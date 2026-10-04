import type { LiveMessage } from "../../packages/core/src/live-conversation.js";
import type { Workspace } from "../../packages/core/src/model.js";
import {
  textQuoteSourceSchema,
  type TextQuote,
} from "../../packages/core/src/text-quotes.js";

// In-memory facts only. Both lanes mount the complete production renderer;
// the explicitly requested historical lane loads an independently archived
// Git298 component, never an oracle synthesized from the current component.
export const viewportTime = "2026-10-04T00:00:00.000Z";
export const viewportOriginalGit = "29863c3f227edd6267826e423f764b17779024f1";
export const viewportOriginalSha =
  "13dcd2ff49330cd1e19ef065934ec61633fcae943111cb1022f46522cf738d7f";

export function viewportInput(
  id: string,
  artifactId = "object-A",
): Workspace["inputs"][number] {
  return {
    id,
    projectId: "first-project",
    conversationId: "conversation-A",
    artifactId,
    artifactRevision: 1,
    selection: "",
    targetActantId: "morphz",
    status: "recorded",
    body: "Human input " + id,
    createdAt: viewportTime,
    author: { principalId: "human", actantId: "human" },
  };
}

export function viewportReply(
  id: string,
  text = "Quote passage " + id + " / " + "readable body ".repeat(15),
  inputId = "input-A",
): LiveMessage {
  return {
    id,
    projectId: "first-project",
    conversationId: "conversation-A",
    artifactId: null,
    inputId,
    rootId: null,
    createdAt: viewportTime,
    text,
    kind: "reply",
  };
}

export function viewportQuote(
  messageId: string,
  text = "Quote passage",
): TextQuote {
  return {
    id: "f64db8b2-4003-440c-9e84-c6846d5ca388",
    // Actual quote capture parses this source schema before passing it to the
    // viewport; preserve that source shape (including its key order).
    source: textQuoteSourceSchema.parse({
      kind: "message",
      messageId,
      inputId: "input-A",
      projectId: "first-project",
      conversationId: "conversation-A",
      title: "Morphz",
      createdAt: viewportTime,
    }),
    text,
    comment: "",
  };
}

export function viewportMessages() {
  return Array.from({ length: 14 }, (_, index) =>
    viewportReply(
      "reply-" + index,
      undefined,
      index % 2 ? "input-B" : "input-A",
    ),
  );
}
