import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AgentTools,
  type HostInvocation,
  type ToolScope,
} from "../packages/application/src/agent-tools.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import {
  PlatformAgentTools,
  type PlatformAgentDomain,
} from "../packages/application/src/platform-agent-tools.js";
import { RuntimeBridge } from "../packages/application/src/runtime.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { IdentityCenter } from "../packages/application/src/identity.js";
import type { ReaderOcr } from "../packages/application/src/reader-ocr.js";
import { localAccess, morphzAgentAccess } from "../packages/core/src/model.js";
import type { ReadingInput } from "../packages/core/src/reader.js";
import type { ScriptGeneration } from "../packages/core/src/script-studio.js";
import type { PlatformActor } from "../packages/platform/src/store.js";
import { storedData } from "./platform-local-input-fixture.js";

/** Real Platform, app private stores and RuntimePlatformAuthority. Only the
 * Runtime's accepted thread/event reads are controlled; no model is executed. */
export async function agentDomainFixture(
  options: {
    readUnderstanding?: PlatformAgentDomain["readUnderstanding"];
    assertProjectInputsSettled?: (projectId: string) => Promise<void>;
    additionalHumans?: { principalId: string; actantId: string }[];
    // Real HTTP login tests supply valid 64-hex credentials; other domain
    // fixtures intentionally do not establish browser login sessions.
    loginTokenForHuman?: (human: {
      principalId: string;
      actantId: string;
    }) => string;
    readerOcr?: ReaderOcr;
    prepareTaskSession?: PlatformAgentDomain["prepareTaskSession"];
    storage?: Parameters<typeof openApplicationDomainsHost>[3];
    // Reuse only the generated HTTP E2E center, never a user's live database.
    existingCenter?: {
      directory: string;
      projectId: string;
      identityConfiguration?: unknown;
    };
  } = {},
) {
  const existing = options.existingCenter;
  if (
    existing &&
    (!isAbsolute(existing.directory) ||
      !basename(existing.directory).startsWith("morphz-e2e-") ||
      !lstatSync(existing.directory).isDirectory())
  )
    throw new Error("Only a generated isolated E2E center can be reused");
  const directory =
    existing?.directory ?? mkdtempSync(join(tmpdir(), "morphz-agent-domain-"));
  const filename = join(directory, "workspace.sqlite");
  const transport = new WorkspaceStore(filename, { mode: "transport" });
  const createIdentity = () =>
    existing?.identityConfiguration !== undefined
      ? new IdentityCenter(transport, existing.identityConfiguration)
      : options.additionalHumans?.length
        ? new IdentityCenter(transport, {
            version: 1,
            members: [localAccess, ...options.additionalHumans].map(
              (human) => ({
                ...human,
                loginTokenHash: createHash("sha256")
                  .update(
                    options.loginTokenForHuman?.(human) ??
                      `synthetic-login-${human.principalId}`,
                  )
                  .digest("hex"),
                enabled: true,
              }),
            ),
          })
        : undefined;
  let identity = createIdentity();
  let domains = await openApplicationDomainsHost(
    directory,
    transport,
    identity,
    options.storage,
  );
  let domainsOpen = true;
  const projectId = existing?.projectId ?? "agent-test-project";
  const roots = new Map<
    string,
    {
      route: HostInvocation;
      inputId: string;
      projectId: string;
      text: string;
      selection: string;
      reading?: ReadingInput;
      scriptGeneration?: ScriptGeneration;
    }
  >();
  let resolveScope: ((route: HostInvocation) => Promise<ToolScope>) | undefined;
  type ControlledExecution = { state: string; cancelRequested: boolean };
  const executions = () =>
    (transport.serviceState("fixture-input-execution") ?? {}) as Record<
      string,
      ControlledExecution
    >;
  const setExecution = (
    inputId: string,
    state: string | null,
    cancelRequested = false,
  ) => {
    const values = executions();
    if (state === null) delete values[inputId];
    else values[inputId] = { state, cancelRequested };
    transport.saveServiceState("fixture-input-execution", values);
  };
  const runtime = {
    teamIdentity: false,
    bindPlatformInputAuthority() {},
    bindPlatformReadAuthority() {},
    bindMessageAttachments() {},
    async assertPlatformInputActive(inputId: string) {
      // The lifecycle is controlled, but use the production delivery gate.
      // Persistence here tests Host reopen, not a real Runtime cancel RPC.
      await RuntimeBridge.prototype.assertPlatformInputActive.call(
        {
          state: {
            deliveries: Object.entries(executions()).map(([id, execution]) => ({
              inputId: id,
              platformSource: {},
              ...execution,
            })),
          },
        } as unknown as RuntimeBridge,
        inputId,
      );
    },
    assertProjectInputsSettled:
      options.assertProjectInputsSettled ??
      (async () => {
        throw new Error("此夹具未配置 Runtime 项目执行状态。");
      }),
    bindPlatformAgentScope(value: typeof resolveScope) {
      resolveScope = value;
    },
    inputEvidenceReader: () => ({
      async readThread(sessionId: string, threadId: string) {
        const root = roots.get(threadId);
        if (!root || root.route.session_id !== sessionId)
          throw new Error("Unknown fixture thread");
        return {
          snapshot: {
            thread: {
              id: threadId,
              session_id: sessionId,
              context_id: root.route.context_id,
              root_turn_id: root.inputId,
              initiating_principal_id: root.route.principal_id,
              agent_id: root.route.agent_id,
              executor_kind: "agent",
              executor_id: null,
            },
          },
        };
      },
      async readSessionEvent(sessionId: string, eventId: string) {
        const root = [...roots.values()].find(
          (entry) =>
            entry.inputId === eventId && entry.route.session_id === sessionId,
        );
        if (!root) throw new Error("Unknown fixture input");
        return {
          id: eventId,
          actor: "Session-Client",
          type: "session_message",
          topic: "chat/user_message",
          payload: {
            session_id: sessionId,
            context_id: root.route.context_id,
            principal_id: root.route.principal_id,
            client_message_id: root.inputId,
            session_io: {
              request: {
                io_version: "1",
                client_message_id: root.inputId,
                message: {
                  format: { id: "morphz.application.input", version: "1" },
                  content: {
                    encoding: "json",
                    value: storedData({
                      input_id: root.inputId,
                      workspace_id: root.projectId,
                      author_actant_id: localAccess.actantId,
                      text: root.text,
                      selection: root.selection,
                      ...(root.reading ? { reading: root.reading } : {}),
                      ...(root.scriptGeneration
                        ? { scriptGeneration: root.scriptGeneration }
                        : {}),
                    }),
                  },
                },
              },
            },
          },
        };
      },
    }),
  } as unknown as RuntimeBridge;
  const withHuman = <T>(work: (actor: PlatformActor) => Promise<T>) =>
    domains.work.authority.withSession(localAccess, () => {}, work);
  await withHuman(async (actor) => {
    if (existing) await domains.content.platform.getProject(actor, projectId);
    else
      await domains.work.service.createProject(actor, {
        commandId: randomUUID(),
        projectId,
        title: "Agent 正式领域测试",
      });
  });
  let bound = domains.bindRuntime(runtime);
  const input = (
    ownerProjectId = projectId,
    text = "合成的已接收请求",
    selection = "",
    reading?: ReadingInput,
    source?: { inputId: string; scriptGeneration?: ScriptGeneration },
  ) => {
    const inputId =
      source?.inputId ?? `input_${randomUUID().replaceAll("-", "")}`;
    const route: HostInvocation = {
      job_id: "fixture-job",
      tool_call_id: "fixture-call",
      session_id: "fixture-shared-session",
      context_id: "fixture-shared-context",
      principal_id: "fixture-runtime-human",
      agent_id: "fixture-runtime-agent",
      thread_id: `thread_${inputId}`,
      target_id: "fixture-target",
    };
    roots.set(route.thread_id, {
      route,
      inputId,
      projectId: ownerProjectId,
      text,
      selection,
      ...(reading ? { reading: structuredClone(reading) } : {}),
      ...(source?.scriptGeneration
        ? { scriptGeneration: structuredClone(source.scriptGeneration) }
        : {}),
    });
    setExecution(inputId, "running");
    return route;
  };
  const route = input();
  const readAcceptedInput = async (invocation: HostInvocation) => {
    const root = roots.get(invocation.thread_id);
    if (!root) throw new Error("Unknown fixture input");
    return {
      input_id: root.inputId,
      workspace_id: root.projectId,
      text: root.text,
      selection: root.selection,
      ...(root.reading ? { reading: structuredClone(root.reading) } : {}),
      ...(root.scriptGeneration
        ? { scriptGeneration: structuredClone(root.scriptGeneration) }
        : {}),
    };
  };
  const createTools = (token = "test-host-token") =>
    new AgentTools({
      token,
      resolveScope: (invocation) => resolveScope!(invocation),
      platformInput: readAcceptedInput,
      platformAgent: new PlatformAgentTools({
        authority: bound.authority,
        work: domains.work.service,
        content: domains.content,
        reader: domains.reader.service,
        readerOcr: options.readerOcr,
        prepareTaskSession: options.prepareTaskSession,
        inputForInvocation: readAcceptedInput,
        ...(options.readUnderstanding
          ? { readUnderstanding: options.readUnderstanding }
          : {}),
      }),
      bookmarkDomain: { authority: bound.authority, service: bound.service },
    });
  let tools = createTools();
  return {
    directory,
    transport,
    get identity() {
      return identity;
    },
    projectId,
    route,
    input,
    readAcceptedInput,
    setInputExecution(
      state: string | null,
      cancelRequested = false,
      invocation: HostInvocation = route,
    ) {
      const root = roots.get(invocation.thread_id);
      if (!root) throw new Error("Unknown fixture input");
      setExecution(root.inputId, state, cancelRequested);
    },
    forgetInput(invocation: HostInvocation) {
      roots.delete(invocation.thread_id);
    },
    withHuman,
    createTools,
    withAgent<T>(
      work: (actor: PlatformActor) => Promise<T>,
      invocation: HostInvocation = route,
    ) {
      return bound.authority.withInvocation(invocation, (actor) => work(actor));
    },
    get domains() {
      return domains;
    },
    get tools() {
      return tools;
    },
    envelope(args: unknown, invocation: HostInvocation = route) {
      return {
        protocol: 1,
        tool: "host_morphz",
        invocation: {
          ...invocation,
          job_id: randomUUID(),
          tool_call_id: randomUUID(),
        },
        arguments: args,
      };
    },
    async call<T>(
      args: unknown,
      invocation: HostInvocation = route,
    ): Promise<T> {
      return (await tools.call(this.envelope(args, invocation))) as T;
    },
    async reopen() {
      await domains.unbindRuntime(bound.authority);
      await domains.close();
      domainsOpen = false;
      identity = createIdentity();
      domains = await openApplicationDomainsHost(
        directory,
        transport,
        identity,
        options.storage,
      );
      domainsOpen = true;
      bound = domains.bindRuntime(runtime);
      tools = createTools();
    },
    assertNoLegacyData() {
      const db = new DatabaseSync(filename, { readOnly: true });
      try {
        assert.deepEqual(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspace','commands','assets','artifact_outputs','script_outputs')",
            )
            .all(),
          [],
        );
      } finally {
        db.close();
      }
    },
    async close() {
      if (domainsOpen) {
        await domains.unbindRuntime(bound.authority);
        await domains.close();
        domainsOpen = false;
      }
      transport.close();
      if (!existing) rmSync(directory, { recursive: true, force: true });
    },
    agentAccess: morphzAgentAccess,
  };
}
