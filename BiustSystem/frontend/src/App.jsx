import { useEffect, useState, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, AreaChart, Area
} from "recharts";
import "./App.css";

const API = "http://127.0.0.1:8000";

const CustomTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    return (
      <div style={{
        background: "rgba(10,14,26,0.95)",
        border: "1px solid rgba(0,255,200,0.2)",
        borderRadius: "8px", padding: "10px 14px",
        fontSize: "12px", color: "#a0aec0"
      }}>
        <p style={{ color: "#00ffc8", marginBottom: 4, fontFamily: "monospace" }}>{label}</p>
        {payload.map((p, i) => (
          <p key={i} style={{ color: p.color, margin: "2px 0" }}>
            {p.name}: <strong>{p.value}</strong>
          </p>
        ))}
      </div>
    );
  }
  return null;
};

function PulsingDot({ color }) {
  return (
    <span style={{ position: "relative", display: "inline-block", width: 10, height: 10, marginRight: 6 }}>
      <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: color, animation: "ping 1.5s cubic-bezier(0,0,0.2,1) infinite", opacity: 0.5 }} />
      <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: color }} />
    </span>
  );
}

function MetricCard({ label, value, unit, color, icon, sublabel }) {
  return (
    <div className="metric-card" style={{ "--accent": color }}>
      <div className="metric-card-header">
        <span className="metric-icon">{icon}</span>
        <span className="metric-label">{label}</span>
      </div>
      <div className="metric-value">{value}<span className="metric-unit">{unit}</span></div>
      {sublabel && <div className="metric-sublabel">{sublabel}</div>}
      <div className="metric-bar"><div className="metric-bar-fill" style={{ width: `${Math.min(value, 100)}%` }} /></div>
    </div>
  );
}

export default function App() {
  const [apiStatus, setApiStatus] = useState("checking");
  const [metrics, setMetrics] = useState({ cpu: 0, memory: 0, requests: 0, latency: 0 });
  const [history, setHistory] = useState([]);
  const [predictedLoad, setPredictedLoad] = useState(0);
  const [recommendation, setRecommendation] = useState("normal");
  const [alert, setAlert] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [modelType, setModelType] = useState("");
  const [isPeakHour, setIsPeakHour] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);

  useEffect(() => {
    fetch(`${API}/health`).then(r => r.json()).then(() => setApiStatus("healthy")).catch(() => setApiStatus("offline"));
  }, []);

  const getPrediction = useCallback(async (m) => {
    try {
      const res = await fetch(`${API}/predict`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server_id: "dashboard", ...m }),
      });
      const data = await res.json();
      setPredictedLoad(data.predicted_load ?? 0);
      setRecommendation(data.recommendation ?? "normal");
      setAlert(data.alert ?? null);
      setModelType(data.model_type ?? "");
      setIsPeakHour(data.context?.is_peak_hour ?? false);
    } catch { setPredictedLoad(0); }
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${API}/metrics/latest`);
        const data = await res.json();
        const items = data.metrics;
        if (items.length > 0) {
          const latest = items[items.length - 1];
          const m = { cpu: latest.cpu_usage, memory: latest.memory_usage, requests: latest.requests, latency: latest.latency };
          setMetrics(m);
          setLastUpdated(new Date().toLocaleTimeString());
          setHistory(items.slice(-15).map(i => ({
            time: i.timestamp?.slice(11, 19) || "",
            cpu: Math.round(i.cpu_usage), memory: Math.round(i.memory_usage),
            latency: Math.round(i.latency), requests: i.requests,
          })));
          getPrediction(m);
        }
      } catch { setApiStatus("offline"); }
    }, 2000);
    return () => clearInterval(interval);
  }, [autoRefresh, getPrediction]);

  const generateMetrics = async () => {
    const m = { server_id: `node-${Math.floor(Math.random() * 5) + 1}`, cpu: Math.floor(Math.random() * 100), memory: Math.floor(Math.random() * 100), requests: Math.floor(Math.random() * 1000), latency: Math.floor(Math.random() * 300) };
    try {
      await fetch(`${API}/metrics`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(m) });
      setMetrics(m); setLastUpdated(new Date().toLocaleTimeString());
      setHistory(prev => [...prev.slice(-14), { time: new Date().toLocaleTimeString(), ...m }]);
      getPrediction(m);
    } catch { setApiStatus("offline"); }
  };

  const loadPercent = Math.round(predictedLoad * 100);
  const loadColor = loadPercent > 75 ? "#ff4d6d" : loadPercent > 50 ? "#ffd166" : "#00ffc8";

  return (
    <div className="app">
      <div className="bg-grid" />
      <header className="top-bar">
        <div className="top-bar-left">
          <div className="logo-mark">◈</div>
          <div>
            <h1 className="title">BIUST Monitor</h1>
            <p className="subtitle">AI-Powered Distributed System</p>
          </div>
        </div>
        <div className="top-bar-right">
          {isPeakHour && <span className="badge badge-peak">⚡ Peak Hours</span>}
          {modelType && <span className="badge badge-model">🧠 {modelType}</span>}
          {lastUpdated && <span className="badge badge-time">🕐 {lastUpdated}</span>}
          <div className={`status-pill status-${apiStatus}`}>
            <PulsingDot color={apiStatus === "healthy" ? "#00ffc8" : "#ff4d6d"} />
            <span>API {apiStatus.toUpperCase()}</span>
          </div>
        </div>
      </header>

      {alert && (
        <div className="alert-banner">
          <span className="alert-icon">⚠</span>
          <span>{alert}</span>
          <span className="alert-rec">→ {recommendation.replace(/_/g, " ").toUpperCase()}</span>
        </div>
      )}

      <section className="cards-grid">
        <MetricCard label="CPU Usage" value={metrics.cpu} unit="%" color="#ff6b6b" icon="⬡" sublabel={metrics.cpu > 80 ? "Critical" : metrics.cpu > 60 ? "Elevated" : "Normal"} />
        <MetricCard label="Memory" value={metrics.memory} unit="%" color="#a78bfa" icon="◫" sublabel={metrics.memory > 80 ? "Critical" : metrics.memory > 60 ? "Elevated" : "Normal"} />
        <MetricCard label="Requests" value={metrics.requests} unit="/s" color="#38bdf8" icon="⇄" sublabel="per second" />
        <MetricCard label="Latency" value={metrics.latency} unit="ms" color="#fb923c" icon="◎" sublabel={metrics.latency > 200 ? "High" : "Normal"} />
        <div className="metric-card ai-card" style={{ "--accent": loadColor }}>
          <div className="metric-card-header">
            <span className="metric-icon">◈</span>
            <span className="metric-label">AI Predicted Load</span>
          </div>
          <div className="ai-gauge">
            <svg viewBox="0 0 120 70" width="120" height="70">
              <path d="M10,60 A50,50 0 0,1 110,60" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="10" strokeLinecap="round" />
              <path d="M10,60 A50,50 0 0,1 110,60" fill="none" stroke={loadColor} strokeWidth="10" strokeLinecap="round"
                strokeDasharray={`${loadPercent * 1.57} 157`} style={{ transition: "stroke-dasharray 0.6s ease, stroke 0.4s ease" }} />
              <text x="60" y="58" textAnchor="middle" fill={loadColor} fontSize="20" fontWeight="bold" fontFamily="monospace">{loadPercent}%</text>
            </svg>
          </div>
          <div className="metric-sublabel" style={{ color: loadColor }}>
            {recommendation === "scale_up_urgent" ? "🔴 Scale Up Urgently" : recommendation === "scale_up" ? "🟡 Scale Up Recommended" : "🟢 Normal Operation"}
          </div>
        </div>
      </section>

      <section className="charts-section">
        <div className="chart-card">
          <div className="chart-header">
            <h2 className="chart-title">CPU & Memory</h2>
            <span className="chart-subtitle">Last 15 readings</span>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={history}>
              <defs>
                <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#ff6b6b" stopOpacity={0.3} /><stop offset="95%" stopColor="#ff6b6b" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="memGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#a78bfa" stopOpacity={0.3} /><stop offset="95%" stopColor="#a78bfa" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="time" tick={{ fill: "#4a5568", fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis domain={[0, 100]} tick={{ fill: "#4a5568", fontSize: 10 }} axisLine={false} tickLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 12, color: "#718096" }} />
              <Area type="monotone" dataKey="cpu" stroke="#ff6b6b" fill="url(#cpuGrad)" strokeWidth={2} dot={false} name="CPU %" />
              <Area type="monotone" dataKey="memory" stroke="#a78bfa" fill="url(#memGrad)" strokeWidth={2} dot={false} name="Memory %" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="chart-card">
          <div className="chart-header">
            <h2 className="chart-title">Latency & Requests</h2>
            <span className="chart-subtitle">Response time trends</span>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={history}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="time" tick={{ fill: "#4a5568", fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: "#4a5568", fontSize: 10 }} axisLine={false} tickLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 12, color: "#718096" }} />
              <Line type="monotone" dataKey="latency" stroke="#fb923c" strokeWidth={2} dot={false} name="Latency ms" />
              <Line type="monotone" dataKey="requests" stroke="#38bdf8" strokeWidth={2} dot={false} name="Requests/s" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="controls">
        <button className={`btn btn-live ${autoRefresh ? "btn-live-active" : ""}`} onClick={() => setAutoRefresh(v => !v)}>
          {autoRefresh ? "⏹ Stop Live Feed" : "▶ Start Live Feed"}
        </button>
        <button className="btn btn-test" onClick={generateMetrics}>⚡ Send Test Metric</button>
        <p className="controls-hint">Live feed polls backend every 2s · Test metric flows through the full pipeline</p>
      </section>

      <footer className="footer">
        <span>BIUST Load Master</span><span className="footer-dot">·</span>
        <span>FastAPI + Kafka + Celery + RandomForest AI</span><span className="footer-dot">·</span>
        <span>Team Load Master © 2026</span>
      </footer>
    </div>
  );
}