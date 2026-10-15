import type { ExecutionScope } from "../../../../packages/core/src/execution.js";
import {
  terminalCatalogSchema,
  terminalViewSchema,
} from "../../../../packages/core/src/terminal.js";
import type { applicationCall } from "../application-transport.js";

/** Read-only, bounded Runtime projections. No local process, terminal output
 * cache, credential store, Thread history, or implicit command submission. */
export function createTerminalInteractions(call: typeof applicationCall) {
  const options = (signal?: AbortSignal) => ({
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000),
  });
  return {
    terminalCatalog: async (scope: ExecutionScope, signal?: AbortSignal) =>
      terminalCatalogSchema.parse(
        await call("terminal.catalog", scope, options(signal)),
      ),
    terminalRead: async (
      scope: ExecutionScope,
      terminalId: string,
      scrollback: number,
      signal?: AbortSignal,
    ) =>
      terminalViewSchema.parse(
        await call(
          "terminal.read",
          { scope, terminalId, scrollback },
          options(signal),
        ),
      ),
  };
}
