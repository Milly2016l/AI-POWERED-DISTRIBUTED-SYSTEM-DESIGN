import requests
import random
import time

URL = "http://127.0.0.1:8000/metrics"

while True:
    data = {
        "server_id": f"node-{random.randint(1,5)}",
        "cpu_usage": random.uniform(20, 95),
        "memory_usage": random.uniform(30, 90),
        "requests": random.randint(100, 2000),
        "latency": random.uniform(50, 300)
    }

    res = requests.post(URL, json=data)
    print(res.json())

    time.sleep(1)