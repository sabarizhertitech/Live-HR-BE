const mongoose = require("mongoose");

const careerGapSchema = new mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },
    empIdString: {
      type: String,
      default: "",
    },
    educationStage: {
      type: String,
      default: "10th to 12th Standard",
      required: true,
    },
    passedOutYear10: {
      type: String,
    },
    expectedYear12: {
      type: String,
    },
    actualYear12: {
      type: String,
    },
    passedOutYear12: {
      type: String,
    },
    expectedUGYear: {
      type: String,
    },
    actualUGYear: {
      type: String,
    },
    expectedDiplomaYear: {
      type: String,
    },
    actualDiplomaYear: {
      type: String,
    },
    gapDuration: {
      type: Number,
      required: true,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
    },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.CareerGap || mongoose.model("CareerGap", careerGapSchema);
