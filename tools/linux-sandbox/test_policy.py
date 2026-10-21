"""Pure compiler tests; these do not claim a Linux enforcement result."""

from dataclasses import replace
import json
import unittest

from policy import (ABI, MAX_PATHS, MAX_REQUEST_BYTES, Policy, PolicyError,
                    compile_profiles, decode_request, literal_path,
                    protected_ancestor_paths, quoted_path)


def request(**changes):
    return {
        "abi": ABI, "mode": "exec", "cwd": "/workspace",
        "read_roots": ["/workspace", "/reference"], "write_roots": ["/workspace"],
        "denied_read_paths": ["/workspace/.env", "/workspace/.morphz/config.toml"],
        "denied_write_paths": ["/workspace/.env", "/workspace/.morphz/config.toml"],
        "denied_read_patterns": [], "denied_write_patterns": [], "network": "deny",
        "hidden_roots": ["/home/example", "/tmp"],
        **changes,
    }


class PolicyTests(unittest.TestCase):
    def test_decoder_rejects_duplicates_and_nonobjects(self):
        for raw in (b'{}{}', b'{"abi":1,"abi":1}', b'[]', b'null', b'1', b'"x"',
                    b'{"abi":NaN}', b'{"x":Infinity}', b'{"x":"\xff"}',
                    b'[' * 2000 + b']' * 2000, b'', b' ' * (MAX_REQUEST_BYTES + 1)):
            with self.subTest(raw=raw[:40]), self.assertRaises(PolicyError):
                decode_request(raw)

    def test_no_command_source_profile_or_unknown_keys(self):
        for key in ("command", "argv", "profile", "source", "uid", "launch_id", "allow_all"):
            with self.subTest(key=key), self.assertRaises(PolicyError):
                Policy.from_request(request(**{key: "untrusted"}))
        for key in request():
            value = request()
            del value[key]
            with self.subTest(missing=key), self.assertRaises(PolicyError):
                Policy.from_request(value)

    def test_exact_typed_fields(self):
        for changes in ({"abi": True}, {"abi": 2}, {"mode": "shell"}, {"network": True},
                        {"read_roots": "/workspace"}, {"write_roots": []},
                        {"read_roots": ["/reference"], "write_roots": ["/reference"]},
                        {"cwd": "/outside"},
                        {"denied_read_paths": [True]},
                        {"denied_read_paths": ["/x"] * (MAX_PATHS + 1)},
                        {"denied_read_patterns": ["**/.env"]},
                        {"denied_write_patterns": None}, {"hidden_roots": ["/"]},
                        {"hidden_roots": ["/x" + str(i) for i in range(9)]}):
            with self.subTest(changes=changes), self.assertRaises(PolicyError):
                Policy.from_request(request(**changes))

    def test_normalized_absolute_utf8_byte_bounds(self):
        for path in ("", "x", "/a/", "/a//b", "//a", "/a/./b", "/a/../b", "/x\0y",
                     "/\ud800", "/" + "中" * 1365, 12):
            with self.subTest(path=repr(path)), self.assertRaises(PolicyError):
                literal_path(path)
        for path in ("/", "/tmp/目录 有空格", '/tmp/quote"slash\\*?[x]{a,b}@{HOME}',
                     "/line\nreturn\rtab\t", "/" + "中" * 1364):
            with self.subTest(path=path):
                self.assertEqual(literal_path(path), path)

    def test_literal_aare_cannot_inject_rule_or_expand_glob(self):
        self.assertEqual(quoted_path('/a/*?[]{}^"\\@{X}\n'),
                         '"/a/\\x2a\\x3f\\x5b\\x5d\\x7b\\x7d\\x5e\\x22\\x5c\\x40\\x7bX\\x7d\\x0a"')
        self.assertEqual(quoted_path("/目录"), '"/\\xe7\\x9b\\xae\\xe5\\xbd\\x95"')
        self.assertEqual(quoted_path("/", "/**"), '"/**"')
        self.assertEqual(quoted_path("/root*", "/**"), '"/root\\x2a/**"')
        with self.assertRaises(PolicyError):
            quoted_path("/x", '" rw,\n/** rw,')

    def test_hash_is_order_independent_but_preserves_every_permission(self):
        policy = Policy.from_request(request())
        duplicate = Policy.from_request(request(read_roots=["/reference", "/workspace", "/workspace"]))
        self.assertEqual(policy.digest(), duplicate.digest())
        for changes in ({"network": "allow"}, {"mode": "pty"},
                        {"write_roots": ["/workspace", "/reference"]},
                        {"denied_read_paths": []}, {"denied_write_paths": []},
                        {"cwd": "/workspace/child"}, {"hidden_roots": ["/tmp"]}):
            with self.subTest(changes=changes):
                self.assertNotEqual(policy.digest(), Policy.from_request(request(**changes)).digest())

    def test_nested_read_and_write_roots_remain_distinct(self):
        policy = Policy.from_request(request(read_roots=["/", "/workspace"],
                                             write_roots=["/workspace/child"],
                                             cwd="/workspace/child"))
        self.assertEqual(policy.read_roots, ("/", "/workspace"))
        self.assertEqual(policy.write_roots, ("/workspace/child",))

    def test_cwd_may_be_in_an_approved_read_only_root(self):
        policy = Policy.from_request(request(write_roots=["/reference"]))
        self.assertEqual(policy.cwd, "/workspace")
        self.assertNotIn(policy.cwd, policy.write_roots)
        self.assertIn(policy.cwd, policy.read_roots)

    def test_only_service_generated_names_and_typed_policy_compile(self):
        policy = Policy.from_request(request())
        for launch in ("x" * 32, "a" * 31, "A" * 32, "a" * 32 + "\n", "../profile", 7):
            with self.subTest(launch=launch), self.assertRaises(PolicyError):
                compile_profiles(policy, launch)
        with self.assertRaises(PolicyError):
            compile_profiles(replace(policy, network="untrusted"), "a" * 32)
        result = compile_profiles(policy, "a" * 32)
        self.assertIn(policy.digest()[:16], result.work)
        self.assertNotEqual(result.work, compile_profiles(policy, "b" * 32).work)
        self.assertNotEqual(result.work, compile_profiles(replace(policy, network="allow"), "a" * 32).work)
        self.assertEqual(result.source.count("profile "), 3)  # two profiles + one exact transition

    def test_read_and_write_denials_are_not_conflated(self):
        policy = Policy.from_request(request(denied_read_paths=["/workspace/read-only-denied"],
                                             denied_write_paths=["/workspace/write-only-denied"]))
        source = compile_profiles(policy, "1" * 32).source
        for suffix in ("", "/", "/**"):
            self.assertIn(f'audit deny "/workspace/read-only-denied{suffix}" rmx,', source)
            self.assertIn(f'audit deny "/workspace/write-only-denied{suffix}" wlk,', source)
        self.assertNotIn('"/workspace/read-only-denied" w', source)
        self.assertNotIn('"/workspace/write-only-denied" r', source)

    def test_all_writable_ancestors_are_frozen_not_siblings(self):
        policy = Policy.from_request(request(write_roots=["/workspace", "/other"],
                                             denied_read_paths=["/workspace/a/b/.env", "/read-only/x"],
                                             denied_write_paths=[]))
        self.assertEqual(protected_ancestor_paths(policy), ("/workspace", "/workspace/a", "/workspace/a/b"))
        source = compile_profiles(policy, "2" * 32).source
        self.assertIn('audit deny "/workspace/a/b/" w,', source)
        self.assertNotIn('audit deny "/workspace/a/b/**" w,', source)
        self.assertNotIn('audit deny "/other/"', source)

    def test_work_stack_cannot_restore_bootstrap_or_modify_control(self):
        result = compile_profiles(Policy.from_request(request()), "3" * 32)
        work = result.source.split(f"profile {result.work}", 1)[1]
        for forbidden in ("change_profile", "capability ", "userns", "mount,", " ux", " px"):
            self.assertNotIn(forbidden, work)
        for protected in ("/run/morphz-sandbox/control.sock", "/var/lib/morphz-sandbox/**",
                          "/sys/kernel/security/**", "/sys/fs/cgroup/**"):
            self.assertIn("audit deny " + protected, work)
        self.assertNotIn("network inet", work)
        allowed = compile_profiles(Policy.from_request(request(network="allow")), "4" * 32)
        self.assertEqual(allowed.source.count("network inet,"), 2)
        self.assertEqual(allowed.source.count("network inet6,"), 2)

    def test_bootstrap_can_only_stack_the_exact_work_profile(self):
        result = compile_profiles(Policy.from_request(request()), "5" * 32)
        transitions = [line.strip() for line in result.source.splitlines()
                       if "change_profile" in line]
        self.assertEqual(transitions, [f"change_profile -> &{result.work},"])
        self.assertNotIn(f"change_profile -> {result.work},", result.source)

    def test_disconnected_setup_paths_are_not_granted_to_work(self):
        result = compile_profiles(Policy.from_request(request()), "6" * 32)
        self.assertIn(f"profile {result.bootstrap} flags=(attach_disconnected)", result.source)
        work = result.source.split(f"profile {result.work}", 1)[1]
        self.assertNotIn("attach_disconnected", work)
        self.assertIn("flags=(mediate_deleted)", work)
        self.assertNotIn("capability", work)

    def test_json_roundtrip_is_exact(self):
        original = request(cwd="/workspace/中文", denied_read_paths=['/workspace/"*\\?'])
        policy = Policy.from_request(decode_request(json.dumps(original).encode()))
        self.assertEqual(policy.cwd, original["cwd"])
        self.assertEqual(policy.denied_read_paths, tuple(original["denied_read_paths"]))


if __name__ == "__main__":
    unittest.main()
