// Read-only original-center acceptance audit. Never persist credentials, request
// bodies, private Context, or unfiltered Model snapshots. UI inputs are separate.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';

const [mode, center, session, output] = process.argv.slice(2);
if (!['watch', 'audit'].includes(mode) || !center?.startsWith('/') || !session || !output?.startsWith('/')) throw new Error('mode center session output required');
const config = JSON.parse(readFileSync(center + '/center/runtime.json', 'utf8'));
const db = new DatabaseSync(center + '/runtime/runtime.sqlite', { readOnly: true });
const marker = 'TEST 活动修复';
const threads = () => db.prepare('SELECT t.id,t.session_id,t.status,t.response_annotations,t.generation,e.payload FROM threads t JOIN events e ON e.id=t.root_turn_id WHERE e.payload LIKE ? ORDER BY t.created_at').all('%' + marker + '%');
const candidates = () => new Set(threads().map(t => t.id));

if (mode === 'watch') {
  const require = createRequire(new URL('../../application/package.json', import.meta.url));
  const { WebSocket } = require('ws');
  const url = new URL(config.url.replace(/^http/, 'ws') + '/ws');
  url.searchParams.set('session_id', session);
  url.searchParams.set('observe_model_requests', 'true');
  const ws = new WebSocket(url, { headers: { Authorization: 'Bearer ' + config.token } });
  const snapshots = [];
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    writeFileSync(output, JSON.stringify({ snapshots, privateBodiesStored: false }, null, 2) + '\n');
    console.log(JSON.stringify({ snapshots: snapshots.length, evidence: output }));
    ws.close(); db.close();
    setTimeout(() => process.exit(0), 100);
  };
  ws.on('open', () => console.log('model snapshot observer ready'));
  ws.on('message', bytes => {
    const event = JSON.parse(bytes.toString());
    if (event.topic !== 'runtime/model_request_snapshot') return;
    const p = event.payload;
    if (!candidates().has(p.thread_id)) return;
    const tools = p.tools ?? [];
    const reply = tools.find(t => t.name === 'reply');
    const messages = p.messages ?? [];
    const snapshot = {
      threadId: p.thread_id, attemptId: p.attempt_id, protocol: p.response_annotations,
      toolsCount: tools.length, replySchema: reply?.parameters,
      workSchemaOffersAnnotations: tools.filter(t => !['reply', 'no_reply'].includes(t.name)).every(t => !!t.parameters?.properties?._annotations),
      strictContractPresent: messages.some(m => m.role === 'system' && /v2/.test(m.content) && /MUST|must/.test(m.content)),
      requestMessagesHash: createHash('sha256').update(JSON.stringify(messages)).digest('hex'),
      messageCount: messages.length,
    };
    snapshots.push(snapshot);
    console.log(JSON.stringify({ snapshot: snapshots.length, threadId: snapshot.threadId, protocol: snapshot.protocol, replyRequired: reply?.parameters?.required }));
  });
  ws.on('error', () => { console.log('observer connection error'); finish(); });
  process.on('SIGTERM', finish); process.on('SIGINT', finish);
  setTimeout(finish, 20 * 60 * 1000);
} else {
  const rows = [];
  for (const t of threads()) {
    const response = await fetch(`${config.url}/api/sessions/${t.session_id}/threads/${t.id}/annotations`, { headers: { Authorization: 'Bearer ' + config.token } });
    if (!response.ok) throw new Error('authorized annotation read failed');
    const projection = await response.json();
    const jobs = db.prepare('SELECT id,status,tool_name,created_at,result_event_id,error FROM execution_jobs WHERE thread_id=? ORDER BY created_at,id').all(t.id);
    const toolStatus = jobs.map(j => ({ ...j, toolStatus: j.result_event_id ? JSON.parse(db.prepare('SELECT payload FROM events WHERE id=?').get(j.result_event_id).payload).tool_status : undefined }));
    const sources = db.prepare('SELECT id,payload FROM events WHERE type=\u0027agent_call\u0027 AND json_extract(payload,\u0027$.thread_id\u0027)=? ORDER BY rowid').all(t.id).map(e => {
      const p = JSON.parse(e.payload);
      const bundle = p.response_annotation_bundle;
      return { id: e.id, rawCalls: bundle?.raw_response?.tool_calls?.map(c => c.func_name), protocol: bundle?.protocol, records: bundle?.records?.map(r => ({ kind: r.kind, value: r.value })), titleRevision: bundle?.title_input_revision };
    });
    rows.push({ threadId: t.id, status: t.status, protocol: t.response_annotations, generation: t.generation, projection, jobs: toolStatus, sources });
  }
  const state = { profile: db.prepare('SELECT current_revision FROM agent_rom_heads').all(), sessions: db.prepare('SELECT count(*) count FROM sessions').get(), timers: db.prepare('SELECT id,status,due_at FROM runtime_timers WHERE status=\u0027pending\u0027').all() };
  writeFileSync(output, JSON.stringify({ rows, state }, null, 2) + '\n');
  console.log(JSON.stringify({ evidence: output, rows: rows.map(r => ({ threadId: r.threadId, status: r.status, protocol: r.protocol, projection: r.projection, jobs: r.jobs.map(j => ({ status: j.status, tool: j.tool_name, toolStatus: j.toolStatus })) })), state }));
  db.close();
}
