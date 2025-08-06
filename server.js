import express from "express";
import fs from "fs";
import cors from "cors";
import bodyParser from "body-parser";
import axios from "axios";
import { Transaction } from "./models/Transaction.js";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import dotenv from "dotenv";
dotenv.config();
import { OpenAI } from "openai";

const app = express();
const PORT = 5000;
const CSV_FILE = "./data/transactions.csv";
const CSV_FILE2 = "./sms.csv";
const FLASK_URL = "https://fraudy.onrender.com/assess";
app.use(cors());

app.use(bodyParser.json());
app.use(express.json());

function readSms() {
  // Check if the file exists
  if (!fs.existsSync(CSV_FILE2)) {
    return [];
  }

  // Read the CSV file content
  const csvData = fs.readFileSync(CSV_FILE2);

  // Parse the CSV data into an array of objects
  const records = parse(csvData, {
    columns: true, // Use the first row as headers
    skip_empty_lines: true,
  });

  return records;
}

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
    
    const isoTime = txData.time;
    if (txData.time && typeof txData.time === 'string') {
        const date = new Date(txData.time);
        // Convert to UTC hour (0-23), which is what the Python server expects
        txData.time = date.getUTCHours(); 
    }
    const flaskRes = await axios.post(FLASK_URL, txData);
    const { risk, is_fraud } = flaskRes.data;
    const tx = new Transaction({ ...txData, created_at: isoTime, risk_level: risk, is_fraud });

    if (risk === "Low" || risk === "High") {
      appendTransaction(tx);
      return res.status(201).json({ tx , verification_required: false });
    }

    if (risk === "Medium") {
      console.log("🛡 Medium risk detected. Answer verification required.");
      return res.status(200).json({ tx, verification_required: true });
    }
  } catch (err) {
    console.error("Error in /transactions:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/verify-transaction", async (req, res) => {
  const { answer, latestTransaction } = req.body;

  if (!answer || !latestTransaction) {
    console.error("⛔️ Missing 'answer' or 'transaction' in request.");
    return res.status(400).json({ verified: false, error: "Missing required data" });
  }
//
  const finalTxData = { ...latestTransaction };
  const a =9;

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

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,  // or leave blank to pull from OPENAI_API_KEY env var
});


app.get("/sms", (req, res) => {
  try {
    const smsMessages = readSms();           // readSms() returns an array of { header: value, … }
    res.json(smsMessages);                   // send it straight back
  } catch (err) {
    console.error("Error in GET /sms:", err);
    res.status(500).json({ error: "Failed to load SMS data" });
  }
});


app.post("/api/check-sms", async (req, res) => {
  try {
    const smsMessages = req.body.messages;
    if (!Array.isArray(smsMessages)) {
      return res.status(400).json({ error: "Request body must have a 'messages' array" });
    }
    if (!smsMessages.length) {
      // no messages → no fraud
      return res.json({ label: 1 });
    }

    // ——————————————————————————————
    // 1. One‐shot overall prompt:
    // ——————————————————————————————
    const prompt = [
      {
        role: "system",
        content:
          "You are a scam-detection assistant. If there is any fraudulent SMS in the list, reply with exactly '0'. Otherwise reply with exactly '1'."
      },
      {
        role: "user",
        content: smsMessages
          .map((msg, i) => `Message ${i+1}: "${msg}"`)
          .join("\n")
      }
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: prompt,
      temperature: 0,
      max_tokens: 5
    });

    // ——————————————————————————————
    // 2. Extract the single digit
    // ——————————————————————————————
    const reply = completion.choices[0].message.content.trim();
    const match = reply.match(/[01]/);
    const label = match ? Number(match[0]) : 0; 
    // default to 0=scam if model mis-formats

    // ——————————————————————————————
    // 3. Return it
    // ——————————————————————————————
    res.json({ label });
  } catch (err) {
    console.error("Error in /sms-check:", err);
    res.status(500).json({ error: err.message });
  }
});


app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});