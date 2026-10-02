import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ReaderOcrControls } from "../../apps/web/src/ReaderOcrControls.js";
import type { WorkspaceClient } from "../../apps/web/src/client.js";
import type { ReadingSection } from "../../packages/core/src/reader.js";
import type {
  ReaderOcrRequest,
  ReaderOcrStatus,
} from "../../packages/core/src/reader-ocr.js";

export type OcrConsumerHarness = {
  notify(): void;
  bind(artifactId: string, revision: number, page: number): void;
  identity(generation: string): void;
  active(value: boolean): void;
  snapshot(): { opened: string[]; aborted: string[] };
};
declare global {
  interface Window {
    ocrHarness: OcrConsumerHarness;
  }
}

// Test-only mounting of the production component and observation hook. The
// controlled HTTP port replaces only WorkspaceClient's OCR/domain transport;
// this is not an OCR-engine or full WorkspaceClient integration claim.
const opened: string[] = [],
  aborted: string[] = [];
let binding = { artifactId: "TEST-book-one", revision: 1, page: 1 };
let boot = {
  centerId: "TEST-center",
  principalId: "TEST-human",
  csrfToken: "generation-one",
};
let active = true,
  revision = 0,
  render = () => {};
const client = {
  online: true,
  get boot() {
    return boot;
  },
  get workspaceChangeRevision() {
    return revision;
  },
  async readingOcr(
    request: ReaderOcrRequest,
    signal?: AbortSignal,
    identityGeneration?: string,
  ): Promise<ReaderOcrStatus> {
    signal?.addEventListener(
      "abort",
      () =>
        aborted.push(
          JSON.stringify([request.artifactId, request.revision, request.page]),
        ),
      { once: true },
    );
    const response = await fetch("/TEST/reader-ocr", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Test-Generation": identityGeneration ?? "",
      },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) throw new Error(`OCR status HTTP ${response.status}`);
    // Deliberately no extra identity publication guard here: these regressions
    // prove the component/hook itself discards late old-scope replies.
    return response.json() as Promise<ReaderOcrStatus>;
  },
} as unknown as WorkspaceClient;

window.ocrHarness = {
  notify() {
    revision++;
    render();
  },
  bind(artifactId, artifactRevision, page) {
    binding = { artifactId, revision: artifactRevision, page };
    render();
  },
  identity(generation) {
    boot = { ...boot, csrfToken: generation };
    render();
  },
  active(value) {
    active = value;
    render();
  },
  snapshot() {
    return { opened: [...opened], aborted: [...aborted] };
  },
};

function Harness() {
  const [, bump] = useState(0);
  render = () => bump((current) => current + 1);
  const section: ReadingSection = {
    id: `page-${binding.page}`,
    title: "TEST scan",
    html: "",
    text: "",
    sourceId: binding.artifactId,
    book: {
      title: "TEST-only OCR page",
      author: "",
      edition: "",
      format: "pdf",
    },
  };
  return (
    <ReaderOcrControls
      client={client}
      artifactId={binding.artifactId}
      revision={binding.revision}
      section={section}
      active={active}
      onOpen={(id) => opened.push(id)}
      onFocusLine={() => {}}
    />
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
