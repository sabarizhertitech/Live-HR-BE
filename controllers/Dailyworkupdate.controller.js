const DailyWorkUpdate = require("../Models/Dailyworkupdate");
const Task = require("../Models/task.model");
const Employee = require('../Models/Employee');
const mongoose = require("mongoose");
const TaskMeta = require("../Models/TaskMeta.model");
const { syncTaskWorkingDays, calculateOverallTaskWorkingDays } = require("../utilities/workingDaysCalculator");

/* ─────────────────────────────────────────────────────────
   POST  /daily-update
───────────────────────────────────────────────────────── */
exports.createDailyUpdate = async (req, res) => {
  try {
    let {
      phase, // legacy
      title, // new standardized
      description,
      status, // new standardized
      phaseStatus, // legacy
      updateDate,
      date, // 🌟 Support both 'updateDate' and 'date'
      isNewTask,
      taskTitle, // legacy
      category,
      project,
      pages,
      workType,
      employeeId,
      taskPhaseId,
      phaseId
    } = req.body;

    const resolvedUpdateDate = updateDate || date || req.body.date || new Date();

    // Support multiple client request formats for Task ID (task, taskId, task_id)
    const resolvedTaskId = req.body.task || req.body.taskId || req.body.task_id;
    const isExplicitStandalone = resolvedTaskId === "standalone" || req.body.isNewTask === true || (!resolvedTaskId && !req.body.phaseId && !req.body.taskPhaseId);
    let task;
    if (!isExplicitStandalone && resolvedTaskId && mongoose.Types.ObjectId.isValid(resolvedTaskId)) {
      // Check if task exists in DB; if not, remove/set to undefined immediately
      const taskExists = await Task.exists({ _id: resolvedTaskId });
      task = taskExists ? resolvedTaskId : undefined;
    } else {
      task = undefined;
    }

    let userId = req.user?.id || req.user?._id || employeeId;

    const resolvedPhaseId = req.body.phaseId || req.body.taskPhaseId;
    let parentTask = null;
    if (task) {
      parentTask = await Task.findById(task);
      if (parentTask) {
        if (!userId) {
          userId = parentTask.assignedMembers?.[0] || parentTask.createdBy;
        }
        // Sync category and project between daily update and task model
        if (!category && parentTask.category) {
          category = parentTask.category;
        } else if (category && (!parentTask.category || parentTask.category.trim() === "")) {
          parentTask.category = category.trim();
        }

        if (!project && parentTask.project) {
          project = parentTask.project;
        } else if (project && (!parentTask.project || parentTask.project.trim() === "")) {
          parentTask.project = project.trim();
        }
      }
    } else if (!isExplicitStandalone && resolvedPhaseId && mongoose.Types.ObjectId.isValid(resolvedPhaseId)) {
      parentTask = await Task.findOne({ "phases._id": resolvedPhaseId });
      if (parentTask) {
        task = parentTask._id;
        if (!userId) {
          userId = parentTask.assignedMembers?.[0] || parentTask.createdBy;
        }
        if (!category && parentTask.category) category = parentTask.category;
        if (!project && parentTask.project) project = parentTask.project;
      }
    }

    if (!isExplicitStandalone && !parentTask && category && project) {
      const catTrim = category.trim();
      const projTrim = project.trim();
      const catRegex = new RegExp(`^${catTrim}$`, "i");
      const projRegex = new RegExp(`^${projTrim}$`, "i");

      let matchedTask = null;
      if (userId && mongoose.Types.ObjectId.isValid(userId)) {
        matchedTask = await Task.findOne({
          category: { $regex: catRegex },
          project: { $regex: projRegex },
          $or: [
            { assignedMembers: userId },
            { createdBy: userId }
          ]
        }).sort({ createdAt: -1 });
      }

      if (!matchedTask) {
        matchedTask = await Task.findOne({
          category: { $regex: catRegex },
          project: { $regex: projRegex }
        }).sort({ createdAt: -1 });
      }

      if (matchedTask) {
        parentTask = matchedTask;
        task = parentTask._id;
        if (!category && parentTask.category) category = parentTask.category;
        if (!project && parentTask.project) project = parentTask.project;
      }
    }

    if (!userId) {
      return res.status(400).json({ success: false, message: "Could not determine user ID (updatedBy)" });
    }

    // --- AUTOMATIC PHASE FETCHING & MATCHING ---
    let finalTitle = (title || phase || taskTitle || "").trim();

    if (!finalTitle && parentTask && parentTask.phases?.length > 0) {
      // Automatically find the most relevant phase (pending or inprocess)
      let autoPhase = parentTask.phases.find(p => ["pending", "inprocess"].includes(p.phaseStatus?.toLowerCase()));
      if (!autoPhase) autoPhase = parentTask.phases[parentTask.phases.length - 1]; // Fallback to last phase
      finalTitle = autoPhase.phaseTitle;
    }

    // Match the target phase before saving the update entry
    let targetPhase = null;
    if (!isExplicitStandalone && parentTask) {
      if (resolvedPhaseId && Array.isArray(parentTask.phases)) {
        targetPhase = parentTask.phases.id(resolvedPhaseId);
      }

      // Fallback 1: Match by title in the task's existing phases
      if (!targetPhase && finalTitle && Array.isArray(parentTask.phases)) {
        targetPhase = parentTask.phases.find(
          p => p.phaseTitle?.trim().toLowerCase() === finalTitle.toLowerCase()
        );
      }

      // Fallback 2: If task has exactly 1 phase, match it
      if (!targetPhase && Array.isArray(parentTask.phases) && parentTask.phases.length === 1) {
        targetPhase = parentTask.phases[0];
      }

      // Fallback 3: If phase array is non-empty, use the last active phase (ONLY if no finalTitle is provided)
      if (!targetPhase && !finalTitle && Array.isArray(parentTask.phases) && parentTask.phases.length > 0) {
        for (let i = parentTask.phases.length - 1; i >= 0; i--) {
          if (["pending", "inprocess"].includes(parentTask.phases[i].phaseStatus?.toLowerCase())) {
            targetPhase = parentTask.phases[i];
            break;
          }
        }
        if (!targetPhase) {
          targetPhase = parentTask.phases[parentTask.phases.length - 1];
        }
      }
    }

    const filteredPages = Array.isArray(pages)
      ? pages.map(p => String(p).trim()).filter(Boolean)
      : (typeof pages === "string" && pages.trim() ? [pages.trim()] : undefined);

    const trimmedWorkType = (workType && String(workType).trim()) ? String(workType).trim() : undefined;

    const entryData = {
      userId: userId,
      category: (category || "").trim(),
      project: (project || "").trim(),
      pages: (filteredPages && filteredPages.length > 0) ? filteredPages : undefined,
      workType: trimmedWorkType,
      title: finalTitle,
      description: (description || "").trim(),
      status: status || phaseStatus || "inprocess",
      updateDate: new Date(resolvedUpdateDate),
      task: undefined, // Never store the parent taskId inside the DailyWorkUpdate entry!
    };

    if (!entryData.workType && parentTask?.workType && String(parentTask.workType).trim()) {
      entryData.workType = String(parentTask.workType).trim();
    }
    if ((!entryData.pages || entryData.pages.length === 0) && parentTask?.pages?.length > 0) {
      const validParentPages = parentTask.pages.map(p => String(p).trim()).filter(Boolean);
      if (validParentPages.length > 0) {
        entryData.pages = validParentPages;
      }
    }


    // 🌟 STORE REFERENCED phaseId directly in entryData ONLY if linked to an actual Task Phase
    let finalPhaseId = null;
    if (!isExplicitStandalone && targetPhase) {
      finalPhaseId = targetPhase._id;
    } else if (!isExplicitStandalone && resolvedPhaseId && mongoose.Types.ObjectId.isValid(resolvedPhaseId) && parentTask) {
      finalPhaseId = resolvedPhaseId;
    }

    entryData.phaseId = finalPhaseId || undefined;
    entryData.referenceId = undefined; // Managed below based on historical records
    if (!finalPhaseId && req.body.workUpdateRefId && mongoose.Types.ObjectId.isValid(req.body.workUpdateRefId)) {
      entryData.workUpdateRefId = new mongoose.Types.ObjectId(req.body.workUpdateRefId);
    }

    // Upsert / Record Search:
    let entry = null;
    const targetDate = new Date(resolvedUpdateDate);
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    if (finalPhaseId) {
      // Priority 1: Check if an entry for this exact phase exists on the SAME calendar date
      entry = await DailyWorkUpdate.findOne({
        $or: [{ phaseId: finalPhaseId }, { referenceId: finalPhaseId }],
        updateDate: { $gte: startOfDay, $lte: endOfDay }
      });

      // RESTRICTION: If existing entry on same date is already Completed and incoming is NOT completed, do not overwrite it
      if (entry && (entry.status || "").toLowerCase() === "completed" && (status || phaseStatus || "").toLowerCase() !== "completed") {
        entry = null;
      }

      // If we are creating a NEW record on this date (entry is null):
      // Check if historical daily-work records exist for this phase on prior dates to manage stable referenceId
      if (!entry) {
        const existingPhaseRecords = await DailyWorkUpdate.find({
          $or: [{ phaseId: finalPhaseId }, { referenceId: finalPhaseId }]
        }).sort({ createdAt: 1 });

        if (existingPhaseRecords.length > 0) {
          // Multiple historical records per phase across different dates: use a stable referenceId
          const existingRef = existingPhaseRecords.find(r => r.referenceId && mongoose.Types.ObjectId.isValid(r.referenceId.toString()));
          if (existingRef) {
            entryData.referenceId = existingRef.referenceId;
          } else {
            const sharedRefId = new mongoose.Types.ObjectId();
            entryData.referenceId = sharedRefId;
            await DailyWorkUpdate.updateMany(
              { $or: [{ phaseId: finalPhaseId }, { referenceId: finalPhaseId }] },
              { $set: { referenceId: sharedRefId } }
            );
          }
        } else {
          // One current record per phase: no separate referenceId is necessary
          entryData.referenceId = undefined;
        }
      }
    } else {
      // Standalone updates: match by userId, category, project, title on same date with no phaseId/referenceId
      const standaloneQuery = {
        userId: userId,
        updateDate: { $gte: startOfDay, $lte: endOfDay },
        $or: [{ phaseId: { $exists: false } }, { phaseId: null }],
        $or: [{ referenceId: { $exists: false } }, { referenceId: null }]
      };
      if (req.body.workUpdateRefId && mongoose.Types.ObjectId.isValid(req.body.workUpdateRefId)) {
        standaloneQuery.workUpdateRefId = req.body.workUpdateRefId;
      } else {
        standaloneQuery.category = (category || "").trim();
        standaloneQuery.project = (project || "").trim();
        standaloneQuery.title = finalTitle;
      }
      entry = await DailyWorkUpdate.findOne(standaloneQuery);

      if (entry && (entry.status || "").toLowerCase() === "completed") {
        entry = null;
      }
    }

    if (entry) {
      console.log(`[CreateDailyUpdate] Updating existing DailyWorkUpdate entry for ${finalPhaseId ? `phaseId: ${finalPhaseId}` : `title: ${finalTitle}`} on date`);
      if (finalPhaseId) {
        entry.phaseId = finalPhaseId;
      } else {
        entry.set('phaseId', undefined);
        entry.set('referenceId', undefined);
        if (entry._doc) {
          delete entry._doc.phaseId;
          delete entry._doc.referenceId;
        }
        if (req.body.workUpdateRefId && mongoose.Types.ObjectId.isValid(req.body.workUpdateRefId)) {
          entry.workUpdateRefId = new mongoose.Types.ObjectId(req.body.workUpdateRefId);
        } else if (!entry.workUpdateRefId) {
          entry.workUpdateRefId = entry._id;
        }
      }
      entry.description = (description || "").trim();
      entry.status = status || phaseStatus || "inprocess";
      // Preserve original start date / historical entry date
      if (!entry.updateDate) {
        entry.updateDate = new Date(resolvedUpdateDate);
      }
      entry.title = finalTitle;
      if (category) entry.category = category.trim();
      if (project) entry.project = project.trim();
      if (pages !== undefined) {
        const filtered = Array.isArray(pages) ? pages.map(p => String(p).trim()).filter(Boolean) : (typeof pages === "string" && pages.trim() ? [pages.trim()] : []);
        if (filtered.length > 0) {
          entry.pages = filtered;
        } else {
          entry.set('pages', undefined);
          if (entry._doc) delete entry._doc.pages;
        }
      }
      if (workType !== undefined) {
        const trimmed = (workType || "").trim();
        if (trimmed) {
          entry.workType = trimmed;
        } else {
          entry.set('workType', undefined);
          if (entry._doc) delete entry._doc.workType;
        }
      }
      if (!entry.workType && parentTask?.workType && String(parentTask.workType).trim()) entry.workType = String(parentTask.workType).trim();
      if ((!entry.pages || entry.pages.length === 0) && parentTask?.pages?.length > 0) {
        const validParentPages = parentTask.pages.map(p => String(p).trim()).filter(Boolean);
        if (validParentPages.length > 0) entry.pages = validParentPages;
      }
      await entry.save();
    } else {
      console.log(`[CreateDailyUpdate] Creating new DailyWorkUpdate entry.`);
      entry = new DailyWorkUpdate(entryData);
      await entry.save();
      if (!finalPhaseId && !entry.workUpdateRefId) {
        entry.workUpdateRefId = entry._id;
        await entry.save();
      }
    }

    // --- SYNC WITH PARENT TASK MODEL ---
    if (!isExplicitStandalone && parentTask) {

      if (targetPhase) {
        const isDifferentDay = targetPhase.updateDate &&
          new Date(targetPhase.updateDate).toDateString() !== new Date(resolvedUpdateDate).toDateString();

        if (isDifferentDay && entry && (!sameDayRecord || sameDayRecord._id.toString() !== entry._id.toString())) {
          // Different calendar day: preserve previous targetPhase and add a new phase for today!
          const newPhase = {
            _id: entry._id || new mongoose.Types.ObjectId(),
            phaseTitle: finalTitle || targetPhase.phaseTitle,
            phaseDescription: (description || "").trim() || targetPhase.phaseDescription,
            phaseStatus: status || phaseStatus || "inprocess",
            updateDate: new Date(resolvedUpdateDate),
            employeeId: userId || targetPhase.employeeId,
            workingDays: 1
          };
          if (!parentTask.phases) parentTask.phases = [];
          parentTask.phases.push(newPhase);
          const addedPhase = parentTask.phases[parentTask.phases.length - 1];

          entry.taskPhaseId = addedPhase._id;
          entry.phaseId = addedPhase._id;
          entry.task = undefined;
          await entry.save();
        } else {
          // Same calendar day: update targetPhase in place
          targetPhase.phaseTitle = finalTitle || targetPhase.phaseTitle;
          targetPhase.phaseDescription = (description || "").trim() || targetPhase.phaseDescription;
          targetPhase.phaseStatus = status || phaseStatus || "inprocess";
          targetPhase.updateDate = new Date(resolvedUpdateDate);
          if (userId) targetPhase.employeeId = userId;
          if (!entry.phaseId) {
            entry.phaseId = targetPhase._id;
            await entry.save();
          }
        }
      } else if (finalTitle) {
        // Fallback 3: If still no targetPhase, create a new phase on the task!
        const newPhase = {
          phaseTitle: finalTitle,
          phaseDescription: (description || "").trim(),
          phaseStatus: status || phaseStatus || "inprocess",
          updateDate: new Date(resolvedUpdateDate),
          employeeId: userId
        };
        if (!parentTask.phases) {
          parentTask.phases = [];
        }
        parentTask.phases.push(newPhase);
        const addedPhase = parentTask.phases[parentTask.phases.length - 1];

        // Save the generated phase's ID back to the daily update
        entry.taskPhaseId = addedPhase._id;
        entry.referenceId = addedPhase._id;
        entry.phaseId = addedPhase._id;
        entry.task = undefined; // Never store the parent taskId inside the DailyWorkUpdate entry!
        await entry.save();
      }

      await parentTask.save();
      await syncTaskWorkingDays(parentTask._id);
    } else if (finalPhaseId) {
      const taskWithPhase = await Task.findOne({ "phases._id": finalPhaseId });
      if (taskWithPhase) {
        await syncTaskWorkingDays(taskWithPhase._id);
      }
    }

    res.status(201).json({
      success: true,
      message: "Daily work update recorded",
      data: entry
    });
  } catch (error) {
    console.error("CREATE DAILY UPDATE ERROR:", error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/* ─────────────────────────────────────────────────────────
   PUT  /daily-update/:id
───────────────────────────────────────────────────────── */
exports.updateDailyUpdate = async (req, res) => {
  try {
    const { id } = req.params;
    const { description, phase, status, phaseStatus, title, category, project, pages, workType } = req.body;

    const entry = await DailyWorkUpdate.findById(id);
    if (!entry) {
      return res.status(404).json({ success: false, message: "Update not found" });
    }

    const requesterId = (req.user?.id || req.user?._id || "").toString();
    const isOwner = entry.userId.toString() === requesterId;
    const isAdmin = req.user?.role === "admin";

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ success: false, message: "Unauthorized to modify this work update" });
    }

    entry.description = (description || entry.description || "").trim();
    entry.title = (phase || title || entry.title || "").trim();
    entry.status = status || phaseStatus || entry.status;

    if (category && category.trim() !== "") entry.category = category.trim();
    if (project && project.trim() !== "") entry.project = project.trim();
    if (pages !== undefined) {
      const filtered = Array.isArray(pages) ? pages.map(p => String(p).trim()).filter(Boolean) : (typeof pages === "string" && pages.trim() ? [pages.trim()] : []);
      if (filtered.length > 0) {
        entry.pages = filtered;
      } else {
        entry.set('pages', undefined);
        if (entry._doc) delete entry._doc.pages;
      }
    }
    if (workType !== undefined) {
      const trimmed = (workType || "").trim();
      if (trimmed) {
        entry.workType = trimmed;
      } else {
        entry.set('workType', undefined);
        if (entry._doc) delete entry._doc.workType;
      }
    }

    // Update phase identification:
    const resolvedPhaseId = req.body.phaseId || req.body.taskPhaseId;
    if (resolvedPhaseId && mongoose.Types.ObjectId.isValid(resolvedPhaseId)) {
      entry.phaseId = resolvedPhaseId;
    }

    // Keep entry.referenceId stable (never overwrite referenceId with phaseId)
    if (entry.referenceId && !entry.phaseId) {
      const isRealPhase = await Task.exists({ "phases._id": entry.referenceId });
      if (isRealPhase) {
        entry.phaseId = entry.referenceId;
      } else {
        entry.set('referenceId', undefined);
        if (entry._doc) delete entry._doc.referenceId;
      }
    }

    if (req.body.workUpdateRefId && mongoose.Types.ObjectId.isValid(req.body.workUpdateRefId)) {
      entry.workUpdateRefId = new mongoose.Types.ObjectId(req.body.workUpdateRefId);
    }

    entry.task = undefined;
    entry.updateDate = req.body.updateDate ? new Date(req.body.updateDate) : (entry.updateDate || new Date());
    await entry.save();

    // --- SYNC WITH PARENT TASK MODEL ---
    const activePhaseId = entry.phaseId || resolvedPhaseId || entry.referenceId;
    let parentTask = null;
    if (activePhaseId) {
      parentTask = await Task.findOne({ "phases._id": activePhaseId });
    }
    if (!parentTask && entry.category && entry.project) {
      const catRegex = new RegExp(`^${entry.category.trim()}$`, "i");
      const projRegex = new RegExp(`^${entry.project.trim()}$`, "i");
      parentTask = await Task.findOne({
        category: { $regex: catRegex },
        project: { $regex: projRegex }
      }).sort({ createdAt: -1 });
    }
    if (parentTask) {
      parentTask.detailUpdatedAt = new Date();
      let phaseObj = null;
      if (activePhaseId && parentTask.phases) {
        phaseObj = parentTask.phases.id(activePhaseId);
      }
      if (!phaseObj && entry.title && parentTask.phases) {
        phaseObj = parentTask.phases.find(
          p => p.phaseTitle?.trim().toLowerCase() === entry.title.trim().toLowerCase()
        );
      }
      if (!phaseObj && parentTask.phases?.length === 1) {
        phaseObj = parentTask.phases[0];
      }
      if (phaseObj) {
        phaseObj.phaseTitle = entry.title || phaseObj.phaseTitle;
        phaseObj.phaseDescription = entry.description || phaseObj.phaseDescription;
        phaseObj.phaseStatus = entry.status;
        phaseObj.updateDate = new Date();
        if (!entry.phaseId) {
          entry.phaseId = phaseObj._id;
          await entry.save();
        }
      }
      await parentTask.save();
      await syncTaskWorkingDays(parentTask._id);
    }

    res.json({ success: true, message: "Update modified successfully", data: entry });
  } catch (error) {
    console.error("UPDATE DAILY UPDATE ERROR:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/* ─────────────────────────────────────────────────────────
   GET  /daily-update/:taskId
───────────────────────────────────────────────────────── */
exports.getDailyUpdates = async (req, res) => {
  try {
    const { taskId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(taskId)) {
      return res.status(400).json({ success: false, message: "Invalid taskId" });
    }

    const parentTask = await Task.findById(taskId);
    if (!parentTask) {
      return res.status(404).json({ success: false, message: "Task not found" });
    }

    const phaseIds = parentTask.phases?.map(p => p._id) || [];

    const filter = {
      $or: [
        // Priority 1: Linked via phaseId or legacy referenceId
        { phaseId: { $in: phaseIds } },
        { referenceId: { $in: phaseIds } },
        // Priority 2: Standalone updates matching category+project BUT NOT already phase-linked
        {
          project: parentTask.project,
          category: parentTask.category,
          phaseId: { $exists: false },
          referenceId: { $exists: false }
        },
        {
          project: parentTask.project,
          category: parentTask.category,
          phaseId: null,
          referenceId: null
        }
      ]
    };

    if (req.query.date) {
      const start = new Date(req.query.date);
      start.setHours(0, 0, 0, 0);
      const end = new Date(req.query.date);
      end.setHours(23, 59, 59, 999);
      filter.updateDate = { $gte: start, $lte: end };
    }

    const updates = await DailyWorkUpdate.find(filter)
      .populate("userId", "name photo email")
      .sort({ _id: -1 });

    res.json({ success: true, count: updates.length, data: updates });

  } catch (error) {
    console.error("GET DAILY UPDATES ERROR:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};
/* ─────────────────────────────────────────────────────────
   GET  /daily-update/today/:taskId
───────────────────────────────────────────────────────── */
exports.getTodayUpdates = async (req, res) => {
  try {
    const { taskId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(taskId)) {
      return res.status(400).json({ success: false, message: "Invalid taskId" });
    }

    const parentTask = await Task.findById(taskId);
    if (!parentTask) {
      return res.status(404).json({ success: false, message: "Task not found" });
    }

    const phaseIds = parentTask.phases?.map(p => p._id) || [];

    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    const filter = {
      $or: [
        { phaseId: { $in: phaseIds } },
        { referenceId: { $in: phaseIds } },
        {
          project: parentTask.project,
          category: parentTask.category,
          phaseId: { $exists: false },
          referenceId: { $exists: false }
        },
        {
          project: parentTask.project,
          category: parentTask.category,
          phaseId: null,
          referenceId: null
        }
      ],
      updateDate: { $gte: start, $lte: end }
    };

    const updates = await DailyWorkUpdate.find(filter)
      .populate("userId", "name photo email")
      .sort({ _id: -1 });

    res.json({ success: true, count: updates.length, data: updates });

  } catch (error) {
    console.error("GET TODAY UPDATES ERROR:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/* ─────────────────────────────────────────────────────────
   GET  /all-daily-updates
   Fetches all daily updates (Admin view)
───────────────────────────────────────────────────────── */
exports.getAllDailyWorkUpdates = async (req, res) => {
  try {
    const { employeeId, fromDate, toDate, today, yesterday, thisWeek, thisMonth, year, category, project } = req.query;

    // BUILD MATCH QUERIES
    const dailyMatch = {};
    const standaloneMatch = {};

    // --- ROLE-BASED PRIVACY ---
    const requesterId = req.user?.id || req.user?._id;
    const isRequesterAdmin = req.user?.role === "admin";

    if (!isRequesterAdmin) {
      // Employees can ONLY see their own data
      dailyMatch.userId = new mongoose.Types.ObjectId(requesterId);
      standaloneMatch.userId = new mongoose.Types.ObjectId(requesterId);
    } else if (employeeId) {
      // Admins can filter by a specific employee
      dailyMatch.userId = new mongoose.Types.ObjectId(employeeId);
      standaloneMatch.userId = new mongoose.Types.ObjectId(employeeId);
    }

    const now = new Date();
    let dateFilter = {};

    if (today === "true") {
      const s = new Date(now); s.setHours(0, 0, 0, 0);
      const e = new Date(now); e.setHours(23, 59, 59, 999);
      dateFilter = { $gte: s, $lte: e };
    } else if (yesterday === "true") {
      const y = new Date(now); y.setDate(now.getDate() - 1);
      const s = new Date(y); s.setHours(0, 0, 0, 0);
      const e = new Date(y); e.setHours(23, 59, 59, 999);
      dateFilter = { $gte: s, $lte: e };
    } else if (thisWeek === "true") {
      const s = new Date(now);
      const day = s.getDay();
      s.setDate(s.getDate() - day + (day === 0 ? -6 : 1));
      s.setHours(0, 0, 0, 0);
      const e = new Date(now); e.setHours(23, 59, 59, 999);
      dateFilter = { $gte: s, $lte: e };
    } else if (thisMonth === "true") {
      const s = new Date(now.getFullYear(), now.getMonth(), 1); s.setHours(0, 0, 0, 0);
      const e = new Date(now); e.setHours(23, 59, 59, 999);
      dateFilter = { $gte: s, $lte: e };
    } else if (year) {
      dateFilter = {
        $gte: new Date(`${year}-01-01T00:00:00.000Z`),
        $lte: new Date(`${year}-12-31T23:59:59.999Z`),
      };
    } else if (fromDate || toDate) {
      dateFilter = {};
      if (fromDate) {
        const start = new Date(fromDate);
        start.setHours(0, 0, 0, 0);
        dateFilter.$gte = start;
      }
      if (toDate) {
        const end = new Date(toDate);
        end.setHours(23, 59, 59, 999);
        dateFilter.$lte = end;
      }
    }

    if (Object.keys(dateFilter).length) {
      dailyMatch.updateDate = dateFilter;
      standaloneMatch.updateDate = dateFilter;
    }

    if (category) {
      standaloneMatch.category = { $in: [category] };
    }
    if (project) {
      standaloneMatch.project = { $in: [project] };
    }

    // --- CONSOLIDATED FETCH: ALL UPDATES ---
    const dailyPipeline = [
      { $match: dailyMatch },
      {
        $lookup: {
          from: "tasks",
          let: { updProj: "$project", updCat: "$category", updPhase: "$phaseId", updRef: "$referenceId", updTask: "$task" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    {
                      $and: [
                        { $ne: [{ $ifNull: ["$$updTask", null] }, null] },
                        { $eq: ["$_id", "$$updTask"] }
                      ]
                    },
                    {
                      $and: [
                        { $ne: [{ $ifNull: ["$$updPhase", null] }, null] },
                        { $in: ["$$updPhase", { $ifNull: ["$phases._id", []] }] }
                      ]
                    },
                    {
                      $and: [
                        { $ne: [{ $ifNull: ["$$updRef", null] }, null] },
                        { $in: ["$$updRef", { $ifNull: ["$phases._id", []] }] }
                      ]
                    }
                  ]
                }
              }
            },
            { $sort: { createdAt: -1 } },
            { $limit: 1 }
          ],
          as: "taskInfo"
        }
      },
      { $unwind: { path: "$taskInfo", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "employees",
          localField: "userId",
          foreignField: "_id",
          as: "userInfo"
        }
      },
      { $unwind: { path: "$userInfo", preserveNullAndEmptyArrays: true } },
      {
        $match: {
          "userInfo.role": { $in: ["admin", "employee"] }
        }
      }
    ];

    if (category) dailyPipeline.push({ $match: { $or: [{ "taskInfo.category": { $in: [category] } }, { category: { $in: [category] } }] } });
    if (project) dailyPipeline.push({ $match: { $or: [{ "taskInfo.project": { $in: [project] } }, { project: { $in: [project] } }] } });

    dailyPipeline.push({
      $project: {
        _id: 1, description: 1, title: 1, status: 1, updateDate: 1, createdAt: 1, category: 1, project: 1,
        workType: { $ifNull: ["$workType", "$taskInfo.workType", ""] },
        pages: {
          $cond: [
            { $gt: [{ $size: { $ifNull: ["$pages", []] } }, 0] },
            "$pages",
            { $ifNull: ["$taskInfo.pages", []] }
          ]
        },
        phaseId: { $ifNull: ["$phaseId", "$referenceId", null] },
        referenceId: { $ifNull: ["$referenceId", null] },
        taskPhaseId: { $ifNull: ["$phaseId", "$referenceId", null] },
        taskPhaseStatus: {
          $let: {
            vars: {
              matchedPhase: {
                $arrayElemAt: [
                  {
                    $filter: {
                      input: { $ifNull: ["$taskInfo.phases", []] },
                      as: "p",
                      cond: {
                        $or: [
                          { $eq: ["$$p._id", "$phaseId"] },
                          { $eq: ["$$p._id", "$referenceId"] },
                          { $eq: [{ $toLower: "$$p.phaseTitle" }, { $toLower: "$title" }] }
                        ]
                      }
                    }
                  },
                  0
                ]
              }
            },
            in: { $ifNull: ["$$matchedPhase.phaseStatus", null] }
          }
        },
        phaseWorkingDays: {
          $let: {
            vars: {
              matchedPhase: {
                $arrayElemAt: [
                  {
                    $filter: {
                      input: { $ifNull: ["$taskInfo.phases", []] },
                      as: "p",
                      cond: {
                        $or: [
                          { $eq: ["$$p._id", "$phaseId"] },
                          { $eq: ["$$p._id", "$referenceId"] },
                          { $eq: [{ $toLower: "$$p.phaseTitle" }, { $toLower: "$title" }] }
                        ]
                      }
                    }
                  },
                  0
                ]
              }
            },
            in: { $ifNull: ["$$matchedPhase.workingDays", null] }
          }
        },
        overallTaskWorkingDays: {
          $reduce: {
            input: { $ifNull: ["$taskInfo.phases", []] },
            initialValue: 0,
            in: { $add: ["$$value", { $ifNull: ["$$this.workingDays", 0] }] }
          }
        },
        userId: { _id: "$userInfo._id", name: "$userInfo.name", employeeId: "$userInfo.empId", photo: "$userInfo.photo" },
        updatedBy: { _id: "$userInfo._id", name: "$userInfo.name", employeeId: "$userInfo.empId", photo: "$userInfo.photo" },
        note: "$description",
        phase: "$title",
        phaseStatus: "$status",
        task: {
          _id: { $ifNull: ["$taskInfo._id", "standalone"] },
          taskTitle: { $ifNull: ["$taskInfo.taskTitle", "$title"] },
          taskDetails: { $ifNull: ["$taskInfo.taskDetails", "$description"] },
          category: { $ifNull: ["$taskInfo.category", "$category"] },
          project: { $ifNull: ["$taskInfo.project", "$project"] },
          workType: { $ifNull: ["$taskInfo.workType", ""] },
          pages: { $ifNull: ["$taskInfo.pages", []] },
          phases: { $ifNull: ["$taskInfo.phases", []] },
          startDate: "$taskInfo.startDate",
          endDate: "$taskInfo.endDate",
          dueDate: "$taskInfo.dueDate",
          status: "$taskInfo.status",
          createdDate: "$taskInfo.createdDate",
          createdAt: "$taskInfo.createdAt"
        }
      }
    });

    const combined = await DailyWorkUpdate.aggregate(dailyPipeline);

    combined.forEach(item => {
      const isTaskPhase = Boolean(item.task && item.task._id && item.task._id !== "standalone" && (item.phaseId || item.referenceId));
      if (isTaskPhase && item.task && Array.isArray(item.task.phases) && item.task.phases.length > 0) {
        const matched = item.task.phases.find(p =>
          (p._id && (p._id.toString() === item.phaseId?.toString() || p._id.toString() === item.referenceId?.toString())) ||
          (p.phaseTitle && p.phaseTitle.trim().toLowerCase() === (item.phase || item.title || "").trim().toLowerCase())
        );
        if (matched && matched.workingDays !== undefined) {
          item.phaseWorkingDays = matched.workingDays;
        } else if (item.task.phases.length === 1 && item.task.phases[0].workingDays !== undefined) {
          item.phaseWorkingDays = item.task.phases[0].workingDays;
        }
      } else {
        item.phaseWorkingDays = null;
      }
      if (isTaskPhase && item.task && item.task._id && item.task._id !== "standalone") {
        item.overallTaskWorkingDays = calculateOverallTaskWorkingDays(item.task);
      } else {
        item.overallTaskWorkingDays = 1;
      }
    });

    // SORT BY DATE
    combined.sort((a, b) => {
      const getLocalDateString = (d) => {
        if (!d) return "";
        const dateObj = new Date(d);
        if (isNaN(dateObj.getTime())) return "";
        return `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;
      };

      const dateStrA = getLocalDateString(a.updateDate);
      const dateStrB = getLocalDateString(b.updateDate);

      if (dateStrA !== dateStrB) {
        return dateStrB.localeCompare(dateStrA);
      }
      return String(b._id || "").localeCompare(String(a._id || ""));
    });

    const totalCount = combined.length;
    let paginatedData = combined;

    if (req.query.page && req.query.limit) {
      const pageNum = parseInt(req.query.page, 10) || 1;
      const limitNum = parseInt(req.query.limit, 10) || 10;
      const startIndex = (pageNum - 1) * limitNum;
      paginatedData = combined.slice(startIndex, startIndex + limitNum);

      return res.json({
        success: true,
        count: totalCount,
        total: totalCount,
        page: pageNum,
        limit: limitNum,
        data: paginatedData
      });
    }

    res.json({
      success: true,
      count: totalCount,
      total: totalCount,
      data: combined
    });
  } catch (error) {
    console.error("GET ALL DAILY UPDATES ERROR:", error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/* ─────────────────────────────────────────────────────────
   GET  /daily-update/meta
   Fetches all unique categories and projects from TaskMeta
───────────────────────────────────────────────────────── */
exports.getWorkUpdateMeta = async (req, res) => {
  try {
    const mappings = await TaskMeta.find().sort({ category: 1 });
    const allCategories = mappings.map(m => m.category);
    const allProjects = Array.from(new Set(mappings.flatMap(m => m.projects))).sort();

    res.json({
      success: true,
      data: {
        categories: allCategories,
        projects: allProjects
      }
    });
  } catch (error) {
    console.error("GET WORK UPDATE META ERROR:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/* ─────────────────────────────────────────────────────────
   GET  /daily-update/standalone-updates
   Fetch StandaloneWorkUpdates by Category, Project, or Employee ID
───────────────────────────────────────────────────────── */
exports.getStandaloneWorkUpdates = async (req, res) => {
  try {
    const { category, project, empId, employeeId } = req.query;
    const resolvedEmpIdParam = employeeId || empId;

    // 1. Build Filters
    const standaloneMatch = {};
    const taskMatch = {};

    if (category) {
      if (category === "Uncategorized") {
        standaloneMatch.$or = [
          { category: { $size: 0 } },
          { category: { $exists: false } },
          { category: null },
          { category: "Uncategorized" }
        ];
        taskMatch.$or = [
          { category: { $size: 0 } },
          { category: { $exists: false } },
          { category: null },
          { category: "Uncategorized" }
        ];
      } else {
        standaloneMatch.category = { $in: [category] };
        taskMatch.category = { $in: [category] };
      }
    }

    if (project) {
      if (project === "Uncategorized") {
        const projFilter = [
          { project: { $size: 0 } },
          { project: { $exists: false } },
          { project: null },
          { project: "Uncategorized" }
        ];
        if (standaloneMatch.$or) {
          standaloneMatch.$and = [{ $or: standaloneMatch.$or }, { $or: projFilter }];
          delete standaloneMatch.$or;
        } else {
          standaloneMatch.$or = projFilter;
        }

        if (taskMatch.$or) {
          taskMatch.$and = [{ $or: taskMatch.$or }, { $or: projFilter }];
          delete taskMatch.$or;
        } else {
          taskMatch.$or = projFilter;
        }
      } else {
        standaloneMatch.project = { $in: [project] };
        taskMatch.project = { $in: [project] };
      }
    }

    // Resolve Employee ID if provided
    let resolvedEmpId = null;
    if (resolvedEmpIdParam) {
      if (mongoose.Types.ObjectId.isValid(resolvedEmpIdParam)) {
        resolvedEmpId = new mongoose.Types.ObjectId(resolvedEmpIdParam);
      } else {
        const employee = await Employee.findOne({ empId: resolvedEmpIdParam });
        if (employee) resolvedEmpId = employee._id;
      }
      if (resolvedEmpId) {
        standaloneMatch.userId = resolvedEmpId;
      }
    }

    // 2. Find IDs and phase IDs of tasks that match category/project
    const matchingTasks = await Task.find(taskMatch).select("_id phases").lean();
    const taskIds = matchingTasks.map(t => t._id);
    const phaseIds = [];
    matchingTasks.forEach(t => {
      if (Array.isArray(t.phases)) {
        t.phases.forEach(p => {
          if (p._id) phaseIds.push(p._id);
        });
      }
    });

    // 3. Fetch All Updates from DailyWorkUpdate (Consolidated source)
    const hasCategoryOrProject = Boolean(category || project);
    let queryFilter = {};

    if (hasCategoryOrProject) {
      const orConditions = [];
      if (taskIds.length > 0) {
        orConditions.push({ task: { $in: taskIds } });
      }
      if (phaseIds.length > 0) {
        orConditions.push({ $or: [{ phaseId: { $in: phaseIds } }, { referenceId: { $in: phaseIds } }] });
      }
      if (Object.keys(standaloneMatch).length > 0) {
        orConditions.push(standaloneMatch);
      }
      queryFilter = orConditions.length > 0 ? { $or: orConditions } : {};
    }

    if (resolvedEmpId) {
      queryFilter.userId = resolvedEmpId;
    }

    const updates = await DailyWorkUpdate.find(queryFilter)
      .populate("task", "taskTitle taskDetails category project workType pages workingDays phases status")
      .populate("userId", "name email empId photo")
      .lean();

    const getCachedSignedUrl = require("../utilities/s3CachedUrl");

    // 4. Format into Unified Response
    const formattedData = await Promise.all(
      updates.map(async (d) => {
        let photo = d.userId?.photo || null;
        if (photo && photo !== "avatar.png" && !photo.startsWith("http://") && !photo.startsWith("https://")) {
          try {
            photo = await getCachedSignedUrl(photo);
          } catch (err) {
            console.error("Error resolving S3 signed URL for photo:", err);
          }
        }

        const targetPhaseId = d.phaseId || d.referenceId;
        const matchingPhase = Array.isArray(d.task?.phases) && targetPhaseId
          ? d.task.phases.find(p => String(p._id) === String(targetPhaseId))
          : null;

        const phaseWorkingDays = (matchingPhase && matchingPhase.workingDays !== undefined)
          ? matchingPhase.workingDays
          : null;

        return {
          _id: d._id,
          task_id: d.task?._id || (d.task ? d.task : null),
          phaseId: d.task ? (d.phaseId || d.referenceId || null) : null,
          referenceId: d.task ? (d.referenceId || null) : null,
          type: d.task ? "formal_task" : "standalone",
          displayTitle: d.task?.taskTitle || d.title || "Untitled Work",
          details: d.task?.taskDetails || d.description,
          category: d.task?.category || d.category || "",
          project: d.task?.project || d.project || "",
          workType: d.workType || d.task?.workType || "",
          pages: (d.pages && d.pages.length > 0) ? d.pages : (d.task?.pages || []),
          phase: d.title,
          phaseStatus: d.status,
          workingDays: phaseWorkingDays !== null ? phaseWorkingDays : (d.task?.workingDays || null),
          taskWorkingDays: d.task?.workingDays || null,
          note: d.description || "",
          description: d.description || "",
          employeeDetails: d.userId ? { ...d.userId, photo } : null,
          completionDate: d.updateDate || d.createdAt,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt
        };
      })
    );

    formattedData.sort((a, b) => new Date(b.completionDate) - new Date(a.completionDate));

    // Fetch company holidays
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
      console.error("Error fetching holidays in getStandaloneWorkUpdates:", hErr);
    }

    // Fetch employee leave / absent dates
    const leavesByEmp = {};
    try {
      const Attendance = require("../Models/Attendance.model");
      const userIds = updates.map((u) => u.userId?._id).filter(Boolean);
      if (userIds.length > 0) {
        const atts = await Attendance.find({
          employeeId: { $in: userIds },
          status: { $in: ["Absent", "Leave", "On Leave"] },
        }).lean();
        atts.forEach((a) => {
          const eid = String(a.employeeId);
          if (!leavesByEmp[eid]) leavesByEmp[eid] = [];
          if (a.date) leavesByEmp[eid].push(a.date);
        });
      }
    } catch (aErr) {
      console.error("Error fetching attendance in getStandaloneWorkUpdates:", aErr);
    }

    res.json({
      success: true,
      count: formattedData.length,
      data: formattedData,
      holidays: holidaysList,
      leavesByEmp: leavesByEmp,
    });

  } catch (error) {
    console.error("GET CONSOLIDATED WORK UPDATES ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching work history",
      error: error.message
    });
  }
};

/* ─────────────────────────────────────────────────────────
   GET  /daily-update/report-by-meta
   Unified report: Fetch tasks and updates by Category & Project
   Provides data on: Which task, which employee, and when completed/updated
───────────────────────────────────────────────────────── */
exports.getWorkByMetadata = async (req, res) => {
  try {
    const { category, project, startDate, endDate } = req.query;

    if (!category || !project) {
      return res.status(400).json({
        success: false,
        message: "Please provide both category and project parameters"
      });
    }

    // 1. Find Tasks matching category/project
    const matchingTasks = await Task.find({
      category: { $in: [category] },
      project: { $in: [project] }
    }).populate("assignedMembers", "name photo empId").lean();

    const taskIds = matchingTasks.map(t => t._id);

    // 2. Fetch all Work Updates matching the criteria
    const updateFilter = {
      $or: [
        { task: { $in: taskIds } },
        { category: category, project: project }
      ]
    };

    if (startDate || endDate) {
      updateFilter.updateDate = {};
      if (startDate) updateFilter.updateDate.$gte = new Date(startDate);
      if (endDate) updateFilter.updateDate.$lte = new Date(endDate);
    }

    const updates = await DailyWorkUpdate.find(updateFilter)
      .populate("task", "taskTitle taskDetails category project")
      .populate("userId", "name photo empId")
      .lean();

    const getCachedSignedUrl = require("../utilities/s3CachedUrl");

    // 3. Format Consolidated Results
    const results = await Promise.all(
      updates.map(async (u) => {
        let photo = u.userId?.photo || null;
        if (photo && photo !== "avatar.png" && !photo.startsWith("http://") && !photo.startsWith("https://")) {
          try {
            photo = await getCachedSignedUrl(photo);
          } catch (err) {
            console.error("Error resolving S3 signed URL for photo:", err);
          }
        }
        return {
          _id: u._id,
          source: u.task ? "Task Update" : "Standalone Update",
          taskTitle: u.task?.taskTitle || u.title || "N/A",
          details: u.task?.taskDetails || u.description || "",
          employees: u.userId ? [{
            id: u.userId._id,
            name: u.userId.name,
            empId: u.userId.empId,
            photo: photo
          }] : [],
          completionTime: u.updateDate || u.createdAt,
          status: u.status || "pending",
          phaseTitle: u.title,
          phaseDescription: u.description
        };
      })
    );

    results.sort((a, b) => new Date(b.completionTime) - new Date(a.completionTime));

    res.json({
      success: true,
      metadata: { category, project },
      count: results.length,
      data: results
    });
  } catch (error) {
    console.error("GET WORK BY META ERROR:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching aggregated work data",
      error: error.message
    });
  }
};

/* ─────────────────────────────────────────────────────────
   GET  /daily-update/employee/history
   Returns formatted updates with Date, Category / Project, Task Title, Description
───────────────────────────────────────────────────────── */
exports.getEmployeeDailyWorkUpdates = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const updates = await DailyWorkUpdate.find({ userId: userId }).sort({ updateDate: -1 });

    const formattedData = updates.map(u => ({
      _id: u._id,
      date: u.updateDate || u.createdAt,
      category: u.category || "N/A",
      project: u.project || "N/A",
      pages: u.pages || [],
      categoryProject: `${u.category || "N/A"} / ${u.project || "N/A"}`,
      taskTitle: u.title || "N/A",
      description: u.description || ""
    }));

    res.json({
      success: true,
      count: formattedData.length,
      data: formattedData
    });
  } catch (error) {
    console.error("GET EMPLOYEE HISTORY ERROR:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/* ─────────────────────────────────────────────────────────
   DELETE /daily-update/:id
───────────────────────────────────────────────────────── */
exports.deleteWorkUpdate = async (req, res) => {
  try {
    const { id } = req.params;
    const requesterId = req.user?.id || req.user?._id;
    const isAdmin = req.user?.role === "admin";
    const query = isAdmin ? { _id: id } : { _id: id, userId: requesterId };

    const entry = await DailyWorkUpdate.findOne(query);

    if (!entry) {
      return res.status(404).json({ success: false, message: "Work update not found or unauthorized" });
    }

    const linkedPhaseId = entry.phaseId || entry.referenceId;
    await DailyWorkUpdate.findByIdAndDelete(id);

    if (linkedPhaseId) {
      const parentTask = await Task.findOne({ "phases._id": linkedPhaseId });
      if (parentTask) {
        await syncTaskWorkingDays(parentTask._id);
      }
    }

    res.json({ success: true, message: "Work update deleted successfully" });
  } catch (error) {
    console.error("DELETE UPDATE ERROR:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};
