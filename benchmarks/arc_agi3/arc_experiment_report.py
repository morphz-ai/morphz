"""Summarize saved engine evidence, not model claims. Run in the Kaggle kernel."""
actual_results=json.loads((ARC_WORK/'results.json').read_text())
audits=[]
for result in actual_results:
    label=f"{result['game']}-{result['arm']}"
    directory=ARC_WORK/label
    trajectory=directory/'workspace'/'trajectory.jsonl'
    if not trajectory.exists():
        audits.append({'run':label,'run_error':result.get('run_error'),'evidence':'no engine trajectory'})
        continue
    rows=[json.loads(line) for line in trajectory.read_text().splitlines()]
    frames=[json.dumps(row['frame'][-1],separators=(',',':')) if row['frame'] else None for row in rows]
    log=(directory/'runtime.log').read_text(errors='replace') if (directory/'runtime.log').exists() else ''
    log=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',log)
    jobs=json.loads((directory/'tool-jobs.json').read_text()) if (directory/'tool-jobs.json').exists() else []
    audit={'run':label,'observed_actions':len(rows)-1,
           'unique_visible_frames':len(set(frames)),
           'unchanged_visible_frames':sum(a is not None and a==b for a,b in zip(frames,frames[1:])),
           'level_transitions':[{k:r[k] for k in ('actions','state','levels_completed','elapsed_s')}
               for i,r in enumerate(rows) if i==0 or r['state']!=rows[i-1]['state']
               or r['levels_completed']!=rows[i-1]['levels_completed']],
           'output_limit_failure_lines':[line for line in log.splitlines()
               if 'state="failed"' in line and 'output length limit' in line],
           'source_access_review_candidates':[j for j in jobs if any(term in str(j.get('request_json',''))
               for term in ('/kaggle/input','arcengine','environment_files','site-packages','bridge-source'))]}
    audits.append(audit)
    print('EXPERIMENT_AUDIT',json.dumps(audit),flush=True)
(ARC_WORK/'audits.json').write_text(json.dumps(audits,indent=2,default=str))
lines=['# ARC-AGI-3 Harness experiment','',
       'Private exploratory public-game test. NOT an official score or leaderboard submission.','',
       '| Game | Arm | Best levels | WIN | Actions | Wall seconds |',
       '|:--|:--|--:|:--:|--:|--:|']
for r in actual_results:
    if 'run_error' in r or not r.get('valid_run',False):
        lines.append(f"| {r['game']} | {r['arm']} | Not measured | — | — | Infrastructure error |")
    else:
        lines.append(f"| {r['game_id']} | {r['arm']} | {r['max_levels_completed']} / {r['total_levels']} | {r['state']=='WIN'} | {r['actions']} | {r['wall_s']:.3f} |")
lines+=['',f'Fixed per-run limits: {BUDGET_S} seconds, {MAX_ACTIONS} submitted actions, seed 0.',
        'Same local model, context, output cap, reasoning effort and Runtime binary in both arms.',
        'Discovery arm changes both the installed Harness and advertised visible-observation interface.',
        'One capped attempt per arm is diagnostic, not a statistically robust improvement estimate.',
        'Only official engine state and trajectory establish progress. Full-access shell is not a sealed anti-cheating sandbox.']
summary='\n'.join(lines)
(ARC_WORK/'SUMMARY.md').write_text(summary)
print(summary,flush=True)
try:
    with urllib.request.urlopen('http://127.0.0.1:8000/get_server_info',timeout=10) as response:
        info=json.load(response)
    (ARC_WORK/'server-info.json').write_text(json.dumps(info,indent=2))
    assert info['context_length']==262144
except Exception as exc:
    print('SERVER_INFO_CHECK_FAILED',repr(exc),flush=True)
