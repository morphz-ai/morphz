import { useEffect, useRef, useState } from "react";
import type { WorkspaceClient } from "./client.js";

/** A visible card may ask its owning app for a preview; scrolling alone never
 * loads every original in the catalog. Opening uses the same exact read path. */
export function CatalogPreview({
  id,
  client,
}: {
  id: string;
  client: WorkspaceClient;
}) {
  const root = useRef<HTMLDivElement>(null);
  const resolve = useRef(client.resolveArtifact);
  resolve.current = client.resolveArtifact;
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        void resolve.current(id).catch(() => setFailed(true));
      },
      { rootMargin: "120px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [id]);
  return (
    <div className="artifact-preview" ref={root} aria-live="polite">
      <span>{failed ? "预览暂不可用，仍可打开内容" : "正在载入预览…"}</span>
    </div>
  );
}
