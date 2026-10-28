const cron = require("node-cron");
const Employee = require("../Models/Employee");
const LeaveCategory = require("../Models/LeaveCategory");
const LeaveBalance = require("../Models/LeaveBalance");
const Notification = require("../Models/Notification");
const HolidayAssignment = require("../Models/Holiday Assignment");
const {
  getCurrentFinancialYear,
  calculateServiceMonths,
  calculateCategoryLeaves,
} = require("../utilities/financialYearUtil");
const { isEmployeeInProbation } = require("../utilities/probationHelper");

// Run every day at midnight (0 0 * * *)
const yearlyLeaveCron = cron.schedule("0 0 * * *", async () => {
  const today = new Date();
  const month = today.getMonth(); // 0-indexed: March is 2, April is 3
  const day = today.getDate();

  // ─── PART A: March 1st — Send reminder & prepare next financial year's categories ───
  if (month === 2 && day === 1) {
    try {
      console.log("⚙️ Running Yearly Leave Settings Reminder Cron (March 1st)...");

      const currentYear = today.getFullYear();
      const nextYear = currentYear + 1;
      const nextFinancialYear = `${currentYear}-${nextYear}`;
      const prevFinancialYear = `${currentYear - 1}-${currentYear}`;

      // Check idempotency: check if notifications for nextFinancialYear already sent
      const alreadySent = await Notification.exists({
        type: "SYSTEM_REMINDER",
        "metadata.financialYear": nextFinancialYear,
      });

      // Create next year's LeaveCategory draft document if it doesn't exist
      let nextYearDoc = await LeaveCategory.findOne({ financialYear: nextFinancialYear });
      if (!nextYearDoc) {
        console.log(`Creating leave categories draft for ${nextFinancialYear}...`);
        const prevYearDoc = await LeaveCategory.findOne({ financialYear: prevFinancialYear });
        const categoriesToCopy = prevYearDoc
          ? prevYearDoc.categories.map((c) => ({
            name: c.name,
            leaveCount: c.leaveCount,
            eligibleMonths: c.eligibleMonths,
            probationOthersLeaveCount: c.probationOthersLeaveCount || 0,
            permanentOthersLeaveCount: c.permanentOthersLeaveCount || 0,
            tiers: c.tiers ? c.tiers.map((t) => ({ ...t.toObject() })) : [],
          }))
          : [];

        nextYearDoc = new LeaveCategory({
          financialYear: nextFinancialYear,
          categories: categoriesToCopy,
          status: "pending",
          isReviewed: false,
        });
        await nextYearDoc.save();
      }

      if (!alreadySent) {
        // Find all active admins and HR users
        const users = await Employee.find({
          $or: [{ role: "admin" }, { isHr: true }],
          employmentStatus: "active",
        }).select("_id role isHr");

        if (users.length > 0) {
          const notifications = users.map((u) => ({
            type: "SYSTEM_REMINDER",
            toEmployee: u._id,
            toAdmin: u.role === "admin",
            title: `Action Required: Prepare FY ${nextFinancialYear} Leave Categories`,
            message: `The new financial year (${nextFinancialYear}) starts in April. Please review, update, and submit the Leave Categories before April 1st.`,
            metadata: { requestType: "SYSTEM", financialYear: nextFinancialYear },
          }));

          await Notification.insertMany(notifications);
          console.log(`✅ Sent yearly leave preparation reminder to ${users.length} admin/HR users.`);
        }
      }
    } catch (error) {
      console.error("❌ Error running yearly leave reminder cron:", error);
    }
  }

  // ─── PART B: April 1 — Rollover: initialize leave balances for new financial year ───
  if (month === 3 && day === 1) {
    try {
      console.log("⚙️ Running Yearly Leave Rollover Cron...");

      const newYear = getCurrentFinancialYear(today);
      const currentYearNum = today.getFullYear();
      const prevYear = `${currentYearNum - 1}-${currentYearNum}`;

      let newYearDoc = await LeaveCategory.findOne({ financialYear: newYear });
      if (!newYearDoc) {
        console.log(`Creating leave categories for new financial year ${newYear}...`);
        const prevYearDoc = await LeaveCategory.findOne({ financialYear: prevYear });
        const categoriesToCopy = prevYearDoc
          ? prevYearDoc.categories.map((c) => ({
            name: c.name,
            leaveCount: c.leaveCount,
            eligibleMonths: c.eligibleMonths,
            tiers: c.tiers,
          }))
          : [];

        newYearDoc = new LeaveCategory({
          financialYear: newYear,
          categories: categoriesToCopy,
        });
        await newYearDoc.save();
      }

      const activeCategories = newYearDoc.categories || [];
      if (activeCategories.length === 0) {
        console.log("No Leave Categories found for the new financial year. Skipping rollover.");
        return;
      }

      // Projection optimization: select only active, non-relieved, non-admin employees
      const employees = await Employee.find({
        employmentStatus: "active",
        status: { $ne: "relieved" },
        role: { $ne: "admin" },
        isDeleted: { $ne: true },
      })
        .select("_id dateJoined dateRelieved createdAt isProbation probationPeriod probationPeriodMonths")
        .lean();

      const currentDate = new Date();

      const bulkOps = employees.map((emp) => {
        const joiningDate = emp.dateJoined || emp.createdAt;
        const inProbation = isEmployeeInProbation(emp);
        const serviceMonths = calculateServiceMonths(joiningDate, currentDate);

        const yearBalances = {};
        activeCategories.forEach((cat) => {
          if (!cat || !cat.name) return;
          const allowedLeaves = calculateCategoryLeaves(cat, serviceMonths, inProbation);

          // ✅ ROLLOVER RESET BUG FIX: New financial year resets used to 0 & remaining to allowedLeaves
          yearBalances[cat.name] = {
            total: allowedLeaves,
            used: 0,
            remaining: allowedLeaves,
          };
        });

        return {
          updateOne: {
            filter: { employeeId: emp._id },
            update: { $set: { [`leaveBalances.${newYear}`]: yearBalances } },
            upsert: true,
          },
        };
      });

      if (bulkOps.length > 0) {
        await LeaveBalance.bulkWrite(bulkOps);
      }

      console.log(
        `✅ Successfully initialized leave balances for ${employees.length} employees for the new financial year ${newYear}.`
      );
    } catch (error) {
      console.error("❌ Error running yearly leave rollover cron:", error);
    }
  }

  // ─── PART C: December 1 — Auto-prepare upcoming year Holiday Calendar for HR ───
  if (month === 11 && day === 1) {
    try {
      console.log("⚙️ Running December 1st Upcoming Holiday Year Auto-Preparation Cron...");
      const currentYear = today.getFullYear();
      const upcomingYear = currentYear + 1;

      // Find active HR or Admin user
      const hrUser = (await Employee.findOne({ isHr: true, employmentStatus: "active" })) ||
        (await Employee.findOne({ role: "admin", employmentStatus: "active" }));

      if (hrUser) {
        const existing = await HolidayAssignment.findOne({ year: upcomingYear });
        if (!existing) {
          const newAssignment = new HolidayAssignment({
            assignedTo: hrUser._id,
            assignedBy: hrUser._id,
            year: upcomingYear,
            status: "pending",
            months: [],
            assignedDate: new Date(),
          });
          await newAssignment.save();
          console.log(`✅ Auto-initialized ${upcomingYear} Holiday Calendar assignment for ${hrUser.name}`);
        }
      }

      // Send in-app reminder notification to all HRs and Admins
      const hrUsers = await Employee.find({
        $or: [{ isHr: true }, { role: "admin" }],
        employmentStatus: "active",
      }).select("_id");

      const notifications = hrUsers.map((u) => ({
        type: "SYSTEM_REMINDER",
        toEmployee: u._id,
        toAdmin: true,
        title: `Action Required: Configure ${upcomingYear} Holiday Calendar`,
        message: `The year ${currentYear} is nearing completion. Please configure the Government Holidays and Special Days for ${upcomingYear} and submit for Admin approval.`,
        metadata: { requestType: "HOLIDAY_REMINDER", year: upcomingYear },
      }));

      if (notifications.length > 0) {
        await Notification.insertMany(notifications);
        console.log(`✅ Sent ${upcomingYear} holiday preparation reminder to ${hrUsers.length} HR/Admin users.`);
      }
    } catch (error) {
      console.error("❌ Error running December 1st holiday preparation cron:", error);
    }
  }
});

module.exports = yearlyLeaveCron;
