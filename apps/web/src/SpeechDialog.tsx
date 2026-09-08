import { useModal } from "./useModal.js";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Mic,
  Square,
  X,
  Volume2,
  Pause,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import {
  scopedStorage,
  type SpeechScope,
  type WorkspaceClient,
} from "./client.js";
import { SpeechCapture } from "./speech-capture.js";
import { SpeechQueue } from "./speech-queue.js";
import { ReadAloud, type ReaderState } from "./read-aloud.js";
import {
  readingChunks,
  readingChapters,
} from "../../../packages/core/src/reading.js";

export function SpeechDialog({
  client,
  scope,
  title,
  onClose,
  onInsert,
}: {
  client: WorkspaceClient;
  scope: SpeechScope;
  title: string;
  onClose(): void;
  onInsert(text: string): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    capture = useRef<SpeechCapture | null>(null),
    timer = useRef<ReturnType<typeof setInterval> | null>(null),
    alive = useRef(true),
    epoch = useRef(0);
  const [phase, setPhase] = useState<
      "idle" | "permission" | "recording" | "finishing"
    >("idle"),
    [seconds, setSeconds] = useState(0),
    [text, setText] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [pending, setPending] = useState(0),
    [configured, setConfigured] = useState<boolean | null>(null),
    [saving, setSaving] = useState(false);
  const queue = useRef<SpeechQueue | null>(null);
  function makeQueue() {
    return new SpeechQueue({
      transcribe: (wav, signal) => client.transcribe(scope, wav, signal),
      text: (value) => {
        if (alive.current)
          setText((previous) => (previous ? previous + "\n" + value : value));
      },
      changed: (count, message) => {
        if (alive.current) {
          setPending(count);
          if (message) setError(message);
        }
      },
      pressure: () => {
        if (alive.current && capture.current) {
          setNotice(
            "识别暂时跟不上，已暂停采集；待处理语音和文字保留，处理完成后可继续。",
          );
          void finish();
        }
      },
    });
  }
  function clearTimer() {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }
  function cancel() {
    epoch.current++;
    capture.current?.cancel();
    capture.current = null;
    clearTimer();
    queue.current?.cancel();
  }
  async function finish() {
    const current = capture.current;
    if (!current) return;
    capture.current = null;
    clearTimer();
    setPhase("finishing");
    try {
      await current.finish();
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : "语音输入结束失败。");
    } finally {
      if (alive.current) setPhase("idle");
    }
  }
  useModal(dialog);
  useEffect(() => {
    alive.current = true;
    queue.current = makeQueue();

    const controller = new AbortController();
    void client
      .speechStatus(controller.signal)
      .then((s) => setConfigured(s.configured))
      .catch(() => {
        if (!controller.signal.aborted)
          setError("无法读取语音配置，请检查中心连接。");
      });
    const hidden = () => {
      if (document.hidden && capture.current) {
        setNotice("窗口已隐藏，麦克风已停止；正在收尾已采集的语音。");
        void finish();
      }
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      alive.current = false;
      controller.abort();
      cancel();
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  async function start() {
    const token = ++epoch.current;
    setError("");
    setNotice("");
    setPhase("permission");
    const current = new SpeechCapture(
      (wav) => queue.current!.enqueue(wav),
      (message) => {
        if (alive.current) {
          setError(message);
          void finish();
        }
      },
    );
    capture.current = current;
    try {
      await current.start();
      if (
        !alive.current ||
        token !== epoch.current ||
        capture.current !== current
      ) {
        current.cancel();
        return;
      }
      const started = Date.now(),
        previous = seconds;
      timer.current = setInterval(
        () => setSeconds(previous + Math.floor((Date.now() - started) / 1000)),
        200,
      );
      setPhase("recording");
    } catch (e) {
      if (alive.current && token === epoch.current) {
        capture.current = null;
        setPhase("idle");
        setError(e instanceof Error ? e.message : "无法开始语音输入。");
      }
    }
  }
  const active = phase !== "idle",
    busy = active || pending > 0 || saving;
  return (
    <dialog
      ref={dialog}
      className="create-dialog voice-dialog"
      aria-label="语音输入"
      onCancel={(e) => {
        e.preventDefault();
        cancel();
        onClose();
      }}
    >
      <header>
        <div>
          <h2>语音输入</h2>
          <small>
            {title}
            {scope.revision ? " · v" + scope.revision : ""}
          </small>
        </div>
        <button
          aria-label="关闭语音输入"
          onClick={() => {
            cancel();
            onClose();
          }}
        >
          <X />
        </button>
      </header>
      <p className="muted">
        开始后，语音会自动分段发送给豆包转为文字，可以持续表达。停止后检查文字，再放入输入框；不会自动发送给
        Agent。关闭会丢弃临时语音和未保存文字。
      </p>
      {configured === false && <p role="status">中心尚未配置豆包语音服务。</p>}
      <div className="voice-recorder" data-recording={phase === "recording"}>
        <Mic />
        <strong>
          {phase === "recording"
            ? "正在录音"
            : phase === "permission"
              ? "等待麦克风授权"
              : phase === "finishing"
                ? "正在结束采集"
                : pending
                  ? "正在转为文字"
                  : "准备语音输入"}
        </strong>
        <span>
          {String(Math.floor(seconds / 60)).padStart(2, "0")}:
          {String(seconds % 60).padStart(2, "0")}
        </span>
      </div>
      <div className="inline">
        {phase === "recording" ? (
          <button onClick={() => void finish()}>
            <Square />
            结束录音
          </button>
        ) : (
          <button
            disabled={busy || configured !== true}
            onClick={() => void start()}
          >
            <Mic />
            {seconds ? "继续输入" : "开始录音"}
          </button>
        )}
        {error && pending > 0 && !active && (
          <button
            onClick={() => {
              setError("");
              queue.current!.retry();
            }}
          >
            重试识别
          </button>
        )}
        {pending > 0 && !active && (
          <button
            onClick={() => {
              queue.current!.cancel();
              queue.current = makeQueue();
              setPending(0);
              setError("");
              setNotice("已放弃待识别语音，已识别的文字保留。");
            }}
          >
            放弃待识别语音
          </button>
        )}
        {pending > 0 && <small role="status">待识别 {pending} 段</small>}
      </div>
      <label className="field">
        确认文字
        <textarea
          aria-label="语音识别文字"
          placeholder="识别的文字会逐段出现在这里…"
          rows={7}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {notice && (
        <p role="status" className="muted">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <footer>
        <button
          onClick={() => {
            cancel();
            onClose();
          }}
        >
          取消
        </button>
        <button
          disabled={busy || !text.trim()}
          onClick={async () => {
            setSaving(true);
            setError("");
            try {
              await client.execute({
                type: "create-artifact",
                projectId: scope.projectId,
                title: title.slice(0, 160) + " · 语音记录",
                content: { kind: "document", markdown: text },
              });
              cancel();
              onClose();
            } catch (e) {
              setError(e instanceof Error ? e.message : "保存失败。");
            } finally {
              setSaving(false);
            }
          }}
        >
          保存为文档
        </button>
        <button
          className="primary"
          disabled={busy || !text.trim()}
          onClick={() => {
            try {
              onInsert(text);
            } catch (e) {
              setError(e instanceof Error ? e.message : "无法放入输入框。");
            }
          }}
        >
          放入输入框
        </button>
      </footer>
    </dialog>
  );
}

export function ReadAloudDialog({
  client,
  scope,
  title,
  source,
  onClose,
}: {
  client: WorkspaceClient;
  scope: SpeechScope;
  title: string;
  source: string;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    player = useRef<ReadAloud | null>(null);
  const chunks = useMemo(() => readingChunks(source), [source]);
  const chapters = useMemo(
    () => readingChapters(source, chunks),
    [source, chunks],
  );
  const [state, setState] = useState<ReaderState>({
      index: 0,
      seconds: 0,
      rate: 1,
      complete: false,
      phase: "idle",
      error: "",
    }),
    [ready, setReady] = useState(false),
    [storageError, setStorageError] = useState("");
  const [storage] = useState(() => scopedStorage());
  useModal(dialog);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(source),
      );
      if (cancelled) return;
      const hash = Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      const key =
        "reading:" +
        (scope.artifactId ?? scope.projectId) +
        ":" +
        (scope.revision ?? 0) +
        ":" +
        hash;
      const reader = new ReadAloud({
        source,
        chunks,
        progress: storage.readLocal(key, null),
        synthesize: (text, signal) => client.synthesize(scope, text, signal),
        changed: (next) => {
          if (!cancelled) setState({ ...next });
        },
        save: (progress) => {
          try {
            storage.writeLocal(key, progress);
          } catch {
            if (!cancelled)
              setStorageError("无法保存本机朗读进度，本次仍可继续听。");
          }
        },
      });
      player.current = reader;
      setState({ ...reader.state });
      setReady(true);
    })().catch(() => {
      if (!cancelled) setStorageError("无法准备朗读，请重新打开。");
    });
    // Switching applications is normal while listening; closing saves and stops.
    return () => {
      cancelled = true;
      player.current?.dispose();
      player.current = null;
    };
  }, []);
  const active = state.phase === "loading" || state.phase === "playing";
  const chunk = chunks[state.index];
  function seek(index: number) {
    player.current?.seek(index);
  }
  return (
    <dialog
      ref={dialog}
      className="create-dialog voice-dialog"
      aria-label="朗读对象"
      onCancel={(e) => {
        e.preventDefault();
        player.current?.dispose();
        onClose();
      }}
    >
      <header>
        <div>
          <h2>朗读</h2>
          <small>
            {title} · v{scope.revision}
          </small>
        </div>
        <button aria-label="关闭朗读" onClick={onClose}>
          <X />
        </button>
      </header>
      <p className="muted">
        自动分段连续朗读，只合成当前内容并预加载下一段。暂停或关闭后停止后续合成，进度保存在当前设备；文字会发送给豆包，按实际合成量使用服务额度。
      </p>
      <div className="reading-controls">
        <label className="field">
          朗读进度
          <input
            aria-label="朗读进度"
            type="range"
            min={0}
            max={Math.max(0, chunks.length - 1)}
            value={state.index}
            disabled={!ready}
            onChange={(e) => seek(Number(e.target.value))}
          />
        </label>
        <small role="status">
          {state.phase === "loading"
            ? "正在合成当前段 · "
            : state.phase === "playing"
              ? "正在朗读 · "
              : state.phase === "paused"
                ? "已暂停 · "
                : ""}
          {state.complete
            ? "已读完"
            : "第 " +
              (chunks.length ? state.index + 1 : 0) +
              " / " +
              chunks.length +
              " 段"}
          {state.seconds ? " · 本段 " + Math.floor(state.seconds) + " 秒" : ""}{" "}
          · 共 {source.length.toLocaleString()} 字符
        </small>
        <div className="inline">
          {chapters.length > 0 && (
            <label>
              章节{" "}
              <select
                aria-label="朗读章节"
                value=""
                disabled={!ready}
                onChange={(e) => seek(Number(e.target.value))}
              >
                <option value="" disabled>
                  跳转章节
                </option>
                {chapters.map((c, i) => (
                  <option key={i} value={c.chunk}>
                    {c.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            语速{" "}
            <select
              aria-label="朗读语速"
              value={state.rate}
              disabled={!ready}
              onChange={(e) => player.current?.rate(Number(e.target.value))}
            >
              {[0.75, 1, 1.25, 1.5, 2].map((rate) => (
                <option key={rate} value={rate}>
                  {rate}×
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <label className="field">
        当前段落
        <textarea
          aria-label="朗读文字"
          value={chunk ? source.slice(chunk.start, chunk.end) : ""}
          readOnly
          rows={7}
        />
      </label>
      {(state.error || storageError) && (
        <p role="alert" className="error">
          {state.error || storageError}
        </p>
      )}
      <footer>
        <button onClick={onClose}>关闭</button>
        <button
          aria-label="上一段"
          disabled={!ready || state.index === 0}
          onClick={() => seek(state.index - 1)}
        >
          <ChevronLeft />
        </button>
        <button
          aria-label="下一段"
          disabled={!ready || state.index + 1 >= chunks.length}
          onClick={() => seek(state.index + 1)}
        >
          <ChevronRight />
        </button>
        {active ? (
          <>
            <button onClick={() => player.current?.pause()}>
              <Pause />
              暂停朗读
            </button>
            <button onClick={() => player.current?.stop()}>
              <Square />
              停止朗读
            </button>
          </>
        ) : (
          <button
            className="primary"
            disabled={!ready || !source.trim()}
            onClick={() => void player.current?.play()}
          >
            <Volume2 />
            {state.complete
              ? "从头朗读"
              : state.phase === "paused" || state.index > 0 || state.seconds > 0
                ? "继续朗读"
                : "朗读"}
          </button>
        )}
      </footer>
    </dialog>
  );
}
