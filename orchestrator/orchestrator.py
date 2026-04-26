"""
orchestrator/orchestrator.py
==============================
Auto-scaling orchestrator for the BIUST Server Monitoring System.

Polls the FastAPI /predict endpoint every 10 seconds and decides
whether to spawn or terminate Celery worker processes based on the
AI-predicted system load.

Scaling rules:
  - predicted_load > 0.75 for 3 consecutive checks → scale UP
  - predicted_load < 0.30 for 5 consecutive checks AND workers > 2
    → scale DOWN
  - Maximum workers: 6
  - Minimum workers: 2

Run from project root:
  python orchestrator/orchestrator.py
"""

import os
import sys
import time
import subprocess
import requests
from datetime import datetime

# ── Settings ────────────────────────────────────────────────────
API_BASE        = os.getenv("API_BASE", "http://127.0.0.1:8000")
POLL_INTERVAL   = int(os.getenv("POLL_INTERVAL", "10"))
SCALE_UP_LOAD   = float(os.getenv("SCALE_UP_LOAD",   "0.75"))
SCALE_DOWN_LOAD = float(os.getenv("SCALE_DOWN_LOAD", "0.30"))
SCALE_UP_COUNT  = int(os.getenv("SCALE_UP_COUNT",  "3"))
SCALE_DOWN_COUNT = int(os.getenv("SCALE_DOWN_COUNT", "5"))
MAX_WORKERS     = int(os.getenv("MAX_WORKERS", "6"))
MIN_WORKERS     = int(os.getenv("MIN_WORKERS", "2"))

# ── State ────────────────────────────────────────────────────────
worker_processes = []   # list of subprocess.Popen objects
worker_count     = 0    # total workers spawned (used for naming)
consecutive_high = 0
consecutive_low  = 0


def log(msg: str) -> None:
    """Print a timestamped log message."""
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}")


def post_scaling_event(message: str) -> None:
    """
    POST a scaling event to the API so the dashboard can display it.

    Args:
        message: human-readable description of the scaling action.
    """
    try:
        requests.post(
            f"{API_BASE}/scaling/event",
            json={"message": message},
            timeout=3
        )
    except Exception as e:
        log(f"WARNING: Could not post scaling event — {e}")


def get_latest_metrics() -> dict | None:
    """
    Fetch the latest metric from the API.

    Returns:
        The most recent metric dict, or None if unavailable.
    """
    try:
        res = requests.get(f"{API_BASE}/metrics/latest", timeout=3)
        metrics = res.json().get("metrics", [])
        return metrics[-1] if metrics else None
    except Exception as e:
        log(f"WARNING: Could not fetch metrics — {e}")
        return None


def get_prediction(metric: dict) -> float | None:
    """
    Call the /predict endpoint with a metric payload.

    Args:
        metric: dict with cpu_usage, memory_usage, requests, latency.

    Returns:
        Predicted load float (0.0–1.0), or None on error.
    """
    try:
        payload = {
            "server_id": metric.get("server_id", "orchestrator"),
            "cpu":       int(metric.get("cpu_usage",    50)),
            "memory":    int(metric.get("memory_usage", 50)),
            "requests":  int(metric.get("requests",    500)),
            "latency":   int(metric.get("latency",     100)),
        }
        res = requests.post(f"{API_BASE}/predict", json=payload, timeout=3)
        return res.json().get("predicted_load", 0.5)
    except Exception as e:
        log(f"WARNING: Could not get prediction — {e}")
        return None


def spawn_worker() -> None:
    """
    Spawn a new Celery worker subprocess and register it.
    """
    global worker_count
    worker_count += 1
    name = f"worker{worker_count}"
    cmd = [
        sys.executable, "-m", "celery",
        "-A", "BiustSystem.workers.worker",
        "worker",
        "--loglevel=info",
        f"-n", f"{name}@%h"
    ]
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
    worker_processes.append(proc)
    log(f"[ORCHESTRATOR] Spawned {name} (PID {proc.pid})")


def terminate_worker() -> None:
    """
    Terminate the most recently spawned Celery worker.
    """
    if not worker_processes:
        return
    proc = worker_processes.pop()
    proc.terminate()
    log(f"[ORCHESTRATOR] Terminated worker (PID {proc.pid})")


def shutdown_all() -> None:
    """
    Cleanly terminate all managed worker processes on exit.
    """
    log("[ORCHESTRATOR] Shutting down all workers...")
    for proc in worker_processes:
        proc.terminate()
    log(f"[ORCHESTRATOR] {len(worker_processes)} workers terminated. Goodbye.")


def active_worker_count() -> int:
    """Return number of currently running managed workers."""
    return len([p for p in worker_processes if p.poll() is None])


# ── Main loop ────────────────────────────────────────────────────
def main() -> None:
    """
    Main orchestrator loop. Runs indefinitely until CTRL+C.
    """
    global consecutive_high, consecutive_low

    log("[ORCHESTRATOR] Starting — polling every 10 seconds")
    log(f"[ORCHESTRATOR] Scale UP  threshold: load > {SCALE_UP_LOAD} for {SCALE_UP_COUNT} checks")
    log(f"[ORCHESTRATOR] Scale DOWN threshold: load < {SCALE_DOWN_LOAD} for {SCALE_DOWN_COUNT} checks")

    try:
        while True:
            metric = get_latest_metrics()

            if metric is None:
                log("[ORCHESTRATOR] No metrics yet — waiting...")
                time.sleep(POLL_INTERVAL)
                continue

            load = get_prediction(metric)

            if load is None:
                time.sleep(POLL_INTERVAL)
                continue

            workers_now = active_worker_count()
            action = "none"

            # ── Scale UP logic ──────────────────────────────────
            if load > SCALE_UP_LOAD:
                consecutive_high += 1
                consecutive_low   = 0
                if consecutive_high >= SCALE_UP_COUNT and workers_now < MAX_WORKERS:
                    spawn_worker()
                    consecutive_high = 0
                    action = "SCALE UP"
                    msg = (f"[ORCHESTRATOR] Scaling UP — spawning worker-{worker_count} "
                           f"(predicted load: {load:.3f})")
                    log(msg)
                    post_scaling_event(msg)

            # ── Scale DOWN logic ────────────────────────────────
            elif load < SCALE_DOWN_LOAD:
                consecutive_low  += 1
                consecutive_high  = 0
                if consecutive_low >= SCALE_DOWN_COUNT and workers_now > MIN_WORKERS:
                    msg = (f"[ORCHESTRATOR] Scaling DOWN — terminating worker "
                           f"(predicted load: {load:.3f})")
                    log(msg)
                    terminate_worker()
                    consecutive_low = 0
                    action = "SCALE DOWN"
                    post_scaling_event(msg)

            else:
                consecutive_high = 0
                consecutive_low  = 0

            log(
                f"[ORCHESTRATOR] Workers: {active_worker_count()} | "
                f"Load: {load:.3f} | "
                f"High streak: {consecutive_high} | "
                f"Low streak: {consecutive_low} | "
                f"Action: {action}"
            )

            time.sleep(POLL_INTERVAL)

    except KeyboardInterrupt:
        shutdown_all()


if __name__ == "__main__":
    main()