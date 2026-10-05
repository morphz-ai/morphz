import assert from "node:assert/strict";

export type DesktopLifecycleEvidence = {
  runtimePids: number[];
  firstMainPid: number;
  activatedMainPid: number;
  relaunchedMainPid: number;
  windowCountAfterClose: number;
  nativeQuit: {
    beforeQuit: number;
    willQuit: number;
    quitCodes: number[];
    exitCode: number | null;
    signal: string | null;
  };
  initialIdentity: { centerId: string; principalId: string; profile: string };
  activatedIdentity: { centerId: string; principalId: string; profile: string };
  relaunchedIdentity: {
    centerId: string;
    principalId: string;
    profile: string;
  };
  draftSnapshots: Array<{ owner: string; key: string; raw: string }>;
  providerCallsBeforeRetries: number;
  providerCallsAfterRetries: number;
  acceptedInputIds: string[];
  finalInputIds: string[];
  replyRoots: string[];
  expectedRoots: string[];
  physicalJobCount: number;
  originalBeforeQuit: unknown;
  originalAfterRelaunch: unknown;
  permissionBeforeQuit: unknown;
  permissionAfterRelaunch: unknown;
};

/** These are conjunctive observations, not a timer, a window screenshot or
 * a call to Host.close pretending that the native application actually quit. */
export function assertDesktopLifecycle(evidence: DesktopLifecycleEvidence) {
  assert.ok(evidence.runtimePids.length >= 4);
  assert.ok(evidence.runtimePids.every((pid) => pid > 0));
  assert.equal(new Set(evidence.runtimePids).size, 1, "Runtime never restarts");
  assert.ok(evidence.firstMainPid > 0 && evidence.relaunchedMainPid > 0);
  assert.equal(evidence.activatedMainPid, evidence.firstMainPid);
  assert.notEqual(evidence.relaunchedMainPid, evidence.firstMainPid);
  assert.equal(evidence.windowCountAfterClose, 0);
  assert.ok(evidence.nativeQuit.beforeQuit >= 1);
  assert.equal(evidence.nativeQuit.willQuit, 1);
  assert.deepEqual(evidence.nativeQuit.quitCodes, [0]);
  assert.equal(evidence.nativeQuit.exitCode, 0, "Actual native main must exit");
  assert.equal(
    evidence.nativeQuit.signal,
    null,
    "A killed main is not normal quit",
  );
  assert.deepEqual(evidence.activatedIdentity, evidence.initialIdentity);
  assert.deepEqual(evidence.relaunchedIdentity, evidence.initialIdentity);
  assert.equal(evidence.draftSnapshots.length, 3);
  assert.ok(
    evidence.draftSnapshots.every(
      (draft) => draft.owner && draft.key && draft.raw,
    ),
    "Each lifecycle stage retains actual non-empty scoped draft bytes",
  );
  assert.deepEqual(evidence.draftSnapshots[1], evidence.draftSnapshots[0]);
  assert.deepEqual(evidence.draftSnapshots[2], evidence.draftSnapshots[0]);
  assert.equal(
    evidence.providerCallsAfterRetries,
    evidence.providerCallsBeforeRetries,
  );
  assert.deepEqual(
    [...evidence.finalInputIds].sort(),
    [...evidence.acceptedInputIds].sort(),
  );
  assert.equal(new Set(evidence.acceptedInputIds).size, 2);
  assert.deepEqual(
    [...evidence.replyRoots].sort(),
    [...evidence.expectedRoots].sort(),
  );
  assert.equal(new Set(evidence.expectedRoots).size, 2);
  assert.equal(evidence.physicalJobCount, 1);
  assert.deepEqual(evidence.originalAfterRelaunch, evidence.originalBeforeQuit);
  assert.deepEqual(
    evidence.permissionAfterRelaunch,
    evidence.permissionBeforeQuit,
  );
}
