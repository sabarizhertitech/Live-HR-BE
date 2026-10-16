const Task = require("../Models/task.model");
const mongoose = require("mongoose");
const { uploadToS3 } = require("../utilities/s3Upload");
const getCachedSignedUrl = require("../utilities/s3CachedUrl");
const deleteFromS3 = require("../utilities/s3Delete");
const User = require("../Models/Employee");
const TaskMeta = require("../Models/TaskMeta.model");
const EmployeeDetails = require("../Models/EmployeeDetails");
const DailyWorkUpdate = require("../Models/Dailyworkupdate");
const { sendPushNotification } = require("../utilities/notificationService");
const { sendTaskAssignmentEmail } = require("../utilities/emailService");
const { createLog } = require("../utilities/logService");
const { syncTaskWorkingDays } = require("../utilities/workingDaysCalculator");
const {
  fetchCompanyHolidaysSet,
  fetchEmployeeApprovedLeavesSet,
  calculateEligibleWorkingDays,
  calculateDeadlineScore,
} = require("../utilities/taskDeadlineCalculator");
const {
  getEmployeeWorkingCalendar,
  evaluateTaskBannerState,
} = require("../utilities/taskBannerReminderCalculator");

/**
 * Helper to compute changed fields for a task before & after edit
 */
const buildTaskDiffs = async (oldTask, updates, files = [], deletedDocuments = null) => {
  const changes = [];

  if (updates.taskTitle !== undefined && String(updates.taskTitle).trim() !== String(oldTask.taskTitle || "").trim()) {
    changes.push({
      fieldName: "Title",
      from: oldTask.taskTitle || "",
      to: updates.taskTitle.trim(),
    });
  }

  if (updates.taskDetails !== undefined && String(updates.taskDetails).trim() !== String(oldTask.taskDetails || "").trim()) {
    changes.push({
      fieldName: "Details",
      from: oldTask.taskDetails || "",
      to: updates.taskDetails.trim(),
    });
  }

  if (updates.priority !== undefined && String(updates.priority).trim() !== String(oldTask.priority || "").trim()) {
    changes.push({
      fieldName: "Priority",
      from: oldTask.priority || "Mid",
      to: updates.priority.trim(),
    });
  }

  if (updates.dueDate !== undefined) {
    const oldDue = oldTask.dueDate ? new Date(oldTask.dueDate).toISOString().split("T")[0] : "";
    const newDue = updates.dueDate ? new Date(updates.dueDate).toISOString().split("T")[0] : "";
    if (oldDue !== newDue) {
      changes.push({
        fieldName: "Due Date",
        from: oldDue,
        to: newDue,
      });
    }
  }

  if (updates.category !== undefined && String(updates.category).trim() !== String(oldTask.category || "").trim()) {
    changes.push({
      fieldName: "Category",
      from: oldTask.category || "",
      to: updates.category.trim(),
    });
  }

  if (updates.project !== undefined && String(updates.project).trim() !== String(oldTask.project || "").trim()) {
    changes.push({
      fieldName: "Project",
      from: oldTask.project || "",
      to: updates.project.trim(),
    });
  }

  if (updates.assignedMembers !== undefined) {
    const oldMemberIds = (oldTask.assignedMembers || []).map(m => String(m._id || m));
    const newMemberIds = (updates.assignedMembers || []).map(m => String(m._id || m));

    const isChanged =
      oldMemberIds.length !== newMemberIds.length ||
      oldMemberIds.some(id => !newMemberIds.includes(id));

    if (isChanged) {
      const oldUsers = oldMemberIds.length ? await User.find({ _id: { $in: oldMemberIds } }).select("name") : [];
      const newUsers = newMemberIds.length ? await User.find({ _id: { $in: newMemberIds } }).select("name") : [];
      const oldNames = oldUsers.map(u => u.name).filter(Boolean).join(", ") || "None";
      const newNames = newUsers.map(u => u.name).filter(Boolean).join(", ") || "None";
      changes.push({
        fieldName: "Assigned Members",
        from: oldNames,
        to: newNames,
      });
    }
  }

  if (deletedDocuments) {
    let deletedCount = 0;
    try {
      const parsed = typeof deletedDocuments === "string" ? JSON.parse(deletedDocuments) : deletedDocuments;
      if (Array.isArray(parsed)) deletedCount = parsed.length;
    } catch (e) { }
    if (deletedCount > 0) {
      changes.push({
        fieldName: "Documents",
        from: `${deletedCount} document(s)`,
        to: "Deleted",
      });
    }
  }

  if (files && files.length > 0) {
    changes.push({
      fieldName: "Documents",
      from: "None",
      to: `Uploaded ${files.length} new file(s)`,
    });
  }

  return changes;
};


/* ══════════════════════════════════════════════════════════
   SERVER LOGGER UTILITY
   Focus: Clean, Timestamped Logs (No Sensitive IDs)
══════════════════════════════════════════════════════════ */

const LOG_LEVEL = process.env.LOG_LEVEL || "INFO";
const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, SUCCESS: 1 };

function shouldLog(level) {
  return (LEVELS[level] ?? 1) >= (LEVELS[LOG_LEVEL] ?? 1);
}

function serverLog(level, context, message) {
  // Only show ERROR and WARN logs to keep the terminal clean
  if (level !== "ERROR" && level !== "WARN") return;
  if (!shouldLog(level)) return;

  const timestamp = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const COLORS = {
    INFO: "\x1b[36m",  // Cyan
    WARN: "\x1b[33m",  // Yellow
    ERROR: "\x1b[31m",  // Red
    SUCCESS: "\x1b[32m",  // Green
    DEBUG: "\x1b[35m",  // Magenta
    RESET: "\x1b[0m",
  };

  const color = COLORS[level] || COLORS.INFO;
  const reset = COLORS.RESET;
  const ctx = `\x1b[1m[${context}]\x1b[0m`;

  console.log(`${color}[${timestamp}] [${level}]${reset} ${ctx} ${message}`);
}

/** Log incoming HTTP request (Privacy Focused) */
function logRequest(context, req) {
  serverLog("INFO", context, `→ [${req.method}] ${req.originalUrl || req.url}`);
}

/** Log outgoing HTTP response (Privacy Focused) */
function logResponse(context, statusCode, message) {
  const level = statusCode >= 500 ? "ERROR" : statusCode >= 400 ? "WARN" : "SUCCESS";
  serverLog(level, context, `← [${statusCode}] ${message}`);
}

/** Log error details (Privacy Focused) */
function logError(context, error) {
  serverLog("ERROR", context, `✖ ${error.message || error}`);
}

/* ══════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════ */

/** Upload every file in req.files to S3, return array of keys */
async function uploadFiles(reqFiles, userId) {
  const keys = [];
  for (const file of reqFiles) {
    const ext = file.originalname.split(".").pop().toLowerCase();
    const baseName = file.originalname.substring(0, file.originalname.lastIndexOf(".")).replace(/[^a-zA-Z0-9_-]/g, "_") || "doc";
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0] + "_" + now.toTimeString().slice(0, 5).replace(":", "-");
    const uniqueId = Date.now().toString(36) + "_" + Math.random().toString(36).substring(2, 7);
    const key = `Tasks/${userId}/${dateStr}_${uniqueId}_${baseName}.${ext}`;
    await uploadToS3(file.buffer, key, file.mimetype);
    keys.push(key);
  }
  return keys;
}

/** Parse assignedMembers (string | array) → ObjectId[] */
function parseMembers(raw) {
  if (!raw) return [];
  let arr;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch (e) {
      // If it's a single string, wrap it in an array
      arr = [raw];
    }
  } else {
    arr = raw;
  }

  if (!Array.isArray(arr)) arr = [arr];

  return arr
    .filter(id => id && mongoose.Types.ObjectId.isValid(id))
    .map(id => new mongoose.Types.ObjectId(id));
}

/** Parse phases (string | array) → object[], always ensuring schema compatibility */
function parsePhases(raw) {
  if (!raw || raw === "[]") return [];
  let arr;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      arr = [raw];
    }
  } else {
    arr = raw;
  }
  if (!Array.isArray(arr)) arr = [arr];

  return arr.map(item => {
    if (typeof item === 'string') {
      return {
        phaseTitle: item.trim(),
        phaseDescription: "",
        phaseStatus: "pending",
        updateDate: new Date()
      };
    }
    // Preserve existing _id and other properties if it's already an object
    return {
      ...item,
      phaseTitle: (item.phaseTitle || item.phase || "").trim(),
      phaseDescription: (item.phaseDescription || "").trim(),
      phaseStatus: item.phaseStatus || "pending",
      updateDate: item.updateDate || new Date()
    };
  }).filter(p => p.phaseTitle); // Remove empty phases
}

/* ══════════════════════════════════════════════════════════
   PHASE → DAILY WORK UPDATE SYNC UTILITY

   Called any time a phase is created or updated on a Task.
   Rules:
   - Identify phase using actual phaseId (fallback to referenceId for legacy compatibility).
   - If a DailyWorkUpdate exists for this phase → UPDATE it (preserve original updateDate and referenceId).
   - If none exists → CREATE a new one with phaseId (referenceId undefined if single current record).
   - Never store parent taskId inside DailyWorkUpdate entry.
   - Synchronize phaseStatus accurately.
══════════════════════════════════════════════════════════ */
async function syncPhaseToDailyWorkUpdate({
  phaseId,
  phaseTitle,
  phaseDescription,
  phaseStatus,
  updateDate,
  userId,
  category,
  project,
  workType,
  pages,
}) {
  try {
    if (!phaseId || !mongoose.Types.ObjectId.isValid(phaseId.toString())) return;

    const pId = new mongoose.Types.ObjectId(phaseId.toString());
    const incomingStatus = (phaseStatus || "inprocess").toLowerCase();
    const resolvedDate = updateDate ? new Date(updateDate) : new Date();

    const targetDate = new Date(resolvedDate);
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    // 1. Check if a record already exists for this phase on the SAME CALENDAR DAY
    const sameDayRecord = await DailyWorkUpdate.findOne({
      $or: [{ phaseId: pId }, { referenceId: pId }],
      updateDate: { $gte: startOfDay, $lte: endOfDay }
    });

    if (sameDayRecord) {
      // ── UPDATE existing record on the SAME day ──
      sameDayRecord.phaseId = pId;
      sameDayRecord.title = phaseTitle || sameDayRecord.title;
      sameDayRecord.description = phaseDescription ?? sameDayRecord.description;
      sameDayRecord.status = incomingStatus;
      if (category) sameDayRecord.category = category;
      if (project) sameDayRecord.project = project;
      if (workType !== undefined) sameDayRecord.workType = (workType && String(workType).trim()) ? String(workType).trim() : undefined;
      if (pages !== undefined) sameDayRecord.pages = (Array.isArray(pages) && pages.length > 0) ? pages.map(p => String(p).trim()).filter(Boolean) : undefined;
      sameDayRecord.task = undefined;

      await sameDayRecord.save();
    } else {
      // ── NO RECORD ON THIS CALENDAR DAY ──
      // Check if historical daily-work records exist for this phase on prior days
      const existingPhaseRecords = await DailyWorkUpdate.find({
        $or: [{ phaseId: pId }, { referenceId: pId }]
      }).sort({ updateDate: 1 });

      if (existingPhaseRecords.length > 0) {
        // Multi-day / multiple transitions: Preserve previous day records intact!
        // Group all records for this phase with a stable referenceId
        const existingRef = existingPhaseRecords.find(r => r.referenceId && mongoose.Types.ObjectId.isValid(r.referenceId.toString()));
        const stableRefId = existingRef?.referenceId || new mongoose.Types.ObjectId();

        // Ensure all historical records share this stableRefId
        await DailyWorkUpdate.updateMany(
          {
            $or: [{ phaseId: pId }, { referenceId: pId }],
            $or: [{ referenceId: { $exists: false } }, { referenceId: null }]
          },
          { $set: { referenceId: stableRefId } }
        );

        // Create a new separate record for this day with the new status
        await DailyWorkUpdate.create({
          phaseId: pId,
          referenceId: stableRefId,
          task: undefined,
          userId: userId ? new mongoose.Types.ObjectId(userId.toString()) : undefined,
          title: phaseTitle,
          description: phaseDescription || "",
          status: incomingStatus,
          updateDate: resolvedDate,
          category: category || "",
          project: project || "",
          workType: (workType && String(workType).trim()) ? String(workType).trim() : undefined,
          pages: (Array.isArray(pages) && pages.length > 0) ? pages.map(p => String(p).trim()).filter(Boolean) : undefined,
        });
      } else {
        // First record for this phase: single record, referenceId remains absent
        await DailyWorkUpdate.create({
          phaseId: pId,
          referenceId: undefined,
          task: undefined,
          userId: userId ? new mongoose.Types.ObjectId(userId.toString()) : undefined,
          title: phaseTitle,
          description: phaseDescription || "",
          status: incomingStatus,
          updateDate: resolvedDate,
          category: category || "",
          project: project || "",
          workType: (workType && String(workType).trim()) ? String(workType).trim() : undefined,
          pages: (Array.isArray(pages) && pages.length > 0) ? pages.map(p => String(p).trim()).filter(Boolean) : undefined,
        });
      }
    }
  } catch (err) {
    serverLog("ERROR", "SYNC_PHASE_TO_DWU", `Phase sync failed for phaseId=${phaseId}: ${err.message}`);
  }
}

/* ══════════════════════════════════════════════════════════
   CREATE TASK
══════════════════════════════════════════════════════════ */
exports.createTask = async (req, res) => {
  const CONTEXT = "CREATE_TASK";
  const startTime = Date.now();
  logRequest(CONTEXT, req);

  try {
    const {
      taskTitle, taskDetails, priority,
      startDate, dueDate, endDate,
      assignedMembers, assignedStatus, status,
      phases, category, project,
      workType, pages,
    } = req.body;

    // ── Validation ──
    if (!taskTitle || !taskDetails) {
      logResponse(CONTEXT, 400, "Title & Details required");
      return res.status(400).json({ message: "Title & Details required" });
    }

    const userId = req.user.id;
    const empId = req.user.empId || userId;

    // ── Members Logic: Filter out creator (to avoid redundant storage) ──
    let members = parseMembers(assignedMembers);
    members = members.filter(id => id.toString() !== userId.toString());

    const isCompleted = (status || "").toLowerCase() === "completed";
    const resolvedEndDate = isCompleted ? new Date() : undefined;

    // ── Member Statuses Tracking (Per-assignee accept/reject) ──
    let memberStatuses = undefined;
    if (members.length > 0) {
      memberStatuses = members.map(mId => ({
        employeeId: mId,
        assignedStatus: assignedStatus || "Allocated",
        status: status || "Assigned",
        rejectionReason: "",
        startDate: startDate === "" ? null : (startDate || null),
        endDate: isCompleted ? resolvedEndDate : null,
        updatedAt: new Date()
      }));
    }

    // ── Phases Logic: Filter empty phases ──
    const phaseArr = parsePhases(phases);

    // ── File uploads ──
    const files = req.files?.length ? await uploadFiles(req.files, empId) : [];

    let parsedPages = [];
    if (Array.isArray(pages)) {
      parsedPages = pages;
    } else if (typeof pages === "string" && pages.trim()) {
      try {
        parsedPages = JSON.parse(pages);
      } catch (e) {
        parsedPages = [pages];
      }
    }

    // ── Construct Clean Task Object ──
    const taskData = {
      taskTitle,
      taskDetails,
      priority: priority || "Mid",
      startDate: (startDate && startDate !== "") ? startDate : undefined,
      dueDate: dueDate === "" ? null : dueDate,
      endDate: resolvedEndDate,
      status: status || "Assigned",
      assignedStatus: assignedStatus || "Allocated",
      category: category || "",
      project: project || "",
      workType: (workType && String(workType).trim()) ? String(workType).trim() : undefined,
      pages: (Array.isArray(parsedPages) && parsedPages.length > 0) ? parsedPages.map(p => String(p).trim()).filter(Boolean) : undefined,
      createdBy: userId,
      // Setting to undefined prevents empty arrays from being stored in MongoDB
      phases: phaseArr.length > 0 ? phaseArr : undefined,
      documents: files.length > 0 ? files : undefined,
      assignedMembers: members.length > 0 ? members : undefined,
      memberStatuses: memberStatuses,
    };

    const task = new Task(taskData);
    await task.save();

    // ── Sync each new phase → DailyWorkUpdate (Non-blocking) ──
    if (task.phases?.length > 0) {
      const resolvedUserId = members.length > 0 ? members[0] : userId;
      for (const phase of task.phases) {
        syncPhaseToDailyWorkUpdate({
          phaseId: phase._id,
          phaseTitle: phase.phaseTitle,
          phaseDescription: phase.phaseDescription,
          phaseStatus: phase.phaseStatus,
          updateDate: phase.updateDate,
          userId: resolvedUserId,
          category: task.category,
          project: task.project,
          workType: task.workType,
          pages: task.pages,
        });
      }
    }

    serverLog("INFO", CONTEXT, `Task created: ${task._id}`);

    // ── Push notifications (Non-blocking) ──
    // 1. Notify the Creator that the task was successfully created/assigned
    sendPushNotification(
      userId,
      "Task Created Successfully",
      `Your task "${taskTitle}" has been created and assigned.`,
      { taskId: task._id.toString(), type: "TASK_CREATED" }
    ).catch(err => serverLog("ERROR", CONTEXT, `Creator notification failed: ${err.message}`));

    // 2. Notify the Assignees that they received a new task
    if (members.length > 0) {
      const creatorName = req.user.name || "an Admin/Manager";
      sendPushNotification(
        members,
        "New Task Assigned",
        `You have been assigned a new task: ${taskTitle} by ${creatorName}.`,
        { taskId: task._id.toString(), type: "TASK" }
      ).catch(err => serverLog("ERROR", CONTEXT, `Notification failed: ${err.message}`));

      // ── Email notifications (Non-blocking) ──
      sendTaskAssignmentEmail(
        members,
        {
          title: taskTitle,
          description: taskDetails,
          priority: priority || "Mid",
          createdByName: req.user.name || "Manager",
          portalLink: "https://hr-portal.ertitech.com/"
        }
      ).catch(err => serverLog("ERROR", CONTEXT, `Email failed: ${err.message}`));
    }

    // ── Log Task Creation / Assignment ──
    const performerName = req.user?.name || "User";
    if (members.length > 0) {
      const assignedUsers = await User.find({ _id: { $in: members } }).select("name");
      const assignedNames = assignedUsers.map(u => u.name).filter(Boolean);
      const assigneeText = assignedNames.length > 0 ? assignedNames.join(", ") : "Employee";

      createLog({
        category: "task",
        referenceId: task._id,
        description: `${performerName} assigned task to ${assigneeText}`,
      });
    } else {
      createLog({
        category: "task",
        referenceId: task._id,
        description: `${performerName} created task for self`,
      });
    }

    const elapsed = Date.now() - startTime;
    logResponse(CONTEXT, 201, "Task created successfully", { elapsedMs: elapsed });

    res.status(201).json({ success: true, message: "Task created successfully", data: task });

  } catch (error) {
    logError(CONTEXT, error);
    logResponse(CONTEXT, 500, error.message);
    res.status(500).json({ message: error.message });
  }
};

/* ══════════════════════════════════════════════════════════
   UPDATE TASK
══════════════════════════════════════════════════════════ */
exports.updateTask = async (req, res) => {
  const CONTEXT = "UPDATE_TASK";
  const startTime = Date.now();

  logRequest(CONTEXT, req, { taskId: req.params.id });

  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      logResponse(CONTEXT, 400, "Invalid Task ID");
      return res.status(400).json({ message: "Invalid Task ID" });
    }

    const task = await Task.findById(id);
    if (!task) {
      logResponse(CONTEXT, 404, "Task not found");
      return res.status(404).json({ message: "Task not found" });
    }

    // Prevent modifying or editing completed tasks
    if ((task.status || "").toLowerCase().replace(/[\s\-_]/g, "") === "completed") {
      logResponse(CONTEXT, 400, "Completed tasks cannot be modified");
      return res.status(400).json({ message: "Completed tasks cannot be modified" });
    }

    // Prevent modifying or editing assigned tasks' assignment parameters after they have been accepted
    if (task.assignedStatus?.toLowerCase() === "accepted") {
      // Check if it is an assigned task (not a personal task)
      const isAssignedTask = task.assignedMembers && task.assignedMembers.length > 0 &&
        task.assignedMembers.some(m => m.toString() !== task.createdBy.toString());

      if (isAssignedTask) {
        const assignmentFields = ["taskTitle", "taskDetails", "priority", "dueDate", "category", "project", "assignedMembers"];
        const isModifyingAssignment = assignmentFields.some(field => {
          if (req.body[field] === undefined) return false;
          // Compare with database value
          const dbValue = task[field];
          let reqValue = req.body[field];

          if (field === "dueDate") {
            const dbDate = dbValue ? new Date(dbValue).toISOString().split("T")[0] : null;
            const reqDate = reqValue ? new Date(reqValue).toISOString().split("T")[0] : null;
            return dbDate !== reqDate;
          }
          if (field === "assignedMembers") {
            let reqMembers = [];
            try {
              reqMembers = typeof reqValue === 'string' ? JSON.parse(reqValue) : reqValue;
            } catch (e) {
              reqMembers = reqValue;
            }
            if (!Array.isArray(reqMembers)) return true;
            if (reqMembers.length !== task.assignedMembers.length) return true;
            return reqMembers.some(m => !task.assignedMembers.map(dbM => dbM.toString()).includes(m.toString()));
          }
          return String(dbValue) !== String(reqValue);
        });

        if (isModifyingAssignment) {
          logResponse(CONTEXT, 400, "Accepted task assignment details cannot be edited or modified");
          return res.status(400).json({ message: "Accepted task assignment details cannot be edited or modified" });
        }
      }
    }


    const oldAssignedStatus = task.assignedStatus;
    const oldMembers = (task.assignedMembers || []).map(m => m.toString());
    const oldTaskSnapshot = {
      taskTitle: task.taskTitle,
      taskDetails: task.taskDetails,
      priority: task.priority,
      dueDate: task.dueDate,
      category: task.category,
      project: task.project,
      assignedMembers: [...(task.assignedMembers || [])],
    };

    const updates = { ...req.body };

    // Clean up empty string values for Date fields to prevent Mongoose CastErrors
    ['startDate', 'dueDate', 'endDate'].forEach(field => {
      if (updates[field] === "") {
        updates[field] = null;
      }
    });

    if (updates.workType !== undefined) {
      updates.workType = (updates.workType || "").trim();
    }
    if (updates.pages !== undefined) {
      let parsedPages = [];
      if (Array.isArray(updates.pages)) {
        parsedPages = updates.pages;
      } else if (typeof updates.pages === "string" && updates.pages.trim()) {
        try {
          parsedPages = JSON.parse(updates.pages);
        } catch (e) {
          parsedPages = [updates.pages];
        }
      }
      updates.pages = parsedPages;
    }


    /* ── Members ── */
    const currentUserIdStr = req.user?.id ? req.user.id.toString() : "";
    const isAssigned = (task.assignedMembers || []).some(m => (m._id || m).toString() === currentUserIdStr);
    const isCreatorOrAdmin = (task.createdBy && task.createdBy.toString() === currentUserIdStr) || req.user?.role === "admin";

    if (updates.assignedMembers !== undefined && isCreatorOrAdmin) {
      let members = parseMembers(updates.assignedMembers);
      const creatorId = task.createdBy.toString();
      members = members.filter(id => id.toString() !== creatorId);
      updates.assignedMembers = members.length > 0 ? members : undefined;

      // Sync memberStatuses array when assigned members list changes
      const currentMemberStatuses = Array.isArray(task.memberStatuses) ? task.memberStatuses : [];
      if (members.length > 0) {
        updates.memberStatuses = members.map(mId => {
          const existing = currentMemberStatuses.find(
            ms => (ms.employeeId?._id || ms.employeeId || "").toString() === mId.toString()
          );
          return existing ? (existing.toObject ? existing.toObject() : { ...existing }) : {
            employeeId: mId,
            assignedStatus: "Allocated",
            status: "Assigned",
            rejectionReason: "",
            startDate: null,
            endDate: null,
            updatedAt: new Date()
          };
        });
      } else {
        updates.memberStatuses = undefined;
      }
    } else if (!isCreatorOrAdmin) {
      delete updates.assignedMembers;
      delete updates.memberStatuses;
    }

    /* ── Per-Member AssignedStatus, Status, Start/End Dates & Rejection Tracking ── */
    if ((updates.assignedStatus || updates.status || updates.startDate !== undefined || updates.endDate !== undefined) && isAssigned) {
      const incomingAssignedStatus = updates.assignedStatus;
      const incomingStatus = updates.status;
      const incomingRejectionReason = updates.rejectionReason || req.body.rejectionReason || "";

      // Ensure memberStatuses array exists
      const sourceStatuses = updates.memberStatuses || task.memberStatuses || [];
      let mStatuses = Array.isArray(sourceStatuses) && sourceStatuses.length > 0
        ? sourceStatuses.map(ms => (ms.toObject ? ms.toObject() : { ...ms }))
        : (task.assignedMembers || []).map(m => ({
            employeeId: m._id || m,
            assignedStatus: task.assignedStatus || "Allocated",
            status: task.status || "Assigned",
            rejectionReason: task.rejectionReason || "",
            startDate: task.startDate || null,
            endDate: task.endDate || null,
            updatedAt: new Date()
          }));

      const existingIndex = mStatuses.findIndex(
        ms => (ms.employeeId?._id || ms.employeeId || "").toString() === currentUserIdStr
      );

      const parsedStartDate = updates.startDate !== undefined ? (updates.startDate ? new Date(updates.startDate) : null) : undefined;
      const isMemberCompleted = (incomingStatus || "").toLowerCase() === "completed";
      const resolvedMemberEndDate = isMemberCompleted
        ? (mStatuses[existingIndex]?.endDate || new Date())
        : (incomingStatus ? null : (updates.endDate !== undefined ? (updates.endDate ? new Date(updates.endDate) : null) : undefined));

      if (existingIndex >= 0) {
        mStatuses[existingIndex] = {
          ...mStatuses[existingIndex],
          ...(incomingAssignedStatus && { assignedStatus: incomingAssignedStatus }),
          ...(incomingStatus && { status: incomingStatus }),
          ...(parsedStartDate !== undefined && { startDate: parsedStartDate }),
          ...(resolvedMemberEndDate !== undefined && { endDate: resolvedMemberEndDate }),
          rejectionReason: incomingRejectionReason || mStatuses[existingIndex].rejectionReason || "",
          updatedAt: new Date()
        };
      } else {
        mStatuses.push({
          employeeId: new mongoose.Types.ObjectId(currentUserIdStr),
          assignedStatus: incomingAssignedStatus || "Allocated",
          status: incomingStatus || "Assigned",
          startDate: parsedStartDate || null,
          endDate: resolvedMemberEndDate || null,
          rejectionReason: incomingRejectionReason,
          updatedAt: new Date()
        });
      }

      updates.memberStatuses = mStatuses;
      task.memberStatuses = mStatuses;
      task.markModified("memberStatuses");

      // Check overall assignedStatus across all members
      const acceptedCount = mStatuses.filter(ms => (ms.assignedStatus || "").toLowerCase() === "accepted").length;
      const rejectedCount = mStatuses.filter(ms => (ms.assignedStatus || "").toLowerCase() === "rejected").length;
      const totalMembers = mStatuses.length;

      if (acceptedCount > 0) {
        updates.assignedStatus = "Accepted";
        if (updates.status === "ignored") {
          updates.status = task.status !== "ignored" ? task.status : "pending";
        }
      } else if (rejectedCount === totalMembers) {
        updates.assignedStatus = "Rejected";
        updates.status = "ignored";
      } else {
        updates.assignedStatus = "Allocated";
        if (updates.status === "ignored") {
          updates.status = "Assigned";
        }
      }

      // Check overall status across all members
      const allCompleted = mStatuses.length > 0 && mStatuses.filter(ms => (ms.assignedStatus || "").toLowerCase() !== "rejected").every(ms => (ms.status || "").toLowerCase() === "completed");
      const anyInProgress = mStatuses.some(ms => (ms.status || "").toLowerCase() === "in progress" || (ms.status || "").toLowerCase() === "inprocess");
      // Fix: detect when all active (non-rejected) members are on hold so the root status syncs correctly
      const activeMembers = mStatuses.filter(ms => (ms.assignedStatus || "").toLowerCase() !== "rejected");
      const anyOnHold = activeMembers.some(ms => (ms.status || "").toLowerCase() === "hold" || (ms.status || "").toLowerCase() === "on hold" || (ms.status || "").toLowerCase() === "onhold");
      const allOnHold = activeMembers.length > 0 && activeMembers.every(ms => (ms.status || "").toLowerCase() === "hold" || (ms.status || "").toLowerCase() === "on hold" || (ms.status || "").toLowerCase() === "onhold");

      if (allCompleted) {
        updates.status = "Completed";
      } else if (anyInProgress) {
        // At least one member is actively working — In Progress takes priority over hold
        updates.status = "In Progress";
      } else if (anyOnHold) {
        // No member is in-progress; one or more members are on hold → sync root status
        updates.status = "On Hold";
      }

      // If not creator/admin, compute overall startDate & endDate from member statuses so individual dates don't overwrite each other
      if (!isCreatorOrAdmin) {
        const memberStartDates = mStatuses.map(ms => ms.startDate).filter(Boolean);
        if (memberStartDates.length > 0) {
          updates.startDate = new Date(Math.min(...memberStartDates.map(d => new Date(d).getTime())));
        }
        if (allCompleted) {
          const memberEndDates = mStatuses.map(ms => ms.endDate).filter(Boolean);
          if (memberEndDates.length > 0) {
            updates.endDate = new Date(Math.max(...memberEndDates.map(d => new Date(d).getTime())));
          } else {
            updates.endDate = new Date();
          }
        } else {
          updates.endDate = null;
        }
      }
    }

    // Direct root status update (creator, admin, or unassigned task)
    if (updates.status !== undefined) {
      const isRootCompleted = (updates.status || "").toLowerCase() === "completed";
      if (isRootCompleted) {
        updates.endDate = task.endDate || new Date();
      } else {
        updates.endDate = null;
      }
    }

    /* ── Phases (Per-Employee Isolation) ── */
    if (updates.phases !== undefined) {
      const incomingPhases = parsePhases(updates.phases).map(p => ({
        ...p,
        ...(p._id && mongoose.Types.ObjectId.isValid(p._id)
          ? { _id: new mongoose.Types.ObjectId(p._id.toString()) }
          : {}),
        employeeId: p.employeeId
          ? (mongoose.Types.ObjectId.isValid(p.employeeId) ? new mongoose.Types.ObjectId(p.employeeId.toString()) : p.employeeId)
          : (req.user?.id ? new mongoose.Types.ObjectId(req.user.id.toString()) : task.createdBy),
      }));

      // Merge: preserve existing phases belonging to other assigned members
      const existingPhases = Array.isArray(task.phases) ? task.phases : [];
      const incomingIds = new Set(incomingPhases.map(p => (p._id ? p._id.toString() : null)).filter(Boolean));
      const otherPhases = isCreatorOrAdmin
        ? []
        : existingPhases.filter(p => {
            const pId = p._id ? p._id.toString() : "";
            if (pId && incomingIds.has(pId)) return false;
            const pEmpId = (p.employeeId?._id || p.employeeId || "").toString();
            return pEmpId && pEmpId !== currentUserIdStr;
          });

      updates.phases = [...otherPhases, ...incomingPhases];

      // Sync matching DailyWorkUpdate records using syncPhaseToDailyWorkUpdate
      for (const ip of incomingPhases) {
        if (ip._id && mongoose.Types.ObjectId.isValid(ip._id)) {
          try {
            await syncPhaseToDailyWorkUpdate({
              phaseId: ip._id,
              phaseTitle: ip.phaseTitle,
              phaseDescription: ip.phaseDescription,
              phaseStatus: ip.phaseStatus,
              updateDate: ip.updateDate || new Date(),
              userId: ip.employeeId || task.createdBy,
              category: task.category,
              project: task.project,
              workType: task.workType,
              pages: task.pages,
            });
          } catch (syncErr) {
            console.error("Error syncing phase to daily work update in updateTask:", syncErr);
          }
        }
      }
    }

    /* ── Timestamp ── */
    updates.detailUpdatedAt = new Date();

    /* ── Apply updates ── */
    task.set(updates);

    if (updates.memberStatuses !== undefined) {
      task.markModified("memberStatuses");
    }
    if (updates.phases !== undefined) {
      task.markModified("phases");
    }

    /* ── Handle document deletion if requested ── */
    if (req.body.deletedDocuments) {
      let deletedIds = [];
      try {
        deletedIds = typeof req.body.deletedDocuments === 'string' ? JSON.parse(req.body.deletedDocuments) : req.body.deletedDocuments;
      } catch (e) { }
      if (Array.isArray(deletedIds) && deletedIds.length > 0) {
        const normalize = (k) => {
          if (!k) return "";
          if (typeof k === "object") k = k._id || k.id || k.key || k.fileKey || k.fileUrl || "";
          k = String(k);
          if (k.includes(".amazonaws.com/")) k = k.split(".amazonaws.com/")[1];
          return k.trim();
        };

        const targetKeys = deletedIds.map(normalize).filter(Boolean);

        const remainingDocs = [];
        for (const docKey of task.documents) {
          const normDoc = normalize(docKey);
          const isMarked = targetKeys.some(t => t === normDoc || normDoc.endsWith(t) || t.endsWith(normDoc));
          if (isMarked) {
            await deleteFromS3(docKey).catch(err => console.error("S3 delete failed:", err));
          } else {
            remainingDocs.push(docKey);
          }
        }
        task.documents = remainingDocs;
      }
    }

    /* ── New file uploads ── */
    if (req.files?.length) {
      const empId = req.user.empId || req.user.id;
      const newKeys = await uploadFiles(req.files, empId);
      task.documents.push(...newKeys);
    }

    await task.save();

    // ── Sync updated / new phases → DailyWorkUpdate ──
    // We sync ALL phases after save so MongoDB-generated _ids are available
    if (task.phases?.length > 0) {
      const resolvedUserId =
        task.assignedMembers?.length > 0
          ? task.assignedMembers[0]
          : task.createdBy;

      const incomingPhases = req.body.phases;

      for (const phase of task.phases) {
        // Only sync phases that were part of the incoming update
        if (incomingPhases !== undefined) {
          syncPhaseToDailyWorkUpdate({
            phaseId: phase._id,
            phaseTitle: phase.phaseTitle,
            phaseDescription: phase.phaseDescription,
            phaseStatus: phase.phaseStatus,
            updateDate: phase.updateDate || new Date(),
            userId: phase.employeeId || resolvedUserId,
            category: task.category,
            project: task.project,
            workType: task.workType,
            pages: task.pages,
          });
        }
      }
      await syncTaskWorkingDays(task._id);
    }

    serverLog("INFO", CONTEXT, "Task updated");

    // ── Audit & Activity Logging ──
    const currentUserName = req.user?.name || "User";
    const newAssignedStatus = updates.assignedStatus || task.assignedStatus;

    if (newAssignedStatus && newAssignedStatus !== oldAssignedStatus) {
      if (newAssignedStatus.toLowerCase() === "accepted") {
        const creatorUser = await User.findById(task.createdBy).select("name");
        const creatorText = creatorUser?.name ? ` assigned by ${creatorUser.name}` : "";

        createLog({
          category: "task",
          referenceId: task._id,
          description: `${currentUserName} accepted task${creatorText}`,
        });
      } else if (newAssignedStatus.toLowerCase() === "rejected") {
        const rejReason =
          req.body.rejectionReason ||
          updates.rejectionReason ||
          task.rejectionReason ||
          "";
        const creatorUser = await User.findById(task.createdBy).select("name");
        const creatorText = creatorUser?.name ? ` assigned by ${creatorUser.name}` : "";
        const reasonText = rejReason.trim() ? `. Reason: ${rejReason.trim()}` : "";

        createLog({
          category: "task",
          referenceId: task._id,
          description: `${currentUserName} rejected task${creatorText}${reasonText}`,
        });
      }
    } else {
      // Check for field edits and only log if fields changed
      const changes = await buildTaskDiffs(oldTaskSnapshot, updates, req.files, req.body.deletedDocuments);
      if (changes.length > 0) {
        createLog({
          category: "task",
          referenceId: task._id,
          description: `${currentUserName} updated task`,
          changes,
        });
      }
    }

    // Check if reassigned to different members
    if (updates.assignedMembers !== undefined) {
      const newMembers = (task.assignedMembers || []).map(m => m.toString());
      const hasMemberChanged =
        newMembers.length !== oldMembers.length ||
        newMembers.some(m => !oldMembers.includes(m));

      if (hasMemberChanged && newMembers.length > 0) {
        const assignedUsers = await User.find({ _id: { $in: task.assignedMembers } }).select("name");
        const assignedNames = assignedUsers.map(u => u.name).filter(Boolean);
        const assigneeText = assignedNames.length > 0
          ? (assignedNames.length === 1 ? assignedNames[0] : `${assignedNames.join(", ")} (${newMembers.length} members)`)
          : `${newMembers.length} member(s)`;

        createLog({
          category: "task",
          action: "REASSIGNED",
          performedBy: req.user.id,
          targetEmployee: task.assignedMembers,
          referenceId: task._id,
          referenceType: "Task",
          summary: `${currentUserName} reassigned task to ${assigneeText}`,
          details: {
            taskTitle: task.taskTitle,
          },
        });
      }
    }

    // ── Push notifications (Non-blocking) ──
    if (task.assignedMembers && task.assignedMembers.length > 0) {
      sendPushNotification(
        task.assignedMembers,
        "Task Updated",
        `Task "${task.taskTitle}" has been updated. Status: ${task.status}.`,
        { taskId: task._id.toString(), type: "TASK" }
      ).catch(err => serverLog("WARN", CONTEXT, `Push notification failed: ${err.message}`));
    }

    const elapsed = Date.now() - startTime;
    logResponse(CONTEXT, 200, "Task updated successfully", { elapsedMs: elapsed });

    res.json({ success: true, message: "Task updated successfully", data: task });

  } catch (error) {
    logError(CONTEXT, error, { taskId: req.params?.id, userId: req.user?.id });
    logResponse(CONTEXT, 500, error.message);
    res.status(500).json({ message: error.message });
  }
};

/* ══════════════════════════════════════════════════════════
   DATE FILTER HELPER
══════════════════════════════════════════════════════════ */
function buildDateFilter(query) {
  const filter = {};
  const now = new Date();
  let createdAtFilter = null;

  // ── CreatedAt Filters ──
  if (query.today === "true") {
    const s = new Date(now); s.setHours(0, 0, 0, 0);
    const e = new Date(now); e.setHours(23, 59, 59, 999);
    createdAtFilter = { $gte: s, $lte: e };
  } else if (query.yesterday === "true") {
    const y = new Date(now); y.setDate(now.getDate() - 1);
    const s = new Date(y); s.setHours(0, 0, 0, 0);
    const e = new Date(y); e.setHours(23, 59, 59, 999);
    createdAtFilter = { $gte: s, $lte: e };
  } else if (query.thisWeek === "true") {
    const s = new Date(now);
    const day = s.getDay();
    s.setDate(s.getDate() - day + (day === 0 ? -6 : 1)); s.setHours(0, 0, 0, 0);
    const e = new Date(now); e.setHours(23, 59, 59, 999);
    createdAtFilter = { $gte: s, $lte: e };
  } else if (query.thisMonth === "true") {
    const s = new Date(now.getFullYear(), now.getMonth(), 1); s.setHours(0, 0, 0, 0);
    const e = new Date(now); e.setHours(23, 59, 59, 999);
    createdAtFilter = { $gte: s, $lte: e };
  } else if (query.fromDate && query.toDate) {
    const s = new Date(query.fromDate); s.setHours(0, 0, 0, 0);
    const e = new Date(query.toDate); e.setHours(23, 59, 59, 999);
    createdAtFilter = { $gte: s, $lte: e };
  } else if (query.year && query.year !== "undefined") {
    createdAtFilter = {
      $gte: new Date(`${query.year}-01-01`),
      $lte: new Date(`${query.year}-12-31T23:59:59.999Z`),
    };
  }

  if (createdAtFilter) filter.createdDate = createdAtFilter;

  // ── Project Schedule Filters (Optional) ──
  if (query.startDate && query.endDate && query.startDate !== "undefined") {
    const s = new Date(query.startDate); s.setHours(0, 0, 0, 0);
    const e = new Date(query.endDate); e.setHours(23, 59, 59, 999);
    filter.startDate = { $gte: s };
    filter.dueDate = { $lte: e };
  }

  return filter;
}

/* ── Shared avatar hydration & per-member status resolution ── */
async function hydrateTasks(tasks, currentUserId = null) {
  const currentUserIdStr = currentUserId ? currentUserId.toString() : null;

  const [holidaysSet, employeeLeavesSet, employeeCalendar] = await Promise.all([
    fetchCompanyHolidaysSet(),
    currentUserIdStr ? fetchEmployeeApprovedLeavesSet(currentUserIdStr) : Promise.resolve(new Set()),
    currentUserIdStr ? getEmployeeWorkingCalendar(currentUserIdStr) : Promise.resolve(null),
  ]);

  return Promise.all(tasks.map(async (task) => {
    const obj = task.toObject ? task.toObject() : { ...task };

    // Fallback: If no one is assigned, the creator is the assigned member
    // Guard: createdBy can be null if the user was deleted
    if (!obj.assignedMembers || obj.assignedMembers.length === 0) {
      if (obj.createdBy) {
        obj.assignedMembers = [obj.createdBy];
      } else {
        obj.assignedMembers = [];
      }
    }

    // Resolve per-member assignedStatus, status, startDate, and endDate for the requesting user
    if (currentUserIdStr && Array.isArray(obj.memberStatuses) && obj.memberStatuses.length > 0) {
      const myMemberStatus = obj.memberStatuses.find(
        ms => (ms.employeeId?._id || ms.employeeId || "").toString() === currentUserIdStr
      );
      if (myMemberStatus) {
        if (myMemberStatus.assignedStatus) {
          obj.assignedStatus = myMemberStatus.assignedStatus;
        }
        if (myMemberStatus.status) {
          obj.status = myMemberStatus.status;
        }
        if (myMemberStatus.rejectionReason) {
          obj.rejectionReason = myMemberStatus.rejectionReason;
        }
        if (myMemberStatus.startDate !== undefined) {
          obj.startDate = myMemberStatus.startDate;
        }
        if (myMemberStatus.endDate !== undefined) {
          obj.endDate = myMemberStatus.endDate;
        }
      }
    }

    // Guard: createdBy can be null if the user was deleted
    if (obj.createdBy?.photo) {
      try {
        obj.createdBy.avatar = await getCachedSignedUrl(obj.createdBy.photo);
      } catch (_) { /* ignore signed-url errors */ }
    }

    // Guard: skip null entries in assignedMembers (deleted users populate as null)
    if (obj.assignedMembers?.length) {
      for (const m of obj.assignedMembers) {
        if (m && m.photo) {
          try {
            m.avatar = await getCachedSignedUrl(m.photo);
          } catch (_) { /* ignore signed-url errors */ }
        }
      }
      // Remove any null/undefined entries from the array
      obj.assignedMembers = obj.assignedMembers.filter(Boolean);
    }

    // Attach eligible working days & deadline performance score
    if (obj.dueDate) {
      const sDate = obj.startDate || obj.createdDate || obj.createdAt;
      const { eligibleDays, excludedDays } = calculateEligibleWorkingDays(sDate, obj.dueDate, holidaysSet, employeeLeavesSet);
      const dlScore = calculateDeadlineScore(obj.dueDate, obj.endDate, obj.status, holidaysSet, employeeLeavesSet);
      obj.eligibleWorkingDays = eligibleDays;
      obj.excludedNonWorkingDays = excludedDays;
      obj.eligibleDaysLate = dlScore.eligibleDaysLate;
      obj.deadlineScore = dlScore.deadlineScore;

      // Attach eligible working hours banner state (10am-7pm, skipping holidays, weekoffs, leaves, absences)
      if (employeeCalendar) {
        obj.bannerState = evaluateTaskBannerState(obj, employeeCalendar);
      }
    }

    return obj;
  }));
}

/* ══════════════════════════════════════════════════════════
   DASHBOARD TASKS  (Employee)
══════════════════════════════════════════════════════════ */
exports.getDashboardTasks = async (req, res) => {
  const CONTEXT = "DASHBOARD_TASKS";
  const startTime = Date.now();

  logRequest(CONTEXT, req);

  try {
    if (!req.user?.id) {
      serverLog("WARN", CONTEXT, "Unauthorized — no user ID in token");
      logResponse(CONTEXT, 401, "Unauthorized");
      return res.status(401).json({ message: "Unauthorized" });
    }

    const userId = new mongoose.Types.ObjectId(req.user.id);
    const {
      taskView,
      status,
      assignedStatus,
      employeeId,
      category,
      project,
      priority,
      search,
      sortBy,
      page = 1,
      limit = 10
    } = req.query;

    const and = [];

    // ── 1. Task View Logic (Core Access Control) ──
    if (taskView === "myTask") {
      // My Task: Created by me AND (explicitly assigned to me OR no one else assigned)
      and.push({
        createdBy: userId,
        $or: [
          { assignedMembers: userId },
          { assignedMembers: { $exists: false } },
          { assignedMembers: { $size: 0 } }
        ]
      });
    } else if (taskView === "assignedToMe") {
      // Assigned to Me: Created by others AND my ID is in the list
      and.push({ createdBy: { $ne: userId }, assignedMembers: userId });
    } else if (taskView === "assignedByMe") {
      // Assigned by Me: Created by me AND someone else is assigned
      and.push({
        createdBy: userId,
        assignedMembers: { $exists: true, $not: { $size: 0 } }
      });
    } else {
      // Default / All: Anything related to me
      and.push({ $or: [{ createdBy: userId }, { assignedMembers: userId }] });
    }

    // ── 2. Primary Status Filters ──
    if (status) {
      const v = Array.isArray(status) ? status : [status];
      const patterns = v.map(st => {
        const clean = String(st || "").trim().toLowerCase();
        if (clean === "inprocess" || clean === "in progress" || clean === "in-progress" || clean === "inprogress") {
          return "^(inprocess|in progress|in-progress|inprogress)$";
        }
        if (clean === "completed" || clean === "complete") {
          return "^(completed|complete)$";
        }
        if (clean === "assigned" || clean === "allocated") {
          return "^(assigned|allocated)$";
        }
        if (clean === "hold" || clean === "on hold" || clean === "on-hold" || clean === "onhold") {
          return "^(hold|on hold|on-hold|onhold)$";
        }
        if (clean === "ignored" || clean === "rejected" || clean === "reject") {
          return "^(ignored|rejected|reject)$";
        }
        return `^${clean}$`;
      });

      const regexList = patterns.map(p => new RegExp(p, "i"));

      and.push({
        $or: [
          { status: { $in: regexList } },
          { memberStatuses: { $elemMatch: { employeeId: userId, status: { $in: regexList } } } }
        ]
      });
    }
    if (assignedStatus) {
      const v = Array.isArray(assignedStatus) ? assignedStatus : [assignedStatus];
      const regexList = v.map(st => new RegExp(`^${st}$`, "i"));
      and.push({
        $or: [
          { memberStatuses: { $elemMatch: { employeeId: userId, assignedStatus: { $in: regexList } } } },
          { assignedStatus: { $in: regexList } }
        ]
      });
    }

    // ── 3. Specific Entity Filters ──
    if (employeeId && mongoose.Types.ObjectId.isValid(employeeId)) {
      and.push({ assignedMembers: new mongoose.Types.ObjectId(employeeId) });
    }
    // ── Category/Project filter (direct on Task) ──
    if (category) {
      and.push({ category: { $regex: new RegExp(`^${category}$`, "i") } });
    }
    if (project) {
      and.push({ project: { $regex: new RegExp(`^${project}$`, "i") } });
    }
    if (priority) {
      and.push({ priority: { $regex: new RegExp(`^${priority}$`, "i") } });
    }

    // ── 4. Search Filter ──
    if (search && search.trim() !== "") {
      and.push({
        $or: [
          { taskTitle: { $regex: search, $options: "i" } },
          { taskDetails: { $regex: search, $options: "i" } }
        ]
      });
    }

    // ── 5. Date Filters ──
    const df = buildDateFilter(req.query);
    if (Object.keys(df).length) {
      and.push(df);
    }

    const filter = and.length > 1 ? { $and: and } : and[0];

    // ── 5.5 Determine Sorting ──
    let sortOption = { createdDate: -1 };
    if (sortBy === "dueDate") {
      sortOption = { dueDate: 1 };
    } else if (sortBy === "createdDate") {
      sortOption = { createdDate: -1 };
    }

    // ── 6. Execute Query with Pagination ──
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [tasks, totalCount] = await Promise.all([
      Task.find(filter)
        .populate("createdBy", "name photo")
        .populate("assignedMembers", "name photo")
        .sort(sortOption)
        .skip(skip)
        .limit(parseInt(limit)),
      Task.countDocuments(filter)
    ]);

    serverLog("INFO", CONTEXT, `Fetched ${tasks.length}/${totalCount} tasks`, {
      page,
      limit,
      totalCount
    });

    const hydratedTasks = await hydrateTasks(tasks, req.user?.id);
    const elapsed = Date.now() - startTime;
    logResponse(CONTEXT, 200, "Tasks fetched successfully", { count: tasks.length, total: totalCount, elapsedMs: elapsed });

    res.json({
      success: true,
      count: tasks.length,
      total: totalCount,
      page: parseInt(page),
      totalPages: Math.ceil(totalCount / limit),
      data: hydratedTasks
    });

  } catch (error) {
    logError(CONTEXT, error, { userId: req.user?.id });
    logResponse(CONTEXT, 500, "Failed to fetch tasks");
    res.status(500).json({ message: "Failed to fetch tasks", error: error.message });
  }
};

/* ══════════════════════════════════════════════════════════
   ADMIN DASHBOARD TASKS
══════════════════════════════════════════════════════════ */
exports.getAllDashboardTasks = async (req, res) => {
  const CONTEXT = "ADMIN_DASHBOARD_TASKS";
  const startTime = Date.now();

  logRequest(CONTEXT, req);

  try {
    const { employeeId, search, status, assignedStatus, category, project } = req.query;
    const and = [];

    if (status) {
      const v = Array.isArray(status) ? status : [status];
      const patterns = v.map(st => {
        const clean = String(st || "").trim().toLowerCase();
        if (clean === "inprocess" || clean === "in progress" || clean === "in-progress" || clean === "inprogress") {
          return "^(inprocess|in progress|in-progress|inprogress)$";
        }
        if (clean === "completed" || clean === "complete") {
          return "^(completed|complete)$";
        }
        if (clean === "assigned" || clean === "allocated") {
          return "^(assigned|allocated)$";
        }
        if (clean === "hold" || clean === "on hold" || clean === "on-hold" || clean === "onhold") {
          return "^(hold|on hold|on-hold|onhold)$";
        }
        if (clean === "ignored" || clean === "rejected" || clean === "reject") {
          return "^(ignored|rejected|reject)$";
        }
        return `^${clean}$`;
      });

      const regexList = patterns.map(p => new RegExp(p, "i"));
      and.push({
        $or: [
          { status: { $in: regexList } },
          { "memberStatuses.status": { $in: regexList } }
        ]
      });
    }
    if (assignedStatus) {
      const v = Array.isArray(assignedStatus) ? assignedStatus : [assignedStatus];
      const regexList = v.map(st => new RegExp(`^${st}$`, "i"));
      and.push({
        $or: [
          { "memberStatuses.assignedStatus": { $in: regexList } },
          { assignedStatus: { $in: regexList } }
        ]
      });
    }
    if (employeeId && mongoose.Types.ObjectId.isValid(employeeId)) {
      const eId = new mongoose.Types.ObjectId(employeeId);
      and.push({
        $or: [
          { assignedMembers: eId },
          { $and: [{ createdBy: eId }, { $or: [{ assignedMembers: { $exists: false } }, { assignedMembers: { $size: 0 } }] }] }
        ]
      });
    }
    // ── Category/Project filter (direct on Task) ──
    if (category) {
      and.push({ category: { $regex: new RegExp(`^${category}$`, "i") } });
    }
    if (project) {
      and.push({ project: { $regex: new RegExp(`^${project}$`, "i") } });
    }

    if (search && search.trim() !== "") {
      and.push({
        $or: [
          { taskTitle: { $regex: search, $options: "i" } },
          { taskDetails: { $regex: search, $options: "i" } }
        ]
      });
    }

    const df = buildDateFilter(req.query);
    if (Object.keys(df).length) {
      and.push(df);
    }

    const filter = and.length ? { $and: and } : {};


    const tasks = await Task.find(filter)
      .populate("createdBy", "name photo")
      .populate("assignedMembers", "name photo")
      .sort({ createdDate: -1 });

    serverLog("INFO", CONTEXT, `Admin fetched ${tasks.length} task(s)`, {
      tasksReturned: tasks.length,
    });

    const hydratedTasks = await hydrateTasks(tasks, req.user?.id);
    const elapsed = Date.now() - startTime;
    logResponse(CONTEXT, 200, "Admin tasks fetched", { count: tasks.length, elapsedMs: elapsed });

    res.json({ success: true, count: tasks.length, data: hydratedTasks });

  } catch (error) {
    logError(CONTEXT, error, { adminId: req.user?.id });
    logResponse(CONTEXT, 500, "Failed to fetch tasks");
    res.status(500).json({ message: "Failed to fetch tasks", error: error.message });
  }
};

/* ══════════════════════════════════════════════════════════
   GET TASK BY ID
══════════════════════════════════════════════════════════ */
exports.getTaskById = async (req, res) => {
  const CONTEXT = "GET_TASK_BY_ID";
  const startTime = Date.now();

  logRequest(CONTEXT, req);

  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      logResponse(CONTEXT, 400, "Invalid task id");
      return res.status(400).json({ message: "Invalid task id" });
    }

    const task = await Task.findById(id)
      .populate("createdBy", "name photo designation department")
      .populate("assignedMembers", "name photo designation department")
      .populate("memberStatuses.employeeId", "name photo designation department")
      .populate("phases.employeeId", "name photo designation department");

    if (!task) {
      logResponse(CONTEXT, 404, "Task not found");
      return res.status(404).json({ message: "Task not found" });
    }

    const taskData = task.toObject();

    // Resolve individual member assignedStatus, status, startDate & endDate for current logged-in employee
    const currentUserIdStr = req.user?.id ? req.user.id.toString() : null;
    if (currentUserIdStr && Array.isArray(taskData.memberStatuses) && taskData.memberStatuses.length > 0) {
      const myMemberStatus = taskData.memberStatuses.find(
        ms => (ms.employeeId?._id || ms.employeeId || "").toString() === currentUserIdStr
      );
      if (myMemberStatus) {
        if (myMemberStatus.assignedStatus) {
          taskData.assignedStatus = myMemberStatus.assignedStatus;
        }
        if (myMemberStatus.status) {
          taskData.status = myMemberStatus.status;
        }
        if (myMemberStatus.rejectionReason) {
          taskData.rejectionReason = myMemberStatus.rejectionReason;
        }
        if (myMemberStatus.startDate !== undefined) {
          taskData.startDate = myMemberStatus.startDate;
        }
        if (myMemberStatus.endDate !== undefined) {
          taskData.endDate = myMemberStatus.endDate;
        }
      }
    }

    // Fallback: If no one is assigned, the creator is the assigned member
    if (!taskData.assignedMembers || taskData.assignedMembers.length === 0) {
      taskData.assignedMembers = [taskData.createdBy];
    }

    // Avatars
    if (taskData.createdBy?.photo)
      taskData.createdBy.avatar = await getCachedSignedUrl(taskData.createdBy.photo);
    if (taskData.assignedMembers?.length)
      for (const m of taskData.assignedMembers)
        if (m.photo) m.avatar = await getCachedSignedUrl(m.photo);

    // Document signed URLs
    taskData.documents = await Promise.all(
      (task.documents || []).map(async (key) => ({
        _id: key,
        fileName: key.split("/").pop(),
        fileUrl: await getCachedSignedUrl(key),
      }))
    );

    if (!Array.isArray(taskData.phases)) taskData.phases = [];

    // Sync all phases from DailyWorkUpdates if historical/separate updates exist across dates
    if (task.phases?.length > 0) {
      const phaseIds = task.phases.map(p => p._id).filter(Boolean);
      const linkedUpdates = await DailyWorkUpdate.find({
        $or: [
          { phaseId: { $in: phaseIds } },
          { referenceId: { $in: phaseIds } }
        ]
      }).sort({ updateDate: 1, createdAt: 1 });

      if (linkedUpdates.length > task.phases.length) {
        const newPhases = [];
        for (let i = 0; i < linkedUpdates.length; i++) {
          const u = linkedUpdates[i];
          let pId = u.phaseId;
          if (newPhases.some(p => p._id && pId && p._id.toString() === pId.toString())) {
            pId = u._id;
            await DailyWorkUpdate.updateOne({ _id: u._id }, { $set: { phaseId: u._id } });
          }
          newPhases.push({
            _id: pId || u._id,
            phaseTitle: u.title || `Phase ${i + 1}`,
            phaseDescription: u.description || "",
            phaseStatus: u.status || "inprocess",
            updateDate: u.updateDate || u.createdAt,
            employeeId: u.userId,
            workingDays: 1
          });
        }
        task.phases = newPhases;
        task.markModified("phases");
        await task.save();
        taskData.phases = task.phases.map(p => (typeof p.toObject === "function" ? p.toObject() : p));
      }
    }

    // Ensure phase working days are fresh and stored in database
    if (task.phases?.length > 0) {
      const syncResult = await syncTaskWorkingDays(task);
      if (syncResult?.task?.phases) {
        taskData.phases.forEach((p) => {
          const syncedP = syncResult.task.phases.find(sp => sp._id?.toString() === p._id?.toString());
          if (syncedP) {
            p.workingDays = syncedP.workingDays || 0;
          }
        });
      }
    }

    // Attach eligible working days & deadline performance score
    if (taskData.dueDate) {
      const holidaysSet = await fetchCompanyHolidaysSet();
      const employeeLeavesSet = currentUserIdStr
        ? await fetchEmployeeApprovedLeavesSet(currentUserIdStr)
        : new Set();
      const sDate = taskData.startDate || taskData.createdDate || taskData.createdAt;
      const { eligibleDays, excludedDays } = calculateEligibleWorkingDays(sDate, taskData.dueDate, holidaysSet, employeeLeavesSet);
      const dlScore = calculateDeadlineScore(taskData.dueDate, taskData.endDate, taskData.status, holidaysSet, employeeLeavesSet);
      taskData.eligibleWorkingDays = eligibleDays;
      taskData.excludedNonWorkingDays = excludedDays;
      taskData.eligibleDaysLate = dlScore.eligibleDaysLate;
      taskData.deadlineScore = dlScore.deadlineScore;

      if (currentUserIdStr) {
        const cal = await getEmployeeWorkingCalendar(currentUserIdStr);
        taskData.bannerState = evaluateTaskBannerState(taskData, cal);
      }
    }

    const elapsed = Date.now() - startTime;
    logResponse(CONTEXT, 200, "Task fetched successfully", { elapsedMs: elapsed });

    res.json({ success: true, data: taskData });

  } catch (error) {
    logError(CONTEXT, error);
    logResponse(CONTEXT, 500, error.message);
    res.status(500).json({ message: error.message });
  }
};

/* ══════════════════════════════════════════════════════════
   DELETE TASK DOCUMENT
══════════════════════════════════════════════════════════ */
exports.deleteTaskDocument = async (req, res) => {
  const CONTEXT = "DELETE_TASK_DOCUMENT";

  logRequest(CONTEXT, req);

  try {
    const { taskId, docId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(taskId)) {
      logResponse(CONTEXT, 400, "Invalid Task ID");
      return res.status(400).json({ message: "Invalid Task ID" });
    }

    const task = await Task.findById(taskId);
    if (!task) {
      logResponse(CONTEXT, 404, "Task not found");
      return res.status(404).json({ message: "Task not found" });
    }

    const isCreator = task.createdBy.toString() === req.user.id;
    const isAssigned = task.assignedMembers.some(m => m.toString() === req.user.id);

    if (!isCreator && !isAssigned) {
      logResponse(CONTEXT, 403, "Not authorized to delete documents from this task");
      return res.status(403).json({ message: "Not authorized" });
    }

    const key = decodeURIComponent(docId);
    const docIndex = task.documents.findIndex(d => d === key);

    if (docIndex === -1) {
      logResponse(CONTEXT, 404, "Document not found");
      return res.status(404).json({ message: "Document not found" });
    }

    await deleteFromS3(task.documents[docIndex]);
    task.documents.splice(docIndex, 1);
    await task.save();

    logResponse(CONTEXT, 200, "Document deleted");

    res.json({ success: true, message: "Document deleted", data: task.documents });

  } catch (error) {
    logError(CONTEXT, error);
    logResponse(CONTEXT, 500, error.message);
    res.status(500).json({ message: error.message });
  }
};

/* ══════════════════════════════════════════════════════════
   DELETE TASK
══════════════════════════════════════════════════════════ */
exports.deleteTask = async (req, res) => {
  const CONTEXT = "DELETE_TASK";

  logRequest(CONTEXT, req);

  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      logResponse(CONTEXT, 400, "Invalid Task ID");
      return res.status(400).json({ message: "Invalid Task ID" });
    }

    const task = await Task.findById(id);
    if (!task) {
      logResponse(CONTEXT, 404, "Task not found");
      return res.status(404).json({ message: "Task not found" });
    }

    // Only the person who assigned the task can delete it
    const currentUserId = (req.user?.id || req.user?._id || "").toString();
    const isCreator = task.createdBy && task.createdBy.toString() === currentUserId;
    if (!isCreator) {
      logResponse(CONTEXT, 403, "Only the person who assigned the task can delete it");
      return res.status(403).json({ message: "Only the person who assigned the task can delete it" });
    }

    // Task can only be deleted before assignee accepts it, and before moving to In Progress, Completed, etc.
    const hasAnyAcceptedMember = (task.assignedStatus || "").toLowerCase() === "accepted" ||
      (Array.isArray(task.memberStatuses) && task.memberStatuses.some(m => (m.assignedStatus || "").toLowerCase() === "accepted"));

    const statusNormalized = (task.status || "").toLowerCase().replace(/[\s\-_]/g, "");
    const isMoved = statusNormalized && !["assigned", "pending", "allocated"].includes(statusNormalized);

    if (hasAnyAcceptedMember || isMoved) {
      logResponse(CONTEXT, 400, "Task cannot be deleted after it has been accepted or in progress");
      return res.status(400).json({ message: "Task cannot be deleted after it has been accepted or moved to subsequent status" });
    }

    // Delete synced daily work updates for this task's phases
    if (task.phases?.length > 0) {
      const phaseIds = task.phases.map(p => p._id);
      await DailyWorkUpdate.deleteMany({
        $or: [
          { phaseId: { $in: phaseIds } },
          { referenceId: { $in: phaseIds } }
        ]
      });
    }

    await Task.findByIdAndDelete(id);

    logResponse(CONTEXT, 200, "Task deleted successfully");

    res.json({ success: true, message: "Task deleted successfully" });

  } catch (error) {
    logError(CONTEXT, error);
    logResponse(CONTEXT, 500, error.message);
    res.status(500).json({ message: error.message });
  }
};

/* ══════════════════════════════════════════════════════════
   GET EMPLOYEE PROJECT DETAILS
   Aggregates tasks by project name for the current employee.
══════════════════════════════════════════════════════════ */
exports.getEmployeeProjectDetails = async (req, res) => {
  const CONTEXT = "GET_EMPLOYEE_PROJECTS";
  logRequest(CONTEXT, req);

  try {
    let userIdVal = req.query.employeeId || req.user?.id;
    if (!userIdVal || !mongoose.Types.ObjectId.isValid(userIdVal)) {
      if (req.user?.id && mongoose.Types.ObjectId.isValid(req.user.id)) {
        userIdVal = req.user.id;
      } else {
        return res.status(400).json({ success: false, message: "A valid User ID is required" });
      }
    }
    const userId = new mongoose.Types.ObjectId(userIdVal);

    // 1. Find all regular tasks where this employee is assigned OR which they created
    const rawTasks = await Task.find({
      $or: [
        { assignedMembers: userId },
        { createdBy: userId }
      ]
    });

    const tasks = rawTasks.filter((task) => {
      const isAssignedToMe = task.assignedMembers?.some((member) => {
        const memberId = typeof member === "object" && member._id ? member._id : member;
        return memberId?.toString() === userId.toString();
      });

      const createdById = task.createdBy?._id || task.createdBy;
      const isCreatedByMe = createdById?.toString() === userId.toString();

      const isOthersAssigned = task.assignedMembers?.some((member) => {
        const memberId = typeof member === "object" && member._id ? member._id : member;
        return memberId?.toString() !== userId.toString();
      });

      return isAssignedToMe || (isCreatedByMe && !isOthersAssigned);
    });

    // 2. Find all standalone work updates created by this employee
    const standaloneTasks = await DailyWorkUpdate.find({
      userId: userId,
      $or: [
        { task: { $exists: false } },
        { task: null }
      ]
    });

    // 3. Get employee designation for the "Role" column
    const empDetails = await EmployeeDetails.findOne({ empId: userId });
    const designation = empDetails?.designation || "Member";

    // 4. Aggregate by project name
    const projectsMap = {};

    // Helper to process task lists
    const processList = (list) => {
      list.forEach((task) => {
        const pName = task.project || "Unassigned";
        const catName = task.category || "Uncategorized";
        const key = `${catName}_${pName}`;

        // Map backend status to UI status
        let taskStatus = task.status || task.phaseStatus || "In Process";
        const normalized = taskStatus.toLowerCase().trim();
        if (["inprocess", "in progress", "in-process", "in process"].includes(normalized)) {
          taskStatus = "In Process";
        } else if (["pending"].includes(normalized)) {
          taskStatus = "Pending";
        } else if (["completed"].includes(normalized)) {
          taskStatus = "Completed";
        } else if (["onhold", "on hold", "on-hold"].includes(normalized)) {
          taskStatus = "On Hold";
        } else {
          taskStatus = taskStatus.charAt(0).toUpperCase() + taskStatus.slice(1);
        }

        const currentTaskDate = task.updateDate || task.createdAt || task.startDate || new Date(0);

        if (!projectsMap[key]) {
          projectsMap[key] = {
            category: catName,
            projectName: pName,
            role: designation,
            startDate: task.startDate || task.updateDate || task.createdAt,
            dueDate: task.dueDate || task.updateDate || task.createdAt,
            status: taskStatus,
            latestUpdateDate: currentTaskDate,
          };
        } else {
          const tStart = task.startDate || task.updateDate || task.createdAt;
          const tDue = task.dueDate || task.updateDate || task.createdAt;

          if (tStart && (!projectsMap[key].startDate || new Date(tStart) < new Date(projectsMap[key].startDate))) {
            projectsMap[key].startDate = tStart;
          }
          if (tDue && (!projectsMap[key].dueDate || new Date(tDue) > new Date(projectsMap[key].dueDate))) {
            projectsMap[key].dueDate = tDue;
          }

          // Aggregate status using the status of the most recently updated task/update
          if (new Date(currentTaskDate) > new Date(projectsMap[key].latestUpdateDate)) {
            projectsMap[key].latestUpdateDate = currentTaskDate;
            projectsMap[key].status = taskStatus;
          }
        }
      });
    };

    processList(tasks);
    processList(standaloneTasks);

    const projectList = Object.values(projectsMap);

    res.json({ success: true, data: projectList });
  } catch (error) {
    logError(CONTEXT, error);
    res.status(500).json({ message: "Failed to fetch project details", error: error.message });
  }
};

/* ══════════════════════════════════════════════════════════
   GET PROJECT PHASES
   Fetches all unique phases for a specific project and category.
══════════════════════════════════════════════════════════ */
exports.getProjectPhases = async (req, res) => {
  const { projectName, category, employeeId } = req.query;

  let userIdVal = employeeId || req.user?.id;
  if (!userIdVal || !mongoose.Types.ObjectId.isValid(userIdVal)) {
    if (req.user?.id && mongoose.Types.ObjectId.isValid(req.user.id)) {
      userIdVal = req.user.id;
    } else {
      return res.status(400).json({ success: false, message: "A valid User ID is required" });
    }
  }
  const userId = new mongoose.Types.ObjectId(userIdVal);

  try {
    // 1. Regular Tasks where user is assigned or created
    const rawTasks = await Task.find({
      $or: [
        { assignedMembers: userId },
        { createdBy: userId }
      ],
      project: projectName,
      category: category
    });

    const tasks = rawTasks.filter((task) => {
      const isAssignedToMe = task.assignedMembers?.some((member) => {
        const memberId = typeof member === "object" && member._id ? member._id : member;
        return memberId?.toString() === userId.toString();
      });

      const createdById = task.createdBy?._id || task.createdBy;
      const isCreatedByMe = createdById?.toString() === userId.toString();

      const isOthersAssigned = task.assignedMembers?.some((member) => {
        const memberId = typeof member === "object" && member._id ? member._id : member;
        return memberId?.toString() !== userId.toString();
      });

      return isAssignedToMe || (isCreatedByMe && !isOthersAssigned);
    });

    // Fetch all updates (both phase-linked and standalone) under this project and category
    const allUpdates = await DailyWorkUpdate.find({
      userId: userId,
      project: projectName,
      category: category
    }).sort({ updateDate: -1 });

    const allWorkData = allUpdates.map(u => {
      const parentTask = tasks.find(t =>
        (u.phaseId && t.phases?.some(p => p._id.toString() === u.phaseId.toString())) ||
        (u.referenceId && t.phases?.some(p => p._id.toString() === u.referenceId.toString())) ||
        (t.taskTitle === u.title)
      );

      return {
        _id: u._id,
        referenceId: u.referenceId || null,
        task_id: parentTask?._id || "standalone",
        taskTitle: parentTask?.taskTitle || u.title || "Standalone Work Update",
        name: u.title || "N/A",
        status: u.status || "In Process",
        note: u.description || "",
        description: u.description || "",
        date: u.updateDate || u.createdAt,
        pages: u.pages || [],
        source: parentTask ? "Task" : "Standalone"
      };
    });

    let holidaysList = [];
    try {
      const Holiday = require("../Models/Holiday.model");
      const hols = await Holiday.find({}).lean();
      holidaysList = hols
        .map((h) => {
          if (!h.date) return null;
          const d = new Date(h.date);
          return !isNaN(d.getTime()) ? d.toISOString().split("T")[0] : null;
        })
        .filter(Boolean);
    } catch (hErr) {
      console.error("Error fetching holidays in getProjectPhases:", hErr);
    }

    let empLeaves = [];
    try {
      const Attendance = require("../Models/Attendance.model");
      const atts = await Attendance.find({
        employeeId: userId,
        status: { $in: ["Absent", "Leave", "On Leave"] },
      }).lean();
      empLeaves = atts.map((a) => a.date).filter(Boolean);
    } catch (aErr) {
      console.error("Error fetching attendance in getProjectPhases:", aErr);
    }

    res.json({ success: true, data: allWorkData, holidays: holidaysList, leaves: empLeaves });
  } catch (error) {
    console.error("GET PROJECT PHASES ERROR:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};


/* ──────────────────────────────────────────────────────────
   PUT  /tasks/:taskId/phases/:phaseId
   Updates a task's specific phase inside phases array
   AND also syncs the status/title/description of any
   DailyWorkUpdate entries linked to this phase.
────────────────────────────────────────────────────────── */
exports.updateTaskPhase = async (req, res) => {
  try {
    const { taskId, phaseId } = req.params;
    const { phaseTitle, phaseStatus, phaseDescription } = req.body;

    const task = await Task.findById(taskId);
    if (!task) {
      return res.status(404).json({ success: false, message: "Task not found" });
    }

    if ((task.status || "").toLowerCase().replace(/[\s\-_]/g, "") === "completed") {
      return res.status(400).json({ success: false, message: "Completed task phases cannot be modified" });
    }

    if (!task.phases || !Array.isArray(task.phases)) {
      return res.status(400).json({ success: false, message: "Task has no phases" });
    }

    const phase = task.phases.id(phaseId);
    if (!phase) {
      return res.status(404).json({ success: false, message: "Phase not found" });
    }

    if ((phase.phaseStatus || "").toLowerCase() === "completed") {
      return res.status(400).json({ success: false, message: "Completed phase cannot be modified" });
    }

    // Update phase in Task model
    if (phaseTitle !== undefined) phase.phaseTitle = phaseTitle.trim();
    if (phaseStatus !== undefined) phase.phaseStatus = phaseStatus;
    if (phaseDescription !== undefined) phase.phaseDescription = phaseDescription.trim();
    if (!phase.employeeId && req.user?.id) phase.employeeId = req.user.id;
    phase.updateDate = new Date();

    // Check member's personal status across their own phases
    const memberIdStr = (phase.employeeId || req.user?.id || "").toString();
    if (memberIdStr && Array.isArray(task.memberStatuses) && task.memberStatuses.length > 0) {
      const memberPhases = (task.phases || []).filter(p => (p.employeeId || "").toString() === memberIdStr);
      const allDone = memberPhases.length > 0 && memberPhases.every(p => (p.phaseStatus || "").toLowerCase() === "completed");
      const anyInProcess = memberPhases.some(p => (p.phaseStatus || "").toLowerCase() === "inprocess" || (p.phaseStatus || "").toLowerCase() === "inprogress");

      const msIdx = task.memberStatuses.findIndex(ms => (ms.employeeId?._id || ms.employeeId || "").toString() === memberIdStr);
      if (msIdx >= 0) {
        if (allDone) {
          task.memberStatuses[msIdx].status = "Completed";
          if (!task.memberStatuses[msIdx].endDate) {
            task.memberStatuses[msIdx].endDate = new Date();
          }
        } else if (anyInProcess) {
          task.memberStatuses[msIdx].status = "In Progress";
          if (!task.memberStatuses[msIdx].startDate) {
            task.memberStatuses[msIdx].startDate = new Date();
          }
        }
        task.markModified("memberStatuses");
      }
    }

    await task.save();

    // ALSO sync DailyWorkUpdate documents linked to this phaseId
    if (mongoose.Types.ObjectId.isValid(phaseId)) {
      const resolvedUserId = phase.employeeId || (task.assignedMembers?.length > 0 ? task.assignedMembers[0] : task.createdBy);
      await syncPhaseToDailyWorkUpdate({
        phaseId: phase._id,
        phaseTitle: phase.phaseTitle,
        phaseDescription: phase.phaseDescription,
        phaseStatus: phase.phaseStatus,
        updateDate: phase.updateDate,
        userId: resolvedUserId,
        category: task.category,
        project: task.project,
        workType: task.workType,
        pages: task.pages,
      });
    }

    await syncTaskWorkingDays(task._id);
    const refreshedTask = await Task.findById(taskId);
    const refreshedPhase = refreshedTask?.phases?.id(phaseId) || phase;

    res.json({ success: true, message: "Phase and daily work updates synced successfully", data: refreshedPhase });
  } catch (error) {
    console.error("UPDATE TASK PHASE ERROR:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};


exports.editAssignedTaskBeforeAccept = async (req, res) => {
  const CONTEXT = "EDIT_ASSIGNED_TASK_BEFORE_ACCEPT";
  const startTime = Date.now();

  logRequest(CONTEXT, req, { taskId: req.params.taskId });

  try {
    const { taskId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(taskId)) {
      logResponse(CONTEXT, 400, "Invalid Task ID");
      return res.status(400).json({ success: false, message: "Invalid Task ID" });
    }

    const task = await Task.findById(taskId);
    if (!task) {
      logResponse(CONTEXT, 404, "Task not found");
      return res.status(404).json({ success: false, message: "Task not found" });
    }

    // Only creator / assignedBy or admin can edit
    const creatorId = task.createdBy.toString();
    const currentUserId = req.user.id;
    const isUserAdmin = req.user.role === "admin";
    if (creatorId !== currentUserId.toString() && !isUserAdmin) {
      logResponse(CONTEXT, 403, "Forbidden: Only the task creator or an admin can edit this assignment");
      return res.status(403).json({ success: false, message: "Only the task creator can edit this assignment" });
    }

    // Check if task.assignedStatus is not Allocated
    if (task.assignedStatus !== "Allocated") {
      logResponse(CONTEXT, 400, "Task already accepted or rejected. Editing is not allowed.");
      return res.status(400).json({
        success: false,
        message: "Task already accepted or rejected. Editing is not allowed."
      });
    }

    const oldMembers = (task.assignedMembers || []).map(m => m.toString());
    const oldTaskSnapshot = {
      taskTitle: task.taskTitle,
      taskDetails: task.taskDetails,
      priority: task.priority,
      dueDate: task.dueDate,
      category: task.category,
      project: task.project,
      assignedMembers: [...(task.assignedMembers || [])],
    };

    const { taskTitle, taskDetails, priority, dueDate, category, project, assignedMembers, workType, pages } = req.body;

    const updates = {};
    if (taskTitle !== undefined) updates.taskTitle = taskTitle;
    if (taskDetails !== undefined) updates.taskDetails = taskDetails;
    if (priority !== undefined) updates.priority = priority;
    if (dueDate !== undefined) updates.dueDate = dueDate === "" ? null : dueDate;
    if (category !== undefined) updates.category = category;
    if (project !== undefined) updates.project = project;
    if (workType !== undefined) updates.workType = (workType || "").trim();
    if (pages !== undefined) {
      let parsedPages = [];
      if (Array.isArray(pages)) parsedPages = pages;
      else if (typeof pages === "string" && pages.trim()) {
        try { parsedPages = JSON.parse(pages); } catch (e) { parsedPages = [pages]; }
      }
      updates.pages = parsedPages;
    }

    /* ── Members ── */
    if (assignedMembers !== undefined) {
      let members = parseMembers(assignedMembers);
      members = members.filter(id => id.toString() !== creatorId);
      updates.assignedMembers = members.length > 0 ? members : undefined;
    }

    /* ── Timestamp ── */
    updates.detailUpdatedAt = new Date();

    /* ── Apply updates ── */
    task.set(updates);

    /* ── Handle document deletion if requested ── */
    if (req.body.deletedDocuments) {
      let deletedIds = [];
      try {
        deletedIds = typeof req.body.deletedDocuments === 'string' ? JSON.parse(req.body.deletedDocuments) : req.body.deletedDocuments;
      } catch (e) { }
      if (Array.isArray(deletedIds) && deletedIds.length > 0) {
        const normalize = (k) => {
          if (!k) return "";
          if (typeof k === "object") k = k._id || k.id || k.key || k.fileKey || k.fileUrl || "";
          k = String(k);
          if (k.includes(".amazonaws.com/")) k = k.split(".amazonaws.com/")[1];
          return k.trim();
        };

        const targetKeys = deletedIds.map(normalize).filter(Boolean);

        const remainingDocs = [];
        for (const docKey of task.documents) {
          const normDoc = normalize(docKey);
          const isMarked = targetKeys.some(t => t === normDoc || normDoc.endsWith(t) || t.endsWith(normDoc));
          if (isMarked) {
            await deleteFromS3(docKey).catch(err => console.error("S3 delete failed:", err));
          } else {
            remainingDocs.push(docKey);
          }
        }
        task.documents = remainingDocs;
      }
    }

    /* ── New file uploads ── */
    if (req.files?.length) {
      const empId = req.user.empId || req.user.id;
      const newKeys = await uploadFiles(req.files, empId);
      task.documents.push(...newKeys);
    }

    await task.save();

    // ── Audit & Activity Logging (Only log if fields were edited) ──
    const currentUserName = req.user?.name || "User";
    const changes = await buildTaskDiffs(oldTaskSnapshot, updates, req.files, req.body.deletedDocuments);
    if (changes.length > 0) {
      createLog({
        category: "task",
        referenceId: task._id,
        description: `${currentUserName} edited task`,
        changes,
      });
    }

    serverLog("INFO", CONTEXT, "Assigned Task edited before accept successfully");
    res.json({ success: true, message: "Task edited successfully", data: task });
  } catch (error) {
    console.error("EDIT ASSIGNED TASK ERROR:", error);
    logResponse(CONTEXT, 500, error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};


