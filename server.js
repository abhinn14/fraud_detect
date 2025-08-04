import express from "express";
import fs from "fs";
import cors from "cors";
import bodyParser from "body-parser";
import axios from "axios";
import { Transaction } from "./models/Transaction.js";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import dotenv from "dotenv";
import pkg from "twilio";
const { Twilio } = pkg;

dotenv.config();

// --- CRITICAL: Check for environment variables on start ---
if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_VERIFY_SERVICE_SID) {
    console.error("FATAL ERROR: Twilio environment variables are not set. Please check your .env file.");
    process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 5000;
const CSV_FILE = "./data/transactions.csv";
const FLASK_URL = process.env.FLASK_URL || "http://localhost:5001/assess";

const twilio = new Twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;

app.use(cors());
app.use(bodyParser.json());

function readTransactions() {
  if (!fs.existsSync(CSV_FILE)) return [];
  const csvData = fs.readFileSync(CSV_FILE);
  return parse(csvData, { columns: true, skip_empty_lines: true }).map(row => new Transaction(row));
}

function appendTransaction(transaction) {
  const all = readTransactions();
  all.unshift(transaction);
  const csv = stringify(all.map(t => ({ ...t })), { header: true });
  fs.writeFileSync(CSV_FILE, csv);
}

app.get("/transactions", (req, res) => {
  res.json(readTransactions());
});

app.post("/transactions", async (req, res) => {
  try {
    const txData = { ...req.body };
    const flaskRes = await axios.post(FLASK_URL, txData);
    const { risk, is_fraud } = flaskRes.data;
    const tx = new Transaction({ ...txData, risk_level: risk, is_fraud });

    if (risk === "Low" || risk === "High") {
      appendTransaction(tx);
      return res.status(201).json({ tx });
    }
    
    if (risk === "Medium") {
      const to = process.env.OTP_RECIPIENT;
      await twilio.verify.services(verifyServiceSid).verifications.create({ to, channel: "sms" });
      console.log(`🔑 OTP sent to ${to}. Holding transaction.`);
      return res.status(200).json({ tx, otp_sent: true });
    }
  } catch (err) {
    console.error("Error in /transactions:", err);
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// This endpoint now has robust logging and error handling
app.post("/verify-transaction", async (req, res) => {
    const { code, transaction } = req.body;
    const to = process.env.OTP_RECIPIENT;

    if (!to || !code || !transaction) {
        console.error("⛔️ Error: Request or server environment is missing data.");
        return res.status(400).json({ verified: false, error: "Missing required data" });
    }

    // Create a new, final transaction object by copying the pending one.
    // This ensures we are not modifying an old object.
    const finalTxData = { ...transaction };

    try {
        console.log(`Verifying OTP for ${to} with code "${code}"...`);
        const verification_check = await twilio.verify
            .services(verifyServiceSid)
            .verificationChecks.create({ to, code });
        
        console.log(`✅ Twilio status: ${verification_check.status}`);

        if (verification_check.status === "approved") {
            // On success, definitively set is_fraud to false.
            finalTxData.is_fraud = false; 
            appendTransaction(new Transaction(finalTxData));
            return res.json({ verified: true });
        } else {
            // On failure, definitively set is_fraud to true.
            finalTxData.is_fraud = true; 
            appendTransaction(new Transaction(finalTxData));
            return res.status(400).json({ verified: false, error: "Invalid code" });
        }
    } catch (err) {
        console.error("💥 ERROR during Twilio verification:", err.message);
        // Also handle system errors by flagging as fraud.
        finalTxData.is_fraud = true; 
        appendTransaction(new Transaction(finalTxData));
        return res.status(500).json({ verified: false, error: "Verification system error." });
    }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});