"""
BIUST Monitoring API — Final Production Version
=================================================
Fixes applied:
- /simulator/scenario  GET/POST  – lets frontend read & set the active scenario
- /workers/status      returns   – real InfluxDB data + simulated nodes when load is high
- Orchestrator scaling is reflected in managed_workers and returned in /workers/status
- worker_count query uses tag-based grouping (fixes schema collision)
- Model paths are absolute so they work from any working directory
- /metrics/latest returns consistent {metrics:[...]} shape
- All InfluxDB queries isolated so one failure never crashes others
"""

from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from datetime import datetime, timezone, timedelta
import joblib
import pandas as pd
import numpy as np
import os
import warnings

from influxdb_client import InfluxDBClient, Point, WritePrecision
from influxdb_client.client.write_api import SYNCHRONOUS

warnings.filterwarnings("ignore", category=UserWarning, module="sklearn")

# ── InfluxDB Configuration ──────────────────────────────────────
INFLUX_URL    = os.getenv("INFLUX_URL",    "http://localhost:8086")
INFLUX_TOKEN  = os.getenv("INFLUX_TOKEN",  "SyjoHso1dXHlfr7LSciUjACyhoTiHOFJ9Q2k7VEfeiry6HfNdU3uIIaTUQX0iA7J9fnTgWIbrsyYCX7QaktfuQ==")
INFLUX_ORG    = os.getenv("INFLUX_ORG",    "biust")
INFLUX_BUCKET = os.getenv("INFLUX_BUCKET", "metrics")

client    = InfluxDBClient(url=INFLUX_URL, token=INFLUX_TOKEN, org=INFLUX_ORG)
write_api = client.write_api(write_options=SYNCHRONOUS)
query_api = client.query_api()

app = FastAPI(title="BIUST Distributed Monitor")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Load AI Model — absolute path so it works from anywhere ─────
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)

MODEL_PATH  = os.path.join(_ROOT, "ai", "model", "load_model.pkl")
SCALER_PATH = os.path.join(_ROOT, "ai", "model", "scaler.pkl")

if not os.path.exists(MODEL_PATH):
    MODEL_PATH  = os.path.join(_HERE, "load_model.pkl")
    SCALER_PATH = os.path.join(_HERE, "scaler.pkl")

model  = None
scaler = None

if os.path.exists(MODEL_PATH) and os.path.exists(SCALER_PATH):
    try:
        model  = joblib.load(MODEL_PATH)
        scaler = joblib.load(SCALER_PATH)
        print(f"✅ AI model loaded from {MODEL_PATH}")
    except Exception as e:
        print(f"⚠️  Error loading model: {e}")
else:
    print(f"⚠️  No trained model found at {MODEL_PATH}")
    print("    Run: python ai/train.py")

# ── In-memory stores ────────────────────────────────────────────
scaling_events  : list = []
managed_workers : int  = 0

# Dashboard/test-panel live display tuning
BASE_WORKERS = int(os.getenv("BASE_WORKERS", "5"))
ACTIVE_WINDOW_SECONDS = int(os.getenv("ACTIVE_WINDOW_SECONDS", "20"))

# ── Scenario state (shared with simulator via file + API) ────────
SCENARIO_RANGES = {
    "normal":   {"cpu": (20, 55),  "memory": (30, 60),  "requests": (80,  200),  "latency": (30,  100)},
    "peak":     {"cpu": (65, 88),  "memory": (70, 90),  "requests": (400, 900),  "latency": (150, 300)},
    "critical": {"cpu": (88, 98),  "memory": (85, 96),  "requests": (800, 2000), "latency": (250, 500)},
    "low":      {"cpu": (5,  20),  "memory": (15, 35),  "requests": (20,  60),   "latency": (15,  50)},
}
# Active scenario written to simulator_state.json so client.py picks it up
STATE_FILE = os.path.join(os.path.dirname(_HERE), "simulator_state.json")
# Fallback: try project root / current dir
if not os.path.exists(os.path.dirname(STATE_FILE)):
    STATE_FILE = "simulator_state.json"

import json as _json
import time as _time

def _read_state() -> dict:
    try:
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE) as f:
                return _json.load(f)
    except Exception:
        pass
    return {"scenario": "normal", "burst_until": 0}

def _write_state(state: dict) -> None:
    try:
        with open(STATE_FILE, "w") as f:
            _json.dump(state, f)
    except Exception as e:
        print(f"⚠️  Could not write state file: {e}")

# ── Pydantic Models ─────────────────────────────────────────────
class Metrics(BaseModel):
    server_id: str   = "node-1"
    cpu:       float
    memory:    float
    requests:  int
    latency:   float
    scenario:  str   = "normal"

class ScalingEvent(BaseModel):
    message: str

class WorkerCount(BaseModel):
    count: int

class ScenarioRequest(BaseModel):
    scenario: str
    burst_seconds: int = 0   # if > 0, force critical for this many seconds

# ── AI Prediction ───────────────────────────────────────────────
def make_prediction(data: Metrics) -> dict:
    now     = datetime.now()
    hour    = now.hour
    is_peak = 1 if (8 <= hour <= 17) else 0

    if model and scaler:
        feat_names = ["cpu", "memory", "requests", "latency", "hour", "is_peak"]
        features   = pd.DataFrame(
            [[data.cpu, data.memory, data.requests, data.latency, hour, is_peak]],
            columns=feat_names
        )
        scaled         = scaler.transform(features)
        predicted_load = float(np.clip(model.predict(scaled)[0], 0, 1))
        model_type     = "RandomForest (trained)"
    else:
        predicted_load = float(np.clip(
            (data.cpu * 0.4 + data.memory * 0.3
             + (data.requests / 2000) * 100 * 0.2
             + (data.latency  / 400)  * 100 * 0.1) / 100, 0, 1))
        model_type = "Heuristic"

    if predicted_load > 0.85:
        severity, suggestion = "CRITICAL", "ADD_WORKER"
    elif predicted_load > 0.70:
        severity, suggestion = "HIGH", "PREPARE_SCALE"
    elif predicted_load < 0.20:
        severity, suggestion = "NORMAL", "REMOVE_WORKER"
    else:
        severity, suggestion = "NORMAL", "STEADY"

    return {
        "predicted_load": round(predicted_load, 3),
        "severity":       severity,
        "suggestion":     suggestion,
        "model_type":     model_type,
        "recommendation": "scale_up" if predicted_load > 0.75 else "normal",
        "alert":          f"HIGH LOAD: {round(predicted_load*100)}%" if predicted_load > 0.75 else None,
        "context":        {"hour": hour, "is_peak_hour": bool(is_peak)},
    }

# ── InfluxDB helpers ────────────────────────────────────────────
def run_query(flux: str) -> list:
    try:
        tables = query_api.query(flux, org=INFLUX_ORG)
        return [record.values for table in tables for record in table.records]
    except Exception as e:
        print(f"❌ InfluxDB Query Error: {e}")
        return []

def count_active_servers() -> int:
    flux = f"""
    from(bucket: "{INFLUX_BUCKET}")
      |> range(start: -10m)
      |> filter(fn: (r) => r._measurement == "server_metrics")
      |> filter(fn: (r) => r._field == "cpu")
      |> group(columns: ["server_id"])
      |> count()
      |> group()
      |> count(column: "_value")
    """
    try:
        tables = query_api.query(flux, org=INFLUX_ORG)
        for table in tables:
            for record in table.records:
                return int(record.get_value() or 1)
    except Exception as e:
        print(f"⚠️  Worker count query failed: {e}")
    return 1

def _parse_range(range_str, range_mins: int) -> str:
    if range_str:
        s = range_str.lstrip("-").strip()
        return f"-{s}"
    return f"-{range_mins}m"

# ── Routes ───────────────────────────────────────────────────────

@app.get("/")
def root():
    return {
        "message":      "BIUST Monitoring API running",
        "model_loaded": model is not None,
        "model_path":   MODEL_PATH,
    }

@app.get("/health")
def health():
    db_up = False
    try:
        db_up = client.ping()
    except Exception:
        pass
    return {
        "status":             "healthy",
        "influxdb_connected": db_up,
        "model_loaded":       model is not None,
        "model_type":         "RandomForest (trained)" if model else "Heuristic",
    }

# ── NEW: Scenario endpoints ──────────────────────────────────────

@app.get("/simulator/scenario")
def get_scenario():
    """Return the current simulator scenario and its metric ranges."""
    state    = _read_state()
    scenario = state.get("scenario", "normal")
    burst_until = state.get("burst_until", 0)
    active = "critical" if _time.time() < burst_until else scenario
    ranges = SCENARIO_RANGES.get(active, SCENARIO_RANGES["normal"])
    return {
        "scenario":      scenario,
        "active":        active,
        "burst_until":   burst_until,
        "burst_active":  _time.time() < burst_until,
        "ranges":        ranges,
        "all_scenarios": SCENARIO_RANGES,
    }

@app.post("/simulator/scenario")
def set_scenario(req: ScenarioRequest):
    """
    Set the active simulator scenario.
    The enhanced client.py reads simulator_state.json every loop and
    adjusts metric generation accordingly.
    burst_seconds > 0 forces critical load for that duration (burst mode).
    """
    if req.scenario not in SCENARIO_RANGES:
        raise HTTPException(status_code=400,
                            detail=f"Unknown scenario '{req.scenario}'. "
                                   f"Valid: {list(SCENARIO_RANGES.keys())}")
    state = _read_state()
    state["scenario"] = req.scenario
    if req.burst_seconds > 0:
        state["burst_until"] = _time.time() + req.burst_seconds
    else:
        state["burst_until"] = 0
    _write_state(state)
    ranges = SCENARIO_RANGES.get(req.scenario, SCENARIO_RANGES["normal"])
    return {
        "status":        "updated",
        "scenario":      req.scenario,
        "burst_seconds": req.burst_seconds,
        "ranges":        ranges,
    }

# ── Metrics endpoints ────────────────────────────────────────────

@app.post("/metrics")
def receive_metrics(data: Metrics):
    pred    = make_prediction(data)
    success = False
    try:
        point = (
            Point("server_metrics")
            .tag("server_id",  data.server_id)
            .tag("scenario",   data.scenario)
            .tag("severity",   pred["severity"])
            .tag("suggestion", pred["suggestion"])
            .field("cpu",             float(data.cpu))
            .field("memory",          float(data.memory))
            .field("requests",        int(data.requests))
            .field("latency",         float(data.latency))
            .field("predicted_load",  float(pred["predicted_load"]))
            .time(datetime.now(timezone.utc), WritePrecision.S)
        )
        write_api.write(bucket=INFLUX_BUCKET, org=INFLUX_ORG, record=point)
        success = True
    except Exception as e:
        print(f"❌ InfluxDB write error: {e}")

    return {
        "status":         "stored" if success else "partial",
        "influxdb_write": success,
        "prediction":     pred,
        "data":           {**data.dict(), "timestamp": datetime.now(timezone.utc).isoformat()},
    }

@app.post("/predict")
def predict_post(data: Metrics):
    return make_prediction(data)

@app.get("/predict")
def predict_get(cpu: float = 50, memory: float = 50,
                requests: int = 500, latency: float = 100):
    return make_prediction(Metrics(cpu=cpu, memory=memory,
                                   requests=requests, latency=latency))

@app.get("/api/dashboard")
def dashboard_data():
    try:
        status_payload = get_workers_status()
        workers = status_payload.get("workers", [])
        metric_workers = [w for w in workers if w.get("last_seen")]

        if not metric_workers:
            return {
                "cpu": 0, "memory": 0, "requests": 0, "latency": 0,
                "predictedLoad": 0, "peakCpu": 0, "peakMemory": 0,
                "peakPredictedLoad": 0, "severity": "NORMAL", "status": "Normal",
                "activeWorkers": len(workers), "workers": workers,
                "events": scaling_events[-10:],
            }

        avg_cpu = sum(float(w.get("cpu", 0)) for w in metric_workers) / len(metric_workers)
        avg_memory = sum(float(w.get("memory", 0)) for w in metric_workers) / len(metric_workers)
        avg_latency = sum(float(w.get("latency", 0)) for w in metric_workers) / len(metric_workers)
        avg_predicted = sum(float(w.get("predicted_load", 0)) for w in metric_workers) / len(metric_workers)
        total_requests = sum(int(w.get("requests", 0)) for w in metric_workers)

        peak_cpu = max(float(w.get("cpu", 0)) for w in metric_workers)
        peak_memory = max(float(w.get("memory", 0)) for w in metric_workers)
        peak_predicted = max(float(w.get("predicted_load", 0)) for w in metric_workers)

        severities = [str(w.get("severity", "NORMAL")).upper() for w in metric_workers]
        if "CRITICAL" in severities:
            severity, status = "CRITICAL", "Critical"
        elif "HIGH" in severities:
            severity, status = "HIGH", "Warning"
        else:
            severity, status = "NORMAL", "Normal"

        return {
            "cpu": round(avg_cpu, 1),
            "memory": round(avg_memory, 1),
            "requests": total_requests,
            "latency": round(avg_latency, 1),
            "predictedLoad": round(avg_predicted, 1),
            "peakCpu": round(peak_cpu, 1),
            "peakMemory": round(peak_memory, 1),
            "peakPredictedLoad": round(peak_predicted, 1),
            "severity": severity,
            "status": status,
            "activeWorkers": len(workers),
            "workers": workers,
            "events": scaling_events[-10:],
        }
    except Exception as e:
        print(f"❌ Dashboard API Error: {e}")
        return {
            "cpu": 0, "memory": 0, "requests": 0, "latency": 0,
            "predictedLoad": 0, "peakCpu": 0, "peakMemory": 0,
            "peakPredictedLoad": 0, "severity": "NORMAL", "status": "Offline",
            "activeWorkers": 0, "workers": [], "events": [], "error": str(e),
        }

@app.get("/metrics/latest")
def get_latest(limit: int = 20):
    flux = f"""
    from(bucket: "{INFLUX_BUCKET}")
      |> range(start: -1h)
      |> filter(fn: (r) => r._measurement == "server_metrics")
      |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
      |> sort(columns: ["_time"], desc: true)
      |> limit(n: {limit})
    """
    rows = run_query(flux)
    normalised = [
        {
            "server_id":      r.get("server_id", "unknown"),
            "cpu_usage":      r.get("cpu",    0),
            "memory_usage":   r.get("memory", 0),
            "requests":       r.get("requests", 0),
            "latency":        r.get("latency",  0),
            "predicted_load": r.get("predicted_load", 0),
            "timestamp":      str(r.get("_time", "")),
        }
        for r in rows
    ]
    return {"metrics": normalised}

@app.get("/metrics/history")
def get_history(
    range_mins: int = 60,
    range:      str = Query(None, description="Flux duration string, e.g. -1h, -15m, -7d"),
    server_id:  str = None,
    severity:   str = None,
    limit:      int = 200,
):
    start = _parse_range(range, range_mins)
    flux = f"""
    from(bucket: "{INFLUX_BUCKET}")
      |> range(start: {start})
      |> filter(fn: (r) => r._measurement == "server_metrics")
    """
    if server_id:
        flux += f'  |> filter(fn: (r) => r.server_id == "{server_id}")\n'
    if severity:
        flux += f'  |> filter(fn: (r) => r.severity == "{severity}")\n'
    flux += f"""
      |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
      |> sort(columns: ["_time"], desc: false)
      |> limit(n: {limit})
    """
    rows = run_query(flux)
    normalised = [
        {
            "server_id":      r.get("server_id", "unknown"),
            "cpu":            r.get("cpu", 0),
            "memory":         r.get("memory", 0),
            "requests":       r.get("requests", 0),
            "latency":        r.get("latency", 0),
            "predicted_load": r.get("predicted_load", 0),
            "severity":       r.get("severity", "NORMAL"),
            "suggestion":     r.get("suggestion", "STEADY"),
            "timestamp":      str(r.get("_time", r.get("timestamp", ""))),
        }
        for r in rows
    ]
    return {"metrics": normalised, "range_mins": range_mins, "range": start}

@app.get("/workers/status")
def get_workers_status():
    """
    Returns only live per-server stats from InfluxDB plus current orchestrator
    standby nodes. Removed orchestrator workers are hidden immediately.
    """
    flux = f"""
    from(bucket: "{INFLUX_BUCKET}")
      |> range(start: -{ACTIVE_WINDOW_SECONDS}s)
      |> filter(fn: (r) => r._measurement == "server_metrics")
      |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
      |> group(columns: ["server_id"])
      |> sort(columns: ["_time"], desc: true)
      |> first(column: "_time")
    """
    rows = run_query(flux)

    allowed_dynamic_workers = max(0, managed_workers - BASE_WORKERS)
    workers = []

    for r in rows:
        server_id = str(r.get("server_id", "unknown"))

        if server_id.startswith("orchestrator-worker-"):
            try:
                worker_num = int(server_id.rsplit("-", 1)[1])
                if worker_num > allowed_dynamic_workers:
                    continue
            except Exception:
                continue

        cpu = float(r.get("cpu", 0))
        memory = float(r.get("memory", 0))
        sev = str(r.get("severity", "NORMAL")).upper()
        sugg = r.get("suggestion", "STEADY")

        if sev == "CRITICAL":
            status = "Critical"
        elif sev == "HIGH" or cpu > 70:
            status = "Busy"
        else:
            status = "Active"

        workers.append({
            "server_id": server_id,
            "cpu": round(cpu, 1),
            "memory": round(memory, 1),
            "requests": int(r.get("requests", 0)),
            "latency": round(float(r.get("latency", 0)), 1),
            "predicted_load": round(float(r.get("predicted_load", 0)) * 100, 1),
            "severity": sev,
            "suggestion": sugg,
            "status": status,
            "last_seen": str(r.get("_time", "")),
        })

    workers.sort(key=lambda w: w["server_id"])

    existing_ids = {w["server_id"] for w in workers}
    missing = max(0, managed_workers - len(workers))

    for i in range(1, missing + 1):
        sid = f"orchestrator-worker-{i}"
        if sid not in existing_ids:
            workers.append({
                "server_id": sid,
                "cpu": 0.0,
                "memory": 0.0,
                "requests": 0,
                "latency": 0.0,
                "predicted_load": 0.0,
                "severity": "NORMAL",
                "suggestion": "STEADY",
                "status": "Standby",
                "last_seen": "",
            })

    workers.sort(key=lambda w: w["server_id"])
    return {
        "workers": workers,
        "count": len(workers),
        "managed_workers": managed_workers,
        "active_window_seconds": ACTIVE_WINDOW_SECONDS,
    }

@app.get("/metrics/stats")
def get_stats(
    range_mins: int = 60,
    range:      str = Query(None, description="Flux duration string, e.g. -1h"),
):
    start = _parse_range(range, range_mins)
    flux = f"""
    from(bucket: "{INFLUX_BUCKET}")
      |> range(start: {start})
      |> filter(fn: (r) => r._measurement == "server_metrics")
      |> filter(fn: (r) => r._field == "cpu" or r._field == "memory"
                        or r._field == "requests" or r._field == "latency"
                        or r._field == "predicted_load")
      |> group(columns: ["server_id", "_field"])
    """
    rows_mean  = run_query(flux + '|> mean()')
    rows_count = run_query(flux + '|> count()')

    agg: dict = {}
    for r in rows_mean:
        sid   = r.get("server_id", "unknown")
        field = r.get("_field",    "")
        val   = r.get("_value",    0)
        if sid not in agg:
            agg[sid] = {}
        agg[sid][f"avg_{field}"] = round(float(val or 0), 3)

    for r in rows_count:
        sid   = r.get("server_id", "unknown")
        field = r.get("_field",    "")
        if field == "cpu" and sid in agg:
            agg[sid]["total_events"] = int(r.get("_value", 0))

    return {"stats": agg, "range": start}

@app.post("/scaling/event")
def receive_scaling_event(event: ScalingEvent):
    entry = {"timestamp": datetime.utcnow().isoformat(), "message": event.message}
    scaling_events.append(entry)
    if len(scaling_events) > 20:
        scaling_events.pop(0)
    print(f"[SCALING] {event.message}")
    return {"status": "logged"}

@app.get("/scaling/events")
def get_scaling_events():
    return {"events": scaling_events}

@app.post("/workers/count")
def update_worker_count(payload: WorkerCount):
    global managed_workers
    managed_workers = payload.count
    return {"status": "updated", "count": managed_workers}

@app.get("/workers/count")
def get_worker_count():
    return {"count": managed_workers}

@app.delete("/metrics/clear")
def clear_metrics():
    try:
        start = datetime(1970, 1, 1, tzinfo=timezone.utc)
        stop  = datetime.now(timezone.utc) + timedelta(seconds=1)
        client.delete_api().delete(
            start, stop,
            '_measurement="server_metrics"',
            bucket=INFLUX_BUCKET, org=INFLUX_ORG
        )
        return {"status": "cleared"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)