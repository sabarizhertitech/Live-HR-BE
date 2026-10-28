const Customer = require("../models/Customer");
const Transaction = require("../models/Transaction");

const extractDate = (text) => {
    // Matches DD-MM-YYYY or DD/MM/YYYY
    const dmyRegex = /\b(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})\b/;
    const dmyMatch = text.match(dmyRegex);
    if (dmyMatch) {
        const day = parseInt(dmyMatch[1], 10);
        const month = parseInt(dmyMatch[2], 10) - 1;
        let year = parseInt(dmyMatch[3], 10);
        if (year < 100) {
            year += 2000;
        }
        return new Date(Date.UTC(year, month, day));
    }

    // Matches YYYY-MM-DD or YYYY/MM/DD
    const ymdRegex = /\b(\d{2,4})[-/](\d{1,2})[-/](\d{1,2})\b/;
    const ymdMatch = text.match(ymdRegex);
    if (ymdMatch) {
        let year = parseInt(ymdMatch[1], 10);
        if (year < 100) {
            year += 2000;
        }
        const month = parseInt(ymdMatch[2], 10) - 1;
        const day = parseInt(ymdMatch[3], 10);
        return new Date(Date.UTC(year, month, day));
    }

    return null;
};

class PayInService {

    async payIn(message, phone) {

        try {

            const text =
                message
                    ?.trim()
                    ?.toLowerCase();

            // =====================================
            // Specific Date PayIn Query
            // =====================================

            const dateMatch = extractDate(text);
            if (dateMatch) {
                if (!phone) {
                    return "Unable to detect phone number. Please try again.";
                }

                const customer = await Customer.findOne({ mobileNumber: phone });
                if (!customer) {
                    return "Customer profile not found. Please complete registration.";
                }

                const startOfDay = new Date(dateMatch);
                startOfDay.setUTCHours(0, 0, 0, 0);

                const endOfDay = new Date(dateMatch);
                endOfDay.setUTCHours(23, 59, 59, 999);

                const txns = await Transaction.find({
                    customerId: customer.customerId,
                    transactionType: "Payin",
                    transactionStatus: "SUCCESS",
                    transactionDate: {
                        $gte: startOfDay,
                        $lte: endOfDay
                    }
                });

                const totalAmount = txns.reduce((sum, t) => sum + t.amount, 0);

                const dateStr = dateMatch.toLocaleDateString("en-US", {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                    timeZone: "UTC"
                });

                return `💰 *PayIn Collection Report*\n\nOn *${dateStr}*, you received a total of *₹${totalAmount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}* across ${txns.length} successful QR payments.`;
            }

            // =====================================
            // Static QR
            // FIX: Removed isEscalated = true — was permanently blocking customer from bot
            // Now raises support query via __SUPPORT__ signal without locking conversation
            // =====================================

            if (
                text.includes("static qr") ||
                text === "1"
            ) {
                return (
                    "__SUPPORT__:📌 *Static QR*\n\n" +
                    "Your request has been noted. Our support team will contact you shortly to help set up your Static QR. 🙋‍♂️"
                );
            }

            // =====================================
            // Dynamic QR
            // FIX: Same fix as Static QR
            // =====================================

            if (
                text.includes("dynamic qr") ||
                text === "2"
            ) {
                return (
                    "__SUPPORT__:📌 *Dynamic QR*\n\n" +
                    "Your request has been noted. Our support team will contact you shortly to help set up your Dynamic QR. 🙋‍♂️"
                );
            }

            // =====================================
            // QR Payment Status
            // =====================================

            if (
                text.includes("payment status") ||
                text.includes("qr payment status") ||
                text === "3"
            ) {

                return (
                    "📌 *QR Payment Status*\n\n" +
                    "Please provide your Transaction ID or UTR Number to check the payment status."
                );

            }

            // =====================================
            // Download QR
            // =====================================

            if (
                text.includes("download qr") ||
                text === "4"
            ) {

                return (
                    "📌 *Download QR*\n\n" +
                    "Please log in to your ErtiPay Merchant Dashboard to download your QR code."
                );

            }

            // =====================================
            // Today's Collection
            // =====================================

            if (
                text.includes("today collection") ||
                text.includes("today's collection") ||
                text === "5"
            ) {
                if (!phone) {
                    return "Unable to detect phone number. Please try again.";
                }

                const customer = await Customer.findOne({ mobileNumber: phone });
                if (!customer) {
                    return "Customer profile not found. Please complete registration.";
                }

                const now = new Date();
                const startOfDay = new Date(now);
                startOfDay.setUTCHours(0, 0, 0, 0);

                const endOfDay = new Date(now);
                endOfDay.setUTCHours(23, 59, 59, 999);

                const txns = await Transaction.find({
                    customerId: customer.customerId,
                    transactionType: "Payin",
                    transactionStatus: "SUCCESS",
                    transactionDate: {
                        $gte: startOfDay,
                        $lte: endOfDay
                    }
                });

                const totalAmount = txns.reduce((sum, t) => sum + t.amount, 0);

                return (
                    `💰 *Today's Collection Summary*\n\n` +
                    `Merchant: *${customer.customerName}*\n` +
                    `Total Collection: *₹${totalAmount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}*\n` +
                    `Successful Payments: *${txns.length}*\n\n` +
                    `Reply *MENU* to return to the PayIn menu.`
                );

            }

            // =====================================
            // Settlement Status
            // =====================================

            if (
                text.includes("settlement") ||
                text === "6"
            ) {

                return (
                    "📌 *Settlement Status*\n\n" +
                    "Please provide your Merchant ID or Settlement ID to check the settlement status."
                );

            }

            // =====================================
            // Failed Payment
            // =====================================

            if (
                text.includes("failed payment") ||
                text === "7"
            ) {

                return (
                    "__SUPPORT__:📌 *Failed Payment*\n\n" +
                    "Your failed payment has been flagged. Please share your Transaction ID or UTR Number and our support team will investigate shortly. 🙋‍♂️"
                );

            }

            // =====================================
            // Default PayIn Menu
            // =====================================

            return (

                "💳 *ErtiPay PayIn Services*\n\n" +

                "Please choose an option:\n\n" +

                "1️⃣ Static QR\n" +
                "2️⃣ Dynamic QR\n" +
                "3️⃣ QR Payment Status\n" +
                "4️⃣ Download QR\n" +
                "5️⃣ Today's Collection\n" +
                "6️⃣ Settlement Status\n" +
                "7️⃣ Failed Payment\n\n" +

                "Reply with the option number or service name."

            );

        } catch (error) {
            return (
                "Unable to process your PayIn request. Please try again later."
            );
        }

    }

}

module.exports = new PayInService();