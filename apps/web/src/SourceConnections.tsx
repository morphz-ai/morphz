import { useEffect, useRef, useState } from "react";
import {
  FolderOpen,
  FileText,
  Pause,
  Play,
  RefreshCw,
  Unplug,
} from "lucide-react";
import type { SourceView } from "./desktop.js";

export default function SourceConnections({
  projectId,
}: {
  projectId: string;
}) {
  const api = window.morphzDesktop?.sources;
  const [sources, setSources] = useState<SourceView[]>([]),
    [error, setError] = useState(""),
    [loadError, setLoadError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const operating = useRef(false);
  useEffect(() => {
    if (!api) return;
    let stopped = false,
      refreshing = false;
    const refresh = () => {
      if (operating.current || refreshing) return;
      refreshing = true;
      const current = ++generation.current;
      void api
        .list()
        .then((value) => {
          if (!stopped && current === generation.current) {
            setSources(value);
            setLoadError("");
          }
        })
        .catch(() => {
          if (!stopped && current === generation.current)
            setLoadError("无法读取本机来源授权。已有资料不会受到影响。");
        })
        .finally(() => {
          refreshing = false;
          if (!stopped && current === generation.current) setLoading(false);
        });
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      stopped = true;
      generation.current++;
      clearInterval(timer);
    };
  }, [api, retry]);
  async function run(action: () => Promise<SourceView[]>) {
    operating.current = true;
    const current = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const value = await action();
      if (current === generation.current) setSources(value);
    } catch (e) {
      if (current === generation.current)
        setError(e instanceof Error ? e.message : "来源操作失败。");
    } finally {
      operating.current = false;
      if (current === generation.current) {
        setBusy(false);
        setLoading(false);
      }
    }
  }
  if (!api)
    return (
      <p className="muted">
        持续接入本机资料需要桌面端。当前仍可导入文件副本。
      </p>
    );
  return (
    <section className="source-connections" aria-label="连接来源">
      <p className="muted">持续接入 Markdown 和文本；原文件只读，不会改写。</p>
      <div className="inline">
        <button
          className="secondary-action"
          disabled={busy}
          onClick={() => void run(() => api.choose(projectId, "directory"))}
        >
          <FolderOpen />
          选择目录
        </button>
        <button
          className="secondary-action"
          disabled={busy}
          onClick={() => void run(() => api.choose(projectId, "file"))}
        >
          <FileText />
          选择文件
        </button>
      </div>
      {loading && <p role="status">正在读取来源…</p>}
      {!loading &&
        !error &&
        !loadError &&
        !sources.some((s) => s.projectId === projectId) && (
          <p className="source-empty">
            还没有连接来源。选择文件或文件夹，确认范围后再开始同步。
          </p>
        )}
      {sources
        .filter((s) => s.projectId === projectId)
        .map((source) => (
          <article key={source.id}>
            <div>
              <strong>{source.label}</strong>
              <small>
                {source.count} 篇 · {source.enabled ? "同步已开启" : "已暂停"}
                {source.lastSync
                  ? ` · 最近检查 ${new Date(source.lastSync).toLocaleTimeString("zh-CN")}`
                  : " · 尚未读取内容"}
              </small>
            </div>
            <div className="inline source-actions">
              <button
                className="secondary-action"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    api.control(source.id, source.enabled ? "pause" : "resume"),
                  )
                }
              >
                {source.enabled ? <Pause /> : <Play />}
                {source.enabled
                  ? "暂停同步"
                  : source.lastSync
                    ? "恢复同步"
                    : "开始只读同步"}
              </button>
              <button
                className="secondary-action"
                disabled={busy || !source.enabled}
                aria-label={`检查 ${source.label} 的更新`}
                onClick={() =>
                  void run(() => api.control(source.id, "refresh"))
                }
              >
                <RefreshCw />
              </button>
              <button
                className="secondary-action"
                disabled={busy}
                aria-label={`断开 ${source.label}`}
                onClick={() => {
                  if (
                    window.confirm(
                      "断开来源并停止读取？中心已保存的版本和批注会保留。",
                    )
                  )
                    void run(() => api.control(source.id, "remove"));
                }}
              >
                <Unplug />
              </button>
            </div>
            {source.error && <p role="alert">{source.error}</p>}
          </article>
        ))}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {loadError && (
        <div className="error-banner" role="alert">
          {loadError}
          <button
            disabled={busy}
            onClick={() => {
              setLoading(true);
              setRetry((value) => value + 1);
            }}
          >
            重新读取
          </button>
        </div>
      )}
      <details className="source-explanation">
        <summary>同步如何工作</summary>
        <p>
          确认开始后，每 15
          秒检查已授权范围。退出桌面停止检查，重开后接续；暂停或断开不会删除已保存的资料和批注。
        </p>
      </details>
    </section>
  );
}
