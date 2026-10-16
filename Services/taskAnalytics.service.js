/**
 * Task Analytics Service
 * Core business calculations for Employee Performance and Admin Team Analytics.
 * Evaluates performance strictly from employee-level memberStatuses in multi-member tasks.
 */

const mongoose = require("mongoose");
const Task = require("../Models/task.model");
const User = require("../Models/Employee");
const DailyWorkUpdate = require("../Models/Dailyworkupdate");
const getCachedSignedUrl = require("../utilities/s3CachedUrl");
const {
  TASK_STATUS,
  DEADLINE_RESULT,
  normalizeTaskStatus,
  calculateDuration,
  formatDuration,
  calculateVariance,
  getDeadlineResult,
  calculatePercentage,
  calculatePerformanceScore,
  calculateConsistencyScore,
  getRankingEligibility,
} = require("../utils/taskAnalytics.utils");
const {
  fetchCompanyHolidaysSet,
  fetchEmployeeApprovedLeavesSet,
  fetchTeamApprovedLeavesMap,
  calculateEligibleWorkingDays,
  calculateDeadlineScore,
} = require("../utilities/taskDeadlineCalculator");

/**
 * Safely extracts a clean ObjectId hex string from an ID or populated document.
 */
function extractIdString(val) {
  if (!val) return "";
  if (typeof val === "string") return val.trim();
  if (typeof val === "object") {
    if (val._id) return String(val._id).trim();
    if (typeof val.toString === "function") {
      const s = val.toString();
      if (s !== "[object Object]") return s.trim();
    }
  }
  return String(val).trim();
}

/**
 * Determines whether a task was worked on by the given employee.
 * A task belongs to an employee's analytics if:
 * 1. The employee is in assignedMembers
 * 2. Or the employee is in memberStatuses
 * 3. Or it is a self-created task with NO other team members assigned.
 * Tasks assigned by an employee to other team members are strictly excluded from the assigner's analytics.
 */
function isWorkedOnByEmployee(task, targetEmployeeId) {
  if (!task || !targetEmployeeId) return false;
  const targetIdStr = extractIdString(targetEmployeeId);
  if (!targetIdStr) return false;

  // Check if target employee is in assignedMembers
  const assignedList = Array.isArray(task.assignedMembers) ? task.assignedMembers : [];
  const assignedIds = assignedList.map(extractIdString).filter(Boolean);
  if (assignedIds.includes(targetIdStr)) return true;

  // Check if target employee is in memberStatuses
  const memberStatusesList = Array.isArray(task.memberStatuses) ? task.memberStatuses : [];
  const memberStatusIds = memberStatusesList.map((ms) => extractIdString(ms?.employeeId)).filter(Boolean);
  if (memberStatusIds.includes(targetIdStr)) return true;

  // If the task has any other assigned members, it was assigned to others -> exclude for assigner
  const hasOtherAssignees = assignedIds.some((id) => id !== targetIdStr);
  const hasOtherMemberStatuses = memberStatusIds.some((id) => id !== targetIdStr);
  if (hasOtherAssignees || hasOtherMemberStatuses) {
    return false;
  }

  // Self-created task with no other members assigned
  const creatorId = extractIdString(task.createdBy);
  return creatorId === targetIdStr;
}

/**
 * Format relative activity timestamps (e.g. "Today at 10:15 AM", "Yesterday at 4:30 PM", "Sep 18 at 2:00 PM")
 */
function formatActivityTime(dateInput) {
  if (!dateInput) return "Recently";
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return "Recently";

  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  const timeString = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });

  if (isToday) return `Today at ${timeString}`;
  if (isYesterday) return `Yesterday at ${timeString}`;
  const dateString = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${dateString} at ${timeString}`;
}

/**
 * Helper to build date range query for Task based on createdDate (with fallback to createdAt)
 */
function buildDateQuery(period, customStart, customEnd) {
  if (!period || period === "all") return null;

  const now = new Date();
  let start = null;
  let end = null;

  if (period === "today") {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  } else if (period === "yesterday") {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59, 999);
  } else if (period === "this_week" || period === "7days") {
    start = new Date(now.getTime() - 7 * 86400000);
    end = now;
  } else if (period === "this_month" || period === "30days") {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = now;
  } else if (period === "last_month" || period === "last_1_month") {
    const prevMonth = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
    const prevYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    start = new Date(prevYear, prevMonth, 1);
    end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
  } else if (period === "this_year") {
    start = new Date(now.getFullYear(), 0, 1);
    end = now;
  } else if (period === "custom" && customStart) {
    start = new Date(customStart);
    end = customEnd ? new Date(customEnd) : now;
  }

  if (!start) return null;

  const dateFilter = { $gte: start };
  if (end) dateFilter.$lte = end;

  return dateFilter;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. Calculate Employee Task Metrics
 * Extracts employee-specific status, dates, durations and deadline results
 * from memberStatuses for that employee (with clean fallback for single-assignee).
 * ─────────────────────────────────────────────────────────────────────────────
 */
function calculateEmployeeTaskMetrics(task, employeeId, now = new Date(), holidaysSet = new Set(), employeeLeavesSet = new Set()) {
  const empIdStr = String(employeeId);
  const memberStatuses = Array.isArray(task.memberStatuses) ? task.memberStatuses : [];

  // Match employee in memberStatuses
  const memberStatus = memberStatuses.find(
    (m) => String(m.employeeId?._id || m.employeeId) === empIdStr
  );

  let rawStatus = "";
  let assignedStatus = "";
  let rejectionReason = "";
  let startDate = null;
  let endDate = null;
  let startDateSource = "TASK_CREATED_DATE_FALLBACK";

  if (memberStatus) {
    rawStatus = memberStatus.status || "";
    assignedStatus = memberStatus.assignedStatus || "";
    rejectionReason = memberStatus.rejectionReason || "";
    startDate = memberStatus.startDate ? new Date(memberStatus.startDate) : null;
    endDate = memberStatus.endDate ? new Date(memberStatus.endDate) : null;

    if (memberStatus.startDate) {
      startDateSource = "MEMBER_START_DATE";
    } else if (task.startDate) {
      startDate = new Date(task.startDate);
      startDateSource = "TASK_START_DATE";
    } else if (task.createdDate) {
      startDate = new Date(task.createdDate);
      startDateSource = "TASK_CREATED_DATE_FALLBACK";
    } else if (task.createdAt) {
      startDate = new Date(task.createdAt);
      startDateSource = "TASK_CREATED_DATE_FALLBACK";
    }
  } else {
    // Single-member or legacy fallback
    rawStatus = task.status || "";
    assignedStatus = task.assignedStatus || "";
    rejectionReason = task.rejectionReason || "";
    if (task.startDate) {
      startDate = new Date(task.startDate);
      startDateSource = "TASK_START_DATE";
    } else if (task.createdDate) {
      startDate = new Date(task.createdDate);
      startDateSource = "TASK_CREATED_DATE_FALLBACK";
    } else if (task.createdAt) {
      startDate = new Date(task.createdAt);
      startDateSource = "TASK_CREATED_DATE_FALLBACK";
    }
    if (task.endDate) {
      endDate = new Date(task.endDate);
    }
  }

  // Determine Rejection
  const normRaw = normalizeTaskStatus(rawStatus);
  const normAssigned = normalizeTaskStatus(assignedStatus);
  const hasRejection =
    normRaw === TASK_STATUS.REJECTED ||
    normAssigned === TASK_STATUS.REJECTED ||
    Boolean(rejectionReason && String(rejectionReason).trim());

  let status = normRaw;
  if (hasRejection) {
    status = TASK_STATUS.REJECTED;
  }

  const isCompleted = status === TASK_STATUS.COMPLETED;
  const isRejected = status === TASK_STATUS.REJECTED;
  const isInProgress = status === TASK_STATUS.IN_PROGRESS;
  const isOnHold = status === TASK_STATUS.ON_HOLD;
  const isPending = status === TASK_STATUS.PENDING;

  // Due Date
  const dueDate = task.dueDate ? new Date(task.dueDate) : null;
  const hasValidDue = dueDate && !isNaN(dueDate.getTime());

  // If completed but endDate is missing, check task.endDate or fallback to task.updatedAt/createdDate
  if (isCompleted && (!endDate || isNaN(endDate.getTime()))) {
    if (task.endDate) {
      endDate = new Date(task.endDate);
    } else if (task.updatedAt) {
      endDate = new Date(task.updatedAt);
    } else if (task.createdDate) {
      endDate = new Date(task.createdDate);
    }
  }

  // Validate timing availability
  const hasValidStart = startDate && !isNaN(startDate.getTime());
  const hasValidEnd = endDate && !isNaN(endDate.getTime());

  let timingDataAvailable = true;
  let timingReason = null;

  if (!hasValidStart) {
    timingDataAvailable = false;
    timingReason = "START_DATE_MISSING";
  } else if (!hasValidDue) {
    timingDataAvailable = false;
    timingReason = "DUE_DATE_MISSING";
  }

  // Duration calculations
  const effectiveEnd = isCompleted ? (hasValidEnd ? endDate : now) : now;
  let actualDuration = isRejected ? calculateDuration(0, 0) : (hasValidStart ? calculateDuration(startDate, effectiveEnd) : null);
  if (isCompleted && actualDuration && actualDuration.totalMs === 0) {
    actualDuration = calculateDuration(0, 86400000); // 1 Day (1d 0h)
  }
  const plannedDuration = hasValidStart && hasValidDue ? calculateDuration(startDate, dueDate) : null;

  // Deadline variance and outcome
  const variance = isCompleted && hasValidEnd && hasValidDue
    ? calculateVariance(endDate, dueDate)
    : null;

  const result = getDeadlineResult(status, endDate, dueDate, now);

  const onTime = result === DEADLINE_RESULT.ON_TIME || result === DEADLINE_RESULT.AHEAD;
  const ahead = result === DEADLINE_RESULT.AHEAD;
  const late = result === DEADLINE_RESULT.LATE;
  const overdue = result === DEADLINE_RESULT.OVERDUE;

  // Employee-specific Phase analysis
  const phases = Array.isArray(task.phases) ? task.phases : [];
  const assignedMembers = Array.isArray(task.assignedMembers) ? task.assignedMembers : [];
  const isSingleAssignee = assignedMembers.length <= 1;

  const employeePhases = phases.filter((p) => {
    if (p.employeeId) {
      return String(p.employeeId?._id || p.employeeId) === empIdStr;
    }
    // If phase has no specific employeeId, count it only if employee is single assignee
    return isSingleAssignee;
  });

  const totalPhases = employeePhases.length;
  const completedPhases = employeePhases.filter(
    (p) => String(p.phaseStatus || "").toLowerCase() === "completed"
  ).length;
  const pendingPhases = totalPhases - completedPhases;
  const phaseCompletionRate = calculatePercentage(completedPhases, totalPhases);

  // Eligible working days & Deadline Score (skipping Sundays, 2nd & 4th Saturdays, company holidays, approved leaves)
  const { eligibleDays: eligibleWorkingDays, excludedDays: excludedNonWorkingDays } =
    hasValidStart && hasValidDue
      ? calculateEligibleWorkingDays(startDate, dueDate, holidaysSet, employeeLeavesSet)
      : { eligibleDays: null, excludedDays: 0 };

  const deadlineScoreDetails = hasValidDue
    ? calculateDeadlineScore(dueDate, endDate, status, holidaysSet, employeeLeavesSet, now)
    : { eligibleDaysLate: 0, deadlineScore: 100, isAhead: false, isOnTime: true, isLate: false, isOverdue: false, excludedLateDays: 0 };

  return {
    taskId: task._id,
    employeeId: empIdStr,
    taskTitle: task.taskTitle,
    taskDetails: task.taskDetails,
    project: task.project || "General",
    category: task.category || "General",
    priority: task.priority || "Mid",

    status,
    rawStatus,
    assignedStatus,
    rejectionReason,

    startDate: hasValidStart ? startDate.toISOString() : null,
    dueDate: hasValidDue ? dueDate.toISOString() : null,
    endDate: hasValidEnd ? endDate.toISOString() : null,
    startDateSource,

    timingDataAvailable,
    timingReason,

    plannedDuration,
    actualDuration,
    variance,

    result,

    completed: isCompleted,
    rejected: isRejected,
    inProgress: isInProgress,
    onHold: isOnHold,
    pending: isPending,

    onTime,
    ahead,
    late,
    overdue,

    eligibleWorkingDays,
    excludedNonWorkingDays,
    eligibleDaysLate: deadlineScoreDetails.eligibleDaysLate,
    deadlineScore: deadlineScoreDetails.deadlineScore,

    phases: {
      total: totalPhases,
      completed: completedPhases,
      pending: pendingPhases,
      completionRate: phaseCompletionRate,
    },

    createdDate: task.createdDate || task.createdAt,
  };
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 2. Get Employee Performance Summary & Details
 * ─────────────────────────────────────────────────────────────────────────────
 */
async function getEmployeePerformance(employeeId, filters = {}) {
  if (!employeeId || !mongoose.Types.ObjectId.isValid(employeeId)) {
    throw new Error("Invalid or missing employee ID");
  }

  const empObjId = new mongoose.Types.ObjectId(employeeId);

  // 1. Fetch Employee Profile
  const emp = await User.findById(empObjId)
    .select("_id name employeeName firstName lastName designation role department empId email profileImage avatar photo employmentStatus status")
    .lean();

  if (!emp) {
    throw new Error("Employee not found");
  }

  const empName = emp.name || emp.employeeName || `${emp.firstName || ""} ${emp.lastName || ""}`.trim() || emp.email || "Employee";
  const empRole = emp.designation || emp.role || "Team Member";
  const empDept = emp.department || "General";
  const empCode = emp.empId || `EMP-${String(emp._id).slice(-4).toUpperCase()}`;
  const empEmail = emp.email || "";

  let avatarUrl = "/avatar.png";
  const rawAvatar = emp.profileImage || emp.avatar || emp.photo || "";
  if (rawAvatar && rawAvatar !== "avatar.png") {
    try {
      avatarUrl = (await getCachedSignedUrl(rawAvatar)) || rawAvatar;
    } catch (_) {
      avatarUrl = rawAvatar;
    }
  }

  const isActive =
    emp.employmentStatus !== "relieved" &&
    emp.employmentStatus !== "relived" &&
    emp.status !== "relieved" &&
    emp.status !== "relived";

  // 2. Build Query for Employee Tasks (strictly tasks worked on by this employee)
  const query = {
    $or: [
      { assignedMembers: empObjId },
      { "memberStatuses.employeeId": empObjId },
      {
        $and: [
          { createdBy: empObjId },
          {
            $or: [
              { assignedMembers: { $exists: false } },
              { assignedMembers: { $size: 0 } },
              { assignedMembers: empObjId },
            ],
          },
        ],
      },
    ],
  };

  // Date filter
  const dateFilter = buildDateQuery(filters.period, filters.startDate, filters.endDate);
  if (dateFilter) {
    query.createdDate = dateFilter;
  }

  // Project, Category, Priority filters
  if (filters.project && filters.project !== "all") {
    query.project = { $regex: new RegExp(`^${filters.project.trim()}$`, "i") };
  }
  if (filters.category && filters.category !== "all") {
    query.category = { $regex: new RegExp(`^${filters.category.trim()}$`, "i") };
  }
  if (filters.priority && filters.priority !== "all") {
    query.priority = filters.priority.trim();
  }

  // 3. Fetch Tasks
  let rawTasks = await Task.find(query)
    .populate("assignedMembers", "_id name employeeName firstName lastName role department profileImage avatar photo empId")
    .populate("createdBy", "_id name employeeName firstName lastName")
    .sort({ createdDate: -1, createdAt: -1 })
    .lean();

  // Strict check: Only include tasks worked on by this employee
  rawTasks = rawTasks.filter((task) => isWorkedOnByEmployee(task, empObjId));

  // Self-created task fallback: if assignedMembers is missing or empty, assign to createdBy
  rawTasks.forEach((task) => {
    if (!task.assignedMembers || task.assignedMembers.length === 0) {
      if (task.createdBy) {
        task.assignedMembers = [task.createdBy];
      }
    }
  });

  const now = new Date();

  // Fetch company holidays and employee's approved leaves
  const [holidaysSet, employeeLeavesSet] = await Promise.all([
    fetchCompanyHolidaysSet(),
    fetchEmployeeApprovedLeavesSet(empObjId),
  ]);

  // 4. Calculate Individual Task Metrics
  const mappedTasks = rawTasks.map((task) => {
    return calculateEmployeeTaskMetrics(task, empObjId, now, holidaysSet, employeeLeavesSet);
  });

  // Filter by task status if requested
  let filteredTasks = mappedTasks;
  if (filters.status && filters.status !== "all") {
    const sLower = filters.status.toLowerCase();
    if (sLower === "completed") {
      filteredTasks = mappedTasks.filter((t) => t.completed);
    } else if (sLower === "in progress" || sLower === "inprogress") {
      filteredTasks = mappedTasks.filter((t) => t.inProgress);
    } else if (sLower === "on hold" || sLower === "onhold") {
      filteredTasks = mappedTasks.filter((t) => t.onHold);
    } else if (sLower === "rejected") {
      filteredTasks = mappedTasks.filter((t) => t.rejected);
    } else if (sLower === "overdue") {
      filteredTasks = mappedTasks.filter((t) => t.overdue);
    } else if (sLower === "on time" || sLower === "ontime") {
      filteredTasks = mappedTasks.filter((t) => t.onTime);
    }
  }

  // 5. Aggregate Employee Metrics
  const totalTasks = mappedTasks.length;
  let completed = 0;
  let pending = 0;
  let inProgress = 0;
  let onHold = 0;
  let rejected = 0;
  let overdue = 0;
  let ahead = 0;
  let exactlyOnTime = 0;
  let late = 0;

  let totalCompletedDurationMs = 0;
  let totalDurationsCount = 0;
  let fastestDurationMs = null;
  let slowestDurationMs = null;
  let totalVarianceMs = 0;
  let varianceCount = 0;

  let totalPhasesSum = 0;
  let completedPhasesSum = 0;

  for (const t of mappedTasks) {
    if (t.completed) completed++;
    else if (t.inProgress) inProgress++;
    else if (t.onHold) onHold++;
    else if (t.rejected) rejected++;
    else pending++;

    if (t.overdue) overdue++;
    if (t.ahead) ahead++;
    if (t.result === DEADLINE_RESULT.ON_TIME) exactlyOnTime++;
    if (t.late) late++;

    // Durations for completed tasks
    if (t.completed && t.actualDuration) {
      const durMs = t.actualDuration.totalMs;
      totalCompletedDurationMs += durMs;
      totalDurationsCount++;

      if (fastestDurationMs === null || durMs < fastestDurationMs) {
        fastestDurationMs = durMs;
      }
      if (slowestDurationMs === null || durMs > slowestDurationMs) {
        slowestDurationMs = durMs;
      }
    }

    // Variance for completed tasks
    if (t.completed && t.variance) {
      totalVarianceMs += t.variance.varianceMs;
      varianceCount++;
    }

    // Phases
    totalPhasesSum += t.phases.total;
    completedPhasesSum += t.phases.completed;
  }

  // Valid Performance Tasks: Assigned - Rejected/Cancelled
  const validPerformanceTasks = Math.max(0, totalTasks - rejected);

  // Performance Rates
  const completionRate = calculatePercentage(completed, validPerformanceTasks);
  const onTimeRate = calculatePercentage(ahead + exactlyOnTime, completed);
  const lateRate = calculatePercentage(late, completed);
  const overdueRate = calculatePercentage(overdue, validPerformanceTasks);
  const deadlineReliability = onTimeRate; // Ahead + OnTime / Completed

  const phaseCompletionRate = calculatePercentage(completedPhasesSum, totalPhasesSum);

  // Separate Deadline Score: average across valid performance tasks
  const validDeadlineTasks = filteredTasks.filter((t) => !t.rejected);
  const deadlineScore = validDeadlineTasks.length > 0
    ? Number(
        (
          validDeadlineTasks.reduce((sum, t) => sum + (t.deadlineScore !== undefined ? t.deadlineScore : 100), 0) /
          validDeadlineTasks.length
        ).toFixed(1)
      )
    : 100;

  // Time Analysis
  const avgCompletionMs = totalDurationsCount > 0 ? Math.round(totalCompletedDurationMs / totalDurationsCount) : 0;
  const avgVarianceMs = varianceCount > 0 ? Math.round(totalVarianceMs / varianceCount) : 0;

  const timeAnalysis = {
    averageCompletionMs: avgCompletionMs,
    averageCompletionFormatted: formatDuration(avgCompletionMs),
    averageCompletionHours: Number((avgCompletionMs / 3600000).toFixed(1)),
    fastestCompletionMs: fastestDurationMs || 0,
    fastestCompletionFormatted: fastestDurationMs !== null ? formatDuration(fastestDurationMs) : "N/A",
    slowestCompletionMs: slowestDurationMs || 0,
    slowestCompletionFormatted: slowestDurationMs !== null ? formatDuration(slowestDurationMs) : "N/A",
    averageVarianceMs: avgVarianceMs,
    averageVarianceHours: Number((avgVarianceMs / 3600000).toFixed(1)),
    averageVarianceFormatted: avgVarianceMs < 0
      ? `${formatDuration(Math.abs(avgVarianceMs))} ahead`
      : (avgVarianceMs > 0 ? `${formatDuration(avgVarianceMs)} late` : "On Time"),
  };

  // 6. Daily Work Updates Supporting Metrics
  const workUpdates = await DailyWorkUpdate.find({ userId: empObjId })
    .sort({ updateDate: -1, createdAt: -1 })
    .lean();

  const totalUpdates = workUpdates.length;
  const uniqueWorkDates = new Set(
    workUpdates.map((u) => new Date(u.updateDate || u.createdAt).toDateString())
  );
  const activeWorkDays = uniqueWorkDates.size;
  const averageUpdatesPerActiveDay = activeWorkDays > 0
    ? Number((totalUpdates / activeWorkDays).toFixed(2))
    : 0;

  let lastUpdateDate = null;
  let daysSinceLastUpdate = null;
  if (workUpdates.length > 0) {
    const lastDate = new Date(workUpdates[0].updateDate || workUpdates[0].createdAt);
    lastUpdateDate = lastDate.toISOString();
    daysSinceLastUpdate = Math.floor((now.getTime() - lastDate.getTime()) / 86400000);
  }

  const dailyWorkUpdatesStats = {
    totalUpdates,
    activeWorkDays,
    averageUpdatesPerActiveDay,
    lastUpdateDate,
    daysSinceLastUpdate,
  };

  // 7. Consistency Score & Performance Score
  const consistencyScore = calculateConsistencyScore({
    onTimeRate,
    overdueCount: overdue,
    totalTasks: validPerformanceTasks,
    completedTasks: completed,
  });

  const performanceScore = calculatePerformanceScore({
    completionRate,
    onTimeRate,
    deadlineReliability,
    phaseCompletionRate,
    consistencyScore,
  });

  // 8. Ranking Eligibility (Sample Size Protection)
  const minTasks = Number(filters.minTasks) || 5;
  const rankingEligibility = getRankingEligibility(validPerformanceTasks, minTasks);

  return {
    employee: {
      _id: emp._id,
      name: empName,
      role: empRole,
      department: empDept,
      empId: empCode,
      email: empEmail,
      avatarUrl,
      isActive,
    },
    summary: {
      totalTasks,
      validPerformanceTasks,
      completed,
      pending,
      inProgress,
      onHold,
      rejected,
      overdue,
      ahead,
      onTime: exactlyOnTime,
      late,
      deadlineScore,
    },
    performance: {
      score: performanceScore,
      deadlineScore, // Separated deadline performance score (0 - 100)
      completionRate,
      onTimeRate,
      lateRate,
      overdueRate,
      deadlineReliability,
      consistencyScore,
    },
    timeAnalysis,
    phaseAnalysis: {
      total: totalPhasesSum,
      completed: completedPhasesSum,
      pending: totalPhasesSum - completedPhasesSum,
      completionRate: phaseCompletionRate,
    },
    dailyWorkUpdates: dailyWorkUpdatesStats,
    ranking: {
      eligible: rankingEligibility.rankingEligible,
      confidence: rankingEligibility.confidence,
      label: rankingEligibility.label,
      tasksEvaluated: validPerformanceTasks,
    },
    tasks: filteredTasks,
  };
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 3. Get Admin Team Performance Analytics
 * Overview of all employees, project statistics, category & SLA metrics.
 * ─────────────────────────────────────────────────────────────────────────────
 */
async function getTeamPerformance(filters = {}, userRole = "admin", currentUserId = null) {
  // 1. Fetch Active Employees
  const empQuery = {
    employmentStatus: { $nin: ["relieved", "relived"] },
    status: { $nin: ["relieved", "relived"] },
  };

  if (filters.department && filters.department !== "all") {
    empQuery.department = { $regex: new RegExp(`^${filters.department.trim()}$`, "i") };
  }
  if (filters.designation && filters.designation !== "all") {
    empQuery.$or = [
      { designation: { $regex: new RegExp(`^${filters.designation.trim()}$`, "i") } },
      { role: { $regex: new RegExp(`^${filters.designation.trim()}$`, "i") } },
    ];
  }

  const allEmployees = await User.find(
    empQuery,
    "_id name employeeName firstName lastName department designation role email profileImage avatar photo empId"
  ).lean();

  const employeeMap = new Map();
  allEmployees.forEach((emp) => {
    employeeMap.set(String(emp._id), emp);
  });

  // 2. Fetch Tasks with Filters
  const taskQuery = {};
  const dateFilter = buildDateQuery(filters.period, filters.startDate, filters.endDate);
  if (dateFilter) {
    taskQuery.createdDate = dateFilter;
  }
  if (filters.project && filters.project !== "all") {
    taskQuery.project = { $regex: new RegExp(`^${filters.project.trim()}$`, "i") };
  }
  if (filters.category && filters.category !== "all") {
    taskQuery.category = { $regex: new RegExp(`^${filters.category.trim()}$`, "i") };
  }
  if (filters.priority && filters.priority !== "all") {
    taskQuery.priority = filters.priority.trim();
  }
  if (filters.employeeId && filters.employeeId !== "all") {
    const empIdObj = new mongoose.Types.ObjectId(filters.employeeId.trim());
    taskQuery.$or = [
      { assignedMembers: empIdObj },
      { "memberStatuses.employeeId": empIdObj },
    ];
  }

  const tasks = await Task.find(taskQuery)
    .populate("assignedMembers", "_id name employeeName firstName lastName role department profileImage avatar photo empId")
    .sort({ createdDate: -1, createdAt: -1 })
    .lean();

  const now = new Date();

  // Fetch company holidays and team members' approved leaves
  const [holidaysSet, teamLeavesMap] = await Promise.all([
    fetchCompanyHolidaysSet(),
    fetchTeamApprovedLeavesMap(allEmployees.map((e) => e._id)),
  ]);

  // 3. Aggregate Team Totals
  let teamTotalTasks = tasks.length;
  let teamCompleted = 0;
  let teamPending = 0;
  let teamInProgress = 0;
  let teamOnHold = 0;
  let teamRejected = 0;
  let teamOverdue = 0;
  let teamOnTime = 0;

  // Project & Category aggregators
  const projectStats = {};
  const categoryStats = {};
  const priorityStats = { Low: 0, Mid: 0, High: 0 };
  const highRiskTasks = [];

  // Employee-specific aggregation maps
  const employeeTaskMetrics = new Map();
  allEmployees.forEach((emp) => {
    employeeTaskMetrics.set(String(emp._id), {
      employee: emp,
      tasks: [],
    });
  });

  for (const task of tasks) {
    const rootStatus = normalizeTaskStatus(task.status);
    const proj = task.project || "General";
    const cat = task.category || "General";
    const prio = task.priority || "Mid";

    // Priority count
    if (priorityStats[prio] !== undefined) priorityStats[prio]++;

    // Project breakdown init
    if (!projectStats[proj]) {
      projectStats[proj] = { project: proj, total: 0, completed: 0, inProgress: 0, overdue: 0, onHold: 0 };
    }
    projectStats[proj].total++;

    // Category breakdown init
    if (!categoryStats[cat]) {
      categoryStats[cat] = { category: cat, total: 0, completed: 0, inProgress: 0, overdue: 0 };
    }
    categoryStats[cat].total++;

    // Evaluate root for overall team high-level view
    const isOverdueRoot = rootStatus !== TASK_STATUS.COMPLETED && rootStatus !== TASK_STATUS.REJECTED && task.dueDate && now > new Date(task.dueDate);
    if (rootStatus === TASK_STATUS.COMPLETED) {
      teamCompleted++;
      projectStats[proj].completed++;
      categoryStats[cat].completed++;
      if (task.dueDate && task.endDate && new Date(task.endDate) <= new Date(task.dueDate)) {
        teamOnTime++;
      }
    } else if (rootStatus === TASK_STATUS.IN_PROGRESS) {
      teamInProgress++;
      projectStats[proj].inProgress++;
      categoryStats[cat].inProgress++;
    } else if (rootStatus === TASK_STATUS.ON_HOLD) {
      teamOnHold++;
      projectStats[proj].onHold++;
    } else if (rootStatus === TASK_STATUS.REJECTED) {
      teamRejected++;
    } else {
      teamPending++;
    }

    if (isOverdueRoot) {
      teamOverdue++;
      projectStats[proj].overdue++;
      categoryStats[cat].overdue++;

      highRiskTasks.push({
        taskId: task._id,
        taskTitle: task.taskTitle,
        project: proj,
        priority: prio,
        dueDate: task.dueDate,
        status: rootStatus,
        daysOverdue: Math.floor((now.getTime() - new Date(task.dueDate).getTime()) / 86400000),
        assignedMembers: (task.assignedMembers || []).map((m) => ({
          _id: m._id,
          name: m.name || m.employeeName || "Member",
        })),
      });
    }

    // Assign tasks to employees for ranking and employee table
    const assignedIds = (task.assignedMembers || []).map((m) => String(m._id || m));
    const memberStatusIds = (task.memberStatuses || []).map((m) => String(m.employeeId?._id || m.employeeId));
    const uniqueAssignees = Array.from(new Set([...assignedIds, ...memberStatusIds]));

    for (const empId of uniqueAssignees) {
      if (employeeTaskMetrics.has(empId)) {
        const empLeavesSet = teamLeavesMap.get(empId) || new Set();
        const empMetrics = calculateEmployeeTaskMetrics(task, empId, now, holidaysSet, empLeavesSet);
        employeeTaskMetrics.get(empId).tasks.push(empMetrics);
      }
    }
  }

  // 4. Calculate Employee Summaries & Rankings
  const minTasks = Number(filters.minTasks) || 5;
  const employeeSummaries = [];

  for (const [empId, data] of employeeTaskMetrics.entries()) {
    const emp = data.employee;
    const empTasks = data.tasks;
    const total = empTasks.length;

    let comp = 0;
    let inProg = 0;
    let hold = 0;
    let rej = 0;
    let ovd = 0;
    let onTm = 0;
    let late = 0;
    let totalDurMs = 0;
    let durCount = 0;
    let phasesTot = 0;
    let phasesComp = 0;

    let deadlineScoresSum = 0;
    let deadlineTasksCount = 0;

    for (const t of empTasks) {
      if (t.completed) comp++;
      else if (t.inProgress) inProg++;
      else if (t.onHold) hold++;
      else if (t.rejected) rej++;

      if (t.overdue) ovd++;
      if (t.onTime) onTm++;
      if (t.late) late++;

      if (!t.rejected && t.deadlineScore !== undefined) {
        deadlineScoresSum += t.deadlineScore;
        deadlineTasksCount++;
      }

      if (t.completed && t.actualDuration) {
        totalDurMs += t.actualDuration.totalMs;
        durCount++;
      }

      phasesTot += t.phases.total;
      phasesComp += t.phases.completed;
    }

    const empDeadlineScore = deadlineTasksCount > 0
      ? Number((deadlineScoresSum / deadlineTasksCount).toFixed(1))
      : 100;

    const validPerformanceTasks = Math.max(0, total - rej);
    const compRate = calculatePercentage(comp, validPerformanceTasks);
    const onTmRate = calculatePercentage(onTm, comp);
    const lateRate = calculatePercentage(late, comp);
    const phaseCompRate = calculatePercentage(phasesComp, phasesTot);

    const consistencyScore = calculateConsistencyScore({
      onTimeRate: onTmRate,
      overdueCount: ovd,
      totalTasks: validPerformanceTasks,
      completedTasks: comp,
    });

    const perfScore = calculatePerformanceScore({
      completionRate: compRate,
      onTimeRate: onTmRate,
      deadlineReliability: onTmRate,
      phaseCompletionRate: phaseCompRate,
      consistencyScore,
    });

    const avgMs = durCount > 0 ? Math.round(totalDurMs / durCount) : 0;
    const rankingEligibility = getRankingEligibility(validPerformanceTasks, minTasks);

    const empName = emp.name || emp.employeeName || `${emp.firstName || ""} ${emp.lastName || ""}`.trim() || emp.email || "Employee";

    employeeSummaries.push({
      employeeId: emp._id,
      name: empName,
      role: emp.designation || emp.role || "Team Member",
      department: emp.department || "General",
      empId: emp.empId || `EMP-${String(emp._id).slice(-4).toUpperCase()}`,
      avatar: emp.profileImage || emp.avatar || emp.photo || "/avatar.png",
      totalTasks: total,
      validPerformanceTasks,
      completed: comp,
      inProgress: inProg,
      onHold: hold,
      rejected: rej,
      overdue: ovd,
      onTime: onTm,
      late,
      completionRate: compRate,
      onTimeRate: onTmRate,
      lateRate,
      averageCompletionHours: Number((avgMs / 3600000).toFixed(1)),
      averageCompletionFormatted: formatDuration(avgMs),
      performanceScore: perfScore,
      deadlineScore: empDeadlineScore,
      rankingEligible: rankingEligibility.rankingEligible,
      confidence: rankingEligibility.confidence,
      confidenceLabel: rankingEligibility.label,
    });
  }

  // Sort employees: Eligible with highest performanceScore first
  const eligibleEmployees = employeeSummaries
    .filter((e) => e.rankingEligible)
    .sort((a, b) => b.performanceScore - a.performanceScore);

  eligibleEmployees.forEach((emp, index) => {
    emp.rank = index + 1;
  });

  const ineligibleEmployees = employeeSummaries
    .filter((e) => !e.rankingEligible)
    .sort((a, b) => b.totalTasks - a.totalTasks);

  ineligibleEmployees.forEach((emp) => {
    emp.rank = null;
  });

  const rankedEmployees = [...eligibleEmployees, ...ineligibleEmployees];

  // 5. Team Rates
  const teamValidTasks = Math.max(0, teamTotalTasks - teamRejected);
  const teamCompletionRate = calculatePercentage(teamCompleted, teamValidTasks);
  const teamOnTimeRate = calculatePercentage(teamOnTime, teamCompleted);
  const teamOverdueRate = calculatePercentage(teamOverdue, teamValidTasks);

  const avgEligibleScore = eligibleEmployees.length > 0
    ? Number((eligibleEmployees.reduce((sum, e) => sum + e.performanceScore, 0) / eligibleEmployees.length).toFixed(1))
    : 0;

  return {
    summary: {
      totalEmployees: allEmployees.length,
      totalTasks: teamTotalTasks,
      validPerformanceTasks: teamValidTasks,
      completed: teamCompleted,
      pending: teamPending,
      inProgress: teamInProgress,
      onHold: teamOnHold,
      rejected: teamRejected,
      overdue: teamOverdue,
      teamCompletionRate,
      teamOnTimeRate,
      teamOverdueRate,
      averageEligibleScore: avgEligibleScore,
      averageDeadlineScore: (() => {
        const totalDl = employeeSummaries.reduce((acc, e) => acc + (e.deadlineScore !== undefined ? e.deadlineScore : 100), 0);
        return employeeSummaries.length > 0 ? Number((totalDl / employeeSummaries.length).toFixed(1)) : 100;
      })(),
    },
    rankedEmployees,
    projects: Object.values(projectStats),
    categories: Object.values(categoryStats),
    priorityBreakdown: priorityStats,
    highRiskTasks: highRiskTasks.slice(0, 20),
  };
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 4. Get Performance Trends (Daily / Weekly / Monthly)
 * ─────────────────────────────────────────────────────────────────────────────
 */
async function getPerformanceTrends(filters = {}, granularity = "daily") {
  const now = new Date();
  let numDays = 14;

  if (filters.trendRange === "7days" || filters.range === "7days") numDays = 7;
  else if (filters.trendRange === "30days" || filters.range === "30days") numDays = 30;

  const query = {};
  if (filters.employeeId && filters.employeeId !== "all") {
    const empObjId = new mongoose.Types.ObjectId(filters.employeeId);
    query.$or = [
      { assignedMembers: empObjId },
      { "memberStatuses.employeeId": empObjId },
    ];
  }

  const tasks = await Task.find(query).lean();

  const labels = [];
  const assignedTrend = [];
  const completedTrend = [];
  const onTimeTrend = [];
  const completionRateTrend = [];
  const avgTimeTrend = [];

  for (let i = numDays - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const dStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
    const dEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

    const label = d.toLocaleDateString("en-US", { month: "short", day: "2-digit" });
    labels.push(label);

    const assignedOnDay = tasks.filter((t) => {
      const c = new Date(t.createdDate || t.createdAt);
      return c >= dStart && c <= dEnd;
    }).length;

    const completedTasksOnDay = tasks.filter((t) => {
      const isComp = normalizeTaskStatus(t.status) === TASK_STATUS.COMPLETED;
      if (!isComp || !t.endDate) return false;
      const end = new Date(t.endDate);
      return end >= dStart && end <= dEnd;
    });

    const completedOnDay = completedTasksOnDay.length;
    const onTimeOnDay = completedTasksOnDay.filter((t) => {
      if (!t.dueDate) return true;
      return new Date(t.endDate) <= new Date(t.dueDate);
    }).length;

    let avgHrsOnDay = 0;
    if (completedOnDay > 0) {
      const totalMs = completedTasksOnDay.reduce((acc, curr) => {
        const start = curr.startDate ? new Date(curr.startDate) : new Date(curr.createdDate || curr.createdAt);
        const end = new Date(curr.endDate);
        return acc + Math.max(0, end.getTime() - start.getTime());
      }, 0);
      avgHrsOnDay = Number((totalMs / (completedOnDay * 3600000)).toFixed(1));
    }

    assignedTrend.push(assignedOnDay);
    completedTrend.push(completedOnDay);
    onTimeTrend.push(onTimeOnDay);
    completionRateTrend.push(assignedOnDay > 0 ? Math.round((completedOnDay / assignedOnDay) * 100) : 0);
    avgTimeTrend.push(avgHrsOnDay);
  }

  return {
    labels,
    tasksAssigned: assignedTrend,
    tasksCompleted: completedTrend,
    tasksOnTime: onTimeTrend,
    completionRates: completionRateTrend,
    avgCompletionHours: avgTimeTrend,
  };
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 5. Legacy Analytics Adapters
 * Provides 100% backward compatibility for existing frontend calls to:
 * - GET /creat/tasks/analytics
 * - GET /creat/tasks/analytics/employee/:employeeId
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * High-performance, backward-compatible service implementation for /creat/tasks/analytics.
 * Incorporates accurate employee-specific memberStatuses logic.
 */
async function getLegacyTaskAnalytics(filters = {}, userRole = "", isHr = false, currentUserId = null) {
  const isAdmin = userRole === "admin" || userRole === "superadmin" || isHr;
  const isEmployeeScope = !isAdmin || filters.scope === "employee" || filters.isEmployee === "true";

  const query = {};

  // 1. Role-Based Scoping & Employee / Department / Designation Filtering
  // Tasks assigned by an employee to other team members are strictly excluded from assigner's analytics
  if (isEmployeeScope && currentUserId) {
    const curObjId = new mongoose.Types.ObjectId(currentUserId);
    query.$or = [
      { assignedMembers: curObjId },
      { "memberStatuses.employeeId": curObjId },
      {
        $and: [
          { createdBy: curObjId },
          {
            $or: [
              { assignedMembers: { $exists: false } },
              { assignedMembers: { $size: 0 } },
              { assignedMembers: curObjId },
            ],
          },
        ],
      },
    ];
  } else if (filters.employeeId && filters.employeeId.trim() && filters.employeeId !== "all") {
    const empIdTrim = filters.employeeId.trim();
    const empObjId = mongoose.Types.ObjectId.isValid(empIdTrim) ? new mongoose.Types.ObjectId(empIdTrim) : null;
    query.$or = [
      ...(empObjId ? [
        { assignedMembers: empObjId },
        { "memberStatuses.employeeId": empObjId },
        {
          $and: [
            { createdBy: empObjId },
            {
              $or: [
                { assignedMembers: { $exists: false } },
                { assignedMembers: { $size: 0 } },
                { assignedMembers: empObjId },
              ],
            },
          ],
        },
      ] : []),
      { assignedMembers: empIdTrim },
      { "memberStatuses.employeeId": empIdTrim },
      {
        $and: [
          { createdBy: empIdTrim },
          {
            $or: [
              { assignedMembers: { $exists: false } },
              { assignedMembers: { $size: 0 } },
              { assignedMembers: empIdTrim },
            ],
          },
        ],
      },
    ];
  } else if (
    (filters.department && filters.department.trim() && filters.department !== "all") ||
    (filters.designation && filters.designation.trim() && filters.designation !== "all")
  ) {
    const empFilter = {};
    if (filters.department && filters.department.trim() && filters.department !== "all") {
      empFilter.department = { $regex: new RegExp(`^${filters.department.trim()}$`, "i") };
    }
    if (filters.designation && filters.designation.trim() && filters.designation !== "all") {
      empFilter.$or = [
        { designation: { $regex: new RegExp(`^${filters.designation.trim()}$`, "i") } },
        { role: { $regex: new RegExp(`^${filters.designation.trim()}$`, "i") } },
      ];
    }
    const matchingEmployees = await User.find(empFilter, "_id").lean();
    const matchingIds = matchingEmployees.map((e) => e._id);
    query.$or = [
      { assignedMembers: { $in: matchingIds } },
      { "memberStatuses.employeeId": { $in: matchingIds } },
    ];
  }

  // 2. Project, Category & Priority
  const targetProject = (filters.project || filters.projectId || "").trim();
  if (targetProject && targetProject !== "all") {
    query.project = { $regex: new RegExp(`^${targetProject}$`, "i") };
  }
  if (filters.category && filters.category.trim() && filters.category !== "all") {
    query.category = { $regex: new RegExp(`^${filters.category.trim()}$`, "i") };
  }
  if (filters.priority && filters.priority.trim() && filters.priority !== "all") {
    query.priority = filters.priority.trim();
  }

  // 3. Status filter
  if (filters.status && filters.status.trim() && filters.status !== "all") {
    const s = filters.status.trim().toLowerCase();
    if (s === "completed") {
      query.status = { $regex: /^completed$/i };
    } else if (s === "in progress" || s === "inprocess") {
      query.status = { $regex: /^(in progress|in-progress|inprocess)$/i };
    } else if (s === "assigned" || s === "pending") {
      query.status = { $regex: /^(assigned|pending)$/i };
    } else if (s === "rejected" || s === "ignored") {
      query.$or = [
        { status: { $regex: /^(rejected|ignored|reject)$/i } },
        { assignedStatus: { $regex: /^(rejected|ignored|reject)$/i } },
        { "memberStatuses.assignedStatus": { $regex: /^(rejected|ignored|reject)$/i } },
        { rejectionReason: { $exists: true, $ne: "" } },
      ];
    } else if (s === "overdue") {
      query.status = { $ne: "Completed" };
      query.dueDate = { $lt: new Date() };
    }
  }

  // 4. Search Filter
  if (filters.search && filters.search.trim()) {
    query.$and = [
      ...(query.$and || []),
      {
        $or: [
          { taskTitle: { $regex: filters.search.trim(), $options: "i" } },
          { taskDetails: { $regex: filters.search.trim(), $options: "i" } },
        ],
      },
    ];
  }

  // 5. Date filter (using createdDate with createdAt fallback)
  const dateFilter = buildDateQuery(filters.period, filters.startDate, filters.endDate);
  if (dateFilter) {
    const dateOr = [
      { createdDate: dateFilter },
      { createdAt: dateFilter },
      { startDate: dateFilter },
    ];
    if (query.$or) {
      query.$and = [
        ...(query.$and || []),
        { $or: query.$or },
        { $or: dateOr },
      ];
      delete query.$or;
    } else {
      query.$or = dateOr;
    }
  }

  // 6. Fetch raw tasks
  let rawTasks = await Task.find(query)
    .populate("assignedMembers", "_id name employeeName firstName lastName email role department profileImage avatar photo empId")
    .populate("createdBy", "_id name employeeName firstName lastName email role photo empId")
    .sort({ createdDate: -1, createdAt: -1 })
    .lean();

  // Strict check: Only include tasks worked on by the target employee
  // Tasks assigned by an employee to other team members are strictly excluded from assigner's analytics
  if (isEmployeeScope && currentUserId) {
    rawTasks = rawTasks.filter((t) => isWorkedOnByEmployee(t, currentUserId));
  } else if (filters.employeeId && filters.employeeId.trim() && filters.employeeId !== "all") {
    rawTasks = rawTasks.filter((t) => isWorkedOnByEmployee(t, filters.employeeId.trim()));
  }

  // Self-created task fallback: if assignedMembers is missing or empty, assign to createdBy
  rawTasks.forEach((t) => {
    if ((!t.assignedMembers || t.assignedMembers.length === 0) && t.createdBy) {
      t.assignedMembers = [t.createdBy];
    }
  });

  const now = new Date();

  // 7. Aggregate analysis
  let totalTasksCount = rawTasks.length;
  let completedCount = 0;
  let inProgressCount = 0;
  let pendingCount = 0;
  let onHoldCount = 0;
  let rejectedCount = 0;
  let overdueCount = 0;
  let onTimeCompletedCount = 0;
  let lateCompletedCount = 0;

  let totalCompletedDurationMs = 0;
  let totalAllDurationMs = 0;

  const analyzedTasks = await Promise.all(
    rawTasks.map(async (t) => {
      const taskStatusLower = String(t.status || "").trim().toLowerCase();
      const assignedStatusLower = String(t.assignedStatus || "").trim().toLowerCase();
      const memberStatuses = Array.isArray(t.memberStatuses) ? t.memberStatuses : [];

      const hasMemberRejected = memberStatuses.some((ms) => {
        const msStatus = String(ms.assignedStatus || "").trim().toLowerCase();
        return (
          msStatus === "rejected" ||
          msStatus === "ignored" ||
          msStatus === "reject" ||
          Boolean(ms.rejectionReason && String(ms.rejectionReason).trim())
        );
      });

      const myMemberStatus = isEmployeeScope && currentUserId
        ? memberStatuses.find((ms) => String(ms.employeeId?._id || ms.employeeId) === String(currentUserId))
        : null;

      const isMyMemberRejected = myMemberStatus
        ? String(myMemberStatus.assignedStatus || "").trim().toLowerCase() === "rejected" ||
          String(myMemberStatus.assignedStatus || "").trim().toLowerCase() === "ignored" ||
          String(myMemberStatus.assignedStatus || "").trim().toLowerCase() === "reject" ||
          Boolean(myMemberStatus.rejectionReason && String(myMemberStatus.rejectionReason).trim())
        : false;

      const hasRootRejection =
        taskStatusLower === "rejected" ||
        taskStatusLower === "ignored" ||
        taskStatusLower === "reject" ||
        taskStatusLower === "cancelled" ||
        assignedStatusLower === "rejected" ||
        assignedStatusLower === "ignored" ||
        assignedStatusLower === "reject" ||
        Boolean(t.rejectionReason && String(t.rejectionReason).trim());

      const isRejected = isEmployeeScope
        ? isMyMemberRejected || (hasRootRejection && !myMemberStatus)
        : hasRootRejection || hasMemberRejected;

      // Status check: if employee scope, use employee's memberStatus status
      const effectiveStatus = (isEmployeeScope && myMemberStatus?.status)
        ? myMemberStatus.status
        : t.status;
      const normEffStatus = normalizeTaskStatus(effectiveStatus);

      let isCompleted = !isRejected && normEffStatus === TASK_STATUS.COMPLETED;
      let isInProgress = !isRejected && normEffStatus === TASK_STATUS.IN_PROGRESS;
      let isOnHold = !isRejected && normEffStatus === TASK_STATUS.ON_HOLD;
      let isPending = !isRejected && !isCompleted && !isInProgress && !isOnHold;

      // Multi-assignee team task status logic:
      // If 2 or more members assigned:
      // If ALL members are completed -> status is Completed
      // If ANY member is pending, onhold, inprocess -> status is Pending
      if (!isEmployeeScope && Array.isArray(t.assignedMembers) && t.assignedMembers.length > 1) {
        const memberStatuses = t.memberStatuses || [];
        let allMembersCompleted = t.assignedMembers.length > 0;
        t.assignedMembers.forEach((m) => {
          const mId = String(m._id || m);
          const ms = memberStatuses.find(
            (s) => String(s.employeeId?._id || s.employeeId?.id || s.employeeId) === mId
          );
          const mWorkStatus = String(ms?.status || t.status || "Pending").toLowerCase().replace(/[-_\s]/g, "");
          const mAssignedStatus = String(ms?.assignedStatus || t.assignedStatus || "").toLowerCase();
          const isRej = mAssignedStatus === "rejected" || mAssignedStatus === "ignored" || mWorkStatus === "rejected" || Boolean(ms?.rejectionReason && String(ms.rejectionReason).trim());
          const isComp = !isRej && (mWorkStatus === "completed" || mWorkStatus === "complete");
          if (!isComp) {
            allMembersCompleted = false;
          }
        });

        if (allMembersCompleted) {
          isCompleted = true;
          isInProgress = false;
          isOnHold = false;
          isPending = false;
        } else {
          isCompleted = false;
          isPending = true;
          isInProgress = false;
          isOnHold = false;
        }
      }

      const start = (isEmployeeScope && myMemberStatus?.startDate)
        ? new Date(myMemberStatus.startDate)
        : (t.startDate ? new Date(t.startDate) : (t.createdDate ? new Date(t.createdDate) : new Date(t.createdAt || now)));

      const end = (isEmployeeScope && myMemberStatus?.endDate)
        ? new Date(myMemberStatus.endDate)
        : (t.endDate ? new Date(t.endDate) : (isCompleted ? new Date(t.updatedAt || t.createdDate || t.createdAt || now) : null));

      const due = t.dueDate ? new Date(t.dueDate) : null;

      const effectiveEnd = end || now;
      let actualDurationMs = Math.max(0, effectiveEnd.getTime() - start.getTime());
      if (actualDurationMs === 0 && isCompleted) {
        // When assigned and completed on the same date (e.g. 23-09-2026 to 23-09-2026),
        // calendar dates stored as midnight UTC evaluate to 0ms difference.
        // Same-day completion represents 1 full day of completion (86,400,000 ms = 1d 0h).
        actualDurationMs = 86400000;
      }
      const plannedDurationMs = due ? Math.max(0, due.getTime() - start.getTime()) : null;

      const isOverdue = !isCompleted && !isRejected && due && now.getTime() > due.getTime();
      const wasCompletedLate = isCompleted && due && end && end.getTime() > due.getTime();

      let slaStatus = "ON_TRACK";
      if (isCompleted) {
        if (wasCompletedLate) {
          slaStatus = "DELAYED";
          lateCompletedCount++;
        } else {
          slaStatus = "ON_TIME";
          onTimeCompletedCount++;
        }
        completedCount++;
        totalCompletedDurationMs += actualDurationMs;
      } else if (isInProgress) {
        if (isOverdue) {
          slaStatus = "OVERDUE";
          overdueCount++;
        } else {
          slaStatus = "IN_PROGRESS";
        }
        inProgressCount++;
      } else if (isOnHold) {
        if (isOverdue) {
          slaStatus = "OVERDUE";
          overdueCount++;
        } else {
          slaStatus = "ON_HOLD";
        }
        onHoldCount++;
      } else if (isRejected) {
        slaStatus = "REJECTED";
        rejectedCount++;
      } else {
        if (isOverdue) {
          slaStatus = "OVERDUE";
          overdueCount++;
        } else {
          slaStatus = "PENDING";
        }
        pendingCount++;
      }

      totalAllDurationMs += actualDurationMs;

      let varianceMs = 0;
      let varianceInfo = null;
      if (due) {
        varianceMs = effectiveEnd.getTime() - due.getTime();
        if (varianceMs > 0) {
          varianceInfo = {
            isOverdue: true,
            status: "OVERDUE",
            deltaMs: varianceMs,
            duration: calculateDuration(due, effectiveEnd),
            text: `Overdue by ${formatDuration(varianceMs)}`,
          };
        } else {
          varianceInfo = {
            isEarly: true,
            status: "AHEAD",
            deltaMs: Math.abs(varianceMs),
            duration: calculateDuration(effectiveEnd, due),
            text: `Completed ${formatDuration(Math.abs(varianceMs))} ahead`,
          };
        }
      }

      const assignedMemberList = await Promise.all(
        (t.assignedMembers || []).map(async (m) => {
          let avatar = "/avatar.png";
          const raw = m.profileImage || m.avatar || m.photo || "";
          if (raw && raw !== "avatar.png") {
            try {
              avatar = (await getCachedSignedUrl(raw)) || raw;
            } catch (_) {
              avatar = raw;
            }
          }
          return {
            _id: m._id,
            name: m.name || m.employeeName || `${m.firstName || ""} ${m.lastName || ""}`.trim() || m.email || "Member",
            avatarUrl: avatar,
            role: m.role || m.designation,
            department: m.department,
          };
        })
      );

      return {
        _id: t._id,
        taskTitle: t.taskTitle,
        taskName: t.taskTitle,
        taskDetails: t.taskDetails,
        project: t.project || "General",
        team: t.project || t.category || "General",
        category: t.category || "General",
        priority: t.priority || "Mid",
        status: isRejected ? "Rejected" : (isCompleted ? "Completed" : (isInProgress ? "In Progress" : (isOnHold ? "On Hold" : "Pending"))),
        isRejected,
        isCompleted,
        isInProgress,
        isOnHold,
        isPending,
        isOverdue,
        wasCompletedLate,
        slaStatus,
        startDate: start.toISOString(),
        endDate: end ? end.toISOString() : null,
        dueDate: due ? due.toISOString() : null,
        actualDurationMs,
        plannedDurationMs,
        duration: calculateDuration(0, actualDurationMs),
        plannedDuration: plannedDurationMs ? calculateDuration(start, due) : null,
        variance: varianceInfo,
        assignedMembers: assignedMemberList,
        assignees: assignedMemberList,
        createdBy: t.createdBy,
        createdAt: t.createdDate || t.createdAt,
      };
    })
  );

  // 8. Overall Summary
  const validTasks = Math.max(0, totalTasksCount - rejectedCount);
  const completionRate = calculatePercentage(completedCount, validTasks);
  const slaEfficiency = calculatePercentage(onTimeCompletedCount, completedCount);
  const avgCompletionTimeMs = completedCount > 0 ? Math.round(totalCompletedDurationMs / completedCount) : 0;
  const avgCompletionStats = calculateDuration(0, avgCompletionTimeMs);

  const completedDurations = analyzedTasks
    .filter((t) => t.isCompleted && typeof t.actualDurationMs === "number" && t.actualDurationMs > 0)
    .map((t) => t.actualDurationMs)
    .sort((a, b) => a - b);

  const fastestMs = completedDurations.length > 0 ? completedDurations[0] : avgCompletionTimeMs;
  const slowestMs = completedDurations.length > 0 ? completedDurations[completedDurations.length - 1] : avgCompletionTimeMs;
  const teamAvgMs = completedDurations.length > 0 ? Math.round(completedDurations.reduce((a, b) => a + b, 0) / completedDurations.length) : avgCompletionTimeMs;

  const averageCompletionStats = {
    fastest: calculateDuration(0, fastestMs),
    slowest: calculateDuration(0, slowestMs),
    teamAverage: calculateDuration(0, teamAvgMs),
  };

  // 9. Project Summary
  const projectMap = {};
  analyzedTasks.forEach((t) => {
    const p = t.project || "General";
    if (!projectMap[p]) {
      projectMap[p] = { project: p, totalTasks: 0, completed: 0, inProgress: 0, onHold: 0, rejected: 0, overdue: 0 };
    }
    projectMap[p].totalTasks++;
    if (t.isCompleted) projectMap[p].completed++;
    else if (t.isInProgress) projectMap[p].inProgress++;
    else if (t.isOnHold) projectMap[p].onHold++;
    else if (t.isRejected) projectMap[p].rejected++;
    if (t.isOverdue) projectMap[p].overdue++;
  });

  const projectAnalytics = Object.values(projectMap).map((p) => {
    const valid = Math.max(0, p.totalTasks - p.rejected);
    return {
      ...p,
      completionRate: calculatePercentage(p.completed, valid),
    };
  });

  // 10. Member Analytics & Team Overview
  const teamMemberMap = {};
  analyzedTasks.forEach((t) => {
    t.assignedMembers.forEach((m) => {
      const id = String(m._id);
      if (!teamMemberMap[id]) {
        teamMemberMap[id] = {
          memberId: m._id,
          name: m.name,
          role: m.role,
          department: m.department,
          avatarUrl: m.avatarUrl,
          totalAssigned: 0,
          completed: 0,
          inProgress: 0,
          onHold: 0,
          rejected: 0,
          overdue: 0,
          onTime: 0,
          late: 0,
          totalDurationMs: 0,
        };
      }
      teamMemberMap[id].totalAssigned++;
      if (t.isCompleted) {
        teamMemberMap[id].completed++;
        if (t.slaStatus === "ON_TIME") teamMemberMap[id].onTime++;
        else if (t.slaStatus === "DELAYED") teamMemberMap[id].late++;
        teamMemberMap[id].totalDurationMs += t.actualDurationMs;
      } else if (t.isInProgress) {
        teamMemberMap[id].inProgress++;
      } else if (t.isOnHold) {
        teamMemberMap[id].onHold++;
      } else if (t.isRejected) {
        teamMemberMap[id].rejected++;
      }
      if (t.isOverdue) teamMemberMap[id].overdue++;
    });
  });

  const memberAnalytics = Object.values(teamMemberMap).map((m) => {
    const valid = Math.max(0, m.totalAssigned - m.rejected);
    const cRate = calculatePercentage(m.completed, valid);
    const otRate = calculatePercentage(m.onTime, m.completed);
    const avgMs = m.completed > 0 ? Math.round(m.totalDurationMs / m.completed) : 0;
    const durComp = calculateDuration(0, avgMs);

    const consistencyScore = calculateConsistencyScore({
      onTimeRate: otRate,
      overdueCount: m.overdue,
      totalTasks: valid,
      completedTasks: m.completed,
    });

    const perfScore = calculatePerformanceScore({
      completionRate: cRate,
      onTimeRate: otRate,
      deadlineReliability: otRate,
      phaseCompletionRate: cRate,
      consistencyScore,
    });

    const rankingEligibility = getRankingEligibility(valid, 5);

    return {
      memberId: m.memberId,
      name: m.name,
      role: m.role,
      department: m.department,
      avatarUrl: m.avatarUrl,
      totalAssigned: m.totalAssigned,
      completed: m.completed,
      inProgress: m.inProgress,
      onHold: m.onHold,
      rejected: m.rejected,
      overdue: m.overdue,
      onTime: m.onTime,
      late: m.late,
      completionRate: cRate,
      onTimeRate: otRate,
      slaEfficiency: otRate,
      averageCompletionTime: durComp ? durComp.daysHours : "0d 0h",
      averageCompletionSpeedMs: avgMs,
      performanceScore: perfScore,
      rankingEligible: rankingEligibility.rankingEligible,
      confidence: rankingEligibility.confidence,
      confidenceLabel: rankingEligibility.label,
    };
  });

  // Sort member analytics by performanceScore descending
  memberAnalytics.sort((a, b) => b.performanceScore - a.performanceScore);
  memberAnalytics.forEach((m, idx) => {
    if (m.rankingEligible) m.rank = idx + 1;
    else m.rank = null;
  });

  // 13. Team Tasks Overview (Tasks assigned to 2 or more persons)
  const multiAssigneeTasks = analyzedTasks.filter(
    (t) => Array.isArray(t.assignedMembers) && t.assignedMembers.length > 1
  );

  const teamOverview = multiAssigneeTasks.map((t) => {
    const memberStatuses = t.memberStatuses || [];
    const assignedMembers = Array.isArray(t.assignedMembers) ? t.assignedMembers : [];

    let allCompleted = assignedMembers.length > 0;
    assignedMembers.forEach((m) => {
      const mId = String(m._id || m);
      const ms = memberStatuses.find(
        (s) => String(s.employeeId?._id || s.employeeId?.id || s.employeeId) === mId
      );
      const mWorkStatus = String(ms?.status || t.status || "Pending").toLowerCase().replace(/[-_\s]/g, "");
      const mAssignedStatus = String(ms?.assignedStatus || t.assignedStatus || "").toLowerCase();
      const isRej = mAssignedStatus === "rejected" || mAssignedStatus === "ignored" || mWorkStatus === "rejected" || Boolean(ms?.rejectionReason && String(ms.rejectionReason).trim());
      const isComp = !isRej && (mWorkStatus === "completed" || mWorkStatus === "complete");
      if (!isComp) {
        allCompleted = false;
      }
    });

    const overallStatus = allCompleted ? "Completed" : "Pending";

    return {
      _id: t._id,
      taskId: t._id,
      taskTitle: t.taskTitle || t.taskName || "Task Item",
      taskName: t.taskTitle || t.taskName || "Task Item",
      taskDetails: t.taskDetails || "",
      project: t.project || "General",
      team: t.project || t.category || "General",
      category: t.category || "General",
      priority: t.priority || "Mid",
      status: overallStatus,
      isCompleted: allCompleted,
      assignedMembers: t.assignedMembers,
      assignees: t.assignedMembers,
      dueDate: t.dueDate,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      memberStatuses: t.memberStatuses,
    };
  });

  // 14. 14-Day Daily Trend Data (Tasks Created vs Completed as array of { date, created, completed })
  const trendDays = 14;
  const trendData = [];
  for (let i = trendDays - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
    const dayEnd = dayStart + 86400000;
    const dateStr = d.toLocaleDateString("en-US", { month: "short", day: "2-digit" });

    const createdOnDay = analyzedTasks.filter((t) => {
      const cTime = t.createdAt ? new Date(t.createdAt).getTime() : 0;
      return cTime >= dayStart && cTime < dayEnd;
    }).length;

    const completedOnDay = analyzedTasks.filter((t) => {
      if (!t.isCompleted) return false;
      const eTime = t.endDate ? new Date(t.endDate).getTime() : (t.createdAt ? new Date(t.createdAt).getTime() : 0);
      return eTime >= dayStart && eTime < dayEnd;
    }).length;

    trendData.push({
      date: dateStr,
      created: createdOnDay,
      completed: completedOnDay,
    });
  }

  // 15. Priority & Category Breakdowns
  const priorityBreakdown = {
    High: { total: 0, completed: 0, inProgress: 0, overdue: 0 },
    Mid: { total: 0, completed: 0, inProgress: 0, overdue: 0 },
    Low: { total: 0, completed: 0, inProgress: 0, overdue: 0 },
  };
  analyzedTasks.forEach((t) => {
    const pKey = t.priority || "Mid";
    if (!priorityBreakdown[pKey]) priorityBreakdown[pKey] = { total: 0, completed: 0, inProgress: 0, overdue: 0 };
    priorityBreakdown[pKey].total++;
    if (t.isCompleted) priorityBreakdown[pKey].completed++;
    else if (t.isInProgress) priorityBreakdown[pKey].inProgress++;
    if (t.isOverdue) priorityBreakdown[pKey].overdue++;
  });

  const categoryMap = {};
  analyzedTasks.forEach((t) => {
    const cName = t.category || "General";
    if (!categoryMap[cName]) {
      categoryMap[cName] = { category: cName, total: 0, completed: 0, inProgress: 0, overdue: 0, durationMs: 0 };
    }
    categoryMap[cName].total++;
    categoryMap[cName].durationMs += (t.actualDurationMs || 0);
    if (t.isCompleted) categoryMap[cName].completed++;
    else if (t.isInProgress) categoryMap[cName].inProgress++;
    if (t.isOverdue) categoryMap[cName].overdue++;
  });

  const categoryBreakdown = Object.values(categoryMap).map((c) => ({
    category: c.category,
    name: c.category,
    total: c.total,
    count: c.total,
    completed: c.completed,
    inProgress: c.inProgress,
    overdue: c.overdue,
    completionRate: c.total > 0 ? Math.round((c.completed / c.total) * 100) : 0,
    percentage: calculatePercentage(c.total, totalTasksCount),
    avgDuration: calculateDuration(0, c.total > 0 ? Math.round(c.durationMs / c.total) : 0),
  })).sort((a, b) => b.total - a.total);

  const slaWatchlist = analyzedTasks
    .filter((t) => t.isOverdue || t.wasCompletedLate)
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))
    .slice(0, 15);

  return {
    success: true,
    role: isAdmin ? "admin" : "employee",
    summary: {
      totalTasks: totalTasksCount,
      total: totalTasksCount,
      validTasks,
      completedTasks: completedCount,
      completed: completedCount,
      inProgressTasks: inProgressCount,
      inProgress: inProgressCount,
      pendingTasks: pendingCount,
      pending: pendingCount,
      onHoldTasks: onHoldCount,
      onHold: onHoldCount,
      rejectedTasks: rejectedCount,
      rejected: rejectedCount,
      overdueTasks: overdueCount,
      overdue: overdueCount,
      onTimeCompleted: onTimeCompletedCount,
      lateCompleted: lateCompletedCount,
      completionRate,
      onTimeCompletionRate: completedCount > 0 ? Number(((onTimeCompletedCount / completedCount) * 100).toFixed(1)) : 0,
      slaEfficiency,
      avgCompletionTime: avgCompletionStats ? avgCompletionStats.daysHours : "0d 0h",
      avgCompletionTimeMs,
    },
    projectSummary: {
      totalProjects: projectAnalytics.length,
      completedProjects: projectAnalytics.filter((p) => p.completionRate === 100).length,
      ongoingProjects: projectAnalytics.filter((p) => p.completionRate < 100).length,
      projects: projectAnalytics,
    },
    memberAnalytics: isAdmin
      ? memberAnalytics
      : memberAnalytics.filter((m) => String(m.memberId) === String(currentUserId)),
    teamOverview,
    trendData,
    averageCompletionStats,
    recentTasks: analyzedTasks.slice(0, 20),
    priorityBreakdown,
    categoryBreakdown,
    slaWatchlist,
    tasks: analyzedTasks,
  };
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 6. Legacy Detailed Employee Performance Analytics (for EmployeePerformanceModal)
 * ─────────────────────────────────────────────────────────────────────────────
 */
async function getEmployeePerformanceDetailsLegacy(req, res) {
  try {
    const { employeeId } = req.params;
    const { trendRange = "15days" } = req.query;

    if (!employeeId || !mongoose.Types.ObjectId.isValid(employeeId)) {
      return res.status(400).json({ success: false, message: "Invalid or missing employee ID" });
    }

    const empObjId = new mongoose.Types.ObjectId(employeeId);
    const empIdStr = String(employeeId);

    // 1. Fetch Employee Profile
    const emp = await User.findById(empObjId)
      .select("_id name employeeName firstName lastName designation role department empId email profileImage avatar photo employmentStatus status")
      .lean();

    if (!emp) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    let empName = emp.name || emp.employeeName || `${emp.firstName || ""} ${emp.lastName || ""}`.trim() || emp.email || "Employee";
    let empRole = emp.designation || emp.role || "Team Member";
    let empDept = emp.department || "General";
    let empCode = emp.empId || `EMP-${String(emp._id).slice(-4).toUpperCase()}`;
    let empEmail = emp.email || "";
    let rawAvatar = emp.profileImage || emp.avatar || emp.photo || "";
    let avatarUrl = "/avatar.png";
    if (rawAvatar && rawAvatar !== "avatar.png") {
      try {
        avatarUrl = (await getCachedSignedUrl(rawAvatar)) || rawAvatar;
      } catch (_) {
        avatarUrl = rawAvatar;
      }
    }
    const isActive = emp.employmentStatus !== "relieved" && emp.employmentStatus !== "relived" && emp.status !== "relieved" && emp.status !== "relived";

    // 2. Fetch all tasks assigned to this employee (or created by them for themselves)
    const rawTasks = await Task.find({
      $or: [
        { assignedMembers: empObjId },
        { "memberStatuses.employeeId": empObjId },
        {
          $and: [
            { createdBy: empObjId },
            {
              $or: [
                { assignedMembers: { $exists: false } },
                { assignedMembers: { $size: 0 } },
                { assignedMembers: empObjId },
              ],
            },
          ],
        },
        { assignedMembers: empIdStr },
        { "memberStatuses.employeeId": empIdStr },
        {
          $and: [
            { createdBy: empIdStr },
            {
              $or: [
                { assignedMembers: { $exists: false } },
                { assignedMembers: { $size: 0 } },
                { assignedMembers: empIdStr },
              ],
            },
          ],
        },
      ],
    })
    .populate("assignedMembers", "_id name employeeName firstName lastName profileImage avatar photo role department empId email")
    .populate("createdBy", "_id name employeeName firstName lastName profileImage avatar photo role department empId email")
    .sort({ createdAt: -1 })
    .lean();

    // Filter tasks strictly to those worked on by this employee
    const tasks = rawTasks.filter((t) => isWorkedOnByEmployee(t, empObjId));

    const now = new Date();

    // 3. Analyze Tasks & Calculate Overview Metrics
    let totalTasks = tasks.length;
    let completed = 0;
    let inProgress = 0;
    let pending = 0;
    let onHold = 0;
    let rejected = 0;
    let overdue = 0;
    let onTimeCompleted = 0;

    let totalCompletedDurationMs = 0;
    let totalAllDurationMs = 0;
    let last30DaysDurationMs = 0;
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

    const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

    let thisMonthCompleted = 0;
    let thisMonthAssigned = 0;
    let lastMonthCompleted = 0;
    let lastMonthAssigned = 0;
    let thisMonthCompletedDurMs = 0;
    let lastMonthCompletedDurMs = 0;

    const mappedTasks = await Promise.all(tasks.map(async (t) => {
      // Self-created task fallback: assign to createdBy if assignedMembers is empty
      if (!t.assignedMembers || t.assignedMembers.length === 0) {
        if (t.createdBy) {
          t.assignedMembers = [t.createdBy];
        }
      }

      const ms = (t.memberStatuses || []).find(
        (m) =>
          String(m.employeeId?._id || m.employeeId?.id || m.employeeId) === String(empObjId) ||
          String(m.employeeId?._id || m.employeeId?.id || m.employeeId) === empIdStr
      );

      const msStatusRaw = String(ms?.status || t.status || "").toLowerCase().replace(/[-_\s]/g, "");
      const msAssignedStatusRaw = String(ms?.assignedStatus || t.assignedStatus || "").toLowerCase();

      const msRej = ms
        ? msAssignedStatusRaw === "rejected" ||
          msAssignedStatusRaw === "ignored" ||
          msAssignedStatusRaw === "reject" ||
          msStatusRaw === "rejected" ||
          msStatusRaw === "ignored" ||
          Boolean(ms.rejectionReason && String(ms.rejectionReason).trim())
        : false;

      const rootRej =
        String(t.assignedStatus || "").toLowerCase() === "rejected" ||
        String(t.assignedStatus || "").toLowerCase() === "ignored" ||
        String(t.assignedStatus || "").toLowerCase() === "reject" ||
        String(t.status || "").toLowerCase() === "rejected" ||
        String(t.status || "").toLowerCase() === "ignored" ||
        Boolean(t.rejectionReason && String(t.rejectionReason).trim());

      const isRej = msRej || rootRej;

      let normalizedStatus = "Pending";
      if (isRej) {
        normalizedStatus = "Rejected";
        rejected++;
      } else if (msStatusRaw === "completed" || msStatusRaw === "complete") {
        normalizedStatus = "Completed";
        completed++;
      } else if (msStatusRaw === "inprocess" || msStatusRaw === "inprogress") {
        normalizedStatus = "In Process";
        inProgress++;
      } else if (msStatusRaw === "hold" || msStatusRaw === "onhold") {
        normalizedStatus = "On Hold";
        onHold++;
      } else {
        normalizedStatus = "Pending";
        pending++;
      }

      const rawStart = ms?.startDate || t.startDate || t.createdDate || t.createdAt || now;
      const startCandidate = new Date(rawStart);
      const start = !isNaN(startCandidate.getTime()) ? startCandidate : now;

      const rawEnd = ms?.endDate || t.endDate || (normalizedStatus === "Completed" ? (t.updatedAt || t.createdDate || t.createdAt || now) : null);
      const endCandidate = rawEnd ? new Date(rawEnd) : null;
      const end = endCandidate && !isNaN(endCandidate.getTime()) ? endCandidate : null;

      const rawDue = t.dueDate ? new Date(t.dueDate) : null;
      const due = rawDue && !isNaN(rawDue.getTime()) ? rawDue : null;

      const effectiveEnd = end || now;
      let durationMs = 0;
      if (!isRej) {
        durationMs = Math.max(0, effectiveEnd.getTime() - start.getTime());
        if (durationMs === 0 && normalizedStatus === "Completed") {
          durationMs = 86400000; // 1 Day
        }
        totalAllDurationMs += durationMs;
      }

      const isOverdue = normalizedStatus !== "Completed" && !isRej && due && now.getTime() > due.getTime();
      if (isOverdue) overdue++;

      const isCompleted = normalizedStatus === "Completed";
      if (isCompleted) {
        totalCompletedDurationMs += durationMs;
        if (due && end && end.getTime() <= due.getTime()) {
          onTimeCompleted++;
        } else if (!due) {
          onTimeCompleted++;
        }
      }

      const taskCreatedAtCandidate = new Date(t.createdDate || t.createdAt || start);
      const taskCreatedAt = !isNaN(taskCreatedAtCandidate.getTime()) ? taskCreatedAtCandidate : start;
      if (!isRej && taskCreatedAt >= thirtyDaysAgo) {
        last30DaysDurationMs += durationMs;
      }

      if (!isRej) {
        if (taskCreatedAt >= startOfCurrentMonth) {
          thisMonthAssigned++;
          if (isCompleted) {
            thisMonthCompleted++;
            thisMonthCompletedDurMs += durationMs;
          }
        } else if (taskCreatedAt >= startOfLastMonth && taskCreatedAt <= endOfLastMonth) {
          lastMonthAssigned++;
          if (isCompleted) {
            lastMonthCompleted++;
            lastMonthCompletedDurMs += durationMs;
          }
        }
      }

      const phases = Array.isArray(t.phases) ? t.phases : [];
      const totalPhases = phases.length;
      const completedPhases = phases.filter(p => String(p.phaseStatus || "").toLowerCase() === "completed").length;
      const progress = isRej ? 0 : (totalPhases > 0 ? Math.round((completedPhases / totalPhases) * 100) : (isCompleted ? 100 : (normalizedStatus === "In Process" ? 50 : 0)));

      const memberList = await Promise.all((t.assignedMembers || []).map(async (m) => {
        let mAvatar = "/avatar.png";
        const mRaw = m.profileImage || m.avatar || m.photo || "";
        if (mRaw && mRaw !== "avatar.png") {
          try {
            mAvatar = (await getCachedSignedUrl(mRaw)) || mRaw;
          } catch (_) {
            mAvatar = mRaw;
          }
        }
        return {
          _id: m._id,
          name: m.name || m.employeeName || `${m.firstName || ""} ${m.lastName || ""}`.trim() || m.email || "Member",
          avatarUrl: mAvatar,
          role: m.role || m.designation,
          department: m.department,
        };
      }));

      const durObj = calculateDuration(0, durationMs);
      return {
        _id: t._id,
        taskTitle: t.taskTitle,
        taskName: t.taskTitle,
        taskDetails: t.taskDetails,
        project: t.project || "General",
        category: t.category || "General",
        priority: t.priority || "Mid",
        status: normalizedStatus,
        isCompleted,
        isRejected: isRej,
        isOverdue,
        progress,
        startDate: start.toISOString(),
        endDate: end ? end.toISOString() : null,
        dueDate: due ? due.toISOString() : null,
        durationMs,
        duration: durObj,
        assignedMembers: memberList,
        phasesCount: totalPhases,
        completedPhases,
        createdAt: taskCreatedAt.toISOString(),
        updatedAt: t.updatedAt && !isNaN(new Date(t.updatedAt).getTime()) ? new Date(t.updatedAt).toISOString() : (end ? end.toISOString() : taskCreatedAt.toISOString()),
      };
    }));

    const validTasks = Math.max(0, totalTasks - rejected);
    const completionRate = validTasks > 0 ? Math.round((completed / validTasks) * 100) : 0;
    const avgCompletionSpeedMs = completed > 0 ? Math.round(totalCompletedDurationMs / completed) : 0;
    const avgDurObj = calculateDuration(0, avgCompletionSpeedMs);
    const avgCompletionTime = avgDurObj.daysHours || avgDurObj.compact || (completed > 0 ? "1d 0h" : "0d 0h");

    const totalDurObj = calculateDuration(0, last30DaysDurationMs);
    const totalWorkDuration = totalDurObj.daysHours || totalDurObj.compact || "0d 0h";

    const thisMonthRate = thisMonthAssigned > 0 ? (thisMonthCompleted / thisMonthAssigned) * 100 : completionRate;
    const lastMonthRate = lastMonthAssigned > 0 ? (lastMonthCompleted / lastMonthAssigned) * 100 : 0;
    const completionRateDelta = Math.round(thisMonthRate - lastMonthRate);

    const thisMonthAvgSpeedMs = thisMonthCompleted > 0 ? thisMonthCompletedDurMs / thisMonthCompleted : 0;
    const lastMonthAvgSpeedMs = lastMonthCompleted > 0 ? lastMonthCompletedDurMs / lastMonthCompleted : 0;
    const avgTimeDelta = lastMonthAvgSpeedMs > 0 ? Math.round(((thisMonthAvgSpeedMs - lastMonthAvgSpeedMs) / lastMonthAvgSpeedMs) * 100) : 0;

    let numDays = 15;
    if (trendRange === "7days") numDays = 7;
    else if (trendRange === "30days") numDays = 30;

    const trendLabels = [];
    const trendAssigned = [];
    const trendCompleted = [];
    const trendAvgTime = [];

    for (let i = numDays - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const dStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
      const dEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

      const label = d.toLocaleDateString("en-US", { month: "short", day: "2-digit" });
      trendLabels.push(label);

      const assignedOnDay = mappedTasks.filter(t => {
        if (t.isRejected) return false;
        const c = new Date(t.createdAt || t.startDate);
        return c >= dStart && c <= dEnd;
      }).length;

      const completedTasksOnDay = mappedTasks.filter(t => {
        if (!t.isCompleted || !t.endDate) return false;
        const e = new Date(t.endDate);
        return e >= dStart && e <= dEnd;
      });

      const completedOnDay = completedTasksOnDay.length;
      let avgHrsOnDay = 0;
      if (completedOnDay > 0) {
        const totalMs = completedTasksOnDay.reduce((acc, curr) => acc + (curr.durationMs || 0), 0);
        avgHrsOnDay = Number((totalMs / (completedOnDay * 3600000)).toFixed(1));
      }

      trendAssigned.push(assignedOnDay);
      trendCompleted.push(completedOnDay);
      trendAvgTime.push(avgHrsOnDay);
    }

    const validMappedTasks = mappedTasks.filter(t => !t.isRejected);
    const categoryCounts = {};
    validMappedTasks.forEach(t => {
      const cat = (t.category || "General").trim();
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    });

    const categoryColors = ["#3b82f6", "#06b6d4", "#f59e0b", "#8b5cf6", "#ec4899", "#10b981", "#6366f1", "#14b8a6"];
    const categoryLabels = Object.keys(categoryCounts);
    if (categoryLabels.length === 0) {
      categoryLabels.push("General");
      categoryCounts["General"] = 0;
    }
    const categoryData = categoryLabels.map(k => categoryCounts[k]);
    const validTotal = validMappedTasks.length;
    const categoryBreakdown = categoryLabels.map((k, idx) => ({
      name: k,
      count: categoryCounts[k],
      percent: validTotal > 0 ? Math.round((categoryCounts[k] / validTotal) * 100) : 0,
      color: categoryColors[idx % categoryColors.length],
    }));

    const teamTasks = mappedTasks.filter(t => !t.isRejected && Array.isArray(t.assignedMembers) && t.assignedMembers.length > 1);

    const total30DaysHoursInt = Math.floor(last30DaysDurationMs / 3600000);
    const total30DaysMins = Math.round((last30DaysDurationMs % 3600000) / 60000);
    const formattedTotalLogged = `${total30DaysHoursInt}h ${total30DaysMins}m`;

    const activeDaysInMonth = 22;
    const dailyAvgMs = last30DaysDurationMs / activeDaysInMonth;
    const dailyAvgHoursInt = Math.floor(dailyAvgMs / 3600000);
    const dailyAvgMins = Math.round((dailyAvgMs % 3600000) / 60000);
    const formattedDailyAverage = `${dailyAvgHoursInt}h ${dailyAvgMins}m`;

    const slaEfficiency = completed > 0 ? Number(((onTimeCompleted / completed) * 100).toFixed(1)) : (overdue === 0 ? 100 : 0);

    const recentWorkUpdates = await DailyWorkUpdate.find({ userId: empObjId })
      .populate("task", "taskTitle project")
      .sort({ createdAt: -1 })
      .limit(15)
      .lean();

    const activityLogs = [];
    recentWorkUpdates.forEach(wu => {
      const timeStr = formatActivityTime(wu.updateDate || wu.createdAt);
      const title = wu.title
        ? `Logged phase update: "${wu.title}" ${wu.task?.taskTitle ? `in ${wu.task.taskTitle}` : ""}`
        : `Submitted daily work update for ${wu.project || "Task"}`;
      activityLogs.push({
        title,
        time: timeStr,
        timestamp: new Date(wu.updateDate || wu.createdAt).getTime(),
        type: wu.status === "completed" ? "completed" : "inprogress",
      });
    });

    mappedTasks.slice(0, 10).forEach(t => {
      if (t.isCompleted && t.endDate) {
        activityLogs.push({
          title: `Completed task "${t.taskTitle}"`,
          time: formatActivityTime(t.endDate),
          timestamp: new Date(t.endDate).getTime(),
          type: "completed",
        });
      }
      if (t.status === "In Progress") {
        activityLogs.push({
          title: `Working on task "${t.taskTitle}"`,
          time: formatActivityTime(t.updatedAt || t.startDate),
          timestamp: new Date(t.updatedAt || t.startDate).getTime(),
          type: "inprogress",
        });
      }
      activityLogs.push({
        title: `Assigned to task "${t.taskTitle}"`,
        time: formatActivityTime(t.createdAt),
        timestamp: new Date(t.createdAt).getTime(),
        type: "assigned",
      });
    });

    activityLogs.sort((a, b) => b.timestamp - a.timestamp);
    const finalActivityLog = activityLogs.slice(0, 10);

    return res.status(200).json({
      success: true,
      profile: {
        _id: emp._id,
        name: empName,
        role: empRole,
        department: empDept,
        empId: empCode,
        email: empEmail,
        avatarUrl,
        isActive,
      },
      overview: {
        totalTasks,
        completed,
        inProgress,
        pending,
        onHold,
        rejected,
        overdue,
        completionRate,
        avgCompletionTime,
        totalWorkDuration,
        completionRateDelta,
        avgTimeDelta,
      },
      trendChart: {
        labels: trendLabels,
        tasksAssigned: trendAssigned,
        tasksCompleted: trendCompleted,
        avgTime: trendAvgTime,
      },
      categoryBreakdown: {
        labels: categoryLabels,
        data: categoryData,
        colors: categoryColors.slice(0, categoryLabels.length),
        breakdown: categoryBreakdown,
        totalTasks: validTotal,
      },
      teamTasks,
      timeTracking: {
        totalLogged: formattedTotalLogged,
        dailyAverage: formattedDailyAverage,
        slaEfficiency: `${slaEfficiency}%`,
      },
      activityLog: finalActivityLog,
      tasks: mappedTasks,
    });
  } catch (error) {
    console.error("GET EMPLOYEE PERFORMANCE DETAILS ERROR:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

module.exports = {
  calculateEmployeeTaskMetrics,
  getEmployeePerformance,
  getTeamPerformance,
  getPerformanceTrends,
  getLegacyTaskAnalytics,
  getEmployeePerformanceDetailsLegacy,
};

