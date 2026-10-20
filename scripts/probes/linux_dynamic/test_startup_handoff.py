"""Pure mocked/source checks, not proof of Linux/AppArmor/FD inheritance."""

from contextlib import ExitStack
import json
import os
from pathlib import Path
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import controller

HERE = Path(__file__).resolve().parent


class CredentialFrames(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        # Linux-only numeric constants are test doubles on non-Linux hosts,
        # never production fallbacks. recvmsg itself is always mocked.
        for name, value in (("SCM_CREDENTIALS", 2), ("MSG_CMSG_CLOEXEC", 0x40000000)):
            self.stack.enter_context(patch.object(socket, name, value, create=True))
        self.peer = (101, 1001, 1001)

    def credentials(self, peer=None):
        return [(socket.SOL_SOCKET, socket.SCM_CREDENTIALS, struct.pack("3i", *(peer or self.peer)))]

    def receive(self, parts):
        connection = Mock()
        connection.recvmsg.side_effect = parts
        return controller.receive_startup(connection)

    def test_single_frame_and_fragmented_frame_have_identical_sender(self):
        whole = (b'{"phase":"inner"}\n', self.credentials(), 0, None)
        parts = [(b'{"phase":', self.credentials(), 0, None),
                 (b'"inner"}\n', self.credentials(), 0, None)]
        expected = ({"phase": "inner"}, self.peer)
        self.assertEqual(self.receive([whole]), expected)
        self.assertEqual(self.receive(parts), expected)

    def test_missing_duplicate_short_and_mixed_credentials_fail(self):
        for ancillary in ([], self.credentials() * 2,
                          [(socket.SOL_SOCKET, socket.SCM_CREDENTIALS, b"short")],
                          [(socket.SOL_SOCKET, 9999, b"unknown")]):
            with self.subTest(ancillary=ancillary), self.assertRaises(RuntimeError):
                self.receive([(b"{}\n", ancillary, 0, None)])
        with self.assertRaisesRegex(RuntimeError, "mixed different senders"):
            self.receive([(b"{", self.credentials(), 0, None),
                          (b"}\n", self.credentials((102, 1001, 1001)), 0, None)])

    def test_truncated_empty_oversize_multiframe_and_duplicate_json_fail(self):
        cases = [
            (b"{}\n", socket.MSG_CTRUNC), (b"{}\n", socket.MSG_TRUNC),
            (b"", 0), (b"x" * 4097, 0), (b"{}\n{}\n", 0), (b"{}\ntrailing", 0),
        ]
        for raw, flags in cases:
            with self.subTest(raw=raw[:20], flags=flags), self.assertRaises(RuntimeError):
                self.receive([(raw, self.credentials(), flags, None)])
        with self.assertRaisesRegex(ValueError, "duplicate key"):
            self.receive([(b'{"phase":"outer","phase":"inner"}\n', self.credentials(), 0, None)])

    def test_unexpected_rights_are_closed_even_on_truncated_frame(self):
        ancillary = self.credentials() + [
            (socket.SOL_SOCKET, socket.SCM_RIGHTS, struct.pack("2i", 123, 124)),
        ]
        with patch.object(controller.os, "close") as close, self.assertRaises(RuntimeError):
            self.receive([(b"{}\n", ancillary, socket.MSG_CTRUNC, None)])
        self.assertEqual([call.args for call in close.call_args_list], [(123,), (124,)])


class HostIdentity(unittest.TestCase):
    def info(self, **changes):
        return SimpleNamespace(**{
            "st_mode": stat.S_IFREG | 0o444, "st_uid": 0, "st_size": 91,
            "st_dev": 10, "st_ino": 20, **changes,
        })

    def test_manifest_host_root_readonly_regular_and_bounded(self):
        with patch.object(controller.os, "fstat", return_value=self.info()), \
             patch.object(controller.fcntl, "fcntl", return_value=os.O_RDONLY):
            self.assertEqual(controller.manifest_fd_identity(3), {
                "dev": 10, "ino": 20, "size": 91, "mode": stat.S_IFREG | 0o444, "access": 0,
            })
        for info, access in (
            (self.info(st_uid=1001), os.O_RDONLY),
            (self.info(st_uid=65534), os.O_RDONLY),
            (self.info(st_mode=stat.S_IFLNK | 0o444), os.O_RDONLY),
            (self.info(st_mode=stat.S_IFREG | 0o464), os.O_RDONLY),
            (self.info(st_size=0), os.O_RDONLY),
            (self.info(st_size=65537), os.O_RDONLY),
            (self.info(), os.O_WRONLY), (self.info(), os.O_RDWR),
        ):
            with self.subTest(info=info, access=access), \
                 patch.object(controller.os, "fstat", return_value=info), \
                 patch.object(controller.fcntl, "fcntl", return_value=access), \
                 self.assertRaises(RuntimeError):
                controller.manifest_fd_identity(3)

    def pinned(self, identities=None, polls=None):
        scope = ExitStack()
        self.addCleanup(scope.close)
        opener = scope.enter_context(patch.object(controller.os, "pidfd_open", return_value=321, create=True))
        close = scope.enter_context(patch.object(controller.os, "close"))
        poller = Mock()
        poller.poll.side_effect = polls or [[], []]
        scope.enter_context(patch.object(controller.select, "poll", return_value=poller, create=True))
        scope.enter_context(patch.object(controller.select, "POLLIN", 1, create=True))
        scope.enter_context(patch.object(controller, "proc_identity", side_effect=identities or [
            {"pid": 12, "ppid": 9, "starttime": 7},
            {"pid": 12, "ppid": 9, "starttime": 7},
        ]))
        return opener, close

    def test_pidfd_stays_open_through_reply_and_closes_after(self):
        opener, close = self.pinned()
        with controller.stable_sender(12) as (identity, current):
            self.assertEqual(identity["starttime"], 7)
            current()
            close.assert_not_called()
            # Actual send is separately tested by the source-order checks.
        opener.assert_called_once_with(12, 0)
        close.assert_called_once_with(321)

    def test_pidfd_rejects_dead_and_reused_sender_and_closes_on_error(self):
        for identities, polls in (
            (None, [[(321, 1)]]),
            (None, [[], [(321, 1)]]),
            ([{"pid": 12, "starttime": 7}, {"pid": 12, "starttime": 8}], [[], []]),
        ):
            with self.subTest(identities=identities, polls=polls):
                _, close = self.pinned(identities, polls)
                with self.assertRaises(RuntimeError):
                    with controller.stable_sender(12) as (_, current):
                        current()
                close.assert_called_once_with(321)

    def test_invalid_pid_never_opens_pidfd(self):
        with patch.object(controller.os, "pidfd_open", create=True) as opener:
            for pid in (0, 1, -1, True, "12"):
                with self.subTest(pid=pid), self.assertRaises(RuntimeError):
                    with controller.stable_sender(pid):
                        self.fail("unexpected admission")
            opener.assert_not_called()

    def test_initial_nonempty_poll_keeps_original_error_and_exact_events(self):
        for events in ([(321, 1)], [(321, 8)], [(321, 16)], [(321, 17)], [(321, 32)]):
            with self.subTest(events=events), \
                 patch.object(controller.os, "pidfd_open", return_value=321, create=True) as opener, \
                 patch.object(controller.os, "close") as close, \
                 patch.object(controller.select, "POLLIN", 1, create=True), \
                 patch.object(controller.select, "poll", create=True) as create_poll, \
                 patch.object(controller, "proc_identity") as identity:
                poller = create_poll.return_value
                poller.poll.return_value = events
                with self.assertRaises(RuntimeError) as raised:
                    with controller.stable_sender(12):
                        self.fail("nonempty poll must not enter admission")
                opener.assert_called_once_with(12, 0)
                poller.register.assert_called_once_with(321, 1)
                poller.poll.assert_called_once_with(0)
                close.assert_called_once_with(321)
                identity.assert_not_called()
            failure = raised.exception
            self.assertEqual(repr(failure), "RuntimeError('sender already exited')")
            self.assertEqual(len(failure.__notes__), 1)
            note = failure.__notes__[0].removeprefix("DYNAMIC_PIDFD_POLL ")
            self.assertEqual(json.loads(note), {"pid": 12, "events": [list(item) for item in events]})
            diagnostic = controller.exception_diagnostic(failure, "inner_pin_sender")
            self.assertIn(failure.__notes__[0], diagnostic["traceback"])

    def test_outer_requires_exact_original_child_executable_namespace_and_label(self):
        manifest = {
            "run_id": "a", "launch_id": "b", "policy_hash": "c", "profile": "work",
            "bootstrap": "boot", "uid": 1001, "entry": "/trusted/entry",
        }
        identity = {"pid": 12, "ppid": 9, "starttime": 7}
        fd = {"dev": 10, "ino": 20, "mode": stat.S_IFREG | 0o444, "size": 91, "access": 0}
        outer = controller.expected_startup(manifest, "outer", fd)

        def verify(*, peer=(12, 1001, 1001), process=None, record=None,
                   live=None, label="boot (enforce)", executable="/trusted/entry",
                   different_namespace=False):
            def link(path):
                if path.endswith("/exe"):
                    return executable
                return ("other:" if different_namespace and "/12/" in path else "host:") + path.rsplit("/", 1)[-1]
            with patch.object(controller.os, "getpid", return_value=9), \
                 patch.object(controller.os, "getgid", return_value=1001), \
                 patch.object(controller.os, "readlink", side_effect=link), \
                 patch.object(controller.Path, "read_text", return_value=label):
                return controller.verify_outer(peer, process or identity, record or outer,
                                               manifest, fd, live or identity)

        self.assertEqual(verify()["peer"], identity)
        for change in (
            {"peer": (13, 1001, 1001)}, {"peer": (12, 65534, 1001)},
            {"peer": (12, 1001, 1002)}, {"live": {**identity, "starttime": 8}},
            {"process": {**identity, "ppid": 8}, "live": {**identity, "ppid": 8}},
            {"record": {**outer, "phase": "inner"}},
            {"record": {**outer, "manifest_fd": {**fd, "ino": 21}}},
            {"record": {**outer, "launch_id": "another-task"}},
            {"label": "boot//&work (enforce)"}, {"label": "boot (complain)"},
            {"executable": "/other/entry"}, {"different_namespace": True},
        ):
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                verify(**change)


class FixedHandoffSource(unittest.TestCase):
    def test_bootstrap_check_precedes_all_supplied_fd_reads(self):
        source = (HERE / "entry.c").read_text()
        main = source.split("int main(", 1)[1]
        self.assertLess(main.index("bootstrap_only();"), main.index("open(argv[2]"))
        self.assertLess(main.index("bootstrap_only();"), main.index("manifest_fd("))
        self.assertIn('"requires one exact bootstrap-only enforcing label"', source)
        self.assertIn('"_boot (enforce)"', source)
        self.assertIn('host_owner && info.st_uid != 0', source)
        self.assertNotIn("65534", source)
        self.assertIn("pread(fd, raw + have", source)
        self.assertIn("(flags & O_ACCMODE) != O_RDONLY", source)

    def test_authenticated_fixed_slots_not_reopened_in_inner(self):
        source = (HERE / "entry.c").read_text()
        self.assertIn("#define MANIFEST_FD 3", source)
        self.assertIn("#define CONTROL_FD 4", source)
        fixed = source.split("static void fixed_startup_fds", 1)[1].split("static void outer", 1)[0]
        self.assertIn("F_DUPFD_CLOEXEC, 5", fixed)
        self.assertIn("dup2(saved_manifest, MANIFEST_FD)", fixed)
        self.assertIn("dup2(saved_control, CONTROL_FD)", fixed)
        host = source.split("static int connect_host", 1)[1].split("static void fixed_startup_fds", 1)[0]
        self.assertIn("peer.pid != parent", host)
        self.assertIn("getppid() != parent", host)
        self.assertIn('SO_PEERSEC', host)
        self.assertIn('strcmp(label, "unconfined")', host)
        outer = source.split("static void outer", 1)[1].split("static void close_extra", 1)[0]
        self.assertLess(outer.index("connect_host(obj)"), outer.index("fixed_startup_fds"))
        self.assertLess(outer.index("fixed_startup_fds"), outer.index("verify_roots"))
        self.assertIn('arg("--"); arg(text(obj, "entry")); arg("--inner");', outer)
        admission = source.split("static void admission", 1)[1].split("static void inner", 1)[0]
        self.assertIn('send_startup(CONTROL_FD, obj, "inner")', admission)
        self.assertNotIn("connect(", admission)
        self.assertIn("close(CONTROL_FD)", admission)
        inner = source.split("static void inner", 1)[1].split("int main", 1)[0]
        self.assertLess(inner.index("close(MANIFEST_FD)"), inner.index("aa_stack_profile"))
        self.assertLess(inner.index("close_extra(CONTROL_FD)"), inner.index("admission(obj)"))
        self.assertLess(inner.index("close_extra(-1)"), inner.index("execv(args[0], args)"))

    def test_each_sender_is_checked_with_pidfd_and_go_stays_inside_pin(self):
        source = (HERE / "controller.py").read_text()
        start = source.split("def start(self):", 1)[1].split("def send", 1)[0]
        self.assertLess(start.index("socket.SO_PASSCRED"), start.index("self.listener.listen"))
        self.assertIn("outer_peer != connected_peer", start)
        self.assertIn("peer_pid == connected_peer[0]", start)
        self.assertLess(start.index("verify_outer_sender()"), start.index('connection.sendall(b"HOST\\n")'))
        self.assertLess(start.index("verify_inner_sender()"), start.index('connection.sendall(b"GO\\n")'))
        self.assertLess(start.index("self.socket_path.unlink()"), start.index('connection.sendall(b"HOST\\n")'))
        # AST indentation guards prevent a future dedent from closing the pin
        # before a reply. This is still a source contract, not kernel evidence.
        import ast
        node = ast.parse(source)
        start_method = next(method for klass in node.body if isinstance(klass, ast.ClassDef)
                            and klass.name == "Lane" for method in klass.body
                            if isinstance(method, ast.FunctionDef) and method.name == "start")
        pinned = [item for item in ast.walk(start_method) if isinstance(item, ast.With)
                  and any(isinstance(child.context_expr, ast.Call)
                          and isinstance(child.context_expr.func, ast.Name)
                          and child.context_expr.func.id == "stable_sender" for child in item.items)]
        replies = [[value.value for value in ast.walk(item) if isinstance(value, ast.Constant)
                    and isinstance(value.value, bytes)] for item in pinned]
        self.assertIn([b"HOST\n"], replies)
        self.assertIn([b"GO\n", b"NO\n"], replies)


class EntryReadFailureDiagnostics(unittest.TestCase):
    """Compile only the exact expect_reply function with synthetic syscall mocks."""

    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="morphz-read-diagnostic-unit-", dir="/tmp")
        cls.addClassCleanup(cls.temporary.cleanup)
        directory = Path(cls.temporary.name)
        source = (HERE / "entry.c").read_text()
        function = "static void expect_reply" + source.split(
            "static void expect_reply", 1)[1].split("static int connect_host", 1)[0]
        prefix = r"""
#define _DEFAULT_SOURCE
#include <errno.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
static int selected_result, diagnostic_fails, calls, stat_calls, socket_calls;
static size_t last_count;
static ssize_t mock_read(int fd, void *buffer, size_t count) {
    if (fd != 4 || count != 3) exit(90);
    calls++; last_count = count;
    errno = EACCES; /* Also deliberately stale for EOF and success. */
    if (selected_result == 3) memcpy(buffer, "GO\n", 3);
    return selected_result;
}
static int mock_fprintf(FILE *stream, const char *format, ...) {
    int result = -1;
    va_list arguments;
    va_start(arguments, format);
    if (!diagnostic_fails) result = vfprintf(stream, format, arguments);
    va_end(arguments);
    errno = EIO; /* Even successful diagnostic formatting may disturb errno. */
    return result;
}
static int mock_fstat(int fd, struct stat *metadata) {
    if (fd != 4) exit(92);
    stat_calls++;
    if (diagnostic_fails) { errno = EBADF; return -1; }
    metadata->st_mode = S_IFSOCK | 0600;
    errno = ENOENT; /* Success may also leave stale errno. */
    return 0;
}
static int mock_getsockopt(int fd, int level, int option, void *value, socklen_t *size) {
    if (fd != 4 || level != SOL_SOCKET || option != SO_TYPE || *size != sizeof(int)) exit(93);
    socket_calls++;
    if (diagnostic_fails) { errno = ENOTSOCK; return -1; }
    *(int *)value = SOCK_STREAM;
    errno = EINVAL;
    return 0;
}
static void fail(const char *why) {
    printf("FAIL errno=%d why=%s calls=%d count=%zu\n", errno, why, calls, last_count);
    printf("DIAGNOSTIC_CALLS stat=%d socket=%d\n", stat_calls, socket_calls);
    exit(78);
}
#define read mock_read
#define fprintf mock_fprintf
#define fstat mock_fstat
#define getsockopt mock_getsockopt
"""
        suffix = r"""
int main(int argc, char **argv) {
    if (argc != 3) return 91;
    selected_result = atoi(argv[1]); diagnostic_fails = atoi(argv[2]);
    expect_reply(4, "GO\n", 3, "admission acknowledgement");
    printf("RETURN calls=%d count=%zu\n", calls, last_count);
    printf("DIAGNOSTIC_CALLS stat=%d socket=%d\n", stat_calls, socket_calls);
    return 0;
}
"""
        path = directory / "expect_reply.c"
        path.write_text(prefix + function + suffix)
        cls.binary = directory / "expect_reply"
        built = subprocess.run(
            ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", str(path), "-o", str(cls.binary)],
            text=True, capture_output=True, timeout=30, check=False,
        )
        if built.returncode:
            raise RuntimeError("mocked expect_reply compilation failed: " + built.stderr)

    def invoke(self, result, diagnostic_fails=False):
        started, completed = time.monotonic(), None
        try:
            # Protect this new local mock process, including OS executable load.
            # This is not an admission deadline or a business latency assertion.
            completed = subprocess.run(
                [str(self.binary), str(result), str(int(diagnostic_fails))],
                text=True, capture_output=True, timeout=60, check=False,
            )
            return completed
        finally:
            print("C_MOCK_CASE " + json.dumps({
                "read_result": result, "diagnostic_fails": diagnostic_fails,
                "elapsed_seconds": round(time.monotonic() - started, 6),
                "returncode": None if completed is None else completed.returncode,
            }), file=sys.stderr)

    def test_read_error_and_eof_are_distinct_without_retry_or_errno_change(self):
        for returned, eof in ((-1, 0), (0, 1)):
            with self.subTest(returned=returned):
                result = self.invoke(returned)
                self.assertEqual(result.returncode, 78)
                self.assertEqual(result.stdout,
                                 "FAIL errno=13 why=admission acknowledgement calls=1 count=3\n"
                                 "DIAGNOSTIC_CALLS stat=1 socket=1\n")
                self.assertEqual(result.stderr,
                                 "DYNAMIC_ENTRY_READ_FAILURE fd=4 why=admission acknowledgement "
                                 f"n={returned} errno=13 eof={eof}\n"
                                 "DYNAMIC_ENTRY_FAILED_FD fd=4 fstat=0 stat_errno=0 mode=140600 "
                                 "is_socket=1 getsockopt=0 socket_errno=0 socket_type=1 socket_size=4\n")

    def test_diagnostic_write_failure_still_preserves_original_refusal(self):
        for returned in (-1, 0):
            with self.subTest(returned=returned):
                result = self.invoke(returned, diagnostic_fails=True)
                self.assertEqual(result.returncode, 78)
                self.assertEqual(result.stdout,
                                 "FAIL errno=13 why=admission acknowledgement calls=1 count=3\n"
                                 "DIAGNOSTIC_CALLS stat=1 socket=1\n")
                self.assertEqual(result.stderr, "")

    def test_successful_reply_does_not_emit_failure_diagnostic(self):
        result = self.invoke(3)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "RETURN calls=1 count=3\n"
                                      "DIAGNOSTIC_CALLS stat=0 socket=0\n")
        self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
