"""Receipt mechanics only; real caller/admission authority is a Linux gate."""
import os
import unittest
from types import SimpleNamespace

from peer import PeerError
from registration import Registration


class StartupReceiptTests(unittest.TestCase):
    def test_only_one_service_confirmation_can_be_consumed(self):
        registration = Registration(None, None, None)
        reader, writer = os.pipe()
        registration.startup["launch"] = writer
        try:
            registration.signal_admitted("launch")
            self.assertEqual(os.read(reader, 2), b"\x01")
            self.assertEqual(os.read(reader, 1), b"")
            with self.assertRaises(PeerError):
                registration.signal_admitted("launch")
            self.assertEqual(registration.startup, {})
        finally:
            os.close(reader)
            registration.close()

    def test_refusal_or_service_shutdown_is_eof_never_success(self):
        for closing in (False, True):
            with self.subTest(closing=closing):
                leases = SimpleNamespace(records={"launch": {"phase": "closing"}})
                registration = Registration(leases, None, None)
                reader, writer = os.pipe()
                registration.startup["launch"] = writer
                try:
                    if closing:
                        registration.reap_bindings()
                    else:
                        registration.close()
                    self.assertEqual(os.read(reader, 1), b"")
                    self.assertEqual(registration.startup, {})
                finally:
                    os.close(reader)
                    registration.close()

    def test_runtime_abandonment_does_not_report_delivered_confirmation(self):
        registration = Registration(None, None, None)
        reader, writer = os.pipe()
        registration.startup["launch"] = writer
        os.close(reader)
        with self.assertRaises(BrokenPipeError):
            registration.signal_admitted("launch")
        self.assertEqual(registration.startup, {})
        with self.assertRaises(OSError):
            os.fstat(writer)


if __name__ == "__main__":
    unittest.main()
