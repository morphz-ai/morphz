import { randomUUID } from "node:crypto";
import {
  localAccess,
  type AccessContext,
  type Artifact,
  type RecordedInput,
  type Workspace,
} from "../packages/core/src/model.js";

type Project = Workspace["projects"][number];
type Relation = Workspace["relations"][number];

/** Explicit renderer DTO seeds, not a domain operation executor.
 * No authorization, CAS, receipts, SQL, persistence or retry semantics;
 * tests requiring those guarantees must use a real Platform/app domain Host. */
export function viewModelFixture() {
  const now = "2026-09-13T00:00:00.000Z";
  const projects: Project[] = [
    {
      id: "first-project",
      title: "我的项目",
      members: ["local-owner", "morphz-service"],
      createdAt: now,
    },
    ...(
      [
        ["local-worktable", "desk", "未归项目"],
        ["local-inbox", "inbox", "事项"],
        ["local-dialogue", "dialogue", "对话"],
      ] as const
    ).map(([id, kind, title]) => ({
      id,
      kind,
      title,
      ownerPrincipalId: "local-owner",
      members: ["local-owner", "morphz-service"],
      createdAt: now,
    })),
  ];
  const state: Workspace = {
    schemaVersion: 1,
    id: "local-workspace",
    name: "我的工作空间",
    revision: 0,
    principals: [
      { id: "local-owner", name: "我" },
      { id: "morphz-service", name: "Morphz" },
    ],
    actants: [
      {
        id: "local-human",
        kind: "human",
        name: "我",
        principalId: "local-owner",
      },
      {
        id: "morphz-agent",
        kind: "agent",
        name: "Morphz",
        principalId: "morphz-service",
      },
    ],
    projects,
    conversations: projects.map((project) => ({
      id: project.id,
      projectId: project.id,
      title: "默认对话",
      revision: 1,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    })),
    scriptProductions: [],
    scriptPreparations: [],
    artifacts: [],
    bookmarks: [],
    readingMarks: [],
    readingStates: [],
    taskOrder: [],
    taskOrderRevision: 0,
    applications: [],
    applicationInstances: [],
    relations: [],
    annotations: [],
    inputs: [],
    taskResponses: [],
  };
  return {
    state,
    seedProject(input: Pick<Project, "title" | "members"> & Partial<Project>) {
      const project: Project = {
        id: randomUUID(),
        createdAt: now,
        ...structuredClone(input),
      };
      state.projects.push(project);
      return project;
    },
    seedArtifact(
      input: Pick<Artifact, "projectId" | "title" | "content"> &
        Partial<Artifact>,
    ) {
      const author: AccessContext = input.createdBy ?? localAccess;
      const createdAt = input.createdAt ?? now;
      const artifact: Artifact = {
        id: randomUUID(),
        revision: 1,
        source: null,
        createdBy: structuredClone(author),
        createdAt,
        updatedAt: createdAt,
        versions: [
          {
            revision: input.revision ?? 1,
            title: input.title,
            content: structuredClone(input.content),
            author: structuredClone(author),
            createdAt,
          },
        ],
        ...structuredClone(input),
      };
      state.artifacts.push(artifact);
      return artifact;
    },
    seedInput(
      input: Omit<RecordedInput, "id" | "author" | "createdAt" | "status"> &
        Partial<Pick<RecordedInput, "id" | "author" | "createdAt">>,
    ) {
      const recorded: RecordedInput = {
        id: randomUUID(),
        author: structuredClone(localAccess),
        createdAt: now,
        status: "recorded",
        ...structuredClone(input),
      };
      state.inputs.push(recorded);
      return recorded;
    },
    seedRelation(
      input: Pick<Relation, "fromId" | "toId" | "type"> & Partial<Relation>,
    ) {
      const relation: Relation = {
        id: randomUUID(),
        createdBy: structuredClone(localAccess),
        createdAt: now,
        ...structuredClone(input),
      };
      state.relations.push(relation);
      return relation;
    },
  };
}
