(() => {
  const fixtures = {
    initial: {
      cpu: { status: "available", value: 25, unit: "percent", observedAt: "2026-01-02T03:04:05.000Z" },
      uptime: { status: "available", value: 90061.25, unit: "seconds", observedAt: "2026-01-02T03:04:05.001Z" },
      ram: { status: "unavailable", value: null, unit: "bytes", observedAt: null },
      rootFilesystem: { status: "available", value: { used: 400000000000, available: 50000000000, total: 500000000000 }, unit: "bytes", observedAt: "2026-01-02T03:04:05.002Z" },
      dataFilesystem: { status: "available", value: { used: 700000000000, available: 300000000000, total: 1000000000000 }, unit: "bytes", observedAt: "2026-01-02T03:04:05.003Z" },
    },
    recovered: {
      cpu: { status: "available", value: 26, unit: "percent", observedAt: "2026-01-02T03:04:10.000Z" },
      uptime: { status: "available", value: 90066.25, unit: "seconds", observedAt: "2026-01-02T03:04:10.001Z" },
      ram: { status: "available", value: { used: 5368709120, available: 3221225472, total: 8589934592 }, unit: "bytes", observedAt: "2026-01-02T03:04:10.002Z" },
      rootFilesystem: { status: "available", value: { used: 401000000000, available: 49000000000, total: 500000000000 }, unit: "bytes", observedAt: "2026-01-02T03:04:10.003Z" },
      dataFilesystem: { status: "available", value: { used: 701000000000, available: 299000000000, total: 1000000000000 }, unit: "bytes", observedAt: "2026-01-02T03:04:10.004Z" },
    },
    partial: {
      cpu: { status: "available", value: 27, unit: "percent", observedAt: "2026-01-02T03:04:15.000Z" },
      uptime: { status: "available", value: 90071.25, unit: "seconds", observedAt: "2026-01-02T03:04:15.001Z" },
      ram: { status: "unavailable", value: null, unit: "bytes", observedAt: null },
      rootFilesystem: { status: "available", value: { used: 402000000000, available: 48000000000, total: 500000000000 }, unit: "bytes", observedAt: "2026-01-02T03:04:15.003Z" },
      dataFilesystem: { status: "available", value: { used: 702000000000, available: 298000000000, total: 1000000000000 }, unit: "bytes", observedAt: "2026-01-02T03:04:15.004Z" },
    },
    final: {
      cpu: { status: "available", value: 28, unit: "percent", observedAt: "2026-01-02T03:04:20.000Z" },
      uptime: { status: "available", value: 90076.25, unit: "seconds", observedAt: "2026-01-02T03:04:20.001Z" },
      ram: { status: "available", value: { used: 0, available: 8589934592, total: 8589934592 }, unit: "bytes", observedAt: "2026-01-02T03:04:20.002Z" },
      rootFilesystem: { status: "available", value: { used: 403000000000, available: 47000000000, total: 500000000000 }, unit: "bytes", observedAt: "2026-01-02T03:04:20.003Z" },
      dataFilesystem: { status: "available", value: { used: 703000000000, available: 297000000000, total: 1000000000000 }, unit: "bytes", observedAt: "2026-01-02T03:04:20.004Z" },
    },
  };

  const nativeFetch = window.fetch.bind(window);
  let phase = "initial";
  window.__issue4FetchEvents = [];
  window.__issue4SetPhase = (next) => { phase = next; };

  window.fetch = async (...args) => {
    const input = args[0];
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url, location.href).pathname !== "/api/metrics") {
      return nativeFetch(...args);
    }

    window.__issue4FetchEvents.push({ phase, at: new Date().toISOString() });
    if (phase === "requestFailure") {
      throw new TypeError("Controlled metrics connection failure");
    }

    return new Response(JSON.stringify(fixtures[phase]), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  };
})();
