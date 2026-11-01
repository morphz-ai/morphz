import type { ExecutionThread } from "../../core/src/execution.js";
import type { RuntimeRequest } from "./execution.js";
import {
  executionRecordThread,
  type RuntimeExecutionRecords,
} from "./execution-thread-tree.js";
/** The exact authorized native page already owns wait/phase metadata. Reading
 * one Thread must never open its Context's sibling scheduler directory. */
export async function executionThreadsWithWait(
  _request: RuntimeRequest,
  records: RuntimeExecutionRecords,
): Promise<ExecutionThread[]> {
  return records.threads.map(executionRecordThread);
}
