// controllers/SalarySlipController.js

const mongoose = require("mongoose");
const moment = require("moment-timezone");

const Employee = require("../Models/Employee");
const EmployeeDetails = require("../Models/EmployeeDetails");
const Attendance = require("../Models/Attendance.model");
const Holiday = require("../Models/Holiday.model");
const SalarySlip = require("../Models/SalarySlip");
const LeaveRequest = require("../Models/LeaveRequest");

const { uploadToS3 } = require("../utilities/s3Upload");
const getCachedSignedUrl = require("../utilities/s3CachedUrl");
const generatePayslipPdf = require("../utilities/generatePayslipPdf");
const payslipTemplate = require("../utilities/payslipTemplate");
const { decrypt } = require("../utilities/secureEncryption");
const deleteFromS3 = require("../utilities/s3Delete");
const numberToWords = require("../utilities/numberToWords");
const { calculateMonthlyAttendance } = require("../Services/attendanceCalculator.service");
const { createLog } = require("../utilities/logService");
const { calculateEmployeeLop } = require("../Services/lopCalculator.service");

const TZ = "Asia/Kolkata";

const monthNames = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/* =========================================================
   HELPERS
========================================================= */

const normalizeObjectId = (id) =>
  mongoose.Types.ObjectId.isValid(id)
    ? new mongoose.Types.ObjectId(id)
    : null;

const getMonthRange = (month, year) => {
  const m = String(month).padStart(2, '0');
  const start = moment.tz(`${year}-${m}-01`, "YYYY-MM-DD", TZ).startOf("month");
  const end = start.clone().endOf("month");
  return { start, end };
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

const getLatestApplicableSalary = (salaryHistory = [], month, year) => {
  if (!salaryHistory.length) return null;
  const sorted = [...salaryHistory].sort((a, b) => new Date(b.fromDate) - new Date(a.fromDate));
  const m = String(month).padStart(2, '0');
  const startOfMonth = moment.tz(`${year}-${m}-01`, "YYYY-MM-DD", TZ).startOf("month").toDate();
  const endOfMonth = moment.tz(`${year}-${m}-01`, "YYYY-MM-DD", TZ).endOf("month").toDate();

  const applicable = sorted.find((row) => {
    const from = row.fromDate ? new Date(row.fromDate) : null;
    const to = row.toDate ? new Date(row.toDate) : null;
    if (!from) return false;
    if (from > endOfMonth) return false;
    if (to && to < startOfMonth) return false;
    return true;
  });

  return applicable || null;
};

const getLatestApplicableBank = (bankHistory = [], month, year) => {
  if (!bankHistory.length) return null;
  const sorted = [...bankHistory].sort((a, b) => new Date(b.fromDate) - new Date(a.fromDate));
  const m = String(month).padStart(2, '0');
  const startOfMonth = moment.tz(`${year}-${m}-01`, "YYYY-MM-DD", TZ).startOf("month").toDate();
  const endOfMonth = moment.tz(`${year}-${m}-01`, "YYYY-MM-DD", TZ).endOf("month").toDate();

  const applicable = sorted.find((row) => {
    const from = row.fromDate ? new Date(row.fromDate) : null;
    const to = row.toDate ? new Date(row.toDate) : null;
    if (!from) return false;
    if (from > endOfMonth) return false;
    if (to && to < startOfMonth) return false;
    return true;
  });

  return applicable || null;
};

const calculateWorkingDays = async (month, year) => {
  const { start } = getMonthRange(month, year);
  return start.daysInMonth();
};

const getAbsentCount = async (employeeId, actualStart, actualEnd) => {
  try {
    const startStr = moment(actualStart).format("YYYY-MM-DD");
    const endStr = moment(actualEnd).format("YYYY-MM-DD");
    const startDate = moment(actualStart).startOf("day").toDate();
    const endDate = moment(actualEnd).endOf("day").toDate();

    const m = moment(actualStart).month() + 1;
    const y = moment(actualStart).year();
    const monthStr = String(m).padStart(2, "0");

    // 1. Fetch Holidays for the month
    const holidays = await Holiday.find({
      date: { $regex: `^${y}-${monthStr}-` }
    }).lean();
    const holidaySet = new Set(holidays.map((h) => h.date));

    // 2. Fetch Attendance records strictly within actualStart and actualEnd
    const attendanceRecords = await Attendance.find({
      employeeId,
      date: { $gte: startStr, $lte: endStr }
    }).lean();
    const attMap = new Map(attendanceRecords.map((a) => [a.date, a]));

    // 3. Fetch Approved LeaveRequests in range
    const approvedLeaves = await LeaveRequest.find({
      employeeId,
      requestType: { $ne: "wfh" },
      status: { $regex: /^approved$/i },
      fromDate: { $lte: endDate },
      toDate: { $gte: startDate }
    }).lean();

    const leaveMap = new Map();
    approvedLeaves.forEach((l) => {
      let current = moment(l.fromDate);
      const lEnd = moment(l.toDate || l.fromDate);
      const isHalfDay = l.dayType === "Half Day" || l.noOfDays === 0.5;
      while (!current.isAfter(lEnd, "day")) {
        const dStr = current.format("YYYY-MM-DD");
        if (dStr >= startStr && dStr <= endStr) {
          leaveMap.set(dStr, { isHalfDay });
        }
        current.add(1, "day");
      }
    });

    let absentCount = 0;
    let curr = moment(actualStart).startOf("day");
    const last = moment(actualEnd).startOf("day");

    while (!curr.isAfter(last, "day")) {
      const dateStr = curr.format("YYYY-MM-DD");
      const d = curr.date();
      const weekday = curr.day();

      const isSunday = weekday === 0;
      const isSecondSaturday = weekday === 6 && Math.ceil(d / 7) === 2;
      const isFourthSaturday = weekday === 6 && Math.ceil(d / 7) === 4;
      const isHoliday = holidaySet.has(dateStr);

      const isWorkingDay = !isHoliday && !isSunday && !isSecondSaturday && !isFourthSaturday;

      if (isWorkingDay) {
        const att = attMap.get(dateStr);
        const hasCheckIn = att && (att.checkInTime || att.checkIn1 || /^(present)/i.test(att.status || ""));
        const isAttHalfDay = att && /^(half day)/i.test(att.status || "");

        if (leaveMap.has(dateStr)) {
          const { isHalfDay } = leaveMap.get(dateStr);
          if (isHalfDay) {
            absentCount += hasCheckIn ? 0.5 : 1;
          } else {
            absentCount += 1;
          }
        } else if (isAttHalfDay) {
          absentCount += hasCheckIn ? 0.5 : 1;
        } else if (!hasCheckIn || (att && /^(leave|on leave|approved leave|unpaid leave|lop|absent)/i.test(att.status || ""))) {
          absentCount += 1;
        }
      }

      curr.add(1, "day");
    }

    return absentCount;
  } catch (err) {
    console.error("getAbsentCount error:", err);
    return 0;
  }
};

const calculatePresentDays = async (
  employeeId,
  startOrMonth,
  endOrYear,
  workingDays
) => {
  let start, end, days;
  if (typeof startOrMonth === "number" && typeof endOrYear === "number") {
    const { start: mStart, end: mEnd } = getMonthRange(startOrMonth, endOrYear);
    start = mStart.toDate();
    end = mEnd.toDate();
    days = workingDays || mStart.daysInMonth();
  } else {
    start = startOrMonth;
    end = endOrYear;
    days = workingDays || Math.floor((new Date(end) - new Date(start)) / (1000 * 60 * 60 * 24)) + 1;
  }

  const absentCount = await getAbsentCount(employeeId, start, end);
  return Math.max(0, days - absentCount);
};

const calculateProfessionalTax = (salary) => {
  const s = Number(salary || 0);

  if (s <= 3500) return 0;
  if (s <= 5000) return 22.5;
  if (s <= 7500) return 52.5;
  if (s <= 10000) return 115;
  if (s <= 12500) return 171;
  return 208;
};

const shouldApplyProfessionalTax = (month, year) => {
  const current = year * 100 + month;

  // No deduction from April 2024 to March 2026
  if (current >= 202404 && current <= 202603) {
    return false;
  }

  // Apply from April 2026 onwards
  return true;
};

/* =========================================================
   CORE FUNCTION (REUSABLE)
========================================================= */

async function createSalarySlip({
  empId,
  month,
  year,
  deductions = [],
  regenerate = false,
  overrideSalary,
  overrideAllowances,
  relievedSalaryMode = "full",
  customPayableDays,
  deductLop,

  employeeMap = null,
  employeeDetailsMap = null,
  salarySlipMap = null
}) {
  const employeeId = normalizeObjectId(empId);
  if (!employeeId) throw new Error("Invalid employee id");

  // ==========================================
  // FIX 4: Override Salary Validation
  // Reject invalid overrideSalary (must be valid numeric and non-negative)
  // ==========================================
  if (overrideSalary !== undefined && overrideSalary !== null) {
    const numOverride = Number(overrideSalary);
    if (
      typeof overrideSalary === "boolean" ||
      (typeof overrideSalary === "string" && overrideSalary.trim() === "") ||
      isNaN(numOverride)
    ) {
      throw new Error("Invalid override salary: must be a valid number");
    }
    if (numOverride < 0) {
      throw new Error("Invalid override salary: cannot be negative");
    }
  }

  // ==========================================
  // FIX 5 & 8: Override Allowance Validation & Duplicate Allowance Validation
  // Validate label non-empty, numeric amount, non-negative, and no duplicate labels
  // ==========================================
  if (overrideAllowances !== undefined && overrideAllowances !== null) {
    if (!Array.isArray(overrideAllowances)) {
      throw new Error("Override allowances must be an array");
    }
    const seenAllowanceLabels = new Set();
    for (const item of overrideAllowances) {
      const label = item?.label || item?.name;
      if (!label || typeof label !== "string" || label.trim() === "") {
        throw new Error("Allowance label is required and cannot be empty");
      }
      const normLabel = label.trim().toLowerCase();
      if (seenAllowanceLabels.has(normLabel)) {
        throw new Error(`Duplicate allowance label: '${label.trim()}'`);
      }
      seenAllowanceLabels.add(normLabel);

      const amt = item?.amount ?? item?.value;
      if (
        amt === undefined ||
        amt === null ||
        typeof amt === "boolean" ||
        (typeof amt === "string" && amt.trim() === "") ||
        isNaN(Number(amt))
      ) {
        throw new Error(`Invalid allowance amount for '${label.trim()}'`);
      }
      if (Number(amt) < 0) {
        throw new Error(`Allowance amount cannot be negative for '${label.trim()}'`);
      }
    }
  }

  // ==========================================
  // FIX 6 & 7: Deduction Validation & Duplicate Deduction Validation
  // Validate label required, numeric non-negative amount, and no duplicate labels
  // ==========================================
  if (deductions !== undefined && deductions !== null) {
    if (!Array.isArray(deductions)) {
      throw new Error("Deductions must be an array");
    }
    const seenDeductionLabels = new Set();
    for (const d of deductions) {
      const label = d?.label;
      if (!label || typeof label !== "string" || label.trim() === "") {
        throw new Error("Deduction label is required and cannot be empty");
      }
      const normLabel = label.trim().toLowerCase();
      if (seenDeductionLabels.has(normLabel)) {
        throw new Error(`Duplicate deduction label: '${d.label.trim()}'`);
      }
      seenDeductionLabels.add(normLabel);

      const amt = d?.amount;
      if (
        amt === undefined ||
        amt === null ||
        typeof amt === "boolean" ||
        (typeof amt === "string" && amt.trim() === "") ||
        isNaN(Number(amt))
      ) {
        throw new Error(`Invalid deduction amount for '${label.trim()}'`);
      }
      if (Number(amt) < 0) {
        throw new Error(`Deduction amount cannot be negative for '${label.trim()}'`);
      }
    }
  }

  const m = Number(month);
  const y = Number(year);

  const { start, end } = getMonthRange(m, y);

  const filter = { empId: employeeId, month: m, year: y };

  let employee;
  let details;
  let existing;

  if (employeeMap && employeeDetailsMap && salarySlipMap) {

    employee = employeeMap.get(String(employeeId));

    details = employeeDetailsMap.get(String(employeeId));

    existing = salarySlipMap.get(String(employeeId));

  } else {

    [employee, existing, details] = await Promise.all([
      Employee.findById(employeeId).lean(),
      SalarySlip.findOne(filter),
      EmployeeDetails.findOne({ empId: employeeId }).lean()
    ]);

  }

  if (!employee) {
    throw new Error("Employee not found");
  }

  if (!details) {
    throw new Error("Employee details not found");
  }

  const doj = employee.dateJoined ? new Date(employee.dateJoined) : null;
  const relievedDate = employee.dateRelieved
    ? new Date(employee.dateRelieved)
    : null;

  // Month range (already exists as start and end)
  const monthStart = start.toDate();
  const monthEnd = end.toDate();

  const isEligible =
    doj && doj <= monthEnd &&
    (
      !relievedDate ||
      relievedDate >= monthStart
    );

  if (!isEligible) {
    throw new Error("Employee not eligible for this month");
  }

  const actualStart = doj > monthStart ? doj : monthStart;

  const actualEnd = relievedDate && relievedDate < monthEnd
    ? relievedDate
    : monthEnd;

  const payPeriod = `${moment(actualStart).tz(TZ).format("DD.MM.YYYY")} to ${moment(actualEnd).tz(TZ).format("DD.MM.YYYY")}`;

  const workingDays =
    Math.floor((actualEnd - actualStart) / (1000 * 60 * 60 * 24)) + 1;

  //  Prevent duplicate generation for the same month/year
  if (existing && !regenerate) {
    const monthName = monthNames[m - 1] || month;
    throw new Error(`Salary slip for ${monthName} ${y} has already been generated for this employee.`);
  }

  const salaryRow = getLatestApplicableSalary(details.salaryHistory || [], m, y);

  if (!salaryRow && overrideSalary === undefined) {
    throw new Error("Salary not configured for employee");
  }

  const bankRow = getLatestApplicableBank(details.bankHistory || [], m, y);

  // ==========================================
  // FIX 2: Override Allowances
  // Use overrideAllowances when provided, otherwise fall back to salaryHistory allowances
  // ==========================================
  let rawAllowances = [];
  if (overrideAllowances !== undefined && overrideAllowances !== null) {
    rawAllowances = overrideAllowances;
  } else if (salaryRow?.allowances) {
    rawAllowances = salaryRow.allowances;
  }

  let allowances = rawAllowances.map((a) => ({
    label: (a.label || a.name || "Allowance").trim(),
    amount: Number(a.value ?? a.amount ?? 0),
  }));

  // ==========================================
  // FIX 3: Basic Salary & Allowance Proration
  // ==========================================

  // Total calendar days
  const monthDays = await calculateWorkingDays(m, y);

  // Compute absentCount considering Attendance records and approved LeaveRequests
  const absentCount = await getAbsentCount(employeeId, actualStart, actualEnd);

  // presentDays and payableDays share the same absentCount — no second DB call
  const presentDays = Math.max(0, workingDays - absentCount);

  // Business Logic:
  // - If relievedSalaryMode === "deduct", prorate salary based on present/worked days.
  // - If relievedSalaryMode === "full" (default), bypass proration deduction (100% full salary).
  let payableDays = monthDays;
  let finalWorkingDays = workingDays;
  let finalPresentDays = presentDays;

  if (relievedSalaryMode === "deduct") {
    if (customPayableDays !== undefined && customPayableDays !== null && Number(customPayableDays) > 0) {
      payableDays = Math.min(monthDays, Number(customPayableDays));
    } else if (doj && doj > monthStart) {
      // Joined during this month — default payable days is the days since DOJ
      payableDays = workingDays;
    } else if (relievedDate && relievedDate < monthEnd) {
      // Relieved during this month — default payable days is days until relief
      payableDays = workingDays;
    } else {
      payableDays = presentDays;
    }
    finalWorkingDays = workingDays;
    finalPresentDays = presentDays;
  } else {
    payableDays = monthDays;
    finalWorkingDays = workingDays;
    finalPresentDays = presentDays;
  }

  const hasOverrideBasic = overrideSalary !== undefined && overrideSalary !== null;
  const hasOverrideAllowances = overrideAllowances !== undefined && overrideAllowances !== null;

  // Basic Salary calculation: use exact override if provided, otherwise prorate if deduct mode
  let proratedBasicSalary;
  if (hasOverrideBasic) {
    proratedBasicSalary = Number(Number(overrideSalary).toFixed(2));
  } else if (relievedSalaryMode === "deduct") {
    const fullBasic = Number(salaryRow?.basicSalary || 0);
    proratedBasicSalary = Number(
      ((fullBasic / monthDays) * payableDays).toFixed(2)
    );
  } else {
    proratedBasicSalary = Number(
      Number(salaryRow?.basicSalary || 0).toFixed(2)
    );
  }

  // Allowances calculation: use exact override if provided, otherwise prorate if deduct mode
  let proratedAllowances;
  if (hasOverrideAllowances) {
    proratedAllowances = allowances.map((item) => ({
      label: item.label,
      amount: Number(Number(item.amount || 0).toFixed(2)),
    }));
  } else if (relievedSalaryMode === "deduct") {
    proratedAllowances = allowances.map((item) => ({
      label: item.label,
      amount: Number(
        ((Number(item.amount || 0) / monthDays) * payableDays).toFixed(2)
      ),
    }));
  } else {
    proratedAllowances = allowances.map((item) => ({
      label: item.label,
      amount: Number(Number(item.amount || 0).toFixed(2)),
    }));
  }

  // Final earnings array
  const earnings = [
    {
      label: "Basic Salary",
      amount: proratedBasicSalary,
    },
    ...proratedAllowances,
  ];

  // Gross salary equals prorated Basic + prorated Allowances
  const rawTotalEarnings = earnings.reduce(
    (sum, row) => sum + Number(row.amount || 0),
    0
  );
  // FIX 10: Total Earnings can never be negative
  const totalEarnings = Math.max(0, Number(rawTotalEarnings.toFixed(2)));

  // ==========================================
  // FIX 1 & 9: Professional Tax & Deduction Amount Formatting
  // Do not automatically add PT inside createSalarySlip().
  // Deduct PT only when received in deductions array from frontend.
  // Round deduction amounts to two decimal places before calculating total and storing.
  // ==========================================

  // ==========================================
  // EPF & ESI DEDUCTION LOGIC
  // Net Salary = totalSalary from salaryRow (employee's configured salary)
  // Other Salary (for EPF calc) = 50% of Net Salary
  // EPF = 12% of Other Salary (always applicable)
  // ESI = 0.75% of Net Salary / Gross Salary (only if Net Salary <= 20,000)
  // ==========================================
  const netSalaryForEpfEsi = Number(salaryRow?.totalSalary || 0);
  const otherSalaryForEpfEsi = Number((netSalaryForEpfEsi * 0.5).toFixed(2));

  const epfAmount = Number((otherSalaryForEpfEsi * 0.12).toFixed(2));
  const esiAmount = netSalaryForEpfEsi <= 20000
    ? Number((netSalaryForEpfEsi * 0.0075).toFixed(2))
    : 0;

  // Build auto EPF/ESI deduction entries (skip if amount is 0)
  const autoDeductions = [];
  if (epfAmount > 0) {
    autoDeductions.push({ label: "EPF", amount: epfAmount });
  }
  if (esiAmount > 0) {
    autoDeductions.push({ label: "ESI", amount: esiAmount });
  }

  // ==========================================
  // LOSS OF PAY (LOP) CALCULATION LOGIC
  // ==========================================
  const applicableMonthlySalary = hasOverrideBasic
    ? Number(overrideSalary) + proratedAllowances.reduce((sum, a) => sum + Number(a.amount || 0), 0)
    : Number(salaryRow?.totalSalary || (Number(salaryRow?.basicSalary || 0) + allowances.reduce((sum, a) => sum + Number(a.amount || 0), 0)));

  const lopResult = await calculateEmployeeLop({
    employeeId,
    month: m,
    year: y,
    applicableMonthlySalary,
    employeeObj: employee,
  });

  const isLopLabel = (label) =>
    /^(loss of pay|loss of pay \(lop\)|lop)$/i.test((label || "").trim());

  // Merge incoming deductions with auto EPF/ESI
  // Prevent duplicates: if frontend already sends EPF/ESI labels, skip auto-add
  const incomingLabels = new Set(
    (deductions || []).map((d) => (d.label || "").trim().toLowerCase())
  );
  const filteredAutoDeductions = autoDeductions.filter(
    (d) => !incomingLabels.has(d.label.toLowerCase())
  );

  // Filter out any existing LOP deduction from incoming/auto to prevent duplicate on regenerate
  const cleanIncomingDeductions = (deductions || [])
    .filter((d) => !isLopLabel(d.label))
    .map((d) => ({
      label: d.label.trim(),
      amount: Number(Number(d.amount || 0).toFixed(2)),
    }));

  const cleanAutoDeductions = filteredAutoDeductions.filter(
    (d) => !isLopLabel(d.label)
  );

  let finalDeductions = [
    ...cleanIncomingDeductions,
    ...cleanAutoDeductions,
  ];

  const shouldDeductLop = deductLop !== undefined
    ? Boolean(deductLop)
    : (deductions && Array.isArray(deductions) ? deductions.some(d => isLopLabel(d.label)) : true);

  // If employee has LOP and shouldDeductLop is true, insert immediately after "Full Deduction" if present, else append
  if (shouldDeductLop && lopResult.hasLop && lopResult.lopAmount > 0) {
    const lopEntry = {
      label: "Loss of Pay (LOP)",
      amount: lopResult.lopAmount,
    };

    const fullDeductionIndex = finalDeductions.findIndex((d) =>
      /^full deduction$/i.test((d.label || "").trim())
    );

    if (fullDeductionIndex !== -1) {
      finalDeductions.splice(fullDeductionIndex + 1, 0, lopEntry);
    } else {
      finalDeductions.push(lopEntry);
    }
  }

  const rawTotalDeductions = finalDeductions.reduce(
    (sum, row) => sum + Number(row.amount || 0),
    0
  );
  // FIX 10: Total Deductions can never be negative
  const totalDeductions = Math.max(0, Number(rawTotalDeductions.toFixed(2)));

  // FIX 10: Net Pay can never become negative (reflects take-home pay after LOP)
  const netPay = Math.max(0, Number((totalEarnings - totalDeductions).toFixed(2)));

  const payload = {
    empId: employeeId,
    month: m,
    year: y,
    monthName: monthNames[m - 1],
    employeeName: employee.name || details?.name || "-",
    empCode: employee.empId || details?.empIdString || "-",
    designation: employee.designation || details?.designation || "-",
    department: employee.department || details?.department || "-",
    doj: employee.dateJoined || details?.dateJoined || null,
    bankName: bankRow?.bankName || "-",
    branchName: bankRow?.branch || "-",
    accountNumber: (() => {
      let accountNumber = bankRow?.accountNumber;
      try {
        return accountNumber ? decrypt(accountNumber) : "-";
      } catch {
        return accountNumber || "-";
      }
    })(),
    ifscCode: bankRow?.ifscCode || "-",
    accountHolder: bankRow?.accountHolder || employee.name || "-",
    panNo: (() => {
      try {
        if (!details.panNo || details.panNo === "-") return "-";
        // Always decrypt to show real number in generated slip
        const decrypted = decrypt(details.panNo);
        return decrypted || details.panNo;
      } catch (err) {
        console.error("PAN decryption error in createSalarySlip:", err);
        return details.panNo || "-";
      }
    })(),
    payPeriod,
    workingDays: finalWorkingDays,
    presentDays: finalPresentDays,
    earnings,
    deductions: finalDeductions,
    totalEarnings,
    totalDeductions,
    netPay,
    amountInWords: numberToWords(netPay || 0),
    generatedAt: new Date(),
    isLocked: true,
  };

  // Only store LOP details in DB when actual LOP deduction applies (no null/empty/blank fields)
  if (shouldDeductLop && lopResult.hasLop && lopResult.lopAmount > 0) {
    payload.lopDays = lopResult.lopDays;
    payload.lopAmount = lopResult.lopAmount;
  }

  let slip;

  if (existing && regenerate) {
    // 🔄 Regenerate: update in place (preserves _id, audit trail, prevents duplication)
    const updateOps = { $set: payload };
    if (!payload.lopDays) {
      updateOps.$unset = { lopDays: 1, lopAmount: 1 };
    }
    slip = await SalarySlip.findByIdAndUpdate(
      existing._id,
      updateOps,
      { new: true }
    );
  } else {
    try {
      slip = await SalarySlip.create(payload);
    } catch (err) {
      //  Catch race-condition duplicate from unique index
      if (err.code === 11000) {
        throw new Error("Salary slip already exists (duplicate prevented)");
      }
      throw err;
    }
  }

  // FIX: PDF generation runs in background — API returns immediately without waiting
  const slipObj = slip.toObject();
  setImmediate(async () => {
    try {
      const html = payslipTemplate(payload);
      const pdfBuffer = await generatePayslipPdf(html);
      const key = `SalarySlip/${payload.empCode}/${y}/${m}.pdf`;
      await uploadToS3(pdfBuffer, key, "application/pdf");
      const pdfUrl = await getCachedSignedUrl(key);
      await SalarySlip.findByIdAndUpdate(slip._id, { pdfUrl });
    } catch (err) {
      console.error("❌ Background PDF Error:", err.message);
    }
  });

  // ✅ Return immediately — PDF will be ready shortly in background
  return {
    ...payload,
    ...slipObj,
  };
}

/* =========================================================
   SINGLE GENERATE
========================================================= */

exports.generateSalarySlip = async (req, res) => {
  try {
    const slip = await createSalarySlip(req.body);

    const mName = monthNames[Number(slip.month) - 1] || slip.month;
    const adminName = req.user?.name || "Admin";
    createLog({
      category: "salary_slip",
      referenceId: slip._id,
      description: `${adminName} generated salary slip for ${slip.empName || "Employee"} (${slip.empCode || slip.empId}) - ${mName} ${slip.year}`,
    });

    res.status(201).json({
      success: true,
      message: "Salary slip generated successfully",
      data: slip,
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      message: err.message,
    });
  }
};

/* =========================================================
   BULK GENERATE
========================================================= */

exports.generateMultipleSalarySlip = async (req, res) => {
  try {
    const { month, year, employeeData = [] } = req.body;

    const pLimit = require("p-limit");

    const limit = pLimit(5);

    let success = [];
    let failed = [];

    // ================================
    // Preload all data for bulk generation
    // ================================

    const employeeIds = employeeData
      .map(emp => normalizeObjectId(emp.empId))
      .filter(Boolean);

    const [employees, employeeDetails, existingSlips] = await Promise.all([

      Employee.find({
        _id: { $in: employeeIds }
      }).lean(),

      EmployeeDetails.find({
        empId: { $in: employeeIds }
      }).lean(),

      SalarySlip.find({
        empId: { $in: employeeIds },
        month: Number(month),
        year: Number(year)
      }).lean()

    ]);

    const employeeMap = new Map(
      employees.map(emp => [String(emp._id), emp])
    );

    const employeeDetailsMap = new Map(
      employeeDetails.map(detail => [String(detail.empId), detail])
    );

    const salarySlipMap = new Map(
      existingSlips.map(slip => [String(slip.empId), slip])
    );

    await Promise.all(
      employeeData.map((emp) =>
        limit(async () => {
          try {
            const slip = await createSalarySlip({
              empId: emp.empId,
              month,
              year,
              overrideSalary: emp.overrideSalary,
              overrideAllowances: emp.overrideAllowances,
              deductions: emp.deductions || [],
              relievedSalaryMode: emp.relievedSalaryMode,
              customPayableDays: emp.customPayableDays,
              deductLop: emp.deductLop,

              employeeMap,
              employeeDetailsMap,
              salarySlipMap
            });

            success.push(slip._id);
          } catch (err) {
            console.log("❌ Bulk Error:", emp.empId, err.message);

            failed.push({
              empId: emp.empId,
              error: err.message,
            });
          }
        })
      )
    );

    const mName = monthNames[Number(month) - 1] || month;
    const adminName = req.user?.name || "Admin";
    if (success.length > 0) {
      createLog({
        category: "salary_slip",
        referenceId: success[0] || null,
        description: `${adminName} generated bulk salary slips for ${success.length} employee(s) - ${mName} ${year}`,
      });
    }

    res.json({
      success: true,
      generated: success.length,
      failed
    });
  } catch (err) {
    console.error("❌ generateMultipleSalarySlip error:", err);
    res.status(500).json({ success: false });
  }
};

/* =========================================================
   ACTIVE EMPLOYEES
========================================================= */

exports.getActiveEmployees = async (req, res) => {
  try {
    const employees = await Employee.find({
      role: "employee",
    }).lean();

    // FIX: Single batch query instead of N+1 individual EmployeeDetails.findOne calls
    const allDetails = await EmployeeDetails.find({
      empId: { $in: employees.map(e => e._id) }
    }).lean();

    const detailsMap = new Map(
      allDetails.map(d => [String(d.empId), d])
    );

    const decryptSafe = (val) => {
      if (!val || val === "-") return "-";
      try {
        const result = decrypt(val);
        return result || val;
      } catch (err) {
        return val;
      }
    };

    const finalData = employees.map((emp) => {
      const details = detailsMap.get(String(emp._id));

      const salaryHistory = details?.salaryHistory || [];

      let latestSalary = null;
      if (salaryHistory.length > 0) {
        salaryHistory.sort(
          (a, b) => new Date(b.fromDate) - new Date(a.fromDate)
        );
        latestSalary = salaryHistory[0];
      }

      return {
        ...emp,
        salaryHistory,
        bankHistory: (details?.bankHistory || []).map(bh => ({
          ...bh,
          accountNumber: decryptSafe(bh.accountNumber)
        })),

        accountNumber: decryptSafe(details?.accountNumber),
        bankName: details?.bankName || "-",
        branchName: details?.branch || "-",
        ifscCode: details?.ifscCode || "-",
        accountHolder: details?.accountHolder || "-",
        panNo: decryptSafe(details?.panNo),

        basicSalary: latestSalary?.basicSalary || 0,
        allowances: latestSalary?.allowances || [],
      };
    });

    finalData.sort((a, b) =>
      (a.empId || "").localeCompare(b.empId || "", undefined, { numeric: true, sensitivity: "base" })
    );

    res.json({
      success: true,
      data: finalData,
    });
  } catch (err) {
    console.error("getActiveEmployees error:", err);
    res.status(500).json({ success: false });
  }
};

/* =========================================================
   EXISTING APIs (UNCHANGED)
========================================================= */

const formatSalarySlipWithDetails = async (s) => {
  if (!s) return s;
  const empObj = typeof s.empId === "object" && s.empId !== null ? s.empId : null;
  const rawEmpId = empObj?._id || s.empId;

  const [employee, details] = await Promise.all([
    empObj ? Promise.resolve(empObj) : Employee.findById(rawEmpId).lean(),
    EmployeeDetails.findOne({ empId: rawEmpId }).lean()
  ]);

  const { start, end } = getMonthRange(s.month, s.year);
  const monthStart = start.toDate();
  const monthEnd = end.toDate();

  const dojDate = employee?.dateJoined || details?.dateJoined ? new Date(employee?.dateJoined || details?.dateJoined) : monthStart;
  const relievedDate = employee?.dateRelieved || details?.dateRelieved ? new Date(employee?.dateRelieved || details?.dateRelieved) : null;

  const actualStart = dojDate > monthStart ? dojDate : monthStart;
  const actualEnd = relievedDate && relievedDate < monthEnd ? relievedDate : monthEnd;
  const calculatedPayPeriod = `${moment(actualStart).tz(TZ).format("DD.MM.YYYY")} to ${moment(actualEnd).tz(TZ).format("DD.MM.YYYY")}`;

  const calculatedWorkingDays = Math.max(1, Math.floor((actualEnd - actualStart) / (1000 * 60 * 60 * 24)) + 1);

  const absentCount = await getAbsentCount(rawEmpId, actualStart, actualEnd);

  const calculatedPresentDays = Math.max(0, calculatedWorkingDays - absentCount);

  const finalEmpCode = (s.empCode && s.empCode !== "-" && s.empCode !== "undefined")
    ? s.empCode
    : (employee?.empId || details?.empIdString || "-");

  const finalDesignation = (s.designation && s.designation !== "-" && s.designation !== "undefined")
    ? s.designation
    : (employee?.designation || details?.designation || "-");

  const finalDepartment = (s.department && s.department !== "-" && s.department !== "undefined")
    ? s.department
    : (employee?.department || details?.department || "-");

  const finalDoj = s.doj || employee?.dateJoined || details?.dateJoined || null;

  const finalWorkingDays = (s.workingDays !== undefined && s.workingDays !== null)
    ? s.workingDays
    : calculatedWorkingDays;

  const finalPresentDays = (s.presentDays !== undefined && s.presentDays !== null && !isNaN(s.presentDays))
    ? s.presentDays
    : calculatedPresentDays;

  const salaryRow = getLatestApplicableSalary(details?.salaryHistory || [], s.month, s.year);
  const earnings = (s.earnings && s.earnings.length > 0)
    ? s.earnings
    : [
      { label: "Basic Salary", amount: Number(salaryRow?.basicSalary || 0) },
      ...(salaryRow?.allowances || []).map(a => ({
        label: a.label || "Allowance",
        amount: Number(a.value || 0)
      }))
    ];
  const totalEarnings = (s.totalEarnings !== undefined && s.totalEarnings !== null)
    ? s.totalEarnings
    : earnings.reduce((sum, r) => sum + r.amount, 0);

  const deductions = (s.deductions && s.deductions.length > 0)
    ? s.deductions
    : [];

  const totalDeductions = (s.totalDeductions !== undefined && s.totalDeductions !== null)
    ? s.totalDeductions
    : deductions.reduce((sum, r) => sum + Number(r.amount || 0), 0);

  const netPay = (s.netPay !== undefined && s.netPay !== null)
    ? s.netPay
    : Math.max(0, totalEarnings - totalDeductions);
  const amountInWords = numberToWords(netPay);

  return {
    ...s,
    employeeName: s.employeeName || employee?.name || details?.name || "-",
    empCode: finalEmpCode,
    designation: finalDesignation,
    department: finalDepartment,
    doj: finalDoj,
    payPeriod: calculatedPayPeriod,
    workingDays: finalWorkingDays,
    presentDays: finalPresentDays,
    earnings,
    totalEarnings,
    deductions,
    totalDeductions,
    netPay,
    amountInWords,
    ...(s.lopDays !== undefined && s.lopDays !== null ? { lopDays: s.lopDays } : {}),
    ...(s.lopAmount !== undefined && s.lopAmount !== null ? { lopAmount: s.lopAmount } : {}),
    bankName: details?.bankName || "-",
    branchName: details?.branch || "-",
    accountNumber: (() => {
      try { return details?.accountNumber ? decrypt(details.accountNumber) : "-"; }
      catch { return details?.accountNumber || "-"; }
    })(),
    ifscCode: details?.ifscCode || "-",
    panNo: (() => {
      try {
        if (!details?.panNo || details.panNo === "-") return "-";
        const decrypted = decrypt(details.panNo);
        return decrypted || details.panNo;
      } catch (err) {
        return details?.panNo || "-";
      }
    })()
  };
};

exports.getSalarySlip = async (req, res) => {
  try {
    const { empId, month, year } = req.params;

    const slip = await SalarySlip.findOne({
      empId,
      month,
      year,
    })
      .populate("empId", "name empId designation department")
      .lean();

    if (!slip) {
      return res.status(404).json({ success: false });
    }

    const formatted = await formatSalarySlipWithDetails(slip);
    res.json({ success: true, data: formatted });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getEmployeeSalarySlips = async (req, res) => {
  try {
    const slips = await SalarySlip.find({
      empId: req.params.empId,
    })
      .populate("empId", "name empId designation department")
      .sort({ year: -1, month: -1 })
      .lean();

    const formatted = await Promise.all(slips.map(formatSalarySlipWithDetails));
    res.json({ success: true, data: formatted });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getAllSalarySlips = async (req, res) => {
  try {
    const { month, year, fromMonth, toMonth, fromYear, toYear, empId, department, designation, mode } = req.query;
    const filter = {};

    if (empId && empId !== "all" && empId !== "") {
      filter.empId = empId;
    }

    if (mode === "monthly" || (!mode && month)) {
      if (month && month !== "all" && month !== "") {
        filter.month = Number(month);
      }
      if (year && year !== "all" && year !== "") {
        filter.year = Number(year);
      }
    } else if (!mode && !fromMonth && !toMonth) {
      if (month && month !== "all" && month !== "") {
        filter.month = Number(month);
      }
      if (year && year !== "all" && year !== "") {
        filter.year = Number(year);
      }
    }

    let slips = await SalarySlip.find(filter)
      .populate("empId", "name empId designation department dateJoined dateRelieved")
      .sort({ year: -1, month: -1 })
      .lean();

    if (mode === "custom" && fromMonth && toMonth && fromYear && toYear) {
      const fromVal = Number(fromYear) * 100 + Number(fromMonth);
      const toVal = Number(toYear) * 100 + Number(toMonth);
      slips = slips.filter(s => {
        const slipVal = (s.year || 0) * 100 + (s.month || 0);
        return slipVal >= fromVal && slipVal <= toVal;
      });
    }

    if (department && department !== "all" && department !== "") {
      slips = slips.filter(s =>
        (s.empId?.department || s.department || "").toLowerCase() === department.toLowerCase()
      );
    }

    if (designation && designation !== "all" && designation !== "") {
      slips = slips.filter(s =>
        (s.empId?.designation || s.designation || "").toLowerCase() === designation.toLowerCase()
      );
    }

    const formatted = await Promise.all(slips.map(formatSalarySlipWithDetails));
    res.json({ success: true, data: formatted });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.deleteSalarySlip = async (req, res) => {
  try {
    const { slipId } = req.params;

    // console.log(`🟡 [DELETE START] SlipId: ${slipId}`);

    // 🔍 Check slip exists with populated employee
    const slip = await SalarySlip.findById(slipId).populate("empId", "name empId empIdString");

    if (!slip) {
      console.log(`❌ [DELETE FAILED] Slip NOT FOUND | SlipId: ${slipId}`);

      return res.status(404).json({
        success: false,
        message: "Salary slip not found",
      });
    }

    // 🔥 Delete from S3
    if (slip.pdfUrl) {
      try {
        const urlObj = new URL(slip.pdfUrl);
        let key = urlObj.pathname.startsWith('/') ? urlObj.pathname.slice(1) : urlObj.pathname;
        if (key) await deleteFromS3(key);
      } catch (err) {
        console.error(`❌ [S3 DELETE FAILED] URL: ${slip.pdfUrl}`, err);
      }
    }

    // 🔥 Delete from DB
    await SalarySlip.findByIdAndDelete(slipId);

    const empName = slip.empId?.name || "Employee";
    const empCode = slip.empId?.empIdString || slip.empId?.empId || "";
    const empDisplay = empCode ? `${empName} (${empCode})` : empName;
    const mName = monthNames[Number(slip.month) - 1] || slip.month;
    const adminName = req.user?.name || "Admin";

    await createLog({
      category: "salary_slip",
      referenceId: slip._id,
      description: `${adminName} deleted salary slip of ${empDisplay} for ${mName} ${slip.year}`,
      changes: [
        {
          fieldName: "salary_slip_deleted",
          from: `${mName} ${slip.year} (Net Pay: ₹${slip.netPay || 0})`,
          to: "DELETED",
        },
      ],
    });

    console.log(`✅ [DELETE SUCCESS] SlipId: ${slipId}`);

    return res.json({
      success: true,
      message: "Salary slip deleted successfully",
    });

  } catch (err) {
    console.error(`❌ [DELETE ERROR]`, err);

    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.deleteMultipleSalarySlips = async (req, res) => {
  try {
    const { slipIds } = req.body;

    if (!slipIds || !Array.isArray(slipIds) || slipIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Please provide an array of slip IDs to delete",
      });
    }

    const slips = await SalarySlip.find({ _id: { $in: slipIds } }).populate("empId", "name empId empIdString");

    if (!slips || slips.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No salary slips found for the provided IDs",
      });
    }

    // Delete PDFs from S3
    await Promise.all(
      slips.map(async (slip) => {
        if (slip.pdfUrl) {
          try {
            const urlObj = new URL(slip.pdfUrl);
            let key = urlObj.pathname.startsWith('/') ? urlObj.pathname.slice(1) : urlObj.pathname;
            if (key) await deleteFromS3(key);
          } catch (err) {
            console.error(`❌ [S3 BULK DELETE FAILED] URL: ${slip.pdfUrl}`, err);
          }
        }
      })
    );

    // Delete records from database
    await SalarySlip.deleteMany({ _id: { $in: slipIds } });

    const adminName = req.user?.name || "Admin";

    // Record audit logs
    for (const slip of slips) {
      const empName = slip.empId?.name || "Employee";
      const empCode = slip.empId?.empIdString || slip.empId?.empId || "";
      const empDisplay = empCode ? `${empName} (${empCode})` : empName;
      const mName = monthNames[Number(slip.month) - 1] || slip.month;

      await createLog({
        category: "salary_slip",
        referenceId: slip._id,
        description: `${adminName} deleted salary slip of ${empDisplay} for ${mName} ${slip.year} (Bulk Delete)`,
        changes: [
          {
            fieldName: "salary_slip_deleted",
            from: `${mName} ${slip.year} (Net Pay: ₹${slip.netPay || 0})`,
            to: "DELETED",
          },
        ],
      });
    }

    console.log(`✅ [BULK DELETE SUCCESS] Deleted ${slips.length} salary slips.`);

    return res.json({
      success: true,
      message: `Successfully deleted ${slips.length} salary slip(s)`,
      deletedCount: slips.length,
    });
  } catch (err) {
    console.error(`❌ [BULK DELETE ERROR]`, err);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.getMySalarySlips = async (req, res) => {
  const { year, month, fromMonth, toMonth, fromYear, toYear, mode } = req.query;
  const query = { empId: req.user._id };

  if (mode === "monthly" || (!mode && month)) {
    if (month && month !== "all" && month !== "") query.month = Number(month);
    if (year && year !== "all" && year !== "") query.year = Number(year);
  } else if (!mode && !fromMonth && !toMonth) {
    if (month && month !== "all" && month !== "") query.month = Number(month);
    if (year && year !== "all" && year !== "") query.year = Number(year);
  }

  let slips = await SalarySlip.find(query)
    .populate("empId", "name empId designation department dateJoined dateRelieved")
    .sort({ year: -1, month: -1 })
    .lean();

  if (mode === "custom" && fromMonth && toMonth && fromYear && toYear) {
    const fromVal = Number(fromYear) * 100 + Number(fromMonth);
    const toVal = Number(toYear) * 100 + Number(toMonth);
    slips = slips.filter(s => {
      const slipVal = (s.year || 0) * 100 + (s.month || 0);
      return slipVal >= fromVal && slipVal <= toVal;
    });
  }

  const formatted = await Promise.all(slips.map(async (s) => {
    const { start, end } = getMonthRange(s.month, s.year);
    const monthStart = start.toDate();
    const monthEnd = end.toDate();

    const empObj = s.empId || {};
    const dojDate = empObj.dateJoined ? new Date(empObj.dateJoined) : monthStart;
    const relievedDate = empObj.dateRelieved ? new Date(empObj.dateRelieved) : null;

    const actualStart = dojDate > monthStart ? dojDate : monthStart;
    const actualEnd = relievedDate && relievedDate < monthEnd ? relievedDate : monthEnd;

    const calculatedPayPeriod = `${moment(actualStart).tz(TZ).format("DD.MM.YYYY")} to ${moment(actualEnd).tz(TZ).format("DD.MM.YYYY")}`;
    const workingDays = await calculateWorkingDays(s.month, s.year);
    const presentDays = await calculatePresentDays(empObj._id || s.empId, s.month, s.year);

    return {
      ...s,
      employeeName: empObj.name,
      empCode: empObj.empId,
      designation: empObj.designation,
      department: empObj.department,
      payPeriod: calculatedPayPeriod,
      workingDays,
      presentDays
    };
  }));

  res.json({ success: true, data: formatted });
};

exports.downloadSalarySlip = async (req, res) => {
  try {
    const slip = await SalarySlip.findById(req.params.slipId).lean();

    if (!slip) {
      console.error(`❌ downloadSalarySlip error: Slip with ID ${req.params.slipId} not found`);
      return res.status(404).json({ success: false, message: "Slip not found" });
    }

    const fullSlip = await formatSalarySlipWithDetails(slip);
    const empCode = fullSlip.empCode || fullSlip.empId?.empId || "Employee";
    const employeeName = (fullSlip.employeeName || fullSlip.name || fullSlip.empName || empCode).replace(/[^a-zA-Z0-9_-]/g, "_");
    const expectedKey = `SalarySlip/${empCode}/${slip.year}/${slip.month}.pdf`;
    let key = expectedKey;

    const { GetObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
    const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
    const s3 = require("../utilities/s3");

    // Check if the object actually exists in S3
    let existsInS3 = false;
    try {
      await s3.send(
        new HeadObjectCommand({
          Bucket: process.env.AWS_BUCKET_NAME,
          Key: key,
        })
      );
      existsInS3 = true;
    } catch (headErr) {
      existsInS3 = false;
    }

    if (!existsInS3) {
      console.log(`[downloadSalarySlip] PDF missing in S3 (${key}) for slip ${slip._id}. Generating on the fly...`);
      try {
        const html = payslipTemplate(fullSlip);
        const pdfBuffer = await generatePayslipPdf(html);

        await uploadToS3(pdfBuffer, key, "application/pdf");

        const pdfUrl = await getCachedSignedUrl(key);
        await SalarySlip.findByIdAndUpdate(slip._id, { pdfUrl });
        slip.pdfUrl = pdfUrl;
      } catch (genErr) {
        console.error("❌ On-the-fly PDF Generation Error:", genErr);
        return res.status(500).json({
          success: false,
          message: `PDF Generation Error: ${genErr.message}`
        });
      }
    }

    const monthNames = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];
    const monthLabel = monthNames[(slip.month || 1) - 1];
    const filename = `${employeeName}_${monthLabel}_${slip.year}_Salaryslip.pdf`;

    const isDownload = req.query.download === 'true';

    const command = new GetObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
      ResponseContentDisposition: isDownload
        ? `attachment; filename="${filename}"`
        : `inline; filename="${filename}"`,
      ResponseContentType: "application/pdf"
    });

    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 }); // 1 hour

    return res.json({
      success: true,
      url: signedUrl
    });
  } catch (err) {
    console.error("downloadSalarySlip error:", err);
    res.status(500).json({ success: false, message: "Failed to download payslip" });
  }
};

const streamToBuffer = async (stream) => {
  if (!stream) return Buffer.alloc(0);
  if (Buffer.isBuffer(stream)) return stream;
  if (typeof stream.pipe !== "function" && typeof stream[Symbol.asyncIterator] !== "function") {
    return Buffer.from(stream);
  }
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
};

const pMap = async (items, fn, concurrency = 3) => {
  const results = [];

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }

  return results;
};

exports.downloadSalarySlipsZip = async (req, res) => {
  let archive = null;
  let clientAborted = false;
  let archiveFailed = false;

  try {
    const archiver = require("archiver");
    const { GetObjectCommand } = require("@aws-sdk/client-s3");
    const s3 = require("../utilities/s3");

    req.on("aborted", () => {
      clientAborted = true;
      if (archive && !archiveFailed) {
        try {
          archive.abort();
        } catch (e) { }
      }
    });

    const {
      month,
      year,
      fromMonth,
      toMonth,
      fromYear,
      toYear,
      empId,
      department,
      designation,
      mode
    } = req.query;

    const filter = {};

    if (empId && empId !== "all" && empId !== "") {
      filter.empId = empId;
    }

    if (mode === "monthly" || (!mode && month)) {
      if (month && month !== "all") filter.month = Number(month);
      if (year && year !== "all") filter.year = Number(year);
    } else if (mode === "custom" && fromYear && toYear) {
      const years = [];
      for (let y = Number(fromYear); y <= Number(toYear); y++) years.push(y);
      filter.year = { $in: years };
    }

    let slips = await SalarySlip.find(filter)
      .populate("empId", "name empId designation department dateJoined dateRelieved")
      .sort({ year: -1, month: -1 })
      .lean();

    if (mode === "custom" && fromMonth && toMonth && fromYear && toYear) {
      const fromVal = Number(fromYear) * 100 + Number(fromMonth);
      const toVal = Number(toYear) * 100 + Number(toMonth);
      slips = slips.filter((slip) => {
        const slipVal = Number(slip.year) * 100 + Number(slip.month);
        return slipVal >= fromVal && slipVal <= toVal;
      });
    }

    if (department && department !== "all") {
      slips = slips.filter((slip) =>
        (slip.empId?.department || slip.department || "").toLowerCase() === department.toLowerCase()
      );
    }

    if (designation && designation !== "all") {
      slips = slips.filter((slip) =>
        (slip.empId?.designation || slip.designation || "").toLowerCase() === designation.toLowerCase()
      );
    }

    if (!slips.length) {
      return res.status(404).json({
        success: false,
        message: "No payslips found matching the filter"
      });
    }

    const monthNames = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"
    ];

    let zipFileName = "Payslips.zip";
    if (mode === "monthly" && month && month !== "all") {
      const mStr = monthNames[Number(month) - 1] || month;
      zipFileName = `Payslips_${mStr}_${year || ""}.zip`;
    } else if (mode === "custom" && fromMonth && toMonth) {
      const fmStr = monthNames[Number(fromMonth) - 1] || fromMonth;
      const tmStr = monthNames[Number(toMonth) - 1] || toMonth;
      zipFileName = `Payslips_${fmStr}_${fromYear}_to_${tmStr}_${toYear}.zip`;
    }

    // Set headers
    res.status(200);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipFileName}"`);
    res.setHeader("Cache-Control", "no-store, no-transform");

    if (typeof res.setTimeout === "function") res.setTimeout(15 * 60 * 1000);
    if (req.socket && typeof req.socket.setTimeout === "function") req.socket.setTimeout(15 * 60 * 1000);

    // Create Archive
    archive =
      typeof archiver === "function"
        ? archiver("zip", { zlib: { level: 6 } })
        : new (archiver.ZipArchive || archiver.Archiver)({ zlib: { level: 6 } });

    archive.on("error", (err) => {
      archiveFailed = true;
      console.error("❌ ARCHIVE ERROR:", err);
      if (!res.writableEnded && !res.destroyed) {
        res.destroy(err);
      }
    });

    // Pipe archive output stream directly to client response
    archive.pipe(res);

    // Process each PDF sequentially, downloading to Buffer first to prevent idle S3 socket timeouts
    for (const slip of slips) {
      if (clientAborted || archiveFailed || archive.destroyed || res.destroyed || res.writableEnded) {
        break;
      }

      try {
        const empCode = slip.empId?.empId || slip.empCode || "Employee";
        const empName = (slip.empId?.name || slip.empName || empCode).replace(/[^a-zA-Z0-9_-]/g, "_");
        const monthLabel = monthNames[Number(slip.month) - 1] || `Month_${slip.month}`;
        const fileName = `${empCode}_${empName}_${monthLabel}_${slip.year}_SalarySlip.pdf`;
        const key = `SalarySlip/${empCode}/${slip.year}/${slip.month}.pdf`;

        let pdfBuffer = null;
        try {
          const s3Response = await s3.send(
            new GetObjectCommand({
              Bucket: process.env.AWS_BUCKET_NAME,
              Key: key
            })
          );

          if (s3Response.Body) {
            pdfBuffer = await streamToBuffer(s3Response.Body);
          }
        } catch (s3Err) {
          try {
            const fullSlip = await formatSalarySlipWithDetails(slip);
            const html = payslipTemplate(fullSlip);
            pdfBuffer = await generatePayslipPdf(html);
            await uploadToS3(pdfBuffer, key, "application/pdf");
          } catch (genErr) {
            console.error(`❌ Failed fallback generation for slip ${slip._id}:`, genErr.message);
          }
        }

        if (clientAborted || archiveFailed || archive.destroyed || res.destroyed || res.writableEnded) {
          break;
        }

        if (pdfBuffer && pdfBuffer.length > 0) {
          // Wait for this entry to be fully processed & written to stream before fetching next S3 file
          await new Promise((resolve) => {
            archive.append(pdfBuffer, { name: fileName });
            archive.once("entry", () => {
              resolve();
            });
          });
        }
      } catch (err) {
        console.error(`❌ Error processing slip ${slip._id}:`, err.message);
      }
    }

    if (!clientAborted && !archiveFailed && !archive.destroyed && !res.destroyed && !res.writableEnded) {
      await archive.finalize();
    }
  } catch (err) {
    console.error("❌ ZIP FATAL ERROR:", err);

    if (!res.headersSent && !res.writableEnded) {
      return res.status(500).json({
        success: false,
        message: err.message || "Failed to generate ZIP"
      });
    }

    if (archive) {
      try { archive.abort(); } catch (e) { }
    }

    if (!res.writableEnded && !res.destroyed) {
      res.destroy(err);
    }
  }
};

exports.downloadMySalarySlipsZip = async (req, res) => {
  try {
    const JSZip = require("jszip");
    const { GetObjectCommand } = require("@aws-sdk/client-s3");
    const s3 = require("../utilities/s3");

    const { month, year, fromMonth, toMonth, fromYear, toYear, mode } = req.query;
    const query = { empId: req.user._id };

    if (mode === "monthly" || (!mode && month)) {
      if (month && month !== "all" && month !== "") query.month = Number(month);
      if (year && year !== "all" && year !== "") query.year = Number(year);
    } else if (mode === "custom" && fromYear && toYear) {
      const years = [];
      for (let y = Number(fromYear); y <= Number(toYear); y++) {
        years.push(y);
      }
      query.year = { $in: years };
    } else if (!mode && !fromMonth && !toMonth) {
      if (month && month !== "all" && month !== "") query.month = Number(month);
      if (year && year !== "all" && year !== "") query.year = Number(year);
    }

    let slips = await SalarySlip.find(query)
      .populate("empId", "name empId designation department dateJoined dateRelieved")
      .sort({ year: -1, month: -1 })
      .lean();

    if (mode === "custom" && fromMonth && toMonth && fromYear && toYear) {
      const fromVal = Number(fromYear) * 100 + Number(fromMonth);
      const toVal = Number(toYear) * 100 + Number(toMonth);
      slips = slips.filter(s => {
        const slipVal = (Number(s.year) || 0) * 100 + (Number(s.month) || 0);
        return slipVal >= fromVal && slipVal <= toVal;
      });
    }

    if (slips.length === 0) {
      return res.status(404).json({ success: false, message: "No payslips found matching the filter" });
    }

    const monthNames = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];

    const zip = new JSZip();

    await pMap(slips, async (slip) => {
      try {
        const empCode = slip.empId?.empId || req.user.empId || "Employee";
        const empName = (slip.empId?.name || req.user.name || "Employee").replace(/[^a-zA-Z0-9_-]/g, "_");
        const monthLabel = monthNames[(slip.month || 1) - 1] || `Month_${slip.month}`;
        const fileName = `${empCode}_${empName}_${monthLabel}_${slip.year}_Salaryslip.pdf`;

        const expectedKey = `SalarySlip/${empCode}/${slip.year}/${slip.month}.pdf`;
        let key = expectedKey;
        if (slip.pdfUrl) {
          try {
            const urlObj = new URL(slip.pdfUrl);
            key = urlObj.pathname.startsWith('/') ? urlObj.pathname.slice(1) : urlObj.pathname;
          } catch (e) {
            key = expectedKey;
          }
        }

        let pdfBuffer = null;
        try {
          const s3Res = await s3.send(
            new GetObjectCommand({
              Bucket: process.env.AWS_BUCKET_NAME,
              Key: key,
            })
          );
          pdfBuffer = await streamToBuffer(s3Res.Body);
        } catch (s3Err) {
          try {
            const fullSlip = await formatSalarySlipWithDetails(slip);
            const html = payslipTemplate(fullSlip);
            pdfBuffer = await generatePayslipPdf(html);
            await uploadToS3(pdfBuffer, expectedKey, "application/pdf");
          } catch (genErr) {
            console.error(`Could not generate PDF for slip ${slip._id}:`, genErr.message);
          }
        }

        if (pdfBuffer && pdfBuffer.length > 0) {
          zip.file(fileName, pdfBuffer);
        }
      } catch (slipErr) {
        console.error(`Error adding slip ${slip._id} to zip:`, slipErr.message);
      }
    }, 15);

    console.log("PDF processing completed");
    console.log("Generating ZIP...");
    const zipBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    console.log("ZIP generated successfully");
    console.log("ZIP size:", zipBuffer.length);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="Payslips.zip"`);
    res.setHeader("Content-Length", zipBuffer.length);
    return res.status(200).send(zipBuffer);
  } catch (err) {
    console.error("downloadMySalarySlipsZip error:", err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
};

exports.getEmployeesForPayroll = async (req, res) => {
  try {
    let { month, year } = req.query;

    // ✅ STEP 0: VALIDATION
    month = Number(month);
    year = Number(year);

    if (!month || !year) {
      return res.status(400).json({
        success: false,
        message: "Month and Year are required"
      });
    }
    const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
    const end = new Date(Date.UTC(year, month, 0, 23, 59, 59));
    // ✅ STEP 1: Fetch Existing Slips to mark generated status
    const existingSlips = await SalarySlip.find({
      month,
      year
    }).select("empId").lean();

    const existingEmpIds = new Set(existingSlips.map(s => s.empId.toString()));

    // ✅ STEP 2: Fetch eligible employees for period
    const employees = await Employee.find({
      role: "employee",
      dateJoined: { $lte: end },
      $or: [
        { dateRelieved: { $exists: false } },
        { dateRelieved: null },
        { dateRelieved: { $gte: start } }
      ]
    }).lean();

    // ✅ STEP 3: Map employee details with hasGeneratedSlip flag
    const finalData = await Promise.all(
      employees.map(async (emp) => {

        const details = await EmployeeDetails.findOne({
          empId: emp._id
        }).lean();

        if (!details) {
          console.warn("No EmployeeDetails for:", emp._id);
        }

        const salaryHistory = details?.salaryHistory || [];
        const bankHistory = (details?.bankHistory || []).map(row => {
          if (row.accountNumber) {
            try {
              return { ...row, accountNumber: decrypt(row.accountNumber) };
            } catch (err) {
              return row;
            }
          }
          return row;
        });

        const hasSalary = salaryHistory.length > 0;
        const hasGeneratedSlip = existingEmpIds.has(emp._id.toString());

        // Calculate deducted/prorated salary for relieved/joined employees
        const monthDays = new Date(year, month, 0).getDate();
        let payableDays = monthDays;

        if (emp.dateRelieved) {
          const relDate = new Date(emp.dateRelieved);
          if (!isNaN(relDate.getTime()) && (relDate.getUTCMonth() + 1 === month) && (relDate.getUTCFullYear() === year)) {
            payableDays = relDate.getUTCDate();
          }
        } else if (emp.dateJoined) {
          const joinDate = new Date(emp.dateJoined);
          if (!isNaN(joinDate.getTime()) && (joinDate.getUTCMonth() + 1 === month) && (joinDate.getUTCFullYear() === year)) {
            payableDays = monthDays - joinDate.getUTCDate() + 1;
          }
        }

        // Get applicable salary row
        const salaryRow = getLatestApplicableSalary(salaryHistory, month, year);

        const fullBasic = Number(salaryRow?.basicSalary || 0);
        const allowances = salaryRow?.allowances || [];
        const fullSalary = Number(salaryRow?.totalSalary || (fullBasic + allowances.reduce((s, a) => s + Number(a.amount ?? a.value ?? 0), 0)));

        const lopResult = await calculateEmployeeLop({
          employeeId: emp._id,
          month,
          year,
          applicableMonthlySalary: fullSalary,
          employeeObj: emp,
        });

        const prorationRatio = Math.min(1, Math.max(0, payableDays / monthDays));
        const deductedBasicSalary = Math.round(fullBasic * prorationRatio);
        const deductedAllowances = allowances.map(a => ({
          label: a.label || a.name || "",
          amount: Math.round(Number(a.amount ?? a.value ?? 0) * prorationRatio)
        }));

        const rawAccountNumber = details?.accountNumber || "-";
        const decryptedAccount = rawAccountNumber !== "-" ? decrypt(rawAccountNumber) : "-";

        return {
          ...emp,
          salaryHistory,
          bankHistory,

          accountNumber: decryptedAccount,
          bankName: details?.bankName || "-",
          branchName: details?.branch || "-",
          ifscCode: details?.ifscCode || "-",

          hasSalary,
          hasGeneratedSlip,
          hasLop: lopResult.hasLop,
          ...(lopResult.hasLop ? { lopDays: lopResult.lopDays, lopAmount: lopResult.lopAmount } : {}),

          deductedSalary: {
            basicSalary: deductedBasicSalary,
            allowances: deductedAllowances,
            payableDays,
            monthDays
          }
        };
      })
    );

    return res.json({
      success: true,
      data: finalData
    });

  } catch (err) {
    console.error("❌ getEmployeesForPayroll error:", err);
    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
};

