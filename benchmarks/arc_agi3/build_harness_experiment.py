"""Build a private Kaggle deployment bundle/Notebook; never upload or submit.

Only the explicit benchmark allowlist, the supplied Linux binary and public
license notices are packaged. No user configuration, credentials or DBs enter.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import zipfile

HERE=Path(__file__).resolve().parent
REPO=HERE.parents[1]
SOURCES=('arc_bridge.py','arc_cli.py','arc_observation.py','arc-discovery.hns',
         'arc_runner.py','arc_experiment_report.py','flash_next_bootstrap_arc.py',
         'test_arc_bridge.py','test_arc_cli.py','test_arc_observation.py')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def cell(source,kind='code'):
    result={'cell_type':kind,'metadata':{},'source':source.splitlines(keepends=True)}
    if kind=='code': result.update(execution_count=None,outputs=[])
    return result


def build(runtime,output,commit):
    binary=runtime.read_bytes()
    if binary[:6]!=b'\x7fELF\x02\x01' or struct.unpack('<H',binary[18:20])[0]!=62:
        raise ValueError('Expected a little-endian ELF64 x86_64 runtime, not the local Mac binary')
    output.mkdir(parents=True,exist_ok=True)
    content={name:(HERE/name).read_bytes() for name in SOURCES}
    content['morphz']=binary
    for name in ('LICENSE','NOTICE','THIRD_PARTY_NOTICES.md'):
        if (REPO/name).is_file(): content[name]=(REPO/name).read_bytes()
    manifest={'schema':'morphz-arc-harness-deployment@1','runtime_commit':commit,
              'runtime_sha256':digest(binary),'harness':'arc-discovery@0.1.0',
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
    preflight=f'''# Verify the new runtime and benchmark before loading the model.
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
assert hashlib.sha256((DEPLOY/'deployment.json').read_bytes()).hexdigest()=={digest(content['deployment.json'])!r}
RUNTIME_BUILD=json.loads((DEPLOY/'deployment.json').read_text())
for name,expected in RUNTIME_BUILD['files'].items():
    assert hashlib.sha256((DEPLOY/name).read_bytes()).hexdigest()==expected, name
(DEPLOY/'morphz').chmod(0o755)
subprocess.run([str(DEPLOY/'morphz'),'--version'],check=True)
subprocess.run([str(DEPLOY/'morphz'),'harness','check',str(DEPLOY/'arc-discovery.hns'),'--format','json'],check=True)
print('DEPLOYMENT_VERIFIED',json.dumps({{'runtime_commit':RUNTIME_BUILD['runtime_commit'],'runtime_sha256':RUNTIME_BUILD['runtime_sha256']}}),flush=True)
'''
    bootstrap='''# Reuse the exact previously approved Pennyroyal v2.5.3 offline stack.
MORPHZ_ARC_WORK='/kaggle/working/morphz-arc3-harness-20261023'
exec(compile((DEPLOY/'flash_next_bootstrap_arc.py').read_text(),str(DEPLOY/'flash_next_bootstrap_arc.py'),'exec'))
# Both comparison arms use this verified new binary, never the legacy release.
morphz=DEPLOY/'morphz'
assert sha256(morphz)==RUNTIME_BUILD['runtime_sha256']
print('ACTIVE_RUNTIME_VERIFIED',morphz,RUNTIME_BUILD['runtime_sha256'],flush=True)
'''
    experiment='''# Targeted engineering A/B selected before this run, not a private-set score.
ARC_EXPERIMENT={'games':['ft09'],'arms':['baseline','discovery'],'budget_s':600,'max_actions':200,'output':'arc-harness-v1-ft09-ab'}
ARC_SOURCE=WORK/ARC_EXPERIMENT['output']/'bridge-source'
ARC_SOURCE.mkdir(parents=True,exist_ok=True)
for name in ('arc_bridge.py','arc_cli.py','arc_observation.py','arc-discovery.hns'):
    shutil.copy2(DEPLOY/name,ARC_SOURCE/name)
try:
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
    notebook={'nbformat':4,'nbformat_minor':5,'metadata':{
        'kernelspec':{'display_name':'Python 3','language':'python','name':'python3'},
        'language_info':{'name':'python'}},'cells':[
        cell('# Morphz ARC-AGI-3 Harness experiment\n\nPrivate, offline, same-model A/B. No training, paid APIs or formal submission. Add the official ARC-AGI-3 competition, approved Pennyroyal v2.5.3 bundle, Flash-Next W4A16 V1, existing offline Python preparation input and this private deployment bundle. Select free RTX PRO 6000; internet off.\n','markdown'),
        cell(preflight),cell(bootstrap),cell(experiment)]}
    destination=output/'morphz-arc-harness-experiment.ipynb'
    destination.write_text(json.dumps(notebook,ensure_ascii=False,indent=2))
    (output/'deployment-manifest.json').write_text(json.dumps(manifest,indent=2))
    return {'bundle':str(bundle),'bundle_sha256':bundle_hash,'notebook':str(destination),
            'runtime_commit':commit,'runtime_sha256':manifest['runtime_sha256']}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--runtime',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--runtime-commit',required=True,
                   help='Commit whose clean Rust sources produced this binary; do not guess from --version')
    args=p.parse_args()
    print(json.dumps(build(args.runtime,args.output,args.runtime_commit),indent=2))


if __name__=='__main__': main()
