"""Bounded Unix control/admission event loop for the Linux policy service.

The administrator owns the directories and installed executable registry. No
user command is accepted or executed. Installation and Runtime startup receipts
remain separate from this transport/controller implementation.
"""
import array
import os
from pathlib import Path
import select
import socket
import stat
import time
import json

from lifecycle import trusted_directory
from peer import configure_listener, receive_frame
from policy import decode_request


class ServiceLoop:
    def __init__(self, registration, control_path):
        self.registration = registration
        self.control_path = Path(control_path)
        self.directory = trusted_directory(self.control_path.parent)
        self.listeners = {}
        self.connections = {}
        self.paths = {}
        try:
            self._listen(self.control_path, None, 0o666)
        except BaseException:
            self.close()
            raise

    def _listen(self, path, launch, mode):
        if path.exists() or path.is_symlink():
            info = path.lstat()
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0:
                raise PermissionError("existing service endpoint is not an administrator-owned socket")
            # An exclusive state lock is already held. Still refuse to replace
            # a live endpoint belonging to a different configured service.
            with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as probe:
                probe.settimeout(0.1)
                try:
                    probe.connect(str(path))
                except ConnectionRefusedError:
                    path.unlink()
                else:
                    raise PermissionError("another live service owns this endpoint")
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        try:
            configure_listener(listener)
            listener.bind(str(path))
            os.chmod(path, mode)
            listener.listen(32)
            listener.setblocking(False)
            self.listeners[listener] = launch
            self.paths[listener] = path
        except BaseException:
            listener.close()
            raise

    def _retire_listener(self, listener):
        listener.close()
        self.listeners.pop(listener, None)
        path = self.paths.pop(listener, None)
        if path is not None:
            # Only exact socket objects created by this process are removed.
            # Persistent records/profiles stay owned by the lease lifecycle.
            path.unlink(missing_ok=True)

    def close(self):
        for connection in list(self.connections):
            connection.close()
        self.connections.clear()
        for listener in list(self.listeners):
            self._retire_listener(listener)
        if self.directory >= 0:
            os.close(self.directory)
            self.directory = -1

    def _reply(self, connection, value, descriptor=None):
        ancillary = [] if descriptor is None else [
            (socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [descriptor]))]
        try:
            connection.sendmsg([json.dumps(value).encode()], ancillary)
        except (BrokenPipeError, ConnectionResetError, BlockingIOError):
            pass  # losing a response never unloads protection for live work
        finally:
            if descriptor is not None:
                os.close(descriptor)
            self.connections.pop(connection, None)
            connection.close()

    def step(self, timeout=0.1):
        self.registration.collect_exited()
        for listener, launch in list(self.listeners.items()):
            record = self.registration.leases.records.get(launch)
            if launch is not None and (record is None or record["phase"] in ("closing", "admitted")):
                self._retire_listener(listener)
        for connection, (_launch, deadline) in list(self.connections.items()):
            if time.monotonic() >= deadline:
                self._reply(connection, {"ok": False, "error": "control_frame_timeout"})
        # Root pins can legitimately occupy high FD numbers. poll has no
        # select(2) FD_SETSIZE ceiling and the number of endpoints stays bounded.
        endpoints = {item.fileno(): item for item in (*self.listeners, *self.connections)}
        poller = select.poll()
        for descriptor in endpoints:
            poller.register(descriptor, select.POLLIN)
        ready = [endpoints[descriptor] for descriptor, _events in poller.poll(int(timeout * 1000))]
        for endpoint in ready:
            if endpoint in self.listeners:
                connection, _ = endpoint.accept()
                connection.setblocking(False)
                if len(self.connections) >= 64:
                    connection.close()
                    continue
                self.connections[connection] = (self.listeners[endpoint], time.monotonic() + 2)
                continue
            launch, _ = self.connections[endpoint]
            descriptor = None
            try:
                with receive_frame(endpoint) as frame:
                    if launch is None:
                        reply, descriptor = self.registration.handle(frame)
                        if decode_request(frame.body).get("op") == "register":
                            name = reply["launch"]
                            path = self.control_path.parent / ("admit-" + name + ".sock")
                            try:
                                self._listen(path, name, 0o666)
                            except BaseException:
                                self.registration.leases.close_admission(name)
                                self.registration.leases.collect(name)
                                raise
                            reply["admission_socket"] = str(path)
                        elif decode_request(frame.body).get("op") == "claim":
                            reply["admission_socket"] = str(
                                self.control_path.parent / ("admit-" + reply["launch"] + ".sock"))
                    else:
                        if decode_request(frame.body) != {"op": "admit", "launch": launch}:
                            raise PermissionError("private endpoint accepts only its own exact admission")
                        reply = self.registration.admission.admit(launch, frame)
            except (ValueError, OSError, RuntimeError, KeyError) as error:
                if descriptor is not None:
                    os.close(descriptor)
                    descriptor = None
                reply = {"ok": False, "error": type(error).__name__, "detail": str(error)[:2048]}
            self._reply(endpoint, reply, descriptor)
