# Execute after the verified 256K bootstrap, in the same private Kaggle kernel.
# This is an exploratory public-game sample, not an official competition score.
import http.client
import sqlite3
import secrets
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

EXPERIMENT=globals().get('ARC_EXPERIMENT', {})
GAMES=tuple(EXPERIMENT.get('games', ('ls20','ft09','vc33')))
ARMS=tuple(EXPERIMENT.get('arms', ('baseline',)))
BUDGET_S=int(EXPERIMENT.get('budget_s',600))
MAX_ACTIONS=int(EXPERIMENT.get('max_actions',200))
HARNESS_ID=EXPERIMENT.get('harness_id','arc-discovery')
HARNESS_VERSION=EXPERIMENT.get('harness_version','0.1.0')
assert ARMS and set(ARMS) <= {'baseline','discovery'}
assert GAMES and BUDGET_S > 0 and MAX_ACTIONS > 0
ARC_WORK=WORK/EXPERIMENT.get('output','arc-public-baseline')
ARC_WORK.mkdir(exist_ok=True)
SOURCE=ARC_WORK/'bridge-source'
SOURCE.mkdir(exist_ok=True)
# The enclosing cell writes reviewed bridge/CLI/observation/Harness files here.
COMP=Path('/kaggle/input/competitions/arc-prize-2026-arc-agi-3')
WHEELHOUSE=COMP/'arc_agi_3_wheels'
ENVS=COMP/'environment_files'
assert WHEELHOUSE.is_dir() and ENVS.is_dir()
(ARC_WORK/'protocol.json').write_text(json.dumps({
    'games':GAMES,'arms':ARMS,'seed':0,'max_actions_per_game':MAX_ACTIONS,
    'wall_budget_s_per_game':BUDGET_S,'context_window_tokens':262144,
    'model':'Qwen3.8-Flash-Next W4A16 AutoRound','runtime':'Morphz v0.1.3',
    'submission':False,'official_score':False,
    'runtime_build':globals().get('RUNTIME_BUILD',{'git_release':'7e8f7d81f8b00fd45544d94d5b9a321214633df1'}),
    'runtime_binary_sha256':sha256(morphz),
    'runner_source_receipt':globals().get('ARC_RUNNER_RECEIPT'),
    'source_sha256':{p.name:sha256(p) for p in SOURCE.iterdir() if p.is_file()},
    'comparison_scope':'Harness plus visible observation aids; not model training',
    'formal_submission':False
},indent=2))
ARC_VENV=PREFIX/'arc-venv'
arc_env=dict(install_env,MPLBACKEND='Agg')
if not (ARC_VENV/'bin/python').exists(): run([uv,'venv','--python',base_python,ARC_VENV],env=arc_env)
ARC_PYTHON=ARC_VENV/'bin/python'
arc_install_env=dict(arc_env,PYTHONPATH=str(next(WHEELS.glob('pip-*.whl'))),PIP_NO_INDEX='1')
run([ARC_PYTHON,'-m','pip','install','--no-index','--find-links',WHEELHOUSE,'arc-agi'],env=arc_install_env)
run([ARC_PYTHON,'-c','import arc_agi,arcengine,PIL,numpy; import importlib.metadata as m; print({k:m.version(k) for k in ["arc-agi","arcengine","pillow","numpy"]})'],env=arc_env)

WIRE_LOCK=threading.Lock()
wire_records=[]
def scrub(value):
    if isinstance(value,list): return [scrub(v) for v in value]
    if isinstance(value,dict):
        result={k:scrub(v) for k,v in value.items()}
        url=value.get('url')
        if isinstance(url,str) and url.startswith('data:image/'):
            result['url']=url[:40]+'...'; result['payload_sha256']=hashlib.sha256(url.encode()).hexdigest()
        return result
    return value

class WireProxy(BaseHTTPRequestHandler):
    def log_message(self,*_): pass
    def do_POST(self):
        start=time.monotonic(); payload=self.rfile.read(int(self.headers['Content-Length']))
        request=json.loads(payload); image_count=payload.count(b'data:image/')
        record={'started_at':time.time(),'path':self.path,'images_in_request':image_count,'request':scrub(request),'completed':False}
        with WIRE_LOCK: wire_records.append(record)
        upstream=http.client.HTTPConnection('127.0.0.1',8000,timeout=240)
        try:
            upstream.request('POST',self.path,payload,{'Content-Type':'application/json'})
            response=upstream.getresponse(); record['status']=response.status
            self.send_response(response.status)
            self.send_header('Content-Type',response.getheader('Content-Type','application/json'))
            self.end_headers(); self.close_connection=True
            first=None; usage=None; response_parts=[]
            while True:
                line=response.readline()
                if not line: break
                if first is None: first=time.monotonic()-start
                if line.startswith(b'data: '):
                    try:
                        piece=json.loads(line[6:]); usage=piece.get('usage') or usage
                        response_parts.append(piece)
                    except (ValueError,TypeError): pass
                else: response_parts.append(line.decode(errors='replace'))
                self.wfile.write(line); self.wfile.flush()
            record.update(elapsed_s=round(time.monotonic()-start,3),first_response_s=first,usage=usage,response=response_parts,completed=True)
        except Exception as exc: record.update(error=repr(exc),elapsed_s=round(time.monotonic()-start,3))
        finally:
            upstream.close()
            with WIRE_LOCK:
                with (ARC_WORK/'provider-wire.jsonl').open('a') as f: f.write(json.dumps(record)+'\n')

proxy=ThreadingHTTPServer(('127.0.0.1',0),WireProxy)
proxy_port=proxy.server_address[1]
threading.Thread(target=proxy.serve_forever,daemon=True).start()
gpu_stop_arc=threading.Event()
def gpu_sampler_arc():
    with (ARC_WORK/'gpu.jsonl').open('a') as out:
        while not gpu_stop_arc.is_set():
            sample=subprocess.run(['nvidia-smi','--query-gpu=memory.used,memory.total,utilization.gpu,temperature.gpu','--format=csv,noheader,nounits'],capture_output=True,text=True)
            out.write(json.dumps({'timestamp':time.time(),'sample':sample.stdout.strip()})+'\n'); out.flush()
            gpu_stop_arc.wait(1)
threading.Thread(target=gpu_sampler_arc,daemon=True).start()

def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0)); return sock.getsockname()[1]

def request_json(port,path,body=None):
    req=urllib.request.Request(f'http://127.0.0.1:{port}{path}',data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=10) as response: return json.load(response)

def bind_account(test,workspace,config,runtime_env):
    port=free_port(); token=secrets.token_hex(32); runtime_env['MORPHZ_DASHBOARD_TOKEN']=token
    with (test/'operator.log').open('w') as out:
        child=subprocess.Popen([str(morphz),'serve','--bind',f'127.0.0.1:{port}','--cwd',str(workspace),'--config-file',str(config),'--sandbox','full-access','--approval','never'],cwd=workspace,env=runtime_env,stdout=out,stderr=subprocess.STDOUT)
    try:
        deadline=time.monotonic()+45
        while True:
            assert child.poll() is None,(test/'operator.log').read_text()[-4000:]
            try:
                req=urllib.request.Request(f'http://127.0.0.1:{port}/api/agents/default-agent/provider-accounts/local',method='PUT',headers={'Authorization':f'Bearer {token}'})
                with urllib.request.urlopen(req,timeout=2) as response: result=json.load(response)
                (test/'account-binding.json').write_text(json.dumps(result)); break
            except Exception:
                if time.monotonic()>deadline: raise
                time.sleep(.5)
    finally:
        child.terminate()
        try: child.wait(timeout=10)
        except subprocess.TimeoutExpired: child.kill(); child.wait()

def run_game(game,arm):
    test=ARC_WORK/(f'{game}-{arm}' if EXPERIMENT else game)
    # Reusing an existing DB or trajectory would invalidate a fresh-context comparison.
    test.mkdir(exist_ok=False)
    workspace=test/'workspace'; workspace.mkdir(exist_ok=True)
    harness_receipt=None
    shutil.copy2(SOURCE/'arc_cli.py',workspace/'arc_cli.py')
    port=free_port()
    (workspace/'connection.json').write_text(json.dumps({'port':port}))
    with (test/'engine.log').open('w') as out:
        bridge=subprocess.Popen([str(ARC_PYTHON),str(SOURCE/'arc_bridge.py'),'--game',game,'--env-dir',str(ENVS),'--output',str(workspace),'--port',str(port),'--budget-s',str(BUDGET_S),'--max-actions',str(MAX_ACTIONS)],env=arc_env,stdout=out,stderr=subprocess.STDOUT)
    try:
        deadline=time.monotonic()+60
        while not (workspace/'status.json').exists():
            assert bridge.poll() is None,(test/'engine.log').read_text()[-6000:]
            if time.monotonic()>deadline: raise TimeoutError('Game engine init timeout')
            time.sleep(.25)
        config=test/'runtime.toml'
        config.write_text(f'''[llm]
model="flash-next"
max_output_tokens=8192
max_retries=1
first_byte_timeout_secs=240
[accounts.local]
auth_adapter="none"
provider="local"
[services.local]
adapter="protocol-compatible"
protocol="openai-chat"
base_url="http://127.0.0.1:{proxy_port}/v1"
accounts=["local"]
[services.local.models.morphz-flash-next]
context_window_tokens=262144
max_output_tokens=8192
[[models.flash-next.targets]]
service="local"
account="local"
physical_model="morphz-flash-next"
capabilities=["tools"]
[permissions]
workspace_root={json.dumps(str(workspace))}
protected_paths=[{json.dumps(str(COMP))},{json.dumps(str(ARC_VENV))},{json.dumps(str(SOURCE))}]
[background_task]
artifact_dir={json.dumps(str(test/'artifacts'))}
''')
        runtime_env={k:v for k,v in os.environ.items() if k in ('PATH','LANG','TMPDIR','TEMP','TMP','LD_LIBRARY_PATH')}
        runtime_env.update(MORPHZ_HOME=str(test/'host'),MORPHZ_STORAGE_SQLITE_PATH=str(test/'runtime.db'),NO_PROXY='127.0.0.1,localhost')
        bind_account(test,workspace,config,runtime_env)
        if arm=='discovery':
            install=subprocess.run([str(morphz),'harness','install',str(SOURCE/'arc-discovery.hns'),
                '--cwd',str(workspace),'--config-file',str(config),'--format','json','--log-level','error'],
                cwd=workspace,env=runtime_env,capture_output=True,text=True,timeout=45)
            (test/'harness-install.json').write_text(install.stdout)
            (test/'harness-install.stderr').write_text(install.stderr)
            assert install.returncode==0,install.stderr[-4000:]
            harness_receipt=json.loads(install.stdout)
            assert (harness_receipt['id'],harness_receipt['version'])==(HARNESS_ID,HARNESS_VERSION)
        prompt='''Play this single unfamiliar ARC-AGI-3 game to completion by discovering its rules through observations and experiments. This is a timed diagnostic of your own autonomous ability, not a request for general advice.
You have at most 600 seconds and 200 game actions. Do not stop early merely to report progress. Keep observing, forming hypotheses, acting, and correcting until the engine says state WIN or stopped true. GAME_OVER is not the end of the attempt: use RESET and keep learning within budget. A game has several levels; levels_completed is not whole-game WIN.
The ONLY interface to the game is the neutral local command: python3 arc_cli.py status; python3 arc_cli.py action ACTION1; python3 arc_cli.py action ACTION6 20 30. For a short sequence use python3 arc_cli.py batch '[{"action":"ACTION1"},{"action":"ACTION2"}]' (maximum 10). Only send actions from available_actions, except RESET which is always allowed. Coordinates are integers 0..63, top-left origin. Actions 1..4 are directional controls but infer their actual effect, 5 is an optional game-specific control, 6 is a click with x,y, 7 is undo when supported. RESET restarts according to engine rules.
Each command returns authoritative state and refreshes frame.png (512px nearest-neighbor visualization of the latest 64x64 grid), grid.txt (row numbers then hexadecimal color IDs 0..F), frame.json (the exact grid). Use the read tool on frame.png to see the native image now, and after meaningful changes. For exact analysis you can read the text grid or write your own scripts using only observations in this workspace. You may batch a few purposeful actions but inspect feedback and adapt. Prior animation frames and observations are recorded automatically; current frame is always the last frame returned by the game.
Do not access game implementation, environment files, another solver, internet, precomputed solutions, hidden state, or files outside this workspace. The neutral CLI contains no rules. Discover and maintain your own rules/plans in Morphz memory; do not ask a human for moves. Do not claim success unless engine state is WIN. Start by running status and reading frame.png. Then actually play.'''
        prompt=prompt.replace('600 seconds and 200 game actions',f'{BUDGET_S} seconds and {MAX_ACTIONS} game actions')
        if arm=='discovery':
            prompt=f'''Play the current unfamiliar ARC-AGI-3 game through all levels. You have at most {BUDGET_S} seconds and {MAX_ACTIONS} submitted environment actions, including resets. Follow the installed arc-discovery Harness. The local bridge is already running; use python3 arc_cli.py observe and python3 arc_cli.py step ACTIONn [x y]. Native images remain available as frame.png. Use only observations in this workspace, not engine/source files, network, another solver, or precomputed moves. Discover rules from evidence, revise them on contradiction, and continue until official state WIN or stopped=true. Start now.'''
        (test/'prompt.txt').write_text(prompt)
        args=[str(morphz),'exec','--cwd',str(workspace),'--config-file',str(config),'--approval','never','--sandbox','full-access','--reasoning-effort','medium','--log-level','info',prompt]
        if arm=='discovery': args[-1:-1]=['--harness',f'{HARNESS_ID}@{HARNESS_VERSION}']
        (test/'execution-argv.json').write_text(json.dumps(args,indent=2))
        start=time.monotonic(); start_wire=len(wire_records)
        with (test/'runtime.log').open('w') as out:
            child=subprocess.Popen(args,cwd=workspace,env=runtime_env,stdout=out,stderr=subprocess.STDOUT,start_new_session=True)
        print('GAME_STARTED',game,'ARM',arm,'BUDGET',BUDGET_S,'ACTIONS',MAX_ACTIONS,flush=True)
        last_progress=0; last_status={}; stop_reason=None
        while child.poll() is None:
            elapsed=time.monotonic()-start
            try: last_status=request_json(port,'/status')
            except Exception as exc: stop_reason='bridge_error:'+repr(exc); break
            if elapsed-last_progress>=20:
                print('GAME_PROGRESS',game,arm,round(elapsed),json.dumps(last_status),flush=True); last_progress=elapsed
            if last_status['stopped'] or elapsed>=BUDGET_S+5:
                stop_reason=last_status.get('stop_reason') or 'wall_budget'; break
            time.sleep(1)
        elapsed=time.monotonic()-start
        if child.poll() is None:
            child.terminate()
            try: child.wait(timeout=15)
            except subprocess.TimeoutExpired: child.kill(); child.wait()
        final=request_json(port,'/status')
        calls=wire_records[start_wire:]
        jobs=[]; bindings=[]
        with sqlite3.connect(test/'runtime.db') as db:
            if db.execute("SELECT 1 FROM sqlite_master WHERE name='execution_jobs'").fetchone():
                db.row_factory=sqlite3.Row
                jobs=[dict(row) for row in db.execute('SELECT * FROM execution_jobs')]
            if db.execute("SELECT 1 FROM sqlite_master WHERE name='events'").fetchone():
                bindings=[json.loads(row[0]) for row in db.execute(
                    'SELECT payload FROM events WHERE topic=?',('runtime/evaluation_harness_binding',))]
        (test/'harness-bindings.json').write_text(json.dumps(bindings,indent=2))
        binding_verified=arm=='baseline' or any(
            b.get('harness_id')==HARNESS_ID and b.get('harness_version')==HARNESS_VERSION
            and b.get('artifact_hash')==harness_receipt['artifact_hash'] for b in bindings)
        (test/'tool-jobs.json').write_text(json.dumps(jobs,indent=2,default=str))
        total_input=sum((r.get('usage') or {}).get('prompt_tokens',0) for r in calls)
        total_output=sum((r.get('usage') or {}).get('completion_tokens',0) for r in calls)
        tools_exposed=any(bool(r['request'].get('tools')) for r in calls)
        successful_requests=sum(r.get('status')==200 and r.get('completed',False) for r in calls)
        invalid_reasons=[]
        if not binding_verified: invalid_reasons.append('harness_binding_missing_or_mismatched')
        if not calls: invalid_reasons.append('no_model_requests')
        if not tools_exposed: invalid_reasons.append('no_tools_exposed_on_provider_wire')
        if not successful_requests: invalid_reasons.append('no_completed_http_200_model_request')
        runtime_log=(test/'runtime.log').read_text(errors='replace')
        runtime_protocol_failed='protocol_invalid' in runtime_log
        runtime_evaluation_failed='Thread Activation evaluation failed' in runtime_log
        runtime_end=('runtime_protocol_invalid' if runtime_protocol_failed else
                     'runtime_evaluation_failed' if runtime_evaluation_failed else 'runtime_returned')
        result=dict(game=game,arm=arm,**final,wall_s=round(elapsed,3),runtime_exit_code=child.returncode,
            termination=stop_reason or ('WIN' if final['state']=='WIN' else runtime_end),
            runtime_protocol_failed=runtime_protocol_failed,
            runtime_evaluation_failed=runtime_evaluation_failed,
            model_requests=len(calls),image_requests=sum(r['images_in_request']>0 for r in calls),
            prompt_tokens_total=total_input,completion_tokens_total=total_output,
            tool_jobs=len(jobs),runtime_version='v0.1.3',reasoning_effort='medium',
            runtime_binary_sha256=sha256(morphz),
            harness=f'{HARNESS_ID}@{HARNESS_VERSION}' if arm=='discovery' else None,
            harness_source_sha256=sha256(SOURCE/'arc-discovery.hns') if arm=='discovery' else None,
            harness_binding_verified=binding_verified if arm=='discovery' else None,
            tools_exposed_on_provider_wire=tools_exposed,
            completed_http_200_model_requests=successful_requests,
            valid_run=not invalid_reasons,invalid_reasons=invalid_reasons,
            memory_context_tokens=262144,formal_competition_score=False,
            source_access_enforcement='instruction and tool-log audit; full-access shell is not a sealed source sandbox')
        (test/'result.json').write_text(json.dumps(result,indent=2))
        print('GAME_RESULT',json.dumps(result),flush=True)
        return result
    finally:
        bridge.terminate()
        try: bridge.wait(timeout=5)
        except subprocess.TimeoutExpired: bridge.kill(); bridge.wait()

results=[]
for game in GAMES:
    for arm in ARMS:
        try: results.append(run_game(game,arm))
        except Exception as exc:
            failure=dict(game=game,arm=arm,run_error=repr(exc)); results.append(failure)
            print('GAME_FAILED',json.dumps(failure),flush=True)
        (ARC_WORK/'results.json').write_text(json.dumps(results,indent=2))
print('PUBLIC_SAMPLE_COMPLETE',json.dumps(results),flush=True)
gpu_stop_arc.set()
proxy.shutdown()
