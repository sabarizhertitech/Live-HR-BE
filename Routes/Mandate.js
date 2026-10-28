const mandate = require("../CUBUatOnboardingMandateController");
const express = require("express");

const router = express.Router();
// 14. Create Mandate
router.post('/mandate/create', mandate.createMandate);

// 15. Update Mandate
router.post('/mandate/update', mandate.updateMandate);

// 16. Revoke Mandate
router.post('/mandate/revoke', mandate.revokeMandate);

// 17. Mandate Status Enquiry
router.post('/mandate/status', mandate.getMandateStatus);

// 18. Mandate List Enquiry
router.post('/mandate/list', mandate.listMandates);

// 19. Mandate Pre-debit Notification
router.post('/mandate/pre-debit-notification', mandate.sendMandatePreDebitNotification);

// 20. Mandate Collection Request (Debit Execution)
router.post('/mandate/collect', mandate.collectMandate);

module.exports = router;
