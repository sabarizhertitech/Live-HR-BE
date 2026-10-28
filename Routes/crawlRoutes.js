const express = require("express");
const router = express.Router();
const crawlController = require("../Webcrawlling/Controller/crawlController");


router.post("/crawl", crawlController.startCrawl);
router.delete("/crawl/:jobId", crawlController.cancelCrawl);
router.get("/status/:jobId", crawlController.getCrawlStatus);
router.get("/reports", crawlController.getReports);
router.get("/reports/:id", crawlController.getReportDetails);
router.delete("/reports/:id", crawlController.deleteReport);
router.get("/dashboard/stats", crawlController.getDashboardStats);
// Seperate API
router.post("/crawl-and-report", crawlController.crawlAndGenerateReport);

module.exports = router;

