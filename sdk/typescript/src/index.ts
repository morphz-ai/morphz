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

export interface AgentRomKey {
  agent_id: string;
  namespace: string;
  principal_scope?: string;
}
export interface PutAgentRomCommand {
  command_id: string;
  expected_revision: number;
  key: AgentRomKey;
  schema_tag: string;
  body_sexpr: string;
  enabled: boolean;
}
export interface AgentRomRecord {
  entry_id: string;
  key: AgentRomKey;
  revision: number;
  schema_tag: string;
  canonical_sexpr: string;
  canonical_format_version: number;
  content_hash: string;
  enabled: boolean;
  created_by: string;
  created_at: string;
}
export interface AgentRomCommandReceipt {
  command_id: string;
  actor_authority_id: string;
  request_hash: string;
  entry_id: string;
  expected_revision: number;
  committed_revision: number;
  committed_at: string;
}
export type AgentRomMutation =
  | { status: "committed"; record: AgentRomRecord; receipt: AgentRomCommandReceipt; duplicate: boolean }
  | { status: "conflict"; current: AgentRomRecord | null }
  | { status: "not_found" };
export interface ThreadRomManifest {
  thread_id: string;
  agent_id: string;
  initiating_principal_id: string | null;
  manifest_hash: string;
  compiler_hash: string;
  bound_at: string;
  entries: AgentRomRecord[];
}

export interface UpdateSessionInput {
  title?: string;
  status?: string;
  /** Omit to preserve the current override; null restores Runtime inheritance. */
  permission_mode?: "request_approval" | "auto_review" | "full_access" | null;
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

export type ApprovalScope = "once" | "thread" | "objective" | "session";
export interface SessionApprovalCommand {
  expected_revision: number;
  decision: "allow_once" | "allow_thread" | "allow_objective" | "allow_session" | "deny";
}
export interface SessionApproval {
  id: string;
  revision: number;
  status: "pending_auto" | "pending_human" | "allowed" | "denied" | "cancelled";
  action: { kind: "shell"; command: string; cwd: string }
    | { kind: "tool_operation"; tool: string; operation: string; target: string | null };
  requested: { network: boolean; read_roots: string[]; write_roots: string[]; secret_env: string[] };
  justification: string;
  thread_id: string;
  target_id: string;
  objective_id: string | null;
  requested_scope: ApprovalScope;
  available_scopes: ApprovalScope[];
  lease_expires_at: string | null;
  created_at: string;
  decided_at: string | null;
}
export interface SessionApprovalPage {
  approvals: SessionApproval[];
  truncated: boolean;
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

  /** The trusted ingress supplies the authenticated assertion; no Session is created. */
  ensureAuthenticatedPrincipal(principal?: MorphzPrincipal): Promise<{principal_id:string}> {
    return this.call("/api/principal/self",principal,{method:"POST"});
  }

  /** Operator/trusted Host only. A principal Header is not ROM write authority. */
  async listAgentRomAsOperator(agentId: string, principalScope?: string): Promise<AgentRomRecord[]> {
    const query = principalScope === undefined ? "" : `?${new URLSearchParams({principal_scope: principalScope})}`;
    const result = await this.call<{entries: AgentRomRecord[]}>(`/api/agents/${encodeURIComponent(agentId)}/rom${query}`, undefined);
    return result.entries;
  }

  getAgentRomAsOperator(key: AgentRomKey): Promise<AgentRomRecord> {
    return this.call(this.agentRomPath(key), undefined);
  }

  /** Conflict is a 409 MorphzHttpError; retries must reuse the same command_id. */
  putAgentRomAsOperator(command: PutAgentRomCommand): Promise<AgentRomMutation> {
    if (!Number.isSafeInteger(command.expected_revision) || command.expected_revision < 0) throw new Error("expected_revision must be a nonnegative safe integer");
    return this.call(this.agentRomPath(command.key), undefined, {method:"PUT",body:JSON.stringify(command)});
  }

  threadRomAsOperator(threadId: string): Promise<ThreadRomManifest> {
    return this.call(`/api/threads/${encodeURIComponent(threadId)}/rom`, undefined);
  }

  private agentRomPath(key: AgentRomKey): string {
    const query = key.principal_scope === undefined ? "" : `?${new URLSearchParams({principal_scope:key.principal_scope})}`;
    return `/api/agents/${encodeURIComponent(key.agent_id)}/rom/${encodeURIComponent(key.namespace)}${query}`;
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

  sessionPendingApprovals(principal: MorphzPrincipal, sessionId: string): Promise<SessionApprovalPage> {
    return this.call(`/api/sessions/${encodeURIComponent(sessionId)}/approvals`, principal);
  }

  sessionApproval(principal: MorphzPrincipal, sessionId: string, approvalId: string): Promise<SessionApproval> {
    return this.call(`/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`, principal);
  }

  decideSessionApproval(principal: MorphzPrincipal, sessionId: string, approvalId: string, command: SessionApprovalCommand): Promise<SessionApproval> {
    return this.call(`/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`, principal,
      { method: "POST", body: JSON.stringify({ expected_revision: command.expected_revision, decision: command.decision }) });
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
