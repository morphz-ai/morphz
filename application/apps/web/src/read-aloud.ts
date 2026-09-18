import {
  readingProgress,
  type ReadingChunk,
  type ReadingProgress,
} from "../../../packages/core/src/reading.js";

export type ReaderState = ReadingProgress & {
  phase: "idle" | "loading" | "playing" | "paused" | "ended" | "error";
  error: string;
  duration: number | null;
};
type Cached = {
  controller: AbortController;
  settled: boolean;
  result: Promise<{ blob?: Blob; error?: unknown }>;
};
type Options = {
  source: string;
  chunks: ReadingChunk[];
  progress: unknown;
  synthesize(text: string, signal: AbortSignal): Promise<Blob>;
  changed(state: ReaderState): void;
  save(progress: ReadingProgress): void;
  audio?: () => HTMLAudioElement;
};

/** At most current + next audio in memory/network. Pausing never spends on more pages. */
export class ReadAloud {
  state: ReaderState;
  private cache = new Map<number, Cached>();
  private player: HTMLAudioElement | null = null;
  private url: string | null = null;
  private generation = 0;
  private disposed = false;
  constructor(private options: Options) {
    const progress = readingProgress(options.progress, options.chunks.length);
    this.state = {
      ...progress,
      phase: progress.complete ? "ended" : "idle",
      error: "",
      duration: null,
    };
  }
  private publish(patch: Partial<ReaderState> = {}) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.options.changed(this.state);
    this.options.save({
      index: this.state.index,
      seconds: this.state.seconds,
      rate: this.state.rate,
      complete: this.state.complete,
    });
  }
  private entry(index: number): Cached {
    let entry = this.cache.get(index);
    if (!entry) {
      const controller = new AbortController();
      const chunk = this.options.chunks[index]!;
      const pending: Cached = {
        controller,
        settled: false,
        result: Promise.resolve({}),
      };
      pending.result = this.options
        .synthesize(
          this.options.source.slice(chunk.start, chunk.end),
          controller.signal,
        )
        .then(
          (blob) => {
            pending.settled = true;
            return { blob };
          },
          (error) => {
            pending.settled = true;
            return { error };
          },
        );
      entry = pending;
      this.cache.set(index, entry);
    }
    return entry;
  }
  private abortRequests() {
    for (const [index, entry] of this.cache) {
      // The current decoded audio can be resumed without another provider call.
      if (!entry.settled && (index !== this.state.index || !this.player)) {
        entry.controller.abort();
        this.cache.delete(index);
      }
    }
  }
  async play(explicit = true) {
    if (this.disposed || !this.options.chunks.length) return;
    if (this.state.complete) this.seek(0);
    const index = this.nextReadable(this.state.index);
    if (index >= this.options.chunks.length) {
      this.publish({ complete: true, phase: "ended" });
      return;
    }
    if (index !== this.state.index) this.publish({ index, seconds: 0 });
    const generation = ++this.generation;
    this.publish({ phase: "loading", error: "", complete: false });
    try {
      if (!this.player) {
        let value = await this.entry(this.state.index).result;
        if (this.disposed || generation !== this.generation) return;
        // A failed speculative request is surfaced; no automatic paid retry.
        if (value.error) {
          if (!explicit) throw value.error;
          this.cache.delete(this.state.index);
          throw value.error;
        }
        const player = (this.options.audio ?? (() => new Audio()))();
        this.player = player;
        this.url = URL.createObjectURL(value.blob!);
        player.src = this.url;
        player.playbackRate = this.state.rate;
        const position = this.state.seconds;
        player.onloadedmetadata = () => {
          if (this.player === player && Number.isFinite(player.duration)) {
            player.currentTime = Math.min(
              position,
              Math.max(0, player.duration - 0.05),
            );
            this.publish({ duration: player.duration });
          }
        };
        player.ontimeupdate = () => {
          if (this.player === player)
            this.publish({ seconds: player.currentTime });
        };
        player.onended = () => {
          if (this.player !== player || this.state.phase !== "playing") return;
          const next = this.nextReadable(this.state.index + 1);
          this.releasePlayer();
          this.cache.delete(this.state.index);
          if (next >= this.options.chunks.length)
            this.publish({ phase: "ended", complete: true, seconds: 0 });
          else {
            this.publish({ index: next, seconds: 0, duration: null });
            void this.play(false);
          }
        };
        player.onerror = () => {
          if (this.player === player) {
            this.pause();
            this.releasePlayer();
            this.cache.delete(this.state.index);
            this.publish({
              phase: "error",
              error: "播放失败，当前位置已保留，可重试。",
            });
          }
        };
      }
      await this.player.play();
      if (this.disposed || generation !== this.generation) return;
      this.publish({ phase: "playing" });
      const next = this.nextReadable(this.state.index + 1);
      if (next < this.options.chunks.length) this.entry(next);
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.cache.delete(this.state.index);
      this.abortRequests();
      this.publish({
        phase: "error",
        error:
          error instanceof Error ? error.message : "朗读失败，当前位置已保留。",
      });
    }
  }
  pause() {
    this.generation++;
    this.player?.pause();
    this.abortRequests();
    this.publish({
      phase: "paused",
      seconds: this.player?.currentTime ?? this.state.seconds,
    });
  }
  private nextReadable(index: number) {
    while (index < this.options.chunks.length) {
      const chunk = this.options.chunks[index]!;
      if (this.options.source.slice(chunk.start, chunk.end).trim()) break;
      index++;
    }
    return index;
  }
  stop() {
    this.pause();
    this.releasePlayer();
    for (const value of this.cache.values()) value.controller.abort();
    this.cache.clear();
  }
  private releasePlayer() {
    if (this.player) {
      this.player.pause();
      this.player.onended =
        this.player.onerror =
        this.player.ontimeupdate =
        this.player.onloadedmetadata =
          null;
      this.player.src = "";
    }
    this.player = null;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }
  seek(index: number) {
    this.pause();
    this.releasePlayer();
    for (const value of this.cache.values()) value.controller.abort();
    this.cache.clear();
    this.publish({
      index: Math.max(0, Math.min(this.options.chunks.length - 1, index)),
      seconds: 0,
      duration: null,
      complete: false,
      error: "",
    });
  }
  seekSeconds(seconds: number) {
    if (!Number.isFinite(seconds) || !this.state.duration) return;
    const position = Math.max(0, Math.min(seconds, this.state.duration - 0.05));
    if (this.player) this.player.currentTime = position;
    this.publish({
      seconds: position,
      complete: false,
      phase: this.state.phase === "ended" ? "paused" : this.state.phase,
    });
  }
  rate(value: number) {
    if (this.player) this.player.playbackRate = value;
    this.publish({ rate: value });
  }
  dispose() {
    this.stop();
    this.disposed = true;
  }
}
