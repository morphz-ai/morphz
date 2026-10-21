"""OS-independent parsing checks; real sender authorization is a Linux gate."""

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from peer import (PeerError, authorize_work_namespace_chain, parse_security_state,
                  parse_single_id_map, parse_start_identity)


def process_stat(pid=123, name="runtime", parent=55, start=991):
    fields = ["S", str(parent)] + ["0"] * 17 + [str(start)] + ["0"] * 5
    return f"{pid} ({name}) " + " ".join(fields)


class PeerParsingTests(unittest.TestCase):
    def test_actual_bwrap_namespace_chain_is_exact_and_every_owner_is_checked(self):
        for owners, ancestor, accepted in (((1001, 1001), (4, 9), True),
                                           ((0, 1001), (4, 9), False),
                                           ((1001, 0), (4, 9), False),
                                           ((1001, 1001), (4, 10), False)):
            calls = []
            def ioctl(fd, operation, *arguments):
                calls.append((fd, operation))
                if operation == 0xb704:
                    arguments[0][0] = owners[fd - 90]
                    return 0
                self.assertEqual(operation, 0xb702)
                return fd + 1
            with self.subTest(owners=owners, ancestor=ancestor), \
                    patch("peer.os.dup", return_value=90), patch("peer.os.close") as close, \
                    patch("peer.fcntl.ioctl", side_effect=ioctl), \
                    patch("peer.os.fstat", return_value=SimpleNamespace(st_dev=ancestor[0], st_ino=ancestor[1])):
                if accepted:
                    authorize_work_namespace_chain(80, (4, 9), 1001)
                    self.assertEqual(calls, [(90, 0xb704), (90, 0xb702), (91, 0xb704), (91, 0xb702)])
                    self.assertEqual([call.args[0] for call in close.call_args_list], [90, 91, 92])
                else:
                    with self.assertRaises(PeerError):
                        authorize_work_namespace_chain(80, (4, 9), 1001)
                    closed = [call.args[0] for call in close.call_args_list]
                    self.assertEqual(len(closed), len(set(closed)))
                    self.assertEqual(closed, list(range(90, 90 + len(closed))))

    def test_work_mapping_is_exactly_one_original_non_root_identity(self):
        parse_single_id_map("      1001       1001          1\n", 1001)
        for raw in ("0 1001 1\n", "1001 0 1\n", "1001 1001 2\n", "1001 1001 1\n1002 1002 1\n",
                    "1001 1001\n", "invalid", "", "1001 1001 1\n\n"):
            with self.subTest(raw=raw), self.assertRaises(PeerError):
                parse_single_id_map(raw, 1001)

    def test_start_time_is_kernel_field_22_not_a_command_name_token(self):
        for name in ("runtime", "spaces in name", "close)paren", "name\nwith) newlines("):
            with self.subTest(name=name):
                self.assertEqual(parse_start_identity(process_stat(name=name), 123), (55, 991))

    def test_wrong_pid_missing_fields_and_non_numeric_identity_are_rejected(self):
        cases = (process_stat(pid=1), "123 (x) S 1", "123 x S 1", process_stat(start=-1),
                 process_stat(parent=-1), process_stat(start="invalid"), process_stat(parent="invalid"))
        for raw in cases:
            with self.subTest(raw=raw), self.assertRaises(PeerError):
                parse_start_identity(raw, 123)

    def test_every_security_identity_field_is_required_and_rechecked(self):
        state = {"Uid": "1001 1001 1001 1001", "Gid": "1002 1002 1002 1002",
                 "Groups": "1002 1003", "TracerPid": "0", "CapEff": "00000000",
                 "CapPrm": "00000000", "CapInh": "00000000", "CapAmb": "00000000",
                 "NoNewPrivs": "0"}
        def raw(value):
            return "\n".join(f"{key}:\t{value}" for key, value in value.items())
        self.assertEqual(parse_security_state(raw(state), 1001, 1002), ((1002, 1003), 0))
        for missing in state:
            changed = {key: value for key, value in state.items() if key != missing}
            with self.subTest(missing=missing), self.assertRaises(PeerError):
                parse_security_state(raw(changed), 1001, 1002)
        for key, value in (("Uid", "1001 0 1001 1001"), ("Gid", "1002 1003 1002 1002"),
                           ("TracerPid", "9"), ("CapEff", "00000001"), ("CapAmb", "00000001"),
                           ("Groups", "-1"), ("NoNewPrivs", "2")):
            with self.subTest(changed=key), self.assertRaises(PeerError):
                parse_security_state(raw({**state, key: value}), 1001, 1002)


if __name__ == "__main__":
    unittest.main()
