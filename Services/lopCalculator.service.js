const moment = require("moment-timezone");
const Employee = require("../Models/Employee");
const LeaveCategory = require("../Models/LeaveCategory");
const LeaveBalance = require("../Models/LeaveBalance");
const LeaveRequest = require("../Models/LeaveRequest");
const PermissionRequest = require("../Models/PermissionRequest");
const {
  calculateServiceMonths,
  calculateCategoryLeaves,
} = require("../utilities/financialYearUtil");
const { isEmployeeInProbation } = require("../utilities/probationHelper");

const TZ = "Asia/Kolkata";

const getFinancialYearForMonth = (month, year) => {
  const m = Number(month);
  const y = Number(year);
  return m >= 4 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
};

const getFinancialYearRange = (financialYear) => {
  const [startYearStr, endYearStr] = financialYear.split("-");
  const startYear = Number(startYearStr);
  const endYear = Number(endYearStr);

  const fyStart = moment.tz(`${startYear}-04-01 00:00:00`, "YYYY-MM-DD HH:mm:ss", TZ).toDate();
  const fyEnd = moment.tz(`${endYear}-03-31 23:59:59.999`, "YYYY-MM-DD HH:mm:ss.SSS", TZ).toDate();

  return { fyStart, fyEnd, startYear, endYear };
};

const isWeekOff = (dateObj) => {
  const day = dateObj.day();
  const d = dateObj.date();

  if (day === 0) return true;

  if (day === 6) {
    const weekNum = Math.ceil(d / 7);
    if (weekNum === 2 || weekNum === 4) return true;
  }

  return false;
};

/**
 * Retrieves the total available annual leave balance for an employee for a specific financial year.
 * Checks LeaveBalance records and LeaveCategory definitions.
 */
const getAnnualLeaveBalance = async (employeeId, financialYear, employeeObj = null) => {
  try {
    let employee = employeeObj;
    if (!employee) {
      employee = await Employee.findById(employeeId).lean();
    }
    if (!employee) return 0;

    const inProbation = isEmployeeInProbation(employee);
    const empGender = (employee.gender || "male").toLowerCase();
    const joiningDate = employee.dateJoined || employee.createdAt || new Date();
    const actualServiceMonths = calculateServiceMonths(joiningDate, new Date());

    const [categoryDoc, leaveBalDoc] = await Promise.all([
      LeaveCategory.findOne({ financialYear }).lean(),
      LeaveBalance.findOne({ employeeId }).lean(),
    ]);

    const configuredCategories = categoryDoc?.categories || [];
    const employeeBalances = leaveBalDoc?.leaveBalances?.[financialYear] || {};

    let totalBalance = 0;
    const processedCats = new Set();

    // 1. Process configured categories strictly from LeaveCategory
    configuredCategories.forEach((cat) => {
      const lowerName = (cat.name || "").toLowerCase();
      if (empGender !== "female" && lowerName.includes("maternity")) return;
      if (empGender !== "male" && lowerName.includes("paternity")) return;

      processedCats.add(cat.name);
      const existingBal = employeeBalances[cat.name];
      if (existingBal && typeof existingBal.total === "number") {
        totalBalance += existingBal.total;
      } else {
        const allowed = calculateCategoryLeaves(cat, actualServiceMonths, inProbation);
        totalBalance += allowed;
      }
    });

    return totalBalance;
  } catch (err) {
    console.error("[lopCalculator] getAnnualLeaveBalance error:", err);
    return 0;
  }
};

/**
 * Maps leave days from an approved LeaveRequest into month keys (e.g. "2026-04").
 */
const mapLeaveDaysByMonth = (leaveReq, fyStart, fyEnd) => {
  const result = {};
  const isHalfDay = leaveReq.dayType === "Half Day" || leaveReq.noOfDays === 0.5;

  // If specific leaveDates are defined, use them (ignoring any invalid date strings)
  if (Array.isArray(leaveReq.leaveDates) && leaveReq.leaveDates.length > 0) {
    leaveReq.leaveDates.forEach((dStr) => {
      const d = moment.tz(dStr, "YYYY-MM-DD", true, TZ);
      if (d.isValid() && !d.isBefore(fyStart, "day") && !d.isAfter(fyEnd, "day")) {
        const mKey = d.format("YYYY-MM");
        result[mKey] = (result[mKey] || 0) + (isHalfDay ? 0.5 : 1);
      }
    });
    if (Object.keys(result).length > 0) {
      return result;
    }
  }

  if (isHalfDay) {
    const d = moment(leaveReq.fromDate).tz(TZ);
    const mKey = d.format("YYYY-MM");
    result[mKey] = (result[mKey] || 0) + 0.5;
    return result;
  }

  const reqStart = moment(leaveReq.fromDate).tz(TZ).startOf("day");
  const reqEnd = moment(leaveReq.toDate || leaveReq.fromDate).tz(TZ).startOf("day");
  const boundedStart = moment.max(reqStart, moment(fyStart).tz(TZ).startOf("day"));
  const boundedEnd = moment.min(reqEnd, moment(fyEnd).tz(TZ).startOf("day"));

  // Same month leave
  if (boundedStart.format("YYYY-MM") === boundedEnd.format("YYYY-MM")) {
    const mKey = boundedStart.format("YYYY-MM");
    result[mKey] = (result[mKey] || 0) + (Number(leaveReq.noOfDays) || 1);
    return result;
  }

  // Multi-month leave: attribute working days to respective months
  let curr = boundedStart.clone();
  let totalWorking = 0;
  const workingDaysPerMonth = {};

  while (!curr.isAfter(boundedEnd, "day")) {
    const mKey = curr.format("YYYY-MM");
    if (!isWeekOff(curr)) {
      workingDaysPerMonth[mKey] = (workingDaysPerMonth[mKey] || 0) + 1;
      totalWorking++;
    }
    curr.add(1, "day");
  }

  const totalDays = Number(leaveReq.noOfDays) || totalWorking || 1;
  if (totalWorking > 0) {
    Object.keys(workingDaysPerMonth).forEach((mKey) => {
      const proportion = workingDaysPerMonth[mKey] / totalWorking;
      result[mKey] = (result[mKey] || 0) + Number((totalDays * proportion).toFixed(2));
    });
  } else {
    const mKey = boundedStart.format("YYYY-MM");
    result[mKey] = (result[mKey] || 0) + totalDays;
  }

  return result;
};

/**
 * Calculates Loss of Pay (LOP) for an employee for a specific salary month and year.
 *
 * @param {Object} params
 * @param {string|ObjectId} params.employeeId
 * @param {number} params.month 1-12
 * @param {number} params.year e.g. 2026
 * @param {number} params.applicableMonthlySalary Employee's monthly salary (total/gross)
 * @param {Object} [params.employeeObj] Pre-fetched employee document (optional)
 * @returns {Promise<Object>} LOP calculation result
 */
const calculateEmployeeLop = async ({
  employeeId,
  month,
  year,
  applicableMonthlySalary,
  employeeObj = null,
}) => {
  const m = Number(month);
  const y = Number(year);

  // 1. Total calendar days in target month
  const targetMonthStart = moment.tz(`${y}-${String(m).padStart(2, "0")}-01`, "YYYY-MM-DD", TZ).startOf("month");
  const targetMonthEnd = targetMonthStart.clone().endOf("month");
  const monthDays = targetMonthStart.daysInMonth(); // 28, 29, 30, or 31

  // 2. Financial Year calculation
  const financialYear = getFinancialYearForMonth(m, y);
  const { fyStart, fyEnd, startYear } = getFinancialYearRange(financialYear);

  // 3. Retrieve Available Annual Leave Balance
  const totalAnnualLeaveBalance = await getAnnualLeaveBalance(
    employeeId,
    financialYear,
    employeeObj
  );

  // 4. Retrieve Approved Leave Requests in Financial Year up to target month end
  const approvedLeaves = await LeaveRequest.find({
    employeeId,
    requestType: { $ne: "wfh" },
    status: { $regex: /^approved$/i },
    fromDate: { $lte: targetMonthEnd.toDate() },
    toDate: { $gte: fyStart },
  })
    .sort({ fromDate: 1 })
    .lean();

  const leaveUsageByMonth = {};
  approvedLeaves.forEach((leave) => {
    const breakdown = mapLeaveDaysByMonth(leave, fyStart, targetMonthEnd.toDate());
    Object.keys(breakdown).forEach((mKey) => {
      leaveUsageByMonth[mKey] = (leaveUsageByMonth[mKey] || 0) + breakdown[mKey];
    });
  });

  // 5. Retrieve Permissions in Financial Year up to target month end
  // Permission Rule:
  // - Maximum 2 permissions allowed per month.
  // - 3rd and subsequent excess permissions in a month convert to 0.5 day (half-day) leave each.
  // - Two half-day leaves combine to 1 full day of leave (excessCount * 0.5).
  const permissions = await PermissionRequest.find({
    employeeId,
    status: { $in: ["APPROVED", "INFORMED", "Approved", "Informed"] },
    from: { $gte: fyStart, $lte: targetMonthEnd.toDate() },
  })
    .sort({ from: 1 })
    .lean();

  const permissionsByMonth = {};
  permissions.forEach((perm) => {
    const permDate = moment(perm.from).tz(TZ);
    const mKey = permDate.format("YYYY-MM");
    if (!permissionsByMonth[mKey]) permissionsByMonth[mKey] = [];
    permissionsByMonth[mKey].push(perm);
  });

  const permUsageByMonth = {};
  Object.keys(permissionsByMonth).forEach((mKey) => {
    const monthPerms = permissionsByMonth[mKey];
    if (monthPerms.length > 2) {
      const excess = monthPerms.length - 2;
      permUsageByMonth[mKey] = excess * 0.5;
    } else {
      permUsageByMonth[mKey] = 0;
    }
  });

  // 6. Generate ordered list of months from start of Financial Year (April) up to target month
  const orderedMonths = [];
  let iter = moment.tz(`${startYear}-04-01`, "YYYY-MM-DD", TZ).startOf("month");
  while (!iter.isAfter(targetMonthStart, "month")) {
    orderedMonths.push(iter.format("YYYY-MM"));
    iter.add(1, "month");
  }

  // 7. Chronological month-by-month leave balance consumption
  let remainingBalance = totalAnnualLeaveBalance;
  let targetMonthLopDays = 0;
  const targetMonthKey = targetMonthStart.format("YYYY-MM");

  orderedMonths.forEach((mKey) => {
    const monthLeaves = (leaveUsageByMonth[mKey] || 0) + (permUsageByMonth[mKey] || 0);

    if (monthLeaves <= 0) {
      return;
    }

    if (remainingBalance >= monthLeaves) {
      remainingBalance -= monthLeaves;
    } else {
      const covered = remainingBalance;
      const excess = monthLeaves - covered;
      remainingBalance = 0;

      if (mKey === targetMonthKey) {
        targetMonthLopDays = excess;
      }
    }
  });

  // 8. Calculate Monthly LOP Deduction
  const monthlySalary = Number(applicableMonthlySalary || 0);
  const dailySalary = monthDays > 0 ? monthlySalary / monthDays : 0;
  const lopAmount = targetMonthLopDays > 0 && dailySalary > 0
    ? Number((dailySalary * targetMonthLopDays).toFixed(2))
    : 0;

  return {
    hasLop: lopAmount > 0 && targetMonthLopDays > 0,
    lopDays: targetMonthLopDays,
    lopAmount,
    dailySalary: Number(dailySalary.toFixed(2)),
    totalCalendarDays: monthDays,
    totalAnnualLeaveBalance,
    remainingLeaveBalance: remainingBalance,
    financialYear,
  };
};

module.exports = {
  calculateEmployeeLop,
  getAnnualLeaveBalance,
  getFinancialYearForMonth,
  getFinancialYearRange,
  isWeekOff,
};
