import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import {
  CognitiveAppBindings,
  CognitiveAppBindingsError,
} from "../packages/application/src/cognitive-app-bindings.js";
import {
  CognitiveAppTransport,
  type CognitiveAppTransportLease,
} from "../packages/application/src/cognitive-app-transport.js";

const tuple = Object.freeze({
  tenantId: "tenant_fixture",
  principalId: "human_fixture",
  appId: "author.fixture",
  serviceId: "author-service",
  dataAuthorityId: "原件 authority/一",
});
const secretName = "MORPHZ_APP_COGNITIVE_CREDENTIAL_FIXTURE_ONLY";
const fixtureSecret = "isolated-fixture-private-credential";
const entry = {
  ...tuple,
  baseUrl: "https://author.example",
  credentialEnv: secretName,
  current: true,
};
function config(bindings: unknown[] = [entry], issuer = "fixture-host") {
  return { format: "morphz-host-cognitive-bindings/v1", issuer, bindings };
}
function fixture(value: unknown = config()) {
  const directory = mkdtempSync(join(tmpdir(), "morphz-cognitive-bindings-"));
  const filename = join(directory, "bindings.json");
  const replace = (next: unknown, mode = 0o600) => {
    const replacement = join(directory, "replacement.json");
    writeFileSync(replacement, JSON.stringify(next), { mode });
    chmodSync(replacement, mode);
    renameSync(replacement, filename);
  };
  replace(value);
  return {
    directory,
    filename,
    replace,
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}
function unavailable(error: unknown) {
  assert.ok(error instanceof CognitiveAppBindingsError);
  assert.equal(error.message, "应用私有连接不可用。");
  assert.equal("cause" in error, false);
  for (const text of [
    fixtureSecret,
    secretName,
    "author.example",
    "bindings.json",
    "cognitive_binding_",
  ]) {
    assert.equal(String(error).includes(text), false);
    assert.equal(JSON.stringify(error).includes(text), false);
    assert.equal(inspect(error).includes(text), false);
  }
  return true;
}

for (const field of ["issuer", "serviceId", "dataAuthorityId"] as const) {
  test(`private config rejects non-portable ${field} before reading any credential`, () => {
    const f = fixture();
    let reads = 0;
    const resolver = new CognitiveAppBindings({
      filename: f.filename,
      readSecret: () => {
        reads++;
        return fixtureSecret;
      },
    });
    try {
      for (const text of ["before\0after", "bad\uD800", "bad\uDC00"]) {
        const invalidTuple =
          field === "issuer" ? tuple : { ...tuple, [field]: text };
        f.replace(
          config(
            [{ ...entry, ...invalidTuple }],
            field === "issuer" ? text : "fixture-host",
          ),
        );
        assert.throws(
          () => resolver.prepareConnection(invalidTuple),
          unavailable,
        );
        assert.equal(reads, 0);
        if (field !== "issuer") {
          f.replace(
            config([entry, { ...entry, principalId: "other", [field]: text }]),
          );
          assert.throws(() => resolver.prepareConnection(tuple), unavailable);
          assert.equal(reads, 0);
        }
      }
      const legal = " 原件\n\t👩‍💻é ";
      const validTuple =
        field === "issuer" ? tuple : { ...tuple, [field]: legal };
      f.replace(
        config(
          [{ ...entry, ...validTuple }],
          field === "issuer" ? legal : "fixture-host",
        ),
      );
      const handle = resolver.prepareConnection(validTuple);
      assert.equal(handle.issuer, field === "issuer" ? legal : "fixture-host");
      assert.equal(reads, 1);
    } finally {
      f.close();
    }
  });
}

test("private resolver is lazy and fails closed without leaking file or secret details", () => {
  assert.throws(
    () => new CognitiveAppBindings({ filename: "relative.json" }),
    unavailable,
  );
  const f = fixture();
  try {
    const resolver = new CognitiveAppBindings({
      filename: join(f.directory, "missing-private-file"),
      readSecret: () => fixtureSecret,
    });
    assert.throws(() => resolver.prepareConnection(tuple), unavailable);
  } finally {
    f.close();
  }
});

test("purpose-only readonly handles never serialize or inspect private route facts", () => {
  const f = fixture();
  try {
    const resolver = new CognitiveAppBindings({
      filename: f.filename,
      readSecret: () => fixtureSecret,
    });
    const setup = resolver.prepareConnection(tuple);
    assert.equal(setup.purpose, "connection-setup");
    assert.equal(setup.issuer, "fixture-host");
    assert.match(setup.hostBindingId, /^cognitive_binding_[a-f0-9]{64}$/);
    const active = resolver.resolveConnection(tuple, setup.hostBindingId);
    const recovery = resolver.resolveReceipt(tuple, setup.hostBindingId);
    for (const handle of [setup, active, recovery]) {
      assert.ok(Object.isFrozen(handle));
      assert.equal("binding" in handle, false);
      assert.equal("post" in handle, false);
      for (const rendered of [
        JSON.stringify(handle),
        inspect(handle),
        inspect({ ...handle }),
      ]) {
        for (const sensitive of [
          handle.hostBindingId,
          handle.issuer,
          "author.example",
          secretName,
          fixtureSecret,
        ])
          assert.equal(rendered.includes(sensitive), false);
      }
      assert.throws(() => Object.assign(handle, { purpose: "other" }));
    }
    assert.equal("invoke" in setup, false);
    assert.equal("readObject" in setup, false);
    assert.equal("readReceipt" in setup, false);
    assert.equal("describe" in active, false);
    assert.equal("readReceipt" in active, false);
    assert.equal("invoke" in recovery, false);
    assert.equal("readObject" in recovery, false);
    assert.equal("describe" in recovery, false);
  } finally {
    f.close();
  }
});

test("all four purpose methods use the actual pinned transport route and private credential", async () => {
  const requests: {
    path: string;
    authorization: string | undefined;
    body: unknown;
  }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    requests.push({
      path: request.url!,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ path: request.url }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const f = fixture(
    config([
      {
        ...entry,
        baseUrl: `http://127.0.0.1:${port}`,
        approvedLoopback: { host: "127.0.0.1", port },
      },
    ]),
  );
  try {
    const secretsRead: string[] = [];
    const resolver = new CognitiveAppBindings({
      filename: f.filename,
      readSecret: (name) => {
        secretsRead.push(name);
        return fixtureSecret;
      },
    });
    const setup = resolver.prepareConnection(tuple);
    const active = resolver.resolveConnection(tuple, setup.hostBindingId);
    const recovery = resolver.resolveReceipt(tuple, setup.hostBindingId);
    const transport = new CognitiveAppTransport();
    const calls = [
      setup.describe,
      active.invoke,
      active.readObject,
      recovery.readReceipt,
    ];
    const paths = ["/describe", "/invoke", "/objects/read", "/receipts/read"];
    for (const [index, call] of calls.entries()) {
      const lease = transport.tryAcquire("tenant_fixture/connection_fixture")!;
      const value = await call(lease, { literal: index });
      assert.deepEqual(value, { path: paths[index] });
      // A capability does not defeat the transport's one-use permit or create retries.
      await assert.rejects(call(lease, {}));
    }
    assert.deepEqual(secretsRead, [secretName, secretName, secretName]);
    assert.deepEqual(
      requests.map((request) => request.path),
      paths,
    );
    assert.ok(
      requests.every(
        (request) => request.authorization === `Bearer ${fixtureSecret}`,
      ),
    );
    assert.deepEqual(
      requests.map((request) => request.body),
      [0, 1, 2, 3].map((literal) => ({ literal })),
    );
  } finally {
    f.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("private capabilities never pass a binding to caller-forged transport permits", async () => {
  const f = fixture();
  const real = new CognitiveAppTransport().tryAcquire("fixture/brand-only")!;
  let forgedPostCalls = 0;
  try {
    const resolver = new CognitiveAppBindings({
      filename: f.filename,
      readSecret: () => fixtureSecret,
    });
    const setup = resolver.prepareConnection(tuple);
    const active = resolver.resolveConnection(tuple, setup.hostBindingId);
    const receipt = resolver.resolveReceipt(tuple, setup.hostBindingId);
    const forged = {
      post: async () => {
        forgedPostCalls++;
        return {};
      },
      release() {},
    };
    const getter = Object.defineProperty({}, "post", {
      get: () => {
        forgedPostCalls++;
        return forged.post;
      },
    });
    for (const method of [
      setup.describe,
      active.invoke,
      active.readObject,
      receipt.readReceipt,
    ]) {
      for (const fake of [
        forged,
        getter,
        { ...real },
        new Proxy(real, {}),
        null,
      ])
        await assert.rejects(
          Promise.resolve().then(() =>
            method(fake as CognitiveAppTransportLease, {}),
          ),
          unavailable,
        );
    }
    assert.equal(
      forgedPostCalls,
      0,
      "private binding must never reach fake post",
    );
  } finally {
    real.release();
    f.close();
  }
});

test("actual tuple is exact and cannot borrow another person's route or normalize opaque authority", () => {
  const other = {
    ...entry,
    principalId: "other_human",
    credentialEnv: `${secretName}_OTHER`,
  };
  const f = fixture(config([entry, other]));
  const reads: string[] = [];
  try {
    const resolver = new CognitiveAppBindings({
      filename: f.filename,
      readSecret: (name) => {
        reads.push(name);
        return fixtureSecret;
      },
    });
    const setup = resolver.prepareConnection(tuple);
    reads.length = 0;
    for (const changed of [
      { ...tuple, tenantId: "other_tenant" },
      { ...tuple, principalId: "missing_human" },
      { ...tuple, appId: "other.fixture" },
      { ...tuple, serviceId: `${tuple.serviceId} ` },
      { ...tuple, dataAuthorityId: `${tuple.dataAuthorityId} ` },
      {
        ...tuple,
        appId: "author.fixture",
        endpoint: "https://injected.example",
      },
    ])
      assert.throws(() => resolver.prepareConnection(changed), unavailable);
    assert.throws(
      () =>
        resolver.resolveConnection(
          { ...tuple, principalId: "other_human" },
          setup.hostBindingId,
        ),
      unavailable,
    );
    assert.throws(
      () =>
        resolver.resolveReceipt(
          { ...tuple, principalId: "other_human" },
          setup.hostBindingId,
        ),
      unavailable,
    );
    assert.throws(
      () => resolver.resolveConnection(tuple, undefined as unknown as string),
      unavailable,
    );
    assert.throws(
      () => resolver.resolveReceipt(tuple, undefined as unknown as string),
      unavailable,
    );
    assert.throws(
      () => resolver.resolveConnection(tuple, "private-operator-locator"),
      unavailable,
    );
    assert.deepEqual(
      reads,
      [],
      "failed exact selection must not access any person's credential",
    );
    assert.notEqual(
      resolver.prepareConnection({ ...tuple, principalId: "other_human" })
        .hostBindingId,
      setup.hostBindingId,
    );
    assert.deepEqual(reads, [other.credentialEnv]);
  } finally {
    f.close();
  }
});

test("retired routes are receipt-only and a changed current route never silently replaces SQL alias", () => {
  const f = fixture();
  try {
    const resolver = new CognitiveAppBindings({
      filename: f.filename,
      readSecret: () => fixtureSecret,
    });
    const old = resolver.prepareConnection(tuple);
    f.replace(
      config([
        { ...entry, current: false },
        { ...entry, baseUrl: "https://next-author.example" },
      ]),
    );
    const current = resolver.prepareConnection(tuple);
    assert.notEqual(current.hostBindingId, old.hostBindingId);
    assert.throws(
      () => resolver.resolveConnection(tuple, old.hostBindingId),
      unavailable,
    );
    assert.equal(
      resolver.resolveReceipt(tuple, old.hostBindingId).hostBindingId,
      old.hostBindingId,
    );
    assert.equal(
      resolver.resolveConnection(tuple, current.hostBindingId).hostBindingId,
      current.hostBindingId,
    );
    f.replace(config([{ ...entry, baseUrl: "https://next-author.example" }]));
    assert.throws(
      () => resolver.resolveReceipt(tuple, old.hostBindingId),
      unavailable,
    );
    f.replace(config([{ ...entry, current: false }]));
    assert.throws(() => resolver.prepareConnection(tuple), unavailable);
    assert.throws(
      () => resolver.resolveConnection(tuple, old.hostBindingId),
      unavailable,
    );
    const recovery = resolver.resolveReceipt(tuple, old.hostBindingId);
    assert.equal(recovery.purpose, "receipt-recovery");
    assert.equal("invoke" in recovery, false);
    assert.equal("describe" in recovery, false);
  } finally {
    f.close();
  }
});

test("aliases survive secret/env/filename/current changes but track issuer and actual route tuple", () => {
  const f = fixture(),
    second = fixture();
  try {
    let secret = fixtureSecret;
    const resolver = new CognitiveAppBindings({
      filename: f.filename,
      readSecret: () => secret,
    });
    const old = resolver.prepareConnection(tuple);
    assert.equal(
      new CognitiveAppBindings({
        filename: second.filename,
        readSecret: () => secret,
      }).prepareConnection(tuple).hostBindingId,
      old.hostBindingId,
    );
    secret = "rotated-isolated-fixture-secret";
    f.replace(
      config([
        {
          ...entry,
          baseUrl: `${entry.baseUrl}/`,
          credentialEnv: `${secretName}_ROTATED`,
        },
      ]),
    );
    assert.equal(
      resolver.prepareConnection(tuple).hostBindingId,
      old.hostBindingId,
    );
    f.replace(config([{ ...entry, current: false }]));
    assert.equal(
      resolver.resolveReceipt(tuple, old.hostBindingId).hostBindingId,
      old.hostBindingId,
    );
    f.replace(config([entry], "different-stable-host"));
    assert.notEqual(
      resolver.prepareConnection(tuple).hostBindingId,
      old.hostBindingId,
    );
    assert.throws(
      () => resolver.resolveReceipt(tuple, old.hostBindingId),
      unavailable,
    );
    for (const changed of [
      { ...entry, serviceId: "new-service" },
      { ...entry, dataAuthorityId: "new-authority" },
      { ...entry, tenantId: "new_tenant" },
      { ...entry, principalId: "new_human" },
      { ...entry, appId: "another.fixture" },
    ]) {
      f.replace(config([changed]));
      const actual = {
        tenantId: changed.tenantId,
        principalId: changed.principalId,
        appId: changed.appId,
        serviceId: changed.serviceId,
        dataAuthorityId: changed.dataAuthorityId,
      };
      assert.notEqual(
        resolver.prepareConnection(actual).hostBindingId,
        old.hostBindingId,
      );
    }
  } finally {
    f.close();
    second.close();
  }
});

test("duplicate aliases and multiple current routes fail the whole snapshot before secret lookup", () => {
  const f = fixture();
  let reads = 0;
  try {
    const resolver = new CognitiveAppBindings({
      filename: f.filename,
      readSecret: () => {
        reads++;
        return fixtureSecret;
      },
    });
    for (const bindings of [
      [entry, { ...entry, current: false }],
      [
        entry,
        {
          ...entry,
          baseUrl: `${entry.baseUrl}/`,
          credentialEnv: `${secretName}_OTHER`,
        },
      ],
      [entry, { ...entry, baseUrl: "https://next-author.example" }],
      [
        entry,
        { ...entry, principalId: "other_human" },
        {
          ...entry,
          principalId: "other_human",
          baseUrl: "https://next-author.example",
        },
      ],
    ]) {
      f.replace(config(bindings));
      assert.throws(() => resolver.prepareConnection(tuple), unavailable);
      assert.equal(reads, 0);
    }
  } finally {
    f.close();
  }
});

test("every entry is strict, explicitly current, namespace bounded and URL-policy compatible", () => {
  const f = fixture();
  let reads = 0;
  try {
    const resolver = new CognitiveAppBindings({
      filename: f.filename,
      readSecret: () => {
        reads++;
        return fixtureSecret;
      },
    });
    const { current: _current, ...noCurrent } = entry;
    const invalid = [
      noCurrent,
      { ...entry, current: "true" },
      { ...entry, credential: fixtureSecret },
      { ...entry, hostBindingId: "operator-authored-alias" },
      { ...entry, credentialEnv: "DOUBAO_API_KEY" },
      { ...entry, credentialEnv: "MORPHZ_APP_COGNITIVE_CREDENTIAL_" },
      { ...entry, credentialEnv: `${secretName}/path` },
      { ...entry, baseUrl: "https://author.example/prefix" },
      { ...entry, baseUrl: "https://author.example?" },
      { ...entry, baseUrl: "https://author.example#" },
      { ...entry, baseUrl: "https://@author.example" },
      { ...entry, baseUrl: "https://user:password@author.example" },
      { ...entry, baseUrl: "http://author.example" },
      { ...entry, baseUrl: "https://127.0.0.1" },
      { ...entry, baseUrl: "https://169.254.169.254" },
      { ...entry, baseUrl: "https://[::ffff:8.8.8.8]" },
      {
        ...entry,
        baseUrl: "http://localhost:3000",
        approvedLoopback: { host: "127.0.0.1", port: 3000 },
      },
      {
        ...entry,
        baseUrl: "http://127.0.0.1:03000",
        approvedLoopback: { host: "127.0.0.1", port: 3000 },
      },
      {
        ...entry,
        baseUrl: "http://127.0.0.1:3000",
        approvedLoopback: { host: "127.0.0.1", port: 3001 },
      },
      {
        ...entry,
        baseUrl: "https://author.example",
        approvedLoopback: { host: "127.0.0.1", port: 3000 },
      },
      {
        ...entry,
        baseUrl: "http://127.0.0.1:3000",
        approvedLoopback: { host: "127.0.0.1", port: 3000, disableTLS: true },
      },
      JSON.parse(
        JSON.stringify(entry).replace(
          '"current":true',
          '"current":true,"__proto__":{"polluted":true}',
        ),
      ),
    ];
    for (const invalidEntry of invalid) {
      f.replace(
        config([entry, { ...invalidEntry, principalId: "other_human" }]),
      );
      assert.throws(() => resolver.prepareConnection(tuple), unavailable);
      assert.equal(reads, 0);
    }
    f.replace({ ...config(), credential: fixtureSecret });
    assert.throws(() => resolver.prepareConnection(tuple), unavailable);
    assert.equal(reads, 0);
  } finally {
    f.close();
  }
});

test("regular owner-only file gates reject symlinks/directories/FIFO and insecure modes", () => {
  const f = fixture();
  try {
    const resolver = new CognitiveAppBindings({
      filename: f.filename,
      readSecret: () => fixtureSecret,
    });
    for (const mode of [0o600, 0o400]) {
      chmodSync(f.filename, mode);
      assert.equal(
        resolver.prepareConnection(tuple).purpose,
        "connection-setup",
      );
    }
    for (const mode of [0o640, 0o644, 0o700, 0o200, 0o4600]) {
      chmodSync(f.filename, mode);
      assert.throws(() => resolver.prepareConnection(tuple), unavailable);
    }
    chmodSync(f.filename, 0o600);
    const symlink = join(f.directory, "symlink.json");
    symlinkSync(f.filename, symlink);
    assert.throws(
      () =>
        new CognitiveAppBindings({
          filename: symlink,
          readSecret: () => fixtureSecret,
        }).prepareConnection(tuple),
      unavailable,
    );
    assert.throws(
      () =>
        new CognitiveAppBindings({
          filename: f.directory,
          readSecret: () => fixtureSecret,
        }).prepareConnection(tuple),
      unavailable,
    );
    const fifo = join(f.directory, "fifo.json");
    execFileSync("mkfifo", [fifo]);
    chmodSync(fifo, 0o600);
    assert.throws(
      () =>
        new CognitiveAppBindings({
          filename: fifo,
          readSecret: () => fixtureSecret,
        }).prepareConnection(tuple),
      unavailable,
    );
  } finally {
    f.close();
  }
});

test("file bytes/entry count and fatal UTF-8 limits are enforced before secret lookup", () => {
  const f = fixture();
  let reads = 0;
  try {
    const resolver = new CognitiveAppBindings({
      filename: f.filename,
      readSecret: () => {
        reads++;
        return fixtureSecret;
      },
    });
    for (const bytes of [
      Buffer.from(" ".repeat(128 * 1024 + 1)),
      Buffer.from([0xc3, 0x28]),
      Buffer.from("not-json-private-content"),
      Buffer.from("\0"),
    ]) {
      writeFileSync(f.filename, bytes);
      assert.throws(() => resolver.prepareConnection(tuple), unavailable);
    }
    f.replace(
      config(
        Array.from({ length: 129 }, (_, index) => ({
          ...entry,
          principalId: `human_${index}`,
        })),
      ),
    );
    assert.throws(() => resolver.prepareConnection(tuple), unavailable);
    assert.equal(reads, 0);
    const valid = JSON.stringify(config());
    writeFileSync(
      f.filename,
      valid + " ".repeat(128 * 1024 - Buffer.byteLength(valid)),
    );
    assert.equal(resolver.prepareConnection(tuple).purpose, "connection-setup");
    assert.equal(reads, 1);
    f.replace(
      config(
        Array.from({ length: 128 }, (_, index) => ({
          ...entry,
          principalId: `human_${index}`,
        })),
      ),
    );
    assert.equal(
      resolver.prepareConnection({ ...tuple, principalId: "human_127" })
        .purpose,
      "connection-setup",
    );
  } finally {
    f.close();
  }
});

test("missing/invalid secrets or callback errors never escape private details", () => {
  const f = fixture();
  try {
    for (const readSecret of [
      () => undefined,
      () => "",
      () => "unsafe\r\nheader",
      () => "x".repeat(4097),
      () => {
        throw new Error(`${fixtureSecret}/${secretName}/${f.filename}`);
      },
    ]) {
      const resolver = new CognitiveAppBindings({
        filename: f.filename,
        readSecret,
      });
      assert.throws(() => resolver.prepareConnection(tuple), unavailable);
      assert.equal(inspect(resolver).includes(f.filename), false);
      assert.equal(JSON.stringify(resolver).includes(f.filename), false);
    }
    const ownedName = `MORPHZ_APP_COGNITIVE_CREDENTIAL_TEST_${randomUUID().replaceAll("-", "").toUpperCase()}`;
    assert.equal(Object.hasOwn(process.env, ownedName), false);
    process.env[ownedName] = fixtureSecret;
    try {
      f.replace(config([{ ...entry, credentialEnv: ownedName }]));
      assert.equal(
        new CognitiveAppBindings({ filename: f.filename }).prepareConnection(
          tuple,
        ).purpose,
        "connection-setup",
      );
    } finally {
      delete process.env[ownedName];
    }
  } finally {
    f.close();
  }
});

test("fd snapshot rejects a wrong owner and an in-place change, without reading secrets", () => {
  const f = fixture();
  const originalFstat = fs.fstatSync,
    originalRead = fs.readSync;
  let reads = 0;
  try {
    const resolver = new CognitiveAppBindings({
      filename: f.filename,
      readSecret: () => {
        reads++;
        return fixtureSecret;
      },
    });
    // Owner failure is an isolated fd-stat seam; no chown or real foreign file is used.
    fs.fstatSync = ((...args: unknown[]) => {
      const value = Reflect.apply(originalFstat, fs, args);
      if (typeof value.uid === "bigint")
        Object.defineProperty(value, "uid", { value: value.uid + 1n });
      return value;
    }) as typeof fs.fstatSync;
    syncBuiltinESMExports();
    assert.throws(() => resolver.prepareConnection(tuple), unavailable);
    assert.equal(reads, 0);
    fs.fstatSync = originalFstat;
    let changed = false;
    fs.readSync = ((...args: unknown[]) => {
      const value = Reflect.apply(originalRead, fs, args);
      if (!changed) {
        changed = true;
        writeFileSync(
          f.filename,
          JSON.stringify(config([entry], "in-place-changed-host")),
        );
      }
      return value;
    }) as typeof fs.readSync;
    syncBuiltinESMExports();
    assert.throws(() => resolver.prepareConnection(tuple), unavailable);
    assert.equal(reads, 0);
  } finally {
    fs.fstatSync = originalFstat;
    fs.readSync = originalRead;
    syncBuiltinESMExports();
    f.close();
  }
});

test("unsupported Windows permission gate is fail-closed, not silently POSIX-bypassed", () => {
  const f = fixture();
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    assert.throws(
      () =>
        new CognitiveAppBindings({
          filename: f.filename,
          readSecret: () => fixtureSecret,
        }).prepareConnection(tuple),
      unavailable,
    );
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    f.close();
  }
});

test("prepared capability snapshots stay pinned across operator route and credential replacement", async () => {
  const seen: { port: number; credential: string | undefined }[] = [];
  const servers = [0, 1].map((index) =>
    createServer((request, response) => {
      seen.push({ port: index, credential: request.headers.authorization });
      response.setHeader("Content-Type", "application/json");
      response.end("{}");
    }),
  );
  const ports: number[] = [];
  for (const server of servers) {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    ports.push((server.address() as { port: number }).port);
  }
  const route = (index: number) => ({
    ...entry,
    baseUrl: `http://127.0.0.1:${ports[index]}`,
    approvedLoopback: { host: "127.0.0.1", port: ports[index] },
  });
  const f = fixture(config([route(0)]));
  let secret = fixtureSecret;
  try {
    const resolver = new CognitiveAppBindings({
      filename: f.filename,
      readSecret: () => secret,
    });
    const setup = resolver.prepareConnection(tuple);
    const pinned = resolver.resolveConnection(tuple, setup.hostBindingId);
    secret = "new-isolated-fixture-secret";
    f.replace(config([route(1)]));
    const next = resolver.prepareConnection(tuple);
    assert.notEqual(next.hostBindingId, pinned.hostBindingId);
    const transport = new CognitiveAppTransport();
    await pinned.invoke(
      transport.tryAcquire("fixture/original-connection")!,
      {},
    );
    await next.describe(transport.tryAcquire("fixture/new-connection")!, {});
    assert.deepEqual(seen, [
      { port: 0, credential: `Bearer ${fixtureSecret}` },
      { port: 1, credential: `Bearer ${secret}` },
    ]);
    assert.throws(
      () => resolver.resolveConnection(tuple, pinned.hostBindingId),
      unavailable,
    );
  } finally {
    f.close();
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
