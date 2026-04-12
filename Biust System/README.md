# AI-Powered Distributed System Monitor

A real-time distributed system monitoring platform where multiple clients stream server metrics, processed through a Kafka message queue, handled by async Celery workers, stored in InfluxDB, and visualized on a Streamlit dashboard.

---

## System Architecture

```
client.py  →  FastAPI /metrics  →  Kafka  →  consumer.py  →  Celery Worker  →  InfluxDB
                                                                                    ↓
                                                                             Streamlit Dashboard
```

---

## Prerequisites

Before cloning the repo, make sure you have the following installed on your machine:

| Tool | Version | Download |
|---|---|---|
| Python | **3.11.x** | https://www.python.org/downloads/release/python-3119/ |
| Docker Desktop | Latest | https://www.docker.com/products/docker-desktop |
| Docker Compose | Included with Docker Desktop | — |
| Git | Latest | https://git-scm.com/downloads |

> ⚠️ **Python 3.11 is required.** The dependencies in `requirements.txt` (especially `scikit-learn==1.7.2` and `numpy==1.26.4`) are not fully compatible with Python 3.12+. Use `python --version` to confirm before proceeding.

---

## Cloning the Repository

```bash
git clone https://github.com/your-username/AI-POWERED-DISTRIBUTED-SYSTEM-DESIGN.git
cd AI-POWERED-DISTRIBUTED-SYSTEM-DESIGN
```

---

## Environment Setup

### 1. Create and activate a virtual environment

**Linux / macOS:**
```bash
python3.11 -m venv venv
source venv/bin/activate
```

**Windows (Command Prompt):**
```cmd
py -3.11 -m venv venv
venv\Scripts\activate
```

**Windows (PowerShell):**
```powershell
py -3.11 -m venv venv
venv\Scripts\Activate.ps1
```

### 2. Install Python dependencies

```bash
pip install --upgrade pip
pip install -r requirements.txt
```

---

## Starting Infrastructure Services (Docker)

All infrastructure (Kafka, Zookeeper, Redis, InfluxDB) runs in Docker containers.

```bash
docker-compose up -d
```

Verify all containers are running:
```bash
docker ps
```

You should see four containers: `zookeeper`, `kafka`, `redis`, and `influxdb`.

To stop all services:
```bash
docker-compose down
```

---

## Running the System

Open **5 separate terminals** and activate the virtual environment in each one before running.

**Activate venv (repeat in each terminal):**
```bash
# Linux/macOS
source venv/bin/activate

# Windows
venv\Scripts\activate
```

---

### Terminal 1 — Ingestion API

```bash
cd "Biust System/ingestion"
uvicorn main:app --reload --port 8000
```

Expected output:
```
INFO:     Uvicorn running on http://127.0.0.1:8000
INFO:     Application startup complete.
```

---

### Terminal 2 — Celery Worker

```bash
cd "Biust System/workers"
celery -A worker worker --loglevel=info
```

Expected output:
```
[celery@hostname] ready.
```

---

### Terminal 3 — Kafka Consumer

```bash
cd "Biust System/consumer"
python consumer.py
```

Expected output:
```
Consumer running... waiting for messages
```

---

### Terminal 4 — Simulator (Client)

```bash
cd "Biust System/simulator"
python client.py
```

Expected output:
```
{'status': 'sent'}
{'status': 'sent'}
...
```

---

### Terminal 5 — Dashboard (optional)

```bash
streamlit run dashboard/app.py
```

Then open your browser at: `http://localhost:8501`

---

## Verifying the Data Flow

Once all terminals are running, you should observe the following chain:

1. **client.py** — sends random metrics every second to the API
2. **FastAPI** — receives and forwards metrics to Kafka
3. **consumer.py** — reads from Kafka and dispatches tasks
4. **Celery worker** — processes metrics and prints alerts

Example worker output:
```
[WORKER] Processing metric from node-3
  CPU:    87.4%
  Memory: 65.2%
  ⚠️  ALERT: High CPU on node-3 -> 87.4%
```

---

## InfluxDB Web UI

InfluxDB has a built-in browser UI for exploring stored metrics.

- URL: `http://localhost:8086`
- Username: `admin`
- Password: `admin1234`
- Organisation: `biust`
- Bucket: `metrics`
- Token: `biust-super-secret-token`

---

## Project Structure

```
AI-POWERED-DISTRIBUTED-SYSTEM-DESIGN/
│
├── Biust System/
│   ├── ingestion/
│   │   ├── main.py          # FastAPI app — receives POST /metrics
│   │   ├── models.py        # Pydantic schema for incoming metrics
│   │   └── producer.py      # Sends metrics to Kafka topic
│   │
│   ├── consumer/
│   │   └── consumer.py      # Reads from Kafka, dispatches to Celery
│   │
│   ├── workers/
│   │   ├── __init__.py
│   │   └── worker.py        # Celery task — processes and alerts on metrics
│   │
│   └── simulator/
│       └── client.py        # Simulates 5 servers sending live metrics
│
├── docker-compose.yml        # Kafka, Zookeeper, Redis, InfluxDB
├── requirements.txt
└── README.md
```

---

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `NoBrokersAvailable` | Kafka not running | `docker-compose up -d kafka zookeeper` |
| `redis.exceptions.ConnectionError` | Redis not running | `docker-compose up -d redis` |
| `ModuleNotFoundError: celery` | venv not activated | `source venv/bin/activate` |
| `Connection refused` on port 8000 | FastAPI not started | Run Terminal 1 first |
| `python: command not found` | Wrong Python version | Use `python3.11` or `py -3.11` |
| Worker receives no tasks | Consumer not running | Start Terminal 3 before Terminal 4 |

---

## Running Tests

```bash
pytest
```

---

## Tech Stack

| Component | Technology |
|---|---|
| API | FastAPI + Uvicorn |
| Message Queue | Apache Kafka |
| Task Queue | Celery |
| Cache / Broker | Redis |
| Time-series DB | InfluxDB |
| ML / Analytics | scikit-learn, pandas, numpy |
| Dashboard | Streamlit |
| Containerisation | Docker + Docker Compose |

---

## License

MIT License — see [LICENSE](LICENSE) for details.
