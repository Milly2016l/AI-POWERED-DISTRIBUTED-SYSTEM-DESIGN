"""
BiustSystem/consumer/consumer.py
==================================
Kafka consumer that reads metrics from the 'metrics-topic' topic,
dispatches each message to a Celery worker for async processing,
and writes every metric to InfluxDB for persistent storage.
"""

import json
import sys
import os
from kafka import KafkaConsumer

# Allow imports from project root
sys.path.append(os.path.join(os.path.dirname(__file__), "..", ".."))

from BiustSystem.workers.worker import process_metric
from BiustSystem.consumer.influx_writer import write_metric

consumer = KafkaConsumer(
    "metrics-topic",
    bootstrap_servers="localhost:9092",
    auto_offset_reset="earliest",
    value_deserializer=lambda v: json.loads(v.decode("utf-8"))
)

print("[CONSUMER] Running... waiting for messages from Kafka")

for message in consumer:
    data = message.value
    server = data.get("server_id", "unknown")

    print(f"\n[CONSUMER] Received message from Kafka: {server}")

    # 1. Persist to InfluxDB
    write_metric(data)

    # 2. Hand off to Celery worker asynchronously
    process_metric.delay(data)
    print(f"[CONSUMER] Dispatched to Celery worker ✅")