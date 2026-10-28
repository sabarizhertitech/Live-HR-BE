const mongoose = require("mongoose");

const configurationSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      default: "DEFAULT_CONFIG",
      unique: true,
    },
    // ── Permission Configuration ──
    permanentFreeCount: {
      type: Number,
      default: 2,
      min: 0,
    },
    probationFreeCount: {
      type: Number,
      default: 2,
      min: 0,
    },
    deductCategoryName: {
      type: String,
      default: "Annual Leave",
      trim: true,
    },
    leaveDaysPerPermission: {
      type: Number,
      default: 0.5,
      min: 0,
    },

    // ── Extensible for Future Portal Configurations ──
    settings: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    // ── HR Access & Permissions Configuration ──
    hrAccessConfig: {
      slipAndLetter: {
        type: String,
        enum: ["READ", "WRITE", "FULL_ACCESS"],
        default: "WRITE",
      },
      hrRequests: {
        type: String,
        enum: ["READ", "WRITE", "FULL_ACCESS"],
        default: "WRITE",
      },
      leaveManagement: {
        type: String,
        enum: ["MAKER", "READ", "FULL_ACCESS"],
        default: "MAKER",
      },
      employeeManagement: {
        canAdd: { type: Boolean, default: true },
        canView: { type: Boolean, default: true },
        canEdit: { type: Boolean, default: true },
        canDeleteDocuments: { type: Boolean, default: false }, // Only Admin has access to delete uploaded docs
      },
      attendanceManagement: {
        dailyReport: { type: Boolean, default: true },
        monthlyOverview: { type: Boolean, default: true },
        exportAttendance: { type: Boolean, default: true },
      },
      holidays: {
        type: String,
        enum: ["MAKER", "READ", "FULL_ACCESS"],
        default: "MAKER",
      },
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.models.Configuration || mongoose.model("Configuration", configurationSchema);
