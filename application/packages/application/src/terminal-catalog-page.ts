import { terminalCatalogSchema } from "../../core/src/terminal.js";
import { DomainError } from "../../core/src/model.js";
import {
  boundedSourcePage,
  type BoundedReadSource,
} from "./bounded-source-page.js";
export type TerminalCatalogSource = BoundedReadSource;
/** The shared source window retains the original Session/root/byte fences. */
export async function terminalCatalogPage(options: {
  owner: readonly unknown[];
  sources: readonly TerminalCatalogSource[];
  cursor?: string;
  read(
    source: TerminalCatalogSource,
    roots: readonly string[],
    cursor: string | null,
  ): Promise<unknown>;
}) {
  const result = await boundedSourcePage({
    ...options,
    parse: terminalCatalogSchema.parse,
    read: async (source, roots, cursor) => {
      const page = terminalCatalogSchema.parse(
        await options.read(source, roots, cursor),
      );
      if (
        page.terminals.some(
          (record) =>
            record.session_id !== source.sessionId ||
            record.context_id !== source.contextId ||
            (record.root_turn_id
              ? !roots.includes(record.root_turn_id)
              : !source.scopeRef ||
                record.scope_ref !== source.scopeRef ||
                record.source_job_id !== null ||
                !record.creation_command_id),
        )
      )
        throw new DomainError("forbidden", "终端来源不属于当前工作范围。");
      return page;
    },
  });
  return {
    ...(result.page ?? { terminals: [], limit: 50 }),
    has_more: result.has_more,
    next_cursor: result.next_cursor,
  };
}
