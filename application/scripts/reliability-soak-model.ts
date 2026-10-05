import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";

export const requiredScenarios = [
  "parallel-steering",
  "context-transaction",
  "durable-infer",
  "scheduled-task",
  "host-tool-write",
  "provider-disconnect",
  "host-reopen",
  "runtime-crash-recovery",
] as const;
export type Scenario = (typeof requiredScenarios)[number];

export function positiveMilliseconds(value: string, name: string): number {
  assert.match(value, /^[0-9]+$/, `${name} must be integer milliseconds`);
  const parsed = Number(value);
  assert.ok(
    Number.isSafeInteger(parsed) && parsed > 0,
    `${name} must be positive`,
  );
  return parsed;
}

export type TerminalEvidence = {
  threads: Array<{
    id: string;
    root_turn_id: string;
    generation: number;
    status: string;
  }>;
  outcomes: Array<{
    thread_id: string;
    root_turn_id: string;
    thread_generation: number;
    terminal_kind: string;
  }>;
  liveActivations: Array<unknown>;
  pendingSignals: Array<unknown>;
};

/** Persisted authority, not visible reply text or an elapsed timer, decides
 * whether a root actually reached exactly one terminal outcome. */
export function assertTerminalRoot(
  root: string,
  evidence: TerminalEvidence,
  allowedStatuses: readonly string[] = ["completed"],
) {
  assert.equal(evidence.threads.length, 1, `${root}: exactly one Thread`);
  const thread = evidence.threads[0]!;
  assert.equal(thread.root_turn_id, root);
  assert.ok(
    allowedStatuses.includes(thread.status),
    `${root}: unexpected ${thread.status}`,
  );
  assert.equal(
    evidence.outcomes.length,
    1,
    `${root}: exactly one durable outcome`,
  );
  const outcome = evidence.outcomes[0]!;
  assert.equal(outcome.thread_id, thread.id);
  assert.equal(outcome.root_turn_id, root);
  assert.equal(outcome.thread_generation, thread.generation);
  assert.equal(outcome.terminal_kind, thread.status);
  assert.deepEqual(
    evidence.liveActivations,
    [],
    `${root}: no live Activation after terminal`,
  );
  assert.deepEqual(
    evidence.pendingSignals,
    [],
    `${root}: no stranded pending Signal`,
  );
}

export function assertRunComplete(input: {
  elapsedMs: number;
  requestedDurationMs: number;
  cycles: number;
  coverage: Partial<Record<Scenario, number>>;
  unsettledRoots: number;
  maximumVerifiedGapMs?: number;
  allowedVerifiedGapMs?: number;
}) {
  assert.ok(
    input.elapsedMs >= input.requestedDurationMs,
    "Wall-clock soak duration was not reached",
  );
  assert.ok(input.cycles > 0, "No real workload cycle completed");
  assert.equal(input.unsettledRoots, 0, "Unsettled persisted roots remain");
  if (input.maximumVerifiedGapMs !== undefined) {
    assert.ok(
      input.allowedVerifiedGapMs !== undefined &&
        input.maximumVerifiedGapMs <= input.allowedVerifiedGapMs,
      "Unobserved or suspended interval exceeded the continuity budget",
    );
  }
  for (const scenario of requiredScenarios)
    assert.ok(
      (input.coverage[scenario] ?? 0) > 0,
      `No actual evidence for ${scenario}`,
    );
}

export function observeVerifiedGap(
  nowMs: number,
  lastVerifiedMs: number,
  previousMaximumMs: number,
  budgetMs: number,
): number {
  assert.ok(
    nowMs >= lastVerifiedMs,
    "Wall clock moved backwards during the run",
  );
  const maximum = Math.max(previousMaximumMs, nowMs - lastVerifiedMs);
  assert.ok(
    maximum <= budgetMs,
    "Machine suspend or an unverified interval exceeded the workload continuity budget",
  );
  return maximum;
}

/** Every cleanup stage gets an independent attempt, even when an earlier
 * stage throws. A timeout is unconfirmed cleanup, never success. */
export async function runCleanupStages(
  stages: Array<{
    name: string;
    run: () => void | Promise<void>;
    timeoutMs?: number;
  }>,
) {
  const failures: Array<{ stage: string; error: string }> = [];
  for (const stage of stages) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(stage.run),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("cleanup timeout; completion unconfirmed")),
            stage.timeoutMs ?? 20_000,
          );
        }),
      ]);
    } catch (error) {
      failures.push({
        stage: stage.name,
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return failures;
}

/** Only the generated one-socket relay folder is removable. Unexpected files
 * or symlinks preserve the exact folder and make cleanup fail. */
export function cleanupOwnedProxyDirectory(directory: string) {
  assert.match(basename(directory), /^morphz-soak-proxy-[A-Za-z0-9]+$/);
  const info = lstatSync(directory);
  assert.ok(info.isDirectory() && !info.isSymbolicLink());
  if (process.platform !== "win32") {
    assert.equal(info.uid, process.getuid!());
    assert.equal(info.mode & 0o077, 0);
  }
  const entries = readdirSync(directory);
  assert.ok(
    entries.every((name) => name === "tools.sock"),
    "Unexpected proxy-folder content is preserved",
  );
  const endpoint = join(directory, "tools.sock");
  if (existsSync(endpoint)) {
    assert.ok(
      lstatSync(endpoint).isSocket(),
      "Unexpected endpoint is preserved",
    );
    unlinkSync(endpoint);
  }
  rmdirSync(directory);
}
