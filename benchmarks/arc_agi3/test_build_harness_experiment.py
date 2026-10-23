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
            expected_version=re.search(r'\(version\s+"([^"]+)"\)',
                Path(__file__).with_name('arc-discovery.hns').read_text()).group(1)
            self.assertEqual(manifest['harness'],f'arc-discovery@{expected_version}')
            self.assertIn(f"'harness_version':{expected_version!r}",
                ''.join(notebook['cells'][3]['source']))
            for i,cell in enumerate(notebook['cells']):
                if cell['cell_type']=='code':
                    compile(''.join(cell['source']),f'generated-cell-{i}','exec')
            self.assertFalse(manifest['formal_submission'])
            self.assertEqual(manifest['paid_services'],[])

    def test_identical_rebuild_retains_uploaded_bundle_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            first=self.fixture(root)
            second=self.fixture(root)
            self.assertEqual(first['bundle_sha256'],second['bundle_sha256'])

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
