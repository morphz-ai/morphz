"""Artifact/Notebook tests only: no real model, game or Linux runtime is run."""
import hashlib
import json
from pathlib import Path
import re
import struct
import tempfile
import unittest
import zipfile
from unittest.mock import patch

from build_harness_experiment import build


class DeploymentTest(unittest.TestCase):
    def fixture(self,root):
        binary=bytearray(64)
        binary[:6]=b'\x7fELF\x02\x01'
        binary[18:20]=struct.pack('<H',62)
        runtime=root/'fake-linux-header'
        runtime.write_bytes(binary)
        return build(runtime,root/'out','fixture-not-a-real-build')

    def test_allowlisted_bundle_and_generated_cells(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            result=self.fixture(root)
            with zipfile.ZipFile(result['bundle']) as archive:
                manifest=json.loads(archive.read('deployment.json'))
                for name,expected in manifest['files'].items():
                    self.assertEqual(hashlib.sha256(archive.read(name)).hexdigest(),expected)
                self.assertNotIn('connection.json',archive.namelist())
                self.assertNotIn('runtime.db',archive.namelist())
            notebook=json.loads(Path(result['notebook']).read_text())
            self.assertTrue(notebook['metadata']['kaggle']['isGpuEnabled'])
            self.assertFalse(notebook['metadata']['kaggle']['isInternetEnabled'])
            self.assertIn('ACTUAL_GPU_CHECK',''.join(notebook['cells'][2]['source']))
            expected_version=re.search(r'\(version\s+"([^"]+)"\)',
                Path(__file__).with_name('arc-discovery.hns').read_text()).group(1)
            self.assertEqual(manifest['harness'],f'arc-discovery@{expected_version}')
            self.assertIn(f"'harness_version':{expected_version!r}",
                ''.join(notebook['cells'][3]['source']))
            for i,cell in enumerate(notebook['cells']):
                if cell['cell_type']=='code':
                    compile(''.join(cell['source']),f'generated-cell-{i}','exec')
            script=Path(result['script']).read_text()
            compile(script,'generated-script','exec')
            for item in notebook['cells']:
                if item['cell_type']=='code':
                    self.assertIn(''.join(item['source']),script)
            self.assertFalse(manifest['formal_submission'])
            self.assertEqual(manifest['paid_services'],[])

    def test_identical_rebuild_retains_uploaded_bundle_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            first=self.fixture(root)
            second=self.fixture(root)
            self.assertEqual(first['bundle_sha256'],second['bundle_sha256'])

    def run_inline_fixture(self,unpacked):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            original=self.fixture(root)
            base=Path(original['bundle'])
            result=build(root/'fake-linux-header',root/'overlay','fixture-not-real',
                         'arc-algorithms',base_bundle=base)
            inputs=root/'input'; inputs.mkdir()
            if unpacked:
                with zipfile.ZipFile(base) as archive: archive.extractall(inputs)
            else:
                (inputs/base.name).write_bytes(base.read_bytes())
            notebook=json.loads(Path(result['notebook']).read_text())
            source=''.join(notebook['cells'][1]['source'])
            source=source.replace("'/kaggle/input'",repr(str(inputs)))
            source=source.replace("'/tmp/morphz-arc-harness-deployment'",repr(str(root/'staged')))
            with patch('subprocess.run') as execute,patch('builtins.print'):
                exec(compile(source,'inline-source-fixture','exec'),{})
                self.assertEqual(execute.call_count,2)
            self.assertEqual((root/'staged'/'arc_solver.py').read_bytes(),
                             Path(__file__).with_name('arc_solver.py').read_bytes())

    def test_inline_overlay_reuses_pinned_binary_in_zip(self):
        self.run_inline_fixture(False)

    def test_inline_overlay_reuses_pinned_binary_in_unpacked_input(self):
        self.run_inline_fixture(True)

    def test_actor_integration_profile_is_separate_and_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); self.fixture(root)
            result=build(root/'fake-linux-header',root/'actor','fixture-not-real',
                         'arc-algorithms',profile='actor-integration')
            notebook=json.loads(Path(result['notebook']).read_text())
            code=''.join(notebook['cells'][3]['source'])
            self.assertIn("'actor_adapter':True",code)
            self.assertIn("'games':['ft09','ls20']",code)
            self.assertIn("'arms':['discovery']",code)
            self.assertIn('not a pure algorithm ablation',''.join(notebook['cells'][0]['source']))
            compile(code,'actor-profile-fixture','exec')

    def test_algorithm_bundle_pins_runtime_owned_harness_and_all_executable_modules(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            self.fixture(root)
            result=build(root/'fake-linux-header',root/'algorithms','fixture-not-real','arc-algorithms')
            with zipfile.ZipFile(result['bundle']) as archive:
                manifest=json.loads(archive.read('deployment.json'))
                version=re.search(r'\(version\s+"([^"]+)"\)',
                    Path(__file__).with_name('arc-algorithms.hns').read_text()).group(1)
                self.assertEqual(manifest['harness'],f'arc-algorithms@{version}')
                for name in ('arc_solver.py','arc_algorithms.py','arc-algorithms.hns'):
                    self.assertEqual(hashlib.sha256(archive.read(name)).hexdigest(),manifest['files'][name])
            notebook=json.loads(Path(result['notebook']).read_text())
            preflight=''.join(notebook['cells'][1]['source'])
            experiment=''.join(notebook['cells'][3]['source'])
            self.assertIn("str(DEPLOY/'arc-algorithms.hns')",preflight)
            self.assertIn("'arms':['baseline','discovery']",experiment)
            self.assertIn("'algorithm_tools':True",experiment)
            self.assertIn("'games':['ft09','ls20','vc33']",experiment)
            for index,value in enumerate(notebook['cells']):
                if value['cell_type']=='code':
                    compile(''.join(value['source']),f'algorithm-cell-{index}','exec')

    def run_preflight_fixture(self,unpacked,tamper=False):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            result=self.fixture(root)
            inputs=root/'input'; inputs.mkdir()
            if unpacked:
                with zipfile.ZipFile(result['bundle']) as archive: archive.extractall(inputs)
                if tamper: (inputs/'arc-discovery.hns').write_text('tampered fixture')
            else:
                (inputs/Path(result['bundle']).name).write_bytes(Path(result['bundle']).read_bytes())
            notebook=json.loads(Path(result['notebook']).read_text())
            source=''.join(notebook['cells'][1]['source'])
            source=source.replace("'/kaggle/input'",repr(str(inputs)))
            source=source.replace("'/tmp/morphz-arc-harness-deployment'",repr(str(root/'staged')))
            # The binary is deliberately fake; only packaging checks execute here.
            with patch('subprocess.run') as execute,patch('builtins.print'):
                if tamper:
                    with self.assertRaises(AssertionError): exec(compile(source,'fixture-preflight','exec'),{})
                    execute.assert_not_called()
                else:
                    exec(compile(source,'fixture-preflight','exec'),{})
                    self.assertEqual(execute.call_count,2)

    def test_preflight_accepts_pinned_zip(self):
        self.run_preflight_fixture(unpacked=False)

    def test_preflight_accepts_kaggle_unpacked_files(self):
        self.run_preflight_fixture(unpacked=True)

    def test_tampering_fails_before_any_executable_starts(self):
        self.run_preflight_fixture(unpacked=True,tamper=True)
    def test_mac_or_wrong_architecture_is_not_packaged_as_linux(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            bad=root/'mac'
            bad.write_bytes(b'not an ELF64 x86_64 executable')
            with self.assertRaises(ValueError): build(bad,root/'out','fixture')


if __name__=='__main__': unittest.main()
