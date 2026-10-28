// routes/SalarySlipRoutes.js

const express = require("express");
const router = express.Router();

const portalAuth = require("../middleware/portalAuth");
const SalarySlipController = require("../controllers/SalarySlipController");
const {
  requireHrSlipWrite,
  requireHrSlipDelete,
} = portalAuth;

/* =========================================================
   ADMIN ROUTES
========================================================= */

// ✅ Single Generate
router.post(
  "/admin/generate-salary-slip",
  portalAuth.adminMiddleware,
  requireHrSlipWrite,
  SalarySlipController.generateSalarySlip
);

// ✅ Bulk Generate
router.post(
  "/admin/generate-multiple-salary-slip",
  portalAuth.adminMiddleware,
  requireHrSlipWrite,
  SalarySlipController.generateMultipleSalarySlip
);

// ✅ Get Active Employees (for popup)
router.get(
  "/admin/active-employees",
  portalAuth.adminMiddleware,
  SalarySlipController.getActiveEmployees
);

router.get(
  "/admin/payroll-employees",
  portalAuth.adminMiddleware,
  SalarySlipController.getEmployeesForPayroll
);

// ✅ Get Single Slip
router.get(
  "/admin/salary-slip/:empId/:month/:year",
  portalAuth.adminMiddleware,
  SalarySlipController.getSalarySlip
);

// ✅ Employee Slip History
router.get(
  "/admin/salary-slip-history/:empId",
  portalAuth.adminMiddleware,
  SalarySlipController.getEmployeeSalarySlips
);

// ✅ All Slip History
router.get(
  "/admin/salary-slip-history-all",
  portalAuth.adminMiddleware,
  SalarySlipController.getAllSalarySlips
);

// ✅ Delete Slip
router.delete(
  "/admin/salary-slip/:slipId",
  portalAuth.adminMiddleware,
  requireHrSlipDelete,
  SalarySlipController.deleteSalarySlip
);

// ✅ Bulk Delete Slips
router.post(
  "/admin/delete-multiple-salary-slips",
  portalAuth.adminMiddleware,
  requireHrSlipDelete,
  SalarySlipController.deleteMultipleSalarySlips
);

// ✅ Download Slip (Admin)
router.get(
  "/admin/download/:slipId",
  portalAuth.adminMiddleware,
  SalarySlipController.downloadSalarySlip
);

// ✅ Download ZIP (Admin)
router.get(
  "/admin/download-zip",
  portalAuth.adminMiddleware,
  SalarySlipController.downloadSalarySlipsZip
);

/* =========================================================
   EMPLOYEE ROUTES
========================================================= */

// ✅ My Slips
router.get(
  "/my-slips",
  portalAuth.employeeMiddleware,
  SalarySlipController.getMySalarySlips
);

// ✅ Download Slip
router.get(
  "/download/:slipId",
  portalAuth.employeeMiddleware,
  SalarySlipController.downloadSalarySlip
);

// ✅ Download ZIP (Employee)
router.get(
  "/download-zip",
  portalAuth.employeeMiddleware,
  SalarySlipController.downloadMySalarySlipsZip
);

module.exports = router;