import { LayoutDashboard, Server } from "lucide-react";

import { MetricsDashboard } from "@/components/metrics-dashboard";

export default function Home() {
  return (
    <div className="dashboard-workbench">
      <aside className="dashboard-rail">
        <div className="dashboard-wordmark">
          <span className="dashboard-mark" aria-hidden="true">V<span>/</span></span>
          voidstation<span className="dashboard-wordmark-dot" aria-hidden="true">.</span>
        </div>
        <div className="dashboard-server">
          <Server aria-hidden="true" />
          <span>Home Server<small>Ubuntu</small></span>
        </div>
        <nav className="dashboard-navigation" aria-label="Workspace">
          <a href="/" aria-current="page">
            <LayoutDashboard aria-hidden="true" />
            Dashboard
          </a>
        </nav>
      </aside>
      <main className="dashboard-main">
        <header className="dashboard-page-head">
          <div className="dashboard-page-title">
            <h1>Dashboard</h1>
          </div>
        </header>
        <MetricsDashboard />
      </main>
    </div>
  );
}
