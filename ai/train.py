"""
ai/train.py
============
Trains a RandomForest model to predict server load scores.

Two modes:
  python ai/train.py                    # synthetic data (default)
  python ai/train.py --source influxdb  # real InfluxDB data

The trained model and scaler are saved to:
  ai/model/load_model.pkl
  ai/model/scaler.pkl
"""

import os
import sys
import argparse
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.preprocessing import StandardScaler
import joblib

# ── InfluxDB settings (used when --source influxdb) ────────────
INFLUX_URL    = os.getenv("INFLUX_URL",    "http://localhost:8086")
INFLUX_TOKEN  = os.getenv("INFLUX_TOKEN",  "biust-super-secret-token")
INFLUX_ORG    = os.getenv("INFLUX_ORG",    "biust")
INFLUX_BUCKET = os.getenv("INFLUX_BUCKET", "metrics")

FEATURES = ["cpu", "memory", "requests", "latency", "hour", "is_peak"]
TARGET   = "load_score"

os.makedirs("ai/model", exist_ok=True)


# ── Data sources ─────────────────────────────────────────────────

def load_synthetic_data() -> pd.DataFrame:
    """
    Generate 5,000 synthetic metric samples with realistic
    BIUST server load patterns including peak hours and
    registration spikes.

    Returns:
        DataFrame with feature columns and load_score target.
    """
    np.random.seed(42)
    n = 5000

    hours            = np.random.randint(0, 24, n)
    is_peak          = ((hours >= 8) & (hours <= 10)) | ((hours >= 13) & (hours <= 15))
    is_registration  = np.random.random(n) < 0.10

    cpu = np.clip(
        np.where(is_registration, np.random.uniform(75, 98, n),
        np.where(is_peak,         np.random.uniform(50, 85, n),
                                  np.random.uniform(15, 55, n)))
        + np.random.normal(0, 5, n), 0, 100)

    memory = np.clip(
        np.where(is_registration, np.random.uniform(70, 95, n),
        np.where(is_peak,         np.random.uniform(45, 80, n),
                                  np.random.uniform(20, 55, n)))
        + np.random.normal(0, 5, n), 0, 100)

    requests = np.clip(
        np.where(is_registration, np.random.uniform(800, 2000, n),
        np.where(is_peak,         np.random.uniform(400, 900, n),
                                  np.random.uniform(50,  400, n)))
        + np.random.normal(0, 20, n), 0, 2000)

    latency = np.clip(
        np.where(cpu > 80, np.random.uniform(200, 500, n),
        np.where(cpu > 60, np.random.uniform(100, 250, n),
                           np.random.uniform(20,  120, n)))
        + np.random.normal(0, 10, n), 0, 500)

    load_score = np.clip(
        (cpu * 0.35 + memory * 0.30
         + (requests / 2000) * 100 * 0.20
         + (latency  / 500)  * 100 * 0.15) / 100
        + np.random.normal(0, 0.02, n), 0, 1)

    return pd.DataFrame({
        "cpu":        cpu,
        "memory":     memory,
        "requests":   requests,
        "latency":    latency,
        "hour":       hours,
        "is_peak":    is_peak.astype(int),
        "load_score": load_score,
    })


def load_influxdb_data() -> pd.DataFrame:
    """
    Query all metrics from InfluxDB and build a training DataFrame.
    Requires influxdb-client to be installed and InfluxDB to be running.

    Returns:
        DataFrame with feature columns and load_score target,
        or empty DataFrame if query fails.
    """
    try:
        from influxdb_client import InfluxDBClient
    except ImportError:
        print("ERROR: influxdb-client not installed. Run: pip install influxdb-client")
        sys.exit(1)

    print(f"[InfluxDB] Connecting to {INFLUX_URL}...")
    client    = InfluxDBClient(url=INFLUX_URL, token=INFLUX_TOKEN, org=INFLUX_ORG)
    query_api = client.query_api()

    flux = f"""
    from(bucket: "{INFLUX_BUCKET}")
      |> range(start: -30d)
      |> filter(fn: (r) => r._measurement == "server_metrics")
      |> pivot(rowKey:["_time", "server_id"],
               columnKey: ["_field"],
               valueColumn: "_value")
      |> sort(columns: ["_time"], desc: false)
    """

    try:
        tables = query_api.query(flux, org=INFLUX_ORG)
    except Exception as e:
        print(f"ERROR: InfluxDB query failed — {e}")
        sys.exit(1)

    rows = []
    for table in tables:
        for record in table.records:
            v = record.values
            ts = record.get_time()
            rows.append({
                "cpu":      float(v.get("cpu_usage",    0)),
                "memory":   float(v.get("memory_usage", 0)),
                "requests": float(v.get("requests",     0)),
                "latency":  float(v.get("latency",      0)),
                "hour":     ts.hour,
                "is_peak":  1 if (8 <= ts.hour <= 10 or 13 <= ts.hour <= 15) else 0,
            })

    if not rows:
        print("ERROR: No data found in InfluxDB. Run the simulator for 10+ minutes first.")
        sys.exit(1)

    df = pd.DataFrame(rows)

    # Compute load_score from real field values
    df["load_score"] = np.clip(
        (df["cpu"] * 0.35
         + df["memory"] * 0.30
         + (df["requests"] / 2000) * 100 * 0.20
         + (df["latency"]  / 500)  * 100 * 0.15) / 100,
        0, 1
    )

    print(f"[InfluxDB] Retrieved {len(df)} real data points")
    return df


# ── Training pipeline ────────────────────────────────────────────

def train(df: pd.DataFrame, source_label: str) -> None:
    """
    Train a RandomForestRegressor on the given DataFrame,
    evaluate it, and save the model and scaler to disk.

    Args:
        df:           DataFrame containing FEATURES and TARGET columns.
        source_label: label string for logging ("synthetic" or "InfluxDB").
    """
    print("\n" + "=" * 50)
    print(f"  BIUST AI Model Trainer — source: {source_label}")
    print("=" * 50)

    print(f"\n[1/4] Dataset — {len(df)} samples")
    print(f"      Average load score: {df[TARGET].mean():.3f}")

    print("\n[2/4] Preparing features...")
    X = df[FEATURES]
    y = df[TARGET]

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42)

    scaler = StandardScaler()
    X_train_s = scaler.fit_transform(X_train)
    X_test_s  = scaler.transform(X_test)

    print(f"      Training: {len(X_train)} | Test: {len(X_test)}")

    print("\n[3/4] Training RandomForest...")
    model = RandomForestRegressor(
        n_estimators=100, max_depth=10,
        min_samples_split=5, random_state=42, n_jobs=-1)
    model.fit(X_train_s, y_train)

    y_pred = model.predict(X_test_s)
    mae    = mean_absolute_error(y_test, y_pred)
    r2     = r2_score(y_test, y_pred)

    print(f"      MAE:  {mae:.4f}")
    print(f"      R²:   {r2:.4f}")

    print("\n      Feature importances:")
    for feat, imp in sorted(
            zip(FEATURES, model.feature_importances_), key=lambda x: -x[1]):
        bar = "█" * int(imp * 40)
        print(f"        {feat:<12} {bar} {imp:.3f}")

    print("\n[4/4] Saving model...")
    joblib.dump(model,  "ai/model/load_model.pkl")
    joblib.dump(scaler, "ai/model/scaler.pkl")
    print("      Saved: ai/model/load_model.pkl")
    print("      Saved: ai/model/scaler.pkl")

    if source_label != "synthetic":
        print(f"\nModel retrained on {len(df)} real data points from InfluxDB")

    print("\n" + "=" * 50)
    print(f"Training complete! MAE: {mae:.4f} | R²: {r2:.4f}")
    print("=" * 50)


# ── Entry point ──────────────────────────────────────────────────

def main() -> None:
    """Parse CLI arguments and run the appropriate training mode."""
    parser = argparse.ArgumentParser(description="BIUST AI Model Trainer")
    parser.add_argument(
        "--source",
        choices=["synthetic", "influxdb"],
        default="synthetic",
        help="Data source: 'synthetic' (default) or 'influxdb'"
    )
    args = parser.parse_args()

    if args.source == "influxdb":
        df = load_influxdb_data()
    else:
        print("[1/4] Generating synthetic training data...")
        df = load_synthetic_data()
        print(f"      Generated {len(df)} samples")
        print(f"      Average load score: {df[TARGET].mean():.3f}")
        print(f"      Peak hour samples:  {df['is_peak'].sum()}")

    train(df, source_label=args.source)


if __name__ == "__main__":
    main()