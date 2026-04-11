import json
from kafka import KafkaProducer

producer = KafkaProducer(
    bootstrap_servers="localhost:9092",
    value_serializer=lambda v: json.dumps(v).encode("utf-8")
)

def send_to_kafka(data):
    producer.send("metrics-topic", value=data)
    producer.flush()
    print(f"SENT TO KAFKA: {data}")