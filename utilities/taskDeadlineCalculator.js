/**
 * Task Deadline & Eligible Working Days Calculator
 *
 * Excludes from calculation:
 * 1. Sundays and 2nd & 4th Saturdays (Weekly Offs)
 * 2. Company Holidays (from Holiday.model and approved HolidayAssignment)
 * 3. Employee's Approved Leaves (from LeaveRequest model)
 *
 * Calculates Deadline Score using:
 * Deadline Score = max(0, 100 - 5 * L)
 * where L is the number of eligible working days late after the due date.
 */

const moment = require("moment-timezone");
const mongoose = require("mongoose");
const Holiday = require("../Models/Holiday.model");
const HolidayAssignment = require("../Models/Holiday Assignment");
const LeaveRequest = require("../Models/LeaveRequest");

const TZ = "Asia/Kolkata";

// In-memory cache for company holidays (5 minute TTL)
let cachedHolidays = null;
let holidaysCacheExpiry = 0;

/**
 * Checks if a given date is a weekly off:
 * - Sundays (day 0)
 * - 2nd and 4th Saturdays (day 6, week 2 or 4 of the month)
 */
function isWeeklyOff(mDate) {
  const m = moment.isMoment(mDate) ? mDate : moment.tz(mDate, TZ);
  const day = m.day();
  const d = m.date();

  // Sunday
  if (day === 0) return true;

  // Saturday: check 2nd and 4th Saturday of the month
  if (day === 6) {
    const weekNum = Math.ceil(d / 7);
    if (weekNum === 2 || weekNum === 4) return true;
  }

  return false;
}

/**
 * Fetches all company holidays and returns a Set of "YYYY-MM-DD" date strings.
 * Combines Holiday collection and approved HolidayAssignment collection.
 */
async function fetchCompanyHolidaysSet(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedHolidays && now < holidaysCacheExpiry) {
    return cachedHolidays;
  }

  const holidaySet = new Set();

  try {
    // 1. Holiday collection (Models/Holiday.model)
    const hols = await Holiday.find({}).lean();
    hols.forEach((h) => {
      if (h.date) {
        const m = moment.tz(h.date, TZ);
        if (m.isValid()) {
          holidaySet.add(m.format("YYYY-MM-DD"));
        }
      }
    });

    // 2. HolidayAssignment collection (Models/Holiday Assignment)
    const assignments = await HolidayAssignment.find({
      status: { $regex: /^approved$/i },
    }).lean();

    assignments.forEach((assign) => {
      const year = assign.year;
      if (Array.isArray(assign.months)) {
        assign.months.forEach((mObj) => {
          const month = mObj.month;
          if (Array.isArray(mObj.governmentHolidays)) {
            mObj.governmentHolidays.forEach((h) => {
              if (h.date) {
                const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(h.date).padStart(2, "0")}`;
                holidaySet.add(dateStr);
              }
            });
          }
        });
      }
    });

    cachedHolidays = holidaySet;
    holidaysCacheExpiry = now + 5 * 60 * 1000; // 5 min TTL
  } catch (err) {
    console.error("Error fetching company holidays:", err);
    return cachedHolidays || new Set();
  }

  return holidaySet;
}

/**
 * Fetches approved leave dates for a specific employee from LeaveRequest model.
 * Returns a Set of "YYYY-MM-DD" strings.
 */
async function fetchEmployeeApprovedLeavesSet(employeeId) {
  if (!employeeId) return new Set();

  const leaveSet = new Set();
  try {
    const empId = mongoose.Types.ObjectId.isValid(employeeId)
      ? new mongoose.Types.ObjectId(employeeId.toString())
      : employeeId;

    const approvedLeaves = await LeaveRequest.find({
      employeeId: empId,
      status: { $regex: /^approved$/i },
    }).lean();

    approvedLeaves.forEach((leave) => {
      if (Array.isArray(leave.leaveDates) && leave.leaveDates.length > 0) {
        leave.leaveDates.forEach((dStr) => {
          const m = moment.tz(dStr, TZ);
          if (m.isValid()) {
            leaveSet.add(m.format("YYYY-MM-DD"));
          }
        });
      } else if (leave.fromDate && leave.toDate) {
        const curr = moment.tz(leave.fromDate, TZ).startOf("day");
        const end = moment.tz(leave.toDate, TZ).startOf("day");
        while (curr.isSameOrBefore(end)) {
          leaveSet.add(curr.format("YYYY-MM-DD"));
          curr.add(1, "day");
        }
      }
    });
  } catch (err) {
    console.error(`Error fetching approved leaves for employee ${employeeId}:`, err);
  }

  return leaveSet;
}

/**
 * Batch-fetches approved leaves for multiple employees.
 * Returns a Map: employeeIdString -> Set of "YYYY-MM-DD".
 */
async function fetchTeamApprovedLeavesMap(employeeIds = []) {
  const map = new Map();
  if (!Array.isArray(employeeIds) || employeeIds.length === 0) return map;

  try {
    const validIds = employeeIds
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id.toString()));

    if (validIds.length === 0) return map;

    const approvedLeaves = await LeaveRequest.find({
      employeeId: { $in: validIds },
      status: { $regex: /^approved$/i },
    }).lean();

    approvedLeaves.forEach((leave) => {
      const empIdStr = leave.employeeId?.toString();
      if (!empIdStr) return;

      if (!map.has(empIdStr)) {
        map.set(empIdStr, new Set());
      }
      const leaveSet = map.get(empIdStr);

      if (Array.isArray(leave.leaveDates) && leave.leaveDates.length > 0) {
        leave.leaveDates.forEach((dStr) => {
          const m = moment.tz(dStr, TZ);
          if (m.isValid()) {
            leaveSet.add(m.format("YYYY-MM-DD"));
          }
        });
      } else if (leave.fromDate && leave.toDate) {
        const curr = moment.tz(leave.fromDate, TZ).startOf("day");
        const end = moment.tz(leave.toDate, TZ).startOf("day");
        while (curr.isSameOrBefore(end)) {
          leaveSet.add(curr.format("YYYY-MM-DD"));
          curr.add(1, "day");
        }
      }
    });
  } catch (err) {
    console.error("Error batch-fetching team approved leaves:", err);
  }

  return map;
}

/**
 * Determines whether a given date is an eligible working day for an employee:
 * - Must NOT be a weekly off (Sunday or 2nd/4th Saturday)
 * - Must NOT be a company holiday
 * - Must NOT be an approved leave date for this employee
 */
function isEligibleWorkingDay(dateInput, holidaysSet = new Set(), employeeLeavesSet = new Set()) {
  const m = moment.isMoment(dateInput) ? dateInput : moment.tz(dateInput, TZ);
  const dateStr = m.format("YYYY-MM-DD");

  if (isWeeklyOff(m)) return false;
  if (holidaysSet && holidaysSet.has(dateStr)) return false;
  if (employeeLeavesSet && employeeLeavesSet.has(dateStr)) return false;

  return true;
}

/**
 * Calculates the number of eligible working days between startDate and dueDate (inclusive).
 * Also counts excluded non-working days (weekoffs, holidays, approved leaves).
 */
function calculateEligibleWorkingDays(startDate, dueDate, holidaysSet = new Set(), employeeLeavesSet = new Set()) {
  if (!startDate || !dueDate) return { eligibleDays: 0, excludedDays: 0 };

  const start = moment.tz(startDate, TZ).startOf("day");
  const due = moment.tz(dueDate, TZ).startOf("day");

  if (due.isBefore(start)) return { eligibleDays: 0, excludedDays: 0 };

  let eligibleDays = 0;
  let excludedDays = 0;

  const curr = start.clone();
  while (curr.isSameOrBefore(due)) {
    if (isEligibleWorkingDay(curr, holidaysSet, employeeLeavesSet)) {
      eligibleDays++;
    } else {
      excludedDays++;
    }
    curr.add(1, "day");
  }

  return { eligibleDays, excludedDays };
}

/**
 * Calculates deadline performance score based on eligible working days:
 * - Completed on or before due date: 100 points
 * - Completed after due date: L eligible working days late
 *   Score = max(0, 100 - 5 * L)
 * - Unfinished tasks past due date: evaluated using current date as target
 * - Rejected tasks: 0 points
 *
 * @param {Date|string} dueDate - Deadline
 * @param {Date|string} endDate - Completion date if completed
 * @param {string} status - Canonical or raw status (COMPLETED, IN_PROGRESS, REJECTED, etc.)
 * @param {Set<string>} holidaysSet - Company holidays
 * @param {Set<string>} employeeLeavesSet - Employee's approved leaves
 * @param {Date} now - Reference current date
 */
function calculateDeadlineScore(
  dueDate,
  endDate,
  status = "COMPLETED",
  holidaysSet = new Set(),
  employeeLeavesSet = new Set(),
  now = new Date()
) {
  const normalizedStatus = String(status || "").trim().toUpperCase();

  if (["REJECTED", "IGNORED", "CANCELLED", "CANCELED"].includes(normalizedStatus)) {
    return {
      eligibleDaysLate: 20,
      deadlineScore: 0,
      isAhead: false,
      isOnTime: false,
      isLate: true,
      isOverdue: false,
      excludedLateDays: 0,
    };
  }

  if (!dueDate) {
    return {
      eligibleDaysLate: 0,
      deadlineScore: 100,
      isAhead: false,
      isOnTime: true,
      isLate: false,
      isOverdue: false,
      excludedLateDays: 0,
    };
  }

  const dueDay = moment.tz(dueDate, TZ).startOf("day");
  const isCompleted = ["COMPLETED", "COMPLETE", "DONE", "FINISHED"].includes(normalizedStatus);
  const targetDate = isCompleted ? (endDate ? new Date(endDate) : new Date(now)) : new Date(now);
  const targetDay = moment.tz(targetDate, TZ).startOf("day");

  if (targetDay.isSameOrBefore(dueDay)) {
    const isAhead = targetDay.isBefore(dueDay) && isCompleted;
    const isOnTime = targetDay.isSame(dueDay) || (!isAhead && isCompleted);
    return {
      eligibleDaysLate: 0,
      deadlineScore: 100,
      isAhead,
      isOnTime,
      isLate: false,
      isOverdue: false,
      excludedLateDays: 0,
    };
  }

  // Target day is after due date: count eligible working days between (dueDay + 1) and targetDay
  let L = 0;
  let excludedLateDays = 0;

  const curr = dueDay.clone().add(1, "day");
  while (curr.isSameOrBefore(targetDay)) {
    if (isEligibleWorkingDay(curr, holidaysSet, employeeLeavesSet)) {
      L++;
    } else {
      excludedLateDays++;
    }
    curr.add(1, "day");
  }

  const deadlineScore = Math.max(0, 100 - 5 * L);

  return {
    eligibleDaysLate: L,
    deadlineScore,
    isAhead: false,
    isOnTime: false,
    isLate: isCompleted,
    isOverdue: !isCompleted,
    excludedLateDays,
  };
}

module.exports = {
  TZ,
  isWeeklyOff,
  fetchCompanyHolidaysSet,
  fetchEmployeeApprovedLeavesSet,
  fetchTeamApprovedLeavesMap,
  isEligibleWorkingDay,
  calculateEligibleWorkingDays,
  calculateDeadlineScore,
};
