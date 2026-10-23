"""Adapter contract fixtures only; these are NOT ARC or model scores."""
import importlib.util
import json
import sys
import tempfile
import shutil
import subprocess
import time
import types
import unittest
from enum import Enum
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from PIL import Image


class Action(Enum):
    RESET=0
    ACTION1=1
    ACTION6=6


spec=importlib.util.spec_from_file_location('arc_bridge',Path(__file__).with_name('arc_bridge.py'))
bridge=importlib.util.module_from_spec(spec)
with patch.dict(sys.modules,{'arc_agi':types.ModuleType('arc_agi'),
                            'arcengine':SimpleNamespace(GameAction=Action)}):
    spec.loader.exec_module(bridge)


class FakeEnvironment:
    def __init__(self):
        self.action_space=[Action.ACTION1,Action.ACTION6]
        self.observation_space=SimpleNamespace(state=SimpleNamespace(name='NOT_FINISHED'),
            levels_completed=0,win_levels=2,frame=[np.array([[0,10],[14,15]],dtype=np.uint8)])
    def step(self,action,data,reasoning):
        if action==Action.RESET:
            self.observation_space.levels_completed=0
            self.observation_space.state.name='NOT_FINISHED'
        elif action==Action.ACTION1: self.observation_space.levels_completed+=1
        if self.observation_space.levels_completed==2: self.observation_space.state.name='WIN'
        return self.observation_space


class ContractTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.s=bridge.Session.__new__(bridge.Session)
        self.s.output=Path(self.tmp.name); self.s.env=FakeEnvironment(); self.s.game='fixture'
        self.s.budget_s=600; self.s.max_actions=200
        self.s.actions=self.s.resets=self.s.max_levels=0
        self.s.started=None; self.s.closed_reason=None
        self.s.lock=__import__('threading').RLock()
        self.s.observations=bridge.ObservationTracker()
        self.s.capture('INITIAL',{})
    def tearDown(self): self.tmp.cleanup()
    def test_lossless_grid_and_official_palette(self):
        image=Image.open(self.s.output/'frame.png')
        self.assertEqual(image.size,(16,16))
        self.assertEqual(image.getpixel((8,0)),(136,216,241))
        self.assertEqual(json.loads((self.s.output/'frame.json').read_text()),[[0,10],[14,15]])
    def test_levels_not_full_win(self):
        status=self.s.act({'action':'ACTION1'})
        self.assertEqual(status['levels_completed'],1)
        self.assertEqual(status['state'],'NOT_FINISHED')
        self.assertFalse(status['stopped'])
    def test_win_stops_batch_without_extra_actions(self):
        status=self.s.act({'actions':[{'action':'ACTION1'}]*5})
        self.assertEqual(status['actions'],2)
        self.assertEqual(status['state'],'WIN')
    def test_reset_retains_max_progress(self):
        self.s.act({'action':'ACTION1'})
        status=self.s.act({'action':'RESET'})
        self.assertEqual(status['levels_completed'],0)
        self.assertEqual(status['max_levels_completed'],1)
        self.assertEqual(status['resets'],1)
    def test_invalid_action_or_coordinate_rejected(self):
        for payload in ({'action':'ACTION2'},{'action':'ACTION6','data':{'x':64,'y':0}},
                        {'action':'ACTION6','data':{'x':True,'y':0}}):
            with self.assertRaises(ValueError): self.s.act(payload)
        self.assertEqual(self.s.actions,0)
    def test_action_budget_is_not_win(self):
        self.s.max_actions=1
        status=self.s.act({'action':'ACTION1'})
        self.assertEqual(status['stop_reason'],'action_budget')
        self.assertNotEqual(status['state'],'WIN')
    def test_time_budget_blocks_moves(self):
        self.s.started=time.monotonic()-601
        status=self.s.act({'action':'ACTION1'})
        self.assertEqual(status['stop_reason'],'time_budget')
        self.assertEqual(status['actions'],0)
    def test_observe_does_not_take_a_game_action_or_inflate_visit_count(self):
        first=self.s.observe()
        second=self.s.observe()
        self.assertEqual(first['actions'],0)
        self.assertEqual(first['observation'],second['observation'])
        self.assertEqual(first['observation']['grid_hex_rows'],['0A','EF'])
        self.assertEqual(first['observation']['action_index'],0)
    def test_step_attaches_current_observation_and_action_stays_backwards_compatible(self):
        plain=self.s.act({'action':'ACTION6','data':{'x':1,'y':0}})
        self.assertNotIn('observation',plain)
        stepped=self.s.act({'action':'ACTION6','data':{'x':1,'y':0},'with_observation':True})
        self.assertEqual(stepped['observation']['action_index'],2)
        self.assertTrue(stepped['observation']['transition']['observation_unchanged'])
        self.assertEqual(stepped['observation']['transition']['attempts_of_action_from_same_state'],2)
    def test_stopped_step_returns_last_observation_without_moving(self):
        self.s.max_actions=1
        self.s.act({'action':'ACTION6','data':{'x':1,'y':0}})
        result=self.s.act({'action':'ACTION1','with_observation':True})
        self.assertTrue(result['stopped'])
        self.assertEqual(result['actions'],1)
        self.assertEqual(result['observation']['action_index'],1)
    def test_frameless_receipt_does_not_publish_stale_observation(self):
        self.s.env.observation_space.frame=[]
        self.s.capture('ACTION6',{})
        self.assertIsNone(self.s.observe()['observation'])
        self.assertIsNone(json.loads((self.s.output/'observation.json').read_text()))
        self.assertFalse(self.s.status()['frame_available'])
    def test_real_http_and_cli_transport_against_explicit_fixture(self):
        # Real socket + subprocess; fake engine. This is not a game/model score.
        from http.server import ThreadingHTTPServer
        import threading
        server=ThreadingHTTPServer(('127.0.0.1',0),bridge.make_handler(self.s))
        worker=threading.Thread(target=server.serve_forever,daemon=True)
        worker.start()
        shutil.copy2(Path(__file__).with_name('arc_cli.py'),self.s.output/'arc_cli.py')
        (self.s.output/'connection.json').write_text(json.dumps({'port':server.server_port}))
        def cli(*args):
            result=subprocess.run([sys.executable,str(self.s.output/'arc_cli.py'),*args],
                                  capture_output=True,text=True,timeout=10,check=True)
            return json.loads(result.stdout)
        try:
            initial=cli('observe')
            self.assertEqual(initial['actions'],0)
            self.assertEqual(initial['observation']['grid_hex_rows'],['0A','EF'])
            stepped=cli('step','ACTION6','1','0')
            self.assertEqual(stepped['actions'],1)
            self.assertEqual(stepped['observation']['action_index'],1)
            self.assertEqual(stepped['observation']['transition']['from_action_index'],0)
            self.assertNotIn('observation',cli('status'))
        finally:
            server.shutdown(); server.server_close(); worker.join(timeout=3)


if __name__=='__main__': unittest.main()
