const cron = require("node-cron");
const moment = require("moment-timezone");
const Holiday = require("../Models/Holiday.model");
const AttendanceConfig = require("../Models/AttendanceConfig.model");
const { autoCheckoutUnclosedAttendances } = require("../controllers/attendance.controller");
const { sendDailyAttendanceReportEmail } = require("../Services/dailyAttendanceReportEmail.service");

const isNonWorkingDay = async (date) => {
  const m = date
    ? moment.tz(date, "YYYY-MM-DD", "Asia/Kolkata")
    : moment().tz("Asia/Kolkata");

  const dateStr = m.format("YYYY-MM-DD");
  const weekday = m.day(); // 0 = Sunday, 6 = Saturday
  const dayOfMonth = m.date();

  // 1. Sunday
  if (weekday === 0) {
    return { isOff: true, reason: "Sunday" };
  }

  // 2. 2nd and 4th Saturday
  if (weekday === 6) {
    const saturdayRank = Math.ceil(dayOfMonth / 7);
    if (saturdayRank === 2 || saturdayRank === 4) {
      return { isOff: true, reason: `${saturdayRank === 2 ? "2nd" : "4th"} Saturday` };
    }
  }

  // 3. Holiday from database
  const holiday = await Holiday.findOne({ date: dateStr });
  if (holiday) {
    return { isOff: true, reason: `Holiday (${holiday.holidayName || holiday.name || holiday.title || "Holiday"})` };
  }

  return { isOff: false };
};

// ✅ PRIMARY CRON: Runs every day at 8:00 PM IST
cron.schedule("0 20 * * *", async () => {
  try {
    const offCheck = await isNonWorkingDay();
    if (offCheck.isOff) {
      console.log(`[CRON] Non-working day detected (${offCheck.reason}), skipping 8:00 PM auto-checkout`);
      return;
    }
    console.log("[CRON] 8:00 PM Attendance auto-checkout started");
    const count = await autoCheckoutUnclosedAttendances();
    console.log(`[CRON] Auto checkout done for ${count} records`);
  } catch (err) {
    console.error("[CRON] 8:00 PM Auto checkout failed", err);
  }
}, {
  timezone: "Asia/Kolkata",
});

// ============================================================================
// DAILY ATTENDANCE REPORT EMAIL CRON (COMMENTED OUT TEMPORARILY)
// ============================================================================
/*
let dailyReportCronTask = null;

const executeDailyAttendanceReportJob = async () => {
  try {
    const offCheck = await isNonWorkingDay();
    if (offCheck.isOff) {
      console.log(`[CRON] Non-working day detected (${offCheck.reason}), skipping attendance report email`);
      return;
    }
    console.log("[CRON] Daily Attendance report email cron started");
    await sendDailyAttendanceReportEmail();
    console.log("[CRON] Daily Attendance report email cron finished");
  } catch (err) {
    console.error("[CRON] Daily Attendance report email cron failed", err);
  }
};
*/

/**
 * Dynamically reschedule or start the daily attendance report cron job
 * @param {string} timeStr - "HH:mm" in 24h format (e.g. "20:01")
 * @param {boolean} isEnabled - whether report email is enabled
 */
const rescheduleDailyAttendanceReportCron = (timeStr = "20:01", isEnabled = true) => {
  /*
  if (dailyReportCronTask) {
    dailyReportCronTask.stop();
    dailyReportCronTask = null;
  }

  if (!isEnabled) {
    console.log("[CRON] Daily Attendance Report email is disabled by Admin setting.");
    return;
  }

  const [hStr, mStr] = (timeStr || "20:01").split(":");
  const hour = parseInt(hStr, 10);
  const minute = parseInt(mStr, 10);

  const safeHour = isNaN(hour) || hour < 0 || hour > 23 ? 20 : hour;
  const safeMinute = isNaN(minute) || minute < 0 || minute > 59 ? 1 : minute;

  const cronPattern = `${safeMinute} ${safeHour} * * *`;

  dailyReportCronTask = cron.schedule(
    cronPattern,
    executeDailyAttendanceReportJob,
    { timezone: "Asia/Kolkata" }
  );

  console.log(`[CRON] Scheduled Daily Attendance Report email cron at ${String(safeHour).padStart(2, "0")}:${String(safeMinute).padStart(2, "0")} IST (${cronPattern})`);
  */
};

// Initialize schedule on startup from database or default to 20:01
/*
(async () => {
  try {
    const config = await AttendanceConfig.findOne({ key: "DEFAULT_CONFIG" });
    const targetTime = config?.dailyReportTime || "20:01";
    const isEnabled = config?.isDailyReportEnabled !== false;
    rescheduleDailyAttendanceReportCron(targetTime, isEnabled);
  } catch (err) {
    console.warn("[CRON] Could not read AttendanceConfig at startup, defaulting to 20:01", err.message);
    rescheduleDailyAttendanceReportCron("20:01", true);
  }
})();
*/

// ✅ BACKUP CRON: Runs every day at 1:00 AM IST (fail-safe)
cron.schedule("0 1 * * *", async () => {
  try {
    const offCheck = await isNonWorkingDay();
    if (offCheck.isOff) return;
    console.log("[CRON] Retry auto-checkout started");
    const count = await autoCheckoutUnclosedAttendances();
    console.log(`[CRON] Retry done for ${count} records`);
  } catch (err) {
    console.error("[CRON] Retry failed", err);
  }
}, {
  timezone: "Asia/Kolkata",
});

module.exports = {
  rescheduleDailyAttendanceReportCron,
};