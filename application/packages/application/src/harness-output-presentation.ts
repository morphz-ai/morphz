/** Domain presentation, not Yao delivery semantics or authorization. The Host
 * attaches this only after resolving the real infer root and original input.
 * Never infer an application contract from keys in model-produced JSON. */
export function harnessOutputTextPath(
  root: { topic: string; payload: Record<string, unknown> } | null | undefined,
  harness: { id: string; version: string } | null | undefined,
): string[] | undefined {
  if (
    root?.topic !== "chat/infer_request" ||
    harness?.id !== "morphz.script-studio" ||
    !["2.2.0", "2.3.0"].includes(harness.version)
  )
    return;
  const request = root.payload.request as { program?: unknown } | undefined;
  // Runtime stores compiler-authored canonical Yao here. Inspect only its
  // declaration prefix; a type name mentioned inside a prompt proves nothing.
  if (
    typeof request?.program === "string" &&
    /^\(infer\s+(?:\(captures(?:\s+[^\s()]+)*\)\s+)?\(returns\s+ScriptIntent\)(?=\s)/u.test(
      request.program.slice(0, 2048),
    )
  )
    return ["reply"];
}
