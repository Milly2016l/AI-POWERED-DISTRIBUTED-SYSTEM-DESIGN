import React, { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  MemoryStick,
  Network,
  PauseCircle,
  PlayCircle,
  RefreshCcw,
  ServerCog,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const API_BASE = "http://localhost:8000";
const MAX_POINTS = 24;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatTime(dateInput) {
  const date = dateInput ? new Date(dateInput) : new Date();
  if (Number.isNaN(date.getTime())) return new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date());
  return new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}

function severityRank(severity) {
  const value = String(severity || "NORMAL").toUpperCase();
  if (value === "CRITICAL") return 3;
  if (value === "HIGH") return 2;
  return 1;
}

function getClusterHealth(workers, fallbackSeverity = "NORMAL") {
  const severities = workers.length > 0 ? workers.map((w) => w.severity) : [fallbackSeverity];
  const worst = severities.reduce((max, sev) => Math.max(max, severityRank(sev)), 1);

  if (worst === 3) return { label: "Critical", severity: "CRITICAL", badge: "bg-red-100 text-red-700" };
  if (worst === 2) return { label: "Warning", severity: "HIGH", badge: "bg-yellow-100 text-yellow-700" };
  return { label: "Normal", severity: "NORMAL", badge: "bg-green-100 text-green-700" };
}

function normaliseWorker(worker, index = 0) {
  const serverId = worker?.server_id || worker?.id || `worker-${index + 1}`;
  const cpu = Number(worker?.cpu ?? 0);
  const memory = Number(worker?.memory ?? 0);
  const requests = Number(worker?.requests ?? 0);
  const predictedLoad = Number(worker?.predicted_load ?? 0);
  const severity = String(worker?.severity || "NORMAL").toUpperCase();

  return {
    id: serverId,
    name: serverId,
    role: serverId.startsWith("orchestrator-") ? "Orchestrator-spawned worker" : "Base monitored server",
    status: worker?.status || (severity === "CRITICAL" ? "Critical" : severity === "HIGH" ? "Busy" : "Active"),
    severity,
    suggestion: worker?.suggestion || "STEADY",
    tasks: requests,
    cpu,
    memory,
    requests,
    latency: Number(worker?.latency ?? 0),
    predictedLoad,
    lastSeen: worker?.last_seen || "",
  };
}

function buildPointFromDashboard(data, workers) {
  const severity = String(data?.severity || "NORMAL").toUpperCase();
  const isSpike = severity === "HIGH" || severity === "CRITICAL";

  // The backend already calculates both average and peak values.
  // During a spike, use peak values so one critical worker is not hidden by averaging.
  // During normal/distributed load, use average values so the graph visibly drops.
  return {
    time: formatTime(),
    cpu: Number(isSpike ? data?.peakCpu ?? data?.cpu ?? 0 : data?.cpu ?? 0),
    memory: Number(isSpike ? data?.peakMemory ?? data?.memory ?? 0 : data?.memory ?? 0),
    requests: Number(data?.requests ?? workers.reduce((sum, w) => sum + w.requests, 0)),
    latency: Number(data?.latency ?? 0),
    predictedLoad: Number(
      isSpike
        ? data?.peakPredictedLoad ?? data?.predictedLoad ?? 0
        : data?.predictedLoad ?? 0
    ),
    severity,
    workers: Number(data?.activeWorkers ?? workers.length ?? 0),
  };
}

function mapBackendEvents(events) {
  if (!Array.isArray(events)) return [];
  return events
    .slice()
    .reverse()
    .map((event, index) => ({
      id: `${event?.timestamp || Date.now()}-${index}`,
      time: formatTime(event?.timestamp),
      type: String(event?.message || "").includes("DOWN") ? "Scale Down" : String(event?.message || "").includes("UP") ? "Scale Up" : "System",
      message: event?.message || "Backend update received.",
    }));
}

function Card({ children, className = "" }) {
  return <div className={`rounded-3xl border border-slate-200 bg-white shadow-sm ${className}`}>{children}</div>;
}

function ProgressBar({ value }) {
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-200">
      <div className="h-full rounded-full bg-slate-800 transition-all duration-500" style={{ width: `${clamp(value, 0, 100)}%` }} />
    </div>
  );
}

function TabButton({ label, active, onClick }) {
  return (
    <button onClick={onClick} className={`rounded-2xl px-4 py-2 text-sm font-medium transition ${active ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`}>
      {label}
    </button>
  );
}

function StatCard({ title, value, unit, icon: Icon, hint, trend }) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-slate-500">{title}</p>
          <div className="mt-2 flex items-end gap-2">
            <h3 className="text-3xl font-bold tracking-tight text-slate-900">{value}</h3>
            <span className="pb-1 text-sm text-slate-500">{unit}</span>
          </div>
          <div className="mt-2 flex items-center gap-2 text-sm text-slate-500">
            {trend === "up" ? <TrendingUp className="h-4 w-4" /> : trend === "down" ? <TrendingDown className="h-4 w-4" /> : null}
            <span>{hint}</span>
          </div>
        </div>
        <div className="rounded-2xl bg-slate-100 p-3">
          <Icon className="h-6 w-6 text-slate-700" />
        </div>
      </div>
    </Card>
  );
}

function WorkerCard({ worker }) {
  const badge = worker.severity === "CRITICAL" ? "bg-red-100 text-red-700" : worker.severity === "HIGH" ? "bg-orange-100 text-orange-700" : worker.status === "Standby" ? "bg-slate-100 text-slate-700" : "bg-green-100 text-green-700";

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-slate-900">{worker.name}</p>
            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${badge}`}>{worker.status}</span>
          </div>
          <p className="mt-1 text-sm text-slate-500">{worker.role}</p>
          <p className="mt-1 text-xs text-slate-400">Severity: {worker.severity} | AI: {worker.predictedLoad}%</p>
        </div>
        <div className="text-right text-sm">
          <p className="font-medium text-slate-900">{worker.requests} req</p>
          <p className="text-slate-500">{worker.cpu}% CPU</p>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <div>
          <div className="mb-1 flex justify-between text-xs text-slate-500"><span>CPU</span><span>{worker.cpu}%</span></div>
          <ProgressBar value={worker.cpu} />
        </div>
        <div>
          <div className="mb-1 flex justify-between text-xs text-slate-500"><span>Memory</span><span>{worker.memory}%</span></div>
          <ProgressBar value={worker.memory} />
        </div>
        <div>
          <div className="mb-1 flex justify-between text-xs text-slate-500"><span>Predicted load</span><span>{worker.predictedLoad}%</span></div>
          <ProgressBar value={worker.predictedLoad} />
        </div>
      </div>
    </Card>
  );
}

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState("workers");
  const [isLive, setIsLive] = useState(true);
  const [backendConnected, setBackendConnected] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(formatTime());
  const [errorMessage, setErrorMessage] = useState("");
  const [workers, setWorkers] = useState([]);
  const [scenario, setScenario] = useState("unknown");
  const [history, setHistory] = useState([]);
  const [events, setEvents] = useState([
    { id: 1, time: formatTime(), type: "System", message: "Dashboard initialized. Waiting for live backend data." },
  ]);

  const latest = history[history.length - 1] || { cpu: 0, memory: 0, requests: 0, latency: 0, predictedLoad: 0, severity: "NORMAL", workers: workers.length };
  const health = getClusterHealth(workers, latest.severity);

  async function fetchLiveState() {
    const [dashboardRes, scenarioRes] = await Promise.all([
      fetch(`${API_BASE}/api/dashboard`),
      fetch(`${API_BASE}/simulator/scenario`).catch(() => null),
    ]);

    if (!dashboardRes.ok) throw new Error(`Backend returned ${dashboardRes.status}`);

    const dashboardData = await dashboardRes.json();
    const normalizedWorkers = Array.isArray(dashboardData?.workers) ? dashboardData.workers.map(normaliseWorker) : [];
    const point = buildPointFromDashboard(dashboardData, normalizedWorkers);
    const incomingEvents = mapBackendEvents(dashboardData?.events);

    if (scenarioRes && scenarioRes.ok) {
      const scenarioData = await scenarioRes.json();
      setScenario(scenarioData?.active || scenarioData?.scenario || "unknown");
    }

    setWorkers(normalizedWorkers);
    setHistory((current) => [...current.slice(-(MAX_POINTS - 1)), point]);
    setEvents((current) => {
      const merged = [...incomingEvents, ...current];
      const seen = new Set();
      return merged.filter((event) => {
        const key = `${event.time}-${event.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 12);
    });
    setBackendConnected(true);
    setErrorMessage("");
    setLastUpdated(point.time);
  }

  useEffect(() => {
    if (!isLive) return undefined;

    fetchLiveState().catch((err) => {
      console.error("Backend error:", err);
      setBackendConnected(false);
      setErrorMessage(err?.message || "Failed to fetch backend data.");
      setEvents((current) => [
        { id: Date.now(), time: formatTime(), type: "System", message: `Backend connection issue: ${err?.message || "unknown error"}` },
        ...current,
      ].slice(0, 12));
    });

    const interval = setInterval(() => {
      fetchLiveState().catch((err) => {
        console.error("Backend error:", err);
        setBackendConnected(false);
        setErrorMessage(err?.message || "Failed to fetch backend data.");
      });
    }, 2000);

    return () => clearInterval(interval);
  }, [isLive]);

  const requestDistribution = workers.map((worker) => ({ name: worker.name, requests: worker.requests }));
  const loadTrend = history.length >= 2 ? (latest.predictedLoad >= history[history.length - 2].predictedLoad ? "up" : "down") : "down";

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <Card className="p-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm font-semibold text-blue-700">BIUST Server Monitoring System with AI-Based Auto-Scaling</p>
              <h1 className="mt-1 text-3xl font-bold tracking-tight text-slate-900 md:text-4xl">Live Monitoring Dashboard</h1>
              <p className="mt-2 max-w-3xl text-sm text-slate-500 md:text-base">
                This dashboard now reads the same live worker state as the test panel, so spikes, distributed load decreases, and NORMAL server states are reflected directly.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="flex flex-col items-start gap-1">
                <span className={`rounded-full px-3 py-1 text-sm font-medium ${health.badge}`}>{health.label}</span>
                <span className={backendConnected ? "text-xs text-green-600" : "text-xs text-red-600"}>
                  {backendConnected ? `Live • Updated ${lastUpdated}` : `Offline • ${errorMessage || "Waiting for backend"}`}
                </span>
              </div>

              <button onClick={() => setIsLive((value) => !value)} className="inline-flex items-center rounded-2xl bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800">
                {isLive ? <PauseCircle className="mr-2 h-4 w-4" /> : <PlayCircle className="mr-2 h-4 w-4" />}
                {isLive ? "Pause Live Feed" : "Resume Live Feed"}
              </button>

              <button onClick={() => fetchLiveState().catch((err) => setErrorMessage(err?.message || "Refresh failed"))} className="inline-flex items-center rounded-2xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100">
                <RefreshCcw className="mr-2 h-4 w-4" /> Refresh State
              </button>
            </div>
          </div>
        </Card>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <StatCard title="Average CPU" value={latest.cpu} unit="%" icon={Cpu} hint="Average across live workers" trend={latest.cpu > 70 ? "up" : "down"} />
          <StatCard title="Average Memory" value={latest.memory} unit="%" icon={MemoryStick} hint="Average across live workers" trend={latest.memory > 70 ? "up" : "down"} />
          <StatCard title="Total Requests" value={latest.requests} unit="req" icon={Network} hint={`Scenario: ${scenario}`} trend={latest.requests > 1200 ? "up" : "down"} />
          <StatCard title="Active Workers" value={workers.length || latest.workers} unit="nodes" icon={ServerCog} hint="Base + orchestrator-spawned nodes" trend={loadTrend} />
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <div className="p-6">
              <h2 className="text-xl font-semibold text-slate-900">System Metrics Over Time</h2>
              <p className="mt-1 text-sm text-slate-500">When workers are added, average CPU and predicted load should drop as requests are distributed.</p>
            </div>
            <div className="h-[360px] w-full px-4 pb-6 md:px-6">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={history}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="time" tick={{ fontSize: 12 }} minTickGap={24} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Line type="monotone" dataKey="cpu" strokeWidth={3} dot={false} name="Average CPU %" />
                  <Line type="monotone" dataKey="memory" strokeWidth={3} dot={false} name="Average Memory %" />
                  <Line type="monotone" dataKey="predictedLoad" strokeWidth={3} strokeDasharray="6 3" dot={false} name="Average AI Load %" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card className="p-6">
            <h2 className="text-xl font-semibold text-slate-900">System Status</h2>
            <p className="mt-1 text-sm text-slate-500">Status is based on actual worker severity, not random fallback values.</p>

            <div className="mt-5 space-y-5">
              <div className="rounded-2xl border border-slate-200 p-4">
                <div className="mb-2 flex items-center gap-2">
                  {health.severity === "CRITICAL" ? <AlertTriangle className="h-5 w-5 text-red-600" /> : <CheckCircle2 className="h-5 w-5 text-green-600" />}
                  <p className="font-semibold text-slate-900">Cluster Health: {health.label}</p>
                </div>
                <p className="text-sm text-slate-500">Worst worker severity: {health.severity}</p>
              </div>

              <div><div className="mb-1 flex justify-between text-sm text-slate-700"><span>Average predicted load</span><span>{latest.predictedLoad}%</span></div><ProgressBar value={latest.predictedLoad} /></div>
              <div><div className="mb-1 flex justify-between text-sm text-slate-700"><span>Average CPU pressure</span><span>{latest.cpu}%</span></div><ProgressBar value={latest.cpu} /></div>
              <div><div className="mb-1 flex justify-between text-sm text-slate-700"><span>Average memory pressure</span><span>{latest.memory}%</span></div><ProgressBar value={latest.memory} /></div>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-2xl bg-slate-100 p-4"><p className="text-sm text-slate-500">Traffic State</p><p className="mt-1 text-xl font-bold text-slate-900">{scenario}</p></div>
                <div className="rounded-2xl bg-slate-100 p-4"><p className="text-sm text-slate-500">Scaler Mode</p><p className="mt-1 text-xl font-bold text-slate-900">{backendConnected ? "Live" : "Offline"}</p></div>
              </div>
            </div>
          </Card>
        </div>

        <Card className="p-4 md:p-6">
          <div className="mb-5 flex flex-wrap gap-3">
            <TabButton label="Worker Activity" active={activeTab === "workers"} onClick={() => setActiveTab("workers")} />
            <TabButton label="Request Distribution" active={activeTab === "requests"} onClick={() => setActiveTab("requests")} />
            <TabButton label="Scaling Events" active={activeTab === "events"} onClick={() => setActiveTab("events")} />
          </div>

          {activeTab === "workers" && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {workers.length > 0 ? workers.map((worker) => <WorkerCard key={worker.id} worker={worker} />) : <p className="text-sm text-slate-500">No live workers returned yet.</p>}
            </div>
          )}

          {activeTab === "requests" && (
            <div>
              <h2 className="text-xl font-semibold text-slate-900">Request Distribution Across Workers</h2>
              <p className="mt-1 text-sm text-slate-500">This shows the actual per-worker requests returned by the API.</p>
              <div className="mt-4 h-[340px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={requestDistribution}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip />
                    <Bar dataKey="requests" radius={[10, 10, 0, 0]} name="Requests" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {activeTab === "events" && (
            <div>
              <h2 className="text-xl font-semibold text-slate-900">Live Event Feed</h2>
              <p className="mt-1 text-sm text-slate-500">Recent auto-scaling decisions from the orchestrator.</p>
              <div className="mt-4 max-h-[340px] space-y-3 overflow-y-auto pr-2">
                {events.map((event) => (
                  <div key={event.id} className="rounded-2xl border border-slate-200 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2"><Activity className="h-4 w-4 text-slate-700" /><p className="font-medium text-slate-900">{event.type}</p></div>
                      <span className="text-xs text-slate-500">{event.time}</span>
                    </div>
                    <p className="mt-2 text-sm text-slate-500">{event.message}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <Card>
            <div className="p-6">
              <h2 className="text-xl font-semibold text-slate-900">Traffic Trend</h2>
              <p className="mt-1 text-sm text-slate-500">Total request volume from the current worker set.</p>
            </div>
            <div className="h-[280px] w-full px-4 pb-6 md:px-6">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={history}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="time" tick={{ fontSize: 12 }} minTickGap={24} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Area type="monotone" dataKey="requests" strokeWidth={2} fillOpacity={0.2} name="Total requests" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
