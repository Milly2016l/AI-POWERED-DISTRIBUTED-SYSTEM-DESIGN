"""
BIUST Monitoring API — Final Production Version
=================================================
Fixes applied:
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
_HERE = os.path.dirname(os.path.abspath(__file__))   # api/
_ROOT = os.path.dirname(_HERE)                        # project root

MODEL_PATH  = os.path.join(_ROOT, "ai", "model", "load_model.pkl")
SCALER_PATH = os.path.join(_ROOT, "ai", "model", "scaler.pkl")

# Fallback: same folder as app.py (for when pkl files are copied there)
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

# ── AI Prediction ───────────────────────────────────────────────
def make_prediction(data: Metrics) -> dict:
    """Run RandomForest prediction or fall back to heuristic."""
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
    """Execute a Flux query and return flat list of record dicts."""
    try:
        tables = query_api.query(flux, org=INFLUX_ORG)
        return [record.values for table in tables for record in table.records]
    except Exception as e:
        print(f"❌ InfluxDB Query Error: {e}")
        return []

def count_active_servers() -> int:
    """
    Count distinct server_id tags active in the last 10 minutes.
    Filters to a single field (cpu) BEFORE grouping to avoid the
    'schema collision: cannot group float and integer types together'
    error that occurs when mixed field types are grouped together.
    """
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

@app.post("/metrics")
def receive_metrics(data: Metrics):
    """Receive metric, run AI prediction, write to InfluxDB."""
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
    """POST prediction used by dashboard and orchestrator."""
    return make_prediction(data)

@app.get("/predict")
def predict_get(cpu: float = 50, memory: float = 50,
                requests: int = 500, latency: float = 100):
    """Quick GET prediction for browser testing."""
    return make_prediction(Metrics(cpu=cpu, memory=memory,
                                   requests=requests, latency=latency))

@app.get("/api/dashboard")
def dashboard_data():
    """Main data source for the React dashboard."""
    try:
        latest_flux = f"""
        from(bucket: "{INFLUX_BUCKET}")
          |> range(start: -10m)
          |> filter(fn: (r) => r._measurement == "server_metrics")
          |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
          |> sort(columns: ["_time"], desc: true)
          |> limit(n: 1)
        """
        rows           = run_query(latest_flux)
        active_workers = count_active_servers()

        if not rows:
            return {
                "cpu": 0, "memory": 0, "requests": 0, "latency": 0,
                "predictedLoad": 0, "activeWorkers": active_workers,
                "workers": [], "events": scaling_events[-5:],
            }

        latest = rows[0]
        return {
            "cpu":           round(float(latest.get("cpu",    0)), 1),
            "memory":        round(float(latest.get("memory", 0)), 1),
            "requests":      int(latest.get("requests", 0)),
            "latency":       round(float(latest.get("latency", 0)), 1),
            "predictedLoad": round(float(latest.get("predicted_load", 0)) * 100, 1),
            "activeWorkers": active_workers,
            "workers":       [],
            "events":        scaling_events[-5:],
        }
    except Exception as e:
        print(f"❌ Dashboard API Error: {e}")
        return {
            "cpu": 0, "memory": 0, "requests": 0, "latency": 0,
            "predictedLoad": 0, "activeWorkers": 1,
            "workers": [], "events": [], "error": str(e),
        }

@app.get("/metrics/latest")
def get_latest(limit: int = 20):
    """Returns recent metrics as {metrics:[...]} for the frontend."""
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

def _parse_range(range_str: str | None, range_mins: int) -> str:
    """
    Convert either a Flux duration string (e.g. '-1h', '-15m', '-7d')
    or the legacy range_mins integer into a Flux start expression.
    Returns a string like '-60m' or '-1h' ready to embed in a query.
    """
    if range_str:
        # Accept '-1h', '1h', '-15m', '-7d' etc.
        s = range_str.lstrip("-").strip()
        return f"-{s}"
    return f"-{range_mins}m"


@app.get("/metrics/history")
def get_history(
    range_mins: int = 60,
    range:      str = Query(None, description="Flux duration string, e.g. -1h, -15m, -7d"),
    server_id:  str = None,
    severity:   str = None,
    limit:      int = 200,
):
    """
    Returns historical metrics rows from InfluxDB.
    Accepts either:
      - range_mins=60      (legacy integer, minutes)
      - range=-1h          (Flux duration string from the frontend)
    Optional filters: server_id, severity.
    """
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
    Returns real per-worker (server_id) stats from InfluxDB.
    Queries the most recent metric point for every active server_id
    in the last 10 minutes, so the frontend can display live cards.
    """
    flux = f"""
    from(bucket: "{INFLUX_BUCKET}")
      |> range(start: -10m)
      |> filter(fn: (r) => r._measurement == "server_metrics")
      |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
      |> group(columns: ["server_id"])
      |> sort(columns: ["_time"], desc: true)
      |> first(column: "_time")
    """
    rows = run_query(flux)

    workers = []
    for r in rows:
        cpu     = float(r.get("cpu",    0))
        memory  = float(r.get("memory", 0))
        sev     = r.get("severity", "NORMAL")
        sugg    = r.get("suggestion", "STEADY")
        if sev == "CRITICAL":
            status = "Critical"
        elif sev == "HIGH" or cpu > 70:
            status = "Busy"
        else:
            status = "Active"
        workers.append({
            "server_id":      r.get("server_id", "unknown"),
            "cpu":            round(cpu, 1),
            "memory":         round(memory, 1),
            "requests":       int(r.get("requests", 0)),
            "latency":        round(float(r.get("latency", 0)), 1),
            "predicted_load": round(float(r.get("predicted_load", 0)) * 100, 1),
            "severity":       sev,
            "suggestion":     sugg,
            "status":         status,
            "last_seen":      str(r.get("_time", "")),
        })

    # Sort by server_id for stable card order
    workers.sort(key=lambda w: w["server_id"])
    return {"workers": workers, "count": len(workers)}


@app.get("/metrics/stats")
def get_stats(
    range_mins: int = 60,
    range:      str = Query(None, description="Flux duration string, e.g. -1h"),
):
    """
    Returns per-server aggregated stats (avg CPU, memory, requests, latency,
    predicted_load, and event count) for the Stats tab in the frontend.
    """
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

    # Build nested dict: server_id -> field -> value
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
        if field == "cpu" and sid in agg:          # use cpu count as total events
            agg[sid]["total_events"] = int(r.get("_value", 0))

    return {"stats": agg, "range": start}

@app.post("/scaling/event")
def receive_scaling_event(event: ScalingEvent):
    """Log a scaling action from the orchestrator."""
    entry = {"timestamp": datetime.utcnow().isoformat(), "message": event.message}
    scaling_events.append(entry)
    if len(scaling_events) > 20:
        scaling_events.pop(0)
    print(f"[SCALING] {event.message}")
    return {"status": "logged"}

@app.get("/scaling/events")
def get_scaling_events():
    """Return last 20 orchestrator scaling events."""
    return {"events": scaling_events}

@app.post("/workers/count")
def update_worker_count(payload: WorkerCount):
    """Orchestrator reports current worker count."""
    global managed_workers
    managed_workers = payload.count
    return {"status": "updated", "count": managed_workers}

@app.get("/workers/count")
def get_worker_count():
    """Return current managed worker count."""
    return {"count": managed_workers}

@app.delete("/metrics/clear")
def clear_metrics():
    """Wipe all metrics from InfluxDB — dev use only."""
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