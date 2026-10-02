import test from 'node:test';
import assert from 'node:assert/strict';
import { augmentTools, mergeAnnotationRecords, normalizeResponse, projectExecution } from './protocol.mjs';
import { ReplyContentDecoder, ReplyStreamNormalizer } from './stream-content.mjs';

const tool = { name: 'exec', description: 'Synthetic only', parameters: { type: 'object', additionalProperties: false, required: ['command'], properties: { command: { type: 'string' }, payload: { type: 'object' } } } };
const call = (id, args, name = 'exec') => ({ id, type: 'function', func_name: name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
const response = (...tool_calls) => ({ content: '', tool_calls });
const executionScope = () => ({ executionId: 'execution-1', generation: 3 });
const hostFact = (status = 'completed', terminal = true) => ({ scope: executionScope(), status, terminal });
const options = () => ({ enabled: true, scope: executionScope(), producer: { eventId: 'response-event-9', attemptId: 'model-attempt-8', sequence: 9 }, observations: new Map([
  ['@e123', { eventId: 'event-123', executionId: 'execution-1', generation: 3, provided: true, allowed: true }],
  ['@e124', { eventId: 'event-124', executionId: 'execution-1', generation: 3, provided: false, allowed: true }],
  ['@other', { eventId: 'other-event', executionId: 'execution-other', generation: 3, provided: true, allowed: true }],
  ['@old', { eventId: 'old-event', executionId: 'execution-1', generation: 2, provided: true, allowed: true }],
  ['@denied', { eventId: 'denied-event', executionId: 'execution-1', generation: 3, provided: true, allowed: false }],
]) });

test('v2 terminal requirements are schema-visible, validated and never repaired', () => {
  const schema = augmentTools([tool], { enabled: true, requiredTerminal: true }).at(-1).parameters;
  assert.deepEqual(schema.required, ['content', 'annotations']);
  assert.deepEqual(schema.properties.annotations.properties.execution.required, ['title', 'result']);
  const strict = { ...options(), requiredTerminal: true, executionFact: hostFact() };
  const ordinary = { content: '完成', tool_calls: [] };
  assert.equal(normalizeResponse(ordinary, options()).terminalDecision.kind, 'deliver');
  assert.throws(() => normalizeResponse(ordinary, strict), /Required terminal/);
  for (const execution of [undefined, { title: '标题' }, { title: '标题', result: null }, { title: '标题', result: '  ' }, { title: '标题', result: '🧠'.repeat(513) }, { title: '🧠'.repeat(257), result: '结果' }]) {
    assert.throws(() => normalizeResponse(response(call('final', { content: '完成', annotations: { execution } }, 'reply')), strict), /Required terminal/);
  }
  const valid = normalizeResponse(response(call('final', { content: '完成', annotations: { execution: { title: '核对', result: '结果' } } }, 'reply')), strict);
  assert.equal(valid.executionResponse.tool_calls.length, 0);
  assert.equal(valid.terminalDecision.kind, 'deliver');
  assert.equal(normalizeResponse(response(call('work', { command: 'read' })), strict).terminalDecision, null);
  assert.equal(normalizeResponse(response(call('silent', { mode: 'silent' }, 'no_reply')), strict).terminalDecision.mode, 'silent');
  assert.equal(normalizeResponse(ordinary, { ...strict, typedInfer: true }).executionResponse, ordinary);
});

test('disabled and typed infer are exactly untouched, even with occupied reserved names', () => {
  const tools = [{ ...tool, name: 'reply' }];
  assert.equal(augmentTools(tools), tools);
  assert.equal(augmentTools(tools, { enabled: true, typedInfer: true }), tools);
  const raw = response(call('1', { command: 'x', _annotations: { arbitrary: true } }, 'reply'));
  const disabled = normalizeResponse(raw);
  assert.equal(disabled.rawResponse, raw); assert.equal(disabled.executionResponse, raw);
  assert.equal(normalizeResponse(raw, { enabled: true, typedInfer: true }).executionResponse, raw);
  const event = { type: 'ToolArgumentsDelta', index: 0, delta: '{secret}' };
  assert.equal(new ReplyStreamNormalizer().push(event)[0], event);
});

test('schema is optional and additive, collision precheck never overwrites a business capability', () => {
  const original = structuredClone(tool);
  const noReply = { name: 'no_reply', parameters: { type: 'object', properties: { mode: { type: 'string' } }, required: ['mode'], additionalProperties: false } };
  const augmented = augmentTools([tool, noReply], { enabled: true });
  assert.deepEqual(tool, original); assert.deepEqual(augmented[0].parameters.required, ['command']);
  assert.deepEqual(augmented[0].parameters.properties.command, tool.parameters.properties.command);
  assert.ok(augmented[0].parameters.properties._annotations);
  assert.deepEqual(augmented[1], noReply); assert.equal(augmented[2].name, 'reply');
  assert.throws(() => augmentTools([{ ...tool, name: 'reply' }], { enabled: true }), /occupied/);
  assert.throws(() => augmentTools([{ ...tool, parameters: { ...tool.parameters, properties: { _annotations: {} } } }], { enabled: true }), /occupied/);
  assert.throws(() => augmentTools([{ ...tool, parameters: { type: 'array' } }], { enabled: true }), /Root object/);
});

test('single work-call slot carries annotations and preserves exact raw / semantic business args', () => {
  const args = { command: 'printf \'中文\\n\' "$UNCHANGED"', payload: { _annotations: { business: true } }, _annotations: {
    execution: { title: '检查运行环境', progress: '继续检查', result: '不能提前完成' }, intent: '确认架构', observations: [{ ref: '@e123', result: '操作系统为 Linux' }],
  } };
  const raw = response(call('provider-call-1', args));
  const normalized = normalizeResponse(raw, options());
  assert.equal(normalized.rawResponse, raw); assert.equal(normalized.rawResponse.tool_calls[0].arguments, raw.tool_calls[0].arguments);
  const expected = structuredClone(args); delete expected._annotations;
  assert.deepEqual(JSON.parse(normalized.executionResponse.tool_calls[0].arguments), expected);
  assert.equal(normalized.executionResponse.tool_calls.length, 1); assert.equal(normalized.terminalDecision, null);
  assert.deepEqual(normalized.annotationRecords.map(record => record.kind), ['execution.title', 'execution.progress', 'intent', 'observation.result']);
  assert.equal(normalized.annotationRecords.find(record => record.kind === 'intent').callId, 'provider-call-1');
  assert.equal(normalized.annotationRecords.at(-1).observationEventId, 'event-123');
});

test('multiple calls bind intents independently, reject sibling future results and duplicate execution text', () => {
  const normalized = normalizeResponse(response(
    call('one', { command: 'a', _annotations: { execution: { title: '统一工作' }, intent: '第一步', observations: [{ ref: '@e124', result: '还没有这个结果' }] } }),
    call('two', { command: 'b', _annotations: { execution: { title: '错误覆盖' }, intent: '第二步' } }),
  ), options());
  assert.equal(normalized.executionResponse.tool_calls.length, 2);
  assert.deepEqual(normalized.annotationRecords.filter(record => record.kind === 'intent').map(record => [record.callId, record.value]), [['one', '第一步'], ['two', '第二步']]);
  assert.equal(normalized.annotationRecords.filter(record => record.kind === 'execution.title').length, 1);
  assert.equal(normalized.annotationRecords.filter(record => record.kind === 'observation.result').length, 0);
});

test('bad metadata is field-local fallback and never damages work params or introduces a repair action', () => {
  const annotations = { execution: { title: '🧠'.repeat(256), progress: '🧠'.repeat(257), status: 'succeeded' }, intent: 12, permission: 'all', observations: [
    { ref: '@other', result: 'forged' }, { ref: '@old', result: 'stale' }, { ref: '@denied', result: 'denied' }, { ref: '@missing', result: 'unknown' }, { ref: '中文', result: 'invalid' }, { ref: '@e123', result: '有效' },
  ] };
  const normalized = normalizeResponse(response(call('one', { command: 'unchanged', _annotations: annotations })), options());
  assert.deepEqual(JSON.parse(normalized.executionResponse.tool_calls[0].arguments), { command: 'unchanged' });
  assert.deepEqual(normalized.annotationRecords.map(record => record.kind), ['execution.title', 'observation.result']);
  assert.ok(normalized.diagnostics.length >= 8); assert.equal(normalized.terminalDecision, null);
  const brokenContainer = normalizeResponse(response(call('two', { command: 'unchanged', _annotations: 'wrong' })), options());
  assert.equal(brokenContainer.annotationRecords.length, 0); assert.equal(brokenContainer.executionResponse.tool_calls.length, 1);
  const malformedBusiness = response(call('bad', '{"command":'));
  assert.equal(normalizeResponse(malformedBusiness, options()).executionResponse.tool_calls[0], malformedBusiness.tool_calls[0]);
});

test('annotation limits are Unicode characters and empty text never deletes history', () => {
  const normalized = normalizeResponse(response(call('one', { command: 'x', _annotations: { execution: { title: '' }, observations: Array.from({ length: 18 }, () => ({ ref: '@e123', result: '有效' })) } })), options());
  assert.equal(normalized.annotationRecords.length, 16); assert.ok(normalized.diagnostics.some(note => note.message.includes('limit')));
  const noScope = normalizeResponse(response(call('one', { command: 'x', _annotations: { intent: '目的' } })), { enabled: true });
  assert.equal(noScope.annotationRecords.length, 0);
  const batch = normalizeResponse(response(...Array.from({ length: 2 }, (_, index) => call(`call-${index}`, { command: 'x', _annotations: { observations: Array.from({ length: 16 }, () => ({ ref: '@e123', result: '有效' })) } }))), options());
  assert.equal(batch.annotationRecords.length, 16, '16 entries per response, not 16 per tool');
  const fallback = normalizeResponse(response(call('bad', { command: 'x', _annotations: { execution: { title: 2 } } }), call('valid', { command: 'y', _annotations: { execution: { title: '可用标题' } } })), options());
  assert.equal(fallback.annotationRecords[0].value, '可用标题');
});

test('reply normalizes in same response without creating a work call or taking over lifecycle', () => {
  const raw = response(call('finish', { content: '检查完成。', annotations: { execution: { result: '已确认系统' }, observations: [{ ref: '@e123', result: 'Linux' }] } }, 'reply'));
  const normalized = normalizeResponse(raw, options());
  assert.equal(normalized.rawResponse, raw); assert.equal(normalized.executionResponse.tool_calls.length, 0);
  assert.deepEqual(normalized.terminalDecision, { kind: 'deliver', content: '检查完成。' });
  assert.equal(normalized.annotationRecords[0].effective, false, 'model reply does not prove background work ended');
  const completed = normalizeResponse(raw, { ...options(), executionFact: hostFact() });
  assert.equal(completed.annotationRecords[0].effective, true);
  const badMetadata = normalizeResponse(response(call('finish', { content: '正常正文', annotations: null }, 'reply')), options());
  assert.equal(badMetadata.terminalDecision.content, '正常正文'); assert.equal(badMetadata.annotationRecords.length, 0);
  assert.throws(() => normalizeResponse(response(call('r', { content: 'x' }, 'reply'), call('w', { command: 'x' })), options()), /sole/);
  assert.throws(() => normalizeResponse({ content: 'double', tool_calls: [call('r', { content: 'x' }, 'reply')] }, options()), /sole/);
  assert.throws(() => normalizeResponse(response(call('r', { content: '', status: 'success' }, 'reply')), options()), /Invalid reply/);
  assert.throws(() => normalizeResponse(response(call('r', '{"content":', 'reply')), options()), /Invalid reply control JSON/);
});

test('legacy plain text / no_reply silent+wait control remains strict and independent', () => {
  assert.equal(normalizeResponse({ content: '传统正文', tool_calls: [] }, options()).terminalDecision.content, '传统正文');
  const silent = normalizeResponse(response(call('n', { mode: 'silent' }, 'no_reply')), options());
  assert.deepEqual(silent.terminalDecision, { kind: 'no_reply', mode: 'silent' });
  assert.deepEqual(normalizeResponse(response(call('n', { mode: 'wait' }, 'no_reply')), options()).terminalDecision, { kind: 'no_reply', mode: 'wait', waitSecs: 60, explicitlyRequested: false });
  assert.deepEqual(normalizeResponse(response(call('n', { mode: 'wait', wait_secs: 2 }, 'no_reply')), options()).terminalDecision, { kind: 'no_reply', mode: 'wait', waitSecs: 2, explicitlyRequested: true });
  assert.throws(() => normalizeResponse(response(call('n', { mode: 'wait', wait_secs: 0 }, 'no_reply')), options()), /Invalid/);
  assert.throws(() => normalizeResponse(response(call('n', { mode: 'silent', _annotations: {} }, 'no_reply')), options()), /Unknown/);
  assert.throws(() => normalizeResponse(response(call('n', { mode: 'silent' }, 'no_reply'), call('r', { content: 'x' }, 'reply')), options()), /sole/);
});

test('complete and incremental reply paths both reject duplicate root control fields', () => {
  for (const raw of ['{"content":"first","content":"last"}', '{"content":"body","annotations":{},"annotations":{}}']) {
    assert.throws(() => normalizeResponse(response(call('r', raw, 'reply')), options()), /duplicate/);
    assert.throws(() => new ReplyContentDecoder().push(raw), /Duplicate/);
  }
});

test('replay is idempotent and rejects rebinding; real cancelled/failed/no-summary facts win', () => {
  const raw = response(call('one', { command: 'x', _annotations: { execution: { title: '标题', progress: '继续' }, observations: [{ ref: '@e123', result: 'Linux' }] } }));
  const first = normalizeResponse(raw, options());
  const replay = normalizeResponse(raw, options());
  const merged = mergeAnnotationRecords(first.annotationRecords, replay.annotationRecords);
  assert.equal(merged.records.length, first.annotationRecords.length); assert.deepEqual(merged.conflicts, []);
  const changed = structuredClone(first.annotationRecords); changed.at(-1).observationEventId = 'forged-event';
  assert.equal(mergeAnnotationRecords(first.annotationRecords, changed).conflicts.length, 1);
  const result = normalizeResponse(response(call('r', { content: '结束', annotations: { execution: { result: '我说成功了' } } }, 'reply')), { ...options(), executionFact: hostFact('cancelled') });
  assert.equal(result.dispatchAllowed, false); assert.equal(result.annotationRecords[0].effective, false);
  const cancelled = projectExecution(hostFact('cancelled'), [...merged.records, ...result.annotationRecords]);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.progress, undefined); assert.equal(cancelled.result, undefined);
  const failed = projectExecution(hostFact('failed'), []);
  assert.equal(failed.status, 'failed'); assert.equal(failed.result, undefined);
});

test('projection uses trusted ordering, ignores ineffective or late results and never regresses terminal facts', () => {
  const produce = (sequence, annotations, fact) => normalizeResponse(response(call(`reply-${sequence}`, { content: '正文', annotations }, 'reply')), {
    ...options(), producer: { eventId: `event-${sequence}`, attemptId: `attempt-${sequence}`, sequence }, executionFact: fact,
  }).annotationRecords;
  const older = produce(10, { execution: { title: '较早', progress: '较早进展' } });
  const newer = produce(20, { execution: { title: '较新', progress: '较新进展', result: '交付但还没结束' } });
  const final = produce(30, { execution: { result: '真实终结边界的结果' } }, hostFact());
  const late = produce(40, { execution: { title: '迟到覆盖', progress: '迟到进展', result: '迟到结果' } }, hostFact());
  const running = projectExecution(hostFact('running', false), [...newer, ...older]);
  assert.equal(running.title, '较早'); assert.equal(running.progress, '较新进展'); assert.equal(running.result, undefined);
  const withoutConfirmedResult = projectExecution({ ...hostFact(), terminalSequence: 30 }, newer);
  assert.equal(withoutConfirmedResult.result, undefined);
  const completed = projectExecution({ ...hostFact(), terminalSequence: 30 }, [...late, ...final, ...newer, ...older]);
  assert.equal(completed.title, '较早'); assert.equal(completed.result, '真实终结边界的结果'); assert.equal(completed.progress, undefined);
  const cancelled = projectExecution({ ...hostFact('cancelled'), terminalSequence: 30 }, [...late, ...final]);
  assert.equal(cancelled.result, undefined); assert.equal(cancelled.status, 'cancelled');
  const unordered = structuredClone(final); delete unordered[0].source.sequence;
  assert.equal(projectExecution(hostFact(), unordered).result, undefined);
});

test('V1 keeps the first valid execution title across reordering, later steps, terminal arrival and replay', () => {
  const produce = (sequence, execution, terminal = false) => normalizeResponse(response(call(`call-${sequence}`,
    terminal ? { content: '正文', annotations: { execution } } : { command: 'safe', _annotations: { execution } },
    terminal ? 'reply' : 'exec')), {
    ...options(), producer: { eventId: `event-${sequence}`, attemptId: `attempt-${sequence}`, sequence },
    ...(terminal ? { executionFact: hostFact() } : {}),
  }).annotationRecords;
  const invalid = produce(5, { title: '', progress: '准备' });
  const first = produce(10, { title: '核对运行环境', progress: '核对操作系统' });
  const later = produce(20, { title: '核对处理器架构', progress: '核对处理器架构' });
  const final = produce(30, { title: '结束步骤', result: '已核对环境' }, true);
  const late = produce(40, { title: '迟到步骤', result: '迟到结果' }, true);
  const unsequenced = structuredClone(produce(1, { title: '没有可信顺序' }));
  delete unsequenced[0].source.sequence;
  const runningFact = hostFact('running', false);
  for (const records of [[...later, ...first, ...invalid], [...invalid, ...first, ...later]]) {
    const projection = projectExecution(runningFact, records);
    assert.equal(projection.title, '核对运行环境');
    assert.equal(projection.progress, '核对处理器架构');
  }
  const stored = mergeAnnotationRecords([...later, ...final, ...first, ...invalid], [...first, ...later]);
  assert.deepEqual(stored.conflicts, []);
  assert.equal(stored.records.filter(record => record.kind === 'execution.title').length, 3);
  const withLate = mergeAnnotationRecords(stored.records, [...late, ...unsequenced]);
  const projection = projectExecution({ ...hostFact(), terminalSequence: 30 }, withLate.records);
  assert.equal(projection.title, '核对运行环境');
  assert.equal(projection.result, '已核对环境');
  assert.equal(projection.progress, undefined);
  assert.equal(withLate.records.filter(record => record.kind === 'execution.title').length, 5);
  assert.equal(projectExecution({ ...hostFact(), terminalSequence: 30 }, [...withLate.records].reverse()).title, '核对运行环境');
});

test('wrong or missing host-fact scope cannot cancel or finalize current execution', () => {
  const raw = response(call('r', { content: '正文', annotations: { execution: { result: '候选结果' } } }, 'reply'));
  const mismatchedScopes = [
    { executionId: 'other-execution', generation: 3 },
    { executionId: 'execution-1', generation: 2 },
    undefined,
  ];
  for (const scope of mismatchedScopes) {
    for (const status of ['cancelled', 'completed']) {
      const normalized = normalizeResponse(raw, { ...options(), executionFact: { scope, status, terminal: true } });
      assert.equal(normalized.dispatchAllowed, true);
      assert.equal(normalized.annotationRecords[0].effective, false);
    }
  }
  const completed = normalizeResponse(raw, { ...options(), executionFact: hostFact() });
  assert.equal(completed.annotationRecords[0].effective, true);
  const otherProjection = projectExecution({ ...hostFact(), scope: mismatchedScopes[0] }, completed.annotationRecords);
  assert.equal(otherProjection.result, undefined);
  const noReply = response(call('n', { mode: 'wait' }, 'no_reply'));
  assert.equal(normalizeResponse(noReply, { ...options(), executionFact: hostFact('cancelled') }).dispatchAllowed, false);
  assert.equal(normalizeResponse(noReply, { ...options(), executionFact: { scope: mismatchedScopes[0], status: 'cancelled', terminal: true } }).dispatchAllowed, true);
  const disabled = normalizeResponse(raw, { ...options(), enabled: false, executionFact: hostFact('cancelled') });
  assert.equal(disabled.rawResponse, raw); assert.equal(disabled.executionResponse, raw);
});

test('diagnostics bound count and path even for oversized unknown metadata keys', () => {
  const unknown = Object.fromEntries(Array.from({ length: 100 }, (_, index) => ['🧠'.repeat(1000) + index, null]));
  const normalized = normalizeResponse(response(call('w', { command: 'unchanged', _annotations: unknown })), options());
  assert.equal(normalized.diagnostics.length, 64);
  assert.equal(normalized.omittedDiagnostics, 36);
  assert.ok(normalized.diagnostics.every(diagnostic => [...diagnostic.path].length <= 256));
  assert.deepEqual(JSON.parse(normalized.executionResponse.tool_calls[0].arguments), { command: 'unchanged' });
});

test('incremental reply decoding is exact at every possible chunk split and emits before completion', () => {
  const content = '中文 🧠 "引号" \\ 换行\n制表\t尾';
  const raw = JSON.stringify({ annotations: { execution: { title: '绝不泄露' }, content: 'nested must not leak' }, content });
  for (let split = 0; split <= raw.length; split++) {
    const decoder = new ReplyContentDecoder();
    const deltas = [decoder.push(raw.slice(0, split)), decoder.push(raw.slice(split))];
    assert.equal(deltas.join(''), content, `split ${split}`); assert.equal(decoder.finish().content, content);
    assert.ok(!deltas.join('').includes('绝不泄露'));
  }
  const oneChar = new ReplyContentDecoder();
  let streamed = '';
  for (const char of raw.split('')) streamed += oneChar.push(char);
  assert.equal(streamed, content); assert.equal(oneChar.finish().content, content);
  const early = new ReplyContentDecoder();
  assert.equal(early.push('{"content":"已经到达'), '已经到达');
  early.push('","annotations":{"execution":{"result":"后到"}}}'); early.finish();
});

test('escaped Unicode and surrogate pairs survive boundary splits, including escaped root keys', () => {
  const raw = '{"ann\\u006ftations":{"content":"hidden"},"c\\u006fntent":"\\u4e2d\\u6587 \\ud83e\\udde0 \\ud800 x \\udc00"}';
  const expected = JSON.parse(raw).content;
  for (let width = 1; width < 14; width++) {
    const decoder = new ReplyContentDecoder(); let streamed = '';
    for (let start = 0; start < raw.length; start += width) streamed += decoder.push(raw.slice(start, start + width));
    assert.equal(streamed, expected); assert.equal(decoder.finish().content, expected);
  }
});

test('deterministic varied chunks and JSON strings match the authoritative complete decoder', () => {
  let state = 0x53a90e1;
  const next = n => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
  const alphabet = ['中', '文', '🧠', '"', '\\', '\n', '\r', '\t', '\0', '\ud800', '\udc00', '\u2028', 'x', '/', ' '];
  for (let sample = 0; sample < 100; sample++) {
    const content = '正文' + Array.from({ length: next(100) }, () => alphabet[next(alphabet.length)]).join('');
    const metadata = { nested: [{ content: 'should remain metadata', list: [1, null, true, { escaped: '\\"' }] }] };
    const raw = JSON.stringify(sample % 2 ? { annotations: metadata, content } : { content, annotations: metadata });
    const decoder = new ReplyContentDecoder(); let decoded = '';
    for (let start = 0; start < raw.length;) {
      const length = 1 + next(23); decoded += decoder.push(raw.slice(start, start + length)); start += length;
    }
    assert.equal(decoded, JSON.parse(raw).content); assert.equal(decoder.finish().content, content);
  }
});

test('stream refuses malformed/duplicate/control bodies and enforces bounded memory budget', () => {
  assert.throws(() => new ReplyContentDecoder().push('{"content":12}'), /string/);
  assert.throws(() => new ReplyContentDecoder().push('{"content":"a","content":"b"}'), /Duplicate/);
  assert.throws(() => new ReplyContentDecoder().push('{"content":"\\q"}'), /escape/);
  assert.throws(() => new ReplyContentDecoder().push('{"content":"\\u12g4"}'), /Unicode/);
  const incomplete = new ReplyContentDecoder(); incomplete.push('{"content":"partial');
  assert.throws(() => incomplete.finish(), /Incomplete/);
  const invalid = new ReplyContentDecoder(); invalid.push('{"content":"正文","status":"success"}');
  assert.throws(() => invalid.finish(), /control/);
  assert.throws(() => new ReplyContentDecoder({ maxArgumentChars: 10 }).push('x'.repeat(11)), /budget/);
});

test('long content remains exact without full-prefix reparsing on each delta', () => {
  const content = '长文本🧠\\"\n'.repeat(50_000);
  const raw = JSON.stringify({ content, annotations: { execution: { result: '末尾注解' } } });
  const decoder = new ReplyContentDecoder(); const deltas = [];
  for (let start = 0; start < raw.length; start += 97) deltas.push(decoder.push(raw.slice(start, start + 97)));
  assert.equal(deltas.join(''), content); assert.equal(decoder.finish().content, content);
});

test('stream normalizer only decodes identified reply, keeps plain text and real work events exact', () => {
  const normalizer = new ReplyStreamNormalizer({ enabled: true });
  const plain = { type: 'TextDelta', text: '原样正文' }; assert.equal(normalizer.push(plain)[0], plain);
  const started = { type: 'ToolCallStarted', index: 1, id: 'work', name: 'exec' };
  const args = { type: 'ToolArgumentsDelta', index: 1, delta: '{"command":"secret"}' };
  const completed = { type: 'ToolCallCompleted', index: 1 };
  assert.equal(normalizer.push(started)[0], started);
  assert.equal(normalizer.push(args)[0], args);
  assert.equal(normalizer.push(completed)[0], completed);
  assert.throws(() => normalizer.push({ type: 'ToolCallStarted', index: 0, id: 'reply-1', name: 'reply' }), /sole/);
  const reply = new ReplyStreamNormalizer({ enabled: true });
  reply.push({ type: 'ToolCallStarted', index: 0, id: 'reply-1', name: 'reply' });
  assert.deepEqual(reply.push({ type: 'ToolArgumentsDelta', index: 0, delta: '{"content":"中文' }), [{ type: 'TextDelta', text: '中文' }]);
  reply.push({ type: 'ToolArgumentsDelta', index: 0, delta: '","annotations":{"intent":"不可泄露"}}' });
  reply.push({ type: 'ToolCallCompleted', index: 0 });
  assert.equal(reply.tools.get(0).reply.content, '中文');
  assert.throws(() => reply.push({ type: 'ToolCallStarted', index: 1, id: 'work-late', name: 'exec' }), /sole/);
  assert.throws(() => reply.push({ type: 'TextDelta', text: 'late ordinary text' }), /ordinary content/);
  assert.throws(() => new ReplyStreamNormalizer({ enabled: true }).push({ type: 'ToolArgumentsDelta', index: 0, delta: '{}' }), /identity/);
});

test('normalizer accepts actual serde wire kinds, preserving raw reply separately from normalized text', () => {
  const rawEvents = [];
  const normalizer = new ReplyStreamNormalizer({ enabled: true, onRawEvent: event => rawEvents.push(event) });
  const start = { kind: 'tool_call_started', index: 0, id: 'r', name: 'reply' };
  const args = { kind: 'tool_arguments_delta', index: 0, delta: '{"content":"流式正文","annotations":{"execution":{"result":"内部注解"}}}' };
  assert.deepEqual(normalizer.push(start), []);
  assert.deepEqual(normalizer.push(args), [{ kind: 'text_delta', text: '流式正文' }]);
  assert.deepEqual(normalizer.push({ kind: 'tool_call_completed', index: 0 }), []);
  const completed = { kind: 'completed' }; assert.equal(normalizer.push(completed)[0], completed);
  assert.equal(rawEvents[0], start); assert.equal(rawEvents[1], args);
  const incomplete = new ReplyStreamNormalizer({ enabled: true });
  incomplete.push(start); incomplete.push({ kind: 'tool_arguments_delta', index: 0, delta: '{"content":"部分' });
  assert.throws(() => incomplete.push(completed), /without validated/);
});
