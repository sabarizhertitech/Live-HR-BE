const cron = require("node-cron");
const Employee = require("../Models/Employee");
const LeaveCategory = require("../Models/LeaveCategory");
const LeaveBalance = require("../Models/LeaveBalance");

// Run on April 1st every year at 00:00 (Midnight)
// "0 0 1 4 *"
const rolloverJob = cron.schedule("0 0 1 4 *", async () => {
  try {
    console.log("⚙️ Running Yearly Leave Rollover Cron...");

    const getFinancialYearForDate = (date) => {
      const d = new Date(date);
      const month = d.getMonth(); // 0 is Jan, 3 is April
      const year = d.getFullYear();
      if (month >= 3) {
        return `${year}-${year + 1}`;
      } else {
        return `${year - 1}-${year}`;
      }
    };

    const today = new Date();
    const newYear = getFinancialYearForDate(today); // E.g., "2026-2027"

    // Calculate previous year
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
          tiers: c.tiers
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

    const employees = await Employee.find({
      employmentStatus: "active",
      status: { $ne: "relieved" },
      role: { $ne: "admin" },
      isDeleted: { $ne: true },
    });
    const currentDate = new Date();

    // Update each active employee by setting their nested leaveBalances for the newYear in LeaveBalance model
    const updatePromises = employees.map((emp) => {
      const joiningDate = new Date(emp.dateJoined || emp.createdAt || currentDate);
      const serviceMonths =
        (currentDate.getFullYear() - joiningDate.getFullYear()) * 12 +
        (currentDate.getMonth() - joiningDate.getMonth());

      const employeeBalances = {};
      activeCategories.forEach((cat) => {
        let allowedLeaves = 0;
        if (cat.tiers && cat.tiers.length > 0) {
          const matchedTier = cat.tiers.find(t => serviceMonths >= t.eligibleMonths);
          allowedLeaves = matchedTier ? matchedTier.leaveCount : 0;
        } else {
          allowedLeaves = cat.leaveCount || 0;
        }

        employeeBalances[cat.name] = {
          total: allowedLeaves,
          used: 0,
          remaining: allowedLeaves,
        };
      });

      return LeaveBalance.updateOne(
        { employeeId: emp._id },
        {
          $set: {
            [`leaveBalances.${newYear}`]: employeeBalances,
          },
        },
        { upsert: true }
      );
    });

    await Promise.all(updatePromises);

    console.log(
      `✅ Successfully initialized leave balances for ${employees.length} employees for the new financial year ${newYear}.`
    );
  } catch (error) {
    console.error("❌ Error running yearly leave rollover cron:", error);
  }
});

module.exports = rolloverJob;
