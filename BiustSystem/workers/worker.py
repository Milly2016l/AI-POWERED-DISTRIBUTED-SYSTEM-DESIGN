from celery import Celery
import logging

# Set up logging
logger = logging.getLogger(__name__)

app = Celery("workers", broker="redis://localhost:6379/0")

@app.task(name="workers.worker.process_metric")
def process_metric(data):
    cpu = data.get("cpu_usage", 0)
    memory = data.get("memory_usage", 0)
    server = data.get("server_id", "unknown")
    requests = data.get("requests", 0)
    latency = data.get("latency", 0)

    # Use Celery's logger
    logger.info(f"\n[WORKER] Processing metric from {server}")
    logger.info(f"  CPU:     {cpu:.1f}%")
    logger.info(f"  Memory:  {memory:.1f}%")
    logger.info(f"  Requests: {requests}")
    logger.info(f"  Latency: {latency:.0f}ms")

    # Alert logic
    if cpu > 80:
        logger.warning(f"⚠️  ALERT: High CPU on {server} -> {cpu:.1f}%")
    if memory > 80:
        logger.warning(f"⚠️  ALERT: High Memory on {server} -> {memory:.1f}%")
    if latency > 500:
        logger.warning(f"⚠️  ALERT: High Latency on {server} -> {latency:.0f}ms")

    if cpu <= 80 and memory <= 80 and latency <= 500:
        logger.info(f"✅ All systems normal on {server}")

    return {
        "server": server, 
        "cpu": cpu, 
        "memory": memory,
        "requests": requests,
        "latency": latency,
        "status": "processed"
    }