"""
BIUST AI Model Trainer
======================
Trains a real scikit-learn model on historical metric data.
Run this script once to generate and save the model.

Usage:
    python ai/train.py
"""

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.preprocessing import StandardScaler
import joblib
import os

# ── Create output folder ────────────────────────────────────────
os.makedirs("ai/model", exist_ok=True)

print("=" * 50)
print("BIUST AI Model Trainer")
print("=" * 50)

# ── Step 1: Generate realistic training data ────────────────────
# In Week 4 this will be replaced with real InfluxDB data.
# For now we simulate realistic BIUST server patterns.

print("\n[1/4] Generating training data...")

np.random.seed(42)
n_samples = 5000

# Simulate time-of-day patterns (peak hours = higher load)
hours = np.random.randint(0, 24, n_samples)
is_peak = ((hours >= 8) & (hours <= 10)) | ((hours >= 13) & (hours <= 15))
is_registration = np.random.random(n_samples) < 0.1  # 10% chance of registration spike

# Generate features with realistic patterns
cpu = np.clip(
    np.where(is_registration, np.random.uniform(75, 98, n_samples),
    np.where(is_peak, np.random.uniform(50, 85, n_samples),
    np.random.uniform(15, 55, n_samples))) + np.random.normal(0, 5, n_samples),
    0, 100
)

memory = np.clip(
    np.where(is_registration, np.random.uniform(70, 95, n_samples),
    np.where(is_peak, np.random.uniform(45, 80, n_samples),
    np.random.uniform(20, 55, n_samples))) + np.random.normal(0, 5, n_samples),
    0, 100
)

requests = np.clip(
    np.where(is_registration, np.random.uniform(800, 2000, n_samples),
    np.where(is_peak, np.random.uniform(400, 900, n_samples),
    np.random.uniform(50, 400, n_samples))) + np.random.normal(0, 20, n_samples),
    0, 2000
)

latency = np.clip(
    np.where(cpu > 80, np.random.uniform(200, 500, n_samples),
    np.where(cpu > 60, np.random.uniform(100, 250, n_samples),
    np.random.uniform(20, 120, n_samples))) + np.random.normal(0, 10, n_samples),
    0, 500
)

# Target: system load score (0.0 = idle, 1.0 = overloaded)
# This is what the model learns to predict
load_score = np.clip(
    (cpu * 0.35 + memory * 0.30 + (requests / 2000) * 100 * 0.20 + (latency / 500) * 100 * 0.15) / 100
    + np.random.normal(0, 0.02, n_samples),
    0, 1
)

# Build DataFrame
df = pd.DataFrame({
    "cpu": cpu,
    "memory": memory,
    "requests": requests,
    "latency": latency,
    "hour": hours,
    "is_peak": is_peak.astype(int),
    "load_score": load_score
})

print(f"    Generated {len(df)} samples")
print(f"    Average load score: {load_score.mean():.3f}")
print(f"    Peak hour samples: {is_peak.sum()}")
print(f"    Registration spike samples: {is_registration.sum()}")

# ── Step 2: Prepare features ────────────────────────────────────
print("\n[2/4] Preparing features...")

FEATURES = ["cpu", "memory", "requests", "latency", "hour", "is_peak"]
TARGET = "load_score"

X = df[FEATURES]
y = df[TARGET]

X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, random_state=42
)

# Scale features
scaler = StandardScaler()
X_train_scaled = scaler.fit_transform(X_train)
X_test_scaled = scaler.transform(X_test)

print(f"    Training samples: {len(X_train)}")
print(f"    Test samples:     {len(X_test)}")
print(f"    Features: {FEATURES}")

# ── Step 3: Train the model ─────────────────────────────────────
print("\n[3/4] Training Random Forest model...")

model = RandomForestRegressor(
    n_estimators=100,
    max_depth=10,
    min_samples_split=5,
    random_state=42,
    n_jobs=-1
)

model.fit(X_train_scaled, y_train)

# Evaluate
y_pred = model.predict(X_test_scaled)
mae = mean_absolute_error(y_test, y_pred)
r2 = r2_score(y_test, y_pred)

print(f"    Model trained successfully!")
print(f"    Mean Absolute Error: {mae:.4f}")
print(f"    R² Score:            {r2:.4f}")

# Feature importance
print("\n    Feature Importances:")
for feat, imp in sorted(zip(FEATURES, model.feature_importances_), key=lambda x: -x[1]):
    bar = "█" * int(imp * 40)
    print(f"      {feat:<12} {bar} {imp:.3f}")

# ── Step 4: Save model & scaler ─────────────────────────────────
print("\n[4/4] Saving model...")

joblib.dump(model, "ai/model/load_model.pkl")
joblib.dump(scaler, "ai/model/scaler.pkl")

print("    Saved: ai/model/load_model.pkl")
print("    Saved: ai/model/scaler.pkl")

print("\n" + "=" * 50)
print("Training complete!")
print(f"MAE: {mae:.4f} | R²: {r2:.4f}")
print("Run the API and the model will load automatically.")
print("=" * 50)