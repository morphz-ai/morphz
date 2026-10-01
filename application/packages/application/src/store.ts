import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, chmodSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { RuntimeLedger, type BridgeDeliveryChanges } from "./runtime-ledger.js";
import { BrowserControlJournal } from "./browser-control-journal.js";

/** Host-local identity, reliable Runtime delivery and page-control journal.
 * Platform and Cognitive Apps own their business data; this store has no
 * workspace snapshot, business commands, content index or original byte table.
 * The existing filename remains stable so a Host keeps its identity and queue.
 */
export class WorkspaceStore {
  private db: DatabaseSync;
  private runtimeLedger: RuntimeLedger;
  private browserJournal: BrowserControlJournal;

  constructor(
    filename: string,
    options: { tenantId?: string; mode?: "transport" } = {},
  ) {
    if (options.tenantId !== undefined) z.uuid().parse(options.tenantId);
    if (filename !== ":memory:") {
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
      const hasExistingAuthority = [
        "platform.sqlite",
        "application-instances.json",
        "objects.sqlite",
        "script-studio.sqlite",
        "reader.sqlite",
        "browser.sqlite",
        "ui-packages/manifest.sqlite",
        "reader-originals/manifest.sqlite",
        "objects-images/manifest.sqlite",
        "message-attachments/manifest.sqlite",
      ].some((name) => existsSync(join(dirname(filename), name)));
      if (hasExistingAuthority) {
        if (!existsSync(filename) || statSync(filename).size === 0)
          throw new Error(
            "本机中心身份投递库缺失；已有 Platform 或应用原件，拒绝生成新中心身份。请恢复原投递库。",
          );
        const existing = new DatabaseSync(filename, { readOnly: true });
        try {
          const metadata = existing
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name='center_metadata'",
            )
            .get();
          const row = metadata
            ? (existing
                .prepare("SELECT identity FROM center_metadata WHERE id=1")
                .get() as { identity: string } | undefined)
            : undefined;
          if (!row || !z.uuid().safeParse(row.identity).success)
            throw new Error(
              "本机中心身份记录缺失；已有 Platform 或应用原件，拒绝生成新中心身份。请恢复原投递库。",
            );
        } finally {
          existing.close();
        }
      }
    }
    this.db = new DatabaseSync(filename);
    if (filename !== ":memory:") chmodSync(filename, 0o600);
    this.db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;",
    );
    const version = this.db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (version.user_version > 19) {
      this.db.close();
      throw new Error("数据库版本高于当前应用支持范围，请使用更新的 Morphz。");
    }
    if (options.tenantId) {
      const metadata = this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='center_metadata'",
        )
        .get();
      const existing = metadata
        ? (this.db
            .prepare("SELECT identity FROM center_metadata WHERE id=1")
            .get() as { identity: string } | undefined)
        : undefined;
      if (existing && existing.identity !== options.tenantId) {
        this.db.close();
        throw new Error(
          "本机 Host 投递库绑定了另一个中心，拒绝接入云端 Platform。",
        );
      }
    }
    try {
      this.db.exec(
        "BEGIN IMMEDIATE; " +
          "CREATE TABLE IF NOT EXISTS center_metadata (id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL); " +
          "CREATE TABLE IF NOT EXISTS runtime_state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); " +
          "CREATE TABLE IF NOT EXISTS service_state (name TEXT PRIMARY KEY, body TEXT NOT NULL);",
      );
      this.db
        .prepare(
          "INSERT OR IGNORE INTO center_metadata(id,identity) VALUES(1,?)",
        )
        .run(options.tenantId ?? randomUUID());
      this.runtimeLedger = new RuntimeLedger(this.db, version.user_version);
      this.browserJournal = new BrowserControlJournal(
        this.db,
        version.user_version,
      );
      this.db.exec("PRAGMA user_version=19; COMMIT");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  identity(): string {
    return (
      this.db
        .prepare("SELECT identity FROM center_metadata WHERE id=1")
        .get() as { identity: string }
    ).identity;
  }
  runtimeState(): unknown {
    return this.runtimeLedger.read();
  }
  runtimeEnvelope(): unknown {
    return this.runtimeLedger.readEnvelope();
  }
  runtimeBridgeState(): unknown {
    return this.runtimeLedger.readBridge();
  }
  runtimeSessionEvents(sessionId: string): unknown[] {
    return this.runtimeLedger.sessionEvents(sessionId);
  }
  browserControlJournal(): BrowserControlJournal {
    return this.browserJournal;
  }
  adoptValidatedRuntimeEvents(
    source: unknown,
    validated: { sessions: Record<string, { events: unknown[] }> },
  ) {
    this.runtimeLedger.adoptValidatedEvents(source, validated);
  }
  serviceState(name: string): unknown {
    const row = this.db
      .prepare("SELECT body FROM service_state WHERE name=?")
      .get(name) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : null;
  }
  saveServiceState(name: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO service_state(name,body) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET body=excluded.body WHERE body<>excluded.body",
      )
      .run(name, JSON.stringify(value));
  }
  saveRuntimeState(value: unknown, appendOnlyEvents = false) {
    this.runtimeLedger.save(value, appendOnlyEvents);
  }
  saveRuntimeBridgeState(value: unknown, deliveries?: BridgeDeliveryChanges) {
    this.runtimeLedger.saveBridge(value, deliveries);
  }
  close() {
    this.db.close();
  }
}
