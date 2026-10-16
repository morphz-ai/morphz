import type { ExecutionScope } from "../../../../packages/core/src/execution.js";
import {
  terminalCatalogSchema,
  terminalViewSchema,
  terminalCommandSchema,
  terminalReceiptSchema,
  terminalOpenSchema,
  terminalOpenReceiptSchema,
  type TerminalCommand,
} from "../../../../packages/core/src/terminal.js";
import type { applicationCall } from "../application-transport.js";

/** Bounded reads and explicitly authenticated keyboard control. No local
 * process, output cache, credential store, Thread history or implicit input. */
export function createTerminalInteractions(call: typeof applicationCall) {
  const options = (signal?: AbortSignal) => ({
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000),
  });
  return {
    terminalOpen: async (scope: ExecutionScope, commandId: string) =>
      terminalOpenReceiptSchema.parse(
        await call(
          "terminal.open",
          terminalOpenSchema.parse({ scope, commandId }),
          options(),
        ),
      ),
    terminalCommand: async (
      scope: ExecutionScope,
      terminalId: string,
      command: TerminalCommand,
    ) =>
      terminalReceiptSchema.parse(
        await call(
          "terminal.command",
          terminalCommandSchema.parse({ scope, terminalId, command }),
          options(),
        ),
      ),
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
