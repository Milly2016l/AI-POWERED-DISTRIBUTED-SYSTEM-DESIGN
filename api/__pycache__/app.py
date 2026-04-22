from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime
from pydantic import BaseModel
from BiustSystem.ingestion.producer import send_to_kafka

app = FastAPI(title="BIUST Monitoring API")

# Allow React dashboard to talk to FastAPI
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Models ─────────────────────────────────────────────────────

class Metrics(BaseModel):
    server_id: str = "dashboard"
    cpu: int
    memory: int
    requests: int
    latency: int

# ── In-memory store for latest metrics ─────────────────────────
latest_metrics = []

# ── Routes ─────────────────────────────────────────────────────

@app.get("/")
def home():
    return {"message": "BIUST Monitoring API running"}

@app.get("/health")
def health():
    return {"status": "healthy"}

@app.post("/metrics")
def receive_metrics(data: Metrics):
    """Receives metrics from dashboard or simulator and sends to Kafka"""
    payload = {
        "server_id": data.server_id,
        "cpu_usage": data.cpu,
        "memory_usage": data.memory,
        "requests": data.requests,
        "latency": data.latency,
        "timestamp": datetime.utcnow().isoformat()
    }

    # Keep last 20 metrics in memory for dashboard polling
    latest_metrics.append(payload)
    if len(latest_metrics) > 20:
        latest_metrics.pop(0)

    # Send to Kafka pipeline
    send_to_kafka(payload)

    print("RECEIVED & SENT TO KAFKA:", payload)
    return {"status": "sent", "data": payload}

@app.get("/metrics/latest")
def get_latest_metrics():
    """Returns the last 20 metrics for the dashboard to poll"""
    return {"metrics": latest_metrics}

@app.post("/predict")
def predict(data: Metrics):
    """AI prediction endpoint - baseline weighted formula"""
    predicted_load = round(
        (data.cpu * 0.4 +
         data.memory * 0.3 +
         data.requests * 0.002 +
         data.latency * 0.1) / 100,
        2
    )

    alert = None
    if data.cpu > 80:
        alert = f"HIGH CPU: {data.cpu}%"
    elif data.memory > 80:
        alert = f"HIGH MEMORY: {data.memory}%"

    return {
        "predicted_load": predicted_load,
        "alert": alert,
        "recommendation": "scale_up" if predicted_load > 0.75 else "normal"
    }