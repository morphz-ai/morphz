// Fixed bounded original recipes from fresh actual Git c93283db.
// No whole-current-source lock or historical inverse.
export const fixedPdfReadingRole = {
  baseline: "c93283db6274d93088884f209337aee887bc8980",
  carriers: {
    base: "features/pdf/pdf-reading-base.css",
    adaptive: "features/pdf/pdf-reading-adaptive.css",
  },
  mainNeighbors: {
    base: [
      "styles.css",
      "features/pdf/pdf-reading-base.css",
      "ui/controls/adaptive.css",
    ],
    adaptive: [
      "visual-system.css",
      "features/pdf/pdf-reading-adaptive.css",
      "features/exchange/exchange-controls.css",
    ],
  },
  recipes: [
    {
      source: "styles.css",
      first: 2405,
      last: 2408,
      selector: ".pdf-reader",
      context: [],
      raw: ".pdf-reader {\n  margin-top: 24px;\n  min-width: 0;\n}\n",
      rawSha256:
        "f7dfd19cbcf23de958964dbdcf7c1883bcbdd80121f1588f0e59037b91529a66",
      declarations: [
        {
          property: "margin-top",
          value: "24px",
          important: false,
        },
        {
          property: "min-width",
          value: "0",
          important: false,
        },
      ],
      carrier: "base",
    },
    {
      source: "styles.css",
      first: 2409,
      last: 2415,
      selector: ".pdf-controls",
      context: [],
      raw: ".pdf-controls {\n  display: flex;\n  align-items: center;\n  flex-wrap: wrap;\n  gap: 8px;\n  margin-bottom: 16px;\n}\n",
      rawSha256:
        "a7807e4e030f93cc1c11db8d186c00a1309bf0193d5baaa830764c4a1645c081",
      declarations: [
        {
          property: "display",
          value: "flex",
          important: false,
        },
        {
          property: "align-items",
          value: "center",
          important: false,
        },
        {
          property: "flex-wrap",
          value: "wrap",
          important: false,
        },
        {
          property: "gap",
          value: "8px",
          important: false,
        },
        {
          property: "margin-bottom",
          value: "16px",
          important: false,
        },
      ],
      carrier: "base",
    },
    {
      source: "styles.css",
      first: 2416,
      last: 2421,
      selector: ".pdf-controls label",
      context: [],
      raw: ".pdf-controls label {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  font-size: 13px;\n}\n",
      rawSha256:
        "751c9b34676ade289c42530a509300dbab8eb133779fe28069c65b1d09b35ef5",
      declarations: [
        {
          property: "display",
          value: "flex",
          important: false,
        },
        {
          property: "align-items",
          value: "center",
          important: false,
        },
        {
          property: "gap",
          value: "8px",
          important: false,
        },
        {
          property: "font-size",
          value: "13px",
          important: false,
        },
      ],
      carrier: "base",
    },
    {
      source: "styles.css",
      first: 2422,
      last: 2424,
      selector: ".pdf-controls select",
      context: [],
      raw: ".pdf-controls select {\n  min-width: 62px;\n}\n",
      rawSha256:
        "5dcc6d6c7abe33bb00cbfd5c5cf84316f13b0970cb8f610415f85a3ac4a7258a",
      declarations: [
        {
          property: "min-width",
          value: "62px",
          important: false,
        },
      ],
      carrier: "base",
    },
    {
      source: "styles.css",
      first: 2425,
      last: 2431,
      selector: ".pdf-page",
      context: [],
      raw: ".pdf-page {\n  position: relative;\n  background: white;\n  color: #111;\n  box-shadow: 0 2px 12px #0002;\n  margin: 0 auto;\n}\n",
      rawSha256:
        "ef00ce8231c6c2ab420e4ddc2e4e95e94737504d9282526a980be04c53c75fdd",
      declarations: [
        {
          property: "position",
          value: "relative",
          important: false,
        },
        {
          property: "background",
          value: "white",
          important: false,
        },
        {
          property: "color",
          value: "#111",
          important: false,
        },
        {
          property: "box-shadow",
          value: "0 2px 12px #0002",
          important: false,
        },
        {
          property: "margin",
          value: "0 auto",
          important: false,
        },
      ],
      carrier: "base",
    },
    {
      source: "styles.css",
      first: 2432,
      last: 2434,
      selector: ".pdf-page canvas",
      context: [],
      raw: ".pdf-page canvas {\n  display: block;\n}\n",
      rawSha256:
        "c5e271a7745f67ff558952b8c309faae711b8a9533cf1c8f0872b48a59f4e6b7",
      declarations: [
        {
          property: "display",
          value: "block",
          important: false,
        },
      ],
      carrier: "base",
    },
    {
      source: "styles.css",
      first: 2435,
      last: 2449,
      selector: ".pdf-text-layer",
      context: [],
      raw: ".pdf-text-layer {\n  position: absolute;\n  text-align: initial;\n  inset: 0;\n  overflow: clip;\n  line-height: 1;\n  letter-spacing: normal;\n  word-spacing: normal;\n  text-size-adjust: none;\n  forced-color-adjust: none;\n  transform-origin: 0 0;\n  --min-font-size: 1;\n  --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));\n  --min-font-size-inv: calc(1 / var(--min-font-size));\n}\n",
      rawSha256:
        "4a9a95b175d4df2335c665ca41795fca3c9c736bc44efc71edd483e00da0ead6",
      declarations: [
        {
          property: "position",
          value: "absolute",
          important: false,
        },
        {
          property: "text-align",
          value: "initial",
          important: false,
        },
        {
          property: "inset",
          value: "0",
          important: false,
        },
        {
          property: "overflow",
          value: "clip",
          important: false,
        },
        {
          property: "line-height",
          value: "1",
          important: false,
        },
        {
          property: "letter-spacing",
          value: "normal",
          important: false,
        },
        {
          property: "word-spacing",
          value: "normal",
          important: false,
        },
        {
          property: "text-size-adjust",
          value: "none",
          important: false,
        },
        {
          property: "forced-color-adjust",
          value: "none",
          important: false,
        },
        {
          property: "transform-origin",
          value: "0 0",
          important: false,
        },
        {
          property: "--min-font-size",
          value: "1",
          important: false,
        },
        {
          property: "--text-scale-factor",
          value: "calc(var(--total-scale-factor) * var(--min-font-size))",
          important: false,
        },
        {
          property: "--min-font-size-inv",
          value: "calc(1 / var(--min-font-size))",
          important: false,
        },
      ],
      carrier: "base",
    },
    {
      source: "styles.css",
      first: 2450,
      last: 2457,
      selector: ".pdf-text-layer :is(span, br)",
      context: [],
      raw: ".pdf-text-layer :is(span, br) {\n  color: transparent;\n  position: absolute;\n  white-space: pre;\n  cursor: text;\n  transform-origin: 0 0;\n  user-select: text;\n}\n",
      rawSha256:
        "81c84f1b3884560a12eb0c49d26d080fe6a09adc77dd32ffcc6a409c92848169",
      declarations: [
        {
          property: "color",
          value: "transparent",
          important: false,
        },
        {
          property: "position",
          value: "absolute",
          important: false,
        },
        {
          property: "white-space",
          value: "pre",
          important: false,
        },
        {
          property: "cursor",
          value: "text",
          important: false,
        },
        {
          property: "transform-origin",
          value: "0 0",
          important: false,
        },
        {
          property: "user-select",
          value: "text",
          important: false,
        },
      ],
      carrier: "base",
    },
    {
      source: "styles.css",
      first: 2458,
      last: 2467,
      selector:
        ".pdf-text-layer > :not(.markedContent),\n.pdf-text-layer .markedContent span:not(.markedContent)",
      context: [],
      raw: ".pdf-text-layer > :not(.markedContent),\n.pdf-text-layer .markedContent span:not(.markedContent) {\n  z-index: 1;\n  --font-height: 0;\n  font-size: calc(var(--text-scale-factor) * var(--font-height));\n  --scale-x: 1;\n  --rotate: 0deg;\n  transform: rotate(var(--rotate)) scaleX(var(--scale-x))\n    scale(var(--min-font-size-inv));\n}\n",
      rawSha256:
        "df046e51e668b4d04308503cffdf9dbc7674bde7c15299a92161a84f5356f7bc",
      declarations: [
        {
          property: "z-index",
          value: "1",
          important: false,
        },
        {
          property: "--font-height",
          value: "0",
          important: false,
        },
        {
          property: "font-size",
          value: "calc(var(--text-scale-factor) * var(--font-height))",
          important: false,
        },
        {
          property: "--scale-x",
          value: "1",
          important: false,
        },
        {
          property: "--rotate",
          value: "0deg",
          important: false,
        },
        {
          property: "transform",
          value:
            "rotate(var(--rotate)) scaleX(var(--scale-x))\n    scale(var(--min-font-size-inv))",
          important: false,
        },
      ],
      carrier: "base",
    },
    {
      source: "styles.css",
      first: 2468,
      last: 2470,
      selector: ".pdf-text-layer .markedContent",
      context: [],
      raw: ".pdf-text-layer .markedContent {\n  display: contents;\n}\n",
      rawSha256:
        "e1d1ce55693759bee190c0a2d7f8b20826033603d548d1e808a61f3af210386c",
      declarations: [
        {
          property: "display",
          value: "contents",
          important: false,
        },
      ],
      carrier: "base",
    },
    {
      source: "styles.css",
      first: 2471,
      last: 2473,
      selector: ".pdf-text-layer ::selection",
      context: [],
      raw: ".pdf-text-layer ::selection {\n  background: #098cb755;\n}\n",
      rawSha256:
        "9dd00542237b8999fcbd345130bcad2807f55a9915462069a335e3ccaae1b3e9",
      declarations: [
        {
          property: "background",
          value: "#098cb755",
          important: false,
        },
      ],
      carrier: "base",
    },
    {
      source: "styles.css",
      first: 2474,
      last: 2477,
      selector: ".pdf-extracted",
      context: [],
      raw: ".pdf-extracted {\n  margin-top: 20px;\n  font-size: 13px;\n}\n",
      rawSha256:
        "28a92126410babfc64bf97ccd6c80d0087138686f0f76d59355997360f48ba64",
      declarations: [
        {
          property: "margin-top",
          value: "20px",
          important: false,
        },
        {
          property: "font-size",
          value: "13px",
          important: false,
        },
      ],
      carrier: "base",
    },
    {
      source: "styles.css",
      first: 2478,
      last: 2480,
      selector: ".pdf-extracted summary",
      context: [],
      raw: ".pdf-extracted summary {\n  cursor: pointer;\n}\n",
      rawSha256:
        "78bcb85c1ee43b182e3ee847bbb49cb61359eef15323822fa77de1fe27a6d58f",
      declarations: [
        {
          property: "cursor",
          value: "pointer",
          important: false,
        },
      ],
      carrier: "base",
    },
    {
      source: "styles.css",
      first: 2481,
      last: 2485,
      selector: ".pdf-extracted p",
      context: [],
      raw: ".pdf-extracted p {\n  white-space: pre-wrap;\n  line-height: 1.75;\n  user-select: text;\n}\n",
      rawSha256:
        "967e66c2591366682b10ae81c0c2d90720ce0b71fd9fb2c044beddc32b633765",
      declarations: [
        {
          property: "white-space",
          value: "pre-wrap",
          important: false,
        },
        {
          property: "line-height",
          value: "1.75",
          important: false,
        },
        {
          property: "user-select",
          value: "text",
          important: false,
        },
      ],
      carrier: "base",
    },
    {
      source: "visual-system.css",
      first: 327,
      last: 329,
      selector: ".app .pdf-reader",
      context: [],
      raw: ".app .pdf-reader {\n  background: var(--bg);\n}\n",
      rawSha256:
        "d670a2fa99cd38c1e25b9a3cc059f410f36305db2ab80191978cfb9c9bf48042",
      declarations: [
        {
          property: "background",
          value: "var(--bg)",
          important: false,
        },
      ],
      carrier: "adaptive",
    },
    {
      source: "visual-system.css",
      first: 332,
      last: 335,
      selector: ".app .object-paper.pdf-paper",
      context: [],
      raw: ".app .object-paper.pdf-paper {\n  max-width: 952px;\n  padding: 8px 16px 16px;\n}\n",
      rawSha256:
        "51f91eb9cfb887315873ebc23bf9affcb3c9e586cb390b349f07589b527b9fa0",
      declarations: [
        {
          property: "max-width",
          value: "952px",
          important: false,
        },
        {
          property: "padding",
          value: "8px 16px 16px",
          important: false,
        },
      ],
      carrier: "adaptive",
    },
    {
      source: "visual-system.css",
      first: 336,
      last: 338,
      selector: ".app .pdf-paper .pdf-reader",
      context: [],
      raw: ".app .pdf-paper .pdf-reader {\n  margin-top: 0;\n}\n",
      rawSha256:
        "fc770f8a08a66b9cf290d91f3c7f15d1f28def6ec6612da62cf6cf9b965c0001",
      declarations: [
        {
          property: "margin-top",
          value: "0",
          important: false,
        },
      ],
      carrier: "adaptive",
    },
    {
      source: "visual-system.css",
      first: 339,
      last: 343,
      selector: ".app .pdf-toolbar-slot .pdf-controls",
      context: [],
      raw: ".app .pdf-toolbar-slot .pdf-controls {\n  flex-wrap: nowrap;\n  gap: 2px;\n  margin: 0;\n}\n",
      rawSha256:
        "fd73121b3d3fc95b765d3662cd2f1368eed5f39f057aa1c2a9e218b0c0bb68d1",
      declarations: [
        {
          property: "flex-wrap",
          value: "nowrap",
          important: false,
        },
        {
          property: "gap",
          value: "2px",
          important: false,
        },
        {
          property: "margin",
          value: "0",
          important: false,
        },
      ],
      carrier: "adaptive",
    },
    {
      source: "visual-system.css",
      first: 344,
      last: 349,
      selector: ".app .pdf-toolbar-slot .pdf-controls button",
      context: [],
      raw: ".app .pdf-toolbar-slot .pdf-controls button {\n  width: 28px;\n  min-width: 28px;\n  height: 28px;\n  padding: 4px;\n}\n",
      rawSha256:
        "10d808f4cafe3692ffcacd4820732d7f4fe7f9da1bdb8b77d450f41e47216bbc",
      declarations: [
        {
          property: "width",
          value: "28px",
          important: false,
        },
        {
          property: "min-width",
          value: "28px",
          important: false,
        },
        {
          property: "height",
          value: "28px",
          important: false,
        },
        {
          property: "padding",
          value: "4px",
          important: false,
        },
      ],
      carrier: "adaptive",
    },
    {
      source: "visual-system.css",
      first: 350,
      last: 354,
      selector: ".app .pdf-toolbar-slot label",
      context: [],
      raw: ".app .pdf-toolbar-slot label {\n  gap: 4px;\n  white-space: nowrap;\n  font-variant-numeric: tabular-nums;\n}\n",
      rawSha256:
        "a3f5934043c19fe1b003bfa566e649e6389bde2b07ce5537d80f68cf85a32152",
      declarations: [
        {
          property: "gap",
          value: "4px",
          important: false,
        },
        {
          property: "white-space",
          value: "nowrap",
          important: false,
        },
        {
          property: "font-variant-numeric",
          value: "tabular-nums",
          important: false,
        },
      ],
      carrier: "adaptive",
    },
    {
      source: "visual-system.css",
      first: 355,
      last: 362,
      selector: ".app .pdf-toolbar-slot select",
      context: [],
      raw: ".app .pdf-toolbar-slot select {\n  width: auto;\n  min-width: 44px;\n  height: 28px;\n  padding: 3px 4px;\n  background: transparent;\n  border-color: transparent;\n}\n",
      rawSha256:
        "276bdbcd532edf0bfa9cb1047695a513e47a35637fa1826b840c72f47e4fcee7",
      declarations: [
        {
          property: "width",
          value: "auto",
          important: false,
        },
        {
          property: "min-width",
          value: "44px",
          important: false,
        },
        {
          property: "height",
          value: "28px",
          important: false,
        },
        {
          property: "padding",
          value: "3px 4px",
          important: false,
        },
        {
          property: "background",
          value: "transparent",
          important: false,
        },
        {
          property: "border-color",
          value: "transparent",
          important: false,
        },
      ],
      carrier: "adaptive",
    },
    {
      source: "visual-system.css",
      first: 363,
      last: 368,
      selector: ".app .pdf-file-info",
      context: [],
      raw: ".app .pdf-file-info {\n  margin-top: 12px;\n  color: var(--muted);\n  font-size: 12px;\n  overflow-wrap: anywhere;\n}\n",
      rawSha256:
        "090974cafc9f31a6f12b8bbf0309d9a43e9cfe4f618be0cfe2d9e8e63f38b26a",
      declarations: [
        {
          property: "margin-top",
          value: "12px",
          important: false,
        },
        {
          property: "color",
          value: "var(--muted)",
          important: false,
        },
        {
          property: "font-size",
          value: "12px",
          important: false,
        },
        {
          property: "overflow-wrap",
          value: "anywhere",
          important: false,
        },
      ],
      carrier: "adaptive",
    },
    {
      source: "visual-system.css",
      first: 369,
      last: 371,
      selector: ".app .pdf-file-info p",
      context: [],
      raw: ".app .pdf-file-info p {\n  margin: 6px 0;\n}\n",
      rawSha256:
        "e6af847ecabafb1ea190df81a5086cd90cb3071132781aed32faa1c0771726fb",
      declarations: [
        {
          property: "margin",
          value: "6px 0",
          important: false,
        },
      ],
      carrier: "adaptive",
    },
  ],
  retainedHost: {
    selectors: [
      ".app .topbar:has(.pdf-toolbar-slot) .breadcrumb",
      ".app .topbar:has(.pdf-toolbar-slot) .detail-toolbar-slot",
      ".app .topbar:has(.pdf-toolbar-slot) .application-toolbar-slot",
      ".app .topbar:has(.pdf-toolbar-slot) .application-strip",
      ".app .topbar:has(.pdf-toolbar-slot) .navigation-history button:last-child",
      ".app .topbar:has(.pdf-toolbar-slot) .object-toolbar",
    ],
    context: [
      [],
      [],
      ["container:(max-width: 640px)"],
      ["container:(max-width: 640px)"],
      ["container:(max-width: 640px)"],
      ["container:(max-width: 640px)"],
    ],
    raw: ".app .topbar:has(.pdf-toolbar-slot) .breadcrumb {\n  min-width: 40px;\n}\n.app .topbar:has(.pdf-toolbar-slot) .detail-toolbar-slot {\n  flex-shrink: 0;\n}\n@container (max-width: 640px) {\n  .app .topbar:has(.pdf-toolbar-slot) .application-toolbar-slot {\n    min-width: 0;\n  }\n  .app .topbar:has(.pdf-toolbar-slot) .application-strip {\n    overflow-x: auto;\n  }\n  .app .topbar:has(.pdf-toolbar-slot) .navigation-history button:last-child {\n    display: none;\n  }\n  .app .topbar:has(.pdf-toolbar-slot) .object-toolbar {\n    gap: 2px;\n  }\n}\n",
    rawSha256:
      "5c25da9e37c7f74f1fb5f09febea794a14200f035c929afe5a144327e6b5899f",
  },
} as const;

// Finite existing native/role writers that can affect PDF controls/canvas.
// Only their PDF-relevant declarations are compared; unrelated growth is legal.
export const fixedPdfPrimitiveRefinements = [
  {
    file: "styles.css",
    first: 26,
    last: 31,
    sourceRaw:
      "svg {\n  width: 16px;\n  height: 16px;\n  flex-shrink: 0;\n  stroke-width: 1.65;\n}\n",
    sourceRawSha256:
      "f1273a4415e89caf6b297d541d69bd9e8c4fe54da3d3c74066017c83dc322ae3",
    context: [],
    raw: "svg {\n  width: 16px;\n  height: 16px;\n  flex-shrink: 0;\n  stroke-width: 1.65;\n}\n",
    rawSha256:
      "f1273a4415e89caf6b297d541d69bd9e8c4fe54da3d3c74066017c83dc322ae3",
  },
  {
    file: "styles.css",
    first: 32,
    last: 37,
    sourceRaw: "h1,\nh2,\nh3,\np {\n  margin: 0;\n}\n",
    sourceRawSha256:
      "fe899a607a7f30ffd0a099ca585f5d5cb3bfecb93f107e17cc4680db044d785d",
    context: [],
    raw: "h1,\nh2,\nh3,\np {\n  margin: 0;\n}\n",
    rawSha256:
      "fe899a607a7f30ffd0a099ca585f5d5cb3bfecb93f107e17cc4680db044d785d",
  },
  {
    file: "ui/controls/base.css",
    first: 2,
    last: 8,
    sourceRaw:
      "button,\ninput,\ntextarea,\nselect {\n  font: inherit;\n  min-width: 0;\n}\n",
    sourceRawSha256:
      "2ab54f22f9948d204d09d0a5985913f18087ddba7553804f8baef44bb5824a36",
    context: [],
    raw: "button,\ninput,\ntextarea,\nselect {\n  font: inherit;\n  min-width: 0;\n}\n",
    rawSha256:
      "2ab54f22f9948d204d09d0a5985913f18087ddba7553804f8baef44bb5824a36",
  },
  {
    file: "ui/controls/base.css",
    first: 9,
    last: 11,
    sourceRaw: "button {\n  cursor: pointer;\n}\n",
    sourceRawSha256:
      "83d3a13f2295c5b717a4df39a2a8091e49b98b4dc247a545fd935ff0cec5573c",
    context: [],
    raw: "button {\n  cursor: pointer;\n}\n",
    rawSha256:
      "83d3a13f2295c5b717a4df39a2a8091e49b98b4dc247a545fd935ff0cec5573c",
  },
  {
    file: "ui/controls/base.css",
    first: 12,
    last: 15,
    sourceRaw: "button:disabled {\n  cursor: default;\n  opacity: 0.45;\n}\n",
    sourceRawSha256:
      "14fed9ac427dca8b80f6e055fa2ace2a2200a4804e4bb7cba47e956b20a9a27e",
    context: [],
    raw: "button:disabled {\n  cursor: default;\n  opacity: 0.45;\n}\n",
    rawSha256:
      "14fed9ac427dca8b80f6e055fa2ace2a2200a4804e4bb7cba47e956b20a9a27e",
  },
  {
    file: "ui/controls/base.css",
    first: 16,
    last: 30,
    sourceRaw:
      ".app button,\n.startup button,\n.connection-screen button {\n  border: 0;\n  background: transparent;\n  color: inherit;\n  display: inline-flex;\n  align-items: center;\n  gap: 8px;\n  border-radius: 7px;\n  padding: 7px 10px;\n  text-align: left;\n  line-height: 1.4;\n  font-size: 12px;\n}\n",
    sourceRawSha256:
      "23096b58701e3912590ae6a768d0a63e91b577a9d563d4377e9c2e96ee56a6e9",
    context: [],
    raw: ".app button,\n.startup button,\n.connection-screen button {\n  border: 0;\n  background: transparent;\n  color: inherit;\n  display: inline-flex;\n  align-items: center;\n  gap: 8px;\n  border-radius: 7px;\n  padding: 7px 10px;\n  text-align: left;\n  line-height: 1.4;\n  font-size: 12px;\n}\n",
    rawSha256:
      "23096b58701e3912590ae6a768d0a63e91b577a9d563d4377e9c2e96ee56a6e9",
  },
  {
    file: "ui/controls/base.css",
    first: 31,
    last: 35,
    sourceRaw:
      ".app button:hover:not(:disabled),\n.startup button:hover,\n.connection-screen button:hover:not(:disabled) {\n  background: var(--soft);\n}\n",
    sourceRawSha256:
      "0e8447161a5759eaa78f67f3a7f457c6e6eea21f47f9ef66efb11a18556052a4",
    context: [],
    raw: ".app button:hover:not(:disabled),\n.startup button:hover,\n.connection-screen button:hover:not(:disabled) {\n  background: var(--soft);\n}\n",
    rawSha256:
      "0e8447161a5759eaa78f67f3a7f457c6e6eea21f47f9ef66efb11a18556052a4",
  },
  {
    file: "ui/controls/base.css",
    first: 42,
    last: 51,
    sourceRaw:
      ".app input,\n.app textarea,\n.app select,\n.connection-screen input {\n  background: var(--paper);\n  color: var(--ink);\n  border: 1px solid var(--line);\n  border-radius: 8px;\n  padding: 9px 11px;\n}\n",
    sourceRawSha256:
      "fc0b5ae755e03de198faa877cc986424092b918e32950c7f288a0d196e7c60bc",
    context: [],
    raw: ".app input,\n.app textarea,\n.app select,\n.connection-screen input {\n  background: var(--paper);\n  color: var(--ink);\n  border: 1px solid var(--line);\n  border-radius: 8px;\n  padding: 9px 11px;\n}\n",
    rawSha256:
      "fc0b5ae755e03de198faa877cc986424092b918e32950c7f288a0d196e7c60bc",
  },
  {
    file: "ui/controls/base.css",
    first: 52,
    last: 55,
    sourceRaw: ".app textarea {\n  resize: vertical;\n  line-height: 1.8;\n}\n",
    sourceRawSha256:
      "79510901d1750afa84417cbde2d344c7b0201aff71679f0b4c91d00e88ae73d5",
    context: [],
    raw: ".app textarea {\n  resize: vertical;\n  line-height: 1.8;\n}\n",
    rawSha256:
      "79510901d1750afa84417cbde2d344c7b0201aff71679f0b4c91d00e88ae73d5",
  },
  {
    file: "ui/controls/base.css",
    first: 68,
    last: 74,
    sourceRaw:
      ".app .primary,\n.connection-screen .primary {\n  background: var(--accent);\n  color: var(--on-accent);\n  padding: 9px 14px;\n  font-weight: 550;\n}\n",
    sourceRawSha256:
      "4f7a6ef2ebaf9a65f4ef8e456008b4ab791764129c5348ddbef042e150fa67f6",
    context: [],
    raw: ".app .primary,\n.connection-screen .primary {\n  background: var(--accent);\n  color: var(--on-accent);\n  padding: 9px 14px;\n  font-weight: 550;\n}\n",
    rawSha256:
      "4f7a6ef2ebaf9a65f4ef8e456008b4ab791764129c5348ddbef042e150fa67f6",
  },
  {
    file: "ui/controls/base.css",
    first: 75,
    last: 79,
    sourceRaw:
      ".app .primary:hover:not(:disabled),\n.app .send:hover:not(:disabled),\n.connection-screen .primary:hover:not(:disabled) {\n  background: var(--accent-strong);\n}\n",
    sourceRawSha256:
      "105a6c9861cda27076f67857d0e6a992347f94682f5ef6c60935b9bd43475d8b",
    context: [],
    raw: ".app .primary:hover:not(:disabled),\n.app .send:hover:not(:disabled),\n.connection-screen .primary:hover:not(:disabled) {\n  background: var(--accent-strong);\n}\n",
    rawSha256:
      "105a6c9861cda27076f67857d0e6a992347f94682f5ef6c60935b9bd43475d8b",
  },
  {
    file: "ui/controls/base.css",
    first: 80,
    last: 85,
    sourceRaw:
      ".app .outline {\n  border: 1px solid var(--line);\n  background: var(--paper);\n  padding: 8px 11px;\n  box-shadow: 0 1px 2px var(--shadow);\n}\n",
    sourceRawSha256:
      "b14386f94b8e2efef5d88cac34664c7f1860acd392fb994668a7314ea313c5e5",
    context: [],
    raw: ".app .outline {\n  border: 1px solid var(--line);\n  background: var(--paper);\n  padding: 8px 11px;\n  box-shadow: 0 1px 2px var(--shadow);\n}\n",
    rawSha256:
      "b14386f94b8e2efef5d88cac34664c7f1860acd392fb994668a7314ea313c5e5",
  },
  {
    file: "ui/controls/base.css",
    first: 86,
    last: 92,
    sourceRaw:
      ".app .icon-button {\n  justify-content: center;\n  width: 32px;\n  height: 32px;\n  padding: 7px;\n  flex-shrink: 0;\n}\n",
    sourceRawSha256:
      "7ae7891c29a4e280afa17cbf2b2da9f12f91af3244976afdc30e303e824c75b5",
    context: [],
    raw: ".app .icon-button {\n  justify-content: center;\n  width: 32px;\n  height: 32px;\n  padding: 7px;\n  flex-shrink: 0;\n}\n",
    rawSha256:
      "7ae7891c29a4e280afa17cbf2b2da9f12f91af3244976afdc30e303e824c75b5",
  },
  {
    file: "ui/controls/adaptive.css",
    first: 3,
    last: 5,
    sourceRaw: "  .app button {\n    min-height: 44px;\n  }\n",
    sourceRawSha256:
      "468ad96af542e5c3a563b2d58c557fa765f09112bcd306c95e83de38a5fd6bb8",
    context: [["media", "(pointer: coarse)"]],
    raw: "@media (pointer: coarse) {\n  .app button {\n    min-height: 44px;\n  }\n}\n",
    rawSha256:
      "63f405fadd7e769f9d28df23861d8d353f97215cdbe8cdeeb64973a1499cd5e2",
  },
  {
    file: "ui/controls/adaptive.css",
    first: 6,
    last: 10,
    sourceRaw:
      "  .app textarea,\n  .app input,\n  .app select {\n    font-size: 16px;\n  }\n",
    sourceRawSha256:
      "fd7291bc79696861f8963bfa596bd69a54c4e3aaf00832274f1d4b1982e38cdf",
    context: [["media", "(pointer: coarse)"]],
    raw: "@media (pointer: coarse) {\n  .app textarea,\n  .app input,\n  .app select {\n    font-size: 16px;\n  }\n}\n",
    rawSha256:
      "f8cd107d59d88b6bdd7ca05217dfed42e91e2318a4cf55c2e8ddde74f80c6b45",
  },
  {
    file: "ui/controls/adaptive.css",
    first: 11,
    last: 15,
    sourceRaw:
      "  .app .icon-button,\n  .app .send {\n    width: 44px;\n    height: 44px;\n  }\n",
    sourceRawSha256:
      "8d943a3eeb4564c2b0dc0412991adde20fcb4369a0d6e6f146ea3bc662a04977",
    context: [["media", "(pointer: coarse)"]],
    raw: "@media (pointer: coarse) {\n  .app .icon-button,\n  .app .send {\n    width: 44px;\n    height: 44px;\n  }\n}\n",
    rawSha256:
      "8791e951c611ed04fe599fe91888e60acdef0df67f46796a3e33feea291fbd83",
  },
  {
    file: "ui/controls/metrics.css",
    first: 2,
    last: 4,
    sourceRaw: ".app .primary {\n  background: var(--accent-strong);\n}\n",
    sourceRawSha256:
      "a15df721087162dd180f0a2720aa5d326f398d767d66c3a4a515e095a302283a",
    context: [],
    raw: ".app .primary {\n  background: var(--accent-strong);\n}\n",
    rawSha256:
      "a15df721087162dd180f0a2720aa5d326f398d767d66c3a4a515e095a302283a",
  },
  {
    file: "ui/controls/metrics.css",
    first: 10,
    last: 13,
    sourceRaw:
      ".app .icon-button {\n  min-width: 32px;\n  min-height: 32px;\n}\n",
    sourceRawSha256:
      "a918694667c20bd0179bd567ab1c69e42a84d33edb81e6784eb3c5e595423dab",
    context: [],
    raw: ".app .icon-button {\n  min-width: 32px;\n  min-height: 32px;\n}\n",
    rawSha256:
      "a918694667c20bd0179bd567ab1c69e42a84d33edb81e6784eb3c5e595423dab",
  },
  {
    file: "ui/controls/surfaces.css",
    first: 2,
    last: 4,
    sourceRaw:
      ".app button:active:not(:disabled) {\n  background-color: var(--hover);\n}\n",
    sourceRawSha256:
      "e8bd8bc192b1bda9040a67f00c5b163980c7e061367b1836affb7f8c345afb5e",
    context: [],
    raw: ".app button:active:not(:disabled) {\n  background-color: var(--hover);\n}\n",
    rawSha256:
      "e8bd8bc192b1bda9040a67f00c5b163980c7e061367b1836affb7f8c345afb5e",
  },
  {
    file: "ui/controls/surfaces.css",
    first: 5,
    last: 9,
    sourceRaw:
      ".app .outline {\n  background: var(--surface-control);\n  border-color: var(--line);\n  box-shadow: var(--elevation-small);\n}\n",
    sourceRawSha256:
      "d1add4f0309e2f2eaf659d887a3277bbe3fef0b79c5d41906c052036545fc402",
    context: [],
    raw: ".app .outline {\n  background: var(--surface-control);\n  border-color: var(--line);\n  box-shadow: var(--elevation-small);\n}\n",
    rawSha256:
      "d1add4f0309e2f2eaf659d887a3277bbe3fef0b79c5d41906c052036545fc402",
  },
  {
    file: "ui/controls/surfaces.css",
    first: 10,
    last: 12,
    sourceRaw: ".app .primary {\n  box-shadow: var(--elevation-small);\n}\n",
    sourceRawSha256:
      "4bc882ba3f4c84fbb607175630eed0f327ff0e0f711026f6724358d6b66aaac4",
    context: [],
    raw: ".app .primary {\n  box-shadow: var(--elevation-small);\n}\n",
    rawSha256:
      "4bc882ba3f4c84fbb607175630eed0f327ff0e0f711026f6724358d6b66aaac4",
  },
] as const;
