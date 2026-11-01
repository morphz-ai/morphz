import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const { prepareApplicationModules } = createRequire(import.meta.url)(
  "../apps/desktop/startup-modules.cjs",
);

test("desktop code imports start together before native readiness, without opening a data owner", async () => {
  const calls: string[] = [];
  const releases: Array<(value: object) => void> = [];
  const pending = prepareApplicationModules((path: string) => {
    calls.push(path);
    return new Promise((resolve) => {
      releases.push(resolve);
    });
  });
  assert.deepEqual(calls, [
    "../../dist/service/packages/application/src/paths.js",
    "../../dist/service/apps/desktop/application-host.js",
  ]);
  const paths = {
    dataDirectory: () => assert.fail("imports must not call dataDirectory"),
  };
  const host = {
    openEmbeddedApplication: () => assert.fail("imports must not open a host"),
  };
  releases[0]!(paths);
  releases[1]!(host);
  assert.deepEqual(await pending, { modules: [paths, host] });
});

for (const synchronous of [false, true])
  test(`desktop ${synchronous ? "synchronous" : "asynchronous"} code-load failure waits for the ready error boundary without an unhandled rejection`, async () => {
    const error = new Error("owned startup import failure");
    const pending = prepareApplicationModules(() => {
      if (synchronous) throw error;
      return Promise.reject(error);
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(await pending, { error });
  });

test("only the winning desktop instance starts code preparation; activation consumes the original promise", () => {
  const main = readFileSync(
    new URL("../apps/desktop/main.cjs", import.meta.url),
    "utf8",
  );
  const lock = main.indexOf("if (!app.requestSingleInstanceLock())");
  const preparation = main.indexOf(
    "const startupModules = prepareApplicationModules();",
  );
  const ready = main.indexOf(".whenReady()");
  const consume = main.indexOf("const prepared = await startupModules;");
  assert.ok(
    lock >= 0 && preparation > lock && ready > preparation && consume > ready,
  );
  assert.equal(main.match(/\bprepareApplicationModules\(\)/g)?.length, 1);
  assert.match(
    main.slice(consume),
    /if \("error" in prepared\) throw prepared\.error;/,
  );
});
