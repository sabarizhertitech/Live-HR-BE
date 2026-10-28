const cron = require("node-cron");
const Employee = require("../Models/Employee");
const Notification = require("../Models/Notification");

// Run on March 15th every year at 00:00 (Midnight)
// "0 0 15 3 *"
const reminderJob = cron.schedule("0 0 15 3 *", async () => {
  try {
    console.log("⚙️ Running Yearly Leave Settings Reminder Cron...");

    // Find all Admins
    const admins = await Employee.find({ role: "admin", employmentStatus: "active" });

    if (admins.length === 0) {
      console.log("No admins found to send yearly reminder.");
      return;
    }

    const currentYear = new Date().getFullYear();
    const nextYear = currentYear + 1;

    // Clean up any existing unread reminders to prevent duplicates
    await Notification.deleteMany({ type: "SYSTEM_REMINDER" });

    // Create a notification for each admin
    const notifications = admins.map(admin => ({
      type: "SYSTEM_REMINDER",
      toEmployee: admin._id,
      toAdmin: true,
      title: "Action Required: Update Leave Categories",
      message: `The new financial year (${currentYear}-${nextYear}) starts soon. Please review and update the Leave Categories and their limits before April 1st. These limits will be automatically applied to all employees on April 1st.`,
      metadata: {
        requestType: "SYSTEM"
      }
    }));

    await Notification.insertMany(notifications);
    console.log(`✅ Sent yearly leave reminder to ${admins.length} admins.`);

  } catch (error) {
    console.error("❌ Error running yearly leave reminder cron:", error);
  }
});

module.exports = reminderJob;
