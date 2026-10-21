# Diagnostic evidence only. No game strategy, game-source inspection or extra run.
import re
diagnostics={}
for result in actual_results:
    game=result['game']; directory=ARC_WORK/game
    log=(directory/'runtime.log').read_text(errors='replace')
    log=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',log)
    inputs=[int(v) for v in re.findall(r'(?<![A-Za-z_])input_tokens=Some\((\d+)\)',log)]
    outputs=[int(v) for v in re.findall(r'output_tokens=Some\((\d+)\)',log)]
    latencies=[int(v)/1e6 for v in re.findall(r'stage="provider.stream_completed" outcome="ok" duration_micros=(\d+)',log)]
    length_failures=[line for line in log.splitlines() if 'state="failed"' in line and 'output length limit' in line]
    jobs=json.loads((directory/'tool-jobs.json').read_text()) if (directory/'tool-jobs.json').exists() else []
    failed_jobs=[{k:j.get(k) for k in ('tool_name','status','request_json','error','exit_code')} for j in jobs if j.get('status')=='failed']
    review=[]
    for job in jobs:
        request=job.get('request_json','')
        if any(term in request for term in ('/kaggle/input','arcengine','environment_files','site-packages','bridge-source')):
            review.append({k:job.get(k) for k in ('tool_name','request_json','status')})
    diagnostics[game]={'max_input_tokens':max(inputs,default=0),'max_reported_output_tokens':max(outputs,default=0),
        'model_reply_s_max':max(latencies,default=0),'output_limit_failure_attempts':len(length_failures),
        'failed_tool_jobs':failed_jobs,'source_access_review_candidates':review}
wire=[json.loads(line) for line in (ARC_WORK/'provider-wire.jsonl').read_text().splitlines()]
serve_log=(WORK/'serve.log').read_text(errors='replace')
diagnostics['transport']={'finished_request_records':len(wire),
    'requests_with_images':sum(r.get('images_in_request',0)>0 for r in wire),
    'image_requests_http_200':sum(r.get('images_in_request',0)>0 and r.get('status')==200 for r in wire),
    'cuda_oom_reported':bool(re.search(r'CUDA out of memory|torch\.OutOfMemoryError',serve_log)),
    'kv_scaling_warning':'default scaling factor' in serve_log or 'scaling factors' in serve_log,
    'kernel_data_race_warning':'Data race detected' in serve_log}
(ARC_WORK/'diagnostics.json').write_text(json.dumps(diagnostics,indent=2))
print('RUN_DIAGNOSTICS',json.dumps(diagnostics),flush=True)
