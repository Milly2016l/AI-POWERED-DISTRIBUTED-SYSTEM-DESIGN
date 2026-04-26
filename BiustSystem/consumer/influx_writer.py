"""
BiustSystem/consumer/influx_writer.py
======================================
Writes incoming metrics from the Kafka consumer into InfluxDB.
Handles connection errors gracefully so the consumer never crashes
if InfluxDB is temporarily unavailable.
"""

import os
from datetime import datetime
from influxdb_client import InfluxDBClient, Point, WritePrecision
from influxdb_client.client.write_api import SYNCHRONOUS

# ── InfluxDB connection settings ────────────────────────────────
INFLUX_URL   = os.getenv("INFLUX_URL",   "http://localhost:8086")
INFLUX_TOKEN = os.getenv("INFLUX_TOKEN", "biust-super-secret-token")
INFLUX_ORG   = os.getenv("INFLUX_ORG",   "biust")
INFLUX_BUCKET = os.getenv("INFLUX_BUCKET", "metrics")

# ── Initialise client ───────────────────────────────────────────
try:
    _client    = InfluxDBClient(url=INFLUX_URL, token=INFLUX_TOKEN, org=INFLUX_ORG)
    _write_api = _client.write_api(write_options=SYNCHRONOUS)
    _query_api = _client.query_api()
    print(f"[InfluxDB] Connected to {INFLUX_URL}")
except Exception as e:
    _client    = None
    _write_api = None
    _query_api = None
    print(f"[InfluxDB] WARNING: Could not connect — {e}")


def write_metric(data: dict) -> None:
    """
    Write a single metric payload to InfluxDB.

    Args:
        data: dict with keys server_id, cpu_usage, memory_usage,
              requests, latency, and optionally timestamp (ISO string).
    """
    if _write_api is None:
        print("[InfluxDB] WARNING: write skipped — no connection")
        return

    try:
        # Parse timestamp or use now
        raw_ts = data.get("timestamp")
        if raw_ts:
            try:
                ts = datetime.fromisoformat(raw_ts)
            except ValueError:
                ts = datetime.utcnow()
        else:
            ts = datetime.utcnow()

        point = (
            Point("server_metrics")
            .tag("server_id", data.get("server_id", "unknown"))
            .field("cpu_usage",    float(data.get("cpu_usage",    0)))
            .field("memory_usage", float(data.get("memory_usage", 0)))
            .field("requests",     int(data.get("requests",       0)))
            .field("latency",      float(data.get("latency",      0)))
            .time(ts, WritePrecision.SECONDS)
        )

        _write_api.write(bucket=INFLUX_BUCKET, org=INFLUX_ORG, record=point)
        print(f"[InfluxDB] Written metric for {data.get('server_id')}")

    except Exception as e:
        print(f"[InfluxDB] WARNING: Failed to write metric — {e}")


def query_recent(minutes: int = 10) -> list:
    """
    Query InfluxDB for metrics from the last N minutes.

    Args:
        minutes: how far back to query (default 10).

    Returns:
        List of dicts, one per record.
    """
    if _query_api is None:
        print("[InfluxDB] WARNING: query skipped — no connection")
        return []

    try:
        flux = f"""
        from(bucket: "{INFLUX_BUCKET}")
          |> range(start: -{minutes}m)
          |> filter(fn: (r) => r._measurement == "server_metrics")
          |> pivot(rowKey:["_time","server_id"],
                   columnKey: ["_field"],
                   valueColumn: "_value")
          |> sort(columns: ["_time"], desc: false)
        """
        tables = _query_api.query(flux, org=INFLUX_ORG)
        results = []
        for table in tables:
            for record in table.records:
                results.append({
                    "timestamp":    record.get_time().isoformat(),
                    "server_id":    record.values.get("server_id", "unknown"),
                    "cpu_usage":    record.values.get("cpu_usage",    0),
                    "memory_usage": record.values.get("memory_usage", 0),
                    "requests":     record.values.get("requests",     0),
                    "latency":      record.values.get("latency",      0),
                })
        return results

    except Exception as e:
        print(f"[InfluxDB] WARNING: query failed — {e}")
        return []