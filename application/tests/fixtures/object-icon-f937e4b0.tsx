// Test .tsx lives outside the web JSX-runtime configuration; only this import
// supplies its loader runtime. Both executable original declarations stay raw.
import React from "react";
import {
  FileText,
  BookOpen,
  Image,
  CircleCheck,
  Globe,
  Table2,
} from "lucide-react";
import type { Content } from "../../packages/core/src/model.js";

// The loader needs React for classic JSX; the full project uses automatic JSX.
// Keep that test-only runtime binding used in both configurations.
void React;

// Independent actual Git f937e4b0 archive; no candidate-derived old oracle.
// Source hashes are historical metadata, not current renderer locks.
export const objectIconOriginal = {
  git: "f937e4b03aa3fb82d75570d6dffcd4f41fda4f0e",
  sources: {
    ArtifactEditor: {
      sha256:
        "b5e0b9c687a786faa2dce8398f978c9d5a0289bb2a24436676708124861bb4e1",
      bytes: 31749,
    },
    ApplicationHost: {
      sha256:
        "9ee23b568de821ed93454ec64f39d4c6725f4c4aecb3e5af01c0c73203b04078",
      bytes: 37225,
    },
    Conversation: {
      sha256:
        "e70d9a1e2dcc0e34de032b5ba56b15301190ac0e76c176177e0e6f4a8cda10c9",
      bytes: 43302,
    },
    ObjectCollection: {
      sha256:
        "dd84a2e7197bb603d31b44ea4f72abccee08ea54d566a6eb8df7f6ab7cc5f25b",
      bytes: 25998,
    },
    LibraryDialogs: {
      sha256:
        "3e99c2ca8a8f67768e22f627c2437f310f17c315a1cb98bb74b0f2b2f52a16c6",
      bytes: 12997,
    },
  },
  declarations: {
    kindLabel:
      'export const kindLabel = {\n  document: "文档",\n  image: "图片",\n  task: "事项",\n  pdf: "PDF",\n  publication: "读物",\n  website: "网页链接",\n  interactive: "表格",\n};',
    ObjectIcon:
      'export function ObjectIcon({ kind }: { kind: Content["kind"] }) {\n  const Icon = {\n    document: FileText,\n    image: Image,\n    task: CircleCheck,\n    pdf: FileText,\n    publication: BookOpen,\n    website: Globe,\n    interactive: Table2,\n  }[kind];\n  return <Icon size={16} />;\n}',
  },
  icons: {
    ArtifactEditor: ["<ObjectIcon kind={artifact.content.kind} />"],
    ApplicationHost: [
      '<ObjectIcon\n                          kind={\n                            listingKind(entry) as Parameters<\n                              typeof ObjectIcon\n                            >[0]["kind"]\n                          }\n                        />',
    ],
    Conversation: [
      '<ObjectIcon\n                            kind={\n                              (artifact?.content.kind ??\n                                catalogEntry!.kind) as Parameters<\n                                typeof ObjectIcon\n                              >[0]["kind"]\n                            }\n                          />',
    ],
    ObjectCollection: [
      '<ObjectIcon\n                          kind={kind as Artifact["content"]["kind"]}\n                        />',
      "<ObjectIcon kind={a.content.kind} />",
    ],
    LibraryDialogs: [
      '<ObjectIcon\n                  kind={item.kind as Parameters<typeof ObjectIcon>[0]["kind"]}\n                />',
      "<ObjectIcon kind={hit.kind} />",
    ],
  },
  labels: {
    ArtifactEditor: ["kindLabel[artifact.content.kind]"],
    ApplicationHost: [
      "kindLabel[listingKind(entry) as keyof typeof kindLabel]",
      "kindLabel[\n                                  listingKind(entry) as keyof typeof kindLabel\n                                ]",
    ],
    Conversation: [],
    ObjectCollection: [
      "kindLabel[kind]",
      "kindLabel[kind as keyof typeof kindLabel]",
      "kindLabel[a.content.kind]",
    ],
    LibraryDialogs: [],
  },
  contexts: {
    ArtifactEditor: [
      {
        conditions: [],
        maps: [],
      },
    ],
    ApplicationHost: [
      {
        branch:
          'listingKind(entry) === "script" ? (\n                        <Film />\n                      ) : (\n                        <ObjectIcon\n                          kind={\n                            listingKind(entry) as Parameters<\n                              typeof ObjectIcon\n                            >[0]["kind"]\n                          }\n                        />\n                      )',
        conditions: ["!active"],
        maps: ["recent.map"],
      },
    ],
    Conversation: [
      {
        conditions: ["(artifact || catalogEntry)"],
        maps: ["timeline.map"],
      },
    ],
    ObjectCollection: [
      {
        branch:
          'kind === "script" ? (\n                        <Clapperboard />\n                      ) : knownKind ? (\n                        <ObjectIcon\n                          kind={kind as Artifact["content"]["kind"]}\n                        />\n                      ) : (\n                        <FilePlus2 />\n                      )',
        conditions: [],
        maps: ["visible.map"],
      },
      {
        conditions: [],
        maps: ["visible.map"],
      },
    ],
    LibraryDialogs: [
      {
        conditions: ["!query.trim()"],
        maps: ["recent.map"],
      },
      {
        conditions: [],
        maps: ["result?.hits.map"],
      },
    ],
  },
  labelRecipes: {
    ArtifactEditor: ["kindLabel[artifact.content.kind]"],
    ApplicationHost: [
      'listingKind(entry) === "script" ? "剧本" : (kindLabel[listingKind(entry) as keyof typeof kindLabel] ?? "内容")',
      'listingKind(entry) === "script"\n                              ? "剧本"\n                              : (kindLabel[\n                                  listingKind(entry) as keyof typeof kindLabel\n                                ] ?? "内容")',
    ],
    Conversation: [],
    ObjectCollection: [
      'kind === "all"\n                  ? "全部"\n                  : kind === "script"\n                    ? "剧本"\n                    : kindLabel[kind]',
      'kind === "script"\n                          ? "剧本"\n                          : knownKind\n                            ? kindLabel[kind as keyof typeof kindLabel]\n                            : "内容"',
      "kindLabel[a.content.kind]",
    ],
    LibraryDialogs: [],
  },
  labelContexts: {
    ArtifactEditor: [
      {
        conditions: ['artifact.content.kind !== "task" && !isPdf'],
        maps: [],
      },
    ],
    ApplicationHost: [
      {
        branch:
          'listingKind(entry) === "script" ? "剧本" : (kindLabel[listingKind(entry) as keyof typeof kindLabel] ?? "内容")',
        conditions: ["!active"],
        maps: ["recent.map"],
      },
      {
        branch:
          'listingKind(entry) === "script"\n                              ? "剧本"\n                              : (kindLabel[\n                                  listingKind(entry) as keyof typeof kindLabel\n                                ] ?? "内容")',
        conditions: ["!active"],
        maps: ["recent.map"],
      },
    ],
    Conversation: [],
    ObjectCollection: [
      {
        branch:
          'kind === "all"\n                  ? "全部"\n                  : kind === "script"\n                    ? "剧本"\n                    : kindLabel[kind]',
        conditions: [],
        maps: [
          '(\n              [\n                "all",\n                "document",\n                "pdf",\n                "image",\n                "interactive",\n                "script",\n              ] as const\n            ).map',
        ],
      },
      {
        branch:
          'kind === "script"\n                          ? "剧本"\n                          : knownKind\n                            ? kindLabel[kind as keyof typeof kindLabel]\n                            : "内容"',
        conditions: [],
        maps: ["visible.map"],
      },
      {
        conditions: [],
        maps: ["visible.map"],
      },
    ],
    LibraryDialogs: [],
  },
  knownKind: "knownKind = kind in kindLabel",
} as const;

export const kindLabel = {
  document: "文档",
  image: "图片",
  task: "事项",
  pdf: "PDF",
  publication: "读物",
  website: "网页链接",
  interactive: "表格",
};
export function ObjectIcon({ kind }: { kind: Content["kind"] }) {
  const Icon = {
    document: FileText,
    image: Image,
    task: CircleCheck,
    pdf: FileText,
    publication: BookOpen,
    website: Globe,
    interactive: Table2,
  }[kind];
  return <Icon size={16} />;
}
