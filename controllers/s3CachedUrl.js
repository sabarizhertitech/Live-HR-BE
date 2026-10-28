const EmployeeDetails = require("../Models/EmployeeDetails");
const Employee = require("../Models/Employee");
const EditRequest = require("../Models/EditRequest");
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

/* =====================================================
   HELPER — UPLOAD ONE FILE TO S3
   Returns the S3 key string, or null on failure
===================================================== */
const uploadFileToS3 = async (file, empIdString) => {
  if (!file || !file.buffer) return null;
  const ext = file.originalname.split(".").pop();
  const key = `ProfileDocs/${empIdString}/${file.fieldname}.${ext}`;
  await uploadToS3(file.buffer, key, file.mimetype);
  return key;
};

/* =====================================================
   HELPER — GENERATE SIGNED URLS FOR ALL FILE FIELDS
   ✅ Safe: skips null/empty keys, wraps each in try/catch
   ✅ Adds *Url fields alongside raw S3 keys
===================================================== */
const attachSignedUrls = async (dataObj) => {
  const fileFields = [
    "picture",
    "aadhaarFile",
    "aadhaarFront",
    "aadhaarBack",
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

  return dataObj;
};

/* =====================================================
   SINGLE SOURCE OF TRUTH — CORE FIELDS GUARD
   Employee is the PRIMARY source for these fields.
   EmployeeDetails must NEVER store or overwrite them.
===================================================== */
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

/* =====================================================
   PROFILE COMPLETION CALCULATION (weighted)
   DO NOT CHANGE — existing logic preserved
===================================================== */
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
        allowedFields = new Set(approvedRequest.approvedFields);
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

          return {
            ...course,
            certificate: certificateKey || (typeof course.certificate === "string" ? course.certificate : null) || existingCert || null,
          };
        })
      );

      usedFields.push("courses");
    }

    /* ───────── FILE FIELDS → S3 ───────── */
    const fileFields = [
      "picture",
      "aadhaarFile",
      "aadhaarFront",
      "aadhaarBack",
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

    if (isFirstTime && merged.profileCompletion >= 100) {
      await Employee.findByIdAndUpdate(employeeId, {
        $set: {
          ...empUpdate,
          profileCompletedAt: new Date(),
        },
        $unset: {
          isProfileCompleted: 1
        }
      });
    } else {
      await Employee.findByIdAndUpdate(employeeId, { $set: empUpdate });
    }

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
      message: "Profile updated successfully",
      profileCompletion: merged.profileCompletion,
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

    if (details.profileCompletion == null) {
      details.profileCompletion = calculateProfileCompletion(details.toObject());
      await details.save();
    }

    const employee = await Employee.findById(req.user._id);
    const today = new Date();
    let isBirthdayToday = false;

    if (details.dob) {
      const dob = new Date(details.dob);

      isBirthdayToday =
        today.getDate() === dob.getDate() &&
        today.getMonth() === dob.getMonth();
    }

    const detailsObj = cleanDetails(details.toObject());

    let responseData = {
      ...detailsObj,
      // Employee is PRIMARY source — always wins over EmployeeDetails
      ...employee.toObject(),
      gender: details.gender || employee.gender || "male",
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

    if (details.profileCompletion == null) {
      details.profileCompletion = calculateProfileCompletion(details.toObject());
      await details.save();
    }

    const employee = await Employee.findById(req.user._id);

    const detailsObj2 = cleanDetails(details.toObject());

    let responseData = {
      ...detailsObj2,
      // Employee is PRIMARY source — always wins over EmployeeDetails
      ...employee.toObject(),
      gender: details.gender || employee.gender || "male",
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
    const jsonFields = ["siblings", "previousExperiences", "courses"];
    jsonFields.forEach((field) => {
      if (update[field] && typeof update[field] === "string") {
        try {
          update[field] = JSON.parse(update[field]);
        } catch {
          update[field] = [];
        }
      }
    });

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
      "aadhaarFront",   // ✅ FIX
      "aadhaarBack",    // ✅ FIX
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

    if (update.status === "relieved") {
      await Employee.findByIdAndUpdate(employee._id, {
        $set: {
          ...employeeUpdate,
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
          profileCompletedAt: "",
          isProfileCompleted: "",
        },
      });
    } else {
      await Employee.findByIdAndUpdate(employee._id, {
        ...employeeUpdate,
        lastProfileUpdateAt: new Date(),
      });
    }

    /* ── Save EmployeeDetails ── */
    // Strip core fields from update before saving to EmployeeDetails (Single Source of Truth)
    CORE_FIELDS.forEach((key) => delete update[key]);

    Object.assign(details, update);
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
    const employee = await Employee.findOne({ empId: empIdString });

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
    if (!details.profileCompletion || details.profileCompletion === 0) {
      details.profileCompletion = calculateProfileCompletion(details.toObject());
      await details.save();
    }

    // ✅ STEP 5: Build response (Employee is PRIMARY source of truth)
    const detailsObj3 = cleanDetails(details.toObject());

    let responseData = {
      ...detailsObj3,
      // Employee wins on all core fields
      ...employee.toObject(),
      gender: details.gender || employee.gender || "male",
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
   NO CHANGES — logic preserved exactly
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
   NO CHANGES — logic preserved exactly
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

    res.json({ success: true, profileCompletion: calculatedCompletion });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
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
};

const apiLogger = require('../utils/apiLogger');
module.exports = apiLogger(module.exports, 'employee.controller.js');
