const Employee = require("../Models/Employee");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const ProfileOTP = require("../Models/ProfileOTP");
const transporter = require("../utilities/emailTransporter");
const { validatePassword } = require("../utilities/passwordPolicy");
const mongoose = require("mongoose");
const { uploadToS3 } = require("../utilities/s3Upload");
const getCachedSignedUrl = require("../utilities/s3CachedUrl");
const EmployeeDetails = require("../Models/EmployeeDetails");
const MenuPermission = require("../Models/MenuPermission");
const { createLog } = require("../utilities/logService");

const sendResponse = (res, status, success, message, data = null) => {
  return res.status(status).json({ success, message, data });
};

const crypto = require("crypto");

const generateOTP = () => crypto.randomInt(100000, 999999).toString();


// ─────────────────────────────────────────────────────────────────────────────
// Helper — Check if today is the user's birthday (Asia/Kolkata timezone)
// ─────────────────────────────────────────────────────────────────────────────
const isBirthdayToday = (dob) => {
  if (!dob) return false;
  const d = new Date(dob);
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

const ProfileFunction = {

  // ✅ GET PROFILE
  getProfile: async (req, res) => {
    try {
      const userId = req.user?.id || req.user?._id;
      if (!userId) return sendResponse(res, 401, false, "Unauthorized");

      const user = await Employee.findById(userId).select(
        "name email empId username phone department designation dateJoined role isHr photo"
      );

      if (!user) return sendResponse(res, 404, false, "User not found");

      const employeeDetails = await EmployeeDetails.findOne({ empId: userId }).select("dob");
      const dob = employeeDetails?.dob || null;

      let photoUrl = null;
      if (user.photo) {
        try {
          photoUrl = await getCachedSignedUrl(user.photo);
        } catch (err) {
          console.error("S3 URL error:", err.message);
          photoUrl = null;
        }
      }


      const permDoc = await MenuPermission.findOne({ employeeId: userId });
      const permissions = permDoc ? permDoc.menus : [];

      return sendResponse(res, 200, true, "Profile fetched", {
        _id: user._id,
        name: user.name,
        email: user.email,
        empId: user.empId,
        username: user.username,
        phone: user.phone,
        department: user.department,
        designation: user.designation,
        doj: user.dateJoined,
        role: user.role,
        isHr: !!user.isHr,
        photo: photoUrl,
        dob,
        isBirthday: isBirthdayToday(dob),
        permissions,
      });

    } catch (err) {
      console.error("Get Profile Error:", err);
      return sendResponse(res, 500, false, "Server error");
    }
  },

  // ✅ UPDATE PROFILE
  updateProfile: async (req, res) => {
    const CONTEXT = "UPDATE_PROFILE";
    try {
      const userId = req.user?.id || req.user?._id;
      if (!userId) {
        console.error(`[${CONTEXT}] Unauthorized: No user ID found in request`);
        return sendResponse(res, 401, false, "Unauthorized");
      }

      // Log incoming request body (excluding sensitive data if any)
      console.log(`[${CONTEXT}] Request from ${userId}:`, JSON.stringify(req.body));

      const { name, email, phone, username } = req.body;

      if (!name && !email && !req.file && !username && !phone) {
        return sendResponse(res, 400, false, "Nothing to update");
      }

      let updateData = { lastProfileUpdateAt: new Date() };

      if (name?.trim()) updateData.name = name.trim();
      if (email?.trim()) updateData.email = email.trim().toLowerCase();
      if (phone?.trim()) updateData.phone = phone.trim();
      if (username?.trim()) updateData.username = username.trim().toLowerCase();

      // Handle File Upload if present
      if (req.file) {
        console.log(`[${CONTEXT}] Processing file upload for ${userId}`);
        const emp = await Employee.findById(userId).select("empId");
        if (!emp) {
          console.error(`[${CONTEXT}] User ${userId} not found during file upload`);
          return sendResponse(res, 404, false, "Employee not found");
        }

        const ext = req.file.originalname.split(".").pop().toLowerCase();
        const key = `Profile/${emp.empId}.${ext}`;

        await uploadToS3(req.file.buffer, key, req.file.mimetype);
        updateData.photo = key;
        console.log(`[${CONTEXT}] File uploaded to S3: ${key}`);
      }

      console.log(`[${CONTEXT}] Applying updates to DB for ${userId}:`, JSON.stringify(updateData));

      // ── Perform Update ──
      const updatedUser = await Employee.findByIdAndUpdate(userId, updateData, {
        new: true,
        runValidators: false, // Changed to false to avoid strict validation issues
      }).select("name email empId username phone department designation dateJoined role photo");

      if (!updatedUser) {
        console.error(`[${CONTEXT}] User ${userId} not found during DB update`);
        return sendResponse(res, 404, false, "User not found");
      }

      // ── Sync to EmployeeDetails (Second Model) ──
      try {
        const detailsUpdate = { lastUpdatedAt: new Date() };
        if (updateData.name) detailsUpdate.name = updateData.name;
        if (updateData.email) detailsUpdate.email = updateData.email;
        if (updateData.phone) detailsUpdate.phone = updateData.phone;
        if (updateData.photo) detailsUpdate.picture = updateData.photo;

        if (Object.keys(detailsUpdate).length > 1) {
          await EmployeeDetails.findOneAndUpdate(
            { empId: userId },
            { $set: detailsUpdate },
            { upsert: true }
          );
          console.log(`[${CONTEXT}] Synced core fields to EmployeeDetails for ${userId}`);
        }
      } catch (syncErr) {
        console.error(`[${CONTEXT}] Sync to EmployeeDetails failed for ${userId}:`, syncErr.message);
      }

      // ── Safely Fetch DOB ──
      let dob = null;
      try {
        const employeeDetails = await EmployeeDetails.findOne({ empId: userId }).select("dob");
        dob = employeeDetails?.dob || null;
      } catch (detailsErr) {
        console.warn(`[${CONTEXT}] Could not fetch employee details for ${userId}:`, detailsErr.message);
      }

      // ── Handle Photo URL ──
      let photoUrl = null;
      if (updatedUser.photo) {
        try {
          photoUrl = await getCachedSignedUrl(updatedUser.photo);
        } catch (s3Err) {
          console.error(`[${CONTEXT}] S3 URL signing error for ${userId}:`, s3Err.message);
        }
      }

      console.log(`[${CONTEXT}] Profile updated successfully for ${userId}`);

      return sendResponse(res, 200, true, "Profile updated successfully", {
        name: updatedUser.name,
        email: updatedUser.email,
        empId: updatedUser.empId,
        username: updatedUser.username,
        phone: updatedUser.phone,
        department: updatedUser.department,
        designation: updatedUser.designation,
        doj: updatedUser.dateJoined,
        role: updatedUser.role,
        photo: photoUrl,
        dob,
        isBirthday: isBirthdayToday(dob),
      });

    } catch (err) {
      console.error(`[${CONTEXT}] CRITICAL ERROR for user ${req.user?.id || 'unknown'}:`, err);

      // MongoDB Unique Constraint (11000)
      if (err.code === 11000 || (err.name === "MongoError" && err.code === 11000)) {
        let field = "Field";

        // Try to find the field name from keyPattern, keyValue, or the message
        if (err.keyPattern) {
          field = Object.keys(err.keyPattern)[0];
        } else if (err.keyValue) {
          field = Object.keys(err.keyValue)[0];
        } else if (err.message && err.message.includes("index: ")) {
          const match = err.message.match(/index: (?:.*\.)?\$?(\w+)_/);
          if (match) field = match[1];
        }

        const fieldMap = {
          username: "Username",
          email: "Email",
          phone: "Phone number",
          empId: "Employee ID"
        };

        const displayName = fieldMap[field] || (field.charAt(0).toUpperCase() + field.slice(1));
        return sendResponse(res, 400, false, `${displayName} already exists. Please try another one.`);
      }

      // Validation Errors
      if (err.name === "ValidationError") {
        const messages = Object.values(err.errors).map(e => e.message);
        return sendResponse(res, 400, false, messages.join(", "));
      }

      return sendResponse(res, 500, false, `Update failed: ${err.message || "Internal server error"}`);
    }
  },

  // ✅ CHANGE PASSWORD (Admin - with old password)
  changePassword: async (req, res) => {
    try {
      const userId = req.user?.id || req.user?._id;
      if (!userId) return sendResponse(res, 401, false, "Unauthorized");

      const currentToken = req.headers.authorization?.split(" ")[1];

      const { oldPassword, newPassword } = req.body;

      if (!oldPassword || !newPassword) {
        return sendResponse(res, 400, false, "Old and new password required");
      }

      if (oldPassword === newPassword) {
        return sendResponse(res, 400, false, "New password cannot be same as old password");
      }

      let errors = [];
      try {
        const result = validatePassword(newPassword);
        if (Array.isArray(result)) errors = result;
        else if (result === false) errors = ["Password does not meet requirements (12+ chars, upper, lower, number, special character)"];
      } catch (validationErr) {
        console.error("validatePassword threw an error:", validationErr);
        return sendResponse(res, 400, false, "Password validation failed");
      }

      if (errors.length > 0) return sendResponse(res, 400, false, errors.join(", "));

      const user = await Employee.findById(userId);
      if (!user) return sendResponse(res, 404, false, "User not found");
      if (!user.passwordHash) return sendResponse(res, 500, false, "Password data corrupted. Please contact support.");

      const minAge = 2 * 24 * 60 * 60 * 1000;
      if (user.passwordChangedAt) {
        const lastChanged = new Date(user.passwordChangedAt).getTime();
        if (!isNaN(lastChanged) && Date.now() - lastChanged < minAge) {
          return sendResponse(res, 400, false, "Password cannot be changed within 2 days of last change");
        }
      }

      const isMatch = await bcrypt.compare(oldPassword, user.passwordHash);
      if (!isMatch) return sendResponse(res, 401, false, "Old password is incorrect");

      const history = Array.isArray(user.passwordHistory) ? user.passwordHistory : [];
      for (let oldHash of history) {
        if (!oldHash) continue;
        const isSame = await bcrypt.compare(newPassword, oldHash);
        if (isSame) return sendResponse(res, 400, false, "Cannot reuse any of your last 5 passwords");
      }

      const hashedPassword = await bcrypt.hash(newPassword, 10);
      const updatedHistory = [hashedPassword, ...history].slice(0, 5);

      user.passwordHash = hashedPassword;
      user.passwordHistory = updatedHistory;
      user.passwordChangedAt = new Date();
      user.passwordExpiresAt = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000);
      user.isFirstLogin = false;

      await user.save();

      createLog({
        category: "auth",
        referenceId: user._id,
        description: `${user.name} (${user.empId || user.email}) changed password successfully`,
      });

      return sendResponse(res, 200, true, "Password updated successfully");

    } catch (err) {
      console.error("Change Password Error:", err);
      return sendResponse(res, 500, false, "Server error");
    }
  },

  // ✅ SEND PROFILE OTP
  sendProfileOtp: async (req, res) => {
    try {
      const userId = req.user?.id || req.user?._id;
      if (!userId) return sendResponse(res, 401, false, "Unauthorized");
      const user = await Employee.findById(userId);

      if (!user) {
        return sendResponse(res, 404, false, "User not found");
      }

      const email = user.email;

      const { phone } = req.body;
      if (!email) {
        return sendResponse(res, 400, false, "User email not available");
      }

      const existingOtp = await ProfileOTP.findOne({ userId, type: "profile_update" });
      const today = new Date().toISOString().slice(0, 10);

      if (existingOtp) {
        if (existingOtp.requestDate !== today) {
          existingOtp.requestCount = 0;
          existingOtp.requestDate = today;
        }

        if (existingOtp.requestCount >= 3) {
          return sendResponse(
            res,
            429,
            false,
            "You have reached the maximum OTP request limit of 3 for today. Please try again tomorrow."
          );
        }

        await existingOtp.save();
      }

      const otp = generateOTP();
      const otpHash = await bcrypt.hash(otp, 10);

      await ProfileOTP.findOneAndUpdate(
        { userId, type: "profile_update" },
        {
          $set: {
            email,
            otp: otpHash,
            expiresAt: new Date(Date.now() + 5 * 60 * 1000),
            attempts: 0,
            requestDate: today
          },
          $inc: { requestCount: 1 }
        },
        {
          upsert: true,
          new: true
        }
      );

      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: "Profile Update OTP - ErtiTech",
        html: `
          <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 480px; margin: auto; border: 1px solid #e5e7eb; border-radius: 12px;">
            <h2 style="color: #6366f1;">Profile Update Verification</h2>
            <p style="color: #374151;">Use the OTP below to verify your identity:</p>
            <div style="font-size: 36px;font-weight: 700;letter-spacing: 12px;color: #1e1b4b;background: #f3f4f6;padding: 16px 24px;border-radius: 8px;display: inline-block;margin: 12px 0;">${otp}</div>
            <p style="color: #6b7280; font-size: 13px;">This OTP is valid for <strong>5 minutes</strong>. Do not share it with anyone.</p>
            <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;" />
            <p style="color: #9ca3af; font-size: 12px;">If you did not request this, please ignore this email.</p>
          </div>
        `,
      });

      return sendResponse(res, 200, true, "OTP sent successfully");

    } catch (err) {
      console.error("Send OTP Error:", err);
      return sendResponse(res, 500, false, "Failed to send OTP");
    }
  },

  // ✅ VERIFY PROFILE OTP
  verifyProfileOtp: async (req, res) => {
    try {
      const userId = req.user?.id || req.user?._id;
      if (!userId) return sendResponse(res, 401, false, "Unauthorized");

      const { otp } = req.body;
      const { email, phone } = req.body;
      if (!otp) return sendResponse(res, 400, false, "OTP is required");

      const record = await ProfileOTP.findOne({ userId, type: "profile_update" });
      if (!record) return sendResponse(res, 400, false, "OTP not found. Please request a new one.");

      if (record.expiresAt < new Date()) {
        await ProfileOTP.deleteMany({ userId, type: "profile_update" });
        return sendResponse(res, 400, false, "OTP has expired. Please request a new one.");
      }

      if (record.attempts >= 5) {
        return sendResponse(res, 429, false, "Too many failed attempts. Please request a new OTP.");
      }

      const isOtpValid = await bcrypt.compare(otp, record.otp);
      if (!isOtpValid) {
        record.attempts += 1;
        await record.save();
        const remaining = 5 - record.attempts;
        return sendResponse(res, 400, false, `Invalid OTP. ${remaining} attempt${remaining !== 1 ? "s" : ""} remaining.`);
      }
      if (email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
          return sendResponse(res, 400, false, "Invalid email format");
        }
      }
      const updateFields = { lastProfileUpdateAt: new Date() };
      if (email) updateFields.email = email;
      if (phone) updateFields.phone = phone;

      const updatedUser = await Employee.findByIdAndUpdate(userId, updateFields, { new: true })
        .select("name email empId username phone department designation dateJoined role photo");

      await ProfileOTP.deleteMany({ userId, type: "profile_update" });

      return sendResponse(res, 200, true, "OTP verified successfully", updatedUser);

    } catch (err) {
      console.error("Verify OTP Error:", err);
      return sendResponse(res, 500, false, "Server error");
    }
  },

  // ✅ SEND PASSWORD CHANGE OTP — with rapid re-send protection
  sendPasswordChangeOtp: async (req, res) => {
    try {
      const userId = req.user?.id || req.user?._id;
      if (!userId) return sendResponse(res, 401, false, "Unauthorized");

      const user = await Employee.findById(userId);
      if (!user) return sendResponse(res, 404, false, "User not found");
      if (!user.email) return sendResponse(res, 400, false, "No email associated with this account");

      const minAge = 2 * 24 * 60 * 60 * 1000;
      if (user.passwordChangedAt) {
        const lastChanged = new Date(user.passwordChangedAt).getTime();
        if (!isNaN(lastChanged) && Date.now() - lastChanged < minAge) {
          return sendResponse(res, 400, false, "Password cannot be changed within 2 days of last change");
        }
      }

      const existingOtp = await ProfileOTP.findOne({ userId, type: "password_change" });
      if (existingOtp) {
        const age = Date.now() - new Date(existingOtp.createdAt).getTime();
        if (age < 10 * 1000) {
          const maskedEmail = user.email.replace(/(.{2})(.*)(@.*)/, "$1***$3");
          return sendResponse(res, 200, true, `OTP sent to ${maskedEmail}`);
        }
      }

      const otp = generateOTP();
      await ProfileOTP.deleteMany({ userId, type: "password_change" });
      const otpHash = await bcrypt.hash(otp, 10);

      await ProfileOTP.create({
        userId,
        email: user.email,
        otp: otpHash,
        type: "password_change",
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        attempts: 0,
      });

      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: user.email,
        subject: "Password Change OTP - ErtiTech",
        html: `
          <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 480px; margin: auto; border: 1px solid #e5e7eb; border-radius: 12px;">
            <h2 style="color: #ef4444;">Password Change Verification</h2>
            <p style="color: #374151;">You requested to change your password. Use the OTP below to verify:</p>
            <div style="font-size: 36px;font-weight: 700;letter-spacing: 12px;color: #1e1b4b;background: #fef2f2;padding: 16px 24px;border-radius: 8px;display: inline-block;margin: 12px 0;border: 1px solid #fecaca;">${otp}</div>
            <p style="color: #6b7280; font-size: 13px;">This OTP is valid for <strong>5 minutes</strong>. Do not share it with anyone.</p>
            <div style="background: #fef3c7; padding: 12px; border-radius: 8px; margin: 16px 0;">
              <p style="color: #92400e; font-size: 13px; margin: 0;"><strong>Security Alert:</strong> If you did not request this, please contact support immediately.</p>
            </div>
            <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;" />
            <p style="color: #9ca3af; font-size: 12px;">ErtiTech Security Team</p>
          </div>
        `,
      });

      const maskedEmail = user.email.replace(/(.{2})(.*)(@.*)/, "$1***$3");
      return sendResponse(res, 200, true, `OTP sent to ${maskedEmail}`);

    } catch (err) {
      console.error("Send Password OTP Error:", err);
      return sendResponse(res, 500, false, "Failed to send OTP");
    }
  },

  // ✅ VERIFY OTP AND CHANGE PASSWORD
  verifyOtpAndChangePassword: async (req, res) => {
    try {
      const userId = req.user?.id || req.user?._id;
      if (!userId) return sendResponse(res, 401, false, "Unauthorized");

      const currentToken = req.headers.authorization?.split(" ")[1];

      const { otp, newPassword } = req.body;

      if (!otp) return sendResponse(res, 400, false, "OTP is required");
      if (!newPassword) return sendResponse(res, 400, false, "New password is required");

      const record = await ProfileOTP.findOne({
        userId: new mongoose.Types.ObjectId(userId),
        type: "password_change",
      });
      if (!record) return sendResponse(res, 400, false, "OTP not found. Please request a new one.");

      if (record.expiresAt < new Date()) {
        await ProfileOTP.deleteMany({ userId });
        return sendResponse(res, 400, false, "OTP has expired. Please request a new one.");
      }

      if (record.attempts >= 5) {
        await ProfileOTP.deleteMany({ userId });
        return sendResponse(res, 429, false, "Too many failed attempts. Please request a new OTP.");
      }

      const isOtpValid = await bcrypt.compare(otp, record.otp);
      if (!isOtpValid) {
        record.attempts += 1;
        await record.save();
        const remaining = 5 - record.attempts;
        return sendResponse(res, 400, false, `Invalid OTP. ${remaining} attempt${remaining !== 1 ? "s" : ""} remaining.`);
      }

      let errors = [];
      try {
        const result = validatePassword(newPassword);
        if (Array.isArray(result)) errors = result;
        else if (result === false) errors = ["Password must be 12+ chars with upper, lower, number, and special character"];
      } catch (validationErr) {
        console.error("validatePassword error:", validationErr);
        return sendResponse(res, 400, false, "Password validation failed");
      }

      if (errors.length > 0) return sendResponse(res, 400, false, errors.join(", "));

      const user = await Employee.findById(userId);
      if (!user) return sendResponse(res, 404, false, "User not found");
      if (!user.passwordHash) return sendResponse(res, 500, false, "Password data corrupted. Please contact support.");

      const isSameAsCurrent = await bcrypt.compare(newPassword, user.passwordHash);
      if (isSameAsCurrent) return sendResponse(res, 400, false, "New password cannot be same as current password");

      const history = Array.isArray(user.passwordHistory) ? user.passwordHistory : [];
      for (let oldHash of history) {
        if (!oldHash) continue;
        const isSame = await bcrypt.compare(newPassword, oldHash);
        if (isSame) return sendResponse(res, 400, false, "Cannot reuse any of your last 5 passwords");
      }

      const hashedPassword = await bcrypt.hash(newPassword, 10);
      const updatedHistory = [hashedPassword, ...history].slice(0, 5);

      user.passwordHash = hashedPassword;
      user.passwordHistory = updatedHistory;
      user.passwordChangedAt = new Date();
      user.passwordExpiresAt = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000);
      user.isFirstLogin = false;

      await user.save();
      await ProfileOTP.deleteMany({ userId });

      createLog({
        category: "auth",
        referenceId: user._id,
        description: `${user.name} (${user.empId || user.email}) changed password successfully via OTP`,
      });

      return sendResponse(res, 200, true, "Password changed successfully");

    } catch (err) {
      console.error("Verify OTP and Change Password Error:", err);
      return sendResponse(res, 500, false, "Server error");
    }
  },

  // ✅ RESEND PASSWORD CHANGE OTP
  resendPasswordChangeOtp: async (req, res) => {
    try {
      const userId = req.user?.id || req.user?._id;
      if (!userId) return sendResponse(res, 401, false, "Unauthorized");

      const existingOtp = await ProfileOTP.findOne({ userId, type: "password_change" });

      if (existingOtp) {
        const timeSinceCreated = Date.now() - new Date(existingOtp.createdAt).getTime();
        const minResendTime = 60 * 1000;
        if (timeSinceCreated < minResendTime) {
          const waitTime = Math.ceil((minResendTime - timeSinceCreated) / 1000);
          return sendResponse(res, 429, false, `Please wait ${waitTime} seconds before requesting a new OTP`);
        }
      }

      await ProfileOTP.deleteMany({ userId });

      const user = await Employee.findById(userId);
      if (!user) return sendResponse(res, 404, false, "User not found");
      const otp = generateOTP();
      const otpHash = await bcrypt.hash(otp, 10);

      await ProfileOTP.create({
        userId,
        email: user.email,
        otp: otpHash,
        type: "password_change",
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        attempts: 0,
      });

      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: user.email,
        subject: "Password Change OTP (Resend) - ErtiTech",
        html: `
          <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 480px; margin: auto; border: 1px solid #e5e7eb; border-radius: 12px;">
            <h2 style="color: #ef4444;">Password Change Verification</h2>
            <p style="color: #374151;">Here is your new OTP to change your password:</p>
            <div style="font-size: 36px;font-weight: 700;letter-spacing: 12px;color: #1e1b4b;background: #fef2f2;padding: 16px 24px;border-radius: 8px;display: inline-block;margin: 12px 0;border: 1px solid #fecaca;">${otp}</div>
            <p style="color: #6b7280; font-size: 13px;">This OTP is valid for <strong>5 minutes</strong>.</p>
            <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;" />
            <p style="color: #9ca3af; font-size: 12px;">ErtiTech Security Team</p>
          </div>
        `,
      });

      const maskedEmail = user.email.replace(/(.{2})(.*)(@.*)/, "$1***$3");
      return sendResponse(res, 200, true, `New OTP sent to ${maskedEmail}`);

    } catch (err) {
      console.error("Resend Password OTP Error:", err);
      return sendResponse(res, 500, false, "Failed to resend OTP");
    }
  },

};

module.exports = ProfileFunction;