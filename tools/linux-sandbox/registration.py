"""Authenticated registration/claim operations for the privileged service.

There is deliberately no public 'admit' operation here: general work still needs
the native mounted-object/label admission gate. No request may contain a command,
policy source, credentials, descriptor numbers, or a chosen profile name.
"""
from dataclasses import asdict
import os

from admission import Admission
from lifecycle import launch_name
from peer import PeerError, PeerFrame, authorize, require_live
from policy import Policy, PolicyError, compile_profiles, decode_request


def hold(frame):
    descriptor = os.dup(frame.pidfd)
    os.set_inheritable(descriptor, False)
    return PeerFrame(b"", frame.pid, frame.uid, frame.gid, descriptor)


class Registration:
    def __init__(self, leases, runtime_executables, launcher_executables):
        self.leases = leases
        self.runtime_executables = runtime_executables
        self.launcher_executables = launcher_executables
        self.owners = {}
        self.launchers = {}
        self.startup = {}
        self.admission = Admission(self)

    def close(self):
        # Closing the service is NOT permission to unload active protection.
        self.admission.close()
        for descriptor in self.startup.values():
            os.close(descriptor)
        self.startup.clear()
        for bindings in (self.owners, self.launchers):
            for frame, _identity in bindings.values():
                frame.close()
            bindings.clear()

    def _owner(self, launch):
        if launch not in self.owners:
            raise PeerError("lease has no live authenticated owner; restart does not restore PID authority")
        frame, identity = self.owners[launch]
        if authorize(frame, self.runtime_executables) != identity:
            raise PeerError("registered Runtime identity changed")
        return identity

    def signal_admitted(self, launch):
        # A one-way, kernel-passed descriptor belongs only to the authenticated
        # Runtime registration. No command stdout, child-provided 'ready', PID
        # file or model data is accepted as evidence. One byte means the service
        # has checked actual admission; EOF means no such confirmation exists.
        descriptor = self.startup.pop(launch, None)
        if descriptor is None:
            raise PeerError("launch has no unconsumed private startup receipt")
        try:
            if os.write(descriptor, b"\x01") != 1:
                raise PeerError("private startup confirmation was not delivered")
        finally:
            os.close(descriptor)

    def handle(self, frame):
        request = decode_request(frame.body)
        operation = request.get("op")
        if operation == "register" and set(request) == {"op", "policy"}:
            identity = authorize(frame, self.runtime_executables)
            policy = Policy.from_request(request["policy"])
            retained = hold(frame)
            launch = None
            reader = writer = -1
            try:
                launch = self.leases.register(policy, asdict(identity))
                if authorize(frame, self.runtime_executables) != identity:
                    raise PeerError("Runtime changed during policy registration")
                reader, writer = os.pipe2(os.O_CLOEXEC | os.O_NONBLOCK)
                self.owners[launch] = (retained, identity)
                self.startup[launch] = writer
            except BaseException:
                retained.close()
                for descriptor in (reader, writer):
                    if descriptor >= 0:
                        os.close(descriptor)
                if launch is not None:
                    self.leases.close_admission(launch)
                    self.leases.collect(launch)
                raise
            return {"ok": True, "launch": launch}, reader
        if operation == "claim" and set(request) == {"op", "launch"}:
            launch = launch_name(request["launch"])
            identity = authorize(frame, self.launcher_executables)
            owner = self._owner(launch)
            if ((identity.uid, identity.gid, identity.user_namespace) !=
                    (owner.uid, owner.gid, owner.user_namespace) or identity.parent != owner.pid):
                raise PeerError("launcher is not a direct child of this live Runtime identity")
            retained = hold(frame)
            descriptor = None
            try:
                descriptor = self.leases.claim(launch)
                if authorize(frame, self.launcher_executables) != identity or self._owner(launch) != owner:
                    raise PeerError("launch identities changed during claim")
                self.launchers[launch] = (retained, identity)
                record = self.leases.records[launch]
                compiled = compile_profiles(Policy.from_request(record["policy"]), launch)
                return {"ok": True, "launch": launch, "bootstrap": compiled.bootstrap,
                        "work": compiled.work, "policy": record["policy"]}, descriptor
            except BaseException:
                retained.close()
                if descriptor is not None:
                    os.close(descriptor)
                    self.leases.close_admission(launch)
                    self.leases.collect(launch)
                raise
        if operation == "bind_roots" and set(request) == {"op", "launch", "descriptors"}:
            launch = launch_name(request["launch"])
            roots = self.admission.pin(launch, frame, request["descriptors"])
            return {"ok": True, "launch": launch, "roots": roots}, None
        if operation == "release" and set(request) == {"op", "launch"}:
            launch = launch_name(request["launch"])
            if authorize(frame, self.runtime_executables) != self._owner(launch):
                raise PeerError("only the exact live owning Runtime may close this admission")
            self.leases.close_admission(launch)
            removed = self.leases.collect(launch)
            self.reap_bindings()
            return {"ok": True, "retained_for_descendants": not removed}, None
        raise PolicyError("unregistered control operation or extra fields")

    def reap_bindings(self):
        for launch in list(self.startup):
            if launch not in self.leases.records or self.leases.records[launch]["phase"] == "closing":
                os.close(self.startup.pop(launch))
        for launch in list(self.admission.pins):
            if launch not in self.leases.records:
                self.admission.close(launch)
        for bindings in (self.owners, self.launchers):
            for launch in list(bindings):
                if launch not in self.leases.records:
                    frame, _identity = bindings.pop(launch)
                    frame.close()

    def collect_exited(self):
        for launch, record in list(self.leases.records.items()):
            if record["phase"] != "closing":
                bindings = [self.owners.get(launch)]
                if launch in self.launchers:
                    bindings.append(self.launchers[launch])
                for binding in bindings:
                    try:
                        if binding is None:
                            raise PeerError("no retained lifetime authority")
                        require_live(binding[0])
                    except PeerError:
                        self.leases.close_admission(launch)
                        break
            if record["phase"] == "closing":
                self.leases.collect(launch)
        self.reap_bindings()
