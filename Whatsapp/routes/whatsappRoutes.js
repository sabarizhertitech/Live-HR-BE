// routes/whatsappRoutes.js

const express = require("express");
const router = express.Router();

const WhatsAppController = require("../controllers/WhatsAppController");
const WhatsAppTemplateController = require("../controllers/WhatsAppTemplateController");
const UserController = require("../controllers/UserController");
const validateWebhook = require("../middleware/validateWebhook");
const auth = require("../middleware/auth");

// Public Meta Webhook Endpoints (no auth needed for Meta servers)
router.get(["/webhook", "/call", "/"], WhatsAppController.verifyWebhook);
router.post(["/webhook", "/call", "/"], validateWebhook, WhatsAppController.receiveMessage);

// Protected Admin Endpoints (requires x-api-key header)
router.use(["/templates", "/customers", "/logs"], auth);

// Bulk Template Message Dispatch
router.post("/templates/send", WhatsAppTemplateController.sendBulkTemplate);

// Customer/Recipient Directory Endpoints
router.post("/customers", UserController.createUser);
router.get("/customers", UserController.getUsers);
router.post("/customers/import", UserController.uploadUsers);

// Fetch Message Logs (sent & received)
router.get("/logs", WhatsAppController.getLogs);

// Fetch WABA Templates
router.get("/templates", WhatsAppTemplateController.getMetaTemplates);

module.exports = router;