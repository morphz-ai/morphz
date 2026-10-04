import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  FileText,
  BookOpen,
  Image,
  CircleCheck,
  Globe,
  Table2,
} from "lucide-react";
import react from "@vitejs/plugin-react";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { initialWorkspace } from "../packages/core/src/model.js";
import { ObjectIcon, kindLabel } from "../apps/web/src/ui/ObjectIcon.js";
import {
  ObjectIcon as OriginalIcon,
  kindLabel as originalLabels,
} from "./fixtures/object-icon-f937e4b0.js";

const kinds = [
  "document",
  "image",
  "task",
  "pdf",
  "publication",
  "website",
  "interactive",
] as const;
const glyphs = {
  document: FileText,
  image: Image,
  task: CircleCheck,
  pdf: FileText,
  publication: BookOpen,
  website: Globe,
  interactive: Table2,
};
const migration =
  process.env.MORPHZ_TEST_OBJECT_ICON_MIGRATION_EQUIVALENCE === "1";
test("shared seven object meanings, original SVG output and same-binding compatibility", async () => {
  assert.deepEqual(kindLabel, {
    document: "文档",
    image: "图片",
    task: "事项",
    pdf: "PDF",
    publication: "读物",
    website: "网页链接",
    interactive: "表格",
  });
  assert.equal(
    Reflect.get(kindLabel, "unknown"),
    undefined,
    "unknown label remains absent; callers own fallback",
  );
  const current = kinds.map((kind) => ({
    kind,
    label: kindLabel[kind],
    svg: renderToStaticMarkup(React.createElement(ObjectIcon, { kind })),
  }));
  for (const record of current)
    assert.equal(
      record.svg,
      renderToStaticMarkup(
        React.createElement(glyphs[record.kind], { size: 16 }),
      ),
    );
  if (migration)
    assert.deepEqual(
      current,
      kinds.map((kind) => ({
        kind,
        label: originalLabels[kind],
        svg: renderToStaticMarkup(React.createElement(OriginalIcon, { kind })),
      })),
      "complete independent original pure declaration observation",
    );
  // Match real schema initialization and read actual CSS, without executing CSS
  // as JavaScript or changing any production import for this identity check.
  void initialWorkspace;
  const styles = registerHooks({
    load(url, context, next) {
      if (url.startsWith("file:") && new URL(url).pathname.endsWith(".css")) {
        readFileSync(new URL(url), "utf8");
        return { format: "module", source: "export {};", shortCircuit: true };
      }
      return next(url, context);
    },
  });
  try {
    const compatibility = await import("../apps/web/src/ArtifactEditor.js");
    assert.equal(compatibility.ObjectIcon, ObjectIcon);
    assert.equal(compatibility.kindLabel, kindLabel);
  } finally {
    styles.deregister();
  }
});

type Observation = {
  appearance: string;
  accent: string;
  width: number;
  icons: {
    kind: string;
    surface: string;
    svg: string;
    rect: { x: number; y: number; width: number; height: number };
    color: string;
    cssWidth: string;
    cssHeight: string;
    stroke: string;
    strokeWidth: string;
    animation: string;
    transition: string;
  }[];
};
// Complete actual primitive, original current CSS graph and representative
// original caller containers. Not five mounted pages, native App or OS proof.
test(
  "actual shared SVG geometry, foreground and motion in original themes and compact styles",
  { timeout: 30000 },
  async (context) => {
    const executable = process.env.MORPHZ_TEST_BROWSER_EXECUTABLE;
    assert.ok(
      existsSync(executable || chromium.executablePath()),
      "npm test prepares installed browser",
    );
    const cache = await mkdtemp(resolve(tmpdir(), "morphz-object-icon-vite-"));
    context.after(() => rm(cache, { recursive: true, force: true }));
    const css = [
      ...readFileSync("apps/web/src/main.tsx", "utf8").matchAll(
        /import\s+["'](\.\/[^"']+\.css)["'];/g,
      ),
    ]
      .map((match) => `import ${JSON.stringify("/src/" + match[1]!.slice(2))};`)
      .join("\n");
    const originalPath =
      "/@fs" + resolve("tests/fixtures/object-icon-f937e4b0.tsx");
    const entry = `${css}
import React from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
import{ObjectIcon as CurrentIcon,kindLabel as CurrentLabels}from'/src/ui/ObjectIcon.tsx';
const original=new URLSearchParams(location.search).get('lane')==='original';
const{ObjectIcon,kindLabel}=original?await import(${JSON.stringify(originalPath)}):{ObjectIcon:CurrentIcon,kindLabel:CurrentLabels};
const h=React.createElement,kinds=${JSON.stringify(kinds)},surfaces=['eyebrow','card','delivery','recent','search'];
function Frame(){return h('div',{className:'app','data-appearance':'light','data-accent':'cyan'},h('main',{className:'library-collection'},...kinds.flatMap(kind=>surfaces.map(surface=>{
 const props={'data-kind':kind,'data-surface':surface,key:kind+'-'+surface};const icon=h(ObjectIcon,{kind}),label=h('span',null,kindLabel[kind]);
 if(surface==='eyebrow')return h('article',{...props,className:'object-paper'},h('div',{className:'eyebrow'},icon,label));
 if(surface==='card')return h('article',{...props,className:'artifact-card'},h('div',{className:'artifact-card-heading'},icon,h('h2',null,kindLabel[kind])));
 if(surface==='delivery')return h('button',{...props,className:'delivery-object'},icon,label);
 if(surface==='recent')return h('ul',{...props,className:'workspace-recent'},h('li',null,h('button',null,icon,label)));
 return h('div',{...props,className:'workspace-search-results'},h('article',null,h('button',{className:'search-result-open'},icon,label)));
}))));}
const root=createRoot(document.getElementById('root'));flushSync(()=>root.render(h(React.StrictMode,null,h(Frame))));
window.objectIconFixture={configure:(appearance,accent)=>{document.documentElement.dataset.appearance=appearance;const app=document.querySelector('.app');app.dataset.appearance=appearance;app.dataset.accent=accent;},
 inspect:()=>Array.from(document.querySelectorAll('[data-kind]')).map(container=>{const svg=container.querySelector('svg'),rect=svg.getBoundingClientRect(),style=getComputedStyle(svg);return{kind:container.dataset.kind,surface:container.dataset.surface,svg:svg.outerHTML,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},color:style.color,cssWidth:style.width,cssHeight:style.height,stroke:style.stroke,strokeWidth:style.strokeWidth,animation:style.animation,transition:style.transition};}),
 cleanup:()=>{flushSync(()=>root.unmount());return document.querySelectorAll('svg').length;}};`;
    const server = await createServer({
      configFile: false,
      root: resolve("apps/web"),
      cacheDir: cache,
      plugins: [
        react(),
        {
          name: "object-icon-style-contract",
          resolveId(id) {
            if (id === "/__icon_entry.js") return "\0icon-entry";
          },
          load(id) {
            if (id === "\0icon-entry") return entry;
          },
          configureServer(vite) {
            vite.middlewares.use(async (request, response, next) => {
              if (!request.url?.startsWith("/__icon?")) return next();
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  request.url,
                  '<!doctype html><html><head><link rel="icon" href="data:,"><style>.app{display:block;width:100%;height:auto;padding:16px}.library-collection{display:grid;gap:8px}</style></head><body><div id="root"></div><script type="module" src="/__icon_entry.js"></script></body></html>',
                ),
              );
            });
          },
        },
      ],
      server: {
        host: "127.0.0.1",
        port: 0,
        hmr: false,
        fs: { allow: [resolve(".")] },
      },
      logLevel: "error",
    });
    context.after(() => server.close());
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== "string");
    const browser = await chromium.launch({
      headless: true,
      executablePath: executable || undefined,
    });
    context.after(() => browser.close());
    const errors: string[] = [],
      unexpected: string[] = [],
      ledgers: Record<string, Observation[]> = {};
    for (const lane of migration ? ["current", "original"] : ["current"]) {
      const page = await browser.newPage({
        viewport: { width: 1024, height: 900 },
      });
      page.setDefaultTimeout(4000);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (
          !request.url().startsWith(`http://127.0.0.1:${address.port}/`) &&
          !request.url().startsWith("data:")
        )
          unexpected.push(request.url());
      });
      try {
        await page.goto(`http://127.0.0.1:${address.port}/__icon?lane=${lane}`);
        await page.waitForFunction(
          () => !!Reflect.get(window, "objectIconFixture"),
        );
        const records: Observation[] = [];
        for (const appearance of ["light", "dark"])
          for (const accent of ["cyan", "mono"])
            for (const width of [1024, 480]) {
              await page.setViewportSize({ width, height: 900 });
              await page.evaluate(
                ({ appearance, accent }) =>
                  Reflect.get(window, "objectIconFixture").configure(
                    appearance,
                    accent,
                  ),
                { appearance, accent },
              );
              await page.evaluate(
                () =>
                  new Promise<void>((resolve) =>
                    requestAnimationFrame(() =>
                      requestAnimationFrame(() => resolve()),
                    ),
                  ),
              );
              const icons = (await page.evaluate(() =>
                Reflect.get(window, "objectIconFixture").inspect(),
              )) as Observation["icons"];
              assert.equal(icons.length, 35);
              assert.equal(new Set(icons.map((item) => item.kind)).size, 7);
              for (const icon of icons) {
                // Original object-paper hides its eyebrow; its SVG CSS size
                // is still14, while the primitive attribute remains16. Other
                // visible callers preserve their actual16/18 CSS geometry.
                const size =
                  icon.surface === "eyebrow"
                    ? 0
                    : icon.surface === "delivery"
                      ? 18
                      : 16;
                assert.equal(
                  icon.rect.width,
                  size,
                  `${icon.surface} actual CSS width`,
                );
                assert.equal(
                  icon.rect.height,
                  size,
                  `${icon.surface} actual CSS height`,
                );
                const cssSize = icon.surface === "eyebrow" ? 14 : size;
                assert.equal(icon.cssWidth, cssSize + "px");
                assert.equal(icon.cssHeight, cssSize + "px");
                assert.match(icon.svg, /width="16" height="16"/);
                assert.match(icon.color, /^rgb/);
                assert.equal(
                  icon.stroke,
                  icon.color,
                  "currentColor remains real inherited foreground",
                );
                assert.equal(icon.strokeWidth, "1.65px");
                assert.match(icon.svg, /stroke="currentColor"/);
              }
              records.push({ appearance, accent, width, icons });
            }
        ledgers[lane] = records;
        const light = records.find(
          (record) =>
            record.appearance === "light" &&
            record.accent === "cyan" &&
            record.width === 1024,
        )!;
        const dark = records.find(
          (record) =>
            record.appearance === "dark" &&
            record.accent === "cyan" &&
            record.width === 1024,
        )!;
        assert.notEqual(
          light.icons[0]!.color,
          dark.icons[0]!.color,
          "actual inherited foreground responds to original appearance",
        );
        assert.equal(
          await page.evaluate(() =>
            Reflect.get(window, "objectIconFixture").cleanup(),
          ),
          0,
        );
      } finally {
        await page.close();
      }
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, [], "no business or external requests");
    if (migration)
      assert.deepEqual(
        ledgers.current,
        ledgers.original,
        "complete SVG/geometry/style records, no DOM or color normalization",
      );
    if (process.env.MORPHZ_TEST_OBJECT_ICON_EVIDENCE)
      await writeFile(
        process.env.MORPHZ_TEST_OBJECT_ICON_EVIDENCE,
        JSON.stringify(ledgers, null, 2) + "\n",
      );
    context.diagnostic(
      JSON.stringify({
        lanes: Object.keys(ledgers),
        cellsPerLane: ledgers.current!.length,
        iconsPerCell: 35,
        sha256: createHash("sha256")
          .update(JSON.stringify(ledgers))
          .digest("hex"),
        businessRequests: unexpected.length,
        cleanup: true,
      }),
    );
  },
);
