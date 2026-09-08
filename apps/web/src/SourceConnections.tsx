import { useEffect, useState } from "react";
import {
  FolderOpen,
  FileText,
  Link2,
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
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!api) return;
    let stopped = false;
    const refresh = () =>
      void api
        .list()
        .then((value) => {
          if (!stopped) setSources(value);
        })
        .catch(() => {
          if (!stopped) setError("无法读取本机来源授权。");
        });
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [api]);
  async function run(action: () => Promise<SourceView[]>) {
    setBusy(true);
    setError("");
    try {
      setSources(await action());
    } catch (e) {
      setError(e instanceof Error ? e.message : "来源操作失败。");
    } finally {
      setBusy(false);
    }
  }
  if (!api)
    return (
      <p className="muted">
        持续接入本机资料需要桌面端。当前仍可导入文件副本。
      </p>
    );
  return (
    <section className="source-connections">
      <h3>
        <Link2 />
        外部资料来源
      </h3>
      <p className="muted">
        只读接入 Markdown 和文本。在下方确认开始后，桌面每 15
        秒检查一次所选范围。原文件不会被改写；退出桌面后停止检查，重开后接续。
      </p>
      <div className="inline">
        <button
          disabled={busy}
          onClick={() => void run(() => api.choose(projectId, "directory"))}
        >
          <FolderOpen />
          选择目录
        </button>
        <button
          disabled={busy}
          onClick={() => void run(() => api.choose(projectId, "file"))}
        >
          <FileText />
          选择文件
        </button>
      </div>
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
            {source.error && <p role="alert">{source.error}</p>}
            <div className="inline">
              <button
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
                disabled={busy || !source.enabled}
                aria-label={`检查 ${source.label} 的更新`}
                onClick={() =>
                  void run(() => api.control(source.id, "refresh"))
                }
              >
                <RefreshCw />
              </button>
              <button
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
          </article>
        ))}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
