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
import { parseCognitiveAppObjectLocator } from "../../../../packages/core/src/cognitive-app-object-locator.js";
import {
  guardCognitiveAppApplicationCommand,
  parseCognitiveAppApplicationTarget,
  sameCognitiveAppApplicationTarget,
} from "../../../../packages/core/src/cognitive-app-application-target.js";
import { parseWireJson } from "../../../../packages/cognitive-app-sdk/src/protocol.js";
import { parseDomainAuthority } from "../../../../packages/cognitive-app-sdk/src/domain-wire.js";
import {
  cognitiveWorkSurfaceKey,
  type CognitiveWorkSurface,
} from "./work-surface.js";

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
  cognitiveSurface?: CognitiveWorkSurface | null;
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
    cognitiveSurface,
    canAuthorizeDirectories,
    directoryScope,
    directoryState,
    capabilities,
  } = context;
  try {
    guardCognitiveAppApplicationCommand({ operation: captured });
    const applicationSlot = Object.getOwnPropertyDescriptor(
      captured,
      "cognitiveApplication",
    );
    const cognitiveApplication =
      !captured.continuation && applicationSlot?.value !== undefined
        ? parseCognitiveAppApplicationTarget(applicationSlot.value)
        : undefined;
    // Only the new source is detached here; unrelated legacy carriers keep
    // their original snapshot/budget behavior. Supplements never take a new
    // caller source: their immutable original is inherited by the backend.
    const slot = Object.getOwnPropertyDescriptor(captured, "cognitiveObject");
    if (
      (slot && (!("value" in slot) || !slot.enumerable)) ||
      (!slot && "cognitiveObject" in captured)
    )
      throw new Error("原件引用无效，草稿已保留。");
    const cognitiveSource: CognitiveWorkSurface | undefined =
      !captured.continuation && cognitiveSurface
        ? JSON.parse(JSON.stringify(parseWireJson(cognitiveSurface)))
        : undefined;
    const cognitiveObject =
      !captured.continuation && !captured.taskResult && !asAnnotation
        ? slot?.value !== undefined
          ? parseCognitiveAppObjectLocator(slot.value)
          : cognitiveSource?.kind === "original"
            ? parseCognitiveAppObjectLocator(cognitiveSource.locator)
            : undefined
        : undefined;
    const cognitive = !!(
      cognitiveSource ||
      cognitiveObject ||
      cognitiveApplication
    );
    if (
      cognitiveSource &&
      cognitiveSource.kind !== "view" &&
      cognitiveSource.kind !== "original"
    )
      throw new Error("原件工作范围无效，草稿已保留。");
    if (cognitiveSource?.kind === "view")
      parseDomainAuthority(cognitiveSource.authority);
    if (cognitiveSource?.kind === "original")
      parseCognitiveAppObjectLocator(cognitiveSource.locator);
    if (
      cognitiveSource &&
      projectId !==
        (cognitiveSource.kind === "original"
          ? cognitiveSource.locator.projectId
          : cognitiveSource.projectId)
    )
      throw new Error("原件工作范围已有变化，草稿已保留。");
    if (
      cognitiveObject &&
      (cognitiveObject.projectId !== projectId ||
        (cognitiveSource?.kind === "original" &&
          cognitiveWorkSurfaceKey({
            kind: "original",
            locator: cognitiveObject,
          }) !== cognitiveWorkSurfaceKey(cognitiveSource)) ||
        (cognitiveSource?.kind === "view" &&
          (cognitiveSource.projectId !== cognitiveObject.projectId ||
            cognitiveSource.connectionId !== cognitiveObject.connectionId ||
            JSON.stringify(parseDomainAuthority(cognitiveSource.authority)) !==
              JSON.stringify(cognitiveObject.authority))))
    )
      throw new Error("原件工作范围已有变化，草稿已保留。");
    if (
      cognitiveApplication &&
      ((cognitiveObject &&
        !sameCognitiveAppApplicationTarget(cognitiveApplication, {
          connectionId: cognitiveObject.connectionId,
          authority: cognitiveObject.authority,
        })) ||
        (cognitiveSource &&
          !sameCognitiveAppApplicationTarget(
            cognitiveApplication,
            cognitiveSource.kind === "original"
              ? {
                  connectionId: cognitiveSource.locator.connectionId,
                  authority: cognitiveSource.locator.authority,
                }
              : {
                  connectionId: cognitiveSource.connectionId,
                  authority: cognitiveSource.authority,
                },
          )))
    )
      throw new Error("应用目标与原件工作范围不一致，草稿已保留。");
    if (
      cognitive &&
      (asAnnotation ||
        captured.taskResult ||
        artifact ||
        captured.revision !== null ||
        captured.selection ||
        captured.reading ||
        captured.scriptGeneration)
    )
      throw new Error("原输入中已有其他来源或专用请求，草稿已保留。");
    if (
      cognitiveApplication &&
      (captured.annotation ||
        captured.pendingSupplement ||
        captured.continuationFailure ||
        captured.page !== undefined)
    )
      throw new Error("原输入中已有专用请求，草稿已保留。");
    if (
      !asAnnotation &&
      !captured.continuation &&
      !captured.taskResult &&
      !captured.scriptGeneration &&
      !cognitive &&
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
          ...(activeInstance && !cognitive
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
          ...(cognitiveObject ? { cognitiveObject } : {}),
          ...(cognitiveApplication ? { cognitiveApplication } : {}),
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
          ...(browserPage &&
          !cognitive &&
          activeInstance?.applicationId === "morphz.browser"
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
