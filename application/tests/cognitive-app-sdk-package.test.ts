import test from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, relative } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const packageRoot = fileURLToPath(
  new URL("../packages/cognitive-app-sdk/", import.meta.url),
);
const execute = promisify(execFile);
test("experimental author package declares only pure public ESM and portable types", () => {
  const pkg = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  );
  assert.equal(pkg.name, "@morphz/cognitive-app-sdk");
  assert.equal(pkg.version, "0.3.0");
  assert.equal(
    pkg.private,
    true,
    "packing is allowed, accidental publishing is not",
  );
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "Apache-2.0");
  assert.deepEqual(pkg.dependencies, { zod: "4.5.4" });
  assert.deepEqual(pkg.devDependencies, { typescript: "7.0.2" });
  assert.deepEqual(Object.keys(pkg.exports).sort(), [
    ".",
    "./browser",
    "./domain-wire",
    "./protocol",
  ]);
  assert.deepEqual(pkg.files, [
    "dist/*.js",
    "dist/*.d.ts",
    "README.md",
    "LICENSE",
  ]);
  assert.equal(
    readFileSync(join(packageRoot, "LICENSE"), "utf8"),
    readFileSync(new URL("../../LICENSE", import.meta.url), "utf8"),
  );
});

test(
  "real offline tarball independently builds, installs, imports and typechecks outside the repository",
  { timeout: 180_000 },
  async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "morphz-cognitive-sdk-package-"),
    );
    const author = join(directory, "author"),
      consumer = join(directory, "consumer");
    const userConfig = join(directory, "empty-user.npmrc"),
      globalConfig = join(directory, "empty-global.npmrc");
    writeFileSync(userConfig, "");
    writeFileSync(globalConfig, "");
    // Pass only nonsecret execution necessities. npm must not read real user/project
    // config or inherit Runtime/Host/database/cloud credentials or NODE_OPTIONS.
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "HOME", "TMPDIR", "SYSTEMROOT"])
      if (process.env[key] !== undefined) env[key] = process.env[key];
    Object.assign(env, {
      npm_config_cache: join(homedir(), ".npm"),
      npm_config_userconfig: userConfig,
      npm_config_globalconfig: globalConfig,
      npm_config_registry: "https://registry.npmjs.org/",
      npm_config_offline: "true",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    });
    async function child(
      phase: string,
      command: string,
      args: string[],
      cwd: string,
    ) {
      try {
        return await execute(command, args, {
          cwd,
          env,
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        });
      } catch (error) {
        const failure = error as {
          code?: unknown;
          stdout?: string;
          stderr?: string;
        };
        const missingCache = failure.stderr?.includes("ENOTCACHED");
        const missingGlobals = [
          ...(failure.stdout ?? "").matchAll(
            /Cannot find name '([A-Za-z0-9_]+)'/g,
          ),
        ].map((match) => match[1]);
        throw new Error(
          `Independent SDK ${phase} failed${missingCache ? ": required public dependency is absent from the offline cache" : ` (exit ${String(failure.code ?? "unknown")}${missingGlobals.length ? `; missing standard globals: ${[...new Set(missingGlobals)].join(",")}` : ""})`}.`,
        );
      }
    }
    async function npm(phase: string, args: string[], cwd: string) {
      return child(phase, "npm", args, cwd);
    }
    const installArgs = [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
    ];
    try {
      assert.ok(relative(packageRoot, directory).startsWith(".."));
      mkdirSync(join(author, "src"), { recursive: true });
      mkdirSync(consumer);
      for (const filename of [
        "package.json",
        "tsconfig.build.json",
        "README.md",
        "LICENSE",
        "src/index.ts",
        "src/protocol.ts",
        "src/domain-wire.ts",
        "src/browser.ts",
        "src/browser-wire.ts",
      ])
        copyFileSync(join(packageRoot, filename), join(author, filename));
      await npm("author dependency installation", installArgs, author);
      // No prepared dist is copied from the workspace: prepack must genuinely build it.
      const packed = await npm(
        "author prepack/build",
        ["pack", "--offline", "--json", "--silent"],
        author,
      );
      const report = JSON.parse(packed.stdout) as {
        filename: string;
        files: { path: string }[];
        integrity: string;
        size: number;
      }[];
      assert.equal(report.length, 1);
      const archive = report[0]!;
      assert.equal(archive.filename, "morphz-cognitive-app-sdk-0.3.0.tgz");
      const expectedFiles = [
        "LICENSE",
        "README.md",
        "package.json",
        ...[
          "index",
          "protocol",
          "domain-wire",
          "browser",
          "browser-wire",
        ].flatMap((name) => [`dist/${name}.js`, `dist/${name}.d.ts`]),
      ].sort();
      assert.deepEqual(
        archive.files.map(({ path }) => path).sort(),
        expectedFiles,
      );
      assert.ok(archive.size > 0 && archive.integrity.startsWith("sha512-"));
      for (const filename of expectedFiles.filter((name) =>
        name.startsWith("dist/"),
      )) {
        const source = readFileSync(join(author, filename), "utf8");
        const imports = [
          ...source.matchAll(
            /\b(?:import|export)\s+(?:(?:[^;]*?)\s+from\s+)?["']([^"']+)["']/g,
          ),
        ].map((match) => match[1]!);
        assert.ok(
          imports.every(
            (name) =>
              name === "zod" ||
              /^\.\/(?:protocol|domain-wire|browser-wire)\.js$/.test(name),
          ),
        );
        assert.doesNotMatch(source, /\b(?:import|require)\s*\(/);
        assert.doesNotMatch(
          source,
          /\b(?:process|Buffer|XMLHttpRequest|WebSocket)\b|\b(?:fetch|setInterval)\s*\(/,
        );
        if (!/^dist\/browser\./.test(filename))
          assert.doesNotMatch(source, /\bsetTimeout\s*\(/);
        assert.doesNotMatch(
          source,
          /sourceMappingURL|node:|Host_private|MORPHZ_APP_|credentials|\.env/,
        );
      }
      writeFileSync(
        join(consumer, "package.json"),
        JSON.stringify({
          name: "isolated-author-consumer",
          private: true,
          type: "module",
          devDependencies: { typescript: "7.0.2" },
        }),
      );
      await npm(
        "consumer tarball installation",
        [...installArgs, join(author, archive.filename)],
        consumer,
      );
      const installed = join(
        consumer,
        "node_modules",
        "@morphz",
        "cognitive-app-sdk",
      );
      assert.equal(isAbsolute(installed), true);
      assert.ok(relative(packageRoot, installed).startsWith(".."));
      assert.deepEqual(
        JSON.parse(readFileSync(join(installed, "package.json"), "utf8"))
          .dependencies,
        { zod: "4.5.4" },
      );
      assert.equal(
        readFileSync(join(installed, "LICENSE"), "utf8"),
        readFileSync(new URL("../../LICENSE", import.meta.url), "utf8"),
      );
      for (const filename of expectedFiles.filter((name) =>
        name.startsWith("dist/"),
      ))
        assert.deepEqual(
          readFileSync(join(installed, filename)),
          readFileSync(join(author, filename)),
          "import/declaration purity checks must describe the actual installed tarball bytes",
        );
      const graph = JSON.parse(
        (
          await npm(
            "runtime dependency graph",
            ["ls", "--omit=dev", "--json", "--all"],
            consumer,
          )
        ).stdout,
      );
      assert.deepEqual(Object.keys(graph.dependencies), [
        "@morphz/cognitive-app-sdk",
      ]);
      assert.equal(
        graph.dependencies["@morphz/cognitive-app-sdk"].version,
        "0.3.0",
      );
      assert.deepEqual(
        Object.keys(
          graph.dependencies["@morphz/cognitive-app-sdk"].dependencies,
        ),
        ["zod"],
      );
      assert.equal(
        graph.dependencies["@morphz/cognitive-app-sdk"].dependencies.zod
          .version,
        "4.5.4",
      );
      assert.deepEqual(
        graph.dependencies["@morphz/cognitive-app-sdk"].dependencies.zod
          .dependencies ?? {},
        {},
      );
      const client = `
import { parseCognitiveAppDefinition, parseInvokeRequest, parseInvokeResponse, parsePortableText, type CognitiveAppDefinition, type DomainInvokeRequest, type DomainReadResult, type DomainDescribeRequest, type JsonValue } from "@morphz/cognitive-app-sdk";
import { parseOperationResources } from "@morphz/cognitive-app-sdk/protocol";
import { canonicalInvokeIdentityBytes, parseDescribeRequest } from "@morphz/cognitive-app-sdk/domain-wire";
import { connectMorphz, parseBrowserContext, parseBrowserNavigationState, type CognitiveBrowserClient, type BrowserNavigationState } from "@morphz/cognitive-app-sdk/browser";
const browserFactory: () => Promise<CognitiveBrowserClient> = connectMorphz;
const contextParser: typeof parseBrowserContext = parseBrowserContext;
if (typeof browserFactory !== "function" || typeof contextParser !== "function") throw new Error("browser subentry unavailable");
const navigationInput = {object:{objectId:"opaque/original 😀",versionRef:"opaque:exact"},view:"reader"};
const navigation: BrowserNavigationState = parseBrowserNavigationState(navigationInput);
navigationInput.object.versionRef="later caller mutation";
if(navigation.object!.versionRef!=="opaque:exact")throw new Error("navigation did not capture its own snapshot");
for(const value of [{body:"not navigation"},{draft:"not navigation"},{unknown:true},{object:{objectId:"original",versionRef:1}}]){let rejected=false;try{parseBrowserNavigationState(value);}catch{rejected=true;}if(!rejected)throw new Error("navigation accepted undeclared business state or numeric version");}
const definition: CognitiveAppDefinition = parseCognitiveAppDefinition({ format: "morphz-cognitive-app/v1", protocol: "morphz-domain/v1", id: "example.notes", version: "1.0.0", title: "Notes", description: "Independent author", icon: "document", harness: null, ui: null, operations: [{ id: "notes.read", title: "Read", description: "Read original", effect: "read", scope: "objects", inputSchema: { type: "null" }, outputSchema: { type: "string" } }] });
const describe: DomainDescribeRequest = parseDescribeRequest({ protocol: "morphz-domain/v1", definition: { appId: definition.id, version: definition.version, definitionHash: "a".repeat(64) } });
const authority = { ...describe.definition, instanceId: "instance", serviceId: "author/service", dataAuthorityId: "author/original" };
const operation = definition.operations[0]!;
const request: DomainInvokeRequest = parseInvokeRequest({ protocol: "morphz-domain/v1", delegation: { issuer: "host", expiresAt: "2026-10-05T10:00:00Z", purpose: "invoke", authority, actor: { kind: "human", tenantId: "tenant", principalId: "person", actantId: "human", source: { kind: "human" } }, projectId: "project", operationId: operation.id, resources: [{ objectId: "original", versionRef: "exact" }], command: null }, parameters: null }, operation.effect, operation.scope);
const result: DomainReadResult = parseInvokeResponse({ protocol: "morphz-domain/v1", authority, operationId: operation.id, result: "Original" }, "read", { authority, operationId: operation.id });
const value: JsonValue = result.result;
if (value !== "Original" || parsePortableText("中文\\n😀") !== "中文\\n😀") throw new Error("exact consumer data failed");
if (parseOperationResources(operation.scope, request.delegation.resources)[0]!.objectId !== "original") throw new Error("opaque references failed");
if (canonicalInvokeIdentityBytes(request, "read", operation.scope).byteLength < 1) throw new Error("identity bytes failed");
export { definition, describe, request, result, value };
`;
      writeFileSync(join(consumer, "consumer.ts"), client);
      writeFileSync(
        join(consumer, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            lib: ["ES2023", "DOM"],
            strict: true,
            skipLibCheck: false,
            noUncheckedIndexedAccess: true,
            noUnusedLocals: true,
            noUnusedParameters: true,
            verbatimModuleSyntax: true,
            types: [],
            outDir: "compiled",
            noEmitOnError: true,
          },
          include: ["consumer.ts"],
        }),
      );
      await child(
        "strict declaration consumption",
        process.execPath,
        [
          join(consumer, "node_modules", "typescript", "bin", "tsc"),
          "-p",
          "tsconfig.json",
        ],
        consumer,
      );
      await child(
        "real Node execution",
        process.execPath,
        [join(consumer, "compiled", "consumer.js")],
        consumer,
      );
      writeFileSync(
        join(consumer, "invalid.ts"),
        `import type { DomainDescribeRequest, DomainInvokeRequest } from "@morphz/cognitive-app-sdk"; import type { CognitiveBrowserClient, BrowserNavigationState } from "@morphz/cognitive-app-sdk/browser"; const a: DomainDescribeRequest = { protocol: "morphz-domain/v1", definition: { appId: "example.notes", version: "1.0.0", definitionHash: "a".repeat(64) }, endpoint: "https://not-authority.example" }; const b: DomainInvokeRequest["delegation"]["actor"] = { kind: "human", tenantId: "tenant", principalId: "person", actantId: "human", source: { kind: "input", inputId: "input", humanActantId: "human" } }; const c:BrowserNavigationState={view:"reader",body:"not navigation"}; function bad(client:CognitiveBrowserClient) { return client.invoke({operationId:"notes.read",parameters:null,resources:[],commandId:null,actor:"forged"}); } export { a, b, c, bad };`,
      );
      writeFileSync(
        join(consumer, "tsconfig.invalid.json"),
        JSON.stringify({
          extends: "./tsconfig.json",
          compilerOptions: { noEmit: true },
          include: ["invalid.ts"],
        }),
      );
      const invalid = await execute(
        process.execPath,
        [
          join(consumer, "node_modules", "typescript", "bin", "tsc"),
          "-p",
          "tsconfig.invalid.json",
        ],
        { cwd: consumer, env, timeout: 60_000, maxBuffer: 1024 * 1024 },
      ).then(
        () => null,
        (error: { code?: number; stdout?: string; stderr?: string }) => error,
      );
      assert.ok(
        invalid,
        "real compiled declarations must reject unsupported fields/source combinations",
      );
      const diagnostics = `${invalid.stdout ?? ""}${invalid.stderr ?? ""}`;
      assert.match(diagnostics, /endpoint/);
      assert.match(diagnostics, /input/);
      assert.match(diagnostics, /actor/);
      assert.match(diagnostics, /body/);
      const consumerModule = join(consumer, "runtime.mjs");
      writeFileSync(
        consumerModule,
        `import * as sdk from "@morphz/cognitive-app-sdk"; import * as protocol from "@morphz/cognitive-app-sdk/protocol"; import * as wire from "@morphz/cognitive-app-sdk/domain-wire"; import * as browser from "@morphz/cognitive-app-sdk/browser"; if (sdk.parsePortableText !== protocol.parsePortableText || sdk.parseDomainReceipt !== wire.parseDomainReceipt || typeof browser.connectMorphz !== "function" || "connectMorphz" in sdk) throw new Error("entry mismatch"); await browser.connectMorphz().then(()=>{throw Error("Node acquired a browser channel")},error=>{if(error.code!=="unsupported")throw error;}); for (const name of ["CognitiveAppBindings", "CognitiveAppTransport", "PlatformStore", "createApp", "fetch", "BrowserBridge"]) if (name in sdk || name in browser) throw new Error("private implementation exported"); try { await import("@morphz/cognitive-app-sdk/src/protocol.js"); throw new Error("source subpath exposed"); } catch (error) { if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error; } console.log(JSON.stringify({ sdk: true, exports: Object.keys(sdk).sort() }));`,
      );
      const runtime = JSON.parse(
        (
          await child(
            "public export isolation",
            process.execPath,
            [consumerModule],
            consumer,
          )
        ).stdout,
      );
      assert.equal(runtime.sdk, true);
      console.log(
        `[independent SDK package] ${JSON.stringify({ name: "@morphz/cognitive-app-sdk", version: "0.3.0", runtimeDependency: "zod@4.5.4", packedFiles: expectedFiles, tarballIntegrity: archive.integrity, bytes: archive.size, strictConsumer: true, invalidConsumerRejected: true, realNodeImports: [".", "./protocol", "./domain-wire", "./browser"], offline: true })}`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
