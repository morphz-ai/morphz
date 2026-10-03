import {
  discussionId,
  type Artifact,
  type InputDispatchMode,
  type Operation,
  type Receipt,
  type RecordedInput,
} from "../../../../packages/core/src/model.js";
import type { DirectoryGrant } from "../../../../packages/core/src/local-files.js";
import { quotedInputText } from "../../../../packages/core/src/text-quotes.js";
import type { ReadingSurface } from "../reading-context-model.js";
import type { ConversationDraft, InputDraft } from "./exchange-drafts.js";

type RecordInput = Extract<Operation, { type: "record-input" }>;
export type ExchangeSubmissionResult = {
  kind: "input" | "supplement" | "annotation" | "task-result";
  receipt: Receipt;
};
export type ExchangeSubmissionContext = {
  projectId: string;
  conversationId: string;
  firstConversation: ConversationDraft | undefined;
  artifact: Pick<Artifact, "id" | "revision"> | undefined;
  activeInstance:
    { applicationId: string; applicationVersion: string } | undefined;
  browserPage: RecordInput["browser"] | null;
  readingExpected: boolean;
  currentReading: ReadingSurface | null;
  canAuthorizeDirectories: boolean;
  directoryScope: string;
  directoryState: { scope: string; ready: boolean; grants: DirectoryGrant[] };
  capabilities: {
    directedInput: boolean | undefined;
    conversationOnFirstInput: boolean | undefined;
    runtimeConfigured: boolean | undefined;
  };
};
export type ExchangeSubmissionPorts = {
  execute(
    operation: Operation,
    dispatch?: boolean,
    applicationInstanceId?: undefined,
    commandId?: string,
    onInputStaged?: (inputId: string) => void,
  ): Promise<Receipt>;
  profile: {
    flush(): Promise<void>;
    assertCurrentScope(): void;
  };
  isCurrentSurface(): boolean;
  originalInput(id: string): RecordedInput | undefined;
  persistSupplement(
    command: NonNullable<InputDraft["pendingSupplement"]>,
  ): void;
  onInputStaged(inputId: string): void;
  onResolved(result: ExchangeSubmissionResult): void;
  onRejected(error: unknown): void;
  onSettled(): void;
};

/** Submit a captured render's request through the existing typed gateway.
 * Owns admission/order/payload, not storage, UI state, navigation or authority.
 * `captured` is the Host's original shallow snapshot; reading capture mutates
 * that same object at the original point. Retry payloads and outbox persistence
 * remain with their existing owners. The original catch/finally feedback is
 * synchronous through semantic ports; no extra retry/implicit dispatch is added. */
export async function submitExchangeDraft(
  captured: InputDraft,
  asAnnotation: boolean,
  dispatchMode: InputDispatchMode,
  context: ExchangeSubmissionContext,
  ports: ExchangeSubmissionPorts,
): Promise<void> {
  const {
    projectId,
    conversationId,
    firstConversation,
    artifact,
    activeInstance,
    browserPage,
    readingExpected,
    currentReading,
    canAuthorizeDirectories,
    directoryScope,
    directoryState,
    capabilities,
  } = context;
  try {
    if (
      !asAnnotation &&
      !captured.continuation &&
      !captured.taskResult &&
      !captured.scriptGeneration &&
      !captured.reading &&
      !captured.selection &&
      !captured.textQuotes?.length &&
      !captured.skipReading &&
      readingExpected
    ) {
      const focus = currentReading?.capture();
      if (!focus)
        throw new Error(
          "当前阅读内容仍在加载或无法读取，请稍后发送；草稿已保留。",
        );
      captured.reading = structuredClone(focus.reference);
      captured.revision = currentReading!.revision;
      captured.selection = focus.selected ? focus.reference.quote : "";
    }
    if (
      !captured.continuation &&
      canAuthorizeDirectories &&
      (directoryState.scope !== directoryScope || !directoryState.ready)
    )
      throw new Error("目录授权尚未确认，请稍后发送；草稿已保留。");
    if (
      asAnnotation &&
      (!artifact || !captured.selection || !captured.revision)
    )
      throw new Error("选区已失效，请重新选择文字。");
    if (
      !captured.continuation &&
      (asAnnotation || captured.taskResult) &&
      captured.attachments?.length
    )
      throw new Error(
        "批注与事项结果暂不支持附件，请移除附件或改为发送消息；草稿已保留。",
      );
    let result: ExchangeSubmissionResult;
    if (captured.continuation) {
      const original = ports.originalInput(captured.continuation.inputId);
      if (!original) throw new Error("原请求已不可用，草稿已保留。");
      if (!capabilities.directedInput || !capabilities.runtimeConfigured)
        throw new Error("当前连接不支持定向补充，草稿已保留。");
      const command = captured.pendingSupplement ?? {
        commandId: crypto.randomUUID(),
        operation: {
          type: "record-input" as const,
          continuation: captured.continuation,
          projectId: original.projectId,
          conversationId: discussionId(original),
          artifactId: original.artifactId,
          artifactRevision: original.artifactRevision,
          selection: "",
          body: captured.body,
          ...(captured.textQuotes?.length
            ? { textQuotes: captured.textQuotes }
            : {}),
          targetActantId: original.targetActantId,
          ...(captured.attachments?.length
            ? { attachments: captured.attachments }
            : {}),
        },
      };
      // Preserve before transport: an uncertain receipt must reuse these bytes.
      ports.persistSupplement(command);
      const receipt = await ports.execute(
        command.operation,
        true,
        undefined,
        command.commandId,
      );
      result = { kind: "supplement", receipt };
    } else if (captured.taskResult && !asAnnotation) {
      if (captured.taskResult.taskId !== artifact?.id)
        throw new Error("请回到这件事项后提交结果，草稿已保留。");
      const receipt = await ports.execute({
        type: "respond-task",
        taskId: captured.taskResult.taskId,
        expectedRevision: captured.taskResult.revision,
        body: quotedInputText(captured.body, captured.textQuotes),
      });
      result = { kind: "task-result", receipt };
    } else if (
      asAnnotation &&
      artifact &&
      captured.selection &&
      captured.revision
    ) {
      const receipt = await ports.execute({
        type: "annotate",
        artifactId: artifact.id,
        artifactRevision: captured.revision,
        quote: captured.selection,
        ...(captured.page ? { page: captured.page } : {}),
        body: quotedInputText(captured.body, captured.textQuotes),
      });
      result = { kind: "annotation", receipt };
    } else {
      if (firstConversation && !capabilities.conversationOnFirstInput)
        throw new Error(
          "当前版本不支持新建会话，请更新应用；草稿已保留，现有会话仍可使用。",
        );
      // Only a new root drains current Profile; supplements retain their binding.
      await ports.profile.flush();
      ports.profile.assertCurrentScope();
      if (!ports.isCurrentSurface())
        throw new Error("工作范围已切换，草稿已保留，请回到原处发送。");
      const receipt = await ports.execute(
        {
          type: "record-input",
          dispatchMode,
          ...(captured.model ? { model: captured.model } : {}),
          ...(captured.reasoningEffort
            ? { reasoningEffort: captured.reasoningEffort }
            : {}),
          projectId,
          conversationId,
          ...(firstConversation
            ? { newConversation: { title: firstConversation.title } }
            : {}),
          ...(activeInstance
            ? {
                application: {
                  id: activeInstance.applicationId,
                  version: activeInstance.applicationVersion,
                },
              }
            : {}),
          artifactId: artifact?.id ?? null,
          artifactRevision: artifact
            ? (captured.revision ?? artifact.revision)
            : null,
          selection: captured.selection,
          ...(captured.reading ? { reading: captured.reading } : {}),
          body: captured.body,
          ...(captured.textQuotes?.length
            ? { textQuotes: captured.textQuotes }
            : {}),
          ...(captured.scriptGeneration
            ? { scriptGeneration: captured.scriptGeneration }
            : {}),
          ...(canAuthorizeDirectories && directoryState.grants.length
            ? { directories: directoryState.grants }
            : {}),
          ...(captured.attachments?.length
            ? { attachments: captured.attachments }
            : {}),
          ...(browserPage && activeInstance?.applicationId === "morphz.browser"
            ? {
                browser: {
                  pageId: browserPage.pageId,
                  epoch: browserPage.epoch,
                  url: browserPage.url,
                  title: browserPage.title,
                },
              }
            : {}),
          ...(captured.intent ? { intent: captured.intent } : {}),
          targetActantId: "morphz-agent",
        },
        !!capabilities.runtimeConfigured,
        undefined,
        firstConversation?.inputId,
        ports.onInputStaged,
      );
      result = { kind: "input", receipt };
    }
    // Run receipt feedback in the execute continuation, before returning to the
    // Host's finally/catch. It is not a persisted success or a fabricated reply.
    ports.onResolved(result);
  } catch (error) {
    ports.onRejected(error);
  } finally {
    ports.onSettled();
  }
}
