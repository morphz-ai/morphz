/** Synthetic providers must obey the control schema offered by the real Runtime.
 * This helper is only for final replies, never scripted physical tools or infer
 * output. Production admission/normalization remains the authority. */
import { randomUUID } from "node:crypto";

export type FixtureFinalReply = {
  message: {
    role: "assistant";
    content: string;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  };
  finishReason: "tool_calls" | "stop";
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function runtimeFixtureFinalReply(
  request: { tools?: unknown },
  result: { content: string; title: string; result: string },
  callId: string = randomUUID(),
): FixtureFinalReply {
  const offered = Array.isArray(request.tools)
    ? request.tools.some((value: unknown) => {
        const tool = record(value);
        const definition = record(tool?.function) ?? tool;
        const properties = record(record(definition?.parameters)?.properties);
        const annotations = record(record(properties?.annotations)?.properties);
        const execution = record(record(annotations?.execution)?.properties);
        return (
          definition?.name === "reply" &&
          record(properties?.content)?.type === "string" &&
          record(execution?.title)?.type === "string" &&
          record(execution?.result)?.type === "string"
        );
      })
    : false;
  if (!offered) {
    return {
      message: { role: "assistant", content: result.content },
      finishReason: "stop",
    };
  }
  return {
    message: {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: callId,
          type: "function",
          function: {
            name: "reply",
            arguments: JSON.stringify({
              content: result.content,
              annotations: {
                execution: { title: result.title, result: result.result },
              },
            }),
          },
        },
      ],
    },
    finishReason: "tool_calls",
  };
}
