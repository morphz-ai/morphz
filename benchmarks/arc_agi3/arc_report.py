# Read actual engine/provider/Runtime outputs after the games; do not infer wins
# from a model's final answer or from process exit codes.
from IPython.display import display, Markdown
import collections
actual_results=json.loads((ARC_WORK/'results.json').read_text())
try:
    with urllib.request.urlopen('http://127.0.0.1:8000/get_server_info',timeout=10) as response:
        live_server=json.load(response)
    (ARC_WORK/'server-info.json').write_text(json.dumps(live_server,indent=2))
    assert live_server['context_length']==262144
except Exception as exc:
    print('LIVE_SERVER_CHECK_FAILED',repr(exc),flush=True)

audits=[]
for result in actual_results:
    game=result['game']; directory=ARC_WORK/game
    if not (directory/'workspace'/'trajectory.jsonl').exists():
        audits.append({'game':game,'evidence':'no engine trajectory','error':result.get('run_error')}); continue
    rows=[json.loads(line) for line in (directory/'workspace'/'trajectory.jsonl').read_text().splitlines()]
    transitions=[{k:row[k] for k in ('action','actions','state','levels_completed','elapsed_s')}
        for i,row in enumerate(rows) if i==0 or row['state']!=rows[i-1]['state'] or row['levels_completed']!=rows[i-1]['levels_completed']]
    hashes=[row['frame_sha256'] for row in rows]
    jobs=json.loads((directory/'tool-jobs.json').read_text()) if (directory/'tool-jobs.json').exists() else []
    tool_details=[]
    for job in jobs:
        # Preserve the full receipts in the output directory; show only compact
        # action/argument/status fields in this human-readable audit.
        detail={key:value for key,value in job.items()
            if key in ('tool_name','exit_code') or any(word in key for word in ('kind','status','command','argument','input','request','error'))}
        tool_details.append(detail)
    audit={'game':game,'trajectory_rows':len(rows),'executed_actions':len(rows)-1,
        'unique_observations':len(set(hashes)),'unchanged_consecutive_observations':sum(a==b for a,b in zip(hashes,hashes[1:])),
        'transitions':transitions,'jobs':tool_details}
    audits.append(audit)
    print('ENGINE_AUDIT',json.dumps({k:v for k,v in audit.items() if k!='jobs'}),flush=True)
    print('TOOL_RECEIPTS',game,json.dumps(tool_details,default=str)[-20000:],flush=True)
    log=(directory/'runtime.log').read_text(errors='replace')
    print('RUNTIME_LOG_TAIL',game,log[-7000:],flush=True)
(ARC_WORK/'audits.json').write_text(json.dumps(audits,indent=2,default=str))
samples=[]
if (ARC_WORK/'gpu.jsonl').exists():
    for line in (ARC_WORK/'gpu.jsonl').read_text().splitlines():
        try:
            data=json.loads(line); used,total,util,temp=map(float,data['sample'].split(','))
            samples.append({'used_mib':used,'total_mib':total,'util':util,'temperature':temp})
        except Exception: pass
if samples: print('ACTUAL_GPU_PEAK',json.dumps(max(samples,key=lambda r:r['used_mib'])),flush=True)

lines=['# Morphz × ARC-AGI-3 — public-game diagnostic',
    '', 'Private Kaggle / Qwen3.8-Flash-Next W4A16 / 256K / Morphz v0.1.3',
    '', '**Exploratory sample, not an official competition score.**',
    '', '| Game | Levels (best / total) | Whole-game WIN | Actions | Time | Stop reason |',
    '|:--|--:|:--:|--:|--:|:--|']
for row in actual_results:
    if 'run_error' in row:
        lines.append(f"| {row['game']} | — | Not measured | — | — | Infrastructure error |")
    else:
        lines.append(f"| {row['game_id']} | {row['max_levels_completed']} / {row['total_levels']} | {'YES' if row['state']=='WIN' else 'NO'} | {row['actions']} | {row['wall_s']:.1f} s | {row['termination']} |")
lines+=['', 'Limits fixed in advance: 600 seconds and 200 actions per game, seed 0.',
    'Times exclude model cold start. Progress and wins come from official engine feedback.',
    'See saved trajectories, native image requests, tool receipts and logs in Output.']
summary='\n'.join(lines)
(ARC_WORK/'SUMMARY.md').write_text(summary)
display(Markdown(summary))
