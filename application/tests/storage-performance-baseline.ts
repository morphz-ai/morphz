/** Opt-in development baseline; intentionally not named *.test.ts.
 *
 * MORPHZ_TEST_POSTGRES_URL=... npx tsx tests/storage-performance-baseline.ts
 *   --backends sqlite,postgres --levels 1000,10000 --samples 30
 *
 * All business records use the production Human Application APIs. No model,
 * HTTP listener, direct SQL business seed, existing center or user file is used.
 * SQL is read-only size measurement, except creating/dropping our unique PG
 * schemas. Percentiles describe this machine/workload; they are not an SLO.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Pool } from "pg";
import {
  Application,
  type ApplicationSession,
} from "../packages/application/src/application.js";
import { openApplicationDomainsHost } from "../packages/application/src/application-domains-host.js";
import { WorkspaceStore } from "../packages/application/src/store.js";
import { localAccess } from "../packages/core/src/model.js";
import { ObjectsConflictError } from "../packages/objects/src/store.js";

type Backend = "sqlite" | "postgres";
type Storage = Parameters<typeof openApplicationDomainsHost>[3];
type Domains = Awaited<ReturnType<typeof openApplicationDomainsHost>>;
type Document = Awaited<
  ReturnType<ApplicationSession["createPlatformDocument"]>
>;
type Page = Awaited<ReturnType<ApplicationSession["listPlatformContent"]>>;
type Sample = { ms: number; responseBytes: number };
const { values } = parseArgs({
  options: {
    backends: { type: "string", default: "sqlite,postgres" },
    levels: { type: "string", default: "1000,10000" },
    samples: { type: "string", default: "30" },
    "cold-samples": { type: "string", default: "5" },
    concurrency: { type: "string", default: "4" },
    "generation-budget-ms": { type: "string", default: "300000" },
  },
  strict: true,
});
const backends = values.backends.split(",") as Backend[];
assert.ok(
  backends.length > 0 &&
    new Set(backends).size === backends.length &&
    backends.every((value) => value === "sqlite" || value === "postgres"),
  "backends must be sqlite,postgres",
);
const levels = values.levels
  .split(",")
  .map(Number)
  .sort((a, b) => a - b);
assert.ok(
  levels.length > 0 &&
    new Set(levels).size === levels.length &&
    levels.every(
      (value) => Number.isSafeInteger(value) && value >= 20 && value <= 50000,
    ),
  "levels must be distinct integers between 20 and 50000",
);
const sampleCount = Number(values.samples);
const coldSampleCount = Number(values["cold-samples"]);
const generationBudgetMs = Number(values["generation-budget-ms"]);
const concurrency = Number(values.concurrency);
for (const count of [sampleCount, coldSampleCount])
  assert.ok(Number.isSafeInteger(count) && count >= 3 && count <= 100);
assert.ok(Number.isSafeInteger(generationBudgetMs) && generationBudgetMs > 0);
assert.ok(
  Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 16,
  "concurrency must be an integer between 1 and 16",
);
const postgresUrl = process.env.MORPHZ_TEST_POSTGRES_URL;
if (backends.includes("postgres") && !postgresUrl)
  throw new Error(
    "Actual PostgreSQL requires MORPHZ_TEST_POSTGRES_URL; it is not simulated or silently skipped.",
  );

const print = (type: string, value: object) =>
  process.stdout.write(JSON.stringify({ type, ...value }) + "\n");
const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");
const round = (value: number) => Math.round(value * 1000) / 1000;
function memorySample(stage: string) {
  const memory = process.memoryUsage();
  return {
    stage,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    arrayBufferBytes: memory.arrayBuffers,
  };
}
function distribution(values: number[]) {
  assert.ok(values.length > 0);
  const ordered = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    ordered[Math.max(0, Math.ceil(fraction * ordered.length) - 1)]!;
  return {
    samples: ordered.length,
    min: round(ordered[0]!),
    p50: round(percentile(0.5)),
    p95: round(percentile(0.95)),
    max: round(ordered.at(-1)!),
  };
}
function measured(samples: Sample[]) {
  return {
    latencyMs: distribution(samples.map((sample) => sample.ms)),
    responseJsonBytes: distribution(
      samples.map((sample) => sample.responseBytes),
    ),
  };
}
async function measure<T>(
  work: () => Promise<T>,
): Promise<{ value: T; sample: Sample }> {
  const started = performance.now();
  const value = await work();
  return {
    value,
    sample: { ms: performance.now() - started, responseBytes: bytes(value) },
  };
}
function fileBytes(filename: string) {
  try {
    return statSync(filename).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function run(backend: Backend) {
  const directory = mkdtempSync(join(tmpdir(), "morphz-storage-baseline-"));
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const schemas = {
    platform: `baseline_p_${suffix}`,
    objects: `baseline_o_${suffix}`,
    scriptStudio: `baseline_s_${suffix}`,
    reader: `baseline_r_${suffix}`,
    browser: `baseline_b_${suffix}`,
  };
  const admin =
    backend === "postgres"
      ? new Pool({ connectionString: postgresUrl })
      : undefined;
  let storage: Storage;
  let transport: WorkspaceStore | undefined;
  let domains: Domains | undefined;
  let session!: ApplicationSession;
  const projectId = `baseline_${suffix}`;
  const documents: Document[] = [];
  const generationSamples: Sample[] = [];
  const markdown =
    "# 存储基线\n\n" + "原件正文、精确版本、修订冲突与目录分页。".repeat(64);
  let generationSpentMs = 0;
  const memorySamples = [memorySample("before_host_open")];

  async function closeHost() {
    try {
      await domains?.close();
    } finally {
      domains = undefined;
      transport?.close();
      transport = undefined;
    }
  }
  async function openHost() {
    transport = new WorkspaceStore(join(directory, "workspace.sqlite"), {
      mode: "transport",
    });
    domains = await openApplicationDomainsHost(
      directory,
      transport,
      undefined,
      storage,
    );
    session = new Application(transport, {
      platformWork: domains.work,
      platformDocuments: domains.content,
      platformReader: domains.reader,
      images: domains.images,
    }).session(localAccess);
  }
  async function storageSize() {
    const sqlite = Object.fromEntries(
      [
        "workspace.sqlite",
        "platform.sqlite",
        "objects.sqlite",
        "script-studio.sqlite",
        "reader.sqlite",
        "browser.sqlite",
        "reader-originals/manifest.sqlite",
        "objects-images/manifest.sqlite",
        "message-attachments/manifest.sqlite",
      ].map((filename) => [
        filename,
        {
          mainBytes: fileBytes(join(directory, filename)),
          walBytes: fileBytes(join(directory, filename + "-wal")),
          sharedMemoryBytes: fileBytes(join(directory, filename + "-shm")),
        },
      ]),
    );
    const postgres = admin
      ? (
          await admin.query<{ schema: string; bytes: string }>(
            `SELECT n.nspname AS schema,coalesce(sum(pg_total_relation_size(c.oid)),0)::text AS bytes
           FROM pg_namespace n LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relkind IN ('r','m')
           WHERE n.nspname=ANY($1::text[]) GROUP BY n.nspname ORDER BY n.nspname`,
            [Object.values(schemas)],
          )
        ).rows.map((row) => ({
          schema: row.schema,
          relationAndIndexBytes: Number(row.bytes),
        }))
      : [];
    return {
      sqlite,
      postgres,
      totalAllocatedBytes:
        Object.values(sqlite).reduce(
          (sum, value) =>
            sum + value.mainBytes + value.walBytes + value.sharedMemoryBytes,
          0,
        ) +
        postgres.reduce((sum, value) => sum + value.relationAndIndexBytes, 0),
    };
  }
  async function generate(target: number) {
    while (
      documents.length < target &&
      generationSpentMs < generationBudgetMs
    ) {
      const index = documents.length;
      const result = await measure(() =>
        session.createPlatformDocument({
          commandId: randomUUID(),
          objectId: randomUUID(),
          projectId,
          title: `存储基线 ${index.toString().padStart(5, "0")}`,
          markdown,
        }),
      );
      documents.push(result.value);
      generationSamples.push(result.sample);
      generationSpentMs += result.sample.ms;
      if (documents.length % 250 === 0)
        print("generation_progress", {
          backend,
          records: documents.length,
          generationMs: round(generationSpentMs),
        });
    }
  }
  async function readPage(before?: { key: string; contentId: string }) {
    return session.listPlatformContent({
      projectId,
      limit: 50,
      ...(before ? { before } : {}),
    });
  }
  async function validatePage(page: Page) {
    assert.ok(page.length <= 50);
    for (const row of page) {
      assert.equal(row.projectId, projectId);
      assert.equal(row.kind, "document");
      assert.equal(row.appId, "morphz.objects");
      assert.equal(
        "markdown" in row,
        false,
        "Directory cannot hydrate original bodies",
      );
    }
  }
  async function baseline(before: Awaited<ReturnType<typeof storageSize>>) {
    memorySamples.push(memorySample(`generated_${documents.length}`));
    const headSamples: Sample[] = [];
    for (let index = 0; index < sampleCount; index++) {
      const result = await measure(() => readPage());
      await validatePage(result.value);
      assert.equal(result.value.length, Math.min(50, documents.length));
      headSamples.push(result.sample);
    }
    const cursorSamples: Sample[] = [];
    const seen = new Set<string>();
    let cursor: { key: string; contentId: string } | undefined;
    for (;;) {
      const result = await measure(() => readPage(cursor));
      await validatePage(result.value);
      if (!result.value.length) break;
      cursorSamples.push(result.sample);
      for (const row of result.value) {
        assert.equal(
          seen.has(row.id),
          false,
          "Keyset pagination repeated an original",
        );
        seen.add(row.id);
      }
      const last = result.value.at(-1)!;
      cursor = { key: last.updatedAt, contentId: last.id };
    }
    assert.equal(
      seen.size,
      documents.length,
      "Keyset traversal lost an original",
    );
    const originalSamples: Sample[] = [];
    for (let index = 0; index < sampleCount; index++) {
      const document =
        documents[Math.floor((index * documents.length) / sampleCount)]!;
      const result = await measure(() =>
        session.readPlatformDocument({
          contentId: document.contentId,
          revision: 1,
        }),
      );
      assert.equal(result.value.revision, 1);
      assert.equal(result.value.markdown, markdown);
      originalSamples.push(result.sample);
    }
    const target = documents[Math.floor(documents.length / 2)]!;
    const original = await session.readPlatformDocument({
      contentId: target.contentId,
      revision: 1,
    });
    let revision = original.headRevision;
    const reviseSamples: Sample[] = [];
    for (let index = 0; index < sampleCount; index++) {
      const result = await measure(() =>
        session.revisePlatformDocument({
          commandId: randomUUID(),
          contentId: target.contentId,
          expectedRevision: revision,
          title: original.title,
          markdown: markdown + `\n\n修订 ${revision + 1}`,
        }),
      );
      revision++;
      assert.equal(result.value.versionRef, String(revision));
      reviseSamples.push(result.sample);
    }
    const conflictSamples: Sample[] = [];
    for (let index = 0; index < Math.min(sampleCount, 10); index++) {
      const started = performance.now();
      await assert.rejects(
        session.revisePlatformDocument({
          commandId: randomUUID(),
          contentId: target.contentId,
          expectedRevision: revision - 1,
          title: original.title,
          markdown: "不能写入的过期修订",
        }),
        (error: unknown) =>
          error instanceof ObjectsConflictError ||
          (error instanceof Error &&
            "code" in error &&
            error.code === "conflict"),
      );
      conflictSamples.push({
        ms: performance.now() - started,
        responseBytes: 0,
      });
    }
    memorySamples.push(memorySample(`serial_workload_${documents.length}`));

    // These are concurrent logical Human requests to one real Host. Embedded
    // SQLite still has a single writer; this does not pretend to be a
    // multi-process, multi-tenant or Agent/model throughput measurement.
    const independent = documents
      .filter((document) => document.contentId !== target.contentId)
      .slice(0, concurrency);
    const independentHeads = new Map<string, number>();
    for (const document of independent) {
      const current = await session.readPlatformDocument({
        contentId: document.contentId,
        revision: 1,
      });
      independentHeads.set(document.contentId, current.headRevision);
    }
    const concurrentWriteSamples: Sample[] = [];
    const concurrentBatchSamples: number[] = [];
    let committedIndependentWrites = 0;
    for (let roundIndex = 0; roundIndex < sampleCount; roundIndex++) {
      const batchStarted = performance.now();
      const results = await Promise.all(
        independent.map(async (document, index) => {
          const expected = independentHeads.get(document.contentId)!;
          const updatedBody =
            markdown + `\n\n并发修订 ${roundIndex}:${index}:${expected + 1}`;
          const result = await measure(() =>
            session.revisePlatformDocument({
              commandId: randomUUID(),
              contentId: document.contentId,
              expectedRevision: expected,
              title: `存储基线并发 ${index}`,
              markdown: updatedBody,
            }),
          );
          assert.equal(result.value.versionRef, String(expected + 1));
          independentHeads.set(document.contentId, expected + 1);
          const exact = await session.readPlatformDocument({
            contentId: document.contentId,
            revision: expected + 1,
          });
          assert.equal(exact.markdown, updatedBody);
          return result.sample;
        }),
      );
      concurrentWriteSamples.push(...results);
      committedIndependentWrites += results.length;
      concurrentBatchSamples.push(performance.now() - batchStarted);
    }

    // Race distinct commands against the same immutable expected revision.
    // One winner is permitted; lost updates or two accepted successors are
    // correctness failures, not performance samples to omit.
    const competingRevision = revision;
    const competingStarted = performance.now();
    const competing = await Promise.allSettled(
      Array.from({ length: concurrency }, (_, index) =>
        session.revisePlatformDocument({
          commandId: randomUUID(),
          contentId: target.contentId,
          expectedRevision: competingRevision,
          title: original.title,
          markdown: markdown + `\n\n同版竞争 ${index}`,
        }),
      ),
    );
    const competingMs = performance.now() - competingStarted;
    const winners = competing.filter((result) => result.status === "fulfilled");
    const losers = competing.filter((result) => result.status === "rejected");
    assert.equal(winners.length, 1, "Same-revision CAS must have one winner");
    assert.equal(losers.length, concurrency - 1);
    for (const loser of losers)
      assert.ok(
        loser.reason instanceof ObjectsConflictError ||
          (loser.reason instanceof Error &&
            "code" in loser.reason &&
            loser.reason.code === "conflict"),
        "Every losing CAS request must report a revision conflict",
      );
    revision++;
    assert.equal(winners[0]!.value.versionRef, String(revision));
    memorySamples.push(memorySample(`concurrent_workload_${documents.length}`));
    const coldSamples: Sample[] = [];
    const firstReadSamples: Sample[] = [];
    const coldPageSamples: Sample[] = [];
    for (let index = 0; index < coldSampleCount; index++) {
      await closeHost();
      const reopened = await measure(async () => {
        await openHost();
        return { opened: true };
      });
      coldSamples.push(reopened.sample);
      const page = await measure(() => readPage());
      assert.equal(page.value.length, Math.min(50, documents.length));
      await validatePage(page.value);
      coldPageSamples.push(page.sample);
      const result = await measure(() =>
        session.readPlatformDocument({
          contentId: target.contentId,
          revision: 1,
        }),
      );
      assert.equal(result.value.revision, 1);
      assert.equal(result.value.headRevision, revision);
      assert.equal(result.value.markdown, markdown);
      firstReadSamples.push(result.sample);
      // Independent writes remain original versions after the real Host
      // connections reopen; directory compensation cannot duplicate them.
      for (const document of independent) {
        const expected = independentHeads.get(document.contentId)!;
        const persisted = await session.readPlatformDocument({
          contentId: document.contentId,
          revision: expected,
        });
        assert.equal(persisted.headRevision, expected);
        assert.equal(persisted.revision, expected);
      }
    }
    memorySamples.push(memorySample(`reopened_${documents.length}`));
    // Match the initial settled measurement. SQLite's live WAL can be larger
    // than its checkpointed file: comparing these two states reports nonsense
    // negative growth, not physical write amplification.
    await closeHost();
    const after = await storageSize();
    await openHost();
    print("storage_baseline", {
      backend,
      records: documents.length,
      operations: {
        directoryHead50: measured(headSamples),
        directoryKeysetTraversal50: measured(cursorSamples),
        exactOriginalVersionRead: measured(originalSamples),
        casRevision: measured(reviseSamples),
        casConflict: {
          latencyMs: distribution(conflictSamples.map((sample) => sample.ms)),
        },
        concurrentIndependentRevisions: {
          parallelRequests: independent.length,
          committedWrites: committedIndependentWrites,
          requests: measured(concurrentWriteSamples),
          batchIncludingExactReadMs: distribution(concurrentBatchSamples),
        },
        sameRevisionCompetition: {
          parallelRequests: concurrency,
          elapsedMs: round(competingMs),
          acceptedSuccessors: winners.length,
          rejectedConflicts: losers.length,
        },
        fullStoreReopen: {
          latencyMs: distribution(coldSamples.map((sample) => sample.ms)),
        },
        firstDirectoryPageAfterReopen: measured(coldPageSamples),
        firstExactOriginalAfterReopen: measured(firstReadSamples),
      },
      generation: {
        totalMs: round(generationSpentMs),
        create: measured(generationSamples),
        logicalOriginalMarkdownBytes:
          documents.length * Buffer.byteLength(markdown, "utf8"),
      },
      allocatedBytes: {
        before,
        after,
        growth: after.totalAllocatedBytes - before.totalAllocatedBytes,
      },
      sampledProcessMemory: memorySamples,
      verified: {
        traversedOriginals: seen.size,
        exactRevision: 1,
        currentHead: revision,
        rejectedStaleWrites: conflictSamples.length,
      },
    });
  }

  try {
    if (admin) {
      for (const schema of Object.values(schemas))
        await admin.query(`CREATE SCHEMA "${schema}"`);
      storage = {
        platform: {
          kind: "postgres",
          connectionString: postgresUrl!,
          schema: schemas.platform,
        },
        applications: {
          deploymentId: `baseline_${suffix}`,
          connectionStrings: {
            objects: postgresUrl!,
            scriptStudio: postgresUrl!,
            reader: postgresUrl!,
            browser: postgresUrl!,
          },
          schemas: {
            objects: schemas.objects,
            scriptStudio: schemas.scriptStudio,
            reader: schemas.reader,
            browser: schemas.browser,
          },
        },
      };
    }
    await openHost();
    await session.createPlatformProject({
      commandId: randomUUID(),
      projectId,
      title: "隔离存储性能基线",
    });
    await closeHost();
    const before = await storageSize();
    await openHost();
    await generate(20);
    assert.ok(documents.length > 0, "No real records were generated");
    const perRecord = generationSpentMs / documents.length;
    print("generation_estimate", {
      backend,
      pilotRecords: documents.length,
      pilotMs: round(generationSpentMs),
      estimatedGenerationMs: Object.fromEntries(
        levels.map((level) => [String(level), round(perRecord * level)]),
      ),
      generationBudgetMs,
    });
    let measuredCount = 0;
    for (const level of levels) {
      const projectedRemaining =
        ((level - documents.length) * generationSpentMs) / documents.length;
      if (
        measuredCount > 0 &&
        generationSpentMs + projectedRemaining > generationBudgetMs
      ) {
        print("unmeasured_level", {
          backend,
          requestedRecords: level,
          reason:
            "Estimated real-write generation exceeds the opt-in time budget",
          estimatedTotalGenerationMs: round(
            generationSpentMs + projectedRemaining,
          ),
        });
        continue;
      }
      await generate(level);
      if (documents.length !== level)
        print("unmeasured_level", {
          backend,
          requestedRecords: level,
          actualRecords: documents.length,
          reason:
            "Real-write generation reached the time budget; measuring the actual smaller data set",
        });
      if (documents.length !== measuredCount) {
        await baseline(before);
        measuredCount = documents.length;
      }
    }
  } finally {
    try {
      await closeHost();
    } finally {
      if (admin) {
        try {
          for (const schema of Object.values(schemas))
            await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        } finally {
          await admin.end();
        }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

print("workload", {
  backends,
  levels,
  samples: sampleCount,
  coldSamples: coldSampleCount,
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  generationBudgetMs,
  concurrency,
  path: "Human Application -> current Platform authorization/catalog + Objects original/CAS + directory outbox",
  isolation:
    "Unique temporary directories and PostgreSQL schemas; no HTTP port, Runtime or model",
  percentile:
    "Nearest rank; sample count is included, especially small cold-reopen samples",
  coldReopenMeaning:
    "All Host stores/connections closed and reopened; OS filesystem/PG shared buffers and JS modules are not flushed",
  sizeMeaning:
    "Settled allocations after all Host stores close: SQLite db/WAL files plus isolated PG heap/toast/index relations; not total shared database size or physical write amplification",
  concurrencyMeaning:
    "Concurrent Human Application promises in one Host, including real SQL transactions and exact-read verification; not multiple Host processes or model execution",
  memoryMeaning:
    "Sampled whole-process RSS/JS heap/external allocations, including harness IDs, connections and retained samples; no forced GC, not a measured peak or isolated store memory",
  unmeasured: [
    "PDF/EPUB/blob workload",
    "multi-tenant/concurrent Agent throughput",
    "OS-cold disk I/O",
    "physical I/O write amplification",
    "approved SLO compliance",
  ],
});
for (const backend of backends) await run(backend);
