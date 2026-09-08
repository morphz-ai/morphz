import { useEffect, useRef, useState } from "react";
import { ArrowLeft, RotateCw, Hand, Globe, ShieldCheck } from "lucide-react";
import type { Artifact } from "../../../packages/core/src/model.js";
import type { BrowserView } from "./desktop.js";

export function BrowserHost({ artifact }: { artifact: Artifact }) {
  const desktop = window.morphzDesktop?.browser;
  const slot = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<BrowserView | null>(null),
    [url, setURL] = useState(""),
    [error, setError] = useState(""),
    [opening, setOpening] = useState(false);
  const active = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    if (page?.url) setURL(page.url);
  }, [page?.url]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (active.current) void desktop?.close(active.current).catch(() => {});
    };
  }, [desktop]);
  useEffect(() => {
    if (!desktop || !page) return;
    const id = page.pageId;
    const update = () => {
      const r = slot.current?.getBoundingClientRect();
      const hidden =
        document.hidden ||
        !!document.querySelector("dialog[open],.theme-menu") ||
        !r ||
        r.width < 10 ||
        r.height < 10 ||
        r.bottom < 120;
      void desktop
        .layout(
          id,
          hidden ? null : { x: r.x, y: r.y, width: r.width, height: r.height },
        )
        .catch(() => {});
    };
    const observer = new ResizeObserver(update);
    if (slot.current) observer.observe(slot.current);
    const modal = new MutationObserver(update);
    modal.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    document.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    document.addEventListener("visibilitychange", update);
    const timer = setInterval(() => {
      update();
      void desktop
        .state()
        .then((next) => {
          if (next?.pageId === id) setPage(next);
        })
        .catch(() => {});
    }, 600);
    update();
    return () => {
      observer.disconnect();
      modal.disconnect();
      clearInterval(timer);
      document.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      document.removeEventListener("visibilitychange", update);
      void desktop.layout(id, null).catch(() => {});
    };
  }, [desktop, page?.pageId]);
  async function control(
    action: "grant" | "takeover" | "back" | "reload" | "approve" | "reject",
  ) {
    if (!desktop || !page) return;
    try {
      setError("");
      setPage(await desktop.control(page.pageId, action));
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败。");
    }
  }
  return (
    <section className="browser-host">
      {!page ? (
        <div className="browser-start">
          <Globe size={30} />
          <p>
            {artifact.content.kind === "website" ? artifact.content.url : ""}
          </p>
          <p className="muted">
            网站使用独立的浏览器配置。登录由你完成；开启协助后，Agent
            可读取和填写页面，点击需逐次确认。
          </p>
          <button
            className="primary"
            disabled={!desktop || opening}
            onClick={async () => {
              if (!desktop) return;
              setOpening(true);
              try {
                const p = await desktop.open(artifact.id);
                if (!mounted.current) {
                  await desktop.close(p.pageId);
                  return;
                }
                active.current = p.pageId;
                setPage(p);
                setURL(p.url);
              } catch (e) {
                if (mounted.current)
                  setError(e instanceof Error ? e.message : "打开失败。");
              } finally {
                if (mounted.current) setOpening(false);
              }
            }}
          >
            {!desktop
              ? "请在桌面应用中打开网站"
              : opening
                ? "打开中…"
                : "打开内置浏览器"}
          </button>
        </div>
      ) : (
        <>
          <div className="browser-toolbar">
            <button aria-label="网页后退" onClick={() => void control("back")}>
              <ArrowLeft />
            </button>
            <button
              aria-label="重新载入网页"
              onClick={() => void control("reload")}
            >
              <RotateCw />
            </button>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  setPage(await desktop!.navigate(page.pageId, url));
                } catch (err) {
                  setError(err instanceof Error ? err.message : "地址无效。");
                }
              }}
            >
              <input
                aria-label="网站地址"
                value={url}
                onChange={(e) => setURL(e.target.value)}
              />
              <button>前往</button>
            </form>
            <button
              className={page.granted ? "primary" : ""}
              onClick={() => void control(page.granted ? "takeover" : "grant")}
            >
              {page.granted ? <Hand /> : <ShieldCheck />}
              {page.granted ? "我来接管" : "允许 Agent 协助"}
            </button>
          </div>
          <div className="browser-status">
            {page.granted
              ? "Agent 可读取与填写 · 点击需确认 · 操作网页即接管"
              : "由你操作 · Agent 当前无权读取"}
            <span title={page.url}>{page.url}</span>
          </div>
          {page.pending && (
            <div className="browser-confirm" role="status">
              <span>
                Agent 请求点击：
                <strong>{page.pending.label || "无名称元素"}</strong>
                。请核对页面及填写内容。
              </span>
              <button onClick={() => void control("reject")}>拒绝</button>
              <button
                className="primary"
                onClick={() => void control("approve")}
              >
                允许这次点击
              </button>
            </div>
          )}
          <div
            ref={slot}
            className="browser-slot"
            aria-label="隔离的网页区域"
          />
        </>
      )}
      {(error || page?.error) && (
        <p role="alert" className="form-error">
          {error || page?.error}
        </p>
      )}
    </section>
  );
}
