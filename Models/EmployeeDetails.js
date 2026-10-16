const mongoose = require("mongoose");

const employeeDetailsSchema = new mongoose.Schema(
  {
    empId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
      unique: true
    },

    empIdString: {
      type: String,
      sparse: true
    },

    employmentStatus: {
      type: String,
      enum: ["active", "relieved", "on_hold"],
      default: "active",
    },


    name: String,
    email: String,
    role: String,
    status: String,

    dob: Date,
    gender: String,
    phone: String,
    emergencyContact: String,
    bloodGroup: String,
    address: String,
    picture: String,

    fatherName: String,
    motherName: String,
    fatherOccupation: String,
    motherOccupation: String,

    siblings: [{
      relationship: String,
      name: String,
      occupation: String
    }],

    department: String,
    designation: String,
    employmentType: String,
    dateJoined: Date,
    experience: String,

    previousExperiences: [{
      previousCompany: String,
      employmentType: String,
      designation: String,
      department: String,
      dateOfJoining: Date,
      lastWorkingDate: Date,
      totalExperience: String,
      previousSalary: String
    }],

    educationPath: {
      type: String,
      enum: ["12th", "Diploma", ""],
    },

    school10: String,
    marks10: String,
    marksheet10: String,
    passedOutYear10: String,

    school12: String,
    marks12: String,
    marksheet12: String,
    passedOutYear12: String,

    careerGaps: [{
      employeeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Employee",
      },
      educationStage: {
        type: String,
        default: "10th to 12th Standard",
      },
      passedOutYear10: String,
      expectedYear12: String,
      actualYear12: String,
      passedOutYear12: String,
      expectedUGYear: String,
      actualUGYear: String,
      expectedDiplomaYear: String,
      actualDiplomaYear: String,
      gapDuration: Number,
      reason: String,
      createdAt: {
        type: Date,
        default: Date.now,
      },
    }],

    courses: [{
      courseType: {
        type: String,
        enum: ["Diploma", "UG", "PG"],
        default: "UG"
      },
      collegeName: String,
      courseName: String,
      cgpa: String,
      passedOutYear: String,
      joiningYear: String,
      certificate: String
    }],

    professionalCertifications: {
      type: [{
        courseName: String,
        startMonthYear: String,
        endMonthYear: String,
        courseDuration: String,
        durationValue: String,
        durationUnit: String,
        durationType: String,
        courseType: String,
        institutionName: String,
        certificate: String,
        createdAt: {
          type: Date,
          default: Date.now,
        },
      }],
      default: undefined,
    },
    hasCertifications: {
      type: String,
      default: undefined,
    },

    aadhaarNo: String,
    panNo: String,
    uanNo: String,
    pfNo: String,

    bankName: String,
    accountHolder: String,
    accountNumber: String,
    ifscCode: String,
    branch: String,
    lastBankUpdate: Date,
    passbookFile: String,

    aadhaarFile: String,
    panFile: String,

    profileCompletion: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    },

    profileApprovalStatus: {
      type: String,
      enum: ["pending", "approved", "rejected", null],
      default: null,
    },

    rejectionRemark: {
      type: String,
      default: "",
    },

    rejectedFields: {
      type: [String],
      default: [],
    },

    submittedForApprovalAt: {
      type: Date
    },

    reviewedAt: {
      type: Date,
    },

    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
    },

    lastUpdatedAt: {
      type: Date,
      default: Date.now
    },


    bankHistory: [
      {
        bankName: String,
        accountHolder: String,
        accountNumber: String,
        ifscCode: String,
        branch: String,
        fromDate: Date,
        toDate: Date,
        addedAt: {
          type: Date,
          default: Date.now
        }
      }
    ],

    salaryHistory: [
      {
        fromDate: {
          type: Date,
          required: true
        },
        toDate: {
          type: Date,
          required: false
        },
        basicSalary: {
          type: Number,
          required: true,
          min: 0
        },
        allowances: [{
          label: String,
          value: { type: Number, default: 0 }
        }],
        totalSalary: {
          type: Number,
          min: 0
        },
        addedAt: {
          type: Date,
          default: Date.now
        }
      }
    ],

    incrementDocuments: [
      {
        financialYear: {
          type: String,
          required: true
        },
        incrementLetter: {
          fileKey: String,
          fileName: String,
          fileType: String,
          uploadedAt: {
            type: Date,
            default: Date.now
          }
        },
        performanceForm: {
          type: new mongoose.Schema({
            fileKey: String,
            fileName: String,
            fileType: String,
            uploadedAt: Date
          }, { _id: false }),
          default: undefined,
          required: false
        },
        salaryId: {
          type: mongoose.Schema.Types.ObjectId,
          default: null
        },
        uploadedAt: {
          type: Date,
          default: Date.now
        }
      }
    ],

  },
  { timestamps: true }
);
module.exports =
  mongoose.models.EmployeeDetails ||
  mongoose.model("EmployeeDetails", employeeDetailsSchema);
