const { CrawlReport, CrawlPage } = require("../../Models/CrawlReport");
const { crawlWebsite } = require("../crawler/engine");
const { generateAggregatedReport } = require("../Services/crawlReportGenerator");
const dns = require('dns').promises;

// In-memory active jobs map to track running crawls and cancellation
// Map key: jobId (string), value: { jobId, hostname, abortController }
const activeJobs = new Map();

const validateURLAndSSRF = async (inputUrl) => {
  let parsedUrl;
  try {
    parsedUrl = new URL(inputUrl);
  } catch (err) {
    throw new Error("Invalid URL format.");
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("Unsupported protocol. Only HTTP and HTTPS are allowed.");
  }

  const hostname = parsedUrl.hostname;
  
  // Basic Regex checks for common local/private blocks
  const forbiddenHostnames = [
    "localhost",
    "127.0.0.1",
    "169.254.169.254", // Cloud Metadata
    "0.0.0.0",
  ];

  if (forbiddenHostnames.includes(hostname) || hostname.endsWith(".internal")) {
    throw new Error("Forbidden hostname.");
  }

  try {
    const addresses = await dns.resolve(hostname);
    for (const ip of addresses) {
      if (
        ip === "127.0.0.1" ||
        ip.startsWith("10.") ||
        ip.startsWith("192.168.") ||
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip) ||
        ip === "169.254.169.254"
      ) {
        throw new Error("Forbidden IP resolved from hostname (SSRF Protection).");
      }
    }
  } catch (err) {
    if (err.message.includes("Forbidden IP")) throw err;
    throw new Error("Could not resolve hostname.");
  }

  return { validUrl: parsedUrl.href, hostname };
};


exports.startCrawl = async (req, res) => {
  try {
    const { url, maxDepth = 2, maxPages = 20, concurrency = 2, timeout = 30000 } = req.body;

    if (!url) {
      return res.status(400).json({ success: false, message: "URL is required to start crawling." });
    }

    // SSRF & URL Validation
    let validUrl, hostname;
    try {
      const result = await validateURLAndSSRF(url);
      validUrl = result.validUrl;
      hostname = result.hostname;
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }

    // Apply sane constraints
    const safeMaxDepth = Math.min(Math.max(Number(maxDepth) || 2, 1), 5);
    const safeMaxPages = Math.min(Math.max(Number(maxPages) || 10, 1), 100);
    const safeConcurrency = Math.min(Math.max(Number(concurrency) || 2, 1), 5);
    const safeTimeout = Math.min(Math.max(Number(timeout) || 30000, 5000), 120000); // max 2 min per page

    // Create a database entry for this job
    const report = new CrawlReport({
      url: validUrl,
      status: "pending",
    });
    await report.save();

    const jobId = report._id;
    const abortController = new AbortController();

    // Register active job by jobId
    activeJobs.set(jobId.toString(), { jobId, hostname, abortController });

    // Detached Asynchronous Background Execution
    (async () => {
      try {
        await CrawlReport.findByIdAndUpdate(jobId, { status: "crawling" });
        const startTime = Date.now();

        // 1. Recursive Playwright crawl
        // Assuming crawlWebsite supports AbortSignal in its options
        const crawlMeta = await crawlWebsite(validUrl, { 
          maxDepth: safeMaxDepth, 
          maxPages: safeMaxPages, 
          concurrency: safeConcurrency, 
          timeout: safeTimeout,
          signal: abortController.signal
        }, jobId);

        // Check if aborted
        if (abortController.signal.aborted) {
          throw new Error("Crawl was cancelled by user.");
        }

        // 2. Perform analytics pipeline
        await CrawlReport.findByIdAndUpdate(jobId, { 
          status: "analyzing",
          depthReached: crawlMeta.depthReached || 0,
          totalPagesScanned: crawlMeta.totalPagesScanned || 0
        });

        await generateAggregatedReport(jobId, validUrl);

        // Calculate and save execution duration
        const crawlTimeMs = Date.now() - startTime;
        await CrawlReport.findByIdAndUpdate(jobId, { 
          status: "completed", 
          crawlTimeMs 
        });
        console.log(`[CrawlController] Job ${jobId}: Crawl completed successfully`);

      } catch (err) {
        console.error(`Background crawl job ${jobId} failed:`, err);
        const isAbort = err.message === "Crawl was cancelled by user.";
        const status = isAbort ? "cancelled" : "failed";
        
        if (isAbort) {
          console.warn(`[CrawlController] Job ${jobId}: Crawl ${status}: ${err.message}`);
        } else {
          console.error(`[CrawlController] Job ${jobId}: Crawl ${status}: ${err.message}`);
        }
        await CrawlReport.findByIdAndUpdate(jobId, {
          status,
          error: err.message,
        });
      } finally {
        // Always cleanup active job
        activeJobs.delete(jobId.toString());
      }
    })();

    return res.status(202).json({
      success: true,
      message: "Crawl started in background.",
      jobId,
      config: {
        maxDepth: safeMaxDepth,
        maxPages: safeMaxPages,
        concurrency: safeConcurrency
      }
    });
  } catch (err) {
    console.error("Error in startCrawl:", err);
    return res.status(500).json({ success: false, message: "Internal server error starting crawl." });
  }
};

/**
 * Safely categorizes crawl/report errors into human-readable codes, reasons, and details,
 * without leaking raw stack traces to the API client.
 */
function classifyFailure(err, stage, timeout = 30000, abortController = null) {
  const errMsg = (err && err.message) ? err.message : String(err || "");
  const isAbort = errMsg === "Crawl was cancelled by user." || (abortController && abortController.signal.aborted);

  if (isAbort) {
    return {
      stage: stage === "crawling" ? "crawling" : stage,
      reason: "Crawl was cancelled by user.",
      error: "CANCELLED",
      details: "The crawl operation was aborted upon user cancellation request."
    };
  }

  const lower = errMsg.toLowerCase();

  // Timeout
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("etimedout")) {
    return {
      stage: stage || "crawling",
      reason: "Website response timed out.",
      error: "TIMEOUT",
      details: `The target website did not respond within the configured timeout of ${timeout} ms.`
    };
  }

  // Connection Refused
  if (lower.includes("econnrefused")) {
    return {
      stage: stage || "crawling",
      reason: "Website could not be reached.",
      error: "ECONNREFUSED",
      details: "The target server refused the connection or the port is closed."
    };
  }

  // Connection Reset / Closed
  if (lower.includes("econnreset") || lower.includes("err_connection_reset") || lower.includes("connection closed")) {
    return {
      stage: stage || "crawling",
      reason: "Unable to access the website.",
      error: "ERR_CONNECTION_RESET",
      details: "The target website closed the connection while the crawler was accessing the page."
    };
  }

  // DNS Error
  if (lower.includes("enotfound") || lower.includes("err_name_not_resolved") || lower.includes("could not resolve hostname")) {
    return {
      stage: stage || "crawling",
      reason: "Website could not be reached (DNS resolution failed).",
      error: "DNS_ERROR",
      details: "The domain name could not be resolved to an IP address."
    };
  }

  // SSL / Certificate Error
  if (lower.includes("cert_") || lower.includes("certificate") || lower.includes("ssl") || lower.includes("depth_zero_self_signed_cert")) {
    return {
      stage: stage || "crawling",
      reason: "SSL/TLS connection failed.",
      error: "CERTIFICATE_ERROR",
      details: "The crawler could not establish a trusted HTTPS connection."
    };
  }

  // Access Denied / Bot Challenge
  if (lower.includes("403") || lower.includes("access denied") || lower.includes("forbidden") || lower.includes("cloudflare")) {
    return {
      stage: stage || "crawling",
      reason: "Website access denied or protected by bot challenge.",
      error: "ACCESS_DENIED",
      details: "The target website blocked access or presented an anti-bot challenge page."
    };
  }

  // Specific stages
  if (stage === "analyzing") {
    return {
      stage: "analyzing",
      reason: "Unable to analyze crawled website data.",
      error: "ANALYSIS_ERROR",
      details: "An error occurred while analyzing the crawled website data."
    };
  }

  if (stage === "report_generation") {
    return {
      stage: "report_generation",
      reason: "Unable to generate the aggregated report.",
      error: "REPORT_GENERATION_ERROR",
      details: "An error occurred while analyzing the crawled website data and generating the report."
    };
  }

  if (stage === "database") {
    return {
      stage: "database",
      reason: "Unable to retrieve the final report from database.",
      error: "DATABASE_ERROR",
      details: "The report was generated but could not be retrieved from MongoDB."
    };
  }

  // Generic fallback
  return {
    stage: stage || "unknown",
    reason: stage === "crawling" ? "Unable to access the target website." : "An unexpected failure occurred.",
    error: (err && err.code) ? String(err.code) : "CRAWL_FAILED",
    details: errMsg.split("\n")[0] || "An unhandled error occurred during crawling."
  };
}

function cleanFieldName(rawLabel, rawName, semanticType) {
  let name = (rawLabel || "").trim();
  if (!name || /form-field-input|input-|field-/i.test(name)) {
    name = (rawName || "").trim();
  }
  if (!name || /form-field-input|input-|field-/i.test(name)) {
    if (semanticType === "phone") return "Phone *";
    if (semanticType === "name") return "Name";
    if (semanticType === "email") return "Email *";
    return "Form Field";
  }
  if (name.length > 50) {
    if (/terms|condition|consent|promotional/i.test(name)) return "Terms & Conditions Checkbox";
    return name.slice(0, 47) + "...";
  }
  return name;
}

/**
 * Extracts failed form fields with clean field name, issue, and expected validation
 * without verbose clutter or duplicate entries.
 */
function extractFormValidationIssues(contactForms = [], finalReport = null) {
  const issues = [];
  const seenKeys = new Set();

  const addIssue = (fieldName, issue, expectedValidation) => {
    const key = (fieldName || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      issues.push({
        fieldName,
        issue,
        expectedValidation,
      });
    }
  };

  // 1. Inspect contact forms and their individual fields
  for (const form of contactForms) {
    const fields = Array.isArray(form.fields) ? form.fields : [];
    for (const field of fields) {
      if (!field || typeof field !== "object") continue;

      const failedTests = Array.isArray(field.tests)
        ? field.tests.filter(t => t.passed === false || t.status === "FAIL")
        : [];
      const isFailed = field.overallFieldStatus === "FAIL" ||
                       field.validationStatus === "FAIL" ||
                       failedTests.length > 0;

      if (!isFailed) continue;

      const semanticType = (field.semanticType || "").toLowerCase();
      const fieldType = (field.fieldType || field.type || "").toLowerCase();
      const rawLabel = field.label || field.placeholder || "";
      const rawName = field.name || field.fieldName || "";
      const fieldName = cleanFieldName(rawLabel, rawName, semanticType);

      if (semanticType === "phone" || fieldType === "tel" || /phone|tel|mobile/i.test(fieldName)) {
        addIssue(
          fieldName,
          "Accepts letters and invalid phone numbers; validation appears only on blur.",
          "Allow digits only and show validation errors immediately."
        );
      } else if (semanticType === "name" || /first.*name|last.*name|name/i.test(fieldName)) {
        addIssue(
          fieldName,
          "Accepts numbers and special symbols.",
          "Allow letters only (a-z, A-Z and spaces)."
        );
      } else if (semanticType === "email" || fieldType === "email" || /email/i.test(fieldName)) {
        addIssue(
          fieldName,
          "Accepts invalid email format.",
          "Allow valid email address only (user@domain.com)."
        );
      } else if (fieldType === "checkbox" || /checkbox|terms|consent/i.test(fieldName)) {
        addIssue(
          fieldName,
          "Required consent checkbox is not enforced before submission.",
          "Must be checked before form submission."
        );
      } else {
        addIssue(
          fieldName,
          "Field failed input validation checks.",
          "Ensure input constraints and required format are enforced."
        );
      }
    }
  }

  // 2. Fallback check for fieldSummaries
  if (issues.length === 0 && Array.isArray(finalReport?.formValidationSummary?.fieldSummaries)) {
    for (const fs of finalReport.formValidationSummary.fieldSummaries) {
      if (fs.status !== "FAIL") continue;
      const fieldName = cleanFieldName(fs.label, fs.fieldName, fs.semanticType);
      const isPhone = /phone|tel|mobile/i.test(fieldName + " " + (fs.fieldName || ""));
      const isName = /first.*name|last.*name|name/i.test(fieldName + " " + (fs.fieldName || ""));
      const isEmail = /email/i.test(fieldName + " " + (fs.fieldName || ""));
      const isCheckbox = /checkbox|terms|consent/i.test(fieldName + " " + (fs.fieldName || ""));

      if (isPhone) {
        addIssue(
          fieldName,
          "Accepts letters and invalid phone numbers; validation appears only on blur.",
          "Allow digits only and show validation errors immediately."
        );
      } else if (isName) {
        addIssue(
          fieldName,
          "Accepts numbers and special symbols.",
          "Allow letters only (a-z, A-Z and spaces)."
        );
      } else if (isEmail) {
        addIssue(
          fieldName,
          "Accepts invalid email format.",
          "Allow valid email address only (user@domain.com)."
        );
      } else if (isCheckbox) {
        addIssue(
          fieldName,
          "Required consent checkbox is not enforced before submission.",
          "Must be checked before form submission."
        );
      } else {
        addIssue(
          fieldName,
          "Field failed input validation checks.",
          "Ensure input constraints and required format are enforced."
        );
      }
    }
  }

  return issues;
}

/**
 * Evaluates the 8 mandatory website information requirements and determines
 * compliance status ('Approved' | 'Moderate' | 'Risk') and descriptive remarks.
 */
function evaluateMandatoryWebsiteCompliance(finalReport, pages = []) {
  try {
    const complianceSummary = finalReport?.complianceSummary || {};
    const extractedEntities = complianceSummary.extractedEntities || {};
    const safePages = Array.isArray(pages) ? pages.filter(Boolean) : [];

    // 1. Privacy Policy
    const privacyPolicy = Boolean(
      complianceSummary.hasPrivacyPolicy ||
      complianceSummary.policyUrls?.privacy ||
      safePages.some(p => p.pageType === "privacy" || /(?:privacy|privacy[-_]?policy)/i.test(p.url || ""))
    );

    // 2. Refund Policy
    const refundPolicy = Boolean(
      complianceSummary.hasRefundPolicy ||
      complianceSummary.policyUrls?.refund ||
      safePages.some(p => p.pageType === "refund" || /(?:refund|cancellation|returns?[-_]?policy)/i.test(p.url || ""))
    );

    // 3. Terms and Conditions
    const termsAndConditions = Boolean(
      complianceSummary.hasTermsOfService ||
      complianceSummary.policyUrls?.terms ||
      safePages.some(p => p.pageType === "terms" || /(?:terms|terms[-_]?and[-_]?conditions|terms[-_]?of[-_]?service|tos)/i.test(p.url || ""))
    );

    // 4. Address
    const candidateAddresses = [
      ...(Array.isArray(complianceSummary.addresses) ? complianceSummary.addresses : []),
      ...(Array.isArray(extractedEntities.addresses) ? extractedEntities.addresses : []),
      ...safePages.flatMap(p => (Array.isArray(p.addresses) ? p.addresses : []))
    ].filter(Boolean);
    const address = candidateAddresses.some(addr => {
      if (typeof addr !== "string") return false;
      const clean = addr.trim();
      return clean.length >= 10 && !clean.includes('{"') && !clean.includes("place_id");
    });

    // 5. Phone Number
    const candidatePhones = [
      ...(Array.isArray(extractedEntities.phones) ? extractedEntities.phones : []),
      ...safePages.flatMap(p => {
        const list = Array.isArray(p.phones) ? p.phones : [];
        return list.map(ph => (typeof ph === "string" ? ph : ph?.phone || ""));
      })
    ].filter(Boolean);
    const phoneNumber = candidatePhones.some(ph => {
      if (typeof ph !== "string") return false;
      const digits = ph.replace(/\D/g, "");
      return digits.length >= 7 && digits.length <= 15;
    });

    // 6. Email (Proper email format validation: local-part@domain.extension)
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    const candidateEmails = [
      ...(Array.isArray(extractedEntities.supportEmails) ? extractedEntities.supportEmails : []),
      ...safePages.flatMap(p => (Array.isArray(p.emails) ? p.emails : []))
    ].filter(Boolean);
    const email = candidateEmails.some(em => {
      if (typeof em !== "string") return false;
      const clean = em.trim().toLowerCase();
      if (!emailRegex.test(clean)) return false;
      if (/\.(png|jpg|jpeg|gif|svg|webp|css|js|woff|woff2)$/i.test(clean)) return false;
      return true;
    });

    // 7. Contact Us Form Validation
    // A form is only validated if the website / Contact Us page contains a form.
    // If the website does not contain any form, form validation is NOT mandatory and is skipped.
    const contactPages = safePages.filter(p => {
      const u = (p.url || "").toLowerCase();
      const pt = (p.pageType || "").toLowerCase();
      const title = (p.title || "").toLowerCase();
      return pt === "contact" ||
        /(?:^|\/|\?|=)(?:contact|contact[-_]?us|get[-_]?in[-_]?touch|reach[-_]?us)(?:$|\/|\?|#|\.html|\.php|\/)/i.test(u) ||
        /\bcontact\s*(us|me)?\b/i.test(title);
    });

    const isExcludedForm = (form) => {
      if (!form || typeof form !== "object") return true;
      const formType = (form.formType || "").toLowerCase();
      if (["login", "search", "newsletter", "auth"].includes(formType)) return true;
      const fields = Array.isArray(form.fields) ? form.fields : (Array.isArray(form.inputs) ? form.inputs : []);
      if (fields.length === 0 && (!form.totalFields || form.totalFields === 0)) return true;
      if (fields.length === 1) {
        const f = fields[0];
        const meta = `${f.name || ""} ${f.fieldName || ""} ${f.id || ""} ${f.placeholder || ""}`.toLowerCase();
        if (/\b(search|find|query|subscribe|newsletter)\b/i.test(meta)) return true;
      }
      return false;
    };

    const contactForms = [];

    // 1. Check contact pages for forms
    for (const cp of contactPages) {
      const forms = Array.isArray(cp.forms) ? cp.forms : [];
      for (const form of forms) {
        if (!isExcludedForm(form)) {
          contactForms.push(form);
        }
      }
    }

    // 2. Fallback: check other pages if they contain a form specifically classified as contact/enquiry
    if (contactForms.length === 0) {
      for (const p of safePages) {
        const forms = Array.isArray(p.forms) ? p.forms : [];
        for (const form of forms) {
          const formType = (form.formType || "").toLowerCase();
          if (["contact", "enquiry"].includes(formType) && !isExcludedForm(form)) {
            contactForms.push(form);
          }
        }
      }
    }

    // 3. Fallback: check aggregated forms summary
    if (contactForms.length === 0 && Array.isArray(finalReport?.formValidationSummary?.forms)) {
      for (const form of finalReport.formValidationSummary.forms) {
        const pageUrl = (form.pageUrl || "").toLowerCase();
        const formType = (form.formType || "").toLowerCase();
        const isContactForm = formType === "contact" || formType === "enquiry" || /(?:contact|get[-_]?in[-_]?touch|reach[-_]?us)/i.test(pageUrl);
        if (isContactForm && !isExcludedForm(form)) {
          contactForms.push(form);
        }
      }
    }

    const hasContactUsForm = contactForms.length > 0;
    let contactUsFormValidation = true;
    let formValidationIssues = [];

    if (hasContactUsForm) {
      // Form was found on the website: check that the form validation is correct (no failures)
      const formHasFailure = (form) => {
        if (form.overallStatus === "FAIL") return true;
        if (typeof form.failedTests === "number" && form.failedTests > 0) return true;
        if (Array.isArray(form.fields)) {
          return form.fields.some(f => {
            if (!f || typeof f !== "object") return false;
            if (f.overallFieldStatus === "FAIL" || f.validationStatus === "FAIL") return true;
            if (Array.isArray(f.tests) && f.tests.some(t => t.passed === false || t.status === "FAIL")) return true;
            return false;
          });
        }
        return false;
      };

      const hasFailingForm = contactForms.some(formHasFailure);
      contactUsFormValidation = !hasFailingForm;

      if (!contactUsFormValidation) {
        formValidationIssues = extractFormValidationIssues(contactForms, finalReport);
      }
    }

    // 8. About Us
    const aboutUs = Boolean(
      complianceSummary.hasAboutUs ||
      complianceSummary.aboutUsUrl ||
      complianceSummary.policyUrls?.about ||
      safePages.some(p => p.pageType === "about" || /(?:about|about[-_]?us|who[-_]?we[-_]?are|our[-_]?story)/i.test(p.url || ""))
    );

    const mandatoryData = {
      privacyPolicy,
      refundPolicy,
      termsAndConditions,
      address,
      phoneNumber,
      email,
      aboutUs,
    };

    const labels = [
      { key: "privacyPolicy", label: "Privacy Policy" },
      { key: "refundPolicy", label: "Refund Policy" },
      { key: "termsAndConditions", label: "Terms and Conditions" },
      { key: "address", label: "Address" },
      { key: "phoneNumber", label: "Phone Number" },
      { key: "email", label: "Email" },
      { key: "aboutUs", label: "About Us" },
    ];

    // Form validation is only checked and included if the website actually contains a form
    if (hasContactUsForm) {
      mandatoryData.contactUsFormValidation = contactUsFormValidation;
      labels.push({ key: "contactUsFormValidation", label: "Contact Us Form Validation" });
    }

    const presentItems = labels.filter(item => mandatoryData[item.key]);
    const missingItems = labels.filter(item => !mandatoryData[item.key]);
    const formattedMissing = missingItems.map((item, index) => `${index + 1}. ${item.label}`).join(", ");

    let status = "Moderate";
    let remarks = "";

    if (missingItems.length === 0) {
      status = "Approved";
      remarks = "All mandatory website compliance requirements have been successfully verified and are present.";
    } else if (presentItems.length === 0) {
      status = "Risk";
      remarks = `The website failed mandatory compliance verification. All mandatory information is missing: ${formattedMissing}.`;
    } else {
      status = "Moderate";
      remarks = `The website partially meets compliance standards. The following mandatory information is missing: ${formattedMissing}.`;
    }

    return {
      status,
      remarks,
      mandatoryData,
      formValidationIssues,
    };
  } catch (evalErr) {
    console.error("[evaluateMandatoryWebsiteCompliance] Error during evaluation:", evalErr);
    return {
      status: "Moderate",
      remarks: "Mandatory information evaluation completed with warnings.",
      mandatoryData: {
        privacyPolicy: false,
        refundPolicy: false,
        termsAndConditions: false,
        address: false,
        phoneNumber: false,
        email: false,
        contactUsFormValidation: false,
        aboutUs: false,
      },
      formValidationIssues: [],
    };
  }
}

/**
 * Synchronously crawls a website, generates the aggregated report,
 * saves it to MongoDB, and returns the final report in the same response.
 */
exports.crawlAndGenerateReport = async (req, res) => {
  // Prevent socket timeout for long-running crawling operations (10 mins)
  if (req.setTimeout) req.setTimeout(600000);
  if (res.setTimeout) res.setTimeout(600000);
  if (req.socket && req.socket.setTimeout) req.socket.setTimeout(600000);

  const startTime = Date.now();
  let currentStage = "initialization";
  let crawlMeta = { depthReached: 0, totalPagesScanned: 0 };
  let jobId = null;
  let validUrl = null;
  let hostname = null;
  let abortController = null;
  let safeTimeout = 30000;

  try {
    const {
      url,
      maxDepth = 2,
      maxPages = 6,
      concurrency = 3,
      timeout = 15000,
    } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        status: "failed",
        message: "URL is required.",
        failure: {
          stage: "validation",
          reason: "Missing required URL parameter.",
          error: "MISSING_URL",
          details: "A valid target website URL must be provided in the request body."
        }
      });
    }

    // --------------------------------------------------
    // 1. Validate URL + SSRF protection
    // --------------------------------------------------
    try {
      const result = await validateURLAndSSRF(url);
      validUrl = result.validUrl;
      hostname = result.hostname;
    } catch (err) {
      return res.status(400).json({
        success: false,
        status: "failed",
        message: err.message,
        failure: {
          stage: "validation",
          reason: "URL validation or SSRF check failed.",
          error: "INVALID_URL_OR_SSRF",
          details: err.message
        }
      });
    }

    // --------------------------------------------------
    // 3. Apply safe limits (Targeted Fast-Scan)
    // --------------------------------------------------
    const safeMaxDepth = Math.min(
      Math.max(Number(maxDepth) || 2, 1),
      5
    );

    const safeMaxPages = Math.min(
      Math.max(Number(maxPages) || 6, 1),
      100
    );

    const safeConcurrency = Math.min(
      Math.max(Number(concurrency) || 3, 1),
      5
    );

    safeTimeout = Math.min(
      Math.max(Number(timeout) || 15000, 5000),
      120000
    );

    // --------------------------------------------------
    // 4. Create report document
    // --------------------------------------------------
    const report = new CrawlReport({
      url: validUrl,
      status: "pending",
    });

    await report.save();

    jobId = report._id;
    abortController = new AbortController();

    activeJobs.set(jobId.toString(), {
      jobId,
      hostname,
      abortController,
    });

    try {
      // --------------------------------------------------
      // 5. Start crawling
      // --------------------------------------------------
      currentStage = "crawling";
      await CrawlReport.findByIdAndUpdate(jobId, {
        status: "crawling",
      });


      crawlMeta = await crawlWebsite(
        validUrl,
        {
          maxDepth: safeMaxDepth,
          maxPages: safeMaxPages,
          concurrency: safeConcurrency,
          timeout: safeTimeout,
          signal: abortController.signal,
        },
        jobId
      );

      // --------------------------------------------------
      // 6. Check cancellation
      // --------------------------------------------------
      if (abortController.signal.aborted) {
        throw new Error("Crawl was cancelled by user.");
      }

      // --------------------------------------------------
      // 7. Update crawl statistics
      // --------------------------------------------------
      currentStage = "analyzing";
      await CrawlReport.findByIdAndUpdate(jobId, {
        status: "analyzing",
        depthReached: crawlMeta.depthReached || 0,
        totalPagesScanned: crawlMeta.totalPagesScanned || 0,
      });

      // --------------------------------------------------
      // 8. Generate complete aggregated report
      // --------------------------------------------------
      currentStage = "report_generation";
      await generateAggregatedReport(jobId, validUrl);

      // --------------------------------------------------
      // 9. Save execution time
      // --------------------------------------------------
      const crawlTimeMs = Date.now() - startTime;

      await CrawlReport.findByIdAndUpdate(jobId, {
        crawlTimeMs,
        status: "completed",
      });

      // --------------------------------------------------
      // 10. Fetch FINAL report and pages from MongoDB
      // --------------------------------------------------
      currentStage = "database";
      const finalReport = await CrawlReport.findById(jobId).lean();

      if (!finalReport) {
        throw new Error(
          "Report was generated but could not be retrieved."
        );
      }

      const pages = await CrawlPage.find({ reportId: jobId }).lean();


      const complianceEvaluation = evaluateMandatoryWebsiteCompliance(finalReport, pages);

      // --------------------------------------------------
      // 11. Return clean compliance response (status, remarks, formValidationIssues)
      // --------------------------------------------------
      const responsePayload = {
        status: complianceEvaluation.status,
        remarks: complianceEvaluation.remarks,
      };

      if (Array.isArray(complianceEvaluation.formValidationIssues) && complianceEvaluation.formValidationIssues.length > 0) {
        responsePayload.formValidationIssues = complianceEvaluation.formValidationIssues;
      }

      return res.status(200).json(responsePayload);
    } catch (err) {
      console.error(
        `[CrawlAndReport] Job ${jobId} failed in stage [${currentStage}]:`,
        err
      );

      const isAbort = err.message === "Crawl was cancelled by user." || (abortController && abortController.signal.aborted);
      const status = isAbort ? "cancelled" : "failed";

      await CrawlReport.findByIdAndUpdate(jobId, {
        status,
        error: err.message,
        crawlTimeMs: Date.now() - startTime,
      });

      const failure = classifyFailure(err, currentStage, safeTimeout, abortController);

      if (currentStage === "crawling") {
        return res.status(500).json({
          success: false,
          status,
          message: isAbort ? "Website crawling was cancelled by user." : "Website crawling failed.",
          jobId,
          url: validUrl,
          crawler: {
            status,
            failure,
          },
        });
      }

      if (currentStage === "analyzing") {
        return res.status(500).json({
          success: false,
          status: "failed",
          message: "Website crawling completed, but analysis failed.",
          jobId,
          url: validUrl,
          crawler: {
            status: "completed",
            totalPagesScanned: crawlMeta.totalPagesScanned || 0,
            depthReached: crawlMeta.depthReached || 0,
          },
          failure,
        });
      }

      if (currentStage === "report_generation") {
        return res.status(500).json({
          success: false,
          status: "failed",
          message: "Website crawling completed, but report generation failed.",
          jobId,
          url: validUrl,
          crawler: {
            status: "completed",
            totalPagesScanned: crawlMeta.totalPagesScanned || 0,
            depthReached: crawlMeta.depthReached || 0,
          },
          failure,
        });
      }

      // database or unknown stage
      return res.status(500).json({
        success: false,
        status: "failed",
        message: "Website crawling could not be completed because of a system error.",
        jobId,
        url: validUrl,
        failure,
      });
    } finally {
      // --------------------------------------------------
      // 12. Always release active job lock
      // --------------------------------------------------
      if (jobId) {
        activeJobs.delete(jobId.toString());
      }
    }
  } catch (err) {
    console.error(
      "Error in crawlAndGenerateReport:",
      err
    );

    const failure = classifyFailure(err, currentStage, safeTimeout, abortController);

    return res.status(500).json({
      success: false,
      status: "failed",
      message: "Website crawling could not be completed because of a system error.",
      jobId,
      url: validUrl,
      failure,
    });
  }
};


/**
 * Cancels a running crawl asynchronously.
 */
exports.cancelCrawl = async (req, res) => {
  try {
    const { jobId } = req.params;
    const jobKey = jobId ? jobId.toString() : "";
    const targetJob = activeJobs.get(jobKey);

    if (!targetJob) {
      return res.status(404).json({ success: false, message: "Active crawl job not found or already completed." });
    }

    // Trigger the abort signal
    targetJob.abortController.abort();
    activeJobs.delete(jobKey);

    await CrawlReport.findByIdAndUpdate(jobId, { status: "cancelled", error: "Cancelled by user" });
    
    return res.status(200).json({ success: true, message: "Crawl cancellation requested successfully." });
  } catch (err) {
    console.error("Error in cancelCrawl:", err);
    return res.status(500).json({ success: false, message: "Internal server error cancelling crawl." });
  }
};

/**
 * Gets progress status and latest logs for a running crawl.
 */
exports.getCrawlStatus = async (req, res) => {
  try {
    const { jobId } = req.params;

    const report = await CrawlReport.findById(jobId).lean();
    if (!report) {
      return res.status(404).json({ success: false, message: "Crawl job not found." });
    }

    const jobKey = jobId.toString();
    const inMemoryLogs = (global.crawlJobLogs && global.crawlJobLogs.get(jobKey)) || [];

    return res.status(200).json({
      success: true,
      status: report.status,
      error: report.error,
      depthReached: report.depthReached,
      totalPagesScanned: report.totalPagesScanned,
      logs: inMemoryLogs.map(l => ({
        message: l.message,
        level: l.level,
        timestamp: l.timestamp,
      })),
    });
  } catch (err) {
    console.error("Error in getCrawlStatus:", err);
    return res.status(500).json({ success: false, message: "Server error querying crawl status." });
  }
};

/**
 * Retrieves a list of all saved crawl reports with pagination.
 */
exports.getReports = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.max(parseInt(req.query.limit) || 10, 1);
    const skip = (page - 1) * limit;

    const query = {};

    // 1. Search / Domain filter
    if (req.query.search && typeof req.query.search === "string" && req.query.search.trim()) {
      const sanitized = req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query.url = { $regex: sanitized, $options: "i" };
    }

    // 2. Status filter
    if (req.query.status && req.query.status !== "ALL" && req.query.status !== "all") {
      query.status = req.query.status;
    }

    // 3. Risk Severity / Level filter
    if (req.query.riskSeverity && req.query.riskSeverity !== "ALL" && req.query.riskSeverity !== "all") {
      const sev = req.query.riskSeverity.toUpperCase();
      if (sev === "HIGH") {
        query.$or = [{ riskSeverity: "HIGH" }, { "scores.risk": { $gt: 60 } }];
      } else if (sev === "MEDIUM") {
        query.$or = [{ riskSeverity: "MEDIUM" }, { "scores.risk": { $gt: 30, $lte: 60 } }];
      } else if (sev === "LOW") {
        query.$or = [{ riskSeverity: "LOW" }, { "scores.risk": { $lte: 30 } }];
      } else {
        query.riskSeverity = sev;
      }
    }

    const reports = await CrawlReport.find(query, {
      url: 1,
      status: 1,
      error: 1,
      totalPagesScanned: 1,
      scores: 1,
      riskSeverity: 1,
      summary: 1,
      createdAt: 1,
    })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await CrawlReport.countDocuments(query);

    return res.status(200).json({ 
      success: true, 
      reports,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error("Error in getReports:", err);
    return res.status(500).json({ success: false, message: "Server error fetching reports." });
  }
};

/**
 * Gets deep audit details for a specific completed report with pagination for pages.
 */
exports.getReportDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.max(parseInt(req.query.limit) || 20, 1);
    const skip = (page - 1) * limit;

    const report = await CrawlReport.findById(id).lean();
    if (!report) {
      return res.status(404).json({ success: false, message: "Report not found." });
    }

    // Fetch associated page details with pagination
    const pages = await CrawlPage.find({ reportId: id }, {
      url: 1,
      title: 1,
      metaDescription: 1,
      depth: 1,
      statusCode: 1,
      emails: 1,
      phones: 1,
      addresses: 1,
      copyrights: 1,
      companyNames: 1,
      seoScore: 1,
      securityIssues: 1,
      technologies: 1,
      links: 1,
      images: 1,
      forms: 1,
      securityHeaders: 1,
      headings: 1,
      pageType: 1,
      rawText: 1,
    })
      .sort({ depth: 1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const totalPages = await CrawlPage.countDocuments({ reportId: id });

    return res.status(200).json({
      success: true,
      report,
      pages,
      pagination: {
        total: totalPages,
        page,
        limit,
        pagesCount: Math.ceil(totalPages / limit)
      }
    });
  } catch (err) {
    console.error("Error in getReportDetails:", err);
    return res.status(500).json({ success: false, message: "Server error fetching report details." });
  }
};

/**
 * Deletes a crawl report and cascades delete to pages and logs.
 */
exports.deleteReport = async (req, res) => {
  try {
    const { id } = req.params;

    const report = await CrawlReport.findById(id).lean();
    if (!report) {
      return res.status(404).json({ success: false, message: "Report not found to delete." });
    }

    // Cancel if running
    const jobKey = id ? id.toString() : "";
    if (activeJobs.has(jobKey)) {
      const jobData = activeJobs.get(jobKey);
      if (jobData?.abortController) {
        jobData.abortController.abort();
      }
      activeJobs.delete(jobKey);
    }

    // Cascade deletes
    await CrawlPage.deleteMany({ reportId: id });

    await CrawlReport.findByIdAndDelete(id);

    // Delete associated in-memory logs
    if (global.crawlJobLogs) {
      global.crawlJobLogs.delete(id.toString());
    }

    return res.status(200).json({
      success: true,
      message: "Report and associated records successfully purged.",
    });
  } catch (err) {
    console.error("Error in deleteReport:", err);
    return res.status(500).json({ success: false, message: "Server error purging report." });
  }
};

/**
 * Renders global aggregations for the core systems dashboard using MongoDB Pipelines.
 */
exports.getDashboardStats = async (req, res) => {
  try {
    // Pipeline to aggregate basic stats efficiently
    const statsPipeline = await CrawlReport.aggregate([
      { $match: { status: "completed" } },
      {
        $group: {
          _id: null,
          totalWebsitesScanned: { $sum: 1 },
          avgRisk: { $avg: "$scores.risk" },
          avgSeo: { $avg: "$scores.seo" },
          avgSecurity: { $avg: "$scores.security" },
          avgCompliance: { $avg: "$scores.compliance" },
          highSeverity: {
            $sum: { $cond: [{ $eq: ["$riskSeverity", "HIGH"] }, 1, 0] }
          },
          mediumSeverity: {
            $sum: { $cond: [{ $eq: ["$riskSeverity", "MEDIUM"] }, 1, 0] }
          },
          lowSeverity: {
            $sum: { $cond: [{ $eq: ["$riskSeverity", "LOW"] }, 1, 0] }
          },
          highlyCompliantCount: {
            $sum: { $cond: [{ $gte: ["$scores.compliance", 70] }, 1, 0] }
          }
        }
      }
    ]);

    if (!statsPipeline || statsPipeline.length === 0) {
      return res.status(200).json({
        success: true,
        stats: {
          totalWebsitesScanned: 0,
          averageScores: { risk: 0, seo: 0, security: 0, compliance: 0 },
          severityBreakdown: { LOW: 0, MEDIUM: 0, HIGH: 0 },
          topIssues: [],
          complianceRate: 0,
        },
      });
    }

    const aggregated = statsPipeline[0];
    const totalCount = aggregated.totalWebsitesScanned;
    
    // Pipeline to extract top vulnerabilities across all completed reports
    // Unwinds issues and groups by title
    const issuesPipeline = await CrawlReport.aggregate([
      { $match: { status: "completed" } },
      { $unwind: "$issues" },
      { 
        $match: { 
          "issues.title": { $not: /KYC|AML/i } // Filter out KYC/AML 
        } 
      },
      {
        $group: {
          _id: "$issues.title",
          category: { $first: "$issues.category" },
          severity: { $first: "$issues.severity" },
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 5 },
      {
        $project: {
          _id: 0,
          title: "$_id",
          category: 1,
          severity: 1,
          count: 1
        }
      }
    ]);

    return res.status(200).json({
      success: true,
      stats: {
        totalWebsitesScanned: totalCount,
        averageScores: {
          risk: Math.round(aggregated.avgRisk || 0),
          seo: Math.round(aggregated.avgSeo || 0),
          security: Math.round(aggregated.avgSecurity || 0),
          compliance: Math.round(aggregated.avgCompliance || 0),
        },
        severityBreakdown: {
          LOW: aggregated.lowSeverity || 0,
          MEDIUM: aggregated.mediumSeverity || 0,
          HIGH: aggregated.highSeverity || 0
        },
        topIssues: issuesPipeline,
        complianceRate: totalCount > 0 
          ? Math.round((aggregated.highlyCompliantCount / totalCount) * 100) 
          : 0,
      },
    });
  } catch (err) {
    console.error("Error in getDashboardStats:", err);
    return res.status(500).json({ success: false, message: "Server error querying dashboard stats." });
  }
};

/**
 * Retrieves form validation audit report for a specific crawl job.
 */
exports.getFormValidationReport = async (req, res) => {
  try {
    const { id } = req.params;
    const report = await CrawlReport.findById(id, {
      url: 1,
      status: 1,
      formValidationSummary: 1,
      createdAt: 1,
    }).lean();

    if (!report) {
      return res.status(404).json({ success: false, message: "Report not found." });
    }

    const pagesWithForms = await CrawlPage.find(
      { reportId: id, "forms.0": { $exists: true } },
      { url: 1, title: 1, forms: 1, depth: 1 }
    ).lean();

    return res.status(200).json({
      success: true,
      reportId: id,
      url: report.url,
      status: report.status,
      formValidationSummary: report.formValidationSummary || {
        totalForms: 0,
        totalFieldsTested: 0,
        totalTestsRun: 0,
        overallStatus: "NOT_TESTED",
        forms: [],
        reportRows: [],
      },
      pagesWithForms,
    });
  } catch (err) {
    console.error("Error in getFormValidationReport:", err);
    return res.status(500).json({ success: false, message: "Server error fetching form validation report." });
  }
};

