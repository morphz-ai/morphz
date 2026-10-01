/** Opt-in capacity evidence, not a per-commit unit test or an SLO.
 * MORPHZ_TEST_POSTGRES_URL=... npx tsx tests/storage-capacity-baseline.ts
 *   --backends sqlite,postgres --books 24 --marks 20 --samples 10
 *
 * Uses real Platform/Reader/Objects stores and Agent tools. Runtime accepted
 * input evidence is controlled by the existing domain fixture: this is not
 * provider throughput or physical-device I/O. All data lives in generated
 * temporary directories / unique PostgreSQL schemas and is removed on exit.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  promises as fs,
  readFileSync,
  readdirSync,
  statSync,
  fstatSync,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { crc32 } from "node:zlib";
import { Worker } from "node:worker_threads";
import { Pool } from "pg";
import { agentDomainFixture } from "./agent-domain-fixture.js";
import { maxReadingFileBytes } from "../packages/core/src/reader.js";

const { values } = parseArgs({
  options: {
    backends: { type: "string", default: "sqlite,postgres" },
    books: { type: "string", default: "24" },
    marks: { type: "string", default: "20" },
    samples: { type: "string", default: "10" },
    previous: { type: "string" },
  },
  strict: true,
});
const backends = values.backends!.split(",");
assert.ok(backends.every((x) => x === "sqlite" || x === "postgres"));
const bookCount = Number(values.books),
  markCount = Number(values.marks),
  samples = Number(values.samples);
assert.ok(
  Number.isSafeInteger(bookCount) && bookCount >= 20 && bookCount <= 50,
);
assert.ok(
  Number.isSafeInteger(markCount) && markCount >= 1 && markCount <= 100,
);
assert.ok(Number.isSafeInteger(samples) && samples >= 3 && samples <= 50);
const postgresUrl = process.env.MORPHZ_TEST_POSTGRES_URL;
if (backends.includes("postgres") && !postgresUrl)
  throw new Error(
    "Actual PostgreSQL URL is required; no simulated backend or silent skip.",
  );
const print = (type: string, value: object) =>
  process.stdout.write(JSON.stringify({ type, ...value }) + "\n");
const sha = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const round = (n: number) => Math.round(n * 1000) / 1000;
function distribution(ns: number[]) {
  const n = [...ns].sort((a, b) => a - b);
  return {
    samples: n.length,
    min: round(n[0]!),
    p50: round(n[Math.ceil(n.length * 0.5) - 1]!),
    p95: round(n[Math.ceil(n.length * 0.95) - 1]!),
    max: round(n.at(-1)!),
  };
}
async function measure<T>(work: () => Promise<T>) {
  const started = performance.now();
  const value = await work();
  return { value, ms: performance.now() - started };
}
function memory(stage: string) {
  return { stage, ...process.memoryUsage() };
}

// Valid original bytes with controlled capacity, not 20 MiB of extracted text.
// PDF has the real fixture pages/text; comments before xref retain object offsets.
function pdfOriginal() {
  const original = readFileSync(
    new URL("./fixtures/reader.pdf", import.meta.url),
  );
  const tail = original.toString("latin1").match(/startxref\s+(\d+)\s+%%EOF/)!;
  assert.ok(tail);
  const xref = Number(tail[1]);
  const padding = Buffer.from(
    ("%" + "x".repeat(1022) + "\n").repeat(20 * 1024),
  );
  return Buffer.concat([
    original.subarray(0, xref),
    padding,
    Buffer.from(
      original
        .subarray(xref)
        .toString("latin1")
        .replace(/startxref\s+\d+/, `startxref\n${xref + padding.length}`),
      "latin1",
    ),
  ]);
}
function storedZip(files: Map<string, Buffer>) {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [path, body] of files) {
    const name = Buffer.from(path),
      checksum = crc32(body),
      h = Buffer.alloc(30),
      d = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt32LE(checksum, 14);
    h.writeUInt32LE(body.length, 18);
    h.writeUInt32LE(body.length, 22);
    h.writeUInt16LE(name.length, 26);
    d.writeUInt32LE(0x02014b50);
    d.writeUInt16LE(20, 4);
    d.writeUInt16LE(20, 6);
    d.writeUInt32LE(checksum, 16);
    d.writeUInt32LE(body.length, 20);
    d.writeUInt32LE(body.length, 24);
    d.writeUInt16LE(name.length, 28);
    d.writeUInt32LE(offset, 42);
    local.push(h, name, body);
    central.push(d, name);
    offset += h.length + name.length + body.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(
    central.reduce((n, b) => n + b.length, 0),
    12,
  );
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
function epubOriginal(book: number, originalByteBoundary = false) {
  const f = new Map<string, Buffer>();
  const add = (name: string, body: string) => f.set(name, Buffer.from(body));
  add("mimetype", "application/epub+zip");
  add(
    "META-INF/container.xml",
    '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  const items: string[] = [],
    spine: string[] = [];
  for (let i = 0; i < 24; i++) {
    // Distinct, actually parsed chapter paragraphs. These are library text,
    // not opaque resources added to disguise a tiny two-digest workload.
    const paragraphs = Array.from({ length: 96 }, (_, paragraph) => {
      const year = 600 + book * 24 + i,
        place = ["河西", "江南", "关中", "河北"][(book + i) % 4],
        matter = ["粮仓", "驿道", "水利", "边防"][paragraph % 4];
      return `<p>第${book}册第${i + 1}章第${paragraph + 1}段：公元${year}年，${place}的地方官核查${matter}。他先向百姓了解实际困难，再与属吏比较历年的记录；对有争议的判断保存不同意见，待新的证据出现后修正。此段用于核对确切章节、阅读位置、划线和批注，不替代真实史料。</p>`;
    }).join("");
    add(
      `OEBPS/c${i}.xhtml`,
      `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第${book}册·第${i + 1}章</h1>${paragraphs}</body></html>`,
    );
    items.push(
      `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`,
    );
    spine.push(`<itemref idref="c${i}"/>`);
  }
  // One separate original-byte boundary still exercises a >20 MiB upload;
  // its padding is explicit and not counted as extracted reading text.
  for (let i = 0; i < (originalByteBoundary ? 20 : 0); i++) {
    const head = '<resource xmlns="urn:morphz:capacity">',
      tail = "</resource>";
    add(
      `OEBPS/resource${i}.xml`,
      head + "x".repeat(1024 * 1024 - head.length - tail.length) + tail,
    );
    items.push(
      `<item id="r${i}" href="resource${i}.xml" media-type="application/xml"/>`,
    );
  }
  add(
    "OEBPS/content.opf",
    `<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>容量伴读第${book}册</dc:title><dc:identifier id="id">synthetic-capacity-${book}</dc:identifier><dc:language>zh</dc:language></metadata><manifest>${items.join("")}</manifest><spine>${spine.join("")}</spine></package>`,
  );
  return storedZip(f);
}
const originals = [
  { name: "capacity.pdf", bytes: pdfOriginal() },
  ...Array.from({ length: bookCount - 1 }, (_, index) => ({
    name: `capacity-${index + 1}.epub`,
    bytes: epubOriginal(index + 1, index === 0),
  })),
];
for (const original of originals)
  assert.ok(original.bytes.length <= maxReadingFileBytes);
assert.equal(
  new Set(originals.map((original) => sha(original.bytes))).size,
  bookCount,
);
print("workload", {
  books: bookCount,
  marksPerBook: markCount,
  samples,
  uniqueOriginalDigests: bookCount,
  parsedChaptersPerEpub: 24,
  paragraphsPerChapter: 96,
  totalOriginalBytes: originals.reduce(
    (total, original) => total + original.bytes.length,
    0,
  ),
  originals: originals.map((v) => ({
    name: v.name,
    byteLength: v.bytes.length,
    sha256: sha(v.bytes),
  })),
  limits: { maxReadingFileBytes },
  physicalIoMeasured: false,
  physicalWriteAmplification: null,
  bounds:
    "Every library book has a unique digest; each EPUB has 24 substantive synthetic chapters. One PDF and one EPUB also exercise >20 MiB original bytes, whose padding is not parsed-text capacity. No large PDF page-count or OCR claim. Two tenants each start four actual Agent-tool requests concurrently; accepted Runtime provenance is controlled, not model-provider throughput. Temporary stores only; not a product SLO.",
});
if (values.previous) {
  for (const line of readFileSync(values.previous, "utf8")
    .split("\n")
    .filter(Boolean)) {
    const prior = JSON.parse(line);
    if (prior.type === "storage_baseline")
      print("previous_baseline_reference", {
        path: values.previous,
        record: prior,
        rerun: false,
      });
  }
}

function filesIn(root: string): { path: string; bytes: number }[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory()
      ? filesIn(path)
      : entry.isFile()
        ? [{ path, bytes: statSync(path).size }]
        : [];
  });
}
async function observe<T>(work: () => Promise<T>) {
  const probe = await fs.open(
    new URL("./fixtures/reader.pdf", import.meta.url),
    "r",
  );
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  const writeFile = prototype.writeFile,
    emit = Worker.prototype.emit;
  let logicalFileWriteBytes = 0,
    fileWriteCalls = 0,
    parserWorkerStarts = 0;
  // Observe the actual FileHandle method, including modules that previously
  // imported fs.open by name. This dedicated process has only isolated stores;
  // SQLite/PG native writes and Worker-process I/O are intentionally excluded.
  prototype.writeFile = async function (
    this: FileHandle,
    ...args: Parameters<FileHandle["writeFile"]>
  ) {
    const regularFile = fstatSync(this.fd).isFile();
    const result = await Reflect.apply(writeFile, this, args);
    const data = args[0];
    if (
      regularFile &&
      (typeof data === "string" || data instanceof Uint8Array)
    ) {
      logicalFileWriteBytes += Buffer.byteLength(data);
      fileWriteCalls++;
    }
    return result;
  };
  Worker.prototype.emit = function (
    event: string | symbol,
    ...args: unknown[]
  ) {
    if (event === "online" && this.threadName?.startsWith("morphz-reader-"))
      parserWorkerStarts++;
    return Reflect.apply(emit, this, [event, ...args]);
  };
  try {
    const result = await measure(work);
    return {
      ...result,
      logicalFileWriteBytes,
      fileWriteCalls,
      parserWorkerStarts,
    };
  } finally {
    prototype.writeFile = writeFile;
    Worker.prototype.emit = emit;
  }
}
async function observeRange<T>(path: string, work: () => Promise<T>) {
  const probe = await fs.open(path, "r"),
    prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  const target = statSync(path),
    read = prototype.read,
    reads: { bytes: number; position: number }[] = [];
  prototype.read = async function (this: FileHandle, ...args: unknown[]) {
    const source = fstatSync(this.fd);
    const result = (await Reflect.apply(read, this, args)) as {
      bytesRead: number;
    };
    if (source.dev === target.dev && source.ino === target.ino)
      reads.push({ bytes: result.bytesRead, position: Number(args[3]) });
    return result;
  } as typeof prototype.read;
  try {
    return { ...(await measure(work)), reads };
  } finally {
    prototype.read = read;
  }
}

for (const backend of backends) {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16),
    admin =
      backend === "postgres"
        ? new Pool({ connectionString: postgresUrl })
        : null;
  const schemas = {
    platform: `capacity_p_${suffix}`,
    objects: `capacity_o_${suffix}`,
    scriptStudio: `capacity_s_${suffix}`,
    reader: `capacity_r_${suffix}`,
    browser: `capacity_b_${suffix}`,
  };
  let first: Awaited<ReturnType<typeof agentDomainFixture>> | undefined,
    second: typeof first;
  const memorySamples = [memory(`${backend}:before_open`)];
  try {
    if (admin)
      for (const schema of Object.values(schemas))
        await admin.query(`CREATE SCHEMA "${schema}"`);
    const storage = admin
      ? {
          platform: {
            kind: "postgres" as const,
            connectionString: postgresUrl!,
            schema: schemas.platform,
          },
          applications: {
            deploymentId: `capacity_${suffix}`,
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
        }
      : undefined;
    first = await agentDomainFixture({ storage });
    second = await agentDomainFixture({ storage });
    const f = first,
      peer = second;
    assert.notEqual(f.transport.identity(), peer.transport.identity());
    const roots = [f.directory, peer.directory];
    async function catalogIds(host: typeof f) {
      const ids = new Set<string>();
      let before: { key: string; contentId: string } | undefined;
      for (;;) {
        const page = await host.withHuman((actor) =>
          host.domains.work.service.listContent(actor, {
            limit: 10,
            ...(before ? { before } : {}),
          }),
        );
        assert.ok(page.length <= 10);
        for (const row of page) {
          assert.equal(ids.has(row.id), false);
          ids.add(row.id);
        }
        if (page.length < 10) return ids;
        const last = page.at(-1)!;
        before = { key: last.updatedAt, contentId: last.id };
      }
    }
    const allocated = async () => {
      const files = roots.flatMap(filesIn);
      const blobFiles = files.filter((v) =>
        v.path.includes("/reader-originals/blobs/"),
      );
      const databaseFiles = files.filter((v) =>
        /\.sqlite(?:-wal|-shm)?$/.test(v.path),
      );
      const relations = admin
        ? (
            await admin.query<{ schema: string; bytes: string }>(
              `SELECT n.nspname AS schema,coalesce(sum(pg_total_relation_size(c.oid)),0)::text AS bytes FROM pg_namespace n LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relkind IN ('r','m') WHERE n.nspname=ANY($1::text[]) GROUP BY n.nspname ORDER BY n.nspname`,
              [Object.values(schemas)],
            )
          ).rows.map((r) => ({ schema: r.schema, bytes: Number(r.bytes) }))
        : [];
      return {
        blobFiles: blobFiles.length,
        blobBytes: blobFiles.reduce((n, v) => n + v.bytes, 0),
        localDatabaseBytes: databaseFiles.reduce((n, v) => n + v.bytes, 0),
        sqliteAllocatedWalBytes: databaseFiles
          .filter((v) => v.path.endsWith("-wal"))
          .reduce((total, file) => total + file.bytes, 0),
        postgresRelationAndIndexBytes: relations.reduce(
          (n, v) => n + v.bytes,
          0,
        ),
        postgres: relations,
      };
    };
    const before = await allocated();
    const imports: Awaited<
      ReturnType<typeof f.domains.reader.service.import>
    >[] = [];
    const importSamples: object[] = [];
    for (let index = 0; index < bookCount; index++) {
      const original = originals[index]!;
      const request = {
        commandId: randomUUID(),
        projectId: f.projectId,
        ...original,
      };
      const measured = await observe(() =>
        f.withHuman((actor) => f.domains.reader.service.import(actor, request)),
      );
      assert.equal(
        measured.parserWorkerStarts,
        1,
        "Every unique library digest must actually be parsed",
      );
      assert.ok(
        measured.logicalFileWriteBytes >= original.bytes.length,
        "The I/O observer must see the actual first-original write, not silently report zero",
      );
      imports.push(measured.value);
      const allocation = await allocated();
      assert.equal(
        allocation.blobFiles,
        index + 1,
        "Unique originals must not silently reuse the two previous digests",
      );
      assert.equal(
        allocation.blobBytes,
        originals
          .slice(0, index + 1)
          .reduce((total, source) => total + source.bytes.length, 0),
      );
      importSamples.push({
        book: index,
        format: original.name.split(".").at(-1),
        ms: round(measured.ms),
        logicalFileWriteBytes: measured.logicalFileWriteBytes,
        fileWriteCalls: measured.fileWriteCalls,
        parserWorkerStarts: measured.parserWorkerStarts,
        responseJsonBytes: Buffer.byteLength(JSON.stringify(measured.value)),
        allocated: allocation,
      });
      print("import_sample", { backend, sample: importSamples.at(-1) });
      if (index < 2) {
        const replay = await observe(() =>
          f.withHuman((actor) =>
            f.domains.reader.service.import(actor, request),
          ),
        );
        assert.deepEqual(replay.value, measured.value);
        assert.equal(replay.parserWorkerStarts, 0);
        print("import_idempotent_replay", {
          backend,
          format: original.name,
          ms: round(replay.ms),
          logicalFileWriteBytes: replay.logicalFileWriteBytes,
          fileWriteCalls: replay.fileWriteCalls,
          parserWorkerStarts: replay.parserWorkerStarts,
        });
      }
      memorySamples.push(memory(`${backend}:import_${index + 1}`));
    }
    assert.equal(new Set(imports.map((v) => v.entityId)).size, bookCount);
    // Cache reuse is measured separately from unique library capacity. A new
    // book identity must not inherit the first book's annotations or position.
    const cachedImport = await observe(() =>
      f.withHuman((actor) =>
        f.domains.reader.service.import(actor, {
          commandId: randomUUID(),
          projectId: f.projectId,
          ...originals[1]!,
        }),
      ),
    );
    assert.equal(cachedImport.parserWorkerStarts, 0);
    assert.equal(
      imports.some((book) => book.entityId === cachedImport.value.entityId),
      false,
    );
    assert.equal((await allocated()).blobFiles, bookCount);
    print("same_digest_new_book", {
      backend,
      contentId: cachedImport.value.entityId,
      ms: round(cachedImport.ms),
      parserWorkerStarts: cachedImport.parserWorkerStarts,
      logicalFileWriteBytes: cachedImport.logicalFileWriteBytes,
    });
    const markSamples: number[] = [],
      pageSamples: {
        tenantId: string;
        contentId: string;
        offset: number;
        textCharacters: number;
        chapterCharacters: number;
        responseJsonBytes: number;
        ms: number;
      }[] = [],
      expectedStates = new Map<string, unknown>(),
      expectedPages = new Map<
        typeof f,
        Map<
          string,
          { sectionId: string; text: string; totalCharacters: number }
        >
      >([
        [f, new Map()],
        [peer, new Map()],
      ]);
    async function readStateAndMarkPages(host: typeof f, contentId: string) {
      const state = await host.withHuman((actor) =>
        host.domains.reader.service.state(actor, contentId, 1),
      );
      const marks: Awaited<
        ReturnType<typeof host.domains.reader.service.marks>
      >["marks"] = [];
      for (;;) {
        const page = await host.withHuman((actor) =>
          host.domains.reader.service.marks(
            actor,
            contentId,
            1,
            false,
            marks.length,
            50,
          ),
        );
        marks.push(...page.marks);
        assert.ok(
          marks.length <= markCount,
          "Mark traversal exceeded this controlled fixture",
        );
        assert.equal(new Set(marks.map((mark) => mark.id)).size, marks.length);
        if (!page.hasMore) break;
        assert.equal(page.marks.length, 50);
      }
      // Complete test evidence is assembled from actual bounded pages, never
      // from the position-only state response. --marks can exceed one page.
      return { ...state, marks };
    }
    async function exerciseBook(
      host: typeof f,
      imported: (typeof imports)[number],
      expectedBook: number,
    ) {
      const overview = await host.withHuman((actor) =>
        host.domains.reader.service.bookOverview(actor, imported.entityId, 1),
      );
      const section = await host.withHuman((actor) =>
        host.domains.reader.service.read(
          actor,
          imported.entityId,
          1,
          overview.sections[0]!.id,
        ),
      );
      assert.ok(section.text.length > 1);
      const totalCharacters = overview.sections.reduce(
        (total, header) => total + header.characters,
        0,
      );
      if (overview.format === "epub") {
        assert.equal(overview.sections.length, 24);
        assert.ok(
          totalCharacters > 150_000,
          "Parsed capacity must contain real chapter text, not archive padding",
        );
        assert.ok(section.text.length > 8000);
        assert.ok(section.text.includes(`第${expectedBook}册第1章第1段`));
        for (const offset of [0, 3993, 8000]) {
          const page = await measure(() =>
            host.withHuman((actor) =>
              host.domains.reader.service.readSlice(
                actor,
                imported.entityId,
                1,
                section.id,
                offset,
                4000,
              ),
            ),
          );
          assert.equal(
            page.value.text,
            section.text.slice(offset, offset + 4000),
          );
          assert.equal(page.value.totalCharacters, section.text.length);
          assert.ok(page.value.text.length <= 4000);
          if (offset === 3993)
            expectedPages.get(host)!.set(imported.entityId, {
              sectionId: section.id,
              text: page.value.text,
              totalCharacters: page.value.totalCharacters,
            });
          const responseJsonBytes = Buffer.byteLength(
            JSON.stringify(page.value),
          );
          assert.ok(
            responseJsonBytes <= 4000 * 4 + 2048,
            "A page response must remain bounded by its requested text, not include other chapters",
          );
          pageSamples.push({
            tenantId: host.transport.identity(),
            contentId: imported.entityId,
            offset,
            textCharacters: page.value.text.length,
            chapterCharacters: page.value.totalCharacters,
            responseJsonBytes,
            ms: round(page.ms),
          });
        }
      }
      const offsets = Array.from(
        { length: section.text.length },
        (_, index) => index,
      ).filter((index) => section.text.slice(index, index + 1).trim());
      assert.ok(offsets.length > 0);
      print("parsed_book", {
        backend,
        contentId: imported.entityId,
        format: overview.format,
        sections: overview.sections.length,
        parsedTextCharacters: totalCharacters,
        firstSectionCharacters: section.text.length,
        overviewJsonBytes: Buffer.byteLength(JSON.stringify(overview)),
        firstSectionJsonBytes: Buffer.byteLength(JSON.stringify(section)),
      });
      for (let index = 0; index < markCount; index++) {
        const start = offsets[index % offsets.length]!,
          location = {
            sourceId: section.sourceId,
            sectionId: section.id,
            start,
            end: start + 1,
          };
        const mark = await measure(() =>
          host.withHuman((actor) =>
            host.domains.reader.service.command(actor, {
              commandId: randomUUID(),
              contentId: imported.entityId,
              revision: 1,
              command: {
                action: "mark-add",
                artifactId: imported.entityId,
                artifactRevision: 1,
                location,
                quote: section.text.slice(start, start + 1),
                kind: "highlight",
                color: "yellow",
                note: `容量批注${index}`,
              },
            }),
          ),
        );
        markSamples.push(mark.ms);
      }
      await host.withHuman((actor) =>
        host.domains.reader.service.command(actor, {
          commandId: randomUUID(),
          contentId: imported.entityId,
          revision: 1,
          command: {
            action: "save-position",
            artifactId: imported.entityId,
            artifactRevision: 1,
            location: {
              sourceId: section.sourceId,
              sectionId: section.id,
              start: 1,
              end: 1,
            },
            preferences: { fontSize: 20, font: "serif", theme: "system" },
            expectedRevision: 0,
          },
        }),
      );
      const state = await readStateAndMarkPages(host, imported.entityId);
      assert.equal(state.marks.length, markCount);
      assert.ok(state.position);
      return state;
    }
    for (const [index, imported] of imports.entries())
      expectedStates.set(
        imported.entityId,
        await exerciseBook(f, imported, index),
      );
    const cachedState = await readStateAndMarkPages(
      f,
      cachedImport.value.entityId,
    );
    assert.equal(cachedState.marks.length, 0);
    assert.equal(cachedState.position, null);
    const pdf = imports[0]!,
      pdfBytes = originals[0]!.bytes,
      digest = sha(pdfBytes),
      path = join(
        f.directory,
        "reader-originals",
        "blobs",
        digest.slice(0, 2),
        digest,
      );
    const ranges: number[] = [],
      rangeReadBytes: number[] = [];
    for (let index = 0; index < samples; index++) {
      const start = index % 2 ? 1024 * 1024 - 8 : 13,
        end = start + 16;
      const measured = await observeRange(path, () =>
        f.withHuman((actor) =>
          f.domains.reader.service.originalRange(
            actor,
            pdf.entityId,
            1,
            start,
            end,
          ),
        ),
      );
      assert.deepEqual(
        Buffer.from(measured.value),
        pdfBytes.subarray(start, end),
      );
      assert.equal(
        measured.reads.reduce((n, v) => n + v.bytes, 0),
        index % 2 ? 2 * 1024 * 1024 : 1024 * 1024,
      );
      ranges.push(measured.ms);
      rangeReadBytes.push(measured.reads.reduce((n, v) => n + v.bytes, 0));
    }
    const metadata = await observeRange(path, () =>
      f.withHuman((actor) =>
        f.domains.reader.service.originalMetadata(actor, pdf.entityId, 1),
      ),
    );
    assert.deepEqual(metadata.reads, []);
    assert.equal(metadata.value.byteLength, pdfBytes.length);
    // Both tenants share the actual PG tables but have distinct authoritative
    // identities, instances and byte roots. SQLite uses their distinct stores.
    await assert.rejects(
      peer.withHuman((actor) =>
        peer.domains.reader.service.bookOverview(actor, pdf.entityId, 1),
      ),
      /内容不存在或无权访问/,
    );
    await assert.rejects(
      peer.call({ action: "read", artifactId: pdf.entityId }),
      /内容|不存在|范围/,
    );
    const peerImport = await observe(() =>
      peer.withHuman((actor) =>
        peer.domains.reader.service.import(actor, {
          commandId: randomUUID(),
          projectId: peer.projectId,
          ...originals[1]!,
        }),
      ),
    );
    assert.equal(
      peerImport.parserWorkerStarts,
      1,
      "A private tenant cannot reuse the other's parse cache",
    );
    await assert.rejects(
      f.withHuman((actor) =>
        f.domains.reader.service.bookOverview(
          actor,
          peerImport.value.entityId,
          1,
        ),
      ),
      /内容不存在或无权访问/,
    );
    assert.equal(
      (
        await peer.withHuman((actor) =>
          peer.domains.reader.service.marks(
            actor,
            peerImport.value.entityId,
            1,
            false,
            0,
            50,
          ),
        )
      ).marks.length,
      0,
    );
    const peerExpectedState = await exerciseBook(peer, peerImport.value, 1);
    const hosts = [f, peer];
    const inFlight = new Map(hosts.map((host) => [host, 0])),
      perTenantPeak = new Map(hosts.map((host) => [host, 0]));
    let combinedInFlight = 0,
      combinedPeak = 0;
    async function request<T>(host: typeof f, work: () => T | Promise<T>) {
      const active = inFlight.get(host)! + 1;
      inFlight.set(host, active);
      perTenantPeak.set(host, Math.max(perTenantPeak.get(host)!, active));
      combinedInFlight++;
      combinedPeak = Math.max(combinedPeak, combinedInFlight);
      try {
        return await work();
      } finally {
        inFlight.set(host, inFlight.get(host)! - 1);
        combinedInFlight--;
      }
    }
    // Both tenant batches are started in the same Promise.all, rather than
    // serially benchmarking one tenant and merely labelling it multi-tenant.
    const documentsByTenant = await Promise.all(
      hosts.map((host) =>
        Promise.all(
          Array.from({ length: 4 }, (_, i) =>
            request(host, () =>
              host.call<{ contentId: string; versionRef: string }>({
                action: "create-document",
                title: `容量Agent ${i}`,
                markdown: `# 确切原件 ${i}\n\n${"正文".repeat(512)}`,
              }),
            ),
          ),
        ),
      ),
    );
    assert.equal(combinedPeak, 8);
    for (const host of hosts) assert.equal(perTenantPeak.get(host), 4);
    assert.equal((await catalogIds(f)).size, bookCount + 1 + 4);
    assert.equal(
      (await catalogIds(peer)).size,
      1 + 4,
      "The shared PostgreSQL catalog must filter by the actual tenant",
    );
    await assert.rejects(
      peer.call({
        action: "read",
        artifactId: documentsByTenant[0]![0]!.contentId,
      }),
      /内容|不存在|范围/,
    );
    await assert.rejects(
      f.call({
        action: "read",
        artifactId: documentsByTenant[1]![0]!.contentId,
      }),
      /内容|不存在|范围/,
    );
    const agentIndependent: number[] = [];
    for (let roundIndex = 0; roundIndex < 3; roundIndex++) {
      const batch = await Promise.all(
        hosts.flatMap((host, tenantIndex) =>
          documentsByTenant[tenantIndex]!.map(async (document, index) => {
            const measured = await measure(() =>
              request(host, () =>
                host.call<{ versionRef: string }>({
                  action: "revise-document",
                  artifactId: document.contentId,
                  revision: roundIndex + 1,
                  title: `容量Agent ${index}`,
                  markdown: `# 修订 ${roundIndex + 2}\n\n${"正文".repeat(512)}`,
                }),
              ),
            );
            assert.equal(measured.value.versionRef, String(roundIndex + 2));
            return measured.ms;
          }),
        ),
      );
      agentIndependent.push(...batch);
    }
    const targets = documentsByTenant.map((documents) => documents[0]!);
    const competingByTenant = await Promise.all(
      hosts.map((host, tenantIndex) =>
        Promise.allSettled(
          Array.from({ length: 4 }, (_, index) =>
            request(host, () =>
              host.call<{ versionRef: string }>({
                action: "revise-document",
                artifactId: targets[tenantIndex]!.contentId,
                revision: 4,
                title: "Agent CAS",
                markdown: `唯一后继${index}`,
              }),
            ),
          ),
        ),
      ),
    );
    for (const competing of competingByTenant) {
      assert.equal(competing.filter((v) => v.status === "fulfilled").length, 1);
      assert.equal(competing.filter((v) => v.status === "rejected").length, 3);
      for (const result of competing)
        if (result.status === "rejected")
          assert.match(String(result.reason), /版本|修订|更新|conflict/);
    }
    await Promise.all(
      hosts.map(async (host, tenantIndex) => {
        const envelope = host.envelope({
          action: "revise-document",
          artifactId: targets[tenantIndex]!.contentId,
          revision: 5,
          title: "Agent幂等",
          markdown: "同一command只提交一次",
        });
        const replay = await Promise.all(
          Array.from({ length: 4 }, () =>
            request(host, () => host.tools.call(envelope)),
          ),
        );
        for (const result of replay) assert.deepEqual(result, replay[0]);
      }),
    );
    const recovery: number[] = [],
      restoredReads: number[] = [];
    for (let index = 0; index < 3; index++) {
      recovery.push(
        (await measure(() => Promise.all(hosts.map((host) => host.reopen()))))
          .ms,
      );
      const restored = await measure(async () => {
        for (const imported of imports)
          assert.deepEqual(
            await readStateAndMarkPages(f, imported.entityId),
            expectedStates.get(imported.entityId),
          );
        assert.deepEqual(
          await readStateAndMarkPages(peer, peerImport.value.entityId),
          peerExpectedState,
        );
        assert.deepEqual(
          await readStateAndMarkPages(f, cachedImport.value.entityId),
          cachedState,
        );
        for (const host of hosts)
          for (const [contentId, expected] of expectedPages.get(host)!) {
            const page = await host.withHuman((actor) =>
              host.domains.reader.service.readSlice(
                actor,
                contentId,
                1,
                expected.sectionId,
                3993,
                4000,
              ),
            );
            assert.equal(page.text, expected.text);
            assert.equal(page.totalCharacters, expected.totalCharacters);
          }
      });
      restoredReads.push(restored.ms);
      for (const [tenantIndex, host] of hosts.entries()) {
        const exact = await host.call<{
          revision: number;
          headRevision: number;
          text: string;
        }>({
          action: "read",
          artifactId: targets[tenantIndex]!.contentId,
          revision: 6,
        });
        assert.equal(exact.revision, 6);
        assert.equal(exact.headRevision, 6);
        assert.equal(exact.text, "同一command只提交一次");
        const historical = await host.call<{
          revision: number;
          headRevision: number;
          text: string;
        }>({
          action: "read",
          artifactId: targets[tenantIndex]!.contentId,
          revision: 1,
        });
        assert.equal(historical.revision, 1);
        assert.equal(historical.headRevision, 6);
        assert.match(historical.text, /确切原件 0/);
      }
    }
    memorySamples.push(memory(`${backend}:after_reopen`));
    f.assertNoLegacyData();
    peer.assertNoLegacyData();
    print("capacity_result", {
      backend,
      tenantIds: [f.transport.identity(), peer.transport.identity()],
      books: bookCount,
      uniqueOriginalDigests: bookCount,
      cachedAdditionalBookIdentities: 1,
      annotations: bookCount * markCount,
      peerAnnotations: markCount,
      imports: importSamples,
      markLatencyMs: distribution(markSamples),
      boundedTextPages: {
        requestedCharacters: 4000,
        latencyMs: distribution(pageSamples.map((page) => page.ms)),
        responseJsonBytes: distribution(
          pageSamples.map((page) => page.responseJsonBytes),
        ),
        samples: pageSamples,
      },
      pdfRangeLatencyMs: distribution(ranges),
      pdfRangeObservedFileReadBytes: distribution(rangeReadBytes),
      originalMetadataFileReadBytes: 0,
      agent: {
        tenantCount: 2,
        parallelRequestsPerTenant: 4,
        simultaneousOutstandingRequests: combinedPeak,
        independentCommittedWrites: 24,
        independentLatencyMs: distribution(agentIndependent),
        sameRevisionAcceptedPerTenant: 1,
        sameRevisionRejectedPerTenant: 3,
        sameCommandConcurrentCallsPerTenant: 4,
        sameCommandCommittedSuccessorsPerTenant: 1,
        finalHead: 6,
        runtimeEvidence:
          "controlled accepted input; real Host Agent tools and live domain authority, no model throughput claim",
      },
      reopenMs: distribution(recovery),
      allBookStateRecoveryMs: distribution(restoredReads),
      allocated: { before, after: await allocated() },
      memorySamples,
      physicalIoMeasured: false,
      physicalWriteAmplification: null,
      writeCostAccounting:
        "Observed original FileHandle.writeFile bytes include staging. SQLite WAL bytes are allocated file sizes at sample times, not cumulative writes; checkpoint/reuse can change them. PostgreSQL sizes include relation/index allocation, not shared-server WAL attribution. Native database/Worker/disk physical writes and write amplification are not measured.",
    });
  } finally {
    try {
      await first?.close();
    } finally {
      try {
        await second?.close();
      } finally {
        if (admin) {
          try {
            for (const schema of Object.values(schemas))
              await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          } finally {
            await admin.end();
          }
        }
      }
    }
  }
}
