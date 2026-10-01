import { useEffect, useRef, useState } from "react";
import type { WorkspaceClient } from "./client.js";
import type { ScriptLibraryEntry, ScriptOverview } from "./platform-client.js";

/** A card asks the owning application for its small overview only while it
 * is actually on screen. The directory itself contains no creative state. */
export function useVisibleScriptOverview<T extends HTMLElement>(
  client: WorkspaceClient,
  entry: ScriptLibraryEntry,
) {
  const element = useRef<T>(null);
  const read = useRef(client.readScriptOverview);
  read.current = client.readScriptOverview;
  const [visible, setVisible] = useState(false);
  const [result, setResult] = useState<{
    key: string;
    overview?: ScriptOverview;
    error?: boolean;
  }>();
  const key = `${client.boot?.csrfToken ?? ""}:${entry.contentId}:${entry.catalogRevision}:${entry.activityRevision}`;

  useEffect(() => {
    if (visible) return;
    const node = element.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        setVisible(true);
      },
      { rootMargin: "120px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [entry.contentId, visible]);

  useEffect(() => {
    if (!visible || !client.boot) return;
    let current = true;
    void read.current(entry).then(
      (overview) => {
        if (current) setResult({ key, overview });
      },
      () => {
        if (current) setResult({ key, error: true });
      },
    );
    return () => {
      current = false;
    };
  }, [entry.contentId, key, visible]);

  return {
    element,
    overview: result?.key === key ? result.overview : undefined,
    error: result?.key === key && result.error === true,
  };
}
