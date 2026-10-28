
const Employee = require("../Models/Employee");
const EmployeeDetails = require("../Models/EmployeeDetails");
const LeaveBalance = require("../Models/LeaveBalance");
const deleteFromS3 = require("../utilities/s3Delete");
const generateSignedUrl = require("../utilities/s3SignedUrl");
const getCachedSignedUrl = require("../utilities/s3CachedUrl");
const fs = require('fs');
const path = require('path');

/* =====================================================
   GET ALL EMPLOYEES (ADMIN)
===================================================== */
exports.getAllEmployees = async (req, res) => {
  try {
    // 🔹 Fetch all employees (exclude deleted ones & only role === "employee")
    const employees = await Employee.find({
      isDeleted: { $ne: true },
      role: "employee",
    })
      .select("-passwordHash")
      .sort({ createdAt: -1 });

    // 🔹 Fetch all employee details for profile completion & empIdString
    const employeeDetails = await EmployeeDetails.find({ isDeleted: { $ne: true } }).lean();

    // 🔹 Create a map of empId -> details
    const detailsMap = {};
    employeeDetails.forEach((detail) => {
      if (detail.empId) {
        detailsMap[detail.empId.toString()] = detail;
      }
    });

    // 🔹 Format response
    const formattedEmployees = await Promise.all(
      employees.map(async (emp) => {
        const details = detailsMap[emp._id.toString()] || {};

        let photoUrl = null;

        if (emp.photo && emp.photo !== "avatar.png") {
          try {
            photoUrl = await getCachedSignedUrl(emp.photo);
          } catch (err) {
            console.error("Signed URL error:", err.message);
          }
        }

        return {
          id: emp._id,
          name: emp.name || details.name,
          designation: emp.designation || details.designation,
          status: (emp.status || "").toLowerCase(),
          workingStatus: emp.workingStatus,
          employeeId: emp.empId,
          email: emp.email || details.email,
          department: emp.department || details.department,
          dateJoined: emp.dateJoined
            ? emp.dateJoined.toISOString()
            : details.dateOfJoining
              ? new Date(details.dateOfJoining).toISOString()
              : null,
          role: emp.role,
          isHr: !!emp.isHr,
          profileCompletion: details.profileCompletion || 0,
          profileApprovalStatus: details.profileApprovalStatus || emp.profileApprovalStatus || ((details.profileCompletion >= 100 && !emp.isProfileCompleted) ? "pending" : (emp.isProfileCompleted ? "approved" : null)),
          isProfileCompleted: !!emp.isProfileCompleted,
          rejectionRemark: details.rejectionRemark || "",
          photo: photoUrl,
          hasBankDetails: !!((details.bankName && details.accountNumber) || (details.bankHistory && details.bankHistory.length > 0)),
        };
      })
    );

    return res.status(200).json({
      success: true,
      count: formattedEmployees.length,
      data: formattedEmployees,
    });
  } catch (error) {
    console.error("❌ Get Employees Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch employees",
    });
  }
};

/* =====================================================
   DELETE EMPLOYEE (ADMIN) - HARD DELETE
===================================================== */
exports.deleteEmployee = async (req, res) => {
  try {
    const { empIdString } = req.params;

    const employeeDetails = await EmployeeDetails.findOne({ empIdString });

    if (!employeeDetails) {
      return res.status(404).json({
        success: false,
        message: `Employee with ID ${empIdString} not found`,
      });
    }

    const empId = employeeDetails.empId;

    const filesToDelete = [
      employeeDetails.photo,
      employeeDetails.aadhaarFile,
      employeeDetails.panFile,
      employeeDetails.passbookFile,
      employeeDetails.marksheet10,
      employeeDetails.marksheet12,
    ];

    filesToDelete.forEach((filePath) => {
      if (filePath) {
        try {
          let fullPath;

          if (filePath.startsWith("/")) {
            fullPath = path.join(__dirname, "..", filePath);
          } else {
            fullPath = path.join(__dirname, "..", filePath);
          }

          if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
          }
        } catch (fileErr) {
          console.warn(
            "⚠️ Could not delete file:",
            filePath,
            fileErr.message
          );
        }
      }
    });

    await EmployeeDetails.findByIdAndDelete(employeeDetails._id);

    if (empId) {
      await Employee.findByIdAndDelete(empId);
      await LeaveBalance.deleteMany({ employeeId: empId });
    }

    return res.status(200).json({
      success: true,
      message: `Employee ${empIdString} has been permanently deleted`,
      deletedId: empIdString,
    });
  } catch (error) {
    console.error("❌ Delete Employee Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to delete employee",
      error: error.message,
    });
  }
};

/* =====================================================
   TOGGLE / ASSIGN SINGLE HR ROLE (ADMIN)
===================================================== */
exports.setSingleHrRole = async (req, res) => {
  try {
    const { employeeId } = req.body; // Target employee _id

    if (!employeeId) {
      return res.status(400).json({ success: false, message: "Employee ID is required" });
    }

    const targetEmp = await Employee.findById(employeeId);
    if (!targetEmp) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    const isCurrentlyHr = Boolean(targetEmp.isHr);

    // Remove isHr field from ALL employees first (enforces single HR rule)
    await Employee.updateMany({}, { $unset: { isHr: "" } });

    // If it wasn't HR before, set this employee as HR
    if (!isCurrentlyHr) {
      await Employee.findByIdAndUpdate(employeeId, { $set: { isHr: true } });
    }

    return res.status(200).json({
      success: true,
      message: !isCurrentlyHr
        ? `${targetEmp.name} has been appointed as HR.`
        : `HR access revoked from ${targetEmp.name}.`,
      assignedHrId: !isCurrentlyHr ? targetEmp._id : null,
    });
  } catch (error) {
    console.error("❌ Set HR Role Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update HR assignment",
    });
  }
};

const apiLogger = require('../utils/apiLogger');
module.exports = apiLogger(module.exports, 'ManageEmployee.controller.js');

