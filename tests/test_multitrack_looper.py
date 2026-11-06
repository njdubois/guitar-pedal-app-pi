from array import array
import time
import unittest
from unittest.mock import Mock, patch

from audio_looper import AudioLooper, TrackLooper, MAX_TRACKS
from pedal_controller import dispatch, validate_config, looper_packet


def pcm(*values):
    return array('h', values).tobytes()


def record(loop, data):
    loop.command('record')
    loop.process(data)
    loop.command('record')


class MultiTrackTests(unittest.TestCase):
    def test_record_new_track_mixes_without_overwriting_first(self):
        loop = TrackLooper()
        source = pcm(10, 11, 20, 21, 30, 31, 40, 41)
        record(loop, source)
        first = loop.selected
        loop.process(pcm(0, 0))  # advance one frame into the first loop
        loop.command('record_new_track')
        self.assertEqual(loop.process(pcm(100, 101, 200, 201)), pcm(20, 21, 30, 31))
        loop.command('finish_recording')
        self.assertIsNotNone(loop.selected.finish_at)
        self.assertEqual(loop.process(pcm(300, 301, 400, 401)), pcm(40, 41, 10, 11))
        self.assertEqual(len(loop.selected.buffer.samples), len(first.buffer.samples))
        self.assertEqual(loop.process(pcm(0, 0, 0, 0)), pcm(120, 122, 230, 232))
        self.assertEqual(first.buffer.samples.tobytes(), source)
        self.assertIsNot(first.buffer.samples, loop.selected.buffer.samples)

    def test_new_track_can_span_multiple_master_cycles(self):
        loop = TrackLooper()
        record(loop, pcm(1, 2, 3, 4))
        loop.command('record_new_track')
        loop.process(pcm(10, 20, 30, 40, 50, 60))
        loop.command('record')
        self.assertEqual(loop.selected.buffer.mode, 'recording')
        self.assertEqual(loop.process(pcm(70, 80)), pcm(3, 4))
        self.assertEqual(loop.selected.buffer.samples.tolist(), [10, 20, 30, 40, 50, 60, 70, 80])
        self.assertEqual(loop.process(pcm(0, 0)), pcm(11, 22))

    def test_navigation_wraps_and_crud_affects_selected_track_only(self):
        loop = TrackLooper()
        record(loop, pcm(10, 20))
        first = loop.selected
        loop.command('add_track')
        second = loop.selected
        loop.command('rename_track', name='Chorus')
        loop.command('record')
        loop.process(pcm(100, 200))
        loop.command('record')
        loop.command('previous_track')
        self.assertEqual(loop.selected.id, first.id)
        loop.command('previous_track')
        self.assertEqual(loop.selected.name, 'Chorus')
        loop.command('clear')
        self.assertFalse(second.buffer.samples)
        self.assertEqual(first.buffer.samples.tolist(), [10, 20])
        loop.command('delete_track')
        self.assertEqual(loop.selected.id, first.id)
        loop.command('delete_track')
        self.assertEqual(len(loop.tracks), 1)
        self.assertEqual(loop.selected.buffer.mode, 'empty')
        self.assertGreater(loop.selected.id, second.id)
        with self.assertRaises(ValueError):
            loop.command('select_track', track_id=second.id)

    def test_duplicate_volume_mute_and_play_all_stop_all(self):
        loop = TrackLooper()
        record(loop, pcm(1000, -1000))
        loop.command('duplicate_track')
        self.assertEqual(loop.process(pcm(0, 0)), pcm(2000, -2000))
        loop.command('set_volume', volume=50)
        self.assertEqual(loop.process(pcm(0, 0)), pcm(1500, -1500))
        loop.command('mute')
        self.assertEqual(loop.process(pcm(0, 0)), pcm(1000, -1000))
        loop.command('stop_all')
        self.assertEqual(loop.process(pcm(0, 0)), pcm(0, 0))
        loop.command('play_all')
        self.assertEqual(loop.process(pcm(0, 0)), pcm(1000, -1000))
        self.assertIsNot(loop.tracks[0].buffer.samples, loop.tracks[1].buffer.samples)

    def test_mixing_clips_once_after_summing_all_tracks(self):
        loop = TrackLooper()
        record(loop, pcm(30000, -30000))
        loop.command('duplicate_track')
        self.assertEqual(loop.process(pcm(0, 0)), pcm(32767, -32768))
        self.assertTrue(loop.output_clipping)
        loop.command('add_track')
        record(loop, pcm(-30000, 30000))
        self.assertEqual(loop.process(pcm(0, 0)), pcm(30000, -30000))
        self.assertFalse(loop.output_clipping)

    def test_paused_track_rejoins_the_shared_playback_phase(self):
        loop = TrackLooper()
        record(loop, pcm(1, 1, 2, 2, 3, 3))
        loop.command('duplicate_track')
        loop.command('pause')
        self.assertEqual(loop.process(pcm(0, 0, 0, 0)), pcm(1, 1, 2, 2))
        loop.command('pause')
        self.assertEqual(loop.process(pcm(0, 0)), pcm(6, 6))

    def test_undo_is_per_track_and_delete_during_recording_is_safe(self):
        loop = TrackLooper()
        record(loop, pcm(100, 200))
        loop.command('duplicate_track')
        loop.command('overdub')
        loop.process(pcm(10, 20))
        loop.command('overdub')
        self.assertEqual(loop.process(pcm(0, 0)), pcm(210, 420))
        loop.command('undo')
        self.assertEqual(loop.process(pcm(0, 0)), pcm(200, 400))
        loop.command('record_new_track')
        loop.process(pcm(5, 6))
        loop.command('delete_track')
        self.assertEqual(len(loop.tracks), 2)
        self.assertEqual(loop.process(pcm(0, 0)), pcm(200, 400))

    def test_limits_do_not_stop_other_tracks_or_exceed_audio_budget(self):
        loop = TrackLooper()
        record(loop, pcm(10, 20))
        with patch('audio_looper.MAX_SAMPLES', 6):
            loop.command('record_new_track')
            loop.process(pcm(30, 40, 50, 60, 70, 80))
            self.assertLessEqual(loop.used(), 6)
            self.assertEqual(loop.selected.buffer.mode, 'playing')
            with self.assertRaises(ValueError):
                loop.command('duplicate_track')
        engine = AudioLooper()
        for _ in range(MAX_TRACKS - 1):
            engine.looper.add()
        engine.commands.append(('add_track', time.monotonic()))
        self.assertEqual(engine.process(pcm(0, 0)), pcm(0, 0))
        self.assertIn('up to', engine.notice)
        self.assertFalse(engine.error)

    def test_stop_retains_all_tracks_and_offline_metadata_remains_editable(self):
        engine = AudioLooper()
        record(engine.looper, pcm(4, 5))
        engine.looper.command('duplicate_track')
        engine.close()
        self.assertEqual([track['mode'] for track in engine.state()['tracks']], ['paused', 'paused'])
        engine.edit('rename_track', name='Keep me')
        self.assertEqual(engine.state()['tracks'][1]['name'], 'Keep me')
        with self.assertRaises(ValueError):
            engine.edit('record_new_track')

    def test_rename_and_track_commands_validate_and_dispatch(self):
        def config(command, **extra):
            return validate_config({'version': 1, 'amp': {'profile': 'go2'}, 'switches': [
                {'id': '1', 'gpio': 17, 'actions': [{'type': 'looper', 'command': command, **extra}]}]}, '/tmp/pedals.json')
        for command in ['add_track', 'record_new_track', 'next_track', 'previous_track', 'duplicate_track', 'delete_track', 'volume_up', 'play_all', 'stop_all']:
            parsed = config(command)
            engine = Mock()
            dispatch(parsed['switches'][0], parsed, Mock(), False, audio_looper=engine)
            engine.hit.assert_called_once_with(command)
            with self.assertRaises(ValueError):
                looper_packet(0, command)
        parsed = config('rename_track', name='Verse')
        engine = Mock()
        dispatch(parsed['switches'][0], parsed, Mock(), False, audio_looper=engine)
        engine.hit.assert_called_once_with('rename_track', name='Verse')
        with self.assertRaises(ValueError):
            config('rename_track')

    def test_record_new_track_finishes_overdub_instead_of_recording_both(self):
        loop = TrackLooper()
        record(loop, pcm(10, 20))
        first = loop.selected
        loop.command('overdub')
        loop.command('record_new_track')
        self.assertEqual(first.buffer.mode, 'playing')
        loop.process(pcm(100, 200))
        self.assertEqual(first.buffer.samples.tolist(), [10, 20])
        self.assertEqual(loop.selected.buffer.samples.tolist(), [100, 200])

    def test_ui_api_targets_tracks_and_reports_state_without_audio_hardware(self):
        import tempfile
        import shutil
        from pathlib import Path
        from pedal_ui import PedalApp, ROOT
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copytree(ROOT / 'tones', root / 'tones')
            shutil.copyfile(ROOT / 'pedals.json', root / 'pedals.json')
            app = PedalApp(root / 'pedals.json', demo=True)
            try:
                app.config['amp']['profile'] = 'mkii'
                app.config['looper']['engine'] = 'builtin'
                result = app.looper_action({'command': 'add_track'})
                self.assertEqual(len(result['looper']['tracks']), 2)
                result = app.looper_action({'command': 'rename_track', 'track_id': 1, 'name': 'Verse'})
                self.assertEqual(result['looper']['tracks'][0]['name'], 'Verse')
                self.assertEqual(result['looper']['selected_track'], 1)
                app.looper_action({'command': 'delete_track', 'track_id': 2})
                self.assertEqual(len(app.audio_looper.state()['tracks']), 1)
            finally:
                app.close()

    def test_single_track_rerecord_can_establish_a_new_cycle(self):
        loop = TrackLooper()
        record(loop, pcm(1, 2, 3, 4))
        record(loop, pcm(5, 6))
        self.assertEqual(loop.cycle, 2)
        self.assertEqual(loop.selected.buffer.samples.tolist(), [5, 6])


class RecordingBoundaryTests(unittest.TestCase):
    def base(self):
        loop = TrackLooper()
        record(loop, pcm(*([1, 2] * 8)))
        loop.process(pcm(0, 0, 0, 0, 0, 0))  # start at a different phase
        loop.command('record_new_track')
        return loop

    def test_early_finish_captures_to_boundary_then_plays_remainder_of_block(self):
        loop = self.base()
        loop.process(pcm(*([100, 200] * 6)))
        loop.command('finish_recording')
        self.assertEqual(loop.selected.buffer.mode, 'recording')
        output = loop.process(pcm(*([300, 400] * 4)))
        self.assertEqual(output, pcm(1, 2, 1, 2, 101, 202, 101, 202))
        self.assertEqual(loop.selected.buffer.samples.tolist(), [100, 200] * 6 + [300, 400] * 2)
        self.assertEqual(loop.selected.buffer.mode, 'playing')
        self.assertIsNone(loop.selected.finish_at)
        self.assertEqual(loop.process(pcm(*([0, 0] * 8))),
                         pcm(*([101, 202] * 4 + [301, 402] * 2 + [101, 202] * 2)))

    def test_late_finish_trims_overrun_instead_of_adding_a_silent_cycle(self):
        loop = self.base()
        loop.process(pcm(*([100, 200] * 9)))
        loop.command('record')
        self.assertEqual(loop.selected.buffer.samples.tolist(), [100, 200] * 8)
        self.assertEqual(loop.process(pcm(*([0, 0] * 24))), pcm(*([101, 202] * 24)))

    def test_new_track_handoff_waits_for_audio_boundary(self):
        loop = self.base()
        previous = loop.selected
        loop.process(pcm(*([100, 200] * 6)))
        loop.command('record_new_track')
        self.assertEqual(len(loop.tracks), 2)
        loop.process(pcm(*([300, 400] * 4)))
        self.assertEqual(len(loop.tracks), 3)
        self.assertEqual(previous.buffer.samples.tolist(), [100, 200] * 6 + [300, 400] * 2)
        self.assertEqual(previous.buffer.mode, 'playing')
        self.assertEqual(loop.selected.buffer.samples.tolist(), [300, 400] * 2)
        self.assertEqual(loop.selected.buffer.mode, 'recording')

    def test_stop_all_cancels_pending_handoff(self):
        loop = self.base()
        loop.process(pcm(100, 200))
        loop.command('record_new_track')
        loop.command('stop_all')
        loop.process(pcm(*([0, 0] * 16)))
        self.assertEqual(len(loop.tracks), 2)
        self.assertTrue(all(track.buffer.mode == 'paused' for track in loop.tracks))
