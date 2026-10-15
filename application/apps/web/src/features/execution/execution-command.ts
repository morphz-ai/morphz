import type { ExecutionSnapshot } from "../../../../../packages/core/src/execution.js";

const maximum = 12_000;
const prefix = (value: string, limit: number) => {
  let end = Math.min(value.length, limit);
  if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1] ?? "")) end--;
  return value.slice(0, end);
};

/** The exact authorized Job's command, not an inferred purpose. These common
 * credential forms are masked only in the display; this is not a shell parser,
 * a complete secret detector, or an execution/authorization transformation. */
export function executionCommand(job: ExecutionSnapshot["jobs"][number]) {
  if (
    !["exec", "exec/background", "exec_command", "terminal"].includes(
      job.tool_name,
    )
  )
    return null;
  const args = job.request;
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const request = args as Record<string, unknown>;
  if (job.tool_name === "terminal" && request.action !== "write") return null;
  const raw =
    job.tool_name === "terminal"
      ? request.text
      : (request.command ??
        (job.tool_name === "exec_command" ? request.cmd : null));
  if (typeof raw !== "string" || !raw.trim()) return null;
  const bounded = prefix(raw.trim(), maximum);
  const value = bounded
    .replace(
      /(\b[\w-]*(?:api[_-]?key|token|secret|password|passwd|credential)[\w-]*\s*=\s*)(?:"[^"\n]*(?:"|$)|'[^'\n]*(?:'|$)|[^\s;|&]+)/gi,
      "$1[已隐藏]",
    )
    .replace(
      /(--(?:api[-_]?key|access[-_]?token|token|secret|password|passwd|credential|cookie|authorization)(?:=|\s+))(?:"[^"\n]*(?:"|$)|'[^'\n]*(?:'|$)|[^\s;|&]+)/gi,
      "$1[已隐藏]",
    )
    .replace(/((?:Authorization|Cookie)\s*:\s*)[^\r\n]+/gi, "$1[已隐藏]")
    .replace(/(https?:\/\/)[^/\s@]+@/gi, "$1[已隐藏]@")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/g, "[已隐藏]");
  return {
    value,
    preview: prefix(value, 600),
    expandable: value.length > 120 || value.includes("\n"),
    truncated: bounded.length < raw.trim().length,
  };
}
