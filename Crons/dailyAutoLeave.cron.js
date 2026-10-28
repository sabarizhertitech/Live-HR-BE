const cron = require("node-cron");
const moment = require("moment-timezone");

const LeaveRequest = require("../Models/LeaveRequest");
const Attendance = require("../Models/Attendance.model");
const Employee = require("../Models/Employee");
const Holiday = require("../Models/Holiday.model");

console.log("🚀 Auto Attendance Cron Loaded");

const job = cron.schedule(
  "00 11 * * *", // 11:00 AM IST
  async () => {
    try {
      const now = moment().tz("Asia/Kolkata");
      const dateStr = now.format("YYYY-MM-DD");
      const dayOfWeek = now.day(); // 0 = Sunday, 6 = Saturday
      const dayOfMonth = now.date();

      console.log(`⏰ Running Auto Attendance Cron for ${dateStr}`);

      // 1️⃣ Sunday Check
      if (dayOfWeek === 0) {
        console.log("🛑 Sunday detected, skipping cron");
        return;
      }

      // 2️⃣ 2nd & 4th Saturday Check
      if (dayOfWeek === 6) {
        const weekNum = Math.ceil(dayOfMonth / 7);
        if (weekNum === 2 || weekNum === 4) {
          console.log(`🛑 ${weekNum}th Saturday detected, skipping cron`);
          return;
        }
      }

      // 3️⃣ Holiday check
      const isHoliday = await Holiday.findOne({ date: dateStr });
      if (isHoliday) {
        console.log("📅 Holiday detected, skipping cron");
        return;
      }

      // 👥 Get employees
      const employees = await Employee.find({
        role: "employee",
        employmentStatus: "active",
        workingStatus: true,
      })
        .select("_id")
        .lean();

      if (!employees.length) {
        console.log("No employees found");
        return;
      }

      const employeeIds = employees.map((e) => e._id);

      // 📌 Today's attendance
      const todayAttendance = await Attendance.find({
        employeeId: { $in: employeeIds },
        date: dateStr,
      }).lean();

      const attendanceMap = new Map();
      todayAttendance.forEach((att) => {
        attendanceMap.set(att.employeeId.toString(), att);
      });

      // 🏖 Approved leaves
      const approvedLeaves = await LeaveRequest.find({
        employeeId: { $in: employeeIds },
        status: "Approved",
        fromDate: { $lte: now.endOf("day").toDate() },
        toDate: { $gte: now.startOf("day").toDate() },
      }).lean();

      const leaveMap = new Map();
      approvedLeaves.forEach((l) => {
        leaveMap.set(l.employeeId.toString(), l);
      });

      // ⚡ Bulk ops
      const bulkOps = [];

      for (const emp of employees) {
        const empId = emp._id.toString();
        const existing = attendanceMap.get(empId);

        // ✅ Already exists → skip
        if (existing) continue;

        // ✅ Leave
        if (leaveMap.has(empId)) {
          const l = leaveMap.get(empId);
          const isHalfDay = l && (l.dayType === "Half Day" || l.noOfDays === 0.5);
          bulkOps.push({
            insertOne: {
              document: {
                employeeId: emp._id,
                date: dateStr,
                status: isHalfDay ? "Half Day Leave" : "Leave",
                remarks: isHalfDay ? "Half Day Leave" : "Leave Approved",
              },
            },
          });
          continue;
        }

        // ❌ Absent
        bulkOps.push({
          insertOne: {
            document: {
              employeeId: emp._id,
              date: dateStr,
              status: "Absent",
            },
          },
        });
      }

      // 🚀 Execute
      if (bulkOps.length > 0) {
        const result = await Attendance.bulkWrite(bulkOps, {
          ordered: false,
        });

        console.log(
          `✅ Inserted: ${result.insertedCount || 0} records`
        );
      } else {
        console.log("ℹ️ No updates needed");
      }

      console.log("✅ Auto Attendance Cron Completed");
    } catch (err) {
      console.error("❌ Auto Attendance Cron Failed:", err);
    }
  },
  {
    timezone: "Asia/Kolkata",
  }
);

job.start();