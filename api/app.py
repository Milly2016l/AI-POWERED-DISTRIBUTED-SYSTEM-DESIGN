from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from datetime import datetime
import joblib
import numpy as np
import os

app = FastAPI(title="BIUST Monitoring API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

MODEL_PATH = "ai/model/load_model.pkl"
SCALER_PATH = "ai/model/scaler.pkl"
model = None
scaler = None

if os.path.exists(MODEL_PATH) and os.path.exists(SCALER_PATH):
    model = joblib.load(MODEL_PATH)
    scaler = joblib.load(SCALER_PATH)
    print("AI model loaded successfully")
else:
    print("No trained model found. Run: python ai/train.py")

latest_metrics = []

class Metrics(BaseModel):
    server_id: str = "dashboard"
    cpu: int
    memory: int
    requests: int
    latency: int

@app.get("/")
def home():
    return {"message": "BIUST Monitoring API running", "ai_model": "loaded" if model else "not trained yet"}

@app.get("/health")
def health():
    return {"status": "healthy", "ai_model": "loaded" if model else "not trained"}

@app.get("/metrics/latest")
def get_latest_metrics():
    return {"metrics": latest_metrics}

@app.post("/metrics")
def receive_metrics(data: Metrics):
    payload = {"server_id": data.server_id, "cpu_usage": data.cpu, "memory_usage": data.memory, "requests": data.requests, "latency": data.latency, "timestamp": datetime.utcnow().isoformat()}
    latest_metrics.append(payload)
    if len(latest_metrics) > 20:
        latest_metrics.pop(0)
    print(f"RECEIVED: {payload}")
    return {"status": "sent", "data": payload}

@app.post("/predict")
def predict(data: Metrics):
    hour = datetime.utcnow().hour
    is_peak = 1 if (8 <= hour <= 10) or (13 <= hour <= 15) else 0
    if model and scaler:
        features = np.array([[data.cpu, data.memory, data.requests, data.latency, hour, is_peak]])
        predicted_load = float(round(model.predict(scaler.transform(features))[0], 3))
        model_type = "RandomForest (trained)"
    else:
        predicted_load = round((data.cpu * 0.35 + data.memory * 0.30 + (data.requests / 2000) * 100 * 0.20 + (data.latency / 500) * 100 * 0.15) / 100, 3)
        model_type = "formula (no model trained)"
    if data.cpu > 80 and data.memory > 80:
        alert = f"CRITICAL: CPU {data.cpu}% and Memory {data.memory}%"
        recommendation = "scale_up_urgent"
    elif data.cpu > 80:
        alert = f"HIGH CPU: {data.cpu}%"
        recommendation = "scale_up"
    elif data.memory > 80:
        alert = f"HIGH MEMORY: {data.memory}%"
        recommendation = "scale_up"
    elif predicted_load > 0.75:
        alert = f"HIGH PREDICTED LOAD: {predicted_load}"
        recommendation = "scale_up"
    else:
        alert = None
        recommendation = "normal"
    return {"predicted_load": predicted_load, "recommendation": recommendation, "alert": alert, "model_type": model_type, "context": {"hour": hour, "is_peak_hour": bool(is_peak)}}
