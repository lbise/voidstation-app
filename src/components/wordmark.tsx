export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="dashboard-wordmark" aria-label="Voidstation">
      <span className="dashboard-mark" aria-hidden="true">V<span>/</span></span>
      {!compact && <span className="dashboard-wordmark-text" aria-hidden="true">voidstation<span className="dashboard-wordmark-dot">.</span></span>}
    </span>
  );
}
