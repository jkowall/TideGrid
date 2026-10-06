// First, so zod never probes for eval under the guest CSP. See zod-jitless.ts.
import "./zod-jitless.ts";
import "@tidegrid/design-system/base.css";
import "./guest.css";
import "./booking.css";
import { ErrorBoundary } from "@tidegrid/design-system/components";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { CrashedState } from "./States.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");
createRoot(root).render(
  <StrictMode>
    {/* A render error shows the designed failure screen, never a blank page. */}
    <ErrorBoundary fallback={<CrashedState />}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
