from pydantic import BaseModel

class Metrics(BaseModel):
    server_id: str
    cpu_usage: float
    memory_usage: float
    requests: int
    latency: float