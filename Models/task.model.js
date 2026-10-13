const mongoose = require("mongoose");

const taskSchema = new mongoose.Schema(
  {
    taskTitle: { type: String, required: true },
    taskDetails: { type: String, required: true },

    priority: {
      type: String,
      enum: ["Low", "Mid", "High"],
      default: "Mid",
    },

    startDate: { type: Date, default: undefined },
    dueDate: { type: Date },   // deadline
    endDate: { type: Date, default: undefined },   // actual completion date
    dueReminderSent: { type: Boolean, default: false },

    category: { type: String, default: "" },
    project: { type: String, default: "" },
    workType: { type: String, trim: true, default: undefined },
    pages: { type: [String], default: undefined },

    status: { type: String, default: "Assigned" },
    assignedStatus: { type: String, default: "Allocated" },
    rejectionReason: { type: String, trim: true, default: undefined },

    assignedMembers: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Employee" }],
      default: undefined
    },

    memberStatuses: {
      type: [
        {
          employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
          assignedStatus: { type: String, default: "Allocated" },
          status: { type: String, default: "Assigned" },
          rejectionReason: { type: String, default: "" },
          startDate: { type: Date },
          endDate: { type: Date },
          updatedAt: { type: Date, default: Date.now },
        }
      ],
      default: undefined
    },

    documents: { type: [String], default: undefined },

    /* ─────────────────────────────────────────
       PHASES – Structured array of phase objects
    ───────────────────────────────────────── */
    phases: {
      type: [
        {
          phaseTitle: { type: String, default: "" },
          phaseDescription: { type: String, default: "" },
          phaseStatus: { type: String, default: "pending" },
          updateDate: { type: Date, default: Date.now },
          employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
        }
      ],
      default: undefined
    },


    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },
    createdDate: {
      type: Date,
      default: Date.now,
    },
  }
);

function sanitizeTaskFields(doc) {
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
  if (doc.rejectionReason === null || (typeof doc.rejectionReason === "string" && doc.rejectionReason.trim() === "")) {
    doc.set("rejectionReason", undefined);
    if (doc._doc) delete doc._doc.rejectionReason;
  }
  if (doc.startDate === null || doc.startDate === "") {
    doc.set("startDate", undefined);
    if (doc._doc) delete doc._doc.startDate;
  }
  if (doc.endDate === null || doc.endDate === "") {
    doc.set("endDate", undefined);
    if (doc._doc) delete doc._doc.endDate;
  }
}

taskSchema.pre("validate", function () {
  sanitizeTaskFields(this);
});

taskSchema.pre("save", function () {
  sanitizeTaskFields(this);
});

module.exports = mongoose.model("Task", taskSchema);