const express = require("express");
const rateLimit = require("express-rate-limit");
const portalAuth = require("../middleware/portalAuth");
const attendanceController = require("../controllers/attendance.controller");
const adminAttendanceController = require("../controllers/adminAttendance.controller");
const morningAttendanceReportController = require("../controllers/morningAttendanceReport.controller");
const whatsappAttendanceReportController = require("../controllers/whatsappAttendanceReport.controller");
const sanitizeRequestData = require("../middleware/sanitizeRequestData");
const {
  requireHrAttendanceDaily,
  requireHrAttendanceMonthly,
  requireHrAttendanceExport,
} = portalAuth;

const AttendanceRoutes = express.Router();
AttendanceRoutes.use(sanitizeRequestData)
/* ═══════════════════════════════════════════════
   RATE LIMITERS
═══════════════════════════════════════════════ */

// 🔐 SECURITY: Strict limiter for check-in/check-out — 5 per minute per IP
const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => {
    // 🔐 Rate limit by USER ID + IP combined (not just IP)
    const userId = req.user?._id || "unknown";
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.connection?.remoteAddress ||
      "unknown";
    return `${userId}_${ip}`;
  },
  handler: (req, res) => {
    console.warn(
      `🚨 RATE LIMIT HIT: IP=${req.headers["x-forwarded-for"] || req.connection?.remoteAddress} ` +
      `Path=${req.path} Time=${new Date().toISOString()}`
    );
    res.status(429).json({
      success: false,
      message: "Too many requests. Please wait before trying again.",
    });
  },
});

// 🔐 SECURITY: Moderate limiter for read/view routes — 60 per minute
const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: "Too many requests. Please slow down.",
    });
  },
});

// 🔐 SECURITY: Admin action limiter — 20 per minute
const adminActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: "Too many admin actions. Please slow down.",
    });
  },
});

/* ═══════════════════════════════════════════════
   EMPLOYEE ATTENDANCE ROUTES
═══════════════════════════════════════════════ */

// Read-only — moderate limiter
AttendanceRoutes.get("/attendance/today", readLimiter, portalAuth.employeeMiddleware, attendanceController.getTodayAttendance);

AttendanceRoutes.get("/attendance/monthly", readLimiter, portalAuth.authMiddleware, attendanceController.getMonthlyAttendance);

// Write actions — strict limiter
AttendanceRoutes.post("/attendance/check-in", strictLimiter, portalAuth.employeeMiddleware, attendanceController.checkIn);

AttendanceRoutes.post("/attendance/check-out", strictLimiter, portalAuth.employeeMiddleware, attendanceController.checkOut);

AttendanceRoutes.post("/attendance/permission", strictLimiter, portalAuth.employeeMiddleware, attendanceController.submitPermissionRequest);

AttendanceRoutes.post("/attendance/inform-permission",strictLimiter,portalAuth.employeeMiddleware,attendanceController.submitInformPermission);

AttendanceRoutes.get("/employee/attendance-overview",readLimiter,portalAuth.employeeMiddleware,attendanceController.getEmployeeAttendanceOverview);

/* ═══════════════════════════════════════════════
   ADMIN ATTENDANCE ROUTES
═══════════════════════════════════════════════ */

// Read-only admin routes — moderate limiter
AttendanceRoutes.get("/admin/analytics", readLimiter, portalAuth.adminMiddleware, requireHrAttendanceMonthly, adminAttendanceController.getMonthlyAnalytics);

AttendanceRoutes.get("/admin/daily", readLimiter, portalAuth.adminMiddleware, requireHrAttendanceDaily, adminAttendanceController.getDailyAttendance);

AttendanceRoutes.get("/admin/leaves", readLimiter, portalAuth.adminMiddleware, adminAttendanceController.getDailyLeaves);

AttendanceRoutes.get("/admin/departments",readLimiter,portalAuth.adminMiddleware,adminAttendanceController.getDepartments);

AttendanceRoutes.get("/admin/attendance-report",readLimiter,portalAuth.adminMiddleware, requireHrAttendanceMonthly, adminAttendanceController.getAttendanceReport);

AttendanceRoutes.get("/admin/morning-attendance-report",readLimiter,portalAuth.adminMiddleware,morningAttendanceReportController.getMorningAttendanceReport);

AttendanceRoutes.post("/admin/send-morning-attendance-report",adminActionLimiter,portalAuth.adminMiddleware,whatsappAttendanceReportController.sendMorningAttendanceReport);

AttendanceRoutes.get("/admin/dashboard-stats",readLimiter,portalAuth.adminMiddleware,adminAttendanceController.getDashboardStats);

AttendanceRoutes.get("/admin/employee-activity",readLimiter,portalAuth.adminMiddleware,adminAttendanceController.getTodayEmployeeActivity);

AttendanceRoutes.get("/admin/attendance-preview",readLimiter,portalAuth.adminMiddleware, requireHrAttendanceMonthly, adminAttendanceController.getEmployeeAttendancePreview);

// Download routes — moderate limiter
AttendanceRoutes.get("/download/employee-summary",readLimiter,portalAuth.adminMiddleware, requireHrAttendanceExport, adminAttendanceController.downloadSingleEmployeeSummary);

AttendanceRoutes.get("/download/all-summary",readLimiter,portalAuth.adminMiddleware, requireHrAttendanceExport, adminAttendanceController.downloadAllEmployeesSummary);

// Permission approval routes — admin action limiter (write actions)
AttendanceRoutes.get("/admin/permission/pending",readLimiter,portalAuth.adminMiddleware,adminAttendanceController.getPermissionRequests);

AttendanceRoutes.get("/admin/permission/history",readLimiter,portalAuth.adminMiddleware,adminAttendanceController.getPermissionHistory);

AttendanceRoutes.post("/admin/permission/approve",adminActionLimiter,portalAuth.adminMiddleware,adminAttendanceController.approvePermission);

AttendanceRoutes.post("/admin/permission/reject",adminActionLimiter,portalAuth.adminMiddleware,adminAttendanceController.rejectPermission);

// Attendance Report Email Schedule Configuration
AttendanceRoutes.get("/admin/attendance-report-schedule",readLimiter,portalAuth.adminMiddleware,adminAttendanceController.getAttendanceReportSchedule);

AttendanceRoutes.put("/admin/attendance-report-schedule",adminActionLimiter,portalAuth.adminMiddleware,adminAttendanceController.updateAttendanceReportSchedule);

module.exports = AttendanceRoutes;