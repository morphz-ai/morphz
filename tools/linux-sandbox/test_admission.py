"""Pure input-boundary checks; namespace/mount authority needs the Linux gate."""
import unittest
import stat
from types import SimpleNamespace
from unittest.mock import patch

from admission import (root_descriptors, root_specifications, verify_mount_boundaries,
                       verify_namespace_handle)
from peer import PeerError
from policy import Policy
from test_policy import request


class AdmissionInputTests(unittest.TestCase):
    def test_namespace_mount_requires_live_kernel_proof_not_a_docker_allowlist(self):
        policy = Policy.from_request(request(hidden_roots=[]))
        baseline = "1 0 8:1 / / ro - ext4 /dev/x ro\n"
        entry = "2 1 0:1 net:[42] /arbitrary/namespace rw - nsfs nsfs rw"
        with self.assertRaises(PeerError):
            verify_mount_boundaries(baseline + entry, policy)
        verified = []
        verify_mount_boundaries(baseline + entry, policy, namespace_verifier=verified.append)
        self.assertEqual(verified, ["/arbitrary/namespace"])
        for filesystem in ("ext4", "tmpfs", "overlay", "fuse.nsfs"):
            with self.subTest(filesystem=filesystem), self.assertRaises(PeerError):
                verify_mount_boundaries(baseline + entry.replace("- nsfs", "- " + filesystem),
                                        policy, namespace_verifier=verified.append)
        def refusal(_path):
            raise PeerError("not a real namespace")
        with self.assertRaisesRegex(PeerError, "not a real namespace"):
            verify_mount_boundaries(baseline + entry, policy, namespace_verifier=refusal)

    def test_namespace_handle_must_be_regular_0444_and_answer_the_kernel_ioctl(self):
        for mode, kind, valid in ((stat.S_IFREG | 0o444, 0x40000000, True),
                                  (stat.S_IFREG | 0o644, 0x40000000, False),
                                  (stat.S_IFDIR | 0o444, 0x40000000, False),
                                  (stat.S_IFREG | 0o444, 0, False),
                                  (stat.S_IFREG | 0o444, OSError("not nsfs"), False)):
            metadata = SimpleNamespace(st_mode=mode, st_dev=10, st_ino=42)
            with self.subTest(mode=mode, kind=kind), \
                    patch("admission.directory_in_process", return_value=7), \
                    patch("admission.os.open", return_value=8), \
                    patch("admission.os.fstat", return_value=metadata), \
                    patch("admission.os.close") as close, \
                    patch("admission.fcntl.ioctl", **(
                        {"side_effect": kind} if isinstance(kind, OSError) else {"return_value": kind})):
                if valid:
                    verify_namespace_handle(12, "/arbitrary/namespace")
                else:
                    with self.assertRaises(PeerError):
                        verify_namespace_handle(12, "/arbitrary/namespace")
                close.assert_any_call(7)

    def test_actual_mount_table_cannot_add_unapproved_writes_or_expose_home(self):
        policy = Policy.from_request(request())
        table = "\n".join([
            "1 0 8:1 / / ro - ext4 /dev/x ro",
            "2 1 0:1 / /dev rw,nosuid - tmpfs tmpfs rw",
            "3 1 0:2 / /proc rw,nosuid - proc proc rw",
            "4 1 0:3 / /home/example ro - tmpfs tmpfs ro",
            "5 1 0:4 / /tmp ro - tmpfs tmpfs ro",
            "6 1 8:1 /workspace /workspace rw - ext4 /dev/x rw",
        ])
        verify_mount_boundaries(table, policy)
        for bad in (table.replace("/ / ro", "/ / rw"),
                    table.replace("/tmp ro - tmpfs", "/tmp ro - ext4"),
                    table.replace("/home/example ro", "/home/example rw"),
                    table + "\n7 1 8:1 /elsewhere /elsewhere rw - ext4 /dev/x rw",
                    "incomplete"):
            with self.subTest(table=bad), self.assertRaises(PeerError):
                verify_mount_boundaries(bad, policy)

    def test_fd_list_is_bounded_typed_and_has_no_identity_or_path_fields(self):
        self.assertEqual(root_descriptors([3, 7], 2), (3, 7))
        for value in ([3], [3, 3], [3, True], [0, 7], [3, -1], [3, 1048576], [3, "7"],
                      [3, 7, 9], {"fd": 3, "uid": 1000}, None):
            with self.subTest(value=value), self.assertRaises(PeerError):
                root_descriptors(value, 2)

    def test_root_roles_and_order_come_only_from_registered_policy(self):
        policy = Policy.from_request({"abi": 1, "mode": "exec", "cwd": "/work",
            "read_roots": ["/reference", "/work"], "write_roots": ["/work"],
            "denied_read_paths": [], "denied_write_paths": [], "denied_read_patterns": [],
            "denied_write_patterns": [], "network": "deny", "hidden_roots": []})
        self.assertEqual(root_specifications(policy), (("/reference", False), ("/work", False), ("/work", True)))


if __name__ == "__main__":
    unittest.main()
