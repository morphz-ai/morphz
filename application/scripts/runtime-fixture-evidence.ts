/** Public CI evidence for synthetic Runtime tests. Raw fixture stores stay local;
 * only bounded causal/status fields and explicitly redacted logs are exported. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function redactFixtureEvidence(
  text: string,
  secrets: readonly string[],
) {
  let value = text;
  for (const secret of secrets.filter(Boolean))
    value = value.split(secret).join("[redacted]");
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /((?:token|password|api[_-]?key|authorization)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    );
}

const eventKeys = [
  "thread_id",
  "activation_id",
  "root_turn_id",
  "session_id",
  "context_id",
  "caused_by",
  "trigger_event_id",
  "trigger_sequence",
  "thread_generation",
  "response_annotations",
  "reason",
  "runtime_failure_kind",
  "runtime_failure_stage",
  "terminal_kind",
  "disposition",
  "tool_name",
  "tool_call_id",
  "tool_status",
  "execution_job_id",
  "error_count",
  "invalid_responses",
] as const;

export function fixtureEventEvidence(
  row: Record<string, unknown>,
): Record<string, unknown> {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(String(row.payload));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      payload = parsed as Record<string, unknown>;
  } catch {
    /* Malformed payload is evidence, never permission to dump raw bytes. */
  }
  const fields = Object.fromEntries(
    eventKeys.flatMap<[string, string | number | boolean]>((key) => {
      const value = payload[key];
      return typeof value === "string"
        ? [[key, value.slice(0, 4096)]]
        : typeof value === "number" || typeof value === "boolean"
          ? [[key, value]]
          : [];
    }),
  );
  return { id: row.id, timestamp: row.timestamp, topic: row.topic, ...fields };
}

export function retainFixtureFailure(options: {
  databasePath: string;
  directory: string;
  logs: string;
  error: unknown;
  secrets: readonly string[];
  metadata: {
    test: string;
    nodeVersion: string;
    providerCalls: number;
    binaryVersion: string;
  };
}) {
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  let events: ReturnType<typeof fixtureEventEvidence>[] = [];
  let outcomes: unknown[] = [];
  let readError: string | undefined;
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(options.databasePath, { readOnly: true });
    events = database
      .prepare(
        `SELECT id, timestamp, topic, payload FROM events
      WHERE topic IN ('runtime/response_protocol_error', 'runtime/response_protocol_fused',
        'session/io_state', 'chat/runtime_error', 'chat/tool_output', 'chat/cancelled')
      ORDER BY timestamp DESC, id DESC LIMIT 100`,
      )
      .all()
      .map(fixtureEventEvidence);
    outcomes = database
      .prepare(
        `SELECT thread_id, root_turn_id, activation_id, session_id,
      terminal_kind, disposition, event_id, created_at FROM thread_outcomes
      ORDER BY created_at DESC, thread_id DESC LIMIT 100`,
      )
      .all();
  } catch (error) {
    readError = error instanceof Error ? error.message : String(error);
  } finally {
    database?.close();
  }
  const evidence = {
    schema: "morphz.synthetic-runtime-failure.v1",
    ...options.metadata,
    capturedAt: new Date().toISOString(),
    error:
      options.error instanceof Error
        ? options.error.stack
        : String(options.error),
    replay:
      "npm --prefix application run test:runtime-ipc (fresh isolated synthetic fixture)",
    // Outcome plus causal events distinguish a physical-tool failure from final reply rejection.
    events,
    outcomes,
    ...(readError ? { evidenceReadError: readError } : {}),
    rawDatabaseExported: false,
  };
  writeFileSync(
    join(options.directory, "failure.json"),
    redactFixtureEvidence(JSON.stringify(evidence, null, 2), options.secrets),
    { mode: 0o600 },
  );
  writeFileSync(
    join(options.directory, "runtime.log"),
    redactFixtureEvidence(options.logs.slice(-12000), options.secrets),
    { mode: 0o600 },
  );
  const cause = events.find(
    (event) => event.topic === "runtime/response_protocol_error",
  );
  return cause
    ? (JSON.parse(
        redactFixtureEvidence(JSON.stringify(cause), options.secrets),
      ) as Record<string, unknown>)
    : undefined;
}
