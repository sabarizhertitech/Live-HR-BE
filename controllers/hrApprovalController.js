const mongoose = require("mongoose");
const HrApprovalRequest = require("../Models/HrApprovalRequest");
const HolidayYear = require("../Models/Holiday.model");
const LeaveCategory = require("../Models/LeaveCategory");
const LeaveBalance = require("../Models/LeaveBalance");
const SalarySlip = require("../Models/SalarySlip");
const Employee = require("../Models/Employee");
const EmployeeDetails = require("../Models/EmployeeDetails");
const Log = require("../Models/Logs");
const Notification = require("../Models/Notification");
const { sendPushNotification } = require("../utilities/notificationService");
const getCachedSignedUrl = require("../utilities/s3CachedUrl");
const {
  getCurrentFinancialYear,
  calculateServiceMonths,
  calculateCategoryLeaves,
} = require("../utilities/financialYearUtil");
const { isEmployeeInProbation } = require("../utilities/probationHelper");
const { validateAndProcessTiers } = require("../utilities/leaveValidationHelper");

/* =====================================================
   1. SUBMIT HR ACTION (By HR)
===================================================== */
exports.submitHrAction = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const empDoc = await Employee.findById(userId).lean();
    const isHrUser = empDoc ? !!empDoc.isHr : !!req.user.isHr;
    const isAdminUser = req.user.role === "admin";

    if (!isHrUser && !isAdminUser) {
      return res.status(403).json({
        success: false,
        message: "Access denied. Only designated HR or Admin can perform this action.",
      });
    }

    const { actionType, targetModule, summary, payload } = req.body;

    if (!actionType || !targetModule || !summary || !payload) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields (actionType, targetModule, summary, payload)",
      });
    }

    // If leave category action, validate tiers immediately
    if (targetModule === "LEAVE_CATEGORY" || targetModule === "LEAVE_MANAGEMENT") {
      if (payload.tiers) {
        const validation = validateAndProcessTiers(payload.tiers);
        if (!validation.isValid) {
          return res.status(400).json({ success: false, message: validation.error });
        }
        payload.tiers = validation.processedTiers;
      } else if (Array.isArray(payload.categories)) {
        for (const cat of payload.categories) {
          if (cat.tiers) {
            const validation = validateAndProcessTiers(cat.tiers);
            if (!validation.isValid) {
              return res.status(400).json({ success: false, message: `${cat.name || "Category"}: ${validation.error}` });
            }
            cat.tiers = validation.processedTiers;
          }
        }
      }
    }

    const hrName = empDoc?.name || req.user?.name || "HR User";

    const request = new HrApprovalRequest({
      hrId: userId,
      hrName,
      actionType,
      targetModule,
      summary,
      payload,
      status: "PENDING",
    });

    await request.save();

    // ── Create Audit Log in Log Model ──
    try {
      await Log.create({
        category: "HR_APPROVAL",
        referenceId: request._id,
        description: `HR ${hrName} submitted a request: ${summary}`,
        changes: Array.isArray(payload.changes) ? payload.changes : undefined,
      });
    } catch (logErr) {
      console.error("❌ Log creation error on submit:", logErr);
    }

    // ── Send FCM Push Notification to all Admins (Single Notification) ──
    try {
      const admins = await Employee.find({ role: "admin" }).select("_id fcmTokens");
      const adminIds = admins.map((a) => a._id);
      if (adminIds.length > 0) {
        const moduleName = targetModule === "EMPLOYEE"
          ? "Employee Update"
          : (targetModule === "LEAVE_CATEGORY" || targetModule === "LEAVE_MANAGEMENT" ? "Leave Category" : targetModule);

        const notifTitle = `HR ${moduleName} Request`;
        const notifBody = summary || `${hrName} submitted a request for your approval.`;
        const targetUrl = (targetModule === "GOV_HOLIDAY" || targetModule === "HOLIDAY")
          ? "/admin/holiday-management"
          : (targetModule === "SALARY_SLIP"
            ? "/admin/payslip-generator"
            : (targetModule === "EMPLOYEE"
              ? "/admin/employees/manage-employee"
              : ((targetModule === "LEAVE_CATEGORY" || targetModule === "LEAVE_MANAGEMENT") ? "/admin/leave-management" : "/admin/leaves")));

        await sendPushNotification(adminIds, notifTitle, notifBody, {
          url: targetUrl,
          ticketId: String(request._id),
          category: "hr_approval",
          targetModule,
        });
      }
    } catch (fcmErr) {
      console.error("❌ FCM push notification error:", fcmErr);
    }

    return res.status(201).json({
      success: true,
      message: "Action submitted successfully and sent to Admin for approval.",
      data: request,
    });
  } catch (error) {
    console.error("❌ Submit HR Action Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to submit HR action",
      error: error.message,
    });
  }
};

/* =====================================================
   2. GET ALL / PENDING REQUESTS (For Admin & HR)
===================================================== */
exports.getApprovalRequests = async (req, res) => {
  try {
    const { status, targetModule } = req.query;
    const filter = {};

    if (status && status !== "ALL") {
      filter.status = status.toUpperCase();
    }

    if (targetModule && targetModule !== "ALL") {
      filter.targetModule = targetModule.toUpperCase();
    }

    const requests = await HrApprovalRequest.find(filter)
      .populate("hrId", "name email empId photo department designation")
      .populate("actionBy", "name email")
      .sort({ createdAt: -1 })
      .lean();

    const signedRequests = await Promise.all(
      requests.map(async (r) => {
        if (r.hrId && r.hrId.photo) {
          try {
            r.hrId.photo = await getCachedSignedUrl(r.hrId.photo);
          } catch (e) {
            console.error("Failed to sign hrId photo:", e);
          }
        }
        return r;
      })
    );

    return res.status(200).json({
      success: true,
      count: signedRequests.length,
      data: signedRequests,
    });
  } catch (error) {
    console.error("❌ Get Approval Requests Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch approval requests",
    });
  }
};

/* =====================================================
   3. GET MY REQUESTS (For HR)
===================================================== */
exports.getMyRequests = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const requests = await HrApprovalRequest.find({ hrId: userId }).sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: requests.length,
      data: requests,
    });
  } catch (error) {
    console.error("❌ Get My Requests Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch your requests",
    });
  }
};

/* =====================================================
   4. APPROVE REQUEST (By Admin)
===================================================== */
exports.approveRequest = async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Admin privileges required.",
      });
    }

    const { id } = req.params;
    const { adminNote } = req.body;

    const request = await HrApprovalRequest.findById(id);
    if (!request) {
      return res.status(404).json({ success: false, message: "Request not found" });
    }

    if (request.status !== "PENDING") {
      return res.status(400).json({
        success: false,
        message: `Request is already ${request.status.toLowerCase()}`,
      });
    }

    // Execute the action based on actionType & payload
    await executeApprovedPayload(request.actionType, request.payload);

    request.status = "APPROVED";
    request.adminNote = adminNote || "Approved by Admin";
    request.actionBy = req.user.id || req.user._id;
    request.actionAt = new Date();

    await request.save();

    // ── Create Audit Log in Log Model ──
    try {
      await Log.create({
        category: "HR_APPROVAL",
        referenceId: request._id,
        description: `Admin approved request: ${request.summary}${adminNote ? ` (Note: ${adminNote})` : ""}`,
        changes: Array.isArray(request.payload?.changes) ? request.payload.changes : undefined,
      });
    } catch (logErr) {
      console.error("❌ Log creation error on approve:", logErr);
    }

    // ── Notify HR User of Approval ──
    try {
      if (request.hrId) {
        const title = `HR ${request.targetModule === "LEAVE_CATEGORY" || request.targetModule === "LEAVE_MANAGEMENT" ? "Leave Category" : request.targetModule} Approved`;
        const body = `Your request "${request.summary}" has been approved and published by Admin.`;

        const targetUrl = (request.targetModule === "GOV_HOLIDAY" || request.targetModule === "HOLIDAY")
          ? "/admin/holiday-management"
          : (request.targetModule === "SALARY_SLIP"
            ? "/admin/payslip-generator"
            : (request.targetModule === "EMPLOYEE"
              ? "/admin/employees/manage-employee"
              : ((request.targetModule === "LEAVE_CATEGORY" || request.targetModule === "LEAVE_MANAGEMENT") ? "/admin/leave-management" : "/admin/leaves")));

        await Notification.create({
          type: "HR_APPROVAL_APPROVED",
          toEmployee: request.hrId,
          fromAdmin: true,
          title,
          message: body,
          metadata: {
            ticketId: String(request._id),
            requestType: "hr-approval-decision",
            targetModule: request.targetModule,
            url: targetUrl,
          },
        });

        await sendPushNotification([request.hrId], title, body, {
          url: targetUrl,
          ticketId: String(request._id),
          category: "hr_approval_decision",
          status: "APPROVED",
        });
      }
    } catch (notifErr) {
      console.error("❌ HR approval feedback notification error:", notifErr);
    }

    return res.status(200).json({
      success: true,
      message:
        request.actionType === "DELETE_DOCUMENT"
          ? "Document deleted successfully from database and S3"
          : "Request approved and changes published successfully",
      data: request,
    });
  } catch (error) {
    console.error("❌ Approve Request Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to approve request",
    });
  }
};

/* =====================================================
   5. REJECT REQUEST (By Admin)
===================================================== */
exports.rejectRequest = async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Admin privileges required.",
      });
    }

    const { id } = req.params;
    const { adminNote } = req.body;

    if (!adminNote || !adminNote.trim()) {
      return res.status(400).json({
        success: false,
        message: "Rejection reason is required.",
      });
    }

    const request = await HrApprovalRequest.findById(id);
    if (!request) {
      return res.status(404).json({ success: false, message: "Request not found" });
    }

    if (request.status !== "PENDING") {
      return res.status(400).json({
        success: false,
        message: `Request is already ${request.status.toLowerCase()}`,
      });
    }

    request.status = "REJECTED";
    request.adminNote = adminNote.trim();
    request.actionBy = req.user.id || req.user._id;
    request.actionAt = new Date();

    await request.save();

    // ── Create Audit Log in Log Model ──
    try {
      await Log.create({
        category: "HR_APPROVAL",
        referenceId: request._id,
        description: `Admin rejected request: ${request.summary}. Reason: ${adminNote.trim()}`,
        changes: Array.isArray(request.payload?.changes) ? request.payload.changes : undefined,
      });
    } catch (logErr) {
      console.error("❌ Log creation error on reject:", logErr);
    }

    // ── Notify HR User of Rejection ──
    try {
      if (request.hrId) {
        const title = `HR ${request.targetModule === "LEAVE_CATEGORY" || request.targetModule === "LEAVE_MANAGEMENT" ? "Leave Category" : request.targetModule} Rejected`;
        const body = `Your request "${request.summary}" was rejected by Admin. Note: ${request.adminNote}`;

        const targetUrl = (request.targetModule === "GOV_HOLIDAY" || request.targetModule === "HOLIDAY")
          ? "/admin/holiday-management"
          : (request.targetModule === "SALARY_SLIP"
            ? "/admin/payslip-generator"
            : (request.targetModule === "EMPLOYEE"
              ? "/admin/employees/manage-employee"
              : ((request.targetModule === "LEAVE_CATEGORY" || request.targetModule === "LEAVE_MANAGEMENT") ? "/admin/leave-management" : "/admin/leaves")));

        await Notification.create({
          type: "HR_APPROVAL_REJECTED",
          toEmployee: request.hrId,
          fromAdmin: true,
          title,
          message: body,
          metadata: {
            ticketId: String(request._id),
            requestType: "hr-approval-decision",
            targetModule: request.targetModule,
            url: targetUrl,
          },
        });

        await sendPushNotification([request.hrId], title, body, {
          url: targetUrl,
          ticketId: String(request._id),
          category: "hr_approval_decision",
          status: "REJECTED",
        });
      }
    } catch (notifErr) {
      console.error("❌ HR rejection feedback notification error:", notifErr);
    }

    return res.status(200).json({
      success: true,
      message: "Request rejected successfully",
      data: request,
    });
  } catch (error) {
    console.error("❌ Reject Request Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to reject request",
    });
  }
};

/* =====================================================
   6. EDIT & APPROVE REQUEST (By Admin)
===================================================== */
exports.updateAndApproveRequest = async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Admin privileges required.",
      });
    }

    const { id } = req.params;
    const { summary, payload, adminNote } = req.body;

    const request = await HrApprovalRequest.findById(id);
    if (!request) {
      return res.status(404).json({ success: false, message: "Request not found" });
    }

    if (request.status !== "PENDING") {
      return res.status(400).json({
        success: false,
        message: `Request is already ${request.status.toLowerCase()}`,
      });
    }

    const finalPayload = payload || request.payload;
    const finalSummary = summary || request.summary;

    await executeApprovedPayload(request.actionType, finalPayload);

    request.payload = finalPayload;
    request.summary = finalSummary;
    request.status = "APPROVED";
    request.adminNote = adminNote || "Edited and Approved by Admin";
    request.actionBy = req.user.id || req.user._id;
    request.actionAt = new Date();

    await request.save();

    // ── Notify HR User of Edit & Approval ──
    try {
      if (request.hrId) {
        const title = `HR ${request.targetModule === "LEAVE_CATEGORY" || request.targetModule === "LEAVE_MANAGEMENT" ? "Leave Category" : request.targetModule} Approved`;
        const body = `Your request "${finalSummary}" was updated & approved by Admin.`;

        const targetUrl = (request.targetModule === "GOV_HOLIDAY" || request.targetModule === "HOLIDAY")
          ? "/admin/holiday-management"
          : (request.targetModule === "SALARY_SLIP" ? "/admin/payslip-generator" : ((request.targetModule === "LEAVE_CATEGORY" || request.targetModule === "LEAVE_MANAGEMENT") ? "/admin/leave-management" : "/admin/leaves"));

        await Notification.create({
          type: "HR_APPROVAL_APPROVED",
          toEmployee: request.hrId,
          fromAdmin: true,
          title,
          message: body,
          metadata: {
            ticketId: String(request._id),
            requestType: "hr-approval-decision",
            targetModule: request.targetModule,
            url: targetUrl,
          },
        });

        await sendPushNotification([request.hrId], title, body, {
          url: targetUrl,
          ticketId: String(request._id),
          category: "hr_approval_decision",
          status: "APPROVED",
        });
      }
    } catch (notifErr) {
      console.error("❌ HR update & approve feedback notification error:", notifErr);
    }

    return res.status(200).json({
      success: true,
      message: "Request edited, approved, and updated for all employees!",
      data: request,
    });
  } catch (error) {
    console.error("❌ Edit & Approve Request Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to edit and approve request",
    });
  }
};

const resolveTargetEmployee = async (payload) => {
  const targetId = payload?.empId || payload?.empIdString;
  let employee = null;
  if (targetId && mongoose.Types.ObjectId.isValid(targetId)) {
    employee = await Employee.findOne({
      $or: [{ _id: targetId }, { empId: targetId }],
    });
  } else if (targetId) {
    employee = await Employee.findOne({ empId: targetId });
  }
  if (!employee && payload?.empIdString) {
    employee = await Employee.findOne({ empId: payload.empIdString });
  }
  return employee;
};

/* =====================================================
   HELPER: EXECUTE APPROVED PAYLOAD
===================================================== */
async function executeApprovedPayload(actionType, payload) {
  switch (actionType) {
    // ── HOLIDAY ACTIONS ──
    case "ADD_HOLIDAY": {
      const { year, month, holiday, type } = payload;
      let doc = await HolidayYear.findOne({ year: parseInt(year) });
      const monthInt = parseInt(month);
      const targetType = type === "special" ? "specialDays" : "governmentHolidays";

      if (!doc) {
        doc = new HolidayYear({
          year: parseInt(year),
          months: [{ month: monthInt, governmentHolidays: [], specialDays: [] }],
        });
      }

      let monthObj = doc.months.find((m) => m.month === monthInt);
      if (!monthObj) {
        monthObj = { month: monthInt, governmentHolidays: [], specialDays: [] };
        doc.months.push(monthObj);
      }

      const existingIndex = monthObj[targetType].findIndex(
        (h) => h.date === holiday.date && h.name === holiday.name
      );
      if (existingIndex === -1) {
        monthObj[targetType].push(holiday);
        monthObj[targetType].sort((a, b) => a.date - b.date);
      } else {
        monthObj[targetType][existingIndex] = holiday;
      }

      doc.months.sort((a, b) => a.month - b.month);
      await doc.save();
      break;
    }

    case "EDIT_HOLIDAY": {
      const { year, month, oldHoliday, newHoliday, type } = payload;
      const doc = await HolidayYear.findOne({ year: parseInt(year) });
      if (doc) {
        const monthObj = doc.months.find((m) => m.month === parseInt(month));
        if (monthObj) {
          const targetArray = type === "special" ? monthObj.specialDays : monthObj.governmentHolidays;
          const idx = targetArray.findIndex(
            (h) => h.date === oldHoliday.date && h.name === oldHoliday.name
          );
          if (idx !== -1) {
            targetArray[idx] = newHoliday;
          } else {
            targetArray.push(newHoliday);
          }
          targetArray.sort((a, b) => a.date - b.date);
          await doc.save();
        }
      }
      break;
    }

    case "DELETE_HOLIDAY": {
      const { year, month, date, name, type } = payload;
      const doc = await HolidayYear.findOne({ year: parseInt(year) });
      if (doc) {
        const monthObj = doc.months.find((m) => m.month === parseInt(month));
        if (monthObj) {
          if (type === "special") {
            monthObj.specialDays = monthObj.specialDays.filter(
              (h) => !(h.date === date && h.name === name)
            );
          } else {
            monthObj.governmentHolidays = monthObj.governmentHolidays.filter(
              (h) => !(h.date === date && h.name === name)
            );
          }
          await doc.save();
        }
      }
      break;
    }

    // ── LEAVE CATEGORY ACTIONS ──
    case "CREATE_LEAVE_CATEGORY": {
      const categoriesToAdd = Array.isArray(payload.categories) ? payload.categories : [payload];
      const targetYear = payload.year || (categoriesToAdd[0] && categoriesToAdd[0].year) || getCurrentFinancialYear();

      let doc = await LeaveCategory.findOne({ financialYear: targetYear });
      if (!doc) {
        doc = new LeaveCategory({
          financialYear: targetYear,
          categories: [],
        });
      }

      const savedCategories = [];

      for (const catData of categoriesToAdd) {
        const { name, tiers, probationOthersLeaveCount, permanentOthersLeaveCount } = catData;
        if (!name) continue;
        const trimmedName = name.trim();

        const processedTiers = (tiers || []).map((t) => {
          const leaveCount = Number(t.leaveCount) || 0;
          const employeeType = t.employeeType || "All";
          const durationUnit = t.durationUnit || "months";

          const fromYear = t.fromYear !== undefined && t.fromYear !== "" && t.fromYear !== null ? Number(t.fromYear) : 0;
          const fromMonth = t.fromMonth !== undefined && t.fromMonth !== "" && t.fromMonth !== null ? Number(t.fromMonth) : (t.minDuration !== undefined && t.minDuration !== "" ? Number(t.minDuration) : (Number(t.eligibleMonths) || 0));
          const toYear = t.toYear !== undefined && t.toYear !== "" && t.toYear !== null ? Number(t.toYear) : fromYear;
          const toMonth = t.toMonth !== undefined && t.toMonth !== "" && t.toMonth !== null ? Number(t.toMonth) : fromMonth;

          const eligibleMonths = (fromYear * 12) + fromMonth;
          const maxEligibleMonths = (toYear * 12) + toMonth;
          const minDuration = eligibleMonths;
          const maxDuration = maxEligibleMonths;

          return {
            employeeType,
            fromYear,
            fromMonth,
            toYear,
            toMonth,
            minDuration,
            maxDuration,
            durationUnit,
            eligibleMonths,
            maxEligibleMonths,
            leaveCount,
          };
        });

        const existsIndex = doc.categories.findIndex(
          (cat) => cat.name.toLowerCase() === trimmedName.toLowerCase()
        );

        if (existsIndex !== -1) {
          doc.categories[existsIndex].tiers = processedTiers;
          if (probationOthersLeaveCount !== undefined) doc.categories[existsIndex].probationOthersLeaveCount = Number(probationOthersLeaveCount) || 0;
          if (permanentOthersLeaveCount !== undefined) doc.categories[existsIndex].permanentOthersLeaveCount = Number(permanentOthersLeaveCount) || 0;
          savedCategories.push(doc.categories[existsIndex]);
        } else {
          const newCat = {
            name: trimmedName,
            tiers: processedTiers,
            probationOthersLeaveCount: Number(probationOthersLeaveCount) || 0,
            permanentOthersLeaveCount: Number(permanentOthersLeaveCount) || 0,
          };
          doc.categories.push(newCat);
          savedCategories.push(newCat);
        }
      }

      doc.isReviewed = true;
      doc.status = "approved";
      doc.approvedDate = new Date();
      await doc.save();

      // Update employee balances for all saved categories
      const employees = await Employee.find({ employmentStatus: "active", role: { $ne: "admin" } });
      const leaveBalDocs = await LeaveBalance.find({ employeeId: { $in: employees.map(e => e._id) } });
      const balMap = {};
      leaveBalDocs.forEach(b => { balMap[b.employeeId.toString()] = b; });
      const currentDate = new Date();

      const updatePromises = employees.map(async (emp) => {
        const joiningDate = emp.dateJoined || emp.createdAt || currentDate;
        const inProbation = isEmployeeInProbation(emp);
        const serviceMonths = calculateServiceMonths(joiningDate, currentDate);

        let leaveBal = balMap[emp._id.toString()];
        if (!leaveBal) {
          leaveBal = new LeaveBalance({ employeeId: emp._id, leaveBalances: {} });
        }
        const balances = leaveBal.leaveBalances || {};
        if (!balances[targetYear]) balances[targetYear] = {};

        for (const savedCat of savedCategories) {
          const catName = savedCat.name;
          const allowedLeaves = calculateCategoryLeaves(savedCat, serviceMonths, inProbation);
          const existingUsed = balances[targetYear][catName]?.used || 0;
          balances[targetYear][catName] = {
            total: allowedLeaves,
            used: existingUsed,
            remaining: Math.max(0, allowedLeaves - existingUsed),
          };
        }

        leaveBal.leaveBalances = balances;
        leaveBal.markModified("leaveBalances");
        return leaveBal.save();
      });

      await Promise.all(updatePromises);
      break;
    }

    case "UPDATE_LEAVE_CATEGORY": {
      const { id, name, tiers, probationOthersLeaveCount, permanentOthersLeaveCount } = payload;
      const doc = await LeaveCategory.findOne({ "categories._id": id });
      if (doc) {
        const category = doc.categories.id(id);
        if (category) {
          const oldName = category.name;
          const targetYear = doc.financialYear;
          const trimmedName = name ? name.trim() : category.name;

          category.name = trimmedName;
          if (probationOthersLeaveCount !== undefined) {
            category.probationOthersLeaveCount = Number(probationOthersLeaveCount) || 0;
          }
          if (permanentOthersLeaveCount !== undefined) {
            category.permanentOthersLeaveCount = Number(permanentOthersLeaveCount) || 0;
          }

          if (tiers && Array.isArray(tiers)) {
            category.tiers = tiers.map((t) => {
              const leaveCount = Number(t.leaveCount) || 0;
              const employeeType = t.employeeType || "All";
              const durationUnit = t.durationUnit || "months";

              const fromYear = t.fromYear !== undefined && t.fromYear !== "" && t.fromYear !== null ? Number(t.fromYear) : 0;
              const fromMonth = t.fromMonth !== undefined && t.fromMonth !== "" && t.fromMonth !== null ? Number(t.fromMonth) : (t.minDuration !== undefined && t.minDuration !== "" ? Number(t.minDuration) : (Number(t.eligibleMonths) || 0));
              const toYear = t.toYear !== undefined && t.toYear !== "" && t.toYear !== null ? Number(t.toYear) : fromYear;
              const toMonth = t.toMonth !== undefined && t.toMonth !== "" && t.toMonth !== null ? Number(t.toMonth) : fromMonth;

              const eligibleMonths = (fromYear * 12) + fromMonth;
              const maxEligibleMonths = (toYear * 12) + toMonth;
              const minDuration = eligibleMonths;
              const maxDuration = maxEligibleMonths;

              return {
                employeeType,
                fromYear,
                fromMonth,
                toYear,
                toMonth,
                minDuration,
                maxDuration,
                durationUnit,
                eligibleMonths,
                maxEligibleMonths,
                leaveCount,
              };
            });
          }

          doc.isReviewed = true;
          doc.status = "approved";
          doc.approvedDate = new Date();
          await doc.save();

          // Update balances
          const employees = await Employee.find({ employmentStatus: "active", role: { $ne: "admin" } });
          const leaveBalDocs = await LeaveBalance.find({ employeeId: { $in: employees.map(e => e._id) } });
          const balMap = {};
          leaveBalDocs.forEach(b => { balMap[b.employeeId.toString()] = b; });
          const currentDate = new Date();

          const updatePromises = employees.map(async (emp) => {
            const joiningDate = emp.dateJoined || emp.createdAt || currentDate;
            const inProbation = isEmployeeInProbation(emp);
            const serviceMonths = calculateServiceMonths(joiningDate, currentDate);
            const allowedLeaves = calculateCategoryLeaves(category, serviceMonths, inProbation);

            let leaveBal = balMap[emp._id.toString()];
            if (!leaveBal) {
              leaveBal = new LeaveBalance({ employeeId: emp._id, leaveBalances: {} });
            }
            const balances = leaveBal.leaveBalances || {};
            if (!balances[targetYear]) balances[targetYear] = {};

            const oldBalance = balances[targetYear][oldName] || { used: 0 };
            const updatedBalance = {
              total: allowedLeaves,
              used: oldBalance.used || 0,
              remaining: Math.max(0, allowedLeaves - (oldBalance.used || 0)),
            };

            if (oldName !== trimmedName) {
              delete balances[targetYear][oldName];
            }
            balances[targetYear][trimmedName] = updatedBalance;

            leaveBal.leaveBalances = balances;
            leaveBal.markModified("leaveBalances");
            return leaveBal.save();
          });

          await Promise.all(updatePromises);
        }
      }
      break;
    }

    case "DELETE_LEAVE_CATEGORY": {
      const { id } = payload;
      if (id && String(id).startsWith("pending_")) {
        const reqId = String(id).replace("pending_", "");
        await HrApprovalRequest.findByIdAndDelete(reqId);
      } else {
        const doc = await LeaveCategory.findOne({ "categories._id": id });
        if (doc) {
          const category = doc.categories.id(id);
          if (category) {
            const name = category.name;
            const targetYear = doc.financialYear;
            doc.categories.pull(id);
            doc.isReviewed = true;
            if (doc.categories.length > 0) {
              doc.status = "approved";
              doc.approvedDate = new Date();
            }
            await doc.save();

            await LeaveBalance.updateMany(
              {},
              { $unset: { [`leaveBalances.${targetYear}.${name}`]: "" } }
            );
          }
        }
      }
      break;
    }

    // ── SALARY SLIP ACTIONS ──
    case "GENERATE_SALARY_SLIP": {
      const { empId, month, year, netPay, pdfUrl } = payload;
      let slip = await SalarySlip.findOne({ empId, month: Number(month), year: Number(year) });
      if (!slip) {
        slip = new SalarySlip({
          empId,
          month: Number(month),
          year: Number(year),
          netPay: Number(netPay),
          pdfUrl,
        });
      } else {
        slip.netPay = Number(netPay);
        if (pdfUrl) slip.pdfUrl = pdfUrl;
      }
      await slip.save();
      break;
    }

    // ── EMPLOYEE ACTIONS ──
    case "EDIT_EMPLOYEE": {
      const employee = await resolveTargetEmployee(payload);
      if (employee) {
        const employeeUpdate = payload.employeeUpdate || {};
        const detailsUpdate = payload.detailsUpdate || {};
        const updatedData = payload.updatedData || {};

        const CORE_EMPLOYEE_FIELDS = [
          "name", "email", "phone", "department", "designation", "status", "salary", "dateRelieved"
        ];

        Object.keys(updatedData).forEach((key) => {
          if (CORE_EMPLOYEE_FIELDS.includes(key)) {
            if (employeeUpdate[key] === undefined) employeeUpdate[key] = updatedData[key];
          } else {
            if (detailsUpdate[key] === undefined) detailsUpdate[key] = updatedData[key];
          }
        });

        if (detailsUpdate.gender !== undefined || employeeUpdate.gender !== undefined || updatedData.gender !== undefined) {
          const g = (detailsUpdate.gender || employeeUpdate.gender || updatedData.gender || "").toString().toLowerCase().trim();
          if (["male", "female", "other"].includes(g)) {
            employeeUpdate.gender = g;
          }
        }

        if (Object.keys(employeeUpdate).length > 0) {
          await Employee.findByIdAndUpdate(employee._id, { $set: employeeUpdate });
        }

        let details = await EmployeeDetails.findOne({ empId: employee._id });
        if (!details) {
          details = new EmployeeDetails({
            empId: employee._id,
            empIdString: employee.empId,
          });
        }

        if (Object.keys(detailsUpdate).length > 0) {
          Object.assign(details, detailsUpdate);
          await details.save();
        }

        if (employeeUpdate.status === "relieved" || detailsUpdate.employmentStatus === "relieved") {
          await LeaveBalance.deleteMany({ employeeId: employee._id });
        }
      }
      break;
    }

    case "UPDATE_SALARY": {
      const employee = await resolveTargetEmployee(payload);
      if (employee) {
        const { newSalary, isTransition, previousSalary, editingId } = payload;
        let details = await EmployeeDetails.findOne({ empId: employee._id });
        if (!details) {
          details = new EmployeeDetails({ empId: employee._id, empIdString: employee.empId });
        }
        let list = details.salaryHistory || [];
        if (isTransition && previousSalary?._id) {
          const prev = list.id ? list.id(previousSalary._id) : list.find(s => String(s._id) === String(previousSalary._id));
          if (prev) prev.toDate = newSalary.fromDate;
          list.unshift(newSalary);
        } else if (editingId) {
          const existing = list.id ? list.id(editingId) : list.find(s => String(s._id) === String(editingId));
          if (existing) {
            Object.assign(existing, newSalary);
          } else {
            list.unshift(newSalary);
          }
        } else {
          list.unshift(newSalary);
        }
        details.salaryHistory = list;

        // Link any matching increment document that has no salaryId
        if (Array.isArray(details.incrementDocuments) && newSalary?.fromDate) {
          const d = new Date(newSalary.fromDate);
          if (!isNaN(d.getTime())) {
            const yr = d.getFullYear();
            const mo = d.getMonth();
            const computedFY = mo >= 3 ? `${yr}–${yr + 1}` : `${yr - 1}–${yr}`;
            const cleanTargetFY = String(computedFY).replace(/[\u2013\u2014–-]/g, "–").trim();
            const targetSalaryId = editingId || (list[0] ? list[0]._id : null);
            if (targetSalaryId) {
              const docToLink = details.incrementDocuments.find(
                doc => !doc.salaryId && String(doc.financialYear || "").replace(/[\u2013\u2014–-]/g, "–").trim() === cleanTargetFY
              );
              if (docToLink) {
                docToLink.salaryId = targetSalaryId;
              }
            }
          }
        }

        await details.save();

        if (newSalary?.totalSalary !== undefined || newSalary?.basicSalary !== undefined) {
          await Employee.findByIdAndUpdate(employee._id, {
            salary: Number(newSalary.totalSalary || newSalary.basicSalary)
          });
        }
      }
      break;
    }

    case "UPDATE_BANK": {
      const employee = await resolveTargetEmployee(payload);
      if (employee) {
        const { bankPayload, isTransition } = payload;
        let details = await EmployeeDetails.findOne({ empId: employee._id });
        if (!details) {
          details = new EmployeeDetails({ empId: employee._id, empIdString: employee.empId });
        }

        if (isTransition && details.bankName) {
          details.bankHistory = details.bankHistory || [];
          details.bankHistory.unshift({
            bankName: details.bankName,
            accountHolder: details.accountHolder,
            accountNumber: details.accountNumber,
            ifscCode: details.ifscCode,
            branch: details.branch,
            fromDate: bankPayload.oldFromDate || details.createdAt,
            toDate: bankPayload.toDate || new Date()
          });
        }

        details.bankName = bankPayload.bankName;
        details.accountHolder = bankPayload.accountHolder;
        details.accountNumber = bankPayload.accountNumber;
        details.ifscCode = bankPayload.ifscCode;
        details.branch = bankPayload.branch;
        details.lastBankUpdate = new Date();
        await details.save();
      }
      break;
    }

    case "DELETE_EMPLOYEE": {
      const employee = await resolveTargetEmployee(payload);
      if (employee) {
        await Employee.findByIdAndUpdate(employee._id, {
          status: "deleted",
          employmentStatus: "relieved",
          isDeleted: true
        });
        await EmployeeDetails.findOneAndUpdate({ empId: employee._id }, { isDeleted: true });
        await LeaveBalance.deleteMany({ employeeId: employee._id });
      }
      break;
    }

    case "DELETE_DOCUMENT": {
      const employee = await resolveTargetEmployee(payload);
      if (employee) {
        const { documentType, fileKey, courseId, courseIdx, financialYear, docType } = payload;
        const deleteFromS3 = require("../utilities/s3Delete");

        // 1. Delete from S3 if fileKey exists
        if (fileKey) {
          await deleteFromS3(fileKey).catch((err) =>
            console.error("S3 delete error in approved DELETE_DOCUMENT:", err)
          );
        }

        let details = await EmployeeDetails.findOne({
          $or: [{ empId: employee._id }, { empIdString: employee.empId }],
        });
        if (!details && employee._id) {
          details = await EmployeeDetails.findById(employee._id);
        }
        if (details) {
          if (documentType === "marksheet10") {
            details.marksheet10 = null;
          } else if (documentType === "marksheet12") {
            details.marksheet12 = null;
          } else if (documentType === "aadhaarFile") {
            details.aadhaarFile = null;
          } else if (documentType === "panFile") {
            details.panFile = null;
          } else if (documentType === "passbookFile") {
            details.passbookFile = null;
          } else if (documentType?.startsWith("courses.") || courseId != null || courseIdx != null) {
            if (Array.isArray(details.courses)) {
              let targetCourse = null;
              if (courseId) {
                targetCourse = details.courses.id ? details.courses.id(courseId) : details.courses.find(x => String(x._id) === String(courseId));
              } else if (courseIdx != null) {
                targetCourse = details.courses[courseIdx];
              }
              if (targetCourse) {
                if (targetCourse.certificate && targetCourse.certificate !== fileKey) {
                  await deleteFromS3(targetCourse.certificate).catch(err => console.error(err));
                }
                targetCourse.certificate = null;
              }
            }
          } else if (financialYear || docType === "incrementLetter" || docType === "performanceForm" || docType === "all") {
            if (Array.isArray(details.incrementDocuments)) {
              const targetFY = String(financialYear || "").replace(/[\u2013\u2014–-]/g, "–").trim();
              const docIndex = details.incrementDocuments.findIndex(
                d => String(d.financialYear || "").replace(/[\u2013\u2014–-]/g, "–").trim() === targetFY
              );
              if (docIndex !== -1) {
                const targetDoc = details.incrementDocuments[docIndex];
                if (docType === "incrementLetter") {
                  if (targetDoc.incrementLetter?.fileKey && targetDoc.incrementLetter.fileKey !== fileKey) {
                    await deleteFromS3(targetDoc.incrementLetter.fileKey).catch(err => console.error(err));
                  }
                  targetDoc.incrementLetter = { fileKey: null, fileName: null, fileType: null };
                  if (!targetDoc.performanceForm?.fileKey) {
                    details.incrementDocuments.splice(docIndex, 1);
                  }
                } else if (docType === "performanceForm") {
                  if (targetDoc.performanceForm?.fileKey && targetDoc.performanceForm.fileKey !== fileKey) {
                    await deleteFromS3(targetDoc.performanceForm.fileKey).catch(err => console.error(err));
                  }
                  targetDoc.performanceForm = undefined;
                  if (!targetDoc.incrementLetter?.fileKey) {
                    details.incrementDocuments.splice(docIndex, 1);
                  }
                } else {
                  if (targetDoc.incrementLetter?.fileKey && targetDoc.incrementLetter.fileKey !== fileKey) {
                    await deleteFromS3(targetDoc.incrementLetter.fileKey).catch(err => console.error(err));
                  }
                  if (targetDoc.performanceForm?.fileKey && targetDoc.performanceForm.fileKey !== fileKey) {
                    await deleteFromS3(targetDoc.performanceForm.fileKey).catch(err => console.error(err));
                  }
                  details.incrementDocuments.splice(docIndex, 1);
                }
              }
            }
          } else if (details[documentType] !== undefined) {
            details[documentType] = null;
          }

          await details.save({ validateBeforeSave: false });
        }
      }
      break;
    }

    default:
      throw new Error(`Unsupported actionType: ${actionType}`);
  }
}

exports.updatePendingRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { payload, summary } = req.body;
    const request = await HrApprovalRequest.findById(id);
    if (!request) {
      return res.status(404).json({ success: false, message: "Request not found" });
    }
    if (request.status !== "PENDING" && request.status !== "REJECTED") {
      return res.status(400).json({ success: false, message: "Request cannot be updated in current status" });
    }
    if (payload) request.payload = payload;
    if (summary) request.summary = summary;
    request.status = "PENDING";
    await request.save();
    res.json({ success: true, message: "Pending request updated successfully", data: request });
  } catch (err) {
    console.error("Update pending request error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.deletePendingRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const request = await HrApprovalRequest.findById(id);
    if (!request) {
      return res.status(404).json({ success: false, message: "Request not found" });
    }
    await HrApprovalRequest.findByIdAndDelete(id);
    res.json({ success: true, message: "Request deleted successfully" });
  } catch (err) {
    console.error("Delete pending request error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.getApprovalLogs = async (req, res) => {
  try {
    const logs = await Log.find({ category: "HR_APPROVAL" }).sort({ createdAt: -1 }).limit(100);
    return res.status(200).json({ success: true, data: logs });
  } catch (error) {
    console.error("Get approval logs error:", error);
    return res.status(500).json({ success: false, message: error.message || "Failed to fetch logs" });
  }
};

const apiLogger = require("../utils/apiLogger");
module.exports = apiLogger(module.exports, "hrApprovalController.js");
