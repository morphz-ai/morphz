"""Artifact/Notebook tests only: no real model, game or Linux runtime is run."""
import hashlib
import json
from pathlib import Path
import struct
import tempfile
import unittest
import zipfile

from build_harness_experiment import build


class DeploymentTest(unittest.TestCase):
    def test_allowlisted_bundle_and_generated_cells(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            binary=bytearray(64)
            binary[:6]=b'\x7fELF\x02\x01'
            binary[18:20]=struct.pack('<H',62)
            runtime=root/'fake-linux-header'
            runtime.write_bytes(binary)
            result=build(runtime,root/'out','fixture-not-a-real-build')
            with zipfile.ZipFile(result['bundle']) as archive:
                manifest=json.loads(archive.read('deployment.json'))
                for name,expected in manifest['files'].items():
                    self.assertEqual(hashlib.sha256(archive.read(name)).hexdigest(),expected)
                self.assertNotIn('connection.json',archive.namelist())
                self.assertNotIn('runtime.db',archive.namelist())
            notebook=json.loads(Path(result['notebook']).read_text())
            for i,cell in enumerate(notebook['cells']):
                if cell['cell_type']=='code':
                    compile(''.join(cell['source']),f'generated-cell-{i}','exec')
            self.assertFalse(manifest['formal_submission'])
            self.assertEqual(manifest['paid_services'],[])
    def test_mac_or_wrong_architecture_is_not_packaged_as_linux(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            bad=root/'mac'
            bad.write_bytes(b'not an ELF64 x86_64 executable')
            with self.assertRaises(ValueError): build(bad,root/'out','fixture')


if __name__=='__main__': unittest.main()
