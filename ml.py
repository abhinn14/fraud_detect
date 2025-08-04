
import sys, joblib, warnings
from pathlib import Path
import numpy as np, pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler, OneHotEncoder
from sklearn.ensemble import IsolationForest
from sklearn.metrics import classification_report
from xgboost import XGBClassifier
import tensorflow as tf
from tensorflow import keras
from tensorflow.keras import layers

warnings.filterwarnings("ignore")

# ------------------------------------------------ CONFIG
DATA_PATH      = Path("data.csv")
RAND_SEED      = 42
NN_EPOCHS      = 60
NN_BATCH       = 32
SAFE_LOC_FILE  = "safe_locations.pkl"
tf.random.set_seed(RAND_SEED)
np.random.seed(RAND_SEED)

# --------------------------------- Neural-network builder
def build_nn(input_dim: int = 2) -> keras.Model:
    model = keras.Sequential([
        layers.Input(shape=(input_dim,)),
        layers.Dense(64, activation="relu"),
        layers.Dropout(0.3),
        layers.Dense(32, activation="relu"),
        layers.Dropout(0.2),
        layers.Dense(16, activation="relu"),
        layers.Dense(1,  activation="sigmoid")
    ])
    model.compile(
        optimizer=keras.optimizers.Adam(1e-3),
        loss="binary_crossentropy",
        metrics=["accuracy"]
    )
    return model

# ------------------------------------------------ TRAINING
def train_models(csv_path: Path = DATA_PATH):
    if not csv_path.exists():
        sys.exit(f"❌  {csv_path} not found")

    df = pd.read_csv(csv_path)
    req = {"amount", "time", "location", "risk"}
    if not req.issubset(df.columns):
        sys.exit(f"❌  CSV must contain columns {req}")

    df["amount"] = df["amount"].astype(int)
    df["time"]   = df["time"].astype(int)

    print(f"✔ {len(df)} rows  |  risk distribution:\n{df['risk'].value_counts()}\n")

    # -- derive SAFE_LOCATIONS from low-risk entries
    safe_locs = set(df[df['risk'] == 0]['location'].unique())
    joblib.dump(safe_locs, SAFE_LOC_FILE)
    print(f"✅  Derived {len(safe_locs)} safe locations from data and saved to {SAFE_LOC_FILE}\n")

    # ---------------- Isolation Forest on LOCATION
    ohe_loc = OneHotEncoder(handle_unknown="ignore", sparse_output=False)
    X_loc   = ohe_loc.fit_transform(df[["location"]])
    iso_loc = IsolationForest(
        n_estimators=150, contamination=0.01, random_state=RAND_SEED
    ).fit(X_loc)

    # ---------------- XGBoost & NN on AMOUNT+TIME
    scaler = StandardScaler()
    X_num  = scaler.fit_transform(df[["amount", "time"]])
    y      = df["risk"]

    X_tr, X_te, y_tr, y_te = train_test_split(
        X_num, y, test_size=0.2,
        stratify=y, random_state=RAND_SEED
    )

    # ---- XGBoost
    xgb = XGBClassifier(
        objective="binary:logistic",
        eval_metric="logloss",
        use_label_encoder=False,
        random_state=RAND_SEED,
        scale_pos_weight=(y_tr == 0).sum() / max((y_tr == 1).sum(), 1),
        verbosity=0
    )
    xgb.fit(X_tr, y_tr)
    print("=== XGBoost performance ===")
    print(classification_report(y_te, xgb.predict(X_te), digits=4))

    # ---- Neural-Network
    nn = build_nn(2)
    nn.fit(
        X_tr, y_tr,
        epochs=NN_EPOCHS,
        batch_size=NN_BATCH,
        validation_split=0.2,
        verbose=0
    )
    nn_pred = (nn.predict(X_te, verbose=0) > 0.5).astype(int).ravel()
    print("=== Neural Network performance ===")
    print(classification_report(y_te, nn_pred, digits=4))

    # ---- Save artefacts
    joblib.dump(scaler,        "scaler.pkl")
    joblib.dump(xgb,           "xgb_amt_time.pkl")
    nn.save("nn_amt_time.keras")
    joblib.dump(ohe_loc,       "ohe_location.pkl")
    joblib.dump(iso_loc,       "iso_location.pkl")
    print("\n✅  Saved: scaler.pkl, xgb_amt_time.pkl, nn_amt_time.keras, "
          "ohe_location.pkl, iso_location.pkl")

# ------------------------------------------------ LOAD
def load_models():
    return dict(
        scaler         = joblib.load("scaler.pkl"),
        xgb            = joblib.load("xgb_amt_time.pkl"),
        nn             = keras.models.load_model("nn_amt_time.keras"),
        ohe_loc        = joblib.load("ohe_location.pkl"),
        iso_loc        = joblib.load("iso_location.pkl"),
        safe_locations = joblib.load(SAFE_LOC_FILE)
    )

# ------------------------------------------------ PREDICT
def assess(tx: dict, mdl: dict) -> dict:
    """tx: {'amount':int,'time':int,'location':str} -> risk assessment"""
    amt  = int(tx["amount"])
    hour = int(tx["time"])
    if not (0 <= hour <= 23):
        raise ValueError("time must be 0-23")
    loc  = tx["location"]

    # amount+time → XGBoost & NN
    X = mdl["scaler"].transform([[amt, hour]])
    xgb_prob = mdl["xgb"].predict_proba(X)[0, 1]
    nn_prob  = mdl["nn"].predict(X, verbose=0)[0, 0]
    ensemble_prob = (xgb_prob + nn_prob) / 2
    amt_time_flag = ensemble_prob > 0.5

    # location → Isolation Forest + dynamic safe set
    loc_vec   = mdl["ohe_loc"].transform([[loc]])
    loc_flag  = bool(mdl["iso_loc"].predict(loc_vec)[0] == -1)
    loc_flag  = loc_flag or (loc not in mdl["safe_locations"])

    unusual = int(amt_time_flag) + int(loc_flag)
    risk = ("Low Risk", "Medium Risk", "High Risk")[min(unusual, 2)]

    return {
        "risk": risk,
        "flags": {
            "amount_time": bool(amt_time_flag),
            "location":    bool(loc_flag)
        },
        "probs": {
            "xgb":       float(xgb_prob),
            "nn":        float(nn_prob),
            "ensemble":  float(ensemble_prob)
        }
    }

# ------------------------------------------------ CLI
def cli():
    mdl = load_models()
    print("\n💳  Enter transaction details")
    amount   = int(input("Amount (int): ").strip())
    time_hour= int(input("Time (hour 0-23): ").strip())
    location = input("Location: ").strip()

    result = assess(dict(amount=amount, time=time_hour, location=location), mdl)

    print("\n=== RISK RESULT ===")
    print(f"Risk classification : {result['risk']}")
    print(f"Amount+Time flag    : {'UNUSUAL' if result['flags']['amount_time'] else 'normal'}")
    print(f"Location flag       : {'UNUSUAL' if result['flags']['location']    else 'normal'}")
    print(f"Ensemble probability: {result['probs']['ensemble']:.4f}")

# ------------------------------------------------ main
if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1].lower() == "train":
        train_models(DATA_PATH)
    else:
        cli()
