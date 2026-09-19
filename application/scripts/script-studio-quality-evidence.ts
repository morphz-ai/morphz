import { z } from "zod";

const workflowReceipt = z.object({
  ok: z.literal(true),
  generating: z.literal(true),
  materials: z.array(
    z.object({
      draft: z.object({ text: z.string() }),
      sources: z.array(z.object({ text: z.string() })),
    }),
  ),
});

/** Inspect decoded Host receipts, not JSON-escaped event strings or model echoes. */
export function receivedWorkflowText(
  outputs: readonly unknown[],
  expected: string,
  kind: "source" | "draft",
): boolean {
  return outputs.some((output) => {
    const event = z
      .object({ tool_name: z.literal("host_morphz"), text: z.string() })
      .safeParse(output);
    if (!event.success) return false;
    let body: unknown;
    try {
      body = JSON.parse(event.data.text);
    } catch {
      return false;
    }
    const receipt = workflowReceipt.safeParse(body);
    return (
      receipt.success &&
      receipt.data.materials.some((material) =>
        kind === "source"
          ? material.sources.some((source) => source.text === expected)
          : material.draft.text === expected,
      )
    );
  });
}
