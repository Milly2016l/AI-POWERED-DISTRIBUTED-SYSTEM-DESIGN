import { useState, useEffect, useRef, useCallback } from "react";

const API_BASE = "http://127.0.0.1:8000";
const SERVERS = ["node-1", "node-2", "node-3", "node-4", "node-5"];
const WORKER_NAMES = ["Loago-Worker-01", "Theo-Worker-02", "Thandiswa-Worker-03"];

const SCENARIOS = {
  normal:   { label: "Normal Load",         cpu: [20, 55],  memory: [30, 60],  requests: [80, 200],   latency: [30, 100] },
  peak:     { label: "BIUST Peak Hours",    cpu: [65, 88],  memory: [70, 90],  requests: [400, 900],  latency: [150, 300] },
  critical: { label: "Registration Spike",  cpu: [88, 98],  memory: [85, 96],  requests: [800, 2000], latency: [250, 500] },
  low:      { label: "Off-Peak",            cpu: [5, 20],   memory: [15, 35],  requests: [20, 60],    latency: [15, 50] },
};

const TIME_RANGES = [
  { label: "Last 15 min", value: "-15m" },
  { label: "Last 1 hr",   value: "-1h"  },
  { label: "Last 6 hrs",  value: "-6h"  },
  { label: "Last 24 hrs", value: "-24h" },
  { label: "Last 7 days", value: "-7d"  },
];

const SEV_COLOR = { NORMAL: "#00ffc8", WARNING: "#ffd166", HIGH: "#fb923c", CRITICAL: "#ff4d6d" };
const SEV_BG    = { NORMAL: "rgba(0,255,200,0.08)", WARNING: "rgba(255,209,102,0.08)", HIGH: "rgba(251,146,60,0.08)", CRITICAL: "rgba(255,77,109,0.12)" };

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function ts()           { return new Date().toLocaleTimeString(); }

function generateMetric(scenario, serverId) {
  const s = SCENARIOS[scenario];
  return {
    server_id: serverId || SERVERS[rand(0, SERVERS.length - 1)],
    cpu:       rand(s.cpu[0],      s.cpu[1]),
    memory:    rand(s.memory[0],   s.memory[1]),
    requests:  rand(s.requests[0], s.requests[1]),
    latency:   rand(s.latency[0],  s.latency[1]),
    scenario,
  };
}

// ── MINI BAR ─────────────────────────────────────────────────
function Bar({ value, max = 100, color }) {
  return (
    <div style={{ height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden", marginTop: 3 }}>
      <div style={{ width: `${Math.min((value / max) * 100, 100)}%`, height: "100%", background: color, borderRadius: 2, transition: "width 0.5s", boxShadow: `0 0 5px ${color}` }} />
    </div>
  );
}

// ── BADGE ────────────────────────────────────────────────────
function Badge({ sev }) {
  return (
    <span style={{ background: SEV_BG[sev], border: `1px solid ${SEV_COLOR[sev]}55`, color: SEV_COLOR[sev], borderRadius: 4, padding: "1px 7px", fontSize: "0.6rem", fontWeight: 700 }}>
      {sev}
    </span>
  );
}

const PIPELINE_STEPS = ["Client", "FastAPI", "Kafka", "Consumer", "Celery Worker", "InfluxDB ✓"];

// ════════════════════════════════════════════════════════════
export default function BiustTestPanel() {
  const [scenario,     setScenario]     = useState("normal");
  const [autoSend,     setAutoSend]     = useState(false);
  const [autoInterval, setAutoInterval] = useState(2000);
  const [apiStatus,    setApiStatus]    = useState("checking");
  const [dbStatus,     setDbStatus]     = useState("checking");

  // live events sent this session
  const [liveEvents, setLiveEvents] = useState([]);
  // history pulled from InfluxDB
  const [historyRows,   setHistoryRows]   = useState([]);
  const [historyRange,  setHistoryRange]  = useState("-1h");
  const [historyLoading,setHistoryLoading]= useState(false);
  const [historyFilter, setHistoryFilter] = useState({ server_id: "", severity: "" });

  const [stats,    setStats]    = useState({ sent: 0, processed: 0, alerts: 0, scaled: 0 });
  const [dbStats,  setDbStats]  = useState({});
  const [workers,      setWorkers]      = useState([]);
  const [workerError,  setWorkerError]  = useState(false);
  const [pipeline,      setPipeline]      = useState({ step: -1, active: false });
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [activeTab,     setActiveTab]     = useState("live"); // "live" | "history" | "stats"

  const timerRef    = useRef(null);
  const liveEndRef  = useRef(null);

  // ── Health check ────────────────────────────────────────────
  useEffect(() => {
    fetch(`${API_BASE}/health`)
      .then(r => r.json())
      .then(d => {
        setApiStatus(d.status === "healthy" ? "online" : "degraded");
        setDbStatus(d.influxdb_connected === true ? "connected" : "offline");
      })
      .catch(() => { setApiStatus("offline"); setDbStatus("unknown"); });
  }, []);

  // ── Auto-scroll live feed ────────────────────────────────────
  useEffect(() => { liveEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [liveEvents]);

  // ── Pipeline animation ───────────────────────────────────────
  const animatePipeline = useCallback(() => {
    setPipeline({ active: true, step: 0 });
    let s = 0;
    const tick = setInterval(() => {
      s++;
      setPipeline(p => ({ ...p, step: s }));
      if (s >= PIPELINE_STEPS.length - 1) {
        clearInterval(tick);
        setTimeout(() => setPipeline({ active: false, step: -1 }), 800);
      }
    }, 200);
  }, []);

  // ── Send metric → API → InfluxDB ────────────────────────────
  const sendMetric = useCallback(async (overrideScenario) => {
    const sc  = overrideScenario || scenario;
    const raw = generateMetric(sc);
    animatePipeline();

    let result = null;
    try {
      const res = await fetch(`${API_BASE}/metrics`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(raw),
      });
      result = await res.json();
      setApiStatus("online");
      setDbStatus(result.influxdb_write ? "connected" : "offline");
    } catch {
      setApiStatus("offline");
    }

    const pred   = result?.prediction || {};
    const sev    = pred.severity   || "NORMAL";
    const sugg   = pred.suggestion || "STEADY";
    const pload  = pred.predicted_load != null ? Math.round(pred.predicted_load * 100) : 0;


    setStats(prev => ({
      sent:      prev.sent + 1,
      processed: prev.processed + 1,
      alerts:    prev.alerts + (sev !== "NORMAL" ? 1 : 0),
      scaled:    prev.scaled + (sugg.includes("ADD") || sugg.includes("REMOVE") ? 1 : 0),
    }));

    const event = {
      id:             Date.now() + Math.random(),
      time:           ts(),
      server_id:      raw.server_id,
      cpu:            raw.cpu,
      memory:         raw.memory,
      requests:       raw.requests,
      latency:        raw.latency,
      scenario:       sc,
      severity:       sev,
      suggestion:     sugg,
      predicted_load: pload,
      stored:         result?.influxdb_write ?? false,
    };
    setLiveEvents(prev => [...prev.slice(-99), event]);
  }, [scenario, animatePipeline, dbStatus]);

  // ── Auto-send loop ───────────────────────────────────────────
  useEffect(() => {
    clearInterval(timerRef.current);
    if (autoSend) timerRef.current = setInterval(() => sendMetric(), autoInterval);
    return () => clearInterval(timerRef.current);
  }, [autoSend, autoInterval, sendMetric]);

  // ── Real worker polling — /workers/status every 5 s ─────────
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res  = await fetch(`${API_BASE}/workers/status`);
        const data = await res.json();
        if (!cancelled) {
          setWorkers(data.workers || []);
          setWorkerError(false);
        }
      } catch {
        if (!cancelled) setWorkerError(true);
      }
    };
    poll();                                   // immediate first fetch
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // ── Load history from InfluxDB ───────────────────────────────
  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      // historyRange is already a Flux duration string like "-1h", "-15m", "-7d"
      const params = new URLSearchParams({ range: historyRange, limit: "200" });
      if (historyFilter.server_id) params.append("server_id", historyFilter.server_id);
      if (historyFilter.severity)  params.append("severity",  historyFilter.severity);
      const res  = await fetch(`${API_BASE}/metrics/history?${params}`);
      const data = await res.json();
      setHistoryRows(data.metrics || []);
    } catch (e) {
      console.error("History load failed", e);
    } finally {
      setHistoryLoading(false);
    }
  }, [historyRange, historyFilter]);

  // ── Load db stats ────────────────────────────────────────────
  const loadStats = useCallback(async () => {
    try {
      const res  = await fetch(`${API_BASE}/metrics/stats?range=${historyRange}`);
      const data = await res.json();
      setDbStats(data.stats || {});
    } catch (e) {
      console.error("Stats load failed", e);
    }
  }, [historyRange]);

  useEffect(() => {
    if (activeTab === "history") loadHistory();
    if (activeTab === "stats")   loadStats();
  }, [activeTab, loadHistory, loadStats]);

  const clearDB = async () => {
    if (!window.confirm("Delete ALL metrics from InfluxDB?")) return;
    await fetch(`${API_BASE}/metrics/clear`, { method: "DELETE" });
    setHistoryRows([]);
    setDbStats({});
    alert("InfluxDB cleared.");
  };

  const burst = async (sc) => {
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, i * 280));
      sendMetric(sc);
    }
  };

  // ── Shared styles ────────────────────────────────────────────
  const S = {
    root:   { fontFamily: "'JetBrains Mono','Fira Code',monospace", background: "#070b14", color: "#e2e8f0", minHeight: "100vh", paddingBottom: "2rem" },
    header: { background: "rgba(13,18,32,0.97)", borderBottom: "1px solid rgba(0,255,200,0.12)", padding: "0.9rem 1.5rem", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.75rem" },
    body:   { display: "grid", gridTemplateColumns: "300px 1fr", gap: "1rem", padding: "1rem 1.5rem", maxWidth: 1500, margin: "0 auto" },
    panel:  { background: "rgba(13,18,32,0.85)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: "1rem" },
    sec:    { fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.12em", color: "#4a5568", marginBottom: "0.6rem", fontWeight: 700 },
    pill:   (ok) => ({ display: "inline-flex", alignItems: "center", gap: 5, background: ok ? "rgba(0,255,200,0.08)" : "rgba(255,77,109,0.08)", border: `1px solid ${ok ? "rgba(0,255,200,0.25)" : "rgba(255,77,109,0.25)"}`, color: ok ? "#00ffc8" : "#ff4d6d", borderRadius: 6, padding: "3px 10px", fontSize: "0.68rem", fontWeight: 600 }),
    dot:    (ok) => ({ width: 6, height: 6, borderRadius: "50%", background: ok ? "#00ffc8" : "#ff4d6d" }),
    btn:    (c, active) => ({ background: active ? `rgba(${c},0.2)` : `rgba(${c},0.06)`, border: `1px solid rgba(${c},${active ? "0.45" : "0.2"})`, color: `rgb(${c})`, borderRadius: 7, padding: "7px 12px", fontSize: "0.74rem", cursor: "pointer", fontFamily: "inherit", fontWeight: 600, width: "100%", marginBottom: 6, transition: "all 0.15s" }),
    scBtn:  (k) => ({ background: scenario === k ? "rgba(0,255,200,0.12)" : "rgba(255,255,255,0.02)", border: `1px solid ${scenario === k ? "rgba(0,255,200,0.35)" : "rgba(255,255,255,0.06)"}`, color: scenario === k ? "#00ffc8" : "#718096", borderRadius: 7, padding: "7px 10px", fontSize: "0.7rem", cursor: "pointer", fontFamily: "inherit", fontWeight: 600, transition: "all 0.15s", textAlign: "left", width: "100%", marginBottom: 5 }),
    tab:    (active) => ({ background: active ? "rgba(0,255,200,0.12)" : "transparent", border: `1px solid ${active ? "rgba(0,255,200,0.3)" : "rgba(255,255,255,0.06)"}`, color: active ? "#00ffc8" : "#718096", borderRadius: 7, padding: "6px 14px", fontSize: "0.72rem", cursor: "pointer", fontFamily: "inherit", fontWeight: 600, marginRight: 6, transition: "all 0.15s" }),
    row:    { display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid rgba(255,255,255,0.04)", fontSize: "0.68rem", color: "#718096" },
    input:  { background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "5px 8px", color: "#e2e8f0", fontFamily: "inherit", fontSize: "0.7rem", width: "100%" },
  };

  return (
    <div style={S.root}>
      {/* ── HEADER ─────────────────────────────────────────── */}
      <header style={S.header}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <span style={{ fontSize: "1.6rem", color: "#00ffc8", filter: "drop-shadow(0 0 8px rgba(0,255,200,0.5))" }}>◈</span>
          <div>
            <div style={{ fontSize: "1rem", fontWeight: 700, color: "#fff" }}>BIUST Test Panel</div>
            <div style={{ fontSize: "0.6rem", color: "#4a5568", textTransform: "uppercase", letterSpacing: "0.1em" }}>Pipeline Monitor · InfluxDB Persistence</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {[["0,255,200", `Sent: ${stats.sent}`], ["56,189,248", `Stored: ${stats.processed}`], ["251,146,60", `Alerts: ${stats.alerts}`], ["167,139,250", `Scaled: ${stats.scaled}`]].map(([c, label]) => (
            <span key={label} style={{ background: `rgba(${c},0.1)`, border: `1px solid rgba(${c},0.25)`, color: `rgb(${c})`, borderRadius: 6, padding: "3px 11px", fontSize: "0.68rem" }}>{label}</span>
          ))}
          <span style={S.pill(apiStatus === "online")}>
            <span style={S.dot(apiStatus === "online")} /> API {apiStatus}
          </span>
          <span style={S.pill(dbStatus === "connected")}>
            <span style={S.dot(dbStatus === "connected")} /> DB {dbStatus}
          </span>
        </div>
      </header>

      <div style={S.body}>
        {/* ── LEFT SIDEBAR ───────────────────────────────────── */}
        <div>
          {/* SCENARIO */}
          <div style={{ ...S.panel, marginBottom: "1rem" }}>
            <div style={S.sec}>📡 Scenario</div>
            {Object.entries(SCENARIOS).map(([k, s]) => (
              <button key={k} style={S.scBtn(k)} onClick={() => setScenario(k)}>
                {scenario === k ? "▶ " : ""}{s.label}
                <div style={{ fontSize: "0.58rem", color: "#4a5568", marginTop: 2 }}>CPU {s.cpu[0]}–{s.cpu[1]}% · Req {s.requests[0]}–{s.requests[1]}/s</div>
              </button>
            ))}
          </div>

          {/* CONTROLS */}
          <div style={{ ...S.panel, marginBottom: "1rem" }}>
            <div style={S.sec}>⚡ Controls</div>
            <button style={S.btn("0,255,200", false)}  onClick={() => sendMetric()}>▶ Send Single Metric</button>
            <button style={S.btn("251,146,60", false)} onClick={() => burst(scenario)}>⚡ Burst × 5</button>
            <button style={S.btn("255,77,109", false)} onClick={() => burst("critical")}>🔴 Force Critical Spike</button>
            <button style={S.btn("167,139,250", autoSend)} onClick={() => setAutoSend(v => !v)}>
              {autoSend ? "⏹ Stop Auto-Send" : "🔄 Start Auto-Send"}
            </button>
            {autoSend && (
              <div style={{ marginBottom: 6 }}>
                <div style={{ fontSize: "0.6rem", color: "#4a5568", marginBottom: 3 }}>Every {autoInterval}ms</div>
                <input type="range" min={500} max={5000} step={500} value={autoInterval}
                  onChange={e => setAutoInterval(+e.target.value)} style={{ width: "100%", accentColor: "#00ffc8" }} />
              </div>
            )}
            <button style={S.btn("100,116,139", false)} onClick={() => { setLiveEvents([]); setStats({ sent: 0, processed: 0, alerts: 0, scaled: 0 }); }}>
              🗑 Clear Live Feed
            </button>
            <button style={S.btn("255,77,109", false)} onClick={clearDB}>
              🗑 Clear InfluxDB
            </button>
          </div>

          {/* PIPELINE */}
          <div style={S.panel}>
            <div style={S.sec}>🔁 Pipeline</div>
            {PIPELINE_STEPS.map((step, i) => {
              const active = pipeline.step === i;
              const done   = pipeline.step > i;
              return (
                <div key={step} style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 8px", borderRadius: 6, marginBottom: 3, background: active ? "rgba(0,255,200,0.1)" : done ? "rgba(0,255,200,0.04)" : "rgba(255,255,255,0.02)", border: `1px solid ${active ? "rgba(0,255,200,0.35)" : done ? "rgba(0,255,200,0.12)" : "rgba(255,255,255,0.05)"}`, transition: "all 0.2s" }}>
                  <div style={{ width: 7, height: 7, borderRadius: "50%", background: active ? "#00ffc8" : done ? "#00ffc8" : "#2d3748", boxShadow: active ? "0 0 8px #00ffc8" : "none", flexShrink: 0, transition: "all 0.2s" }} />
                  <span style={{ fontSize: "0.7rem", color: active ? "#00ffc8" : done ? "#00ffc8aa" : "#4a5568", fontWeight: active ? 700 : 400 }}>{step}</span>
                  {done   && <span style={{ marginLeft: "auto", fontSize: "0.58rem", color: "#00ffc8aa" }}>✓</span>}
                  {active && <span style={{ marginLeft: "auto", fontSize: "0.58rem", color: "#00ffc8" }}>●</span>}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── RIGHT MAIN ─────────────────────────────────────── */}
        <div>
          {/* WORKER NODES — real data polled from /workers/status every 5 s */}
          <div style={{ ...S.panel, marginBottom: "1rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: "0.6rem" }}>
              <div style={S.sec}>🖥 Worker Nodes</div>
              <span style={{ fontSize: "0.6rem", color: "#4a5568", marginLeft: "auto" }}>
                {workerError
                  ? "⚠ polling failed"
                  : workers.length === 0
                    ? "awaiting data…"
                    : `${workers.length} active`}
              </span>
            </div>
            {workers.length === 0 ? (
              <div style={{ color: "#4a5568", fontSize: "0.72rem", textAlign: "center", padding: "1.5rem 0" }}>
                {workerError
                  ? "Cannot reach API — is the backend running?"
                  : "No active workers in InfluxDB yet — send a metric first"}
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px,1fr))", gap: "0.75rem" }}>
                {workers.map(w => {
                  const sevColor  = SEV_COLOR[w.severity] || "#00ffc8";
                  const isBusy    = w.status === "Busy" || w.status === "Critical";
                  const statusBg  = w.status === "Critical" ? "rgba(255,77,109,0.12)"
                                  : isBusy                  ? "rgba(251,146,60,0.12)"
                                  :                           "rgba(0,255,200,0.08)";
                  const statusClr = w.status === "Critical" ? "#ff4d6d"
                                  : isBusy                  ? "#fb923c"
                                  :                           "#00ffc8";
                  return (
                    <div key={w.server_id} style={{ background: "rgba(255,255,255,0.02)", border: `1px solid ${sevColor}22`, borderRadius: 8, padding: "0.75rem" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                        <div>
                          <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "#e2e8f0" }}>{w.server_id}</div>
                          <div style={{ fontSize: "0.58rem", color: "#4a5568" }}>
                            {w.requests}/s · {w.latency}ms
                          </div>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                          <span style={{ background: statusBg, color: statusClr, border: `1px solid ${statusClr}44`, borderRadius: 4, padding: "1px 7px", fontSize: "0.58rem", fontWeight: 700 }}>{w.status}</span>
                          <span style={{ background: SEV_BG[w.severity], color: sevColor, border: `1px solid ${sevColor}44`, borderRadius: 4, padding: "1px 6px", fontSize: "0.55rem", fontWeight: 600 }}>{w.severity}</span>
                        </div>
                      </div>
                      <div style={{ fontSize: "0.6rem", color: "#4a5568", display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                        <span>CPU <span style={{ color: w.cpu > 80 ? "#ff4d6d" : "#e2e8f0" }}>{w.cpu}%</span></span>
                        <span>MEM <span style={{ color: w.memory > 80 ? "#fb923c" : "#e2e8f0" }}>{w.memory}%</span></span>
                        <span>Load <span style={{ color: w.predicted_load > 75 ? "#ff4d6d" : "#a78bfa" }}>{w.predicted_load}%</span></span>
                      </div>
                      <Bar value={w.cpu}    color={w.cpu    > 80 ? "#ff4d6d" : "#00ffc8"} />
                      <Bar value={w.memory} color={w.memory > 80 ? "#fb923c" : "#a78bfa"} />
                      {w.suggestion && w.suggestion !== "STEADY" && (
                        <div style={{ marginTop: 5, fontSize: "0.55rem", color: sevColor, opacity: 0.8 }}>→ {w.suggestion}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* TABS */}
          <div style={{ marginBottom: "0.75rem" }}>
            {[["live", "📡 Live Feed"], ["history", "🗄 DB History"], ["stats", "📊 Server Stats"]].map(([key, label]) => (
              <button key={key} style={S.tab(activeTab === key)} onClick={() => setActiveTab(key)}>{label}</button>
            ))}
          </div>

          {/* ── TAB: LIVE FEED ──────────────────────────────── */}
          {activeTab === "live" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: "1rem" }}>
              <div style={S.panel}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.6rem" }}>
                  <div style={S.sec}>Live Events (this session)</div>
                  <span style={{ fontSize: "0.6rem", color: "#4a5568" }}>{liveEvents.length} events</span>
                </div>
                <div style={{ maxHeight: 400, overflowY: "auto" }}>
                  {liveEvents.length === 0 && <div style={{ color: "#4a5568", fontSize: "0.72rem", textAlign: "center", padding: "2rem 0" }}>Send a metric to see events</div>}
                  {[...liveEvents].reverse().map(ev => (
                    <div key={ev.id}
                      onClick={() => setSelectedEvent(selectedEvent?.id === ev.id ? null : ev)}
                      style={{ background: selectedEvent?.id === ev.id ? SEV_BG[ev.severity] : "rgba(255,255,255,0.01)", border: `1px solid ${selectedEvent?.id === ev.id ? SEV_COLOR[ev.severity] + "44" : "rgba(255,255,255,0.04)"}`, borderRadius: 6, padding: "7px 10px", marginBottom: 4, cursor: "pointer", transition: "all 0.12s" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3 }}>
                        <Badge sev={ev.severity} />
                        <span style={{ fontSize: "0.72rem", fontWeight: 700, color: "#e2e8f0" }}>{ev.server_id}</span>
                        <span style={{ marginLeft: "auto", fontSize: "0.6rem", color: "#4a5568" }}>{ev.time}</span>
                        <span style={{ fontSize: "0.6rem", color: ev.stored ? "#00ffc8" : "#4a5568" }}>{ev.stored ? "✓ DB" : "✗ DB"}</span>
                      </div>
                      <div style={{ fontSize: "0.63rem", color: "#718096" }}>
                        CPU <span style={{ color: ev.cpu > 80 ? "#ff4d6d" : "#e2e8f0" }}>{ev.cpu}%</span>
                        {" · "}MEM <span style={{ color: ev.memory > 80 ? "#fb923c" : "#e2e8f0" }}>{ev.memory}%</span>
                        {" · "}Req <span style={{ color: "#e2e8f0" }}>{ev.requests}/s</span>
                        {" · "}Lat <span style={{ color: ev.latency > 200 ? "#ffd166" : "#e2e8f0" }}>{ev.latency}ms</span>
                      </div>
                      <div style={{ fontSize: "0.6rem", color: "#4a5568", marginTop: 2 }}>→ {ev.suggestion}</div>
                    </div>
                  ))}
                  <div ref={liveEndRef} />
                </div>
              </div>

              {/* INSPECTOR */}
              <div style={S.panel}>
                <div style={S.sec}>🔍 Inspector</div>
                {!selectedEvent
                  ? <div style={{ color: "#4a5568", fontSize: "0.7rem", textAlign: "center", padding: "2rem 0" }}>Click any event</div>
                  : <>
                    <Badge sev={selectedEvent.severity} />
                    <div style={{ fontSize: "0.62rem", color: "#a78bfa", margin: "8px 0", lineHeight: 1.5 }}>Scenario: {selectedEvent.scenario}</div>
                    {[["Server", selectedEvent.server_id], ["Time", selectedEvent.time], ["CPU", `${selectedEvent.cpu}%`], ["Memory", `${selectedEvent.memory}%`], ["Requests", `${selectedEvent.requests}/s`], ["Latency", `${selectedEvent.latency}ms`], ["Predicted Load", `${selectedEvent.predicted_load}%`], ["Action", selectedEvent.suggestion], ["Stored to DB", selectedEvent.stored ? "✓ Yes" : "✗ No"]].map(([k, v]) => (
                      <div key={k} style={S.row}><span>{k}</span><span style={{ color: "#e2e8f0", fontWeight: 600 }}>{v}</span></div>
                    ))}
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontSize: "0.6rem", color: "#4a5568", marginBottom: 3 }}>Predicted Load</div>
                      <Bar value={selectedEvent.predicted_load} color={selectedEvent.predicted_load > 75 ? "#ff4d6d" : "#00ffc8"} />
                    </div>
                  </>
                }
              </div>
            </div>
          )}

          {/* ── TAB: DB HISTORY ─────────────────────────────── */}
          {activeTab === "history" && (
            <div style={S.panel}>
              {/* Filters */}
              <div style={{ display: "flex", gap: 8, marginBottom: "0.75rem", flexWrap: "wrap", alignItems: "flex-end" }}>
                <div>
                  <div style={{ fontSize: "0.6rem", color: "#4a5568", marginBottom: 3 }}>Time Range</div>
                  <select value={historyRange} onChange={e => setHistoryRange(e.target.value)} style={{ ...S.input, width: 130 }}>
                    {TIME_RANGES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                </div>
                <div>
                  <div style={{ fontSize: "0.6rem", color: "#4a5568", marginBottom: 3 }}>Server ID</div>
                  <select value={historyFilter.server_id} onChange={e => setHistoryFilter(f => ({ ...f, server_id: e.target.value }))} style={{ ...S.input, width: 110 }}>
                    <option value="">All Servers</option>
                    {SERVERS.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <div style={{ fontSize: "0.6rem", color: "#4a5568", marginBottom: 3 }}>Severity</div>
                  <select value={historyFilter.severity} onChange={e => setHistoryFilter(f => ({ ...f, severity: e.target.value }))} style={{ ...S.input, width: 110 }}>
                    <option value="">All</option>
                    {["NORMAL","WARNING","HIGH","CRITICAL"].map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <button style={{ ...S.btn("0,255,200", false), width: "auto", padding: "6px 14px", marginBottom: 0 }} onClick={loadHistory}>
                  {historyLoading ? "Loading…" : "🔍 Query DB"}
                </button>
                <span style={{ fontSize: "0.65rem", color: "#4a5568", alignSelf: "center" }}>{historyRows.length} rows from InfluxDB</span>
              </div>

              {/* Table */}
              <div style={{ maxHeight: 420, overflowY: "auto" }}>
                {historyRows.length === 0 && !historyLoading && (
                  <div style={{ color: "#4a5568", fontSize: "0.72rem", textAlign: "center", padding: "2rem 0" }}>
                    {dbStatus === "connected" ? "No data for this range — send some metrics first" : "InfluxDB offline — start Docker"}
                  </div>
                )}
                {historyRows.map((r, i) => (
                  <div key={i} style={{ background: "rgba(255,255,255,0.01)", border: "1px solid rgba(255,255,255,0.04)", borderRadius: 6, padding: "7px 10px", marginBottom: 3 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 2 }}>
                      <Badge sev={r.severity || "NORMAL"} />
                      <span style={{ fontSize: "0.7rem", fontWeight: 700, color: "#e2e8f0" }}>{r.server_id}</span>
                      <span style={{ marginLeft: "auto", fontSize: "0.58rem", color: "#4a5568" }}>
                      {r.timestamp
  ? new Date(r.timestamp).toLocaleString("en-GB", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    })
  : "—"}
                      </span>
                    </div>
                    <div style={{ fontSize: "0.62rem", color: "#718096" }}>
                      CPU <span style={{ color: r.cpu > 80 ? "#ff4d6d" : "#e2e8f0" }}>{Math.round(r.cpu)}%</span>
                      {" · "}MEM <span style={{ color: r.memory > 80 ? "#fb923c" : "#e2e8f0" }}>{Math.round(r.memory)}%</span>
                      {" · "}Req <span style={{ color: "#e2e8f0" }}>{r.requests}/s</span>
                      {" · "}Lat <span style={{ color: r.latency > 200 ? "#ffd166" : "#e2e8f0" }}>{Math.round(r.latency)}ms</span>
                      {" · "}Load <span style={{ color: "#a78bfa" }}>{Math.round(r.predicted_load * 100)}%</span>
                      {r.suggestion && <span style={{ color: "#4a5568" }}>{" · "}{r.suggestion}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── TAB: STATS ──────────────────────────────────── */}
          {activeTab === "stats" && (
            <div style={S.panel}>
              <div style={{ display: "flex", gap: 8, marginBottom: "0.75rem", alignItems: "center" }}>
                <select value={historyRange} onChange={e => setHistoryRange(e.target.value)} style={{ ...S.input, width: 140 }}>
                  {TIME_RANGES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
                <button style={{ ...S.btn("0,255,200", false), width: "auto", padding: "6px 14px", marginBottom: 0 }} onClick={loadStats}>📊 Refresh Stats</button>
              </div>
              {Object.keys(dbStats).length === 0
                ? <div style={{ color: "#4a5568", fontSize: "0.72rem", textAlign: "center", padding: "2rem 0" }}>No stats — send metrics and click Refresh</div>
                : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px,1fr))", gap: "0.75rem" }}>
                    {Object.entries(dbStats).map(([server, s]) => (
                      <div key={server} style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 10, padding: "0.9rem" }}>
                        <div style={{ fontSize: "0.78rem", fontWeight: 700, color: "#e2e8f0", marginBottom: 8 }}>{server}</div>
                        {[["Avg CPU",     `${s.avg_cpu?.toFixed(1) ?? "—"}%`,     "#ff6b6b"],
                          ["Avg Memory",  `${s.avg_memory?.toFixed(1) ?? "—"}%`,  "#a78bfa"],
                          ["Avg Requests",`${s.avg_requests?.toFixed(0) ?? "—"}/s`,"#38bdf8"],
                          ["Avg Latency", `${s.avg_latency?.toFixed(0) ?? "—"}ms`,"#fb923c"],
                          ["Avg Load",    `${((s.avg_predicted_load ?? 0) * 100).toFixed(1)}%`,"#00ffc8"],
                        ].map(([label, val, color]) => (
                          <div key={label} style={{ ...S.row }}>
                            <span>{label}</span>
                            <span style={{ color, fontWeight: 600 }}>{val}</span>
                          </div>
                        ))}
                        {s.total_events && <div style={{ marginTop: 6, fontSize: "0.6rem", color: "#4a5568" }}>{s.total_events} total events recorded</div>}
                      </div>
                    ))}
                  </div>
                )
              }
            </div>
          )}
        </div>
      </div>
    </div>
  );
}