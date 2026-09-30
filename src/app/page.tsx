import { AppShell } from "@/components/app-shell";
import { MetricsDashboard } from "@/components/metrics-dashboard";

export default function Home() {
  return (
    <AppShell active="dashboard">
      <main className="dashboard-main">
        <MetricsDashboard />
      </main>
    </AppShell>
  );
}
