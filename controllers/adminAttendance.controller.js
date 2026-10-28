const mongoose = require("mongoose");
const Attendance = require("../Models/Attendance.model");
const PermissionRequest = require("../Models/PermissionRequest");
const Employee = require("../Models/Employee");
const EmployeeDetails = require("../Models/EmployeeDetails");
const Holiday = require("../Models/Holiday.model");
const moment = require("moment-timezone");
const { calculateMonthlyAttendance } = require("../Services/attendanceCalculator.service");
const ExcelJS = require("exceljs");
const LeaveRequest = require("../Models/LeaveRequest");
const LeaveCategory = require("../Models/LeaveCategory");
const LeaveBalance = require("../Models/LeaveBalance");
const { isEmployeeInProbation } = require("../utilities/probationHelper");
const { calculateServiceMonths, calculateCategoryLeaves } = require("../utilities/financialYearUtil");
const generateSignedUrl = require("../utilities/s3SignedUrl");
const getCachedSignedUrl = require("../utilities/s3CachedUrl");
const apiLogger = require('../utils/apiLogger');
const { sendPushNotification } = require("../utilities/notificationService");
const Notification = require("../Models/Notification");
const { createLog } = require("../utilities/logService");
const AttendanceConfig = require("../Models/AttendanceConfig.model");
const { rescheduleDailyAttendanceReportCron } = require("../Crons/attendance.cron");
/* ═══════════════════════════════════════════════
   SECURITY HELPERS
═══════════════════════════════════════════════ */

const getClientIP = (req) => {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    "unknown"
  );
};

const isValidAdmin = (req) => {
  return req.user && (req.user.role === "admin" || req.user.isAdmin === true || req.user.isHr === true);
};

function getISTDateTime() {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

const adminAttendanceController = {

  /* ═══════════════════════════════════════════════
     1. MONTHLY ANALYTICS
  ═══════════════════════════════════════════════ */
  async getMonthlyAnalytics(req, res) {
    try {
      if (!isValidAdmin(req)) {
        return res.status(403).json({ success: false, message: "Admin access required" });
      }

      const { month, year } = req.query;
      const m = Number(month);
      const y = Number(year);

      if (!m || !y) {
        return res.status(400).json({ success: false, message: "Month and year required" });
      }

      if (m < 1 || m > 12 || y < 2000 || y > 2100) {
        return res.status(400).json({ success: false, message: "Invalid month or year" });
      }

      const start = moment.tz({ year: y, month: m - 1, day: 1 }, "Asia/Kolkata").startOf("month");
      const end = start.clone().endOf("month");
      const today = moment().tz("Asia/Kolkata").startOf("day");

      const employees = await Employee.find({
        employmentStatus: "active",
        role: { $ne: "admin" }
      }).select("_id joiningDate dateOfJoining dateJoined createdAt").lean();

      const records = await Attendance.find({
        date: {
          $gte: start.format("YYYY-MM-DD"),
          $lte: end.format("YYYY-MM-DD"),
        },
      }).lean();

      const holidays = await Holiday.find({ date: { $regex: `^${y}-` } }).lean();

      const leaveRequests = await LeaveRequest.find({
        status: "Approved",
        requestType: { $ne: "wfh" }, // ✅ EXCLUDE WFH FROM LEAVE COUNT
        fromDate: { $lte: end.toDate() },
        toDate: { $gte: start.toDate() },
      }).lean();

      // ✅ FIX 5: Already correct - reading PermissionRequest separately
      const permissions = await PermissionRequest.find({
        status: { $in: ["APPROVED", "INFORMED"] },
        from: { $lte: end.toDate() },
        to: { $gte: start.toDate() },
      }).lean();

      const attendanceMap = {};
      const permissionMap = {};
      const leaveMap = {};

      records.forEach((r) => {
        const day = r.date;
        if (!attendanceMap[day]) attendanceMap[day] = { present: 0, leave: 0, absent: 0 };

        // 1. Check status field first (Direct override)
        if (r.status === "Present" || (r.checkIn1 || r.checkInTime)) {
          attendanceMap[day].present++;
        } else if (r.status === "Leave") {
          attendanceMap[day].leave++;
        } else if (r.status === "Absent") {
          attendanceMap[day].absent++;
        }
      });

      permissions.forEach((p) => {
        const day = moment(p.from).format("YYYY-MM-DD");
        permissionMap[day] = (permissionMap[day] || 0) + 1;
      });

      // FIX: Build leaveMap keyed by employeeId per date for accurate per-day counts
      const leaveDayEmpMap = {}; // { "YYYY-MM-DD": { [employeeId]: maxLeaveWeight } }
      leaveRequests.forEach((l) => {
        let current = moment(l.fromDate);
        const endDate = moment(l.toDate || l.fromDate);
        const val = l.dayType === "Half Day" ? 0.5 : 1;
        while (!current.isAfter(endDate, "day")) {
          const d = current.format("YYYY-MM-DD");
          if (!leaveDayEmpMap[d]) leaveDayEmpMap[d] = {};
          const empId = l.employeeId.toString();
          leaveDayEmpMap[d][empId] = Math.max(leaveDayEmpMap[d][empId] || 0, val);
          current.add(1, "day");
        }
      });

      Object.keys(leaveDayEmpMap).forEach((d) => {
        const sum = Object.values(leaveDayEmpMap[d]).reduce((acc, curr) => acc + curr, 0);
        leaveMap[d] = (leaveMap[d] || 0) + sum;
      });

      const holidaySet = new Set(holidays.map((h) => moment(h.date).format("YYYY-MM-DD")));

      const analytics = [];

      for (let d = 1; d <= end.date(); d++) {
        const currentDate = start.clone().date(d);
        const date = currentDate.format("YYYY-MM-DD");

        const isFuture = currentDate.isAfter(today, "day");
        const isHoliday = holidaySet.has(date);
        const dayOfWeek = currentDate.day();

        const isSunday = dayOfWeek === 0;
        const isSecondSaturday = dayOfWeek === 6 && Math.ceil(d / 7) === 2;
        const isFourthSaturday = dayOfWeek === 6 && Math.ceil(d / 7) === 4;

        const present = attendanceMap[date]?.present || 0;
        const permission = permissionMap[date] || 0;
        const attendanceLeave = attendanceMap[date]?.leave || 0;
        const approvedLeave = (leaveMap[date] || 0);

        const finalLeaveCount = Math.max(attendanceLeave, approvedLeave);

        const isWeekend = isSunday || isSecondSaturday || isFourthSaturday;
        const currentHour = moment().tz("Asia/Kolkata").hour();
        const isTodayDate = currentDate.isSame(today, "day");
        const isPastAbsentTime = !isTodayDate || currentHour >= 11;

        const activeEmployees = employees.filter((emp) => {
          const joining = emp.joiningDate || emp.dateOfJoining || emp.dateJoined || emp.createdAt;
          if (!joining) return true;
          const joiningDate = moment(joining).tz("Asia/Kolkata").startOf("day");
          return joiningDate.isSameOrBefore(currentDate, "day");
        });

        let absent = 0;

        if (!isHoliday && !isWeekend && !isFuture && isPastAbsentTime) {
          const totalActiveEmployees = activeEmployees.length;

          absent = Math.max(
            0,
            totalActiveEmployees - present - permission - finalLeaveCount
          );
        }

        analytics.push({
          date,
          ontime: isFuture ? 0 : present,
          permission: isFuture ? 0 : permission,
          leave: isFuture ? 0 : finalLeaveCount,
          absent,
          isHoliday,
          isWeekend,
        });
      }

      return res.json({ success: true, data: analytics });
    } catch (err) {
      console.error("❌ getMonthlyAnalytics error:", err);
      return res.status(500).json({ success: false, message: "Monthly analytics failed" });
    }
  },

  /* ═══════════════════════════════════════════════
     2. DAILY ATTENDANCE — FIX 1 APPLIED
  ═══════════════════════════════════════════════ */
  async getDailyAttendance(req, res) {
    try {
      if (!isValidAdmin(req)) {
        return res.status(403).json({ success: false, message: "Admin access required" });
      }

      const date = req.query.date
        ? moment(req.query.date).tz("Asia/Kolkata").format("YYYY-MM-DD")
        : moment().tz("Asia/Kolkata").format("YYYY-MM-DD");

      const records = await Attendance.find({
        date: date,
        status: { $in: ["Present", "Half Day", "Half Day Leave"] },
      })
        .populate("employeeId", "name designation photo")
        .select("employeeId checkInTime checkOutTime checkIn1 checkOut1 checkIn2 checkOut2 remarks workingMinutes checkInIPAddress checkInIPReason checkOutIPAddress checkOutIPReason")
        .lean();

      // Fetch all approved permission requests on this date
      const startOfDay = moment(date).tz("Asia/Kolkata").startOf("day").toDate();
      const endOfDay = moment(date).tz("Asia/Kolkata").endOf("day").toDate();

      const approvedPermissions = await PermissionRequest.find({
        status: { $in: ["APPROVED", "INFORMED"] },
        from: { $gte: startOfDay, $lte: endOfDay },
      }).populate("approvedBy", "name").lean();

      // Create a map of employeeId -> permission record
      const permissionMap = {};
      approvedPermissions.forEach((p) => {
        permissionMap[p.employeeId.toString()] = p;
      });

      const formatted = await Promise.all(
        records.map(async (r) => {
          const empId = r.employeeId?._id?.toString();
          const permission = empId ? permissionMap[empId] : null;
          let permissionMinutes = 0;
          if (permission) {
            permissionMinutes = Math.round((new Date(permission.to) - new Date(permission.from)) / 60000);
          }

          let avatarUrl = "/avatar.png";
          if (r.employeeId?.photo && r.employeeId?.photo !== "avatar.png") {
            avatarUrl = await getCachedSignedUrl(r.employeeId.photo);
          }

          let loginTimeToShow = r.checkIn1 || r.checkInTime;
          let logoutTimeToShow = r.checkOutTime;

          if (r.checkIn2) {
            loginTimeToShow = r.checkIn2;
            if (r.checkOut2) {
              logoutTimeToShow = r.checkOut2;
            } else {
              logoutTimeToShow = undefined;
            }
          } else {
            loginTimeToShow = r.checkIn1 || r.checkInTime;
            logoutTimeToShow = r.checkOut1 || r.checkOutTime;
          }

          let remarksToShow = r.remarks;
          if (permission) {
            remarksToShow = permission.status === "INFORMED" ? "Informed Permission" : "Approved Permission";
          }

          return {
            employeeId: r.employeeId?._id || null,
            employeeName: r.employeeId?.name || "-",
            designation: r.employeeId?.designation || "-",
            avatar: avatarUrl,
            login: loginTimeToShow,
            logout: logoutTimeToShow,
            checkIn1: r.checkIn1,
            checkOut1: r.checkOut1,
            checkIn2: r.checkIn2,
            checkOut2: r.checkOut2,
            remarks: remarksToShow,
            checkInIPAddress: r.checkInIPAddress || null,
            checkInIPReason: r.checkInIPReason || null,
            checkOutIPAddress: r.checkOutIPAddress || null,
            checkOutIPReason: r.checkOutIPReason || null,
            workingMinutes: (() => {
              if ((r.checkIn2 && !r.checkOut2) || (r.checkIn1 && !r.checkOut1 && !r.checkIn2)) {
                return 0;
              }
              let totalMs = 0;
              if (r.checkIn1 && r.checkOut1) {
                totalMs += new Date(r.checkOut1) - new Date(r.checkIn1);
              }
              if (r.checkIn2 && r.checkOut2) {
                totalMs += new Date(r.checkOut2) - new Date(r.checkIn2);
              }
              if (totalMs > 0) {
                return Math.floor(totalMs / 60000);
              }
              return r.workingMinutes;
            })(),
            permissionMinutes: permissionMinutes,
            hasPermission: !!permission,
            permissionDetails: permission ? {
              from: permission.from,
              to: permission.to,
              reason: permission.reason,
              permissionType: permission.permissionType,
              status: permission.status,
              approvedBy: permission.approvedBy?.name || "-",
              approvedAt: permission.approvedAt,
            } : null
          };
        })
      );

      return res.json({ success: true, data: formatted });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ success: false, message: "Daily attendance fetch failed" });
    }
  },

  async getDailyLeaves(req, res) {
    try {
      if (!isValidAdmin(req)) {
        return res.status(403).json({ success: false, message: "Admin access required" });
      }

      const dateMoment = req.query.date
        ? moment(req.query.date).tz("Asia/Kolkata").startOf("day")
        : moment().tz("Asia/Kolkata").startOf("day");

      const dateStr = dateMoment.format("YYYY-MM-DD");
      const start = dateMoment.toDate();
      const end = dateMoment.clone().endOf("day").toDate();

      // 1. Fetch All Active Employees (excluding admin)
      const activeEmployees = await Employee.find({
        employmentStatus: "active",
        role: { $ne: "admin" }
      })
        .select("_id name designation joiningDate dateOfJoining dateJoined createdAt")
        .lean();

      // 2. Fetch Approved Leaves (excluding WFH)
      const leaveRequests = await LeaveRequest.find({
        status: "Approved",
        requestType: { $ne: "wfh" },
        fromDate: { $lte: end },
        toDate: { $gte: start },
      }).lean();

      // 3. Fetch Attendance records (to check manual status)
      const todayAttendance = await Attendance.find({
        date: dateStr
      }).select("employeeId status checkInTime checkIn1").lean();

      const attendanceStatusMap = {};
      const attendanceEmployeeIds = new Set();
      todayAttendance.forEach(a => {
        const empIdStr = a.employeeId.toString();
        attendanceStatusMap[empIdStr] = a.status || ((a.checkIn1 || a.checkInTime) ? "Present" : null);
        attendanceEmployeeIds.add(empIdStr);
      });

      const presentEmployeeIds = new Set(
        todayAttendance
          .filter(a => a.status === "Present" || ((a.checkIn1 || a.checkInTime) && !["Leave", "Absent", "Half Day", "Half Day Leave"].includes(a.status)))
          .map(a => a.employeeId.toString())
      );

      // Filter by joining date OR if they have an explicit attendance record today
      const currentEmployees = activeEmployees.filter((emp) => {
        const empIdStr = emp._id.toString();
        if (attendanceEmployeeIds.has(empIdStr)) return true;

        const joining = emp.joiningDate || emp.dateOfJoining || emp.dateJoined || emp.createdAt;
        if (!joining) return true;
        const joiningDate = moment(joining).tz("Asia/Kolkata").startOf("day");
        return joiningDate.isSameOrBefore(dateMoment, "day");
      });

      // 4. Check for Holiday/Weekend
      const holidays = await Holiday.find({ date: dateStr }).lean();
      const isHoliday = holidays.length > 0;
      const dayOfWeek = dateMoment.day();
      const dayOfMonth = dateMoment.date();
      const isSunday = dayOfWeek === 0;
      const isSecondSaturday = dayOfWeek === 6 && Math.ceil(dayOfMonth / 7) === 2;
      const isFourthSaturday = dayOfWeek === 6 && Math.ceil(dayOfMonth / 7) === 4;
      const isWeekend = isSunday || isSecondSaturday || isFourthSaturday;

      const today = moment().tz("Asia/Kolkata").startOf("day");
      const isToday = dateMoment.isSame(today, "day");
      const currentHour = moment().tz("Asia/Kolkata").hour();
      const isPastAbsentTime = !isToday || currentHour >= 11;

      // 5. Group Results
      const leaveData = [];
      const absentData = [];

      currentEmployees.forEach(emp => {
        const empIdStr = emp._id.toString();

        const manualStatus = attendanceStatusMap[empIdStr];
        const leaveRequest = leaveRequests.find(l => l.employeeId.toString() === empIdStr);
        const isHalfDayLeave = leaveRequest?.dayType === "Half Day" || manualStatus === "Half Day" || manualStatus === "Half Day Leave";

        if (presentEmployeeIds.has(empIdStr) && !isHalfDayLeave) {
          return;
        }

        if (leaveRequest || manualStatus === "Leave" || manualStatus === "Half Day Leave" || manualStatus === "Half Day") {
          leaveData.push({
            employeeName: emp.name,
            designation: emp.designation || "-",
            type: isHalfDayLeave ? "Half Day Leave" : "Leave"
          });
        } else if (manualStatus === "Absent" || (!manualStatus && !isHoliday && !isWeekend && isPastAbsentTime)) {
          absentData.push({
            employeeName: emp.name,
            designation: emp.designation || "-",
            type: "Absent"
          });
        }
      });

      return res.json({
        success: true,
        data: [...leaveData, ...absentData],
      });

    } catch (err) {
      console.error("❌ getDailyLeaves error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch daily leaves"
      });
    }
  },

  /* ═══════════════════════════════════════════════
     4. DEPARTMENTS
  ═══════════════════════════════════════════════ */
  async getDepartments(req, res) {
    try {
      if (!isValidAdmin(req)) {
        return res.status(403).json({ success: false, message: "Admin access required" });
      }

      const departments = await Employee.distinct("department", { employmentStatus: "active" });
      return res.json({ success: true, data: departments.sort() });
    } catch (err) {
      console.error("getDepartments error:", err);
      return res.status(500).json({ success: false, message: "Failed to fetch departments" });
    }
  },

  /* ═══════════════════════════════════════════════
     5. ATTENDANCE REPORT — FIX 2 APPLIED
  ═══════════════════════════════════════════════ */
  async getAttendanceReport(req, res) {
    try {
      if (!isValidAdmin(req)) {
        return res.status(403).json({ success: false, message: "Admin access required" });
      }

      const { month, year, search = "", department } = req.query;
      const y = Number(year);
      const m = month === "ALL" ? null : Number(month);

      if (!y) {
        return res.status(400).json({ success: false, message: "Year required" });
      }

      const sanitizedSearch = String(search).replace(/[<>{}$]/g, "").trim().substring(0, 100);

      let startDate, endDate;
      if (!m) {
        startDate = moment.tz({ year: y, month: 0, day: 1 }, "Asia/Kolkata").startOf("year");
        endDate = startDate.clone().endOf("year");
      } else {
        startDate = moment.tz({ year: y, month: m - 1, day: 1 }, "Asia/Kolkata").startOf("month");
        endDate = startDate.clone().endOf("month");
      }

      const empQuery = {
        role: { $ne: "admin" },
        name: { $regex: sanitizedSearch, $options: "i" },
        employmentStatus: { $in: ["active", "relieved"] },
        dateJoined: { $lte: endDate.toDate() },
        $or: [
          { dateRelieved: { $exists: false } },
          { dateRelieved: null },
          { dateRelieved: { $gte: startDate.toDate() } }
        ]
      };

      if (department) empQuery.department = String(department).trim();

      const employees = await Employee.find(
        empQuery,
        "_id name designation photo employmentStatus dateJoined dateRelieved createdAt"
      ).lean();

      if (employees.length === 0) {
        return res.json({ success: true, data: [] });
      }

      const employeeIds = employees.map(emp => emp._id);

      // ✅ FIX 2: Bulk fetch with PermissionRequest included
      const [allAttendance, allLeaves, allHolidays, allPermissions] =
        await Promise.all([
          Attendance.find({
            employeeId: { $in: employeeIds },
            date: {
              $gte: startDate.format("YYYY-MM-DD"),
              $lte: endDate.format("YYYY-MM-DD"),
            },
          }).lean(),

          LeaveRequest.find({
            employeeId: { $in: employeeIds },
            status: "Approved",
            fromDate: { $lte: endDate.toDate() },
            toDate: { $gte: startDate.toDate() },
          }).lean(),

          Holiday.find({
            date: {
              $gte: startDate.format("YYYY-MM-DD"),
              $lte: endDate.format("YYYY-MM-DD"),
            },
          }).lean(),

          PermissionRequest.find({
            employeeId: { $in: employeeIds },
            status: { $in: ["APPROVED", "INFORMED"] },
            from: { $lte: endDate.toDate() },
            to: { $gte: startDate.toDate() },
          }).lean(),
        ]);

      const holidaySet = new Set(allHolidays.map(h => h.date));
      const today = moment().tz("Asia/Kolkata").startOf("day");

      // Group attendance records by employee
      const attByEmp = {};
      allAttendance.forEach(a => {
        const eid = a.employeeId.toString();
        if (!attByEmp[eid]) attByEmp[eid] = new Map();
        attByEmp[eid].set(a.date, a);
      });

      const leavesByEmp = {};
      const wfhByEmp = {};

      // ✅ FIX 2: Build permissionByEmp map (count per employee)
      const permissionByEmp = {};
      allPermissions.forEach((p) => {
        const eid = p.employeeId.toString();
        if (!permissionByEmp[eid]) {
          permissionByEmp[eid] = 0;
        }
        permissionByEmp[eid]++;
      });

      allLeaves.forEach(l => {
        const eid = l.employeeId.toString();
        const isWFH = l.requestType === "wfh";
        if (isWFH) {
          if (!wfhByEmp[eid]) wfhByEmp[eid] = new Set();
          if (Array.isArray(l.leaveDates) && l.leaveDates.length > 0) {
            l.leaveDates.forEach(d => wfhByEmp[eid].add(d));
          } else {
            let curr = moment(l.fromDate).tz("Asia/Kolkata");
            const lEnd = moment(l.toDate || l.fromDate).tz("Asia/Kolkata");
            while (!curr.isAfter(lEnd, "day")) {
              wfhByEmp[eid].add(curr.format("YYYY-MM-DD"));
              curr.add(1, "day");
            }
          }
        } else {
          if (!leavesByEmp[eid]) leavesByEmp[eid] = new Map();
          const leaveInfo = {
            dayType: l.dayType,
            noOfDays: l.noOfDays,
          };
          if (Array.isArray(l.leaveDates) && l.leaveDates.length > 0) {
            l.leaveDates.forEach(d => leavesByEmp[eid].set(d, leaveInfo));
          } else {
            let curr = moment(l.fromDate).tz("Asia/Kolkata");
            const lEnd = moment(l.toDate || l.fromDate).tz("Asia/Kolkata");
            while (!curr.isAfter(lEnd, "day")) {
              leavesByEmp[eid].set(curr.format("YYYY-MM-DD"), leaveInfo);
              curr.add(1, "day");
            }
          }
        }
      });

      // ✅ Process in memory
      const finalResults = await Promise.all(employees.map(async (emp) => {
        const eid = emp._id.toString();
        const empAttMap = attByEmp[eid] || new Map();
        const empLeaveMap = leavesByEmp[eid] || new Map();
        const empWfhSet = wfhByEmp[eid] || new Set();

        // ✅ FIX 2: Get permissionCount from permissionByEmp map (not from loop)
        const permissionCount = permissionByEmp[eid] || 0;

        const joining = moment(emp.dateJoined || emp.createdAt).tz("Asia/Kolkata").startOf("day");
        const relieving = emp.dateRelieved ? moment(emp.dateRelieved).tz("Asia/Kolkata").startOf("day") : null;

        let workingDays = 0;
        let completedWorkingDays = 0;
        let presentDays = 0;
        let leaveDays = 0;
        let absentDays = 0;

        let cursor = startDate.clone();
        while (!cursor.isAfter(endDate, "day")) {
          const dateStr = cursor.format("YYYY-MM-DD");
          const day = cursor.date();
          const weekday = cursor.day();

          const isSunday = weekday === 0;
          const isSecondSaturday = weekday === 6 && Math.ceil(day / 7) === 2;
          const isFourthSaturday = weekday === 6 && Math.ceil(day / 7) === 4;
          const isHoliday = holidaySet.has(dateStr);
          const isBeforeJoining = cursor.isBefore(joining, "day");
          const isAfterRelieved = relieving && cursor.isAfter(relieving, "day");

          const isWorkingDay =
            !isHoliday &&
            !isSunday &&
            !isSecondSaturday &&
            !isFourthSaturday &&
            !isBeforeJoining &&
            !isAfterRelieved;

          if (isWorkingDay) {
            workingDays++;
            if (!cursor.isAfter(today, "day")) {
              completedWorkingDays++;
              const att = empAttMap.get(dateStr);
              const attStatus = att?.status?.toLowerCase();
              const hasCheckIn = att && (att.checkIn1 || att.checkInTime);

              if (empLeaveMap.has(dateStr)) {
                const leaveInfo = empLeaveMap.get(dateStr);
                if (leaveInfo.dayType === "Half Day" || leaveInfo.noOfDays === 0.5) {
                  leaveDays += 0.5;
                  if (hasCheckIn || ["present", "half day"].includes(attStatus)) {
                    presentDays += 0.5;
                  } else {
                    absentDays += 0.5;
                  }
                } else {
                  leaveDays += 1;
                }
              } else if (attStatus === "leave" || attStatus === "approved") {
                leaveDays += 1;
              } else if (attStatus === "half day leave" || attStatus === "half day") {
                leaveDays += 0.5;
                if (hasCheckIn) {
                  presentDays += 0.5;
                } else {
                  absentDays += 0.5;
                }
              } else if (
                empWfhSet.has(dateStr) ||
                attStatus === "present" ||
                hasCheckIn
              ) {
                presentDays += 1;
              } else {
                absentDays += 1;
              }
            }
          }
          cursor.add(1, "day");
        }

        let avatarUrl = "/user-avatar.png";
        if (emp.photo && emp.photo !== "avatar.png") {
          avatarUrl = await getCachedSignedUrl(emp.photo);
        }

        return {
          employeeId: emp._id,
          name: emp.name,
          designation: emp.designation || "-",
          avatar: avatarUrl,
          workingDays,
          daysPresent: presentDays,
          leavesTaken: leaveDays + absentDays,
          permissions: permissionCount,
          attendancePercentage:
            completedWorkingDays > 0
              ? Math.round((presentDays / completedWorkingDays) * 100) + "%"
              : "0%",
          employmentStatus: emp.employmentStatus,
        };
      }));

      return res.json({ success: true, data: finalResults });

    } catch (err) {
      console.error("❌ getAttendanceReport error:", err);
      return res.status(500).json({ success: false, message: "Attendance report failed" });
    }
  },

  /* ═══════════════════════════════════════════════
     6. EMPLOYEE ATTENDANCE PREVIEW — FIX 3 APPLIED
  ═══════════════════════════════════════════════ */
  async getEmployeeAttendancePreview(req, res) {
    try {
      if (!isValidAdmin(req)) {
        return res.status(403).json({ success: false, message: "Admin access required" });
      }

      let {
        employeeId,
        year,
        fromYear,
        toYear,
        fromMonth,
        toMonth,
      } = req.query;

      employeeId = employeeId?.trim();

      year = Number(year);

      fromYear = Number(fromYear || year);
      toYear = Number(toYear || year);

      fromMonth = Number(fromMonth);
      toMonth = Number(toMonth);

      if (!employeeId || employeeId === "undefined" || !year) {
        return res.status(400).json({
          success: false,
          message: "Valid employeeId and year are required",
        });
      }

      if (!mongoose.isValidObjectId(employeeId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid employee ID",
        });
      }

      if (isNaN(fromMonth) || fromMonth < 0 || fromMonth > 11) fromMonth = 0;
      if (isNaN(toMonth) || toMonth < 0 || toMonth > 11) toMonth = 11;

      const empObjectId = new mongoose.Types.ObjectId(employeeId);

      const employee = await Employee.findById(empObjectId)
        .select("name designation photo dateJoined dateRelieved createdAt leaveBalances gender isProbation probationPeriod probationPeriodMonths")
        .lean();

      if (!employee) {
        return res.status(404).json({ success: false, message: "Employee not found" });
      }

      // ✅ Correct joining field
      const joiningDate = moment(
        employee.dateJoined || employee.createdAt
      ).tz("Asia/Kolkata").startOf("day");

      // Financial Year: April → March
      const startDate = moment.tz(
        { year: fromYear, month: fromMonth, day: 1 },
        "Asia/Kolkata"
      ).startOf("month");

      const endDate = moment.tz(
        { year: toYear, month: toMonth, day: 1 },
        "Asia/Kolkata"
      ).endOf("month");    // March 31 next year
      const today = moment().tz("Asia/Kolkata").startOf("day");
      const relievingDate = employee.dateRelieved
        ? moment(employee.dateRelieved).tz("Asia/Kolkata").startOf("day")
        : null;

      // ✅ Effective start (avoid pre-joining data)
      const effectiveStart = moment.max(startDate, joiningDate);

      const holidays = await Holiday.find({
        date: {
          $gte: startDate.format("YYYY-MM-DD"),
          $lte: endDate.format("YYYY-MM-DD"),
        },
      }).lean();
      const holidaySet = new Set(holidays.map((h) => h.date));

      const leaveRequests = await LeaveRequest.find({
        employeeId: empObjectId,
        status: "Approved",
        fromDate: { $lte: endDate.toDate() },
        toDate: { $gte: effectiveStart.toDate() },
      }).lean();

      // ✅ FIX 3: Fetch approved permissions for this employee
      const permissions = await PermissionRequest.find({
        employeeId: empObjectId,
        status: { $in: ["APPROVED", "INFORMED"] },
        from: { $lte: endDate.toDate() },
        to: { $gte: effectiveStart.toDate() },
      }).lean();

      const leaveMap = new Map();
      const wfhSet = new Set();
      leaveRequests.forEach((l) => {
        const isWFH = l.requestType === "wfh";
        if (isWFH) {
          if (Array.isArray(l.leaveDates) && l.leaveDates.length > 0) {
            l.leaveDates.forEach((d) => wfhSet.add(d));
          } else {
            let current = moment.tz(l.fromDate, "Asia/Kolkata").startOf("day");
            const end = moment.tz(l.toDate || l.fromDate, "Asia/Kolkata").startOf("day");
            while (!current.isAfter(end, "day")) {
              wfhSet.add(current.format("YYYY-MM-DD"));
              current.add(1, "day");
            }
          }
        } else {
          const leaveInfo = {
            dayType: l.dayType,
            noOfDays: l.noOfDays,
            startTime: l.startTime,
            endTime: l.endTime,
            status: l.status,
          };
          if (Array.isArray(l.leaveDates) && l.leaveDates.length > 0) {
            l.leaveDates.forEach((d) => leaveMap.set(d, leaveInfo));
          } else {
            let current = moment.tz(l.fromDate, "Asia/Kolkata").startOf("day");
            const end = moment.tz(l.toDate || l.fromDate, "Asia/Kolkata").startOf("day");
            while (!current.isAfter(end, "day")) {
              leaveMap.set(current.format("YYYY-MM-DD"), leaveInfo);
              current.add(1, "day");
            }
          }
        }
      });

      // ✅ Use effectiveStart
      const attendances = await Attendance.find({
        employeeId: empObjectId,
        date: {
          $gte: effectiveStart.format("YYYY-MM-DD"),
          $lte: endDate.format("YYYY-MM-DD"),
        },
      }).lean();

      const attMap = new Map(attendances.map((a) => [a.date, a]));

      let workingDays = 0;
      let completedWorkingDays = 0;
      let presentDays = 0;
      let leaveDays = 0;
      // ✅ FIX 3: permissionCount = total approved permissions (not incremented in loop)
      let permissionCount = permissions.length;
      let absentDays = 0;

      const calendarByMonth = {};
      let cursor = startDate.clone();

      while (!cursor.isAfter(endDate, "day")) {
        const dateStr = cursor.format("YYYY-MM-DD");
        const day = cursor.date();
        const month = cursor.month();

        const weekday = cursor.day();

        const isSunday = weekday === 0;
        const isSecondSaturday = weekday === 6 && Math.ceil(day / 7) === 2;
        const isFourthSaturday = weekday === 6 && Math.ceil(day / 7) === 4;
        const isHoliday = holidaySet.has(dateStr);
        const isBeforeJoining = cursor.isBefore(joiningDate, "day");

        const isFuture = cursor.isAfter(today, "day");
        const isAfterRelieved = relievingDate && cursor.isAfter(relievingDate, "day");

        const isWorkingDay =
          !isHoliday &&
          !isSunday &&
          !isSecondSaturday &&
          !isFourthSaturday &&
          !isBeforeJoining &&
          !isAfterRelieved;

        if (isWorkingDay) {
          workingDays++;

          if (!isFuture) {
            completedWorkingDays++;

            const attRecord = attMap.get(dateStr);
            const attStatus = attRecord?.status?.toLowerCase();
            const hasCheckIn = attRecord && (attRecord.checkIn1 || attRecord.checkInTime);
            const currentHour = moment().tz("Asia/Kolkata").hour();
            const isTodayDate = cursor.isSame(today, "day");
            const isPastAbsentTime = !isTodayDate || currentHour >= 11;

            if (leaveMap.has(dateStr)) {
              const leaveInfo = leaveMap.get(dateStr);
              if (leaveInfo.dayType === "Half Day" || leaveInfo.noOfDays === 0.5) {
                leaveDays += 0.5;
                if (hasCheckIn || ["present", "half day"].includes(attStatus)) {
                  presentDays += 0.5;
                } else {
                  absentDays += 0.5;
                }
              } else {
                leaveDays += 1;
              }
            } else if (attStatus === "leave" || attStatus === "approved") {
              leaveDays += 1;
            } else if (attStatus === "half day leave" || attStatus === "half day") {
              leaveDays += 0.5;
              if (hasCheckIn) {
                presentDays += 0.5;
              } else {
                absentDays += 0.5;
              }
            } else if (
              wfhSet.has(dateStr) ||
              attStatus === "present" ||
              hasCheckIn
            ) {
              presentDays += 1;
            } else if (isPastAbsentTime || (attRecord && attStatus === "absent")) {
              absentDays += 1;
            }
          }
        }

        let status = null;
        if (isBeforeJoining || isAfterRelieved) {
          status = "inactive";
        } else if (isHoliday) {
          status = "holiday";
        } else if (isSunday || isSecondSaturday || isFourthSaturday) {
          status = "weekend";
        } else {
          if (isFuture) {
            status = null;
          } else if (leaveMap.has(dateStr)) {
            const leaveInfo = leaveMap.get(dateStr);
            if (leaveInfo.dayType === "Half Day" || leaveInfo.noOfDays === 0.5) {
              status = "half-day-leave";
            } else {
              status = "leave";
            }
          } else if (wfhSet.has(dateStr)) {
            status = "wfh";
          } else if (
            ["half day leave", "half day"].includes(attMap.get(dateStr)?.status?.toLowerCase())
          ) {
            status = "half-day-leave";
          } else if (
            ["present"].includes(attMap.get(dateStr)?.status?.toLowerCase()) ||
            (attMap.get(dateStr)?.checkIn1 || attMap.get(dateStr)?.checkInTime)
          ) {
            status = "present";
          } else if (
            ["leave", "approved"].includes(attMap.get(dateStr)?.status?.toLowerCase())
          ) {
            status = "leave";
          } else {
            status = "absent";
          }
        }

        if (!calendarByMonth[month]) calendarByMonth[month] = [];

        calendarByMonth[month].push({
          day,
          date: dateStr,
          status,
          isToday: cursor.isSame(today, "day"),
        });

        cursor.add(1, "day");
      }

      let policyTotal = 0;
      let policyUsed = 0;
      let policyRemaining = 0;
      let matLeaveObj = { total: 0, used: 0, remaining: 0 };
      let patLeaveObj = { total: 0, used: 0, remaining: 0 };

      const finYear = `${year}-${Number(year) + 1}`;
      const inProbation = isEmployeeInProbation(employee);
      const empGender = (employee.gender || "male").toLowerCase();

      const categoryDoc = await LeaveCategory.findOne({ financialYear: finYear }).lean();
      const configuredCategories = categoryDoc ? categoryDoc.categories : [];

      const empJoiningDate = employee.dateJoined || employee.createdAt || new Date();
      const currentDate = new Date();
      const actualServiceMonths = calculateServiceMonths(empJoiningDate, currentDate);

      const leaveBalDoc = await LeaveBalance.findOne({ employeeId: empObjectId });
      const employeeBalances = leaveBalDoc?.leaveBalances && leaveBalDoc.leaveBalances[finYear]
        ? { ...leaveBalDoc.leaveBalances[finYear] }
        : {};

      const yearBalances = {};

      if (configuredCategories && configuredCategories.length > 0) {
        configuredCategories.forEach((cat) => {
          const lowerName = cat.name.toLowerCase();
          if (empGender !== "female" && lowerName.includes("maternity")) return;
          if (empGender !== "male" && lowerName.includes("paternity")) return;

          const allowedLeaves = calculateCategoryLeaves(cat, actualServiceMonths, inProbation);
          const existingBal = employeeBalances[cat.name] || {};
          const used = existingBal.used || 0;

          yearBalances[cat.name] = {
            total: allowedLeaves,
            used,
            remaining: Math.max(0, allowedLeaves - used),
          };
        });
      } else {
        Object.assign(yearBalances, employeeBalances);
      }

      Object.keys(yearBalances).forEach((key) => {
        const bal = yearBalances[key] || {};
        const total = bal.total || 0;
        const used = bal.used || 0;
        const remaining = bal.remaining || 0;
        const lowerKey = key.toLowerCase();

        if (lowerKey.includes("maternity")) {
          matLeaveObj = { total, used, remaining };
        } else if (lowerKey.includes("paternity")) {
          patLeaveObj = { total, used, remaining };
        } else {
          policyTotal += total;
          policyUsed += used;
          policyRemaining += remaining;
        }
      });

      let avatarUrl = "/avatar.png";
      if (employee.photo && employee.photo !== "avatar.png") {
        avatarUrl = await getCachedSignedUrl(employee.photo);
      }

      return res.json({
        success: true,
        data: {
          employee: {
            name: employee.name,
            designation: employee.designation || "-",
            avatar: avatarUrl,
            joiningDate: joiningDate.format("YYYY-MM-DD"),
            relievingDate: relievingDate ? relievingDate.format("YYYY-MM-DD") : null,
          },
          summary: {
            // Leave Policy Stats
            policyTotal,
            policyUsed,
            policyRemaining,

            maternityLeave: matLeaveObj,
            paternityLeave: patLeaveObj,

            workingDays,
            daysPresent: presentDays,
            approvedLeave: leaveDays,
            absentDays: absentDays,
            totalLeave: leaveDays + absentDays,
            permissions: permissionCount,
            attendancePercentage:
              completedWorkingDays > 0
                ? Math.round((presentDays / completedWorkingDays) * 100) + "%"
                : "0%",
          },
          calendar: calendarByMonth,
        },
      });

    } catch (err) {
      console.error("❌ getEmployeeAttendancePreview error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch attendance preview",
      });
    }
  },

  /* ═══════════════════════════════════════════════
     7. DOWNLOAD SINGLE EMPLOYEE SUMMARY
  ═══════════════════════════════════════════════ */
  async downloadSingleEmployeeSummary(req, res) {
    try {
      if (!isValidAdmin(req)) {
        return res.status(403).json({ success: false, message: "Admin access required" });
      }

      const { employeeId, month, year } = req.query;

      if (!employeeId || !month || !year) {
        return res.status(400).json({ success: false, message: "employeeId, month, year are required" });
      }

      if (!mongoose.isValidObjectId(employeeId)) {
        return res.status(400).json({ success: false, message: "Invalid employee ID" });
      }

      const fakeReq = { query: { month, year, search: "" }, user: req.user };
      let reportResult;
      const fakeRes = { json: (data) => { reportResult = data; } };

      await module.exports.getAttendanceReport(fakeReq, fakeRes);

      if (!reportResult?.data?.length) {
        return res.status(404).json({ success: false, message: "No attendance data found" });
      }

      const employee = reportResult.data.find(
        (e) => e.employeeId.toString() === employeeId.toString()
      );

      if (!employee) {
        return res.status(404).json({ success: false, message: "Employee not found" });
      }

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Attendance Summary");

      sheet.columns = [
        { header: "Employee Name", key: "name", width: 25 },
        { header: "Working Days", key: "workingDays", width: 18 },
        { header: "Present Days", key: "daysPresent", width: 18 },
        { header: "Leave Taken", key: "leavesTaken", width: 18 },
        { header: "Attendance %", key: "attendancePercentage", width: 18 },
      ];

      sheet.getRow(1).font = { bold: true };
      sheet.addRow({
        name: employee.name,
        workingDays: employee.workingDays,
        daysPresent: employee.daysPresent,
        leavesTaken: employee.leavesTaken,
        attendancePercentage: employee.attendancePercentage,
      });

      const metaStartRow = sheet.lastRow.number + 2;
      sheet.getRow(metaStartRow).values = ["Month", "Year", "Downloaded On"];
      sheet.getRow(metaStartRow).font = { bold: true };
      sheet.getRow(metaStartRow + 1).values = [
        moment(month, "M").format("MMM"),
        year,
        getISTDateTime(),
      ];

      res.setHeader(
        "Content-Disposition",
        `attachment; filename=employee_attendance_${month}_${year}.xlsx`
      );
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );

      await workbook.xlsx.write(res);
      res.end();
    } catch (err) {
      console.error("❌ downloadSingleEmployeeSummary error:", err);
      res.status(500).json({ success: false, message: "Failed to download employee summary" });
    }
  },

  /* ═══════════════════════════════════════════════
     8. DOWNLOAD ALL EMPLOYEES SUMMARY
  ═══════════════════════════════════════════════ */
  async downloadAllEmployeesSummary(req, res) {
    try {
      if (!isValidAdmin(req)) {
        return res.status(403).json({ success: false, message: "Admin access required" });
      }

      const { month, year } = req.query;

      if (!month || !year) {
        return res.status(400).json({ success: false, message: "month and year are required" });
      }

      const fakeReq = { query: { month, year, search: "" }, user: req.user };
      let reportResult;
      const fakeRes = { json: (data) => { reportResult = data; } };

      await module.exports.getAttendanceReport(fakeReq, fakeRes);

      if (!reportResult?.data?.length) {
        return res.status(404).json({ success: false, message: "No attendance data found" });
      }

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Attendance Summary");

      sheet.columns = [
        { header: "Employee Name", key: "name", width: 25 },
        { header: "Working Days", key: "workingDays", width: 18 },
        { header: "Present Days", key: "daysPresent", width: 18 },
        { header: "Leave Taken", key: "leavesTaken", width: 18 },
        { header: "Attendance %", key: "attendancePercentage", width: 18 },
      ];

      sheet.getRow(1).font = { bold: true };
      reportResult.data.forEach((emp) => {
        sheet.addRow({
          name: emp.name,
          workingDays: emp.workingDays,
          daysPresent: emp.daysPresent,
          leavesTaken: emp.leavesTaken,
          attendancePercentage: emp.attendancePercentage,
        });
      });

      const metaStartRow = sheet.lastRow.number + 2;
      sheet.getRow(metaStartRow).values = ["Month", "Year", "Downloaded On"];
      sheet.getRow(metaStartRow).font = { bold: true };
      sheet.getRow(metaStartRow + 1).values = [
        moment(month, "M").format("MMM"),
        year,
        getISTDateTime(),
      ];

      res.setHeader(
        "Content-Disposition",
        `attachment; filename=all_employees_attendance_${month}_${year}.xlsx`
      );
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );

      await workbook.xlsx.write(res);
      res.end();
    } catch (err) {
      console.error("❌ downloadAllEmployeesSummary error:", err);
      res.status(500).json({ success: false, message: "Failed to download employees summary" });
    }
  },

  /* ═══════════════════════════════════════════════
     9. DASHBOARD STATS
  ═══════════════════════════════════════════════ */
  async getDashboardStats(req, res) {
    try {
      if (!isValidAdmin(req)) {
        return res.status(403).json({ success: false });
      }

      const today = moment().tz("Asia/Kolkata").format("YYYY-MM-DD");

      const startOfDay = moment().tz("Asia/Kolkata").startOf("day");
      const endOfDay = moment().tz("Asia/Kolkata").endOf("day");

      const totalEmployees = await Employee.countDocuments({
        employmentStatus: "active",
        role: { $ne: "admin" }
      });

      const employees = await Employee.find({
        employmentStatus: "active",
        role: { $ne: "admin" }
      }).select("_id");

      const attendanceList = await Attendance.find({ date: today });

      const leaveList = await LeaveRequest.find({
        status: "Approved",
        fromDate: { $lte: endOfDay.toDate() },
        toDate: { $gte: startOfDay.toDate() },
      });

      const attendanceMap = new Map();
      attendanceList.forEach(a => {
        attendanceMap.set(a.employeeId.toString(), a);
      });

      // ✅ REAL LEAVE ONLY (exclude WFH)
      const leaveMap = new Map();
      const wfhSet = new Set();
      leaveList.forEach(l => {
        if (l.requestType === "wfh") {
          wfhSet.add(l.employeeId.toString());
        } else {
          leaveMap.set(l.employeeId.toString(), l);
        }
      });

      let presentToday = 0;
      let leaveToday = 0;
      let absentToday = 0;
      let lateCheckins = 0;

      const now = moment().tz("Asia/Kolkata");
      const cutoffTime = moment().tz("Asia/Kolkata").hour(11).minute(0).second(0);
      const isAfterCutoff = now.isAfter(cutoffTime);

      employees.forEach(emp => {
        const empId = emp._id.toString();
        const att = attendanceMap.get(empId);

        const leaveReq = leaveMap.get(empId);
        const isOnLeave = !!leaveReq;
        const isWFH = wfhSet.has(empId);
        const hasCheckIn = att && (att.checkIn1 || att.checkInTime);
        const isHalfDay = leaveReq && (leaveReq.dayType === "Half Day" || leaveReq.noOfDays === 0.5);

        // 1️⃣ PRESENT (checked-in) - HIGHEST PRIORITY
        if (hasCheckIn) {
          if (isHalfDay) {
            presentToday += 0.5;
            leaveToday += 0.5;
          } else {
            presentToday++;
          }
          if (att.lateEntryCount > 0) {
            lateCheckins++;
          }
          return;
        }

        // 2️⃣ LEAVE (only if NOT checked-in)
        if (isOnLeave) {
          if (isHalfDay) {
            leaveToday += 0.5;
            if (isAfterCutoff) absentToday += 0.5;
          } else {
            leaveToday++;
          }
          return;
        }

        // 3️⃣ WFH (no check-in but approved request)
        if (isWFH) {
          presentToday++;
          return;
        }

        // 4️⃣ ABSENT (only if after cutoff time)
        if (isAfterCutoff) {
          absentToday++;
        }
      });

      return res.json({
        success: true,
        data: {
          totalEmployees,
          presentToday,
          absentToday,
          lateCheckins,
          leaveToday
        }
      });

    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false });
    }
  },

  /* ═══════════════════════════════════════════════
     10. TODAY EMPLOYEE ACTIVITY
  ═══════════════════════════════════════════════ */
  async getTodayEmployeeActivity(req, res) {
    try {
      if (!isValidAdmin(req)) {
        return res.status(403).json({ success: false, message: "Admin access required" });
      }

      const { date: dateParam, status: statusParam } = req.query;

      let targetDate = moment().tz("Asia/Kolkata").startOf("day");

      if (dateParam === "yesterday") {
        targetDate = targetDate.subtract(1, "days");
      } else if (dateParam && dateParam !== "today") {
        const parsed = moment(dateParam, "YYYY-MM-DD", true);
        if (parsed.isValid()) {
          targetDate = parsed.tz("Asia/Kolkata").startOf("day");
        }
      }

      const dateStr = targetDate.format("YYYY-MM-DD");
      const startOfDay = targetDate.clone().startOf("day").toDate();
      const endOfDay = targetDate.clone().endOf("day").toDate();

      const dayOfWeek = targetDate.day();
      const isSunday = dayOfWeek === 0;
      const isSecondSaturday = dayOfWeek === 6 && Math.ceil(targetDate.date() / 7) === 2;
      const isFourthSaturday = dayOfWeek === 6 && Math.ceil(targetDate.date() / 7) === 4;
      const isWeekend = isSunday || isSecondSaturday || isFourthSaturday;

      const employees = await Employee.find(
        { employmentStatus: "active", role: { $ne: "admin" } },
        "empId name email"
      )
        .sort({ empId: 1 })
        .lean();

      const attendanceList = await Attendance.find({ date: dateStr })
        .populate("employeeId", "empId name email")
        .lean();

      const holiday = await Holiday.findOne({ date: dateStr }).lean();
      const isHoliday = !!holiday;

      const leaveList = await LeaveRequest.find({
        status: "Approved",
        fromDate: { $lte: endOfDay },
        toDate: { $gte: startOfDay },
      }).lean();

      // ✅ REAL LEAVE (exclude WFH)
      const leaveMap = new Map();
      const wfhSet = new Set();
      leaveList.forEach((l) => {
        if (l.requestType === "wfh") {
          wfhSet.add(l.employeeId.toString());
        } else {
          leaveMap.set(l.employeeId.toString(), l);
        }
      });

      const attendanceMap = new Map();
      attendanceList.forEach((a) => {
        if (a.employeeId) attendanceMap.set(a.employeeId._id.toString(), a);
      });

      const now = moment().tz("Asia/Kolkata");
      const cutoffTime = moment().tz("Asia/Kolkata").hour(11).minute(0).second(0);

      let result = employees.map((emp, index) => {
        const att = attendanceMap.get(emp._id.toString());

        let status = "Not Checked-In";

        // 1. Holiday / Weekend
        if (isHoliday || isWeekend) {
          status = "Holiday";
        }
        // 2. Attendance
        else if (att && (att.checkIn1 || att.checkInTime)) {
          const remarks = (att.remarks || "").toLowerCase();

          const isWFH =
            remarks.includes("wfh") ||
            wfhSet.has(emp._id.toString());

          const isLate =
            remarks.includes("late") ||
            att.lateEntryCount > 0;

          const leaveReq = leaveMap.get(emp._id.toString());
          const isHalfDay =
            att.status === "Half Day Leave" ||
            att.status === "Half Day" ||
            (leaveReq && (leaveReq.dayType === "Half Day" || leaveReq.noOfDays === 0.5));

          if (isWFH && isLate) {
            status = "Late Entry - WFH";
          } else if (isWFH) {
            status = "Present - WFH";
          } else if (isHalfDay) {
            status = "Half Day Leave";
          } else if (isLate) {
            status = "Late Entry";
          } else {
            status = "Present";
          }
        }
        // 3. Leave
        else if (leaveMap.has(emp._id.toString())) {
          const leaveReq = leaveMap.get(emp._id.toString());
          if (leaveReq && (leaveReq.dayType === "Half Day" || leaveReq.noOfDays === 0.5)) {
            status = "Half Day Leave";
          } else {
            status = "Leave";
          }
        }
        // 4. Not checked / Absent
        else {
          const isPastDate = targetDate.isBefore(moment().tz("Asia/Kolkata").startOf("day"));
          const isAbsentInDB = att && att.status === "Absent";
          if (isPastDate || isAbsentInDB || now.isAfter(cutoffTime)) {
            status = "Absent";
          } else {
            status = "Not Checked-In";
          }
        }

        return {
          sno: index + 1,
          empId: emp.empId || "-",
          name: emp.name,
          email: emp.email,
          inTime: (att?.checkIn1 || att?.checkInTime)
            ? moment(att.checkIn1 || att.checkInTime).tz("Asia/Kolkata").format("hh:mm A")
            : "-",
          outTime: (att?.checkOut2 || att?.checkOut1 || att?.checkOutTime)
            ? moment(att.checkOut2 || att.checkOut1 || att.checkOutTime).tz("Asia/Kolkata").format("hh:mm A")
            : "—",
          status,
          suspicious: att?.suspiciousActivity || false,
          suspiciousReason: att?.suspiciousReason || null,
          lateEntryReason: att?.lateEntryReason || "",
        };
      });

      if (statusParam && statusParam !== "All") {
        if (statusParam === "Present") {
          result = result.filter((item) =>
            item.status === "Present" ||
            item.status === "Present - WFH" ||
            item.status === "Late Entry" ||
            item.status === "Late Entry - WFH"
          );
        } else {
          result = result.filter((item) => item.status === statusParam);
        }
        result = result.map((item, index) => ({ ...item, sno: index + 1 }));
      }

      return res.json({ success: true, data: result });
    } catch (err) {
      console.error("❌ getTodayEmployeeActivity error:", err);
      return res.status(500).json({ success: false, message: "Failed to fetch employee activity" });
    }
  },

  /* ═══════════════════════════════════════════════
     11. GET PENDING PERMISSION REQUESTS
  ═══════════════════════════════════════════════ */
  async getPermissionRequests(req, res) {
    try {
      if (!isValidAdmin(req)) {
        return res.status(403).json({ success: false, message: "Admin access required" });
      }

      const requests = await PermissionRequest.find({ status: "PENDING" })
        .populate("employeeId", "name empId department designation")
        .sort({ createdAt: -1 })
        .lean();

      const data = requests.map((r) => ({
        ...r,
        employeeName: r.employeeId?.name || "-",
        empIdString: r.employeeId?.empId || "-",
      }));

      res.json({ success: true, data });
    } catch (err) {
      console.error("❌ getPermissionRequests error:", err);
      res.status(500).json({ success: false, message: "Failed to fetch permission requests" });
    }
  },

  /* ═══════════════════════════════════════════════
     12. APPROVE PERMISSION — FIX 4: NO CHANGES (Already correct)
  ═══════════════════════════════════════════════ */
  async approvePermission(req, res) {
    try {
      if (!isValidAdmin(req)) {
        return res.status(403).json({ success: false, message: "Admin access required" });
      }

      const { requestId } = req.body;

      if (!requestId || !mongoose.isValidObjectId(requestId)) {
        return res.status(400).json({ success: false, message: "Invalid request ID" });
      }

      const request = await PermissionRequest.findById(requestId);

      if (!request || request.status !== "PENDING") {
        return res.status(400).json({ success: false, message: "Invalid or already processed request" });
      }

      if (!request.from || !request.to || request.to <= request.from) {
        return res.status(400).json({ success: false, message: "Invalid time data in request" });
      }

      // ✅ FIX 4: Only update PermissionRequest — do NOT touch Attendance collection
      request.status = "APPROVED";
      request.approvedBy = req.user._id;
      request.approvedByName = req.user.name || req.user.email;
      request.approvedAt = new Date();
      request.approvedFromIP = getClientIP(req);
      await request.save();

      createLog({
        category: "permission",
        referenceId: request._id,
        description: `${req.user.name || "Admin"} approved permission request for ${request.employeeName || "Employee"}`,
      });

      try {
        const title = "Permission Approved";
        const body = `Your permission request from ${new Date(request.from).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} to ${new Date(request.to).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} has been approved.`;

        await new Notification({
          type: "PERMISSION_APPROVED",
          toEmployee: request.employeeId,
          title: title,
          message: body,
          metadata: {
            ticketId: request._id.toString(),
            requestType: "permission",
            url: "/emp/request-leave",
          },
        }).save();

        try {
          await sendPushNotification(request.employeeId, title, body, {
            requestId: request._id.toString(),
            type: "permission",
            status: "Approved",
          });
        } catch (pushErr) {
          console.error("[AdminAttendance] Error sending status update push:", pushErr);
        }
      } catch (notifErr) {
        console.error("[AdminAttendance] Error saving approve notification:", notifErr);
      }

      res.json({ success: true });
    } catch (err) {
      console.error("❌ approvePermission error:", err);
      res.status(500).json({ success: false });
    }
  },

  /* ═══════════════════════════════════════════════
     13. REJECT PERMISSION
  ═══════════════════════════════════════════════ */
  async rejectPermission(req, res) {
    try {
      if (!isValidAdmin(req)) {
        return res.status(403).json({ success: false, message: "Admin access required" });
      }

      const { requestId, rejectReason } = req.body;

      if (!requestId || !mongoose.isValidObjectId(requestId)) {
        return res.status(400).json({ success: false, message: "Invalid request ID" });
      }

      const request = await PermissionRequest.findById(requestId);

      if (!request || request.status !== "PENDING") {
        return res.status(400).json({ success: false, message: "Invalid or already processed request" });
      }

      const sanitizedRejectReason = rejectReason
        ? String(rejectReason).replace(/<[^>]*>/g, "").trim().substring(0, 300)
        : "Rejected by admin";

      request.status = "REJECTED";
      request.rejectedBy = req.user._id;
      request.rejectedByName = req.user.name || req.user.email;
      request.rejectedAt = new Date();
      request.rejectedFromIP = getClientIP(req);
      request.rejectReason = sanitizedRejectReason;
      await request.save();

      createLog({
        category: "permission",
        referenceId: request._id,
        description: `${req.user.name || "Admin"} rejected permission request for ${request.employeeName || "Employee"}. Reason: ${sanitizedRejectReason}`,
      });

      try {
        const title = "Permission Rejected";
        const body = `Your permission request from ${new Date(request.from).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} to ${new Date(request.to).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} has been rejected.`;

        await new Notification({
          type: "PERMISSION_REJECTED",
          toEmployee: request.employeeId,
          title: title,
          message: body,
          metadata: {
            ticketId: request._id.toString(),
            requestType: "permission",
            url: "/emp/request-leave",
          },
        }).save();

        try {
          await sendPushNotification(request.employeeId, title, body, {
            requestId: request._id.toString(),
            type: "permission",
            status: "Rejected",
          });
        } catch (pushErr) {
          console.error("[AdminAttendance] Error sending status update push:", pushErr);
        }
      } catch (notifErr) {
        console.error("[AdminAttendance] Error saving reject notification:", notifErr);
      }

      res.json({ success: true });
    } catch (err) {
      console.error("❌ rejectPermission error:", err);
      res.status(500).json({ success: false });
    }
  },

  /* ═══════════════════════════════════════════════
     14. PERMISSION HISTORY
  ═══════════════════════════════════════════════ */
  getPermissionHistory: async (req, res) => {
    try {
      if (!isValidAdmin(req)) {
        return res.status(403).json({ success: false, message: "Admin access required" });
      }

      const historyRequests = await PermissionRequest.find({
        status: { $in: ["APPROVED", "REJECTED"] }
      })
        .populate("employeeId", "name empId department designation")
        .sort({ updatedAt: -1 })
        .lean();

      res.json({ success: true, permissions: historyRequests });
    } catch (err) {
      console.error("❌ getPermissionHistory error:", err);
      res.status(500).json({ success: false, message: "Server Error" });
    }
  },

  /* ═══════════════════════════════════════════════
     15. ATTENDANCE REPORT SCHEDULE SETTINGS
  ═══════════════════════════════════════════════ */
  getAttendanceReportSchedule: async (req, res) => {
    try {
      if (!isValidAdmin(req)) {
        return res.status(403).json({ success: false, message: "Admin access required" });
      }

      let config = await AttendanceConfig.findOne({ key: "DEFAULT_CONFIG" }).lean();
      if (!config) {
        config = {
          dailyReportTime: "20:01",
          isDailyReportEnabled: true,
        };
      }

      return res.json({
        success: true,
        dailyReportTime: config.dailyReportTime || "20:01",
        isDailyReportEnabled: config.isDailyReportEnabled !== false,
      });
    } catch (err) {
      console.error("❌ getAttendanceReportSchedule error:", err);
      return res.status(500).json({ success: false, message: "Failed to get attendance report schedule" });
    }
  },

  updateAttendanceReportSchedule: async (req, res) => {
    try {
      if (!isValidAdmin(req)) {
        return res.status(403).json({ success: false, message: "Admin access required" });
      }

      const { dailyReportTime, isDailyReportEnabled } = req.body;

      if (!dailyReportTime || !/^\d{2}:\d{2}$/.test(dailyReportTime)) {
        return res.status(400).json({
          success: false,
          message: "Invalid time format. Please provide time in HH:mm (24-hour) format.",
        });
      }

      const [h, m] = dailyReportTime.split(":").map(Number);
      if (h < 0 || h > 23 || m < 0 || m > 59) {
        return res.status(400).json({
          success: false,
          message: "Invalid time value. Hour must be 00-23 and Minute must be 00-59.",
        });
      }

      const config = await AttendanceConfig.findOneAndUpdate(
        { key: "DEFAULT_CONFIG" },
        {
          dailyReportTime,
          isDailyReportEnabled: isDailyReportEnabled !== false,
          updatedBy: req.user?._id,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      // Reschedule the cron dynamically
      rescheduleDailyAttendanceReportCron(config.dailyReportTime, config.isDailyReportEnabled);

      return res.json({
        success: true,
        message: "Attendance report email schedule updated successfully.",
        data: {
          dailyReportTime: config.dailyReportTime,
          isDailyReportEnabled: config.isDailyReportEnabled,
        },
      });
    } catch (err) {
      console.error("❌ updateAttendanceReportSchedule error:", err);
      return res.status(500).json({ success: false, message: "Failed to update attendance report schedule" });
    }
  },
};

module.exports = adminAttendanceController;


module.exports = apiLogger(module.exports, 'adminAttendance.controller.js');