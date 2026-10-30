import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import setup_ui


class StartupFilesTests(unittest.TestCase):
    def test_missing_config_and_directories_created_and_existing_setup_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(setup_ui, 'ROOT', root):
                setup_ui.ensure_config([])
                config = root / 'pedals.json'
                original = config.read_bytes()
                self.assertEqual(json.loads(original)['amp']['profile'], 'go2')
                self.assertTrue((root / 'tones/user').is_dir())
                self.assertTrue((root / '.state').is_dir())
                setup_ui.ensure_config([])
                self.assertEqual(config.read_bytes(), original)

    def test_custom_config_created_and_invalid_existing_config_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'custom/setup.json'
            setup_ui.ensure_config(['--config', str(config)])
            self.assertTrue(config.is_file())
            config.write_text('{broken')
            with self.assertRaises(ValueError):
                setup_ui.ensure_config(['--config=' + str(config)])
            self.assertEqual(config.read_text(), '{broken')


class UICompatibilityTests(unittest.TestCase):
    def test_ui_initializes_and_dry_run_worker_reports_status(self):
        from pedal_ui import PedalApp
        from pedal_controller import ToneWorker
        app = PedalApp(setup_ui.ROOT / 'pedals.json', demo=True)
        events = []
        worker = ToneWorker(app.config, True, status=lambda *args: events.append(args))
        try:
            worker.submit(Path('test.json'))
            self.assertEqual(events[0][0], 'test')
            self.assertTrue(app.state()['demo'])
        finally:
            worker.close()
            app.close()

    def test_position_actions_are_validated_and_dispatched(self):
        from pedal_controller import validate_config, dispatch
        from unittest.mock import Mock
        document = json.loads((setup_ui.ROOT / 'tests/fixtures/pedals.json').read_text())
        switch = document['switches'][0]
        switch['position_actions'] = {'open': switch['actions'], 'closed': document['switches'][1]['actions']}
        config = validate_config(document, setup_ui.ROOT / 'pedals.json')
        worker = Mock()
        dispatch(config['switches'][0], config, worker, True, position=True)
        worker.submit.assert_called_once_with(setup_ui.ROOT / 'tones/go2/drive.json')
