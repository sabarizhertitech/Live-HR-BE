const HolidayAssignment = require("../Models/Holiday Assignment");
const Holiday = require("../Models/Holiday.model");
const SpecialDay = require("../Models/SpecialDay.model");
const User = require("../Models/Employee");
const { sendPushNotification, notifyAdmins } = require("../utilities/notificationService");
const { createLog } = require("../utilities/logService");

const mongoose = require("mongoose");

function getUserModelName() {
  return "Employee";
}

function populateUsers(query) {
  return query
    .populate({ path: "assignedTo", model: "Employee", select: "name department email" })
    .populate({ path: "assignedBy", model: "Employee", select: "name" });
}

async function populateMonthsIfEmpty(assignment) {
  return assignment;
}

function buildMonthsFromFlatHolidays(holidays) {
  const monthsMap = {};
  holidays.forEach((h) => {
    let month, day;
    if (typeof h.date === "string" && h.date.includes("-")) {
      const parts = h.date.split("-");
      month = parseInt(parts[1], 10);
      day = parseInt(parts[2], 10);
    } else if (h.date instanceof Date) {
      month = h.date.getMonth() + 1;
      day = h.date.getDate();
    } else {
      console.warn("Skipping holiday with invalid date:", h);
      return;
    }
    if (!monthsMap[month]) monthsMap[month] = { month, governmentHolidays: [], specialDays: [] };
    monthsMap[month].governmentHolidays.push({ date: day, name: h.name });
  });
  Object.values(monthsMap).forEach((m) => m.governmentHolidays.sort((a, b) => a.date - b.date));
  return Object.values(monthsMap).sort((a, b) => a.month - b.month);
}

async function getMonthHolidaysFromFlat(year, month) {
  const monthStr = String(month).padStart(2, "0");
  const startDate = `${year}-${monthStr}-01`;
  const endDate = `${year}-${monthStr}-31`;
  const holidays = await Holiday.find({ date: { $gte: startDate, $lte: endDate } });
  const govHolidays = holidays.map((h) => {
    const day = typeof h.date === "string" ? parseInt(h.date.split("-")[2], 10) : new Date(h.date).getDate();
    return { date: day, name: h.name };
  });
  govHolidays.sort((a, b) => a.date - b.date);
  return { month, governmentHolidays: govHolidays, specialDays: [] };
}

async function syncApprovedToFlatHoliday(assignment) {
  try {
    const year = assignment.year;
    console.log(`🚀 Syncing Gov Holidays to master Holiday model for year ${year}`);

    const bulk = [];
    for (const m of assignment.months || []) {
      const month = String(m.month).padStart(2, "0");
      for (const d of m.governmentHolidays || []) {
        if (d.date == null || !d.name) continue;
        const day = String(d.date).padStart(2, "0");
        bulk.push({ date: `${year}-${month}-${day}`, name: d.name });
      }
    }

    if (!bulk.length) {
      console.warn(`No gov holidays to sync for year ${year}`);
      return;
    }

    await Holiday.deleteMany({ date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } });
    const inserted = await Holiday.insertMany(bulk, { ordered: false });
    console.log(`✅ Synced ${inserted.length} gov holidays to master Holiday table for year ${year}`);
  } catch (err) {
    console.error("❌ syncApprovedToFlatHoliday FAILED:", err.message);
  }
}

async function syncApprovedSpecialDays(assignment) {
  try {
    const year = assignment.year;
    console.log(`🚀 Syncing Special Days to master SpecialDay model for year ${year}`);

    const bulk = [];
    for (const m of assignment.months || []) {
      const month = String(m.month).padStart(2, "0");
      for (const s of m.specialDays || []) {
        if (s.date == null || !s.name) continue;
        const day = String(s.date).padStart(2, "0");
        bulk.push({ date: `${year}-${month}-${day}`, name: s.name });
      }
    }

    await SpecialDay.deleteMany({ date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } });

    if (!bulk.length) {
      console.log(`ℹ️ No special days to sync for year ${year}`);
      return;
    }

    const inserted = await SpecialDay.insertMany(bulk, { ordered: false });
    console.log(`✅ Synced ${inserted.length} special days to master SpecialDay table for year ${year}`);
  } catch (err) {
    console.error("❌ syncApprovedSpecialDays FAILED:", err.message);
  }
}

async function cleanupAfterApproval(assignmentId) {
  try {
    // Keep months array intact so HR can view and edit approved calendars
    await HolidayAssignment.findByIdAndUpdate(
      assignmentId,
      {
        $unset: {
          adminRemarks: "",
        },
      },
      { new: true }
    );
    console.log(`✅ HolidayAssignment ${assignmentId} approved and preserved`);
  } catch (err) {
    console.error("❌ cleanupAfterApproval FAILED:", err.message);
  }
}

exports.assignCalendar = async (req, res) => {
  try {
    const { employeeId, year } = req.body;
    const adminId = req.user._id || req.user.id;

    if (!employeeId || !year) {
      return res.status(400).json({ success: false, message: "Employee ID and year are required" });
    }

    const existing = await HolidayAssignment.findOne({ assignedTo: employeeId, year: parseInt(year) });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: `Holiday calendar for ${year} is already assigned to this employee.`,
      });
    }

    const flatHolidays = await Holiday.find({
      date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` },
    });

    let months = [];
    if (flatHolidays.length > 0) months = buildMonthsFromFlatHolidays(flatHolidays);

    const assignment = new HolidayAssignment({
      assignedTo: employeeId,
      assignedBy: adminId,
      year: parseInt(year),
      status: "pending",
      months,
      assignedDate: new Date(),
    });

    await assignment.save();
    const populated = await populateUsers(HolidayAssignment.findById(assignment._id));

    createLog({
      category: "holiday_calendar",
      referenceId: assignment._id,
      description: `${req.user?.name || "Admin"} assigned ${year} Holiday Calendar to ${populated?.assignedTo?.name || "Employee"}`,
    });

    // ─── ADDED: Notify the employee that they were assigned holiday management ───
    try {
      const title = "Holiday Management Assigned";
      const body = `The Admin has assigned you to manage the Holiday calendar for ${year}.`;

      await sendPushNotification(employeeId, title, body, {
        assignmentId: assignment._id.toString(),
        year: year,
        type: "HOLIDAY_ASSIGNED"
      });
    } catch (pushErr) {
      console.error("[HolidayAssignment] Error sending assignment push:", pushErr);
    }

    res.json({
      success: true,
      message: `Holiday calendar ${year} assigned with ${flatHolidays.length} government holidays.`,
      data: populated,
    });
  } catch (err) {
    console.error("Assign calendar error:", err);
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: "Calendar for this year already assigned" });
    }
    res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.getAllAssignments = async (req, res) => {
  try {
    const { year, status, department } = req.query;
    const filter = {};
    if (year) filter.year = parseInt(year);
    if (status) filter.status = status;

    let assignments = await populateUsers(HolidayAssignment.find(filter)).sort({ year: -1 });

    if (department) {
      assignments = assignments.filter((a) => a.assignedTo?.department === department);
    }

    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    // Deduplicate by year and hide upcoming year until December
    const uniqueAssignments = [];
    const seenYears = new Set();
    for (const a of assignments) {
      if (!year && currentMonth < 12 && a.year > currentYear) {
        continue;
      }
      if (!seenYears.has(a.year)) {
        seenYears.add(a.year);
        uniqueAssignments.push(a);
      }
    }

    res.json({ success: true, data: uniqueAssignments });
  } catch (err) {
    console.error("Get all assignments error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.updateCalendarAssignment = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const assignment = await HolidayAssignment.findById(id);
    if (!assignment) {
      return res.status(404).json({ success: false, message: "Assignment not found" });
    }

    const previousStatus = assignment.status;
    if (status) assignment.status = status;
    assignment.updatedAt = new Date();
    await assignment.save();

    if (status === "approved" && previousStatus !== "approved") {
      console.log("🔄 Approved via updateCalendarAssignment — syncing...");

      await syncApprovedToFlatHoliday(assignment);

      await syncApprovedSpecialDays(assignment);

      await cleanupAfterApproval(id);
    }

    res.json({ success: true, message: "Status updated successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.reviewAssignment = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, remarks } = req.body;
    const adminId = req.user._id || req.user.id;

    if (!["approved", "rejected"].includes(action)) {
      return res.status(400).json({ success: false, message: "Action must be 'approved' or 'rejected'" });
    }

    if (action === "rejected" && (!remarks || !remarks.trim())) {
      return res.status(400).json({ success: false, message: "Rejection remarks are required when rejecting a calendar." });
    }

    const assignment = await HolidayAssignment.findById(id);
    if (!assignment) {
      return res.status(404).json({ success: false, message: "Assignment not found" });
    }

    if (assignment.status !== "submitted") {
      return res.status(400).json({ success: false, message: "Can only review submitted assignments" });
    }

    assignment.status = action;
    assignment.adminRemarks = remarks || "";
    assignment.reviewedDate = new Date();
    assignment.reviewedBy = adminId;
    await assignment.save();

    if (action === "approved") {
      await syncApprovedToFlatHoliday(assignment);

      await syncApprovedSpecialDays(assignment);

      await cleanupAfterApproval(id);
    }

    if (action === "approved") {
      createLog({
        category: "holiday_calendar",
        referenceId: assignment._id,
        description: `${req.user?.name || "Admin"} approved ${assignment.year} Holiday Calendar`,
      });
    } else {
      createLog({
        category: "holiday_calendar",
        referenceId: assignment._id,
        description: `${req.user?.name || "Admin"} rejected ${assignment.year} Holiday Calendar. Reason: ${remarks}`,
      });
    }

    const populated = await populateUsers(HolidayAssignment.findById(id));

    res.json({
      success: true,
      message: `Assignment ${action} successfully!`,
      data: populated,
    });
  } catch (err) {
    console.error("Review error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

async function autoSeedCurrentAndUpcomingYears(employeeId, userName) {
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();
  const upcomingYear = currentYear + 1;

  // Upcoming year is ONLY seeded when December month starts (currentMonth >= 12)
  const yearsToSeed = currentMonth >= 12 ? [currentYear, upcomingYear] : [currentYear];

  for (const yr of yearsToSeed) {
    const existing = await HolidayAssignment.findOne({ year: yr });
    if (!existing) {
      const defaultMonths = Array.from({ length: 12 }, (_, i) => ({
        month: i + 1,
        governmentHolidays: [],
        specialDays: [],
      }));
      try {
        const autoAssignment = new HolidayAssignment({
          assignedTo: employeeId,
          assignedBy: employeeId,
          year: yr,
          status: "pending",
          months: defaultMonths,
          assignedDate: new Date(),
        });
        await autoAssignment.save();
        console.log(`✅ On-demand initialized Holiday Calendar for ${yr} assigned to HR/Admin user ${userName || employeeId}`);
      } catch (err) {
        if (err.code !== 11000) {
          console.error(`Auto-seed error for year ${yr}:`, err);
        }
      }
    }
  }
}

exports.getMyAssignments = async (req, res) => {
  try {
    const employeeId = req.user._id || req.user.id;
    const isHrOrAdmin = req.user.isHr || req.user.role === "admin" || req.user.role === "hr";

    const filter = isHrOrAdmin
      ? {}
      : { assignedTo: employeeId };

    let assignments = await populateUsers(
      HolidayAssignment.find(filter)
    ).sort({ year: -1 });

    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    // Deduplicate by year (ensure strictly 1 card per year) and hide upcoming year until December
    const uniqueAssignments = [];
    const seenYears = new Set();
    for (const a of assignments) {
      if (currentMonth < 12 && a.year > currentYear) {
        continue;
      }
      if (!seenYears.has(a.year)) {
        seenYears.add(a.year);
        uniqueAssignments.push(a);
      }
    }

    res.json({ success: true, data: uniqueAssignments });
  } catch (err) {
    console.error("Get my assignments error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.getAssignmentDetail = async (req, res) => {
  try {
    const { id } = req.params;
    let assignment = await populateUsers(HolidayAssignment.findById(id)).populate({
      path: "reviewedBy",
      model: getUserModelName(),
      select: "name",
    });

    if (!assignment) {
      return res.status(404).json({ success: false, message: "Assignment not found" });
    }

    assignment = await populateMonthsIfEmpty(assignment);

    res.json({ success: true, data: assignment });
  } catch (err) {
    console.error("Get detail error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.getGovernmentHolidays = async (req, res) => {
  try {
    const year = parseInt(req.params.year);
    if (!year || isNaN(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ success: false, message: "Invalid year" });
    }

    const holidays = await Holiday.find({
      date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` },
    }).sort({ date: 1 }).lean();

    return res.status(200).json({
      success: true,
      data: holidays.map((h) => ({ _id: h._id, date: h.date.substring(0, 10), name: h.name })),
      total: holidays.length,
    });
  } catch (error) {
    console.error("❌ getGovernmentHolidays error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch government holidays" });
  }
};

exports.updateGovernmentHolidays = async (req, res) => {
  try {
    const year = parseInt(req.params.year);
    if (!year || isNaN(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ success: false, message: "Invalid year" });
    }

    const { holidays } = req.body;
    if (!Array.isArray(holidays)) {
      return res.status(400).json({ success: false, message: "'holidays' array is required in the request body." });
    }

    const bulk = [];
    for (const h of holidays) {
      if (!h.date || !h.name) continue;

      let formattedDate;
      if (typeof h.date === "string" && h.date.length >= 10) {
        formattedDate = h.date.substring(0, 10);
      } else {
        const d = new Date(h.date);
        if (!isNaN(d.getTime())) {
          formattedDate = d.toISOString().substring(0, 10);
        } else {
          continue;
        }
      }

      if (!formattedDate.startsWith(`${year}-`)) {
        continue;
      }

      bulk.push({ date: formattedDate, name: h.name });
    }

    await Holiday.deleteMany({ date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } });

    let insertedCount = 0;
    if (bulk.length > 0) {
      const inserted = await Holiday.insertMany(bulk, { ordered: false });
      insertedCount = inserted.length;
    }

    return res.status(200).json({
      success: true,
      message: `Successfully updated ${insertedCount} government holidays for ${year}`,
      total: insertedCount,
      data: bulk,
    });
  } catch (error) {
    console.error("❌ updateGovernmentHolidays error:", error);
    return res.status(500).json({ success: false, message: "Failed to update government holidays" });
  }
};

exports.getSpecialDays = async (req, res) => {
  try {
    const year = parseInt(req.params.year);
    if (!year || isNaN(year)) {
      return res.status(400).json({ success: false, message: "Invalid year" });
    }

    const specialDays = await SpecialDay.find({
      date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` },
    }).sort({ date: 1 }).lean();

    const transformed = specialDays.map((s) => {
      const day = parseInt(s.date.substring(8, 10), 10);
      const month = parseInt(s.date.substring(5, 7), 10);

      return {
        _id: s._id,
        name: s.name,
        date: s.date.substring(0, 10),
        day,
        month,
        year,
        createdAt: s.createdAt || null,
        updatedAt: s.updatedAt || null,
      };
    });

    // Optional grouped format for existing clients that expect month-based grouping
    const groupedByMonth = Array.from({ length: 12 }, (_, i) => ({
      month: i + 1,
      specialDays: transformed.filter((d) => d.month === i + 1),
    }));

    return res.status(200).json({
      success: true,
      data: transformed,
      total: transformed.length,
      grouped: groupedByMonth,
    });
  } catch (error) {
    console.error("❌ getSpecialDays error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch special days" });
  }
};


exports.createGovernmentHoliday = async (req, res) => {
  try {
    const { name, date } = req.body;

    if (!name || !date) {
      return res.status(400).json({
        success: false,
        message: "Holiday name and date are required",
      });
    }

    const existingHoliday = await Holiday.findOne({ date });
    if (existingHoliday) {
      return res.status(409).json({
        success: false,
        message: "Holiday already exists for this date",
      });
    }

    const newHoliday = await Holiday.create({
      name: name.trim(),
      date,
    });

    return res.status(201).json({
      success: true,
      message: "Government holiday created successfully",
      data: newHoliday,
    });

  } catch (error) {
    console.error("❌ createGovernmentHoliday error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create holiday",
    });
  }
};
exports.deleteGovernmentHoliday = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || !id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({
        success: false,
        message: "Valid holiday ID is required",
      });
    }

    const deleted = await Holiday.findByIdAndDelete(id);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: "Holiday not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Government holiday deleted successfully",
      data: {
        _id: deleted._id,
        name: deleted.name,
        date: deleted.date,
      },
    });
  } catch (error) {
    console.error("❌ deleteGovernmentHoliday error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to delete government holiday",
    });
  }
};

exports.createSpecialDay = async (req, res) => {
  try {
    const { name, date } = req.body;
    if (!name || !date) {
      return res.status(400).json({ success: false, message: "Special day name and date are required" });
    }

    let formattedDate = typeof date === "string" ? date.substring(0, 10) : new Date(date).toISOString().substring(0, 10);

    const exists = await SpecialDay.findOne({ date: formattedDate, name });
    if (exists) {
      return res.status(400).json({ success: false, message: "Special day already exists for this exact date." });
    }

    const newSpecialDay = new SpecialDay({ date: formattedDate, name });
    await newSpecialDay.save();

    return res.status(201).json({
      success: true,
      message: "Special day created successfully",
      data: { _id: newSpecialDay._id, name: newSpecialDay.name, date: newSpecialDay.date }
    });
  } catch (error) {
    console.error("❌ createSpecialDay error:", error);
    return res.status(500).json({ success: false, message: "Failed to create special day" });
  }
};


exports.getAvailableYears = async (req, res) => {
  try {
    const holidays = await Holiday.find({}, { date: 1, _id: 0 }).lean();

    if (!holidays || holidays.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const yearsSet = new Set();
    holidays.forEach((h) => {
      if (h.date && typeof h.date === "string") {
        const year = parseInt(h.date.substring(0, 4));
        if (!isNaN(year)) yearsSet.add(year);
      }
    });

    return res.status(200).json({
      success: true,
      data: [...yearsSet].sort((a, b) => a - b),
    });
  } catch (error) {
    console.error("❌ getAvailableYears error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch available years" });
  }
};

exports.getTodaySpecialDays = async (req, res) => {
  try {
    const today = new Date();
    const currentDay = today.getDate();
    const currentMonth = today.getMonth() + 1;
    const currentYear = today.getFullYear();

    const todayStr = `${currentYear}-${String(currentMonth).padStart(2, "0")}-${String(currentDay).padStart(2, "0")}`;

    const [flatHolidays, flatSpecialDays] = await Promise.all([
      Holiday.find({ date: todayStr }).lean(),
      SpecialDay.find({ date: todayStr }).lean(),
    ]);

    const governmentHolidays = flatHolidays.map((h) => ({
      name: h.name, date: currentDay, month: currentMonth, year: currentYear, type: "government",
    }));

    const specialDays = flatSpecialDays.map((s) => ({
      name: s.name, date: currentDay, month: currentMonth, year: currentYear, type: "special",
    }));

    return res.status(200).json({
      success: true,
      message: `Found ${governmentHolidays.length + specialDays.length} occasion(s) today`,
      data: {
        specialDays,
        governmentHolidays,
        today: { day: currentDay, month: currentMonth, year: currentYear, fullDate: today.toISOString() },
      },
    });
  } catch (error) {
    console.error("❌ getTodaySpecialDays error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch today's special days" });
  }
};

exports.getMonthSpecialDays = async (req, res) => {
  try {
    const today = new Date();
    const month = parseInt(req.query.month) || today.getMonth() + 1;
    const year = parseInt(req.query.year) || today.getFullYear();

    if (month < 1 || month > 12) {
      return res.status(400).json({ success: false, message: "Invalid month. Must be between 1 and 12." });
    }

    const monthStr = String(month).padStart(2, "0");
    const startDate = `${year}-${monthStr}-01`;
    const endDate = `${year}-${monthStr}-31`;

    const [flatHolidays, flatSpecialDays] = await Promise.all([
      Holiday.find({ date: { $gte: startDate, $lte: endDate } }).sort({ date: 1 }).lean(),
      SpecialDay.find({ date: { $gte: startDate, $lte: endDate } }).sort({ date: 1 }).lean(),
    ]);

    const govHolidays = flatHolidays.map((h) => ({
      date: parseInt(h.date.split("-")[2]),
      name: h.name,
      type: "government",
      month,
      year,
    }));

    const specDays = flatSpecialDays.map((s) => ({
      date: parseInt(s.date.split("-")[2]),
      name: s.name,
      type: "special",
      month,
      year,
    }));

    return res.status(200).json({
      success: true,
      message: `Found data for ${month}/${year}`,
      data: {
        month, year,
        governmentHolidays: govHolidays,
        specialDays: specDays,
        totalHolidays: govHolidays.length + specDays.length,
      },
    });
  } catch (error) {
    console.error("❌ getMonthSpecialDays error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch month's special days" });
  }
};

exports.saveMonth = async (req, res) => {
  try {
    const { assignmentId, month, governmentHolidays, specialDays } = req.body;

    if (!assignmentId || !month) {
      return res.status(400).json({ success: false, message: "Assignment ID and month are required" });
    }

    const assignment = await HolidayAssignment.findById(assignmentId);
    if (!assignment) {
      return res.status(404).json({ success: false, message: "Assignment not found" });
    }

    const govDates = (governmentHolidays || []).map(h => parseInt(h.date));
    const specialDates = (specialDays || []).map(h => parseInt(h.date));

    const hasGovDup = govDates.some((d, idx) => govDates.indexOf(d) !== idx);
    if (hasGovDup) {
      return res.status(400).json({ success: false, message: "Duplicate dates found in government holidays" });
    }

    const hasSpecDup = specialDates.some((d, idx) => specialDates.indexOf(d) !== idx);
    if (hasSpecDup) {
      return res.status(400).json({ success: false, message: "Duplicate dates found in special days" });
    }

    const sortedGov = (governmentHolidays || []).sort((a, b) => a.date - b.date);
    const sortedSpecial = (specialDays || []).sort((a, b) => a.date - b.date);

    const monthIndex = assignment.months.findIndex((m) => m.month === parseInt(month));
    if (monthIndex !== -1) {
      assignment.months[monthIndex].governmentHolidays = sortedGov;
      assignment.months[monthIndex].specialDays = sortedSpecial;
    } else {
      assignment.months.push({ month: parseInt(month), governmentHolidays: sortedGov, specialDays: sortedSpecial });
    }

    assignment.months.sort((a, b) => a.month - b.month);
    if (assignment.status === "pending" || assignment.status === "approved" || assignment.status === "submitted") {
      assignment.status = "in-progress";
    }

    await assignment.save();

    res.json({ success: true, message: `Month ${month} saved successfully`, data: assignment });
  } catch (err) {
    console.error("Save month error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.submitAssignment = async (req, res) => {
  try {
    const { assignmentId } = req.body;
    const assignment = await HolidayAssignment.findById(assignmentId);

    if (!assignment) return res.status(404).json({ success: false, message: "Assignment not found" });

    const totalItems = (assignment.months || []).reduce(
      (acc, m) => acc + (m.governmentHolidays?.length || 0) + (m.specialDays?.length || 0),
      0
    );
    if (totalItems === 0) {
      return res.status(400).json({
        success: false,
        message: "Cannot submit an empty holiday calendar. Please add at least one holiday before submitting to Admin.",
      });
    }

    assignment.status = "submitted";
    assignment.submittedDate = new Date();
    await assignment.save();

    const employee = await User.findById(assignment.assignedTo);
    const empName = employee ? employee.name : "An employee";

    createLog({
      category: "holiday_calendar",
      referenceId: assignment._id,
      description: `${empName} submitted ${assignment.year} Holiday Calendar for review`,
    });

    try {
      const title = "Holiday Calendar Submitted";
      const body = `${empName} has sent the ${assignment.year} holiday list. Please check and approve it.`;

      await notifyAdmins(title, body, {
        assignmentId: assignment._id.toString(),
        year: assignment.year,
        type: "HOLIDAY_SUBMITTED"
      });
    } catch (pushErr) {
      console.error("[HolidayAssignment] Error notifying admins on submit:", pushErr);
    }

    res.json({ success: true, message: "Assignment submitted for review!", data: assignment });
  } catch (err) {
    console.error("Submit error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.reassignCalendar = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user._id || req.user.id;

    const assignment = await HolidayAssignment.findById(id);
    if (!assignment) return res.status(404).json({ success: false, message: "Assignment not found" });

    const flatHolidays = await Holiday.find({
      date: { $gte: `${assignment.year}-01-01`, $lte: `${assignment.year}-12-31` },
    });

    const specialDaysMap = {};
    (assignment.months || []).forEach((m) => { specialDaysMap[m.month] = m.specialDays || []; });

    let newMonths = [];
    if (flatHolidays.length > 0) {
      const builtMonths = buildMonthsFromFlatHolidays(flatHolidays);
      newMonths = builtMonths.map((m) => ({
        month: m.month,
        governmentHolidays: m.governmentHolidays || [],
        specialDays: specialDaysMap[m.month] || [],
      }));
      Object.keys(specialDaysMap).forEach((mn) => {
        const mnInt = parseInt(mn);
        if (!newMonths.find((m) => m.month === mnInt) && specialDaysMap[mnInt].length > 0) {
          newMonths.push({ month: mnInt, governmentHolidays: [], specialDays: specialDaysMap[mnInt] });
        }
      });
      newMonths.sort((a, b) => a.month - b.month);
    }

    assignment.months = newMonths;
    assignment.status = "pending";
    assignment.adminRemarks = "";
    assignment.assignedBy = adminId;
    assignment.assignedDate = new Date();
    assignment.submittedDate = undefined;
    assignment.reviewedDate = undefined;

    await assignment.save();
    const populated = await populateUsers(HolidayAssignment.findById(id));

    createLog({
      category: "holiday_calendar",
      referenceId: assignment._id,
      description: `${req.user?.name || "Admin"} reassigned ${assignment.year} Holiday Calendar to ${populated?.assignedTo?.name || "Employee"}`,
    });

    res.json({
      success: true,
      message: `Reassigned with ${flatHolidays.length} government holidays. Special days preserved.`,
      data: populated,
    });
  } catch (err) {
    console.error("Reassign error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.deleteAssignment = async (req, res) => {
  try {
    const { id } = req.params;
    const assignment = await HolidayAssignment.findById(id);
    if (!assignment) return res.status(404).json({ success: false, message: "Assignment not found" });

    createLog({
      category: "holiday_calendar",
      referenceId: assignment._id,
      description: `${req.user?.name || "Admin"} deleted ${assignment.year} Holiday Calendar assignment`,
    });

    await HolidayAssignment.findByIdAndDelete(id);
    res.json({ success: true, message: "Assignment deleted successfully" });
  } catch (err) {
    console.error("Delete error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.previewMasterData = async (req, res) => {
  try {
    const yearInt = parseInt(req.params.year);
    const flatHolidays = await Holiday.find({
      date: { $gte: `${yearInt}-01-01`, $lte: `${yearInt}-12-31` },
    }).sort({ date: 1 });

    if (!flatHolidays || flatHolidays.length === 0) {
      return res.json({ success: true, data: null, message: `No holiday data for year ${yearInt}` });
    }

    const months = buildMonthsFromFlatHolidays(flatHolidays);
    const totalGov = months.reduce((sum, m) => sum + (m.governmentHolidays?.length || 0), 0);

    res.json({
      success: true,
      data: {
        year: yearInt,
        months,
        summary: { totalGovHolidays: totalGov, totalSpecialDays: 0, monthsWithData: months.length },
      },
    });
  } catch (err) {
    console.error("Preview master error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.getApprovedCalendar = async (req, res) => {
  try {
    const { employeeId, year } = req.params;
    const assignment = await populateUsers(
      HolidayAssignment.findOne({ assignedTo: employeeId, year: parseInt(year), status: "approved" })
    );
    if (!assignment) {
      return res.status(404).json({ success: false, message: "No approved calendar found" });
    }
    res.json({ success: true, data: assignment });
  } catch (err) {
    console.error("Get approved calendar error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.checkExistingAssignment = async (req, res) => {
  try {
    const { employeeId, year } = req.query;
    if (!employeeId || !year) {
      return res.status(400).json({ success: false, message: "employeeId and year are required" });
    }
    const existing = await HolidayAssignment.findOne({ assignedTo: employeeId, year: parseInt(year) });
    if (existing) {
      return res.json({ success: true, exists: true, assignment: { _id: existing._id, year: existing.year, status: existing.status, assignedDate: existing.assignedDate } });
    }
    return res.json({ success: true, exists: false, assignment: null });
  } catch (err) {
    console.error("Check existing assignment error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.deleteSingleHoliday = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await Holiday.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ success: false, message: "Holiday not found" });
    res.json({ success: true, message: "Holiday deleted successfully" });
  } catch (err) {
    console.error("Delete single holiday error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.getUnassignedYearAlert = async (req, res) => {
  try {
    const now = new Date();
    const currentMonth = now.getMonth() + 1; // 1 to 12
    const currentYear = now.getFullYear();
    const upcomingYear = currentYear + 1;

    // From December 1st onwards: check upcoming year
    if (currentMonth >= 12) {
      const assignment = await HolidayAssignment.findOne({ year: upcomingYear });

      // After Admin approves it, banner is NOT shown for Admin
      if (assignment && assignment.status === "approved") {
        return res.json({
          success: true,
          showAlert: false,
          year: upcomingYear,
          status: "approved",
        });
      }

      // When HR sends to Admin, Admin sees banner to review and approve
      if (assignment && assignment.status === "submitted") {
        return res.json({
          success: true,
          showAlert: true,
          unassigned: false,
          year: upcomingYear,
          currentYear,
          isUpcoming: true,
          status: "submitted",
          title: `Holiday Calendar Submitted for Approval (${upcomingYear})`,
          message: `HR has submitted the ${upcomingYear} holiday calendar for review. Please review and approve it.`,
        });
      }

      // If unassigned or pending/rejected: show banner to Admin to send reminder
      return res.json({
        success: true,
        showAlert: true,
        unassigned: !assignment,
        year: upcomingYear,
        currentYear,
        isUpcoming: true,
        status: assignment ? assignment.status : "unassigned",
        title: `Holiday Calendar Not Uploaded for ${upcomingYear}`,
        message: `The holidays are not uploaded for ${upcomingYear}. Send reminder to HR to upload the holidays.`,
      });
    }

    // Before December (Jan - Nov): check currentYear
    const currentAssignment = await HolidayAssignment.findOne({ year: currentYear });

    // Once current year is approved, do not show alert
    if (currentAssignment && currentAssignment.status === "approved") {
      return res.json({
        success: true,
        showAlert: false,
        unassigned: false,
        year: currentYear,
        currentYear,
        isUpcoming: false,
        status: "approved",
      });
    }

    // If submitted, show banner to Admin to review and approve
    if (currentAssignment && currentAssignment.status === "submitted") {
      return res.json({
        success: true,
        showAlert: true,
        unassigned: false,
        year: currentYear,
        currentYear,
        isUpcoming: false,
        status: "submitted",
        title: `Holiday Calendar Submitted for Approval (${currentYear})`,
        message: `The ${currentYear} holiday calendar has been submitted for review. Please review and approve it.`,
      });
    }

    // Holidays are not uploaded for currentYear: show banner to Admin to send reminder to HR
    return res.json({
      success: true,
      showAlert: true,
      unassigned: !currentAssignment,
      year: currentYear,
      currentYear,
      isUpcoming: false,
      status: currentAssignment ? currentAssignment.status : "unassigned",
      title: `Holiday Calendar Not Uploaded for ${currentYear}`,
      message: `The holidays are not uploaded for ${currentYear}. Send reminder to HR to upload the holidays.`,
    });
  } catch (err) {
    console.error("Get unassigned year alert error:", err);
    return res.status(500).json({ success: false, message: "Server error checking unassigned year alert" });
  }
};

exports.getHRPendingAlert = async (req, res) => {
  try {
    const isHrOrAdmin = req.user.isHr || req.user.role === "admin" || req.user.role === "hr";
    if (!isHrOrAdmin) {
      return res.json({ success: true, showAlert: false });
    }

    const now = new Date();
    const currentMonth = now.getMonth() + 1; // 1 to 12
    const currentYear = now.getFullYear();
    const upcomingYear = currentYear + 1;

    // Upcoming year banner only shows starting in December!
    if (currentMonth >= 12) {
      const assignment = await HolidayAssignment.findOne({ year: upcomingYear });

      // After HR sends to Admin ("submitted") or Admin approves ("approved"):
      // BANNER IS NOT SHOWN FOR HR!
      if (assignment && (assignment.status === "submitted" || assignment.status === "approved")) {
        return res.json({
          success: true,
          showAlert: false,
          year: upcomingYear,
          status: assignment.status,
        });
      }

      // If pending, in-progress, or rejected, or unassigned: show banner to HR
      return res.json({
        success: true,
        showAlert: true,
        year: upcomingYear,
        status: assignment ? assignment.status : "unassigned",
        remarks: assignment ? assignment.adminRemarks : "",
        title: assignment?.status === "rejected"
          ? `Action Required: Changes Requested for ${upcomingYear} Holidays`
          : `Upload Holidays for ${upcomingYear}`,
        message: assignment?.status === "rejected"
          ? `Admin requested changes for ${upcomingYear} holidays: "${assignment.adminRemarks}". Please update and re-submit.`
          : `The holidays are not uploaded for ${upcomingYear}. Please upload and configure the holiday calendar and submit to Admin for approval.`,
      });
    }

    // Before December (Jan - Nov): check currentYear
    const currentAssignment = await HolidayAssignment.findOne({ year: currentYear });

    // When HR uploads the Data and sends to Admin for Approval ("submitted") or "approved":
    // BANNER FOR UPLOAD HOLIDAYS IS NOT SHOWN FOR HR DASHBOARD!
    if (currentAssignment && (currentAssignment.status === "submitted" || currentAssignment.status === "approved")) {
      return res.json({
        success: true,
        showAlert: false,
        year: currentYear,
        status: currentAssignment.status,
      });
    }

    // Holidays are not uploaded for currentYear: show banner to HR
    return res.json({
      success: true,
      showAlert: true,
      year: currentYear,
      status: currentAssignment ? currentAssignment.status : "unassigned",
      remarks: currentAssignment ? currentAssignment.adminRemarks : "",
      title: currentAssignment?.status === "rejected"
        ? `Action Required: Changes Requested for ${currentYear} Holidays`
        : `Upload Holidays for ${currentYear}`,
      message: currentAssignment?.status === "rejected"
        ? `Admin requested changes for ${currentYear} holidays: "${currentAssignment.adminRemarks}". Please update and re-submit.`
        : `The holidays are not uploaded for ${currentYear}. Please upload and configure the holiday calendar and submit to Admin for approval.`,
    });
  } catch (err) {
    console.error("Get HR pending alert error:", err);
    return res.status(500).json({ success: false, message: "Server error checking HR pending alert" });
  }
};

exports.sendHRReminder = async (req, res) => {
  try {
    const { year } = req.body;
    const targetYear = parseInt(year) || new Date().getFullYear();

    const hrUsers = await User.find({
      $or: [{ isHr: true }, { role: "hr" }, { role: "HR" }],
      employmentStatus: "active",
    });

    if (!hrUsers || hrUsers.length === 0) {
      return res.status(404).json({ success: false, message: "No active HR found to remind." });
    }

    const Notification = require("../Models/Notification");
    const notifications = hrUsers.map((hr) => ({
      type: "SYSTEM_REMINDER",
      toEmployee: hr._id,
      title: `Action Required: Upload Holiday Calendar for ${targetYear}`,
      message: `Admin has requested you to upload and configure the holiday calendar for ${targetYear} and submit it for approval.`,
      metadata: { requestType: "HOLIDAY_REMINDER", year: targetYear },
    }));

    if (notifications.length > 0) {
      await Notification.insertMany(notifications);
    }

    for (const hr of hrUsers) {
      try {
        await sendPushNotification(
          hr._id,
          `Action Required: Upload Holiday Calendar for ${targetYear}`,
          `Admin has requested you to upload and configure the holiday calendar for ${targetYear}.`,
          { type: "HOLIDAY_REMINDER", year: targetYear }
        );
      } catch (pushErr) {
        // Push notification fail safe
      }
    }

    createLog({
      category: "holiday_calendar",
      description: `${req.user?.name || "Admin"} sent reminder to HR to upload ${targetYear} Holiday Calendar`,
    });

    return res.json({
      success: true,
      message: `Reminder sent to HR successfully.`,
    });
  } catch (err) {
    console.error("sendHRReminder error:", err);
    return res.status(500).json({ success: false, message: "Server error sending reminder" });
  }
};

exports.initDraft = async (req, res) => {
  try {
    const { year } = req.body;
    const employeeId = req.user._id || req.user.id;
    const targetYear = parseInt(year) || new Date().getFullYear();

    let existing = await HolidayAssignment.findOne({ year: targetYear });
    if (existing) {
      const populated = await populateUsers(HolidayAssignment.findById(existing._id));
      return res.json({ success: true, message: `Calendar for ${targetYear} already exists`, data: populated });
    }

    const defaultMonths = Array.from({ length: 12 }, (_, i) => ({
      month: i + 1,
      governmentHolidays: [],
      specialDays: [],
    }));

    const assignment = new HolidayAssignment({
      assignedTo: employeeId,
      assignedBy: employeeId,
      year: targetYear,
      status: "pending",
      months: defaultMonths,
      assignedDate: new Date(),
    });

    await assignment.save();
    const populated = await populateUsers(HolidayAssignment.findById(assignment._id));

    createLog({
      category: "holiday_calendar",
      referenceId: assignment._id,
      description: `${req.user?.name || "HR"} initialized ${targetYear} Holiday Calendar draft`,
    });

    return res.json({
      success: true,
      message: `Draft calendar for ${targetYear} created`,
      data: populated,
    });
  } catch (err) {
    console.error("Init draft error:", err);
    return res.status(500).json({ success: false, message: "Server error initializing draft" });
  }
};

exports.dismissAssignmentNotification = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?._id || req.user?.id;
    const cleanId = String(id).replace(/^calendar-(?:approved-)?/, "");
    if (mongoose.Types.ObjectId.isValid(cleanId)) {
      const updateObj = { isDismissed: true };
      const updateOp = { $set: updateObj };
      if (userId && mongoose.Types.ObjectId.isValid(userId)) {
        updateOp.$addToSet = { dismissedBy: userId };
      }
      await HolidayAssignment.findByIdAndUpdate(cleanId, updateOp);
    }
    return res.status(200).json({ success: true, message: "Notification dismissed successfully" });
  } catch (err) {
    console.error("Dismiss assignment notification error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
