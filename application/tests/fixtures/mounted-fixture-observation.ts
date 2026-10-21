import { performance } from "node:perf_hooks";
import type { TestContext } from "node:test";
import type { Page, Request } from "@playwright/test";

// Failure-only observation: no CDP, browser evaluation, timers, warmup, retries or waits.
// Request paths are synthetic fixture/module paths; never persist headers/bodies.
export function mountedFixtureObservation(context: TestContext, scope: string) {
  const began = performance.now(),
    cpu = process.cpuUsage();
  const loop = performance.eventLoopUtilization();
  const pages: Array<{
    lane: string;
    attachedMs: number;
    pending: Map<Request, { path: string; kind: string; at: number }>;
    events: Array<{ kind: string; atMs: number; detail?: string }>;
    finished: number;
    slow: Array<{ path: string; durationMs: number }>;
  }> = [];
  const elapsed = () => Math.round(performance.now() - began);
  const stages: Array<{
    phase: string;
    elapsedMs: number;
    cpuMs: number;
    eventLoopUtilization: ReturnType<typeof performance.eventLoopUtilization>;
  }> = [];
  let complete = false,
    reports = 0;
  function stage(phase: string) {
    const used = process.cpuUsage(cpu);
    stages.push({
      phase,
      elapsedMs: elapsed(),
      cpuMs: (used.user + used.system) / 1000,
      eventLoopUtilization: performance.eventLoopUtilization(loop),
    });
    if (stages.length > 32) stages.shift();
  }
  function report(reason: string) {
    if (reports++ >= 2) return;
    stage(reason);
    context.diagnostic(
      JSON.stringify({
        fixtureObservation: scope,
        reason,
        at: new Date().toISOString(),
        stages,
        pages: pages
          .slice(-12)
          .map(({ lane, attachedMs, pending, events, finished, slow }) => ({
            lane,
            attachedMs,
            finished,
            pendingCount: pending.size,
            pending: [...pending.values()]
              .sort((a, b) => a.at - b.at)
              .slice(0, 12)
              .map(({ path, kind, at }) => ({
                path,
                kind,
                elapsedMs: elapsed() - at,
              })),
            events: events.slice(-12),
            slow: [...slow]
              .sort((a, b) => b.durationMs - a.durationMs)
              .slice(0, 8),
          })),
      }),
    );
  }
  context.after(() => {
    if (!complete) report("fixture-incomplete");
  });
  function observe(page: Page, lane: string) {
    const record = {
      lane,
      attachedMs: elapsed(),
      pending: new Map<Request, { path: string; kind: string; at: number }>(),
      events: [] as Array<{ kind: string; atMs: number; detail?: string }>,
      finished: 0,
      slow: [] as Array<{ path: string; durationMs: number }>,
    };
    pages.push(record);
    const event = (kind: string, detail?: string) => {
      record.events.push({ kind, atMs: elapsed(), detail });
      if (record.events.length > 24) record.events.shift();
    };
    page.on("request", (request) => {
      const url = new URL(request.url());
      record.pending.set(request, {
        path: url.pathname,
        kind: request.resourceType(),
        at: elapsed(),
      });
    });
    const finish = (request: Request) => {
      const found = record.pending.get(request);
      if (found && elapsed() - found.at >= 1000) {
        record.slow.push({
          path: found.path,
          durationMs: elapsed() - found.at,
        });
        record.slow.sort((a, b) => b.durationMs - a.durationMs);
        record.slow.length = Math.min(record.slow.length, 8);
      }
      record.pending.delete(request);
      record.finished++;
    };
    page.on("requestfinished", finish);
    page.on("requestfailed", (request) => {
      event(
        "requestfailed",
        new URL(request.url()).pathname + ": " + request.failure()?.errorText,
      );
      finish(request);
    });
    page.on("pageerror", (error) => event("pageerror", error.message));
    page.on("domcontentloaded", () => event("domcontentloaded"));
    page.on("load", () => event("load"));
    page.on("crash", () => event("crash"));
    page.on("close", () => event("close"));
  }
  stage("test-enter");
  return {
    stage,
    observe,
    report,
    complete() {
      complete = true;
    },
  };
}
