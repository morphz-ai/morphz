"""Local unit/mock checks; no Linux confinement, policies or privileged work."""

from contextlib import nullcontext, redirect_stdout
import errno
import io
import json
import os
from pathlib import Path
import socket
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, Mock, patch

import controller
import worker

HERE = Path(__file__).resolve().parent
TARGET = {"dev": 9, "ino": 999}
NONCE = "DYNAMIC_FD_" + "a" * 32 + "\n"


class InheritedObjectEvidence(unittest.TestCase):
    def row(self, fd=64, **changes):
        return {"fd": fd, **TARGET, "kind": stat.S_IFSOCK,
                "link": "socket:[999]", **changes}

    def test_real_outer_injection_is_required_at_the_injected_slot(self):
        self.assertEqual(controller.require_outer_injection([self.row()], TARGET, 64), [64])
        for rows in ([], [self.row(fd=65)], [self.row(ino=1000)],
                     [self.row(dev=10)], [self.row(kind=stat.S_IFREG)]):
            with self.subTest(rows=rows), self.assertRaisesRegex(RuntimeError, "not actually inherited"):
                controller.require_outer_injection(rows, TARGET, 64)

    def test_matching_by_object_not_number_catches_a_duplicate_or_reused_slot(self):
        rows = [self.row(), self.row(fd=77), self.row(fd=78, ino=1000)]
        self.assertEqual(controller.matching_socket_fds(rows, TARGET), [64, 77])
        self.assertEqual(controller.matching_socket_fds([self.row(ino=1000)], TARGET), [])

    def test_fd_table_keeps_all_objects_and_fails_on_partial_inspection(self):
        entries = [SimpleNamespace(name=str(fd), path=f"/proc/123/fd/{fd}") for fd in (0, 4, 64)]
        info = SimpleNamespace(st_dev=9, st_ino=999, st_mode=stat.S_IFSOCK | 0o600)
        with patch.object(controller.os, "scandir", return_value=nullcontext(entries)), \
             patch.object(controller.os, "stat", return_value=info), \
             patch.object(controller.os, "readlink", return_value="socket:[999]"):
            self.assertEqual([row["fd"] for row in controller.fd_table(123)], [0, 4, 64])
        for failure in (PermissionError(errno.EACCES, "denied"), FileNotFoundError(errno.ENOENT, "gone")):
            with patch.object(controller.os, "scandir", return_value=nullcontext(entries)), \
                 patch.object(controller.os, "stat", side_effect=[info, failure]), \
                 patch.object(controller.os, "readlink", return_value="socket:[999]"), \
                 self.assertRaises(OSError):
                controller.fd_table(123)

    def test_peer_requires_actual_eof_not_timeout_or_silence(self):
        peer = Mock()
        peer.recv.return_value = b""
        self.assertEqual(controller.peer_eof(peer), {"eof": True, "received_hex": "", "error": None})
        for steps in ([socket.timeout("no EOF")], [b"nonce", b""],
                      [b"x" * 129], [b"partial", socket.timeout("no EOF")]):
            with self.subTest(steps=steps):
                peer.recv.side_effect = steps
                result = controller.peer_eof(peer)
                self.assertFalse(result["eof"] and result["received_hex"] == "" and result["error"] is None)
        peer.recv.reset_mock()
        peer.recv.side_effect = [b"partial", b""]
        with patch.object(controller.time, "monotonic", side_effect=[10, 10.5, 13.1]):
            result = controller.peer_eof(peer, timeout=3)
        self.assertFalse(result["eof"])
        self.assertIn("deadline", result["error"])
        self.assertEqual(peer.recv.call_count, 1)

    def test_complete_boundary_requires_every_independent_piece(self):
        payload = {"matching_fds": [], "send_attempts": []}
        peer = {"eof": True, "received_hex": "", "error": None}
        self.assertTrue(controller.inherited_fd_closed(True, True, payload, peer))
        cases = [
            (False, True, payload, peer), (True, False, payload, peer),
            (True, True, None, peer),
            (True, True, {**payload, "matching_fds": [64]}, peer),
            (True, True, {**payload, "send_attempts": [{"fd": 64, "sent": False}]}, peer),
            (True, True, payload, {**peer, "eof": False}),
            (True, True, payload, {**peer, "received_hex": "abcd"}),
            (True, True, payload, {**peer, "error": "timeout"}),
            (True, True, {}, {}),
        ]
        for case in cases:
            with self.subTest(case=case):
                self.assertFalse(controller.inherited_fd_closed(*case))

    def test_payload_actual_leaked_inode_sends_nonce_to_actual_peer(self):
        # A normal local pair tests the finite worker operation only.
        # It does not claim Linux/AppArmor inheritance evidence.
        host, leaked = socket.socketpair()
        try:
            # macOS has no Linux proc socket inode; only that identity lookup
            # is mocked. Transmission uses an actual local inherited endpoint.
            info = SimpleNamespace(st_dev=9, st_ino=999, st_mode=stat.S_IFSOCK)
            target = TARGET
            entry = SimpleNamespace(name=str(leaked.fileno()), path="mock-proc-entry")
            with patch.object(worker.os, "scandir", return_value=nullcontext([entry])), \
                 patch.object(worker.os, "stat", return_value=info):
                result = worker.inherited_fd_check(target, NONCE)
            host.settimeout(1)
            self.assertEqual(host.recv(100), NONCE.encode())
            self.assertEqual(result["matching_fds"], [leaked.fileno()])
            self.assertEqual(result["send_attempts"], [{"fd": leaked.fileno(), "sent": True}])
            self.assertFalse(controller.inherited_fd_closed(
                True, True, result, {"eof": True, "received_hex": "", "error": None}))
        finally:
            host.close()
            leaked.close()

    def test_payload_matching_fd_with_send_denied_still_fails(self):
        info = SimpleNamespace(st_dev=9, st_ino=999, st_mode=stat.S_IFSOCK)
        entry = SimpleNamespace(name="64", path="mock-proc-entry")
        peer = Mock()
        peer.sendall.side_effect = PermissionError(errno.EACCES, "denied")
        with patch.object(worker.os, "scandir", return_value=nullcontext([entry])), \
             patch.object(worker.os, "stat", return_value=info), \
             patch.object(worker.os, "dup", return_value=100), \
             patch.object(worker.socket, "socket", return_value=nullcontext(peer)):
            result = worker.inherited_fd_check(TARGET, NONCE)
        peer.sendall.assert_called_once_with(NONCE.encode())
        self.assertEqual(result["send_attempts"][0]["errno"], errno.EACCES)
        self.assertFalse(controller.inherited_fd_closed(
            True, True, result, {"eof": True, "received_hex": "", "error": None}))

    def test_payload_absent_is_a_complete_scan_not_a_blind_fd_write(self):
        info = SimpleNamespace(st_dev=9, st_ino=1000, st_mode=stat.S_IFSOCK)
        entry = SimpleNamespace(name="64", path="mock-proc-entry")
        with patch.object(worker.os, "scandir", return_value=nullcontext([entry])), \
             patch.object(worker.os, "stat", return_value=info), \
             patch.object(worker.os, "dup") as duplicate:
            result = worker.inherited_fd_check(TARGET, NONCE)
        duplicate.assert_not_called()
        self.assertEqual(result["matching_fds"], [])
        self.assertEqual(result["send_attempts"], [])
        with patch.object(worker.os, "scandir", side_effect=PermissionError(errno.EACCES, "denied")), \
             self.assertRaises(PermissionError):
            worker.inherited_fd_check(TARGET, NONCE)

    def test_worker_rejects_non_synthetic_targets_and_payloads(self):
        for target, nonce in (({**TARGET, "fd": 64}, NONCE), ({"dev": True, "ino": 999}, NONCE),
                              (TARGET, "anything"), (TARGET, NONCE.replace("a", "z"))):
            with self.subTest(target=target, nonce=nonce), self.assertRaises(ValueError):
                worker.inherited_fd_check(target, nonce)

    def test_source_places_snapshots_inside_real_barriers_and_eof_after_exit(self):
        source = (HERE / "controller.py").read_text()
        start = source.split("def start(self):", 1)[1].split("def send", 1)[0]
        outer = start.split("with stable_sender(outer_peer[0])", 1)[1].split("inner_record,", 1)[0]
        self.assertLess(outer.index("rows = fd_table("), outer.index('connection.sendall(b"HOST\\n")'))
        self.assertIn("host_rows = fd_table(os.getpid())", outer)
        self.assertIn("require_outer_injection", outer)
        inner = start.split("with stable_sender(peer_pid)", 1)[1].split('# disconnect', 1)[0]
        self.assertLess(inner.index("rows = fd_table(peer_pid)"), inner.index('connection.sendall(b"GO\\n")'))
        self.assertIn("not self.sentinel.exists()", inner)
        self.assertIn("pass_fds=pass_fds", start)
        self.assertLess(start.index("os.close(self.extra_child_fd)"),
                        start.index("self.listener.accept()"))
        close = source.split("def close(self):", 1)[1].split("class Campaign", 1)[0]
        self.assertLess(close.index('self.ask("exit")'), close.index("self.process.wait(timeout=5)"))
        self.assertLess(close.index("normal_exit = True"), close.index("peer_eof(self.extra_peer)"))
        self.assertIn("if normal_exit:", close)
        self.assertIn("elif result[\"error\"] is not None or not result[\"eof\"]:", close)

    def test_failed_exit_or_incomplete_startup_cannot_claim_inheritance_pass(self):
        for ready, code in ((True, 1), (False, 78)):
            with self.subTest(ready=ready, code=code), tempfile.TemporaryDirectory() as directory:
                output = Path(directory)
                campaign = SimpleNamespace(lanes=[], output=output, record=Mock())
                lane = controller.Lane(campaign, {
                    "control": str(output / "control"), "launch_id": "a",
                    "cwd": str(output), "profile": "work",
                }, extra_fd_probe=True)
                lane.ready = ready
                lane.process = Mock()
                lane.process.wait.return_value = code
                lane.process.poll.return_value = code
                lane.ask = Mock(return_value={"event": "bye"})
                lane.extra_peer = Mock()
                peer = lane.extra_peer
                with patch.object(controller, "peer_eof", return_value={
                    "eof": True, "received_hex": "", "error": None,
                }):
                    lane.close()
                peer.close.assert_called_once()
                calls = campaign.record.call_args_list
                self.assertFalse(any(call.args[0] == "synthetic_fd_peer_eof_without_nonce"
                                     for call in calls))
                self.assertEqual(calls[-1].args, ("lane_cleanup", False))
                self.assertFalse(calls[-1].kwargs["extra_fd_cleanup"]["normal_exit"])


class AbstractListenerPositive(unittest.TestCase):
    def setUp(self):
        self.peercred = patch.object(socket, "SO_PEERCRED", 17, create=True)
        self.peercred.start()
        self.addCleanup(self.peercred.stop)

    def test_requires_exact_peer_real_bytes_and_eof(self):
        credentials = (os.getpid(), os.getuid(), os.getgid())
        connection, client, listener = MagicMock(), Mock(), Mock()
        connection.getsockopt.return_value = controller.struct.pack("3i", *credentials)
        listener.accept.return_value = (connection, None)
        result = {"eof": True, "received_hex": b"DYNAMIC_HOST_ABSTRACT_CONTROL\n".hex(), "error": None}
        with patch.object(controller.Path, "read_text", return_value="unconfined"), \
             patch.object(controller.socket, "socket", return_value=nullcontext(client)), \
             patch.object(controller, "peer_eof", return_value=result):
            evidence = controller.abstract_reachable_same_uid(listener, "morphz-dynamic-unit")
        self.assertEqual(evidence["peer"], credentials)
        client.connect.assert_called_once_with("\0morphz-dynamic-unit")
        client.sendall.assert_called_once_with(b"DYNAMIC_HOST_ABSTRACT_CONTROL\n")
        client.shutdown.assert_called_once_with(socket.SHUT_WR)
        for change in ({"eof": False}, {"received_hex": ""}, {"error": "timeout"}):
            with patch.object(controller.Path, "read_text", return_value="unconfined"), \
                 patch.object(controller.socket, "socket", return_value=nullcontext(client)), \
                 patch.object(controller, "peer_eof", return_value={**result, **change}), \
                 self.assertRaises(RuntimeError):
                controller.abstract_reachable_same_uid(listener, "morphz-dynamic-unit")
        connection.getsockopt.return_value = controller.struct.pack("3i", credentials[0], credentials[1] + 1, credentials[2])
        with patch.object(controller.Path, "read_text", return_value="unconfined"), \
             patch.object(controller.socket, "socket", return_value=nullcontext(client)), \
             patch.object(controller, "peer_eof", return_value=result), \
             self.assertRaises(RuntimeError):
            controller.abstract_reachable_same_uid(listener, "morphz-dynamic-unit")

    def test_positive_precedes_same_listener_negative_and_self_ipc_is_separate(self):
        source = (HERE / "controller.py").read_text()
        block = source.split("with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as abstract_listener:", 1)[1]
        self.assertLess(block.index("abstract_reachable_same_uid"), block.index('allowed.ask("unix_boundary"'))
        self.assertIn('"host_abstract_connection_denied"', block)
        self.assertIn('"same_process_socketpair_functional_positive"', block)
        self.assertNotIn("unix_lifecycle_does_not_allow", source)


class KernelRingDiagnostics(unittest.TestCase):
    def test_ring_read_does_not_clear_or_reconfigure_and_filters_exact_family(self):
        run = "0123456789abcdef" * 2
        other = "fedcba9876543210" * 2
        wanted = f'audit: profile="morphz_dynamic_{run}_launch_work" denied'
        result = {"argv": [], "code": 0, "stdout": "\n".join((
            "unrelated kernel message",
            f'audit: profile="morphz_dynamic_{other}_launch_work" denied',
            wanted,
        )), "stderr": ""}
        with patch.object(controller, "privileged", return_value=result) as read:
            actual = controller.scoped_kernel_ring(run)
        read.assert_called_once_with("/usr/bin/dmesg", "--color=never")
        self.assertEqual(actual["stdout"], wanted)
        self.assertEqual(actual["code"], 0)

    def test_ring_failure_is_not_hidden_and_invalid_run_never_executes(self):
        result = {"code": 1, "stdout": "", "stderr": "synthetic failure"}
        with patch.object(controller, "privileged", return_value=result) as read:
            self.assertEqual(controller.scoped_kernel_ring("a" * 32), result)
            for invalid in ("", "a" * 31, "a" * 33, "G" * 32, "--clear"):
                with self.subTest(run=invalid), self.assertRaises(ValueError):
                    controller.scoped_kernel_ring(invalid)
        read.assert_called_once_with("/usr/bin/dmesg", "--color=never")

    def test_ring_and_journal_are_independent_before_unmodified_collection(self):
        source = (HERE / "controller.py").read_text()
        finish = source.split("def finish(self, error):", 1)[1].split("def main", 1)[0]
        self.assertLess(finish.index('self.record("campaign_error", False'),
                        finish.index('self.record("kernel_audit_diagnostic"'))
        self.assertLess(finish.index('except Exception as audit_error:'),
                        finish.index('ring = scoped_kernel_ring(self.run_id)'))
        self.assertLess(finish.index('except Exception as ring_error:'),
                        finish.index('for lane in self.lanes:'))


class ExceptionDiagnostics(unittest.TestCase):
    def test_oserror_preserves_original_paths_errno_and_callsite(self):
        original = FileNotFoundError(errno.ENOENT, "synthetic missing",
                                     "/proc/123/fd/64", None, "/synthetic/second")
        try:
            raise original
        except FileNotFoundError as error:
            result = controller.exception_diagnostic(error, "inner_full_fd_table")
        self.assertEqual(result["phase"], "inner_full_fd_table")
        self.assertEqual(result["errno"], errno.ENOENT)
        self.assertEqual(result["filename"], "/proc/123/fd/64")
        self.assertEqual(result["filename2"], "/synthetic/second")
        self.assertEqual(result["type"], "FileNotFoundError")
        self.assertIn("raise original", result["traceback"])
        self.assertIn("FileNotFoundError", result["traceback"])
        self.assertEqual(original.errno, errno.ENOENT)

    def test_non_oserror_and_signal_do_not_require_errno_fields(self):
        for error in (RuntimeError("original"), KeyboardInterrupt("signal")):
            with self.subTest(error=error):
                result = controller.exception_diagnostic(error, "inner_pin_sender")
                self.assertIsNone(result["errno"])
                self.assertIsNone(result["filename"])
                self.assertIsNone(result["filename2"])
                self.assertIn(str(error), result["traceback"])

    def test_receipt_stays_false_and_existing_checks_are_not_caught_or_retried(self):
        source = (HERE / "controller.py").read_text()
        finish = source.split("def finish(self, error):", 1)[1].split("def main", 1)[0]
        self.assertIn('self.record("campaign_error", False, error=repr(error),', finish)
        self.assertIn("diagnostic=exception_diagnostic(error, self.phase)", finish)
        start = source.split("def start(self):", 1)[1].split("def send", 1)[0]
        self.assertLess(start.index('self.campaign.phase = "inner_verify_admission"'),
                        start.index("evidence = verify_admission("))
        self.assertLess(start.index('self.campaign.phase = "inner_full_fd_table"'),
                        start.index("rows = fd_table(peer_pid)"))
        self.assertNotIn("except FileNotFoundError", start)
        self.assertNotIn("except OSError", start)


class WorkerExceptionDiagnostics(unittest.TestCase):
    def run_worker(self, request):
        profile = "synthetic_boot//&synthetic_work"
        source = "\n".join(json.dumps(item) for item in (
            request, {"op": "exit", "id": 2},
        )) + "\n"
        output = io.StringIO()
        with patch.object(worker.sys, "argv", ["worker.py", "--profile", profile]), \
             patch.object(worker.sys, "stdin", io.StringIO(source)), \
             patch.object(worker, "identity", return_value={"label": profile + " (enforce)"}), \
             patch.object(worker.Path, "write_text"), redirect_stdout(output):
            self.assertEqual(worker.main(), 0)
        records = [json.loads(line.removeprefix(worker.PREFIX))
                   for line in output.getvalue().splitlines()]
        self.assertEqual([item["event"] for item in records], ["ready", "operation_error", "bye"])
        self.assertEqual(records[1]["id"], 1)
        self.assertEqual(records[2]["id"], 2)
        return records[1]

    def test_fd_scan_errors_keep_original_repr_paths_errno_and_worker_callsite(self):
        request = {"op": "inherited_fd", "id": 1, "target": TARGET, "nonce": NONCE}
        entries = [SimpleNamespace(name="64", path="/proc/self/fd/64")]
        for operation in ("scandir", "stat"):
            original = PermissionError(errno.EACCES, "synthetic denied",
                                       "/proc/self/fd/64", None, "/synthetic/second")
            with self.subTest(operation=operation), \
                 patch.object(worker, "os", wraps=os) as worker_os:
                worker_os.scandir.return_value = nullcontext(entries)
                failing = worker_os.scandir if operation == "scandir" else worker_os.stat
                failing.side_effect = original
                record = self.run_worker(request)
                failing.assert_called_once()
                worker_os.dup.assert_not_called()
            self.assertEqual(record["error"], repr(original))
            detail = record["diagnostic"]
            self.assertEqual(detail["type"], "PermissionError")
            self.assertEqual(detail["errno"], errno.EACCES)
            self.assertEqual(detail["filename"], "/proc/self/fd/64")
            self.assertEqual(detail["filename2"], "/synthetic/second")
            self.assertIn("inherited_fd_check", detail["traceback"])
            self.assertIn("worker.py", detail["traceback"])
            self.assertIn("os." + operation, detail["traceback"])
            self.assertIn("PermissionError", detail["traceback"])
            self.assertFalse(controller.inherited_fd_closed(
                True, True, None, {"eof": True, "received_hex": "", "error": None}))

    def test_validation_error_diagnostics_have_null_oserror_fields(self):
        with patch.object(worker.os, "scandir") as scan:
            record = self.run_worker({
                "op": "inherited_fd", "id": 1, "target": TARGET, "nonce": "not-synthetic",
            })
            scan.assert_not_called()
        self.assertEqual(record["error"], repr(ValueError("invalid synthetic inherited-socket target")))
        self.assertEqual(record["diagnostic"]["type"], "ValueError")
        for field in ("errno", "filename", "filename2"):
            self.assertIsNone(record["diagnostic"][field])
        self.assertIn("inherited_fd_check", record["diagnostic"]["traceback"])

    def test_controller_still_raises_for_operation_error_with_diagnostics(self):
        record = self.run_worker({"op": "invalid-synthetic-op", "id": 1})
        lane = object.__new__(controller.Lane)
        lane.master = 123  # A supplied complete line must fail before any FD read.
        lane.pending = bytearray((worker.PREFIX + json.dumps(record) + "\n").encode())
        lane.transcript = []
        with patch.object(controller.select, "select") as select_call, \
             patch.object(controller.os, "read") as read_call:
            with self.assertRaises(RuntimeError) as failure:
                lane.wait("result", 1)
            select_call.assert_not_called()
            read_call.assert_not_called()
        self.assertEqual(json.loads(str(failure.exception)), record)
        self.assertEqual(len(lane.transcript), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
