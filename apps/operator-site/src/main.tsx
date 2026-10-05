import "@tidegrid/design-system/base.css";
import "./console.css";
import "./calendar/calendar.css";
import { ErrorBoundary } from "@tidegrid/design-system/components";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { CrashedConsole } from "./Gate.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");
createRoot(root).render(
  <StrictMode>
    {/* A render error shows the designed failure screen, never a blank page. */}
    <ErrorBoundary fallback={<CrashedConsole />}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
