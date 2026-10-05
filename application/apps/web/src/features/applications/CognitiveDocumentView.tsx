import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CognitiveAppViewUi } from "../../../../../packages/core/src/cognitive-app-view-api.js";
import type { CognitiveBrowserRouterPorts } from "../../host/cognitive-browser-router.js";
import {
  createCognitiveDocumentConsumer,
  type CognitiveDocumentPresentation,
} from "../../host/cognitive-document-consumer.js";

export interface CognitiveDocumentViewProps {
  source: CognitiveAppViewUi | null;
  /** Real identity/read-owner incarnation, not conversation, theme or save CAS. */
  mountKey: string | number;
  status:
    "idle" | "loading" | "absent" | "closed" | "unbound" | "error" | "ready";
  message: string;
  current(): boolean;
  routerPorts: CognitiveBrowserRouterPorts;
  presentation: CognitiveDocumentPresentation;
  onRetry(): void;
  onClose(): void;
}

type Consumer = ReturnType<typeof createCognitiveDocumentConsumer>;
type Plan = {
  source: CognitiveAppViewUi | null;
  current(): boolean;
  routerPorts: CognitiveBrowserRouterPorts;
  ready: boolean;
};
type Mount = {
  plan: Plan;
  controller: AbortController;
  live: boolean;
  consumer?: Consumer;
};
const unavailable = "应用界面已失效或未能加载，已保存的现场与草稿仍保留。";

/** React lifetime/presentation leaf only. The parent supplies an authenticated
 * immutable read and a captured real-owner lease; neither props nor ready are
 * authority. This component never launches, binds, grants, closes or sends. */
export function CognitiveDocumentView(props: CognitiveDocumentViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const mounted = useRef<Mount | null>(null);
  const [failedPlan, setFailedPlan] = useState<Plan | null>(null);
  const [readyPlan, setReadyPlan] = useState<Plan | null>(null);
  const executable = props.status === "ready" && props.source !== null;
  // Capture callbacks for this exact immutable source/owner. A subsequent
  // callback cannot lend a new owner's authority to the old Document.
  const plan = useMemo<Plan>(
    () => ({
      source: props.source,
      current: props.current,
      routerPorts: props.routerPorts,
      ready: executable,
    }),
    [props.source, props.mountKey, executable],
  );

  function current(mount: Mount) {
    if (!mount.live || mounted.current !== mount) return false;
    try {
      return (
        mount.plan.current() &&
        mount.live &&
        mounted.current === mount &&
        !mount.controller.signal.aborted
      );
    } catch {
      return false;
    }
  }
  function stop(mount: Mount) {
    if (!mount.live) return;
    mount.live = false;
    mount.controller.abort();
    mount.consumer?.retire();
  }
  function failed(mount: Mount) {
    if (!mount.live || mounted.current !== mount) return;
    stop(mount);
    setFailedPlan(mount.plan);
  }

  useLayoutEffect(() => {
    if (!plan.ready) return;
    const mount: Mount = {
      plan,
      controller: new AbortController(),
      live: true,
    };
    mounted.current = mount;
    return () => {
      // Synchronous retirement precedes the passive cleanup and late promises.
      // Cleanup is not an explicit Human close of the persisted view.
      stop(mount);
      if (mounted.current === mount) mounted.current = null;
    };
  }, [plan]);

  useLayoutEffect(() => {
    const mount = mounted.current;
    // Initial child layout precedes the parent's published-owner layout. Check
    // only an already-created consumer here; creation waits for passive effect.
    if (mount?.consumer && !current(mount)) failed(mount);
  });

  useEffect(() => {
    const mount = mounted.current;
    if (
      !mount?.live ||
      mount.plan !== plan ||
      !plan.source ||
      !container.current
    )
      return;
    try {
      const consumer = createCognitiveDocumentConsumer({
        source: plan.source,
        container: container.current,
        routerPorts: plan.routerPorts,
        current: () => current(mount),
        signal: mount.controller.signal,
        presentation: props.presentation,
        onRetire: () => failed(mount),
      });
      mount.consumer = consumer;
      if (!mount.live) {
        consumer.retire();
        return;
      }
      // Only this component's own outer iframe, never guest Document contents.
      for (const child of container.current.children)
        if (child instanceof HTMLIFrameElement)
          child.className = "cognitive-application-frame";
      void consumer.ready.then((ready) => {
        if (!mount.live || mounted.current !== mount) return;
        if (!ready || !current(mount)) failed(mount);
        else setReadyPlan(plan);
      });
    } catch {
      failed(mount);
    }
  }, [plan]);

  useEffect(() => {
    const mount = mounted.current;
    if (!mount?.live || mount.plan !== plan || !mount.consumer) return;
    void mount.consumer.updatePresentation(props.presentation).catch(() => {
      failed(mount);
    });
  }, [plan, props.presentation]);

  const failedCurrent = failedPlan === plan;
  const showDocument = executable && !failedCurrent;
  const message = failedCurrent
    ? unavailable
    : props.message ||
      (showDocument && readyPlan !== plan ? "正在加载应用界面…" : "");
  return (
    <section className="application-host">
      <div
        ref={container}
        className="application-pane cognitive-document-container"
        hidden={!showDocument}
      />
      {message && (
        <div className="empty-state">
          <p
            role={
              failedCurrent || props.status === "error" ? "alert" : "status"
            }
          >
            {message}
          </p>
          {(!showDocument || failedCurrent) && (
            <div className="empty-state-actions">
              <button
                type="button"
                className="secondary-action"
                onClick={props.onRetry}
              >
                重试
              </button>
              <button
                type="button"
                className="secondary-action"
                onClick={props.onClose}
              >
                返回
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
