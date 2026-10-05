import test from "node:test";
import assert from "node:assert/strict";
import {
  assertDesktopLifecycle,
  type DesktopLifecycleEvidence,
} from "../scripts/reliability-desktop-model.js";

const valid = (): DesktopLifecycleEvidence => ({
  runtimePids: [100, 100, 100, 100],
  firstMainPid: 200,
  activatedMainPid: 200,
  relaunchedMainPid: 300,
  windowCountAfterClose: 0,
  nativeQuit: {
    beforeQuit: 2,
    willQuit: 1,
    quitCodes: [0],
    exitCode: 0,
    signal: null,
  },
  initialIdentity: {
    centerId: "center",
    principalId: "human",
    profile: "/fixture/profile",
  },
  activatedIdentity: {
    centerId: "center",
    principalId: "human",
    profile: "/fixture/profile",
  },
  relaunchedIdentity: {
    centerId: "center",
    principalId: "human",
    profile: "/fixture/profile",
  },
  draftSnapshots: Array.from({ length: 3 }, () => ({
    owner: "owner",
    key: "scoped:key",
    raw: "exact unsent bytes",
  })),
  providerCallsBeforeRetries: 3,
  providerCallsAfterRetries: 3,
  acceptedInputIds: ["A", "B"],
  finalInputIds: ["B", "A"],
  expectedRoots: ["root-A", "root-B"],
  replyRoots: ["root-B", "root-A"],
  physicalJobCount: 1,
  originalBeforeQuit: {
    contentId: "original",
    revision: 1,
    markdown: "exact original bytes",
  },
  originalAfterRelaunch: {
    contentId: "original",
    revision: 1,
    markdown: "exact original bytes",
  },
  permissionBeforeQuit: {
    permissionMode: "request_approval",
    sandboxMode: "workspace-write",
  },
  permissionAfterRelaunch: {
    permissionMode: "request_approval",
    sandboxMode: "workspace-write",
  },
});

test("native lifecycle oracle rejects Host-close-only, force-kill, restarted Runtime and identity drift", () => {
  assertDesktopLifecycle(valid());
  for (const mutate of [
    (e: DesktopLifecycleEvidence) => {
      e.nativeQuit.exitCode = null;
    },
    (e: DesktopLifecycleEvidence) => {
      e.nativeQuit.signal = "SIGKILL";
    },
    (e: DesktopLifecycleEvidence) => {
      e.nativeQuit.willQuit = 0;
    },
    (e: DesktopLifecycleEvidence) => {
      e.runtimePids[3] = 101;
    },
    (e: DesktopLifecycleEvidence) => {
      e.activatedMainPid = 201;
    },
    (e: DesktopLifecycleEvidence) => {
      e.relaunchedMainPid = 200;
    },
    (e: DesktopLifecycleEvidence) => {
      e.relaunchedIdentity.profile = "/other/profile";
    },
    (e: DesktopLifecycleEvidence) => {
      e.windowCountAfterClose = 1;
    },
  ]) {
    const e = valid();
    mutate(e);
    assert.throws(() => assertDesktopLifecycle(e));
  }
});

test("native lifecycle oracle rejects draft loss/submission, reply or Job replay, wrong original and authority expansion", () => {
  for (const mutate of [
    (e: DesktopLifecycleEvidence) => {
      e.draftSnapshots[1]!.raw = "altered";
    },
    (e: DesktopLifecycleEvidence) => {
      for (const draft of e.draftSnapshots) draft.raw = "";
    },
    (e: DesktopLifecycleEvidence) => {
      e.draftSnapshots[2]!.owner = "new-owner";
    },
    (e: DesktopLifecycleEvidence) => {
      e.finalInputIds.push("unsent-draft");
    },
    (e: DesktopLifecycleEvidence) => {
      e.replyRoots.push("root-A");
    },
    (e: DesktopLifecycleEvidence) => {
      e.physicalJobCount = 2;
    },
    (e: DesktopLifecycleEvidence) => {
      e.providerCallsAfterRetries++;
    },
    (e: DesktopLifecycleEvidence) => {
      e.originalAfterRelaunch = { markdown: "copy" };
    },
    (e: DesktopLifecycleEvidence) => {
      e.permissionAfterRelaunch = { permissionMode: "full_access" };
    },
  ]) {
    const e = valid();
    mutate(e);
    assert.throws(() => assertDesktopLifecycle(e));
  }
});
