# workers/biust_processor.py
# Lead: Loago Ditetso - Processing Worker Lead
# Description: Production-grade processing logic for BIUST Server Monitoring.
# This worker listens for server metrics, computes statistical windows,
# detects anomalies, and prepares data for the Orchestrator (Theo) and Dashboard (Thandiswa).

import time
import random
import json
import logging
import os
from collections import deque
from dataclasses import dataclass, asdict
from typing import Dict, List, Optional, Tuple
from enum import Enum

# -------------------------------
# 1. CONFIGURATION (Real systems use env variables, not hardcoded magic numbers)
# -------------------------------
class Config:
    # Processing Windows (Simulates looking at the last 'n' seconds of data)
    MOVING_AVG_WINDOW = 5          # 5 data points (approx 5 seconds if data comes every sec)
    ALERT_CPU_HIGH = 85.0          # Alert if average CPU > 85% 
    ALERT_CPU_CRITICAL = 95.0      # Critical alert for imminent crash
    ALERT_MEMORY_HIGH = 90.0       # Memory threshold
    ALERT_REQUEST_SPIKE = 2.5      # Alert if requests suddenly 2.5x higher than baseline
    HYSTERESIS = 5.0               # Avoid alert flapping (CPU must drop below 80% to clear HIGH alert)
    
    # Simulated BIUST Server Names (For realistic logging)
    TARGET_SERVERS = ["STUDENT-PORTAL", "MOODLE-LMS", "LIBRARY-DB", "REGISTRATION-ENGINE"]

# -------------------------------
# 2. DATA MODELS (Using dataclasses for clean structure)
# -------------------------------
class AlertSeverity(Enum):
    NORMAL = "GREEN"
    WARNING = "YELLOW"  # e.g., high memory usage
    HIGH = "ORANGE"     # e.g., CPU > 85%
    CRITICAL = "RED"    # e.g., CPU > 95%, immediate scaling needed

@dataclass
class ProcessedMetric:
    """This is the exact structure Theo (Backend) and Thandiswa (Dashboard) expect."""
    timestamp: float
    server_id: str
    cpu_percent: float
    memory_percent: float
    request_rate: int
    cpu_avg_5s: float
    memory_avg_5s: float
    request_rate_baseline: float
    alert_severity: str
    alert_reason: str
    scaling_suggestion: str  # e.g., "ADD_WORKER", "REMOVE_WORKER", "STEADY"
    worker_id: str = "Loago-Worker-01"

# -------------------------------
# 3. THE PROCESSING WORKER CLASS 
# -------------------------------
class BIUSTMetricsProcessor:
    def __init__(self, worker_id: str = "Loago-Worker-01"):
        self.worker_id = worker_id
        
        # Rolling Buffers (Sliding Window) for each server
        # This is how real monitoring tools (Prometheus/Grafana) work
        self.cpu_history: Dict[str, deque] = {}
        self.memory_history: Dict[str, deque] = {}
        self.request_history: Dict[str, deque] = {}
        
        # State management to prevent alert fatigue
        self.current_alert_state: Dict[str, AlertSeverity] = {}
        
        # Setup professional logging (Team can see exactly what you processed)
        logging.basicConfig(
            level=logging.INFO,
            format='%(asctime)s - [WORKER] - %(levelname)s - %(message)s'
        )
        self.logger = logging.getLogger(__name__)
        self.logger.info(f"🚀 BIUST Advanced Processor started. Worker ID: {self.worker_id}")

    def _update_history(self, server_id: str, metric_type: str, value: float):
        """Maintains the sliding window of recent data."""
        if metric_type == "cpu":
            if server_id not in self.cpu_history:
                self.cpu_history[server_id] = deque(maxlen=Config.MOVING_AVG_WINDOW)
            self.cpu_history[server_id].append(value)
        elif metric_type == "memory":
            if server_id not in self.memory_history:
                self.memory_history[server_id] = deque(maxlen=Config.MOVING_AVG_WINDOW)
            self.memory_history[server_id].append(value)
        elif metric_type == "requests":
            if server_id not in self.request_history:
                self.request_history[server_id] = deque(maxlen=Config.MOVING_AVG_WINDOW * 2) # Longer baseline for requests
            self.request_history[server_id].append(value)

    def _calculate_average(self, history: deque) -> float:
        """Safe average calculation."""
        if not history:
            return 0.0
        return sum(history) / len(history)

    def _detect_anomalies(self, server_id: str, raw_data: Dict) -> Tuple[AlertSeverity, str, str]:
        """
        🧠 THE CORE INTELLIGENCE (Replaces the simple if/else from before)
        Determines if BIUST needs to spin up a new server.
        """
        cpu_now = raw_data.get("cpu", 0.0)
        mem_now = raw_data.get("memory", 0.0)
        req_now = raw_data.get("requests", 0)

        # Get windowed averages
        cpu_avg = self._calculate_average(self.cpu_history.get(server_id, deque()))
        mem_avg = self._calculate_average(self.memory_history.get(server_id, deque()))
        req_avg = self._calculate_average(self.request_history.get(server_id, deque()))
        
        # Calculate baseline for requests (last 10 points if available)
        req_history_list = list(self.request_history.get(server_id, deque()))
        baseline_req = sum(req_history_list[:-1]) / max(len(req_history_list[:-1]), 1) if len(req_history_list) > 1 else req_now

        severity = AlertSeverity.NORMAL
        reason = "All systems operational."
        suggestion = "STEADY"

        # 1. CRITICAL CHECK: Immediate crash risk
        if cpu_now > Config.ALERT_CPU_CRITICAL:
            severity = AlertSeverity.CRITICAL
            reason = f"CPU at {cpu_now:.1f}%! CRITICAL THRESHOLD BREACHED."
            suggestion = "ADD_WORKER_IMMEDIATE"
        # 2. HIGH CHECK: Sustained high load
        elif cpu_avg > Config.ALERT_CPU_HIGH and len(self.cpu_history.get(server_id, [])) == Config.MOVING_AVG_WINDOW:
            severity = AlertSeverity.HIGH
            reason = f"Sustained high CPU load: {cpu_avg:.1f}% average over {Config.MOVING_AVG_WINDOW}s."
            suggestion = "ADD_WORKER"
        # 3. MEMORY LEAK CHECK
        elif mem_avg > Config.ALERT_MEMORY_HIGH:
            severity = AlertSeverity.WARNING
            reason = f"High memory utilization: {mem_avg:.1f}%. Possible memory leak."
            suggestion = "INVESTIGATE"
        # 4. REQUEST SPIKE CHECK (BIUST Registration just opened)
        elif req_now > baseline_req * Config.ALERT_REQUEST_SPIKE and baseline_req > 0:
            severity = AlertSeverity.WARNING
            reason = f"Request spike detected: {req_now} req/s (Baseline: {baseline_req:.1f})."
            suggestion = "PREPARE_SCALE"
        # 5. LOW LOAD CHECK (Save university electricity/money)
        elif cpu_avg < 20.0 and len(self.cpu_history.get(server_id, [])) == Config.MOVING_AVG_WINDOW:
            severity = AlertSeverity.NORMAL
            reason = "Low utilization detected."
            suggestion = "REMOVE_WORKER" # Tell Theo to scale down

        # Hysteresis Logic: If it was CRITICAL last time, don't downgrade to NORMAL instantly
        # This prevents the dashboard from flickering between Red and Green every second.
        prev_state = self.current_alert_state.get(server_id)
        if prev_state == AlertSeverity.CRITICAL and severity == AlertSeverity.NORMAL:
            if cpu_now > (Config.ALERT_CPU_HIGH - Config.HYSTERESIS):
                severity = AlertSeverity.HIGH # Keep it orange until it really cools down
                reason += " (Cooling down from critical state)"

        self.current_alert_state[server_id] = severity
        return severity, reason, suggestion

    def process_raw_data(self, raw_data: Dict) -> Optional[ProcessedMetric]:
        """
        Main entry point. Called by Godfrey's ingestion pipeline.
        Returns a fully processed metric ready for the database/dashboard.
        """
        try:
            server_id = raw_data.get("server_id", "UNKNOWN")
            if server_id == "UNKNOWN":
                # For demo purposes, assign a random BIUST server if not specified
                server_id = random.choice(Config.TARGET_SERVERS)

            # Extract values with safe defaults
            cpu = float(raw_data.get("cpu", random.uniform(10, 90)))
            mem = float(raw_data.get("memory", random.uniform(20, 80)))
            reqs = int(raw_data.get("requests", random.randint(50, 200)))

            # Update rolling windows
            self._update_history(server_id, "cpu", cpu)
            self._update_history(server_id, "memory", mem)
            self._update_history(server_id, "requests", reqs)

            # Calculate advanced metrics
            cpu_avg = self._calculate_average(self.cpu_history.get(server_id, deque()))
            mem_avg = self._calculate_average(self.memory_history.get(server_id, deque()))
            req_history = list(self.request_history.get(server_id, deque()))
            baseline_req = sum(req_history[:-1]) / max(len(req_history[:-1]), 1) if len(req_history) > 1 else reqs

            # Detect issues
            severity, reason, suggestion = self._detect_anomalies(server_id, raw_data)

            # Create the structured output
            output = ProcessedMetric(
                timestamp=time.time(),
                server_id=server_id,
                cpu_percent=cpu,
                memory_percent=mem,
                request_rate=reqs,
                cpu_avg_5s=round(cpu_avg, 2),
                memory_avg_5s=round(mem_avg, 2),
                request_rate_baseline=round(baseline_req, 2),
                alert_severity=severity.value,
                alert_reason=reason,
                scaling_suggestion=suggestion,
                worker_id=self.worker_id
            )

            # Log it professionally (This is what you show in the demo terminal)
            if severity != AlertSeverity.NORMAL:
                self.logger.warning(f"🚨 {server_id} | {severity.value} | {reason} | Suggestion: {suggestion}")
            else:
                self.logger.info(f"✅ {server_id} | CPU: {cpu:.1f}% | Avg: {cpu_avg:.1f}% | Req/s: {reqs}")

            return output

        except Exception as e:
            self.logger.error(f"Failed to process data: {e} | Raw data: {raw_data}")
            return None

    def simulate_output_to_dashboard(self, metric: ProcessedMetric):
        """
        Simulates sending data to Theo (Orchestrator) and Thandiswa (Dashboard).
        In the real system, this would be an HTTP POST to an API.
        Here we just print it as pretty JSON.
        """
        output_json = json.dumps(asdict(metric), indent=2)
        print("\n" + "="*50)
        print(f"📊 [DASHBOARD UPDATE] {metric.server_id}")
        print("="*50)
        print(output_json)
        print("="*50 + "\n")

# -------------------------------
# 4. DEMO / TEST HARNESS (Week 3 Demo Execution)
# -------------------------------
if __name__ == "__main__":
    print("🔥🔥🔥 BIUST SERVER MONITORING - PRODUCTION PROCESSOR 🔥🔥🔥")
    print(f"Lead: Loago Ditetso | Worker ID: Loago-Worker-01")
    print("Simulating live traffic from Student Portal and Moodle...")
    print("-" * 60)
    
    processor = BIUSTMetricsProcessor()
    
    # Simulate a 15-second period during BIUST registration peak time.
    # We will inject a "traffic spike" halfway through to show auto-scaling detection.
    for i in range(15):
        # Simulate Godfrey's ingestion sending data for different servers
        if i < 5:
            # Normal load: 8 AM on a Tuesday
            fake_data = {
                "server_id": "STUDENT-PORTAL",
                "cpu": random.uniform(30, 55),
                "memory": random.uniform(40, 60),
                "requests": random.randint(80, 120)
            }
        elif i < 10:
            # SPIKE LOAD: Results just released! (CPU jumps to 90%+)
            fake_data = {
                "server_id": "STUDENT-PORTAL",
                "cpu": random.uniform(88, 98),  # CRITICAL ZONE
                "memory": random.uniform(75, 92),
                "requests": random.randint(450, 600)  # Huge request spike
            }
        else:
            # Recovery: System scales up (simulated), load drops back to safe levels
            fake_data = {
                "server_id": "MOODLE-LMS",
                "cpu": random.uniform(20, 40),
                "memory": random.uniform(35, 50),
                "requests": random.randint(60, 100)
            }
            
        # Process the data
        result = processor.process_raw_data(fake_data)
        
        if result:
            # This is the part you show the lecturer: The Dashboard Output
            processor.simulate_output_to_dashboard(result)
            
            # In a real system, this is where you'd write to InfluxDB or send to Kafka topic 'processed_metrics'
            
        time.sleep(1.0) # Data arrives every 1 second
