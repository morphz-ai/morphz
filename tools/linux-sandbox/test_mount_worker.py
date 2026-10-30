"""The actual copied worker must start without administrator-only modules."""

import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class MountWorkerTests(unittest.TestCase):
    def test_copied_worker_is_standalone_under_isolated_python(self):
        with tempfile.TemporaryDirectory(prefix="morphz-mount-worker-") as directory:
            worker = Path(directory) / "worker.py"
            shutil.copyfile(Path(__file__).with_name("mount_kernel_contract.py"), worker)
            result = subprocess.run([sys.executable, "-I", "-B", str(worker), "--worker"],
                                    input='{"op":"exit"}\n', capture_output=True,
                                    text=True, timeout=5, cwd=directory)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr, "")
            self.assertEqual(json.loads(result.stdout)["ready"], True)


if __name__ == "__main__":
    unittest.main()
