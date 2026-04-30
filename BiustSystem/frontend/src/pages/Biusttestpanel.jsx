import { useState, useEffect, useRef, useCallback } from "react";

const API_BASE = "http://127.0.0.1:8000";
const SERVERS  = ["node-1", "node-2", "node-3", "node-4", "node-5"];

// Local scenario definitions (mirrors API) — used for UI labels & burst UI only.
// Actual ranges shown on the dashboard come from the API after selection.
const SCENARIO_META = {
  normal:   { label: "Normal Load",        emoji: "🟢", desc: "Typical weekday traffic" },
  peak:     { label: "BIUST Peak Hours",   emoji: "🟡", desc: "Morning & afternoon rush" },
  critical: { label: "Registration Spike", emoji: "🔴", desc: "Portal overload" },
  low:      { label: "Off-Peak",           emoji: "🔵", desc: "Night / weekend" },
};

const PIPELINE_STEPS = ["Client", "FastAPI", "Kafka", "Consumer", "Celery Worker", "InfluxDB ✓"];

const SEV_COLOR = {
  NORMAL:   "#00ffc8",
  WARNING:  "#ffd166",
  HIGH:     "#fb923c",
  CRITICAL: "#ff4d6d",
};
const SEV_BG = {
  NORMAL:   "rgba(0,255,200,0.08)",
  WARNING:  "rgba(255,209,102,0.08)",
  HIGH:     "rgba(251,146,60,0.08)",
  CRITICAL: "rgba(255,77,109,0.12)",
};

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function nowTs()        { return new Date().toLocaleTimeString(); }

function generateMetricFromRanges(ranges, serverId) {
  const v = (key) => rand(ranges[key][0], ranges[key][1]);
  return {
    server_id: serverId || SERVERS[rand(0, SERVERS.length - 1)],
    cpu:       v("cpu"),
    memory:    v("memory"),
    requests:  v("requests"),
    latency:   v("latency"),
  };
}

// ── Mini components ────────────────────────────────────────────
function Bar({ value, max = 100, color }) {
  return (
    <div style={{ height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden", marginTop: 3 }}>
      <div style={{
        width: `${Math.min((value / max) * 100, 100)}%`,
        height: "100%", background: color, borderRadius: 2,
        transition: "width 0.5s", boxShadow: `0 0 5px ${color}`,
      }} />
    </div>
  );
}

function Badge({ sev }) {
  return (
    <span style={{
      background: SEV_BG[sev], border: `1px solid ${SEV_COLOR[sev]}55`,
      color: SEV_COLOR[sev], borderRadius: 4, padding: "1px 7px",
      fontSize: "0.6rem", fontWeight: 700,
    }}>
      {sev}
    </span>
  );
}

function RangeChip({ label, range, color }) {
  return (
    <div style={{
      background: "rgba(255,255,255,0.03)",
      border: `1px solid ${color}33`,
      borderRadius: 6, padding: "4px 10px",
      display: "flex", flexDirection: "column", alignItems: "center",
    }}>
      <span style={{ fontSize: "0.55rem", color: "#4a5568", textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</span>
      <span style={{ fontSize: "0.72rem", fontWeight: 700, color }}>
        {range[0]}–{range[1]}
      </span>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
export default function BiustTestPanel() {
  // ── Scenario state (driven by API) ──────────────────────────
  const [scenario,        setScenarioLocal] = useState("normal");
  const [apiRanges,       setApiRanges]     = useState(null);   // from GET /simulator/scenario
  const [burstActive,     setBurstActive]   = useState(false);
  const [scenarioLoading, setScenarioLoading] = useState(false);

  // ── Control state ────────────────────────────────────────────
  const [autoSend,     setAutoSend]     = useState(false);
  const [autoInterval, setAutoInterval] = useState(2000);
  const [apiStatus,    setApiStatus]    = useState("checking");
  const [dbStatus,     setDbStatus]     = useState("checking");

  // ── Live feed ────────────────────────────────────────────────
  const [liveEvents, setLiveEvents] = useState([]);
  const [stats,      setStats]      = useState({ sent: 0, processed: 0, alerts: 0, scaled: 0 });

  // ── Workers (from /workers/status) ──────────────────────────
  const [workers,     setWorkers]     = useState([]);
  const [workerError, setWorkerError] = useState(false);

  // ── History / Stats tabs ─────────────────────────────────────
  const [historyRows,    setHistoryRows]    = useState([]);
  const [historyRange,   setHistoryRange]   = useState("-1h");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyFilter,  setHistoryFilter]  = useState({ server_id: "", severity: "" });
  const [dbStats,        setDbStats]        = useState({});

  // ── Scaling events ───────────────────────────────────────────
  const [scalingEvents, setScalingEvents] = useState([]);

  // ── Pipeline animation ───────────────────────────────────────
  const [pipeline,      setPipeline]      = useState({ step: -1, active: false });
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [activeTab,     setActiveTab]     = useState("live");

  const timerRef   = useRef(null);
  const liveEndRef = useRef(null);

  // ── On mount: fetch current scenario from API ─────────────────
  useEffect(() => {
    fetch(`${API_BASE}/health`)
      .then(r => r.json())
      .then(d => {
        setApiStatus(d.status === "healthy" ? "online" : "degraded");
        setDbStatus(d.influxdb_connected ? "connected" : "offline");
      })
      .catch(() => { setApiStatus("offline"); setDbStatus("unknown"); });

    fetch(`${API_BASE}/simulator/scenario`)
      .then(r => r.json())
      .then(d => {
        setScenarioLocal(d.scenario || "normal");
        setApiRanges(d.ranges || null);
        setBurstActive(d.burst_active || false);
      })
      .catch(() => {});
  }, []);

  // Auto-scroll live feed
  useEffect(() => { liveEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [liveEvents]);

  // Poll workers + scaling events every 5 s
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const [wRes, sRes] = await Promise.all([
          fetch(`${API_BASE}/workers/status`),
          fetch(`${API_BASE}/scaling/events`),
        ]);
        const wData = await wRes.json();
        const sData = await sRes.json();
        if (!cancelled) {
          setWorkers(wData.workers || []);
          setWorkerError(false);
          setScalingEvents((sData.events || []).slice().reverse());
        }
      } catch {
        if (!cancelled) setWorkerError(true);
      }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Pipeline animation helper
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

  // ── Set scenario via API ──────────────────────────────────────
  const applyScenario = useCallback(async (sc, burstSeconds = 0) => {
    setScenarioLoading(true);
    try {
      const res = await fetch(`${API_BASE}/simulator/scenario`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: sc, burst_seconds: burstSeconds }),
      });
      const data = await res.json();
      setScenarioLocal(sc);
      setApiRanges(data.ranges || null);
      setBurstActive(burstSeconds > 0);
      setApiStatus("online");

      // Refresh scenario state after burst_seconds to reset burst indicator
      if (burstSeconds > 0) {
        setTimeout(async () => {
          try {
            const r2 = await fetch(`${API_BASE}/simulator/scenario`);
            const d2 = await r2.json();
            setBurstActive(d2.burst_active || false);
          } catch {}
        }, (burstSeconds + 1) * 1000);
      }
    } catch {
      setApiStatus("offline");
    } finally {
      setScenarioLoading(false);
    }
  }, []);

  // ── Send a single metric ──────────────────────────────────────
  const sendMetric = useCallback(async (overrideScenario) => {
    const sc = overrideScenario || scenario;

    // Use API ranges if available, otherwise local fallback
    const ranges = apiRanges || {
      cpu: [20, 55], memory: [30, 60], requests: [80, 200], latency: [30, 100],
    };
    const raw = {
      ...generateMetricFromRanges(ranges),
      scenario: sc,
    };

    animatePipeline();
    let result = null;
    try {
      const res = await fetch(`${API_BASE}/metrics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(raw),
      });
      result = await res.json();
      setApiStatus("online");
      setDbStatus(result.influxdb_write ? "connected" : "offline");
    } catch {
      setApiStatus("offline");
    }

    const pred  = result?.prediction || {};
    const sev   = pred.severity   || "NORMAL";
    const sugg  = pred.suggestion || "STEADY";
    const pload = pred.predicted_load != null
      ? Math.round(pred.predicted_load * 100) : 0;

    setStats(prev => ({
      sent:      prev.sent + 1,
      processed: prev.processed + 1,
      alerts:    prev.alerts + (sev !== "NORMAL" ? 1 : 0),
      scaled:    prev.scaled + (sugg.includes("ADD") || sugg.includes("REMOVE") ? 1 : 0),
    }));

    const event = {
      id:             Date.now() + Math.random(),
      time:           nowTs(),
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
      model_type:     pred.model_type || "Heuristic",
    };
    setLiveEvents(prev => [...prev.slice(-99), event]);
  }, [scenario, apiRanges, animatePipeline]);

  // ── Auto-send loop ────────────────────────────────────────────
  useEffect(() => {
    clearInterval(timerRef.current);
    if (autoSend) timerRef.current = setInterval(() => sendMetric(), autoInterval);
    return () => clearInterval(timerRef.current);
  }, [autoSend, autoInterval, sendMetric]);

  // ── Burst: 5 rapid metrics with critical overide ──────────────
  const burst = async () => {
    // Tell the simulator to go critical for 15 s
    await applyScenario(scenario, 15);
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, i * 280));
      sendMetric("critical");
    }
  };

  // ── History ───────────────────────────────────────────────────
  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
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

  const loadStats = useCallback(async () => {
    try {
      const res  = await fetch(`${API_BASE}/metrics/stats?range=${historyRange}`);
      const data = await res.json();
      setDbStats(data.stats || {});
    } catch {}
  }, [historyRange]);

  useEffect(() => {
    if (activeTab === "history") loadHistory();
    if (activeTab === "stats")   loadStats();
    if (activeTab === "scaling") {}
  }, [activeTab, loadHistory, loadStats]);

  const clearDB = async () => {
    if (!window.confirm("Delete ALL metrics from InfluxDB?")) return;
    await fetch(`${API_BASE}/metrics/clear`, { method: "DELETE" });
    setHistoryRows([]); setDbStats({});
  };

  // ── Styles ────────────────────────────────────────────────────
  const S = {
    root:  { fontFamily: "'JetBrains Mono','Fira Code',monospace", background: "#070b14", color: "#e2e8f0", minHeight: "100vh", paddingBottom: "2rem" },
    hdr:   { background: "rgba(13,18,32,0.97)", borderBottom: "1px solid rgba(0,255,200,0.12)", padding: "0.9rem 1.5rem", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.75rem" },
    body:  { display: "grid", gridTemplateColumns: "310px 1fr", gap: "1rem", padding: "1rem 1.5rem", maxWidth: 1500, margin: "0 auto" },
    panel: { background: "rgba(13,18,32,0.85)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: "1rem" },
    sec:   { fontSize: "0.65rem", textTransform: "uppercase", letterSpacing: "0.12em", color: "#4a5568", marginBottom: "0.6rem", fontWeight: 700 },
    pill:  (ok) => ({ display: "inline-flex", alignItems: "center", gap: 5, background: ok ? "rgba(0,255,200,0.08)" : "rgba(255,77,109,0.08)", border: `1px solid ${ok ? "rgba(0,255,200,0.25)" : "rgba(255,77,109,0.25)"}`, color: ok ? "#00ffc8" : "#ff4d6d", borderRadius: 6, padding: "3px 10px", fontSize: "0.68rem", fontWeight: 600 }),
    dot:   (ok) => ({ width: 6, height: 6, borderRadius: "50%", background: ok ? "#00ffc8" : "#ff4d6d" }),
    btn:   (c, active) => ({ background: active ? `rgba(${c},0.2)` : `rgba(${c},0.06)`, border: `1px solid rgba(${c},${active ? "0.45" : "0.2"})`, color: `rgb(${c})`, borderRadius: 7, padding: "7px 12px", fontSize: "0.74rem", cursor: "pointer", fontFamily: "inherit", fontWeight: 600, width: "100%", marginBottom: 6, transition: "all 0.15s" }),
    tab:   (active) => ({ background: active ? "rgba(0,255,200,0.12)" : "transparent", border: `1px solid ${active ? "rgba(0,255,200,0.3)" : "rgba(255,255,255,0.06)"}`, color: active ? "#00ffc8" : "#718096", borderRadius: 7, padding: "6px 14px", fontSize: "0.72rem", cursor: "pointer", fontFamily: "inherit", fontWeight: 600, marginRight: 6, transition: "all 0.15s" }),
    row:   { display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid rgba(255,255,255,0.04)", fontSize: "0.68rem", color: "#718096" },
    input: { background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "5px 8px", color: "#e2e8f0", fontFamily: "inherit", fontSize: "0.7rem", width: "100%" },
  };

  const TIME_RANGES = [
    { label: "Last 15 min", value: "-15m" },
    { label: "Last 1 hr",   value: "-1h"  },
    { label: "Last 6 hrs",  value: "-6h"  },
    { label: "Last 24 hrs", value: "-24h" },
    { label: "Last 7 days", value: "-7d"  },
  ];

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div style={S.root}>

      {/* ── HEADER ─────────────────────────────────────────────── */}
      <header style={S.hdr}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <span style={{ fontSize: "1.6rem", color: "#00ffc8", filter: "drop-shadow(0 0 8px rgba(0,255,200,0.5))" }}>◈</span>
          <div>
            <div style={{ fontSize: "1rem", fontWeight: 700, color: "#fff" }}>BIUST Test Panel</div>
            <div style={{ fontSize: "0.6rem", color: "#4a5568", textTransform: "uppercase", letterSpacing: "0.1em" }}>
              Pipeline Monitor · InfluxDB · AI Auto-Scaling
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {[["0,255,200", `Sent: ${stats.sent}`], ["56,189,248", `Stored: ${stats.processed}`],
            ["251,146,60", `Alerts: ${stats.alerts}`], ["167,139,250", `Scaled: ${stats.scaled}`]].map(([c, label]) => (
            <span key={label} style={{ background: `rgba(${c},0.1)`, border: `1px solid rgba(${c},0.25)`, color: `rgb(${c})`, borderRadius: 6, padding: "3px 11px", fontSize: "0.68rem" }}>{label}</span>
          ))}
          <span style={S.pill(apiStatus === "online")}><span style={S.dot(apiStatus === "online")} /> API {apiStatus}</span>
          <span style={S.pill(dbStatus === "connected")}><span style={S.dot(dbStatus === "connected")} /> DB {dbStatus}</span>
        </div>
      </header>

      <div style={S.body}>
        {/* ── LEFT SIDEBAR ──────────────────────────────────────── */}
        <div>

          {/* SCENARIO SELECTOR */}
          <div style={{ ...S.panel, marginBottom: "1rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.6rem" }}>
              <div style={S.sec}>📡 Scenario</div>
              {burstActive && (
                <span style={{ fontSize: "0.6rem", color: "#ff4d6d", fontWeight: 700, animation: "pulse 1s infinite" }}>
                  🔴 BURST ACTIVE
                </span>
              )}
              {scenarioLoading && (
                <span style={{ fontSize: "0.6rem", color: "#ffd166" }}>updating…</span>
              )}
            </div>

            {Object.entries(SCENARIO_META).map(([k, meta]) => {
              const active = scenario === k;
              return (
                <button
                  key={k}
                  disabled={scenarioLoading}
                  onClick={() => applyScenario(k)}
                  style={{
                    background: active ? "rgba(0,255,200,0.1)" : "rgba(255,255,255,0.02)",
                    border: `1px solid ${active ? "rgba(0,255,200,0.4)" : "rgba(255,255,255,0.06)"}`,
                    color: active ? "#00ffc8" : "#718096",
                    borderRadius: 8, padding: "8px 12px",
                    fontSize: "0.72rem", cursor: scenarioLoading ? "not-allowed" : "pointer",
                    fontFamily: "inherit", fontWeight: active ? 700 : 400,
                    transition: "all 0.15s", textAlign: "left",
                    width: "100%", marginBottom: 5,
                    opacity: scenarioLoading ? 0.6 : 1,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span>{meta.emoji}</span>
                    <span style={{ fontWeight: 700 }}>{active ? "▶ " : ""}{meta.label}</span>
                  </div>
                  <div style={{ fontSize: "0.58rem", color: "#4a5568", marginTop: 2 }}>{meta.desc}</div>
                </button>
              );
            })}

            {/* Active range preview — from API */}
            {apiRanges && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: "0.6rem", color: "#4a5568", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                  Active ranges
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                  <RangeChip label="CPU %"    range={apiRanges.cpu}      color="#ff6b6b" />
                  <RangeChip label="MEM %"    range={apiRanges.memory}   color="#a78bfa" />
                  <RangeChip label="Req/s"    range={apiRanges.requests}  color="#38bdf8" />
                  <RangeChip label="Latency ms" range={apiRanges.latency} color="#fb923c" />
                </div>
              </div>
            )}
          </div>

          {/* CONTROLS */}
          <div style={{ ...S.panel, marginBottom: "1rem" }}>
            <div style={S.sec}>⚡ Controls</div>
            <button style={S.btn("0,255,200", false)}  onClick={() => sendMetric()}>▶ Send Single Metric</button>
            <button style={S.btn("251,146,60", false)} onClick={burst}>
              ⚡ Burst × 5 {burstActive ? "(active)" : ""}
            </button>
            <button style={S.btn("255,77,109", false)} onClick={() => applyScenario("critical").then(() => {
              for (let i = 0; i < 5; i++) setTimeout(() => sendMetric("critical"), i * 280);
            })}>
              🔴 Force Critical Spike
            </button>
            <button style={S.btn("167,139,250", autoSend)} onClick={() => setAutoSend(v => !v)}>
              {autoSend ? "⏹ Stop Auto-Send" : "🔄 Start Auto-Send"}
            </button>
            {autoSend && (
              <div style={{ marginBottom: 6 }}>
                <div style={{ fontSize: "0.6rem", color: "#4a5568", marginBottom: 3 }}>Every {autoInterval / 1000}s</div>
                <input type="range" min={500} max={5000} step={500} value={autoInterval}
                  onChange={e => setAutoInterval(+e.target.value)}
                  style={{ width: "100%", accentColor: "#00ffc8" }} />
              </div>
            )}
            <button style={S.btn("100,116,139", false)} onClick={() => { setLiveEvents([]); setStats({ sent: 0, processed: 0, alerts: 0, scaled: 0 }); }}>
              🗑 Clear Live Feed
            </button>
            <button style={S.btn("255,77,109", false)} onClick={clearDB}>🗑 Clear InfluxDB</button>
          </div>

          {/* PIPELINE */}
          <div style={S.panel}>
            <div style={S.sec}>🔁 Pipeline</div>
            {PIPELINE_STEPS.map((step, i) => {
              const isActive = pipeline.step === i;
              const done     = pipeline.step > i;
              return (
                <div key={step} style={{
                  display: "flex", alignItems: "center", gap: 7,
                  padding: "5px 8px", borderRadius: 6, marginBottom: 3,
                  background: isActive ? "rgba(0,255,200,0.1)" : done ? "rgba(0,255,200,0.04)" : "rgba(255,255,255,0.02)",
                  border: `1px solid ${isActive ? "rgba(0,255,200,0.35)" : done ? "rgba(0,255,200,0.12)" : "rgba(255,255,255,0.05)"}`,
                  transition: "all 0.2s",
                }}>
                  <div style={{ width: 7, height: 7, borderRadius: "50%", background: isActive ? "#00ffc8" : done ? "#00ffc8" : "#2d3748", boxShadow: isActive ? "0 0 8px #00ffc8" : "none", flexShrink: 0, transition: "all 0.2s" }} />
                  <span style={{ fontSize: "0.7rem", color: isActive ? "#00ffc8" : done ? "#00ffc8aa" : "#4a5568", fontWeight: isActive ? 700 : 400 }}>{step}</span>
                  {done    && <span style={{ marginLeft: "auto", fontSize: "0.58rem", color: "#00ffc8aa" }}>✓</span>}
                  {isActive && <span style={{ marginLeft: "auto", fontSize: "0.58rem", color: "#00ffc8" }}>●</span>}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── RIGHT MAIN ─────────────────────────────────────────── */}
        <div>

          {/* WORKER NODES */}
          <div style={{ ...S.panel, marginBottom: "1rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: "0.75rem" }}>
              <div style={{ ...S.sec, marginBottom: 0 }}>🖥 Worker Nodes</div>
              <span style={{ fontSize: "0.6rem", color: "#4a5568", marginLeft: "auto" }}>
                {workerError ? "⚠ polling failed" : workers.length === 0 ? "awaiting data…" : `${workers.length} nodes`}
              </span>
            </div>

            {workers.length === 0 ? (
              <div style={{ color: "#4a5568", fontSize: "0.72rem", textAlign: "center", padding: "1.5rem 0" }}>
                {workerError ? "Cannot reach API — is the backend running?" : "No active workers — send a metric first"}
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px,1fr))", gap: "0.75rem" }}>
                {workers.map(w => {
                  const sevColor = SEV_COLOR[w.severity] || "#00ffc8";
                  const isStandby = w.status === "Standby";
                  const statusClr = w.status === "Critical" ? "#ff4d6d"
                                  : w.status === "Busy"     ? "#fb923c"
                                  : isStandby               ? "#4a5568"
                                  :                           "#00ffc8";
                  const statusBg = w.status === "Critical" ? "rgba(255,77,109,0.12)"
                                 : w.status === "Busy"     ? "rgba(251,146,60,0.12)"
                                 : isStandby               ? "rgba(255,255,255,0.04)"
                                 :                           "rgba(0,255,200,0.08)";
                  return (
                    <div key={w.server_id} style={{
                      background: "rgba(255,255,255,0.02)",
                      border: `1px solid ${sevColor}22`,
                      borderRadius: 8, padding: "0.75rem",
                      opacity: isStandby ? 0.6 : 1,
                    }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                        <div>
                          <div style={{ fontSize: "0.7rem", fontWeight: 700, color: "#e2e8f0" }}>{w.server_id}</div>
                          <div style={{ fontSize: "0.58rem", color: "#4a5568" }}>{w.requests}/s · {w.latency}ms</div>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                          <span style={{ background: statusBg, color: statusClr, border: `1px solid ${statusClr}44`, borderRadius: 4, padding: "1px 7px", fontSize: "0.58rem", fontWeight: 700 }}>{w.status}</span>
                          {!isStandby && <span style={{ background: SEV_BG[w.severity], color: sevColor, border: `1px solid ${sevColor}44`, borderRadius: 4, padding: "1px 6px", fontSize: "0.55rem", fontWeight: 600 }}>{w.severity}</span>}
                        </div>
                      </div>
                      {!isStandby && (
                        <>
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
                        </>
                      )}
                      {isStandby && (
                        <div style={{ fontSize: "0.62rem", color: "#4a5568", textAlign: "center", paddingTop: 4 }}>
                          Spawned by orchestrator · waiting for load
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* TABS */}
          <div style={{ marginBottom: "0.75rem" }}>
            {[["live", "📡 Live Feed"], ["history", "🗄 DB History"],
              ["stats", "📊 Server Stats"], ["scaling", "⚖ Scaling Events"]].map(([key, label]) => (
              <button key={key} style={S.tab(activeTab === key)} onClick={() => setActiveTab(key)}>{label}</button>
            ))}
          </div>

          {/* ── LIVE FEED ──────────────────────────────────────── */}
          {activeTab === "live" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 310px", gap: "1rem" }}>
              <div style={S.panel}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.6rem" }}>
                  <div style={S.sec}>Live Events (this session)</div>
                  <span style={{ fontSize: "0.6rem", color: "#4a5568" }}>{liveEvents.length} events</span>
                </div>
                <div style={{ maxHeight: 420, overflowY: "auto" }}>
                  {liveEvents.length === 0 && <div style={{ color: "#4a5568", fontSize: "0.72rem", textAlign: "center", padding: "2rem 0" }}>Send a metric to see events</div>}
                  {[...liveEvents].reverse().map(ev => (
                    <div key={ev.id}
                      onClick={() => setSelectedEvent(selectedEvent?.id === ev.id ? null : ev)}
                      style={{
                        background: selectedEvent?.id === ev.id ? SEV_BG[ev.severity] : "rgba(255,255,255,0.01)",
                        border: `1px solid ${selectedEvent?.id === ev.id ? SEV_COLOR[ev.severity] + "44" : "rgba(255,255,255,0.04)"}`,
                        borderRadius: 6, padding: "7px 10px", marginBottom: 4, cursor: "pointer", transition: "all 0.12s",
                      }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3 }}>
                        <Badge sev={ev.severity} />
                        <span style={{ fontSize: "0.72rem", fontWeight: 700, color: "#e2e8f0" }}>{ev.server_id}</span>
                        <span style={{ fontSize: "0.6rem", color: "#a78bfa", marginLeft: 4 }}>{ev.model_type?.includes("Random") ? "🧠 RF" : "⚡ Heuristic"}</span>
                        <span style={{ marginLeft: "auto", fontSize: "0.6rem", color: "#4a5568" }}>{ev.time}</span>
                        <span style={{ fontSize: "0.6rem", color: ev.stored ? "#00ffc8" : "#4a5568" }}>{ev.stored ? "✓ DB" : "✗ DB"}</span>
                      </div>
                      <div style={{ fontSize: "0.63rem", color: "#718096" }}>
                        CPU <span style={{ color: ev.cpu > 80 ? "#ff4d6d" : "#e2e8f0" }}>{ev.cpu}%</span>
                        {" · "}MEM <span style={{ color: ev.memory > 80 ? "#fb923c" : "#e2e8f0" }}>{ev.memory}%</span>
                        {" · "}Req <span style={{ color: "#e2e8f0" }}>{ev.requests}/s</span>
                        {" · "}Lat <span style={{ color: ev.latency > 200 ? "#ffd166" : "#e2e8f0" }}>{ev.latency}ms</span>
                        {" · "}Load <span style={{ color: ev.predicted_load > 75 ? "#ff4d6d" : "#a78bfa" }}>{ev.predicted_load}%</span>
                      </div>
                      {ev.suggestion !== "STEADY" && (
                        <div style={{ fontSize: "0.6rem", color: SEV_COLOR[ev.severity], marginTop: 2 }}>→ {ev.suggestion}</div>
                      )}
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
                  : (
                    <>
                      <Badge sev={selectedEvent.severity} />
                      <div style={{ fontSize: "0.62rem", color: "#a78bfa", margin: "8px 0", lineHeight: 1.5 }}>
                        Scenario: {selectedEvent.scenario} · {selectedEvent.model_type}
                      </div>
                      {[["Server", selectedEvent.server_id], ["Time", selectedEvent.time],
                        ["CPU", `${selectedEvent.cpu}%`], ["Memory", `${selectedEvent.memory}%`],
                        ["Requests", `${selectedEvent.requests}/s`], ["Latency", `${selectedEvent.latency}ms`],
                        ["Predicted Load", `${selectedEvent.predicted_load}%`],
                        ["Action", selectedEvent.suggestion],
                        ["Stored to DB", selectedEvent.stored ? "✓ Yes" : "✗ No"],
                      ].map(([k, v]) => (
                        <div key={k} style={S.row}><span>{k}</span><span style={{ color: "#e2e8f0", fontWeight: 600 }}>{v}</span></div>
                      ))}
                      <div style={{ marginTop: 10 }}>
                        <div style={{ fontSize: "0.6rem", color: "#4a5568", marginBottom: 3 }}>Predicted Load</div>
                        <Bar value={selectedEvent.predicted_load} color={selectedEvent.predicted_load > 75 ? "#ff4d6d" : "#00ffc8"} />
                      </div>
                    </>
                  )}
              </div>
            </div>
          )}

          {/* ── DB HISTORY ─────────────────────────────────────── */}
          {activeTab === "history" && (
            <div style={S.panel}>
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
                <span style={{ fontSize: "0.65rem", color: "#4a5568", alignSelf: "center" }}>{historyRows.length} rows</span>
              </div>
              <div style={{ maxHeight: 420, overflowY: "auto" }}>
                {historyRows.length === 0 && !historyLoading && (
                  <div style={{ color: "#4a5568", fontSize: "0.72rem", textAlign: "center", padding: "2rem 0" }}>
                    {dbStatus === "connected" ? "No data for this range" : "InfluxDB offline — start Docker"}
                  </div>
                )}
                {historyRows.map((r, i) => (
                  <div key={i} style={{ background: "rgba(255,255,255,0.01)", border: "1px solid rgba(255,255,255,0.04)", borderRadius: 6, padding: "7px 10px", marginBottom: 3 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 2 }}>
                      <Badge sev={r.severity || "NORMAL"} />
                      <span style={{ fontSize: "0.7rem", fontWeight: 700, color: "#e2e8f0" }}>{r.server_id}</span>
                      <span style={{ marginLeft: "auto", fontSize: "0.58rem", color: "#4a5568" }}>
                        {r.timestamp ? new Date(r.timestamp).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"}
                      </span>
                    </div>
                    <div style={{ fontSize: "0.62rem", color: "#718096" }}>
                      CPU <span style={{ color: r.cpu > 80 ? "#ff4d6d" : "#e2e8f0" }}>{Math.round(r.cpu)}%</span>
                      {" · "}MEM <span style={{ color: r.memory > 80 ? "#fb923c" : "#e2e8f0" }}>{Math.round(r.memory)}%</span>
                      {" · "}Req <span style={{ color: "#e2e8f0" }}>{r.requests}/s</span>
                      {" · "}Lat <span style={{ color: r.latency > 200 ? "#ffd166" : "#e2e8f0" }}>{Math.round(r.latency)}ms</span>
                      {" · "}Load <span style={{ color: "#a78bfa" }}>{Math.round(r.predicted_load * 100)}%</span>
                      {r.suggestion && r.suggestion !== "STEADY" && <span style={{ color: "#4a5568" }}>{" · "}{r.suggestion}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── STATS ─────────────────────────────────────────── */}
          {activeTab === "stats" && (
            <div style={S.panel}>
              <div style={{ display: "flex", gap: 8, marginBottom: "0.75rem", alignItems: "center" }}>
                <select value={historyRange} onChange={e => setHistoryRange(e.target.value)} style={{ ...S.input, width: 140 }}>
                  {TIME_RANGES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
                <button style={{ ...S.btn("0,255,200", false), width: "auto", padding: "6px 14px", marginBottom: 0 }} onClick={loadStats}>📊 Refresh</button>
              </div>
              {Object.keys(dbStats).length === 0
                ? <div style={{ color: "#4a5568", fontSize: "0.72rem", textAlign: "center", padding: "2rem 0" }}>No stats — send metrics and click Refresh</div>
                : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px,1fr))", gap: "0.75rem" }}>
                    {Object.entries(dbStats).map(([server, s]) => (
                      <div key={server} style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 10, padding: "0.9rem" }}>
                        <div style={{ fontSize: "0.78rem", fontWeight: 700, color: "#e2e8f0", marginBottom: 8 }}>{server}</div>
                        {[["Avg CPU",      `${s.avg_cpu?.toFixed(1) ?? "—"}%`,                                "#ff6b6b"],
                          ["Avg Memory",   `${s.avg_memory?.toFixed(1) ?? "—"}%`,                             "#a78bfa"],
                          ["Avg Requests", `${s.avg_requests?.toFixed(0) ?? "—"}/s`,                          "#38bdf8"],
                          ["Avg Latency",  `${s.avg_latency?.toFixed(0) ?? "—"}ms`,                           "#fb923c"],
                          ["Avg Load",     `${((s.avg_predicted_load ?? 0) * 100).toFixed(1)}%`,              "#00ffc8"],
                        ].map(([label, val, color]) => (
                          <div key={label} style={S.row}>
                            <span>{label}</span>
                            <span style={{ color, fontWeight: 600 }}>{val}</span>
                          </div>
                        ))}
                        {s.total_events && <div style={{ marginTop: 6, fontSize: "0.6rem", color: "#4a5568" }}>{s.total_events} events recorded</div>}
                      </div>
                    ))}
                  </div>
                )}
            </div>
          )}

          {/* ── SCALING EVENTS ─────────────────────────────────── */}
          {activeTab === "scaling" && (
            <div style={S.panel}>
              <div style={{ ...S.sec, marginBottom: "0.75rem" }}>⚖ Orchestrator Scaling Events</div>
              {scalingEvents.length === 0
                ? <div style={{ color: "#4a5568", fontSize: "0.72rem", textAlign: "center", padding: "2rem 0" }}>
                    No scaling events yet — run orchestrator.py and trigger high load
                  </div>
                : (
                  <div style={{ maxHeight: 420, overflowY: "auto" }}>
                    {scalingEvents.map((ev, i) => {
                      const isUp    = ev.message?.includes("UP");
                      const isCrit  = ev.message?.includes("EMERGENCY");
                      const clr     = isCrit ? "#ff4d6d" : isUp ? "#fb923c" : "#00ffc8";
                      return (
                        <div key={i} style={{ background: `${clr}08`, border: `1px solid ${clr}22`, borderRadius: 6, padding: "8px 12px", marginBottom: 4 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                            <span style={{ fontSize: "0.6rem", color: clr, fontWeight: 700 }}>
                              {isCrit ? "🔴 EMERGENCY" : isUp ? "⬆ SCALE UP" : "⬇ SCALE DOWN"}
                            </span>
                            <span style={{ fontSize: "0.58rem", color: "#4a5568" }}>
                              {ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : ""}
                            </span>
                          </div>
                          <div style={{ fontSize: "0.68rem", color: "#a0aec0" }}>{ev.message}</div>
                        </div>
                      );
                    })}
                  </div>
                )}
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
      `}</style>
    </div>
  );
}