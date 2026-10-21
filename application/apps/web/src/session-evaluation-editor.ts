import {
  sessionEvaluationDefaultsSchema,
  sessionEvaluationSnapshotSchema,
  type SessionEvaluationDefaults,
  type SessionEvaluationSnapshot,
  type SessionEvaluationScope,
} from "../../../packages/core/src/session-evaluation.js";

type Ports = {
  assertScope(): void;
  read?: () => Promise<SessionEvaluationSnapshot>;
  save(
    defaults: SessionEvaluationDefaults,
    snapshot: SessionEvaluationSnapshot,
  ): Promise<SessionEvaluationSnapshot>;
  changed(): void;
  localDraft(defaults: SessionEvaluationDefaults): void;
  isRejected?(error: unknown): boolean;
};
const same = (a: SessionEvaluationDefaults, b: SessionEvaluationDefaults) =>
  a.model === b.model && a.reasoningEffort === b.reasoningEffort;
const failure = (error: unknown) =>
  error instanceof Error ? error.message : "模型设置未确认。";

/** Surface drafts are not Session identities, including during a save. */
export function sessionEvaluationEditorKey(input: {
  identity: string;
  identityGeneration: string;
  enabled: boolean;
  scope?: SessionEvaluationScope;
  draftKey: string;
}) {
  return JSON.stringify([
    input.identity,
    input.identityGeneration,
    input.enabled,
    input.scope
      ? [input.scope.projectId, input.scope.conversationId]
      : ["unsent", input.draftKey],
  ]);
}

/** One visible, identity-scoped editor. Only a Runtime receipt is authority;
 * local choices initialize a not-yet-started Session, never an existing one.
 * Slider edits coalesce without disabling the gesture. Unknown writes require
 * a new read, not a retry or a rebase over another writer. */
export class SessionEvaluationEditor {
  private snapshot?: SessionEvaluationSnapshot;
  private intent?: SessionEvaluationDefaults;
  private initialized: boolean;
  private loading = false;
  private saving = false;
  private blocked = false;
  private error = "";
  private rejected = false;
  private timer?: ReturnType<typeof setTimeout>;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly seed: SessionEvaluationDefaults,
    private readonly ports: Ports,
  ) {
    this.seed = sessionEvaluationDefaultsSchema.parse(seed);
    this.initialized = !ports.read;
    if (!ports.read) this.intent = structuredClone(this.seed);
  }

  get state() {
    return {
      defaults: structuredClone(
        this.intent ?? this.snapshot?.defaults ?? this.seed,
      ),
      snapshot: this.snapshot ? structuredClone(this.snapshot) : undefined,
      loading: this.loading || !this.initialized,
      saving: this.saving,
      pending: !!(
        this.snapshot?.source === "runtime" &&
        this.intent &&
        !same(this.intent, this.snapshot.defaults)
      ),
      error: this.error,
      needsRead: this.blocked,
      editable:
        this.initialized &&
        !this.blocked &&
        (!this.snapshot ||
          this.snapshot.source === "not_started" ||
          this.snapshot.canUpdate),
    };
  }

  refresh(reconcile = false): Promise<void> {
    this.cancelScheduled();
    return this.serialize(async () => {
      await this.read(reconcile);
      // Reopening the menu may cancel a not-yet-fired slider debounce. Keep
      // that intentional edit, but only save after reconciling its old base.
      if (!reconcile && !this.blocked && !this.rejected) await this.drain();
    });
  }

  edit(patch: Partial<SessionEvaluationDefaults>, delay = 80) {
    this.ports.assertScope();
    if (!this.state.editable)
      throw new Error("请先重新读取当前会话的模型设置。");
    this.intent = sessionEvaluationDefaultsSchema.parse({
      ...this.state.defaults,
      ...patch,
    });
    this.error = "";
    this.rejected = false;
    this.cancelScheduled();
    if (!this.snapshot || this.snapshot.source === "not_started") {
      this.ports.localDraft(structuredClone(this.intent));
    } else {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.serialize(() => this.drain()).catch(() => {});
      }, delay);
    }
    this.ports.changed();
  }

  /** Admission must wait for the latest edit, including edits made while the
   * previous write was in flight. An ordinary root gets no task override. */
  async prepareInput(): Promise<SessionEvaluationDefaults | undefined> {
    this.cancelScheduled();
    return this.serialize(async () => {
      this.ports.assertScope();
      if (this.blocked || this.rejected) throw new Error(this.error);
      if (!this.initialized) await this.read(false);
      await this.drain();
      this.ports.assertScope();
      if (this.snapshot?.source === "runtime") return undefined;
      const defaults = this.state.defaults;
      return defaults.model !== null || defaults.reasoningEffort !== null
        ? defaults
        : undefined;
    });
  }

  cancelScheduled() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(work);
    this.tail = pending.catch(() => {});
    return pending;
  }

  private async read(reconcile: boolean) {
    this.ports.assertScope();
    if (!this.ports.read) return;
    this.loading = true;
    this.ports.changed();
    try {
      const actual = sessionEvaluationSnapshotSchema.parse(
        await this.ports.read(),
      );
      this.ports.assertScope();
      const previous = this.snapshot;
      this.snapshot = actual;
      this.initialized = true;
      if (actual.source === "not_started") {
        this.intent ??= structuredClone(this.seed);
      } else if (!previous || reconcile || !this.intent) {
        // A saved draft is never permission to change an existing Session.
        this.intent = undefined;
      } else if (same(actual.defaults, this.intent)) {
        this.intent = undefined;
      } else if (previous.fingerprint !== actual.fingerprint) {
        throw new Error("会话模型已变化，请重新读取后再选择；未覆盖新的设置。");
      }
      if (this.rejected && !reconcile && this.intent) return;
      this.blocked = false;
      this.rejected = false;
      this.error = "";
    } catch (error) {
      this.blocked = true;
      this.error = `${failure(error)} 请重新读取；原输入草稿已保留。`;
      throw error;
    } finally {
      this.loading = false;
      this.ports.changed();
    }
  }

  private async drain() {
    this.ports.assertScope();
    if (this.blocked || this.rejected) throw new Error(this.error);
    if (!this.initialized) await this.read(false);
    if (!this.snapshot || this.snapshot.source === "not_started") return;
    while (this.intent) {
      if (same(this.intent, this.snapshot.defaults)) {
        this.intent = undefined;
        break;
      }
      if (!this.snapshot.canUpdate || !this.snapshot.fingerprint)
        throw new Error("当前会话的模型设置只读。");
      const target = structuredClone(this.intent);
      const baseline = structuredClone(this.snapshot);
      this.saving = true;
      this.ports.changed();
      try {
        const actual = sessionEvaluationSnapshotSchema.parse(
          await this.ports.save(target, baseline),
        );
        this.ports.assertScope();
        if (
          actual.source !== "runtime" ||
          actual.runtimeSessionId !== baseline.runtimeSessionId ||
          actual.scope.projectId !== baseline.scope.projectId ||
          actual.scope.conversationId !== baseline.scope.conversationId ||
          !same(actual.defaults, target)
        )
          throw new Error("模型设置回执不匹配，保存结果未确认。");
        this.snapshot = actual;
        if (this.intent && same(this.intent, target)) this.intent = undefined;
        this.error = "";
      } catch (error) {
        this.rejected = this.ports.isRejected?.(error) === true;
        this.blocked = !this.rejected;
        this.error = this.rejected
          ? `${failure(error)} 请调整模型或推理强度；原输入草稿已保留。`
          : `${failure(error)} 请重新读取，不要重复发送；原输入草稿已保留。`;
        throw error;
      } finally {
        this.saving = false;
        this.ports.changed();
      }
    }
    this.ports.changed();
  }
}
