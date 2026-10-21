import { useEffect, useRef, useState } from "react";
import {
  sessionEvaluationSnapshotSchema,
  type SessionEvaluationDefaults,
  type SessionEvaluationScope,
} from "../../../packages/core/src/session-evaluation.js";
import {
  applicationCall,
  applicationIdentity,
  RequestError,
} from "./application-transport.js";
import {
  SessionEvaluationEditor,
  sessionEvaluationEditorKey,
} from "./session-evaluation-editor.js";

export function useSessionEvaluation({
  enabled,
  online,
  identityGeneration,
  draftKey,
  scope,
  seed,
  onLocalDraft,
}: {
  enabled: boolean;
  online: boolean;
  identityGeneration: string;
  draftKey: string;
  scope?: SessionEvaluationScope;
  seed: SessionEvaluationDefaults;
  onLocalDraft(defaults: SessionEvaluationDefaults): void;
}) {
  const identity = applicationIdentity();
  const key = sessionEvaluationEditorKey({
    identity,
    identityGeneration,
    enabled,
    draftKey,
    scope,
  });
  const current = useRef({ key, online, mounted: true });
  current.current.key = key;
  current.current.online = online;
  const [, changed] = useState(0);
  const localDraft = useRef(onLocalDraft);
  localDraft.current = onLocalDraft;
  const holder = useRef<{
    key: string;
    editor: SessionEvaluationEditor;
  } | null>(null);
  if (holder.current?.key !== key) {
    holder.current?.editor.cancelScheduled();
    const assertScope = () => {
      if (
        current.current.key !== key ||
        !current.current.mounted ||
        applicationIdentity() !== identity
      )
        throw new DOMException(
          "工作范围已切换，旧模型设置操作已取消。",
          "AbortError",
        );
      if (!current.current.online)
        throw new Error("运行服务未连接，模型设置尚未确认。");
    };
    const read = scope
      ? async () => {
          assertScope();
          const actual = sessionEvaluationSnapshotSchema.parse(
            await applicationCall("session-evaluation.read", scope, {
              identityGeneration,
              signal: AbortSignal.timeout(15_000),
            }),
          );
          assertScope();
          if (
            actual.scope.projectId !== scope.projectId ||
            actual.scope.conversationId !== scope.conversationId
          )
            throw new Error("会话模型设置范围不匹配。");
          return actual;
        }
      : undefined;
    holder.current = {
      key,
      editor: new SessionEvaluationEditor(seed, {
        assertScope,
        read,
        async save(defaults, snapshot) {
          assertScope();
          if (!scope) throw new Error("首次发送前的模型选择仅属于草稿。");
          return sessionEvaluationSnapshotSchema.parse(
            await applicationCall(
              "session-evaluation.update",
              { ...scope, defaults, expectedFingerprint: snapshot.fingerprint },
              { identityGeneration, signal: AbortSignal.timeout(15_000) },
            ),
          );
        },
        changed() {
          if (current.current.key === key && current.current.mounted)
            changed((value) => value + 1);
        },
        localDraft(defaults) {
          assertScope();
          localDraft.current(defaults);
        },
        isRejected: (error) =>
          error instanceof RequestError && error.status === 400,
      }),
    };
  }
  const editor = holder.current.editor;
  useEffect(() => {
    current.current.mounted = true;
    if (enabled && online) void editor.refresh().catch(() => {});
    return () => {
      current.current.mounted = false;
      editor.cancelScheduled();
    };
  }, [editor, enabled, online]);
  return {
    enabled,
    ...editor.state,
    edit: (patch: Partial<SessionEvaluationDefaults>) => editor.edit(patch),
    refresh: () => editor.refresh(),
    reconcile: () => editor.refresh(true),
    prepareInput: () => editor.prepareInput(),
  };
}
