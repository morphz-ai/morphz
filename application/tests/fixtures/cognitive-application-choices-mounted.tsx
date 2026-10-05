import React, { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CognitiveAppCatalogDto } from "../../packages/core/src/cognitive-app-api.js";
import type { CognitiveAppApplicationTarget } from "../../packages/core/src/cognitive-app-application-target.js";
import { initialWorkspace } from "../../packages/core/src/model.js";
import { projectApplicationPresentation } from "../../apps/web/src/application-presentation.js";
import { CognitiveApplicationPicker } from "../../apps/web/src/features/applications/CognitiveApplicationChoices.js";
import "../../apps/web/src/ui/controls/base.css";
import "../../apps/web/src/styles.css";
import "../../apps/web/src/ui/controls/adaptive.css";
import "../../apps/web/src/ui/dialog-frame.css";
import "../../apps/web/src/ui/controls/metrics.css";
import "../../apps/web/src/ui.css";
import "../../apps/web/src/ui/popup-surface.css";
import "../../apps/web/src/ui/dialog-surface.css";
import "../../apps/web/src/ui/controls/surfaces.css";
import "../../apps/web/src/visual-system.css";
import "../../apps/web/src/application-icons.css";

// Actual React/native dialog/shared focus and option rendering only. This leaf
// has no client/transport, so it does not claim full App/SQL/native acceptance.
const now = "2026-10-05T00:00:00.000Z";
const catalog: Pick<CognitiveAppCatalogDto, "versions" | "connections"> = {
  versions: [1, 2].map((v) => ({
    appId: "author.notes",
    version: `${v}.0.0`,
    definitionHash: String(v).repeat(64),
    title: "作者笔记",
    description: "真实目录事实",
    icon: "document",
    registeredAt: now,
    installationState: "active",
    harness: null,
    ui: v === 1 ? null : { packageVersion: "2.0.0", sha256: "a".repeat(64) },
    grant: {
      appId: "author.notes",
      version: `${v}.0.0`,
      state: "active",
      revision: 1,
      consentedAt: now,
      updatedAt: now,
    },
  })),
  connections: ["A", "B", "disabled"].map((id) => ({
    appId: "author.notes",
    connectionId: `connection-${id}`,
    instanceId: `instance-${id}`,
    serviceId: `作者/service-${id}`,
    dataAuthorityId: `原始保存方-${id}😀`,
    state: id === "disabled" ? "disabled" : "active",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  })),
};
const requests: CognitiveAppApplicationTarget[] = [];
let change: (name: "empty" | "revoked" | "fresh") => void = () => undefined;
let opened = false;
function Fixture() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"empty" | "revoked" | "fresh">("fresh");
  const [current, setCurrent] = useState<CognitiveAppApplicationTarget>();
  opened = open;
  change = setMode;
  const source =
    mode === "empty"
      ? { versions: [], connections: [] }
      : mode === "revoked"
        ? {
            ...catalog,
            versions: catalog.versions.map((v) => ({ ...v, grant: null })),
          }
        : catalog;
  const entries = projectApplicationPresentation({
    workspace: initialWorkspace(now),
    principalId: "local-owner",
    workspaceId: "first-project",
    cognitiveCatalog: source,
  }).entries.filter((entry) => entry.kind === "cognitive");
  return (
    <main className="workspace" style={{ minHeight: "100dvh" }}>
      <button onClick={() => setOpen(true)}>选择应用</button>
      {open && (
        <CognitiveApplicationPicker
          entries={entries}
          current={current}
          onClose={() => setOpen(false)}
          onChoose={(target) => {
            requests.push(target);
            setCurrent(target);
            setOpen(false);
          }}
        />
      )}
    </main>
  );
}
Object.assign(window, {
  cognitiveChoicesFixture: {
    mode: (name: "empty" | "revoked" | "fresh") => change(name),
    report: () => ({ requests, open: opened }),
  },
});
const root = createRoot(document.getElementById("root")!);
root.render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
import.meta.hot?.dispose(() => {
  root.unmount();
  Reflect.deleteProperty(window, "cognitiveChoicesFixture");
});
