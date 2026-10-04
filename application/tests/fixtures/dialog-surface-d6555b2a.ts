// Independently captured from actual Git d6555b2a before the surface migration.
// Source ordinals are audit metadata; signatures keep selector/context/decl order.
export type FrozenDialogRule = readonly [
  file: string,
  ordinal: number,
  selector: string,
  context: readonly string[],
  declarations: readonly (readonly [
    property: string,
    value: string,
    important: boolean,
  ])[],
];

export const selectedDialogSurfaceRules = [
  [
    "styles.css",
    335,
    ".create-dialog",
    [],
    [
      ["background", "var(--paper)", false],
      ["border", "1px solid var(--line)", false],
      ["border-radius", "15px", false],
      ["box-shadow", "0 18px 70px var(--shadow)", false],
    ],
  ],
  [
    "styles.css",
    336,
    ".create-dialog::backdrop",
    [],
    [["background", "light-dark(#161a2548, #0009)", false]],
  ],
  ["ui.css", 380, ".app dialog", [], [["background", "var(--paper)", false]]],
  [
    "ui.css",
    381,
    ".create-dialog",
    [],
    [["border-radius", "var(--ui-radius-panel)", false]],
  ],
  [
    "ui.css",
    469,
    ".search-dialog",
    [],
    [
      ["border", "1px solid var(--line)", false],
      ["border-radius", "var(--ui-radius-panel)", false],
      [
        "box-shadow",
        "0 16px 48px light-dark(#0000001a, #00000050),\n    0 2px 8px var(--shadow)",
        false,
      ],
    ],
  ],
  [
    "ui.css",
    471,
    ".search-dialog::backdrop",
    [],
    [["background", "light-dark(#0003, #0007)", false]],
  ],
  [
    "visual-system.css",
    140,
    ".app :is(.create-dialog,.search-dialog,.attachment-preview-dialog)",
    [],
    [
      ["background", "var(--surface-dialog)", false],
      ["border-color", "var(--line)", false],
      ["border-radius", "14px", false],
      ["box-shadow", "var(--elevation-modal)", false],
      ["-webkit-backdrop-filter", "var(--popup-blur)", false],
      ["backdrop-filter", "var(--popup-blur)", false],
    ],
  ],
  [
    "visual-system.css",
    141,
    ".app dialog::backdrop",
    [],
    [["background", "var(--popup-backdrop)", false]],
  ],
] as const satisfies readonly FrozenDialogRule[];

export const mixedDialogSurvivors = [
  [
    "styles.css",
    335,
    ".create-dialog",
    [],
    [
      ["color", "var(--ink)", false],
      ["padding", "24px 28px", false],
      ["width", "min(590px, calc(100% - 32px))", false],
      ["max-height", "calc(100dvh - 48px)", false],
    ],
  ],
  ["ui.css", 380, ".app dialog", [], [["color", "var(--ink)", false]]],
  [
    "ui.css",
    381,
    ".create-dialog",
    [],
    [
      [
        "width",
        "min(var(--ui-dialog-width, 460px), calc(100vw - 40px))",
        false,
      ],
      ["max-height", "var(--modal-max-height, calc(100dvh - 32px))", false],
      ["padding", "4px 12px 12px", false],
      ["overflow", "auto", false],
    ],
  ],
  [
    "ui.css",
    469,
    ".search-dialog",
    [],
    [
      ["position", "fixed", false],
      ["inset", "14dvh 0 auto var(--workspace-offset, 0px)", false],
      ["margin", "0 auto", false],
      ["padding", "0", false],
      [
        "width",
        "min(640px, calc(100vw - var(--workspace-offset, 0px) - 40px))",
        false,
      ],
      ["max-height", "min(65dvh, 660px)", false],
      ["overflow", "hidden", false],
    ],
  ],
] as const satisfies readonly FrozenDialogRule[];

export const retainedDialogRules = [
  [
    "visual-system.css",
    139,
    ".app :is( .create-dialog,.search-dialog,.attachment-preview-dialog,.composer-options,.theme-menu,.workspace-options-menu ),.selection-actions",
    [],
    [
      ["--soft", "light-dark(#f7f7f7, #303030)", false],
      ["--hover", "light-dark(#f0f0f0, #373737)", false],
      ["--ink", "light-dark(#202020, #f4f4f4)", false],
      ["--text-secondary", "light-dark(#4b4b4b, #c8c8c8)", false],
      ["--muted", "light-dark(#626262, #b0b0b0)", false],
      ["--selection", "light-dark(#f0f0f0, #3a3a3a)", false],
      ["--surface-raised", "light-dark(#ffffff, #303030)", false],
      ["--control-fill", "light-dark(#ffffff, #333333)", false],
      ["--control-border", "var(--popup-control-border)", false],
      ["--line", "var(--popup-line)", false],
      ["--hairline", "var(--popup-hairline)", false],
      ["color", "var(--ink)", false],
    ],
  ],
  [
    "workflow.css",
    215,
    '.capture-dialog[data-capturing="true"]::backdrop',
    [],
    [
      ["visibility", "hidden", false],
      ["background", "transparent", false],
      ["backdrop-filter", "none", false],
    ],
  ],
] as const satisfies readonly FrozenDialogRule[];

export const retainedDialogTokens = [
  ["ui.css", 0, ":root", [], [["--ui-radius-panel", "12px", false]]],
  [
    "visual-system.css",
    0,
    ".app,.startup,.connection-screen,.selection-actions",
    [],
    [
      ["--popup-solid", "light-dark(#ffffff, #272727)", false],
      ["--surface-dialog", "light-dark(#fffffffa, #272727fa)", false],
      ["--popup-blur", "blur(20px)", false],
      ["--popup-line", "light-dark(#dcdcdc, #454545)", false],
      ["--popup-backdrop", "light-dark(#0000001f, #00000040)", false],
      [
        "--elevation-modal",
        "0 18px 48px light-dark(#00000020, #00000048),\n    0 2px 8px light-dark(#0000000c, #00000030)",
        false,
      ],
    ],
  ],
  [
    "visual-system.css",
    147,
    ".app.application-browser-workspace,:root:has(.application-browser-workspace) .selection-actions",
    [],
    [
      ["--surface-dialog", "var(--popup-solid)", false],
      ["--popup-blur", "none", false],
    ],
  ],
  [
    "visual-system.css",
    184,
    ".app,.selection-actions",
    ["@media (prefers-reduced-transparency: reduce)"],
    [
      ["--surface-dialog", "var(--popup-solid)", false],
      ["--popup-blur", "none", false],
    ],
  ],
  [
    "visual-system.css",
    185,
    ".app,.selection-actions",
    ["@media (prefers-contrast: more)"],
    [
      ["--surface-dialog", "var(--popup-solid)", false],
      ["--popup-blur", "none", false],
      ["--popup-line", "light-dark(#898989, #989898)", false],
    ],
  ],
  [
    "visual-system.css",
    186,
    ':root:is([data-reduced-transparency="true"],[data-native-contrast="more"]) :is(.app,.selection-actions)',
    [],
    [
      ["--surface-dialog", "var(--popup-solid)", false],
      ["--popup-blur", "none", false],
    ],
  ],
  [
    "visual-system.css",
    187,
    ':root[data-native-contrast="more"] :is(.app,.selection-actions)',
    [],
    [["--popup-line", "light-dark(#898989, #989898)", false]],
  ],
] as const satisfies readonly FrozenDialogRule[];

export const originalDialogSourceHashes = {
  "styles.css":
    "6f5aa5c6314dbc9a2218ee412a5ff9030f7c2f492f60177e174f617204c3f6d3",
  "ui.css": "b93c4ea647d1172d92a3447e7ceac708a8e7031ac9b2079385ed353868de007b",
  "visual-system.css":
    "614e7c5052a3039b4000b1c59aa5a90a9bcf0b4dba49441dcc426c3e826570e6",
  "workflow.css":
    "2f80005921c8f7597076e7df896c142990ef2b8bc0226aaa36a3da94c453d501",
} as const;
