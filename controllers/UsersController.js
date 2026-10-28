const Employee = require("../Models/Employee");
const LeaveCategory = require("../Models/LeaveCategory");
const UserOTP = require("../Models/UserOTP");
const nodemailer = require("nodemailer");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../utilities/config");
const { validatePassword } = require("../utilities/passwordPolicy");
const crypto = require("crypto");
const generateSignedUrl = require("../utilities/s3SignedUrl");
const getCachedSignedUrl = require("../utilities/s3CachedUrl");
const { uploadToS3 } = require("../utilities/s3Upload");
const deleteFromS3 = require("../utilities/s3Delete");
const EmployeeDetails = require("../Models/EmployeeDetails");
const mongoose = require("mongoose");
const MenuPermission = require("../Models/MenuPermission");
const { decrypt, encrypt, maskAccountNumber: maskAccNo } = require("../utilities/secureEncryption");
const { createLog } = require("../utilities/logService");
const { checkProfileRestriction, calculateProfileCompletion } = require("../utils/profileRestriction");

const computeFinancialYear = (dateInput) => {
  const d = dateInput ? new Date(dateInput) : new Date();
  if (isNaN(d.getTime())) {
    const now = new Date();
    const curYear = now.getFullYear();
    const curMonth = now.getMonth();
    return curMonth >= 3 ? `${curYear}–${curYear + 1}` : `${curYear - 1}–${curYear}`;
  }
  const year = d.getFullYear();
  const month = d.getMonth(); // 0 is Jan, 3 is Apr
  if (month >= 3) {
    return `${year}–${year + 1}`;
  } else {
    return `${year - 1}–${year}`;
  }
};

const normalizeFY = (str) => String(str || "").replace(/[\u2013\u2014–-]/g, "–").trim();



const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const UsersController = {

  login: async (req, res) => {
    try {
      const { identifier, password, role } = req.body;

      if (!identifier || !password || !role) {
        return res.status(400).json({ message: "Email/Username, password, and role are required" });
      }

      const loginInput = identifier.trim();

      const user = await Employee.findOne({
        $or: [
          { email: loginInput },
          { username: loginInput },
          { empId: loginInput.toUpperCase() } // 🔥 important
        ],
      });

      if (!user) {
        createLog({
          category: "auth",
          referenceId: null,
          description: `Failed login attempt for identifier '${loginInput}': Invalid credentials (User not found)`,
        });
        return res.status(404).json({ message: "Invalid Credentials" });
      }

      if (user.role !== role) {
        createLog({
          category: "auth",
          referenceId: user._id,
          description: `Failed login attempt for ${user.name} (${user.empId || loginInput}): Access denied for role '${role}'`,
        });
        return res.status(403).json({
          message: `Access denied. You don't have ${role} privileges.`,
        });
      }

      if (user.employmentStatus !== "active") {
        createLog({
          category: "auth",
          referenceId: user._id,
          description: `Failed login attempt for ${user.name} (${user.empId || loginInput}): Employment is not active`,
        });
        return res.status(403).json({ message: "Your employment is not active" });
      }

      if (!user.workingStatus) {
        createLog({
          category: "auth",
          referenceId: user._id,
          description: `Failed login attempt for ${user.name} (${user.empId || loginInput}): Account is deactivated`,
        });
        return res.status(403).json({
          message: "Your account is deactivated. Please contact admin.",
        });
      }

      if (user.lockUntil && user.lockUntil > Date.now()) {
        const remaining = Math.ceil((user.lockUntil - Date.now()) / 60000);
        createLog({
          category: "auth",
          referenceId: user._id,
          description: `Failed login attempt for ${user.name} (${user.empId || loginInput}): Account locked (remaining: ${remaining} mins)`,
        });

        return res.status(403).json({
          message: `Account locked. Try again after ${remaining} minutes`
        });
      }

      if (!user.passwordHash) {
        console.error("User missing passwordHash:", user._id);
        return res.status(500).json({
          message: "User password not configured"
        });
      }

      const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

      if (!isPasswordValid) {
        const newAttempts = (user.loginAttempts || 0) + 1;
        console.warn(
          `[AUTH_FAILED] Invalid Login | EmpID: ${user.empId} | Attempt: ${newAttempts} | Time: ${new Date().toISOString()}`
        );
        const lockUpdate = { loginAttempts: newAttempts };

        if (newAttempts >= 5) {
          lockUpdate.lockUntil = new Date(Date.now() + 30 * 60 * 1000);
        }

        await Employee.updateOne({ _id: user._id }, { $set: lockUpdate });

        const lockMsg = newAttempts >= 5 ? " (Account locked for 30 minutes)" : "";
        createLog({
          category: "auth",
          referenceId: user._id,
          description: `Failed login attempt for ${user.name} (${user.empId || loginInput}) - Invalid credentials (Attempt ${newAttempts})${lockMsg}`,
        });

        return res.status(401).json({ message: "Invalid Credentials" });
      }

      const updateData = {
        $set: {
          loginAttempts: 0,
          lockUntil: null,
        },
      };

      if (user.isFirstLogin && !user.firstLoginAt) {
        updateData.$set.firstLoginAt = new Date();
      }

      await Employee.updateOne({ _id: user._id }, updateData);

      const tokenPayload = { id: user._id, role: user.role };
      const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: "8h" });

      // ── Successful Login Log ──
      createLog({
        category: "auth",
        referenceId: user._id,
        description: `${user.name} (${user.empId || user.role}) logged in successfully`,
      });

      const now = new Date();
      let passwordExpired = false;
      let passwordExpiringSoon = false;
      let daysRemaining = null;

      if (user.passwordExpiresAt) {
        if (user.passwordExpiresAt < now) {
          passwordExpired = true;
          daysRemaining = 0;
        } else {
          const diffDays = Math.ceil((user.passwordExpiresAt - now) / (1000 * 60 * 60 * 24));
          if (diffDays <= 7) passwordExpiringSoon = true;
          daysRemaining = diffDays;
        }
      }


      const isFirstLoginFlag = user.isFirstLogin === true;

      const forceChangePassword = isFirstLoginFlag || passwordExpired;


      const permDoc = await MenuPermission.findOne({ employeeId: user._id });
      const permissions = permDoc ? permDoc.menus : [];

      let profileCompletion = 0;
      let isProfileRestricted = false;
      let daysRemainingForProfile = 7;
      let isLastDayForProfile = false;
      let isNewEmployee = false;
      let isRejectedForProfile = false;
      let profileDeadline = null;
      let profileApprovalStatus = null;
      let profileReviewedAt = null;

      if (user.role === "employee") {
        const details = await EmployeeDetails.findOne({ empId: user._id });
        if (details) {
          profileCompletion = calculateProfileCompletion(details.toObject(), user);
          profileApprovalStatus = details.profileApprovalStatus;
          profileReviewedAt = details.reviewedAt;
        }
        const restriction = checkProfileRestriction({
          role: "employee",
          profileCompletion,
          isProfileCompleted: user.isProfileCompleted,
          dateJoined: user.dateJoined,
          createdAt: user.createdAt,
          empId: user.empId,
          profileApprovalStatus: profileApprovalStatus || user.profileApprovalStatus,
          reviewedAt: profileReviewedAt || user.profileRejectedAt,
          profileRejectedAt: user.profileRejectedAt || profileReviewedAt,
        });
        isProfileRestricted = restriction.isRestricted;
        daysRemainingForProfile = restriction.daysRemaining;
        isLastDayForProfile = restriction.isLastDay;
        isNewEmployee = restriction.isNewEmployee;
        isRejectedForProfile = restriction.isRejected;
        profileDeadline = restriction.deadline;
      }

      let hrAccessConfig = null;
      if (user.isHr) {
        try {
          const Configuration = require("../Models/Configuration");
          const configDoc = await Configuration.findOne({ key: "DEFAULT_CONFIG" }).lean();
          hrAccessConfig = configDoc?.hrAccessConfig || null;
        } catch (_) {}
      }

      if (user.isFirstLogin) {
        return res.status(200).json({
          message: "Login success",
          _id: user._id,
          empId: user.empId,
          username: user.username,
          name: user.name,
          role: user.role,
          isHr: !!user.isHr,
          token,
          permissions,
          hrAccessConfig,
          forceChangePassword: true,
          passwordExpiringSoon: false,
          passwordExpiresAt: user.passwordExpiresAt,
          daysRemaining,
          profileCompletion,
          dateJoined: user.dateJoined,
          isProfileCompleted: user.isProfileCompleted || profileCompletion >= 100,
          isProfileRestricted,
          daysRemainingForProfile,
          isLastDayForProfile,
          isNewEmployee,
          isRejectedForProfile,
          profileApprovalStatus: profileApprovalStatus || user.profileApprovalStatus || null,
          reviewedAt: profileReviewedAt || user.profileRejectedAt || null,
          profileDeadline,
        });
      }

      return res.status(200).json({
        message: "Login success",
        _id: user._id,
        empId: user.empId,
        username: user.username,
        name: user.name,
        role: user.role,
        isHr: !!user.isHr,
        token,
        permissions,
        hrAccessConfig,
        forceChangePassword,
        passwordExpiringSoon,
        passwordExpiresAt: user.passwordExpiresAt,
        daysRemaining,
        profileCompletion,
        dateJoined: user.dateJoined,
        isProfileCompleted: user.isProfileCompleted || profileCompletion >= 100,
        isProfileRestricted,
        daysRemainingForProfile,
        isLastDayForProfile,
        isNewEmployee,
        isRejectedForProfile,
        profileApprovalStatus: profileApprovalStatus || user.profileApprovalStatus || null,
        reviewedAt: profileReviewedAt || user.profileRejectedAt || null,
        profileDeadline,
      });


    } catch (error) {
      console.error("LOGIN ERROR FULL:");
      console.error("Message:", error.message);
      console.error("Stack:", error.stack);
      console.error("Full Error:", error);

      return res.status(500).json({
        message: "Internal server error",
        error: error.message
      });
    }
  },

  // ────────────────────────────────────────────────
  // Forgot Password – Send OTP
  // ────────────────────────────────────────────────
  sendOTP: async (req, res) => {
    try {
      const { email, role } = req.body;

      if (!email || !role) {
        return res.status(400).json({ message: "Email/Username and role are required" });
      }

      const user = await Employee.findOne({
        $or: [
          { email: email.toLowerCase().trim() },
          { username: email.toLowerCase().trim() },
        ],
      });

      if (!user) return res.status(404).json({ message: "If the account exists, an OTP has been sent to the registered email" });

      if (user.role !== role) {
        return res.status(403).json({
          message: `The provided credentials are not associated with a ${role} account.`,
        });
      }

      const existingOTP = await UserOTP.findOne({ email: user.email });

      const today = new Date().toISOString().slice(0, 10);

      if (existingOTP) {

        // reset counter if new day
        if (existingOTP.requestDate !== today) {
          existingOTP.requestCount = 0;
          existingOTP.requestDate = today;
        }

        if (existingOTP.requestCount >= 3) {
          return res.status(429).json({
            message: "You have reached the maximum OTP request limit of 3 for today. Please try again tomorrow."
          });
        }

        await existingOTP.save();
      }

      if (existingOTP && existingOTP.lastSentAt &&
        Date.now() - new Date(existingOTP.lastSentAt).getTime() < 60 * 1000) {
        return res.status(429).json({ message: "Please wait before requesting another OTP" });
      }

      const otp = crypto.randomInt(100000, 999999).toString();
      const expiryTime = new Date();
      expiryTime.setMinutes(expiryTime.getMinutes() + 10);
      const otpHash = await bcrypt.hash(otp, 10);

      await UserOTP.findOneAndUpdate(
        { email: user.email },
        {
          email: user.email,
          otpHash,
          expiryTime,
          attempts: 0,
          verified: false,
          lastSentAt: new Date(),
          requestDate: today,
          $inc: { requestCount: 1 }
        },
        { upsert: true, new: true }
      );

      const mailOptions = {
        from: `"Ertitech Portal" <${process.env.EMAIL_USER}>`,
        to: user.email,
        subject: "Password Reset OTP - Ertitech Portal",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 5px;">
            <h2 style="color: #4a4a4a;">Password Reset Request</h2>
            <p>Dear ${user.name},</p>
            <p>We received a request to reset your password. Please use the OTP below to proceed:</p>
            <div style="background-color: #f0f4f8; padding: 20px; border-radius: 5px; margin: 20px 0; text-align: center; border: 2px solid #667eea;">
              <p style="margin: 0 0 10px 0; color: #666; font-size: 14px;">Your One-Time Password</p>
              <p style="font-size: 32px; letter-spacing: 8px; font-weight: bold; color: #2c5282; margin: 10px 0; font-family: monospace;">
                ${otp}
              </p>
              <p style="margin: 10px 0 0 0; color: #e53e3e; font-size: 13px;">Valid for 10 minutes only</p>
            </div>
            <p style="background-color: #fef5e7; padding: 10px; border-left: 3px solid #f39c12; margin: 20px 0;">
              <strong>Security Alert:</strong> If you didn't request this, please ignore this email.
            </p>
            <p>Best Regards,<br><strong>IT Support Team</strong><br>Ertitech Solutions</p>
            <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">
            <p style="font-size: 12px; color: #888;">Never share this OTP with anyone.</p>
          </div>
        `,
      };

      transporter.sendMail(mailOptions).catch((err) => {
        console.error("OTP email failed:", err.message);
      });

      createLog({
        category: "auth",
        referenceId: user._id,
        description: `${user.name} (${user.empId || user.email}) requested password reset OTP`,
      });

      return res.status(200).json({ message: "OTP sent successfully to your registered email", email: user.email });

    } catch (error) {
      console.error("Error sending OTP:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  },

  // ────────────────────────────────────────────────
  // Reset Password (Forgot Password flow)
  // ────────────────────────────────────────────────
  resetPassword: async (req, res) => {
    try {
      const { email, otp, newPassword } = req.body;

      if (!email || !otp || !newPassword) {
        return res.status(400).json({
          message: "Email/Username, OTP, and new password are required"
        });
      }

      const cleanEmail = email.toLowerCase().trim();

      const user = await Employee.findOne({
        $or: [
          { email: cleanEmail },
          { username: cleanEmail },
        ],
      });

      if (!user) {
        return res.status(200).json({
          message: "If the account exists, an OTP has been sent"
        });
      }

      // ⛔ Prevent too frequent password change
      const minAge = 2 * 24 * 60 * 60 * 1000;
      if (
        user.passwordChangedAt &&
        (Date.now() - user.passwordChangedAt.getTime()) < minAge
      ) {
        return res.status(400).json({
          message: "Password cannot be changed within 2 days of last change",
        });
      }

      const otpRecord = await UserOTP.findOne({ email: user.email });

      if (!otpRecord) {
        return res.status(404).json({
          message: "No OTP found. Please request a new one."
        });
      }

      if (new Date() > otpRecord.expiryTime) {
        await UserOTP.deleteOne({ email: user.email });
        return res.status(400).json({
          message: "OTP has expired. Please request a new one."
        });
      }

      const isMatch = await bcrypt.compare(otp, otpRecord.otpHash);

      if (!isMatch) {
        otpRecord.attempts += 1;

        if (otpRecord.attempts >= 5) {
          await UserOTP.deleteOne({ email: user.email });
          return res.status(403).json({
            message: "Too many attempts. Request new OTP."
          });
        }

        await otpRecord.save();
        return res.status(400).json({ message: "Invalid OTP" });
      }

      // 🔐 Password validation
      const errors = validatePassword(newPassword);
      if (errors.length > 0) {
        return res.status(400).json({ message: errors.join(", ") });
      }

      // 🔁 Prevent reuse
      for (let oldHash of user.passwordHistory || []) {
        const isSame = await bcrypt.compare(newPassword, oldHash);
        if (isSame) {
          return res.status(400).json({
            message: "Cannot reuse last 5 passwords"
          });
        }
      }

      // 🔐 Hash password
      const passwordHash = await bcrypt.hash(newPassword, 10);

      let history = user.passwordHistory || [];
      history.unshift(passwordHash);
      history = history.slice(0, 5);

      // ✅ UPDATE USER (CLEAN + SECURE)
      await Employee.findByIdAndUpdate(user._id, {
        $set: {
          passwordHash,
          passwordHistory: history,
          passwordChangedAt: new Date(),
          passwordExpiresAt: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000),
          loginAttempts: 0,          // 🔥 FIX
          lockUntil: null            // 🔥 FIX
        },
        $unset: {
          isFirstLogin: 1,
          firstLoginAt: 1
        }
      });

      // 🧹 Delete OTP
      await UserOTP.deleteOne({ email: user.email });

      createLog({
        category: "auth",
        referenceId: user._id,
        description: `${user.name} (${user.empId || user.email}) reset password successfully via OTP`,
      });

      // 📧 Email notification
      const mailOptions = {
        from: `"Ertitech Portal" <${process.env.EMAIL_USER}>`,
        to: user.email,
        subject: "Password Changed Successfully - Ertitech Portal",
        html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: green;">Password Changed Successfully ✅</h2>
          <p>Dear ${user.name},</p>
          <p>Your password was changed on ${new Date().toLocaleString()}.</p>
          <p>If this wasn't you, contact support immediately.</p>
        </div>
        `
      };

      transporter.sendMail(mailOptions).catch(() => { });

      return res.status(200).json({
        message: "Password reset successfully"
      });

    } catch (error) {
      console.error("Error resetting password:", error);
      return res.status(500).json({
        message: "Internal server error"
      });
    }
  },

  // ────────────────────────────────────────────────
  // Add Employee
  // ────────────────────────────────────────────────
  addEmployee: async (req, res) => {
    try {
      const { name, email, phone, department, designation, dateJoined, employmentType, empId, probationPeriod, probationPeriodMonths, gender } = req.body;
      // const { salary } = req.body;

      if (!["full_time", "part_time"].includes(employmentType)) {
        return res.status(400).json({ message: "Invalid employment type" });
      }

      if (!name || !email || !phone || !department || !designation || !dateJoined || !employmentType) {
        // if (!salary) was removed
        return res.status(400).json({ message: "All fields are required" });
      }

      if (!/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(email)) {
        return res.status(400).json({ message: "Invalid email format" });
      }

      if (!/^\d{10}$/.test(phone)) {
        return res.status(400).json({ message: "Phone number must be 10 digits" });
      }

      // const salaryNum = Number(salary);
      // if (isNaN(salaryNum) || salaryNum <= 0) {
      //   return res.status(400).json({ message: "Salary must be a positive number" });
      // }

      const existingEmail = await Employee.findOne({ email: email.toLowerCase() });
      if (existingEmail) {
        return res.status(400).json({ message: "Employee with this email already exists" });
      }

      const existingPhone = await Employee.findOne({ phone });
      if (existingPhone) {
        return res.status(400).json({ message: "Employee with this phone number already exists" });
      }

      let baseUsername = email.split("@")[0].toLowerCase().replace(/[^a-z0-9]/g, "");
      let username = baseUsername;
      let counter = 1;

      while (await Employee.findOne({ username })) {
        username = `${baseUsername}${counter}`;
        counter++;
      }


      let employeeId = "";

      // 🔥 FULL TIME → AUTO GENERATE
      if (employmentType === "full_time") {
        const lastEmployee = await Employee.findOne({
          empId: { $regex: /^ER\d+$/ }
        }).sort({ empId: -1 });

        let nextNumber = 1;

        if (lastEmployee?.empId) {
          const lastNumber = parseInt(lastEmployee.empId.replace("ER", ""), 10);
          nextNumber = lastNumber + 1;
        }

        // ✅ FIXED (no const)
        employeeId = `ER${String(nextNumber).padStart(2, "0")}`;
      }
      // 🔥 INTERN / PART-TIME → MANUAL
      else {
        if (!empId || !empId.trim()) {
          return res.status(400).json({
            message: "Employee ID is required for Intern / Part-Time",
          });
        }

        const cleanedEmpId = empId.trim().toUpperCase();

        // ✅ STRICT FORMAT VALIDATION
        if (!/^[A-Z0-9-]{3,20}$/.test(cleanedEmpId)) {
          return res.status(400).json({
            message: "Invalid Employee ID format",
          });
        }

        // ✅ DUPLICATE CHECK (CASE INSENSITIVE)
        const existingEmpId = await Employee.findOne({
          empId: { $regex: `^${cleanedEmpId}$`, $options: "i" },
        });

        if (existingEmpId) {
          return res.status(400).json({
            message: "Employee ID already exists",
          });
        }

        employeeId = cleanedEmpId;
      }

      const plainPassword =
        "Erti@" + crypto.randomBytes(6).toString("hex") + "A1";
      const passwordHash = await bcrypt.hash(plainPassword, 10);

      // Dynamically build leave balances based on categories for the current financial year
      const getCurrentFinancialYear = (date = new Date()) => {
        const d = new Date(date);
        const month = d.getMonth();
        const year = d.getFullYear();
        if (month >= 3) {
          return `${year}-${year + 1}`;
        } else {
          return `${year - 1}-${year}`;
        }
      };

      const currentYear = getCurrentFinancialYear();
      const leaveDoc = await LeaveCategory.findOne({ financialYear: currentYear });
      const dynamicLeaveBalances = {};

      const joiningDate = new Date(dateJoined);
      const currentDate = new Date();
      const serviceMonths =
        (currentDate.getFullYear() - joiningDate.getFullYear()) * 12 +
        (currentDate.getMonth() - joiningDate.getMonth());

      if (leaveDoc && leaveDoc.categories) {
        dynamicLeaveBalances[currentYear] = {};
        leaveDoc.categories.forEach(category => {
          let allowedLeaves = 0;
          if (category.tiers && category.tiers.length > 0) {
            const matchedTier = category.tiers.find(t => serviceMonths >= t.eligibleMonths);
            allowedLeaves = matchedTier ? matchedTier.leaveCount : 0;
          } else {
            allowedLeaves = category.leaveCount || 0;
          }

          dynamicLeaveBalances[currentYear][category.name] = {
            total: allowedLeaves,
            used: 0,
            remaining: allowedLeaves,
          };
        });
      }

      const isProb = probationPeriod === "yes" && Number(probationPeriodMonths) > 0;

      const employeePayload = {
        empId: employeeId,
        username,
        name,
        email: email.toLowerCase(),
        phone,
        department,
        designation,
        dateJoined: new Date(dateJoined),
        status: employmentType,
        role: "employee",
        employmentStatus: "active",
        gender: gender || "male",
        passwordHash,
        passwordHistory: [passwordHash],
        passwordChangedAt: new Date(),
        passwordExpiresAt: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000),
        isFirstLogin: true,
        workingStatus: true,
        photo: "avatar.png",
        leaveBalances: dynamicLeaveBalances,
      };

      if (isProb) {
        employeePayload.probationPeriod = "yes";
        employeePayload.isProbation = true;
        employeePayload.probationPeriodMonths = Number(probationPeriodMonths);
      }

      const newEmployee = new Employee(employeePayload);

      await newEmployee.save();


      await EmployeeDetails.create({
        empId: newEmployee._id,
        empIdString: newEmployee.empId,
      });

      const mailOptions = {
        from: `"Ertitech Solutions" <${process.env.EMAIL_USER}>`,
        to: email.toLowerCase(),
        subject: "Welcome to Ertitech Family!",
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
          </head>
          <body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,sans-serif;">
            <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;padding:20px 0;">
              <tr>
                <td align="center">
                  <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.1);">
                    <tr>
                      <td style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:30px;text-align:center;">
                        <h1 style="color:#ffffff;margin:0;font-size:28px;">Welcome to Ertitech!</h1>
                        <p style="color:rgba(255,255,255,0.9);margin:10px 0 0;font-size:16px;">We're excited to have you on board</p>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding:40px 30px;">
                        <p style="color:#333;font-size:16px;line-height:1.6;margin:0 0 20px;">Dear <strong>${name}</strong>,</p>
                        <p style="color:#555;font-size:15px;line-height:1.6;margin:0 0 20px;">
                          Congratulations on joining <strong>Ertitech Solutions</strong> as a <strong>${designation}</strong> in the <strong>${department}</strong> department.
                        </p>
                        <p style="color:#555;font-size:15px;line-height:1.6;margin:0 0 20px;">Here are your login credentials for the Employee Portal:</p>
                        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fa;border-radius:8px;border:1px solid #e9ecef;margin:25px 0;">
                          <tr><td style="padding:25px;">
                            <table width="100%">
                              <tr><td style="padding:10px 0;border-bottom:1px solid #e9ecef;">
                                <span style="color:#666;font-size:14px;">Employee ID</span><br>
                                <strong style="color:#333;font-size:16px;">${newEmployee.empId}</strong>
                              </td></tr>
                              <tr><td style="padding:10px 0;border-bottom:1px solid #e9ecef;">
                                <span style="color:#666;font-size:14px;">Username</span><br>
                                <strong style="color:#333;font-size:16px;">${username}</strong>
                              </td></tr>
                              <tr><td style="padding:10px 0;border-bottom:1px solid #e9ecef;">
                                <span style="color:#666;font-size:14px;">Email</span><br>
                                <strong style="color:#333;font-size:16px;">${email.toLowerCase()}</strong>
                              </td></tr>
                              <tr><td style="padding:10px 0;">
                                <span style="color:#666;font-size:14px;">Temporary Password</span><br>
                                <strong style="color:#667eea;font-size:20px;letter-spacing:2px;">${plainPassword}</strong>
                              </td></tr>
                            </table>
                          </td></tr>
                        </table>
                        <table width="100%" cellpadding="0" cellspacing="0">
                          <tr><td align="center" style="padding:20px 0;">
                            <a href="https://hr-portal.ertitech.com/" style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;text-decoration:none;padding:14px 40px;border-radius:6px;font-size:16px;font-weight:bold;display:inline-block;">
                              Login to Portal
                            </a>
                          </td></tr>
                        </table>
                        <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff3cd;border-radius:6px;border-left:4px solid #ffc107;margin:25px 0;">
                          <tr><td style="padding:15px 20px;">
                            <p style="color:#856404;font-size:14px;margin:0;line-height:1.5;">
                              <strong>Important:</strong> For security reasons, please change your password immediately after your first login.
                            </p>
                          </td></tr>
                        </table>
                        <p style="color:#555;font-size:15px;line-height:1.6;margin:20px 0 0;">You can login using either your <strong>Email</strong> or <strong>Username</strong>.</p>
                        <p style="color:#555;font-size:15px;line-height:1.6;margin:20px 0 30px;">
                          Best Regards,<br><strong>HR Team</strong><br>
                          <span style="color:#667eea;">Ertitech Solutions</span>
                        </p>
                      </td>
                    </tr>
                    <tr>
                      <td style="background:#f8f9fa;padding:25px;text-align:center;border-top:1px solid #e9ecef;">
                        <p style="color:#999;font-size:13px;margin:0 0 10px;">© ${new Date().getFullYear()} Ertitech Solutions. All rights reserved.</p>
                        <p style="color:#999;font-size:12px;margin:0;">This is an automated email. Please do not reply directly.</p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </body>
          </html>
        `,
      };

      transporter.sendMail(mailOptions).catch((err) => {
        console.error("Welcome email failed:", err.message);
      });

      res.status(201).json({
        message: "Employee added successfully",
        data: {
          empId: newEmployee.empId,
          username: newEmployee.username,
          name: newEmployee.name,
          email: newEmployee.email,
          phone: newEmployee.phone,
          department: newEmployee.department,
          designation: newEmployee.designation,
          employmentType: newEmployee.employmentType,
          salary: newEmployee.salary,
          workingStatus: newEmployee.workingStatus,
          photo: newEmployee.photo,
        },
      });

    } catch (error) {
      console.error("Error adding employee:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  },

  // ────────────────────────────────────────────────
  // Get basic list
  // ────────────────────────────────────────────────
  getEmployeeBasicList: async (req, res) => {
    try {
      if (!req.user || !["admin", "employee"].includes(req.user.role)) {
        return res.status(403).json({ success: false, message: "Access denied" });
      }

      const [employees, rawDesignations] = await Promise.all([
        Employee.find({ role: "employee" }, { _id: 1, name: 1, department: 1, isHr: 1, designation: 1, role: 1 }).sort({ name: 1 }),
        Employee.distinct("designation", { role: "employee" }),
      ]);

      const map = new Map();
      (rawDesignations || []).forEach((d) => {
        if (!d || typeof d !== "string" || !d.trim()) return;
        let str = d.trim();
        let key = str.toLowerCase();
        if (key === "mern stack developer" || key === "mern stack") {
          key = "mern stack developer";
          str = "MERN Stack Developer";
        } else if (key === "technical support and api integration" || key === "techical support and api integration") {
          key = "technical support and api integration";
          str = "Technical Support And API Integration";
        } else if (key === "business operation" || key === "business operation executive") {
          key = str.toLowerCase();
        }
        if (!map.has(key)) {
          map.set(key, str);
        }
      });

      const departments = Array.from(map.values()).sort();

      return res.status(200).json({ success: true, count: employees.length, employees, departments });

    } catch (error) {
      console.error("Error fetching basic employee list:", error);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  },

  // ────────────────────────────────────────────────
  // Get all employees
  // ────────────────────────────────────────────────
  getAllEmployees: async (req, res) => {
    try {

      if (!["admin", "employee"].includes(req.user?.role)) {
        return res.status(403).json({ message: "Access denied" });
      }

      let roleFilter = { $in: ["employee", "admin"] };
      if (req.query.role) {
        roleFilter = req.query.role;
      } else if (req.query.excludeAdmin === "true") {
        roleFilter = "employee";
      }

      const employees = await Employee.find(
        { role: roleFilter, workingStatus: true },
        { passwordHash: 0, __v: 0 }
      )
        .sort({ createdAt: -1 })
        .lean();

      const result = await Promise.all(
        employees.map(async (emp) => {

          let avatar = null;

          if (emp.photo) {
            try {
              avatar = await getCachedSignedUrl(emp.photo);
            } catch {
              avatar = "/avatar.png";
            }
          }

          return {
            ...emp,
            avatar: avatar   // ✅ FIX HERE
          };

        })
      );

      return res.status(200).json({
        success: true,
        count: result.length,
        data: result
      });

    } catch (error) {
      console.error("Error fetching employees:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  },

  // ────────────────────────────────────────────────
  // Get single employee by ID
  // ────────────────────────────────────────────────
  getEmployeeById: async (req, res) => {
    try {
      if (!["admin", "employee"].includes(req.user?.role)) {
        return res.status(403).json({ message: "Access denied" });
      }

      const { id } = req.params;
      const employee = await Employee.findById(id, { passwordHash: 0, __v: 0 });

      if (!employee) {
        return res.status(404).json({ success: false, message: "Employee not found" });
      }

      return res.status(200).json({ success: true, data: employee });

    } catch (error) {
      console.error("Error fetching employee by id:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  },



  // ────────────────────────────────────────────────
  // First Login / Expired Password / Expiring Soon Reset
  // ────────────────────────────────────────────────
  resetFirstLoginPassword: async (req, res) => {
    try {
      const userId = req.user.id;
      const { newPassword } = req.body;

      if (!newPassword) {
        return res.status(400).json({ message: "New password is required" });
      }

      const errors = validatePassword(newPassword);
      if (errors.length > 0) {
        return res.status(400).json({ message: errors.join(", ") });
      }

      const user = await Employee.findById(userId);

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      const now = new Date();
      const minAge = 2 * 24 * 60 * 60 * 1000;

      if (!user.isFirstLogin) {
        if (user.passwordChangedAt && (Date.now() - user.passwordChangedAt.getTime()) < minAge) {
          return res.status(400).json({
            message: "Password cannot be changed within 2 days of last change",
          });
        }
      }

      const isFirstLogin = user.isFirstLogin;
      const isExpiredPassword = user.passwordExpiresAt && user.passwordExpiresAt < now;
      const diffDays = user.passwordExpiresAt
        ? Math.ceil((user.passwordExpiresAt - now) / (1000 * 60 * 60 * 24))
        : null;
      const isExpiringSoon = diffDays !== null && diffDays <= 7;

      if (!isFirstLogin && !isExpiredPassword && !isExpiringSoon) {
        return res.status(403).json({
          message: "Password reset not allowed"
        });
      }

      for (let oldHash of user.passwordHistory || []) {
        const isSame = await bcrypt.compare(newPassword, oldHash);
        if (isSame) {
          return res.status(400).json({ message: "Cannot reuse last 5 passwords" });
        }
      }

      const hashedPassword = await bcrypt.hash(newPassword, 10);
      let history = user.passwordHistory || [];
      history.unshift(hashedPassword);
      history = history.slice(0, 5);

      await Employee.findByIdAndUpdate(userId, {
        $set: {
          passwordHash: hashedPassword,
          passwordHistory: history,
          passwordChangedAt: new Date(),
          passwordExpiresAt: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000)
        },
        $unset: {
          isFirstLogin: 1,
          firstLoginAt: 1
        }
      });

      // await user.save({ validateModifiedOnly: true });

      createLog({
        category: "auth",
        referenceId: user._id,
        description: `${user.name} (${user.empId || user.email}) updated password successfully`,
      });

      return res.status(200).json({ message: "Password updated successfully" });

    } catch (error) {
      console.error("Reset First Login Error:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  },

  // ────────────────────────────────────────────────
  // ────────────────────────────────────────────────
  // POST — Add Salary Details
  // ────────────────────────────────────────────────
  addSalaryDetails: async (req, res) => {
    try {
      const {
        empId,
        fromDate,
        toDate,
        basicSalary,
        allowances = [],
        financialYear: passedFY,
      } = req.body;

      // ── Validate required fields ──────────────────────────────
      if (!empId || !fromDate || basicSalary === undefined) {
        return res.status(400).json({
          message: "Employee ID, From Date, and Basic Salary are required",
        });
      }

      // ── File uploads ──────────────────────────────────────────
      const files = req.files || [];
      const incrementLetterFile = files.find(f => f.fieldname === "incrementLetter");
      const performanceFormFile = files.find(f => f.fieldname === "performanceForm");

      // ── Validate dates ────────────────────────────────────────
      const from = new Date(fromDate);
      if (isNaN(from.getTime())) {
        return res.status(400).json({ message: "Invalid From Date format" });
      }

      let to = null;
      if (toDate) {
        to = new Date(toDate);
        if (isNaN(to.getTime())) {
          return res.status(400).json({ message: "Invalid To Date format" });
        }
      }

      // ── Normalize basicSalary ──────────────────────────────────
      const basic = Number(basicSalary);
      if (isNaN(basic) || basic < 0) {
        return res.status(400).json({ message: "Basic Salary must be a valid non-negative number" });
      }

      // ── Process Allowances (support JSON string from FormData) ──
      let rawAllowances = allowances;
      if (typeof rawAllowances === "string") {
        try {
          rawAllowances = JSON.parse(rawAllowances);
        } catch {
          rawAllowances = [];
        }
      }
      const processedAllowances = (rawAllowances || []).map(a => ({
        label: a.label || "Allowance",
        value: Number(a.value) || 0
      }));

      const totalAllowances = processedAllowances.reduce((sum, a) => sum + a.value, 0);
      const totalSalary = basic + totalAllowances;

      // ── Find EmployeeDetails ───────────────────────────────────
      const isObjectId = mongoose.Types.ObjectId.isValid(empId);
      const employeeDetails = await EmployeeDetails.findOne(
        isObjectId ? { empId } : { empIdString: empId }
      );

      if (!employeeDetails) {
        return res.status(404).json({ message: "Employee profile details not found." });
      }

      if (!employeeDetails.salaryHistory) {
        employeeDetails.salaryHistory = [];
      }

      // ── Increment Documents Handling ─────
      const financialYear = normalizeFY(passedFY || computeFinancialYear(from));
      const cleanFY = financialYear.replace(/[^a-zA-Z0-9_-]/g, "_");
      const empFolder = employeeDetails.empIdString || String(empId);

      const existingDocIdx = (employeeDetails.incrementDocuments || []).findIndex(
        d => normalizeFY(d.financialYear) === normalizeFY(financialYear)
      );
      const existingDoc = existingDocIdx !== -1 ? employeeDetails.incrementDocuments[existingDocIdx] : null;

      if (!incrementLetterFile && !existingDoc?.incrementLetter?.fileKey) {
        return res.status(400).json({
          message: "Please upload the Increment Letter.",
        });
      }

      let incrementLetterData = existingDoc?.incrementLetter || null;
      if (incrementLetterFile) {
        if (existingDoc?.incrementLetter?.fileKey) {
          await deleteFromS3(existingDoc.incrementLetter.fileKey).catch(err => console.error("Old incrementLetter S3 delete error:", err));
        }

        const extInc = (incrementLetterFile.originalname.split(".").pop() || "pdf").toLowerCase();
        const incKey = `IncrementDocs/${empFolder}/${cleanFY}_IncrementLetter.${extInc}`;
        await uploadToS3(incrementLetterFile.buffer, incKey, incrementLetterFile.mimetype);

        try {
          const redisClient = require("../utilities/redis");
          await redisClient.del(`s3url:${incKey}`);
          if (existingDoc?.incrementLetter?.fileKey && existingDoc.incrementLetter.fileKey !== incKey) {
            await redisClient.del(`s3url:${existingDoc.incrementLetter.fileKey}`);
          }
        } catch { }

        incrementLetterData = {
          fileKey: incKey,
          fileName: incrementLetterFile.originalname,
          fileType: incrementLetterFile.mimetype,
          uploadedAt: new Date()
        };
      }

      let performanceFormData = null;
      if (performanceFormFile) {
        if (existingDoc?.performanceForm?.fileKey) {
          await deleteFromS3(existingDoc.performanceForm.fileKey).catch(err => console.error("Old performanceForm S3 delete error:", err));
        }

        const extPerf = (performanceFormFile.originalname.split(".").pop() || "pdf").toLowerCase();
        const perfKey = `IncrementDocs/${empFolder}/${cleanFY}_PerformanceForm.${extPerf}`;
        await uploadToS3(performanceFormFile.buffer, perfKey, performanceFormFile.mimetype);

        try {
          const redisClient = require("../utilities/redis");
          await redisClient.del(`s3url:${perfKey}`);
          if (existingDoc?.performanceForm?.fileKey && existingDoc.performanceForm.fileKey !== perfKey) {
            await redisClient.del(`s3url:${existingDoc.performanceForm.fileKey}`);
          }
        } catch { }

        performanceFormData = {
          fileKey: perfKey,
          fileName: performanceFormFile.originalname,
          fileType: performanceFormFile.mimetype,
          uploadedAt: new Date()
        };
      } else if (existingDoc?.performanceForm?.fileKey) {
        performanceFormData = existingDoc.performanceForm;
      }

      // ── Build & push new entry ─────────────────────────────────
      const newSalaryEntry = {
        fromDate: from,
        toDate: to,
        basicSalary: basic,
        allowances: processedAllowances,
        totalSalary,
        addedAt: new Date(),
      };

      employeeDetails.salaryHistory.push(newSalaryEntry);
      const savedSalaryId = employeeDetails.salaryHistory[employeeDetails.salaryHistory.length - 1]._id;

      // ── Store Year-Wise in EmployeeDetails.incrementDocuments ──
      if (!employeeDetails.incrementDocuments) {
        employeeDetails.incrementDocuments = [];
      }

      const docObj = {
        financialYear,
        incrementLetter: incrementLetterData,
        salaryId: savedSalaryId,
        uploadedAt: new Date()
      };
      if (performanceFormData) {
        docObj.performanceForm = performanceFormData;
      } else if (existingDocIdx !== -1 && employeeDetails.incrementDocuments[existingDocIdx].performanceForm?.fileKey) {
        docObj.performanceForm = employeeDetails.incrementDocuments[existingDocIdx].performanceForm;
      }

      if (existingDocIdx !== -1) {
        employeeDetails.incrementDocuments[existingDocIdx] = docObj;
        if (!docObj.performanceForm) {
          employeeDetails.incrementDocuments[existingDocIdx].performanceForm = undefined;
        }
      } else {
        employeeDetails.incrementDocuments.push(docObj);
      }

      // Update top-level salary to the most recent period (by fromDate)
      const latest = [...employeeDetails.salaryHistory].sort((a, b) => new Date(b.fromDate) - new Date(a.fromDate))[0];
      employeeDetails.salary = latest.totalSalary;
      employeeDetails.lastUpdatedAt = new Date();

      await employeeDetails.save({ validateBeforeSave: false });

      return res.status(201).json({
        message: "Salary details added successfully",
        data: employeeDetails.salaryHistory[employeeDetails.salaryHistory.length - 1],
      });

    } catch (error) {
      console.error("Error adding salary details:", error);
      return res.status(500).json({ message: "Internal server error", error: error.message });
    }
  },

  // ────────────────────────────────────────────────
  // GET — Get All Salary Details for an Employee
  // ────────────────────────────────────────────────
  getSalaryDetails: async (req, res) => {
    try {
      const { empId } = req.params;
      if (!empId || empId === "undefined") {
        return res.status(400).json({ message: "Employee ID is required" });
      }

      const isObjectId = mongoose.Types.ObjectId.isValid(empId);
      const employeeDetails = await EmployeeDetails.findOne(
        isObjectId ? { empId } : { empIdString: empId }
      ).select("empId empIdString salaryHistory salary bankName accountHolder accountNumber ifscCode branch bankHistory lastBankUpdate dateJoined createdAt");

      if (!employeeDetails) {
        return res.status(404).json({ message: "Salary details not configured for this employee" });
      }

      const sortedHistory = [...(employeeDetails.salaryHistory || [])].sort(
        (a, b) => new Date(b.fromDate) - new Date(a.fromDate)
      );

      const rawHistory = employeeDetails.bankHistory || [];
      const decryptedHistory = rawHistory.map(bh => {
        const obj = bh.toObject ? bh.toObject() : bh;
        return {
          ...obj,
          accountNumber: decrypt(obj.accountNumber) || obj.accountNumber
        };
      });

      // Sort history descending by fromDate
      const sortedBankHistory = [...decryptedHistory].sort(
        (a, b) => new Date(b.fromDate) - new Date(a.fromDate)
      );

      // Active bank details is the entry where toDate is null/undefined, or the most recent one
      const activeBank = sortedBankHistory.find(bh => !bh.toDate) || sortedBankHistory[0] || {};

      return res.status(200).json({
        message: "Salary details fetched successfully",
        empId: employeeDetails.empIdString || empId,
        currentSalary: employeeDetails.salary || 0,
        totalRecords: sortedHistory.length,
        data: sortedHistory,
        bankDetails: {
          bankName: activeBank.bankName || "",
          accountHolder: activeBank.accountHolder || "",
          accountNumber: activeBank.accountNumber || "",
          ifscCode: activeBank.ifscCode || "",
          branch: activeBank.branch || "",
          lastBankUpdate: employeeDetails.lastBankUpdate || "",
          createdAt: employeeDetails.createdAt || "",
          bankHistory: decryptedHistory
        }
      });
    } catch (error) {
      console.error("Error fetching salary details:", error);
      return res.status(500).json({ message: "Internal server error", error: error.message });
    }
  },

  // ────────────────────────────────────────────────
  // PUT — Update a Salary Entry
  // ────────────────────────────────────────────────
  updateSalaryDetails: async (req, res) => {
    try {
      const { empId, salaryId } = req.params;
      const {
        fromDate,
        toDate,
        basicSalary,
        allowances = [],
        financialYear: passedFY,
      } = req.body;

      const isObjectId = mongoose.Types.ObjectId.isValid(empId);
      const employeeDetails = await EmployeeDetails.findOne(
        isObjectId ? { empId } : { empIdString: empId }
      );

      if (!employeeDetails) {
        return res.status(404).json({ message: "Employee details not found" });
      }

      const entryIndex = employeeDetails.salaryHistory.findIndex(
        (entry) => entry._id.toString() === salaryId
      );

      if (entryIndex === -1) {
        return res.status(404).json({ message: "Salary entry not found" });
      }

      const existing = employeeDetails.salaryHistory[entryIndex];
      const from = fromDate ? new Date(fromDate) : existing.fromDate;
      const to = toDate ? new Date(toDate) : existing.toDate;
      const basic = basicSalary !== undefined ? Number(basicSalary) : existing.basicSalary;

      let rawAllowances = allowances;
      if (typeof rawAllowances === "string") {
        try {
          rawAllowances = JSON.parse(rawAllowances);
        } catch {
          rawAllowances = [];
        }
      }

      const processedAllowances = (rawAllowances || []).map(a => ({
        label: a.label || "Allowance",
        value: Number(a.value) || 0
      }));

      const totalAllowances = processedAllowances.reduce((sum, a) => sum + a.value, 0);
      const totalSalary = basic + totalAllowances;

      // Check if files are uploaded
      const files = req.files || [];
      const incrementLetterFile = files.find(f => f.fieldname === "incrementLetter");
      const performanceFormFile = files.find(f => f.fieldname === "performanceForm");

      const financialYear = normalizeFY(passedFY || computeFinancialYear(from));

      // If incrementLetter or performanceForm is uploaded, save into employeeDetails.incrementDocuments
      if (incrementLetterFile || performanceFormFile) {
        if (!employeeDetails.incrementDocuments) {
          employeeDetails.incrementDocuments = [];
        }

        const existingDocIdx = employeeDetails.incrementDocuments.findIndex(
          d => normalizeFY(d.financialYear) === normalizeFY(financialYear)
        );
        const existingDoc = existingDocIdx !== -1 ? employeeDetails.incrementDocuments[existingDocIdx] : null;

        const cleanFY = financialYear.replace(/[^a-zA-Z0-9_-]/g, "_");
        const empFolder = employeeDetails.empIdString || String(empId);

        let incrementLetterData = null;
        if (incrementLetterFile) {
          if (existingDoc?.incrementLetter?.fileKey) {
            await deleteFromS3(existingDoc.incrementLetter.fileKey).catch(err => console.error("Old incrementLetter S3 delete error:", err));
          }

          const extInc = (incrementLetterFile.originalname.split(".").pop() || "pdf").toLowerCase();
          const incKey = `IncrementDocs/${empFolder}/${cleanFY}_IncrementLetter.${extInc}`;
          await uploadToS3(incrementLetterFile.buffer, incKey, incrementLetterFile.mimetype);

          try {
            const redisClient = require("../utilities/redis");
            await redisClient.del(`s3url:${incKey}`);
            if (existingDoc?.incrementLetter?.fileKey && existingDoc.incrementLetter.fileKey !== incKey) {
              await redisClient.del(`s3url:${existingDoc.incrementLetter.fileKey}`);
            }
          } catch { }

          incrementLetterData = {
            fileKey: incKey,
            fileName: incrementLetterFile.originalname,
            fileType: incrementLetterFile.mimetype,
            uploadedAt: new Date()
          };
        }

        let performanceFormData = null;
        if (performanceFormFile) {
          if (existingDoc?.performanceForm?.fileKey) {
            await deleteFromS3(existingDoc.performanceForm.fileKey).catch(err => console.error("Old performanceForm S3 delete error:", err));
          }

          const extPerf = (performanceFormFile.originalname.split(".").pop() || "pdf").toLowerCase();
          const perfKey = `IncrementDocs/${empFolder}/${cleanFY}_PerformanceForm.${extPerf}`;
          await uploadToS3(performanceFormFile.buffer, perfKey, performanceFormFile.mimetype);

          try {
            const redisClient = require("../utilities/redis");
            await redisClient.del(`s3url:${perfKey}`);
            if (existingDoc?.performanceForm?.fileKey && existingDoc.performanceForm.fileKey !== perfKey) {
              await redisClient.del(`s3url:${existingDoc.performanceForm.fileKey}`);
            }
          } catch { }

          performanceFormData = {
            fileKey: perfKey,
            fileName: performanceFormFile.originalname,
            fileType: performanceFormFile.mimetype,
            uploadedAt: new Date()
          };
        }

        if (existingDocIdx !== -1) {
          const existingDoc = employeeDetails.incrementDocuments[existingDocIdx];
          const updatedDoc = {
            ...existingDoc.toObject(),
            financialYear,
            incrementLetter: incrementLetterData || existingDoc.incrementLetter,
            salaryId: existing._id,
            uploadedAt: new Date()
          };
          if (performanceFormData) {
            updatedDoc.performanceForm = performanceFormData;
          } else if (existingDoc.performanceForm?.fileKey) {
            updatedDoc.performanceForm = existingDoc.performanceForm;
          } else {
            updatedDoc.performanceForm = undefined;
          }
          employeeDetails.incrementDocuments[existingDocIdx] = updatedDoc;
          if (!updatedDoc.performanceForm) {
            employeeDetails.incrementDocuments[existingDocIdx].performanceForm = undefined;
          }
        } else if (incrementLetterData) {
          const docObj = {
            financialYear,
            incrementLetter: incrementLetterData,
            salaryId: existing._id,
            uploadedAt: new Date()
          };
          if (performanceFormData) {
            docObj.performanceForm = performanceFormData;
          }
          employeeDetails.incrementDocuments.push(docObj);
        }
      }

      employeeDetails.salaryHistory[entryIndex] = {
        ...existing.toObject(),
        fromDate: from,
        toDate: to,
        basicSalary: basic,
        allowances: processedAllowances,
        totalSalary,
      };

      const latest = [...employeeDetails.salaryHistory].sort((a, b) => new Date(b.fromDate) - new Date(a.fromDate))[0];
      employeeDetails.salary = latest.totalSalary;
      employeeDetails.lastUpdatedAt = new Date();

      await employeeDetails.save({ validateBeforeSave: false });

      return res.status(200).json({
        message: "Salary details updated successfully",
        data: employeeDetails.salaryHistory[entryIndex],
      });
    } catch (error) {
      console.error("Error updating salary details:", error);
      return res.status(500).json({ message: "Internal server error", error: error.message });
    }
  },

  // ────────────────────────────────────────────────
  // DELETE — Delete a Salary Entry
  // ────────────────────────────────────────────────
  deleteSalaryDetails: async (req, res) => {
    try {
      const { empId, salaryId } = req.params;

      // ── Find EmployeeDetails ───────────────────────────────────
      const mongoose = require("mongoose");
      const isObjectId = mongoose.Types.ObjectId.isValid(empId);

      const employeeDetails = await EmployeeDetails.findOne(
        isObjectId ? { empId } : { empIdString: empId }
      );

      if (!employeeDetails) {
        return res.status(404).json({ message: "Employee details not found" });
      }

      // ── Find the entry to delete ───────────────────────────────
      const entryExists = employeeDetails.salaryHistory.some(
        (entry) => entry._id.toString() === salaryId
      );

      if (!entryExists) {
        return res.status(404).json({ message: "Salary entry not found" });
      }

      // ── Remove linked increment documents from S3 and DB if any ──
      const linkedDoc = employeeDetails.incrementDocuments?.find(
        (doc) => doc.salaryId && doc.salaryId.toString() === salaryId
      );
      if (linkedDoc) {
        if (linkedDoc.incrementLetter?.fileKey) {
          await deleteFromS3(linkedDoc.incrementLetter.fileKey).catch((err) =>
            console.error("Error deleting linked increment letter from S3:", err)
          );
        }
        if (linkedDoc.performanceForm?.fileKey) {
          await deleteFromS3(linkedDoc.performanceForm.fileKey).catch((err) =>
            console.error("Error deleting linked performance form from S3:", err)
          );
        }
        await EmployeeDetails.updateOne(
          isObjectId ? { empId } : { empIdString: empId },
          { $pull: { incrementDocuments: { _id: linkedDoc._id } } }
        );
      }

      // ── Remove using $pull ─────────────────────────────────────
      await EmployeeDetails.updateOne(
        isObjectId ? { empId } : { empIdString: empId },
        { $pull: { salaryHistory: { _id: salaryId } } }
      );

      // ── Refresh and update top-level salary ───────────────────
      const updated = await EmployeeDetails.findOne(
        isObjectId ? { empId } : { empIdString: empId }
      );

      if (updated.salaryHistory.length > 0) {
        const latest = [...updated.salaryHistory].sort(
          (a, b) => new Date(b.fromDate) - new Date(a.fromDate)
        )[0];
        updated.salary = latest.totalSalary;
      } else {
        updated.salary = 0; // no salary entries left
      }

      updated.lastUpdatedAt = new Date();
      await updated.save({ validateBeforeSave: false });

      return res.status(200).json({
        message: "Salary entry deleted successfully",
      });

    } catch (error) {
      console.error("Error deleting salary entry:", error);
      return res.status(500).json({ message: "Internal server error", error: error.message });
    }
  },

  // ────────────────────────────────────────────────
  // INCREMENT DOCUMENTS — Upload Increment Documents
  // ────────────────────────────────────────────────
  uploadIncrementDocuments: async (req, res) => {
    try {
      const { empId, financialYear: passedFY, fromDate, salaryId } = req.body;
      if (!empId) {
        return res.status(400).json({ message: "Employee ID is required" });
      }

      const files = req.files || [];
      const incrementLetterFile = files.find(f => f.fieldname === "incrementLetter");
      const performanceFormFile = files.find(f => f.fieldname === "performanceForm");

      const isObjectId = mongoose.Types.ObjectId.isValid(empId);
      const employeeDetails = await EmployeeDetails.findOne(
        isObjectId ? { empId } : { empIdString: empId }
      );

      if (!employeeDetails) {
        return res.status(404).json({ message: "Employee details not found" });
      }

      const financialYear = normalizeFY(passedFY || computeFinancialYear(fromDate || new Date()));
      const cleanFY = financialYear.replace(/[^a-zA-Z0-9_-]/g, "_");
      const empFolder = employeeDetails.empIdString || String(empId);

      const existingDocIdx = (employeeDetails.incrementDocuments || []).findIndex(
        d => normalizeFY(d.financialYear) === normalizeFY(financialYear)
      );
      const existingDoc = existingDocIdx !== -1 ? employeeDetails.incrementDocuments[existingDocIdx] : null;

      if (!incrementLetterFile && !existingDoc?.incrementLetter?.fileKey) {
        return res.status(400).json({
          message: "Please upload the Increment Letter.",
        });
      }

      let incrementLetterData = existingDoc?.incrementLetter || null;
      if (incrementLetterFile) {
        if (existingDoc?.incrementLetter?.fileKey) {
          await deleteFromS3(existingDoc.incrementLetter.fileKey).catch(err => console.error("Old incrementLetter S3 delete error:", err));
        }

        const extInc = (incrementLetterFile.originalname.split(".").pop() || "pdf").toLowerCase();
        const incKey = `IncrementDocs/${empFolder}/${cleanFY}_IncrementLetter.${extInc}`;
        await uploadToS3(incrementLetterFile.buffer, incKey, incrementLetterFile.mimetype);

        try {
          const redisClient = require("../utilities/redis");
          await redisClient.del(`s3url:${incKey}`);
          if (existingDoc?.incrementLetter?.fileKey && existingDoc.incrementLetter.fileKey !== incKey) {
            await redisClient.del(`s3url:${existingDoc.incrementLetter.fileKey}`);
          }
        } catch { }

        incrementLetterData = {
          fileKey: incKey,
          fileName: incrementLetterFile.originalname,
          fileType: incrementLetterFile.mimetype,
          uploadedAt: new Date()
        };
      }

      let performanceFormData = null;
      if (performanceFormFile) {
        if (existingDoc?.performanceForm?.fileKey) {
          await deleteFromS3(existingDoc.performanceForm.fileKey).catch(err => console.error("Old performanceForm S3 delete error:", err));
        }

        const extPerf = (performanceFormFile.originalname.split(".").pop() || "pdf").toLowerCase();
        const perfKey = `IncrementDocs/${empFolder}/${cleanFY}_PerformanceForm.${extPerf}`;
        await uploadToS3(performanceFormFile.buffer, perfKey, performanceFormFile.mimetype);

        try {
          const redisClient = require("../utilities/redis");
          await redisClient.del(`s3url:${perfKey}`);
          if (existingDoc?.performanceForm?.fileKey && existingDoc.performanceForm.fileKey !== perfKey) {
            await redisClient.del(`s3url:${existingDoc.performanceForm.fileKey}`);
          }
        } catch { }

        performanceFormData = {
          fileKey: perfKey,
          fileName: performanceFormFile.originalname,
          fileType: performanceFormFile.mimetype,
          uploadedAt: new Date()
        };
      }

      if (!employeeDetails.incrementDocuments) {
        employeeDetails.incrementDocuments = [];
      }

      // Link to matching salary record if available
      let targetSalaryId = salaryId || null;
      if (!targetSalaryId && Array.isArray(employeeDetails.salaryHistory)) {
        const matchedSalary = employeeDetails.salaryHistory.find(s => {
          const sFY = computeFinancialYear(s.fromDate);
          return normalizeFY(sFY) === normalizeFY(financialYear);
        });
        if (matchedSalary) {
          targetSalaryId = matchedSalary._id;
        }
      }

      const docObj = {
        financialYear,
        incrementLetter: incrementLetterData,
        salaryId: targetSalaryId,
        uploadedAt: new Date()
      };
      if (performanceFormData) {
        docObj.performanceForm = performanceFormData;
      } else if (existingDocIdx !== -1 && employeeDetails.incrementDocuments[existingDocIdx].performanceForm?.fileKey) {
        docObj.performanceForm = employeeDetails.incrementDocuments[existingDocIdx].performanceForm;
      }

      if (existingDocIdx !== -1) {
        employeeDetails.incrementDocuments[existingDocIdx] = docObj;
        if (!docObj.performanceForm) {
          employeeDetails.incrementDocuments[existingDocIdx].performanceForm = undefined;
        }
      } else {
        employeeDetails.incrementDocuments.push(docObj);
      }

      await employeeDetails.save({ validateBeforeSave: false });

      return res.status(200).json({
        success: true,
        message: "Increment documents uploaded successfully",
        data: docObj
      });
    } catch (error) {
      console.error("Error uploading increment documents:", error);
      return res.status(500).json({ message: "Internal server error", error: error.message });
    }
  },

  // ────────────────────────────────────────────────
  // INCREMENT DOCUMENTS — Get Year-Wise Documents
  // ────────────────────────────────────────────────
  getIncrementDocuments: async (req, res) => {
    try {
      const { empId } = req.params;
      if (!empId) {
        return res.status(400).json({ message: "Employee ID is required" });
      }

      // Security: regular employee can only view their own documents
      const isAdmin = req.user?.role === "admin" || req.user?.role === "superadmin" || Boolean(req.user?.isHr);
      if (!isAdmin) {
        const userEmpId = String(req.user._id);
        const userEmpCode = req.user.empId ? String(req.user.empId) : "";
        if (empId !== userEmpId && empId !== userEmpCode) {
          return res.status(403).json({ success: false, message: "Unauthorized: You can only view your own increment documents" });
        }
      }

      const isObjectId = mongoose.Types.ObjectId.isValid(empId);
      let employeeDetails = await EmployeeDetails.findOne(
        isObjectId ? { $or: [{ empId }, { empIdString: empId }, { _id: empId }] } : { empIdString: empId }
      ).select("empId empIdString incrementDocuments");

      if (!employeeDetails && isObjectId) {
        employeeDetails = await EmployeeDetails.findById(empId).select("empId empIdString incrementDocuments");
      }

      if (!employeeDetails) {
        const Employee = require("../Models/Employee");
        const empDoc = await Employee.findOne(
          isObjectId ? { $or: [{ _id: empId }, { empId }] } : { empId: empId }
        );
        if (empDoc) {
          employeeDetails = await EmployeeDetails.findOne({ empId: empDoc._id }).select("empId empIdString incrementDocuments");
        }
      }

      if (!employeeDetails) {
        return res.status(404).json({ message: "Employee details not found" });
      }

      const docs = employeeDetails.incrementDocuments || [];

      // ── Filter by financial year based on query params ──
      const { filter = "current", fromDate, toDate } = req.query;

      const getCurrentFYStartYear = () => {
        const now = new Date();
        const month = now.getMonth() + 1; // 1-based
        return month >= 4 ? now.getFullYear() : now.getFullYear() - 1;
      };

      const getFYStartYearFromDate = (dateStr) => {
        const d = new Date(dateStr);
        const month = d.getMonth() + 1;
        return month >= 4 ? d.getFullYear() : d.getFullYear() - 1;
      };

      const getFYStartYearFromFYStr = (fyStr) => {
        const normalized = normalizeFY(fyStr);
        const m = normalized.match(/^(\d{4})/);
        return m ? parseInt(m[1]) : NaN;
      };

      let filteredDocs = docs;
      if (filter === "current") {
        const currentFYStart = getCurrentFYStartYear();
        filteredDocs = docs.filter((d) => getFYStartYearFromFYStr(d.financialYear) === currentFYStart);
      } else if (filter === "last3") {
        const currentFYStart = getCurrentFYStartYear();
        filteredDocs = docs.filter((d) => {
          const fy = getFYStartYearFromFYStr(d.financialYear);
          return fy >= currentFYStart - 2 && fy <= currentFYStart;
        });
      } else if (filter === "custom" && fromDate && toDate) {
        const fromFYStart = getFYStartYearFromDate(fromDate);
        const toFYStart = getFYStartYearFromDate(toDate);
        filteredDocs = docs.filter((d) => {
          const fy = getFYStartYearFromFYStr(d.financialYear);
          return fy >= fromFYStart && fy <= toFYStart;
        });
      }
      // if filter === "all" or unknown → return all docs (no filter)

      const populatedDocs = await Promise.all(
        filteredDocs.map(async (doc) => {
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

      // Sort by financial year descending
      populatedDocs.sort((a, b) => (b.financialYear || "").localeCompare(a.financialYear || ""));

      return res.status(200).json({
        success: true,
        data: populatedDocs
      });
    } catch (error) {
      console.error("Error fetching increment documents:", error);
      return res.status(500).json({ message: "Internal server error", error: error.message });
    }
  },

  // ────────────────────────────────────────────────
  // INCREMENT DOCUMENTS — Delete Document(s) from S3 and DB
  // ────────────────────────────────────────────────
  deleteIncrementDocuments: async (req, res) => {
    try {
      const { empId, docId } = req.params;
      const { docType } = req.query; // optional: 'incrementLetter' | 'performanceForm' | undefined (both)

      if (!empId || !docId) {
        return res.status(400).json({ success: false, message: "Employee ID and Document ID are required" });
      }

      // Security check: Only Admin can directly delete documents. HR must submit an approval request.
      const isAdmin = req.user?.role === "admin" || req.user?.role === "superadmin";
      if (!isAdmin) {
        return res.status(403).json({
          success: false,
          message: "Unauthorized: Only Admin can directly delete documents. HR must submit an approval request.",
        });
      }

      const isObjectId = mongoose.Types.ObjectId.isValid(empId);
      let employeeDetails = await EmployeeDetails.findOne(
        isObjectId ? { $or: [{ empId }, { empIdString: empId }, { _id: empId }] } : { empIdString: empId }
      );

      if (!employeeDetails && isObjectId) {
        employeeDetails = await EmployeeDetails.findById(empId);
      }

      if (!employeeDetails) {
        const Employee = require("../Models/Employee");
        const emp = await Employee.findOne(
          isObjectId ? { $or: [{ _id: empId }, { empId }] } : { empId: empId }
        );
        if (emp) {
          employeeDetails = await EmployeeDetails.findOne({ empId: emp._id });
        }
      }

      if (!employeeDetails) {
        return res.status(404).json({ success: false, message: "Employee details not found" });
      }

      const docList = employeeDetails.incrementDocuments || [];
      const normalizeFY = (fy) => String(fy || "").replace(/[\u2013\u2014–-]/g, "–").trim();
      const decodedDocId = decodeURIComponent(docId);
      const docIndex = docList.findIndex(
        (d) =>
          (d._id && d._id.toString() === docId) ||
          d.financialYear === docId ||
          d.financialYear === decodedDocId ||
          normalizeFY(d.financialYear) === normalizeFY(docId) ||
          normalizeFY(d.financialYear) === normalizeFY(decodedDocId)
      );

      if (docIndex === -1) {
        return res.status(404).json({ success: false, message: "Increment document record not found" });
      }

      const targetDoc = docList[docIndex];

      if (docType === "incrementLetter") {
        if (targetDoc.incrementLetter?.fileKey) {
          await deleteFromS3(targetDoc.incrementLetter.fileKey).catch((err) =>
            console.error("Error deleting increment letter from S3:", err)
          );
        }
        targetDoc.incrementLetter = { fileKey: null, fileName: null, fileType: null };

        // If performanceForm is also empty, remove the entire record
        if (!targetDoc.performanceForm?.fileKey) {
          employeeDetails.incrementDocuments.splice(docIndex, 1);
        }
      } else if (docType === "performanceForm") {
        if (targetDoc.performanceForm?.fileKey) {
          await deleteFromS3(targetDoc.performanceForm.fileKey).catch((err) =>
            console.error("Error deleting performance form from S3:", err)
          );
        }
        targetDoc.performanceForm = undefined;

        // If incrementLetter is also empty, remove the entire record
        if (!targetDoc.incrementLetter?.fileKey) {
          employeeDetails.incrementDocuments.splice(docIndex, 1);
        }
      } else {
        // Delete both from S3
        if (targetDoc.incrementLetter?.fileKey) {
          await deleteFromS3(targetDoc.incrementLetter.fileKey).catch((err) =>
            console.error("Error deleting increment letter from S3:", err)
          );
        }
        if (targetDoc.performanceForm?.fileKey) {
          await deleteFromS3(targetDoc.performanceForm.fileKey).catch((err) =>
            console.error("Error deleting performance form from S3:", err)
          );
        }

        // Remove entire entry from DB array
        employeeDetails.incrementDocuments.splice(docIndex, 1);
      }

      await employeeDetails.save({ validateBeforeSave: false });

      return res.status(200).json({
        success: true,
        message: "Increment document(s) deleted successfully from database and S3",
        deletedId: docId,
        financialYear: targetDoc.financialYear,
        data: employeeDetails.incrementDocuments,
      });
    } catch (error) {
      console.error("Error deleting increment documents:", error);
      return res.status(500).json({ success: false, message: "Internal server error", error: error.message });
    }
  },

  // ────────────────────────────────────────────────
  // BANK — Update Bank Details with History
  // ────────────────────────────────────────────────
  updateBankDetails: async (req, res) => {
    try {
      const { empId } = req.params;
      const { bankName, accountHolder, accountNumber, ifscCode, branch, toDate, oldFromDate } = req.body;

      console.log(`[UpdateBankDetails] Request for Emp: ${empId}`);

      // ── Validations ──────────────────────────────────────────────
      if (!bankName || !bankName.trim()) {
        return res.status(400).json({ message: "Bank Name is required" });
      }
      if (!accountHolder || !accountHolder.trim()) {
        return res.status(400).json({ message: "Account Holder Name is required" });
      }
      if (!accountNumber || !accountNumber.trim()) {
        return res.status(400).json({ message: "Account Number is required" });
      }
      if (!ifscCode || !ifscCode.trim()) {
        return res.status(400).json({ message: "IFSC Code is required" });
      }

      const mongoose = require("mongoose");
      const employeeDetails = await EmployeeDetails.findOne(
        mongoose.Types.ObjectId.isValid(empId) ? { empId } : { empIdString: empId }
      );

      if (!employeeDetails) {
        console.log(`[UpdateBankDetails] Employee not found: ${empId}`);
        return res.status(404).json({ message: "Employee details not found" });
      }

      // Check if we have active bank details (either in root fields or in bankHistory)
      const hasExistingDetails = !!employeeDetails.accountNumber || (employeeDetails.bankHistory && employeeDetails.bankHistory.length > 0);

      if (hasExistingDetails) {
        console.log(`[UpdateBankDetails] Transitioning/Updating bank details for: ${empId}`);
        const historyToDate = toDate ? new Date(toDate) : new Date();

        // 1. Close the active entry
        if (employeeDetails.bankHistory && employeeDetails.bankHistory.length > 0) {
          const activeEntry = employeeDetails.bankHistory.find(h => !h.toDate);
          if (activeEntry) {
            activeEntry.toDate = historyToDate;
          } else {
            // Fallback if all have toDate: set the latest one's toDate
            const latest = [...employeeDetails.bankHistory].sort((a, b) => new Date(b.fromDate) - new Date(a.fromDate))[0];
            if (latest) latest.toDate = historyToDate;
          }
        } else {
          // Legacy support: root fields exist but history is empty. Archive root fields.
          const legacyEntry = {
            bankName: employeeDetails.bankName,
            accountHolder: employeeDetails.accountHolder,
            accountNumber: employeeDetails.accountNumber,
            ifscCode: employeeDetails.ifscCode,
            branch: employeeDetails.branch,
            fromDate: oldFromDate ? new Date(oldFromDate) : (employeeDetails.lastBankUpdate || employeeDetails.createdAt || new Date()),
            toDate: historyToDate
          };
          employeeDetails.bankHistory.push(legacyEntry);
        }

        // 2. Add the new active entry
        let finalEncryptedAccountNumber;
        if (accountNumber && accountNumber.includes("X")) {
          const activeEntry = employeeDetails.bankHistory.find(h => h.toDate && h.toDate.getTime() === historyToDate.getTime());
          finalEncryptedAccountNumber = activeEntry ? activeEntry.accountNumber : employeeDetails.accountNumber;
        } else {
          finalEncryptedAccountNumber = encrypt(accountNumber.trim());
        }

        const nextFromDate = req.body.fromDate ? new Date(req.body.fromDate) : new Date();
        const nextDay = new Date(historyToDate);
        nextDay.setDate(nextDay.getDate() + 1);
        nextDay.setHours(0, 0, 0, 0);
        employeeDetails.lastBankUpdate = nextDay;

        employeeDetails.bankHistory.push({
          bankName: bankName.trim(),
          accountHolder: accountHolder.trim(),
          accountNumber: finalEncryptedAccountNumber,
          ifscCode: ifscCode.trim().toUpperCase(),
          branch: (branch || "").trim(),
          fromDate: nextFromDate,
          toDate: null
        });

      } else {
        console.log(`[UpdateBankDetails] First time bank setup for: ${empId}`);
        employeeDetails.lastBankUpdate = new Date();

        // For the first entry in bank history, take their joining date
        const joiningDate = employeeDetails.dateJoined || employeeDetails.createdAt || new Date();
        employeeDetails.bankHistory.push({
          bankName: bankName.trim(),
          accountHolder: accountHolder.trim(),
          accountNumber: encrypt(accountNumber.trim()),
          ifscCode: ifscCode.trim().toUpperCase(),
          branch: (branch || "").trim(),
          fromDate: joiningDate,
          toDate: null
        });
      }

      // Unset deprecated root fields to avoid storing separately
      employeeDetails.bankName = undefined;
      employeeDetails.accountHolder = undefined;
      employeeDetails.accountNumber = undefined;
      employeeDetails.ifscCode = undefined;
      employeeDetails.branch = undefined;

      console.log(`[UpdateBankDetails] Saving document for: ${empId}`);
      await employeeDetails.save({ validateBeforeSave: false });

      const decryptedHistory = (employeeDetails.bankHistory || []).map(bh => {
        const obj = bh.toObject ? bh.toObject() : bh;
        return {
          ...obj,
          accountNumber: decrypt(obj.accountNumber) || obj.accountNumber
        };
      });

      // Find active entry to return
      const sortedBankHistory = [...decryptedHistory].sort(
        (a, b) => new Date(b.fromDate) - new Date(a.fromDate)
      );
      const activeBank = sortedBankHistory.find(bh => !bh.toDate) || sortedBankHistory[0] || {};

      return res.json({
        message: "Bank details updated successfully",
        data: {
          bankName: activeBank.bankName || "",
          accountHolder: activeBank.accountHolder || "",
          accountNumber: activeBank.accountNumber || "",
          ifscCode: activeBank.ifscCode || "",
          branch: activeBank.branch || "",
          lastBankUpdate: employeeDetails.lastBankUpdate,
          bankHistory: decryptedHistory
        }
      });

    } catch (error) {
      console.error("Error updating bank details:", error);
      return res.status(500).json({
        message: "Internal server error",
        error: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  },

  // ────────────────────────────────────────────────
  // DELETE — Remove a Bank History Entry
  // ────────────────────────────────────────────────
  deleteBankHistory: async (req, res) => {
    try {
      const { empId, historyId } = req.params;
      const isObjectId = mongoose.Types.ObjectId.isValid(empId);
      const employeeDetails = await EmployeeDetails.findOne(
        isObjectId ? { empId } : { empIdString: empId }
      );

      if (!employeeDetails) {
        return res.status(404).json({ message: "Employee details not found" });
      }

      employeeDetails.bankHistory = employeeDetails.bankHistory.filter(
        h => h._id.toString() !== historyId
      );

      await employeeDetails.save({ validateBeforeSave: false });

      // Return decrypted history
      const formattedHistory = (employeeDetails.bankHistory || []).map(bh => {
        const obj = bh.toObject ? bh.toObject() : bh;
        return {
          ...obj,
          accountNumber: decrypt(obj.accountNumber) || obj.accountNumber
        };
      });

      return res.json({
        message: "Bank history record deleted successfully",
        bankHistory: formattedHistory
      });
    } catch (error) {
      console.error("Error deleting bank history:", error);
      return res.status(500).json({ message: "Internal server error", error: error.message });
    }
  },

  // ────────────────────────────────────────────────
  // PUT — Update a Bank History Entry
  // ────────────────────────────────────────────────
  updateBankHistory: async (req, res) => {
    try {
      const { empId, historyId } = req.params;
      const { bankName, accountHolder, accountNumber, ifscCode, branch, fromDate, toDate } = req.body;

      console.log(`[UpdateBankHistory] Request for Emp: ${empId}, HistoryId: ${historyId}`);

      const mongoose = require("mongoose");
      const employeeDetails = await EmployeeDetails.findOne(
        mongoose.Types.ObjectId.isValid(empId) ? { empId } : { empIdString: empId }
      );

      if (!employeeDetails) {
        return res.status(404).json({ message: "Employee details not found" });
      }

      const historyIndex = employeeDetails.bankHistory.findIndex(
        h => h && h._id && h._id.toString() === historyId
      );

      if (historyIndex === -1) {
        return res.status(404).json({ message: "History record not found" });
      }

      // Update fields
      const entry = employeeDetails.bankHistory[historyIndex];
      if (bankName !== undefined) entry.bankName = bankName;
      if (accountHolder !== undefined) entry.accountHolder = accountHolder;
      if (ifscCode !== undefined) entry.ifscCode = ifscCode;
      if (branch !== undefined) entry.branch = branch;

      if (fromDate) {
        const d = new Date(fromDate);
        if (!isNaN(d.getTime())) entry.fromDate = d;
      }
      if (toDate) {
        const d = new Date(toDate);
        if (!isNaN(d.getTime())) entry.toDate = d;
      }

      // Encrypt account number if provided and not masked
      if (accountNumber && String(accountNumber).indexOf("X") === -1) {
        entry.accountNumber = encrypt(String(accountNumber));
      }

      await employeeDetails.save({ validateBeforeSave: false });

      // Return decrypted history
      const formattedHistory = (employeeDetails.bankHistory || []).map(bh => {
        if (!bh) return null;
        const obj = bh.toObject ? bh.toObject() : bh;
        const rawAcc = decrypt(obj.accountNumber) || obj.accountNumber;
        return {
          ...obj,
          accountNumber: rawAcc
        };
      }).filter(Boolean);

      return res.json({
        message: "Bank history record updated successfully",
        bankHistory: formattedHistory
      });
    } catch (error) {
      console.error("Error updating bank history:", error);
      return res.status(500).json({
        message: "Internal server error",
        error: error.message,
        stack: error.stack
      });
    }
  },

  // ────────────────────────────────────────────────
  // DIRECT ADMIN / HR DELETE GENERAL EMPLOYEE DOCUMENT
  // ────────────────────────────────────────────────
  deleteGeneralDocument: async (req, res) => {
    try {
      const { empId } = req.params;
      const { field, key, courseId, courseIdx, certId, certIdx } = req.body;

      if (!empId) {
        return res.status(400).json({ success: false, message: "Employee ID is required" });
      }

      // Check Admin/HR access for document deletion
      const userRole = (req.user?.role || "").toLowerCase();
      const isHr = Boolean(req.user?.isHr === true || req.user?.isHr === "true" || userRole === "hr");
      const isAdmin = (userRole === "admin" || userRole === "superadmin") && !isHr;

      let isAuthorized = Boolean(isAdmin);
      if (isHr) {
        const Configuration = require("../Models/Configuration");
        const config = await Configuration.findOne({ key: "DEFAULT_CONFIG" }).lean();
        if (config?.hrAccessConfig?.employeeManagement?.canDeleteDocuments) {
          isAuthorized = true;
        }
      }

      if (!isAuthorized) {
        return res.status(403).json({
          success: false,
          message: "Access denied. You do not have permission to delete uploaded documents.",
        });
      }

      const extractS3Key = (val) => {
        if (!val || typeof val !== "string") return null;
        let clean = val.trim();
        if (clean.startsWith("http://") || clean.startsWith("https://")) {
          try {
            const parsed = new URL(clean);
            clean = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
          } catch (e) {
            clean = clean.replace(/^https?:\/\/[^\/]+\//, "").split("?")[0];
          }
        }
        return clean.split("?")[0];
      };

      const isObjectId = mongoose.Types.ObjectId.isValid(empId);
      let employeeDetails = null;

      if (isObjectId) {
        employeeDetails = await EmployeeDetails.findOne({
          $or: [{ empId }, { empIdString: empId }, { _id: empId }],
        });
        if (!employeeDetails) {
          employeeDetails = await EmployeeDetails.findById(empId);
        }
      } else {
        employeeDetails = await EmployeeDetails.findOne({
          $or: [{ empIdString: empId }, { empId: empId }],
        });
      }

      const Employee = require("../Models/Employee");
      let emp = null;

      if (employeeDetails) {
        emp = await Employee.findById(employeeDetails.empId);
      } else {
        emp = await Employee.findOne(
          isObjectId ? { $or: [{ _id: empId }, { empId }] } : { empId: empId }
        );
        if (emp) {
          employeeDetails = await EmployeeDetails.findOne({ empId: emp._id });
        }
      }

      if (!employeeDetails) {
        return res.status(404).json({ success: false, message: "Employee details not found" });
      }

      // Determine S3 key to delete and update Database fields
      let fileKeyToDelete = key || null;

      if (field === "marksheet10") {
        fileKeyToDelete = fileKeyToDelete || employeeDetails.marksheet10;
        employeeDetails.marksheet10 = null;
      } else if (field === "marksheet12") {
        fileKeyToDelete = fileKeyToDelete || employeeDetails.marksheet12;
        employeeDetails.marksheet12 = null;
      } else if (field === "aadhaarFile") {
        fileKeyToDelete = fileKeyToDelete || employeeDetails.aadhaarFile;
        employeeDetails.aadhaarFile = null;
      } else if (field === "panFile") {
        fileKeyToDelete = fileKeyToDelete || employeeDetails.panFile;
        employeeDetails.panFile = null;
      } else if (field === "passbookFile") {
        fileKeyToDelete = fileKeyToDelete || employeeDetails.passbookFile;
        employeeDetails.passbookFile = null;
      } else if (field === "picture") {
        fileKeyToDelete =
          fileKeyToDelete ||
          employeeDetails.picture ||
          (emp?.photo && emp.photo !== "avatar.png" ? emp.photo : null);
        employeeDetails.picture = null;
        if (emp) {
          emp.photo = "avatar.png";
          await emp.save({ validateBeforeSave: false });
        }
      } else if (field === "degreeCertificate") {
        fileKeyToDelete = fileKeyToDelete || employeeDetails.degreeCertificate;
        employeeDetails.degreeCertificate = null;
      } else if (field === "ugDegreeCertificate") {
        fileKeyToDelete = fileKeyToDelete || employeeDetails.ugDegreeCertificate;
        employeeDetails.ugDegreeCertificate = null;
      } else if (field === "pgDegreeCertificate") {
        fileKeyToDelete = fileKeyToDelete || employeeDetails.pgDegreeCertificate;
        employeeDetails.pgDegreeCertificate = null;
      } else if (field?.startsWith("courses.") || courseId != null || courseIdx != null) {
        if (Array.isArray(employeeDetails.courses)) {
          let c = null;
          if (courseId) {
            c = employeeDetails.courses.id
              ? employeeDetails.courses.id(courseId)
              : employeeDetails.courses.find((x) => String(x._id) === String(courseId));
          } else if (courseIdx != null) {
            c = employeeDetails.courses[courseIdx];
          } else if (field?.startsWith("courses.")) {
            const parts = field.split(".");
            const idx = parseInt(parts[1], 10);
            if (!isNaN(idx)) c = employeeDetails.courses[idx];
          }
          if (c) {
            fileKeyToDelete = fileKeyToDelete || c.certificate;
            c.certificate = null;
          }
        }
      } else if (
        field?.startsWith("professionalCertifications.") ||
        certId != null ||
        certIdx != null
      ) {
        if (Array.isArray(employeeDetails.professionalCertifications)) {
          let cert = null;
          if (certId) {
            cert = employeeDetails.professionalCertifications.id
              ? employeeDetails.professionalCertifications.id(certId)
              : employeeDetails.professionalCertifications.find(
                (x) => String(x._id) === String(certId)
              );
          } else if (certIdx != null) {
            cert = employeeDetails.professionalCertifications[certIdx];
          } else if (field?.startsWith("professionalCertifications.")) {
            const parts = field.split(".");
            const idx = parseInt(parts[1], 10);
            if (!isNaN(idx)) cert = employeeDetails.professionalCertifications[idx];
          }
          if (cert) {
            fileKeyToDelete = fileKeyToDelete || cert.certificate;
            cert.certificate = null;
          }
        }
      } else if (field && employeeDetails[field] !== undefined) {
        fileKeyToDelete = fileKeyToDelete || employeeDetails[field];
        employeeDetails[field] = null;
      }

      // Delete from S3 (and invalidate Redis URL cache)
      const keyToPurge = extractS3Key(fileKeyToDelete);
      if (keyToPurge && keyToPurge !== "avatar.png") {
        await deleteFromS3(keyToPurge).catch((err) =>
          console.error("S3 delete error:", err)
        );
      }

      // Recalculate profile completion score
      const updatedCompletion = calculateProfileCompletion(
        employeeDetails.toObject(),
        emp || null
      );
      employeeDetails.profileCompletion = updatedCompletion;
      if (updatedCompletion < 100) {
        employeeDetails.isProfileCompleted = false;
        if (emp) {
          emp.isProfileCompleted = false;
          await emp.save({ validateBeforeSave: false });
        }
      }

      await employeeDetails.save({ validateBeforeSave: false });

      if (createLog) {
        await createLog({
          action: "DELETE_EMPLOYEE_DOCUMENT",
          performedBy: req.user?._id || req.user?.id,
          performedByRole: req.user?.role || (req.user?.isHr ? "hr" : "unknown"),
          targetUser: emp?._id || employeeDetails.empId,
          details: {
            field,
            fileKey: keyToPurge,
            empIdString: employeeDetails.empIdString || emp?.empId,
          },
        }).catch(() => { });
      }

      return res.status(200).json({
        success: true,
        message: "Document deleted successfully from S3 and database",
        field,
        profileCompletion: updatedCompletion,
      });
    } catch (err) {
      console.error("Error deleting general document:", err);
      return res.status(500).json({
        success: false,
        message: "Internal server error",
        error: err.message,
      });
    }
  },

};

module.exports = UsersController;

const apiLogger = require('../utils/apiLogger');
module.exports = apiLogger(module.exports, 'UsersController.js');
