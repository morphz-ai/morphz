"""OS-independent parsing checks; real sender authorization is a Linux gate."""

import unittest

from peer import PeerError, parse_security_state, parse_single_id_map, parse_start_identity


def process_stat(pid=123, name="runtime", parent=55, start=991):
    fields = ["S", str(parent)] + ["0"] * 17 + [str(start)] + ["0"] * 5
    return f"{pid} ({name}) " + " ".join(fields)


class PeerParsingTests(unittest.TestCase):
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
