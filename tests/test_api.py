"""
tests/test_api.py
==================
Unit tests for the BIUST Monitoring API (api/app.py).

Run from project root:
    pytest tests/ -v
"""

import sys
import os
import pytest
from fastapi.testclient import TestClient

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.app import app

client = TestClient(app)

VALID_METRIC = {
    "server_id": "test-node",
    "cpu":       65,
    "memory":    55,
    "requests":  800,
    "latency":   120,
}


def test_health_endpoint():
    """GET /health should return 200 and status healthy."""
    res = client.get("/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "healthy"


def test_metrics_post():
    """POST /metrics with valid data should return status sent."""
    res = client.post("/metrics", json=VALID_METRIC)
    assert res.status_code == 200
    assert res.json()["status"] == "sent"


def test_metrics_post_invalid():
    """POST /metrics with missing required fields should return 422."""
    res = client.post("/metrics", json={"server_id": "bad-node"})
    assert res.status_code == 422


def test_predict_endpoint():
    """POST /predict should return predicted_load between 0.0 and 1.0."""
    res = client.post("/predict", json=VALID_METRIC)
    assert res.status_code == 200
    load = res.json()["predicted_load"]
    assert 0.0 <= load <= 1.0


def test_predict_uses_real_model():
    """POST /predict should use the trained RandomForest model."""
    res = client.post("/predict", json=VALID_METRIC)
    assert res.status_code == 200
    model_type = res.json().get("model_type", "")
    assert "RandomForest" in model_type, (
        f"Expected RandomForest model, got: {model_type}. "
        "Run: python ai/train.py"
    )


def test_metrics_latest():
    """GET /metrics/latest should return a dict with a metrics list."""
    res = client.get("/metrics/latest")
    assert res.status_code == 200
    data = res.json()
    assert "metrics" in data
    assert isinstance(data["metrics"], list)


def test_scaling_events():
    """GET /scaling/events should return a dict with an events list."""
    res = client.get("/scaling/events")
    assert res.status_code == 200
    data = res.json()
    assert "events" in data
    assert isinstance(data["events"], list)


def test_scaling_event_post():
    """POST /scaling/event should log the message and return logged."""
    res = client.post("/scaling/event", json={"message": "Test scale up event"})
    assert res.status_code == 200
    assert res.json()["status"] == "logged"

    # Verify it appears in the events list
    events = client.get("/scaling/events").json()["events"]
    messages = [e["message"] for e in events]
    assert "Test scale up event" in messages


def test_workers_count():
    """GET /workers/count should return a count integer."""
    res = client.get("/workers/count")
    assert res.status_code == 200
    assert "count" in res.json()
    assert isinstance(res.json()["count"], int)