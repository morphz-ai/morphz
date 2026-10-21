"""Pure input-boundary checks; namespace/mount authority needs the Linux gate."""
import unittest

from admission import root_descriptors, root_specifications
from peer import PeerError
from policy import Policy


class AdmissionInputTests(unittest.TestCase):
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
            "denied_write_patterns": [], "network": "deny"})
        self.assertEqual(root_specifications(policy), (("/reference", False), ("/work", False), ("/work", True)))


if __name__ == "__main__":
    unittest.main()
