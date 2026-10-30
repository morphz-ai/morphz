"""Deterministic phase/order tests, not evidence of Linux kernel enforcement."""
import copy
from dataclasses import replace
import os
import unittest
from unittest.mock import patch

from lifecycle import (Leases, LifecycleError, Profiles, launch_name,
                       profile_binding, verify_saved_profile)
from policy import Policy, compile_profiles
from test_policy import request


class Store:
    def __init__(self):
        self.values = {}
        self.events = []
    def create(self, record, _compiled):
        self.events.append("durable-input")
        self.save(record)
    def save(self, record):
        self.values[record["launch"]] = copy.deepcopy(record)
        self.events.append(record["phase"])
    def records(self):
        return copy.deepcopy(list(self.values.values()))


class Groups:
    def __init__(self, events):
        self.events = events
        self.members = set()
        self.identities = {}
    def create(self, launch):
        self.events.append("create-group")
        self.identities[launch] = [1, len(self.identities) + 1]
        return self.identities[launch]
    def join_descriptor(self, record):
        self.events.append("join-capability")
        return os.open(os.devnull, os.O_WRONLY)
    def remove_if_empty(self, record):
        self.events.append("atomic-remove-group")
        if record["launch"] in self.members:
            return False
        self.identities.pop(record["launch"], None)
        return True


class Policies:
    def __init__(self, events):
        self.events = events
        self.active = set()
        self.fail = False
    def add(self, record):
        self.events.append("load-policy")
        # Recheck actual typed payload, catching tuples versus JSON arrays.
        Policy.from_request(record["policy"])
        if self.fail:
            raise LifecycleError("synthetic load failure")
        self.active.add(record["launch"])
    def loaded(self, record):
        return ["bootstrap", "work"] if record["launch"] in self.active else []
    def remove(self, record):
        self.events.append("remove-policy")
        self.active.discard(record["launch"])


class LeaseTests(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.groups = Groups(self.store.events)
        self.profiles = Policies(self.store.events)
        self.leases = Leases(self.store, self.groups, self.profiles)
    def register(self):
        return self.leases.register(Policy.from_request(request()), {"uid": 1001})
    def test_policy_and_intent_are_durable_before_kernel_resources(self):
        launch = self.register()
        self.assertEqual(self.store.events, ["durable-input", "preparing", "create-group", "preparing",
                                            "load-policy", "registered"])
        self.assertEqual(self.store.values[launch]["phase"], "registered")
    def test_claim_is_single_use_and_cannot_be_reopened(self):
        launch = self.register()
        os.close(self.leases.claim(launch))
        for _ in range(2):
            with self.assertRaises(LifecycleError):
                self.leases.claim(launch)
        self.leases.close_admission(launch)
        with self.assertRaises(LifecycleError):
            self.leases.mark_admitted(launch)
    def test_live_descendants_keep_policy_after_close(self):
        launch = self.register()
        os.close(self.leases.claim(launch))
        self.leases.mark_admitted(launch)
        self.groups.members.add(launch)
        self.leases.close_admission(launch)
        self.assertFalse(self.leases.collect(launch))
        self.assertIn(launch, self.profiles.active)
        self.assertNotIn("remove-policy", self.store.events)
        self.groups.members.remove(launch)
        self.assertTrue(self.leases.collect(launch))
        self.assertLess(self.store.events.index("atomic-remove-group"), self.store.events.index("remove-policy"))
    def test_unclosed_admission_can_never_be_collected(self):
        launch = self.register()
        with self.assertRaises(LifecycleError):
            self.leases.collect(launch)
        self.assertIn(launch, self.profiles.active)
    def test_restart_preserves_live_work_but_never_restores_saved_pid_authority(self):
        launch = self.register()
        self.groups.members.add(launch)
        recovered = Leases(self.store, self.groups, self.profiles)
        recovered.recover()
        self.assertEqual(recovered.records[launch]["phase"], "closing")
        with self.assertRaises(LifecycleError):
            recovered.claim(launch)
        self.assertIn(launch, self.profiles.active)
    def test_restart_collects_empty_preparing_registered_claimed_and_admitted(self):
        for phase in ("preparing", "registered", "claimed", "admitted", "closing"):
            with self.subTest(phase=phase):
                launch = self.register()
                self.store.values[launch]["phase"] = phase
                recovered = Leases(self.store, self.groups, self.profiles)
                recovered.recover()
                self.assertNotIn(launch, self.profiles.active)
                self.assertEqual(self.store.values[launch]["phase"], "removed")
    def test_load_failure_is_not_admitted_and_cleans_only_owned_resources(self):
        self.profiles.fail = True
        with self.assertRaises(LifecycleError):
            self.register()
        self.assertFalse(self.leases.records)
        self.assertFalse(self.groups.identities)
        self.assertEqual(next(iter(self.store.values.values()))["phase"], "removed")
    def test_missing_policy_on_live_group_is_an_error_not_a_repair_to_broad_access(self):
        launch = self.register()
        self.groups.members.add(launch)
        self.profiles.active.clear()
        self.leases.close_admission(launch)
        with self.assertRaises(LifecycleError):
            self.leases.collect(launch)
        self.assertIn(launch, self.leases.records)
    def test_bounded_registration_and_no_caller_chosen_names(self):
        for _ in range(32):
            self.register()
        with self.assertRaises(LifecycleError):
            self.register()
        for invalid in ("../x", "", "A" * 32, "a" * 32 + "\n", 1):
            with self.subTest(invalid=invalid), self.assertRaises(LifecycleError):
                launch_name(invalid)


class FrozenGenerationTests(unittest.TestCase):
    def setUp(self):
        self.record = {"launch": "a" * 32, "policy": request()}
        self.source = compile_profiles(Policy.from_request(request()), "a" * 32).source.encode()
        self.record["profile_sha256"] = profile_binding(self.record, self.source)

    def test_saved_source_is_verified_without_the_new_compiler(self):
        with patch("lifecycle.compile_profiles", side_effect=AssertionError("new compiler invoked")):
            self.assertEqual(verify_saved_profile(self.record, self.source), self.record["profile_sha256"])

    def test_binding_rejects_changed_source_policy_launch_and_invalid_digest(self):
        variants = [(self.record, self.source + b"# different generator\n")]
        for field, value in (("launch", "b" * 32), ("policy", request(network="allow")),
                             ("profile_sha256", None), ("profile_sha256", "0" * 64),
                             ("profile_sha256", {"unexpected": True})):
            variants.append(({**self.record, field: value}, self.source))
        for record, source in variants:
            with self.subTest(record=record), self.assertRaises(LifecycleError):
                verify_saved_profile(record, source)

    def test_legacy_migration_requires_exact_original_source(self):
        legacy = {key: value for key, value in self.record.items() if key != "profile_sha256"}
        self.assertEqual(verify_saved_profile(legacy, self.source), self.record["profile_sha256"])
        with self.assertRaisesRegex(LifecycleError, "unbound legacy policy"):
            verify_saved_profile(legacy, self.source + b"# unknown original generator\n")
        # A changed compiler cannot stamp old, previously unbound data as new.
        newer = compile_profiles(Policy.from_request(request()), "a" * 32)
        with patch("lifecycle.compile_profiles", return_value=replace(newer, source=newer.source + "# new\n")), \
                self.assertRaisesRegex(LifecycleError, "unbound legacy policy"):
            verify_saved_profile(legacy, self.source)

    def test_mutable_lifetime_metadata_does_not_change_the_immutable_binding(self):
        record = {**self.record, "phase": "closing", "cgroup": [12, 34], "owner": {"uid": 1001}}
        self.assertEqual(verify_saved_profile(record, self.source), self.record["profile_sha256"])

    def test_loaded_profiles_do_not_recompile_an_existing_generation(self):
        policy = Policy.from_request(request())
        launch = "a" * 32
        compiled = compile_profiles(policy, launch)
        record = {"launch": launch, "policy": request()}
        kernel = f"{compiled.bootstrap} (enforce)\n{compiled.work} (enforce)\n"
        with patch("lifecycle.privileged_linux"), \
                patch("lifecycle.Path.read_text", return_value=kernel), \
                patch("lifecycle.compile_profiles", side_effect=AssertionError("new compiler invoked")):
            self.assertEqual(Profiles(None).loaded(record), [compiled.bootstrap, compiled.work])

    def test_non_enforcing_saved_generation_still_fails_closed(self):
        compiled = compile_profiles(Policy.from_request(request()), "a" * 32)
        with patch("lifecycle.privileged_linux"), \
                patch("lifecycle.Path.read_text", return_value=compiled.work + " (complain)\n"), \
                self.assertRaisesRegex(LifecycleError, "not enforcing"):
            Profiles(None).loaded(self.record)


if __name__ == "__main__":
    unittest.main()
