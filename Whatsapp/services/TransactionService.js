const Customer = require("../models/Customer");
const Transaction = require("../models/Transaction");

class TransactionService {

    async transaction(message, phone) {

        try {

            const text =
                message
                    ?.trim()
                    ?.toLowerCase();

            // =====================================
            // Secure Transaction ID / UTR Lookup
            // =====================================
            const txnIdMatch = text.match(/\b(txn[a-z0-9]+)\b/i);
            const refIdMatch = text.match(/\b(ref-[a-z]+-\d+)\b/i);

            const searchKey = txnIdMatch ? txnIdMatch[1].toUpperCase() : (refIdMatch ? refIdMatch[1].toUpperCase() : null);

            if (searchKey) {
                if (!phone) {
                    return "Unable to verify transaction owner. Please try again.";
                }

                const customer = await Customer.findOne({ mobileNumber: phone });
                if (!customer) {
                    return "Customer profile not found. Please complete registration.";
                }

                const txn = await Transaction.findOne({
                    $or: [
                        { transactionId: searchKey },
                        { referenceId: searchKey }
                    ]
                });

                if (!txn) {
                    return `Transaction *${searchKey}* not found in our database. Please double-check the ID.`;
                }

                // Security Check: Verify that the transaction belongs to the requesting customer
                if (txn.customerId !== customer.customerId) {
                    return "Security Alert: You do not have permission to view this transaction.";
                }

                return (
                    `📄 *Transaction Status*\n\n` +
                    `Transaction ID: *${txn.transactionId}*\n` +
                    `Amount: *₹${txn.amount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}*\n` +
                    `Status: *${txn.transactionStatus === "SUCCESS" ? "SUCCESS ✅" : txn.transactionStatus === "PENDING" ? "PENDING ⏳" : "FAILED ❌"}*` +
                    (txn.failureReason ? `\nReason: *${txn.failureReason}*` : "")
                );
            }

            // =====================================
            // Transaction Status
            // =====================================

            if (
                text.includes("transaction status") ||
                text.includes("status") ||
                text === "1"
            ) {

                return (
                    "📄 *Transaction Status*\n\n" +
                    "Please provide your Transaction ID to check the current transaction status."
                );

            }

            // =====================================
            // Search by Transaction ID
            // =====================================

            if (
                text.includes("transaction id") ||
                text === "2"
            ) {

                return (
                    "🆔 *Search by Transaction ID*\n\n" +
                    "Please enter your Transaction ID."
                );

            }

            // =====================================
            // Search by UTR Number
            // =====================================

            if (
                text.includes("utr") ||
                text.includes("utr number") ||
                text === "3"
            ) {

                return (
                    "🏦 *Search by UTR Number*\n\n" +
                    "Please enter your UTR Number."
                );

            }

            // =====================================
            // Search by Mobile Number
            // =====================================

            if (
                text.includes("mobile") ||
                text.includes("phone") ||
                text === "4"
            ) {

                return (
                    "📱 *Search by Mobile Number*\n\n" +
                    "Please enter the registered mobile number."
                );

            }

            // =====================================
            // Failed Transactions
            // =====================================

            if (
                text.includes("failed") ||
                text.includes("failed transaction") ||
                text === "5"
            ) {

                return (
                    "❌ *Failed Transactions*\n\n" +
                    "Please provide your Transaction ID or UTR Number so we can investigate the failed transaction."
                );

            }

            // =====================================
            // Pending Transactions
            // =====================================

            if (
                text.includes("pending") ||
                text.includes("pending transaction") ||
                text === "6"
            ) {

                return (
                    "⏳ *Pending Transactions*\n\n" +
                    "Please provide your Transaction ID to check the pending transaction status."
                );

            }

            // =====================================
            // Default Menu
            // =====================================

            return (

                "💰 *Transaction Support*\n\n" +

                "Please choose an option:\n\n" +

                "1️⃣ Check Transaction Status\n" +
                "2️⃣ Search by Transaction ID\n" +
                "3️⃣ Search by UTR Number\n" +
                "4️⃣ Search by Mobile Number\n" +
                "5️⃣ Failed Transactions\n" +
                "6️⃣ Pending Transactions\n\n" +

                "Reply with the option number or service name."

            );

        } catch (error) {
            return (
                "Unable to process your transaction request. Please try again later."
            );
        }

    }

}

module.exports = new TransactionService();