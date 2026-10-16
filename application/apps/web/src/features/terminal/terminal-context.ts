import type { ApplicationInstance } from "../../../../../packages/core/src/applications.js";

export type TerminalContext = {
  instanceId: string;
  projectId: string;
  conversationId?: string;
  terminalId: string;
  title: string;
};

/** Display-only metadata, never authority or terminal screen content. The
 * submit boundary freezes the actual selected instance's terminal ID. */
export function composerTerminalContext(
  instance: ApplicationInstance | undefined,
  projectId: string,
  conversationId: string | undefined,
  observed: TerminalContext | null,
) {
  if (instance?.applicationId !== "morphz.terminal") return null;
  const id =
    typeof instance.state.terminalId === "string"
      ? instance.state.terminalId
      : null;
  const title =
    id &&
    observed?.terminalId === id &&
    observed.instanceId === instance.id &&
    observed.projectId === projectId &&
    observed.conversationId === conversationId
      ? observed.title
      : undefined;
  return {
    label: title || (id ? "终端 · 当前会话" : "终端 · 未选择会话"),
    description: id
      ? `关联终端：${id}`
      : "新建或选择终端后，消息将关联同一会话。",
  };
}
