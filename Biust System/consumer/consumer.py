import json
from kafka import KafkaConsumer
import sys
import os

# So consumer can import from workers folder
sys.path.append(os.path.join(os.path.dirname(__file__), ".."))
from workers.worker import process_metric

consumer = KafkaConsumer(
    "metrics-topic",
    bootstrap_servers="localhost:9092",
    auto_offset_reset="earliest",
    value_deserializer=lambda v: json.loads(v.decode("utf-8"))
)

print("Consumer running... waiting for messages")

for message in consumer:
    data = message.value
    print(f"\n[CONSUMER] Received message from Kafka: {data['server_id']}")

    # Hand off to Celery worker asynchronously
    process_metric.delay(data)
    print(f"[CONSUMER] Dispatched to worker ✅")