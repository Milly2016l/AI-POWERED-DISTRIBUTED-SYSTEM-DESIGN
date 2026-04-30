import requests
import random
import time
import json
import os

API_BASE = os.getenv("API_BASE", "http://127.0.0.1:8000")
URL = f"{API_BASE}/metrics"
STATE_FILE = os.getenv("STATE_FILE", "simulator_state.json")

SCENARIOS = {
    "normal":   {"cpu": (20, 55),  "memory": (30, 60),  "requests": (80, 200),   "latency": (30, 100)},
    "peak":     {"cpu": (65, 88),  "memory": (70, 90),  "requests": (400, 900),  "latency": (150, 300)},
    "critical": {"cpu": (88, 98),  "memory": (85, 96),  "requests": (800, 2000), "latency": (250, 500)},
    "low":      {"cpu": (5, 20),   "memory": (15, 35),  "requests": (20, 60),    "latency": (15, 50)},
}

BASE_SERVERS = ["node-1", "node-2", "node-3", "node-4", "node-5"]
BASE_WORKERS = len(BASE_SERVERS)

def get_scenario():
    try:
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE) as f:
                state = json.load(f)
                return state.get("scenario", "normal"), state.get("burst_until", 0)
    except:
        pass
    return "normal", 0

def get_current_worker_count():
    try:
        # Fetches count from API (updated by Orchestrator)
        res = requests.get(f"{API_BASE}/workers/count", timeout=1)
        return max(BASE_WORKERS, int(res.json().get("count", BASE_WORKERS)))
    except:
        return BASE_WORKERS

print("Functional scaling simulator running...")

while True:
    scenario, burst_until = get_scenario()
    total_workers = get_current_worker_count()
    
    # Logic: If orchestrator says we have 7 workers, we simulate 5 base + 2 dynamic ones
    active_nodes = list(BASE_SERVERS)
    if total_workers > BASE_WORKERS:
        for i in range(1, (total_workers - BASE_WORKERS) + 1):
            active_nodes.append(f"orchestrator-worker-{i}")

    # Determine scenario
    if time.time() < burst_until:
        active_scenario = "critical"
    else:
        active_scenario = scenario
    
    s = SCENARIOS.get(active_scenario, SCENARIOS["normal"])
    num_nodes = len(active_nodes)
    
    # FUNCTIONAL SCALE-DOWN LOGIC:
    # We distribute the total scenario load across the number of available nodes.
    # More nodes = less load per node = lower metrics = system stabilizes.
    for server_id in active_nodes:
        # Load reduction factor: base 5 nodes = 1.0. Adding nodes reduces intensity.
        efficiency_gain = num_nodes / BASE_WORKERS
        
        # Calculate distributed metrics
        raw_cpu = random.randint(*s["cpu"])
        raw_req = random.randint(*s["requests"])
        raw_lat = random.randint(*s["latency"])

        # As nodes increase, the average CPU and Latency drop
        cpu_val = max(5, int(raw_cpu / (1 + (num_nodes - BASE_WORKERS) * 0.35))) 
        req_val = max(1, int(raw_req / efficiency_gain))
        lat_val = max(5, int(raw_lat / efficiency_gain))

        variation = random.uniform(-0.05, 0.05)
        data = {
            "server_id": server_id,
            "cpu":      max(1, min(99, int(cpu_val * (1 + variation)))),
            "memory":   max(1, min(99, int(random.randint(*s["memory"]) * (1 + variation)))),
            "requests": max(1, int(req_val * (1 + variation))),
            "latency":  max(1, int(lat_val * (1 + variation))),
            "scenario": active_scenario,
        }
        
        try:
            requests.post(URL, json=data, timeout=1)
        except:
            pass
            
    print(f"[{active_scenario.upper()}] Nodes: {num_nodes} | Load spread across all workers.")
    time.sleep(2)