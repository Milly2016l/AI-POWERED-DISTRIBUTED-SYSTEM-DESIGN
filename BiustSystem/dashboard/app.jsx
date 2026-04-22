import { useEffect, useState, useCallback } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import "./App.css";

const API = "http://127.0.0.1:8000";

function App() {
  const [apiStatus, setApiStatus] = useState("checking");
  const [metrics, setMetrics] = useState({
    cpu: 0,
    memory: 0,
    requests: 0,
    latency: 0,
  });
  const [history, setHistory] = useState([]);
  const [predictedLoad, setPredictedLoad] = useState(0);
  const [recommendation, setRecommendation] = useState("normal");
  const [alert, setAlert] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(false);

  // Check API health on load
  useEffect(() => {
    fetch(`${API}/health`)
      .then((res) => res.json())
      .then(() => setApiStatus("healthy"))
      .catch(() => setApiStatus("offline"));
  }, []);

  // Poll live metrics from backend every 2 seconds when autoRefresh is on
  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${API}/metrics/latest`);
        const data = await res.json();
        const items = data.metrics;

        if (items.length > 0) {
          const latest = items[items.length - 1];

          // Update current metric cards
          setMetrics({
            cpu: latest.cpu_usage,
            memory: latest.memory_usage,
            requests: latest.requests,
            latency: latest.latency,
          });

          // Update chart history
          setHistory(
            items.slice(-10).map((m) => ({
              time: m.timestamp?.slice(11, 19) || "",
              cpu: m.cpu_usage,
              memory: m.memory_usage,
              latency: m.latency,
            }))
          );

          // Get AI prediction for latest metric
          getPrediction({
            cpu: latest.cpu_usage,
            memory: latest.memory_usage,
            requests: latest.requests,
            latency: latest.latency,
          });
        }
      } catch {
        setApiStatus("offline");
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [autoRefresh]);

  // Get AI prediction from backend
  const getPrediction = useCallback(async (currentMetrics) => {
    try {
      const res = await fetch(`${API}/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          server_id: "dashboard",
          ...currentMetrics,
        }),
      });
      const data = await res.json();
      setPredictedLoad(data.predicted_load);
      setRecommendation(data.recommendation);
      setAlert(data.alert);
    } catch {
      setPredictedLoad(0);
    }
  }, []);

  // Manually generate and send metrics to backend
  const generateMetrics = async () => {
    const newMetrics = {
      server_id: `node-${Math.floor(Math.random() * 5) + 1}`,
      cpu: Math.floor(Math.random() * 100),
      memory: Math.floor(Math.random() * 100),
      requests: Math.floor(Math.random() * 1000),
      latency: Math.floor(Math.random() * 300),
    };

    try {
      await fetch(`${API}/metrics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newMetrics),
      });

      setMetrics({
        cpu: newMetrics.cpu,
        memory: newMetrics.memory,
        requests: newMetrics.requests,
        latency: newMetrics.latency,
      });

      const entry = {
        time: new Date().toLocaleTimeString(),
        cpu: newMetrics.cpu,
        memory: newMetrics.memory,
        latency: newMetrics.latency,
      };

      setHistory((prev) => [...prev.slice(-9), entry]);
      getPrediction(newMetrics);
    } catch {
      setApiStatus("offline");
    }
  };

  return (
    <div className="dashboard">
      <header className="header">
        <h1>BIUST Server Monitoring Dashboard</h1>
        <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
          <button
            className="generate-btn"
            style={{ background: autoRefresh ? "#16a34a" : "#6366f1" }}
            onClick={() => setAutoRefresh((v) => !v)}
          >
            {autoRefresh ? "⏹ Stop Live Feed" : "▶ Start Live Feed"}
          </button>
          <span className={`status-badge status ${apiStatus}`}>
            API: {apiStatus.toUpperCase()}
          </span>
        </div>
      </header>

      {/* Metric Cards */}
      <div className="cards">
        <div className="card cpu">
          <h3>CPU Usage</h3>
          <p>{metrics.cpu}%</p>
        </div>
        <div className="card memory">
          <h3>Memory Usage</h3>
          <p>{metrics.memory}%</p>
        </div>
        <div className="card requests">
          <h3>Requests/sec</h3>
          <p>{metrics.requests}</p>
        </div>
        <div className="card latency">
          <h3>Latency</h3>
          <p>{metrics.latency} ms</p>
        </div>
        <div className="card ai">
          <h3>AI Predicted Load</h3>
          <p>{predictedLoad}</p>
          <small style={{ color: recommendation === "scale_up" ? "#ef4444" : "#16a34a" }}>
            {recommendation === "scale_up" ? "⚠ Scale Up Recommended" : "✅ Normal"}
          </small>
        </div>
      </div>

      {/* Alert Banner */}
      <div className={`alert ${alert ? "" : "ok"}`}>
        {alert ? `⚠ ALERT: ${alert}` : "✅ All Systems Operating Normally"}
      </div>

      {/* Live Charts */}
      <h2>Live CPU & Memory Usage</h2>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={history}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="time" tick={{ fontSize: 11 }} />
          <YAxis domain={[0, 100]} />
          <Tooltip />
          <Legend />
          <Line type="monotone" dataKey="cpu" stroke="#ef4444" name="CPU %" dot={false} strokeWidth={2} />
          <Line type="monotone" dataKey="memory" stroke="#6366f1" name="Memory %" dot={false} strokeWidth={2} />
        </LineChart>
      </ResponsiveContainer>

      <h2 style={{ marginTop: "1.5rem" }}>Latency (ms)</h2>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={history}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="time" tick={{ fontSize: 11 }} />
          <YAxis />
          <Tooltip />
          <Line type="monotone" dataKey="latency" stroke="#0ea5e9" name="Latency ms" dot={false} strokeWidth={2} />
        </LineChart>
      </ResponsiveContainer>

      {/* Manual Test Button */}
      <div style={{ margin: "2rem 0" }}>
        <button className="generate-btn" onClick={generateMetrics}>
          Send Test Metric to Backend
        </button>
        <p style={{ marginTop: "0.5rem", color: "#64748b", fontSize: "0.85rem" }}>
          Sends a metric through the full pipeline: Dashboard → API → Kafka → Worker
        </p>
      </div>

      <footer className="footer">
        BIUST Load Master — AI-Powered Distributed System | Live data via FastAPI + Kafka + Celery
      </footer>
    </div>
  );
}

export default App;