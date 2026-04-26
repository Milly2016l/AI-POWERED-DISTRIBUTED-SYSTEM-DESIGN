import requests
import random
import time

URL = "http://127.0.0.1:8000/metrics"

print("Simulator running... sending metrics every second")

while True:
    data = {
        "server_id": f"node-{random.randint(1, 5)}",
        "cpu": random.randint(85, 98),
        "memory": random.randint(75, 92),
        "requests": random.randint(100, 2000),
        "latency": random.randint(50, 300)
    }

    try:
        res = requests.post(URL, json=data)
        print(f"SENT: {data['server_id']} | CPU: {data['cpu']}% | Memory: {data['memory']}% | Response: {res.json()}")
    except Exception as e:
        print(f"ERROR: Could not reach API - {e}")

    time.sleep(1)