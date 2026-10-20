import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Browser, Frame, Page } from "@playwright/test";
import {
  documentReport,
  withControlledPairedResource,
  type NativePacket,
  type PairedDocumentReport,
} from "./cognitive-document-paired-port-mounted.js";

/** CONTROLLED parser-order instrumentation, not an unchanged-wrapper E2E test.
 * The actual production prefix executes in Chromium after this observer and
 * before the unchanged author. The native port remains lexical; no frames,
 * acknowledgements or MessagePort delivery events are fabricated or replayed.
 * No Playwright initScript or CDP scheduling is used. */
const documentGate = String.raw`(() => {
 if(location.href!=="about:srcdoc")throw Error("Controlled gate requires the actual srcdoc Document.");
 const previous=window.pairedNativeGateRegistration;
 if(previous){
  if(previous.document!==document)throw Error("Fixture instrumentation changed Document.");
  previous.duplicateExecutions++;
  /* SAME_DOCUMENT_INSTRUMENTATION_GUARD */ return;
 }
 if(!previous&&typeof window.__morphzCognitiveDocument==="function"){
  const message="Fixture instrumentation installed too late: production facade already exists.";
  window.pairedNativeGateFailure=message;throw Error(message);
 }
 const registration=previous??{document,duplicateExecutions:0};
 window.pairedNativeGateRegistration=registration;
 const installations=(window.pairedNativeGateInstallations??=[]);
 const installation={href:location.href,readyState:document.readyState,
  facadePresent:typeof window.__morphzCognitiveDocument==="function",
  priorGatePresent:!!window.pairedNativeGate,posts:0,wirePosts:0,parserReadyPosts:0,starts:0};
 installations.push(installation);
 const nativeStart=MessagePort.prototype.start,nativePost=MessagePort.prototype.postMessage;
 const apply=Reflect.apply,clone=structuredClone.bind(window);
 let held=__HOLD_DOC__,target=null,heldStarts=0;
 const posts=[],attempts=[];
 MessagePort.prototype.start=function(...args){
  installation.starts++;
  if(target===null)target=this;
  if(this===target&&held){heldStarts++;return;}
  return apply(nativeStart,this,args);
 };
 MessagePort.prototype.postMessage=function(...args){
  attempts.push(clone(args[0]));
  const result=apply(nativePost,this,args);
  installation.posts++;if(args[0]?.kind==="wire")installation.wirePosts++;if(args[0]?.kind==="parser-ready")installation.parserReadyPosts++;
  posts.push(clone(args[0]));return result;
 };
 window.pairedNativeGate={
  release(){if(!target||!held)throw Error("Missing/unexpected native receive-start hold");held=false;MessagePort.prototype.start=nativeStart;apply(nativeStart,target,[]);},
  report(){return{held,heldStarts,posts:clone(posts),attempts:clone(attempts),installations:clone(installations),duplicateExecutions:registration.duplicateExecutions};}
 };
})();`;

export type ControlledDocumentReport = PairedDocumentReport & {
  held: boolean;
  heldStarts: number;
  duplicateExecutions: number;
  posts: NativePacket[];
  attempts: NativePacket[];
  installations: Array<{
    href: string;
    readyState: string;
    facadePresent: boolean;
    priorGatePresent: boolean;
    posts: number;
    wirePosts: number;
    parserReadyPosts: number;
    starts: number;
  }>;
};

export async function controlledDocumentReport(
  frame: Frame,
): Promise<ControlledDocumentReport> {
  return {
    ...(await documentReport(frame)),
    ...(await frame.evaluate(() =>
      Reflect.get(window, "pairedNativeGate").report(),
    )),
  };
}

export async function withControlledPrefix(
  browser: Browser,
  options: {
    holdHost?: boolean;
    holdDocument?: boolean;
    controlledDuplicateGuardRemoval?: boolean;
    /** Explicit positive oracle: only an already-retired callback skips check. */
    controlledRetiredGuardRemoval?: boolean;
  },
  work: (
    page: Page,
    frame: Frame,
    instrumentation: { repeatInitScript: () => Promise<void> },
  ) => Promise<void>,
) {
  let instrumentation = documentGate.replace(
    "__HOLD_DOC__",
    JSON.stringify(options.holdDocument ?? false),
  );
  if (options.controlledDuplicateGuardRemoval) {
    const seam = "/* SAME_DOCUMENT_INSTRUMENTATION_GUARD */ return;";
    assert.equal(instrumentation.split(seam).length, 2);
    instrumentation = instrumentation.replace(
      seam,
      "/* CONTROLLED old fixture: overwrite the live native observer. */",
    );
  }
  assert.equal(instrumentation.includes("</script"), false);

  await withControlledPairedResource(
    browser,
    { holdHost: options.holdHost },
    (original) => {
      // Decode only the fixed builder's actual JSON string literal. This is
      // executable production output, not a retyped implementation or source
      // inspection standing in for browser execution.
      const pattern = /inner\.srcdoc = ("(?:[^"\\]|\\[\s\S])*") \+ author;/g;
      const matches = [...original.html.matchAll(pattern)];
      assert.equal(matches.length, 1, "Exactly one fixed prefix literal.");
      const match = matches[0]!;
      const originalPrefix: string = JSON.parse(match[1]!);
      let executedPrefix = originalPrefix;
      if (options.controlledRetiredGuardRemoval) {
        const seam =
          "if (ready && subscriber !== null) subscriber(validated);\n      check();";
        assert.equal(executedPrefix.split(seam).length, 2);
        executedPrefix = executedPrefix.replace(
          seam,
          "if (ready && subscriber !== null) subscriber(validated);\n      if (!retired) check();",
        );
      }
      assert.equal(
        executedPrefix === originalPrefix,
        !options.controlledRetiredGuardRemoval,
      );
      const scriptAt = executedPrefix.indexOf("<script>");
      assert.ok(scriptAt > 0);
      assert.equal(executedPrefix.indexOf("<script>", scriptAt + 1), -1);
      assert.ok(executedPrefix.startsWith("<!doctype html><html><head>"));
      const observer = `<script>${instrumentation}</script>`;
      const instrumented =
        executedPrefix.slice(0, scriptAt) +
        observer +
        executedPrefix.slice(scriptAt);
      assert.equal(instrumented.replace(observer, ""), executedPrefix);
      const encoded = JSON.stringify(instrumented).replaceAll("<", "\\u003c");
      const html = original.html.replace(
        match[0],
        `inner.srcdoc = ${encoded} + author;`,
      );
      assert.equal(
        html.replace(`inner.srcdoc = ${encoded} + author;`, match[0]),
        original.html,
        "Only the declared prefix composition changed; author/hand-off stay exact.",
      );
      const sha = (text: string) =>
        createHash("sha256").update(text).digest("hex");
      console.info("CONTROLLED prefix browser boundary", {
        productionPrefixSha256: sha(originalPrefix),
        executedPrefixSha256: sha(executedPrefix),
        productionPrefixUnchanged: executedPrefix === originalPrefix,
        retiredGuardRemoval: !!options.controlledRetiredGuardRemoval,
        originalWrapperSha256: sha(original.html),
        controlledWrapperSha256: sha(html),
        contentSecurityPolicy: original.contentSecurityPolicy,
      });
      return new TextEncoder().encode(html);
    },
    async (page, frame) => {
      assert.equal(
        await frame.evaluate(
          () => Reflect.get(window, "pairedNativeGateFailure") ?? null,
        ),
        null,
      );
      const report = await controlledDocumentReport(frame);
      assert.equal(report.installations.length, 1);
      assert.equal(report.installations[0]!.readyState, "loading");
      assert.equal(report.installations[0]!.facadePresent, false);
      assert.equal(report.installations[0]!.priorGatePresent, false);
      await work(page, frame, {
        repeatInitScript: () => frame.evaluate(instrumentation),
      });
    },
  );
}
