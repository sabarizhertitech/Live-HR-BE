"use strict";

const { CrawlReport, CrawlPage } = require("../../Models/CrawlReport");
const { analyzeSSL }                        = require("../analyzers/sslAnalyzer");
const { checkBrokenLinks }                  = require("../analyzers/brokenLinkChecker");
const { buildTechnologySummary, aggregateReportTechnologies } = require("../analyzers/techDetector");
const { analyzePageSEO, aggregateReportSEO }                  = require("../analyzers/seoAnalyzer");
const { analyzePageSecurity, aggregateReportSecurity }        = require("../analyzers/securityAnalyzer");
const { auditPoliciesAndComplianceFull }                      = require("../analyzers/policyAnalyzer");
const { evaluateRiskProfile }                                 = require("../analyzers/riskEngine");
const { analyzeInfrastructure }                               = require("../analyzers/infrastructureAnalyzer");
const { aggregateReportFormValidations }                      = require("../analyzers/formValidator");

// Free / Public Generic Email Providers
const FREE_EMAIL_PROVIDERS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.in",
  "yahoo.co.uk",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "aol.com",
  "icloud.com",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "protonmail.com",
  "proton.me",
  "rediffmail.com",
  "gmx.com",
]);

function isFreeEmailProvider(email = "") {
  if (!email || typeof email !== "string") return false;
  const parts = email.trim().toLowerCase().split("@");
  if (parts.length !== 2) return false;
  return FREE_EMAIL_PROVIDERS.has(parts[1]);
}

// ============================================================================
// LOGGING HELPER
// ============================================================================

async function writeLog(jobId, message, level = "info", stage = "report") {
  const prefix = `[ReportGenerator][${stage.toUpperCase()}][${level.toUpperCase()}]`;
  if (level === "error" || level === "warn") {
    console.error(`${prefix} ${message}`);
  } else {
    console.log(`${prefix} ${message}`);
  }

  if (jobId) {
    const jobKey = jobId.toString();
    if (!global.crawlJobLogs) {
      global.crawlJobLogs = new Map();
    }
    if (!global.crawlJobLogs.has(jobKey)) {
      global.crawlJobLogs.set(jobKey, []);
    }
    global.crawlJobLogs.get(jobKey).push({
      message: `${prefix} ${message}`,
      level,
      timestamp: new Date()
    });
  }
}

// ============================================================================
// SAFE ANALYZER WRAPPER
// ============================================================================

/**
 * Wraps an async analyzer call with fault isolation.
 * Returns { result } on success, { error } on failure — never throws.
 */
async function safeRun(label, fn) {
  try {
    const result = await fn();
    return { ok: true, result };
  } catch (err) {
    console.error(`[Analyzer][${label}] FAILED: ${err.message}`);
    return { ok: false, error: err.message, result: null };
  }
}

function buildOperationalSummary(pages) {
  let totalApiCalls    = 0;
  let totalJsErrors    = 0;
  let totalCookies     = 0;
  let totalLoadTime    = 0;
  let totalPageWeight  = 0;
  let pagesWithMetrics = 0;
  const apiEndpoints   = new Set();

  for (const page of pages) {
    const apis    = page.apiCalls    || [];
    const errors  = page.jsErrors    || [];
    const cookies = page.cookies     || [];
    const perf    = page.performanceMetrics || {};

    totalApiCalls   += apis.length;
    totalJsErrors   += errors.length;
    totalCookies    += cookies.length;

    apis.forEach(a => { if (a.url) apiEndpoints.add(a.url); });

    if (perf.loadTime && perf.loadTime > 0) {
      totalLoadTime   += perf.loadTime;
      totalPageWeight += perf.pageWeightBytes || 0;
      pagesWithMetrics++;
    }
  }

  return {
    totalApiCalls,
    totalJsErrors,
    totalCookies,
    avgLoadTimeMs:       pagesWithMetrics > 0 ? Math.round(totalLoadTime / pagesWithMetrics) : 0,
    avgPageWeightBytes:  pagesWithMetrics > 0 ? Math.round(totalPageWeight / pagesWithMetrics) : 0,
    totalBrokenRequests: pages.reduce((acc, p) => acc + ((p.performanceMetrics || {}).failedRequests || 0), 0),
    uniqueApiEndpoints:  [...apiEndpoints].slice(0, 20),
  };
}

// ============================================================================
// COMPLIANCE SUMMARY BUILDER
// ============================================================================

function buildComplianceSummaryObject(complianceReport, pages = []) {
  const ip  = complianceReport.identifiedPages   || {};
  const ent = complianceReport.extractedEntities || {};

  // Global Page-level Aggregation
  const rawAddressCandidates = [
    ...(ent.addresses || []),
    ...pages.flatMap(p => p.addresses || [])
  ].filter(Boolean);

  const globalAddressMap = new Map();
  for (const rawAddr of rawAddressCandidates) {
    const addr = String(rawAddr).replace(/\s+/g, " ").trim();
    const lowerAddr = addr.toLowerCase();

if (
  lowerAddr.includes('"title"') ||
  lowerAddr.includes('"id"') ||
  lowerAddr.includes('"io"') ||
  lowerAddr.includes('"bb"') ||
  lowerAddr.includes('"a":[') ||
  lowerAddr.includes('},{"a"') ||
  lowerAddr.includes('googleusercontent') ||
  lowerAddr.includes('place_id') ||
  lowerAddr.includes('viewport') ||
  lowerAddr.includes('coimbatore institute of technology') ||
  lowerAddr.includes('lulu hypermarket')
) {
  continue;
}
    const normalizedAddr = addr
      .replace(/^.*?(?:pvt\.?\s*ltd\.?|private\s+limited|limited|llp),?\s*/i, "")
      .trim();
    const pincodeMatch = normalizedAddr.match(/\b(\d{3}\s?\d{3})\b/);
    if (!pincodeMatch) continue;
    const key = pincodeMatch[1].replace(/\s+/g, "");
    if (!globalAddressMap.has(key)) {
      globalAddressMap.set(key, addr);
    } else {
      const existing = globalAddressMap.get(key);
      const currentHasCompany  = /\b(?:pvt|private|limited|ltd|llp)\b/i.test(addr);
      const existingHasCompany = /\b(?:pvt|private|limited|ltd|llp)\b/i.test(existing);
      if (currentHasCompany && !existingHasCompany) {
        globalAddressMap.set(key, addr);
      } else if (currentHasCompany === existingHasCompany && addr.length > existing.length) {
        globalAddressMap.set(key, addr);
      }
    }
  }
  const globalAddresses = [...globalAddressMap.values()];

  const globalCopyrights = [...new Set(
    pages.flatMap(p => p.copyrights || [])
  )].filter(Boolean);

  const globalCompanyNames = [...new Set([
    ...(ent.companyNames || []),
    ...pages.flatMap(p => p.companyNames || [])
  ])].filter(Boolean);

  const globalGstin = [...new Set([
    ...(ent.gstin || []),
    ...pages.flatMap(p => p.gstin || [])
  ])].filter(Boolean);

  const globalCin = [...new Set([
    ...(ent.cin || []),
    ...pages.flatMap(p => p.cin || [])
  ])].filter(Boolean);

  // Detect About Us page or in-page section across all scanned pages
  let hasAboutUs = false;
  let aboutUsUrl = null;

  for (const p of pages) {
    const u = (p.url || "").toLowerCase();
    const title = (p.title || "").toLowerCase();
    const metaDesc = (p.metaDescription || "").toLowerCase();
    const headings = (p.headings || []).map(h => (h.text || "").toLowerCase());
    const links = p.links || [];
    const rawText = (p.rawText || "").toLowerCase();

    // 1. Dedicated URL slug or pageType
    if (p.pageType === "about" || /about|about-us|aboutus|who-we-are|our-story|our-team|our-company/i.test(u)) {
      hasAboutUs = true;
      aboutUsUrl = p.url;
      break;
    }

    // 2. Title or Meta description matching About Us
    if (/about\s*(us|the\s*company|our\s*company|me)?|who\s*we\s*are|our\s*story/i.test(title) || /about\s*(us|the\s*company|our\s*company|me)?|who\s*we\s*are|our\s*story/i.test(metaDesc)) {
      hasAboutUs = true;
      aboutUsUrl = p.url;
      break;
    }

    // 3. Headings on the page (e.g. <h2>About Us</h2> on homepage)
    if (headings.some(h => /about\s*(us|the\s*company|our\s*company|me)?|who\s*we\s*are|our\s*story|our\s*mission/i.test(h))) {
      hasAboutUs = true;
      aboutUsUrl = p.url;
      break;
    }

    // 4. In-page anchor links (e.g. <a href="#about">About Us</a>)
    if (links.some(l => /about\s*(us)?|who\s*we\s*are|our\s*story/i.test(l.text || "") || /#about/i.test(l.url || ""))) {
      hasAboutUs = true;
      aboutUsUrl = p.url;
      break;
    }

    // 5. Body text check
    if (
      /\babout\s+(us|the\s+company|our\s+company|our\s+team|our\s+mission|me)\b/i.test(rawText) ||
      /\bwho\s+we\s+are\b/i.test(rawText) ||
      /\bour\s+story\b/i.test(rawText)
    ) {
      hasAboutUs = true;
      aboutUsUrl = p.url;
      break;
    }
  }

  return {
    hasPrivacyPolicy:          ip.privacy?.found           || false,
    hasTermsOfService:         ip.terms?.found             || false,
    hasRefundPolicy:           ip.refund?.found            || false,
    hasAboutUs:                hasAboutUs,
    aboutUsUrl:                aboutUsUrl,
    completenessPercent:       complianceReport.scoreBreakdown?.policyPresence || 0,
    policyUrls: {
      privacy: ip.privacy?.url || null,
      terms:   ip.terms?.url   || null,
      refund:  ip.refund?.url  || null,
      about:   aboutUsUrl,
    },
    extractedEntities: {
      companyNames:     globalCompanyNames,
      addresses:        globalAddresses,
      copyrights:       globalCopyrights,
      gstin:            globalGstin,
      cin:              globalCin,
      grievanceOfficer: ent.grievanceOfficer || null,
      supportEmails:    ent.supportEmails    || [],
      refundTimeline:   ent.refundTimeline   || null,
    },
    addresses: globalAddresses,
    companyNames: globalCompanyNames,
    copyrights: globalCopyrights,
    gstin: globalGstin,
    cin: globalCin,
  };
}

// ============================================================================
// EXECUTIVE SUMMARY GENERATOR
// ============================================================================

function generateExecutiveSummary({
  url,
  riskReport,
  sslReport,
  technologySummary,
  complianceReport,
  infraReport,
  totalPages,
  brokenCount,
  formValidationSummary,
}) {
  const domain     = (() => { try { return new URL(url).hostname; } catch { return url; } })();
  const riskLevel  = riskReport.severity || "UNKNOWN";
  const sslStatus  = sslReport && sslReport.isValid ? "valid TLS/SSL" : "no valid TLS/SSL certificate";
  const frameworks = [...(technologySummary.frontendFrameworks || []), ...(technologySummary.backendFrameworks || [])].slice(0, 3).join(", ") || "undetected";
  const hosting    = infraReport?.hostingProvider || "Unknown";
  const cdn        = infraReport?.cdnProvider !== "Unknown" ? infraReport.cdnProvider : null;
  const hasPrivacy = complianceReport?.identifiedPages?.privacy?.found ? "a Privacy Policy" : "no Privacy Policy";
  const hasTerms   = complianceReport?.identifiedPages?.terms?.found   ? "Terms & Conditions" : "no Terms & Conditions";
  const hasRefund  = complianceReport?.identifiedPages?.refund?.found  ? "a Refund Policy"   : "no Refund Policy";
  const compScore  = complianceReport?.score ?? 0;

  const lines = [
    `${domain} was scanned across ${totalPages} page(s) and assessed a ${riskLevel} overall risk profile with a compliance score of ${compScore}/100.`,
    `The site operates on ${sslStatus} and is hosted on ${hosting}${cdn ? ` behind ${cdn} CDN` : ""}.`,
    `Detected technology stack includes: ${frameworks}.`,
    `Policy audit found ${hasPrivacy}, ${hasTerms}, and ${hasRefund}.`,
  ];

  if (brokenCount > 0) {
    lines.push(`${brokenCount} broken link(s) detected, which may impact user experience and SEO rankings.`);
  }
  if (formValidationSummary && formValidationSummary.totalForms > 0) {
    lines.push(`Form validation testing evaluated ${formValidationSummary.totalForms} form(s) across ${formValidationSummary.totalFieldsTested} field(s) with ${formValidationSummary.totalTestsRun} automated test cases (Passed forms: ${formValidationSummary.formsPassed}, Failed forms: ${formValidationSummary.formsFailed}, Overall: ${formValidationSummary.overallStatus}).`);
  }
  if (riskLevel === "HIGH") {
    lines.push(`CRITICAL: This site presents significant security or compliance risks that require immediate remediation.`);
  } else if (riskLevel === "MEDIUM") {
    lines.push(`Several compliance and/or security gaps were identified that should be addressed to meet regulatory standards.`);
  } else {
    lines.push(`The site demonstrates a generally healthy security posture. Minor improvements are recommended.`);
  }

  return lines.join(" ");
}

// ============================================================================
// ISSUE DEDUPLICATION
// ============================================================================

function deduplicateIssues(issues) {
  const seen = new Map();
  for (const issue of issues) {
    const key = `${issue.category}::${issue.title}`;
    if (!seen.has(key)) {
      seen.set(key, { ...issue, affectedUrls: [...(issue.affectedUrls || [])] });
    } else {
      const existing = seen.get(key);
      for (const url of (issue.affectedUrls || [])) {
        if (!existing.affectedUrls.includes(url)) {
          existing.affectedUrls.push(url);
        }
      }
    }
  }
  return Array.from(seen.values());
}

// ============================================================================
// MAIN AGGREGATION PIPELINE
// ============================================================================

async function generateAggregatedReport(jobId, seedUrl) {
  try {
    const pages = await CrawlPage.find({ reportId: jobId }).lean();

    if (!pages || pages.length === 0) {
      throw new Error("No crawled pages found in the database. Crawl may have failed or returned no content.");
    }

    const [sslResult, infraResult] = await Promise.all([
      safeRun("SSL",            () => analyzeSSL(seedUrl)),
      safeRun("Infrastructure", () => analyzeInfrastructure(seedUrl)),
    ]);

    const sslReport   = sslResult.ok   ? sslResult.result   : { isValid: false, error: sslResult.error, issuer: "", validFrom: null, validTo: null, daysRemaining: 0 };
    const infraReport = infraResult.ok ? infraResult.result : { hostname: "", ipAddress: "", hostingProvider: "Unknown", deploymentPlatform: "Unknown", cdnProvider: "Unknown", dnsProvider: "Unknown", cloudProvider: "Unknown", country: "" };

    const pageSEOAudits      = pages.map(page => analyzePageSEO(page));
    const pageSecurityAudits = pages.map(page => analyzePageSecurity(page));
    const aggregatedSEO      = aggregateReportSEO(pageSEOAudits);
    const aggregatedSecurity = aggregateReportSecurity(pageSecurityAudits);

    await Promise.allSettled(
      pages.map(async (page, idx) => {
        await CrawlPage.findByIdAndUpdate(page._id, {
          seoScore:      pageSEOAudits[idx].score,
          securityIssues: pageSecurityAudits[idx].issues.map(i => i.message),
        });
      })
    );

    const complianceResult = await safeRun("Compliance", () => Promise.resolve(auditPoliciesAndComplianceFull(pages)));
    const complianceReport = complianceResult.ok ? complianceResult.result : {
      score: 0,
      status: { hasPrivacyPolicy: false, hasTermsOfService: false, hasRefundPolicy: false, completenessPercent: 0 },
      identifiedPages: { privacy: { found: false, url: null }, terms: { found: false, url: null }, refund: { found: false, url: null } },
      clauses: {},
      scoreBreakdown: {},
      extractedEntities: {},
      issues: [],
    };

    const uniqueLinks  = [...new Set(pages.flatMap(p => (p.links || []).map(l => l.url)))];
    const brokenLinksResult = await safeRun("BrokenLinks", () => checkBrokenLinks(uniqueLinks, 5));
    const brokenLinks  = brokenLinksResult.ok ? brokenLinksResult.result : [];
    const brokenCount  = brokenLinks.filter(l => l.isBroken).length;

    const technologySummary = buildTechnologySummary(pages);
    const technologiesList  = technologySummary.all || [];

    const riskReport = evaluateRiskProfile(
      pages,
      sslReport,
      complianceReport,
      brokenLinks,
      aggregatedSEO,
      aggregatedSecurity
    );

    const operationalSummary = buildOperationalSummary(pages);
    const complianceSummary = buildComplianceSummaryObject(complianceReport, pages);
    const formValidationReport = aggregateReportFormValidations(pages);

    const rawIssues = [
      ...riskReport.issues,
      ...aggregatedSEO.issues,
      ...aggregatedSecurity.issues,
      ...complianceReport.issues,
      ...formValidationReport.issues,
    ];

    if (!sslReport.isValid) {
      rawIssues.push({
        category:       "ssl",
        severity:       "HIGH",
        title:          "SSL Certificate Invalid or Missing",
        description:    sslReport.error || "The domain is not protected by a valid, trusted TLS certificate.",
        recommendation: "Configure a valid SSL certificate from a trusted CA (e.g. Let's Encrypt, DigiCert) and force all HTTP traffic to HTTPS.",
        affectedUrls:   [seedUrl],
      });
    } else if (sslReport.daysRemaining < 180) {
      rawIssues.push({
        category:       "ssl",
        severity:       sslReport.daysRemaining <= 30 ? "HIGH" : "MEDIUM",
        title:          `SSL Certificate Expiring Soon (${sslReport.daysRemaining} days remaining)`,
        description:    `The SSL certificate for ${seedUrl} is valid but has only ${sslReport.daysRemaining} days remaining (below 180 days). It will expire on ${sslReport.validTo ? new Date(sslReport.validTo).toLocaleDateString() : "soon"}.`,
        recommendation: "Renew your SSL/TLS certificate with your certificate authority before it expires to prevent browser security warnings and site downtime.",
        affectedUrls:   [seedUrl],
      });
    }

    brokenLinks
      .filter(l => l.isBroken)
      .forEach(link => {
        rawIssues.push({
          category:       "broken_link",
          severity:       "MEDIUM",
          title:          `Broken Link: HTTP ${link.statusCode}`,
          description:    `The URL '${link.url}' returned status ${link.statusCode} and is unreachable.`,
          recommendation: "Remove or update this broken hyperlink reference.",
          affectedUrls:   [link.url],
        });
      });

    if (!infraReport.hostingProvider || infraReport.hostingProvider === "Unknown") {
      rawIssues.push({
        category:       "infrastructure",
        severity:       "LOW",
        title:          "Hosting Provider Undetected",
        description:    "The hosting provider could not be determined from DNS or WHOIS records.",
        recommendation: "Ensure public WHOIS records are accurate and DNS is configured for the correct provider.",
        affectedUrls:   [],
      });
    }

    // ── Score Adjustments for Form Validation & Corporate Email ──
    const allFoundEmailsList = [...new Set(pages.flatMap(p => p.emails || []))];
    const genericFoundEmails = allFoundEmailsList.filter(e => isFreeEmailProvider(e));
    const hasCorporateDomainEmail = allFoundEmailsList.length > 0 && allFoundEmailsList.some(e => !isFreeEmailProvider(e));
    const isOnlyGenericPublicEmail = allFoundEmailsList.length > 0 && allFoundEmailsList.every(e => isFreeEmailProvider(e));

    let adjustedComplianceScore = complianceReport.score;

    // 1. Form Validation impact
    if (formValidationReport.summary.totalForms > 0) {
      if (formValidationReport.summary.overallStatus === "FAIL") {
        adjustedComplianceScore = Math.max(0, adjustedComplianceScore - 8);
      } else if (formValidationReport.summary.overallStatus === "PASS") {
        adjustedComplianceScore = Math.min(100, adjustedComplianceScore + 5);
      }
    }

    // 2. Corporate vs Generic Email impact
    if (isOnlyGenericPublicEmail) {
      adjustedComplianceScore = Math.max(0, adjustedComplianceScore - 6);
      rawIssues.push({
        category:       "compliance",
        severity:       "MEDIUM",
        title:          "Generic Public Email Used (@gmail.com / free provider)",
        description:    `The website provides generic email address(es) (${genericFoundEmails.join(", ")}) instead of an official company-branded corporate email domain (e.g. contact@yourdomain.com).`,
        recommendation: "Update your contact email to an official corporate domain email address to enhance business credibility and pass onboarding compliance checks.",
        affectedUrls:   [seedUrl],
      });
    } else if (hasCorporateDomainEmail) {
      adjustedComplianceScore = Math.min(100, adjustedComplianceScore + 4);
    }

    const allIssues = deduplicateIssues(rawIssues);

    const executiveSummary = generateExecutiveSummary({
      url: seedUrl,
      riskReport,
      sslReport,
      technologySummary,
      complianceReport,
      infraReport,
      totalPages: pages.length,
      brokenCount,
      formValidationSummary: formValidationReport.summary,
    });

const emailsFound = [
  ...new Set(
    pages.flatMap(p => p.emails || [])
  )
].length;

const phonesFound = [
  ...new Set(
    pages.flatMap(p =>
      (p.phones || []).map(ph =>
        typeof ph === "string" ? ph : ph.phone
      )
    )
  )
].length;

    const report = await CrawlReport.findById(jobId);
    if (!report) throw new Error("CrawlReport document was deleted before report generation completed.");

    report.status         = "completed";
    report.totalPagesScanned = pages.length;
    report.scores         = {
      risk:       riskReport.score,
      compliance: adjustedComplianceScore,
      seo:        aggregatedSEO.score,
      security:   aggregatedSecurity.score,
      infrastructure: 0,
      operational: 0
    };
    report.riskSeverity   = riskReport.severity || "LOW";
    report.executiveSummary = executiveSummary;
    report.issues         = allIssues;
    report.ssl            = sslReport;
    report.infrastructure = infraReport;
    report.technologySummary = technologySummary;
    report.technologies   = technologiesList;
    report.complianceSummary = complianceSummary;
    report.operationalSummary = operationalSummary;
    report.formValidationSummary = {
      ...formValidationReport.summary,
      forms: formValidationReport.forms,
      reportRows: formValidationReport.reportRows,
      fieldSummaries: formValidationReport.fieldSummaries || [],
    };

    await report.save();

    await writeLog(jobId, "Report generation completed successfully.", "info", "report");
    return true;
  } catch (error) {
    await writeLog(jobId, `Report generation failed: ${error.message}`, "error", "report");
    
    try {
      await CrawlReport.findByIdAndUpdate(jobId, {
        status: "failed",
        error: error.message,
      });
    } catch (e) {
      console.error(`Failed to update report status: ${e.message}`);
    }
    
    throw error;
  }
}

module.exports = {
  generateAggregatedReport,
};