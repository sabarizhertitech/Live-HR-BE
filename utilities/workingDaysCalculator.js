const mongoose = require("mongoose");
const Task = require("../Models/task.model");
const DailyWorkUpdate = require("../Models/Dailyworkupdate");

/**
 * Converts a Date to YYYY-MM-DD local calendar date string
 */
function getLocalDateString(d) {
  if (!d) return "";
  const dateObj = new Date(d);
  if (isNaN(dateObj.getTime())) return "";
  const year = dateObj.getFullYear();
  const month = String(dateObj.getMonth() + 1).padStart(2, "0");
  const day = String(dateObj.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Adds N calendar days to a YYYY-MM-DD date string
 */
function addDays(dateStr, numDays) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dateObj = new Date(y, m - 1, d);
  dateObj.setDate(dateObj.getDate() + numDays);
  return getLocalDateString(dateObj);
}

/**
 * Checks if a YYYY-MM-DD date string is a weekly off:
 * - Sundays
 * - 2nd and 4th Saturdays
 */
function isWeeklyOff(dateStr) {
  if (!dateStr) return false;
  const [y, m, d] = dateStr.split("-").map(Number);
  const dateObj = new Date(y, m - 1, d);
  const day = dateObj.getDay(); // 0 = Sunday, 6 = Saturday
  if (day === 0) return true;
  if (day === 6) {
    const saturdayRank = Math.ceil(d / 7);
    if (saturdayRank === 2 || saturdayRank === 4) return true;
  }
  return false;
}

/**
 * Standardizes status strings into: "pending", "inprocess", "hold", "completed"
 */
function normalizeStatus(raw) {
  const s = String(raw || "").toLowerCase().replace(/[-_\s]/g, "");
  if (s === "inprogress" || s === "inprocess") return "inprocess";
  if (s === "completed" || s === "complete") return "completed";
  if (s === "onhold" || s === "hold") return "hold";
  if (s === "pending" || s === "assigned" || s === "allocated") return "pending";
  return s || "pending";
}

/**
 * Calculates working days for a single phase using the addition method:
 * - Pending: 0
 * - In Process: 1 per calendar day
 * - On Hold: 0
 * - Completed: 1 on the completion date
 * - Untouched days: If last recorded status is In Process, count each subsequent day as 1 until status changes or phase is completed.
 * - Completed phases: Stop counting after the completion date.
 * - Carries forward previous accumulated total (Pending/On Hold do not reset it).
 *
 * @param {Object} phase - Phase object from Task.phases
 * @param {Array} updatesForPhase - Array of DailyWorkUpdate records linked to this phase
 * @param {Date} asOfDate - Evaluation date (defaults to now)
 * @returns {Number} - Total working days
 */
function calculatePhaseWorkingDays(phase, updatesForPhase = [], asOfDate = new Date()) {
  const phaseStatus = normalizeStatus(phase?.phaseStatus);
  const todayStr = getLocalDateString(asOfDate);

  // Filter updates that have a valid date
  const validUpdates = (updatesForPhase || []).filter(u => u && (u.updateDate || u.createdAt));

  // Fallback: If no Daily Work Updates exist for this phase yet
  if (validUpdates.length === 0) {
    if (phaseStatus === "completed") {
      return 1;
    }
    if (phaseStatus === "pending" || phaseStatus === "hold") {
      return 0;
    }
    if (phaseStatus === "inprocess") {
      const startDateStr = getLocalDateString(phase?.updateDate || asOfDate);
      if (!startDateStr || startDateStr > todayStr) return 1;
      let count = 0;
      let cur = startDateStr;
      while (cur <= todayStr) {
        if (!isWeeklyOff(cur)) {
          count++;
        }
        cur = addDays(cur, 1);
      }
      return Math.max(1, count);
    }
    return 0;
  }

  // Sort updates chronologically (oldest to newest)
  const sortedUpdates = [...validUpdates].sort((a, b) => {
    const timeA = new Date(a.updateDate || a.createdAt).getTime();
    const timeB = new Date(b.updateDate || b.createdAt).getTime();
    if (timeA !== timeB) return timeA - timeB;
    return String(a._id || "").localeCompare(String(b._id || ""));
  });

  // Group by local calendar date (YYYY-MM-DD) -> determine status for each date
  const statusByDate = {};
  for (const u of sortedUpdates) {
    const dStr = getLocalDateString(u.updateDate || u.createdAt);
    if (!dStr) continue;
    const st = normalizeStatus(u.status || u.phaseStatus);
    statusByDate[dStr] = st;
  }

  const distinctDates = Object.keys(statusByDate).sort();
  if (distinctDates.length === 0) return 0;

  const minDate = distinctDates[0];

  // Determine completion date (if completed)
  let completionDate = null;
  for (const dStr of distinctDates) {
    if (statusByDate[dStr] === "completed") {
      completionDate = dStr;
      break;
    }
  }

  // If phaseStatus in Phase model is completed, but no update recorded "completed":
  if (!completionDate && phaseStatus === "completed") {
    const phaseUpdStr = getLocalDateString(phase?.updateDate);
    completionDate = phaseUpdStr && phaseUpdStr >= minDate ? phaseUpdStr : distinctDates[distinctDates.length - 1];
    statusByDate[completionDate] = "completed";
  }

  // Determine simulation end date
  let endDate = completionDate ? completionDate : todayStr;
  if (endDate < minDate) {
    endDate = minDate;
  }

  // Day-by-day accumulation
  let accumulatedWorkingDays = 0;
  let currentStatus = "pending";
  let cur = minDate;

  while (cur <= endDate) {
    if (statusByDate[cur]) {
      currentStatus = statusByDate[cur];
    }
    // On untouched days: currentStatus is carried forward from the previous day

    const weeklyOff = isWeeklyOff(cur);
    if (!weeklyOff) {
      if (currentStatus === "inprocess") {
        accumulatedWorkingDays += 1;
      } else if (currentStatus === "completed") {
        accumulatedWorkingDays += 1;
        // Stop counting after completion date
        break;
      }
      // Pending or On Hold: add 0 days
    }

    cur = addDays(cur, 1);
  }

  return accumulatedWorkingDays;
}

/**
 * Calculates working days for all phases of a task, saves workingDays to
 * each phase in the Task collection, and calculates overallTaskWorkingDays.
 *
 * @param {ObjectId|String|Object} taskIdOrTask - Task ID or Task document
 * @param {Date} asOfDate - Evaluation date
 * @returns {Object} - { task, overallWorkingDays }
 */
async function syncTaskWorkingDays(taskIdOrTask, asOfDate = new Date()) {
  try {
    let task = taskIdOrTask;
    if (!task || !task.phases || typeof task.save !== "function") {
      const idToFind = task?._id || taskIdOrTask;
      if (!idToFind || !mongoose.Types.ObjectId.isValid(idToFind.toString())) {
        return null;
      }
      task = await Task.findById(idToFind);
    }

    if (!task || !task.phases || !Array.isArray(task.phases) || task.phases.length === 0) {
      return { task, overallWorkingDays: 0 };
    }

    const phaseIds = task.phases.map(p => p._id).filter(Boolean);
    if (phaseIds.length === 0) {
      return { task, overallWorkingDays: 0 };
    }

    // 1. Fetch all updates matching these phaseIds
    const directUpdates = await DailyWorkUpdate.find({
      $or: [
        { phaseId: { $in: phaseIds } },
        { referenceId: { $in: phaseIds } }
      ]
    }).lean();

    // 2. Also check if any updates match category and project (directly added through Daily Work Update)
    const cat = task.category ? task.category.trim() : null;
    const proj = task.project ? task.project.trim() : null;
    let titleUpdates = [];
    if (cat && proj) {
      titleUpdates = await DailyWorkUpdate.find({
        category: { $regex: new RegExp(`^${cat}$`, "i") },
        project: { $regex: new RegExp(`^${proj}$`, "i") }
      }).lean();
    }

    // Also check if any shared referenceIds exist for these records
    const refIds = directUpdates
      .map(u => u.referenceId)
      .filter(ref => ref && mongoose.Types.ObjectId.isValid(ref.toString()));

    let extraUpdates = [];
    if (refIds.length > 0) {
      extraUpdates = await DailyWorkUpdate.find({
        referenceId: { $in: refIds }
      }).lean();
    }

    const map = new Map();
    directUpdates.forEach(u => map.set(u._id.toString(), u));
    extraUpdates.forEach(u => map.set(u._id.toString(), u));
    titleUpdates.forEach(u => map.set(u._id.toString(), u));
    const allUpdates = Array.from(map.values());

    // 3. Map updates to each phase and calculate
    let modified = false;

    task.phases.forEach(phase => {
      const pIdStr = phase._id ? phase._id.toString() : null;
      const pTitle = phase.phaseTitle ? phase.phaseTitle.trim().toLowerCase() : null;
      const updatesForThisPhase = allUpdates.filter(u => {
        const uPhaseIdStr = u.phaseId ? u.phaseId.toString() : null;
        const uRefIdStr = u.referenceId ? u.referenceId.toString() : null;
        const idMatch = pIdStr && (uPhaseIdStr === pIdStr || uRefIdStr === pIdStr);
        const titleMatch = pTitle && (
          (u.title && u.title.trim().toLowerCase() === pTitle) ||
          (u.phase && u.phase.trim().toLowerCase() === pTitle)
        );
        return idMatch || titleMatch;
      });

      const calculatedDays = calculatePhaseWorkingDays(phase, updatesForThisPhase, asOfDate);
      if (phase.workingDays !== calculatedDays) {
        phase.workingDays = calculatedDays;
        modified = true;
      }
    });

    const overallWorkingDays = calculateOverallTaskWorkingDays(task, asOfDate);

    if (modified) {
      await Task.collection.updateOne(
        { _id: task._id },
        { $set: { phases: task.phases } }
      );
    }

    return { task, overallWorkingDays };
  } catch (err) {
    console.error("syncTaskWorkingDays ERROR:", err);
    return null;
  }
}

/**
 * Calculates overall task working days based on the task's date range (startDate & endDate).
 * - Counts both the start date and end date (inclusive).
 * - If the task starts and completes on the same calendar day, overall days = 1.
 * - If the task spans multiple calendar days, calculates the inclusive date difference.
 * - For an ongoing task without an endDate, uses current date as the end date.
 */
function calculateOverallTaskWorkingDays(task, asOfDate = new Date()) {
  if (!task) return 0;
  if (Array.isArray(task.phases) && task.phases.length > 0) {
    const sum = task.phases.reduce((acc, p) => acc + (Number(p.workingDays) || 0), 0);
    if (sum > 0) return sum;
  }

  const startRaw = task.startDate || task.createdDate || task.createdAt;
  if (!startRaw) {
    return 1;
  }
  const startDate = new Date(startRaw);
  if (isNaN(startDate.getTime())) return 1;

  const isCompleted = (task.status || "").toLowerCase() === "completed";
  const endRaw = isCompleted
    ? (task.endDate || task.dueDate || startRaw)
    : (task.endDate || asOfDate);

  const endDate = new Date(endRaw);
  if (isNaN(endDate.getTime())) return 1;

  const startStr = getLocalDateString(startDate);
  const endStr = getLocalDateString(endDate);

  if (!startStr || !endStr || startStr > endStr) return 1;

  let cur = startStr;
  let count = 0;
  while (cur <= endStr) {
    if (!isWeeklyOff(cur)) {
      count++;
    }
    cur = addDays(cur, 1);
  }
  return Math.max(1, count);
}

/**
 * Syncs working days for all existing tasks in the database
 */
async function syncAllTasksWorkingDays(asOfDate = new Date()) {
  try {
    const tasks = await Task.find({ "phases.0": { $exists: true } });
    let totalUpdated = 0;
    for (const task of tasks) {
      const res = await syncTaskWorkingDays(task, asOfDate);
      if (res) totalUpdated++;
    }
    return totalUpdated;
  } catch (err) {
    console.error("syncAllTasksWorkingDays ERROR:", err);
    return 0;
  }
}

module.exports = {
  getLocalDateString,
  addDays,
  isWeeklyOff,
  normalizeStatus,
  calculatePhaseWorkingDays,
  calculateOverallTaskWorkingDays,
  syncTaskWorkingDays,
  syncAllTasksWorkingDays
};
