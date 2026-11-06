"""Headless HTTP, CORS, and automatic-start behavior."""
import threading
import unittest
from types import MethodType, SimpleNamespace
from unittest.mock import Mock

from pedal_ui import Handler, PedalApp


class FakeApp:
    token = "test-token"

    def state(self):
        return {"running": True, "token": self.token}


class HeadlessServerTests(unittest.TestCase):
    def handler(self, path, headers=None):
        handler = Handler.__new__(Handler)
        handler.server = SimpleNamespace(
            app=FakeApp(), allowed_origins={"http://controller.local:4173"}
        )
        handler.path = path
        handler.headers = headers or {}
        handler.response_status = None
        handler.response_headers = {}
        handler.response_body = None

        def send(instance, status, body, content_type="application/json; charset=utf-8"):
            instance.response_status = status
            instance.response_body = body

        handler.send = MethodType(send, handler)
        handler.send_response = lambda status: setattr(handler, "response_status", status)
        handler.send_header = lambda name, value: handler.response_headers.__setitem__(name, value)
        handler.end_headers = lambda: None
        return handler

    def test_api_is_reachable_from_an_allowed_browser_origin(self):
        handler = self.handler("/api/state", {
            "Host": "guitar-pedal.local:8080", "Origin": "http://controller.local:4173"
        })
        self.assertEqual(handler.permitted_origin(), "http://controller.local:4173")
        handler.do_GET()
        self.assertEqual(handler.response_status, 200)
        self.assertTrue(handler.response_body["running"])

    def test_preflight_and_private_network_headers(self):
        handler = self.handler("/api/state", {
            "Host": "guitar-pedal.local:8080",
            "Origin": "http://controller.local:4173",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Private-Network": "true",
        })
        handler.do_OPTIONS()
        self.assertEqual(handler.response_status, 204)
        self.assertIn("X-Pedal-Token", handler.response_headers["Access-Control-Allow-Headers"])
        self.assertEqual(handler.response_headers["Access-Control-Allow-Private-Network"], "true")
        self.assertEqual(handler.response_headers["Access-Control-Allow-Origin"], "http://controller.local:4173")

    def test_disallowed_origin_is_rejected_and_ui_is_not_served(self):
        handler = self.handler("/api/state", {
            "Host": "guitar-pedal.local:8080", "Origin": "http://untrusted.example"
        })
        handler.do_GET()
        self.assertEqual(handler.response_status, 403)
        handler = self.handler("/app.js")
        handler.do_GET()
        self.assertEqual(handler.response_status, 404)

    def test_root_identifies_a_headless_service(self):
        handler = self.handler("/")
        handler.do_GET()
        self.assertEqual(handler.response_status, 200)
        self.assertTrue(handler.response_body["headless"])


class AutomaticStartTests(unittest.TestCase):
    def test_pedals_start_when_gpio_is_ready(self):
        app = PedalApp.__new__(PedalApp)
        app.auto_start_thread = None
        app.connection_stop = threading.Event()
        app.lock = threading.RLock()
        app.gpio_status = "ready"
        app.revision = "revision"
        app.log = Mock()
        app.start = Mock()

        app.start_automatically()
        app.auto_start_thread.join(timeout=2)

        self.assertFalse(app.auto_start_thread.is_alive())
        app.start.assert_called_once_with("revision")


if __name__ == "__main__":
    unittest.main()
