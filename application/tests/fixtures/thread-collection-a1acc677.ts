import {
  activeExecutionThreads,
  type ConversationRuntime,
} from "../../packages/core/src/conversation.js";
import type { ExecutionScope } from "../../packages/core/src/execution.js";
import type {
  RecordedInput,
  Workspace,
} from "../../packages/core/src/model.js";
import {
  executionActivityStatus,
  executionActivityThreads,
  executionActivityRoots,
  executionActivityDescendants,
  executionActivityDateGroups,
  type ActivityThread,
} from "../../apps/web/src/execution-activity.js";
// Historical migration oracle: 13 complete declarations independently read from actual Git a1acc677.
// The existing domain helpers are deliberately shared; this archive freezes only the moved collection recipes.
// No Git invocation or current-renderer whole-file lock is used in ordinary CI.

export const fixedThreadMetadata = {
  git: "a1acc677402045068384a73f8f72a2d8c28f6b1e",
  sources: {
    "Conversation.tsx": {
      path: "application/apps/web/src/Conversation.tsx",
      sha256:
        "676df688b81c088cfa8ff2b1f6d635fb5822541e7b9282eadf42f7268b10eaf5",
      bytes: 50424,
    },
    "ExecutionSidebar.tsx": {
      path: "application/apps/web/src/ExecutionSidebar.tsx",
      sha256:
        "a60f7813cb98259e36a1d383cc99ed98ebde0766ed2e19fe1814df5e2a344a97",
      bytes: 19196,
    },
  },
  spans: {
    activeBranches: {
      file: "Conversation.tsx",
      sha256:
        "36d388056ce045b05f4caa08539d3bd682df3907459bc9270178ac3840af727e",
      line: 730,
    },
    activeBranch: {
      file: "Conversation.tsx",
      sha256:
        "e7264c403b55d0db9b6031e33a3b2d00838cc91bacc088ee66d0f620d918dffc",
      line: 736,
    },
    branchStatuses: {
      file: "Conversation.tsx",
      sha256:
        "ffe0a75b3563ef73f4f62f19c01307c8330624023762bb5cd96e377255b15c01",
      line: 737,
    },
    workStatus: {
      file: "Conversation.tsx",
      sha256:
        "d3ffdd9b3b3d8bdaba231283f0fad3992571858dd4d4df5bdbb21dbebce40463",
      line: 740,
    },
    activityThreads: {
      file: "ExecutionSidebar.tsx",
      sha256:
        "55d69fadef86a047f19a5d595f855a5d9ba3b07ec6616ccf3d1fbe537fba27c9",
      line: 107,
    },
    groupedActivities: {
      file: "ExecutionSidebar.tsx",
      sha256:
        "00c4ec00e369cc81eda060490fa5c65e740f13aab0d1b8640689e682c09c2c2c",
      line: 114,
    },
    hasOpenWork: {
      file: "ExecutionSidebar.tsx",
      sha256:
        "05393d0cdf4dbb3092d9b880a477b07c431c0ab7ce40f48bcf2ac1ba10d9b6bc",
      line: 115,
    },
    active: {
      file: "ExecutionSidebar.tsx",
      sha256:
        "2b0b739177198732cdf14b80afe715812ff84fabca21ec004bf14fd3f9921392",
      line: 120,
    },
    recent: {
      file: "ExecutionSidebar.tsx",
      sha256:
        "3506b93fa909d10c31a9c609de1f363b5beed0f28163f5bd00c740da9e470c78",
      line: 121,
    },
    activeCount: {
      file: "ExecutionSidebar.tsx",
      sha256:
        "7a08369d3d19127cd77c3d48898108536b5216e1bdad7a7d4b510ea54d3cf1f2",
      line: 124,
    },
    activityAvailable: {
      file: "ExecutionSidebar.tsx",
      sha256:
        "e862b0398b58e301be39162ba21b0ccddf2fc858078bfce8b9ee321bd6a56a57",
      line: 125,
    },
    activityComplete: {
      file: "ExecutionSidebar.tsx",
      sha256:
        "313c37af26ef79b5c722153c00d22d2bc8d689ca68e1fe7273e4ea3410fdc80c",
      line: 127,
    },
    activitySummary: {
      file: "ExecutionSidebar.tsx",
      sha256:
        "b58305c8debcf0ad1056cb37134bdd4267bba00702043434d7940d325d641cc7",
      line: 131,
    },
  },
} as const;

export const fixedThreadDeclarations = {
  activeBranches:
    "const activeBranches =\n                item && client.online\n                  ? activeExecutionThreads(runtime).filter(\n                      (t) => t.inputId === item.id,\n                    )\n                  : [];",
  activeBranch: "const activeBranch = activeBranches.length > 0;",
  branchStatuses:
    "const branchStatuses = activeBranches.map((thread) =>\n                executionActivityStatus(thread, true),\n              );",
  workStatus:
    'const workStatus =\n                branchStatuses.find((s) => s.kind === "running") ??\n                branchStatuses.find((s) => s.kind === "unknown") ??\n                branchStatuses.find((s) => s.kind === "paused") ??\n                branchStatuses[0];',
  activityThreads:
    "const activityThreads = executionActivityThreads(\n    state,\n    threads,\n    scope,\n    allWork,\n    !client.boot!.capabilities.teamAuthentication,\n  );",
  groupedActivities:
    "const groupedActivities = executionActivityRoots(activityThreads);",
  hasOpenWork:
    'const hasOpenWork = (t: ActivityThread) =>\n    t.lifecycle === "open" ||\n    executionActivityDescendants(t, activityThreads).some(\n      (child) => child.lifecycle === "open",\n    );',
  active: "const active = groupedActivities.filter(hasOpenWork);",
  recent:
    "const recent = executionActivityDateGroups(\n    groupedActivities.filter((t) => !hasOpenWork(t)),\n  );",
  activeCount: "const activeCount = active.length;",
  activityAvailable:
    "const activityAvailable =\n    runtime.connected && runtime.activity?.available === true;",
  activityComplete:
    "const activityComplete = activityAvailable && !runtime.activity?.truncated;",
  activitySummary:
    'const activitySummary = !activityAvailable\n    ? "工作状态待核对"\n    : runtime.activity?.truncated\n      ? activeCount\n        ? `至少 ${activeCount} 项进行中`\n        : "工作状态待核对"\n      : `${activeCount} 项进行中`;',
} as const;

export function fixedInputExecutionActivityPresentation(
  runtime: ConversationRuntime,
  item: Pick<RecordedInput, "id"> | null | undefined,
  online: boolean | null | undefined,
) {
  const activeBranches =
    item && online
      ? activeExecutionThreads(runtime).filter((t) => t.inputId === item.id)
      : [];
  const activeBranch = activeBranches.length > 0;
  const branchStatuses = activeBranches.map((thread) =>
    executionActivityStatus(thread, true),
  );
  const workStatus =
    branchStatuses.find((s) => s.kind === "running") ??
    branchStatuses.find((s) => s.kind === "unknown") ??
    branchStatuses.find((s) => s.kind === "paused") ??
    branchStatuses[0];
  return { activeBranch, workStatus };
}

export function fixedExecutionActivityOverview(
  state: Workspace,
  threads: readonly ActivityThread[],
  scope: ExecutionScope,
  allWork: boolean,
  sharedDefault: boolean,
  runtime: ConversationRuntime,
) {
  const activityThreads = executionActivityThreads(
    state,
    threads,
    scope,
    allWork,
    sharedDefault,
  );
  const groupedActivities = executionActivityRoots(activityThreads);
  const hasOpenWork = (t: ActivityThread) =>
    t.lifecycle === "open" ||
    executionActivityDescendants(t, activityThreads).some(
      (child) => child.lifecycle === "open",
    );
  const active = groupedActivities.filter(hasOpenWork);
  const recent = executionActivityDateGroups(
    groupedActivities.filter((t) => !hasOpenWork(t)),
  );
  const activeCount = active.length;
  const activityAvailable =
    runtime.connected && runtime.activity?.available === true;
  const activityComplete = activityAvailable && !runtime.activity?.truncated;
  return {
    activityThreads,
    active,
    recent,
    activeCount,
    activityAvailable,
    activityComplete,
  };
}

export function fixedExecutionActivityOverviewSummary(
  runtime: ConversationRuntime,
  activityAvailable: boolean,
  activeCount: number,
) {
  const activitySummary = !activityAvailable
    ? "工作状态待核对"
    : runtime.activity?.truncated
      ? activeCount
        ? `至少 ${activeCount} 项进行中`
        : "工作状态待核对"
      : `${activeCount} 项进行中`;
  return activitySummary;
}
