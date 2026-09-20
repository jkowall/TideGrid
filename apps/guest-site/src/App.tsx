import type { HealthResponse } from "@tidegrid/contracts";
import { useEffect, useState } from "react";

const apiBase = import.meta.env.VITE_API_BASE ?? "";

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!apiBase) return;
    fetch(`${apiBase}/v1/health`)
      .then((r) => r.json() as Promise<HealthResponse>)
      .then(setHealth)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <main style={{ padding: "var(--space-8) var(--space-4)", maxWidth: 720, margin: "0 auto" }}>
      <p
        style={{ fontSize: "var(--text-xs)", letterSpacing: "0.08em", textTransform: "uppercase" }}
      >
        Demo build, synthetic data
      </p>
      <h1>Guest booking</h1>
      <p>
        The branded guest experience arrives with the design system and catalog goals. This page
        proves the workspace deploys and can reach the API.
      </p>
      <p aria-live="polite">
        {!apiBase && "API base not configured."}
        {apiBase && !health && !error && "Checking the API…"}
        {health && `API ${health.status}, database ${health.database}, build ${health.version}.`}
        {error && `API unreachable: ${error}`}
      </p>
    </main>
  );
}
