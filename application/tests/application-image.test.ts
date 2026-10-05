import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApplicationImage, AppIcon } from "../apps/web/src/ApplicationIcon.js";
import { readerApplication } from "../packages/core/src/applications.js";

test("author application images require only declared visual metadata", () => {
  const app = {
    icon: "book" as const,
    iconImage: "data:image/png;base64,AA==",
  };
  assert.equal(
    renderToStaticMarkup(createElement(ApplicationImage, { app })),
    '<img src="data:image/png;base64,AA==" alt=""/>',
  );
  assert.equal(
    renderToStaticMarkup(
      createElement(ApplicationImage, { app, identity: "reader" }),
    ),
    '<img src="data:image/png;base64,AA==" alt=""/>',
  );
});

test("author fallback never assumes a bundled identity or UI-only manifest", () => {
  const markup = renderToStaticMarkup(
    createElement(ApplicationImage, { app: { icon: "book" } }),
  );
  assert.match(markup, /lucide-book-open/);
  assert.doesNotMatch(
    markup,
    /application-emblem|data-application-identity|linearGradient/,
  );
  assert.equal(
    markup,
    renderToStaticMarkup(
      createElement(AppIcon, {
        app: {
          ...readerApplication,
          ui: { type: "sandbox", html: "<p>author</p>" },
        },
      }),
    ),
  );
});
