import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";
import "./ui.css";
import "./workflow.css";
import "./visual-system.css";
import "./inspector.css";
import "./task-list.css";
import "./content-catalog.css";
import "./browser-bookmarks.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
