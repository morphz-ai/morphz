// Immutable finite tuples independently captured from actual Git c525d217.
// Whole-current-source hashes are not a CI contract; historical provenance only.
export const fixedDialogFrame = {
  baseline: "c525d217deafe2bc125b15186cf056edfd2e4037",
  sourceProvenance: {
    "styles.css": {
      sha256:
        "5386fe4aec87b0eedb3b7f8a14b91f9abe55e94da0140dce313d9cedf678c64d",
      bytes: 62282,
    },
    "ui.css": {
      sha256:
        "8e78a362355bacd725382f5049e51434f2dff163bd4ce06c2a488d44aa21cfe2",
      bytes: 72975,
    },
    "workflow.css": {
      sha256:
        "c6583708d8073574fb67fc8efd7e1e0b12f141a57a3b8abf97580c997bfe14c6",
      bytes: 23446,
    },
    "visual-system.css": {
      sha256:
        "12c83da8d2969f24f2fbe647b067469350d8ee5290c6d929899d0c31eef822f6",
      bytes: 31407,
    },
    "main.tsx": {
      sha256:
        "e462f0dcee45d208e50903935446785839e024b30602256436e04ce1a36b1d1c",
      bytes: 736,
    },
  },
  selected: [
    {
      source: "styles.css",
      line: 1903,
      ordinal: 336,
      role: "common-frame-or-controls",
      selector: ".create-dialog",
      context: [],
      declarations: [
        {
          prop: "padding",
          value: "24px 28px",
          important: false,
        },
        {
          prop: "width",
          value: "min(590px, calc(100% - 32px))",
          important: false,
        },
        {
          prop: "max-height",
          value: "calc(100dvh - 48px)",
          important: false,
        },
      ],
    },
    {
      source: "styles.css",
      line: 1909,
      ordinal: 337,
      role: "common-frame-or-controls",
      selector: ".create-dialog header",
      context: [],
      declarations: [
        {
          prop: "display",
          value: "flex",
          important: false,
        },
        {
          prop: "justify-content",
          value: "space-between",
          important: false,
        },
        {
          prop: "align-items",
          value: "center",
          important: false,
        },
        {
          prop: "margin-bottom",
          value: "22px",
          important: false,
        },
      ],
    },
    {
      source: "styles.css",
      line: 1915,
      ordinal: 338,
      role: "common-frame-or-controls",
      selector: ".create-dialog h2",
      context: [],
      declarations: [
        {
          prop: "font-size",
          value: "18px",
          important: false,
        },
      ],
    },
    {
      source: "styles.css",
      line: 1918,
      ordinal: 339,
      role: "common-frame-or-controls",
      selector: ".create-dialog footer",
      context: [],
      declarations: [
        {
          prop: "display",
          value: "flex",
          important: false,
        },
        {
          prop: "justify-content",
          value: "flex-end",
          important: false,
        },
        {
          prop: "gap",
          value: "8px",
          important: false,
        },
        {
          prop: "margin-top",
          value: "24px",
          important: false,
        },
        {
          prop: "padding-top",
          value: "18px",
          important: false,
        },
        {
          prop: "border-top",
          value: "1px solid var(--hairline)",
          important: false,
        },
      ],
    },
    {
      source: "styles.css",
      line: 2223,
      ordinal: 415,
      role: "common-frame-or-controls",
      selector: ".create-dialog",
      context: ["@media (max-width: 560px)"],
      declarations: [
        {
          prop: "padding",
          value: "20px",
          important: false,
        },
      ],
    },
    {
      source: "styles.css",
      line: 2226,
      ordinal: 416,
      role: "common-frame-or-controls",
      selector:
        ".create-dialog input,\n  .create-dialog textarea,\n  .create-dialog select",
      context: ["@media (max-width: 560px)"],
      declarations: [
        {
          prop: "font-size",
          value: "16px",
          important: false,
        },
      ],
    },
    {
      source: "styles.css",
      line: 2252,
      ordinal: 420,
      role: "required-same-specificity-cascade-carrier",
      selector: ".library-dialog > header,\n.library-dialog > footer",
      context: [],
      declarations: [
        {
          prop: "display",
          value: "flex",
          important: false,
        },
        {
          prop: "align-items",
          value: "center",
          important: false,
        },
        {
          prop: "justify-content",
          value: "space-between",
          important: false,
        },
        {
          prop: "gap",
          value: "16px",
          important: false,
        },
      ],
    },
    {
      source: "styles.css",
      line: 3264,
      ordinal: 617,
      role: "required-same-specificity-cascade-carrier",
      selector: ".application-install > header,\n.application-install > footer",
      context: [],
      declarations: [
        {
          prop: "display",
          value: "flex",
          important: false,
        },
        {
          prop: "align-items",
          value: "center",
          important: false,
        },
        {
          prop: "justify-content",
          value: "space-between",
          important: false,
        },
        {
          prop: "gap",
          value: "14px",
          important: false,
        },
      ],
    },
    {
      source: "ui.css",
      line: 1971,
      ordinal: 353,
      role: "required-same-specificity-cascade-carrier",
      selector: ".connection-dialog",
      context: [],
      declarations: [
        {
          prop: "inset",
          value: "0 0 0 var(--workspace-offset, 0px)",
          important: false,
        },
        {
          prop: "margin",
          value: "auto",
          important: false,
        },
        {
          prop: "width",
          value:
            "min(460px, calc(100vw - var(--workspace-offset, 0px) - 32px))",
          important: false,
        },
      ],
    },
    {
      source: "ui.css",
      line: 2118,
      ordinal: 382,
      role: "common-frame-or-controls",
      selector: ".create-dialog",
      context: [],
      declarations: [
        {
          prop: "width",
          value: "min(var(--ui-dialog-width, 460px), calc(100vw - 40px))",
          important: false,
        },
        {
          prop: "max-height",
          value: "var(--modal-max-height, calc(100dvh - 32px))",
          important: false,
        },
        {
          prop: "padding",
          value: "4px 12px 12px",
          important: false,
        },
        {
          prop: "overflow",
          value: "auto",
          important: false,
        },
      ],
    },
    {
      source: "ui.css",
      line: 2127,
      ordinal: 383,
      role: "common-frame-or-controls",
      selector:
        '.app\n  .create-dialog\n  :where(\n    input:not(\n      [type="checkbox"],\n      [type="radio"],\n      [type="range"],\n      [type="file"],\n      [type="color"],\n      [type="hidden"],\n      [type="button"],\n      [type="submit"],\n      [type="reset"],\n      [type="image"]\n    ),\n    select:not([multiple], [size]),\n    textarea\n  )',
      context: [],
      declarations: [
        {
          prop: "min-width",
          value: "0",
          important: false,
        },
        {
          prop: "padding",
          value: "5px 8px",
          important: false,
        },
        {
          prop: "border-radius",
          value: "var(--ui-radius-control)",
          important: false,
        },
        {
          prop: "font-size",
          value: "var(--ui-dialog-control-font-size)",
          important: false,
        },
        {
          prop: "line-height",
          value: "20px",
          important: false,
        },
      ],
    },
    {
      source: "ui.css",
      line: 2151,
      ordinal: 384,
      role: "common-frame-or-controls",
      selector:
        '.app\n  .create-dialog\n  :where(\n    input:not(\n      [type="checkbox"],\n      [type="radio"],\n      [type="range"],\n      [type="file"],\n      [type="color"],\n      [type="hidden"],\n      [type="button"],\n      [type="submit"],\n      [type="reset"],\n      [type="image"]\n    ),\n    select:not([multiple], [size])\n  )',
      context: [],
      declarations: [
        {
          prop: "height",
          value: "var(--ui-dialog-control-height)",
          important: false,
        },
      ],
    },
    {
      source: "ui.css",
      line: 2170,
      ordinal: 385,
      role: "common-frame-or-controls",
      selector:
        '.app\n  .create-dialog\n  :where(\n    input:not(\n      [type="checkbox"],\n      [type="radio"],\n      [type="range"],\n      [type="file"],\n      [type="color"],\n      [type="hidden"],\n      [type="button"],\n      [type="submit"],\n      [type="reset"],\n      [type="image"]\n    ),\n    select,\n    textarea\n  ):focus',
      context: [],
      declarations: [
        {
          prop: "border-color",
          value: "var(--accent-strong)",
          important: false,
        },
        {
          prop: "outline",
          value: "2px solid var(--accent-strong)",
          important: false,
        },
        {
          prop: "outline-offset",
          value: "-2px",
          important: false,
        },
        {
          prop: "box-shadow",
          value: "none",
          important: false,
        },
      ],
    },
    {
      source: "ui.css",
      line: 2195,
      ordinal: 386,
      role: "common-frame-or-controls",
      selector:
        ".app\n  .create-dialog\n  :is(\n    .primary,\n    .secondary-action:not(.model-service-button),\n    footer > button,\n    .dialog-actions > button:not(.icon-button),\n    .bookmark-edit-actions > button\n  )",
      context: [],
      declarations: [
        {
          prop: "min-height",
          value: "var(--ui-dialog-control-height)",
          important: false,
        },
        {
          prop: "padding",
          value: "5px 12px",
          important: false,
        },
        {
          prop: "border-radius",
          value: "var(--ui-radius-control)",
          important: false,
        },
        {
          prop: "font-size",
          value: "var(--ui-dialog-control-font-size)",
          important: false,
        },
        {
          prop: "line-height",
          value: "20px",
          important: false,
        },
        {
          prop: "justify-content",
          value: "center",
          important: false,
        },
      ],
    },
    {
      source: "ui.css",
      line: 2212,
      ordinal: 387,
      role: "common-frame-or-controls",
      selector: ".app .create-dialog .primary",
      context: [],
      declarations: [
        {
          prop: "border",
          value: "1px solid transparent",
          important: false,
        },
      ],
    },
    {
      source: "ui.css",
      line: 2215,
      ordinal: 388,
      role: "common-frame-or-controls",
      selector: ".app .create-dialog .field",
      context: [],
      declarations: [
        {
          prop: "gap",
          value: "4px",
          important: false,
        },
      ],
    },
    {
      source: "ui.css",
      line: 2220,
      ordinal: 389,
      role: "common-frame-or-controls",
      selector: ".create-dialog .dialog-input-row",
      context: [],
      declarations: [
        {
          prop: "display",
          value: "flex",
          important: false,
        },
        {
          prop: "align-items",
          value: "center",
          important: false,
        },
        {
          prop: "flex-wrap",
          value: "wrap",
          important: false,
        },
        {
          prop: "gap",
          value: "8px",
          important: false,
        },
        {
          prop: "min-width",
          value: "0",
          important: false,
        },
      ],
    },
    {
      source: "ui.css",
      line: 2227,
      ordinal: 390,
      role: "common-frame-or-controls",
      selector: ".create-dialog .dialog-input-row > input",
      context: [],
      declarations: [
        {
          prop: "flex",
          value: "1 1 100px",
          important: false,
        },
        {
          prop: "min-width",
          value: "0",
          important: false,
        },
      ],
    },
    {
      source: "ui.css",
      line: 2231,
      ordinal: 391,
      role: "common-frame-or-controls",
      selector: ".create-dialog .dialog-input-row > :is(button, footer)",
      context: [],
      declarations: [
        {
          prop: "flex-shrink",
          value: "0",
          important: false,
        },
        {
          prop: "margin-left",
          value: "auto",
          important: false,
        },
      ],
    },
    {
      source: "ui.css",
      line: 2235,
      ordinal: 392,
      role: "common-frame-or-controls",
      selector: ".create-dialog .dialog-input-row > footer",
      context: [],
      declarations: [
        {
          prop: "align-items",
          value: "center",
          important: false,
        },
        {
          prop: "margin-block",
          value: "0",
          important: false,
        },
        {
          prop: "padding",
          value: "0",
          important: false,
        },
        {
          prop: "border",
          value: "0",
          important: false,
        },
        {
          prop: "background",
          value: "var(--surface-dialog)",
          important: false,
        },
      ],
    },
    {
      source: "ui.css",
      line: 2243,
      ordinal: 393,
      role: "common-frame-or-controls",
      selector: ".create-dialog",
      context: ["@media (pointer: coarse)"],
      declarations: [
        {
          prop: "--ui-dialog-control-height",
          value: "44px",
          important: false,
        },
        {
          prop: "--ui-dialog-control-font-size",
          value: "16px",
          important: false,
        },
      ],
    },
    {
      source: "ui.css",
      line: 2470,
      ordinal: 434,
      role: "common-frame-or-controls",
      selector:
        ".create-dialog > header,\n.create-dialog > form > header,\n.document-draft header",
      context: [],
      declarations: [
        {
          prop: "display",
          value: "flex",
          important: false,
        },
        {
          prop: "align-items",
          value: "center",
          important: false,
        },
        {
          prop: "justify-content",
          value: "space-between",
          important: false,
        },
        {
          prop: "gap",
          value: "8px",
          important: false,
        },
        {
          prop: "min-height",
          value: "var(--ui-dialog-heading-height)",
          important: false,
        },
        {
          prop: "padding",
          value: "0",
          important: false,
        },
        {
          prop: "margin",
          value: "0 0 4px",
          important: false,
        },
      ],
    },
    {
      source: "ui.css",
      line: 2481,
      ordinal: 435,
      role: "common-frame-or-controls",
      selector: ".create-dialog > header > div",
      context: [],
      declarations: [
        {
          prop: "display",
          value: "flex",
          important: false,
        },
        {
          prop: "align-items",
          value: "baseline",
          important: false,
        },
        {
          prop: "min-width",
          value: "0",
          important: false,
        },
        {
          prop: "gap",
          value: "8px",
          important: false,
        },
      ],
    },
    {
      source: "ui.css",
      line: 2487,
      ordinal: 436,
      role: "common-frame-or-controls",
      selector: ".create-dialog > header > .dialog-actions",
      context: [],
      declarations: [
        {
          prop: "align-items",
          value: "center",
          important: false,
        },
        {
          prop: "flex-shrink",
          value: "0",
          important: false,
        },
        {
          prop: "gap",
          value: "4px",
          important: false,
        },
      ],
    },
    {
      source: "ui.css",
      line: 2492,
      ordinal: 437,
      role: "common-frame-or-controls",
      selector: ".create-dialog > header > :first-child",
      context: [],
      declarations: [
        {
          prop: "min-width",
          value: "0",
          important: false,
        },
      ],
    },
    {
      source: "ui.css",
      line: 2495,
      ordinal: 438,
      role: "common-frame-or-controls",
      selector: ".create-dialog > header p,\n.create-dialog > header small",
      context: [],
      declarations: [
        {
          prop: "margin",
          value: "0",
          important: false,
        },
        {
          prop: "font-size",
          value: "12px",
          important: false,
        },
        {
          prop: "min-width",
          value: "0",
          important: false,
        },
        {
          prop: "overflow",
          value: "hidden",
          important: false,
        },
        {
          prop: "text-overflow",
          value: "ellipsis",
          important: false,
        },
        {
          prop: "white-space",
          value: "nowrap",
          important: false,
        },
      ],
    },
    {
      source: "ui.css",
      line: 2504,
      ordinal: 439,
      role: "common-frame-or-controls",
      selector:
        ".create-dialog > header > button,\n.create-dialog > form > header > button,\n.document-draft header > button",
      context: [],
      declarations: [
        {
          prop: "width",
          value: "32px",
          important: false,
        },
        {
          prop: "height",
          value: "32px",
          important: false,
        },
        {
          prop: "flex-shrink",
          value: "0",
          important: false,
        },
        {
          prop: "padding",
          value: "8px",
          important: false,
        },
        {
          prop: "justify-content",
          value: "center",
          important: false,
        },
      ],
    },
    {
      source: "ui.css",
      line: 2513,
      ordinal: 440,
      role: "common-frame-or-controls",
      selector:
        ".create-dialog > header h2,\n.create-dialog > form > header h2,\n.document-draft header h2",
      context: [],
      declarations: [
        {
          prop: "font-size",
          value: "var(--ui-dialog-heading-size)",
          important: false,
        },
        {
          prop: "line-height",
          value: "1.4",
          important: false,
        },
        {
          prop: "margin",
          value: "0",
          important: false,
        },
        {
          prop: "flex-shrink",
          value: "0",
          important: false,
        },
      ],
    },
    {
      source: "ui.css",
      line: 2521,
      ordinal: 441,
      role: "common-frame-or-controls",
      selector: ".create-dialog > footer,\n.create-dialog > form > footer",
      context: [],
      declarations: [
        {
          prop: "align-items",
          value: "center",
          important: false,
        },
        {
          prop: "flex-wrap",
          value: "wrap",
          important: false,
        },
        {
          prop: "margin-top",
          value: "12px",
          important: false,
        },
        {
          prop: "padding-top",
          value: "0",
          important: false,
        },
        {
          prop: "border-top",
          value: "0",
          important: false,
        },
      ],
    },
    {
      source: "workflow.css",
      line: 558,
      ordinal: 110,
      role: "common-frame-or-controls",
      selector: ".app .create-dialog:not(.search-dialog)",
      context: [],
      declarations: [
        {
          prop: "position",
          value: "fixed",
          important: false,
        },
        {
          prop: "left",
          value: "var(--modal-center, 50vw)",
          important: false,
        },
        {
          prop: "right",
          value: "auto",
          important: false,
        },
        {
          prop: "margin-left",
          value: "0",
          important: false,
        },
        {
          prop: "margin-right",
          value: "0",
          important: false,
        },
        {
          prop: "transform",
          value: "translateX(-50%)",
          important: false,
        },
        {
          prop: "max-width",
          value:
            "min(\n    var(--modal-max-width, calc(100vw - 32px)),\n    calc(100vw - 32px)\n  )",
          important: false,
        },
      ],
    },
  ],
  neighbors: [
    {
      source: "visual-system.css",
      selector:
        ".app .secondary-action,\n.app .create-dialog > footer > button:not(.primary),\n.app .create-dialog > form > footer > button:not(.primary),\n.app .search-dialog > footer > button,\n.app .editor-actions > button:not(.primary)",
      context: [],
      declarations: [
        {
          prop: "min-height",
          value: "28px",
          important: false,
        },
        {
          prop: "padding",
          value: "4px 9px",
          important: false,
        },
        {
          prop: "border",
          value: "1px solid var(--control-border)",
          important: false,
        },
        {
          prop: "border-radius",
          value: "6px",
          important: false,
        },
        {
          prop: "font-size",
          value: "12px",
          important: false,
        },
        {
          prop: "line-height",
          value: "18px",
          important: false,
        },
      ],
    },
    {
      source: "visual-system.css",
      selector:
        ".app .secondary-action:hover:not(:disabled),\n.app .create-dialog > footer > button:not(.primary):hover:not(:disabled),\n.app .create-dialog > form > footer > button:not(.primary):hover:not(:disabled),\n.app .search-dialog > footer > button:hover:not(:disabled),\n.app .editor-actions > button:not(.primary):hover:not(:disabled)",
      context: [],
      declarations: [
        {
          prop: "border-color",
          value: "var(--muted)",
          important: false,
        },
      ],
    },
  ],
  mainCss: [
    "./styles.css",
    "./ui.css",
    "./ui/popup-surface.css",
    "./workflow.css",
    "./ui/dialog-surface.css",
    "./visual-system.css",
    "./exchange-layout.css",
    "./inspector.css",
    "./task-list.css",
    "./content-catalog.css",
    "./browser-bookmarks.css",
    "./text-quotes.css",
    "./profile-avatar.css",
    "./personality-profile.css",
    "./execution-activity.css",
    "./execution-thread-groups.css",
    "./application-icons.css",
  ],
  proof: {
    actualGit: true,
    auditManifestRevalidated: true,
    rules30: true,
    declarations107: true,
    carriers3: true,
  },
} as const;
