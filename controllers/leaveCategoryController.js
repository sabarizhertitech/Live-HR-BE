const LeaveCategory = require("../Models/LeaveCategory");
const Employee = require("../Models/Employee");
const LeaveRequest = require("../Models/LeaveRequest");
const LeaveBalance = require("../Models/LeaveBalance");
const mongoose = require("mongoose");
const Notification = require("../Models/Notification");
const {
  getCurrentFinancialYear,
  calculateServiceMonths,
  calculateCategoryLeaves,
} = require("../utilities/financialYearUtil");
const { isEmployeeInProbation } = require("../utilities/probationHelper");
const { validateAndProcessTiers } = require("../utilities/leaveValidationHelper");
const {
  isAnnualLeaveCategory,
  isMatchingDeductCategory,
  getPermissionConfig,
  getBulkPermissionDeductions,
} = require("../utilities/permissionLeaveUtil");

const leaveCategoryController = {
  // Get all categories for a specific financial year
  getAllCategories: async (req, res) => {
    try {
      const year = req.query.year || getCurrentFinancialYear();
      let doc = await LeaveCategory.findOne({ financialYear: year }).lean();
      if (doc && doc.categories && doc.categories.length > 0 && doc.isReviewed && doc.status === "pending") {
        await LeaveCategory.updateOne(
          { _id: doc._id },
          { $set: { status: "approved", approvedDate: doc.approvedDate || new Date() } }
        );
        doc.status = "approved";
        doc.approvedDate = doc.approvedDate || new Date();
      }
      const categories = doc ? doc.categories : [];
      return res.status(200).json({
        success: true,
        data: categories,
        status: doc ? doc.status || (doc.isReviewed ? "approved" : "pending") : "pending",
        isReviewed: doc ? doc.isReviewed : false,
        adminRemarks: doc ? doc.adminRemarks || "" : "",
        financialYear: year,
        submittedDate: doc?.submittedDate,
        approvedDate: doc?.approvedDate,
      });
    } catch (err) {
      console.error("Error fetching leave categories:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // Helper to get target financial year for reminders / banners
  getTargetFinancialYear: async () => {
    const today = new Date();
    const month = today.getMonth(); // 0: Jan, 1: Feb, 2: Mar, 3: Apr ... 11: Dec
    const year = today.getFullYear();

    // Current financial year:
    const currentFY = month >= 3 ? `${year}-${year + 1}` : `${year - 1}-${year}`;

    // Check if current FY has an approved LeaveCategory doc:
    const currentDoc = await LeaveCategory.findOne({ financialYear: currentFY });
    const isCurrentApproved = currentDoc && (currentDoc.status === "approved" || currentDoc.isReviewed === true || (currentDoc.categories && currentDoc.categories.length > 0 && currentDoc.status !== "rejected"));

    // If current FY is not approved, target is current FY
    if (!isCurrentApproved) {
      return currentFY;
    }

    // If current FY is approved, check if we are in March (month === 2) preparing for next FY:
    if (month === 2) {
      const upcomingFY = `${year}-${year + 1}`;
      const upcomingDoc = await LeaveCategory.findOne({ financialYear: upcomingFY });
      const isUpcomingApproved = upcomingDoc && (upcomingDoc.status === "approved" || upcomingDoc.isReviewed === true || (upcomingDoc.categories && upcomingDoc.categories.length > 0 && upcomingDoc.status !== "rejected"));
      if (!isUpcomingApproved) {
        return upcomingFY;
      }
    }

    return currentFY;
  },

  // Admin banner alert endpoint
  getUnassignedYearAlert: async (req, res) => {
    try {
      const targetFY = await leaveCategoryController.getTargetFinancialYear();
      let doc = await LeaveCategory.findOne({ financialYear: targetFY });

      if (doc && doc.categories && doc.categories.length > 0 && (doc.isReviewed || doc.status === "pending")) {
        if (doc.status === "pending" && doc.isReviewed) {
          doc.status = "approved";
          doc.approvedDate = doc.approvedDate || new Date();
          await doc.save();
        }
      }

      if (!doc || !doc.categories || doc.categories.length === 0) {
        return res.status(200).json({
          success: true,
          showAlert: true,
          year: targetFY,
          status: "pending",
          title: `Leave Categories Not Uploaded for FY ${targetFY}`,
          message: `The leave categories are not uploaded for FY ${targetFY}. Send reminder to HR to upload the leave categories.`,
        });
      }

      if (doc.status === "submitted") {
        return res.status(200).json({
          success: true,
          showAlert: true,
          year: targetFY,
          status: "submitted",
          title: `Leave Categories Submitted for Approval (FY ${targetFY})`,
          message: `HR has submitted the FY ${targetFY} leave categories for review. Please review and approve them.`,
        });
      }

      if (doc.status === "approved" || doc.isReviewed || (doc.categories && doc.categories.length > 0 && doc.status !== "rejected")) {
        return res.status(200).json({
          success: true,
          showAlert: false,
          year: targetFY,
          status: "approved",
        });
      }

      return res.status(200).json({
        success: true,
        showAlert: false,
        year: targetFY,
        status: doc.status || "approved",
      });
    } catch (err) {
      console.error("Error in getUnassignedYearAlert for leave categories:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // HR banner alert endpoint
  getHRPendingAlert: async (req, res) => {
    try {
      if (!req.user || (req.user.role !== "admin" && !req.user.isHr)) {
        return res.status(200).json({ success: true, showAlert: false });
      }

      const targetFY = await leaveCategoryController.getTargetFinancialYear();
      const doc = await LeaveCategory.findOne({ financialYear: targetFY });

      if (!doc || !doc.categories || doc.categories.length === 0) {
        return res.status(200).json({
          success: true,
          showAlert: true,
          year: targetFY,
          status: "pending",
          title: `Upload Leave Categories for FY ${targetFY}`,
          message: `The leave categories are not uploaded for FY ${targetFY}. Please configure and submit for Admin approval.`,
        });
      }

      if (doc.status === "rejected") {
        return res.status(200).json({
          success: true,
          showAlert: true,
          year: targetFY,
          status: "rejected",
          title: `Action Required: Changes Requested for FY ${targetFY} Leave Categories`,
          message: doc.adminRemarks
            ? `Admin requested changes: "${doc.adminRemarks}". Please review and update.`
            : `Admin has requested changes for FY ${targetFY} leave categories. Please update and re-submit.`,
        });
      }

      return res.status(200).json({
        success: true,
        showAlert: false,
        year: targetFY,
        status: doc.status || "approved",
      });
    } catch (err) {
      console.error("Error in getHRPendingAlert for leave categories:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // Send Reminder to HR
  sendHRReminder: async (req, res) => {
    try {
      const year = req.body.year || await leaveCategoryController.getTargetFinancialYear();

      const hrUsers = await Employee.find({
        isHr: true,
        employmentStatus: "active",
      }).select("_id name email");

      if (hrUsers.length === 0) {
        return res.status(200).json({
          success: true,
          message: `Reminder recorded for FY ${year}.`,
        });
      }

      const notifications = hrUsers.map((hr) => ({
        type: "SYSTEM_REMINDER",
        toEmployee: hr._id,
        toAdmin: false,
        title: `Reminder: Upload Leave Categories for FY ${year}`,
        message: `Admin has requested you to configure and upload the leave categories for the upcoming financial year ${year}. Please configure and submit for approval.`,
        metadata: { requestType: "SYSTEM", financialYear: year },
      }));

      await Notification.insertMany(notifications);

      return res.status(200).json({
        success: true,
        message: `Reminder sent to ${hrUsers.length} HR member(s) to upload FY ${year} leave categories!`,
      });
    } catch (err) {
      console.error("Error sending leave category reminder to HR:", err);
      return res.status(500).json({ success: false, message: "Server error sending reminder" });
    }
  },

  // Submit Leave Categories for Admin Approval
  submitToAdmin: async (req, res) => {
    try {
      const year = req.body.year || getCurrentFinancialYear();
      const doc = await LeaveCategory.findOne({ financialYear: year });

      if (!doc || !doc.categories || doc.categories.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Cannot submit empty leave categories. Please add at least one category before submitting to Admin.",
        });
      }

      doc.status = "submitted";
      doc.submittedBy = req.user._id;
      doc.submittedDate = new Date();
      doc.adminRemarks = "";
      await doc.save();

      const admins = await Employee.find({ role: "admin", employmentStatus: "active" }).select("_id");
      if (admins.length > 0) {
        const notifs = admins.map((a) => ({
          type: "SYSTEM_REMINDER",
          toEmployee: a._id,
          toAdmin: true,
          title: `Leave Categories Submitted for FY ${year}`,
          message: `HR has submitted the leave categories for FY ${year} for review and approval.`,
          metadata: { requestType: "SYSTEM", financialYear: year },
        }));
        await Notification.insertMany(notifs);
      }

      return res.status(200).json({
        success: true,
        message: `Leave categories for FY ${year} submitted to Admin for approval!`,
        data: doc,
      });
    } catch (err) {
      console.error("Error submitting leave categories to Admin:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // Approve Leave Categories for FY
  approveYear: async (req, res) => {
    try {
      if (req.user.role !== "admin") {
        return res.status(403).json({ success: false, message: "Admin access required" });
      }

      const year = req.body.year || getCurrentFinancialYear();
      const doc = await LeaveCategory.findOne({ financialYear: year });

      if (!doc) {
        return res.status(404).json({ success: false, message: "Leave categories not found for this financial year" });
      }

      doc.status = "approved";
      doc.isReviewed = true;
      doc.approvedBy = req.user._id;
      doc.approvedDate = new Date();
      doc.adminRemarks = "";
      await doc.save();

      if (doc.categories && doc.categories.length > 0) {
        const employees = await Employee.find({
          employmentStatus: "active",
          status: { $ne: "relieved" },
          role: { $ne: "admin" },
          isDeleted: { $ne: true },
        })
          .select("_id dateJoined dateRelieved createdAt isProbation probationPeriod probationPeriodMonths")
          .lean();
        const leaveBalDocs = await LeaveBalance.find({ employeeId: { $in: employees.map(e => e._id) } }).lean();
        const balMap = {};
        leaveBalDocs.forEach(b => { balMap[b.employeeId.toString()] = b.leaveBalances || {}; });

        const permConfig = await getPermissionConfig();
        const bulkPermDeductions = await getBulkPermissionDeductions(employees.map(e => e._id), year);
        const alCat = doc.categories.find(c => isMatchingDeductCategory(c.name, permConfig.deductCategoryName)) ||
          doc.categories.find(c => isAnnualLeaveCategory(c.name));

        const currentDate = new Date();
        const bulkOps = employees.map((emp) => {
          const joiningDate = emp.dateJoined || emp.createdAt;
          const inProbation = isEmployeeInProbation(emp);
          const serviceMonths = calculateServiceMonths(joiningDate, currentDate);
          const existingBalances = balMap[emp._id.toString()] || {};
          const yearBalances = { ...(existingBalances[year] || {}) };
          const empPermDays = bulkPermDeductions[emp._id.toString()] || 0;

          doc.categories.forEach((cat) => {
            if (!cat || !cat.name) return;
            const allowedLeaves = calculateCategoryLeaves(cat, serviceMonths, inProbation);
            const existingCatBalance = yearBalances[cat.name] || {};
            let used = existingCatBalance.used || 0;

            if (alCat && cat.name === alCat.name && empPermDays > 0) {
              const regularUsed = existingCatBalance.regularUsed !== undefined
                ? existingCatBalance.regularUsed
                : (existingCatBalance.permissionDeducted !== undefined
                    ? Math.max(0, used - existingCatBalance.permissionDeducted)
                    : used);
              const availableAL = Math.max(0, allowedLeaves - regularUsed);
              const deductedFromAL = Math.min(availableAL, empPermDays);
              used = regularUsed + deductedFromAL;
              yearBalances[cat.name] = {
                total: allowedLeaves,
                used: used,
                remaining: Math.max(0, allowedLeaves - used),
                regularUsed,
                permissionDeducted: deductedFromAL,
              };
            } else {
              yearBalances[cat.name] = {
                total: allowedLeaves,
                used: used,
                remaining: Math.max(0, allowedLeaves - used),
              };
            }
          });

          return {
            updateOne: {
              filter: { employeeId: emp._id },
              update: { $set: { [`leaveBalances.${year}`]: yearBalances } },
              upsert: true,
            },
          };
        });

        if (bulkOps.length > 0) {
          await LeaveBalance.bulkWrite(bulkOps);
        }
      }

      const hrUsers = await Employee.find({ isHr: true, employmentStatus: "active" }).select("_id");
      if (hrUsers.length > 0) {
        const notifs = hrUsers.map((hr) => ({
          type: "SYSTEM_REMINDER",
          toEmployee: hr._id,
          toAdmin: false,
          title: `Leave Categories Approved for FY ${year}`,
          message: `Admin has approved the leave categories for FY ${year}.`,
          metadata: { requestType: "SYSTEM", financialYear: year },
        }));
        await Notification.insertMany(notifs);
      }

      return res.status(200).json({
        success: true,
        message: `Leave categories for FY ${year} approved successfully!`,
        data: doc,
      });
    } catch (err) {
      console.error("Error approving leave categories:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // Reject Leave Categories for FY with remarks
  rejectYear: async (req, res) => {
    try {
      if (req.user.role !== "admin") {
        return res.status(403).json({ success: false, message: "Admin access required" });
      }

      const { year, remarks } = req.body;
      const targetYear = year || getCurrentFinancialYear();
      const doc = await LeaveCategory.findOne({ financialYear: targetYear });

      if (!doc) {
        return res.status(404).json({ success: false, message: "Leave categories not found for this financial year" });
      }

      doc.status = "rejected";
      doc.adminRemarks = remarks || "Changes requested by Admin";
      await doc.save();

      const hrUsers = await Employee.find({ isHr: true, employmentStatus: "active" }).select("_id");
      if (hrUsers.length > 0) {
        const notifs = hrUsers.map((hr) => ({
          type: "SYSTEM_REMINDER",
          toEmployee: hr._id,
          toAdmin: false,
          title: `Changes Requested for FY ${targetYear} Leave Categories`,
          message: `Admin requested changes: "${remarks || 'Please update and re-submit'}".`,
          metadata: { requestType: "SYSTEM", financialYear: targetYear },
        }));
        await Notification.insertMany(notifs);
      }

      return res.status(200).json({
        success: true,
        message: `Leave categories for FY ${targetYear} rejected with feedback.`,
        data: doc,
      });
    } catch (err) {
      console.error("Error rejecting leave categories:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // Initialize draft for FY
  initDraft: async (req, res) => {
    try {
      const year = req.body.year || getCurrentFinancialYear();
      let doc = await LeaveCategory.findOne({ financialYear: year });

      if (!doc) {
        const prevFinancialYear = `${parseInt(year.split("-")[0]) - 1}-${parseInt(year.split("-")[0])}`;
        const prevYearDoc = await LeaveCategory.findOne({ financialYear: prevFinancialYear });
        const categoriesToCopy = prevYearDoc
          ? prevYearDoc.categories.map((c) => ({
              name: c.name,
              leaveCount: c.leaveCount,
              eligibleMonths: c.eligibleMonths,
              probationOthersLeaveCount: c.probationOthersLeaveCount || 0,
              permanentOthersLeaveCount: c.permanentOthersLeaveCount || 0,
              tiers: c.tiers ? c.tiers.map((t) => ({ ...t.toObject() })) : [],
            }))
          : [];

        doc = new LeaveCategory({
          financialYear: year,
          categories: categoriesToCopy,
          status: "pending",
          isReviewed: false,
        });
        await doc.save();
      }

      return res.status(200).json({
        success: true,
        message: `Initialized leave category draft for FY ${year}`,
        data: doc,
      });
    } catch (err) {
      console.error("Error initializing leave category draft:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // Get Leave Category Review Status
  getReviewStatus: async (req, res) => {
    try {
      const year = req.query.year || getCurrentFinancialYear();

      const doc = await LeaveCategory.findOne(
        { financialYear: year },
        { isReviewed: 1, status: 1 }
      );

      return res.status(200).json({
        success: true,
        isReviewed: doc ? (doc.isReviewed || doc.status === "approved") : false,
        status: doc ? doc.status : "pending",
      });
    } catch (err) {
      console.error("Error getting review status:", err);

      return res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  },

  // Create a new category under a specific financial year
  createCategory: async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    let savedCategory = null;
    let targetYear = "";

    try {
      if (req.user.role !== "admin" && !req.user.isHr) {
        await session.abortTransaction();
        session.endSession();
        return res.status(403).json({ success: false, message: "Access denied" });
      }

      const { name, tiers, year, probationOthersLeaveCount, permanentOthersLeaveCount } = req.body;
      targetYear = year || getCurrentFinancialYear();

      if (!name || !name.trim()) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ success: false, message: "Category name is required" });
      }

      const trimmedName = name.trim();

      // Validate tiers
      const validation = validateAndProcessTiers(tiers);
      if (!validation.isValid) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ success: false, message: validation.error });
      }

      const processedTiers = validation.processedTiers;

      // Find or create document for target financial year
      let doc = await LeaveCategory.findOne({ financialYear: targetYear }).session(session);
      if (!doc) {
        doc = new LeaveCategory({
          financialYear: targetYear,
          categories: []
        });
      }

      // Check if category name already exists for this year (reject duplicate creation)
      const existingCatIdx = doc.categories.findIndex(
        (cat) => cat.name.toLowerCase() === trimmedName.toLowerCase()
      );

      if (existingCatIdx !== -1) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: `Leave category "${trimmedName}" already exists for financial year ${targetYear}. Please use Edit to update it.`
        });
      }

      processedTiers.sort((a, b) => (b.eligibleMonths || 0) - (a.eligibleMonths || 0));
      const newCategory = {
        name: trimmedName,
        tiers: processedTiers,
        probationOthersLeaveCount: Number(probationOthersLeaveCount) || 0,
        permanentOthersLeaveCount: Number(permanentOthersLeaveCount) || 0,
      };
      doc.categories.push(newCategory);
      savedCategory = newCategory;

      doc.isReviewed = true;
      doc.status = "approved";
      doc.approvedDate = new Date();
      await doc.save({ session });

      await Notification.deleteMany({
        type: "SYSTEM_REMINDER",
        "metadata.financialYear": targetYear
      }).session(session);

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error("Error creating leave category:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    } finally {
      session.endSession();
    }

    // Update active employees' balances outside transaction for optimal locks/performance
    try {
      const employees = await Employee.find({
        employmentStatus: "active",
        status: { $ne: "relieved" },
        role: { $ne: "admin" },
        isDeleted: { $ne: true },
      })
        .select("_id dateJoined dateRelieved createdAt isProbation probationPeriod probationPeriodMonths")
        .lean();
      const leaveBalDocs = await LeaveBalance.find({ employeeId: { $in: employees.map(e => e._id) } }).lean();
      const balMap = {};
      leaveBalDocs.forEach(b => { balMap[b.employeeId.toString()] = b.leaveBalances || {}; });

      const permConfig = await getPermissionConfig();
      const isAl = isMatchingDeductCategory(savedCategory.name, permConfig.deductCategoryName) || isAnnualLeaveCategory(savedCategory.name);
      const bulkPermDeductions = isAl
        ? await getBulkPermissionDeductions(employees.map(e => e._id), targetYear)
        : {};

      const currentDate = new Date();

      const bulkOps = employees.map(emp => {
        const joiningDate = emp.dateJoined || emp.createdAt;
        const inProbation = isEmployeeInProbation(emp);
        const serviceMonths = calculateServiceMonths(joiningDate, currentDate);
        const allowedLeaves = calculateCategoryLeaves(savedCategory, serviceMonths, inProbation);

        const balances = balMap[emp._id.toString()] || {};
        const yearBalances = { ...(balances[targetYear] || {}) };
        const existingCatBalance = yearBalances[savedCategory.name] || {};
        let used = existingCatBalance.used || 0;

        if (isAl) {
          const empPermDays = bulkPermDeductions[emp._id.toString()] || 0;
          if (empPermDays > 0) {
            const regularUsed = existingCatBalance.regularUsed !== undefined
              ? existingCatBalance.regularUsed
              : (existingCatBalance.permissionDeducted !== undefined
                  ? Math.max(0, used - existingCatBalance.permissionDeducted)
                  : used);
            const availableAL = Math.max(0, allowedLeaves - regularUsed);
            const deductedFromAL = Math.min(availableAL, empPermDays);
            used = regularUsed + deductedFromAL;
            yearBalances[savedCategory.name] = {
              total: allowedLeaves,
              used: used,
              remaining: Math.max(0, allowedLeaves - used),
              regularUsed,
              permissionDeducted: deductedFromAL,
            };
          } else {
            yearBalances[savedCategory.name] = {
              total: allowedLeaves,
              used: used,
              remaining: Math.max(0, allowedLeaves - used)
            };
          }
        } else {
          yearBalances[savedCategory.name] = {
            total: allowedLeaves,
            used: used,
            remaining: Math.max(0, allowedLeaves - used)
          };
        }

        return {
          updateOne: {
            filter: { employeeId: emp._id },
            update: { $set: { [`leaveBalances.${targetYear}`]: yearBalances } },
            upsert: true
          }
        };
      });

      if (bulkOps.length > 0) {
        await LeaveBalance.bulkWrite(bulkOps);
      }

      return res.status(201).json({
        success: true,
        message: "Leave category created successfully",
        data: savedCategory
      });
    } catch (err) {
      console.error("Error updating employee balances for new category:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // Update a category inside its financial year document
  updateCategory: async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    let updatedCategory = null;
    let oldName = "";
    let trimmedName = "";
    let targetYear = "";

    try {
      if (req.user.role !== "admin" && !req.user.isHr) {
        await session.abortTransaction();
        session.endSession();
        return res.status(403).json({ success: false, message: "Access denied" });
      }

      const { id } = req.params;
      const { name, tiers, probationOthersLeaveCount, permanentOthersLeaveCount } = req.body;

      const doc = await LeaveCategory.findOne({ "categories._id": id }).session(session);
      if (!doc) {
        await session.abortTransaction();
        session.endSession();
        return res.status(404).json({ success: false, message: "Leave category not found" });
      }

      const category = doc.categories.id(id);
      if (!category) {
        await session.abortTransaction();
        session.endSession();
        return res.status(404).json({ success: false, message: "Leave category not found" });
      }

      oldName = category.name;
      targetYear = doc.financialYear;
      trimmedName = name ? name.trim() : category.name;

      if (!trimmedName) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ success: false, message: "Category name cannot be empty" });
      }

      // Check for duplicate name if renamed
      if (trimmedName.toLowerCase() !== oldName.toLowerCase()) {
        const duplicate = doc.categories.some(
          (cat) => cat._id.toString() !== id && cat.name.toLowerCase() === trimmedName.toLowerCase()
        );
        if (duplicate) {
          await session.abortTransaction();
          session.endSession();
          return res.status(400).json({ success: false, message: `Leave category "${trimmedName}" already exists for this year` });
        }
      }

      // Validate tiers
      if (tiers && Array.isArray(tiers)) {
        const validation = validateAndProcessTiers(tiers);
        if (!validation.isValid) {
          await session.abortTransaction();
          session.endSession();
          return res.status(400).json({ success: false, message: validation.error });
        }
        category.tiers = validation.processedTiers.sort((a, b) => (b.eligibleMonths || 0) - (a.eligibleMonths || 0));
      }

      category.name = trimmedName;
      if (probationOthersLeaveCount !== undefined) {
        category.probationOthersLeaveCount = Number(probationOthersLeaveCount) || 0;
      }
      if (permanentOthersLeaveCount !== undefined) {
        category.permanentOthersLeaveCount = Number(permanentOthersLeaveCount) || 0;
      }

      doc.isReviewed = true;
      doc.status = "approved";
      doc.approvedDate = doc.approvedDate || new Date();
      await doc.save({ session });

      await Notification.deleteMany({
        type: "SYSTEM_REMINDER",
        "metadata.financialYear": targetYear
      }).session(session);

      updatedCategory = category;
      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error("Error updating leave category:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    } finally {
      session.endSession();
    }

    // Update existing active employees' balances outside transaction
    try {
      const employees = await Employee.find({
        employmentStatus: "active",
        status: { $ne: "relieved" },
        role: { $ne: "admin" },
        isDeleted: { $ne: true },
      })
        .select("_id dateJoined dateRelieved createdAt isProbation probationPeriod probationPeriodMonths")
        .lean();
      const leaveBalDocs = await LeaveBalance.find({ employeeId: { $in: employees.map(e => e._id) } }).lean();
      const balMap = {};
      leaveBalDocs.forEach(b => { balMap[b.employeeId.toString()] = b.leaveBalances || {}; });

      const permConfig = await getPermissionConfig();
      const isAl = isMatchingDeductCategory(trimmedName, permConfig.deductCategoryName) || isAnnualLeaveCategory(trimmedName);
      const bulkPermDeductions = isAl
        ? await getBulkPermissionDeductions(employees.map(e => e._id), targetYear)
        : {};

      const currentDate = new Date();

      const bulkOps = employees.map(emp => {
        const joiningDate = emp.dateJoined || emp.createdAt;
        const inProbation = isEmployeeInProbation(emp);
        const serviceMonths = calculateServiceMonths(joiningDate, currentDate);
        const allowedLeaves = calculateCategoryLeaves(updatedCategory, serviceMonths, inProbation);

        const balances = balMap[emp._id.toString()] || {};
        const yearBalances = { ...(balances[targetYear] || {}) };

        const oldBalance = yearBalances[oldName] || { used: 0 };
        let used = oldBalance.used || 0;

        if (isAl) {
          const empPermDays = bulkPermDeductions[emp._id.toString()] || 0;
          if (empPermDays > 0) {
            const regularUsed = oldBalance.regularUsed !== undefined
              ? oldBalance.regularUsed
              : (oldBalance.permissionDeducted !== undefined
                  ? Math.max(0, used - oldBalance.permissionDeducted)
                  : used);
            const availableAL = Math.max(0, allowedLeaves - regularUsed);
            const deductedFromAL = Math.min(availableAL, empPermDays);
            used = regularUsed + deductedFromAL;
            oldBalance.regularUsed = regularUsed;
            oldBalance.permissionDeducted = deductedFromAL;
          }
        }

        const remaining = Math.max(0, allowedLeaves - used);

        const updatedBalance = {
          total: allowedLeaves,
          used: used,
          remaining: remaining,
          ...(oldBalance.regularUsed !== undefined ? { regularUsed: oldBalance.regularUsed } : {}),
          ...(oldBalance.permissionDeducted !== undefined ? { permissionDeducted: oldBalance.permissionDeducted } : {}),
        };

        if (oldName !== trimmedName) {
          delete yearBalances[oldName];
        }
        yearBalances[trimmedName] = updatedBalance;

        return {
          updateOne: {
            filter: { employeeId: emp._id },
            update: { $set: { [`leaveBalances.${targetYear}`]: yearBalances } },
            upsert: true
          }
        };
      });

      if (bulkOps.length > 0) {
        await LeaveBalance.bulkWrite(bulkOps);
      }

      return res.status(200).json({
        success: true,
        message: "Leave category updated successfully",
        data: updatedCategory
      });
    } catch (err) {
      console.error("Error updating employee balances for updated category:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // Delete a category from its financial year document
  deleteCategory: async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    let targetYear = "";
    let name = "";

    try {
      if (req.user.role !== "admin" && !req.user.isHr) {
        await session.abortTransaction();
        session.endSession();
        return res.status(403).json({ success: false, message: "Access denied" });
      }

      const { id } = req.params;
      const doc = await LeaveCategory.findOne({ "categories._id": id }).session(session);
      if (!doc) {
        await session.abortTransaction();
        session.endSession();
        return res.status(404).json({ success: false, message: "Leave category not found" });
      }

      const category = doc.categories.id(id);
      if (!category) {
        await session.abortTransaction();
        session.endSession();
        return res.status(404).json({ success: false, message: "Leave category not found" });
      }

      name = category.name;
      targetYear = doc.financialYear;

      // Check if there are active, pending, or approved leave requests under this category
      const activeRequestsCount = await LeaveRequest.countDocuments({
        leaveType: name,
        status: { $in: ["Pending", "Approved"] },
      }).session(session);

      if (activeRequestsCount > 0) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: `Cannot delete category "${name}" because there are ${activeRequestsCount} active (Pending/Approved) leave request(s) associated with it.`,
        });
      }

      doc.categories.pull(id);
      doc.isReviewed = true;
      await doc.save({ session });

      await Notification.deleteMany({
        type: "SYSTEM_REMINDER",
        "metadata.financialYear": targetYear
      }).session(session);

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error("Error deleting leave category:", err);
      return res.status(500).json({ success: false, message: err.message || "Server error" });
    } finally {
      session.endSession();
    }

    // Unset from active employees' balances for this specific financial year outside transaction
    try {
      await LeaveBalance.updateMany(
        {},
        {
          $unset: {
            [`leaveBalances.${targetYear}.${name}`]: ""
          }
        }
      );

      return res.status(200).json({ success: true, message: "Leave category deleted successfully" });
    } catch (err) {
      console.error("Error unsetting deleted leave category from employees:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // Confirm settings (mark isReviewed = true and copy categories from previous year if creating fresh)
  confirmReviewStatus: async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    let targetYear = "";
    let activeCategories = [];

    try {
      if (req.user.role !== "admin") {
        await session.abortTransaction();
        session.endSession();
        return res.status(403).json({ success: false, message: "Access denied" });
      }

      const { year } = req.body;
      targetYear = year || getCurrentFinancialYear();

      // Parse previous year from targetYear (e.g. "2026-2027" -> "2025-2026")
      const years = targetYear.split("-");
      let prevYear = "";
      if (years.length === 2) {
        const start = parseInt(years[0]);
        const end = parseInt(years[1]);
        if (!isNaN(start) && !isNaN(end)) {
          prevYear = `${start - 1}-${end - 1}`;
        }
      }

      // Try to copy categories from the previous year with ALL tier and counter fields preserved
      let categoriesToCopy = [];
      if (prevYear) {
        const prevYearDoc = await LeaveCategory.findOne({ financialYear: prevYear }).session(session);
        if (prevYearDoc && prevYearDoc.categories) {
          categoriesToCopy = prevYearDoc.categories.map((c) => ({
            name: c.name,
            probationOthersLeaveCount: c.probationOthersLeaveCount || 0,
            permanentOthersLeaveCount: c.permanentOthersLeaveCount || 0,
            tiers: c.tiers ? c.tiers.map((t) => ({
              employeeType: t.employeeType || "All",
              fromYear: t.fromYear !== undefined ? t.fromYear : 0,
              fromMonth: t.fromMonth !== undefined ? t.fromMonth : 0,
              toYear: t.toYear !== undefined ? t.toYear : (t.fromYear || 0),
              toMonth: t.toMonth !== undefined ? t.toMonth : (t.fromMonth || 0),
              minDuration: t.minDuration !== undefined ? t.minDuration : 0,
              maxDuration: t.maxDuration !== undefined ? t.maxDuration : null,
              durationUnit: t.durationUnit || "months",
              eligibleMonths: t.eligibleMonths || 0,
              maxEligibleMonths: t.maxEligibleMonths || null,
              leaveCount: t.leaveCount || 0,
            })) : []
          }));
        }
      }

      let doc = await LeaveCategory.findOne({ financialYear: targetYear }).session(session);
      if (!doc) {
        doc = new LeaveCategory({
          financialYear: targetYear,
          categories: []
        });
      }

      // Overwrite or assign categories from previous year if available and doc currently has none
      if (categoriesToCopy.length > 0 && (!doc.categories || doc.categories.length === 0)) {
        doc.categories = categoriesToCopy;
      }

      doc.isReviewed = true;
      await doc.save({ session });
      activeCategories = doc.categories || [];

      await Notification.deleteMany({
        type: "SYSTEM_REMINDER",
        "metadata.financialYear": targetYear
      }).session(session);

      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      console.error("Error confirming leave settings status:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    } finally {
      session.endSession();
    }

    // Also update leaveBalances for all active employees for this new year outside transaction
    try {
      if (activeCategories.length > 0) {
        const employees = await Employee.find({
          employmentStatus: "active",
          status: { $ne: "relieved" },
          role: { $ne: "admin" },
          isDeleted: { $ne: true },
        })
          .select("_id dateJoined dateRelieved createdAt isProbation probationPeriod probationPeriodMonths")
          .lean();
        const leaveBalDocs = await LeaveBalance.find({ employeeId: { $in: employees.map(e => e._id) } }).lean();
        const balMap = {};
        leaveBalDocs.forEach(b => { balMap[b.employeeId.toString()] = b.leaveBalances || {}; });

        const permConfig = await getPermissionConfig();
        const bulkPermDeductions = await getBulkPermissionDeductions(employees.map(e => e._id), targetYear);
        const alCat = activeCategories.find(c => isMatchingDeductCategory(c.name, permConfig.deductCategoryName)) ||
          activeCategories.find(c => isAnnualLeaveCategory(c.name));

        const currentDate = new Date();

        const bulkOps = employees.map((emp) => {
          const joiningDate = emp.dateJoined || emp.createdAt;
          const inProbation = isEmployeeInProbation(emp);
          const serviceMonths = calculateServiceMonths(joiningDate, currentDate);

          const existingBalances = balMap[emp._id.toString()] || {};
          const yearBalances = { ...(existingBalances[targetYear] || {}) };
          const empPermDays = bulkPermDeductions[emp._id.toString()] || 0;

          activeCategories.forEach((cat) => {
            if (!cat || !cat.name) return;
            const allowedLeaves = calculateCategoryLeaves(cat, serviceMonths, inProbation);

            const existingCatBalance = yearBalances[cat.name] || {};
            let used = existingCatBalance.used || 0;

            if (alCat && cat.name === alCat.name && empPermDays > 0) {
              const regularUsed = existingCatBalance.regularUsed !== undefined
                ? existingCatBalance.regularUsed
                : (existingCatBalance.permissionDeducted !== undefined
                    ? Math.max(0, used - existingCatBalance.permissionDeducted)
                    : used);
              const availableAL = Math.max(0, allowedLeaves - regularUsed);
              const deductedFromAL = Math.min(availableAL, empPermDays);
              used = regularUsed + deductedFromAL;
              yearBalances[cat.name] = {
                total: allowedLeaves,
                used: used,
                remaining: Math.max(0, allowedLeaves - used),
                regularUsed,
                permissionDeducted: deductedFromAL,
              };
            } else {
              yearBalances[cat.name] = {
                total: allowedLeaves,
                used: used,
                remaining: Math.max(0, allowedLeaves - used),
              };
            }
          });

          return {
            updateOne: {
              filter: { employeeId: emp._id },
              update: { $set: { [`leaveBalances.${targetYear}`]: yearBalances } },
              upsert: true
            }
          };
        });

        if (bulkOps.length > 0) {
          await LeaveBalance.bulkWrite(bulkOps);
        }
      }

      return res.status(200).json({ success: true, message: "Review status updated and copied successfully." });
    } catch (err) {
      console.error("Error recalculating balances after review confirmation:", err);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  }
};

module.exports = leaveCategoryController;
