import { MetricsDashboard } from "@/components/metrics-dashboard";

export default function Home() {
  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <div>
          <p className="dashboard-wordmark">Voidstation</p>
          <h1 className="dashboard-title">Server status</h1>
          <p className="dashboard-summary">
            Server Uptime and RAM, refreshed every five seconds while viewing.
          </p>
        </div>
      </header>
      <MetricsDashboard />
    </main>
  );
}
