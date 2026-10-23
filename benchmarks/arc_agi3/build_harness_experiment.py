"""Build a private Kaggle deployment bundle/Notebook; never upload or submit.

Only the explicit benchmark allowlist, the supplied Linux binary and public
license notices are packaged. No user configuration, credentials or DBs enter.
"""
import argparse
import base64
import gzip
import hashlib
import json
from pathlib import Path
import re
import struct
import subprocess
import zipfile

HERE=Path(__file__).resolve().parent
REPO=HERE.parents[1]
SOURCES=('arc_bridge.py','arc_cli.py','arc_observation.py','arc-discovery.hns',
         'arc-algorithms.hns','arc_algorithms.py','arc_solver.py','arc_model_adapter.py','test_arc_algorithms.py',
         'test_algorithm_harness_runtime.py',
         'arc_runner.py','arc_experiment_report.py','flash_next_bootstrap_arc.py',
         'arc_experiment_diagnostics.py','test_arc_experiment_diagnostics.py',
         'test_harness_tool_admission.py',
         'test_arc_bridge.py','test_arc_cli.py','test_arc_observation.py')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def cell(source,kind='code'):
    result={'cell_type':kind,'metadata':{},'source':source.splitlines(keepends=True)}
    if kind=='code': result.update(execution_count=None,outputs=[])
    return result


def build(runtime,output,commit,harness='arc-discovery',base_bundle=None,profile='paired'):
    if profile not in ('paired','actor-integration') or profile=='actor-integration' and harness!='arc-algorithms':
        raise ValueError('Select an explicitly supported experiment profile')
    if harness not in ('arc-discovery','arc-algorithms'):
        raise ValueError('Select an explicitly allowlisted Harness')
    binary=runtime.read_bytes()
    if binary[:6]!=b'\x7fELF\x02\x01' or struct.unpack('<H',binary[18:20])[0]!=62:
        raise ValueError('Expected a little-endian ELF64 x86_64 runtime, not the local Mac binary')
    output.mkdir(parents=True,exist_ok=True)
    content={name:(HERE/name).read_bytes() for name in SOURCES}
    version_match=re.search(r'\(version\s+"([^"]+)"\)',content[f'{harness}.hns'].decode())
    if version_match is None: raise ValueError('Harness manifest must declare a version')
    harness_version=version_match.group(1)
    content['morphz']=binary
    for name in ('LICENSE','NOTICE','THIRD_PARTY_NOTICES.md'):
        if (REPO/name).is_file(): content[name]=(REPO/name).read_bytes()
    manifest={'schema':'morphz-arc-harness-deployment@1','runtime_commit':commit,
              'runtime_sha256':digest(binary),'harness':f'{harness}@{harness_version}',
              'files':{name:digest(data) for name,data in content.items()},
              'training':False,'paid_services':[],'formal_submission':False}
    content['deployment.json']=json.dumps(manifest,indent=2).encode()
    bundle=output/'morphz-arc-harness-deployment.zip'
    unchanged=False
    if bundle.exists():
        with zipfile.ZipFile(bundle) as archive:
            unchanged=(set(archive.namelist())==set(content)
                       and all(archive.read(name)==data for name,data in content.items()))
    if not unchanged:
        with zipfile.ZipFile(bundle,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
            for name,data in content.items():
                entry=zipfile.ZipInfo(name,date_time=(2026,10,23,0,0,0))
                entry.compress_type=zipfile.ZIP_DEFLATED
                archive.writestr(entry,data,compresslevel=6)
    bundle_hash=digest(bundle.read_bytes())
    stage=f'''# Verify the new runtime and benchmark before loading the model.
import hashlib, json, shutil, subprocess, zipfile
from pathlib import Path
DEPLOY=Path('/tmp/morphz-arc-harness-deployment')
DEPLOY.mkdir(exist_ok=True)
bundles=list(Path('/kaggle/input').rglob('morphz-arc-harness-deployment.zip'))
if bundles:
    assert len(bundles)==1
    assert hashlib.sha256(bundles[0].read_bytes()).hexdigest()=={bundle_hash!r}
    with zipfile.ZipFile(bundles[0]) as archive:
        assert all('/' not in n and '\\\\' not in n and n not in ('.','..') for n in archive.namelist())
        archive.extractall(DEPLOY)
else:
    # Kaggle can unpack uploaded ZIPs while creating a Dataset.
    manifests=[p for p in Path('/kaggle/input').rglob('deployment.json')
        if hashlib.sha256(p.read_bytes()).hexdigest()=={digest(content['deployment.json'])!r}]
    assert len(manifests)==1, f'Expected one hash-pinned deployment manifest: {{manifests}}'
    staged=json.loads(manifests[0].read_text())
    for name in (*staged['files'],'deployment.json'):
        assert '/' not in name and '\\\\' not in name and name not in ('.','..')
        shutil.copy2(manifests[0].parent/name,DEPLOY/name)
'''
    if base_bundle is not None:
        with zipfile.ZipFile(base_bundle) as old:
            assert digest(old.read('morphz'))==manifest['runtime_sha256'], 'Base input must contain the identical Runtime binary'
            old_manifest_hash=digest(old.read('deployment.json'))
        overlay=base64.b64encode(gzip.compress(json.dumps({
            name:base64.b64encode(data).decode() for name,data in content.items()
            if name!='morphz'}).encode(),mtime=0)).decode()
        stage=f'''# Reuse only the identical binary from the already verified private input.
import base64, gzip, hashlib, json, shutil, subprocess, zipfile
from pathlib import Path
DEPLOY=Path('/tmp/morphz-arc-harness-deployment')
DEPLOY.mkdir(exist_ok=True)
bundles=list(Path('/kaggle/input').rglob('morphz-arc-harness-deployment.zip'))
if bundles:
    assert len(bundles)==1
    assert hashlib.sha256(bundles[0].read_bytes()).hexdigest()=={digest(base_bundle.read_bytes())!r}
    with zipfile.ZipFile(bundles[0]) as old:
        runtime_bytes=old.read('morphz')
else:
    manifests=[p for p in Path('/kaggle/input').rglob('deployment.json')
        if hashlib.sha256(p.read_bytes()).hexdigest()=={old_manifest_hash!r}]
    assert len(manifests)==1, 'Expected the previously verified base input manifest'
    runtime_bytes=(manifests[0].parent/'morphz').read_bytes()
assert hashlib.sha256(runtime_bytes).hexdigest()=={manifest['runtime_sha256']!r}
(DEPLOY/'morphz').write_bytes(runtime_bytes)
overlay=json.loads(gzip.decompress(base64.b64decode({overlay!r})))
for name,encoded in overlay.items():
    assert '/' not in name and '\\\\' not in name and name not in ('.','..','morphz')
    (DEPLOY/name).write_bytes(base64.b64decode(encoded))
print('PINNED_SOURCE_OVERLAY_STAGED',flush=True)
'''
    verify=f'''
assert hashlib.sha256((DEPLOY/'deployment.json').read_bytes()).hexdigest()=={digest(content['deployment.json'])!r}
RUNTIME_BUILD=json.loads((DEPLOY/'deployment.json').read_text())
for name,expected in RUNTIME_BUILD['files'].items():
    assert hashlib.sha256((DEPLOY/name).read_bytes()).hexdigest()==expected, name
(DEPLOY/'morphz').chmod(0o755)
subprocess.run([str(DEPLOY/'morphz'),'--version'],check=True)
subprocess.run([str(DEPLOY/'morphz'),'harness','check',str(DEPLOY/'arc-discovery.hns'),'--format','json'],check=True)
print('DEPLOYMENT_VERIFIED',json.dumps({{'runtime_commit':RUNTIME_BUILD['runtime_commit'],'runtime_sha256':RUNTIME_BUILD['runtime_sha256']}}),flush=True)
'''
    preflight=stage+verify
    bootstrap='''# Verify real hardware before installing the approved offline stack.
gpu_check=subprocess.run(['nvidia-smi','--query-gpu=name,memory.total,driver_version','--format=csv,noheader,nounits'],capture_output=True,text=True)
print('ACTUAL_GPU_CHECK',json.dumps({'returncode':gpu_check.returncode,'stdout':gpu_check.stdout,'stderr':gpu_check.stderr}),flush=True)
assert gpu_check.returncode==0 and gpu_check.stdout.strip(), 'Requested GPU not exposed to the container'
assert all(int(line.split(',')[1])>=96000 for line in gpu_check.stdout.strip().splitlines()), 'Same-model experiment requires the selected 96GB RTX PRO 6000'
# Reuse the exact previously approved Pennyroyal v2.5.3 offline stack.
MORPHZ_ARC_WORK='/kaggle/working/morphz-arc3-harness-20261023'
exec(compile((DEPLOY/'flash_next_bootstrap_arc.py').read_text(),str(DEPLOY/'flash_next_bootstrap_arc.py'),'exec'))
# Both comparison arms use this verified new binary, never the legacy release.
morphz=DEPLOY/'morphz'
assert sha256(morphz)==RUNTIME_BUILD['runtime_sha256']
print('ACTIVE_RUNTIME_VERIFIED',morphz,RUNTIME_BUILD['runtime_sha256'],flush=True)
'''
    experiment='''# Targeted engineering A/B selected before this run, not a private-set score.
ARC_EXPERIMENT={'games':['ft09'],'arms':['baseline','discovery'],'budget_s':600,'max_actions':200,'harness_version':HARNESS_VERSION_PIN,'output':'arc-harness-v1-ft09-ab'}
ARC_SOURCE=WORK/ARC_EXPERIMENT['output']/'bridge-source'
ARC_SOURCE.mkdir(parents=True,exist_ok=True)
for name in ('arc_bridge.py','arc_cli.py','arc_observation.py','arc-discovery.hns'):
    shutil.copy2(DEPLOY/name,ARC_SOURCE/name)
try:
    ARC_RUNNER_RECEIPT={'sha256':sha256(DEPLOY/'arc_runner.py'),'source':'verified deployment bundle'}
    exec(compile((DEPLOY/'arc_runner.py').read_text(),str(DEPLOY/'arc_runner.py'),'exec'))
    exec(compile((DEPLOY/'arc_experiment_report.py').read_text(),str(DEPLOY/'arc_experiment_report.py'),'exec'))
finally:
    if 'gpu_stop_arc' in globals(): gpu_stop_arc.set()
    if 'proxy' in globals(): proxy.shutdown()
    if 'server' in globals() and server.poll() is None:
        server.terminate()
        try: server.wait(timeout=20)
        except subprocess.TimeoutExpired: server.kill(); server.wait()
print('HARNESS_DIAGNOSTIC_ARCHIVE_READY',str(WORK),flush=True)
'''
    experiment=experiment.replace('HARNESS_VERSION_PIN',repr(harness_version))
    notebook={'nbformat':4,'nbformat_minor':5,'metadata':{
        'kernelspec':{'display_name':'Python 3','language':'python','name':'python3'},
        'language_info':{'name':'python'},
        'kaggle':{'accelerator':'nvidiaRtxPro6000','isGpuEnabled':True,
                  'isInternetEnabled':False,'language':'python','sourceType':'notebook'}},'cells':[
        cell('# Morphz ARC-AGI-3 Harness experiment\n\nPrivate, offline, same-model A/B. No training, paid APIs or formal submission. Add the official ARC-AGI-3 competition, approved Pennyroyal v2.5.3 bundle, Flash-Next W4A16 V1, existing offline Python preparation input and this private deployment bundle. Select free RTX PRO 6000; internet off.\n','markdown'),
        cell(preflight),cell(bootstrap),cell(experiment)]}
    if harness=='arc-algorithms':
        notebook['cells'][1]['source']=[line.replace("str(DEPLOY/'arc-discovery.hns')", "str(DEPLOY/'arc-algorithms.hns')")
                                      for line in notebook['cells'][1]['source']]
        algorithm_experiment='''# Predeclared same-binary/model A/B, six fresh attempts, no formal submission.
ARC_EXPERIMENT={'games':['ft09','ls20','vc33'],'arms':['baseline','discovery'],'budget_s':600,'max_actions':200,'harness_id':'arc-algorithms','harness_file':'arc-algorithms.hns','harness_version':HARNESS_VERSION_PIN,'algorithm_tools':True,'output':'arc-algorithms-v030-public-ab'}
ARC_SOURCE=WORK/ARC_EXPERIMENT['output']/'bridge-source'
ARC_SOURCE.mkdir(parents=True,exist_ok=True)
for name in ('arc_bridge.py','arc_cli.py','arc_observation.py','arc-algorithms.hns','arc_algorithms.py','arc_solver.py','arc_model_adapter.py'):
    shutil.copy2(DEPLOY/name,ARC_SOURCE/name)
try:
    ARC_RUNNER_RECEIPT={'sha256':sha256(DEPLOY/'arc_runner.py'),'source':'verified algorithm deployment bundle'}
    exec(compile((DEPLOY/'arc_runner.py').read_text(),str(DEPLOY/'arc_runner.py'),'exec'))
    exec(compile((DEPLOY/'arc_experiment_report.py').read_text(),str(DEPLOY/'arc_experiment_report.py'),'exec'))
    audit_ns={'__name__':'arc_saved_receipts'}
    exec(compile((DEPLOY/'arc_experiment_diagnostics.py').read_text(),str(DEPLOY/'arc_experiment_diagnostics.py'),'exec'),audit_ns)
    diagnostics=audit_ns['summarize'](ARC_WORK)
    (ARC_WORK/'DIAGNOSTICS.json').write_text(json.dumps(diagnostics,indent=2))
    print('ALGORITHM_DIAGNOSTICS',json.dumps(diagnostics),flush=True)
finally:
    if 'gpu_stop_arc' in globals(): gpu_stop_arc.set()
    if 'proxy' in globals(): proxy.shutdown()
    if 'server' in globals() and server.poll() is None:
        import signal
        os.killpg(server.pid,signal.SIGTERM)
        try: server.wait(timeout=20)
        except subprocess.TimeoutExpired: os.killpg(server.pid,signal.SIGKILL); server.wait()
print('ALGORITHM_EXPERIMENT_ARCHIVE_READY',str(WORK),flush=True)
'''.replace('HARNESS_VERSION_PIN',repr(harness_version))
        if profile=='actor-integration':
            algorithm_experiment=algorithm_experiment.replace("'games':['ft09','ls20','vc33']", "'games':['ft09','ls20']")
            algorithm_experiment=algorithm_experiment.replace("'arms':['baseline','discovery']", "'arms':['discovery']")
            algorithm_experiment=algorithm_experiment.replace("'output':'arc-algorithms-v030-public-ab'", "'actor_adapter':True,'bounded_batches':16,'output':'arc-algorithms-v032-actor-integration'")
            notebook['cells'][0]=cell('# Morphz ARC-AGI-3 actor integration repair\n\nPrivate bounded follow-up, not a pure algorithm ablation. Same Flash-Next V1 and Runtime binary. Semantic actors receive the exact capture-bound PNG and constrained non-thinking JSON generation; native provider adaptation is explicitly recorded. Two public games, candidate only, 600 seconds / 200 actions each. No training, paid APIs or formal submission.\n','markdown')
        notebook['cells'][3]=cell(algorithm_experiment)
    destination=output/'morphz-arc-harness-experiment.ipynb'
    destination.write_text(json.dumps(notebook,ensure_ascii=False,indent=2))
    # Equivalent official-CLI script launcher for Notebook provisioning failures.
    # Solving sources, hashes and the predeclared experiment remain identical.
    script=output/'morphz-arc-harness-experiment.py'
    script.write_text("print('MORPHZ_ARC_SCRIPT_STARTED', flush=True)\n\n" +
                      '\n\n'.join(''.join(item['source']) for item in notebook['cells']
                                  if item['cell_type']=='code'))
    (output/'deployment-manifest.json').write_text(json.dumps(manifest,indent=2))
    return {'bundle':str(bundle),'bundle_sha256':bundle_hash,'notebook':str(destination),'script':str(script),
            'runtime_commit':commit,'runtime_sha256':manifest['runtime_sha256']}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--runtime',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--runtime-commit',required=True,
                   help='Commit whose clean Rust sources produced this binary; do not guess from --version')
    p.add_argument('--harness',choices=('arc-discovery','arc-algorithms'),default='arc-discovery')
    p.add_argument('--base-bundle',type=Path,help='Reuse the identical binary in a previously verified private input; inline hash-verified sources')
    p.add_argument('--profile',choices=('paired','actor-integration'),default='paired')
    args=p.parse_args()
    print(json.dumps(build(args.runtime,args.output,args.runtime_commit,args.harness,args.base_bundle,args.profile),indent=2))


if __name__=='__main__': main()
