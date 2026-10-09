import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./ui/controls/base.css";
import "./styles.css";
import "./shell/window-frame-base.css";
import "./shell/workspace-topbar-base.css";
import "./features/pdf/pdf-reading-base.css";
import "./ui/controls/adaptive.css";
import "./features/browser/browser-controls.css";
import "./ui/dialog-frame.css";
import "./ui/controls/metrics.css";
import "./ui.css";
import "./shell/window-frame-composition.css";
import "./shell/workspace-topbar-composition.css";
import "./ui/popup-surface.css";
import "./ui/tooltip.css";
import "./workflow.css";
import "./ui/dialog-surface.css";
import "./ui/controls/surfaces.css";
import "./visual-system.css";
import "./shell/workspace-topbar-packing.css";
import "./features/pdf/pdf-reading-adaptive.css";
import "./features/exchange/exchange-controls.css";
import "./exchange-layout.css";
import "./inspector.css";
import "./task-list.css";
import "./content-catalog.css";
import "./browser-bookmarks.css";
import "./text-quotes.css";
import "./profile-avatar.css";
import "./personality-profile.css";
import "./execution-activity.css";
import "./execution-thread-groups.css";
import "./features/execution/execution-details.css";
import "./application-icons.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
