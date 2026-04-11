from celery import Celery

# Connect Celery to Redis as the broker
app = Celery("workers", broker="redis://localhost:6379/0")

@app.task
def process_metric(data):
    cpu = data.get("cpu_usage", 0)
    memory = data.get("memory_usage", 0)
    server = data.get("server_id", "unknown")

    print(f"\n[WORKER] Processing metric from {server}")
    print(f"  CPU:    {cpu}%")
    print(f"  Memory: {memory}%")

    # Alert logic
    if cpu > 80:
        print(f"  ⚠️  ALERT: High CPU on {server} -> {cpu}%")
    if memory > 80:
        print(f"  ⚠️  ALERT: High Memory on {server} -> {memory}%")

    if cpu <= 80 and memory <= 80:
        print(f"  ✅ All systems normal on {server}")

    return {"server": server, "cpu": cpu, "memory": memory, "status": "processed"}