import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  DomainError,
  type Workspace,
  type AccessContext,
  type Artifact,
} from "../../../packages/core/src/model.js";
import {
  contentText,
  searchSchema,
  type SearchRequest,
  type SearchResult,
  type SearchHit,
} from "../../../packages/core/src/retrieval.js";

/** A disposable projection, committed atomically with canonical object mutations. */
export class SearchIndex {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS search_actor (id TEXT PRIMARY KEY, principal TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS search_project (id TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS search_member (project TEXT NOT NULL, principal TEXT NOT NULL, PRIMARY KEY(project, principal));
      CREATE TABLE IF NOT EXISTS search_object (rowid INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, project TEXT NOT NULL, revision INTEGER NOT NULL, title TEXT NOT NULL, title_fold TEXT NOT NULL, body TEXT NOT NULL, body_fold TEXT NOT NULL, meta TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS search_object_project ON search_object(project);
      CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(title_fold, body_fold, content='search_object', content_rowid='rowid', tokenize='trigram case_sensitive 1');
      CREATE TRIGGER IF NOT EXISTS search_insert AFTER INSERT ON search_object BEGIN
        INSERT INTO search_fts(rowid,title_fold,body_fold) VALUES(new.rowid,new.title_fold,new.body_fold); END;
      CREATE TRIGGER IF NOT EXISTS search_delete AFTER DELETE ON search_object BEGIN
        INSERT INTO search_fts(search_fts,rowid,title_fold,body_fold) VALUES('delete',old.rowid,old.title_fold,old.body_fold); END;
      DROP TRIGGER IF EXISTS search_update;
      CREATE TRIGGER search_update AFTER UPDATE OF title_fold,body_fold ON search_object BEGIN
        INSERT INTO search_fts(search_fts,rowid,title_fold,body_fold) VALUES('delete',old.rowid,old.title_fold,old.body_fold);
        INSERT INTO search_fts(rowid,title_fold,body_fold) VALUES(new.rowid,new.title_fold,new.body_fold); END;
      CREATE TABLE IF NOT EXISTS asset_project (asset TEXT NOT NULL, project TEXT NOT NULL, PRIMARY KEY(asset, project));
    `);
  }
  sync(state: Workspace) {
    // Authority and projection share the caller's transaction. Never index first and authorize later.
    this.db.exec(
      "DELETE FROM search_actor; DELETE FROM search_project; DELETE FROM search_member; DELETE FROM asset_project;",
    );
    const actor = this.db.prepare(
        "INSERT INTO search_actor(id,principal) VALUES(?,?)",
      ),
      project = this.db.prepare(
        "INSERT INTO search_project(id,title) VALUES(?,?)",
      ),
      member = this.db.prepare(
        "INSERT INTO search_member(project,principal) VALUES(?,?)",
      ),
      asset = this.db.prepare(
        "INSERT OR IGNORE INTO asset_project(asset,project) VALUES(?,?)",
      );
    for (const a of state.actants) actor.run(a.id, a.principalId);
    for (const p of state.projects) {
      project.run(p.id, p.title);
      for (const principal of p.members) member.run(p.id, principal);
    }
    const revisions = new Map(
      (
        this.db
          .prepare(
            "SELECT id,CASE WHEN json_extract(meta,'$.kind')='pdf' AND json_extract(meta,'$.pagesFold') IS NULL THEN 0 ELSE revision END AS revision FROM search_object",
          )
          .all() as {
          id: string;
          revision: number;
        }[]
      ).map((row) => [row.id, row.revision]),
    );
    const upsert = this.db.prepare(
      "INSERT INTO search_object(id,project,revision,title,title_fold,body,body_fold,meta) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project=excluded.project,revision=excluded.revision,title=excluded.title,title_fold=excluded.title_fold,body=excluded.body,body_fold=excluded.body_fold,meta=excluded.meta",
    );
    for (const a of state.artifacts) {
      for (const v of a.versions)
        if (v.content.kind === "image" || v.content.kind === "pdf")
          asset.run(v.content.assetId, a.projectId);
      if (revisions.get(a.id) !== a.revision) {
        const body = contentText(a.content);
        upsert.run(
          a.id,
          a.projectId,
          a.revision,
          a.title,
          a.title.toLocaleLowerCase(),
          body,
          body.toLocaleLowerCase(),
          JSON.stringify({
            kind: a.content.kind,
            source: a.source,
            updatedAt: a.updatedAt,
            ...(a.content.kind === "pdf"
              ? {
                  pages: a.content.pages,
                  pagesFold: a.content.pages.map((page) =>
                    page.toLocaleLowerCase(),
                  ),
                }
              : {}),
          }),
        );
      } else {
        const source = JSON.stringify(a.source);
        this.db
          .prepare(
            "UPDATE search_object SET meta=json_set(meta,'$.source',json(?)) WHERE id=? AND COALESCE(json_extract(meta,'$.source'),'null')<>?",
          )
          .run(source, a.id, source);
      }
      revisions.delete(a.id);
    }
    for (const id of revisions.keys())
      this.db.prepare("DELETE FROM search_object WHERE id=?").run(id);
  }
  assertActor(access: AccessContext) {
    if (
      !this.db
        .prepare("SELECT 1 FROM search_actor WHERE id=? AND principal=?")
        .get(access.actantId, access.principalId)
    )
      throw new DomainError("forbidden", "参与者与主体不匹配。");
  }
  assetVisible(assetId: string, access: AccessContext) {
    this.assertActor(access);
    return !!this.db
      .prepare(
        "SELECT 1 FROM asset_project a JOIN search_member m ON m.project=a.project WHERE a.asset=? AND m.principal=? LIMIT 1",
      )
      .get(assetId, access.principalId);
  }
  search(raw: SearchRequest, access: AccessContext): SearchResult {
    this.assertActor(access);
    const request = searchSchema.parse(raw),
      needle = request.query.toLocaleLowerCase();
    if (request.projectId) {
      if (
        !this.db
          .prepare("SELECT 1 FROM search_project WHERE id=?")
          .get(request.projectId)
      )
        throw new DomainError("not_found", "项目不存在。");
      if (
        !this.db
          .prepare(
            "SELECT 1 FROM search_member WHERE project=? AND principal=?",
          )
          .get(request.projectId, access.principalId)
      )
        throw new DomainError("forbidden", "没有访问这个项目的权限。");
    }
    let where =
      "m.principal=? AND (instr(o.title_fold,?)>0 OR (instr(o.body_fold,?)>0 AND (json_extract(o.meta,'$.kind')<>'pdf' OR EXISTS (SELECT 1 FROM json_each(o.meta,'$.pagesFold') page WHERE instr(page.value,?)>0))))";
    const params: SQLInputValue[] = [
      access.principalId,
      needle,
      needle,
      needle,
    ];
    if (request.projectId) {
      where += " AND o.project=?";
      params.push(request.projectId);
    }
    // Long literal queries use trigram postings. One/two-character queries fall back
    // to SQLite's projection scan (not the workspace/versions JSON).
    if ([...needle].length >= 3 && !needle.includes("\0")) {
      where +=
        " AND o.rowid IN (SELECT rowid FROM search_fts WHERE search_fts MATCH ?)";
      params.push('"' + needle.replaceAll('"', '""') + '"');
    }
    const from =
      "FROM search_object o JOIN search_project p ON p.id=o.project JOIN search_member m ON m.project=o.project WHERE " +
      where;
    const total = (
      this.db.prepare("SELECT count(*) AS count " + from).get(...params) as {
        count: number;
      }
    ).count;
    const rows = this.db
      .prepare(
        "SELECT o.id,o.project,o.revision,o.title,o.body,o.meta,p.title AS project_title " +
          from +
          " ORDER BY instr(o.title_fold,?)>0 DESC,json_extract(o.meta,'$.updatedAt') DESC,o.id LIMIT ? OFFSET ?",
      )
      .all(...params, needle, request.limit, request.offset) as {
      id: string;
      project: string;
      revision: number;
      title: string;
      body: string;
      meta: string;
      project_title: string;
    }[];
    const hits: SearchHit[] = rows.map((row) => {
      const meta = JSON.parse(row.meta) as {
        kind: Artifact["content"]["kind"];
        source: Artifact["source"];
        updatedAt: string;
        pages?: string[];
      };
      const page = meta.pages
        ? Math.max(
            0,
            meta.pages.findIndex((text) =>
              text.toLocaleLowerCase().includes(needle),
            ),
          )
        : undefined;
      const body = meta.pages ? meta.pages[page!]! : row.body,
        position = body.toLocaleLowerCase().indexOf(needle),
        start = Math.max(0, position - 72),
        quote = body.slice(start, start + 260);
      return {
        artifactId: row.id,
        projectId: row.project,
        projectTitle: row.project_title,
        title: row.title,
        revision: row.revision,
        kind: meta.kind,
        source: meta.source,
        updatedAt: meta.updatedAt,
        matchedIn: row.title.toLocaleLowerCase().includes(needle)
          ? "title"
          : "content",
        quote,
        excerpt:
          (start ? "…" : "") + quote + (start + 260 < body.length ? "…" : ""),
        ...(page !== undefined ? { page: page + 1 } : {}),
      };
    });
    return {
      hits,
      total,
      hasMore: request.offset + request.limit < total,
      workspaceRevision: (
        this.db
          .prepare(
            "SELECT json_extract(body,'$.revision') AS revision FROM workspace WHERE id=1",
          )
          .get() as { revision: number }
      ).revision,
    };
  }
}
