const mongoose = require("mongoose");

const dailyWorkUpdateSchema = new mongoose.Schema(
  {
    category: {
      type: String,
    },
    project: {
      type: String,
    },
    pages: {
      type: [String],
      default: undefined,
    },
    workType: {
      type: String,
      trim: true,
      default: undefined,
    },
    title: {
      type: String, // phaseTitle
    },
    description: {
      type: String, // phaseDescription
      trim: true,
    },
    status: {
      type: String, // phaseStatus
      enum: ["pending", "inprocess", "hold", "completed"],
      default: "inprocess",
    },
    updateDate: {
      type: Date,
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },
    phaseId: {
      type: mongoose.Schema.Types.ObjectId,
      required: false,
    },
    referenceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: false,
    },
    task: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Task",
      required: false,
    },
  },
  {
    timestamps: true
  }
);

function sanitizeDailyWorkUpdate(doc) {
  if (doc.workType === null || (typeof doc.workType === "string" && doc.workType.trim() === "")) {
    doc.set("workType", undefined);
    if (doc._doc) delete doc._doc.workType;
  }
  if (doc.pages === null || (Array.isArray(doc.pages) && doc.pages.length === 0)) {
    doc.set("pages", undefined);
    if (doc._doc) delete doc._doc.pages;
  } else if (Array.isArray(doc.pages)) {
    const validPages = doc.pages.map((p) => String(p).trim()).filter(Boolean);
    if (validPages.length === 0) {
      doc.set("pages", undefined);
      if (doc._doc) delete doc._doc.pages;
    } else {
      doc.pages = validPages;
    }
  }
}

dailyWorkUpdateSchema.pre("validate", function () {
  sanitizeDailyWorkUpdate(this);
});

dailyWorkUpdateSchema.pre("save", function () {
  sanitizeDailyWorkUpdate(this);
});

dailyWorkUpdateSchema.index({ userId: 1, updateDate: -1 });
dailyWorkUpdateSchema.index({ phaseId: 1 });
dailyWorkUpdateSchema.index({ referenceId: 1 });
dailyWorkUpdateSchema.index({ category: 1, project: 1 });

module.exports = mongoose.model("DailyWorkUpdate", dailyWorkUpdateSchema);
