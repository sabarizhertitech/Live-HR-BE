// ? MUST be first
require("dotenv").config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const xss = require('xss-clean');
const passport = require('passport');
const http = require('http');
const path = require('path');
const fs = require('fs');


const app = express();
const server = http.createServer(app);

const { PORT, MONGODB_URI } = require('./utilities/config');

// Routes
const UsersRoutes = require('./Routes/UsersRoute');
const AttendanceRoutes = require('./Routes/Attendace');
const ReminderRoutes = require("./Routes/Reminder");
const leaveRoutes = require("./Routes/leaveRoutes");
const leaveCategoryRoutes = require("./Routes/leaveCategoryRoutes");
const adminTask = require("./Routes/task.routes");
const ProfileEditRoutes = require("./Routes/ProfileEdit");
const Users = require("./Routes/Users");
const TodoRoutes = require("./Routes/todoRoutes");
const holidayRoutes = require("./Routes/holidayRoutes");
const holidayAssignmentRoutes = require("./Routes/holidayAssignmentRoutes");
const security = require("./Routes/Securityroutes");
const SalarySlipRoutes = require("./Routes/Salaryslip");
const NotificationRoutes = require("./Routes/NotificationRoutes");
const ThirukkuralRoutes = require("./Routes/ThirukkuralRoutes");
const auditRoutes = require("./Routes/auditRoutes");
const paymentScriptsRoutes = require("./Routes/paymentScriptsRoutes");
const menuPermissionRoutes = require("./Routes/menuPermissionRoutes");
const crawlRoutes = require("./Routes/crawlRoutes");
const hrApprovalRoutes = require("./Routes/hrApprovalRoutes");
const letterRoutes = require("./Routes/letterRoutes");
// const websiteContentRoutes = require('./Routes/websiteContentRoutes');
const whatsAppRoutes = require('./Whatsapp/routes/whatsappRoutes');
const whatsAppSupportRoutes = require('./Whatsapp/routes/supportRoutes');
const whatsAppTicketRoutes = require('./Whatsapp/routes/supportTicketRoutes');
const whatsAppTrainingRoutes = require('./Whatsapp/routes/trainingRoutes');
const instagramCareRoutes = require('./Routes/care/instagramCareRoutes');
const facebookCareRoutes = require('./Routes/care/facebookCareRoutes');
const careRoutes = require('./Routes/care/careRoutes');
const Mandate = require('./Routes/Mandate')




// Cron Jobs
require("./Crons/dailyAutoLeave.cron");
require('./Crons/attendance.cron');
require('./Crons/reminderEmail.cron');
require('./Crons/YearlyLeaveCron');
// require('./Crons/whatsappMorningAttendance.cron'); // Paused for now


// Trust proxy
app.set('trust proxy', true);


// ? Middleware
app.use(cors());



app.use(helmet({
    crossOriginResourcePolicy: {
        policy: "cross-origin"
    }
}));


app.use("/uploads",
    express.static(path.join(__dirname, "uploads"))
);

app.use("/public",
    express.static(path.join(__dirname, "Public"))
);


app.use(passport.initialize());


// ? IMPORTANT
app.use(express.json({
    limit: '50mb'
}));

app.use(express.urlencoded({
    extended: true,
    limit: '50mb'
}));

app.use(xss());


app.use('/instagram', instagramCareRoutes);
app.use('/api/instagram', instagramCareRoutes);
app.use('/facebook', facebookCareRoutes);
app.use('/api/facebook', facebookCareRoutes);


app.use('/api/facebook-review', facebookCareRoutes);
app.use('/facebook-review', facebookCareRoutes);

app.use('/api/care', careRoutes);


// ? FCM ROUTES
app.use("/api/notifications", NotificationRoutes);


// ? Your existing routes
app.use('/data', UsersRoutes);
app.use('/portal', AttendanceRoutes);
app.use('/', ReminderRoutes);
app.use('/profile', ProfileEditRoutes);
app.use('/users', Users);
app.use('/creat', adminTask);
app.use("/api/leaves", leaveRoutes);
app.use("/leave-categories", leaveCategoryRoutes);
app.use("/holiday-assignments", holidayAssignmentRoutes);
app.use("/holidays", holidayRoutes);
app.use('/todo', TodoRoutes);
app.use("/security", security);
app.use("/salary-slip", SalarySlipRoutes);
app.use('/thirukkural', ThirukkuralRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/payment-scripts', paymentScriptsRoutes);
app.use('/menu-permission', menuPermissionRoutes);
app.use("/web/crawler", crawlRoutes);
app.use('/hr-approval', hrApprovalRoutes);
app.use('/appointment/letter', letterRoutes);
// app.use('/website-content', websiteContentRoutes);
// ? WhatsApp AI Chatbot & Customer Support Routes
app.use('/whatsapp', whatsAppRoutes);
app.use('/api/whatsapp', whatsAppRoutes);
app.use('/', whatsAppRoutes);
app.use('/api/support/tickets', whatsAppTicketRoutes);
app.use('/api/support', whatsAppSupportRoutes);
app.use('/cub', Mandate);



// ? DB Connection
(async () => {

    try {

        await mongoose.connect(
            MONGODB_URI,
            {
                maxPoolSize: 50,
            }
        );

        console.log(
            'Mongoose connection successful'
        );

    } catch (error) {

        console.error(
            'Mongoose connection error:',
            error.message
        );

        process.exit(1);
    }

    mongoose.connection.on(
        'disconnected',
        () => {

            console.log(
                'Mongoose connection is disconnected'
            );
        }
    );

})();


// ? Server
server.timeout = 600000; // 10 minutes timeout for crawling operations
server.keepAliveTimeout = 610000;
server.headersTimeout = 620000;

server.listen(PORT, "0.0.0.0", () => {

    console.log(
        `Server is running at PORT NO : ${PORT}`
    );

});