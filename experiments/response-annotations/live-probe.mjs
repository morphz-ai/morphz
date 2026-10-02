// Explicit live mechanism experiment: synthetic facts only, no Runtime DB,
// original Profile/history, filesystem tools, or credentials in evidence.
// The native bridge uses an already configured model route; this driver never
// receives provider credentials. Each run has a hard model-request allowance.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { augmentTools, normalizeResponse, projectExecution } from './protocol.mjs';
import { ReplyStreamNormalizer } from './stream-content.mjs';

const binary = process.env.MORPHZ_ANNOTATIONS_BRIDGE ?? fileURLToPath(new URL('../../target/debug/response-annotations-probe', import.meta.url));
const output = process.env.MORPHZ_ANNOTATIONS_EVIDENCE ?? fileURLToPath(new URL('./live-evidence.json', import.meta.url));
const bridgeArgs = process.argv.slice(2);
const child = spawn(binary, bridgeArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
const lines = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 0;
let readyResolve, readyReject;
const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
const readyTimeout = setTimeout(() => readyReject(new Error('Native probe initialization deadline exceeded')), 30_000);
ready.then(() => clearTimeout(readyTimeout), () => clearTimeout(readyTimeout));
// Native errors must already be category-only; do not persist stderr/config.
child.stderr.on('data', () => {});
child.on('error', () => readyReject(new Error('Native probe bridge could not start')));
child.on('exit', code => {
  if (code !== 0) readyReject(new Error('Native probe bridge exited'));
  for (const request of pending.values()) request.reject(new Error('Native probe bridge exited during request'));
});
lines.on('line', line => {
  let value;
  try { value = JSON.parse(line); } catch { readyReject(new Error('Non-protocol bridge output rejected')); return; }
  if (value.kind === 'ready') { readyResolve(value); return; }
  const request = pending.get(value.request_id);
  if (value.kind === 'error') {
    evidence.nativeErrors ??= [];
    evidence.nativeErrors.push({
      requestId: value.request_id ?? null,
      category: value.category ?? 'unknown',
      clientCallCount: value.client_call_count ?? null,
      startedEventsThisCall: value.started_events_this_call ?? null,
      startedEventsTotal: value.started_events_total ?? null,
      httpRequestCount: value.http_request_count ?? null,
    });
    const error = new Error('Native probe failed: ' + String(value.category ?? 'unknown'));
    if (request) request.reject(error); else readyReject(error);
    return;
  }
  if (!request) return;
  if (value.kind === 'stream') {
    try { request.onEvent(value.event); }
    catch { request.reject(new Error('Native stream violated the normalization contract')); }
  }
  if (value.kind === 'result') { pending.delete(value.request_id); request.resolve(value); }
});

async function ask(messages, tools, onEvent) {
  const request_id = `annotations-probe-${++nextId}`;
  assert.ok(nextId <= 16, 'Total live usage allowance reached');
  const result = new Promise((resolve, reject) => pending.set(request_id, { resolve, reject, onEvent }));
  child.stdin.write(JSON.stringify({ request_id, messages, tools }) + '\n');
  const timeout = setTimeout(() => pending.get(request_id)?.reject(new Error('Native probe request deadline exceeded')), 180_000);
  try { return await result; } finally { clearTimeout(timeout); pending.delete(request_id); }
}

const workTool = {
  name: 'probe_read',
  description: 'Read one synthetic experiment fact. It does not read a file, contact a service, or change state.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['key'],
    properties: { key: { type: 'string', enum: ['system', 'architecture'] } },
  },
};
const annotationContract = `This caller enabled optional response annotations v1.
Work calls can carry _annotations. It is display metadata, not business arguments.
The current call intent describes what you are about to do. execution.title describes the ENTIRE user task (for example 核对系统与架构), never only this tool or current stage. Supply it only once, alongside the first work call, and omit it later. execution.progress describes current stage.
For a result you have already received, use observations[{ref: the exact observation_ref, result: a short Chinese interpretation}]. Never describe an unobserved future result.
Supply useful annotations alongside existing work, never issue a separate annotation-only turn.
For the final response use the sole reply({content, annotations}) terminal response form. This is not a work tool and does not require a tool-result continuation.
In that same reply supply execution.result as a short Chinese factual result summary and useful explanations of received observations.
Annotations are optional; never spend another request just to fill or fix them. Do not set status, permissions, identity or guessed percentages.`;

async function runCase({ enabled, retry }) {
  const name = `${retry ? 'retry' : 'serial'}-${enabled ? 'v1' : 'off'}`;
  const scope = { executionId: `synthetic-${name}`, generation: 1 };
  const tools = augmentTools([workTool], { enabled });
  const messages = [{
    role: 'system',
    content: `You are validating a low-level response protocol with synthetic facts only.
Complete the user request by calling probe_read with key system first, then in a later response call probe_read with key architecture, then deliver a Chinese final answer.
Use exactly one work call per work response. Do not combine the two reads into one response. Do not fabricate facts or use other tools.
If a read returns a retryable error, retry the same read once; otherwise do not repeat successful reads.
${enabled ? annotationContract : 'When all reads are finished, deliver ordinary final text without tool calls.'}`,
  }, {
    role: 'user', content: 'TEST_RESPONSE_ANNOTATIONS：请核对合成环境的操作系统与处理器架构，并用中文告诉我结果。',
  }];
  const observations = new Map();
  const got = new Map();
  const turns = [];
  const records = [];
  const runEvidence = { name, enabled, retry, requests: 0, turns, completed: false };
  evidence.runs.push(runEvidence);
  let injectedFailure = false;
  let observationSeq = 100;
  const allowance = retry ? 4 : 3;
  for (let turn = 1; turn <= allowance; turn++) {
    runEvidence.requests = turn;
    const start = performance.now();
    const publicText = [];
    const publicTextAt = [];
    const streamKinds = [];
    const stream = new ReplyStreamNormalizer({ enabled });
    const trace = { turn, streamKinds, completed: false };
    turns.push(trace);
    const result = await ask(messages, tools, event => {
      streamKinds.push(event.kind ?? event.type);
      for (const normalized of stream.push(event)) {
        if (normalized.kind === 'text_delta' || normalized.type === 'TextDelta') {
          publicText.push(normalized.text);
          publicTextAt.push(performance.now() - start);
        }
      }
    });
    const finishedAt = performance.now() - start;
    const raw = result.response;
    const likelyTerminal = got.size === 2 && (raw.tool_calls.length === 0 || raw.tool_calls.every(call => call.func_name === 'reply'));
    const normalized = normalizeResponse(raw, {
      enabled, scope, observations,
      producer: { eventId: `assistant-${name}-${turn}`, attemptId: `attempt-${name}-${turn}`, sequence: turn * 100 },
      executionFact: { scope, terminal: likelyTerminal, status: likelyTerminal ? 'completed' : 'running' },
    });
    records.push(...normalized.annotationRecords);
    const execution = normalized.executionResponse;
    Object.assign(trace, {
      turn, raw, businessCalls: execution.tool_calls,
      annotations: normalized.annotationRecords, diagnostics: normalized.diagnostics,
      streamKinds, publicText: publicText.join(''), firstPublicTextAt: publicTextAt[0] ?? null,
      publicTextDeltaCount: publicText.length,
      lastPublicTextAt: publicTextAt.at(-1) ?? null, finishedAt,
      usage: result.usage ?? null,
      nativeEvents: result.native_events ?? null,
      binding: result.binding ?? null,
      clientCallCount: result.client_call_count ?? null,
      startedEventsThisCall: result.started_events_this_call ?? null,
      startedEventsTotal: result.started_events_total ?? null,
      httpRequestCount: result.http_request_count ?? null,
      continuationPreserved: result.continuation_preserved ?? null,
      completed: true,
    });
    if (execution.tool_calls.length === 0) {
      assert.equal(got.size, 2, 'Premature delivery before both facts');
      assert.match(execution.content, /Linux/i);
      assert.match(execution.content, /ARM64|aarch64/i);
      assert.equal(trace.publicText, execution.content, 'Incremental public body differs from final body');
      assert.ok(trace.firstPublicTextAt !== null && trace.firstPublicTextAt < finishedAt, 'No public body increment before completion');
      assert.ok(!trace.publicText.includes('_annotations') && !trace.publicText.includes('"execution"'), 'Metadata leaked into public body');
      if (enabled) {
        assert.equal(raw.tool_calls.length, 1);
        assert.equal(raw.tool_calls[0].func_name, 'reply');
        assert.ok(records.some(record => record.kind === 'execution.title'), 'No initial title annotation');
        assert.ok(records.some(record => record.kind === 'execution.progress'), 'No stage annotation');
        assert.ok(records.some(record => record.kind === 'observation.result' && record.observationRef !== [...observations.keys()].at(-1)), 'No earlier result interpreted in later existing response');
        assert.ok(records.some(record => record.kind === 'execution.result'), 'No final execution result annotation');
        assert.ok(publicText.length > 1, 'Terminal content arrived atomically, not as multiple native increments');
        for (const trace of turns) {
          if (trace.nativeEvents?.continuation > 0 && trace.raw.tool_calls.length) {
            assert.equal(trace.continuationPreserved, true, 'Provider continuation supplied but not retained');
          }
        }
        assert.equal(normalized.diagnostics.length, 0, 'Terminal metadata violated the contract');
      }
      const projection = projectExecution({ scope, terminal: true, status: 'completed', terminalSequence: turn * 100 }, records);
      if (enabled) {
        assert.ok(projection.title, 'Bound title is absent from execution projection');
        assert.ok(projection.result, 'Bound terminal result is absent from execution projection');
        assert.equal(projection.title, records.find(record => record.kind === 'execution.title')?.value, 'Step update replaced the original execution title');
      }
      Object.assign(runEvidence, { projection, completed: true,
        nativeContinuationObserved: turns.some(trace => trace.nativeEvents?.continuation > 0) });
      return runEvidence;
    }
    assert.equal(execution.tool_calls.length, 1, 'Expected serial single work call');
    const call = execution.tool_calls[0];
    assert.equal(call.func_name, 'probe_read', 'Unexpected work tool');
    const args = JSON.parse(call.arguments);
    assert.deepEqual(Object.keys(args), ['key'], 'Annotation or unknown parameter reached business tool');
    assert.ok(['system', 'architecture'].includes(args.key));
    if (args.key === 'architecture') assert.ok(got.has('system'), 'Architecture read started before system result');
    assert.ok(!got.has(args.key), 'Successful read repeated');
    const ref = `@e${++observationSeq}`;
    const fail = retry && !injectedFailure && args.key === 'system';
    if (fail) injectedFailure = true;
    const value = args.key === 'system' ? 'Linux' : 'ARM64';
    if (!fail) got.set(args.key, value);
    const receipt = {
      status: fail ? 'error' : 'success', observation_ref: ref,
      tool_name: 'probe_read', result: fail ? { retryable: true, error: 'Synthetic temporary read error; retry this same key once.' } : { [args.key]: value },
    };
    observations.set(ref, { eventId: `output-${name}-${call.id}`, ...scope, provided: true, allowed: true });
    trace.receipt = receipt;
    // Replay exactly the raw provider arguments, not the stripped execution args.
    messages.push({ role: 'assistant', content: raw.content, tool_calls: raw.tool_calls.map(toolCall => ({ id: toolCall.id, type: toolCall.type, function: { name: toolCall.func_name, arguments: toolCall.arguments } })) });
    messages.push({ role: 'tool', content: JSON.stringify(receipt), tool_call_id: call.id });
  }
  throw new Error(`Run exceeded existing request count: ${name}`);
}

const evidence = { syntheticOnly: true, originalRuntimeModified: false, originalDataUsed: false, modelGate: false, runs: [] };
let previousClientRequests = 0;
try {
  const route = await ready;
  assert.equal(route.stream_entry, 'native_bound_with_options', 'Probe must use the production native-bound stream entry');
  evidence.route = route;
  const resumePath = process.env.MORPHZ_ANNOTATIONS_RESUME_SERIAL;
  if (resumePath) {
    // Reassess already-finished native serial samples rather than spending six
    // more requests to require optional provider state that was not supplied.
    const prior = JSON.parse(await readFile(resumePath, 'utf8'));
    assert.equal(prior.syntheticOnly, true);
    assert.equal(prior.route.stream_entry, route.stream_entry);
    assert.equal(prior.route.model, route.model);
    assert.equal(prior.failure, 'No real provider continuation was captured before final delivery');
    assert.deepEqual(prior.runs.map(run => run.name), ['serial-off', 'serial-v1']);
    for (const run of prior.runs) {
      assert.equal(run.requests, 3);
      assert.equal(run.turns.length, 3);
      assert.ok(run.turns.every(trace => trace.completed && trace.binding.physical_model === route.model && trace.nativeEvents.usage > 0));
      const last = run.turns.at(-1);
      assert.ok(last.publicTextDeltaCount > 1 && last.firstPublicTextAt < last.finishedAt);
      assert.equal(last.publicText, run.enabled ? JSON.parse(last.raw.tool_calls[0].arguments).content : last.raw.content);
      assert.ok(run.turns.every(trace => trace.diagnostics.length === 0));
      assert.ok(run.turns.every(trace => trace.nativeEvents.continuation === 0));
      const records = run.turns.flatMap(trace => trace.annotations);
      const scope = { executionId: `synthetic-${run.name}`, generation: 1 };
      const projection = projectExecution({ scope, terminal: true, status: 'completed', terminalSequence: 300 }, records);
      if (run.enabled) {
        assert.ok(projection.title && projection.result);
        assert.equal(projection.title, records.find(record => record.kind === 'execution.title')?.value);
        assert.ok(records.some(record => record.kind === 'observation.result' && record.observationRef === '@e101'));
        assert.equal(last.raw.tool_calls[0].func_name, 'reply');
      }
      Object.assign(run, { completed: true, projection, nativeContinuationObserved: false,
        reassessed: 'Optional opaque state was absent; supplied state retention is covered by the native-entry regression.' });
      evidence.runs.push(run);
    }
    previousClientRequests = prior.clientRequests;
    evidence.resumedFrom = resumePath;
  }
  for (const retry of resumePath ? [true] : [false, true]) {
    for (const enabled of [false, true]) {
      process.stdout.write(JSON.stringify({ event: 'live_run_started', retry, enabled }) + '\n');
      const run = await runCase({ enabled, retry });
      process.stdout.write(JSON.stringify({ event: 'live_run_completed', name: run.name, requests: run.requests, bodyIncremental: true }) + '\n');
    }
    const pair = evidence.runs.slice(-2);
    assert.equal(pair[0].requests, pair[1].requests, 'Annotations introduced extra model requests');
  }
  evidence.clientRequests = previousClientRequests + nextId;
  evidence.newClientRequests = nextId;
  evidence.modelGate = true;
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ evidence: output, modelGate: true, clientRequests: evidence.clientRequests, newClientRequests: nextId, counts: evidence.runs.map(run => ({ name: run.name, requests: run.requests })) }) + '\n');
} catch (error) {
  evidence.clientRequests = previousClientRequests + nextId;
  evidence.newClientRequests = nextId;
  evidence.failure = error instanceof Error ? error.message : 'Probe failure';
  // Category messages only; native bridge never emits credentials/error bodies.
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
  process.stderr.write(JSON.stringify({ modelGate: false, category: evidence.failure, evidence: output }) + '\n');
  process.exitCode = 1;
} finally {
  child.stdin.end();
  child.kill('SIGTERM');
}
