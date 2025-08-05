// models/Transaction.js
export class Transaction {
  constructor({
    id,
    sender,
    receiver,
    amount,
    time,
    created_at,
    is_fraud,
    risk_level,
    ip_address,
    location,
  }) {
    this.id = id;
    this.sender     = sender;
    this.receiver   = receiver;
    this.amount     = Number(amount) || "-";
    // store both the ML timestamp and the original time field
    this.created_at = created_at;  
    this.time       = time;        
    // normalize is_fraud to string "true"/"false"
    this.is_fraud   = 
      (typeof is_fraud === "boolean" ? is_fraud : is_fraud === "true") 
        ? "true" 
        : "false";
    this.risk_level = risk_level     || "low";
    this.ip_address = ip_address     || "-";
    this.location   = location       || "Unknown";
  }
}
