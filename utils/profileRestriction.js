/**
 * 7-Day Profile Completion & Access Restriction Utility
 * Logic Introduction Start Date: October 8, 2026 (2026-10-08)
 */

const LOGIC_START_DATE_STR = "2026-10-08";

function parseDateOnly(dateVal) {
  if (!dateVal) return null;
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

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

function checkProfileRestriction({
  role,
  profileCompletion = 0,
  isProfileCompleted = false,
  dateJoined = null,
  createdAt = null,
  empId = null,
  profileApprovalStatus = null,
  reviewedAt = null,
  profileRejectedAt = null,
}) {
  // 1. Applies only to employees
  if (role !== "employee") {
    return {
      isRestricted: false,
      daysRemaining: 7,
      isLastDay: false,
      isNewEmployee: false,
      isComplete: true,
      isRejected: false,
      deadline: null,
      completion: Number(profileCompletion || 0),
    };
  }

  const isRejected = profileApprovalStatus === "rejected";
  const completion = Math.min(Math.max(Number(profileCompletion || 0), 0), 100);

  // 3. Profile Must Be 100% Complete and NOT currently rejected
  if (!isRejected && (completion >= 100 || isProfileCompleted === true)) {
    return {
      isRestricted: false,
      daysRemaining: 0,
      isLastDay: false,
      isNewEmployee: false,
      isComplete: true,
      isRejected: false,
      deadline: null,
      completion: 100,
    };
  }

  // 2. Profile Completion Period:
  // Base date when logic is introduced: 08 Oct 2026
  const logicStartDate = new Date(2026, 9, 8); // month 9 is October (0-indexed)

  const joiningDate = parseDateOnly(dateJoined) || parseDateOnly(createdAt);

  let isNewEmployee = false;
  let periodStartDate;

  if (isRejected) {
    // Rejected by Admin: calculate 7-day period starting from rejection date
    const rejectionDate = reviewedAt || profileRejectedAt || createdAt;
    periodStartDate = parseDateOnly(rejectionDate) || parseDateOnly(new Date());
  } else if (joiningDate && joiningDate.getTime() >= logicStartDate.getTime()) {
    // New Employee: Date of Joining is on or after logic introduction date (08 Oct 2026)
    isNewEmployee = true;
    periodStartDate = new Date(joiningDate);
  } else {
    // Existing Employee: Calculate 7-day period starting from 08 Oct 2026
    isNewEmployee = false;
    periodStartDate = new Date(logicStartDate);
  }

  // 7-Day Completion Period:
  // Day 1 to Day 7 inclusive. Day 8 begins exactly 7 full days after periodStartDate at 00:00:00
  const deadline = new Date(periodStartDate);
  deadline.setDate(deadline.getDate() + 7); // Period ends at the start of Day 8
  deadline.setHours(0, 0, 0, 0);

  const now = new Date();
  const today = parseDateOnly(now);
  const startDay = parseDateOnly(periodStartDate);

  // Calendar days elapsed from periodStartDate:
  // Day 1 (startDay): daysElapsed = 0
  // Day 2: daysElapsed = 1
  // ...
  // Day 7: daysElapsed = 6
  // Day 8+: daysElapsed >= 7
  const daysElapsed = Math.max(0, Math.floor((today.getTime() - startDay.getTime()) / (1000 * 60 * 60 * 24)));
  const daysRemaining = Math.max(0, 7 - daysElapsed);

  // Day 7 is the 7th and final day of the 7-day window (daysElapsed === 6, daysRemaining === 1)
  const isLastDay = daysRemaining === 1 && daysElapsed === 6;

  // Starting from Day 8, if profile < 100% or rejected, access is restricted
  const isRestricted = daysElapsed >= 7;

  return {
    isRestricted,
    daysRemaining,
    isLastDay,
    isNewEmployee,
    isRejected,
    isComplete: false,
    deadline,
    completion,
    periodStartDate,
  };
}

module.exports = {
  calculateProfileCompletion,
  checkProfileRestriction,
  LOGIC_START_DATE_STR,
};
