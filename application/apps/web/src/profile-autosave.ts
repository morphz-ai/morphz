import {
  normalizeAgentProfileData,
  normalizeHumanProfileData,
  profileHasConfiguredFields,
  profileUpdateSchema,
  type AgentProfileData,
  type HumanProfileData,
  type ProfileSnapshot,
  type ProfileSubject,
  type ProfileUpdate,
} from "../../../packages/core/src/profile.js";

type ProfileData = AgentProfileData | HumanProfileData;
export type ProfileAutosaveState<T> = {
  data?: T;
  enabled?: boolean;
  saving: boolean;
  error: string;
  dirty: boolean;
  conflict: boolean;
};
export type ProfileAutosaveStates = {
  human: ProfileAutosaveState<HumanProfileData>;
  agent: ProfileAutosaveState<AgentProfileData>;
};
export class ProfileAutosaveConflictError extends Error {}
type Intent = { data: ProfileData; enabled: boolean; generation: number };
type SubjectQueue = {
  intent?: Intent;
  pending?: { command: ProfileUpdate; generation: number };
  timer?: ReturnType<typeof setTimeout>;
  saving: boolean;
  error: string;
  conflict: boolean;
};
type Ports = {
  assertScope(): void;
  save(command: ProfileUpdate): Promise<ProfileSnapshot>;
  read(): Promise<ProfileSnapshot | undefined>;
  changed(): void;
  isConflict(error: unknown): boolean;
  commandId?(): string;
};
const subjects = ["human", "agent"] as const;
const emptyQueue = (): SubjectQueue => ({
  saving: false,
  error: "",
  conflict: false,
});
const message = (error: unknown) => {
  if (
    error instanceof TypeError &&
    /failed to fetch|fetch failed|networkerror|load failed/i.test(error.message)
  )
    return "保存结果未确认，请重试。";
  return error instanceof Error ? error.message : "设定暂时无法保存，请重试。";
};
const canonical = (subject: ProfileSubject, data: ProfileData): ProfileData =>
  subject === "human"
    ? normalizeHumanProfileData(data)
    : normalizeAgentProfileData(data);
const fingerprint = (data: ProfileData, enabled: boolean) =>
  JSON.stringify({ data, enabled });

/**
 * One identity-scoped queue, owned by the app rather than the mounted editor.
 * The only persistent authority is the audited Host response. Raw UI drafts
 * never substitute for a receipt, and an uncertain command is immutable.
 */
export class ProfileAutosave {
  private queues: Record<ProfileSubject, SubjectQueue> = {
    human: emptyQueue(),
    agent: emptyQueue(),
  };
  private snapshot?: ProfileSnapshot;
  private generation = 0;
  private disposed = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(private ports: Ports) {}

  hydrate(snapshot: ProfileSnapshot) {
    if (this.disposed) return;
    this.acceptSnapshot(snapshot);
    this.ports.changed();
  }

  get state(): ProfileAutosaveStates {
    const result = {} as ProfileAutosaveStates;
    for (const subject of subjects) {
      const queue = this.queues[subject];
      const state: ProfileAutosaveState<ProfileData> = {
        ...(queue.intent
          ? {
              data: structuredClone(queue.intent.data),
              enabled: queue.intent.enabled,
            }
          : {}),
        saving: queue.saving,
        error: queue.error,
        dirty: Boolean(queue.pending) || this.needsSave(subject),
        conflict: queue.conflict,
      };
      Object.assign(result, { [subject]: state });
    }
    return result;
  }

  edit<S extends ProfileSubject>(
    subject: S,
    data: ProfileSnapshot[S]["data"],
    enabled: boolean,
    delay = 0,
  ) {
    this.assertActive();
    const queue = this.queues[subject];
    queue.intent = {
      data: structuredClone(data),
      enabled,
      generation: ++this.generation,
    };
    this.clearTimer(subject);
    // A new edit cannot silently overwrite another client's CAS conflict.
    if (!queue.conflict && !(queue.error && queue.pending)) {
      queue.timer = setTimeout(
        () => {
          queue.timer = undefined;
          void this.serialize(() => this.drain(subject, false, false)).catch(
            () => {},
          );
        },
        Math.max(0, delay),
      );
    }
    this.ports.changed();
  }

  async flush(subject?: ProfileSubject) {
    this.assertActive();
    const selected = subject ? [subject] : subjects;
    for (const value of selected) this.clearTimer(value);
    // Across both subjects: save() includes a read-back and the hook's read
    // sequence must not be superseded by another automatic write/read pair.
    return this.serialize(async () => {
      do {
        let failure: unknown;
        for (const value of selected) {
          try {
            await this.drain(value, true, false);
          } catch (error) {
            failure ??= error;
          }
        }
        if (failure) throw failure;
        // A Human edit can arrive while the Agent write is awaited (and vice
        // versa). Send admission must reach a quiescent queue, not just visit
        // each subject once and admit an input with one stale preference head.
      } while (
        selected.some(
          (value) => this.queues[value].pending || this.needsSave(value),
        )
      );
      this.assertActive();
    });
  }

  retry(subject: ProfileSubject) {
    this.assertActive();
    this.clearTimer(subject);
    return this.serialize(() => this.drain(subject, true, true));
  }

  discard(subject: ProfileSubject) {
    this.assertActive();
    const queue = this.queues[subject];
    if (queue.pending || queue.saving)
      throw new Error("上次保存尚未确认，请先重试；不能丢弃未确认的操作。");
    this.clearTimer(subject);
    queue.intent = undefined;
    queue.error = "";
    this.ports.changed();
  }

  async resolveConflict(
    subject: ProfileSubject,
    resolution: "reload" | "overwrite",
  ) {
    this.assertActive();
    this.clearTimer(subject);
    return this.serialize(async () => {
      const queue = this.queues[subject];
      if (!queue.conflict) return;
      this.assertActive();
      const actual = await this.ports.read();
      this.assertActive();
      if (!actual) throw new Error("请先重新读取设定，再处理冲突。");
      this.acceptSnapshot(actual, subject);
      queue.pending = undefined;
      queue.conflict = false;
      queue.error = "";
      if (resolution === "reload") queue.intent = undefined;
      this.ports.changed();
      if (resolution === "overwrite") await this.drain(subject, true, false);
    });
  }

  cancelScheduled() {
    for (const subject of subjects) this.clearTimer(subject);
  }

  dispose() {
    this.disposed = true;
    this.cancelScheduled();
  }

  private assertActive() {
    if (this.disposed)
      throw new DOMException("身份已切换，旧设定操作已取消。", "AbortError");
    this.ports.assertScope();
  }

  private clearTimer(subject: ProfileSubject) {
    const queue = this.queues[subject];
    if (queue.timer !== undefined) clearTimeout(queue.timer);
    queue.timer = undefined;
  }

  private serialize(work: () => Promise<void>) {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }

  private acceptSnapshot(actual: ProfileSnapshot, confirmed?: ProfileSubject) {
    const incoming = structuredClone(actual);
    for (const subject of subjects) {
      const baseline = this.snapshot?.[subject];
      if (!baseline || subject === confirmed) continue;
      const queue = this.queues[subject];
      if (queue.pending || this.needsSave(subject)) {
        // A refresh (including an avatar read-back) is not consent to rebase
        // an unsent edit over a newer writer. Preserve its original CAS base,
        // while applying fresh access and media state.
        Object.assign(incoming[subject], {
          data: structuredClone(baseline.data),
          revision: baseline.revision,
          enabled: baseline.enabled,
        });
      } else if (
        queue.intent &&
        fingerprint(canonical(subject, baseline.data), baseline.enabled) !==
          fingerprint(
            canonical(subject, incoming[subject].data),
            incoming[subject].enabled,
          )
      ) {
        queue.intent = undefined;
      }
    }
    this.snapshot = incoming;
  }

  private target(subject: ProfileSubject) {
    const queue = this.queues[subject];
    if (!queue.intent) return;
    const raw = structuredClone(queue.intent.data);
    // An enabled but not-yet-typed name is an editor intermediate state, not
    // consent to erase the saved name. Other valid fields still save normally.
    if (raw.name !== null && !raw.name.trim())
      raw.name = this.snapshot?.[subject].data.name ?? null;
    const data = canonical(subject, raw);
    return {
      data,
      enabled: queue.intent.enabled && profileHasConfiguredFields(data),
    };
  }

  private needsSave(subject: ProfileSubject) {
    if (!this.queues[subject].intent) return false;
    try {
      const target = this.target(subject)!;
      const baseline = this.snapshot?.[subject];
      if (!baseline) return profileHasConfiguredFields(target.data);
      return (
        fingerprint(target.data, target.enabled) !==
        fingerprint(canonical(subject, baseline.data), baseline.enabled)
      );
    } catch {
      return true;
    }
  }

  private async drain(
    subject: ProfileSubject,
    force: boolean,
    retryPending: boolean,
  ) {
    const queue = this.queues[subject];
    try {
      this.assertActive();
      if (queue.conflict)
        throw new ProfileAutosaveConflictError(
          "设定已在别处更改，请重新读取或确认覆盖。",
        );
      if (queue.pending && queue.error && !retryPending)
        throw new Error(queue.error);
      // Process an uncertain frozen command before parsing newer edits. Even
      // an invalid later draft cannot hide the earlier durable write/receipt.
      while (queue.pending || this.needsSave(subject)) {
        this.assertActive();
        // The previous receipt must not flush a newer still-debouncing text
        // draft. Only an explicit flush/retry (including send admission) drains
        // all current intent; background saves wait for the newest timer.
        if (!queue.pending && !force && queue.timer !== undefined) break;
        if (force) this.clearTimer(subject);
        if (!queue.pending) {
          const baseline = this.snapshot?.[subject];
          if (!baseline?.available)
            throw new Error("设定尚未读取，请重新连接后重试。");
          if (!baseline.editable) throw new Error("当前身份不能修改这份设定。");
          const target = this.target(subject)!;
          const command = profileUpdateSchema.parse({
            subject,
            data: target.data,
            enabled: target.enabled,
            expectedRevision: baseline.revision,
            commandId: this.ports.commandId?.() ?? crypto.randomUUID(),
          });
          queue.pending = {
            command,
            generation: queue.intent!.generation,
          };
        }
        queue.saving = true;
        queue.error = "";
        this.ports.changed();
        this.assertActive();
        const pending = queue.pending;
        const actual = await this.ports.save(structuredClone(pending.command));
        this.assertActive();
        this.acceptSnapshot(actual, subject);
        queue.pending = undefined;
        // Keep raw input (including enabled empty controls) after canonical
        // read-back. A newer intent was never replaced with the older receipt.
        this.ports.changed();
      }
      queue.error = "";
    } catch (error) {
      if (this.disposed) throw error;
      this.ports.assertScope();
      queue.error = message(error);
      queue.conflict =
        queue.conflict ||
        error instanceof ProfileAutosaveConflictError ||
        this.ports.isConflict(error);
      if (error instanceof Error && queue.error !== error.message)
        throw new Error(queue.error, { cause: error });
      throw error;
    } finally {
      queue.saving = false;
      if (!this.disposed) this.ports.changed();
    }
  }
}
