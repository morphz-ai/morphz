import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import {
  canonicalJsonBytes,
  canonicalInvokeIdentityBytes,
  parseCognitiveAppDefinition,
  parseDescribeRequest,
  parseDescribeResponse,
  parseInvokeRequest,
  parseInvokeResponse,
  parseObjectReadRequest,
  parseObjectReadResponse,
  parseReceiptReadRequest,
  parseDomainReceipt,
  parsePortableText,
  parseWireJson,
  validateOperationValue,
} from "@morphz/cognitive-app-sdk";

// Public package only. SQLite, domain rules and account mapping belong to this
// author service, not to the SDK. No author code is loaded into an application.
const serviceId = "cognitive-notes-service";
const knownDefinition = parseCognitiveAppDefinition(
  JSON.parse(
    readFileSync(new URL("./definition.json", import.meta.url), "utf8"),
  ),
);
const hash = (value) =>
  createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");
const supported = new Map([
  [
    knownDefinition.version,
    { definition: knownDefinition, hash: hash(knownDefinition) },
  ],
]);
const equal = (a, b) =>
  Buffer.from(canonicalJsonBytes(a)).equals(Buffer.from(canonicalJsonBytes(b)));
const schema = `
CREATE TABLE metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL CHECK(schema_version=1),app_id TEXT NOT NULL,service_id TEXT NOT NULL,data_authority_id TEXT NOT NULL);
CREATE TABLE author_definitions(version TEXT PRIMARY KEY,definition_hash TEXT NOT NULL,definition_json TEXT NOT NULL);
CREATE TABLE integrations(credential_hash TEXT PRIMARY KEY,issuer TEXT NOT NULL,tenant_id TEXT NOT NULL,principal_id TEXT NOT NULL,human_actant_id TEXT NOT NULL,active INTEGER NOT NULL CHECK(active IN(0,1)));
CREATE TABLE allowed_agent_actants(credential_hash TEXT NOT NULL REFERENCES integrations(credential_hash),actant_id TEXT NOT NULL,PRIMARY KEY(credential_hash,actant_id));
CREATE TABLE projects(tenant_id TEXT NOT NULL,project_id TEXT NOT NULL,PRIMARY KEY(tenant_id,project_id));
CREATE TABLE project_acl(tenant_id TEXT NOT NULL,project_id TEXT NOT NULL,principal_id TEXT NOT NULL,can_read INTEGER NOT NULL CHECK(can_read IN(0,1)),can_write INTEGER NOT NULL CHECK(can_write IN(0,1)),PRIMARY KEY(tenant_id,project_id,principal_id),FOREIGN KEY(tenant_id,project_id) REFERENCES projects(tenant_id,project_id));
CREATE TABLE notes(object_id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,project_id TEXT NOT NULL,current_version_ref TEXT NOT NULL,creator_principal_id TEXT NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(tenant_id,project_id) REFERENCES projects(tenant_id,project_id),FOREIGN KEY(object_id,current_version_ref) REFERENCES note_versions(object_id,version_ref) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE note_versions(object_id TEXT NOT NULL REFERENCES notes(object_id),version_ref TEXT NOT NULL,title TEXT NOT NULL,content_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(object_id,version_ref));
CREATE TABLE author_commands(tenant_id TEXT NOT NULL,command_id TEXT NOT NULL,request_hash TEXT NOT NULL,binding_json TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('committed','rejected')),receipt_json TEXT NOT NULL,receipt_hash TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(tenant_id,command_id));
`;
class Refusal extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
const deny = (status = 400, code = "invalid_request") => {
  throw new Refusal(status, code);
};
const internalId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
function exact(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    deny();
}
function bootstrap(filename) {
  if (!filename || !isAbsolute(filename)) deny();
  const stat = statSync(filename);
  if (
    !stat.isFile() ||
    stat.size > 65536 ||
    (process.platform !== "win32" &&
      ((stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()))
  )
    deny();
  const config = parseWireJson(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(filename)),
    ),
  );
  exact(config, ["format", "integrations"]);
  if (
    config.format !== "cognitive-notes-bootstrap/v1" ||
    !Array.isArray(config.integrations) ||
    !config.integrations.length ||
    config.integrations.length > 16
  )
    deny();
  const credentials = new Set();
  for (const account of config.integrations) {
    exact(account, [
      "credentialSha256",
      "issuer",
      "tenantId",
      "principalId",
      "humanActantId",
      "agentActantIds",
      "projects",
    ]);
    if (
      !/^[a-f0-9]{64}$/.test(account.credentialSha256) ||
      credentials.has(account.credentialSha256)
    )
      deny();
    credentials.add(account.credentialSha256);
    parsePortableText(account.issuer);
    if (
      !account.issuer.length ||
      account.issuer.length > 200 ||
      ![account.tenantId, account.principalId, account.humanActantId].every(
        internalId,
      ) ||
      !Array.isArray(account.agentActantIds) ||
      account.agentActantIds.length > 16 ||
      !account.agentActantIds.every(internalId) ||
      new Set(account.agentActantIds).size !== account.agentActantIds.length ||
      !Array.isArray(account.projects) ||
      account.projects.length > 32
    )
      deny();
    const projects = new Set();
    for (const project of account.projects) {
      exact(project, ["projectId", "read", "write"]);
      if (
        !internalId(project.projectId) ||
        projects.has(project.projectId) ||
        typeof project.read !== "boolean" ||
        typeof project.write !== "boolean" ||
        (project.write && !project.read)
      )
        deny();
      projects.add(project.projectId);
    }
  }
  return config.integrations;
}

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    config: { type: "string" },
    port: { type: "string", default: "0" },
  },
});
if (
  !values.db ||
  !isAbsolute(values.db) ||
  !/^\d{1,5}$/.test(values.port) ||
  Number(values.port) > 65535
) {
  console.error(
    "Explicit absolute author database and numeric loopback port required.",
  );
  process.exit(1);
}
process.umask(0o077);
let db;
let metadata;
try {
  db = new DatabaseSync(values.db);
  const version = db.prepare("PRAGMA user_version").get().user_version;
  const empty =
    db
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .get().n === 0;
  if (empty ? version !== 0 : version !== 1) deny();
  db.exec(
    "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=250;",
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    if (empty) {
      const accounts = bootstrap(values.config);
      db.exec(schema);
      for (const table of [
        "author_definitions",
        "note_versions",
        "author_commands",
      ])
        db.exec(
          `CREATE TRIGGER immutable_${table}_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable author fact'); END; CREATE TRIGGER immutable_${table}_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable author fact'); END;`,
        );
      db.prepare("INSERT INTO metadata VALUES(1,1,?,?,?)").run(
        knownDefinition.id,
        serviceId,
        `notes_data_${randomUUID()}`,
      );
      for (const account of accounts) {
        db.prepare("INSERT INTO integrations VALUES(?,?,?,?,?,1)").run(
          account.credentialSha256,
          account.issuer,
          account.tenantId,
          account.principalId,
          account.humanActantId,
        );
        for (const actant of account.agentActantIds)
          db.prepare("INSERT INTO allowed_agent_actants VALUES(?,?)").run(
            account.credentialSha256,
            actant,
          );
        for (const project of account.projects) {
          db.prepare(
            "INSERT INTO projects VALUES(?,?) ON CONFLICT DO NOTHING",
          ).run(account.tenantId, project.projectId);
          const old = db
            .prepare(
              "SELECT can_read,can_write FROM project_acl WHERE tenant_id=? AND project_id=? AND principal_id=?",
            )
            .get(account.tenantId, project.projectId, account.principalId);
          if (
            old &&
            (old.can_read !== Number(project.read) ||
              old.can_write !== Number(project.write))
          )
            deny();
          if (!old)
            db.prepare("INSERT INTO project_acl VALUES(?,?,?,?,?)").run(
              account.tenantId,
              project.projectId,
              account.principalId,
              Number(project.read),
              Number(project.write),
            );
        }
      }
      db.exec("PRAGMA user_version=1");
    }
    metadata = db.prepare("SELECT * FROM metadata WHERE singleton=1").get();
    if (
      !metadata ||
      metadata.schema_version !== 1 ||
      metadata.app_id !== knownDefinition.id ||
      metadata.service_id !== serviceId ||
      !/^notes_data_[a-f0-9-]{36}$/.test(metadata.data_authority_id)
    )
      deny();
    for (const [version, entry] of supported) {
      const canonical = Buffer.from(
        canonicalJsonBytes(entry.definition),
      ).toString("utf8");
      const stored = db
        .prepare("SELECT * FROM author_definitions WHERE version=?")
        .get(version);
      if (
        stored &&
        (stored.definition_hash !== entry.hash ||
          stored.definition_json !== canonical)
      )
        deny();
      if (!stored)
        db.prepare("INSERT INTO author_definitions VALUES(?,?,?)").run(
          version,
          entry.hash,
          canonical,
        );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
} catch {
  db?.close();
  console.error(
    "Author database or bootstrap refused; existing facts were not replaced.",
  );
  process.exit(1);
}

function credentials(request) {
  const count = request.rawHeaders.filter(
    (value, index) =>
      index % 2 === 0 && value.toLowerCase() === "authorization",
  ).length;
  const match =
    typeof request.headers.authorization === "string" &&
    request.headers.authorization.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/);
  if (count !== 1 || !match) deny(403, "unauthorized");
  const actual = createHash("sha256").update(match[1]).digest();
  const account = db
    .prepare("SELECT * FROM integrations WHERE credential_hash=?")
    .get(actual.toString("hex"));
  if (
    !account ||
    !account.active ||
    !timingSafeEqual(actual, Buffer.from(account.credential_hash, "hex"))
  )
    deny(403, "unauthorized");
  return account;
}
function definition(reference) {
  const entry = supported.get(reference.version);
  if (
    !entry ||
    reference.appId !== knownDefinition.id ||
    reference.definitionHash !== entry.hash
  )
    deny(409, "conflict");
  return entry.definition;
}
function authorize(delegation, account, write = false) {
  const current = db
    .prepare("SELECT * FROM integrations WHERE credential_hash=?")
    .get(account.credential_hash);
  if (!current || !current.active || !equal(current, account))
    deny(403, "unauthorized");
  const declared = definition(delegation.authority);
  if (
    delegation.authority.serviceId !== metadata.service_id ||
    delegation.authority.dataAuthorityId !== metadata.data_authority_id ||
    delegation.issuer !== account.issuer ||
    delegation.actor.tenantId !== account.tenant_id ||
    delegation.actor.principalId !== account.principal_id ||
    Date.parse(delegation.expiresAt) <= Date.now()
  )
    deny(403, "unauthorized");
  const actor = delegation.actor;
  if (actor.kind === "human") {
    if (actor.actantId !== account.human_actant_id) deny(403, "unauthorized");
  } else if (
    actor.source.humanActantId !== account.human_actant_id ||
    !db
      .prepare(
        "SELECT 1 FROM allowed_agent_actants WHERE credential_hash=? AND actant_id=?",
      )
      .get(account.credential_hash, actor.actantId)
  )
    deny(403, "unauthorized");
  const acl = db
    .prepare(
      "SELECT can_read,can_write FROM project_acl WHERE tenant_id=? AND project_id=? AND principal_id=?",
    )
    .get(account.tenant_id, delegation.projectId, account.principal_id);
  if (!acl || !acl.can_read || (write && !acl.can_write))
    deny(403, "unauthorized");
  return declared;
}
function transaction(action, check) {
  check();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    check();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function fixed(delegation, recovery = false) {
  const command = recovery
    ? delegation.historicalAdmission
    : delegation.command;
  return {
    authority: delegation.authority,
    actor: delegation.actor,
    projectId: delegation.projectId,
    operationId: recovery
      ? delegation.originalOperationId
      : delegation.operationId,
    resources: recovery ? delegation.originalResources : delegation.resources,
    ...command,
  };
}
function receiptBinding(immutable) {
  const { resources: _resources, ...binding } = immutable;
  return binding;
}
function existing(immutable) {
  const row = db
    .prepare("SELECT * FROM author_commands WHERE tenant_id=? AND command_id=?")
    .get(immutable.actor.tenantId, immutable.commandId);
  if (!row) return null;
  if (
    row.request_hash !== immutable.requestHash ||
    !equal(JSON.parse(row.binding_json), immutable)
  )
    deny(409, "conflict");
  const receipt = parseDomainReceipt(
    JSON.parse(row.receipt_json),
    receiptBinding(immutable),
  );
  if (hash(receipt) !== row.receipt_hash) deny(500, "unavailable");
  return receipt;
}
function currentNote(objectId, delegation) {
  const note = db
    .prepare(
      "SELECT * FROM notes WHERE object_id=? AND tenant_id=? AND project_id=?",
    )
    .get(objectId, delegation.actor.tenantId, delegation.projectId);
  if (!note) deny(403, "unauthorized");
  return note;
}
function invoke(raw, account, check) {
  const def = definition(raw?.delegation?.authority ?? {});
  const operation = def.operations.find(
    (op) => op.id === raw?.delegation?.operationId,
  );
  if (!operation) deny(400, "invalid_request");
  const request = parseInvokeRequest(raw, operation.effect, operation.scope);
  const parameters = validateOperationValue(
    operation.inputSchema,
    request.parameters,
  );
  const delegation = request.delegation;
  if (operation.id !== "notes.revise" && delegation.resources.length) deny();
  if (
    operation.id === "notes.revise" &&
    (delegation.resources.length !== 1 ||
      !equal(delegation.resources[0], {
        objectId: parameters.objectId,
        versionRef: parameters.baselineVersionRef,
      }))
  )
    deny();
  if (operation.effect === "read")
    return transaction(() => {
      authorize(delegation, account);
      if (parameters.afterObjectId !== undefined)
        parsePortableText(parameters.afterObjectId);
      const rows = db
        .prepare(
          "SELECT n.object_id,v.version_ref,v.title FROM notes n JOIN note_versions v ON v.object_id=n.object_id AND v.version_ref=n.current_version_ref WHERE n.tenant_id=? AND n.project_id=? AND n.object_id>? ORDER BY n.object_id LIMIT ?",
        )
        .all(
          delegation.actor.tenantId,
          delegation.projectId,
          parameters.afterObjectId ?? "",
          parameters.limit + 1,
        );
      const more = rows.length > parameters.limit;
      const objects = rows.slice(0, parameters.limit).map((row) => ({
        objectId: row.object_id,
        versionRef: row.version_ref,
        title: row.title,
      }));
      const result = {
        objects,
        ...(more ? { nextAfterObjectId: objects.at(-1).objectId } : {}),
      };
      validateOperationValue(operation.outputSchema, result);
      return parseInvokeResponse(
        {
          protocol: request.protocol,
          authority: delegation.authority,
          operationId: operation.id,
          result,
        },
        "read",
        { authority: delegation.authority, operationId: operation.id },
      );
    }, check);
  const actualHash = createHash("sha256")
    .update(
      canonicalInvokeIdentityBytes(request, operation.effect, operation.scope),
    )
    .digest("hex");
  if (actualHash !== delegation.command.requestHash) deny(409, "conflict");
  return transaction(() => {
    authorize(delegation, account, true);
    const immutable = fixed(delegation);
    const previous = existing(immutable);
    if (previous) return previous;
    let refusal = null;
    try {
      parsePortableText(parameters.title);
      if (!parameters.title.trim() || parameters.title.length > 180)
        refusal = "invalid_title";
    } catch {
      refusal = "invalid_title";
    }
    let objectId = `note_${randomUUID()}`;
    const versionRef = `version_${randomUUID()}`;
    if (operation.id === "notes.revise") {
      objectId = parameters.objectId;
      const note = currentNote(objectId, delegation);
      if (note.current_version_ref !== parameters.baselineVersionRef)
        refusal = "baseline_conflict";
    }
    const committedAt = new Date().toISOString();
    const result = {
      objectId,
      versionRef,
      title: parameters.title,
      markdown: parameters.markdown,
    };
    const reply = refusal
      ? {
          protocol: request.protocol,
          binding: receiptBinding(immutable),
          status: "rejected",
          receiptId: `receipt_${randomUUID()}`,
          reason: {
            code: refusal,
            message:
              "The author domain rule refused this command without committing a note change.",
          },
        }
      : {
          protocol: request.protocol,
          binding: receiptBinding(immutable),
          status: "committed",
          receiptId: `receipt_${randomUUID()}`,
          committedAt,
          result,
          objects: [
            { objectId, versionRef, kind: "document", title: parameters.title },
          ],
        };
    if (!refusal) {
      validateOperationValue(operation.outputSchema, result);
      if (operation.id === "notes.create")
        db.prepare("INSERT INTO notes VALUES(?,?,?,?,?,?)").run(
          objectId,
          delegation.actor.tenantId,
          delegation.projectId,
          versionRef,
          delegation.actor.principalId,
          committedAt,
        );
      db.prepare("INSERT INTO note_versions VALUES(?,?,?,?,?)").run(
        objectId,
        versionRef,
        parameters.title,
        JSON.stringify({
          title: parameters.title,
          markdown: parameters.markdown,
        }),
        committedAt,
      );
      if (operation.id === "notes.revise") {
        const changed = db
          .prepare(
            "UPDATE notes SET current_version_ref=? WHERE object_id=? AND current_version_ref=?",
          )
          .run(versionRef, objectId, parameters.baselineVersionRef).changes;
        if (changed !== 1) deny(409, "conflict");
      }
    }
    const receipt = parseDomainReceipt(reply, receiptBinding(immutable));
    db.prepare("INSERT INTO author_commands VALUES(?,?,?,?,?,?,?,?)").run(
      delegation.actor.tenantId,
      immutable.commandId,
      actualHash,
      Buffer.from(canonicalJsonBytes(immutable)).toString("utf8"),
      receipt.status,
      JSON.stringify(receipt),
      hash(receipt),
      committedAt,
    );
    return receipt;
  }, check);
}
function route(path, raw, account, check) {
  if (path === "/describe") {
    const current = db
      .prepare("SELECT * FROM integrations WHERE credential_hash=?")
      .get(account.credential_hash);
    if (!current || !current.active || !equal(current, account))
      deny(403, "unauthorized");
    const request = parseDescribeRequest(raw);
    definition(request.definition);
    return parseDescribeResponse(
      {
        ...request,
        serviceId: metadata.service_id,
        dataAuthorityId: metadata.data_authority_id,
      },
      request,
    );
  }
  if (path === "/invoke") return invoke(raw, account, check);
  if (path === "/objects/read") {
    const request = parseObjectReadRequest(raw);
    return transaction(() => {
      authorize(request.delegation, account);
      currentNote(request.object.objectId, request.delegation);
      const row = db
        .prepare(
          "SELECT title,content_json FROM note_versions WHERE object_id=? AND version_ref=?",
        )
        .get(request.object.objectId, request.object.versionRef);
      if (!row) deny(404, "not_found");
      return parseObjectReadResponse(
        {
          protocol: request.protocol,
          authority: request.delegation.authority,
          object: request.object,
          kind: "document",
          title: row.title,
          content: { format: "json", value: JSON.parse(row.content_json) },
        },
        request,
      );
    }, check);
  }
  const request = parseReceiptReadRequest(raw);
  return transaction(() => {
    const declared = authorize(request.delegation, account);
    const operation = declared.operations.find(
      (op) => op.id === request.delegation.originalOperationId,
    );
    if (
      !operation ||
      operation.effect === "read" ||
      (operation.scope === "objects" &&
        request.delegation.originalResources.length !== 1)
    )
      deny();
    const immutable = fixed(request.delegation, true);
    return (
      existing(immutable) ??
      parseDomainReceipt({
        protocol: request.protocol,
        binding: receiptBinding(immutable),
        status: "unknown",
        reason: {
          code: "not_seen",
          message:
            "No durable receipt is visible; an earlier request may still arrive.",
        },
      })
    );
  }, check);
}
async function readJson(request, check) {
  // The fixed Host transport sends UTF-8 explicitly. Accept that JSON media
  // type, not arbitrary charsets/parameters or an encoded/compressed body.
  if (
    !/^application\/json(?:[\t ]*;[\t ]*charset[\t ]*=[\t ]*(?:utf-8|"utf-8"))?[\t ]*$/i.test(
      request.headers["content-type"] ?? "",
    ) ||
    request.headers["content-encoding"]
  )
    deny(415, "unsupported_media_type");
  if (Number(request.headers["content-length"] ?? 0) > 512 * 1024)
    deny(413, "too_large");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    check();
    bytes += chunk.length;
    if (bytes > 512 * 1024) deny(413, "too_large");
    chunks.push(chunk);
  }
  check();
  return parseWireJson(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    ),
  );
}
const server = createServer(
  { maxHeaderSize: 8192 },
  async (request, response) => {
    const deadline = performance.now() + 10000;
    let committed = false;
    const check = () => {
      if (performance.now() >= deadline || request.aborted)
        deny(408, "timeout");
    };
    const timer = setTimeout(() => {
      if (!response.writableEnded) response.destroy();
    }, 10000);
    timer.unref();
    try {
      if (
        request.method !== "POST" ||
        !["/describe", "/invoke", "/objects/read", "/receipts/read"].includes(
          request.url,
        )
      )
        deny(404, "not_found");
      const account = credentials(request);
      const raw = await readJson(request, check);
      check();
      const result = route(request.url, raw, account, check);
      committed = true; // This does not say an HTTP failure rolled back a DB fact.
      check();
      const body = Buffer.from(canonicalJsonBytes(result));
      check();
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": body.length,
        "Cache-Control": "no-store",
      });
      response.end(body);
    } catch (error) {
      if (!response.destroyed && !response.headersSent) {
        // Never echo cause, body, identities, bearer, SQL or paths. In particular,
        // a failed response after COMMIT is not a new authoritative rejection.
        const status = error instanceof Refusal ? error.status : 400;
        response.writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          Connection: "close",
        });
        response.end(
          JSON.stringify({
            error: committed
              ? "response_unavailable"
              : error instanceof Refusal
                ? error.code
                : "invalid_request",
          }),
        );
      }
    } finally {
      clearTimeout(timer);
    }
  },
);
server.headersTimeout = 5000;
server.requestTimeout = 10000;
server.maxHeadersCount = 32;
server.listen(Number(values.port), "127.0.0.1", () =>
  console.log(
    JSON.stringify({
      event: "ready",
      port: server.address().port,
      serviceId: metadata.service_id,
      dataAuthorityId: metadata.data_authority_id,
      definition: {
        appId: knownDefinition.id,
        version: knownDefinition.version,
        definitionHash: supported.get(knownDefinition.version).hash,
      },
    }),
  ),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    server.closeAllConnections();
  });
