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

const MAX_POINTS = 24;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatTime(date) {
  return new Intl.DateTimeFormat([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function generateNextPoint(prev, workers = 3) {
  const cpuBase = prev?.cpu ?? 42;
  const memoryBase = prev?.memory ?? 55;
  const requestsBase = prev?.requests ?? 180;

  const spike = Math.random() > 0.88 ? Math.random() * 20 : 0;
  const dip = Math.random() > 0.95 ? Math.random() * 12 : 0;
  const workerEffect = workers * 2.2;

  const requests = clamp(
    Math.round(requestsBase + (Math.random() * 30 - 15) + spike * 6 - dip * 2),
    40,
    520
  );

  const cpu = clamp(
    Math.round(cpuBase + (Math.random() * 10 - 5) + spike - dip - workerEffect * 0.12 + requests / 185),
    10,
    98
  );

  const memory = clamp(
    Math.round(memoryBase + (Math.random() * 8 - 4) + spike * 0.4 - dip * 0.3 + requests / 350),
    20,
    96
  );

  const predictedLoad = clamp(
    Math.round(cpu * 0.72 + memory * 0.28 + Math.random() * 6),
    10,
    100
  );

  return {
    time: formatTime(new Date()),
    cpu,
    memory,
    requests,
    predictedLoad,
  };
}

function getHealthStatus(cpu, memory) {
  if (cpu > 85 || memory > 85) {
    return { label: "Critical", badge: "bg-red-100 text-red-700" };
  }
  if (cpu > 70 || memory > 75) {
    return { label: "Warning", badge: "bg-yellow-100 text-yellow-700" };
  }
  return { label: "Stable", badge: "bg-green-100 text-green-700" };
}

function normalizeWorker(worker, index = 0) {
  return {
    id: worker?.id ?? index + 1,
    name: worker?.name ?? `Worker-${index + 1}`,
    role: worker?.role ?? (index === 0 ? "Load balancer helper" : index % 2 === 0 ? "Prediction processor" : "Request handler"),
    status: worker?.status ?? "Active",
    tasks: Number(worker?.tasks ?? 0),
    cpu: Number(worker?.cpu ?? 0),
    memory: Number(worker?.memory ?? 0),
  };
}

function mapBackendEvents(events) {
  if (!Array.isArray(events)) return [];

  return events.map((event, index) => ({
    id: `${Date.now()}-${index}`,
    time: event?.time || formatTime(new Date()),
    type: event?.type || "System",
    message: event?.message || "Backend update received.",
  }));
}

function Card({ children, className = "" }) {
  return <div className={`rounded-3xl border border-slate-200 bg-white shadow-sm ${className}`}>{children}</div>;
}

function ProgressBar({ value }) {
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-200">
      <div
        className="h-full rounded-full bg-slate-800 transition-all duration-500"
        style={{ width: `${clamp(value, 0, 100)}%` }}
      />
    </div>
  );
}

function TabButton({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-2xl px-4 py-2 text-sm font-medium transition ${
        active ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
      }`}
    >
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
            <h3 className="text-3xl font-bold tracking-tight text-slate-900">
              {value}
            </h3>
            <span className="pb-1 text-sm text-slate-500">{unit}</span>
          </div>

          <div className="mt-2 flex items-center gap-2 text-sm text-slate-500">
            {trend === "up" ? (
              <TrendingUp className="h-4 w-4" />
            ) : trend === "down" ? (
              <TrendingDown className="h-4 w-4" />
            ) : null}
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
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <p className="font-semibold text-slate-900">{worker.name}</p>
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                worker.status === "Active"
                  ? "bg-green-100 text-green-700"
                  : worker.status === "Busy"
                  ? "bg-orange-100 text-orange-700"
                  : "bg-slate-100 text-slate-700"
              }`}
            >
              {worker.status}
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-500">{worker.role}</p>
        </div>
        <div className="text-right text-sm">
          <p className="font-medium text-slate-900">{worker.tasks} tasks</p>
          <p className="text-slate-500">{worker.cpu}% CPU</p>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <div>
          <div className="mb-1 flex justify-between text-xs text-slate-500">
            <span>CPU</span>
            <span>{worker.cpu}%</span>
          </div>
          <ProgressBar value={worker.cpu} />
        </div>
        <div>
          <div className="mb-1 flex justify-between text-xs text-slate-500">
            <span>Memory</span>
            <span>{worker.memory}%</span>
          </div>
          <ProgressBar value={worker.memory} />
        </div>
      </div>
    </Card>
  );
}

export default function Dashboard() {
  const API_URL = "http://localhost:8000/api/dashboard";

  const [activeTab, setActiveTab] = useState("workers");
  const [isLive, setIsLive] = useState(true);
  const [backendConnected, setBackendConnected] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(formatTime(new Date()));
  const [errorMessage, setErrorMessage] = useState("");
  const [backendWorkers, setBackendWorkers] = useState([]);
  const [workerCount, setWorkerCount] = useState(3);
  const [history, setHistory] = useState(() => {
    const seed = [];
    let prev = null;
    for (let i = 0; i < 12; i += 1) {
      prev = generateNextPoint(prev, 3);
      seed.push(prev);
    }
    return seed;
  });
  const [events, setEvents] = useState([
    { id: 1, time: formatTime(new Date()), type: "System", message: "Dashboard initialized successfully." },
    { id: 2, time: formatTime(new Date()), type: "System", message: "Waiting for backend metrics stream." },
  ]);

  const latest = history[history.length - 1];
  const health = latest ? getHealthStatus(latest.cpu, latest.memory) : getHealthStatus(0, 0);

  useEffect(() => {
    if (!isLive) return undefined;

    const fetchData = async () => {
      try {
        const res = await fetch(API_URL);
        if (!res.ok) {
          throw new Error(`Backend returned ${res.status}`);
        }

        const data = await res.json();

        const point = {
          time: formatTime(new Date()),
          cpu: Number(data?.cpu ?? 0),
          memory: Number(data?.memory ?? 0),
          requests: Number(data?.requests ?? 0),
          predictedLoad: Number(data?.predictedLoad ?? 0),
        };

        const normalizedWorkers = Array.isArray(data?.workers)
          ? data.workers.map((worker, index) => normalizeWorker(worker, index))
          : [];

        const incomingEvents = mapBackendEvents(data?.events);

        setHistory((current) => [...current.slice(-(MAX_POINTS - 1)), point]);
        setBackendWorkers(normalizedWorkers);
        setWorkerCount(normalizedWorkers.length > 0 ? normalizedWorkers.length : Number(data?.activeWorkers ?? 3));
        setEvents((current) => [...incomingEvents, ...current].slice(0, 12));
        setBackendConnected(true);
        setErrorMessage("");
        setLastUpdated(point.time);
      } catch (err) {
        console.error("Backend error:", err);

        setBackendConnected(false);
        setErrorMessage(err?.message || "Failed to fetch backend data.");
        setBackendWorkers([]);

        setHistory((current) => {
          const prev = current[current.length - 1];
          const next = generateNextPoint(prev, workerCount || 3);
          setLastUpdated(next.time);
          return [...current.slice(-(MAX_POINTS - 1)), next];
        });
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 2000);

    return () => clearInterval(interval);
  }, [API_URL, isLive, workerCount]);

  useEffect(() => {
    if (!latest || backendConnected) return;

    if (latest.cpu > 85 || latest.memory > 85) {
      setEvents((current) => [
        {
          id: Date.now(),
          time: formatTime(new Date()),
          type: "Alert",
          message: `High resource usage detected. CPU ${latest.cpu}% | Memory ${latest.memory}%.`,
        },
        ...current,
      ].slice(0, 12));
    }
  }, [latest, backendConnected]);

  const fallbackWorkers = useMemo(() => {
    if (!latest) return [];

    return Array.from({ length: Math.max(workerCount, 1) }, (_, index) => {
      const baseCpu = clamp(Math.round(latest.cpu - 10 - index * 2), 18, 92);
      const baseMemory = clamp(Math.round(latest.memory - 8 - index * 2), 20, 95);

      return {
        id: index + 1,
        name: `Worker-${index + 1}`,
        role: index === 0 ? "Load balancer helper" : index % 2 === 0 ? "Prediction processor" : "Request handler",
        status: baseCpu > 85 ? "Busy" : "Active",
        tasks: Math.max(3, Math.round(latest.requests / Math.max(workerCount, 1) / 4) + index),
        cpu: baseCpu,
        memory: baseMemory,
      };
    });
  }, [latest, workerCount]);

  const displayedWorkers = backendWorkers.length > 0 ? backendWorkers : fallbackWorkers;

  const requestDistribution = displayedWorkers.map((worker) => ({
    name: worker.name,
    tasks: worker.tasks,
  }));

  if (!latest) return null;

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <Card className="p-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm font-semibold text-blue-700">BIUST Server Monitoring System with AI-Based Auto-Scaling</p>
              <h1 className="mt-1 text-3xl font-bold tracking-tight text-slate-900 md:text-4xl">Live Monitoring Dashboard</h1>
              <p className="mt-2 max-w-3xl text-sm text-slate-500 md:text-base">
                Real-time visualization of server performance, predicted load, worker activity, and automatic scaling decisions.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="flex flex-col items-start gap-1">
                <span className={`rounded-full px-3 py-1 text-sm font-medium ${health.badge}`}>{health.label}</span>
                <span className="text-xs text-green-600">
                  Updated {lastUpdated}
                </span>
              </div>

              <button
                onClick={() => setIsLive((value) => !value)}
                className="inline-flex items-center rounded-2xl bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
              >
                {isLive ? <PauseCircle className="mr-2 h-4 w-4" /> : <PlayCircle className="mr-2 h-4 w-4" />}
                {isLive ? "Pause Live Feed" : "Resume Live Feed"}
              </button>

              <button
                onClick={() => {
                  setEvents((current) => [
                    {
                      id: Date.now(),
                      time: formatTime(new Date()),
                      type: "System",
                      message: backendConnected ? "Manual refresh requested." : "Manual refresh triggered in fallback mode.",
                    },
                    ...current,
                  ].slice(0, 12));
                }}
                className="inline-flex items-center rounded-2xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
              >
                <RefreshCcw className="mr-2 h-4 w-4" />
                Refresh State
              </button>
            </div>
          </div>
        </Card>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <StatCard title="CPU Usage" value={latest.cpu} unit="%" icon={Cpu} hint="Updated every 2 seconds" trend={latest.cpu > 70 ? "up" : "down"} />
          <StatCard title="Memory Usage" value={latest.memory} unit="%" icon={MemoryStick} hint="Tracks active server memory" trend={latest.memory > 70 ? "up" : "down"} />
          <StatCard title="Requests / min" value={latest.requests} unit="rpm" icon={Network} hint="Incoming traffic volume" trend={latest.requests > 250 ? "up" : "down"} />
          <StatCard title="Active Workers" value={displayedWorkers.length} unit="nodes" icon={ServerCog} hint="Auto-adjusted based on system load" trend="up" />
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <div className="p-6">
              <h2 className="text-xl font-semibold text-slate-900">System Metrics Over Time</h2>
              <p className="mt-1 text-sm text-slate-500">CPU, memory, and AI-predicted future load shown on a live timeline.</p>
            </div>
            <div className="h-[360px] w-full px-4 pb-6 md:px-6">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={history}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="time" tick={{ fontSize: 12 }} minTickGap={24} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Line type="monotone" dataKey="cpu" strokeWidth={3} dot={false} name="CPU %" />
                  <Line type="monotone" dataKey="memory" strokeWidth={3} dot={false} name="Memory %" />
                  <Line type="monotone" dataKey="predictedLoad" strokeWidth={3} strokeDasharray="6 3" dot={false} name="Predicted Load %" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card className="p-6">
            <h2 className="text-xl font-semibold text-slate-900">System Status</h2>
            <p className="mt-1 text-sm text-slate-500">Current operating condition of the monitored environment.</p>

            <div className="mt-5 space-y-5">
              <div className="rounded-2xl border border-slate-200 p-4">
                <div className="mb-2 flex items-center gap-2">
                  {health.label === "Critical" ? (
                    <AlertTriangle className="h-5 w-5 text-red-600" />
                  ) : (
                    <CheckCircle2 className="h-5 w-5 text-green-600" />
                  )}
                  <p className="font-semibold text-slate-900">Cluster Health: {health.label}</p>
                </div>
                
              </div>

              <div>
                <div className="mb-1 flex justify-between text-sm text-slate-700">
                  <span>Predicted load</span>
                  <span>{latest.predictedLoad}%</span>
                </div>
                <ProgressBar value={latest.predictedLoad} />
              </div>

              <div>
                <div className="mb-1 flex justify-between text-sm text-slate-700">
                  <span>CPU pressure</span>
                  <span>{latest.cpu}%</span>
                </div>
                <ProgressBar value={latest.cpu} />
              </div>

              <div>
                <div className="mb-1 flex justify-between text-sm text-slate-700">
                  <span>Memory pressure</span>
                  <span>{latest.memory}%</span>
                </div>
                <ProgressBar value={latest.memory} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-2xl bg-slate-100 p-4">
                  <p className="text-sm text-slate-500">Traffic State</p>
                  <p className="mt-1 text-xl font-bold text-slate-900">
                    {latest.requests > 260 ? "High" : latest.requests > 150 ? "Normal" : "Low"}
                  </p>
                </div>
                <div className="rounded-2xl bg-slate-100 p-4">
                  <p className="text-sm text-slate-500">Scaler Mode</p>
                  <p className="mt-1 text-xl font-bold text-slate-900">{backendConnected ? "Live" : "Fallback"}</p>
                </div>
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
              {displayedWorkers.map((worker) => (
                <WorkerCard key={worker.id} worker={worker} />
              ))}
            </div>
          )}

          {activeTab === "requests" && (
            <div>
              <h2 className="text-xl font-semibold text-slate-900">Task Distribution Across Workers</h2>
              <p className="mt-1 text-sm text-slate-500">Shows how incoming requests are spread across active worker nodes.</p>
              <div className="mt-4 h-[340px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={requestDistribution}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip />
                    <Bar dataKey="tasks" radius={[10, 10, 0, 0]} name="Tasks" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {activeTab === "events" && (
            <div>
              <h2 className="text-xl font-semibold text-slate-900">Live Event Feed</h2>
              <p className="mt-1 text-sm text-slate-500">Recent alerts, manual actions, and auto-scaling decisions.</p>
              <div className="mt-4 max-h-[340px] space-y-3 overflow-y-auto pr-2">
                {events.map((event) => (
                  <div key={event.id} className="rounded-2xl border border-slate-200 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <Activity className="h-4 w-4 text-slate-700" />
                        <p className="font-medium text-slate-900">{event.type}</p>
                      </div>
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
              <p className="mt-1 text-sm text-slate-500">Live request-rate area chart for the final demo.</p>
            </div>
            <div className="h-[280px] w-full px-4 pb-6 md:px-6">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={history}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="time" tick={{ fontSize: 12 }} minTickGap={24} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Area type="monotone" dataKey="requests" strokeWidth={2} fillOpacity={0.2} name="Requests/min" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>

        </div>
      </div>
    </div>
  );
}
