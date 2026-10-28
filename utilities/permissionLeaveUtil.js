const moment = require("moment-timezone");
const PermissionRequest = require("../Models/PermissionRequest");
const Attendance = require("../Models/Attendance.model");
const Employee = require("../Models/Employee");
const Configuration = require("../Models/Configuration");
const { isEmployeeInProbation } = require("./probationHelper");

const TZ = "Asia/Kolkata";

/**
 * Returns fyStart and fyEnd dates for a financial year (e.g. "2026-2027")
 */
const getFinancialYearDates = (financialYear) => {
  if (!financialYear || typeof financialYear !== "string" || !financialYear.includes("-")) {
    const d = new Date();
    const month = d.getMonth();
    const year = d.getFullYear();
    financialYear = month >= 3 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
  }

  const [startYearStr, endYearStr] = financialYear.split("-");
  const startYear = parseInt(startYearStr, 10);
  const endYear = parseInt(endYearStr, 10);

  const fyStart = moment.tz(`${startYear}-04-01`, "YYYY-MM-DD", TZ).startOf("day").toDate();
  const fyEnd = moment.tz(`${endYear}-03-31`, "YYYY-MM-DD", TZ).endOf("day").toDate();

  return { fyStart, fyEnd, financialYear };
};

/**
 * Reads permission configuration (permanentFreeCount, probationFreeCount, deductCategoryName, leaveDaysPerPermission)
 */
const getPermissionConfig = async () => {
  try {
    const config = await Configuration.findOne({ key: "DEFAULT_CONFIG" }).lean();
    if (config) {
      return {
        permanentFreeCount: typeof config.permanentFreeCount === "number" ? Math.max(0, config.permanentFreeCount) : 2,
        probationFreeCount: typeof config.probationFreeCount === "number" ? Math.max(0, config.probationFreeCount) : 2,
        deductCategoryName: config.deductCategoryName || "Annual Leave",
        leaveDaysPerPermission: typeof config.leaveDaysPerPermission === "number" ? Math.max(0, config.leaveDaysPerPermission) : 0.5,
      };
    }
  } catch (err) {
    console.error("Error reading Configuration:", err);
  }
  return {
    permanentFreeCount: 2,
    probationFreeCount: 2,
    deductCategoryName: "Annual Leave",
    leaveDaysPerPermission: 0.5,
  };
};

/**
 * Check if category is Annual Leave
 */
const isAnnualLeaveCategory = (name) => {
  if (!name || typeof name !== "string") return false;
  const clean = name.trim().toLowerCase();
  return clean === "annual leave" || clean === "al" || clean === "annual" || clean.includes("annual");
};

/**
 * Check if a category name matches the configured deduction target category
 */
const isMatchingDeductCategory = (catName, targetCategoryName = "Annual Leave") => {
  if (!catName || typeof catName !== "string") return false;
  const cleanCat = catName.trim().toLowerCase();
  const cleanTarget = (targetCategoryName || "Annual Leave").trim().toLowerCase();

  if (cleanCat === cleanTarget) return true;
  if (cleanTarget.includes("annual") && isAnnualLeaveCategory(catName)) return true;
  return false;
};

/**
 * Computes converted permission leave for a single employee in a financial year
 */
const calculatePermissionLeaveDeduction = async (
  employeeId,
  financialYear,
  targetCategoryAllowed = 0,
  targetCategoryRegularUsed = 0,
  explicitInProbation = null
) => {
  const { fyStart, fyEnd } = getFinancialYearDates(financialYear);
  const config = await getPermissionConfig();

  // Determine probation status
  let inProbation = false;
  if (explicitInProbation !== null && explicitInProbation !== undefined) {
    inProbation = !!explicitInProbation;
  } else {
    try {
      const emp = await Employee.findById(employeeId)
        .select("_id isProbation probationPeriod probationPeriodMonths dateJoined createdAt")
        .lean();
      inProbation = isEmployeeInProbation(emp);
    } catch (e) {
      inProbation = false;
    }
  }

  const freeAllowed = inProbation ? config.probationFreeCount : config.permanentFreeCount;
  const daysPerPerm = config.leaveDaysPerPermission;

  // Find all approved and informed permissions in this financial year
  const [permissions, attendanceRecords] = await Promise.all([
    PermissionRequest.find({
      employeeId,
      status: { $in: ["APPROVED", "INFORMED", "Approved", "Informed"] },
      from: { $gte: fyStart, $lte: fyEnd },
    })
      .sort({ from: 1 })
      .lean(),
    Attendance.find({
      employeeId,
      date: {
        $gte: moment(fyStart).tz(TZ).format("YYYY-MM-DD"),
        $lte: moment(fyEnd).tz(TZ).format("YYYY-MM-DD"),
      },
      remarks: { $in: ["Informed Permission", "Approved Permission"] },
    }).lean(),
  ]);

  // Track dates already covered by PermissionRequest to avoid double counting with Attendance
  const coveredDates = new Set();
  const monthlyCounts = {};

  permissions.forEach((perm) => {
    const d = moment(perm.from).tz(TZ);
    const dateStr = d.format("YYYY-MM-DD");
    const mKey = d.format("YYYY-MM");
    coveredDates.add(dateStr);
    monthlyCounts[mKey] = (monthlyCounts[mKey] || 0) + 1;
  });

  // Include any Attendance permissions not already in PermissionRequest
  attendanceRecords.forEach((att) => {
    if (!coveredDates.has(att.date)) {
      coveredDates.add(att.date);
      const mKey = att.date.substring(0, 7);
      monthlyCounts[mKey] = (monthlyCounts[mKey] || 0) + 1;
    }
  });

  // Calculate monthly converted days (first freeAllowed free, each excess = daysPerPerm day)
  let totalConvertedDays = 0;
  const monthlyBreakdown = {};

  Object.keys(monthlyCounts).forEach((mKey) => {
    const count = monthlyCounts[mKey];
    if (count > freeAllowed) {
      const excess = count - freeAllowed;
      const convertedDays = excess * daysPerPerm;
      totalConvertedDays += convertedDays;
      monthlyBreakdown[mKey] = {
        count,
        free: freeAllowed,
        excess,
        convertedDays,
      };
    } else {
      monthlyBreakdown[mKey] = {
        count,
        free: count,
        excess: 0,
        convertedDays: 0,
      };
    }
  });

  // Deduction logic against target leave category balance first, then Others/LOP
  const availableTarget = Math.max(0, targetCategoryAllowed - targetCategoryRegularUsed);
  const deductedFromTarget = Math.min(availableTarget, totalConvertedDays);
  const remainingTarget = Math.max(0, availableTarget - deductedFromTarget);
  const overflowLop = Math.max(0, totalConvertedDays - availableTarget);

  return {
    totalConvertedDays,
    deductedFromAL: deductedFromTarget, // maintain backward compatibility for existing code using deductedFromAL
    deductedFromTarget,
    remainingAL: remainingTarget,
    remainingTarget,
    overflowLop,
    monthlyBreakdown,
    freeAllowed,
    daysPerPerm,
    deductCategoryName: config.deductCategoryName,
    inProbation,
  };
};

/**
 * Bulk calculates converted permission days for multiple employees in a financial year
 */
const getBulkPermissionDeductions = async (employeeIds, financialYear) => {
  const { fyStart, fyEnd } = getFinancialYearDates(financialYear);
  const config = await getPermissionConfig();

  const [permissions, attendanceRecords, employees] = await Promise.all([
    PermissionRequest.find({
      employeeId: { $in: employeeIds },
      status: { $in: ["APPROVED", "INFORMED", "Approved", "Informed"] },
      from: { $gte: fyStart, $lte: fyEnd },
    })
      .sort({ from: 1 })
      .lean(),
    Attendance.find({
      employeeId: { $in: employeeIds },
      date: {
        $gte: moment(fyStart).tz(TZ).format("YYYY-MM-DD"),
        $lte: moment(fyEnd).tz(TZ).format("YYYY-MM-DD"),
      },
      remarks: { $in: ["Informed Permission", "Approved Permission"] },
    }).lean(),
    Employee.find({ _id: { $in: employeeIds } })
      .select("_id dateJoined dateRelieved createdAt isProbation probationPeriod probationPeriodMonths")
      .lean(),
  ]);

  const empProbMap = {};
  employees.forEach((emp) => {
    empProbMap[emp._id.toString()] = isEmployeeInProbation(emp);
  });

  const coveredDatesMap = {};
  const empMonthlyCounts = {};

  employeeIds.forEach((id) => {
    const idStr = id.toString();
    coveredDatesMap[idStr] = new Set();
    empMonthlyCounts[idStr] = {};
  });

  permissions.forEach((perm) => {
    const idStr = perm.employeeId.toString();
    if (!empMonthlyCounts[idStr]) {
      empMonthlyCounts[idStr] = {};
      coveredDatesMap[idStr] = new Set();
    }
    const d = moment(perm.from).tz(TZ);
    const dateStr = d.format("YYYY-MM-DD");
    const mKey = d.format("YYYY-MM");
    coveredDatesMap[idStr].add(dateStr);
    empMonthlyCounts[idStr][mKey] = (empMonthlyCounts[idStr][mKey] || 0) + 1;
  });

  attendanceRecords.forEach((att) => {
    const idStr = att.employeeId.toString();
    if (!coveredDatesMap[idStr]) {
      coveredDatesMap[idStr] = new Set();
      empMonthlyCounts[idStr] = {};
    }
    if (!coveredDatesMap[idStr].has(att.date)) {
      coveredDatesMap[idStr].add(att.date);
      const mKey = att.date.substring(0, 7);
      empMonthlyCounts[idStr][mKey] = (empMonthlyCounts[idStr][mKey] || 0) + 1;
    }
  });

  const resultMap = {};
  employeeIds.forEach((id) => {
    const idStr = id.toString();
    const monthlyCounts = empMonthlyCounts[idStr] || {};
    const inProb = empProbMap[idStr] || false;
    const freeAllowed = inProb ? config.probationFreeCount : config.permanentFreeCount;
    const daysPerPerm = config.leaveDaysPerPermission;

    let totalConvertedDays = 0;
    Object.keys(monthlyCounts).forEach((mKey) => {
      const count = monthlyCounts[mKey];
      if (count > freeAllowed) {
        totalConvertedDays += (count - freeAllowed) * daysPerPerm;
      }
    });
    resultMap[idStr] = totalConvertedDays;
  });

  return resultMap;
};

module.exports = {
  getFinancialYearDates,
  getPermissionConfig,
  isAnnualLeaveCategory,
  isMatchingDeductCategory,
  calculatePermissionLeaveDeduction,
  getBulkPermissionDeductions,
};
