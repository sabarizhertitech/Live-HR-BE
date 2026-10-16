const express = require("express");
const UsersController = require("../controllers/UsersController");
const portalAuth = require("../middleware/portalAuth");
const { getAllEmployees, deleteEmployee } = require("../controllers/ManageEmployee.controller");

// ✅ Import getMyProfileWithSignedUrls — used by edit form so file previews work
const {
  updateEmployeeDetails,
  getEmployeeDetails,
  getMyProfileWithSignedUrls,
  getEmployeeByEmpIdString,
  adminUpdateEmployee,
  searchEmployees,
  getTodayBirthdays,
  sendBirthdayWish,
  getReceivedWishes,
  replyBirthdayWish,
  getUserSentWishes,
  getDocumentViewUrl,
  adminReviewProfile,
  saveCertifications,
} = require("../controllers/employee.controller");

const attendanceController = require("../controllers/attendance.controller");
const profileController = require("../controllers/profileController");
const sanitizeRequestData = require("../middleware/sanitizeRequestData");

// ✅ Multer memory storage middleware (files go to S3, not disk)
const upload = require("../middleware/uploadMemory");

const Users = express.Router();
Users.use(sanitizeRequestData);

/* ═══════════════════════════════════════════════════════════
   EMPLOYEE ROUTES
═══════════════════════════════════════════════════════════ */

// ✅ Generate temporary 3-minute S3 signed URL to view uploaded document in Chrome
Users.post(
  "/document-view-url",
  portalAuth.authMiddleware,
  getDocumentViewUrl
);

// ✅ Used by EDIT FORM (EmployeeDetails.jsx) — needs signed URLs for previews
Users.get(
  "/get-employee",
  portalAuth.authMiddleware,
  getMyProfileWithSignedUrls
);

// ✅ Used by VIEW PAGE (DetailsView.jsx) — also needs signed URLs for photo
Users.get(
  "/get-details",
  portalAuth.authMiddleware,
  getEmployeeDetails
);

// ✅ Employee self-update with file upload to S3
Users.put(
  "/update-employee",
  portalAuth.authMiddleware,
  upload.any(),
  updateEmployeeDetails
);

// ✅ Auto-save certifications without consuming edit requests
Users.put(
  "/certifications/auto-save",
  portalAuth.authMiddleware,
  upload.any(),
  saveCertifications
);

Users.get(
  "/search-employees",
  portalAuth.employeeMiddleware,
  searchEmployees
);

Users.post(
  "/attendance/holiday",
  portalAuth.employeeMiddleware,
  attendanceController.addHoliday
);
Users.post(
  "/attendance/holiday/bulk",
  portalAuth.employeeMiddleware,
  attendanceController.addBulkHolidays
);
Users.get(
  "/attendance/holidays",
  portalAuth.employeeMiddleware,
  attendanceController.getHolidays
);

/* ═══════════════════════════════════════════════════════════
   ADMIN ROUTES
═══════════════════════════════════════════════════════════ */

// ✅ Add employee with photo upload
Users.post(
  "/add-employee",
  portalAuth.adminMiddleware,
  upload.single("photo"),
  UsersController.addEmployee
);

Users.get("/all-employee", portalAuth.adminMiddleware, getAllEmployees);

// ✅ Admin view of single employee — has signed URLs
Users.get(
  "/employee/:empIdString",
  portalAuth.adminMiddleware,
  getEmployeeByEmpIdString
);

Users.delete(
  "/delete-employee/:empIdString",
  portalAuth.adminMiddleware,
  deleteEmployee
);

// ✅ Admin update employee with file upload to S3
// Also records the edit in EditRequest model for audit trail
Users.put(
  "/admin/employee/:empId/update",
  portalAuth.adminMiddleware,
  upload.any(),
  adminUpdateEmployee
);

// ✅ Admin review & approve/reject employee profile
Users.put(
  "/admin/review-profile/:empId",
  portalAuth.adminMiddleware,
  adminReviewProfile
);

Users.get(
  "/today-birthdays",
  portalAuth.authMiddleware,
  getTodayBirthdays
);

Users.post(
  "/birthday-wish/send",
  portalAuth.authMiddleware,
  sendBirthdayWish
);

Users.get(
  "/birthday-wish/received",
  portalAuth.authMiddleware,
  getReceivedWishes
);

Users.post(
  "/birthday-wish/reply",
  portalAuth.authMiddleware,
  replyBirthdayWish
);

Users.get(
  "/birthday-wish/sent",
  portalAuth.authMiddleware,
  getUserSentWishes
);

/* ═══════════════════════════════════════════════════════════
   PROFILE ROUTES
═══════════════════════════════════════════════════════════ */

Users.get(
  "/get-profile",
  portalAuth.authMiddleware,
  profileController.getProfile
);

// ✅ Profile photo update with file upload
Users.put(
  "/update-profile",
  portalAuth.authMiddleware,
  upload.single("photo"),
  profileController.updateProfile
);

Users.put(
  "/change-password",
  portalAuth.authMiddleware,
  profileController.changePassword
);

Users.get(
  "/attendance/govholidays",
  portalAuth.authMiddleware,
  attendanceController.getgovHolidays
);

Users.put(
  "/attendance/govholidays/:id",
  portalAuth.authMiddleware,
  attendanceController.updateGovHoliday
);
// ✅ Salary Details CRUD (Admin only)
Users.post("/employee/salary", portalAuth.adminMiddleware, upload.any(), UsersController.addSalaryDetails);
// ✅ Salary Details (Admins can view all, Employees can view their own)
Users.get("/employee/salary/:empId", portalAuth.authMiddleware, UsersController.getSalaryDetails);
Users.put("/employee/salary/:empId/:salaryId", portalAuth.adminMiddleware, upload.any(), UsersController.updateSalaryDetails);
Users.delete("/employee/salary/:empId/:salaryId", portalAuth.adminMiddleware, UsersController.deleteSalaryDetails);

// ✅ Increment Documents (S3 Upload, Fetch & Delete)
Users.post("/employee/increment-documents", portalAuth.adminMiddleware, upload.any(), UsersController.uploadIncrementDocuments);
Users.get("/employee/increment-documents/:empId", portalAuth.authMiddleware, UsersController.getIncrementDocuments);
Users.delete("/employee/increment-documents/:empId/:docId", portalAuth.authMiddleware, UsersController.deleteIncrementDocuments);
Users.delete("/employee/document/:empId", portalAuth.adminMiddleware, UsersController.deleteGeneralDocument);

Users.put("/employee/bank/:empId", portalAuth.adminMiddleware, UsersController.updateBankDetails);
Users.delete("/employee/bank-history/:empId/:historyId", portalAuth.adminMiddleware, UsersController.deleteBankHistory);
Users.put("/employee/bank-history/:empId/:historyId", portalAuth.adminMiddleware, UsersController.updateBankHistory);


module.exports = Users;