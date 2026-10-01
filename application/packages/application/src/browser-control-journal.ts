import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  browserReceiptSchema,
  type BrowserReceipt,
} from "../../core/src/browser.js";

type ReceiptRow = {
  id: string;
  owner_principal_id: string | null;
  page_id: string;
  epoch: string;
  project_id: string;
  artifact_id: string | null;
  source_session_id: string | null;
  action: string;
  status: BrowserReceipt["status"];
  created_at: string;
  result: string | null;
};

export type StoredBrowserReceipt = {
  receipt: BrowserReceipt;
  ownerPrincipalId: string | null;
};

/** Local Host delivery journal, not a second Browser-app or Platform store.
 * A live page/grant is intentionally never persisted here. */
export class BrowserControlJournal {
  constructor(
    private readonly db: DatabaseSync,
    oldVersion: number,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS browser_control_receipts (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        owner_principal_id TEXT,
        page_id TEXT NOT NULL,
        epoch TEXT NOT NULL,
        project_id TEXT NOT NULL,
        artifact_id TEXT,
        source_session_id TEXT,
        action TEXT NOT NULL,
        action_type TEXT NOT NULL CHECK(action_type IN ('snapshot','fill','click')),
        status TEXT NOT NULL CHECK(status IN ('queued','awaiting_approval','executing','succeeded','rejected','unknown')),
        created_at TEXT NOT NULL,
        result TEXT
      );
      CREATE INDEX IF NOT EXISTS browser_control_by_page_status
        ON browser_control_receipts(page_id,status,ordinal);
      CREATE INDEX IF NOT EXISTS browser_control_by_snapshot
        ON browser_control_receipts(page_id,epoch,action_type,status,ordinal);
      CREATE INDEX IF NOT EXISTS browser_control_by_project_owner
        ON browser_control_receipts(project_id,owner_principal_id);
    `);
    if (oldVersion < 18) {
      const legacy = db
        .prepare("SELECT body FROM service_state WHERE name='browser-receipts'")
        .get() as { body: string } | undefined;
      if (legacy) {
        for (const receipt of z
          .array(browserReceiptSchema)
          .parse(JSON.parse(legacy.body)))
          this.insert(receipt, null);
      }
      // Old continuation commands are not reissued: that mechanism created
      // synthetic workspace inputs. Existing inputs remain in the old data.
      db.prepare(
        "DELETE FROM service_state WHERE name IN ('browser-receipts','browser-consumed','browser-continuations')",
      ).run();
    }
  }

  private fromRow(row: ReceiptRow | undefined): StoredBrowserReceipt | null {
    if (!row) return null;
    return {
      ownerPrincipalId: row.owner_principal_id,
      receipt: browserReceiptSchema.parse({
        id: row.id,
        pageId: row.page_id,
        epoch: row.epoch,
        projectId: row.project_id,
        artifactId: row.artifact_id,
        ...(row.source_session_id
          ? { sourceSessionId: row.source_session_id }
          : {}),
        action: JSON.parse(row.action),
        status: row.status,
        createdAt: row.created_at,
        result: row.result,
      }),
    };
  }

  read(id: string): StoredBrowserReceipt | null {
    return this.fromRow(
      this.db
        .prepare("SELECT * FROM browser_control_receipts WHERE id=?")
        .get(id) as ReceiptRow | undefined,
    );
  }

  insert(receipt: BrowserReceipt, ownerPrincipalId: string | null) {
    this.db
      .prepare(
        `INSERT INTO browser_control_receipts
        (id,owner_principal_id,page_id,epoch,project_id,artifact_id,source_session_id,action,action_type,status,created_at,result)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        receipt.id,
        ownerPrincipalId,
        receipt.pageId,
        receipt.epoch,
        receipt.projectId,
        receipt.artifactId,
        receipt.sourceSessionId ?? null,
        JSON.stringify(receipt.action),
        receipt.action.type,
        receipt.status,
        receipt.createdAt,
        receipt.result,
      );
  }

  firstQueued(pageId: string, epoch: string): BrowserReceipt | null {
    const row = this.db
      .prepare(
        "SELECT * FROM browser_control_receipts WHERE page_id=? AND epoch=? AND status='queued' ORDER BY ordinal LIMIT 1",
      )
      .get(pageId, epoch) as ReceiptRow | undefined;
    return this.fromRow(row)?.receipt ?? null;
  }

  hasInFlight(pageId: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM browser_control_receipts WHERE page_id=? AND status IN ('queued','awaiting_approval','executing') LIMIT 1",
      )
      .get(pageId);
  }

  requiresReconciliation(pageId: string, epoch: string): boolean {
    const unknown = this.db
      .prepare(
        "SELECT ordinal FROM browser_control_receipts WHERE page_id=? AND status='unknown' ORDER BY ordinal DESC LIMIT 1",
      )
      .get(pageId) as { ordinal: number } | undefined;
    if (!unknown) return false;
    const snapshot = this.db
      .prepare(
        "SELECT 1 FROM browser_control_receipts WHERE page_id=? AND epoch=? AND status='succeeded' AND action_type='snapshot' AND ordinal>? LIMIT 1",
      )
      .get(pageId, epoch, unknown.ordinal);
    return !snapshot;
  }

  updateStatus(
    id: string,
    status: BrowserReceipt["status"],
    result: string | null,
  ) {
    this.db
      .prepare(
        "UPDATE browser_control_receipts SET status=?,result=? WHERE id=?",
      )
      .run(status, result, id);
  }

  invalidatePage(pageId: string, message: string) {
    this.db
      .prepare(
        `UPDATE browser_control_receipts
        SET status=CASE WHEN status='executing' THEN 'unknown' ELSE 'rejected' END,
            result=?
        WHERE page_id=? AND status IN ('queued','awaiting_approval','executing')`,
      )
      .run(message + " 如涉及提交，请先核对结果。", pageId);
  }

  expireInFlight() {
    this.db.exec(`UPDATE browser_control_receipts
      SET status=CASE WHEN status='executing' THEN 'unknown' ELSE 'rejected' END,
          result='应用已重新启动，旧控制权已失效。执行中的结果未知，请先查看页面核对，不要重复提交。'
      WHERE status IN ('queued','awaiting_approval','executing')`);
  }
}
