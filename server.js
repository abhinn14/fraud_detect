import express from "express";
import fs from "fs";
import cors from "cors";
import bodyParser from "body-parser";
import axios from "axios";
import { Transaction } from "./models/Transaction.js";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

const app = express();
const PORT = process.env.PORT || 5000;
const CSV_FILE = "./data/transactions.csv";
const FLASK_URL = "https://fraudy.onrender.com/assess";


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
      console.log("🛡 Medium risk detected. Answer verification required.");
      return res.status(200).json({ tx, verification_required: true });
    }
  } catch (err) {
    console.error("Error in /transactions:", err);
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

app.post("/verify-transaction", async (req, res) => {
  const { answer, transaction } = req.body;

  if (!answer || !transaction) {
    console.error("⛔️ Missing 'answer' or 'transaction' in request.");
    return res.status(400).json({ verified: false, error: "Missing required data" });
  }

  const finalTxData = { ...transaction };

  try {
    console.log(`🔐 Verifying answer: "${answer}"`);
    if (answer.toLowerCase().trim() === "gaming") {
      finalTxData.is_fraud = false;
      appendTransaction(new Transaction(finalTxData));
      console.log("✅ Correct answer. Transaction verified.");
      return res.json({ verified: true });
    } else {
      finalTxData.is_fraud = true;
      appendTransaction(new Transaction(finalTxData));
      console.log("❌ Wrong answer. Transaction flagged as fraud.");
      return res.status(400).json({ verified: false, error: "Incorrect answer" });
    }
  } catch (err) {
    console.error("💥 Error during answer verification:", err.message);
    finalTxData.is_fraud = true;
    appendTransaction(new Transaction(finalTxData));
    return res.status(500).json({ verified: false, error: "Verification error" });
  }
});
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});