const express = require("express");
const router = express.Router();
const { authMiddleware } = require("../middleware/portalAuth");
const upload = require("../middleware/uploadMemory");
const sanitizeRequestData = require("../middleware/sanitizeRequestData");

const {
  createTask,
  updateTask,
  getTaskById,


  getDashboardTasks,
  getAllDashboardTasks,
  deleteTaskDocument,
  deleteTask,
  getEmployeeProjectDetails,
  getProjectPhases,
  updateTaskPhase,
  editAssignedTaskBeforeAccept,
} = require("../controllers/task.controller");




const {
  getTaskMeta,
  getProjectsByCategory,
  addCategory,
  updateCategory,
  deleteCategory,
  addProject,
  deleteProject,
  updateProject,
  addPage,
  deletePage,
} = require("../controllers/taskMeta.controller");

const {
  createDailyUpdate,
  getDailyUpdates,
  getTodayUpdates,
  getAllDailyWorkUpdates,
  getWorkUpdateMeta,
  getStandaloneWorkUpdates,
  getWorkByMetadata,
  updateDailyUpdate,
  getEmployeeDailyWorkUpdates,
  deleteWorkUpdate,
} = require("../controllers/Dailyworkupdate.controller");

const {
  getMyPerformance,
  getMyTasks,
  getEmployeePerformance,
  getAdminTeam,
  getAdminEmployees,
  getAdminTasks,
  getTrends,
  getTaskAnalyticsLegacy,
} = require("../controllers/taskAnalytics.controller");

router.use(sanitizeRequestData);

/* ──── Task CRUD ──── */
router.post("/task", authMiddleware, upload.array("files", 5), createTask);
router.put("/task/:id", authMiddleware, upload.array("files", 5), updateTask);
router.put("/tasks/:taskId/phases/:phaseId", authMiddleware, updateTaskPhase);
router.put("/tasks/:taskId/edit-before-accept", authMiddleware, upload.array("files", 5), editAssignedTaskBeforeAccept);
router.delete("/task/:taskId/document/:docId", authMiddleware, deleteTaskDocument);
router.delete("/task/:id", authMiddleware, deleteTask);

/* ──── Task Analytics Engine Endpoints ──── */
router.get("/tasks/analytics/my-performance", authMiddleware, getMyPerformance);
router.get("/tasks/analytics/my-tasks", authMiddleware, getMyTasks);
router.get("/tasks/analytics/admin/team", authMiddleware, getAdminTeam);
router.get("/tasks/analytics/admin/employees", authMiddleware, getAdminEmployees);
router.get("/tasks/analytics/admin/tasks", authMiddleware, getAdminTasks);
router.get("/tasks/analytics/trends", authMiddleware, getTrends);

router.get("/analytics/my-performance", authMiddleware, getMyPerformance);
router.get("/analytics/my-tasks", authMiddleware, getMyTasks);
router.get("/analytics/admin/team", authMiddleware, getAdminTeam);
router.get("/analytics/admin/employees", authMiddleware, getAdminEmployees);
router.get("/analytics/admin/tasks", authMiddleware, getAdminTasks);
router.get("/analytics/trends", authMiddleware, getTrends);

/* ──── Employee Analytics & Legacy Compatibility ──── */
router.get("/tasks/analytics/employee/:employeeId", authMiddleware, getEmployeePerformance);
router.get("/analytics/employee/:employeeId", authMiddleware, getEmployeePerformance);
router.get("/tasks/analytics", authMiddleware, getTaskAnalyticsLegacy);
router.get("/analytics", authMiddleware, getTaskAnalyticsLegacy);
router.get("/tasks/dashboard", authMiddleware, getDashboardTasks);
router.get("/tasks/admin-dashboard", authMiddleware, getAllDashboardTasks);
router.get("/tasks/project-details", authMiddleware, getEmployeeProjectDetails);
router.get("/tasks/project-phases", authMiddleware, getProjectPhases);



/* ──── Task Meta (Categories & Projects) ──── */
router.get("/task-meta", authMiddleware, getTaskMeta);
router.get("/task-meta/projects/:categoryId", authMiddleware, getProjectsByCategory);
router.post("/task-meta/category", authMiddleware, addCategory);
router.put("/task-meta/category/:id", authMiddleware, updateCategory);
router.delete("/task-meta/category/:id", authMiddleware, deleteCategory);
router.post("/task-meta/project", authMiddleware, addProject);
router.put("/task-meta/project", authMiddleware, updateProject);
router.delete("/task-meta/project", authMiddleware, deleteProject);
router.post("/task-meta/page", authMiddleware, addPage);
router.delete("/task-meta/page", authMiddleware, deletePage);

router.post("/daily-update", authMiddleware, createDailyUpdate);
router.put("/daily-update/:id", authMiddleware, updateDailyUpdate);
router.delete("/daily-update/:id", authMiddleware, deleteWorkUpdate);
router.get("/daily-update/today/:taskId", authMiddleware, getTodayUpdates);
router.get("/daily-update/employee/history", authMiddleware, getEmployeeDailyWorkUpdates);
router.get("/daily-update/all", authMiddleware, getAllDailyWorkUpdates);
router.get("/daily-update/meta", authMiddleware, getWorkUpdateMeta);
router.get("/daily-update/standalone-updates", authMiddleware, getStandaloneWorkUpdates);
router.get("/daily-update/report-by-meta", authMiddleware, getWorkByMetadata);
router.get("/daily-update/:taskId", authMiddleware, getDailyUpdates);

/* Keep this LAST – generic :id catch-all */
router.get("/tasks/:id", authMiddleware, getTaskById);

module.exports = router;