const mongoose = require("mongoose");
const numberToWords = require("../utilities/numberToWords");

const salarySlipSchema = new mongoose.Schema({
  empId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Employee",
    required: true
  },

  month: Number,
  year: Number,

  netPay: Number,
  totalEarnings: Number,
  totalDeductions: Number,
  // amountInWords: String, // REMOVED - Use virtual

  deductions: [
    {
      label: { type: String, trim: true },
      amount: { type: Number, default: 0 }
    }
  ],

  lopDays: {
    type: Number
  },
  lopAmount: {
    type: Number
  },

  pdfUrl: String

}, { 
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});


// ✅ VIRTUAL: monthName
salarySlipSchema.virtual("monthName").get(function () {
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  return monthNames[this.month - 1] || "";
});

// ✅ VIRTUAL: generatedAt
salarySlipSchema.virtual("generatedAt").get(function () {
  return this.createdAt;
});

// ✅ VIRTUAL: amountInWords
salarySlipSchema.virtual("amountInWords").get(function () {
  return numberToWords(this.netPay || 0);
});

module.exports = mongoose.model("SalarySlip", salarySlipSchema);