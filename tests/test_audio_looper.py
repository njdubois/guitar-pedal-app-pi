from array import array
import unittest
from unittest.mock import Mock

from audio_looper import LoopBuffer
from pedal_controller import dispatch, validate_config


def pcm(*samples):
    return array('h', samples).tobytes()


class AudioLooperTests(unittest.TestCase):
    def test_record_play_pause_clear(self):
        loop = LoopBuffer()
        loop.command('record')
        self.assertEqual(loop.process(pcm(100, 200, 300, 400)), pcm(0, 0, 0, 0))
        loop.command('record')
        self.assertEqual(loop.process(pcm(9, 9, 9, 9)), pcm(100, 200, 300, 400))
        loop.command('play_stop')
        self.assertEqual(loop.process(pcm(9, 9)), pcm(0, 0))
        loop.command('play_stop')
        self.assertEqual(loop.process(pcm(9, 9)), pcm(100, 200))
        loop.command('clear')
        self.assertEqual(loop.mode, 'empty')
        self.assertEqual(len(loop.samples), 0)

    def test_overdub_undo_redo_and_clipping(self):
        loop = LoopBuffer()
        loop.command('record')
        loop.process(pcm(32000, -32000))
        loop.command('record')
        loop.command('overdub')
        loop.process(pcm(2000, -2000))
        loop.command('overdub')
        self.assertEqual(loop.process(pcm(0, 0)), pcm(32767, -32768))
        loop.command('undo')
        self.assertEqual(loop.process(pcm(0, 0)), pcm(32000, -32000))
        loop.command('redo')
        self.assertEqual(loop.process(pcm(0, 0)), pcm(32767, -32768))

    def test_reverse_preserves_stereo_and_oneshot_stops(self):
        loop = LoopBuffer()
        loop.command('record')
        loop.process(pcm(1, 2, 3, 4))
        loop.command('record')
        loop.command('reverse')
        loop.command('oneshot')
        self.assertEqual(loop.process(pcm(0, 0, 0, 0, 0, 0)), pcm(3, 4, 1, 2, 0, 0))
        self.assertEqual(loop.mode, 'paused')

    def test_builtin_dispatch_and_dry_run(self):
        switch = {'id': '1', 'gpio': 17, 'actions': [{'type': 'looper', 'command': 'clear'}]}
        config = validate_config({'version': 1, 'amp': {'profile': 'go2'}, 'switches': [switch]}, '/tmp/pedals.json')
        engine = Mock()
        dispatch(switch, config, Mock(), True, audio_looper=engine)
        engine.hit.assert_not_called()
        dispatch(switch, config, Mock(), False, audio_looper=engine)
        engine.hit.assert_called_once_with('clear')

class TimingTests(unittest.TestCase):
    def test_first_edge_immediate_bounce_suppressed_both_directions(self):
        from pedal_controller import DebouncedLatch
        latch = DebouncedLatch(False, 0, immediate=True)
        self.assertTrue(latch.update(True, .001))
        self.assertFalse(latch.update(False, .003))
        self.assertFalse(latch.update(True, .005))
        self.assertFalse(latch.update(True, .036))
        self.assertTrue(latch.update(False, .1))
        self.assertFalse(latch.update(True, .102))
        self.assertFalse(latch.update(False, .104))
        self.assertFalse(latch.update(False, .14))
        self.assertTrue(latch.update(True, .2))


    def test_partial_native_io_and_underrun_recovery(self):
        import ctypes as C
        import errno
        import threading
        from alsa_audio import PCM
        pcm_device = PCM.__new__(PCM)
        pcm_device.handle = C.c_void_p(1)
        pcm_device.xruns = 0
        pcm_device.lib = Mock()
        pcm_device.lib.snd_pcm_writei.side_effect = [-errno.EAGAIN, 1, -errno.EPIPE, 1]
        pcm_device.lib.snd_pcm_recover.return_value = 0
        pcm_device.transfer(pcm(1, 2, 3, 4), 2, threading.Event())
        self.assertEqual(pcm_device.xruns, 1)
        self.assertEqual(pcm_device.lib.snd_pcm_writei.call_count, 4)
        pcm_device.lib.snd_pcm_recover.assert_called_once_with(pcm_device.handle, -errno.EPIPE, 1)


    def test_capture_explicitly_starts_below_auto_threshold_and_after_recovery(self):
        import ctypes as C
        import errno
        import threading
        from alsa_audio import PCM
        pcm_device = PCM.__new__(PCM)
        pcm_device.handle = C.c_void_p(1)
        pcm_device.xruns = 0
        pcm_device.lib = Mock()
        state = [2]  # Prepared: a small read alone cannot start capture.
        pcm_device.lib.snd_pcm_state.side_effect = lambda _: state[0]
        def start(_):
            state[0] = 3
            return 0
        pcm_device.lib.snd_pcm_start.side_effect = start
        attempts = [0]
        def read(_, memory, frames):
            if state[0] == 2:
                return 0
            attempts[0] += 1
            if attempts[0] == 1:
                return -errno.EPIPE
            C.memmove(memory, pcm(1, 2, 3, 4), 8)
            return 2
        pcm_device.lib.snd_pcm_readi.side_effect = read
        def recover(*_):
            state[0] = 2
            return 0
        pcm_device.lib.snd_pcm_recover.side_effect = recover
        self.assertEqual(pcm_device.transfer(None, 2, threading.Event(), capture=True), pcm(1, 2, 3, 4))
        self.assertEqual(pcm_device.lib.snd_pcm_start.call_count, 2)
        self.assertEqual(pcm_device.xruns, 1)

    def test_duplex_primed_before_capture_and_devices_released(self):
        from audio_looper import AudioLooper, FRAMES
        engine = AudioLooper()
        calls = Mock()
        engine.playback = calls.playback
        engine.capture = calls.capture
        engine.playback.buffer_frames = FRAMES * 4
        def read(*args, **kwargs):
            engine.stop.set()
            return bytes(FRAMES * 4)
        engine.capture.transfer.side_effect = read
        engine.run()
        self.assertEqual([c[0] for c in calls.mock_calls], [
            'playback.transfer', 'playback.start_if_prepared', 'capture.transfer',
            'capture.close', 'playback.close'])
        engine.playback.transfer.assert_called_once_with(bytes(FRAMES * 12), FRAMES * 3, engine.stop)
        self.assertFalse(engine.active)

    def test_stall_diagnostic_identifies_direction_and_alsa_state(self):
        import ctypes as C
        import errno
        import threading
        from unittest.mock import patch
        from alsa_audio import PCM
        pcm_device = PCM.__new__(PCM)
        pcm_device.handle = C.c_void_p(1)
        pcm_device.lib = Mock()
        pcm_device.lib.snd_pcm_state.return_value = 3
        pcm_device.lib.snd_pcm_readi.return_value = -errno.EAGAIN
        with patch('alsa_audio.time.monotonic', side_effect=[0, 3]):
            with self.assertRaisesRegex(OSError, 'capture stalled.*ALSA state 3'):
                pcm_device.transfer(None, 2, threading.Event(), capture=True)

    def test_normal_playback_preserves_full_scale_pcm_across_blocks_and_wraps(self):
        import random
        randomizer = random.Random(9)
        source = array('h', [randomizer.randint(-32768, 32767) for _ in range(962)])
        source[0:4] = array('h', [-32768, 32767, 32767, -32768])
        loop = LoopBuffer()
        loop.command('record')
        for start in range(0, len(source), 160):
            loop.process(source[start:start + 160].tobytes())
        loop.command('record')
        output = bytearray()
        total = 0
        for frames in (240, 37, 480, 101, 240):
            output.extend(loop.process(pcm(0, 0) * frames))
            total += frames * 2
        expected = (source * (total // len(source) + 1))[:total].tobytes()
        self.assertEqual(bytes(output), expected)

    def test_partial_pcm_writes_keep_stereo_byte_alignment(self):
        import ctypes as C
        import threading
        from alsa_audio import PCM
        pcm_device = PCM.__new__(PCM)
        pcm_device.handle = C.c_void_p(1)
        pcm_device.lib = Mock()
        written = bytearray()
        def write(_, memory, frames):
            count = min(frames, 2)
            written.extend(C.string_at(memory, count * 4))
            return count
        pcm_device.lib.snd_pcm_writei.side_effect = write
        source = pcm(-32768, 32767, 1, -1, 12345, -12345, 0, 250)
        pcm_device.transfer(source, len(source) // 4, threading.Event())
        self.assertEqual(bytes(written), source)

    def test_looper_applies_transport_without_tempo_queue(self):
        from audio_looper import AudioLooper
        import time
        engine = AudioLooper()
        engine.commands.append(('record', time.monotonic()))
        engine.process(pcm(100, 200, 300, 400))
        engine.commands.append(('record', time.monotonic()))
        self.assertEqual(engine.process(pcm(0, 0, 0, 0)), pcm(100, 200, 300, 400))
        engine.commands.append(('play_stop', time.monotonic()))
        self.assertEqual(engine.process(pcm(0, 0)), pcm(0, 0))
        engine.commands.append(('clear', time.monotonic()))
        engine.process(pcm(0, 0))
        self.assertEqual(engine.buffer.mode, 'empty')
        self.assertNotIn('bpm', engine.state())
