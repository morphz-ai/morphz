// Original whole recipes reviewed against the accepted post-PDF baseline
// 66666d53. No test side effects, peer inverse, CI Git reads or whole App locks.
// Finite named WorkspaceTopbar packing contract, not a universal selector engine.
import assert from "node:assert/strict";
import { posix } from "node:path";
import postcss, { type Rule, type Root, type ChildNode } from "postcss";
import { verifiedWindowFrameCarrierPhases } from "./window-frame-contract.js";
import {
  isImportDeclaration,
  isExportDeclaration,
  isNamedImports,
  isNamedExports,
  isStringLiteral,
  isNoSubstitutionTemplateLiteral,
  isBinaryExpression,
  isCallExpression,
  isIdentifier,
  SyntaxKind,
  type Node,
  type SourceFile,
  type Identifier,
} from "typescript/unstable/ast";

export const topbarCarriers = {
  base: "shell/workspace-topbar-base.css",
  composition: "shell/workspace-topbar-composition.css",
  packing: "shell/workspace-topbar-packing.css",
} as const;
export const topbarMainNeighbors = {
  base: [
    "styles.css",
    topbarCarriers.base,
    "features/pdf/pdf-reading-base.css",
  ],
  composition: ["ui.css", topbarCarriers.composition, "ui/popup-surface.css"],
  packing: [
    "visual-system.css",
    topbarCarriers.packing,
    "features/pdf/pdf-reading-adaptive.css",
  ],
} as const;
export type TopbarPhase = keyof typeof topbarCarriers;
export type TopbarSources = Readonly<{
  css: ReadonlyMap<string, string>;
  modules: ReadonlyMap<string, string>;
}>;
export type TopbarModule = Readonly<{ file: string; source: SourceFile }>;
type Recipe = Readonly<{
  id: string;
  phase?: string;
  file: string;
  first: number;
  last: number;
  declarations?: number;
  context: readonly { open: string; key: string }[];
  raw: string;
}>;
// Original whole source families, line numbers for provenance only. Values,
// selector-list branches and occurrence order are the actual finite contract.
export const topbarRecipes = [
  {
    id: "B01",
    phase: "base",
    file: "styles.css",
    first: 294,
    last: 303,
    declarations: 8,
    context: [],
    raw: ".topbar {\n  display: flex;\n  align-items: center;\n  gap: 12px;\n  height: 64px;\n  flex-shrink: 0;\n  padding: 0 20px;\n  border-bottom: 1px solid var(--hairline);\n  user-select: none;\n}\n",
  },
  {
    id: "B02",
    phase: "base",
    file: "styles.css",
    first: 304,
    last: 314,
    declarations: 9,
    context: [],
    raw: ".breadcrumb {\n  min-width: 0;\n  flex: 1;\n  display: flex;\n  align-items: center;\n  gap: 9px;\n  color: var(--muted);\n  font-size: 12px;\n  overflow: hidden;\n  white-space: nowrap;\n}\n",
  },
  {
    id: "B03",
    phase: "base",
    file: "styles.css",
    first: 315,
    last: 318,
    declarations: 2,
    context: [],
    raw: ".breadcrumb > svg {\n  width: 14px;\n  height: 14px;\n}\n",
  },
  {
    id: "B04",
    phase: "base",
    file: "styles.css",
    first: 319,
    last: 323,
    declarations: 2,
    context: [],
    raw: ".breadcrumb > span,\n.breadcrumb > strong {\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n",
  },
  {
    id: "B05",
    phase: "base",
    file: "styles.css",
    first: 324,
    last: 332,
    declarations: 7,
    context: [],
    raw: ".breadcrumb button {\n  max-width: 160px;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  color: var(--muted);\n  padding: 5px;\n  display: block;\n}\n",
  },
  {
    id: "B06",
    phase: "base",
    file: "styles.css",
    first: 333,
    last: 336,
    declarations: 2,
    context: [],
    raw: ".breadcrumb > strong {\n  color: var(--ink);\n  font-weight: 500;\n}\n",
  },
  {
    id: "B07",
    phase: "base",
    file: "styles.css",
    first: 367,
    last: 374,
    declarations: 6,
    context: [],
    raw: ".top-actions {\n  display: flex;\n  align-items: center;\n  gap: 3px;\n  flex-shrink: 0;\n  padding-left: 8px;\n  border-left: 1px solid var(--hairline);\n}\n",
  },
  {
    id: "B08",
    phase: "base",
    file: "styles.css",
    first: 395,
    last: 397,
    declarations: 1,
    context: [],
    raw: '.app[data-desktop="mac"] .topbar {\n  -webkit-app-region: drag;\n}\n',
  },
  {
    id: "B09",
    phase: "base",
    file: "styles.css",
    first: 402,
    last: 404,
    declarations: 1,
    context: [],
    raw: '.app[data-desktop="mac"].sidebar-hidden .topbar {\n  padding-left: 94px;\n}\n',
  },
  {
    id: "B10",
    phase: "base",
    file: "styles.css",
    first: 1832,
    last: 1835,
    declarations: 2,
    context: [{ open: "@media (max-width: 1100px) {", key: "styles.css:1822" }],
    raw: "  .topbar {\n    padding-inline: 15px;\n    gap: 8px;\n  }\n",
  },
  {
    id: "B11",
    phase: "base",
    file: "styles.css",
    first: 1879,
    last: 1882,
    declarations: 1,
    context: [{ open: "@media (max-width: 850px) {", key: "styles.css:1864" }],
    raw: "  .breadcrumb > svg,\n  .breadcrumb:has(strong) > span {\n    display: none;\n  }\n",
  },
  {
    id: "B12",
    phase: "base",
    file: "styles.css",
    first: 1883,
    last: 1886,
    declarations: 2,
    context: [{ open: "@media (max-width: 850px) {", key: "styles.css:1864" }],
    raw: "  .top-actions {\n    gap: 0;\n    padding-left: 5px;\n  }\n",
  },
  {
    id: "B13",
    phase: "base",
    file: "styles.css",
    first: 1959,
    last: 1964,
    declarations: 4,
    context: [{ open: "@media (max-width: 560px) {", key: "styles.css:1911" }],
    raw: "  .topbar {\n    height: 50px;\n    padding-inline: 12px;\n    gap: 6px;\n    justify-content: space-between;\n  }\n",
  },
  {
    id: "B14",
    phase: "base",
    file: "styles.css",
    first: 1965,
    last: 1967,
    declarations: 1,
    context: [{ open: "@media (max-width: 560px) {", key: "styles.css:1911" }],
    raw: "  .breadcrumb {\n    display: none;\n  }\n",
  },
  {
    id: "B15",
    phase: "base",
    file: "styles.css",
    first: 1968,
    last: 1972,
    declarations: 3,
    context: [{ open: "@media (max-width: 560px) {", key: "styles.css:1911" }],
    raw: "  .top-actions {\n    border-left: 0;\n    padding-left: 0;\n    gap: 1px;\n  }\n",
  },
  {
    id: "B16",
    phase: "base",
    file: "styles.css",
    first: 1973,
    last: 1977,
    declarations: 3,
    context: [{ open: "@media (max-width: 560px) {", key: "styles.css:1911" }],
    raw: "  .top-actions .icon-button {\n    width: 28px;\n    min-width: 28px;\n    padding: 5px;\n  }\n",
  },
  {
    id: "C01",
    phase: "composition",
    file: "ui.css",
    first: 90,
    last: 98,
    declarations: 7,
    context: [],
    raw: ".topbar {\n  position: relative;\n  height: 48px;\n  gap: 8px;\n  padding-inline: 12px;\n  border-bottom: 0;\n  background: var(--paper);\n  container-type: inline-size;\n}\n",
  },
  {
    id: "C02",
    phase: "composition",
    file: "ui.css",
    first: 101,
    last: 108,
    declarations: 6,
    context: [],
    raw: '.app[data-desktop="mac"] .topbar::before {\n  content: "";\n  position: absolute;\n  inset: 0 0 auto;\n  height: 6px;\n  z-index: 3;\n  -webkit-app-region: drag;\n}\n',
  },
  {
    id: "C03",
    phase: "composition",
    file: "ui.css",
    first: 109,
    last: 124,
    declarations: 1,
    context: [],
    raw: '.app[data-desktop="mac"]\n  .topbar\n  :is(\n    button,\n    input,\n    textarea,\n    select,\n    a,\n    summary,\n    [role="tab"],\n    [contenteditable="true"],\n    .search-field,\n    .workspace-options-menu\n  ) {\n  -webkit-app-region: no-drag;\n}\n',
  },
  {
    id: "C04",
    phase: "composition",
    file: "ui.css",
    first: 125,
    last: 135,
    declarations: 8,
    context: [],
    raw: ".topbar .toolbar-title,\n.topbar .toolbar-title button {\n  margin: 0;\n  padding-block: 0;\n  font-size: 22px;\n  font-weight: 600;\n  line-height: 1.3;\n  color: var(--ink);\n  letter-spacing: -0.4px;\n  white-space: nowrap;\n}\n",
  },
  {
    id: "C05",
    phase: "composition",
    file: "ui.css",
    first: 136,
    last: 138,
    declarations: 1,
    context: [],
    raw: ".topbar:has(.page-toolbar-slot:not([hidden])) .breadcrumb {\n  flex: 0 0 auto;\n}\n",
  },
  {
    id: "C06",
    phase: "composition",
    file: "ui.css",
    first: 139,
    last: 145,
    declarations: 5,
    context: [],
    raw: ".page-toolbar-slot {\n  display: flex;\n  flex: 1;\n  align-items: center;\n  min-width: 0;\n  gap: 8px;\n}\n",
  },
  {
    id: "C07",
    phase: "composition",
    file: "ui.css",
    first: 146,
    last: 152,
    declarations: 5,
    context: [],
    raw: ".detail-toolbar-slot {\n  display: flex;\n  min-width: 0;\n  flex: 0 1 auto;\n  overflow-x: auto;\n  scrollbar-width: thin;\n}\n",
  },
  {
    id: "C08",
    phase: "composition",
    file: "ui.css",
    first: 153,
    last: 163,
    declarations: 8,
    context: [],
    raw: ".topbar .object-toolbar,\n.topbar .draft-toolbar {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  margin: 0;\n  padding: 0;\n  min-height: 32px;\n  border: 0;\n  white-space: nowrap;\n}\n",
  },
  {
    id: "C09",
    phase: "composition",
    file: "ui.css",
    first: 207,
    last: 209,
    declarations: 1,
    context: [],
    raw: ".page-toolbar-slot button {\n  white-space: nowrap;\n}\n",
  },
  {
    id: "C10",
    phase: "composition",
    file: "ui.css",
    first: 220,
    last: 228,
    declarations: 7,
    context: [],
    raw: ".page-toolbar-slot .project-directory-toolbar {\n  display: flex;\n  align-items: center;\n  flex-wrap: nowrap;\n  justify-content: flex-end;\n  width: 100%;\n  gap: 8px;\n  margin: 0;\n}\n",
  },
  {
    id: "C11",
    phase: "composition",
    file: "ui.css",
    first: 258,
    last: 262,
    declarations: 1,
    context: [{ open: "@container (max-width: 640px) {", key: "ui.css:257" }],
    raw: "  .page-toolbar-slot .matter-filters,\n  .page-toolbar-slot .toolbar-count,\n  .project-directory-toolbar > span {\n    display: none;\n  }\n",
  },
  {
    id: "C12",
    phase: "composition",
    file: "ui.css",
    first: 271,
    last: 274,
    declarations: 1,
    context: [{ open: "@container (max-width: 640px) {", key: "ui.css:257" }],
    raw: "  .toolbar-action-label,\n  .toolbar-install span {\n    display: none;\n  }\n",
  },
  {
    id: "C13",
    phase: "composition",
    file: "ui.css",
    first: 275,
    last: 277,
    declarations: 1,
    context: [{ open: "@container (max-width: 640px) {", key: "ui.css:257" }],
    raw: "  .topbar .object-toolbar > span {\n    display: none;\n  }\n",
  },
  {
    id: "C14",
    phase: "composition",
    file: "ui.css",
    first: 282,
    last: 288,
    declarations: 5,
    context: [],
    raw: ".app:not(.sidebar-hidden) .sidebar-toggle {\n  position: absolute;\n  right: calc(100% + 16px);\n  top: 50%;\n  transform: translateY(-50%);\n  z-index: 2;\n}\n",
  },
  {
    id: "C15",
    phase: "composition",
    file: "ui.css",
    first: 289,
    last: 293,
    declarations: 3,
    context: [],
    raw: ".top-actions {\n  gap: 4px;\n  padding-left: 4px;\n  border: 0;\n}\n",
  },
  {
    id: "C16",
    phase: "composition",
    file: "ui.css",
    first: 428,
    last: 431,
    declarations: 2,
    context: [{ open: "@media (min-width: 561px) {", key: "ui.css:321" }],
    raw: "  .app.sidebar-compact .sidebar-toggle {\n    position: static;\n    transform: none;\n  }\n",
  },
  {
    id: "C17",
    phase: "composition",
    file: "ui.css",
    first: 432,
    last: 434,
    declarations: 1,
    context: [{ open: "@media (min-width: 561px) {", key: "ui.css:321" }],
    raw: '  .app.sidebar-compact[data-desktop="mac"] .topbar {\n    padding-left: calc(max(0px, 94px - var(--sidebar-width)) + 12px);\n  }\n',
  },
  {
    id: "C18",
    phase: "composition",
    file: "ui.css",
    first: 515,
    last: 518,
    declarations: 2,
    context: [],
    raw: ".application-toolbar-slot {\n  min-width: 0;\n  flex: 1;\n}\n",
  },
  {
    id: "C19",
    phase: "composition",
    file: "ui.css",
    first: 519,
    last: 528,
    declarations: 8,
    context: [],
    raw: ".topbar .application-strip {\n  --border: var(--line);\n  --surface: var(--paper);\n  --surface-hover: var(--hover);\n  min-height: 0;\n  height: 40px;\n  padding: 0;\n  border: 0;\n  gap: 6px;\n}\n",
  },
  {
    id: "C20",
    phase: "composition",
    file: "ui.css",
    first: 529,
    last: 533,
    declarations: 3,
    context: [],
    raw: ".topbar .application-tabs {\n  flex: 0 1 auto;\n  min-width: 0;\n  scrollbar-width: thin;\n}\n",
  },
  {
    id: "C21",
    phase: "composition",
    file: "ui.css",
    first: 534,
    last: 536,
    declarations: 1,
    context: [],
    raw: ".topbar .application-strip > button {\n  flex-shrink: 0;\n}\n",
  },
  {
    id: "C22",
    phase: "composition",
    file: "ui.css",
    first: 537,
    last: 539,
    declarations: 1,
    context: [],
    raw: ".topbar .application-strip {\n  min-width: 0;\n}\n",
  },
  {
    id: "C23",
    phase: "composition",
    file: "ui.css",
    first: 540,
    last: 542,
    declarations: 1,
    context: [],
    raw: ".topbar:has(.detail-toolbar-slot:not(:empty)) .application-toolbar-slot {\n  min-width: 200px;\n}\n",
  },
  {
    id: "C24",
    phase: "composition",
    file: "ui.css",
    first: 543,
    last: 545,
    declarations: 1,
    context: [],
    raw: ".topbar .application-tabs + button {\n  margin-left: auto;\n}\n",
  },
  {
    id: "C25",
    phase: "composition",
    file: "ui.css",
    first: 546,
    last: 548,
    declarations: 1,
    context: [],
    raw: ".topbar .application-tab {\n  flex: 0 0 auto;\n}\n",
  },
  {
    id: "C26",
    phase: "composition",
    file: "ui.css",
    first: 549,
    last: 553,
    declarations: 3,
    context: [],
    raw: ".topbar .application-tab > button:first-child {\n  min-width: 64px;\n  max-width: 180px;\n  padding: 7px 8px;\n}\n",
  },
  {
    id: "C27",
    phase: "composition",
    file: "ui.css",
    first: 559,
    last: 561,
    declarations: 1,
    context: [{ open: "@container (max-width: 640px) {", key: "ui.css:558" }],
    raw: "  .topbar:has(.detail-toolbar-slot:not(:empty)) .application-toolbar-slot {\n    min-width: 150px;\n  }\n",
  },
  {
    id: "C28",
    phase: "composition",
    file: "ui.css",
    first: 562,
    last: 565,
    declarations: 2,
    context: [{ open: "@container (max-width: 640px) {", key: "ui.css:558" }],
    raw: "  .topbar .application-strip {\n    overflow-x: auto;\n    scrollbar-width: none;\n  }\n",
  },
  {
    id: "C29",
    phase: "composition",
    file: "ui.css",
    first: 566,
    last: 568,
    declarations: 1,
    context: [{ open: "@container (max-width: 640px) {", key: "ui.css:558" }],
    raw: "  .topbar .application-tabs {\n    flex-shrink: 0;\n  }\n",
  },
  {
    id: "C30",
    phase: "composition",
    file: "ui.css",
    first: 569,
    last: 571,
    declarations: 1,
    context: [{ open: "@container (max-width: 640px) {", key: "ui.css:558" }],
    raw: "  .topbar .detail-toolbar-slot {\n    min-width: 32px;\n  }\n",
  },
  {
    id: "C31",
    phase: "composition",
    file: "ui.css",
    first: 572,
    last: 575,
    declarations: 2,
    context: [{ open: "@container (max-width: 640px) {", key: "ui.css:558" }],
    raw: "  .topbar .object-toolbar button {\n    min-width: 32px;\n    padding-inline: 6px;\n  }\n",
  },
  {
    id: "C32",
    phase: "composition",
    file: "ui.css",
    first: 576,
    last: 578,
    declarations: 1,
    context: [{ open: "@container (max-width: 640px) {", key: "ui.css:558" }],
    raw: "  .topbar .object-toolbar .inline {\n    gap: 2px;\n  }\n",
  },
  {
    id: "C33",
    phase: "composition",
    file: "ui.css",
    first: 580,
    last: 583,
    declarations: 1,
    context: [],
    raw: '.app[data-desktop="mac"] .application-tabs,\n.app[data-desktop="mac"] .workspace-options {\n  -webkit-app-region: no-drag;\n}\n',
  },
  {
    id: "C34",
    phase: "composition",
    file: "ui.css",
    first: 585,
    last: 587,
    declarations: 1,
    context: [{ open: "@container (max-width: 400px) {", key: "ui.css:584" }],
    raw: "  .topbar:has(.detail-toolbar-slot:not(:empty)) .application-toolbar-slot {\n    min-width: 72px;\n  }\n",
  },
  {
    id: "C35",
    phase: "composition",
    file: "ui.css",
    first: 1703,
    last: 1709,
    declarations: 5,
    context: [],
    raw: ".navigation-history {\n  display: flex;\n  align-items: center;\n  gap: 0;\n  flex-shrink: 0;\n  -webkit-app-region: no-drag;\n}\n",
  },
  {
    id: "C36",
    phase: "composition",
    file: "ui.css",
    first: 1710,
    last: 1714,
    declarations: 3,
    context: [],
    raw: ".app .navigation-history .icon-button {\n  width: 28px;\n  height: 28px;\n  padding: 6px;\n}\n",
  },
  {
    id: "C37",
    phase: "composition",
    file: "ui.css",
    first: 1715,
    last: 1717,
    declarations: 1,
    context: [],
    raw: ".navigation-history button:disabled {\n  opacity: 0.25;\n}\n",
  },
  {
    id: "C38",
    phase: "composition",
    file: "ui.css",
    first: 3033,
    last: 3035,
    declarations: 1,
    context: [{ open: "@media (max-width: 850px) {", key: "ui.css:3020" }],
    raw: "  .topbar {\n    padding-inline: 12px;\n  }\n",
  },
  {
    id: "C39",
    phase: "composition",
    file: "ui.css",
    first: 3036,
    last: 3038,
    declarations: 1,
    context: [{ open: "@media (max-width: 850px) {", key: "ui.css:3020" }],
    raw: "  .top-actions {\n    gap: 6px;\n  }\n",
  },
  {
    id: "C40",
    phase: "composition",
    file: "ui.css",
    first: 3048,
    last: 3050,
    declarations: 1,
    context: [{ open: "@media (max-width: 480px) {", key: "ui.css:3047" }],
    raw: "  .breadcrumb {\n    gap: 3px;\n  }\n",
  },
  {
    id: "C41",
    phase: "composition",
    file: "ui.css",
    first: 3051,
    last: 3053,
    declarations: 1,
    context: [{ open: "@media (max-width: 480px) {", key: "ui.css:3047" }],
    raw: "  .topbar {\n    gap: 4px;\n  }\n",
  },
  {
    id: "C42",
    phase: "composition",
    file: "ui.css",
    first: 3149,
    last: 3153,
    declarations: 3,
    context: [],
    raw: ".task-breadcrumb > button {\n  font-size: 13px;\n  color: var(--muted);\n  flex-shrink: 0;\n}\n",
  },
  {
    id: "C43",
    phase: "composition",
    file: "ui.css",
    first: 3154,
    last: 3157,
    declarations: 2,
    context: [],
    raw: ".task-breadcrumb .toolbar-title {\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n",
  },
  {
    id: "L01",
    phase: "packing",
    file: "visual-system.css",
    first: 327,
    last: 329,
    declarations: 1,
    context: [],
    raw: ".app .topbar:has(.pdf-toolbar-slot) .breadcrumb {\n  min-width: 40px;\n}\n",
  },
  {
    id: "L02",
    phase: "packing",
    file: "visual-system.css",
    first: 330,
    last: 332,
    declarations: 1,
    context: [],
    raw: ".app .topbar:has(.pdf-toolbar-slot) .detail-toolbar-slot {\n  flex-shrink: 0;\n}\n",
  },
  {
    id: "L03",
    phase: "packing",
    file: "visual-system.css",
    first: 334,
    last: 336,
    declarations: 1,
    context: [
      { open: "@container (max-width: 640px) {", key: "visual-system.css:333" },
    ],
    raw: "  .app .topbar:has(.pdf-toolbar-slot) .application-toolbar-slot {\n    min-width: 0;\n  }\n",
  },
  {
    id: "L04",
    phase: "packing",
    file: "visual-system.css",
    first: 337,
    last: 339,
    declarations: 1,
    context: [
      { open: "@container (max-width: 640px) {", key: "visual-system.css:333" },
    ],
    raw: "  .app .topbar:has(.pdf-toolbar-slot) .application-strip {\n    overflow-x: auto;\n  }\n",
  },
  {
    id: "L05",
    phase: "packing",
    file: "visual-system.css",
    first: 340,
    last: 342,
    declarations: 1,
    context: [
      { open: "@container (max-width: 640px) {", key: "visual-system.css:333" },
    ],
    raw: "  .app .topbar:has(.pdf-toolbar-slot) .navigation-history button:last-child {\n    display: none;\n  }\n",
  },
  {
    id: "L06",
    phase: "packing",
    file: "visual-system.css",
    first: 343,
    last: 345,
    declarations: 1,
    context: [
      { open: "@container (max-width: 640px) {", key: "visual-system.css:333" },
    ],
    raw: "  .app .topbar:has(.pdf-toolbar-slot) .object-toolbar {\n    gap: 2px;\n  }\n",
  },
] as const;
// C11 is a mixed domain/count rule. Keep it at its original UI position before
// the retained display:block filter refinement, rather than moving it across
// that writer or allowing the compiler to coalesce it with C12/C13.
export const topbarMovedRecipes = topbarRecipes.filter(
  (row) => row.id !== "C11",
);
export const topbarBorrowedFamilies = [
  {
    id: "R01",
    file: "styles.css",
    first: 375,
    last: 378,
    context: [],
    raw: ".top-actions > button,\n.theme-wrap > button {\n  color: var(--muted);\n}\n",
  },
  {
    id: "R02",
    file: "styles.css",
    first: 398,
    last: 401,
    context: [],
    raw: '.app[data-desktop="mac"] .topbar button,\n.app[data-desktop="mac"] .theme-menu {\n  -webkit-app-region: no-drag;\n}\n',
  },
  {
    id: "R03",
    file: "styles.css",
    first: 1953,
    last: 1958,
    context: [{ open: "@media (max-width: 560px) {", key: "styles.css:1911" }],
    raw: "  .space-label,\n  .sidebar-section,\n  .sidebar-bottom,\n  .app .sidebar-toggle {\n    display: none;\n  }\n",
  },
  {
    id: "R04",
    file: "ui.css",
    first: 199,
    last: 206,
    context: [],
    raw: ".page-toolbar-slot .matter-filters {\n  flex: 1;\n  flex-wrap: nowrap;\n  gap: 2px;\n  border: 0;\n  padding: 0;\n  margin: 0;\n}\n",
  },
  {
    id: "R40",
    file: "ui.css",
    first: 258,
    last: 280,
    context: [{ open: "@container (max-width: 640px) {", key: "ui.css:257" }],
    raw: "  .page-toolbar-slot .matter-filters,\n  .page-toolbar-slot .toolbar-count,\n  .project-directory-toolbar > span {\n    display: none;\n  }\n  .app .matter-filter-select {\n    display: block;\n    margin-right: auto;\n  }\n  .project-directory-toolbar .search-field {\n    width: auto;\n    flex: 1;\n  }\n  .app .version-controls select {\n    width: 80px;\n  }\n",
  },
  {
    id: "R23",
    file: "inspector.css",
    first: 41,
    last: 47,
    context: [],
    raw: '.app .workspace:not([data-inspector-mode="docked"]) > .topbar,\n.app .workspace:not([data-inspector-mode="docked"]) .browser-toolbar {\n  /* Padding still belongs to Electron\'s drag rectangle. Leave the sibling\n     controls physically outside it, including while the inspector is closed. */\n  margin-right: var(--inspector-controls-space);\n  padding-right: 0;\n}\n',
  },
  {
    id: "R24",
    file: "inspector.css",
    first: 51,
    last: 55,
    context: [],
    raw: ".app .workspace > .topbar {\n  grid-column: 1;\n  grid-row: 1;\n  min-width: 0;\n}\n",
  },
  {
    id: "R25",
    file: "inspector.css",
    first: 149,
    last: 160,
    context: [],
    raw: ".app .sidebar-visibility-toggle,\n.app .inspector-header > .sidebar-visibility-toggle {\n  width: 32px;\n  height: 32px;\n  min-width: 32px;\n  min-height: 32px;\n  padding: 7px;\n}\n.app .sidebar-visibility-toggle > svg {\n  width: 18px;\n  height: 18px;\n}\n",
  },
  {
    id: "R26",
    file: "inspector.css",
    first: 162,
    last: 165,
    context: [{ open: "@media (pointer: coarse) {", key: "inspector.css:161" }],
    raw: "  .app .sidebar-visibility-toggle {\n    min-width: 44px;\n    min-height: 44px;\n  }\n",
  },
  {
    id: "R27",
    file: "workflow.css",
    first: 411,
    last: 415,
    context: [],
    raw: ".application-immersive > .sidebar,\n.application-immersive > .workspace > .topbar,\n.application-browser-workspace > .workspace > .topbar {\n  display: none;\n}\n",
  },
  {
    id: "R35",
    file: "visual-system.css",
    first: 107,
    last: 109,
    context: [],
    raw: ".app :is(.topbar, .primary-panel, .browser-toolbar) {\n  background: var(--paper);\n}\n",
  },
  {
    id: "R36",
    file: "visual-system.css",
    first: 129,
    last: 131,
    context: [],
    raw: ".app .topbar :is(.outline, input, select) {\n  box-shadow: none;\n}\n",
  },
  {
    id: "R37",
    file: "visual-system.css",
    first: 155,
    last: 164,
    context: [],
    raw: ".app\n  :is(\n    .search-result-meta,\n    .artifact-caption,\n    .library-caption,\n    .project-card-bottom,\n    .object-toolbar > span\n  ) {\n  color: var(--muted);\n}\n",
  },
  {
    id: "H01",
    file: "ui.css",
    first: 3021,
    last: 3023,
    context: [{ open: "@media (max-width: 850px) {", key: "ui.css:3020" }],
    raw: "  .topbar .workspace-save span {\n    display: none;\n  }\n",
  },
  {
    id: "H02",
    file: "ui.css",
    first: 3024,
    last: 3026,
    context: [{ open: "@media (max-width: 850px) {", key: "ui.css:3020" }],
    raw: "  .topbar .workspace-save {\n    padding: 7px;\n  }\n",
  },
  {
    id: "H03",
    file: "ui.css",
    first: 3054,
    last: 3056,
    context: [{ open: "@media (max-width: 480px) {", key: "ui.css:3047" }],
    raw: "  .top-actions .input-toggle kbd {\n    display: none;\n  }\n",
  },
] as const;
const carriers: readonly string[] = Object.values(topbarCarriers);
const phases: readonly TopbarPhase[] = ["base", "composition", "packing"];
// CSS signatures DO NOT normalize generic values, selector spelling, context
// params or declarations.
function guarded(check: () => void, diagnostic: string, errors: string[]) {
  try {
    check();
  } catch (error) {
    if (!(error instanceof assert.AssertionError)) throw error;
    errors.push(diagnostic);
  }
}
function context(rule: Rule) {
  const result: string[][] = [];
  for (
    let parent = rule.parent;
    parent?.type !== "root";
    parent = parent?.parent
  ) {
    assert.ok(parent);
    result.unshift(
      parent.type === "atrule"
        ? [parent.name, parent.params]
        : ["nested", (parent as Rule).selector],
    );
  }
  return result;
}
function signature(rule: Rule) {
  return {
    selector: rule.selector,
    context: context(rule),
    declarations: rule.nodes
      .filter((node) => node.type !== "comment")
      .map((node) =>
        node.type === "decl"
          ? {
              property: node.prop,
              value: node.value,
              important: !!node.important,
            }
          : { unexpected: node.type },
      ),
  };
}
function profiles(root: Root) {
  const result: ReturnType<typeof signature>[] = [];
  root.walkRules((rule) => {
    result.push(signature(rule));
  });
  return result;
}
function wrapped(row: Recipe) {
  return row.context.reduceRight(
    (raw, entry) => entry.open + "\n" + raw + "}\n",
    row.raw,
  );
}
// Only adjacent children of the SAME original wrapper are grouped. Distinct
// same-query wrappers separated by original rules are never globally merged.
export function topbarCarrierSource(phase: TopbarPhase) {
  const rows: readonly Recipe[] = topbarMovedRecipes.filter(
    (row) => row.phase === phase,
  );
  let result = "";
  for (let at = 0; at < rows.length;) {
    const row = rows[at]!;
    if (!row.context.length) {
      result += row.raw;
      at++;
      continue;
    }
    const key = JSON.stringify(row.context);
    let raw = row.raw;
    at++;
    while (at < rows.length && JSON.stringify(rows[at]!.context) === key)
      raw += rows[at++]!.raw;
    result += wrapped({ ...row, raw });
  }
  return result;
}
function shape(node: Root | ChildNode): unknown {
  if (node.type === "comment") return undefined;
  if (node.type === "rule") return { rule: signature(node) };
  if (node.type === "root" || node.type === "atrule")
    return {
      kind: node.type,
      ...(node.type === "atrule"
        ? { name: node.name, params: node.params }
        : {}),
      children: (node.nodes ?? [])
        .filter((child) => child.type !== "comment")
        .map(shape),
    };
  return { unexpected: node.type };
}
const expectedRoots = new Map(
  phases.map(
    (phase) => [phase, postcss.parse(topbarCarrierSource(phase))] as const,
  ),
);
const expectedProfiles = new Map(
  phases.map((phase) => [phase, profiles(expectedRoots.get(phase)!)] as const),
);
const borrowed = topbarBorrowedFamilies.flatMap((row) =>
  profiles(postcss.parse(wrapped(row))).map((profile) => ({
    id: row.id,
    file: row.file,
    profile,
  })),
);
const key = (profile: ReturnType<typeof signature>) => JSON.stringify(profile);
const movedProfiles = new Set(
  [...expectedProfiles.values()].flatMap((rows) => rows.map(key)),
);
const packingProperties = new Set([
  ...[...expectedProfiles.values()].flatMap((rows) =>
    rows.flatMap((row) =>
      row.declarations.flatMap((decl) =>
        "property" in decl ? [decl.property] : [],
      ),
    ),
  ),
  "all",
  "width",
  "min-width",
  "max-width",
  "height",
  "min-height",
  "max-height",
  "inline-size",
  "min-inline-size",
  "max-inline-size",
  "block-size",
  "min-block-size",
  "max-block-size",
  "margin",
  "margin-block",
  "margin-inline",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "margin-block-start",
  "margin-block-end",
  "margin-inline-start",
  "margin-inline-end",
  "padding",
  "padding-block",
  "padding-inline",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "padding-block-start",
  "padding-block-end",
  "padding-inline-start",
  "padding-inline-end",
  "gap",
  "row-gap",
  "column-gap",
  "overflow",
  "overflow-x",
  "overflow-y",
  "overflow-inline",
  "overflow-block",
  "container",
  "container-name",
  "container-type",
  "visibility",
  "pointer-events",
]);
const anchors = new Set([
  "topbar",
  "breadcrumb",
  "task-breadcrumb",
  "toolbar-title",
  "top-actions",
  "navigation-history",
  "application-toolbar-slot",
  "page-toolbar-slot",
  "detail-toolbar-slot",
  "sidebar-toggle",
  "toolbar-action-label",
  "toolbar-install",
]);
function withoutPredicates(selector: string) {
  let result = selector;
  for (;;) {
    const match = /:(?:has|not)\(/.exec(result);
    if (!match) return result;
    let depth = 1,
      quote = "",
      end = match.index + match[0].length;
    for (; end < result.length && depth; end++) {
      const char = result[end]!;
      if (quote) {
        if (char === quote && result[end - 1] !== "\\") quote = "";
      } else if (char === '"' || char === "'") quote = char;
      else if (char === "(") depth++;
      else if (char === ")") depth--;
    }
    assert.equal(depth, 0, "balanced selector predicate");
    result = result.slice(0, match.index) + result.slice(end);
  }
}
// Attribute values are data, except an actual class identity selector. Do not
// let a quoted label containing '.icon-button' create a control writer.
function classCode(selector: string) {
  let code = "";
  for (let index = 0; index < selector.length; index++) {
    if (selector[index] !== "[") {
      code += selector[index];
      continue;
    }
    let end = index + 1,
      quote = "";
    for (; end < selector.length; end++) {
      const char = selector[end]!;
      if (quote) {
        if (char === quote && selector[end - 1] !== "\\") quote = "";
      } else if (char === '"' || char === "'") quote = char;
      else if (char === "]") break;
    }
    assert.ok(end < selector.length, "balanced selector attribute");
    const attribute = selector.slice(index, end + 1);
    const match =
      /^\[\s*class\s*(?:~=|=)\s*(?:"([^"]+)"|'([^']+)'|([^\]\s]+))\s*\]$/.exec(
        attribute,
      );
    code += match
      ? "." + (match[1] ?? match[2] ?? match[3]!).split(/\s+/).join(".")
      : "[]";
    index = end;
  }
  return code;
}
// Decode named CSS identifiers, including hexadecimal escape terminators.
function decoded(selector: string) {
  return selector.replace(
    /\\([\da-f]{1,6})(?:\r\n|[ \n\t\r\f])?|\\([^\n\r\f\da-f])/gi,
    (_, hex: string | undefined, character: string | undefined) => {
      if (!hex) return character!;
      const code = Number.parseInt(hex, 16);
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
        ? "\ufffd"
        : String.fromCodePoint(code);
    },
  );
}

// Positive named identities only. :not and :has predicates are not a styled
// subject/ancestor. :is/:where keep positive identities. Bare entity toolbars,
// Browser's distinct controls and data labels do not become Host packing writers.
function namedHost(selector: string) {
  // Drop data attributes/quoted functional data before reading predicates;
  // a quoted ':has(' label must neither create an anchor nor a balance error.
  const identity = classCode(decoded(selector)).replace(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
    "",
  );
  const code = withoutPredicates(identity);
  return [...code.matchAll(/\.([\w-]+)/g)].some((match) =>
    anchors.has(match[1]!),
  );
}
function hostPackingWriter(rule: Rule) {
  let named = namedHost(rule.selector);
  for (
    let parent = rule.parent;
    parent?.type !== "root";
    parent = parent?.parent
  )
    if (parent?.type === "rule") named ||= namedHost(parent.selector);
  return (
    named &&
    rule.nodes.some(
      (node) => node.type === "decl" && packingProperties.has(node.prop),
    )
  );
}
export function topbarCssViolations(css: ReadonlyMap<string, string>) {
  const errors: string[] = [];
  for (const phase of phases) {
    const source = css.get(topbarCarriers[phase]);
    guarded(
      () => {
        assert.ok(source !== undefined, "actual carrier must exist");
        assert.deepEqual(
          shape(postcss.parse(source)),
          shape(expectedRoots.get(phase)!),
        );
      },
      "topbar:complete-" + phase,
      errors,
    );
  }
  const parsed = new Map(
    [...css].map(([file, text]) => [file, postcss.parse(text, { from: file })]),
  );
  for (const [file, root] of parsed) {
    // Even an unused CSS @import creates a second/opaque carrier origin.
    root.walkAtRules("import", (node) => {
      const specifier = /^\s*(?:url\(\s*)?["']?([^"'\s)]+)["']?/.exec(
        node.params,
      )?.[1];
      const target = specifier
        ? posix.normalize(
            posix.join(posix.dirname(file), specifier.split(/[?#]/)[0]!),
          )
        : undefined;
      guarded(
        () => assert.ok(!target || !carriers.includes(target)),
        "topbar:css-import",
        errors,
      );
    });
    if (carriers.includes(file)) continue;
    root.walkRules((rule) => {
      const tuple = key(signature(rule));
      for (const seam of borrowed.filter((row) => key(row.profile) === tuple))
        guarded(
          () => assert.equal(file, seam.file),
          "topbar:borrowed-origin:" + seam.id,
          errors,
        );
      // Complete approved native tuples may have no named Topbar anchor (C33).
      // Their exact duplicate is still a second physical owner; do not broaden
      // this finite check into a ban on independently owned application CSS.
      if (!hostPackingWriter(rule) && !movedProfiles.has(tuple)) return;
      guarded(
        () =>
          assert.ok(
            borrowed.some(
              (row) => row.file === file && key(row.profile) === tuple,
            ),
          ),
        "topbar:no-second-owner:" + file,
        errors,
      );
    });
  }
  // Borrowed permission is exact tuple + source + occurrence. No file whitelist;
  // adding a branch/property/context to a mixed/native rule invalidates it.
  for (const family of topbarBorrowedFamilies) {
    const rows = borrowed.filter((row) => row.id === family.id);
    guarded(
      () => {
        const root = parsed.get(family.file);
        assert.ok(root);
        const actual = profiles(root);
        const wanted = rows.map((row) => key(row.profile));
        for (const tuple of new Set(wanted))
          assert.equal(
            actual.filter((row) => key(row) === tuple).length,
            wanted.filter((item) => item === tuple).length,
          );
        const occurrence = actual.flatMap((row, index) =>
          wanted.includes(key(row)) ? [index] : [],
        );
        assert.deepEqual(
          occurrence.map((index) => key(actual[index]!)),
          wanted,
        );
      },
      "topbar:retained-tuple:" + family.id,
      errors,
    );
  }
  // Preserve only the original relative order of the registered retained
  // families, not intervening independent CSS. In particular the 44px coarse
  // refinement must remain after the ordinary 32px sidebar toggle recipe.
  for (const file of new Set(topbarBorrowedFamilies.map((row) => row.file))) {
    guarded(
      () => {
        const root = parsed.get(file);
        assert.ok(root);
        const families = topbarBorrowedFamilies
          .filter((row) => row.file === file)
          .toSorted((a, b) => a.first - b.first);
        const wanted = families.flatMap((family) =>
          borrowed
            .filter((row) => row.id === family.id)
            .map((row) => key(row.profile)),
        );
        const known = new Set(wanted);
        assert.deepEqual(
          profiles(root)
            .map(key)
            .filter((tuple) => known.has(tuple)),
          wanted,
        );
      },
      "topbar:retained-order:" + file,
      errors,
    );
  }
  return errors;
}
function physical(file: string, specifier: string) {
  return specifier.startsWith(".")
    ? posix.normalize(
        posix.join(posix.dirname(file), specifier.split(/[?#]/)[0]!),
      )
    : undefined;
}
function literal(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (
    isBinaryExpression(node) &&
    node.operatorToken.kind === SyntaxKind.PlusToken
  ) {
    const left = literal(node.left),
      right = literal(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  return undefined;
}
export function topbarEntryFacts(
  modules: readonly TopbarModule[],
  css: ReadonlyMap<string, string>,
  unbound: (identifier: Identifier) => boolean,
) {
  const errors: string[] = [],
    names = new Set(modules.map((module) => module.file)),
    edges = new Map<string, string[]>(),
    counts = new Map<string, number>();
  let main: string[] = [];
  const resolve = (file: string, specifier: string) => {
    const path = physical(file, specifier);
    if (!path) return undefined;
    return [
      path,
      path.replace(/\.js$/, ".tsx"),
      path.replace(/\.js$/, ".ts"),
    ].find((name) => css.has(name) || names.has(name));
  };
  for (const { file, source } of modules) {
    const dependencies: string[] = [],
      direct: string[] = [];
    for (const node of source.statements) {
      if (
        (!isImportDeclaration(node) && !isExportDeclaration(node)) ||
        !node.moduleSpecifier ||
        !isStringLiteral(node.moduleSpecifier)
      )
        continue;
      const specifier = node.moduleSpecifier.text,
        target = physical(file, specifier),
        clause = isImportDeclaration(node) ? node.importClause : undefined;
      const typeOnly = isImportDeclaration(node)
        ? clause?.phaseModifier === SyntaxKind.TypeKeyword ||
          (!!clause?.namedBindings &&
            !clause.name &&
            isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every(
              (element) => element.isTypeOnly,
            ))
        : node.isTypeOnly ||
          (!!node.exportClause &&
            isNamedExports(node.exportClause) &&
            node.exportClause.elements.length > 0 &&
            node.exportClause.elements.every((element) => element.isTypeOnly));
      const resolved = resolve(file, specifier);
      if (resolved && !typeOnly) dependencies.push(resolved);
      if (
        file === "main.tsx" &&
        isImportDeclaration(node) &&
        resolved &&
        css.has(resolved) &&
        !typeOnly
      )
        direct.push(resolved);
      if (target && carriers.includes(target)) {
        counts.set(target, (counts.get(target) ?? 0) + 1);
        guarded(
          () =>
            assert.ok(
              isImportDeclaration(node) &&
                file === "main.tsx" &&
                !clause &&
                !/[?#]/.test(specifier) &&
                css.has(target),
            ),
          "topbar:runtime-origin:" + target,
          errors,
        );
      }
    }
    edges.set(file, dependencies);
    if (file === "main.tsx") main = direct;
    function walk(node: Node) {
      if (
        isCallExpression(node) &&
        (node.expression.kind === SyntaxKind.ImportKeyword ||
          (isIdentifier(node.expression) &&
            node.expression.text === "require" &&
            unbound(node.expression)))
      )
        for (const argument of node.arguments) {
          const text = literal(argument),
            target = text === undefined ? undefined : physical(file, text);
          guarded(
            () => assert.ok(!target || !carriers.includes(target)),
            "topbar:dynamic-entry",
            errors,
          );
        }
      node.forEachChild((child) => {
        walk(child);
      });
    }
    walk(source);
  }
  for (const file of carriers)
    guarded(
      () => assert.equal(counts.get(file), 1),
      "topbar:single-entry:" + file,
      errors,
    );
  const visited = new Set<string>(),
    runtime: string[] = [];
  function visit(file: string) {
    if (visited.has(file)) return;
    visited.add(file);
    if (css.has(file)) {
      runtime.push(file);
      return;
    }
    for (const dependency of edges.get(file) ?? []) visit(dependency);
  }
  visit("main.tsx");
  // Stage60 adds two independent WindowFrame slots before our original phases.
  // Only complete two-carrier/writer/origin/phase proof may make them transparent.
  // WindowFrame is a leaf fixture and never imports this or another peer fixture.
  let windowFrame:
    ReturnType<typeof verifiedWindowFrameCarrierPhases> | undefined;
  guarded(
    () => {
      windowFrame = verifiedWindowFrameCarrierPhases(css, modules, unbound);
    },
    "topbar:window-frame-contract",
    errors,
  );
  return {
    errors,
    main: windowFrame?.main ?? main,
    runtime: windowFrame?.runtime ?? runtime,
  };
}
export function topbarPhaseViolations(
  main: readonly string[],
  runtime: readonly string[],
) {
  const errors: string[] = [];
  for (const [phase, neighbors] of Object.entries(topbarMainNeighbors))
    for (const [stream, label] of [
      [main, "main"],
      [runtime, "runtime"],
    ] as const)
      guarded(
        () => {
          const at = stream.indexOf(neighbors[1]);
          assert.ok(at > 0);
          assert.deepEqual(stream.slice(at - 1, at + 2), neighbors);
        },
        "topbar:" + label + "-phase:" + phase,
        errors,
      );
  return errors;
}

// A peer may adapt its THREE physical import neighbors only after ALL 64
// complete moved profiles, retained mixed counts and all 3 actual phases pass.
// No blind source projection, reverse old source reconstruction or peer inverse.
export function verifiedTopbarCarrierPhases(
  carrier: string,
  css: ReadonlyMap<string, string>,
  modules: readonly TopbarModule[],
  unbound: (identifier: Identifier) => boolean,
) {
  assert.ok(carriers.includes(carrier), "one finite approved Topbar carrier");
  const facts = topbarEntryFacts(modules, css, unbound);
  const errors = [
    ...topbarCssViolations(css),
    ...facts.errors,
    ...topbarPhaseViolations(facts.main, facts.runtime),
  ];
  assert.deepEqual(errors, [], "topbar:complete-handoff:" + errors.join(","));
  return {
    main: facts.main.filter((file) => file !== carrier),
    runtime: facts.runtime.filter((file) => file !== carrier),
  };
}
