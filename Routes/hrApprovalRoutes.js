const express = require("express");
const router = express.Router();
const hrApprovalController = require("../controllers/hrApprovalController");
const manageEmployeeController = require("../controllers/ManageEmployee.controller");
const {
  authMiddleware,
  adminMiddleware,
  requireHrRequestsWrite,
  requireHrRequestsDelete,
  requirePureAdmin,
} = require("../middleware/portalAuth");

// HR Submissions & Approval Routes
router.post("/submit", authMiddleware, requireHrRequestsWrite, hrApprovalController.submitHrAction);
router.get("/requests", authMiddleware, hrApprovalController.getApprovalRequests);
router.get("/my-requests", authMiddleware, hrApprovalController.getMyRequests);
router.post("/approve/:id", adminMiddleware, hrApprovalController.approveRequest);
router.post("/update-approve/:id", adminMiddleware, hrApprovalController.updateAndApproveRequest);
router.post("/reject/:id", adminMiddleware, hrApprovalController.rejectRequest);
router.put("/request/:id", authMiddleware, requireHrRequestsWrite, hrApprovalController.updatePendingRequest);
router.delete("/request/:id", authMiddleware, requireHrRequestsDelete, hrApprovalController.deletePendingRequest);
router.get("/logs", authMiddleware, hrApprovalController.getApprovalLogs);

// Single HR Assignment (Admin Only)
router.put("/assign-hr", adminMiddleware, requirePureAdmin, manageEmployeeController.setSingleHrRole);

module.exports = router;
