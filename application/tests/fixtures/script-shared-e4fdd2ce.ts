// Independently captured from complete actual Git e4fdd2cec1358b513216f05f6061d0986f1dab44.
// Only this small primitive, vocabulary and seven original consumers are fixed.
// Ordinary CI never reads Git, /tmp, a complete renderer hash or an inverse chain.
export const scriptSharedOriginal = {
  git: "e4fdd2cec1358b513216f05f6061d0986f1dab44",
  sources: {
    Studio: {
      bytes: 39296,
      sha256:
        "22f107264b012f23dce5b9e2a22457841a4e97f229ae73cfbc6f304f39800598",
    },
    Editor: {
      bytes: 59872,
      sha256:
        "63a7940bbd6e29c49a5d1cf8e91a9e298b0864fc32f8363890e1a3273a53bb41",
    },
    Navigation: {
      bytes: 13469,
      sha256:
        "630bbc2e0943a5e2450ca9c32dcf0f4c983d646c185532139438aac3b0788120",
    },
    Presentation: {
      bytes: 3834,
      sha256:
        "a6d3b7c1106d0970ffac8cef29e5e00e71de4f561f9c162f0fac419ca85c8694",
    },
  },
  dialog: {
    raw: 'export function StudioDialog({\n  title,\n  children,\n  onClose,\n  compact = false,\n}: {\n  title: string;\n  children: ReactNode;\n  onClose: () => void;\n  compact?: boolean;\n}) {\n  const dialog = useRef<HTMLDialogElement>(null);\n  useModal(dialog);\n  return (\n    <dialog\n      ref={dialog}\n      className={`create-dialog script-dialog${compact ? " script-dialog-compact" : ""}`}\n      aria-label={title}\n      onCancel={(e) => {\n        e.preventDefault();\n        onClose();\n      }}\n    >\n      <header>\n        <h2>{title}</h2>\n        <button\n          type="button"\n          className="icon-button"\n          aria-label="关闭"\n          onClick={onClose}\n        >\n          <X />\n        </button>\n      </header>\n      {children}\n    </dialog>\n  );\n}',
    sha256: "e090540c06501b5d4b1edaf1a2ba1b42b37f2e1b82a439837584fed48a2352cc",
  },
  labels: {
    raw: 'export const scriptStatusLabels = {\n  draft: "草稿",\n  "in-review": "待审",\n  approved: "已批准",\n  locked: "已锁稿",\n};',
    sha256: "fb7f305e0c62fe4d9e6fd165aa10dd6acabe44f78bed0e5a81b60e5430e4535c",
  },
  navigationLabels: {
    raw: 'const statuses = {\n  draft: "草稿",\n  "in-review": "待审",\n  approved: "已批准",\n  locked: "已锁稿",\n};',
    sha256: "2d69db4d776a0c40f34e5b7a0de08d7f519e2754230fd21bf5e446edef278ef5",
  },
  consumers: [
    {
      source: "Studio",
      name: "ExportDialog",
      raw: '<StudioDialog title="导出 Word" onClose={onClose}>',
    },
    {
      source: "Studio",
      name: "CreateDialog",
      raw: "<StudioDialog title={title} onClose={onClose} compact>",
    },
    {
      source: "Studio",
      name: "CreateItemDialog",
      raw: "<StudioDialog title={scriptCreateLabels[kind]} onClose={onClose} compact>",
    },
    {
      source: "Studio",
      name: "ProductionSettings",
      raw: '<StudioDialog title="剧本设置" onClose={onClose}>',
    },
    {
      source: "Editor",
      name: "NoteDialog",
      raw: "<StudioDialog title={title} onClose={onClose} compact>",
    },
    {
      source: "Editor",
      name: "GenerationDialog",
      raw: "<StudioDialog title={`准备${names[purpose]}请求`} onClose={onClose}>",
    },
    {
      source: "Editor",
      name: "SourceDialog",
      raw: '<StudioDialog title="引用项目原文" onClose={onClose}>',
    },
  ],
} as const;
