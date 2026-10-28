const mongoose = require("mongoose");

const PermissionRequestSchema =
new mongoose.Schema(
{
  employeeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Employee",
    required: true,
    index: true,
  },

  from: {
    type: Date,
    required: true,
  },

  to: {
    type: Date,
    required: true,
  },

  reason: {
    type: String,
    required: true,
    trim: true,
    maxlength: 500,
  },

  status: {
    type: String,
    enum: [
      "PENDING",
      "APPROVED",
      "REJECTED",
      "INFORMED",
    ],
    default: "PENDING",
    index: true,
  },

  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Employee",
  },

  approvedAt: Date,

  rejectedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Employee",
  },

  rejectedAt: Date,

  rejectReason: {
    type: String,
    trim: true,
    maxlength: 500,
  },

  permissionType: {
    type: String,
    enum: ["MORNING", "AFTERNOON", "EVENING"],
  },

  isExcess: {
    type: Boolean,
    default: false,
  },

  monthlyIndex: {
    type: Number,
  },

  leaveDaysToDeduct: {
    type: Number,
    default: 0,
  },

  deductCategoryName: {
    type: String,
    default: "Annual Leave",
  },
},
{ timestamps: true }
);


PermissionRequestSchema.index({
  employeeId: 1,
  status: 1,
});

PermissionRequestSchema.index({
  from: 1,
  to: 1,
});

module.exports =
mongoose.model(
  "PermissionRequest",
  PermissionRequestSchema
);