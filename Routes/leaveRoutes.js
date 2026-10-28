// backend/routes/leaveRoutes.js
const express = require("express");
const router = express.Router();
const { authMiddleware, adminMiddleware } = require("../middleware/portalAuth");
const {
  createRequest,
  getMyLeaves,
  getMyPermissions,
  getMyLeaveBalance,
  updatePermissionStatus,
  updateLeaveStatus,
  updateLeave,
  getAllRequestsAdmin,
  getAllPermissionRequests,
  getAllWFHRequests,
  createPermissionRequest,
  dismissLeaveNotification,
  getPermissionConfigController,
  updatePermissionConfigController,
} = require("../controllers/leaveController");
const sanitizeRequestData = require("../middleware/sanitizeRequestData");

// ✅ Apply middleware to all routes
router.use(sanitizeRequestData);
router.use(authMiddleware);

// Configuration for permissions
router.get("/permission-config", getPermissionConfigController);
router.put("/permission-config", adminMiddleware, updatePermissionConfigController);

// GET /api/leaves/admin/all - Get all LEAVE requests (Admin only)
router.get("/admin/all", getAllRequestsAdmin);

// GET /api/leaves/admin/wfh - Get all WFH requests (Admin only)
router.get("/admin/wfh", getAllWFHRequests);

// POST /api/leaves - Create new leave/WFH request
router.post("/", createRequest);

// POST /api/leaves/permission - Create official permission request
router.post("/permission", createPermissionRequest);

// GET /api/leaves - Get my own requests (with filters)
router.get("/", getMyLeaves);

// GET /api/leaves/my-permissions - Get my own permission requests
router.get("/my-permissions", getMyPermissions);

router.get("/balance", getMyLeaveBalance);

// PUT /api/leaves/:id - Update pending request (Employee)
router.put("/:id", updateLeave);

router.get("/admin/permission",
  getAllPermissionRequests
);
// PUT /api/leaves/:id/status - Update request status (Admin/Manager approve/reject, Employee cancel)
router.put("/:id/status", updateLeaveStatus);

// PUT /api/leaves/:id/dismiss - Mark a leave notification as seen
router.put("/:id/dismiss", dismissLeaveNotification);

router.put(
  "/permission/:id/status",
  updatePermissionStatus
);

module.exports = router;