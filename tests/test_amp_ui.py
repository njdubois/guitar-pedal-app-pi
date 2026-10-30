"""Exercise editor validation and library round trips without amp hardware."""
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

from pedal_ui import PedalApp, ROOT, UIError


@unittest.skipUnless(shutil.which("node"), "Node is required for tone validation")
class AmpEditorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        shutil.copytree(ROOT / "tones", root / "tones")
        shutil.copyfile(ROOT / "pedals.json", root / "pedals.json")
        self.app = PedalApp(root / "pedals.json", demo=True)
        self.app._check_amp({"profile": "go2", "input": None, "output": None}, False)

    def tearDown(self):
        self.app.close()
        self.directory.cleanup()

    def test_channel_targets_and_running_pedals_are_guarded(self):
        for body in ({"bank":0,"channel":"A","command":"write-memory"},
                     {"bank":1,"channel":"D","command":"recall-memory"}):
            with self.assertRaises(UIError):
                self.app.memory_action(body)
        result = self.app.memory_action({"bank":10,"channel":"C","command":"recall-memory"})
        self.assertTrue(result["verified"])
        self.assertEqual(self.app.amp["memory"], {"bank":10,"channel":"C"})
        self.app.running = True
        with self.assertRaises(UIError):
            self.app.memory_action({"bank":1,"channel":"A","command":"write-memory"})
        self.app.running = False

    def test_edit_capture_and_reload_preserves_settings(self):
        self.app.edit_amp({"changes": {"gain": 63, "ampType": "crunch", "modType": "comp"}})
        self.assertEqual(self.app.amp_settings["gain"], 63)
        self.assertIn("modCompSustain", self.app.amp_settings)
        self.assertNotIn("modChorusLowRate", self.app.amp_settings)
        saved = self.app.capture_amp({"name": "My crunch"})
        document = self.app.tone_file(saved["file"])
        self.assertEqual(document["settings"]["gain"], 63)
        self.app.edit_amp({"changes": {"gain": 10}})
        self.app.edit_amp({"file": saved["file"]})
        self.assertEqual(self.app.amp_settings["gain"], 63)

    def test_invalid_changes_do_not_modify_settings(self):
        before = dict(self.app.amp_settings)
        for changes in ({"gain": 101}, {"inventedControl": 5}, {"variation": 1}):
            with self.assertRaises(UIError):
                self.app.edit_amp({"changes": changes})
        self.assertEqual(self.app.amp_settings, before)
        self.assertEqual(self.app.amp["status"], "connected")

    def test_connection_and_library_boundary(self):
        with self.assertRaises(UIError):
            self.app.edit_amp({"file": "../../pedals.json"})
        self.app.amp["status"] = "error"
        with self.assertRaises(UIError):
            self.app.edit_amp({"changes": {"gain": 20}})
        with self.assertRaises(UIError):
            self.app.capture_amp({"name": "Offline"})

    def test_missing_amp_ports_return_to_disconnected_state(self):
        from subprocess import CompletedProcess
        from unittest.mock import Mock
        self.app.connection_stop.set()
        self.app.demo = False
        stop = Mock()
        stop.wait.side_effect = [False, True]
        with patch.object(self.app, "connection_stop", stop), patch.object(self.app, "pause") as pause, patch(
                "pedal_ui.subprocess.run", return_value=CompletedProcess([], 1, "", "Missing port")):
            self.app.watch_connection()
        self.assertEqual(self.app.amp["status"], "error")
        self.assertIn("disconnected", self.app.amp["message"])
        pause.assert_called_once()

    def test_live_edit_reads_back_with_selected_ports(self):
        self.app.demo = False
        # No monitor iteration should use hardware during this isolated check.
        self.app.connection_stop.set()
        self.app.amp["options"].update(input="Chosen input", output="Chosen output")
        settings = dict(self.app.amp_settings, gain=72)
        calls = []

        def run(args, **kwargs):
            from subprocess import CompletedProcess
            calls.append(args)
            return CompletedProcess(args, 0, json.dumps({"settings": settings}), "")

        with patch("pedal_ui.subprocess.run", side_effect=run):
            result = self.app.edit_amp({"changes": {"gain": 72}})
        self.assertEqual([args[2] for args in calls], ["validate", "apply", "read"])
        for args in calls[1:]:
            self.assertEqual(args[args.index("--input") + 1], "Chosen input")
            self.assertEqual(args[args.index("--output") + 1], "Chosen output")
        self.assertEqual(result["settings"]["gain"], 72)
