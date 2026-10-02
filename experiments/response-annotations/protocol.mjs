// Isolated mechanism prototype. This file does not execute tools, persist data,
// call a model, or establish production provider compatibility.
import { createHash } from 'node:crypto';
import { ReplyContentDecoder } from './stream-content.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const withinUnicodeLimit = (value, max) => {
  if (value.length > max * 2) return false;
  let count = 0;
  for (const _char of value) if (++count > max) return false;
  return true;
};
const fields = { title: 256, progress: 256, result: 512 };
const sameScope = (candidate, scope) => object(candidate) && object(scope)
  && typeof scope.executionId === 'string' && scope.executionId.length > 0
  && Number.isSafeInteger(scope.generation) && scope.generation >= 0
  && candidate.executionId === scope.executionId && candidate.generation === scope.generation;
const diagnosticPath = path => {
  let bounded = '';
  let count = 0;
  for (const character of path) {
    if (++count > 255) return bounded + '…';
    bounded += character;
  }
  return bounded;
};

export const annotationSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    execution: {
      type: 'object', additionalProperties: false,
      properties: Object.fromEntries(Object.entries(fields).map(([key, maxLength]) => [key, { type: 'string', maxLength }])),
    },
    intent: { type: 'string', maxLength: 256 },
    observations: {
      type: 'array', maxItems: 16,
      items: {
        type: 'object', additionalProperties: false, required: ['ref', 'result'],
        properties: {
          ref: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[\\x00-\\x7F]+$' },
          result: { type: 'string', maxLength: 512 },
        },
      },
    },
  },
};

export const replyTool = {
  name: 'reply',
  description: 'Deliver the final user-facing response. This is a terminal response form, not a work tool. Use alone; optional annotations never change execution state.',
  parameters: {
    type: 'object', additionalProperties: false, required: ['content'],
    properties: { content: { type: 'string', minLength: 1 }, annotations: annotationSchema },
  },
};

/** Disabled means exact identity. An enabled schema is only a candidate schema:
 * provider strict/nullable/schema conversion still needs provider-specific proof. */
export function augmentTools(tools, { enabled = false, typedInfer = false } = {}) {
  if (!enabled || typedInfer) return tools;
  for (const tool of tools) {
    if (tool.name === 'reply') throw new Error('Reserved reply tool name is already occupied');
    if (own(tool.parameters?.properties ?? {}, '_annotations') || tool.parameters?.required?.includes('_annotations')) throw new Error(`Reserved _annotations parameter is already occupied: ${tool.name}`);
    if (tool.name !== 'no_reply' && (tool.parameters?.type !== 'object' || !object(tool.parameters.properties ?? {}))) {
      throw new Error(`Root object tool schema required: ${tool.name}`);
    }
    if (tool.name !== 'no_reply' && (tool.parameters?.$ref || tool.parameters?.allOf || tool.parameters?.anyOf || tool.parameters?.oneOf)) {
      throw new Error(`Composite root schema requires an explicit provider/integration decision: ${tool.name}`);
    }
  }
  return [
    ...tools.map(tool => tool.name === 'no_reply' ? structuredClone(tool) : {
      ...structuredClone(tool),
      parameters: {
        ...structuredClone(tool.parameters),
        properties: { ...structuredClone(tool.parameters.properties ?? {}), _annotations: structuredClone(annotationSchema) },
      },
    }),
    structuredClone(replyTool),
  ];
}

function protocolError(message) {
  const error = new Error(message);
  error.name = 'ResponseProtocolError';
  throw error;
}

function terminalFromLegacy(response) {
  const calls = response.tool_calls ?? [];
  if (calls.some(call => call.func_name === 'no_reply')) {
    if (calls.length !== 1 || response.content.trim()) protocolError('no_reply must be sole call with no ordinary content');
    let args;
    try { args = JSON.parse(calls[0].arguments); } catch { protocolError('Malformed no_reply control arguments'); }
    if (!object(args) || Object.keys(args).some(key => !['mode', 'wait_secs'].includes(key))) protocolError('Unknown no_reply control parameters');
    if (args.mode === 'silent' && !own(args, 'wait_secs')) return { kind: 'no_reply', mode: 'silent' };
    if (args.mode === 'wait' && (!own(args, 'wait_secs') || Number.isSafeInteger(args.wait_secs) && args.wait_secs > 0)) {
      return { kind: 'no_reply', mode: 'wait', waitSecs: args.wait_secs ?? 60, explicitlyRequested: own(args, 'wait_secs') };
    }
    protocolError('Invalid no_reply mode or wait_secs');
  }
  if (calls.length) return null;
  if (!response.content.trim()) protocolError('Empty terminal reply');
  return { kind: 'deliver', content: response.content };
}

/** Trust inputs are supplied by the host, never copied from model JSON.
 * observations is a Map(ref -> { eventId, executionId, generation, provided,
 * allowed }). A ref is not authorized by its spelling or numeric suffix. */
export function normalizeResponse(response, options = {}) {
  const { enabled = false, typedInfer = false } = options;
  if (!enabled || typedInfer) return {
    rawResponse: response, executionResponse: response,
    annotationRecords: [], diagnostics: [], terminalDecision: undefined, protocolEnabled: false,
  };
  const rawResponse = response;
  const scope = options.scope;
  // A Host fact is still about a specific execution/generation. Never apply a
  // cancelled/terminal fact merely because it was the latest caller snapshot.
  const executionFact = sameScope(options.executionFact?.scope, scope) ? options.executionFact : undefined;
  const diagnostics = [];
  const annotationRecords = [];
  const calls = response.tool_calls ?? [];
  const replyCalls = calls.filter(call => call.func_name === 'reply');
  if (replyCalls.length && (calls.length !== 1 || response.content.trim())) protocolError('reply must be sole call with no ordinary content');
  // Validate no_reply before stripping any reserved field. Its control grammar
  // is unchanged and annotations in it are not supported by this prototype.
  if (calls.some(call => call.func_name === 'no_reply')) {
    return { rawResponse, executionResponse: response, annotationRecords, diagnostics, terminalDecision: terminalFromLegacy(response), protocolEnabled: true,
      omittedDiagnostics: 0, dispatchAllowed: executionFact?.status !== 'cancelled' };
  }

  const producer = options.producer;
  let executionSeen = false;
  let observationInputsSeen = 0;
  let omittedDiagnostics = 0;
  const note = (path, message) => {
    if (diagnostics.length < 64) diagnostics.push({ path: diagnosticPath(path), message });
    else omittedDiagnostics++;
  };
  const validText = (value, max, path) => {
    if (typeof value !== 'string' || !withinUnicodeLimit(value, max)) { note(path, 'Invalid or over-limit annotation text'); return undefined; }
    if (!value.trim()) { note(path, 'Empty annotation does not erase prior text'); return undefined; }
    return value;
  };
  const record = (kind, value, path, callId, extra = {}) => {
    if (!sameScope(scope, scope) || !producer?.eventId || !producer.attemptId) {
      note(path, 'Missing trusted producer/scope; annotation not bound');
      return;
    }
    const identity = [producer.eventId, producer.attemptId, scope.executionId, scope.generation, callId ?? null, path];
    annotationRecords.push({
      id: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
      kind, value, ordinal: annotationRecords.length,
      source: { eventId: producer.eventId, attemptId: producer.attemptId,
        ...(Number.isSafeInteger(producer.sequence) && producer.sequence >= 0 ? { sequence: producer.sequence } : {}) },
      executionId: scope.executionId, generation: scope.generation,
      ...(callId ? { callId } : {}), ...extra,
    });
  };
  const extract = (annotations, path, callId, terminalCarrier) => {
    if (!object(annotations)) { note(path, 'Annotation container must be an object'); return; }
    for (const key of Object.keys(annotations)) {
      if (!['execution', 'intent', 'observations'].includes(key)) note(`${path}.${key}`, 'Unknown annotation field ignored');
    }
    if (own(annotations, 'execution')) {
      const execution = annotations.execution;
      if (!object(execution)) note(`${path}.execution`, 'Invalid execution annotation object');
      else if (executionSeen) note(`${path}.execution`, 'Only one execution annotation allowed per response');
      else {
        for (const key of Object.keys(execution)) {
          if (!own(fields, key)) { note(`${path}.execution.${key}`, 'Unknown execution annotation field ignored'); continue; }
          const text = validText(execution[key], fields[key], `${path}.execution.${key}`);
          if (text === undefined) continue;
          if (key === 'result' && !terminalCarrier) { note(`${path}.execution.result`, 'Working response cannot establish final result'); continue; }
          executionSeen = true;
          record(`execution.${key}`, text, `${path}.execution.${key}`, undefined,
            key === 'result' ? { resultBoundary: 'delivery', effective: executionFact?.terminal === true && executionFact?.status !== 'cancelled' } : {});
        }
      }
    }
    if (own(annotations, 'intent')) {
      const text = validText(annotations.intent, 256, `${path}.intent`);
      if (text !== undefined && callId) record('intent', text, `${path}.intent`, callId);
      else if (text !== undefined) note(`${path}.intent`, 'Terminal response has no work-call intent');
    }
    if (own(annotations, 'observations')) {
      if (!Array.isArray(annotations.observations)) note(`${path}.observations`, 'Observations must be an array');
      else {
        const remaining = Math.max(0, 16 - observationInputsSeen);
        if (annotations.observations.length > remaining) note(`${path}.observations`, 'Response observation limit exceeded; excess ignored');
        observationInputsSeen += annotations.observations.length;
        annotations.observations.slice(0, remaining).forEach((observation, index) => {
          const entryPath = `${path}.observations[${index}]`;
          if (!object(observation)) { note(entryPath, 'Invalid observation annotation object'); return; }
          for (const key of Object.keys(observation)) if (!['ref', 'result'].includes(key)) note(`${entryPath}.${key}`, 'Unknown observation annotation field ignored');
          const ref = observation.ref;
          if (typeof ref !== 'string' || !ref.length || ref.length > 128 || !/^[\x00-\x7f]+$/.test(ref)) { note(`${entryPath}.ref`, 'Invalid observation ref'); return; }
          const text = validText(observation.result, 512, `${entryPath}.result`);
          if (text === undefined) return;
          const target = options.observations?.get(ref);
          if (!target || !target.provided || !target.allowed || !target.eventId || target.executionId !== scope?.executionId || target.generation !== scope?.generation) {
            note(`${entryPath}.ref`, 'Observation not provided or outside trusted execution scope'); return;
          }
          record('observation.result', text, `${entryPath}.result`, undefined, { observationRef: ref, observationEventId: target.eventId });
        });
      }
    }
  };

  let executionResponse;
  let terminalDecision;
  if (replyCalls.length) {
    let args;
    try {
      const decoder = new ReplyContentDecoder();
      decoder.push(replyCalls[0].arguments);
      const decoded = decoder.finish();
      args = JSON.parse(decoded.argumentsText);
    } catch { protocolError('Invalid reply control JSON (malformed or duplicate)'); }
    if (!object(args) || Object.keys(args).some(key => !['content', 'annotations'].includes(key)) || typeof args.content !== 'string' || !args.content.trim()) {
      protocolError('Invalid reply content/control fields');
    }
    if (own(args, 'annotations')) extract(args.annotations, 'reply.annotations', undefined, true);
    executionResponse = { ...response, content: args.content, tool_calls: [] };
    terminalDecision = terminalFromLegacy(executionResponse);
  } else {
    const executionCalls = calls.map((call, index) => {
      let args;
      try { args = JSON.parse(call.arguments); } catch {
        // Preserve a malformed business call for its original validation path.
        note(`tool_calls[${index}]`, 'Business arguments unchanged; JSON parsing is deferred to existing tool validation');
        return call;
      }
      if (!object(args) || !own(args, '_annotations')) return call;
      extract(args._annotations, `tool_calls[${index}]._annotations`, call.id, false);
      const executionArgs = { ...args };
      delete executionArgs._annotations;
      return { ...call, arguments: JSON.stringify(executionArgs) };
    });
    executionResponse = { ...response, tool_calls: executionCalls };
    terminalDecision = terminalFromLegacy(executionResponse);
  }
  return { rawResponse, executionResponse, annotationRecords, diagnostics, terminalDecision, protocolEnabled: true,
    omittedDiagnostics, dispatchAllowed: executionFact?.status !== 'cancelled' };
}

/** Replay is idempotent by trusted producer identity, not by display content.
 * Conflicting same-ID content is rejected rather than silently rebound. */
export function mergeAnnotationRecords(existing, incoming) {
  const records = new Map(existing.map(record => [record.id, record]));
  const conflicts = [];
  for (const record of incoming) {
    const prior = records.get(record.id);
    if (!prior) records.set(record.id, record);
    else if (JSON.stringify(prior) !== JSON.stringify(record)) conflicts.push(record.id);
  }
  return { records: [...records.values()], conflicts };
}

/** This read-model cannot infer completion/success from annotation prose. */
export function projectExecution(fact, records) {
  // Sequence is supplied by a persisted host event journal, never by model text
  // or parsed numeric event IDs. Unknown ordering is not guessed by arrival.
  const matching = records.filter(record => sameScope({ executionId: record.executionId, generation: record.generation }, fact.scope)
    && Number.isSafeInteger(record.source?.sequence)
    && (!fact.terminal || !Number.isSafeInteger(fact.terminalSequence) || record.source.sequence <= fact.terminalSequence))
    .toSorted((a, b) => a.source.sequence - b.source.sequence || a.ordinal - b.ordinal);
  const last = kind => matching.findLast(record => record.kind === kind)?.value;
  return {
    ...fact,
    // V1 has no rename operation: later titles remain audit records, not steps.
    title: matching.find(record => record.kind === 'execution.title')?.value,
    ...(fact.terminal ? {
      result: fact.status === 'cancelled' ? undefined : matching.findLast(record => record.kind === 'execution.result' && record.effective === true)?.value,
    } : { progress: last('execution.progress') }),
  };
}
