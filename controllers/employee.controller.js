const EmployeeDetails = require("../Models/EmployeeDetails");
const Employee = require("../Models/Employee");
const CareerGap = require("../Models/CareerGap");
const { calculateEligibleCareerGaps, getCourseJoiningYear } = require("../utilities/careerGapCalculator");
const LeaveBalance = require("../Models/LeaveBalance");
const EditRequest = require("../Models/EditRequest");
const BirthdayWish = require("../Models/BirthdayWish");
const Notification = require("../Models/Notification");
const { notifyAdmins, sendPushNotification } = require("../utilities/notificationService");
const mongoose = require("mongoose");
const { uploadToS3 } = require("../utilities/s3Upload");
const generateSignedUrl = require("../utilities/s3SignedUrl");
const getCachedSignedUrl = require("../utilities/s3CachedUrl");
const {
  encrypt,
  decrypt,
  maskAadhaar,
  maskPAN,
  maskAccountNumber
} = require("../utilities/secureEncryption");
const { checkProfileRestriction } = require("../utils/profileRestriction");
const { expandAllowedFields } = require("../utilities/editFieldsHelper");


const uploadFileToS3 = async (file, empIdString) => {
  if (!file || !file.buffer) return null;
  const ext = file.originalname.split(".").pop();
  const key = `ProfileDocs/${empIdString}/${file.fieldname}.${ext}`;
  await uploadToS3(file.buffer, key, file.mimetype);
  return key;
};


const attachSignedUrls = async (dataObj) => {
  const fileFields = [
    "picture",
    "aadhaarFile",
    "panFile",
    "marksheet10",
    "marksheet12",
    "passbookFile",
    "degreeCertificate",
    "courseCertificate",
    "ugDegreeCertificate",
    "pgDegreeCertificate",
  ];

  for (const field of fileFields) {
    const key = dataObj[field];
    if (key && typeof key === "string" && key.trim() !== "") {
      try {
        const signedUrl = await getCachedSignedUrl(key);
        dataObj[`${field}Url`] = signedUrl;
      } catch (err) {
        console.error(`Signed URL error for ${field}`, err.message);
        dataObj[`${field}Url`] = null;
      }
    } else {
      dataObj[`${field}Url`] = null;
    }
  }

  /* courses certificate urls */
  if (Array.isArray(dataObj.courses)) {
    dataObj.courses = await Promise.all(
      dataObj.courses.map(async (course) => {
        if (course.certificate && typeof course.certificate === "string") {
          try {
            const url = await getCachedSignedUrl(course.certificate);
            return { ...course, certificateUrl: url };
          } catch {
            return { ...course, certificateUrl: null };
          }
        }
        return { ...course, certificateUrl: course.certificateUrl || null };
      })
    );
  }

  /* professionalCertifications certificate urls */
  if (Array.isArray(dataObj.professionalCertifications)) {
    dataObj.professionalCertifications = await Promise.all(
      dataObj.professionalCertifications.map(async (cert) => {
        const certObj = cert.toObject ? cert.toObject() : { ...cert };
        if (certObj.certificate && typeof certObj.certificate === "string") {
          try {
            const url = await getCachedSignedUrl(certObj.certificate);
            return { ...certObj, certificateUrl: url };
          } catch {
            return { ...certObj, certificateUrl: null };
          }
        }
        return { ...certObj, certificateUrl: certObj.certificateUrl || null };
      })
    );
  }

  /* increment documents signed urls */
  if (Array.isArray(dataObj.incrementDocuments)) {
    dataObj.incrementDocuments = await Promise.all(
      dataObj.incrementDocuments.map(async (doc) => {
        const docObj = doc.toObject ? doc.toObject() : { ...doc };
        if (docObj.incrementLetter?.fileKey) {
          try {
            docObj.incrementLetter.fileUrl = await getCachedSignedUrl(docObj.incrementLetter.fileKey);
          } catch {
            docObj.incrementLetter.fileUrl = null;
          }
        }
        if (docObj.performanceForm?.fileKey) {
          try {
            docObj.performanceForm.fileUrl = await getCachedSignedUrl(docObj.performanceForm.fileKey);
          } catch {
            docObj.performanceForm.fileUrl = null;
          }
        }
        return docObj;
      })
    );
  }

  return dataObj;
};


const CORE_FIELDS = [
  "name",
  "email",
  "phone",
  "department",
  "designation",
  "role",
  "status",
  "employmentStatus",
  "dateJoined",
];

const cleanDetails = (detailsObj) => {
  CORE_FIELDS.forEach((f) => delete detailsObj[f]);
  return detailsObj;
};


const calculateProfileCompletion = (data, employee = null) => {
  if (!data) return 0;

  // Extract active bank from bankHistory if root fields are not present
  const activeBank = Array.isArray(data.bankHistory) && data.bankHistory.length > 0
    ? data.bankHistory.find((h) => !h.toDate) || data.bankHistory[0]
    : null;

  const phone = data.phone || employee?.phone;
  const status = data.status || employee?.status || data.employmentStatus;

  // Check if degree/diploma certificate is uploaded in courses or root
  const hasCourseCertificate =
    (Array.isArray(data.courses) &&
      data.courses.some(
        (c) =>
          c &&
          ((typeof c.certificate === "string" && c.certificate.trim() !== "") ||
            (typeof c.certificateUrl === "string" && c.certificateUrl.trim() !== ""))
      )) ||
    (typeof data.degreeCertificate === "string" &&
      data.degreeCertificate.trim() !== "") ||
    (typeof data.degreeCertificateUrl === "string" &&
      data.degreeCertificateUrl.trim() !== "") ||
    (typeof data.courseCertificate === "string" &&
      data.courseCertificate.trim() !== "") ||
    (typeof data.courseCertificateUrl === "string" &&
      data.courseCertificateUrl.trim() !== "") ||
    (typeof data.ugDegreeCertificate === "string" &&
      data.ugDegreeCertificate.trim() !== "") ||
    (typeof data.ugDegreeCertificateUrl === "string" &&
      data.ugDegreeCertificateUrl.trim() !== "") ||
    (typeof data.pgDegreeCertificate === "string" &&
      data.pgDegreeCertificate.trim() !== "") ||
    (typeof data.pgDegreeCertificateUrl === "string" &&
      data.pgDegreeCertificateUrl.trim() !== "");

  const resolvedData = {
    ...data,
    phone,
    status,
    bankName: data.bankName || activeBank?.bankName,
    accountHolder: data.accountHolder || activeBank?.accountHolder,
    accountNumber: data.accountNumber || activeBank?.accountNumber,
    ifscCode: data.ifscCode || activeBank?.ifscCode,
    passbookFile: data.passbookFile || activeBank?.passbookFile,
    degreeCertificate: hasCourseCertificate ? "uploaded" : null,
  };

  const requiredFields = [
    { field: "dob", weight: 4 },
    { field: "gender", weight: 2 },
    { field: "phone", weight: 4 },
    { field: "emergencyContact", weight: 4 },
    { field: "bloodGroup", weight: 2 },
    { field: "address", weight: 4 },
    { field: "fatherName", weight: 4 },
    { field: "motherName", weight: 4 },
    { field: "fatherOccupation", weight: 3 },
    { field: "motherOccupation", weight: 3 },

    { field: "status", weight: 4 },
    { field: "experience", weight: 0 },
    { field: "salaryHistory", weight: 0 },

    { field: "school10", weight: 2 },
    { field: "marks10", weight: 2 },
    { field: "marksheet10", weight: 3 },

    { field: "courses", weight: 4 },
    { field: "degreeCertificate", weight: 4 },

    { field: "aadhaarNo", weight: 5 },
    { field: "panNo", weight: 5 },
    { field: "aadhaarFile", weight: 5 },
    { field: "panFile", weight: 5 },

    { field: "bankName", weight: 3 },
    { field: "accountHolder", weight: 2 },
    { field: "accountNumber", weight: 3 },
    { field: "ifscCode", weight: 5 },
    { field: "passbookFile", weight: 4 },
  ];

  if (
    resolvedData.educationPath === "12th" ||
    (!resolvedData.educationPath &&
      (resolvedData.school12 || resolvedData.marks12 || resolvedData.marksheet12))
  ) {
    requiredFields.push(
      { field: "school12", weight: 3 },
      { field: "marks12", weight: 3 },
      { field: "marksheet12", weight: 4 }
    );
  }

  if (resolvedData.hasCertifications === "yes") {
    requiredFields.push({ field: "professionalCertifications", weight: 3 });
  }

  let total = 0;
  let completed = 0;

  requiredFields.forEach(({ field, weight }) => {
    total += weight;
    const val = resolvedData[field];
    if (
      val !== null &&
      val !== undefined &&
      !(typeof val === "string" && val.trim() === "")
    ) {
      if (Array.isArray(val)) {
        const hasValidItem = val.some(
          (item) =>
            item &&
            typeof item === "object" &&
            Object.values(item).some(
              (v) => v !== null && v !== undefined && v !== ""
            )
        );
        if (hasValidItem) completed += weight;
      } else {
        completed += weight;
      }
    }
  });

  return total === 0 ? 0 : Math.min(100, Math.round((completed / total) * 100));
};


const updateEmployeeDetails = async (req, res) => {
  try {
    const employeeId = req.user._id;

    const employee = await Employee.findById(employeeId);
    if (!employee) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    let details = await EmployeeDetails.findOne({ empId: employeeId });
    const isFirstTime = employee.isProfileCompleted === false;

    /* ───────── PERMISSION CHECK ───────── */
    let allowedFields = null;
    let approvedRequest = null;
    const usedFields = [];

    if (!isFirstTime) {
      approvedRequest = await EditRequest.findOne({
        employeeId,
        status: "approved",
      }).sort({ actionAt: -1 });

      if (
        !approvedRequest ||
        !Array.isArray(approvedRequest.approvedFields) ||
        approvedRequest.approvedFields.length === 0
      ) {
        return res.status(403).json({
          success: false,
          message: "Profile locked. No active approved edit request found.",
        });
      }

      if (!approvedRequest.approvedFields.includes("ALL")) {
        allowedFields = new Set(expandAllowedFields(approvedRequest.approvedFields));
      }
    }

    /* ───────── INPUT & FILES ───────── */
    const input = { ...req.body };
    if (req.user.role !== "admin" && req.body.dateRelieved) {
      return res.status(403).json({
        success: false,
        message: "Only admin can update relieved date",
      });
    }

    if (
      req.body.status === "relieved" &&
      !req.body.dateRelieved
    ) {
      return res.status(400).json({
        success: false,
        message: "Relieved date is required when status is relieved",
      });
    }

    if (req.body.educationPath === "Diploma") {
      if (req.body.school12 || req.body.marks12) {
        return res.status(400).json({
          success: false,
          message: "Diploma students should not have 12th details"
        });
      }

      let parsedCourses = req.body.courses;
      if (typeof parsedCourses === "string") {
        try {
          parsedCourses = JSON.parse(parsedCourses);
        } catch {
          parsedCourses = [];
        }
      }
      const existingCourses = details ? details.courses : [];
      const checkCourses = Array.isArray(parsedCourses) && parsedCourses.length > 0 ? parsedCourses : existingCourses;
      const hasDiploma = Array.isArray(checkCourses) && checkCourses.some((c) => c && c.courseType === "Diploma");
      if (!hasDiploma) {
        return res.status(400).json({
          success: false,
          message: "Diploma details are required"
        });
      }
    }

    if (req.body.educationPath === "12th") {
      const school12 = req.body.school12 || (details ? details.school12 : null);
      const marks12 = req.body.marks12 || (details ? details.marks12 : null);

      if (!school12 || !marks12) {
        return res.status(400).json({
          success: false,
          message: "12th details required"
        });
      }
    }

    // ✅ FIX 1: Validate BEFORE saving
    if (input.aadhaarNo) {
      if (input.aadhaarNo.includes("X")) {
        delete input.aadhaarNo;
      } else if (!/^\d{12}$/.test(input.aadhaarNo)) {
        return res.status(400).json({
          success: false,
          message: "Invalid Aadhaar number (must be 12 digits)",
        });
      }
    }

    if (input.panNo) {
      if (input.panNo.includes("X")) {
        delete input.panNo;
      } else if (!/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(input.panNo)) {
        return res.status(400).json({
          success: false,
          message: "Invalid PAN format (ABCDE1234F)",
        });
      }
    }

    const files = {};
    if (Array.isArray(req.files)) {
      req.files.forEach((f) => {
        if (!files[f.fieldname]) files[f.fieldname] = [];
        files[f.fieldname].push(f);
      });
    }

    const updateData = {
      empId: employeeId,
      lastUpdatedAt: new Date(),
    };

    /* ───────── STRIP CORE FIELDS FROM INPUT (Single Source of Truth) ───────── */
    // Core fields belong to Employee collection only — never write to EmployeeDetails
    CORE_FIELDS.forEach((key) => delete input[key]);

    /* ───────── TEXT FIELDS ───────── */
    const textFields = [
      "dob", "gender", "emergencyContact", "bloodGroup", "address",
      "fatherName", "motherName", "fatherOccupation", "motherOccupation",
      "dateRelieved", "experience", "salary",
      "educationPath", "school10", "marks10", "school12", "marks12",
      "passedOutYear10", "passedOutYear12",
      "aadhaarNo", "panNo", "uanNo", "pfNo",
      "bankName", "accountHolder", "accountNumber", "ifscCode",
    ];

    textFields.forEach((field) => {
      if (input[field] !== undefined) {
        if (isFirstTime || allowedFields === null || allowedFields.has(field)) {

          const val = input[field];

          // 🔥 SECURE FIELDS
          if (["aadhaarNo", "panNo", "accountNumber"].includes(field)) {

            // ✅ skip empty values
            if (val === null || val === undefined || val === "") {
              updateData[field] = "";
            }

            // ✅ prevent double encryption (strict check)
            else if (
              typeof val === "string" &&
              val.split(":").length === 3 // iv:tag:data format
            ) {
              updateData[field] = val;
            }

            // ✅ encrypt fresh value (ONLY if not masked)
            else {
              const strVal = val.toString().trim();
              const isMasked = strVal.includes("XXXX") || strVal.includes("****");

              if (isMasked) {
                // If it's masked, it means it came from a masked UI field.
                // DO NOT overwrite the existing real value in the DB.
                console.log(`[SECURE] Skipping update for ${field} - received masked value: ${strVal}`);
              } else {
                updateData[field] = encrypt(strVal);
              }
            }

          } else {
            // 🔥 NORMAL FIELDS
            if (field === "salary") {
              updateData[field] = Number(val) || 0;
            } else {
              updateData[field] =
                typeof val === "string" ? val.trim() : val;
            }
          }

          usedFields.push(field);
        }
      }
    });

    /* ───────── BANK DETAILS TO HISTORY ───────── */
    const bankFields = ["bankName", "accountHolder", "accountNumber", "ifscCode", "branch"];
    const hasBankInput = bankFields.some(field => input[field] !== undefined);

    if (hasBankInput) {
      console.log(`[employee.controller] Processing profile bank details via history`);
      const bankName = input.bankName !== undefined ? input.bankName : (details ? details.bankName : "");
      const accountHolder = input.accountHolder !== undefined ? input.accountHolder : (details ? details.accountHolder : "");
      const accountNumber = input.accountNumber !== undefined ? input.accountNumber : (details ? details.accountNumber : "");
      const ifscCode = input.ifscCode !== undefined ? input.ifscCode : (details ? details.ifscCode : "");
      const branch = input.branch !== undefined ? input.branch : (details ? details.branch : "");

      let finalEncryptedAccountNumber;
      if (accountNumber && accountNumber.includes("X")) {
        const activeEntry = details && details.bankHistory ? details.bankHistory.find(h => !h.toDate) : null;
        finalEncryptedAccountNumber = activeEntry ? activeEntry.accountNumber : (details ? details.accountNumber : "");
      } else if (accountNumber) {
        const strVal = accountNumber.toString().trim();
        if (strVal.split(":").length === 3) {
          finalEncryptedAccountNumber = strVal; // already encrypted
        } else {
          finalEncryptedAccountNumber = encrypt(strVal);
        }
      }

      const hasExistingDetails = !!(details && (details.accountNumber || (details.bankHistory && details.bankHistory.length > 0)));

      if (hasExistingDetails) {
        details.bankHistory = details.bankHistory || [];
        const activeEntry = details.bankHistory.find(h => !h.toDate);
        if (activeEntry) {
          if (bankName !== undefined) activeEntry.bankName = (bankName || "").toString().trim();
          if (accountHolder !== undefined) activeEntry.accountHolder = (accountHolder || "").toString().trim();
          if (finalEncryptedAccountNumber !== undefined) activeEntry.accountNumber = finalEncryptedAccountNumber;
          if (ifscCode !== undefined) activeEntry.ifscCode = (ifscCode || "").toString().trim().toUpperCase();
          if (branch !== undefined) activeEntry.branch = (branch || "").toString().trim();
        } else if (details.accountNumber && details.bankHistory.length === 0) {
          // Legacy support: root fields exist but history is empty. Move them to history first.
          const legacyFromDate = details.lastBankUpdate || details.createdAt || new Date();
          const legacyEntry = {
            bankName: details.bankName,
            accountHolder: details.accountHolder,
            accountNumber: details.accountNumber,
            ifscCode: details.ifscCode,
            branch: details.branch,
            fromDate: legacyFromDate,
            toDate: null
          };
          details.bankHistory.push(legacyEntry);

          // Now update the active legacy entry with new info
          const entry = details.bankHistory[0];
          if (bankName !== undefined) entry.bankName = (bankName || "").toString().trim();
          if (accountHolder !== undefined) entry.accountHolder = (accountHolder || "").toString().trim();
          if (finalEncryptedAccountNumber !== undefined) entry.accountNumber = finalEncryptedAccountNumber;
          if (ifscCode !== undefined) entry.ifscCode = (ifscCode || "").toString().trim().toUpperCase();
          if (branch !== undefined) entry.branch = (branch || "").toString().trim();
        }
      } else {
        // First time bank setup
        const joiningDate = (employee && employee.dateJoined) || (details && details.dateJoined) || new Date();

        details = details || new EmployeeDetails({ empId: employeeId });
        details.bankHistory = details.bankHistory || [];
        details.bankHistory.push({
          bankName: (bankName || "").toString().trim(),
          accountHolder: (accountHolder || "").toString().trim(),
          accountNumber: finalEncryptedAccountNumber || "",
          ifscCode: (ifscCode || "").toString().trim().toUpperCase(),
          branch: (branch || "").toString().trim(),
          fromDate: joiningDate,
          toDate: null
        });
      }

      // Remove the bank root fields from updateData so they don't get written to root fields
      bankFields.forEach(field => {
        delete updateData[field];
        if (details) {
          details[field] = undefined;
        }
      });
    }


    /* ───────── ARRAY FIELDS ───────── */
    if (
      input.siblings &&
      (isFirstTime || allowedFields === null || allowedFields.has("siblings"))
    ) {
      try {
        updateData.siblings = JSON.parse(input.siblings);
      } catch {
        updateData.siblings = [];
      }
      usedFields.push("siblings");
    }

    if (
      input.previousExperiences &&
      (isFirstTime || allowedFields === null || allowedFields.has("previousExperiences"))
    ) {
      try {
        updateData.previousExperiences = JSON.parse(input.previousExperiences);
      } catch {
        updateData.previousExperiences = [];
      }
      usedFields.push("previousExperiences");
    }

    /* ───────── COURSES + CERTIFICATES ───────── */
    if (
      input.courses &&
      (isFirstTime || allowedFields === null || allowedFields.has("courses"))
    ) {
      let parsed = [];
      try {
        parsed = typeof input.courses === "string" ? JSON.parse(input.courses) : input.courses;
      } catch { }

      const existingCourses = Array.isArray(details?.courses) ? details.courses : [];

      updateData.courses = await Promise.all(
        parsed.map(async (course, idx) => {
          let certificateKey = null;
          const certFile =
            files[`course_${course.id}_certificate`]?.[0] ||
            files[`course_${course._id}_certificate`]?.[0] ||
            files[`course_${idx}_certificate`]?.[0];

          if (certFile?.buffer) {
            const ext = certFile.originalname.split(".").pop();
            let fileName = "";
            if (course.courseType === "UG") fileName = `collegeugfile.${ext}`;
            else if (course.courseType === "PG") fileName = `collegepgfile.${ext}`;
            else if (course.courseType === "Diploma") fileName = `diplomafile.${ext}`;
            else fileName = `course_${course.id || course._id || idx}_certificate.${ext}`;

            const key = `ProfileDocs/${employee.empId}/${fileName}`;
            await uploadToS3(certFile.buffer, key, certFile.mimetype);
            certificateKey = key;
          }

          let existingCert = null;
          if (!certificateKey && !course.certificate) {
            const match =
              existingCourses.find((ec) =>
                (ec._id && course._id && String(ec._id) === String(course._id)) ||
                (ec.id && course.id && String(ec.id) === String(course.id)) ||
                (ec.courseType && course.courseType && ec.courseType === course.courseType)
              ) || existingCourses[idx];
            if (match && match.certificate) {
              existingCert = match.certificate;
            }
          }

          let joiningYear = course.joiningYear || "";
          if (!joiningYear && course.passedOutYear) {
            const match = String(course.passedOutYear).trim().match(/^(\d{4})\s*-\s*(\d{4})$/);
            if (match) {
              joiningYear = match[1];
            }
          }

          return {
            ...course,
            joiningYear,
            certificate: certificateKey || (typeof course.certificate === "string" ? course.certificate : null) || existingCert || null,
          };
        })
      );

      usedFields.push("courses");
    }

    /* ───────── PROFESSIONAL CERTIFICATIONS ───────── */
    if (input.hasCertifications !== undefined) {
      updateData.hasCertifications = input.hasCertifications;
      usedFields.push("courses");
    }

    if (input.hasCertifications === "no") {
      delete updateData.professionalCertifications;
      if (details) {
        details.set("professionalCertifications", undefined);
      }
    } else if (input.professionalCertifications !== undefined) {
      let parsedCerts = [];
      try {
        parsedCerts =
          typeof input.professionalCertifications === "string"
            ? JSON.parse(input.professionalCertifications)
            : input.professionalCertifications;
      } catch {
        parsedCerts = [];
      }

      if (Array.isArray(parsedCerts) && parsedCerts.length > 0) {
        const existingCerts = Array.isArray(details?.professionalCertifications)
          ? details.professionalCertifications
          : [];

        updateData.professionalCertifications = await Promise.all(
          parsedCerts.map(async (cert, idx) => {
            let certKey = null;
            const certFile =
              files[`cert_${idx}_certificate`]?.[0] ||
              files[`cert_${cert.id}_certificate`]?.[0] ||
              files[`cert_${cert._id}_certificate`]?.[0];

            if (certFile?.buffer) {
              const ext = certFile.originalname.split(".").pop();
              const key = `ProfileDocs/${employee.empId}/cert_${idx}_${Date.now()}.${ext}`;
              await uploadToS3(certFile.buffer, key, certFile.mimetype);
              certKey = key;
            }

            const existingMatch =
              existingCerts.find(
                (ec) =>
                  (ec.id && cert.id && String(ec.id) === String(cert.id)) ||
                  (ec._id && cert._id && String(ec._id) === String(cert._id)) ||
                  (ec.courseName && cert.courseName && ec.courseName === cert.courseName)
              ) || existingCerts[idx];

            return {
              ...cert,
              certificate:
                certKey ||
                (typeof cert.certificate === "string" ? cert.certificate : null) ||
                existingMatch?.certificate ||
                null,
            };
          })
        );
        usedFields.push("courses");
      } else {
        // Do NOT store empty array in DB
        delete updateData.professionalCertifications;
        if (details) {
          details.set("professionalCertifications", undefined);
        }
      }
    }

    /* ───────── CAREER GAPS (Eligible Transitions Only) ───────── */
    const shouldCheckCareerGaps =
      input.careerGaps !== undefined ||
      input.passedOutYear10 !== undefined ||
      input.passedOutYear12 !== undefined ||
      input.educationPath !== undefined ||
      input.courses !== undefined;

    if (shouldCheckCareerGaps) {
      let parsedGaps = [];
      if (input.careerGaps) {
        try {
          parsedGaps = typeof input.careerGaps === "string" ? JSON.parse(input.careerGaps) : input.careerGaps;
        } catch {
          parsedGaps = [];
        }
      }
      if (!Array.isArray(parsedGaps) && parsedGaps && typeof parsedGaps === "object") {
        parsedGaps = [parsedGaps];
      }

      const p10 = updateData.passedOutYear10 !== undefined ? updateData.passedOutYear10 : (input.passedOutYear10 !== undefined ? input.passedOutYear10 : (details ? details.passedOutYear10 : ""));
      const p12 = updateData.passedOutYear12 !== undefined ? updateData.passedOutYear12 : (input.passedOutYear12 !== undefined ? input.passedOutYear12 : (details ? details.passedOutYear12 : ""));
      const currentEducationPath = updateData.educationPath !== undefined ? updateData.educationPath : (input.educationPath !== undefined ? input.educationPath : (details ? details.educationPath : ""));
      const currentCourses = updateData.courses || details?.courses || [];

      // Calculate genuine, positive gaps for eligible transitions only
      const eligibleGaps = calculateEligibleCareerGaps({
        passedOutYear10: p10,
        passedOutYear12: p12,
        educationPath: currentEducationPath,
        courses: currentCourses,
      });

      // Match reasons for eligible gaps
      const existingGaps = Array.isArray(details?.careerGaps) ? details.careerGaps : [];
      const validGaps = eligibleGaps
        .map((eg) => {
          const incoming = Array.isArray(parsedGaps)
            ? parsedGaps.find((g) => g && g.educationStage === eg.educationStage)
            : null;
          const existing = existingGaps.find((g) => g && g.educationStage === eg.educationStage);

          const reason = (
            incoming?.reason ||
            (Array.isArray(parsedGaps) && parsedGaps.length === 1 && eligibleGaps.length === 1 ? parsedGaps[0]?.reason : "") ||
            existing?.reason ||
            ""
          ).toString().trim();

          return {
            employeeId: employee._id,
            educationStage: eg.educationStage,
            passedOutYear10: eg.passedOutYear10 || "",
            expectedYear12: eg.expectedYear12 || "",
            actualYear12: eg.actualYear12 || "",
            passedOutYear12: eg.passedOutYear12 || "",
            expectedUGYear: eg.expectedUGYear || "",
            actualUGYear: eg.actualUGYear || "",
            expectedDiplomaYear: eg.expectedDiplomaYear || "",
            actualDiplomaYear: eg.actualDiplomaYear || "",
            gapDuration: eg.gapDuration,
            reason,
            createdAt: incoming?.createdAt || existing?.createdAt || new Date(),
          };
        })
        .filter((g) => g.gapDuration > 0 && g.reason.length > 0);

      // Set clean careerGaps on updateData - never null or empty objects
      updateData.careerGaps = validGaps;

      // Sync to CareerGap collection (remove outdated, insert valid)
      try {
        await CareerGap.deleteMany({ employeeId: employee._id });
        if (validGaps.length > 0) {
          await CareerGap.insertMany(validGaps.map(g => ({ ...g, empIdString: employee.empId, employeeId: employee._id })));
        }
      } catch (err) {
        console.error("Error syncing CareerGap collection:", err);
      }
      usedFields.push("careerGaps");
    }

    /* ───────── FILE FIELDS → S3 ───────── */
    const fileFields = [
      "picture",
      "aadhaarFile",
      "panFile",
      "marksheet10",
      "marksheet12",
      "passbookFile",
    ];

    for (const field of fileFields) {
      const file = files[field]?.[0];
      if (!file || !file.buffer) continue;
      const ext = file.originalname.split(".").pop();
      const key = `ProfileDocs/${employee.empId}/${field}.${ext}`;
      await uploadToS3(file.buffer, key, file.mimetype);
      updateData[field] = key;
      usedFields.push(field);
    }

    /* ───────── MERGE & SAVE ───────── */
    // Strip core fields from updateData one final time before merge (safety net)
    CORE_FIELDS.forEach((key) => delete updateData[key]);

    const existingDetails = details ? cleanDetails(details.toObject()) : {};
    const merged = {
      ...existingDetails,
      ...updateData,
    };
    if (
      input.hasCertifications === "no" ||
      (input.professionalCertifications !== undefined &&
        (!updateData.professionalCertifications || updateData.professionalCertifications.length === 0))
    ) {
      delete merged.professionalCertifications;
      if (details) {
        details.set("professionalCertifications", undefined);
      }
    }
    merged.profileCompletion = calculateProfileCompletion({
      ...merged,
      // Inject Employee fields for completion calculation without saving them
      phone: employee.phone,
      status: employee.status,
    }, employee);

    if (details) {
      Object.assign(details, merged);
      await details.save();
    } else {
      details = await EmployeeDetails.create(merged);
    }

    /* ───────── EMPLOYEE FLAGS ───────── */
    const empUpdate = { lastProfileUpdateAt: new Date() };

    // 🔥 ALWAYS SYNC STATUS (FIXED — moved outside isFirstTime)
    if (input.status) {
      if (Array.isArray(input.status)) {
        input.status = input.status[0];
      }

      const status = input.status.toLowerCase();

      if (status === "relieved") {
        const relievedDate = input.dateRelieved
          ? new Date(input.dateRelieved)
          : new Date();

        // 🔥 SINGLE UPDATE WITH CLEANUP
        await Employee.findByIdAndUpdate(employeeId, {
          $set: {
            status: "relieved",
            employmentStatus: "relieved",
            dateRelieved: relievedDate,
            workingStatus: false,
            lastProfileUpdateAt: new Date(),
          },
          $unset: {
            passwordHash: "",
            passwordHistory: "",
            passwordChangedAt: "",
            passwordExpiresAt: "",
            isFirstLogin: "",
            loginAttempts: "",
            lockUntil: "",
          }
        });

        return res.json({
          success: true,
          message: "Profile updated successfully",
          profileCompletion: merged.profileCompletion,
          data: details,
        });

      } else {
        // NORMAL FLOW
        empUpdate.status = status;
        empUpdate.employmentStatus = "active";
        empUpdate.dateRelieved = null;
      }
    }

    // Core fields are always sourced from req.body for Employee only (first-time setup)
    // They were already deleted from input above, so read directly from req.body
    if (isFirstTime) {
      empUpdate.name = req.body.name ?? employee.name;
      empUpdate.email = req.body.email ?? employee.email;
      empUpdate.phone = req.body.phone ?? employee.phone;
      empUpdate.department = req.body.department ?? employee.department;
      empUpdate.designation = req.body.designation ?? employee.designation;
      if (req.body.gender !== undefined) {
        const g = req.body.gender.toString().toLowerCase().trim();
        if (["male", "female", "other"].includes(g)) {
          empUpdate.gender = g;
        }
      }
    } else {
      if (allowedFields === null || allowedFields.has("gender")) {
        if (req.body.gender !== undefined) {
          const g = req.body.gender.toString().toLowerCase().trim();
          if (["male", "female", "other"].includes(g)) {
            empUpdate.gender = g;
          }
        }
      }
      if (allowedFields === null || allowedFields.has("phone")) {
        if (req.body.phone !== undefined) empUpdate.phone = req.body.phone;
      }
      if (allowedFields === null || allowedFields.has("department")) {
        if (req.body.department !== undefined) empUpdate.department = req.body.department;
      }
      if (allowedFields === null || allowedFields.has("designation")) {
        if (req.body.designation !== undefined) empUpdate.designation = req.body.designation;
      }
      if (allowedFields === null || allowedFields.has("name")) {
        if (req.body.name !== undefined) empUpdate.name = req.body.name;
      }
      if (allowedFields === null || allowedFields.has("email")) {
        if (req.body.email !== undefined) empUpdate.email = req.body.email;
      }
    }

    const wasRejected = details?.profileApprovalStatus === "rejected" || employee?.profileApprovalStatus === "rejected";
    const reached100 = merged.profileCompletion >= 100;
    const isApprovedAlready = details?.profileApprovalStatus === "approved" && employee?.isProfileCompleted === true;

    let responseMessage = "Profile updated successfully";

    // Filter out any updated fields from details.rejectedFields so they are not shown again
    if (Array.isArray(details.rejectedFields) && details.rejectedFields.length > 0) {
      const updatedKeys = new Set(Object.keys(input));
      if (req.files && Array.isArray(req.files)) {
        req.files.forEach((f) => {
          updatedKeys.add(f.fieldname);
          if (f.fieldname === "marksheet10") updatedKeys.add("certificate10");
          if (f.fieldname === "marksheet12") updatedKeys.add("certificate12");
          if (f.fieldname && f.fieldname.includes("course_")) {
            updatedKeys.add("degreeCertificate");
            updatedKeys.add("courses");
          }
        });
      }
      details.rejectedFields = details.rejectedFields.filter((rf) => !updatedKeys.has(rf));
    }

    if (!isApprovedAlready && (reached100 || wasRejected)) {
      details.profileApprovalStatus = "pending";
      details.submittedForApprovalAt = new Date();
      details.rejectionRemark = "";
      details.rejectedFields = [];
      await details.save();

      empUpdate.profileApprovalStatus = "pending";
      empUpdate.isProfileCompleted = false;

      const notifTitle = wasRejected
        ? "Profile Re-submitted for Review"
        : "Profile Completion Review Required";
      const notifMsg = wasRejected
        ? `${employee.name} (${employee.empId || ""}) has updated their documents and re-submitted their profile for review.`
        : `${employee.name} (${employee.empId || ""}) has completed their profile 100% and submitted it for review and approval.`;

      responseMessage = wasRejected
        ? "Profile re-submitted for Admin review and approval successfully!"
        : "Profile completed 100% and submitted for Admin review and approval!";

      try {
        await Notification.create({
          type: "PROFILE_COMPLETION_REQUEST",
          toAdmin: true,
          fromEmployee: employeeId,
          title: notifTitle,
          message: notifMsg,
          metadata: {
            empIdString: employee.empId,
            empName: employee.name,
            department: employee.department,
            designation: employee.designation,
            url: `/admin/employees/view/${employee.empId || employee._id}`,
            requestType: "profile-completion-review",
          },
        });

        await notifyAdmins(notifTitle, notifMsg, {
          type: "PROFILE_COMPLETION_REQUEST",
          url: `/admin/employees/view/${employee.empId || employee._id}`,
          empIdString: employee.empId || "",
        });
      } catch (notifErr) {
        console.error("Profile review notification error:", notifErr);
      }
    }

    await Employee.findByIdAndUpdate(employeeId, { $set: empUpdate });

    /* ───────── CONSUME EDIT REQUEST ───────── */
    if (!isFirstTime && approvedRequest) {
      await EditRequest.findByIdAndUpdate(approvedRequest._id, {
        status: "used",
        usedFields: [...new Set(usedFields)],
        actionAt: new Date(),
      });
    }

    return res.json({
      success: true,
      message: responseMessage,
      profileCompletion: merged.profileCompletion,
      profileApprovalStatus: details.profileApprovalStatus,
      data: details,
    });
  } catch (err) {
    console.error("updateEmployeeDetails error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const getEmployeeDetails = async (req, res) => {
  try {
    let details = await EmployeeDetails.findOne({ empId: req.user._id });

    if (!details) {
      details = await EmployeeDetails.create({
        empId: req.user._id,
        empIdString: req.user.empId || null,
      });
    }

    const employee = await Employee.findById(req.user._id);
    const calculatedCompletion = calculateProfileCompletion(details.toObject(), employee);
    if (details.profileCompletion !== calculatedCompletion) {
      details.profileCompletion = calculatedCompletion;
      await details.save();
    }
    const today = new Date();
    let isBirthdayToday = false;

    if (details.dob) {
      const dob = new Date(details.dob);

      isBirthdayToday =
        today.getDate() === dob.getDate() &&
        today.getMonth() === dob.getMonth();
    }

    const detailsObj = cleanDetails(details.toObject());

    let approvalStatus = details.profileApprovalStatus;
    if (!approvalStatus) {
      if (employee.isProfileCompleted === true) {
        approvalStatus = "approved";
      } else if (calculatedCompletion >= 100) {
        approvalStatus = "pending";
      } else {
        approvalStatus = null;
      }
    }

    let responseData = {
      ...detailsObj,
      // Employee is PRIMARY source — always wins over EmployeeDetails
      ...employee.toObject(),
      gender: details.gender || employee.gender || "male",
      profileApprovalStatus: approvalStatus,
      rejectionRemark: details.rejectionRemark || "",
      rejectedFields: details.rejectedFields || [],
      submittedForApprovalAt: details.submittedForApprovalAt || null,
      reviewedAt: details.reviewedAt || employee.profileRejectedAt || null,
      profileRejectedAt: employee.profileRejectedAt || details.reviewedAt || null,
      dob: details.dob ? new Date(details.dob) : null,
      isBirthdayToday,
      empId: employee.empId,
      picture: details.picture || employee.photo,
      isProfileCompleted: employee.isProfileCompleted !== false,
      dateRelieved: employee.dateRelieved,
    };

    // ✅ FIX 3: Decrypt → mask before sending (never sends encrypted or plain values)
    if (responseData.aadhaarNo) {
      try {
        const decrypted = decrypt(responseData.aadhaarNo);
        responseData.aadhaarNo = req.query?.unmask === "true" ? decrypted : maskAadhaar(decrypted);
      } catch {
        responseData.aadhaarNo = null;
      }
    }

    if (responseData.panNo) {
      try {
        const decrypted = decrypt(responseData.panNo);
        responseData.panNo = req.query?.unmask === "true" ? decrypted : maskPAN(decrypted);
      } catch {
        responseData.panNo = null;
      }
    }

    // 🔥 ACCOUNT NUMBER → DECRYPT ONLY (for edit page)
    if (responseData.accountNumber) {
      try {
        const decrypted = decrypt(responseData.accountNumber);

        // 🔥 IMPORTANT: check request source
        if (req.query?.type === "edit") {
          responseData.accountNumber = decrypted; // edit page
        } else {
          responseData.accountNumber = maskAccountNumber(decrypted); // view page
        }

      } catch (err) {
        console.error("Decrypt failed:", err.message);
        responseData.accountNumber = null;
      }
    }

    // 🔥 BANK HISTORY → DECRYPT & MASK
    if (responseData.bankHistory && Array.isArray(responseData.bankHistory)) {
      responseData.bankHistory = responseData.bankHistory.map((item) => {
        if (item.accountNumber) {
          try {
            const decrypted = decrypt(item.accountNumber);
            return {
              ...item,
              accountNumber: req.query?.type === "edit" ? decrypted : maskAccountNumber(decrypted),
            };
          } catch (err) {
            console.error("Bank history decrypt failed:", err.message);
            return { ...item, accountNumber: null };
          }
        }
        return item;
      });
    }

    // Populate root bank details from active bankHistory entry if available
    if (responseData.bankHistory && Array.isArray(responseData.bankHistory)) {
      const activeBank = responseData.bankHistory.find(h => !h.toDate) || responseData.bankHistory[0];
      if (activeBank) {
        if (!responseData.bankName) responseData.bankName = activeBank.bankName;
        if (!responseData.accountHolder) responseData.accountHolder = activeBank.accountHolder;
        if (!responseData.accountNumber) responseData.accountNumber = activeBank.accountNumber;
        if (!responseData.ifscCode) responseData.ifscCode = activeBank.ifscCode;
        if (!responseData.branch) responseData.branch = activeBank.branch;
      }
    }

    // Clean career gaps (ensure no empty/null records)
    if (!responseData.careerGaps || responseData.careerGaps.length === 0) {
      try {
        const foundGaps = await CareerGap.find({ employeeId: employee._id });
        if (foundGaps && foundGaps.length > 0) {
          responseData.careerGaps = foundGaps;
        }
      } catch (e) { }
    }
    if (Array.isArray(responseData.careerGaps)) {
      responseData.careerGaps = responseData.careerGaps.filter(
        (g) => g && (Number(g.gapDuration) > 0) && g.reason && g.reason.trim().length > 0
      );
    } else {
      responseData.careerGaps = [];
    }

    // ✅ Attach signed S3 URLs safely
    responseData = await attachSignedUrls(responseData);

    return res.json({ success: true, data: responseData });
  } catch (err) {
    console.error("getEmployeeDetails error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const getMyProfileWithSignedUrls = async (req, res) => {
  try {
    let details = await EmployeeDetails.findOne({ empId: req.user._id });

    if (!details) {
      details = await EmployeeDetails.create({
        empId: req.user._id,
        empIdString: req.user.empId || null,
      });
    }

    const employee = await Employee.findById(req.user._id);
    const calculatedCompletion = calculateProfileCompletion(details.toObject(), employee);
    if (details.profileCompletion !== calculatedCompletion) {
      details.profileCompletion = calculatedCompletion;
      await details.save();
    }

    let approvalStatus2 = details.profileApprovalStatus;
    if (!approvalStatus2) {
      if (employee.isProfileCompleted === true) {
        approvalStatus2 = "approved";
      } else if (calculatedCompletion >= 100) {
        approvalStatus2 = "pending";
      } else {
        approvalStatus2 = null;
      }
    }

    const detailsObj2 = cleanDetails(details.toObject());

    let responseData = {
      ...detailsObj2,
      profileCompletion: calculatedCompletion,
      // Employee is PRIMARY source — always wins over EmployeeDetails
      ...employee.toObject(),
      gender: details.gender || employee.gender || "male",
      profileApprovalStatus: approvalStatus2,
      rejectionRemark: details.rejectionRemark || "",
      rejectedFields: details.rejectedFields || [],
      submittedForApprovalAt: details.submittedForApprovalAt || null,
      reviewedAt: details.reviewedAt || employee.profileRejectedAt || null,
      profileRejectedAt: employee.profileRejectedAt || details.reviewedAt || null,
      empId: employee.empId,
      empIdString: employee.empId,
      picture: details.picture || employee.photo,
      isProfileCompleted: employee.isProfileCompleted !== false,
      dateRelieved: employee.dateRelieved,
    };

    // 🔥 EDIT PAGE → DECRYPT AND MASK BY DEFAULT (User can unmask via eye icon)
    if (responseData.aadhaarNo) {
      try {
        const decrypted = decrypt(responseData.aadhaarNo);
        responseData.aadhaarNo = req.query?.unmask === "true" ? decrypted : maskAadhaar(decrypted);
      } catch {
        responseData.aadhaarNo = null;
      }
    }

    if (responseData.panNo) {
      try {
        const decrypted = decrypt(responseData.panNo);
        responseData.panNo = req.query?.unmask === "true" ? decrypted : maskPAN(decrypted);
      } catch {
        responseData.panNo = null;
      }
    }

    if (responseData.accountNumber) {
      try {
        responseData.accountNumber = decrypt(responseData.accountNumber);
      } catch {
        responseData.accountNumber = null;
      }
    }

    // 🔥 BANK HISTORY → DECRYPT BUT DO NOT MASK
    if (responseData.bankHistory && Array.isArray(responseData.bankHistory)) {
      responseData.bankHistory = responseData.bankHistory.map((item) => {
        if (item.accountNumber) {
          try {
            return {
              ...item,
              accountNumber: decrypt(item.accountNumber),
            };
          } catch {
            return { ...item, accountNumber: null };
          }
        }
        return item;
      });
    }

    // Populate root bank details from active bankHistory entry if available
    if (responseData.bankHistory && Array.isArray(responseData.bankHistory)) {
      const activeBank = responseData.bankHistory.find(h => !h.toDate) || responseData.bankHistory[0];
      if (activeBank) {
        if (!responseData.bankName) responseData.bankName = activeBank.bankName;
        if (!responseData.accountHolder) responseData.accountHolder = activeBank.accountHolder;
        if (!responseData.accountNumber) responseData.accountNumber = activeBank.accountNumber;
        if (!responseData.ifscCode) responseData.ifscCode = activeBank.ifscCode;
        if (!responseData.branch) responseData.branch = activeBank.branch;
      }
    }

    // ✅ Attach signed S3 URLs safely
    responseData = await attachSignedUrls(responseData);

    return res.json({ success: true, data: responseData });
  } catch (err) {
    console.error("getMyProfileWithSignedUrls error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const adminUpdateEmployee = async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const empIdString = req.params.empId;

    let employee = null;
    if (mongoose.Types.ObjectId.isValid(empIdString)) {
      employee = await Employee.findOne({
        $or: [{ empId: empIdString }, { _id: empIdString }],
      });
    } else {
      employee = await Employee.findOne({ empId: empIdString });
    }

    if (!employee) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    let details = await EmployeeDetails.findOne({ empId: employee._id });
    if (!details) {
      details = await EmployeeDetails.create({
        empId: employee._id,
        empIdString: employee.empId,
      });
    }

    const update = { ...req.body };

    if (req.user.role !== "admin" && req.body.dateRelieved) {
      return res.status(403).json({
        success: false,
        message: "Only admin can update relieved date",
      });
    }

    if (
      req.body.status === "relieved" &&
      !req.body.dateRelieved
    ) {
      return res.status(400).json({
        success: false,
        message: "Relieved date is required when status is relieved",
      });
    }

    if (req.body.educationPath === "Diploma") {
      if (req.body.school12 || req.body.marks12) {
        return res.status(400).json({
          success: false,
          message: "Diploma students should not have 12th details"
        });
      }

      let parsedCourses = req.body.courses;
      if (typeof parsedCourses === "string") {
        try {
          parsedCourses = JSON.parse(parsedCourses);
        } catch {
          parsedCourses = [];
        }
      }
      const existingCourses = details ? details.courses : [];
      const checkCourses = Array.isArray(parsedCourses) && parsedCourses.length > 0 ? parsedCourses : existingCourses;
      const hasDiploma = Array.isArray(checkCourses) && checkCourses.some((c) => c && c.courseType === "Diploma");
      if (!hasDiploma) {
        return res.status(400).json({
          success: false,
          message: "Diploma details are required"
        });
      }
    }

    if (req.body.educationPath === "12th") {
      const school12 = req.body.school12 || (details ? details.school12 : null);
      const marks12 = req.body.marks12 || (details ? details.marks12 : null);

      if (!school12 || !marks12) {
        return res.status(400).json({
          success: false,
          message: "12th details required"
        });
      }
    }

    // ✅ FIX 4a: Validate Aadhaar & PAN BEFORE processing
    if (update.aadhaarNo) {
      if (update.aadhaarNo.includes("X")) {
        delete update.aadhaarNo;
      } else if (!/^\d{12}$/.test(update.aadhaarNo)) {
        return res.status(400).json({
          success: false,
          message: "Invalid Aadhaar number (must be 12 digits)",
        });
      }
    }

    if (update.panNo) {
      if (update.panNo.includes("X")) {
        delete update.panNo;
      } else if (!/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(update.panNo)) {
        return res.status(400).json({
          success: false,
          message: "Invalid PAN format (ABCDE1234F)",
        });
      }
    }

    // ✅ FIX 4b: Encrypt Aadhaar & PAN before saving (if not masked)
    if (update.aadhaarNo) {
      update.aadhaarNo = encrypt(update.aadhaarNo);
    }
    if (update.panNo) {
      update.panNo = encrypt(update.panNo);
    }

    if (update.accountNumber) {
      if (update.accountNumber.includes("X")) {
        delete update.accountNumber;
      } else {
        update.accountNumber = encrypt(update.accountNumber);
      }
    }

    /* ── Normalize status ── */
    // 🔥 AUTO SYNC status → employmentStatus
    if (update.status) {
      if (Array.isArray(update.status)) {
        update.status = update.status[0];
      }

      const status = update.status.toLowerCase();

      update.employmentStatus =
        status === "relieved" ? "relieved" : "active";

      if (status === "relieved") {
        update.dateRelieved = update.dateRelieved
          ? new Date(update.dateRelieved)
          : new Date();
      } else {
        update.dateRelieved = null;
      }
    }
    /* ── Safe JSON parsing ── */
    const jsonFields = ["siblings", "previousExperiences", "courses", "careerGaps", "professionalCertifications"];
    jsonFields.forEach((field) => {
      if (update[field] && typeof update[field] === "string") {
        try {
          update[field] = JSON.parse(update[field]);
        } catch {
          update[field] = [];
        }
      }
    });

    if (Array.isArray(update.professionalCertifications)) {
      if (update.professionalCertifications.length === 0) {
        delete update.professionalCertifications;
        if (details) details.professionalCertifications = undefined;
      }
    }

    if (Array.isArray(update.courses)) {
      update.courses = update.courses.map((c) => {
        let joiningYear = c.joiningYear || "";
        if (!joiningYear && c.passedOutYear) {
          const match = String(c.passedOutYear).trim().match(/^(\d{4})\s*-\s*(\d{4})$/);
          if (match) joiningYear = match[1];
        }
        return { ...c, joiningYear };
      });
    }

    /* ── Career Gaps handling in adminUpdateEmployee ── */
    const shouldCheckCareerGapsAdmin =
      update.careerGaps !== undefined ||
      update.passedOutYear10 !== undefined ||
      update.passedOutYear12 !== undefined ||
      update.educationPath !== undefined ||
      update.courses !== undefined;

    if (shouldCheckCareerGapsAdmin) {
      let parsedGaps = Array.isArray(update.careerGaps) ? update.careerGaps : [];
      const p10 = update.passedOutYear10 !== undefined ? update.passedOutYear10 : (details ? details.passedOutYear10 : "");
      const p12 = update.passedOutYear12 !== undefined ? update.passedOutYear12 : (details ? details.passedOutYear12 : "");
      const currentEducationPath = update.educationPath !== undefined ? update.educationPath : (details ? details.educationPath : "");
      const currentCourses = update.courses || details?.courses || [];

      // Calculate genuine, positive gaps for eligible transitions only
      const eligibleGaps = calculateEligibleCareerGaps({
        passedOutYear10: p10,
        passedOutYear12: p12,
        educationPath: currentEducationPath,
        courses: currentCourses,
      });

      const existingGaps = Array.isArray(details?.careerGaps) ? details.careerGaps : [];
      const validGaps = eligibleGaps
        .map((eg) => {
          const incoming = Array.isArray(parsedGaps)
            ? parsedGaps.find((g) => g && g.educationStage === eg.educationStage)
            : null;
          const existing = existingGaps.find((g) => g && g.educationStage === eg.educationStage);

          const reason = (
            incoming?.reason ||
            (Array.isArray(parsedGaps) && parsedGaps.length === 1 && eligibleGaps.length === 1 ? parsedGaps[0]?.reason : "") ||
            existing?.reason ||
            ""
          ).toString().trim();

          return {
            employeeId: employee._id,
            educationStage: eg.educationStage,
            passedOutYear10: eg.passedOutYear10 || "",
            expectedYear12: eg.expectedYear12 || "",
            actualYear12: eg.actualYear12 || "",
            passedOutYear12: eg.passedOutYear12 || "",
            expectedUGYear: eg.expectedUGYear || "",
            actualUGYear: eg.actualUGYear || "",
            expectedDiplomaYear: eg.expectedDiplomaYear || "",
            actualDiplomaYear: eg.actualDiplomaYear || "",
            gapDuration: eg.gapDuration,
            reason,
            createdAt: incoming?.createdAt || existing?.createdAt || new Date(),
          };
        })
        .filter((g) => g.gapDuration > 0 && g.reason.length > 0);

      update.careerGaps = validGaps;
      try {
        await CareerGap.deleteMany({ employeeId: employee._id });
        if (validGaps.length > 0) {
          await CareerGap.insertMany(validGaps.map(g => ({ ...g, empIdString: employee.empId, employeeId: employee._id })));
        }
      } catch (err) {
        console.error("Error syncing CareerGap in adminUpdateEmployee:", err);
      }
    }

    /* ── Fix numbers ── */
    if (update.salary !== undefined) {
      update.salary = Number(update.salary) || 0;
    }

    /* ── Handle files → S3 ── */
    const files = {};
    if (Array.isArray(req.files)) {
      req.files.forEach((f) => {
        if (!files[f.fieldname]) files[f.fieldname] = [];
        files[f.fieldname].push(f);
      });
    }

    // ✅ Track which fields admin actually changed
    const adminEditedFields = [];

    /* ── Courses handling in adminUpdateEmployee ── */
    if (update.courses && Array.isArray(update.courses)) {
      const existingCourses = Array.isArray(details?.courses) ? details.courses : [];
      update.courses = await Promise.all(
        update.courses.map(async (course, idx) => {
          let certificateKey = null;
          const certFile =
            files[`course_${course.id}_certificate`]?.[0] ||
            files[`course_${course._id}_certificate`]?.[0] ||
            files[`course_${idx}_certificate`]?.[0];

          if (certFile?.buffer) {
            const ext = certFile.originalname.split(".").pop();
            let fileName = "";
            if (course.courseType === "UG") fileName = `collegeugfile.${ext}`;
            else if (course.courseType === "PG") fileName = `collegepgfile.${ext}`;
            else if (course.courseType === "Diploma") fileName = `diplomafile.${ext}`;
            else fileName = `course_${course.id || course._id || idx}_certificate.${ext}`;

            const key = `ProfileDocs/${employee.empId}/${fileName}`;
            await uploadToS3(certFile.buffer, key, certFile.mimetype);
            certificateKey = key;
            adminEditedFields.push("courses");
          }

          let existingCert = null;
          if (!certificateKey && !course.certificate) {
            const match =
              existingCourses.find((ec) =>
                (ec._id && course._id && String(ec._id) === String(course._id)) ||
                (ec.id && course.id && String(ec.id) === String(course.id)) ||
                (ec.courseType && course.courseType && ec.courseType === course.courseType)
              ) || existingCourses[idx];
            if (match && match.certificate) {
              existingCert = match.certificate;
            }
          }

          return {
            ...course,
            certificate: certificateKey || (typeof course.certificate === "string" ? course.certificate : null) || existingCert || null,
          };
        })
      );
    }

    const fileFields = [
      "picture",
      "aadhaarFile",
      "panFile",
      "marksheet10",
      "marksheet12",
      "passbookFile",
    ];

    for (const field of fileFields) {
      const file = files[field]?.[0];
      if (file?.buffer) {
        update[field] = await uploadFileToS3(file, "documents");
        adminEditedFields.push(field);
      }
    }

    Object.keys(update).forEach((field) => {
      if (!adminEditedFields.includes(field)) {
        adminEditedFields.push(field);
      }
    });

    /* ── Sync Employee table ── */
    const syncFields = [
      "name", "email", "phone", "department",
      "designation", "salary", "status", "employmentStatus", "dateRelieved",
    ];

    const employeeUpdate = {};
    syncFields.forEach((field) => {
      if (update[field] !== undefined) {
        employeeUpdate[field] = update[field];
      }
    });

    if (update.gender !== undefined) {
      const g = update.gender.toString().toLowerCase().trim();
      if (["male", "female", "other"].includes(g)) {
        employeeUpdate.gender = g;
      }
    }

    if (update.status === "relieved" || update.employmentStatus === "relieved") {
      await Employee.findByIdAndUpdate(employee._id, {
        $set: {
          ...employeeUpdate,
          status: "relieved",
          employmentStatus: "relieved",
          workingStatus: false,
        },
        $unset: {
          photo: "",
          salary: "",
          passwordHash: "",
          passwordHistory: "",
          passwordChangedAt: "",
          passwordExpiresAt: "",
          isFirstLogin: "",
          loginAttempts: "",
          lockUntil: "",
          isProfileCompleted: "",
          profileCompletedAt: "",
          firstLoginAt: "",
          lastProfileUpdateAt: "",
          fcmTokens: "",
          allowedMenus: "",
          menuAccessRequests: "",
          leaveBalances: "",
        }
      }, { strict: false });
    } else {
      await Employee.findByIdAndUpdate(employee._id, {
        ...employeeUpdate,
        lastProfileUpdateAt: new Date(),
      });
    }

    /* ── Save EmployeeDetails ── */
    const targetEmploymentStatus = (employeeUpdate.status === "relieved" || employeeUpdate.employmentStatus === "relieved")
      ? "relieved"
      : (employeeUpdate.employmentStatus || details.employmentStatus);

    // Strip core fields from update before saving to EmployeeDetails (Single Source of Truth)
    CORE_FIELDS.forEach((key) => delete update[key]);

    Object.assign(details, update);
    if (targetEmploymentStatus) {
      details.employmentStatus = targetEmploymentStatus;
    }
    if (targetEmploymentStatus === "relieved") {
      await LeaveBalance.deleteMany({ employeeId: employee._id });
    }
    details.profileCompletion = calculateProfileCompletion({
      ...details.toObject(),
      // Inject Employee fields for calculation accuracy
      phone: employee.phone,
      status: req.body.status || employee.status,
    });
    await details.save();

    /* ── ✅ Record admin edit in EditRequest model ── */
    await EditRequest.create({
      employeeId: employee._id,
      requestMessage: `Admin direct edit by ${req.user.name || req.user.empId}`,
      requestedFields: adminEditedFields,
      approvedFields: adminEditedFields,
      usedFields: adminEditedFields,
      status: "used",
      actionBy: req.user._id,
      actionAt: new Date(),
      adminNote: "Direct admin update",
    });

    return res.json({
      success: true,
      message: "Employee updated successfully by admin",
    });
  } catch (err) {
    console.error("adminUpdateEmployee error:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Server error",
    });
  }
};

const getEmployeeByEmpIdString = async (req, res) => {
  try {
    const { empIdString } = req.params;

    // ✅ STEP 1: Get Employee FIRST (source of truth)
    let employee = null;
    if (mongoose.Types.ObjectId.isValid(empIdString)) {
      employee = await Employee.findById(empIdString);
    }
    if (!employee) {
      employee = await Employee.findOne({ empId: empIdString });
    }

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    // ✅ STEP 2: Get EmployeeDetails
    let details = await EmployeeDetails.findOne({ empId: employee._id });

    // ✅ STEP 3: Auto-create if missing
    if (!details) {
      details = await EmployeeDetails.create({
        empId: employee._id,
        empIdString: employee.empId,
      });
    }

    // ✅ STEP 4: Ensure profile completion
    const calculatedCompletion = calculateProfileCompletion(details.toObject(), employee);
    if (details.profileCompletion !== calculatedCompletion) {
      details.profileCompletion = calculatedCompletion;
      await details.save();
    }

    // ✅ STEP 5: Build response (Employee is PRIMARY source of truth)
    const detailsObj3 = cleanDetails(details.toObject());

    let approvalStatus3 = details.profileApprovalStatus;
    if (!approvalStatus3) {
      if (employee.isProfileCompleted === true) {
        approvalStatus3 = "approved";
      } else if (calculatedCompletion >= 100) {
        approvalStatus3 = "pending";
      } else {
        approvalStatus3 = null;
      }
    }

    let responseData = {
      ...detailsObj3,
      profileCompletion: calculatedCompletion,
      // Employee wins on all core fields
      ...employee.toObject(),
      gender: details.gender || employee.gender || "male",
      profileApprovalStatus: approvalStatus3,
      rejectionRemark: details.rejectionRemark || "",
      rejectedFields: details.rejectedFields || [],
      submittedForApprovalAt: details.submittedForApprovalAt || null,
      reviewedAt: details.reviewedAt || null,
      empIdString: employee.empId,
      dateRelieved: employee.dateRelieved,
    };

    // ✅ FIX 3: Decrypt → mask before sending
    if (responseData.aadhaarNo) {
      try {
        const decrypted = decrypt(responseData.aadhaarNo);
        responseData.aadhaarNo = req.query?.unmask === "true" ? decrypted : maskAadhaar(decrypted);
      } catch {
        responseData.aadhaarNo = null;
      }
    }

    if (responseData.panNo) {
      try {
        const decrypted = decrypt(responseData.panNo);
        responseData.panNo = req.query?.unmask === "true" ? decrypted : maskPAN(decrypted);
      } catch {
        responseData.panNo = null;
      }
    }

    if (responseData.accountNumber) {
      try {
        const decrypted = decrypt(responseData.accountNumber);
        responseData.accountNumber = maskAccountNumber(decrypted);
      } catch {
        responseData.accountNumber = null;
      }
    }

    // 🔥 BANK HISTORY → DECRYPT & MASK
    if (responseData.bankHistory && Array.isArray(responseData.bankHistory)) {
      responseData.bankHistory = responseData.bankHistory.map((item) => {
        if (item.accountNumber) {
          try {
            const decrypted = decrypt(item.accountNumber);
            return {
              ...item,
              accountNumber: maskAccountNumber(decrypted),
            };
          } catch {
            return { ...item, accountNumber: null };
          }
        }
        return item;
      });
    }

    // Populate root bank details from active bankHistory entry if available
    if (responseData.bankHistory && Array.isArray(responseData.bankHistory)) {
      const activeBank = responseData.bankHistory.find(h => !h.toDate) || responseData.bankHistory[0];
      if (activeBank) {
        if (!responseData.bankName) responseData.bankName = activeBank.bankName;
        if (!responseData.accountHolder) responseData.accountHolder = activeBank.accountHolder;
        if (!responseData.accountNumber) responseData.accountNumber = activeBank.accountNumber;
        if (!responseData.ifscCode) responseData.ifscCode = activeBank.ifscCode;
        if (!responseData.branch) responseData.branch = activeBank.branch;
      }
    }

    // Clean career gaps (ensure no empty/null records)
    if (!responseData.careerGaps || responseData.careerGaps.length === 0) {
      try {
        const foundGaps = await CareerGap.find({ employeeId: employee._id });
        if (foundGaps && foundGaps.length > 0) {
          responseData.careerGaps = foundGaps;
        }
      } catch (e) { }
    }
    if (Array.isArray(responseData.careerGaps)) {
      responseData.careerGaps = responseData.careerGaps.filter(
        (g) => g && (Number(g.gapDuration) > 0) && g.reason && g.reason.trim().length > 0
      );
    } else {
      responseData.careerGaps = [];
    }

    responseData = await attachSignedUrls(responseData);

    return res.json({
      success: true,
      data: responseData,
    });
  } catch (err) {
    console.error("getEmployeeByEmpIdString error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

/* =====================================================
   SEARCH EMPLOYEES
   ⚠️ NO CHANGES — logic preserved exactly
===================================================== */
const searchEmployees = async (req, res) => {
  try {
    const loggedInEmployeeId = req.user?._id;
    const { query } = req.query;

    if (!loggedInEmployeeId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    if (!query || query.trim().length < 2) {
      return res.json({ success: true, data: [] });
    }

    const safeRegex = new RegExp(query.trim(), "i");

    const employees = await Employee.find({
      workingStatus: true,
      _id: { $ne: loggedInEmployeeId },
      $or: [
        { name: safeRegex },
        { empId: safeRegex },
        { email: safeRegex },
      ],
    })
      .select("_id name empId email designation")
      .limit(10)
      .lean();

    return res.json({ success: true, data: employees });
  } catch (err) {
    console.error("Search Employees Error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/* =====================================================
   GET PROFILE COMPLETION (SELF)
   ⚠️ NO CHANGES — logic preserved exactly
===================================================== */
const getProfileCompletion = async (req, res) => {
  try {
    let details = await EmployeeDetails.findOne({ empId: req.user._id });

    if (!details) {
      details = await EmployeeDetails.create({
        empId: req.user._id,
        empIdString: req.user.empId || undefined,
      });
    }

    const employee = await Employee.findById(req.user._id);
    const calculatedCompletion = calculateProfileCompletion(details.toObject(), employee);
    if (details.profileCompletion !== calculatedCompletion) {
      details.profileCompletion = calculatedCompletion;
      await details.save();
    }

    const restriction = checkProfileRestriction({
      role: "employee",
      profileCompletion: calculatedCompletion,
      isProfileCompleted: employee?.isProfileCompleted,
      dateJoined: employee?.dateJoined,
      createdAt: employee?.createdAt,
      empId: employee?.empId || req.user?.empId,
      profileApprovalStatus: details?.profileApprovalStatus || employee?.profileApprovalStatus,
      reviewedAt: details?.reviewedAt,
      profileRejectedAt: employee?.profileRejectedAt,
    });

    res.json({
      success: true,
      profileCompletion: calculatedCompletion,
      isProfileRestricted: restriction.isRestricted,
      daysRemaining: restriction.daysRemaining,
      isLastDay: restriction.isLastDay,
      isNewEmployee: restriction.isNewEmployee,
      isRejected: restriction.isRejected,
      profileApprovalStatus: details?.profileApprovalStatus || employee?.profileApprovalStatus,
      reviewedAt: details?.reviewedAt || employee?.profileRejectedAt || null,
      dateJoined: employee?.dateJoined,
      isProfileCompleted: employee?.isProfileCompleted || calculatedCompletion >= 100,
      deadline: restriction.deadline,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/* =====================================================
   GET TODAY'S BIRTHDAYS FOR EMPLOYEES
===================================================== */
const isTodayBirthdayMatch = (dobDateObj) => {
  if (!dobDateObj) return false;
  const d = new Date(dobDateObj);
  if (isNaN(d.getTime())) return false;

  const getISTMonthDay = (dateObj) => {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      month: "numeric",
      day: "numeric",
    });
    const parts = formatter.formatToParts(dateObj);
    let month = 0, day = 0;
    for (const p of parts) {
      if (p.type === "month") month = parseInt(p.value, 10);
      if (p.type === "day") day = parseInt(p.value, 10);
    }
    return { month, day };
  };

  const todayComp = getISTMonthDay(new Date());
  const dobComp = getISTMonthDay(d);

  const istMatch = todayComp.month === dobComp.month && todayComp.day === dobComp.day;
  const utcMatch = (new Date().getUTCMonth() + 1) === (d.getUTCMonth() + 1) && new Date().getUTCDate() === d.getUTCDate();

  return istMatch || utcMatch;
};

const getTodayBirthdays = async (req, res) => {
  try {
    const details = await EmployeeDetails.find({
      dob: { $exists: true, $ne: null }
    })
      .populate({
        path: "empId",
        select: "name empId photo department designation employmentStatus role status"
      })
      .lean();

    const birthdayEmployees = [];

    for (const item of details) {
      if (!item.empId) continue;

      const empStatus = (item.empId.employmentStatus || "").toLowerCase();
      if (empStatus === "relieved") continue;

      if (isTodayBirthdayMatch(item.dob)) {
        let avatarUrl = "/avatar.png";
        if (item.empId.photo && item.empId.photo !== "avatar.png") {
          try {
            avatarUrl = await getCachedSignedUrl(item.empId.photo);
          } catch (err) {
            console.error("Avatar error:", err);
          }
        }

        birthdayEmployees.push({
          _id: item.empId._id,
          name: item.empId.name,
          empId: item.empId.empId,
          department: item.empId.department || "-",
          designation: item.empId.designation || "-",
          photo: avatarUrl,
          dob: item.dob,
        });
      }
    }

    return res.json({ success: true, data: birthdayEmployees });
  } catch (err) {
    console.error("❌ getTodayBirthdays error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch today's birthdays" });
  }
};

/* =====================================================
   SEND BIRTHDAY WISH
===================================================== */
const sendBirthdayWish = async (req, res) => {
  try {
    const senderId = req.user?._id || req.user?.id;
    const senderName = req.user?.name || "Colleague";
    const { receiverId, message } = req.body;

    if (!receiverId || !message || !message.trim()) {
      return res.status(400).json({ success: false, message: "Receiver and message are required" });
    }

    const todayIST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const [year, month, day] = todayIST.split("-").map(Number);
    // Set expiresAt to 12:00 AM (midnight) IST of the next day
    const expiresAt = new Date(Date.UTC(year, month - 1, day + 1, 0, 0, 0) - (5.5 * 60 * 60 * 1000));

    const wish = await BirthdayWish.findOneAndUpdate(
      { senderId, receiverId, wishDate: todayIST },
      { senderId, senderName, receiverId, message: message.trim(), wishDate: todayIST, expiresAt },
      { upsert: true, new: true }
    );

    return res.json({ success: true, message: "Birthday wish sent successfully!", data: wish });
  } catch (err) {
    console.error("❌ sendBirthdayWish error:", err);
    return res.status(500).json({ success: false, message: "Failed to send birthday wish" });
  }
};

/* =====================================================
   GET RECEIVED BIRTHDAY WISHES FOR LOGGED-IN EMPLOYEE
===================================================== */
const getReceivedWishes = async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const todayIST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

    const wishes = await BirthdayWish.find({
      receiverId: userId,
      wishDate: todayIST,
    })
      .populate("senderId", "name photo designation department")
      .sort({ createdAt: -1 })
      .lean();

    const formattedWishes = await Promise.all(
      wishes.map(async (w) => {
        let avatarUrl = "/avatar.png";
        if (w.senderId?.photo && w.senderId?.photo !== "avatar.png") {
          try {
            avatarUrl = await getCachedSignedUrl(w.senderId.photo);
          } catch (e) { }
        }
        return {
          ...w,
          senderPhoto: avatarUrl,
        };
      })
    );

    return res.json({ success: true, data: formattedWishes });
  } catch (err) {
    console.error("❌ getReceivedWishes error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch birthday wishes" });
  }
};

/* =====================================================
   REPLY TO A BIRTHDAY WISH
===================================================== */
const replyBirthdayWish = async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const { wishId, reply } = req.body;

    if (!wishId || !reply || !reply.trim()) {
      return res.status(400).json({ success: false, message: "Wish ID and reply message required" });
    }

    const wish = await BirthdayWish.findOneAndUpdate(
      { _id: wishId, receiverId: userId },
      { reply: reply.trim(), repliedAt: new Date() },
      { new: true }
    );

    if (!wish) {
      return res.status(404).json({ success: false, message: "Birthday wish record not found" });
    }

    return res.json({ success: true, message: "Reply sent successfully!", data: wish });
  } catch (err) {
    console.error("❌ replyBirthdayWish error:", err);
    return res.status(500).json({ success: false, message: "Failed to reply to birthday wish" });
  }
};

/* =====================================================
   GET WISHES SENT TODAY BY CURRENT LOGGED-IN USER
===================================================== */
const getUserSentWishes = async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const todayIST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

    const sentWishes = await BirthdayWish.find({
      senderId: userId,
      wishDate: todayIST,
    }).lean();

    return res.json({ success: true, data: sentWishes });
  } catch (err) {
    console.error("❌ getUserSentWishes error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch sent wishes" });
  }
};

/* =====================================================
   DOCUMENT VIEW PRESIGNED URL (3 MINUTE EXPIRATION)
===================================================== */
const getDocumentViewUrl = async (req, res) => {
  try {
    const { key, field, empId: targetEmpId } = req.body || {};
    let s3Key = key;

    // If key not provided directly or if field was passed, fetch from DB
    if (!s3Key && field) {
      const isAdmin = req.user?.role === "admin" || req.user?.role === "superadmin" || Boolean(req.user?.isHr);
      let queryUser = req.user._id;

      if (isAdmin && targetEmpId) {
        const empDoc = await Employee.findOne({
          $or: [{ _id: targetEmpId }, { empId: targetEmpId }]
        });
        if (empDoc) {
          queryUser = empDoc._id;
        }
      }

      const details = await EmployeeDetails.findOne({ empId: queryUser });
      if (details) {
        if (field.startsWith("courses.") || field.startsWith("course_")) {
          const idx = parseInt(field.replace(/[^0-9]/g, ""), 10);
          if (!isNaN(idx) && details.courses?.[idx]) {
            s3Key = details.courses[idx].certificate;
          }
        } else {
          s3Key = details[field];
        }
      }
    }

    if (!s3Key || typeof s3Key !== "string" || s3Key.trim() === "") {
      return res.status(404).json({ success: false, message: "Document not found or not uploaded" });
    }

    // Security check: Regular employees can only view documents belonging to their own employee record
    const isAdmin = req.user?.role === "admin" || req.user?.role === "superadmin" || Boolean(req.user?.isHr);
    if (!isAdmin) {
      const userEmpId = String(req.user._id);
      const userEmpCode = req.user.empId ? String(req.user.empId) : "";

      const isFolderMatched = (userEmpCode && s3Key.includes(`/${userEmpCode}/`)) || s3Key.includes(`/${userEmpId}/`);

      if (!isFolderMatched) {
        const myDetails = await EmployeeDetails.findOne({ empId: req.user._id });
        let isAuthorized = false;
        if (myDetails) {
          if (Array.isArray(myDetails.incrementDocuments)) {
            isAuthorized = myDetails.incrementDocuments.some(
              (doc) => doc.incrementLetter?.fileKey === s3Key || doc.performanceForm?.fileKey === s3Key
            );
          }
          if (!isAuthorized) {
            const rawObj = myDetails.toObject ? myDetails.toObject() : myDetails;
            isAuthorized = Object.values(rawObj).some((val) => typeof val === "string" && val === s3Key);
          }
        }

        if (!isAuthorized) {
          return res.status(403).json({
            success: false,
            message: "Unauthorized: You can only view documents belonging to your own employee record.",
          });
        }
      }
    }

    // Generate signed URL with strictly 3 minutes (180 seconds) expiry
    const signedUrl = await generateSignedUrl(s3Key, 180);

    return res.json({
      success: true,
      url: signedUrl,
      expiresIn: 180,
      message: "Signed URL generated (expires in 3 minutes)",
    });
  } catch (err) {
    console.error("❌ getDocumentViewUrl error:", err);
    return res.status(500).json({ success: false, message: "Failed to generate document view URL" });
  }
};

/* =====================================================
   ADMIN REVIEW & APPROVE / REJECT PROFILE
===================================================== */
const adminReviewProfile = async (req, res) => {
  try {
    const { empId } = req.params;
    const { action, remark, rejectedFields } = req.body;

    if (!["approve", "reject"].includes(action)) {
      return res.status(400).json({
        success: false,
        message: "Action must be either 'approve' or 'reject'",
      });
    }

    let employee = null;
    if (mongoose.Types.ObjectId.isValid(empId)) {
      employee = await Employee.findById(empId);
    }
    if (!employee) {
      employee = await Employee.findOne({ empId });
    }

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    let details = await EmployeeDetails.findOne({ empId: employee._id });
    if (!details) {
      details = await EmployeeDetails.create({
        empId: employee._id,
        empIdString: employee.empId,
      });
    }

    const adminUser = req.user;

    if (action === "approve") {
      details.profileApprovalStatus = "approved";
      details.rejectionRemark = "";
      details.rejectedFields = [];
      details.reviewedAt = new Date();
      details.reviewedBy = adminUser._id;
      await details.save();

      await Employee.findByIdAndUpdate(employee._id, {
        $set: {
          isProfileCompleted: true,
          profileCompletedAt: new Date(),
          profileApprovalStatus: "approved",
        },
      });

      const notifTitle = "Profile Approved!";
      const notifMsg = "Congratulations! Your profile has been reviewed and approved by Admin.";

      try {
        await Notification.create({
          type: "PROFILE_APPROVED",
          toEmployee: employee._id,
          fromAdmin: true,
          title: notifTitle,
          message: notifMsg,
          metadata: {
            url: "/emp/my-details",
            approvedBy: adminUser.name || "Admin",
            requestType: "profile-approval",
          },
        });

        await sendPushNotification([employee._id], notifTitle, notifMsg, {
          type: "PROFILE_APPROVED",
          url: "/emp/my-details",
        });
      } catch (nErr) {
        console.error("Profile approved notification error:", nErr);
      }

      return res.json({
        success: true,
        message: "Employee profile approved successfully",
        data: details,
      });
    } else {
      // REJECT
      if (!remark || !remark.trim()) {
        return res.status(400).json({
          success: false,
          message: "A rejection remark explaining the reason for rejection is required",
        });
      }

      const rawFields = Array.isArray(rejectedFields) ? rejectedFields : [];
      const formattedFields = Array.from(new Set(rawFields.map((f) => {
        if (f === "certificate10") return "marksheet10";
        if (f === "certificate12") return "marksheet12";
        return f;
      })));

      details.profileApprovalStatus = "rejected";
      details.rejectionRemark = remark.trim();
      details.rejectedFields = formattedFields;
      details.reviewedAt = new Date();
      details.reviewedBy = adminUser._id;
      await details.save();

      await Employee.findByIdAndUpdate(employee._id, {
        $set: {
          isProfileCompleted: false,
          profileApprovalStatus: "rejected",
          profileRejectedAt: new Date(),
        },
      });

      const notifTitle = "Profile Verification Needs Attention";
      const notifMsg = `Your profile was reviewed and rejected: "${remark.trim()}". Please update the requested information/document and re-submit.`;

      try {
        await Notification.create({
          type: "PROFILE_REJECTED",
          toEmployee: employee._id,
          fromAdmin: true,
          title: notifTitle,
          message: notifMsg,
          metadata: {
            url: "/emp/my-details",
            reason: remark.trim(),
            rejectionRemark: remark.trim(),
            rejectedFields: formattedFields,
            rejectedBy: adminUser.name || "Admin",
            requestType: "profile-rejection",
          },
        });

        await sendPushNotification([employee._id], notifTitle, notifMsg, {
          type: "PROFILE_REJECTED",
          url: "/emp/my-details",
          remark: remark.trim(),
        });
      } catch (nErr) {
        console.error("Profile rejected notification error:", nErr);
      }

      return res.json({
        success: true,
        message: "Employee profile rejected with remarks",
        data: details,
      });
    }
  } catch (err) {
    console.error("❌ adminReviewProfile error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error reviewing employee profile",
    });
  }
};

const saveCertifications = async (req, res) => {
  try {
    const employeeId = req.user.id || req.user._id;
    const employee = await Employee.findById(employeeId);
    if (!employee) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    let details = await EmployeeDetails.findOne({ empId: employeeId });
    if (!details) {
      details = new EmployeeDetails({ empId: employeeId });
    }

    const { hasCertifications, professionalCertifications } = req.body;

    if (hasCertifications !== undefined) {
      details.hasCertifications = hasCertifications;
    }

    if (hasCertifications === "no") {
      details.set("professionalCertifications", undefined);
    } else if (professionalCertifications !== undefined) {
      let parsed = [];
      try {
        parsed =
          typeof professionalCertifications === "string"
            ? JSON.parse(professionalCertifications)
            : professionalCertifications;
      } catch (e) {
        parsed = [];
      }

      if (Array.isArray(parsed) && parsed.length > 0) {
        const files = req.files
          ? req.files.reduce((acc, f) => {
              acc[f.fieldname] = acc[f.fieldname] || [];
              acc[f.fieldname].push(f);
              return acc;
            }, {})
          : {};

        const existingCerts = Array.isArray(details.professionalCertifications)
          ? details.professionalCertifications
          : [];

        const updatedCerts = await Promise.all(
          parsed.map(async (cert, idx) => {
            let certKey = null;
            const certFile =
              files[`cert_${idx}_certificate`]?.[0] ||
              files[`cert_${cert.id}_certificate`]?.[0] ||
              files[`cert_${cert._id}_certificate`]?.[0];

            if (certFile?.buffer) {
              const ext = certFile.originalname.split(".").pop();
              const key = `ProfileDocs/${employee.empId}/cert_${idx}_${Date.now()}.${ext}`;
              await uploadToS3(certFile.buffer, key, certFile.mimetype);
              certKey = key;
            }

            const existingMatch =
              existingCerts.find(
                (ec) =>
                  (ec.id && cert.id && String(ec.id) === String(cert.id)) ||
                  (ec._id && cert._id && String(ec._id) === String(cert._id)) ||
                  (ec.courseName && cert.courseName && ec.courseName === cert.courseName)
              ) || existingCerts[idx];

            return {
              courseName: cert.courseName || "",
              startMonthYear: cert.startMonthYear || "",
              endMonthYear: cert.endMonthYear || "",
              courseDuration: cert.courseDuration || "",
              durationValue: cert.durationValue || "",
              durationUnit: cert.durationUnit || cert.durationType || "Months",
              durationType: cert.durationType || cert.durationUnit || "Months",
              courseType: cert.courseType || "",
              institutionName: cert.institutionName || "",
              certificate:
                certKey ||
                (typeof cert.certificate === "string" ? cert.certificate : null) ||
                existingMatch?.certificate ||
                null,
            };
          })
        );
        details.professionalCertifications = updatedCerts;
      } else {
        details.set("professionalCertifications", undefined);
      }
    }

    const detailsObj = details.toObject();
    details.profileCompletion = calculateProfileCompletion(
      {
        ...detailsObj,
        phone: employee.phone,
        status: employee.status,
      },
      employee
    );

    await details.save();

    const signedDetails = await attachSignedUrls(details.toObject());

    return res.json({
      success: true,
      message: "Certifications saved successfully",
      hasCertifications: details.hasCertifications,
      professionalCertifications: signedDetails.professionalCertifications || [],
      profileCompletion: details.profileCompletion,
    });
  } catch (err) {
    console.error("Error auto-saving certifications:", err);
    return res.status(500).json({ success: false, message: "Failed to save certifications" });
  }
};

module.exports = {
  updateEmployeeDetails,
  getEmployeeDetails,
  getMyProfileWithSignedUrls,
  getEmployeeByEmpIdString,
  calculateProfileCompletion,
  adminUpdateEmployee,
  getProfileCompletion,
  searchEmployees,
  getTodayBirthdays,
  sendBirthdayWish,
  getReceivedWishes,
  replyBirthdayWish,
  getUserSentWishes,
  getDocumentViewUrl,
  adminReviewProfile,
  saveCertifications,
};

const apiLogger = require('../utils/apiLogger');
module.exports = apiLogger(module.exports, 'employee.controller.js');
