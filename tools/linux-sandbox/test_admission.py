"""Pure input-boundary checks; namespace/mount authority needs the Linux gate."""
import unittest

from admission import root_descriptors, root_specifications, verify_mount_boundaries
from peer import PeerError
from policy import Policy
from test_policy import request


class AdmissionInputTests(unittest.TestCase):
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
