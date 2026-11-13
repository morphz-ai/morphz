import type {
  CommentDiscussionMessage,
  CommentDiscussionPage,
  DiscussionReplyLocator,
} from "./comment-discussion-types.js";
import type {
  DiscussionActivity,
  DiscussionResponse,
} from "./comment-discussion-activity.js";
import {
  canonicalDiscussionSource,
  discussionCommandId,
} from "./comment-discussion-drafts.js";

export type DiscussionSummary = {
  id: string;
  title: string;
  preview: string;
  created_at_micros: number;
  publish_to_session: boolean;
  source_key?: string;
  locator?: Record<string, unknown>;
};
export type DiscussionDirectoryCursor = { createdAtMicros: number; id: string };
export type DiscussionCommand<Q> = {
  commandId: string;
  discussionId: string;
  quote: Q;
  body: string;
  first: boolean;
  publish: boolean;
  envelope?: unknown;
};
export type DiscussionDraft<Q> = Pick<
  DiscussionView<Q>,
  "id" | "quote" | "draft" | "publish" | "submitted" | "pending"
>;
export type DiscussionDraftJournal<Q> = {
  load: (quote: Q, id?: string) => DiscussionDraft<Q> | null;
  save: (draft: DiscussionDraft<Q>) => void;
};
export type DiscussionTransport<Q> = {
  list: (
    quote: Q,
    before: DiscussionDirectoryCursor | null,
    signal: AbortSignal,
    limit?: number,
  ) => Promise<{
    items: DiscussionSummary[];
    nextCursor: DiscussionDirectoryCursor | null;
  }>;
  read: (
    id: string,
    signal: AbortSignal,
  ) => Promise<{ quote: Q; publish: boolean }>;
  history: (
    id: string,
    before: CommentDiscussionPage["nextCursor"],
    signal: AbortSignal,
  ) => Promise<CommentDiscussionPage>;
  readMessage?: (
    id: string,
    message: CommentDiscussionMessage,
    offset: number,
    signal: AbortSignal,
  ) => Promise<{ eventId: string; text: string; nextOffset: number | null }>;
  readReply?: (
    id: string,
    reply: DiscussionReplyLocator,
    signal: AbortSignal,
  ) => Promise<CommentDiscussionMessage>;
  prepare?: (command: DiscussionCommand<Q>) => unknown;
  send: (command: DiscussionCommand<Q>) => Promise<void>;
};
export type DiscussionView<Q> = {
  id: string;
  quote: Q;
  publish: boolean;
  submitted: boolean;
  sourceReady: boolean;
  historyLoaded: boolean;
  olderCursor: CommentDiscussionPage["nextCursor"];
  gapCursor: CommentDiscussionPage["nextCursor"];
  acceptedIds: Set<string>;
  draft: string;
  messages: CommentDiscussionMessage[];
  pending?: DiscussionCommand<Q>;
  sending: boolean;
  awaitingResponse?: string;
  responseActivity?: DiscussionActivity;
  responseConnected?: boolean;
  loading: boolean;
  error: string;
  readError?: string;
  focusReply?: DiscussionReplyLocator;
  nextCursor: CommentDiscussionPage["nextCursor"];
  directory: DiscussionSummary[];
  directoryCursor: DiscussionDirectoryCursor | null;
  directoryLoading: boolean;
};

/** A visible discussion owns its reads, not the main chat's submission lane.
 * Closing only retires reads. In-flight commands keep their identity and an
 * unknown outcome is retried with the exact same body, never a fresh input.
 * All transport operations are single bounded pages or authorized point reads. */
export class CommentDiscussionController<Q> {
  version = 0;
  activeId: string | null = null;
  readonly views = new Map<string, DiscussionView<Q>>();
  private listeners = new Set<() => void>();
  private readOwner?: AbortController;
  private dirty = new Set<string>();
  private reading = new Set<string>();
  private disposed = false;
  private transport: DiscussionTransport<Q>;
  private uuid: () => string;
  private journal?: DiscussionDraftJournal<Q>;
  constructor(
    transport: DiscussionTransport<Q>,
    uuid: () => string = discussionCommandId,
    journal?: DiscussionDraftJournal<Q>,
  ) {
    this.transport = transport;
    this.uuid = uuid;
    this.journal = journal;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.version;
  get active() {
    return this.activeId ? this.views.get(this.activeId) : undefined;
  }
  private changed() {
    if (this.disposed) return;
    this.version++;
    for (const listener of this.listeners) listener();
  }
  private own(id: string) {
    if (this.active && this.activeId !== id) {
      this.active.responseConnected = undefined;
      this.active.responseActivity = undefined;
    }
    this.readOwner?.abort();
    this.readOwner = new AbortController();
    this.activeId = id;
    return this.readOwner.signal;
  }
  private create(id: string, quote: Q): DiscussionView<Q> {
    const view: DiscussionView<Q> = {
      id,
      quote,
      publish: false,
      submitted: false,
      sourceReady: true,
      historyLoaded: false,
      olderCursor: null,
      gapCursor: null,
      acceptedIds: new Set(),
      draft: "",
      messages: [],
      sending: false,
      loading: false,
      error: "",
      nextCursor: null,
      directory: [],
      directoryCursor: null,
      directoryLoading: false,
    };
    this.views.set(id, view);
    return view;
  }
  private restore(view: DiscussionView<Q>, saved: DiscussionDraft<Q>) {
    view.draft = saved.draft;
    view.publish = saved.publish;
    view.submitted = saved.submitted;
    view.pending = saved.pending;
    if (saved.pending)
      this.merge(view, [
        {
          id: saved.pending.commandId,
          eventId: saved.pending.commandId,
          rootId: "",
          createdAt: new Date().toISOString(),
          kind: "input",
          text: saved.pending.body,
        },
      ]);
  }
  private persist(view: DiscussionView<Q>) {
    this.journal?.save({
      id: view.id,
      quote: view.quote,
      draft: view.draft,
      publish: view.publish,
      submitted: view.submitted,
      pending: view.pending,
    });
  }
  private saveDraft(view: DiscussionView<Q>) {
    try {
      this.persist(view);
    } catch (error) {
      view.error = error instanceof Error ? error.message : String(error);
    }
  }
  open(quote: Q, fresh = false) {
    let saved: DiscussionDraft<Q> | null = null,
      error = "";
    try {
      if (!fresh) saved = this.journal?.load(quote) ?? null;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const id = saved?.id ?? this.uuid();
    const view = this.views.get(id) ?? this.create(id, saved?.quote ?? quote);
    if (saved) this.restore(view, saved);
    view.error = error;
    const signal = this.own(id);
    this.changed();
    void this.directory(view, null, signal);
    if (view.submitted) this.invalidate(id);
    return id;
  }
  reopen(id: string) {
    const view = this.views.get(id);
    if (!view) return;
    this.own(id);
    view.focusReply = undefined;
    this.changed();
    if (view.submitted) this.invalidate(id);
  }
  /** A visible source owns one metadata page, never a transcript read. */
  sourcePage(quote: Q, signal: AbortSignal) {
    return this.transport.list(quote, null, signal, 10);
  }
  async select(id: string, source?: Q, reply?: DiscussionReplyLocator) {
    const signal = this.own(id);
    let view = this.views.get(id);
    // Keep the current source visible while the exact selected discussion is
    // loading. The new response cannot replace another selection's draft.
    if (!view) {
      const current = [...this.views.values()].at(-1);
      if (!current && !source) return;
      view = this.create(id, source ?? current!.quote);
    }
    view.loading = true;
    view.sourceReady = false;
    view.focusReply = reply && { ...reply };
    view.error = "";
    this.changed();
    try {
      const result = await this.transport.read(id, signal);
      if (signal.aborted || this.disposed) return;
      if (
        view.pending &&
        canonicalDiscussionSource(view.pending.quote) !==
          canonicalDiscussionSource(result.quote)
      )
        throw new Error("讨论原文与保留的请求不一致；草稿和请求标识已保留。");
      const typedWhileReading = view.draft;
      view.quote = result.quote;
      view.publish = result.publish;
      const saved = this.journal?.load(result.quote, id);
      if (saved) this.restore(view, saved);
      if (typedWhileReading) view.draft = typedWhileReading;
      view.submitted = !view.pending?.first;
      view.sourceReady = true;
      void this.directory(view, null, signal);
      await this.refresh(view, null, signal);
      if (
        reply &&
        !signal.aborted &&
        !view.messages.some(
          (message) =>
            message.entryId === reply.messageId &&
            message.eventId === reply.eventId &&
            !message.contentOmitted,
        ) &&
        this.transport.readReply
      ) {
        const message = await this.transport.readReply(id, reply, signal);
        if (signal.aborted || this.disposed) return;
        this.merge(view, [message]);
      }
      this.saveDraft(view);
    } catch (error) {
      if (!signal.aborted)
        view.error = String(error instanceof Error ? error.message : error);
    } finally {
      if (!signal.aborted) {
        view.loading = false;
        this.changed();
      }
    }
  }
  private async directory(
    view: DiscussionView<Q>,
    before: DiscussionDirectoryCursor | null,
    signal: AbortSignal,
  ) {
    if (view.directoryLoading) return;
    view.directoryLoading = true;
    this.changed();
    try {
      const page = await this.transport.list(view.quote, before, signal);
      if (signal.aborted || this.disposed) return;
      if (
        before &&
        page.nextCursor?.id === before.id &&
        page.nextCursor.createdAtMicros === before.createdAtMicros
      )
        throw new Error("讨论列表游标未前进，请重试。");
      view.directory = before ? [...view.directory, ...page.items] : page.items;
      view.directoryCursor = page.nextCursor;
    } catch (error) {
      if (!signal.aborted)
        view.error = String(error instanceof Error ? error.message : error);
    } finally {
      view.directoryLoading = false;
      this.changed();
    }
  }
  olderDiscussions() {
    const view = this.active;
    if (view?.directoryCursor && this.readOwner)
      void this.directory(view, view.directoryCursor, this.readOwner.signal);
  }
  draft(text: string) {
    if (this.active) {
      this.active.draft = text;
      if (this.active.sourceReady) this.saveDraft(this.active);
      this.changed();
    }
  }
  publish(value: boolean) {
    if (this.active && !this.active.submitted && !this.active.pending) {
      this.active.publish = value;
      this.saveDraft(this.active);
      this.changed();
    }
  }
  private merge(view: DiscussionView<Q>, messages: CommentDiscussionMessage[]) {
    const items = new Map(
      view.messages.map((message) => [message.id, message]),
    );
    for (const message of messages) {
      const previous = items.get(message.id);
      if (previous?.entryId && !message.entryId) continue;
      if (
        previous &&
        message.contentOmitted &&
        previous.eventId === message.eventId &&
        previous.text
      )
        continue;
      if (
        previous &&
        !previous.streaming &&
        message.streaming &&
        !message.id.startsWith("stream:")
      )
        continue;
      if (
        previous &&
        message.id.startsWith("stream:") &&
        !message.replace &&
        previous.text.length > message.text.length &&
        previous.text.startsWith(message.text)
      )
        continue;
      if (message.id.startsWith("publication:"))
        items.delete(`stream:${message.id.slice(12)}`);
      if (
        message.id.startsWith("stream:") &&
        items.has(`publication:${message.id.slice(7)}`)
      )
        continue;
      items.set(message.id, message);
    }
    view.messages = [...items.values()].sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  }
  private accepted(
    view: DiscussionView<Q>,
    messages: CommentDiscussionMessage[],
  ) {
    const command = view.pending;
    if (
      !command ||
      !messages.some(
        (message) =>
          message.kind === "input" &&
          message.id === command.commandId &&
          message.text === command.body,
      )
    )
      return;
    view.acceptedIds.add(command.commandId);
    view.submitted = true;
    view.pending = undefined;
    this.awaitResponse(view, command.commandId);
    view.error = "";
    if (view.draft.trim() === command.body) view.draft = "";
    this.saveDraft(view);
  }
  private awaitResponse(view: DiscussionView<Q>, inputId: string) {
    if (
      view.responseActivity?.responses.some(
        (response) => response.inputId === inputId,
      )
    )
      return;
    if (!view.responseConnected || view.responseActivity)
      view.awaitingResponse = inputId;
  }
  observeResponse(
    id: string,
    connected: boolean,
    activity?: DiscussionActivity,
  ) {
    const view = this.active;
    if (view?.id !== id || (activity && activity.id !== id)) return;
    const recovering = connected && !view.responseConnected;
    const previous = view.responseActivity;
    const same =
      previous === activity ||
      (previous &&
        activity &&
        previous.responses.length === activity.responses.length &&
        activity.responses.every((response, index) => {
          const old = previous.responses[index]!;
          return (
            old.inputId === response.inputId &&
            old.rootId === response.rootId &&
            old.createdAt === response.createdAt &&
            old.phase === response.phase
          );
        }));
    if (
      view.responseConnected === connected &&
      (same || (!connected && !activity))
    )
      return;
    view.responseConnected = connected;
    if (activity || connected) view.responseActivity = activity;
    if (
      recovering ||
      activity?.responses.some(
        (response) => response.inputId === view.awaitingResponse,
      )
    )
      view.awaitingResponse = undefined;
    this.changed();
  }
  receive(id: string, messages: CommentDiscussionMessage[]) {
    const view = this.views.get(id);
    if (!view || !messages.length) return;
    this.accepted(view, messages);
    this.merge(view, messages);
    this.changed();
  }
  private async refresh(
    view: DiscussionView<Q>,
    before: CommentDiscussionPage["nextCursor"],
    signal: AbortSignal,
  ) {
    const page = await this.transport.history(view.id, before, signal);
    if (signal.aborted || this.disposed) return;
    if (
      before &&
      page.nextCursor?.id === before.id &&
      page.nextCursor.createdAt === before.createdAt
    )
      throw new Error("讨论历史游标未前进，请重试。");
    const existing = new Set(view.messages.map((message) => message.id));
    const overlaps = page.messages.some((message) => existing.has(message.id));
    if (!before) {
      if (!view.historyLoaded) view.olderCursor = page.nextCursor;
      else if (
        existing.size &&
        page.messages.length &&
        !overlaps &&
        page.nextCursor
      )
        view.gapCursor = page.nextCursor;
    } else if (
      view.gapCursor?.id === before.id &&
      view.gapCursor.createdAt === before.createdAt
    ) {
      view.gapCursor = overlaps ? null : page.nextCursor;
    } else view.olderCursor = page.nextCursor;
    view.historyLoaded = true;
    view.nextCursor = view.gapCursor ?? view.olderCursor;
    this.accepted(view, page.messages);
    this.merge(view, page.messages);
    this.changed();
  }
  invalidate(id: string) {
    if (this.disposed || id !== this.activeId) return;
    const view = this.views.get(id),
      signal = this.readOwner?.signal;
    if (!view?.submitted || !signal) return;
    this.dirty.add(id);
    if (this.reading.has(id)) return;
    this.reading.add(id);
    void (async () => {
      try {
        while (!signal.aborted && this.dirty.delete(id))
          await this.refresh(view, null, signal);
      } catch (error) {
        if (!signal.aborted)
          view.error = String(error instanceof Error ? error.message : error);
      } finally {
        this.reading.delete(id);
        this.changed();
        if (
          this.dirty.has(id) &&
          !this.disposed &&
          this.activeId === id &&
          this.readOwner?.signal !== signal
        )
          this.invalidate(id);
      }
    })();
  }
  async older() {
    const view = this.active,
      signal = this.readOwner?.signal;
    if (!view?.nextCursor || !signal || view.loading) return;
    view.loading = true;
    this.changed();
    try {
      await this.refresh(view, view.nextCursor, signal);
    } catch (error) {
      if (!signal.aborted)
        view.error = String(error instanceof Error ? error.message : error);
    } finally {
      view.loading = false;
      this.changed();
    }
  }
  async openMessage(id: string) {
    const view = this.active,
      signal = this.readOwner?.signal;
    const message = view?.messages.find((message) => message.id === id);
    if (
      !view ||
      !signal ||
      !message ||
      view.loading ||
      !this.transport.readMessage
    )
      return;
    const offset = message.nextOffset ?? 0;
    view.loading = true;
    view.error = "";
    this.changed();
    try {
      const chunk = await this.transport.readMessage(
        view.id,
        message,
        offset,
        signal,
      );
      if (signal.aborted || this.disposed) return;
      const current = view.messages.find((value) => value.id === id);
      if (
        !current ||
        current.eventId !== chunk.eventId ||
        chunk.eventId !== message.eventId
      )
        throw new Error("消息已更新，请重新打开。");
      current.text = offset ? current.text + chunk.text : chunk.text;
      current.nextOffset = chunk.nextOffset;
      current.contentOmitted = chunk.nextOffset !== null;
    } catch (error) {
      if (!signal.aborted)
        view.error = error instanceof Error ? error.message : String(error);
    } finally {
      view.loading = false;
      this.changed();
    }
  }
  async send() {
    const view = this.active;
    if (
      !view ||
      !view.sourceReady ||
      view.sending ||
      (!view.pending && !view.draft.trim())
    )
      return;
    const command = view.pending ?? {
      commandId: view.submitted ? this.uuid() : view.id,
      discussionId: view.id,
      quote: view.quote,
      body: view.draft.trim(),
      first: !view.submitted,
      publish: view.publish,
    };
    view.pending = command;
    view.sending = true;
    view.error = "";
    this.merge(view, [
      {
        id: command.commandId,
        eventId: command.commandId,
        rootId: "",
        createdAt: new Date().toISOString(),
        kind: "input",
        text: command.body,
      },
    ]);
    this.changed();
    try {
      if (command.envelope === undefined && this.transport.prepare)
        command.envelope = this.transport.prepare(command);
      this.persist(view);
      if (this.disposed) return;
      await this.transport.send(command);
      view.submitted = true;
      view.pending = undefined;
      this.awaitResponse(view, command.commandId);
      if (view.draft.trim() === command.body) view.draft = "";
      this.saveDraft(view);
      // The native receipt is the command result; a history read is separate.
      this.invalidate(view.id);
    } catch (error) {
      if (!view.acceptedIds.has(command.commandId)) {
        view.awaitingResponse = undefined;
        view.error = `${error instanceof Error ? error.message : String(error)}。保留了这条消息，重试会使用同一个请求。`;
      }
    } finally {
      view.sending = false;
      this.changed();
    }
  }
  retryRead() {
    const view = this.active;
    if (!view || !this.readOwner) return;
    if (view.submitted || !view.sourceReady)
      void this.select(view.id, view.quote, view.focusReply);
    else void this.directory(view, null, this.readOwner.signal);
  }
  readFailed(id: string, error: unknown) {
    if (this.disposed || this.activeId !== id) return;
    const view = this.views.get(id);
    if (view && !view.pending) {
      view.readError = error instanceof Error ? error.message : String(error);
      view.error = view.readError;
      this.changed();
    }
  }
  readRecovered(id: string) {
    if (this.disposed || this.activeId !== id) return;
    const view = this.views.get(id);
    if (view?.readError) {
      if (view.error === view.readError) view.error = "";
      view.readError = undefined;
      this.changed();
    }
  }
  close() {
    if (this.active) {
      this.active.responseConnected = undefined;
      this.active.responseActivity = undefined;
    }
    this.readOwner?.abort();
    this.activeId = null;
    this.changed();
  }
  start() {
    this.disposed = false;
  }
  dispose() {
    this.disposed = true;
    this.readOwner?.abort();
    this.listeners.clear();
  }
}

/** Render feedback on its input without inserting synthetic rows into history. */
export function discussionResponseRows<Q>(view: DiscussionView<Q>) {
  type Row = Omit<DiscussionResponse, "phase"> & {
    phase: DiscussionResponse["phase"] | "sending";
  };
  const completed = new Set(
    view.messages
      .filter(
        (message) =>
          message.kind === "reply" &&
          !message.streaming &&
          !message.id.startsWith("stream:"),
      )
      .map((message) => message.rootId),
  );
  const rows = new Map<string, Row>();
  for (const response of view.responseActivity?.responses ?? [])
    if (response.phase !== "settled" && !completed.has(response.rootId))
      rows.set(response.inputId, response);
  const local = view.sending
    ? (view.pending?.commandId ?? view.awaitingResponse)
    : view.awaitingResponse;
  if (
    local &&
    !view.responseActivity?.responses.some(
      (response) => response.inputId === local,
    )
  ) {
    const input = view.messages.find(
      (message) => message.kind === "input" && message.id === local,
    );
    if (input && !completed.has(input.rootId))
      rows.set(local, {
        inputId: local,
        rootId: input.rootId,
        createdAt: input.createdAt,
        phase: view.pending ? "sending" : "waiting",
      });
  }
  return rows;
}
