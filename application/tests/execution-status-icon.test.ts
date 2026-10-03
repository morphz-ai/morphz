import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, transformWithOxc } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "@playwright/test";
import { ExecutionStatusIcon } from "../apps/web/src/ExecutionStatusIcon.js";
import {
  FixedDialogGlyph,
  FixedSidebarGlyph,
  type FixedKind,
} from "./fixtures/execution-status-icon-14ae1de6.js";

const fixtureSource = readFileSync(
  new URL("./fixtures/execution-status-icon-14ae1de6.tsx", import.meta.url),
  "utf8",
);
const kinds: readonly (FixedKind | undefined)[] = [
  "running",
  "waiting",
  "paused",
  "ended",
  "failed",
  "cancelled",
  "unknown",
  undefined,
];
const render = renderToStaticMarkup;

test("fixed 14ae1de6 oracle is the independently verified original maps/ternaries and waveform, not a production import", () => {
  // Recorded only after comparing the original two maps/ternaries and running
  // function AST with git 14ae1de6; no historical checkout is required in CI.
  assert.equal(
    createHash("sha256").update(fixtureSource).digest("hex"),
    "a628267a9b3ea011e7853c98bfbe8d22c1aa5db6ad117a20162d1ca3fd2e8806",
  );
  assert.doesNotMatch(
    fixtureSource,
    /from\s+["'].*(?:ExecutionStatusIcon|RunningActivityIcon|execution-activity)/,
  );
});

test("all seven kinds and undefined keep exact original SVG bytes, with consumer-specific 18/19 static sizes and no wrapper", () => {
  for (const size of [18, 19] as const)
    for (const kind of kinds) {
      const expected =
        size === 18
          ? render(createElement(FixedDialogGlyph, { kind }))
          : render(
              createElement(FixedSidebarGlyph, { kind: kind ?? "unknown" }),
            );
      // Undefined is a real old Dialog fallback. At 19 it is the same old
      // Sidebar unknown glyph; Sidebar itself never supplied undefined.
      const actual = render(createElement(ExecutionStatusIcon, { kind, size }));
      assert.equal(actual, expected, `${kind}/${size}`);
      assert.match(actual, /^<svg\s/);
      assert.equal(actual.match(/<svg\b/g)?.length, 1);
      assert.match(actual, /aria-hidden="true"/);
      assert.match(
        actual,
        new RegExp(
          `width="${kind === "running" ? 24 : size}" height="${kind === "running" ? 24 : size}"`,
        ),
      );
      assert.equal(actual.endsWith("</svg>"), true);
    }
});

test("running retains its exact base/flow paths, independent 24x24 SVG and original accessibility attributes at both static sizes", () => {
  for (const size of [18, 19] as const) {
    const actual = render(
      createElement(ExecutionStatusIcon, { kind: "running", size }),
    );
    assert.equal(actual.match(/<path\b/g)?.length, 2);
    assert.match(
      actual,
      /class="execution-running-signal" width="24" height="24" viewBox="0 0 24 24"/,
    );
    assert.match(
      actual,
      /fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"/,
    );
    assert.match(actual, /class="execution-signal-base"/);
    assert.match(actual, /class="execution-signal-flow"[^>]*pathLength="100"/);
    const paths = [...actual.matchAll(/\bd="([^"]+)"/g)].map(
      (match) => match[1],
    );
    assert.equal(paths.length, 2);
    assert.equal(paths[0], paths[1]);
  }
});

// A real React StrictMode document, not App/Runtime/Client or a user profile.
// Original callsite sizes stay 19/18. The optional size-change adapter clones
// only the old static Icon element's size to challenge the new prop contract.
const mountedSource = `
import React, { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ExecutionStatusIcon } from '/src/ExecutionStatusIcon.tsx';
import { FixedSidebarGlyph, FixedDialogGlyph } from '/__fixed-status-icon.tsx';
const lanes = ['old-side', 'new-side', 'old-dialog', 'new-dialog'], remembered = new Map();
let command, current;
function oldGlyph(kind, size, side) {
  const icon = side ? FixedSidebarGlyph({ kind: kind ?? 'unknown' }) : FixedDialogGlyph({ kind });
  return kind !== 'running' && size !== null ? React.cloneElement(icon, { size }) : icon;
}
function Fixture() {
  const [state, setState] = useState({ kind: 'running', size: null, sequence: 0, mounted: true, title: '原状态标签' });
  current = state;
  command = patch => flushSync(() => setState(s => ({ ...s, ...patch, sequence: s.sequence + 1 })));
  return <main>{state.mounted && lanes.map(lane => <span key={lane} id={lane}
    className={lane.endsWith('side') ? 'execution-activity-icon' : 'execution-thread-state'} data-status={state.kind} title={state.title}>
    {lane.startsWith('old') ? oldGlyph(state.kind, state.size, lane.endsWith('side'))
      : <ExecutionStatusIcon kind={state.kind} size={state.size ?? (lane.endsWith('side') ? 19 : 18)} />}
  </span>)}</main>;
}
Object.assign(window, { statusIconFixture: {
  run(patch) { command(patch); },
  remember() { for (const lane of lanes) { const span = document.getElementById(lane), svg = span.querySelector('svg'); remembered.set(lane, { span, svg, paths: [...svg.querySelectorAll('path')] }); } },
  report() { return { ...current, lanes: lanes.map(lane => {
    const span = document.getElementById(lane), svg = span?.querySelector('svg'), old = remembered.get(lane), paths = [...(svg?.querySelectorAll('path') ?? [])];
    return { lane, html: span?.innerHTML, outerSame: old?.span === span, svgSame: old?.svg === svg,
      pathsSame: old?.paths.map((path, index) => path === paths[index]), oldConnected: old?.span.isConnected ?? false,
      oldSvgConnected: old?.svg.isConnected ?? false, oldPathsConnected: old?.paths.map(path => path.isConnected),
      attributes: span ? [...span.attributes].map(attr => [attr.name, attr.value]) : [] };
  }) }; }
} });
createRoot(document.getElementById('root')).render(<StrictMode><Fixture/></StrictMode>);
`;
type MountedReport = {
  sequence: number;
  lanes: {
    lane: string;
    html?: string;
    outerSame: boolean;
    svgSame: boolean;
    pathsSame?: boolean[];
    oldConnected: boolean;
    oldSvgConnected: boolean;
    oldPathsConnected?: boolean[];
    attributes: string[][];
  }[];
};
const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;

test(
  "StrictMode mounting preserves old/new outer span, SVG/path identity, size/state transitions and unmount cleanup without eager queries",
  {
    timeout: 45000,
    skip:
      !executable && !existsSync(chromium.executablePath())
        ? "No matching Playwright browser"
        : false,
  },
  async (context) => {
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      logLevel: "error",
      plugins: [
        react(),
        {
          name: "execution-status-icon-isolated",
          resolveId(id) {
            if (
              id === "/__status-icons.tsx" ||
              id === "/__fixed-status-icon.tsx"
            )
              return "\0" + id;
          },
          async load(id) {
            if (id === "\0/__status-icons.tsx")
              return transformWithOxc(mountedSource, "status-icons.tsx");
            if (id === "\0/__fixed-status-icon.tsx")
              return transformWithOxc(fixtureSource, "fixed-status-icon.tsx");
          },
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (request.url !== "/__status-icons") return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url,
                  '<!doctype html><html><body><div id="root"></div><script type="module" src="/__status-icons.tsx"></script></body></html>',
                ),
              );
            });
          },
        },
      ],
      server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(".")] } },
    });
    context.after(() => server.close());
    const browser = await chromium.launch({
      headless: true,
      executablePath: executable || undefined,
    });
    context.after(() => browser.close());
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== "string");
    const page = await browser.newPage(),
      errors: string[] = [],
      queries: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (["fetch", "xhr"].includes(request.resourceType()))
        queries.push(request.url());
    });
    await page.goto(`http://127.0.0.1:${address.port}/__status-icons`);
    await page.waitForSelector("#new-side svg");
    const report = () =>
      page.evaluate(() =>
        Reflect.get(window, "statusIconFixture").report(),
      ) as Promise<MountedReport>;
    const remember = () =>
      page.evaluate(() => Reflect.get(window, "statusIconFixture").remember());
    const update = async (patch: {
      kind?: FixedKind;
      clearKind?: boolean;
      size?: 18 | 19 | null;
      mounted?: boolean;
      title?: string;
    }) => {
      const previous = (await report()).sequence;
      await page.evaluate((value) => {
        const { clearKind, ...next } = value;
        if (clearKind) Reflect.set(next, "kind", undefined);
        Reflect.get(window, "statusIconFixture").run(next);
      }, patch);
      await page.waitForFunction(
        (sequence) =>
          Reflect.get(window, "statusIconFixture").report().sequence > sequence,
        previous,
      );
      return report();
    };
    const parity = (value: MountedReport) => {
      assert.equal(value.lanes[1]!.html, value.lanes[0]!.html);
      assert.equal(value.lanes[3]!.html, value.lanes[2]!.html);
      for (const [oldIndex, newIndex] of [
        [0, 1],
        [2, 3],
      ]) {
        const old = value.lanes[oldIndex!]!,
          next = value.lanes[newIndex!]!;
        assert.equal(next.outerSame, old.outerSame);
        assert.equal(next.svgSame, old.svgSame);
        assert.deepEqual(next.pathsSame, old.pathsSame);
        assert.deepEqual(
          next.attributes.filter(([name]) => name !== "id"),
          old.attributes.filter(([name]) => name !== "id"),
        );
      }
    };
    parity(await report());
    await remember();
    let value = await update({ title: "与图形无关的标签重绘" });
    parity(value);
    assert.equal(
      value.lanes.every(
        (lane) =>
          lane.outerSame && lane.svgSame && lane.pathsSame?.every(Boolean),
      ),
      true,
    );
    for (const size of [18, 19] as const) {
      value = await update({ size });
      parity(value);
      assert.equal(
        value.lanes.every(
          (lane) => lane.svgSame && lane.html?.includes('width="24"'),
        ),
        true,
      );
    }
    for (const kind of [
      "waiting",
      "paused",
      "ended",
      "failed",
      "cancelled",
      "unknown",
    ] as const) {
      await remember();
      value = await update({ kind, size: null });
      parity(value);
      assert.equal(
        value.lanes.every((lane) => lane.outerSame),
        true,
      );
      assert.equal(
        value.lanes.every((lane) => !lane.svgSame),
        true,
        `${kind} must change the old/new glyph constructor identically`,
      );
      await remember();
      value = await update({ kind });
      parity(value);
      assert.equal(
        value.lanes.every(
          (lane) => lane.svgSame && lane.pathsSame?.every(Boolean),
        ),
        true,
      );
      for (const size of [18, 19] as const) {
        value = await update({ size });
        parity(value);
        assert.equal(
          value.lanes.every(
            (lane) => lane.svgSame && lane.html?.includes(`width="${size}"`),
          ),
          true,
        );
      }
    }
    await remember();
    value = await update({ clearKind: true, size: null });
    parity(value);
    assert.equal(
      value.lanes.every((lane) => lane.svgSame),
      true,
      "undefined keeps the existing CircleHelp SVG, not a new wrapper",
    );
    await remember();
    value = await update({ kind: "running" });
    parity(value);
    assert.equal(
      value.lanes.every((lane) => lane.outerSame && !lane.svgSame),
      true,
    );
    await remember();
    value = await update({ mounted: false });
    parity(value);
    assert.equal(
      value.lanes.every(
        (lane) =>
          !lane.oldConnected &&
          !lane.oldSvgConnected &&
          lane.oldPathsConnected?.every((connected) => !connected),
      ),
      true,
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(queries, []);
  },
);
