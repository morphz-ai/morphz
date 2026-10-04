import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";
import "./ui.css";
import "./workflow.css";
import "./ui/dialog-surface.css";
import "./visual-system.css";
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
import "./application-icons.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
