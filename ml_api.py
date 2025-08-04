from flask import Flask, request, jsonify
from ml import load_models, assess
from datetime import datetime

app = Flask(__name__)
models = load_models()

@app.route("/assess", methods=["POST"])
def assess_transaction():
    data = request.json

    # Optional: normalize ISO timestamp → hour
    t = data.get("time")
    print(data)
    if isinstance(t, str):
        t = datetime.fromisoformat(t.rstrip("Z")).hour
        print(f"t is {t}")
        data["time"] = t+12
    try:
        result = assess(data, models)
        risk = result["risk"]
        risk = risk.replace(" Risk", "")
        response = {
            "risk":          risk,
            "probabilities": result["probs"],
            "flags":         result["flags"],
            "is_fraud" : False
        }

        if risk == "High":
            response["is_fraud"] = True
        # print(response)
        return jsonify(response)

    except Exception as e:
        return jsonify({"error": str(e)}), 400

if __name__ == "__main__":
    app.run(port=5001, debug=True)
