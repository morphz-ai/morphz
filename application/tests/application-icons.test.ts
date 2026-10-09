import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  browserApplication,
  readerApplication,
  scriptStudioApplication,
  objectsApplication,
} from "../packages/core/src/applications.js";
import {
  AppIcon,
  ApplicationLauncherIcon,
} from "../apps/web/src/ApplicationIcon.js";
import {
  applicationIdentity,
  applicationIdentities,
} from "../apps/web/src/application-identity.js";

const builtins = [
  browserApplication,
  readerApplication,
  scriptStudioApplication,
];

function artworkWithoutInstanceIds(markup: string) {
  const ids = [...markup.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]!);
  return ids.reduce<string>(
    (result, id, index) => result.replaceAll(id, `paint-${index}`),
    markup,
  );
}

test("bundled applications have separate identities independent of host accents", () => {
  assert.equal(applicationIdentity(browserApplication), "browser");
  assert.equal(applicationIdentity(readerApplication), "reader");
  assert.equal(applicationIdentity(scriptStudioApplication), "studio");
  assert.equal(applicationIdentity(objectsApplication), undefined);
  assert.equal(
    new Set(Object.values(applicationIdentities).map((x) => x.field.join()))
      .size,
    3,
  );
});

test("identity cannot replace author images or sandbox applications", () => {
  const image = {
    ...readerApplication,
    iconImage: "data:image/png;base64,AA==",
  };
  assert.equal(applicationIdentity(image), undefined);
  for (const presentation of ["tile", "symbol"] as const)
    assert.equal(
      renderToStaticMarkup(
        createElement(AppIcon, { app: image, presentation }),
      ),
      '<img src="data:image/png;base64,AA==" alt=""/>',
    );
  assert.equal(
    applicationIdentity({
      ...readerApplication,
      ui: { type: "sandbox", html: "<p>author</p>" },
    }),
    undefined,
  );
  assert.equal(
    applicationIdentity({
      ...readerApplication,
      ui: { type: "builtin", view: "browser" },
    }),
    undefined,
  );
  const sandbox = renderToStaticMarkup(
    createElement(AppIcon, {
      app: {
        ...readerApplication,
        ui: { type: "sandbox", html: "<p>author</p>" },
      },
      presentation: "tile",
    }),
  );
  assert.match(sandbox, /lucide-book-open/);
  assert.doesNotMatch(sandbox, /application-emblem|linearGradient/);
});

test("all presentations scale the exact same colored image, geometry and paint", () => {
  for (const app of builtins) {
    const compact = renderToStaticMarkup(createElement(AppIcon, { app }));
    const symbol = renderToStaticMarkup(
      createElement(AppIcon, { app, presentation: "symbol" }),
    );
    const tile = renderToStaticMarkup(
      createElement(AppIcon, { app, presentation: "tile" }),
    );
    assert.equal(
      artworkWithoutInstanceIds(compact),
      artworkWithoutInstanceIds(tile),
    );
    assert.equal(
      artworkWithoutInstanceIds(symbol),
      artworkWithoutInstanceIds(tile),
    );
    assert.match(tile, /class="application-emblem"/);
    assert.match(tile, /viewBox="0 0 64 64"/);
    assert.match(tile, /fill="none" stroke="none" stroke-width="0"/);
    assert.match(
      tile,
      new RegExp(`data-application-identity="${applicationIdentity(app)}"`),
    );
    assert.match(tile, /aria-hidden="true" focusable="false"/);
    assert.doesNotMatch(
      tile,
      /application-symbol|<title|role="button"|tabindex|<animate|<text|<filter/i,
    );
    // Surface CSS alone owns physical size, including the 22px Dock image.
    assert.doesNotMatch(
      tile.match(/<svg\b[^>]*>/)?.[0] ?? "",
      /\s(?:width|height|style)=/,
    );
  }
});

test("Script Studio uses a screenplay manuscript, not a video clapperboard", () => {
  const markup = renderToStaticMarkup(
    createElement(AppIcon, { app: scriptStudioApplication }),
  );
  assert.match(markup, /data-application-identity="studio"/);
  // The page silhouette and four coarse typesetting marks remain readable when
  // the very same image is scaled down. These are artwork regression guards,
  // not a substitute for reviewing its actual 16px/22px rendering.
  assert.match(markup, /<rect x="13" y="15" width="32" height="39" rx="3.5"/);
  assert.match(
    markup,
    /<path d="M22 10h18l10 10v28a3 3 0 0 1-3 3H22a3 3 0 0 1-3-3V13a3 3 0 0 1 3-3Z"/,
  );
  for (const line of [
    'x="25" y="24" width="18" height="3"',
    'x="25" y="30" width="18" height="2.5"',
    'x="31" y="38" width="9" height="2.5"',
    'x="28" y="44" width="15" height="2.5"',
  ])
    assert.ok(markup.includes(line));
  assert.doesNotMatch(markup, /transform=|lucide-film|<text|<image/);
});

test("simultaneous repeated emblems have unique paint servers and valid references", () => {
  const markup = renderToStaticMarkup(
    createElement(
      "div",
      {},
      ...builtins.flatMap((app) =>
        Array.from({ length: 4 }, (_, i) =>
          createElement(AppIcon, {
            key: `${app.id}-${i}`,
            app,
            presentation: i % 2 === 0 ? "tile" : "symbol",
          }),
        ),
      ),
    ),
  );
  const ids = [...markup.matchAll(/ id="([^"]+)"/g)].map((x) => x[1]);
  const refs = [...markup.matchAll(/url\(#([^)]+)\)/g)].map((x) => x[1]);
  assert.equal(ids.length, 12);
  assert.equal(refs.length, ids.length);
  assert.equal(new Set(ids).size, ids.length);
  for (const ref of refs) assert.ok(ids.includes(ref));
});

test("bundled images use fresh independent fields and simple opaque foregrounds", () => {
  const fields = {
    browser: ["#268bff", "#1655dd"],
    reader: ["#ffab45", "#f9792d"],
    studio: ["#a06cff", "#7050e8"],
  };
  const shapes = new Set<string>();
  for (const app of builtins) {
    const identity = applicationIdentity(app)!;
    const palette = applicationIdentities[identity];
    assert.deepEqual(palette.field, fields[identity]);
    assert.equal(palette.foreground[0], "#ffffff");
    const markup = renderToStaticMarkup(createElement(AppIcon, { app }));
    for (const color of [...palette.field, ...palette.foreground])
      assert.ok(markup.includes(color));
    assert.doesNotMatch(markup, /opacity|stroke-linecap|stroke-linejoin/);
    assert.doesNotMatch(
      markup,
      /#(?:b67336|b87942|b77942|bb7641|fff8e7|ffedc5)/,
    );
    shapes.add(
      [...markup.matchAll(/<(?:path|circle|rect)\b[^>]*>/g)]
        .map((match) => match[0].replace(/fill="[^"]*"/g, ""))
        .join(),
    );
  }
  assert.equal(shapes.size, 3);
});

test("unknown application keeps its existing semantic symbol", () => {
  const app = { ...readerApplication, id: "author.another-reader" };
  const markup = renderToStaticMarkup(
    createElement(AppIcon, { app, presentation: "tile" }),
  );
  assert.match(markup, /lucide-book-open/);
  assert.doesNotMatch(
    markup,
    /application-emblem|application-symbol|linearGradient/,
  );
});

test("launcher has its own collection symbol without impersonating app identity", () => {
  const markup = renderToStaticMarkup(createElement(ApplicationLauncherIcon));
  assert.match(markup, /class="application-launcher-symbol"/);
  assert.match(markup, /viewBox="0 0 24 24"/);
  assert.match(markup, /aria-hidden="true" focusable="false"/);
  assert.match(markup, /fill="none" stroke="none"/);
  assert.ok(markup.includes(applicationIdentities.browser.field[0]));
  assert.ok(markup.includes(applicationIdentities.studio.field[1]));
  assert.match(markup, /<rect width="24" height="24" rx="6"/);
  assert.equal([...markup.matchAll(/<rect /g)].length, 1);
  assert.equal([...markup.matchAll(/<circle /g)].length, 9);
  for (const cy of [7, 12, 17])
    for (const cx of [7, 12, 17])
      assert.match(
        markup,
        new RegExp(`<circle cx="${cx}" cy="${cy}" r="1.3" fill="#ffffff"`),
      );
  assert.doesNotMatch(
    markup,
    /currentColor|accent|light-dark|transform=|<filter/i,
  );
  assert.doesNotMatch(markup, /application-emblem|data-application-identity/);
  assert.doesNotMatch(markup, /<title|role="button"|tabindex|<animate/i);
});

test("repeated launchers own their paint IDs without colliding with app images", () => {
  const markup = renderToStaticMarkup(
    createElement(
      "div",
      {},
      ...Array.from({ length: 4 }, (_, index) =>
        createElement(ApplicationLauncherIcon, { key: `launcher-${index}` }),
      ),
      ...builtins.map((app) => createElement(AppIcon, { key: app.id, app })),
      createElement(AppIcon, {
        key: objectsApplication.id,
        app: objectsApplication,
      }),
    ),
  );
  const ids = [...markup.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, 7);
  assert.equal(new Set(ids).size, ids.length);
  for (const svg of markup.matchAll(/<svg\b[^>]*>[\s\S]*?<\/svg>/g)) {
    const localIds = [...svg[0].matchAll(/ id="([^"]+)"/g)].map(
      (match) => match[1],
    );
    const refs = [...svg[0].matchAll(/url\(#([^)]+)\)/g)].map(
      (match) => match[1],
    );
    for (const ref of refs) assert.ok(localIds.includes(ref));
    if (svg[0].includes('class="application-launcher-symbol"')) {
      assert.equal(refs.length, 1);
      assert.doesNotMatch(svg[0], /data-application-identity/);
    } else if (svg[0].includes('class="application-emblem"')) {
      assert.equal(refs.length, 1);
      assert.doesNotMatch(svg[0], /data-launcher-module/);
    }
  }
  assert.match(markup, /lucide-layers/);
});
