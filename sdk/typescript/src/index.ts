/** Stable Morphz HTTP client surface for Session Service v1. */

export interface MorphzPrincipal {
  id: string;
  displayName?: string;
}

export interface MorphzClientOptions {
  baseUrl: string;
  serviceToken?: string;
  fetch?: typeof globalThis.fetch;
}

export interface CreateSessionInput {
  id?: string;
  agent_id?: string;
  parent_session_id?: string;
  title?: string;
  mount?:
    | { type: "existing_context"; context_id: string }
    | { type: "new_blank_context"; context_id?: string; context_title?: string }
    | {
        type: "new_context_from_mind";
        source_context_id: string;
        source_version?: number;
        context_id?: string;
        context_title?: string;
      };
}

export interface CreateContextInput {
  id?: string;
  agent_id?: string;
  title?: string;
}

export interface ContextRecord {
  id: string;
  agent_id: string;
  title: string;
  [key: string]: unknown;
}

export interface UpdateSessionInput {
  title?: string;
  status?: string;
}

export interface SessionRecord {
  id: string;
  agent_id: string;
  context_id: string;
  title: string;
  status: string;
  [key: string]: unknown;
}

export interface MorphzEvent {
  id: string;
  topic: string;
  payload: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MessageReceipt {
  accepted: boolean;
  duplicate: boolean;
  event_id: string;
  client_message_id: string;
}

export type MessageAttachmentStageStatus = "uploading" | "ready" | "consumed";

export interface MessageAttachmentStage {
  stage_id: string;
  principal_id: string;
  session_id: string;
  client_message_id: string;
  name: string;
  media_type: string;
  size_bytes: number;
  offset: number;
  expected_sha256?: string;
  sha256?: string;
  status: MessageAttachmentStageStatus;
  created_at: string;
  expires_at: string;
  consumed_event_id?: string;
}

export interface CreateMessageAttachmentStageInput {
  stage_id?: string;
  client_message_id: string;
  name: string;
  media_type: string;
  size_bytes: number;
  expected_sha256?: string;
}

export interface SendMessageOptions {
  input_destination?:
    | { kind: 'thread'; thread_id: string; generation: number }
    | { kind: 'objective'; objective_id: string; generation: number; reply_to_request_id?: string };
  attachments?: Array<{
    name: string;
    media_type: string;
    data_base64: string;
  }>;
  staged_attachment_ids?: string[];
  references?: Array<Record<string, unknown>>;
  dispatch_mode?: "interrupt" | "parallel" | "follow_up";
  model_alias?: string;
  reasoning_effort?: string;
  target_id?: string;
}

export class MorphzHttpError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "MorphzHttpError";
    this.status = status;
    this.code = code;
  }
}

export class MorphzClient {
  readonly baseUrl: string;
  readonly serviceToken?: string;
  readonly fetch: typeof globalThis.fetch;

  constructor(options: MorphzClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.serviceToken = options.serviceToken;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  createContext(input: CreateContextInput): Promise<ContextRecord> {
    return this.call("/api/contexts", undefined, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async createSession(
    principal: MorphzPrincipal,
    input: CreateSessionInput,
  ): Promise<SessionRecord> {
    return this.call("/api/sessions", principal, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async claimLegacySession(
    principal: MorphzPrincipal,
    sessionId: string,
  ): Promise<SessionRecord> {
    const result = await this.call<{ session: SessionRecord }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/principal`,
      principal,
      { method: "POST" },
    );
    return result.session;
  }

  getSession(
    principal: MorphzPrincipal,
    sessionId: string,
  ): Promise<SessionRecord> {
    return this.call(
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      principal,
    );
  }

  updateSession(
    principal: MorphzPrincipal,
    sessionId: string,
    input: UpdateSessionInput,
  ): Promise<SessionRecord> {
    return this.call(
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      principal,
      { method: "PATCH", body: JSON.stringify(input) },
    );
  }

  async listSessions(
    principal: MorphzPrincipal,
    includeArchived = false,
  ): Promise<SessionRecord[]> {
    const result = await this.call<{ sessions: SessionRecord[] }>(
      `/api/sessions?include_archived=${includeArchived}`,
      principal,
    );
    return result.sessions;
  }

  sendMessage(
    principal: MorphzPrincipal,
    sessionId: string,
    text: string,
    clientMessageId: string,
    options: SendMessageOptions = {},
  ): Promise<MessageReceipt> {
    return this.call(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
      principal,
      {
        method: "POST",
        body: JSON.stringify({
          text,
          client_message_id: clientMessageId,
          ...options,
        }),
      },
    );
  }

  createMessageAttachmentStage(
    principal: MorphzPrincipal,
    sessionId: string,
    input: CreateMessageAttachmentStageInput,
  ): Promise<MessageAttachmentStage> {
    return this.call(
      `/api/sessions/${encodeURIComponent(sessionId)}/attachment-stages`,
      principal,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  getMessageAttachmentStage(
    principal: MorphzPrincipal,
    sessionId: string,
    stageId: string,
  ): Promise<MessageAttachmentStage> {
    return this.call(
      `/api/sessions/${encodeURIComponent(sessionId)}/attachment-stages/${encodeURIComponent(stageId)}`,
      principal,
    );
  }

  async listMessageAttachmentStages(
    principal: MorphzPrincipal,
    sessionId: string,
    clientMessageId?: string,
  ): Promise<MessageAttachmentStage[]> {
    const query = new URLSearchParams();
    if (clientMessageId) query.set("client_message_id", clientMessageId);
    const suffix = query.size > 0 ? `?${query}` : "";
    const result = await this.call<{ stages: MessageAttachmentStage[] }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/attachment-stages${suffix}`,
      principal,
    );
    return result.stages;
  }

  uploadMessageAttachmentStage(
    principal: MorphzPrincipal,
    sessionId: string,
    stageId: string,
    offset: number,
    body: BodyInit,
  ): Promise<MessageAttachmentStage> {
    return this.call(
      `/api/sessions/${encodeURIComponent(sessionId)}/attachment-stages/${encodeURIComponent(stageId)}/content`,
      principal,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-morphz-upload-offset": String(offset),
        },
        body,
      },
    );
  }

  cancelMessageAttachmentStage(
    principal: MorphzPrincipal,
    sessionId: string,
    stageId: string,
  ): Promise<void> {
    return this.call(
      `/api/sessions/${encodeURIComponent(sessionId)}/attachment-stages/${encodeURIComponent(stageId)}`,
      principal,
      { method: "DELETE" },
    );
  }

  async sessionEvents(
    principal: MorphzPrincipal,
    sessionId: string,
    options: { afterSequence?: number; limit?: number } = {},
  ): Promise<MorphzEvent[]> {
    const query = new URLSearchParams();
    if (options.afterSequence !== undefined)
      query.set("after_sequence", String(options.afterSequence));
    query.set("limit", String(options.limit ?? 200));
    const result = await this.call<{ events: MorphzEvent[] }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/events?${query}`,
      principal,
    );
    return result.events;
  }

  /** URL for a single-Session WebSocket subscription. Use TLS in production. */
  sessionWebSocketUrl(
    principal: MorphzPrincipal,
    sessionId: string,
  ): string {
    const url = new URL("/ws", this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("session_id", sessionId);
    url.searchParams.set("principal_id", principal.id);
    if (this.serviceToken) url.searchParams.set("token", this.serviceToken);
    return url.toString();
  }

  private async call<T>(
    path: string,
    principal: MorphzPrincipal | undefined,
    init: RequestInit = {},
  ): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has("content-type"))
      headers.set("content-type", "application/json");
    if (principal) {
      if (!principal.id) throw new Error("principal.id is required");
      headers.set("x-morphz-principal", principal.id);
      if (
        principal.displayName &&
        /^[\x20-\x7e]{1,200}$/.test(principal.displayName)
      )
        headers.set("x-morphz-principal-name", principal.displayName);
    }
    if (this.serviceToken)
      headers.set("authorization", `Bearer ${this.serviceToken}`);
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string | { code?: string; message?: string };
      };
      const detail =
        typeof body.error === "string"
          ? body.error
          : body.error?.message ?? `Morphz HTTP ${response.status}`;
      const code = typeof body.error === "object" ? body.error?.code : undefined;
      throw new MorphzHttpError(response.status, detail, code);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}
