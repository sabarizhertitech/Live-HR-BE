const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { JWT_SECRET } = require("../utilities/config");
const Employee = require("../Models/Employee");
const Configuration = require("../Models/Configuration");

/* ===================== HELPERS ===================== */

const getToken = (req) => {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const parts = authHeader.split(" ");
    if (parts.length === 2 && parts[0] === "Bearer") {
      return parts[1];
    }
  }

  if (req.query && req.query.token) {
    return req.query.token;
  }

  return null;
};


const verifyToken = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET, {
  algorithms: ["HS256"],
  ignoreExpiration: false
});
  } catch (err) {
    if (err.name === "TokenExpiredError") throw new Error("TokenExpired");
    if (err.name === "JsonWebTokenError") throw new Error("InvalidToken");
    throw err;
  }
};

const validateUser = async (decodedId) => {
  if (!mongoose.Types.ObjectId.isValid(decodedId)) {
    throw new Error("InvalidUserId");
  }

  const user = await Employee.findById(decodedId).lean();
  if (!user) throw new Error("UserNotFound");
if (!user.workingStatus || user.employmentStatus !== "active") {
  throw new Error("AccountDeactivated");
}

  return user;
};

const createUserObject = (user) => ({
  _id: user._id,
  id: user._id.toString(),
  empId: user.empId,
  name: user.name,
  email: user.email,
  role: user.role,
  isHr: !!user.isHr,
  department: user.department,
  designation: user.designation,
  status: user.status,
  employmentStatus: user.employmentStatus,
  workingStatus: user.workingStatus,
  joiningDate: user.dateJoined || user.joiningDate || null
});

/* ===================== TOKEN INVALIDATION ===================== */
/* Instead of blacklist → use passwordChangedAt */

const checkTokenValidity = (decoded, user) => {
  if (!user.passwordChangedAt) return;

  const passwordChangedTime = Math.floor(
    new Date(user.passwordChangedAt).getTime() / 1000
  );

  if (decoded.iat < passwordChangedTime) {
    throw new Error("TokenInvalidated");
  }
};

/* ===================== ERROR HANDLER ===================== */

const handleAuthError = (error, res) => {
  if (error.message === "TokenExpired") {
    return res.status(401).json({ success: false, message: "Token expired" });
  }
  if (error.message === "InvalidToken") {
    return res.status(401).json({ success: false, message: "Invalid token" });
  }
  if (error.message === "InvalidUserId") {
    return res.status(401).json({ success: false, message: "Invalid user ID" });
  }
  if (error.message === "UserNotFound") {
    return res.status(401).json({ success: false, message: "User not found" });
  }
  if (error.message === "AccountDeactivated") {
    return res.status(403).json({
      success: false,
      message: "Account is deactivated",
    });
  }
  if (error.message === "TokenInvalidated") {
    return res.status(401).json({
      success: false,
      message: "Session expired. Please login again.",
    });
  }
  if (error.message === "SuspiciousSession") {
    return res.status(403).json({
      success: false,
      message: "Suspicious session detected",
    });
  }

  console.error("Auth error:", error);
  return res.status(500).json({ success: false, message: "Server error" });
};

/* ===================== CORE AUTH ===================== */

const coreAuth = async (req, token) => {
const decoded = verifyToken(token);

if (!decoded || (!decoded.id && !decoded._id)) {
  throw new Error("InvalidToken");
}

const userId = decoded.id || decoded._id;

  const user = await validateUser(userId);

  checkTokenValidity(decoded, user);

  return createUserObject(user);
};

/* ===================== HR ACCESS HELPERS & GUARDS ===================== */

const getHrAccessConfig = async () => {
  try {
    const config = await Configuration.findOne({ key: "DEFAULT_CONFIG" }).lean();
    return (
      config?.hrAccessConfig || {
        slipAndLetter: "WRITE",
        hrRequests: "WRITE",
        leaveManagement: "MAKER",
        employeeManagement: {
          canAdd: true,
          canView: true,
          canEdit: true,
          canDeleteDocuments: false,
        },
        attendanceManagement: {
          dailyReport: true,
          monthlyOverview: true,
          exportAttendance: true,
        },
        holidays: "MAKER",
      }
    );
  } catch (err) {
    console.error("Error reading hrAccessConfig in middleware:", err);
    return null;
  }
};

const checkHrPermission = (moduleName, checkFn) => {
  return async (req, res, next) => {
    try {
      const userRole = (req.user?.role || "").toLowerCase();
      const isHr = Boolean(req.user?.isHr === true || req.user?.isHr === "true" || userRole === "hr");
      const isAdmin = (userRole === "admin" || userRole === "superadmin") && !isHr;

      // Pure Admin has unrestricted access
      if (isAdmin) {
        return next();
      }

      if (isHr) {
        const hrConfig = await getHrAccessConfig();
        const allowed = hrConfig ? checkFn(hrConfig) : false;

        if (!allowed) {
          return res.status(403).json({
            success: false,
            message: `Access denied. Your HR permissions do not allow this ${moduleName} action.`,
          });
        }

        req.hrAccessConfig = hrConfig;
        return next();
      }

      // Neither Admin nor HR
      return res.status(403).json({
        success: false,
        message: "Forbidden: Admin or HR privileges required.",
      });
    } catch (error) {
      console.error(`HR permission check error for ${moduleName}:`, error);
      return res.status(500).json({ success: false, message: "Internal permission validation error." });
    }
  };
};

/* ===================== MIDDLEWARE ===================== */

const portalAuth = {
  // Any logged-in user
  authMiddleware: async (req, res, next) => {
    try {
      const token = getToken(req);
      if (!token) {
        return res.status(401).json({ success: false, message: "No token provided" });
      }

      req.user = await coreAuth(req, token);
      next();
    } catch (error) {
      return handleAuthError(error, res);
    }
  },

  // Admin only
  adminMiddleware: async (req, res, next) => {
    try {
      const token = getToken(req);
      if (!token) {
        return res.status(401).json({ success: false, message: "No token provided" });
      }

      const user = await coreAuth(req, token);

      if (user.role !== "admin" && !user.isHr) {
        return res.status(403).json({
          success: false,
          message: "Admin or HR access required",
        });
      }

      req.user = user;
      next();
    } catch (error) {
      return handleAuthError(error, res);
    }
  },

  // Employee only
  employeeMiddleware: async (req, res, next) => {
    try {
      const token = getToken(req);
      if (!token) {
        return res.status(401).json({ success: false, message: "No token provided" });
      }

      const user = await coreAuth(req, token);

      if (user.role !== "employee") {
        return res.status(403).json({
          success: false,
          message: "Employee access required",
        });
      }

      req.user = user;
      next();
    } catch (error) {
      return handleAuthError(error, res);
    }
  },

  // ── HR Access Helpers & Methods ──
  getHrAccessConfig,
  checkHrPermission,

  // ── Employee Management HR Guards ──
  requireHrEmployeeCanAdd: checkHrPermission(
    "Employee Management",
    (cfg) => cfg.employeeManagement?.canAdd !== false
  ),
  requireHrEmployeeCanView: checkHrPermission(
    "Employee Management",
    (cfg) => cfg.employeeManagement?.canView !== false
  ),
  requireHrEmployeeCanEdit: checkHrPermission(
    "Employee Management",
    (cfg) => cfg.employeeManagement?.canEdit !== false
  ),
  requireHrEmployeeCanDeleteDocs: checkHrPermission(
    "Employee Management",
    (cfg) => Boolean(cfg.employeeManagement?.canDeleteDocuments)
  ),

  // ── Attendance Management HR Guards ──
  requireHrAttendanceDaily: checkHrPermission(
    "Attendance Management",
    (cfg) => cfg.attendanceManagement?.dailyReport !== false
  ),
  requireHrAttendanceMonthly: checkHrPermission(
    "Attendance Management",
    (cfg) => cfg.attendanceManagement?.monthlyOverview !== false
  ),
  requireHrAttendanceExport: checkHrPermission(
    "Attendance Management",
    (cfg) => cfg.attendanceManagement?.exportAttendance !== false
  ),

  // ── Slip & Letters HR Guards ──
  requireHrSlipWrite: checkHrPermission(
    "Slip Generation",
    (cfg) => ["WRITE", "FULL_ACCESS"].includes(cfg.slipAndLetter)
  ),
  requireHrSlipDelete: checkHrPermission(
    "Slip Generation",
    (cfg) => cfg.slipAndLetter === "FULL_ACCESS"
  ),

  // ── HR Requests Guards ──
  requireHrRequestsWrite: checkHrPermission(
    "HR Requests",
    (cfg) => ["WRITE", "FULL_ACCESS"].includes(cfg.hrRequests)
  ),
  requireHrRequestsDelete: checkHrPermission(
    "HR Requests",
    (cfg) => cfg.hrRequests === "FULL_ACCESS"
  ),

  // ── Pure Admin Only (HR strictly forbidden) ──
  requirePureAdmin: (req, res, next) => {
    const userRole = (req.user?.role || "").toLowerCase();
    const isHr = Boolean(req.user?.isHr === true || req.user?.isHr === "true" || userRole === "hr");
    const isAdmin = (userRole === "admin" || userRole === "superadmin") && !isHr;
    if (isAdmin) {
      return next();
    }
    return res.status(403).json({
      success: false,
      message: "Forbidden: Super Administrator privileges required for this action.",
    });
  },
};

module.exports = portalAuth;