const cron = require("node-cron");
const moment = require("moment-timezone");
const Reminder = require("../Models/Reminder");
const transporter = require("../utilities/emailTransporter");

cron.schedule("* * * * *", async () => {
  try {
    const now = moment().tz("Asia/Kolkata").toDate();

    const reminders = await Reminder.find({
      "notifications.notifyAt": { $lte: now },
      "notifications.isSent": false,
    });

    if (reminders.length === 0) return;

    for (const reminder of reminders) {
      const emails = new Set();
      if (reminder.email) emails.add(reminder.email);
      if (Array.isArray(reminder.participants)) {
        reminder.participants.forEach((p) => {
          if (p.email) emails.add(p.email);
        });
      }


      if (emails.size === 0) continue;

      let hasSentAny = false;

      for (const n of reminder.notifications) {
        if (n.isSent) continue;
        if (n.notifyAt > now) continue;

        // send email
        await transporter.sendMail({
          from: `"HR Portal" <${process.env.EMAIL_USER}>`,
          to: Array.from(emails),
          subject: `Reminder: ${reminder.title}`,
          html: `
  <div style="font-family: Arial, sans-serif; background:#f4f6f8; padding:20px">
    <div style="max-width:600px; margin:auto; background:#ffffff; border-radius:8px; overflow:hidden">

      <div style="background:#4f46e5; color:#ffffff; padding:20px">
        <h2 style="margin:0">⏰ Reminder Notification</h2>
      </div>

      <div style="padding:20px">
        <h3 style="margin-top:0; color:#111827">${reminder.title}</h3>

        <p style="color:#374151; line-height:1.6">
          ${reminder.details || "You have an upcoming task scheduled."}
        </p>

        <table style="width:100%; margin-top:20px; border-collapse:collapse">
          <tr>
            <td style="padding:8px 0; color:#6b7280"><b>Date</b></td>
            <td style="padding:8px 0">${moment(reminder.date).format("DD MMM YYYY")}</td>
          </tr>

          <tr>
            <td style="padding:8px 0; color:#6b7280"><b>Time</b></td>
            <td style="padding:8px 0">
              ${reminder.eventTime || "--"}
            </td>
           </tr>

          <tr>
            <td style="padding:8px 0; color:#6b7280"><b>Category</b></td>
            <td style="padding:8px 0">${reminder.category}</td>
          </tr>
        </table>
        <p style="margin-top:30px; color:#374151">
          Regards,<br/>
          <b>HR Portal</b>
        </p>
      </div>

      <div style="background:#f9fafb; text-align:center; padding:12px; font-size:12px; color:#9ca3af">
        © ${new Date().getFullYear()} Ertitech. All rights reserved.
      </div>

      <div style="margin-top:25px; padding:15px; background:#fef3c7; border-radius:8px;">
          <b>Please Note:</b> This is an automated reminder. Make sure you’re prepared.
        </div>
    </div>
  </div>
`,
        });

        n.isSent = true;
        hasSentAny = true;
      }

      if (hasSentAny) {
        await reminder.save();
      }
    }
  } catch (err) {
    console.error("Reminder Cron Error:", err.message);
  }
});

module.exports = {};
