const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const DailyWorkUpdate = require('./Models/Dailyworkupdate');
const Task = require('./Models/task.model');

const MONGO_URI =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  process.env.DATABASE_URL ||
  'mongodb://localhost:27017/HRMS';

async function updateOldWorkUpdatesToNewLogic() {
  console.log('=====================================================');
  console.log('  HRMS Work Update & Task Old Data Migration Script   ');
  console.log('=====================================================\n');

  try {
    console.log(`Connecting to MongoDB...`);
    await mongoose.connect(MONGO_URI);
    console.log('MongoDB connected successfully.\n');

    // 1. Fetch all Tasks and collect all valid phase IDs
    const allTasks = await Task.find();
    const validPhaseMap = new Map(); // phaseId string -> { taskId, taskTitle, phase }

    allTasks.forEach(task => {
      (task.phases || []).forEach(phase => {
        if (phase._id) {
          validPhaseMap.set(phase._id.toString(), {
            taskId: task._id,
            taskTitle: task.taskTitle,
            phase
          });
        }
      });
    });

    console.log(`Found ${allTasks.length} tasks with ${validPhaseMap.size} valid phases.\n`);

    // 2. Fetch all DailyWorkUpdate records
    const allUpdates = await DailyWorkUpdate.find();
    console.log(`Found ${allUpdates.length} DailyWorkUpdate records to process.\n`);

    let fixedPhaseFromRef = 0;
    let removedDummyRefFromStandalone = 0;
    let cleanedEmptyFieldsCount = 0;

    // Step 2A: Identify and fix phaseId vs standalone dummy referenceId
    for (const update of allUpdates) {
      const pIdStr = update.phaseId ? update.phaseId.toString() : null;
      const rIdStr = update.referenceId ? update.referenceId.toString() : null;

      const isPhaseValid = pIdStr && validPhaseMap.has(pIdStr);
      const isRefValidPhase = rIdStr && validPhaseMap.has(rIdStr);

      const updateOps = {};
      const unsetOps = {};

      // Case 1: Old Task record where phaseId was missing/null and stored in referenceId
      if (!isPhaseValid && isRefValidPhase) {
        updateOps.phaseId = new mongoose.Types.ObjectId(rIdStr);
        unsetOps.referenceId = '';
        fixedPhaseFromRef++;
        console.log(`[FIX PHASE_ID] Update "${update.title}" (_id: ${update._id}) -> phaseId set to ${rIdStr}`);
      }

      // Case 2: Standalone record with dummy referenceId or dummy phaseId
      if (!isPhaseValid && !isRefValidPhase) {
        if (rIdStr) {
          unsetOps.referenceId = '';
          removedDummyRefFromStandalone++;
          console.log(`[CLEAN STANDALONE] Removed dummy referenceId "${rIdStr}" from "${update.title}" (_id: ${update._id})`);
        }
        if (pIdStr) {
          unsetOps.phaseId = '';
          console.log(`[CLEAN STANDALONE] Removed invalid phaseId "${pIdStr}" from "${update.title}" (_id: ${update._id})`);
        }
      }

      // Case 3: Remove empty / null fields in DailyWorkUpdate
      if (update.workType === '' || update.workType === null) {
        unsetOps.workType = '';
      }
      if (Array.isArray(update.pages) && update.pages.length === 0) {
        unsetOps.pages = '';
      }
      if (update.task !== undefined) {
        unsetOps.task = '';
      }

      // Execute update if any changes needed
      const mongoUpdate = {};
      if (Object.keys(updateOps).length > 0) mongoUpdate.$set = updateOps;
      if (Object.keys(unsetOps).length > 0) {
        mongoUpdate.$unset = unsetOps;
        cleanedEmptyFieldsCount++;
      }

      if (Object.keys(mongoUpdate).length > 0) {
        await DailyWorkUpdate.collection.updateOne({ _id: update._id }, mongoUpdate);
      }
    }

    // Step 2B: Stable referenceId management for Task phases
    // Reload updates to get current state
    const refreshedUpdates = await DailyWorkUpdate.find({ phaseId: { $exists: true, $ne: null } });
    const phaseGroupMap = new Map();

    refreshedUpdates.forEach(u => {
      const pKey = u.phaseId.toString();
      if (!phaseGroupMap.has(pKey)) {
        phaseGroupMap.set(pKey, []);
      }
      phaseGroupMap.get(pKey).push(u);
    });

    let stableRefManagedPhases = 0;

    for (const [phaseKey, records] of phaseGroupMap.entries()) {
      // Check distinct calendar dates
      const distinctDates = new Set(
        records.map(r => (r.updateDate ? new Date(r.updateDate).toISOString().split('T')[0] : ''))
      );

      if (records.length > 1 && distinctDates.size > 1) {
        // Multiple records across different calendar dates: ensure single stable referenceId
        const existingRef = records.find(r => r.referenceId && mongoose.Types.ObjectId.isValid(r.referenceId.toString()));
        const sharedRefId = existingRef ? existingRef.referenceId : new mongoose.Types.ObjectId();

        await DailyWorkUpdate.collection.updateMany(
          { phaseId: new mongoose.Types.ObjectId(phaseKey) },
          { $set: { referenceId: sharedRefId } }
        );
        stableRefManagedPhases++;
        console.log(`[STABLE REFERENCE_ID] Linked ${records.length} history records for phase "${phaseKey}" with refId: ${sharedRefId}`);
      } else {
        // Single record or same date: no separate referenceId is needed
        await DailyWorkUpdate.collection.updateMany(
          { phaseId: new mongoose.Types.ObjectId(phaseKey) },
          { $unset: { referenceId: '' } }
        );
      }
    }

    // Step 3: Clean empty fields in Task model
    let tasksCleaned = 0;
    for (const task of allTasks) {
      let taskNeedsUpdate = false;
      const taskUnset = {};

      if (task.workType === '' || task.workType === null) {
        taskUnset.workType = '';
        taskNeedsUpdate = true;
      }
      if (Array.isArray(task.pages) && task.pages.length === 0) {
        taskUnset.pages = '';
        taskNeedsUpdate = true;
      }

      // Check phases within task
      let phasesModified = false;
      const cleanedPhases = (task.phases || []).map(phase => {
        let pObj = phase.toObject ? phase.toObject() : { ...phase };
        if (pObj.workType === '' || pObj.workType === null) {
          delete pObj.workType;
          phasesModified = true;
        }
        if (Array.isArray(pObj.pages) && pObj.pages.length === 0) {
          delete pObj.pages;
          phasesModified = true;
        }
        return pObj;
      });

      const taskUpdateObj = {};
      if (taskNeedsUpdate && Object.keys(taskUnset).length > 0) {
        taskUpdateObj.$unset = taskUnset;
      }
      if (phasesModified) {
        taskUpdateObj.$set = { phases: cleanedPhases };
      }

      if (Object.keys(taskUpdateObj).length > 0) {
        await Task.collection.updateOne({ _id: task._id }, taskUpdateObj);
        tasksCleaned++;
      }
    }

    console.log('\n=====================================================');
    console.log('                  MIGRATION SUMMARY                  ');
    console.log('=====================================================');
    console.log(`  Task updates with phaseId restored from refId:   ${fixedPhaseFromRef}`);
    console.log(`  Standalone updates cleaned of dummy referenceId: ${removedDummyRefFromStandalone}`);
    console.log(`  DailyWorkUpdate docs cleaned of empty fields:    ${cleanedEmptyFieldsCount}`);
    console.log(`  Task phases linked with stable referenceId:      ${stableRefManagedPhases}`);
    console.log(`  Task documents cleaned of empty fields:          ${tasksCleaned}`);
    console.log('=====================================================\n');
    console.log('SUCCESS: All old database records updated to the new logic!\n');

  } catch (error) {
    console.error('MIGRATION ERROR:', error);
  } finally {
    await mongoose.disconnect();
    console.log('MongoDB disconnected.');
  }
}

if (require.main === module) {
  updateOldWorkUpdatesToNewLogic().then(() => process.exit(0)).catch(() => process.exit(1));
}

module.exports = updateOldWorkUpdatesToNewLogic;
