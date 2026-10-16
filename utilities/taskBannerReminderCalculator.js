/**
 * Task Banner Reminder Calculator
 *
 * Requirements:
 * 1. Company working hours: 10:00 AM to 7:00 PM (10:00 to 19:00 = 9 working hours/day).
 * 2. Exclude Sundays, 2nd & 4th Saturdays, company holidays (Holiday model & HolidayAssignment),
 *    approved leaves (LeaveRequest), and recorded absences (Attendance).
 * 3. Support full-day and partial-day (half-day) leave/absence without double counting.
 * 4. Same-day task / deadline:
 *    - Assigned 10:00 AM to 2:59 PM: Reminder delayed until 3:00 PM.
 *    - Assigned 3:00 PM or later: Banner appears immediately.
 * 5. Longer tasks (future due dates): Show when remaining eligible working hours <= 25% of total eligible working hours.
 * 6. Incomplete overdue tasks: Show OVERDUE banner (after 7:00 PM on due date).
 * 7. Completed, cancelled, and rejected tasks: Never show active reminder banner.
 */

const moment = require("moment-timezone");
const mongoose = require("mongoose");
const Holiday = require("../Models/Holiday.model");
const HolidayAssignment = require("../Models/Holiday Assignment");
const LeaveRequest = require("../Models/LeaveRequest");
const Attendance = require("../Models/Attendance.model");
const { isWeeklyOff, fetchCompanyHolidaysSet, TZ } = require("./taskDeadlineCalculator");

const WORK_START_HOUR = 10; // 10:00 AM
const WORK_END_HOUR = 19;   // 7:00 PM (19:00)
const FULL_DAY_HOURS = 9;   // 10:00 AM - 7:00 PM = 9 hours
const HALF_DAY_HOURS = 4.5; // Half day deduction = 4.5 hours
const THREE_PM_HOUR = 15;   // 3:00 PM

/**
 * Loads employee-specific working calendar containing:
 * - Company holidays (Set of YYYY-MM-DD)
 * - Approved leaves (Set of full-day and half-day dates)
 * - Recorded absences (Set of absent dates)
 */
async function getEmployeeWorkingCalendar(employeeId) {
  const holidaysSet = await fetchCompanyHolidaysSet();
  const fullDayLeavesSet = new Set();
  const halfDayLeavesSet = new Set();
  const absentDatesSet = new Set();

  if (!employeeId) {
    return {
      holidaysSet,
      fullDayLeavesSet,
      halfDayLeavesSet,
      absentDatesSet,
      isNonWorkingDay: (dStr) => {
        const m = moment.tz(dStr, TZ);
        return isWeeklyOff(m) || holidaysSet.has(dStr);
      },
      isHalfDay: () => false,
    };
  }

  try {
    const empObjId = mongoose.Types.ObjectId.isValid(employeeId)
      ? new mongoose.Types.ObjectId(employeeId.toString())
      : employeeId;

    // 1. Fetch Approved Leaves
    const approvedLeaves = await LeaveRequest.find({
      employeeId: empObjId,
      status: { $regex: /^approved$/i },
    }).lean();

    approvedLeaves.forEach((leave) => {
      const isHalf = String(leave.dayType || "").trim().toLowerCase() === "half day";
      const targetSet = isHalf ? halfDayLeavesSet : fullDayLeavesSet;

      if (Array.isArray(leave.leaveDates) && leave.leaveDates.length > 0) {
        leave.leaveDates.forEach((dStr) => {
          const m = moment.tz(dStr, TZ);
          if (m.isValid()) targetSet.add(m.format("YYYY-MM-DD"));
        });
      } else if (leave.fromDate && leave.toDate) {
        const curr = moment.tz(leave.fromDate, TZ).startOf("day");
        const end = moment.tz(leave.toDate, TZ).startOf("day");
        while (curr.isSameOrBefore(end)) {
          targetSet.add(curr.format("YYYY-MM-DD"));
          curr.add(1, "day");
        }
      }
    });

    // 2. Fetch Recorded Absences
    const absences = await Attendance.find({
      employeeId: empObjId,
      status: { $regex: /^absent$/i },
    }).lean();

    absences.forEach((att) => {
      if (att.date) {
        const m = moment.tz(att.date, TZ);
        if (m.isValid()) absentDatesSet.add(m.format("YYYY-MM-DD"));
      }
    });
  } catch (err) {
    console.error("Error loading employee working calendar:", err);
  }

  const isNonWorkingDay = (dateStr) => {
    const m = moment.tz(dateStr, TZ);
    if (isWeeklyOff(m)) return true;
    if (holidaysSet && holidaysSet.has(dateStr)) return true;
    if (fullDayLeavesSet.has(dateStr)) return true;
    if (absentDatesSet.has(dateStr)) return true;
    return false;
  };

  const isHalfDay = (dateStr) => {
    return halfDayLeavesSet.has(dateStr);
  };

  return {
    holidaysSet,
    fullDayLeavesSet,
    halfDayLeavesSet,
    absentDatesSet,
    isNonWorkingDay,
    isHalfDay,
  };
}

/**
 * Calculates eligible working hours between two timestamps:
 * Working window: 10:00 AM to 7:00 PM (10:00 - 19:00).
 * Excludes non-working days (weekoffs, holidays, full-day leaves, absences).
 * Subtracts 4.5 hours for half-day leaves without double counting.
 */
function calculateEligibleWorkingHours(startInput, endInput, calendar) {
  if (!startInput || !endInput) return 0;

  const startM = moment.isMoment(startInput) ? startInput.clone() : moment.tz(startInput, TZ);
  const endM = moment.isMoment(endInput) ? endInput.clone() : moment.tz(endInput, TZ);

  if (endM.isSameOrBefore(startM)) return 0;

  let totalHours = 0;
  const cur = startM.clone().startOf("day");
  const lastDay = endM.clone().startOf("day");

  while (cur.isSameOrBefore(lastDay)) {
    const dateStr = cur.format("YYYY-MM-DD");

    // If whole day is non-working, count 0 hours
    if (!calendar.isNonWorkingDay(dateStr)) {
      const workStart = cur.clone().hours(WORK_START_HOUR).minutes(0).seconds(0).milliseconds(0);
      const workEnd = cur.clone().hours(WORK_END_HOUR).minutes(0).seconds(0).milliseconds(0);

      const effectiveStart = moment.max(workStart, startM);
      const effectiveEnd = moment.min(workEnd, endM);

      if (effectiveEnd.isAfter(effectiveStart)) {
        const ms = effectiveEnd.diff(effectiveStart);
        let hours = ms / (1000 * 60 * 60);

        // Deduct half day if applicable (only if not already a full non-working day)
        if (calendar.isHalfDay(dateStr)) {
          hours = Math.max(0, hours - HALF_DAY_HOURS);
        }

        totalHours += hours;
      }
    }

    cur.add(1, "day");
  }

  return Number(totalHours.toFixed(2));
}

/**
 * Checks whether an input date represents a date-only value (without a specific time-of-day).
 * Detects:
 * - String "YYYY-MM-DD"
 * - UTC midnight (00:00:00.000Z), which is how HTML date inputs are stored in MongoDB
 * - Asia/Kolkata midnight (00:00:00)
 */
function isDateOnly(dateInput) {
  if (!dateInput) return false;
  if (typeof dateInput === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateInput.trim())) {
    return true;
  }
  const utcM = moment.utc(dateInput);
  if (!utcM.isValid()) return false;
  if (utcM.hours() === 0 && utcM.minutes() === 0 && utcM.seconds() === 0 && utcM.milliseconds() === 0) {
    return true;
  }
  const istM = moment.tz(dateInput, TZ);
  if (istM.hours() === 0 && istM.minutes() === 0 && istM.seconds() === 0 && istM.milliseconds() === 0) {
    return true;
  }
  return false;
}

/**
 * Calculates reminder window for a task with D eligible working days:
 * - 1 working day (D <= 1): Final 4 eligible working hours
 * - 2 working days (1 < D <= 2): Final 4 eligible working hours
 * - 3 working days (2 < D <= 3): Final 1 eligible working day (9 eligible working hours)
 * - 4–6 working days (3 < D <= 6): Final 2 eligible working days (18 eligible working hours)
 * - 7–10 working days (6 < D <= 10): Final 3 eligible working days (27 eligible working hours)
 * - Longer than 10 working days:
 *     W = min(10, max(3, ceil(D * 0.25))) eligible working days
 *     firstReminderDay = D - W + 1
 *
 * @param {number} D - Total eligible working day equivalents
 * @returns {Object} { windowDays: number, windowHours: number, firstReminderDay: number }
 */
function calculateReminderWindow(D) {
  if (D <= 0) {
    return { windowDays: 0, windowHours: 0, firstReminderDay: 1 };
  }

  // 1–2 working days: Final 4 eligible working hours
  if (D <= 2) {
    return {
      windowDays: Number((4 / FULL_DAY_HOURS).toFixed(2)),
      windowHours: 4,
      firstReminderDay: D,
    };
  }

  // 3 working days: Final 1 eligible working day (9 eligible working hours)
  if (D <= 3) {
    return {
      windowDays: 1,
      windowHours: 1 * FULL_DAY_HOURS,
      firstReminderDay: D,
    };
  }

  // 4–6 working days: Final 2 eligible working days (18 eligible working hours)
  if (D <= 6) {
    return {
      windowDays: 2,
      windowHours: 2 * FULL_DAY_HOURS,
      firstReminderDay: D - 2 + 1,
    };
  }

  // 7–10 working days: Final 3 eligible working days (27 eligible working hours)
  if (D <= 10) {
    return {
      windowDays: 3,
      windowHours: 3 * FULL_DAY_HOURS,
      firstReminderDay: D - 3 + 1,
    };
  }

  // Longer than 10 working days:
  // W = min(10, max(3, ceil(D * 0.25)))
  const W = Math.min(10, Math.max(3, Math.ceil(D * 0.25)));
  const firstReminderDay = D - W + 1;

  return {
    windowDays: W,
    windowHours: W * FULL_DAY_HOURS,
    firstReminderDay,
  };
}

/**
 * Evaluates the banner reminder state for a task.
 *
 * Implements the exact decision order:
 * Rule 1: Terminal tasks -> hide reminder
 * Rule 2: Invalid or missing deadline -> hide reminder
 * Rule 3: Overdue task -> show OVERDUE banner
 * Rule 4: Due today -> before 3:00 PM hide; 3:00 PM to 7:00 PM show DUE_TODAY; after 7:00 PM show OVERDUE
 * Rule 5: Future deadline -> evaluate eligible duration D and reminder window W; show DUE_SOON when remaining working time <= W
 *
 * @param {Object} task - The task object
 * @param {Object} calendar - The employee working calendar
 * @param {Date|moment} now - Current reference time
 * @returns {Object} { show: boolean, type: "OVERDUE"|"DUE_SOON"|"DUE_TODAY"|null, ...metrics }
 */
function evaluateTaskBannerState(task, calendar, now = new Date()) {
  const normStatus = String(task.status || "").trim().toUpperCase();
  const normAssignedStatus = String(task.assignedStatus || "").trim().toUpperCase();

  // ── Rule 1: Terminal tasks ──
  // Completed, cancelled, or rejected tasks: NEVER show active deadline reminder
  if (
    ["COMPLETED", "COMPLETE", "DONE", "FINISHED", "CANCELLED", "CANCELED", "REJECTED", "IGNORED"].includes(normStatus) ||
    ["REJECTED"].includes(normAssignedStatus)
  ) {
    return { show: false, type: null, reason: "TERMINAL_STATUS" };
  }

  // ── Rule 2: Invalid or missing deadline ──
  if (!task.dueDate) {
    return { show: false, type: null, reason: "NO_DUE_DATE" };
  }

  const nowM = moment.isMoment(now) ? now.clone() : moment.tz(now, TZ);
  const dueM = moment.tz(task.dueDate, TZ);

  if (!dueM.isValid()) {
    return { show: false, type: null, reason: "INVALID_DUE_DATE" };
  }

  // Date-only deadline: default working deadline is 7:00 PM (19:00:00) IST on that date
  const dueTime = isDateOnly(task.dueDate)
    ? dueM.clone().hours(WORK_END_HOUR).minutes(0).seconds(0).milliseconds(0)
    : dueM;

  // ── Rule 3: Overdue task ──
  // Current time is past the effective due timestamp and task is active & incomplete
  // Do not suppress overdue status merely because current date is weekly off, holiday, leave, or absence
  if (nowM.isAfter(dueTime)) {
    return {
      show: true,
      type: "OVERDUE",
      isOverdue: true,
      dueTime: dueTime.toISOString(),
      message: "Your assigned task is past its due date. Please complete it as soon as possible.",
    };
  }

  // ── Calculate task duration D and remaining time R ──
  // Start date fallback: startDate -> createdDate -> createdAt -> now
  const sDate = task.startDate || task.createdDate || task.createdAt;
  let startM;
  if (sDate) {
    startM = moment.tz(sDate, TZ);
    if (isDateOnly(sDate)) {
      startM = startM.clone().hours(WORK_START_HOUR).minutes(0).seconds(0).milliseconds(0);
    }
  } else {
    startM = nowM.clone().hours(WORK_START_HOUR).minutes(0).seconds(0).milliseconds(0);
  }

  const totalWorkingHours = calculateEligibleWorkingHours(startM, dueTime, calendar);
  const remainingWorkingHours = calculateEligibleWorkingHours(nowM, dueTime, calendar);

  // D = total eligible working-day equivalents
  // R = remaining eligible working-day equivalents
  const D = Number((totalWorkingHours / FULL_DAY_HOURS).toFixed(2));
  const R = Number((remainingWorkingHours / FULL_DAY_HOURS).toFixed(2));
  const reminder = calculateReminderWindow(D);

  // ── Rule 4: Due today ──
  // Incomplete task whose effective due date is today:
  // - Before 3:00 PM IST: do not show DUE_TODAY reminder
  // - From 3:00 PM IST until effective deadline (7:00 PM): show DUE_TODAY
  // - After effective deadline: Rule 3 already handled (OVERDUE)
  const isDueToday = dueTime.isSame(nowM, "day");
  if (isDueToday) {
    if (nowM.hours() >= THREE_PM_HOUR) {
      return {
        show: true,
        type: "DUE_TODAY",
        isDueToday: true,
        totalWorkingDays: D,
        remainingWorkingDays: R,
        totalWorkingHours,
        remainingWorkingHours,
        reminderWindowDays: reminder.windowDays,
        reminderWindowHours: reminder.windowHours,
        firstReminderDay: reminder.firstReminderDay,
        dueTime: dueTime.toISOString(),
        message: "Task is due today. Please complete your task before the due date.",
      };
    }
    return {
      show: false,
      type: null,
      isDueToday: true,
      totalWorkingDays: D,
      remainingWorkingDays: R,
      totalWorkingHours,
      remainingWorkingHours,
      reminderWindowDays: reminder.windowDays,
      reminderWindowHours: reminder.windowHours,
      firstReminderDay: reminder.firstReminderDay,
      dueTime: dueTime.toISOString(),
      reason: "SAME_DAY_BEFORE_3PM",
      message: "Reminder will appear at 3:00 PM.",
    };
  }

  // ── Rule 5: Future deadline ──
  if (totalWorkingHours <= 0) {
    return {
      show: false,
      type: null,
      totalWorkingDays: D,
      remainingWorkingDays: R,
      totalWorkingHours,
      remainingWorkingHours,
      reason: "ZERO_HOURS",
    };
  }

  // Check if current time is inside the calculated reminder window
  const isInsideWindow = remainingWorkingHours <= reminder.windowHours;

  if (isInsideWindow) {
    let reminderText;
    if (D <= 2) {
      reminderText = "Task deadline is approaching. Please complete your task before the due date.";
    } else if (D <= 3) {
      reminderText = "Task deadline is approaching (final eligible working day).";
    } else if (D <= 6) {
      reminderText = "Task deadline is approaching (final 2 eligible working days).";
    } else if (D <= 10) {
      reminderText = "Task deadline is approaching (final 3 eligible working days).";
    } else {
      reminderText = `Task deadline is approaching (final ${reminder.windowDays} eligible working days).`;
    }

    return {
      show: true,
      type: "DUE_SOON",
      isDueSoon: true,
      totalWorkingDays: D,
      remainingWorkingDays: R,
      totalWorkingHours,
      remainingWorkingHours,
      reminderWindowDays: reminder.windowDays,
      reminderWindowHours: reminder.windowHours,
      firstReminderDay: reminder.firstReminderDay,
      dueTime: dueTime.toISOString(),
      message: reminderText,
    };
  }

  return {
    show: false,
    type: null,
    totalWorkingDays: D,
    remainingWorkingDays: R,
    totalWorkingHours,
    remainingWorkingHours,
    reminderWindowDays: reminder.windowDays,
    reminderWindowHours: reminder.windowHours,
    firstReminderDay: reminder.firstReminderDay,
    dueTime: dueTime.toISOString(),
    reason: "BEFORE_REMINDER_WINDOW",
  };
}

/**
 * Top-level async helper to compute banner state for a task and employee
 */
async function getTaskBannerState(task, employeeId, now = new Date()) {
  const calendar = await getEmployeeWorkingCalendar(employeeId);
  return evaluateTaskBannerState(task, calendar, now);
}

module.exports = {
  WORK_START_HOUR,
  WORK_END_HOUR,
  FULL_DAY_HOURS,
  HALF_DAY_HOURS,
  THREE_PM_HOUR,
  isDateOnly,
  calculateReminderWindow,
  getEmployeeWorkingCalendar,
  calculateEligibleWorkingHours,
  evaluateTaskBannerState,
  getTaskBannerState,
};
