// Independently captured from actual Git 9708abbde92a1efe813863bca281e29884d14bf1.
// Ordinals and source hashes are provenance, not CI-wide file locks.
export type FrozenPopupRule = readonly [
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

export const popupBaselineGit = "9708abbde92a1efe813863bca281e29884d14bf1";
export const popupSourceProvenance = [
  {
    file: "application-dock.css",
    bytes: 7338,
    sha256: "623c02b254b8eb39d1a74571757984e67f6b8a867ff410aa1d9327848ed8c31b",
  },
  {
    file: "styles.css",
    bytes: 62407,
    sha256: "b7a078ef887801cb6883c6fc7177a5657ec11bd3c018e89e4480409d369770b8",
  },
  {
    file: "ui.css",
    bytes: 73248,
    sha256: "badea6bec8c1e7386983040b915d78fd9c00c5b8366676b43a168f4079baba50",
  },
  {
    file: "workflow.css",
    bytes: 23585,
    sha256: "2f80005921c8f7597076e7df896c142990ef2b8bc0226aaa36a3da94c453d501",
  },
  {
    file: "visual-system.css",
    bytes: 31886,
    sha256: "f9f6e069ba5cf4c944e14da724c76606a1b647b3aa3a407933dd56fc1e3d59c7",
  },
  {
    file: "main.tsx",
    bytes: 703,
    sha256: "e6c85a40ffa6adbf8ee9b5f541a04dd47d3ac01659bbea30b5876eb61743bbc3",
  },
  {
    file: "ComposerOptions.tsx",
    bytes: 10362,
    sha256: "6ac8cf52dbfe9455ca462bee85d8f49107631e0f6ced7c5b8e95cee67627bd74",
  },
  {
    file: "SelectionActions.tsx",
    bytes: 2589,
    sha256: "0f6db55a54229fb196d7c70824aaf06170d775223b6a980d4e244438792f2096",
  },
] as const;

export const selectedPopupSurfaceRules = [
  [
    "application-dock.css",
    24,
    ".app .composer-options.application-dock-menu",
    [],
    [["border-radius", "20px", false]],
  ],
  [
    "styles.css",
    322,
    ".theme-menu",
    [],
    [
      ["border", "1px solid var(--line)", false],
      ["border-radius", "12px", false],
      ["background", "var(--paper)", false],
      ["box-shadow", "0 10px 36px var(--shadow)", false],
    ],
  ],
  [
    "ui.css",
    148,
    ".workspace-options-menu",
    [],
    [
      ["border", "1px solid var(--line)", false],
      ["border-radius", "var(--ui-radius-panel)", false],
      ["background", "var(--paper)", false],
      ["box-shadow", "0 8px 28px var(--shadow)", false],
    ],
  ],
  [
    "ui.css",
    301,
    ".composer-options",
    [],
    [
      ["background", "var(--paper)", false],
      ["border", "1px solid var(--line-strong)", false],
      ["border-radius", "10px", false],
      ["box-shadow", "0 6px 20px var(--shadow)", false],
    ],
  ],
  [
    "workflow.css",
    160,
    ".selection-actions",
    [],
    [
      ["background", "light-dark(#fff, #292929)", false],
      ["border", "1px solid light-dark(#ddd, #444)", false],
      ["box-shadow", "0 4px 16px #0002", false],
      ["border-radius", "8px", false],
    ],
  ],
  [
    "visual-system.css",
    29,
    ".selection-actions",
    [],
    [
      ["background", "var(--surface-popover)", false],
      ["border-color", "var(--line)", false],
      ["box-shadow", "var(--elevation-popover)", false],
      ["-webkit-backdrop-filter", "var(--popup-blur)", false],
      ["backdrop-filter", "var(--popup-blur)", false],
    ],
  ],
  [
    "visual-system.css",
    141,
    ".app :is(.composer-options,.theme-menu,.workspace-options-menu)",
    [],
    [
      ["background", "var(--surface-popover)", false],
      ["border", "1px solid var(--line)", false],
      ["border-radius", "10px", false],
      ["box-shadow", "var(--elevation-popover)", false],
      ["-webkit-backdrop-filter", "var(--popup-blur)", false],
      ["backdrop-filter", "var(--popup-blur)", false],
    ],
  ],
] as const satisfies readonly FrozenPopupRule[];

export const mixedPopupSurvivors = [
  [
    "application-dock.css",
    24,
    ".app .composer-options.application-dock-menu",
    [],
    [
      ["width", "var(--launcher-width, 472px)", false],
      ["padding", "18px 14px 10px", false],
    ],
  ],
  [
    "styles.css",
    322,
    ".theme-menu",
    [],
    [
      ["position", "absolute", false],
      ["right", "0", false],
      ["top", "calc(100% + 14px)", false],
      ["width", "264px", false],
      ["padding", "17px", false],
      ["z-index", "40", false],
    ],
  ],
  [
    "ui.css",
    148,
    ".workspace-options-menu",
    [],
    [
      ["position", "absolute", false],
      ["z-index", "30", false],
      ["right", "0", false],
      ["top", "40px", false],
      ["width", "180px", false],
      ["padding", "6px", false],
    ],
  ],
  [
    "ui.css",
    301,
    ".composer-options",
    [],
    [
      ["-webkit-app-region", "no-drag", false],
      ["position", "fixed", false],
      ["inset", "auto", false],
      ["margin", "0", false],
      ["padding", "5px", false],
      ["width", "236px", false],
      ["max-width", "calc(100vw - 16px)", false],
      ["overflow-y", "auto", false],
      ["color", "var(--ink)", false],
    ],
  ],
  [
    "workflow.css",
    160,
    ".selection-actions",
    [],
    [
      ["position", "fixed", false],
      ["z-index", "50", false],
      ["padding", "4px", false],
      ["display", "flex", false],
      ["gap", "2px", false],
      ["color", "light-dark(#222, #eee)", false],
      ["font", "13px -apple-system,\n    sans-serif", false],
    ],
  ],
  [
    "visual-system.css",
    29,
    ".selection-actions",
    [],
    [["color", "var(--ink)", false]],
  ],
  [
    "visual-system.css",
    141,
    ".app :is(.composer-options,.theme-menu,.workspace-options-menu)",
    [],
    [],
  ],
] as const satisfies readonly FrozenPopupRule[];

export const retainedPopupRules = [
  [
    "styles.css",
    83,
    '.app[data-desktop="mac"] .topbar button,.app[data-desktop="mac"] .theme-menu',
    [],
    [["-webkit-app-region", "no-drag", false]],
  ],
  [
    "ui.css",
    20,
    '.app[data-desktop="mac"] .topbar :is( button,input,textarea,select,a,summary,[role="tab"],[contenteditable="true"],.search-field,.workspace-options-menu )',
    [],
    [["-webkit-app-region", "no-drag", false]],
  ],
  [
    "ui.css",
    302,
    ".composer-options::backdrop",
    [],
    [
      ["-webkit-app-region", "no-drag", false],
      ["pointer-events", "none", false],
    ],
  ],
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
    "visual-system.css",
    175,
    ".app .composer-options:not(:popover-open)",
    [],
    [["pointer-events", "none", false]],
  ],
  [
    "visual-system.css",
    176,
    "from",
    ["@keyframes menu-content-reveal"],
    [["opacity", "0", false]],
  ],
  [
    "visual-system.css",
    177,
    "to",
    ["@keyframes menu-content-reveal"],
    [["opacity", "1", false]],
  ],
  [
    "visual-system.css",
    178,
    ".app .composer-options:popover-open>*",
    [],
    [
      [
        "animation",
        "menu-content-reveal var(--motion-surface) var(--motion-ease)",
        false,
      ],
    ],
  ],
  [
    "visual-system.css",
    179,
    ".app .theme-menu",
    [],
    [
      [
        "animation",
        "surface-reveal var(--motion-surface) var(--motion-ease)",
        false,
      ],
    ],
  ],
  [
    "visual-system.css",
    188,
    ".app *,.app *::before,.app *::after,.app dialog::backdrop",
    ["@media (prefers-reduced-motion: reduce)"],
    [
      ["animation", "none", true],
      ["transition", "none", true],
      ["scroll-behavior", "auto", true],
    ],
  ],
] as const satisfies readonly FrozenPopupRule[];

export const retainedPopupTokens = [
  ["ui.css", 0, ":root", [], [["--ui-radius-panel", "12px", false]]],
  [
    "visual-system.css",
    0,
    ".app,.startup,.connection-screen,.selection-actions",
    [],
    [
      ["--popup-solid", "light-dark(#ffffff, #272727)", false],
      ["--surface-popover", "light-dark(#fffffff2, #262626f2)", false],
      ["--popup-blur", "blur(20px)", false],
      ["--popup-line", "light-dark(#dcdcdc, #454545)", false],
      ["--popup-hairline", "light-dark(#e9e9e9, #383838)", false],
      ["--popup-control-border", "light-dark(#cecece, #5b5b5b)", false],
      [
        "--elevation-popover",
        "0 8px 24px light-dark(#00000014, #00000030),\n    0 1px 3px light-dark(#0000000a, #00000024)",
        false,
      ],
    ],
  ],
  [
    "visual-system.css",
    145,
    ".app.application-browser-workspace,:root:has(.application-browser-workspace) .selection-actions",
    [],
    [
      ["--surface-popover", "var(--popup-solid)", false],
      ["--popup-blur", "none", false],
    ],
  ],
  [
    "visual-system.css",
    182,
    ".app,.selection-actions",
    ["@media (prefers-reduced-transparency: reduce)"],
    [
      ["--surface-popover", "var(--popup-solid)", false],
      ["--popup-blur", "none", false],
    ],
  ],
  [
    "visual-system.css",
    183,
    ".app,.selection-actions",
    ["@media (prefers-contrast: more)"],
    [
      ["--surface-popover", "var(--popup-solid)", false],
      ["--popup-blur", "none", false],
      ["--popup-line", "light-dark(#898989, #989898)", false],
      ["--popup-hairline", "var(--popup-line)", false],
      ["--popup-control-border", "var(--ink)", false],
    ],
  ],
  [
    "visual-system.css",
    184,
    ':root:is([data-reduced-transparency="true"],[data-native-contrast="more"]) :is(.app,.selection-actions)',
    [],
    [
      ["--surface-popover", "var(--popup-solid)", false],
      ["--popup-blur", "none", false],
    ],
  ],
  [
    "visual-system.css",
    185,
    ':root[data-native-contrast="more"] :is(.app,.selection-actions)',
    [],
    [
      ["--popup-line", "light-dark(#898989, #989898)", false],
      ["--popup-hairline", "var(--popup-line)", false],
      ["--popup-control-border", "var(--ink)", false],
    ],
  ],
] as const satisfies readonly FrozenPopupRule[];

export const popupProtectedTokens = [
  "--ui-radius-panel",
  "--surface-popover",
  "--popup-solid",
  "--popup-line",
  "--popup-hairline",
  "--popup-control-border",
  "--popup-blur",
  "--elevation-popover",
] as const;
