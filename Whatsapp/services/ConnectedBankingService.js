const Customer = require("../models/Customer");
const Transaction = require("../models/Transaction");

class ConnectedBankingService {

    async connectedBanking(message, phone) {

        try {

            const text =
                message
                    ?.trim()
                    ?.toLowerCase();

            // =====================================
            // Account Verification
            // =====================================

            if (
                text.includes("account verification") ||
                text.includes("verify account") ||
                text === "1"
            ) {

                return (
                    "__SUPPORT__:🏦 *Account Verification*\n\n" +
                    "Your request has been noted. Our support team will assist you with bank account verification shortly. 🙋‍♂️"
                );

            }

            // =====================================
            // Balance Enquiry
            // =====================================

            if (
                text.includes("balance") ||
                text.includes("balance enquiry") ||
                text === "2"
            ) {
                if (!phone) {
                    return "Unable to verify account owner. Please try again.";
                }

                const customer = await Customer.findOne({ mobileNumber: phone });
                if (!customer) {
                    return "Customer profile not found. Please complete registration.";
                }

                return (
                    `🏦 *ErtiPay Balance Enquiry*\n\n` +
                    `For security reasons, your account balance is not displayed directly on WhatsApp.\n\n` +
                    `• Please log in to your *ErtiPay Merchant Dashboard* to view your balance securely.\n` +
                    `• Or reply *SUPPORT* to connect with our support team.\n\n` +
                    `Reply *MENU* to return to the Connected Banking menu.`
                );

            }

            // =====================================
            // NEFT Transfer
            // FIX: Now raises support query — bot cannot process actual bank transfers
            // =====================================

            if (
                text.includes("neft") ||
                text === "3"
            ) {

                return (
                    "__SUPPORT__:🏦 *NEFT Transfer*\n\n" +
                    "Your NEFT transfer request has been noted. Our support team will contact you shortly to process it. 🙋‍♂️"
                );

            }

            // =====================================
            // RTGS Transfer
            // FIX: Now raises support query
            // =====================================

            if (
                text.includes("rtgs") ||
                text === "4"
            ) {

                return (
                    "__SUPPORT__:🏦 *RTGS Transfer*\n\n" +
                    "Your RTGS transfer request has been noted. Our support team will contact you shortly to process it. 🙋‍♂️"
                );

            }

            // =====================================
            // UPI Payout
            // FIX: Now raises support query
            // =====================================

            if (
                text.includes("upi payout") ||
                text.includes("payout") ||
                text === "5"
            ) {

                return (
                    "__SUPPORT__:💸 *UPI Payout*\n\n" +
                    "Your UPI payout request has been noted. Our support team will contact you shortly to process it. 🙋‍♂️"
                );

            }

            // =====================================
            // Beneficiary Status
            // =====================================

            if (
                text.includes("beneficiary") ||
                text.includes("beneficiary status") ||
                text === "6"
            ) {

                return (
                    "👤 *Beneficiary Status*\n\n" +
                    "Please provide the Beneficiary ID to check its current status."
                );

            }

            // =====================================
            // Transaction Status
            // FIX: Removed broad "status" keyword that was catching unrelated messages
            // =====================================

            if (
                text.includes("transaction status") ||
                text === "7"
            ) {

                return (
                    "📄 *Transaction Status*\n\n" +
                    "Please provide the Transaction ID or UTR Number."
                );

            }

            // =====================================
            // Failed Payout
            // =====================================

            if (
                text.includes("failed payout") ||
                text === "8"
            ) {

                return (
                    "__SUPPORT__:❌ *Failed Payout*\n\n" +
                    "Your failed payout has been flagged. Our support team will investigate and contact you shortly. 🙋‍♂️"
                );

            }

            // =====================================
            // Default Menu
            // =====================================

            return (

                "🏦 *Connected Banking*\n\n" +

                "Please choose an option:\n\n" +

                "1️⃣ Account Verification\n" +
                "2️⃣ Balance Enquiry\n" +
                "3️⃣ NEFT\n" +
                "4️⃣ RTGS\n" +
                "5️⃣ UPI Payout\n" +
                "6️⃣ Beneficiary Status\n" +
                "7️⃣ Transaction Status\n" +
                "8️⃣ Failed Payout\n\n" +

                "Reply with the option number or service name."

            );

        } catch (error) {
            return (
                "Unable to process your Connected Banking request."
            );
        }

    }

}

module.exports = new ConnectedBankingService();