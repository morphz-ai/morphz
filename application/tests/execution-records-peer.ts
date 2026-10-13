/** Test-only native projection peer over the original controlled facts.
 * It models the new Runtime response, not a production old-endpoint fallback.
 * Actual SQL/SDK/HTTP boundedness is tested against the Runtime separately. */
import type { RuntimeRequest } from "../packages/application/src/execution.js";

export function executionRecordsPeer(
  peer: RuntimeRequest,
  contextId: string,
): RuntimeRequest {
  return async (path, method, body) => {
    const url = new URL(path, "http://controlled.invalid");
    if (!url.pathname.endsWith("/execution-records"))
      return peer(path, method, body);
    const sessionId = decodeURIComponent(url.pathname.split("/").at(-2)!);
    const selected = url.searchParams.get("thread_id");
    const wanted = url.searchParams.has("thread_ids")
      ? (JSON.parse(url.searchParams.get("thread_ids")!) as string[])
      : undefined;
    const roots = url.searchParams.has("root_turn_ids")
      ? (JSON.parse(url.searchParams.get("root_turn_ids")!) as string[])
      : undefined;
    const metadataOnly = url.searchParams.get("metadata_only") === "true";
    const readJobs = async (threadId?: string) => {
      const raw = (await peer(
        "/api/execution-jobs?" +
          new URLSearchParams({
            session_id: sessionId,
            context_id: contextId,
            limit: "100",
            ...(threadId ? { thread_id: threadId } : {}),
          }),
      )) as any;
      return raw.jobs ?? [];
    };
    let jobs: any[] =
      !selected && !wanted
        ? (await readJobs()).filter(
            (job: any) =>
              job.session_id === sessionId && job.context_id === contextId,
          )
        : [];
    const rows = new Map<string, any>();
    const read = async (id: string) => {
      if (!rows.has(id)) {
        const value = (await peer(
          `/api/contexts/${encodeURIComponent(contextId)}/threads/${encodeURIComponent(id)}`,
        )) as any;
        rows.set(id, value.snapshot);
      }
      return rows.get(id);
    };
    let ids: string[] = [];
    let sourceRoot: string | null = null;
    let truncated = false;
    if (selected) {
      let ancestor = await read(selected);
      const seen = new Set<string>();
      for (;;) {
        const t = ancestor.thread;
        if (
          seen.has(t.id) ||
          seen.size >= 64 ||
          t.session_id !== sessionId ||
          t.context_id !== contextId
        )
          throw Error("无法核验执行来源");
        seen.add(t.id);
        if (
          ancestor.source?.context_id === contextId &&
          ancestor.source?.session_id === sessionId
        ) {
          sourceRoot = ancestor.source.root_turn_id;
          break;
        }
        if (!t.supervision?.parent_thread_id) {
          sourceRoot = t.root_turn_id;
          break;
        }
        ancestor = await read(t.supervision.parent_thread_id);
      }
      if (roots && !roots.includes(sourceRoot!))
        throw Error("执行不属于原始来源");
      ids = [selected];
      if (url.searchParams.get("include_descendants") === "true") {
        const family = (await peer(
          `/api/sessions/${sessionId}/threads/${selected}/family?limit=64`,
        )) as any;
        ids = family.threads.map((t: any) => t.id);
        truncated = family.has_more;
        for (const member of family.threads) {
          const value = await read(member.id),
            t = value.thread;
          if (
            t.root_turn_id !== member.root_turn_id ||
            t.supervision?.parent_thread_id !== member.parent_thread_id ||
            t.session_id !== sessionId ||
            t.context_id !== contextId
          )
            throw Error("执行归属不一致");
        }
      }
    } else ids = wanted ?? [...new Set(jobs.map((job) => job.thread_id))];
    await Promise.all(ids.map(read));
    if (!metadataOnly && (selected || wanted)) {
      jobs = (await Promise.all(ids.map(readJobs))).flat();
      jobs = [...new Map(jobs.map((job) => [job.id, job])).values()];
    }
    jobs = jobs
      .filter(
        (job) =>
          job.session_id === sessionId &&
          job.context_id === contextId &&
          ids.includes(job.thread_id) &&
          (!roots ||
            !!selected ||
            roots.includes(rows.get(job.thread_id)?.thread.root_turn_id)),
      )
      .slice(0, 100);
    if (!selected)
      ids = ids.filter((id) => jobs.some((job) => job.thread_id === id));
    const threads = await Promise.all(
      ids.map(async (id) => {
        const value = rows.get(id),
          t = value.thread;
        let annotations: unknown = value.response_annotations;
        if (
          !metadataOnly &&
          annotations === undefined &&
          t.generation !== undefined
        ) {
          try {
            annotations = await peer(
              `/api/sessions/${sessionId}/threads/${id}/annotations`,
            );
          } catch {
            /* Optional controlled metadata. */
          }
        }
        return {
          ...t,
          parent_thread_id: t.supervision?.parent_thread_id ?? null,
          generation: t.generation ?? 0,
          control_state: t.control_state ?? "active",
          lifecycle: t.lifecycle ?? "open",
          revision: t.revision ?? 1,
          phase: value.phase ?? "unknown",
          created_at: t.created_at ?? "2026-10-13T00:00:00Z",
          updated_at: t.updated_at ?? "2026-10-13T00:00:00Z",
          intent: value.intent ?? null,
          response_annotations: annotations,
        };
      }),
    );
    return {
      session_id: sessionId,
      context_id: contextId,
      selected_thread_id: selected,
      source_root_id: sourceRoot,
      limit: 100,
      has_more_jobs: false,
      threads_truncated: truncated,
      jobs: metadataOnly ? [] : jobs,
      threads,
    };
  };
}
