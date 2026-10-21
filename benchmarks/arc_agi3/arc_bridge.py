"""Neutral ARC-AGI-3 observation/action bridge. No game strategy or source inspection."""
import argparse
import hashlib
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import arc_agi
import numpy as np
from arcengine import GameAction
from PIL import Image

PALETTE = ['#FFFFFF','#CCCCCC','#999999','#666666','#333333','#000000',
           '#E53AA3','#FF7BCC','#F93C31','#1E93FF','#88D8F1','#FFDC00',
           '#FF851B','#921231','#4FCC30','#A356D6']


class Session:
    def __init__(self, game, env_dir, output, budget_s, max_actions):
        self.output = Path(output)
        self.output.mkdir(parents=True, exist_ok=True)
        self.arc = arc_agi.Arcade(operation_mode=arc_agi.OperationMode.OFFLINE,
            environments_dir=env_dir, recordings_dir=str(self.output/'recordings'))
        self.env = self.arc.make(game, seed=0, save_recording=True, include_frame_data=True)
        if self.env is None or self.env.observation_space is None:
            raise RuntimeError('Official environment failed to initialize')
        self.game = self.env.info.game_id
        self.budget_s, self.max_actions = budget_s, max_actions
        self.actions, self.resets, self.max_levels = 0, 0, 0
        self.started = None
        self.closed_reason = None
        self.lock = threading.RLock()
        self.capture('INITIAL', {})

    def status(self):
        obs = self.env.observation_space
        elapsed = time.monotonic()-self.started if self.started else 0
        state = obs.state.name
        reason = self.closed_reason
        if state == 'WIN': reason = 'WIN'
        elif self.actions >= self.max_actions: reason = 'action_budget'
        elif elapsed >= self.budget_s: reason = 'time_budget'
        return dict(game_id=self.game, state=state, levels_completed=obs.levels_completed,
            max_levels_completed=self.max_levels, total_levels=obs.win_levels,
            actions=self.actions, resets=self.resets,
            available_actions=[a.name for a in self.env.action_space],
            elapsed_s=round(elapsed,3), remaining_s=round(max(0,self.budget_s-elapsed),3),
            stopped=bool(reason), stop_reason=reason,
            frame_png='frame.png', grid_txt='grid.txt', frame_json='frame.json')

    def capture(self, action, data):
        obs = self.env.observation_space
        self.max_levels = max(self.max_levels, obs.levels_completed)
        frames = [np.asarray(frame,dtype=np.uint8) for frame in obs.frame]
        if frames:
            grid = frames[-1]
            assert grid.ndim == 2 and grid.max() < 16
            rgb=np.array([[tuple(bytes.fromhex(PALETTE[int(c)][1:])) for c in row] for row in grid], dtype=np.uint8)
            image=Image.fromarray(rgb).resize((grid.shape[1]*8,grid.shape[0]*8), Image.Resampling.NEAREST)
            image.save(self.output/'frame.png')
            (self.output/'frames').mkdir(exist_ok=True)
            image.save(self.output/'frames'/f'{self.actions:04d}.png')
            (self.output/'grid.txt').write_text(''.join(f'{y:02d} '+''.join(format(int(c),'X') for c in row)+'\n' for y,row in enumerate(grid)))
            (self.output/'frame.json').write_text(json.dumps(grid.tolist()))
        record=dict(timestamp=time.time(), action=action, data=data, **self.status())
        record['frame']= [frame.tolist() for frame in frames]
        record['frame_sha256']=hashlib.sha256(json.dumps(record['frame']).encode()).hexdigest()
        with (self.output/'trajectory.jsonl').open('a') as out: out.write(json.dumps(record)+'\n')
        (self.output/'status.json').write_text(json.dumps(self.status(),indent=2))
        return self.status()

    def act(self, payload):
        with self.lock:
            if self.started is None: self.started=time.monotonic()
            if self.status()['stopped']: return self.status()
            sequence=payload.get('actions')
            if sequence is None: sequence=[payload]
            if not 1 <= len(sequence) <= 10: raise ValueError('Use 1 to 10 actions per request')
            snapshots=[]
            for item in sequence:
                if self.status()['stopped']: break
                name=item['action'].upper()
                valid=self.status()['available_actions']
                if name != 'RESET' and name not in valid: raise ValueError(f'Illegal action {name}; legal={valid}')
                if self.status()['state']=='GAME_OVER' and name!='RESET': raise ValueError('GAME_OVER requires RESET')
                data=item.get('data',{})
                if name=='ACTION6' and not all(isinstance(data.get(k),int) and 0<=data[k]<=63 for k in ('x','y')):
                    raise ValueError('ACTION6 requires integer x,y in [0,63]')
                obs=self.env.step(GameAction[name],data=data,reasoning={'comment':str(item.get('reasoning',''))[:4000]})
                if obs is None: raise RuntimeError('Official engine returned no observation')
                self.actions+=1
                if name=='RESET': self.resets+=1
                snapshots.append(self.capture(name,data))
                if self.status()['state'] in ('WIN','GAME_OVER'): break
            return dict(**self.status(), intermediate=snapshots)


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--game',required=True); p.add_argument('--env-dir',required=True)
    p.add_argument('--output',required=True); p.add_argument('--port',type=int,required=True)
    p.add_argument('--budget-s',type=int,default=600); p.add_argument('--max-actions',type=int,default=200)
    args=p.parse_args(); session=Session(args.game,args.env_dir,args.output,args.budget_s,args.max_actions)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*_): pass
        def respond(self,data,status=200):
            body=json.dumps(data).encode(); self.send_response(status)
            self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(body)))
            self.end_headers(); self.wfile.write(body)
        def do_GET(self):
            if self.path=='/status':
                with session.lock:
                    if session.started is None: session.started=time.monotonic()
                    self.respond(session.status())
            else: self.respond({'error':'Not found'},404)
        def do_POST(self):
            try:
                data=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                if self.path=='/action': self.respond(session.act(data))
                elif self.path=='/stop':
                    session.closed_reason=data.get('reason','runner_stop'); self.respond(session.status())
                else: self.respond({'error':'Not found'},404)
            except Exception as exc: self.respond({'error':repr(exc)},400)
    print(json.dumps({'ready':True,**session.status()}),flush=True)
    ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()


if __name__=='__main__': main()
