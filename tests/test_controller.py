import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("pedal_controller", ROOT / "pedal_controller.py")
pedals = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pedals)
BRIDGE_SPEC = importlib.util.spec_from_file_location("midi_bridge", ROOT / "midi_bridge.py")
bridge_module = importlib.util.module_from_spec(BRIDGE_SPEC)
BRIDGE_SPEC.loader.exec_module(bridge_module)


class LatchingAndLooperTests(unittest.TestCase):
    def test_channel_action_validation_and_dispatch(self):
        from unittest.mock import Mock
        config = json.loads((ROOT / "tests/fixtures/pedals.json").read_text())
        action = {"type":"channel","bank":10,"channel":"C"}
        config["switches"][0]["actions"] = [action]
        validated = pedals.validate_config(config, ROOT / "pedals.json")
        worker = Mock()
        pedals.dispatch(validated["switches"][0],validated,worker,False)
        target = worker.submit.call_args.args[0]
        self.assertEqual((target.bank,target.channel),(10,"C"))
        for bank,channel in ((0,"A"),(11,"A"),(True,"A"),(1,"D")):
            action.update(bank=bank,channel=channel)
            with self.assertRaises(ValueError):
                pedals.validate_config(config,ROOT / "pedals.json")

    def test_bounce_is_ignored_and_both_latch_positions_emit_one_stomp(self):
        button = pedals.DebouncedLatch(initial=False, now=0.0, seconds=.030)
        self.assertFalse(button.update(True, .005))
        self.assertFalse(button.update(False, .010))  # contact bounce
        self.assertFalse(button.update(True, .015))
        self.assertFalse(button.update(True, .044))
        self.assertTrue(button.update(True, .045))
        self.assertTrue(button.stable)
        self.assertFalse(button.update(False, .100))
        self.assertFalse(button.update(False, .129))
        self.assertTrue(button.update(False, .130))
        self.assertFalse(button.stable)
        self.assertFalse(button.update(True, .180))
        self.assertTrue(button.update(True, .210))
        self.assertTrue(button.stable)

    def test_sooperlooper_osc_record_and_loop_addresses_are_valid(self):
        packet = pedals.looper_packet(0, "record")
        self.assertEqual(packet[:12], b"/sl/0/hit\0\0\0")
        self.assertEqual(packet[12:16], b",s\0\0")
        self.assertEqual(packet[16:24], b"record\0\0")
        self.assertIn(b"/sl/2/hit", pedals.looper_packet(2, "undo"))
        with self.assertRaises(ValueError):
            pedals.looper_packet(0, "shell-command")

    def test_three_and_ten_switch_configs_match_the_schematic(self):
        three = pedals.validate_config(json.loads((ROOT / "tests/fixtures/pedals.json").read_text()), ROOT / "pedals.json")
        ten = pedals.load_config(ROOT / "pedals.ten-switches.json")
        self.assertEqual([(s['gpio'], s['id']) for s in three['switches']], [(17, '1'), (27, '2'), (22, '3')])
        self.assertEqual(len(ten['switches']), 10)
        self.assertEqual(len({s['gpio'] for s in ten['switches']}), 10)

    def test_tone_file_paths_and_gpio_pin_numbering_are_validated(self):
        config = pedals.validate_config(json.loads((ROOT / "tests/fixtures/pedals.json").read_text()), ROOT / "pedals.json")
        self.assertEqual(config['switches'][0]['actions'][0]['_file'], ROOT / 'tones/go2/clean.json')
        invalid = ROOT / '.invalid-duplicate-pins-test.json'
        original = json.loads((ROOT / 'tests/fixtures/pedals.json').read_text())
        original['switches'][1]['gpio'] = original['switches'][0]['gpio']
        invalid.write_text(json.dumps(original))
        try:
            with self.assertRaisesRegex(ValueError, 'BCM GPIO'):
                pedals.load_config(invalid)
        finally:
            invalid.unlink()


class FakeMidi:
    class Message:
        @staticmethod
        def from_bytes(data):
            return data

    def __init__(self):
        self.sent = []
        self.input_names = ['KATANA:GO MIDI OUT']
        self.output_names = ['KATANA:GO MIDI IN']

    def get_input_names(self): return list(self.input_names)
    def get_output_names(self): return list(self.output_names)

    def open_input(self, name, callback):
        self.callback = callback
        return type('Port', (), {'close': lambda self: None})()

    def open_output(self, name, autoreset=True):
        backend = self
        class Port:
            def send(self, message): backend.sent.append(message)
            def close(self): pass
        return Port()


class MidiTransportTests(unittest.TestCase):
    def test_lists_connects_sends_sysex_and_closes(self):
        backend = FakeMidi()
        events = []
        bridge = bridge_module.MidiBridge(backend, events.append)
        self.assertEqual(len(bridge.request({'op': 'list'})['inputs']), 1)
        self.assertEqual(bridge.request({'op': 'connect', 'input': backend.input_names[0], 'output': backend.output_names[0]}),
                         {'connected': True})
        message = [0xF0, 0x41, 0x10, 0x01, 0x05, 0x0D, 0x12, 0xF7]
        self.assertEqual(bridge.request({'op': 'send', 'bytes': message}), {'sent': True})
        self.assertEqual(backend.sent, [message])
        backend.callback(type('Message', (), {'bytes': lambda self: message})())
        self.assertEqual(events, [{'type': 'message', 'bytes': message}])
        self.assertEqual(bridge.request({'op': 'disconnect'}), {'closed': True})

    def test_wrong_port_and_invalid_midi_bytes_fail_closed(self):
        bridge = bridge_module.MidiBridge(FakeMidi(), lambda event: None)
        with self.assertRaisesRegex(ValueError, 'unavailable'):
            bridge.request({'op': 'connect', 'input': 'other', 'output': 'KATANA:GO MIDI IN'})
        bridge.request({'op': 'connect', 'input': 'KATANA:GO MIDI OUT', 'output': 'KATANA:GO MIDI IN'})
        with self.assertRaisesRegex(ValueError, '0..255'):
            bridge.request({'op': 'send', 'bytes': [0xF0, 256, 0xF7]})
        with self.assertRaisesRegex(ValueError, 'integer'):
            bridge.request({'op': 'send', 'bytes': [True]})
        bridge.close()


if __name__ == '__main__':
    unittest.main()
