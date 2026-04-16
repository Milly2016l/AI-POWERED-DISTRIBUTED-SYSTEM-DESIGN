from fastapi import FastAPI
from datetime import datetime
from models import Metrics
from producer import send_to_kafka

app = FastAPI()

@app.get("/")
def home():
    return {"message": "Ingestion API running"}

@app.post("/metrics")
def receive_metrics(data: Metrics):
    payload = data.dict()
    payload["timestamp"] = datetime.utcnow().isoformat()

    print("RECEIVED:", payload)

    send_to_kafka(payload)

    return {"status": "sent"}