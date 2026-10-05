import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseDomainActor,
  parseDomainAuthority,
  parseDescribeRequest,
  parseDescribeResponse,
  parseInvokeRequest,
  parseInvokeResponse,
  parseObjectReadRequest,
  parseObjectReadResponse,
  parseReceiptReadRequest,
  parseDomainReceipt,
  canonicalJsonBytes,
  canonicalInvokeIdentityBytes,
  domainWireLimits,
  type DomainActor,
} from "../packages/cognitive-app-sdk/src/domain-wire.js";
import {
  CognitiveAppProtocolError,
  parseWireJson,
  validateOperationValue,
} from "../packages/cognitive-app-sdk/src/protocol.js";

const definition = {
  appId: "example.notes",
  version: "1.0.0",
  definitionHash: "a".repeat(64),
};
const authority = {
  ...definition,
  instanceId: "notes_instance",
  serviceId: "author/service",
  dataAuthorityId: "author/database:original",
};
const human = {
  tenantId: "tenant",
  principalId: "principal",
  actantId: "human",
  kind: "human",
  source: { kind: "human" },
} as const;
const agent = {
  tenantId: "tenant",
  principalId: "principal",
  actantId: "agent",
  kind: "agent",
  source: { kind: "input", inputId: "input", humanActantId: "human" },
} as const;
const taskRun = {
  ...agent,
  source: {
    kind: "task-run",
    sessionId: "session",
    scheduleId: "schedule",
    eventId: "event",
    sourceInputId: "original_input",
    humanActantId: "human",
  },
} as const;
const resources = [
  { objectId: "  opaque/original  ", versionRef: "  version:exact  " },
];
const transport = { issuer: "host-one", expiresAt: "2026-10-05T10:00:00Z" };
const command = { commandId: "command", requestHash: "b".repeat(64) };
function invocation(actor: unknown = human) {
  return {
    protocol: "morphz-domain/v1",
    delegation: {
      ...transport,
      purpose: "invoke",
      authority,
      actor,
      projectId: "project",
      operationId: "notes.create",
      resources,
      command,
    },
    parameters: { title: "TEST", markdown: "Original" },
  };
}
function binding(actor: DomainActor = human) {
  return {
    authority,
    actor,
    projectId: "project",
    operationId: "notes.create",
    ...command,
  };
}
const summary = { ...resources[0]!, kind: "document", title: "Original" };
function committed(actor: DomainActor = human) {
  return {
    protocol: "morphz-domain/v1",
    status: "committed",
    binding: binding(actor),
    receiptId: "author/receipt",
    committedAt: "2026-10-05T09:59:00Z",
    result: { objectId: summary.objectId, versionRef: summary.versionRef },
    objects: [summary],
  };
}
function objectRead() {
  return {
    protocol: "morphz-domain/v1" as const,
    delegation: {
      ...transport,
      purpose: "object-read" as const,
      authority,
      actor: human,
      projectId: "project",
      resource: resources[0]!,
    },
    object: resources[0]!,
    maxBytes: 262144,
  };
}
function recovery(actor: unknown = taskRun) {
  return {
    protocol: "morphz-domain/v1",
    delegation: {
      ...transport,
      purpose: "receipt-recovery",
      authority,
      actor,
      projectId: "project",
      originalOperationId: "notes.create",
      originalResources: resources,
      historicalAdmission: command,
    },
  };
}
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
const identityText = (value: unknown) =>
  new TextDecoder().decode(
    canonicalInvokeIdentityBytes(value, "write", "objects"),
  );

test("wire persistent authority/receipt/catalog metadata reject nonportable text before publication", () => {
  for (const text of [
    "before\u0000after",
    "before\ud800after",
    "before\udc00after",
    "\ud800",
    "\udc00",
    "\ud800\ud800",
    "\udc00\ud800",
  ]) {
    for (const field of ["serviceId", "dataAuthorityId"] as const) {
      assert.throws(() =>
        parseDomainAuthority({ ...authority, [field]: text }),
      );
      assert.throws(() =>
        parseDescribeResponse({
          protocol: "morphz-domain/v1",
          definition,
          serviceId: "service",
          dataAuthorityId: "data",
          [field]: text,
        }),
      );
    }
    const request = invocation();
    for (const field of ["issuer", "operationId"] as const)
      assert.throws(() =>
        parseInvokeRequest(
          { ...request, delegation: { ...request.delegation, [field]: text } },
          "write",
          "objects",
        ),
      );
    assert.throws(() =>
      parseDomainReceipt({ ...committed(), receiptId: text }),
    );
    assert.throws(() =>
      parseDomainReceipt({
        ...committed(),
        binding: { ...binding(), operationId: text },
      }),
    );
    for (const field of ["objectId", "versionRef", "kind", "title"] as const)
      assert.throws(() =>
        parseDomainReceipt({
          ...committed(),
          objects: [{ ...summary, [field]: text }],
        }),
      );
    for (const field of ["code", "message"] as const)
      assert.throws(() =>
        parseDomainReceipt({
          protocol: "morphz-domain/v1",
          status: "rejected",
          binding: binding(),
          receiptId: "receipt",
          reason: { code: "denied", message: "Rejected", [field]: text },
        }),
      );
    assert.throws(() =>
      parseInvokeResponse(
        {
          protocol: "morphz-domain/v1",
          authority,
          operationId: text,
          result: {},
        },
        "read",
      ),
    );
    const prior = recovery();
    assert.throws(() =>
      parseReceiptReadRequest({
        ...prior,
        delegation: { ...prior.delegation, originalOperationId: text },
      }),
    );
    for (const field of ["kind", "title"] as const)
      assert.throws(() =>
        parseObjectReadResponse({
          protocol: "morphz-domain/v1",
          authority,
          object: resources[0],
          kind: "document",
          title: "Original",
          content: { format: "text", text: "Content" },
          [field]: text,
        }),
      );
  }
});

test("portable authority and catalog text preserve paired Unicode, newline, tab and literal spaces", () => {
  const text = "  原件/😀\ud800\udc00\udbff\udfff\ne\u0301\tα  ";
  const exactAuthority = {
    ...authority,
    serviceId: text,
    dataAuthorityId: text,
  };
  assert.deepEqual(parseDomainAuthority(exactAuthority), exactAuthority);
  assert.equal(
    parseDescribeResponse({
      protocol: "morphz-domain/v1",
      definition,
      serviceId: text,
      dataAuthorityId: text,
    }).serviceId,
    text,
  );
  const request = invocation();
  const exactResources = [{ objectId: text, versionRef: text }];
  const exactRequest = {
    ...request,
    delegation: {
      ...request.delegation,
      authority: exactAuthority,
      issuer: text,
      operationId: text,
      resources: exactResources,
    },
  };
  const parsed = parseInvokeRequest(exactRequest, "write", "objects");
  assert.equal(parsed.delegation.issuer, text);
  assert.equal(parsed.delegation.operationId, text);
  assert.deepEqual(parsed.delegation.resources, exactResources);
  const exactObjects = [{ ...exactResources[0]!, kind: text, title: text }];
  const receipt = {
    ...committed(),
    binding: { ...binding(), authority: exactAuthority, operationId: text },
    receiptId: text,
    objects: exactObjects,
  };
  const parsedReceipt = parseDomainReceipt(receipt);
  assert.equal(parsedReceipt.status, "committed");
  assert.equal(parsedReceipt.receiptId, text);
  if (parsedReceipt.status === "committed")
    assert.deepEqual(parsedReceipt.objects, exactObjects);
  const rejected = parseDomainReceipt({
    protocol: "morphz-domain/v1",
    status: "rejected",
    binding: binding(),
    receiptId: text,
    reason: { code: text, message: text },
  });
  assert.equal(rejected.status, "rejected");
  if (rejected.status === "rejected")
    assert.deepEqual(rejected.reason, { code: text, message: text });
  const prior = recovery();
  const history = parseReceiptReadRequest({
    ...prior,
    delegation: {
      ...prior.delegation,
      originalOperationId: text,
      originalResources: exactResources,
    },
  });
  assert.equal(history.delegation.originalOperationId, text);
  assert.deepEqual(history.delegation.originalResources, exactResources);
  const read = parseObjectReadResponse({
    protocol: "morphz-domain/v1",
    authority: exactAuthority,
    object: exactResources[0],
    kind: text,
    title: text,
    content: { format: "text", text },
  });
  assert.equal(read.kind, text);
  assert.equal(read.title, text);
  assert.deepEqual(read.object, exactResources[0]);
});

test("business invocation/result/content JSON stays exact instead of inheriting metadata's portable restriction", () => {
  const text = "business\u0000\ud800\udfff\ud800";
  const value = { [text]: [text, { text }] };
  const request = { ...invocation(), parameters: value };
  assert.equal(
    parseInvokeRequest(request, "write", "objects").parameters,
    value,
  );
  const parsedReceipt = parseDomainReceipt({ ...committed(), result: value });
  assert.equal(parsedReceipt.status, "committed");
  if (parsedReceipt.status === "committed")
    assert.equal(parsedReceipt.result, value);
  assert.equal(
    parseInvokeResponse(
      {
        protocol: "morphz-domain/v1",
        authority,
        operationId: "read",
        result: value,
      },
      "read",
    ).result,
    value,
  );
  const object = {
    protocol: "morphz-domain/v1",
    authority,
    object: resources[0],
    kind: "document",
    title: "Original",
  };
  assert.deepEqual(
    parseObjectReadResponse({ ...object, content: { format: "json", value } })
      .content,
    { format: "json", value },
  );
  for (const format of ["text", "markdown"] as const)
    assert.deepEqual(
      parseObjectReadResponse({ ...object, content: { format, text } }).content,
      { format, text },
    );
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(canonicalJsonBytes(value))),
    value,
  );
  assert.equal(JSON.parse(identityText(request)).parameters[text][0], text);
  assert.deepEqual(JSON.parse(JSON.stringify(parseWireJson(value))), value);
});

test("wire modules stay pure and reuse one bounded JSON validator", () => {
  const source = readFileSync(
    new URL(
      "../packages/cognitive-app-sdk/src/domain-wire.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.deepEqual(
    [
      ...source.matchAll(
        /\bimport\s+(?:(?:[^;]*?)\s+from\s+)?["']([^"']+)["']/g,
      ),
    ].map((match) => match[1]),
    ["zod", "./protocol.js"],
  );
  assert.doesNotMatch(source, /\b(?:import|require)\s*\(/);
  assert.doesNotMatch(
    source,
    /\b(?:process|Buffer|XMLHttpRequest|WebSocket)\b/,
  );
  assert.doesNotMatch(source, /\b(?:fetch|setTimeout|setInterval)\s*\(/);
  assert.equal(Object.isFrozen(domainWireLimits), true);
  assert.deepEqual(domainWireLimits, {
    bytes: 524288,
    depth: 40,
    nodes: 32768,
    receiptSummaryBytes: 65536,
    objectReadBytes: 262144,
  });
});

test("identity and real source classification are explicit, exact and strict", () => {
  assert.deepEqual(parseDomainAuthority(authority), authority);
  assert.deepEqual(parseDomainActor(human), human);
  assert.deepEqual(parseDomainActor(agent), agent);
  assert.deepEqual(parseDomainActor(taskRun), taskRun);
  const withoutInput = {
    ...taskRun,
    source: { ...taskRun.source, sourceInputId: null },
  };
  assert.deepEqual(parseDomainActor(withoutInput), withoutInput);
  for (const actor of [
    { ...human, source: agent.source },
    { ...agent, source: human.source },
    { ...taskRun, source: { ...taskRun.source, kind: "input" } },
    { ...agent, credential: "private" },
    { ...human, source: { kind: "human", inputId: "invented" } },
    { ...agent, source: { kind: "input", inputId: "input" } },
  ])
    assert.throws(() => parseDomainActor(actor));
  for (const value of [
    { ...authority, version: "latest" },
    { ...authority, definitionHash: "A".repeat(64) },
    { ...authority, instanceId: "x".repeat(101) },
    { ...authority, serviceId: "x".repeat(201) },
    { ...authority, endpoint: "https://example.invalid" },
  ])
    assert.throws(() => parseDomainAuthority(value));
});

test("describe fixes one definition and authority without accepting dynamic schemas", () => {
  const request = { protocol: "morphz-domain/v1" as const, definition };
  const response = {
    ...request,
    serviceId: authority.serviceId,
    dataAuthorityId: authority.dataAuthorityId,
  };
  assert.deepEqual(parseDescribeRequest(request), request);
  assert.deepEqual(parseDescribeResponse(response, request), response);
  assert.throws(() =>
    parseDescribeResponse(
      { ...response, definition: { ...definition, version: "1.0.1" } },
      request,
    ),
  );
  assert.throws(() => parseDescribeResponse({ ...response, operations: [] }));
  assert.throws(() =>
    parseDescribeResponse({ protocol: "morphz-domain/v1", definition }),
  );
  assert.throws(() =>
    parseDescribeRequest({ ...request, credential: "private" }),
  );
});

test("invocation takes immutable operation semantics, never wire-selected effects or authority", () => {
  const request = invocation();
  assert.deepEqual(parseInvokeRequest(request, "write", "objects"), request);
  assert.deepEqual(
    parseInvokeRequest(invocation(taskRun), "execute", "objects").delegation
      .actor,
    taskRun,
  );
  const read = {
    ...request,
    delegation: { ...request.delegation, command: null },
  };
  assert.deepEqual(parseInvokeRequest(read, "read", "objects"), read);
  assert.throws(() => parseInvokeRequest(read, "write", "objects"));
  assert.throws(() => parseInvokeRequest(request, "read", "objects"));
  assert.throws(() =>
    parseInvokeRequest({ ...request, effect: "read" }, "write", "objects"),
  );
  assert.throws(() =>
    parseInvokeRequest(
      {
        ...request,
        delegation: { ...request.delegation, purpose: "receipt-recovery" },
      },
      "write",
      "objects",
    ),
  );
  assert.throws(() =>
    parseInvokeRequest(
      { ...request, delegation: { ...request.delegation, resources: [] } },
      "write",
      "objects",
    ),
  );
  assert.deepEqual(
    parseInvokeRequest(
      { ...request, delegation: { ...request.delegation, resources: [] } },
      "write",
      "project",
    ).delegation.resources,
    [],
  );
  assert.throws(() =>
    parseInvokeRequest(
      {
        ...request,
        delegation: {
          ...request.delegation,
          resources: [resources[0], { ...resources[0], versionRef: "another" }],
        },
      },
      "write",
      "objects",
    ),
  );
});

test("all envelope scopes reject credentials, endpoints and unsupported transport fields", () => {
  const request = invocation();
  for (const extra of [
    { credential: "private" },
    { endpoint: "https://example.invalid" },
    { nonce: "not-v1" },
    { transportRevision: 2 },
    { connectionRevision: 3 },
    { approved: true },
  ]) {
    assert.throws(() =>
      parseInvokeRequest({ ...request, ...extra }, "write", "objects"),
    );
    assert.throws(() =>
      parseInvokeRequest(
        { ...request, delegation: { ...request.delegation, ...extra } },
        "write",
        "objects",
      ),
    );
  }
  assert.throws(() =>
    canonicalInvokeIdentityBytes(
      { ...request, credential: "private" },
      "write",
      "objects",
    ),
  );
  assert.throws(() =>
    parseInvokeRequest(
      {
        ...request,
        delegation: { ...request.delegation, expiresAt: "tomorrow" },
      },
      "write",
      "objects",
    ),
  );
});

test("committed receipts retain full binding, result and bounded original summaries", () => {
  const receipt = committed(taskRun);
  assert.deepEqual(parseDomainReceipt(receipt, binding(taskRun)), receipt);
  assert.deepEqual(
    parseInvokeResponse(receipt, "execute", binding(taskRun)),
    receipt,
  );
  assert.throws(() =>
    parseDomainReceipt(
      { ...receipt, binding: binding(agent) },
      binding(taskRun),
    ),
  );
  assert.throws(() =>
    parseDomainReceipt(
      {
        ...receipt,
        binding: {
          ...receipt.binding,
          authority: { ...authority, dataAuthorityId: "replacement" },
        },
      },
      binding(taskRun),
    ),
  );
  assert.throws(() =>
    parseDomainReceipt({
      ...receipt,
      objects: [summary, { ...summary, versionRef: "another" }],
    }),
  );
  assert.throws(() =>
    parseDomainReceipt({
      ...receipt,
      objects: [{ ...summary, body: "not-a-summary" }],
    }),
  );
  assert.throws(() =>
    parseDomainReceipt({
      ...receipt,
      objects: Array.from({ length: 33 }, (_, index) => ({
        ...summary,
        objectId: `object-${index}`,
      })),
    }),
  );
  assert.throws(() =>
    parseDomainReceipt({ ...receipt, committedAt: "invalid" }),
  );
  const { receiptId: _id, ...missingReceiptId } = receipt;
  assert.throws(() => parseDomainReceipt(missingReceiptId));
  const { committedAt: _time, ...missingTime } = receipt;
  assert.throws(() => parseDomainReceipt(missingTime));
  const { result: _result, ...missingResult } = receipt;
  assert.throws(() => parseDomainReceipt(missingResult));
});

test("rejected requires authoritative denial evidence; not_seen is unknown only", () => {
  const reason = {
    code: "domain_denied",
    message: "The original was not committed.",
  };
  const rejected = {
    protocol: "morphz-domain/v1",
    status: "rejected",
    binding: binding(),
    receiptId: "denial-receipt",
    reason,
  };
  assert.deepEqual(parseDomainReceipt(rejected), rejected);
  const { receiptId: _id, ...missingReceiptId } = rejected;
  assert.throws(() => parseDomainReceipt(missingReceiptId));
  assert.throws(() =>
    parseDomainReceipt({
      ...rejected,
      reason: { code: "not_seen", message: "No receipt yet." },
    }),
  );
  const unknown = {
    protocol: "morphz-domain/v1",
    status: "unknown",
    binding: binding(),
    reason: {
      code: "not_seen",
      message: "No receipt yet; the old request may still be in flight.",
    },
  };
  assert.deepEqual(parseDomainReceipt(unknown), unknown);
  assert.throws(() => parseDomainReceipt({ ...unknown, status: "not_seen" }));
  for (const extra of [
    { committedAt: "2026-10-05T09:59:00Z" },
    { result: null },
    { objects: [] },
    { receiptId: "invented" },
  ])
    assert.throws(() => parseDomainReceipt({ ...unknown, ...extra }));
  for (const extra of [
    { committedAt: "2026-10-05T09:59:00Z" },
    { result: null },
    { objects: [] },
  ])
    assert.throws(() => parseDomainReceipt({ ...rejected, ...extra }));
  assert.throws(() =>
    parseDomainReceipt({
      protocol: "morphz-domain/v1",
      status: "rejected",
      error: "HTTP 403",
    }),
  );
});

test("read results are separate from command receipts and caller checks actual output schema", () => {
  const response = {
    protocol: "morphz-domain/v1",
    authority,
    operationId: "notes.list",
    result: { count: 1 },
  };
  assert.deepEqual(parseInvokeResponse(response, "read"), response);
  assert.throws(() => parseInvokeResponse(committed(), "read"));
  assert.throws(() => parseInvokeResponse(response, "write"));
  assert.throws(() =>
    validateOperationValue(
      { type: "integer" },
      parseInvokeResponse(response, "read").result,
    ),
  );
  assert.throws(() =>
    parseInvokeResponse({ ...response, result: undefined }, "read"),
  );
  assert.throws(() =>
    parseInvokeResponse({ ...response, result: NaN }, "read"),
  );
  assert.throws(() =>
    parseDomainReceipt({ ...committed(), result: "x".repeat(262143) }),
  );
});

test("a valid committed fact survives separate business output-schema failure", () => {
  const original = committed();
  const receipt = parseInvokeResponse(original, "write", binding());
  assert.equal(receipt.status, "committed");
  if (receipt.status !== "committed") assert.fail("Expected committed fact");
  assert.throws(() =>
    validateOperationValue({ type: "integer" }, receipt.result),
  );
  assert.deepEqual(receipt, original);
  assert.equal(receipt.receiptId, original.receiptId);
  assert.equal(receipt.committedAt, original.committedAt);
  assert.deepEqual(parseDomainReceipt(receipt, binding()), original);
});

test("exact object reads bind the same authority, opaque original and exact version", () => {
  const request = objectRead();
  assert.deepEqual(parseObjectReadRequest(request), request);
  const response = {
    protocol: "morphz-domain/v1",
    authority,
    object: resources[0],
    kind: "document",
    title: "Original",
    content: { format: "json", value: { original: true } },
  };
  assert.deepEqual(parseObjectReadResponse(response, request), response);
  assert.throws(() =>
    parseObjectReadRequest({
      ...request,
      object: { ...resources[0], versionRef: "latest" },
    }),
  );
  assert.throws(() =>
    parseObjectReadResponse(
      { ...response, object: { ...resources[0], versionRef: "another" } },
      request,
    ),
  );
  assert.throws(() =>
    parseObjectReadResponse(
      {
        ...response,
        authority: { ...authority, instanceId: "other_instance" },
      },
      request,
    ),
  );
  assert.throws(() =>
    parseObjectReadResponse(
      {
        ...response,
        content: { format: "html", text: "<p>not-supported</p>" },
      },
      request,
    ),
  );
  assert.throws(() =>
    parseObjectReadResponse(
      {
        ...response,
        content: {
          format: "json",
          value: null,
          url: "https://example.invalid",
        },
      },
      request,
    ),
  );
  assert.throws(() => parseObjectReadRequest({ ...request, maxBytes: 0 }));
  assert.throws(() => parseObjectReadRequest({ ...request, maxBytes: 262145 }));
});

test("object content uses raw text or serialized JSON UTF-8 byte budgets, never character counts", () => {
  const request = { ...objectRead(), maxBytes: 6 };
  const base = {
    protocol: "morphz-domain/v1",
    authority,
    object: resources[0],
    kind: "document",
    title: "Original",
  };
  assert.deepEqual(
    parseObjectReadResponse(
      { ...base, content: { format: "markdown", text: "中文" } },
      request,
    ).content,
    { format: "markdown", text: "中文" },
  );
  assert.throws(() =>
    parseObjectReadResponse(
      { ...base, content: { format: "text", text: "中文x" } },
      request,
    ),
  );
  assert.deepEqual(
    parseObjectReadResponse(
      { ...base, content: { format: "json", value: "😀" } },
      request,
    ).content,
    { format: "json", value: "😀" },
  );
  assert.throws(() =>
    parseObjectReadResponse(
      { ...base, content: { format: "json", value: "😀x" } },
      request,
    ),
  );
  const maximum = {
    ...base,
    content: { format: "text", text: "x".repeat(262144) },
  };
  assert.equal(
    (parseObjectReadResponse(maximum, objectRead()).content as { text: string })
      .text.length,
    262144,
  );
  assert.throws(() =>
    parseObjectReadResponse(
      { ...maximum, content: { format: "text", text: "x".repeat(262145) } },
      objectRead(),
    ),
  );
});

test("receipt recovery preserves historical source and never invents new invocation parameters", () => {
  const request = recovery();
  assert.deepEqual(parseReceiptReadRequest(request), request);
  assert.equal(
    parseReceiptReadRequest(request).delegation.actor.source.kind,
    "task-run",
  );
  assert.deepEqual(
    parseReceiptReadRequest(recovery(human)).delegation.actor,
    human,
  );
  assert.throws(() => parseReceiptReadRequest({ ...request, parameters: {} }));
  assert.throws(() =>
    parseReceiptReadRequest({
      ...request,
      delegation: { ...request.delegation, purpose: "invoke" },
    }),
  );
  assert.throws(() =>
    parseReceiptReadRequest({
      ...request,
      delegation: { ...request.delegation, currentActor: human },
    }),
  );
  assert.throws(() =>
    parseReceiptReadRequest({
      ...request,
      delegation: {
        ...request.delegation,
        historicalAdmission: { commandId: "command" },
      },
    }),
  );
});

test("canonical request identity sorts every key but keeps arrays and literal data intact", () => {
  const request = invocation();
  const reordered = {
    parameters: { markdown: "Original", title: "TEST" },
    delegation: {
      ...request.delegation,
      authority: {
        dataAuthorityId: authority.dataAuthorityId,
        serviceId: authority.serviceId,
        instanceId: authority.instanceId,
        definitionHash: authority.definitionHash,
        version: authority.version,
        appId: authority.appId,
      },
    },
    protocol: request.protocol,
  };
  assert.equal(identityText(request), identityText(reordered));
  const parsed = JSON.parse(identityText(request));
  assert.deepEqual(Object.keys(parsed), [
    "actor",
    "authority",
    "operationId",
    "parameters",
    "projectId",
    "protocol",
    "resources",
  ]);
  assert.deepEqual(parsed.resources, resources);
  const first = {
    ...request,
    parameters: {
      records: [1, 2],
      principalId: "plain business field",
      credential: "plain business field",
    },
  };
  const second = {
    ...first,
    parameters: { ...first.parameters, records: [2, 1] },
  };
  assert.notEqual(identityText(first), identityText(second));
  assert.match(identityText(first), /plain business field/);
  assert.equal(
    identityText({ ...request, parameters: { value: -0 } }),
    identityText({ ...request, parameters: { value: 0 } }),
  );
});

test("canonical JSON bytes preserve special keys and exact sorted-key structure", () => {
  const value = JSON.parse(
    '{"2":"two","__proto__":{"b":2,"a":1},"10":"ten","a":[2,1]}',
  );
  const original = JSON.stringify(value);
  assert.equal(
    new TextDecoder().decode(canonicalJsonBytes(value)),
    '{"10":"ten","2":"two","__proto__":{"a":1,"b":2},"a":[2,1]}',
  );
  assert.equal(JSON.stringify(value), original);
  assert.equal(Object.hasOwn(value, "__proto__"), true);
  assert.deepEqual(
    canonicalJsonBytes(value),
    canonicalJsonBytes(
      JSON.parse('{"a":[2,1],"__proto__":{"a":1,"b":2},"10":"ten","2":"two"}'),
    ),
  );
  assert.throws(() => canonicalJsonBytes("x".repeat(524287)), /UTF-8 budget/);
  let getterRead = false;
  const unsafe = Object.defineProperty({}, "key", {
    enumerable: true,
    get() {
      getterRead = true;
      return "unsafe";
    },
  });
  assert.throws(() => canonicalJsonBytes(unsafe));
  assert.equal(getterRead, false);
});

test("transport renewal and independent command IDs do not alter the semantic byte identity", () => {
  const request = invocation();
  const renewed = {
    ...request,
    delegation: {
      ...request.delegation,
      issuer: "host-two",
      expiresAt: "2026-10-06T10:00:00Z",
      command: { commandId: "retry_key", requestHash: "c".repeat(64) },
    },
  };
  assert.equal(identityText(request), identityText(renewed));
  assert.doesNotMatch(
    identityText(request),
    /issuer|expiresAt|requestHash|commandId/,
  );
});

test("every semantic authority, actor, source, target, parameter and resource change changes bytes", () => {
  const request = invocation(taskRun);
  const original = identityText(request);
  const variants = [
    { ...request, parameters: { title: "Changed" } },
    {
      ...request,
      delegation: { ...request.delegation, projectId: "other_project" },
    },
    {
      ...request,
      delegation: { ...request.delegation, operationId: "notes.revise" },
    },
    {
      ...request,
      delegation: {
        ...request.delegation,
        resources: [{ ...resources[0], versionRef: "v2" }],
      },
    },
    ...[
      "appId",
      "version",
      "definitionHash",
      "instanceId",
      "serviceId",
      "dataAuthorityId",
    ].map((key) => ({
      ...request,
      delegation: {
        ...request.delegation,
        authority: {
          ...authority,
          [key]:
            key === "appId"
              ? "example.other"
              : key === "version"
                ? "1.0.1"
                : key === "definitionHash"
                  ? "d".repeat(64)
                  : "changed",
        },
      },
    })),
    ...["tenantId", "principalId", "actantId"].map((key) => ({
      ...request,
      delegation: {
        ...request.delegation,
        actor: { ...taskRun, [key]: "changed" },
      },
    })),
    ...[
      "sessionId",
      "scheduleId",
      "eventId",
      "sourceInputId",
      "humanActantId",
    ].map((key) => ({
      ...request,
      delegation: {
        ...request.delegation,
        actor: { ...taskRun, source: { ...taskRun.source, [key]: "changed" } },
      },
    })),
    invocation(agent),
    invocation(human),
  ];
  for (const variant of variants)
    assert.notEqual(identityText(variant), original);
});

test("whole wires and actual parameters retain separate byte, depth and node limits", () => {
  const request = invocation();
  assert.equal(
    parseInvokeRequest(
      { ...request, parameters: "x".repeat(262142) },
      "write",
      "objects",
    ).parameters,
    "x".repeat(262142),
  );
  assert.throws(
    () =>
      parseInvokeRequest(
        { ...request, parameters: "x".repeat(262143) },
        "write",
        "objects",
      ),
    /UTF-8 budget/,
  );
  assert.throws(
    () =>
      parseInvokeRequest(
        { ...request, parameters: "文".repeat(90000) },
        "write",
        "objects",
      ),
    /UTF-8 budget/,
  );
  assert.throws(
    () =>
      parseInvokeRequest(
        { ...request, extra: "x".repeat(524288) },
        "write",
        "objects",
      ),
    /UTF-8 budget/,
  );
  assert.equal(parseWireJson("x".repeat(524286)), "x".repeat(524286));
  assert.throws(() => parseWireJson("x".repeat(524287)), /UTF-8 budget/);
  assert.equal(
    (parseWireJson(Array(32767).fill(null)) as readonly unknown[]).length,
    32767,
  );
  assert.throws(() => parseWireJson(Array(32768).fill(null)), /node budget/);
  function deep(depth: number): unknown {
    let value: unknown = null;
    for (let index = 1; index < depth; index++) value = [value];
    return value;
  }
  assert.deepEqual(parseWireJson(deep(40)), deep(40));
  assert.throws(() => parseWireJson(deep(41)), /depth budget/);
  assert.throws(
    () =>
      parseInvokeRequest(
        { ...request, parameters: deep(33) },
        "write",
        "objects",
      ),
    /depth budget/,
  );
  assert.throws(
    () =>
      parseInvokeRequest(
        { ...request, parameters: Array(16384).fill(null) },
        "write",
        "objects",
      ),
    /node budget/,
  );
  assert.ok(bytes(request) < 524288);
});

test("non-JSON and cyclic data fail before Zod, canonicalization or successful response interpretation", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  let getterRead = false;
  const accessor = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      getterRead = true;
      return "unsafe";
    },
  });
  const request = invocation();
  for (const value of [
    cyclic,
    accessor,
    NaN,
    Infinity,
    undefined,
    () => null,
    new Date(),
    Array(1),
  ]) {
    const changed = { ...request, parameters: value };
    assert.throws(() => parseInvokeRequest(changed, "write", "objects"));
    assert.throws(() =>
      canonicalInvokeIdentityBytes(changed, "write", "objects"),
    );
    assert.throws(() => parseDomainReceipt({ ...committed(), result: value }));
  }
  assert.equal(getterRead, false);
  assert.throws(() => parseDescribeResponse(cyclic));
});

test("committed summaries fit the ledger's exact UTF-8 budget before establishing a complete protocol fact", () => {
  const objects = Array.from({ length: 32 }, (_, index) => ({
    objectId: String(index).padEnd(200, "x"),
    versionRef: "x".repeat(200),
    kind: "x".repeat(100),
    title: "x".repeat(180),
  }));
  let remaining = 65536 - bytes(objects);
  for (const object of objects) {
    for (const field of ["objectId", "versionRef", "kind", "title"] as const) {
      for (
        let index = 2;
        index < object[field].length && remaining > 0;
        index++
      ) {
        const character = remaining >= 2 ? "界" : "\n";
        object[field] =
          object[field].slice(0, index) +
          character +
          object[field].slice(index + 1);
        remaining -= character === "界" ? 2 : 1;
      }
    }
  }
  assert.equal(remaining, 0);
  assert.equal(bytes(objects), 65536);
  const receipt = { ...committed(), objects };
  assert.equal(parseDomainReceipt(receipt, binding()).status, "committed");
  const above = objects.map((object) => ({ ...object }));
  const last = above.at(-1)!;
  const lastIndex = last.title.lastIndexOf("x");
  assert.ok(lastIndex >= 0);
  last.title =
    last.title.slice(0, lastIndex) + "\n" + last.title.slice(lastIndex + 1);
  assert.equal(bytes(above), 65537);
  assert.throws(
    () => parseDomainReceipt({ ...receipt, objects: above }, binding()),
    CognitiveAppProtocolError,
  );
  assert.equal(bytes(objects), 65536);
});
