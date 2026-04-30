"""
orchestrator.py
Auto-scaling orchestrator for BIUST Server Monitoring System.
"""

import os
import sys
import time
import subprocess
import requests
from datetime import datetime

API_BASE = os.getenv("API_BASE", "http://127.0.0.1:8000")

POLL_INTERVAL = int(os.getenv("POLL_INTERVAL", "5"))

SCALE_UP_LOAD = float(os.getenv("SCALE_UP_LOAD", "0.72"))
SCALE_DOWN_LOAD = float(os.getenv("SCALE_DOWN_LOAD", "0.45"))

SCALE_UP_COUNT = int(os.getenv("SCALE_UP_COUNT", "3"))
SCALE_DOWN_COUNT = int(os.getenv("SCALE_DOWN_COUNT", "3"))

BASE_WORKERS = int(os.getenv("BASE_WORKERS", "5"))
MIN_WORKERS = int(os.getenv("MIN_WORKERS", str(BASE_WORKERS)))
MAX_WORKERS = int(os.getenv("MAX_WORKERS", "8"))

worker_processes = []
worker_count = 0

consecutive_high = 0
consecutive_low = 0


def ts():
    return datetime.now().strftime("%H:%M:%S")


def log(message):
    print(f"[{ts()}] {message}", flush=True)


def spawned_count():
    return len([p for p in worker_processes if p.poll() is None])


def total_worker_count():
    return BASE_WORKERS + spawned_count()


def post_event(message):
    try:
        requests.post(
            f"{API_BASE}/scaling/event",
            json={"message": message},
            timeout=2,
        )
    except Exception:
        pass


def report_count():
    try:
        requests.post(
            f"{API_BASE}/workers/count",
            json={"count": total_worker_count()},
            timeout=2,
        )
    except Exception:
        pass


def get_latest_load():
    try:
        response = requests.get(f"{API_BASE}/workers/status", timeout=3)
        response.raise_for_status()

        workers = response.json().get("workers", [])

        real_workers = [
            w for w in workers
            if not str(w.get("server_id", "")).startswith("orchestrator-")
        ]

        if not real_workers:
            return None, None

        loads = [
            float(w.get("predicted_load", 0)) / 100
            for w in real_workers
        ]

        avg_load = sum(loads) / len(loads)

        max_severity = "NORMAL"

        for worker in real_workers:
            severity = worker.get("severity", "NORMAL")

            if severity == "CRITICAL":
                max_severity = "CRITICAL"
                break

            if severity == "HIGH":
                max_severity = "HIGH"

        return avg_load, max_severity

    except Exception as e:
        log(f"WARNING: Could not get load — {e}")
        return None, None


def spawn_worker():
    global worker_count

    worker_count += 1
    name = f"orchestrator-worker-{worker_count}"

    cmd = [
        sys.executable,
        "-m",
        "celery",
        "-A",
        "BiustSystem.workers.worker",
        "worker",
        "--loglevel=info",
        "-n",
        f"{name}@%h",
    ]

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    worker_processes.append(proc)

    log(f"[ORCHESTRATOR] Spawned {name} PID={proc.pid}")
    return name


def terminate_worker():
    live_workers = [p for p in worker_processes if p.poll() is None]

    if not live_workers:
        return None

    proc = live_workers[-1]

    try:
        proc.terminate()
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    except Exception:
        pass

    try:
        worker_processes.remove(proc)
    except ValueError:
        pass

    log(f"[ORCHESTRATOR] Terminated worker PID={proc.pid}")
    return proc.pid


def shutdown_all():
    log(f"[ORCHESTRATOR] Shutting down {spawned_count()} spawned workers")

    for proc in worker_processes:
        try:
            if proc.poll() is None:
                proc.terminate()
        except Exception:
            pass

    report_count()


def main():
    global consecutive_high, consecutive_low

    log("[ORCHESTRATOR] Starting")
    log(f"[ORCHESTRATOR] API: {API_BASE}")
    log(f"[ORCHESTRATOR] Base workers: {BASE_WORKERS}")
    log(f"[ORCHESTRATOR] Min workers: {MIN_WORKERS}")
    log(f"[ORCHESTRATOR] Max workers: {MAX_WORKERS}")
    log(f"[ORCHESTRATOR] Scale up load: {SCALE_UP_LOAD}")
    log(f"[ORCHESTRATOR] Scale down load: {SCALE_DOWN_LOAD}")
    log(f"[ORCHESTRATOR] Scale up count: {SCALE_UP_COUNT}")
    log(f"[ORCHESTRATOR] Scale down count: {SCALE_DOWN_COUNT}")

    report_count()

    try:
        while True:
            load, severity = get_latest_load()
            workers_now = total_worker_count()
            action = "none"

            if load is None:
                log(
                    f"[ORCHESTRATOR] No load data yet | "
                    f"Workers: {workers_now}"
                )
                report_count()
                time.sleep(POLL_INTERVAL)
                continue

            if severity == "CRITICAL" and workers_now < MAX_WORKERS:
                name = spawn_worker()
                consecutive_high = 0
                consecutive_low = 0
                action = "EMERGENCY SCALE UP"

                message = (
                    f"[ORCHESTRATOR] EMERGENCY SCALE UP — {name} spawned "
                    f"| Severity: CRITICAL | Load: {load:.3f}"
                )

                log(message)
                post_event(message)

            elif load > SCALE_UP_LOAD:
                consecutive_high += 1
                consecutive_low = 0

                if consecutive_high >= SCALE_UP_COUNT and workers_now < MAX_WORKERS:
                    name = spawn_worker()
                    consecutive_high = 0
                    action = "SCALE UP"

                    message = (
                        f"[ORCHESTRATOR] SCALE UP — {name} spawned "
                        f"| Load: {load:.3f}"
                    )

                    log(message)
                    post_event(message)

                else:
                    log(
                        f"[ORCHESTRATOR] High load streak "
                        f"{consecutive_high}/{SCALE_UP_COUNT} "
                        f"| Load: {load:.3f}"
                    )

            elif load < SCALE_DOWN_LOAD:
                consecutive_low += 1
                consecutive_high = 0

                if consecutive_low >= SCALE_DOWN_COUNT and workers_now > MIN_WORKERS:
                    pid = terminate_worker()
                    consecutive_low = 0
                    action = "SCALE DOWN"

                    message = (
                        f"[ORCHESTRATOR] SCALE DOWN — worker PID={pid} removed "
                        f"| Load: {load:.3f}"
                    )

                    log(message)
                    post_event(message)

                else:
                    if workers_now > MIN_WORKERS:
                        log(
                            f"[ORCHESTRATOR] Low load streak "
                            f"{consecutive_low}/{SCALE_DOWN_COUNT} "
                            f"| Load: {load:.3f}"
                        )
                    else:
                        log(
                            f"[ORCHESTRATOR] Low load but already at minimum "
                            f"workers | Workers: {workers_now}"
                        )

            else:
                consecutive_high = 0
                consecutive_low = 0

            report_count()

            log(
                f"[ORCHESTRATOR] Workers: {total_worker_count()} "
                f"| Spawned: {spawned_count()} "
                f"| AvgLoad: {load:.3f} "
                f"| Severity: {severity} "
                f"| HighStreak: {consecutive_high} "
                f"| LowStreak: {consecutive_low} "
                f"| Action: {action}"
            )

            time.sleep(POLL_INTERVAL)

    except KeyboardInterrupt:
        shutdown_all()
        log("[ORCHESTRATOR] Stopped")


if __name__ == "__main__":
    main()