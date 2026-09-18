import { useModal } from "./useModal.js";
import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import {
  Mic,
  Square,
  X,
  Pause,
  ChevronLeft,
  ChevronRight,
  Play,
  ListMusic,
  LoaderCircle,
  Info,
} from "lucide-react";
import {
  scopedStorage,
  type SpeechScope,
  type WorkspaceClient,
} from "./client.js";
import { SpeechCapture } from "./speech-capture.js";
import { SpeechQueue } from "./speech-queue.js";
import { LiveDictation } from "./live-dictation.js";
import { speechFrameMilliseconds } from "../../../packages/core/src/speech-stream.js";
import { ReadAloud, type ReaderState } from "./read-aloud.js";
import { SpeechServiceDetails } from "./SpeechServiceDetails.js";
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
  inlineTarget,
  onTranscript,
  controls,
  onRecording,
  transcriptLimit = 30000,
}: {
  inlineTarget?: HTMLElement;
  onTranscript?: (text: string, previous: string) => void;
  transcriptLimit?: number;
  controls?: Ref<{ toggle(): void; interrupt(): void }>;
  onRecording?: (recording: boolean) => void;
  client: WorkspaceClient;
  scope: SpeechScope;
  title: string;
  onClose(): void;
  onInsert(text: string): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    consentDialog = useRef<HTMLDialogElement>(null),
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
    [attempt, setAttempt] = useState({ finished: false, hasText: false }),
    [configured, setConfigured] = useState<boolean | null>(null),
    [service, setService] = useState<{
      provider: string;
      label: string;
    } | null>(null),
    [consentOpen, setConsentOpen] = useState(false),
    [level, setLevel] = useState(0),
    [saving, setSaving] = useState(false);
  const [storage] = useState(() => scopedStorage());
  const consentKey = (provider: string) => `dictation-consent:v1:${provider}`;
  const queue = useRef<SpeechQueue | null>(null);
  const live = useRef<LiveDictation | null>(null);
  function makeQueue() {
    return new SpeechQueue({
      transcribe: (wav, signal) => client.transcribe(scope, wav, signal),
      text: (value) => {
        if (alive.current) {
          setAttempt((previous) => ({ ...previous, hasText: true }));
          setText((previous) => (previous ? previous + "\n" + value : value));
        }
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
    live.current?.cancel();
    live.current = null;
  }
  async function finish() {
    const current = capture.current;
    if (!current) return;
    const token = epoch.current,
      session = live.current;
    capture.current = null;
    clearTimer();
    setPhase("finishing");
    try {
      await current.finish();
      await session?.finish();
      if (alive.current && token === epoch.current)
        setAttempt((previous) => ({ ...previous, finished: true }));
    } catch (e) {
      session?.cancel();
      if (alive.current && token === epoch.current)
        setError(e instanceof Error ? e.message : "语音输入结束失败。");
    } finally {
      if (alive.current && token === epoch.current) setPhase("idle");
    }
  }
  useModal(dialog, undefined, !inlineTarget);
  useModal(consentDialog, undefined, !!inlineTarget && consentOpen);
  useEffect(() => {
    onRecording?.(phase === "recording");
  }, [phase]);
  useImperativeHandle(controls, () => ({
    interrupt() {
      if (phase === "idle") return;
      cancel();
      setPhase("idle");
      setNotice("已停止听写，继续编辑即可。");
    },
    toggle() {
      if (phase === "permission") {
        cancel();
        setPhase("idle");
      } else if (capture.current) void finish();
      else if (!busy) requestStart();
    },
  }));
  useEffect(() => {
    alive.current = true;
    queue.current = makeQueue();

    const controller = new AbortController();
    void client
      .speechStatus(controller.signal)
      .then((s) => {
        if (controller.signal.aborted) return;
        setConfigured(
          s.configured &&
            !!s.provider &&
            (!inlineTarget || s.streaming === true),
        );
        if (!s.configured || !s.provider) return;
        if (inlineTarget && !s.streaming) {
          setError("当前语音服务不支持实时听写，请检查服务配置。");
          return;
        }
        const next = {
          provider: s.provider,
          label:
            s.providerLabel || (s.provider === "doubao" ? "豆包" : s.provider),
        };
        setService(next);
        if (inlineTarget) {
          // Only a previously approved, named service may start immediately.
          // This record is local to the current center and principal.
          if (storage.readLocal(consentKey(next.provider), false)) void start();
          else setConsentOpen(true);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("无法读取语音配置，请重试。");
      });
    const hidden = () => {
      if (document.hidden && (capture.current || live.current?.active)) {
        if (inlineTarget) {
          cancel();
          setPhase("idle");
          setNotice("窗口已隐藏，听写已停止；已识别文字保留。");
        } else {
          setNotice("窗口已隐藏，麦克风已停止；正在收尾已采集的语音。");
          void finish();
        }
      }
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      alive.current = false;
      controller.abort();
      cancel();
      onRecording?.(false);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  function requestStart() {
    if (!service || !configured || busy) return;
    if (inlineTarget && !storage.readLocal(consentKey(service.provider), false))
      setConsentOpen(true);
    else void start();
  }
  async function start() {
    if (!alive.current || document.hidden || capture.current) return;
    const token = ++epoch.current;
    setError("");
    setNotice("");
    setAttempt({ finished: false, hasText: false });
    setPhase("permission");
    let session: LiveDictation | undefined;
    if (inlineTarget) {
      let call: ReturnType<WorkspaceClient["createSpeechStream"]>;
      try {
        call = client.createSpeechStream(scope);
      } catch {
        setPhase("idle");
        setError("应用连接已变化，请重新开始听写。");
        return;
      }
      session = new LiveDictation(
        call,
        (value, previous) => {
          if (!alive.current || token !== epoch.current) return;
          if (value.length > transcriptLimit)
            throw new Error(
              "输入框已达长度上限，听写已停止；已显示文字保留，请先发送或整理。",
            );
          onTranscript?.(value, previous);
          setAttempt((old) => ({ ...old, hasText: !!value.trim() }));
        },
        (message) => {
          if (!alive.current || token !== epoch.current) return;
          capture.current?.cancel();
          capture.current = null;
          clearTimer();
          setError(message);
          setPhase("idle");
        },
        () => {
          if (!alive.current || token !== epoch.current) return;
          capture.current?.cancel();
          capture.current = null;
          clearTimer();
          setAttempt((old) => ({ ...old, finished: true }));
          setPhase("idle");
        },
      );
      live.current = session;
    }
    const current = new SpeechCapture(
      (wav) => queue.current!.enqueue(wav),
      (message) => {
        if (alive.current) {
          setError(message);
          void finish();
        }
      },
      (value) => {
        if (alive.current) setLevel(value);
      },
      session
        ? {
            frameSeconds: speechFrameMilliseconds / 1000,
            pcm: (data) => session!.enqueue(data),
          }
        : undefined,
    );
    capture.current = current;
    try {
      await current.start();
      if (
        alive.current &&
        token === epoch.current &&
        capture.current === current
      )
        await session?.start();
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
        session?.cancel();
        capture.current = null;
        setPhase("idle");
        setError(e instanceof Error ? e.message : "无法开始语音输入。");
      }
    }
  }
  const active = phase !== "idle",
    busy = active || pending > 0 || saving,
    emptyResult =
      attempt.finished &&
      !attempt.hasText &&
      !active &&
      pending === 0 &&
      !error;
  if (inlineTarget && consentOpen)
    return (
      <dialog
        ref={consentDialog}
        className="create-dialog dictation-consent"
        aria-label="语音输入授权"
        onCancel={(event) => {
          event.preventDefault();
          setConsentOpen(false);
          onClose();
        }}
      >
        <header>
          <h2>使用{service?.label}识别录音</h2>
        </header>
        <p>
          录音持续分段发送至{service?.label}，可能消耗服务额度。
          停止、关闭或离开输入区后结束收音。授权将记在本机，可随时撤销。
        </p>
        <footer>
          <button
            onClick={() => {
              setConsentOpen(false);
              onClose();
            }}
          >
            暂不启用
          </button>
          <button
            className="primary"
            disabled={!service}
            onClick={() => {
              if (!service) return;
              try {
                storage.writeLocal(consentKey(service.provider), true);
              } catch {
                setError("无法保存语音授权，尚未开启麦克风。");
                return;
              }
              setConsentOpen(false);
              void start();
            }}
          >
            允许并开始听写
          </button>
        </footer>
        {service && storage.readLocal(consentKey(service.provider), false) && (
          <button
            onClick={() => {
              try {
                storage.writeLocal(consentKey(service.provider), false);
              } catch {
                setError("无法撤销语音授权，请检查本机存储。");
                return;
              }
              setConsentOpen(false);
              onClose();
            }}
          >
            撤销一键听写授权
          </button>
        )}
        {error && <p role="alert">{error}</p>}
      </dialog>
    );
  if (inlineTarget)
    return createPortal(
      <section
        className="inline-dictation"
        aria-label="听写"
        data-recording={phase === "recording"}
      >
        <div className="dictation-controls">
          <Mic aria-hidden="true" />
          <span role="status">
            {phase === "recording"
              ? `正在听写 ${seconds}s`
              : phase === "permission"
                ? "正在连接麦克风与语音服务…"
                : phase === "finishing"
                  ? "正在结束听写…"
                  : pending
                    ? `正在识别 ${pending} 段`
                    : emptyResult
                      ? "未识别到文字，可重新听写"
                      : configured === null
                        ? "正在连接语音服务…"
                        : "听写已停止"}
          </span>
          {phase === "recording" && (
            <meter
              className="dictation-level"
              aria-label="麦克风音量"
              min={0}
              max={1}
              value={level}
            />
          )}
          {phase === "recording" ? (
            <button onClick={() => void finish()}>
              <Square />
              停止听写
            </button>
          ) : (
            <button
              disabled={busy || configured !== true}
              onClick={requestStart}
            >
              开始听写
            </button>
          )}
          <button
            aria-label="语音服务与授权"
            title={`语音服务：${service?.label ?? "未配置"} · 管理授权`}
            disabled={busy || !service}
            onClick={() => {
              setError("");
              setConsentOpen(true);
            }}
          >
            <Info />
          </button>
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
          <button
            aria-label="关闭听写"
            title="停止采集；已识别文字保留，未识别语音丢弃"
            onClick={() => {
              cancel();
              onClose();
            }}
          >
            <X />
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {configured === false && !error && (
          <p role="status">尚未配置语音服务。</p>
        )}
      </section>,
      inlineTarget,
    );
  return (
    <dialog
      ref={dialog}
      className="create-dialog voice-dialog"
      aria-label="录音转文字"
      onCancel={(e) => {
        e.preventDefault();
        cancel();
        onClose();
      }}
    >
      <header>
        <div>
          <h2>录音转文字</h2>
          <small>
            {title}
            {scope.revision ? " · v" + scope.revision : ""}
          </small>
        </div>
        <button
          aria-label="关闭录音转文字"
          onClick={() => {
            cancel();
            onClose();
          }}
        >
          <X />
        </button>
      </header>
      <SpeechServiceDetails client={client} mode="dictate" />
      {configured === false && <p role="status">尚未配置语音服务。</p>}
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
                  : emptyResult
                    ? "未识别到文字，可重新录音"
                    : "未录音"}
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
              setAttempt({ finished: false, hasText: false });
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
          placeholder="转写文字"
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
        {!!text.trim() && <small>关闭将丢弃未保存的转写</small>}
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
  const player = useRef<ReadAloud | null>(null);
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
      duration: null,
    }),
    [ready, setReady] = useState(false),
    [storageError, setStorageError] = useState(""),
    [detailsOpen, setDetailsOpen] = useState(false);
  const [storage] = useState(() => scopedStorage());
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
  const single = chunks.length <= 1;
  const fraction = state.duration
    ? Math.min(1, state.seconds / state.duration)
    : 0;
  const progressMax = single ? (state.duration ?? 1) : chunks.length;
  const progress = state.complete
    ? progressMax
    : single
      ? state.duration
        ? state.seconds
        : 0
      : state.index + fraction;
  const time = (seconds: number) =>
    `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  const playLabel = state.complete
    ? "从头朗读"
    : state.phase === "paused" || state.index > 0 || state.seconds > 0
      ? "继续朗读"
      : "朗读";
  return (
    <section className="read-aloud-player" aria-label="朗读对象">
      <div className="reading-transport">
        <button
          className="reading-play"
          aria-label={active ? "暂停朗读" : playLabel}
          title={active ? "暂停朗读" : playLabel}
          disabled={!ready || !source.trim()}
          onClick={() =>
            active ? player.current?.pause() : void player.current?.play()
          }
        >
          {state.phase === "loading" ? (
            <LoaderCircle className="reading-loading" />
          ) : active ? (
            <Pause />
          ) : (
            <Play />
          )}
        </button>
        <div className="reading-timeline">
          <div className="reading-status-line">
            <span role="status">
              {state.phase === "loading"
                ? "正在准备声音…"
                : state.complete
                  ? "已读完"
                  : state.phase === "playing"
                    ? "正在朗读"
                    : state.phase === "paused"
                      ? "已暂停"
                      : state.phase === "error"
                        ? "朗读未完成"
                        : "未播放"}
            </span>
            <span className="reading-time">
              {!single && `${state.index + 1}/${chunks.length} 段 · `}
              {time(
                state.complete
                  ? (state.duration ?? state.seconds)
                  : state.seconds,
              )}
              {single && ` / ${state.duration ? time(state.duration) : "—:—"}`}
            </span>
          </div>
          <input
            aria-label="朗读进度"
            aria-valuetext={
              single
                ? `${time(state.seconds)} / ${state.duration ? time(state.duration) : "尚未加载"}`
                : `第 ${state.index + 1} / ${chunks.length} 段，本段 ${time(state.seconds)}`
            }
            type="range"
            min={0}
            max={progressMax}
            step={single ? 0.05 : 0.001}
            value={Math.min(progress, progressMax)}
            disabled={!ready || (single && !state.duration)}
            style={{
              backgroundSize: `${100 * Math.min(progress / progressMax, 1)}% 3px`,
            }}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (single) player.current?.seekSeconds(value);
              else {
                const index = Math.min(chunks.length - 1, Math.floor(value));
                if (index === state.index && state.duration)
                  player.current?.seekSeconds((value - index) * state.duration);
                else seek(index);
              }
            }}
          />
        </div>
        <select
          className="reading-rate"
          aria-label="朗读语速"
          title="朗读语速"
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
        <button
          className="reading-details-toggle"
          aria-label="朗读内容与章节"
          aria-expanded={detailsOpen}
          title="朗读内容与章节"
          onClick={() => setDetailsOpen(!detailsOpen)}
        >
          <ListMusic />
        </button>
        <button
          aria-label="关闭朗读"
          title="停止朗读并关闭，保留位置"
          onClick={onClose}
        >
          <X />
        </button>
      </div>
      {detailsOpen && (
        <div className="reading-details">
          <div className="reading-source">
            <span title={title}>{title}</span>
            <small>
              {scope.revision ? `v${scope.revision} · ` : ""}
              {source.length.toLocaleString()} 字符
            </small>
          </div>
          {(chapters.length > 0 ||
            !single ||
            active ||
            state.phase === "paused") && (
            <div className="reading-navigation">
              {chapters.length > 0 && (
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
              )}
              {!single && (
                <>
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
                </>
              )}
              {(active || state.phase === "paused") && (
                <button
                  disabled={!ready}
                  onClick={() => player.current?.stop()}
                >
                  <Square />
                  停止朗读
                </button>
              )}
            </div>
          )}
          <p className="reading-passage" aria-label="朗读文字">
            {chunk ? source.slice(chunk.start, chunk.end) : ""}
          </p>
          <SpeechServiceDetails client={client} mode="read" />
        </div>
      )}
      {(state.error || storageError) && (
        <p role="alert" className="error">
          {state.error || storageError}
        </p>
      )}
    </section>
  );
}
