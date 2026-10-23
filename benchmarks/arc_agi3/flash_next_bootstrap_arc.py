# Private, offline Kaggle smoke test. No cloud API or competition submission.
# Serving setup adapted from Daniel Franzen's Apache-2.0 Milestone 2 notebook.
import os, sys, json, hashlib, tarfile, zipfile, shutil, subprocess, re, time, socket
from pathlib import Path
import urllib.request
import threading, concurrent.futures

MODEL_DIR = Path('/kaggle/input/models/dfranzen/intel-qwen3.8-flash-next-w4a16-autoround/transformers/default/1')
BUNDLE = Path('/kaggle/input/datasets/dfranzen/pennyroyal-v253')
WORK = Path(globals().get('MORPHZ_ARC_WORK','/kaggle/working/morphz-arc3-public-baseline'))
WORK.mkdir(exist_ok=True)
PREFIX = Path('/tmp/morphz-flash-next-serving')
PREFIX.mkdir(exist_ok=True)
LOG = WORK/'serve.log'

def sha256(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda:f.read(8*1024*1024), b''): h.update(block)
    return h.hexdigest()

def warm_files(files, workers):
    def read_file(path):
        with Path(path).open('rb') as stream:
            buffer=bytearray(32*1024*1024)
            while stream.readinto(buffer): pass
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(read_file,files))

def run(args, env=None, timeout=900):
    print('RUN:', ' '.join(map(str,args)), flush=True)
    command_log=WORK/'install-command.log'
    start=time.monotonic()
    with command_log.open('w') as out:
        child=subprocess.Popen(list(map(str,args)),env=env,stdout=out,stderr=subprocess.STDOUT)
    try:
        while child.poll() is None:
            if time.monotonic()-start>timeout: raise TimeoutError('Command timeout')
            time.sleep(5)
            print('COMMAND_PROGRESS',round(time.monotonic()-start),command_log.read_text(errors='replace')[-2000:],flush=True)
    except BaseException:
        child.terminate()
        try: child.wait(timeout=10)
        except subprocess.TimeoutExpired: child.kill(); child.wait()
        raise
    print(command_log.read_text(errors='replace')[-4000:],flush=True)
    assert child.returncode == 0, f'command failed: {child.returncode}'
    return child

assert MODEL_DIR.is_dir() and BUNDLE.is_dir(), 'Missing model or approved offline bundle'
manifests = [p for p in Path('/kaggle/input').rglob('manifest.json') if p.parent.name=='flash-next-offline']
assert len(manifests)==1, f'Expected one offline prep artifact: {manifests}'
artifacts = manifests[0].parent
manifest = json.loads(manifests[0].read_text())
for item in manifest['files']:
    assert sha256(artifacts/item['name'])==item['sha256'], f"Artifact checksum failed: {item['name']}"
print('OFFLINE_ARTIFACTS_VERIFIED', flush=True)
pyroot=PREFIX/'python312'
pyroot.mkdir(exist_ok=True)
with tarfile.open(artifacts/'python312.tar.gz') as archive: archive.extractall(pyroot, filter='data')
base_python=next(pyroot.glob('cpython-3.12*/bin/python3.12'))
run([base_python,'--version'])
WHEELS=next(BUNDLE.rglob('wheels'))
LOCK=next(BUNDLE.rglob('requirements.lock'))
uvwheel=next(WHEELS.glob('uv-*.whl'))
uv=PREFIX/'uv'
with zipfile.ZipFile(uvwheel) as archive:
    member=next(n for n in archive.namelist() if Path(n).name=='uv' and not n.endswith('/'))
    binary=archive.read(member)
    assert binary.startswith(b'\x7fELF')
    uv.write_bytes(binary)
uv.chmod(0o755)
venv=PREFIX/'venv'
python=venv/'bin/python'
sglang=venv/'bin/sglang'
install_env=dict(os.environ, UV_OFFLINE='1', UV_PYTHON_DOWNLOADS='never', PYTHONNOUSERSITE='1')
install_env.pop('PYTHONPATH',None)
if not python.exists(): run([uv,'venv','--python',base_python,venv],env=install_env)
if not (PREFIX/'installed').exists():
    print('PRECACHING_OFFLINE_WHEELS',flush=True)
    warm_files(sorted(WHEELS.glob('*.whl')),16)
    # Use bundled pip directly from its wheel, avoiding uv's stalled wheel
    # preparation on this Kaggle session. All versions stay exactly pinned.
    pip_env=dict(install_env,PYTHONPATH=str(next(WHEELS.glob('pip-*.whl'))),PIP_NO_INDEX='1',PIP_DISABLE_PIP_VERSION_CHECK='1')
    install=[python,'-m','pip','install','--no-index','--find-links',WHEELS]
    # The bundle is a complete exact-version lock; do not re-solve its transitive
    # graph against future metadata. Install precisely the pinned wheel set.
    run(install+['--no-deps','-r',LOCK],env=pip_env)
    (PREFIX/'installed').write_text('Pennyroyal v2.5.3')

cuda=next(venv.glob('lib/python*/site-packages/nvidia/cu13'))
assert (cuda/'bin/nvcc').exists()
lib=cuda/'lib'
if not (cuda/'lib64').exists(): (cuda/'lib64').symlink_to('lib')
for so in lib.glob('*.so.*'):
    link=lib/re.sub(r'\.so\..*$', '.so',so.name)
    if not link.exists() and not link.is_symlink(): link.symlink_to(so.name)
if not (lib/'libcuda.so').exists():
    drivers=[p for d in ('/usr/local/nvidia/lib64','/usr/local/nvidia/lib','/usr/lib/x86_64-linux-gnu','/usr/lib64') for p in Path(d).glob('libcuda.so*') if p.is_file()]
    assert drivers, 'GPU driver missing'
    (lib/'libcuda.so').symlink_to(drivers[0].resolve())
cxx=next(c for c in ('g++-15','g++-14','g++-13','g++-12','g++-11','g++') if shutil.which(c))
cache=PREFIX/'cache'
env=dict(install_env)
env.update({
    'HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1','HF_DATASETS_OFFLINE':'1',
    'CUDA_HOME':str(cuda),'CUDACXX':str(cuda/'bin/nvcc'),
    'PATH':f'{cuda}/bin:{venv}/bin:'+env.get('PATH',''),
    'LD_LIBRARY_PATH':f'{cuda}/lib64:{cuda}/lib:'+env.get('LD_LIBRARY_PATH',''),
    'CC':cxx.replace('g++','gcc'),'CXX':cxx,'CUDAHOSTCXX':cxx,
    'TORCH_CUDA_ARCH_LIST':'12.0','XDG_CACHE_HOME':str(cache),'HF_HOME':str(cache/'huggingface'),
    'TORCH_HOME':str(cache/'torch'),'CUDA_CACHE_PATH':str(cache/'cuda'),
    'TORCHINDUCTOR_CACHE_DIR':str(cache/'torchinductor'),'TRITON_CACHE_DIR':str(cache/'triton'),
    'FLASHINFER_WORKSPACE_BASE':str(cache/'flashinfer'),'SGLANG_CACHE_DIR':str(cache/'sglang'),
    'SGLANG_JIT_CACHE_DIR':str(cache/'sglang/jit'),'PYTORCH_CUDA_ALLOC_CONF':'expandable_segments:True',
    'OMP_NUM_THREADS':'8','MKL_NUM_THREADS':'8','TOKENIZERS_PARALLELISM':'false',
    'MAX_JOBS':'8','CMAKE_BUILD_PARALLEL_LEVEL':'8','FLASHINFER_NINJA_JOBS':'8',
    'FLASHINFER_NVCC_THREADS':'2','TORCHINDUCTOR_COMPILE_THREADS':'8',
    'SGLANG_ENABLE_SM120_LOWM_BF16_GEMM':'1','SGLANG_SM120_ONLINE_MXFP8':'0',
    'SGLANG_SM120_LOWM_FP8_WEIGHT':'0','SGLANG_SM120_LM_HEAD_FP8':'0',
    'SGLANG_MAMBA_CONV_DTYPE':'bfloat16','SGLANG_NUMA_BIND_V2':'false',
    'SGLANG_MM_PREPROCESS_DEVICE':'cpu','NUMPY_MADVISE_HUGEPAGE':'0',
})
run([python,'-c','import sglang,torch; print("SGLANG",sglang.__version__,"TORCH",torch.__version__); assert torch.cuda.is_available(); print(torch.cuda.get_device_name(0))'],env=env)
with socket.socket() as s: assert s.connect_ex(('127.0.0.1',8000))!=0, 'Port already in use'
weight_index=json.loads((MODEL_DIR/'model.safetensors.index.json').read_text())
def prefetch_model():
    time.sleep(60)
    warm_files([MODEL_DIR/name for name in sorted(set(weight_index['weight_map'].values()))],3)
prefetch_thread=threading.Thread(target=prefetch_model,daemon=True)
prefetch_thread.start()
args=[sglang,'serve','--model-path',MODEL_DIR,'--load-format','safetensors',
      '--model-loader-extra-config','{"enable_multithread_load":false}',
      '--served-model-name','morphz-flash-next','--host','127.0.0.1','--port','8000',
      '--tensor-parallel-size','1','--dtype','bfloat16','--quantization','auto-round',
      '--kv-cache-dtype','fp8_e4m3','--mem-fraction-static','0.96','--context-length','262144',
      '--page-size','64','--max-running-requests','2','--chunked-prefill-size','8192',
      '--max-prefill-tokens','16384','--cuda-graph-max-bs-decode','2','--cuda-graph-bs-decode','1','2',
      '--mamba-ssm-dtype','bfloat16','--max-mamba-cache-size','12',
      '--mamba-radix-cache-strategy','extra_buffer','--mamba-track-interval','64',
      '--mamba-backend','flashinfer','--linear-attn-decode-backend','flashinfer',
      '--linear-attn-prefill-backend','flashinfer','--moe-runner-backend','auto',
      '--ple-offload-embedding','--mm-feature-transport','cpu','--image-processor-backend','pil',
      '--reasoning-parser','qwen3','--tool-call-parser','qwen3_coder',
      '--default-chat-template-kwargs','{"preserve_thinking":true}',
      '--watchdog-timeout','1800','--schedule-policy','lpm','--warmups','structured_output',
      '--enable-cache-report','--enable-metrics','--enable-request-time-stats-logging',
      '--weight-loader-prefetch-checkpoints','--weight-loader-drop-cache-after-load']
if (MODEL_DIR/'chat_template.jinja').exists(): args+=['--chat-template',MODEL_DIR/'chat_template.jinja']
with LOG.open('ab',buffering=0) as log:
    server=subprocess.Popen(list(map(str,args)),env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
print('SERVER_STARTED',server.pid, 'LOG',LOG,flush=True)
start=time.monotonic()
ready=False
while time.monotonic()-start<1800:
    if server.poll() is not None:
        print(LOG.read_text(errors='replace')[-24000:],flush=True)
        raise RuntimeError(f'Server exited: {server.returncode}')
    try:
        with urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=3) as response:
            if response.status==200: ready=True; break
    except Exception: pass
    print('LOADING',round(time.monotonic()-start),LOG.read_text(errors='replace')[-900:],flush=True)
    time.sleep(20)
assert ready, 'Server startup timeout; inspect serve.log'
print('MODEL_SERVER_READY',round(time.monotonic()-start),flush=True)
payload={'model':'morphz-flash-next','messages':[{'role':'user','content':'Compute 17*23. Reply with only the integer.'}],'max_tokens':128,'temperature':0,'chat_template_kwargs':{'enable_thinking':False}}
request=urllib.request.Request('http://127.0.0.1:8000/v1/chat/completions',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'})
start=time.monotonic()
with urllib.request.urlopen(request,timeout=180) as response: result=json.load(response)
receipt={'elapsed_s':round(time.monotonic()-start,3),'request':payload,'response':result,'paid_services':[]}
(WORK/'direct-response.json').write_text(json.dumps(receipt,indent=2))
print('REAL_MODEL_RESPONSE',json.dumps(receipt),flush=True)
assert '391' in (result['choices'][0]['message'].get('content') or ''), 'Unexpected arithmetic result'
print('DIRECT_MODEL_SMOKE_PASS',flush=True)
runtime=WORK/'morphz-release'
runtime.mkdir(exist_ok=True)
with tarfile.open(artifacts/'morphz-linux-x86_64.tar.gz') as archive: archive.extractall(runtime,filter='data')
morphz=next(p for p in runtime.rglob('morphz') if p.is_file())
morphz.chmod(0o755)
run([morphz,'--version'])
run([morphz,'exec','--help'])
print('READY_FOR_MORPHZ_RUNTIME_TEST',morphz,flush=True)
