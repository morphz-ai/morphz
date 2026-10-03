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
import { AppIcon } from "../apps/web/src/ApplicationIcon.js";
import {
  applicationIdentity,
  applicationIdentities,
} from "../apps/web/src/application-identity.js";

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
  assert.equal(
    renderToStaticMarkup(
      createElement(AppIcon, { app: image, presentation: "tile" }),
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
});

test("tiles and compact symbols have matching identities but separate optical art", () => {
  for (const app of [
    browserApplication,
    readerApplication,
    scriptStudioApplication,
  ]) {
    const compact = renderToStaticMarkup(createElement(AppIcon, { app }));
    const tile = renderToStaticMarkup(
      createElement(AppIcon, { app, presentation: "tile" }),
    );
    assert.match(compact, /class="application-symbol"/);
    assert.match(compact, /viewBox="0 0 24 24"/);
    assert.match(tile, /class="application-emblem"/);
    assert.match(tile, /viewBox="0 0 64 64"/);
    assert.match(
      tile,
      new RegExp(`data-application-identity="${applicationIdentity(app)}"`),
    );
    assert.match(tile, /aria-hidden="true" focusable="false"/);
    assert.doesNotMatch(tile, /<title|role="button"|tabindex|<animate/i);
  }
});

test("simultaneous repeated emblems have unique paint servers and valid references", () => {
  const markup = renderToStaticMarkup(
    createElement(
      "div",
      {},
      ...Array.from({ length: 5 }, (_, i) =>
        createElement(AppIcon, {
          key: i,
          app: browserApplication,
          presentation: "tile",
        }),
      ),
    ),
  );
  const ids = [...markup.matchAll(/ id="([^"]+)"/g)].map((x) => x[1]);
  const refs = [...markup.matchAll(/url\(#([^)]+)\)/g)].map((x) => x[1]);
  assert.equal(ids.length, 10);
  assert.equal(new Set(ids).size, ids.length);
  for (const ref of refs) assert.ok(ids.includes(ref));
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
