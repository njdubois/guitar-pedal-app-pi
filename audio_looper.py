"""Stereo PCM looper using the GO's ALSA USB interface (no software monitoring)."""
from array import array
from collections import deque
from pathlib import Path
import sys
import threading
import time

import numpy as np

RATE = 48000
FRAMES = 240
MAX_TRACKS = 16
MAX_SAMPLES = RATE * 2 * 300  # Five minutes of stereo across all tracks.
OSC_LOOP_COMMANDS = {"record", "overdub", "undo", "redo", "mute", "pause", "reverse", "oneshot", "trigger"}
TRACK_COMMANDS = {"add_track", "record_new_track", "next_track", "scroll_tracks", "previous_track", "select_track", "rename_track",
                  "delete_track", "duplicate_track", "volume_up", "volume_down", "set_volume",
                  "finish_recording", "play_all", "stop_all", "clear_all"}
LOOP_COMMANDS = OSC_LOOP_COMMANDS | TRACK_COMMANDS | {"play_stop", "clear"}


class LoopBuffer:
    def __init__(self):
        self.samples = array('h')
        self.position = 0
        self.mode = 'empty'
        self.muted = False
        self.reverse = False
        self.once = False
        self.undo = None
        self.redo = None

    def command(self, command):
        if command == 'clear':
            self.__init__()
        elif command == 'record':
            if self.mode == 'recording':
                self.mode = 'playing' if self.samples else 'empty'
                self.position = 0
            else:
                self.__init__()
                self.mode = 'recording'
        elif command == 'overdub' and self.samples:
            if self.mode == 'overdubbing':
                self.mode = 'playing'
            else:
                self.undo = self.samples[:]
                self.redo = None
                self.mode = 'overdubbing'
        elif command == 'undo' and self.undo is not None:
            self.redo, self.samples, self.undo = self.samples, self.undo, None
        elif command == 'redo' and self.redo is not None:
            self.undo, self.samples, self.redo = self.samples, self.redo, None
        elif command == 'mute':
            self.muted = not self.muted
        elif command in ('pause', 'play_stop') and self.samples:
            self.mode = 'playing' if self.mode == 'paused' else 'paused'
        elif command == 'reverse':
            self.reverse = not self.reverse
        elif command in ('oneshot', 'trigger') and self.samples:
            self.position = len(self.samples) - 2 if self.reverse else 0
            self.mode = 'playing'
            self.once = command == 'oneshot'

    def process(self, data):
        incoming = array('h', data)
        if sys.byteorder != 'little':
            incoming.byteswap()
        output = array('h', [0]) * len(incoming)
        if self.mode == 'recording':
            # Bound memory to five minutes of stereo audio.
            remaining = RATE * 2 * 300 - len(self.samples)
            self.samples.extend(incoming[:remaining])
            if len(self.samples) >= RATE * 2 * 300:
                self.mode = 'playing'
        elif self.samples and self.mode == 'playing' and not self.reverse:
            # Preserve PCM exactly and copy contiguous spans in C. Normal
            # playback needs no per-sample Python work or gain conversion.
            written = 0
            while written < len(output):
                count = min(len(output) - written, len(self.samples) - self.position)
                if not self.muted:
                    output[written:written + count] = self.samples[self.position:self.position + count]
                self.position += count
                written += count
                if self.position == len(self.samples):
                    self.position = 0
                    if self.once:
                        self.once = False
                        self.mode = 'paused'
                        break
        elif self.samples and self.mode in ('playing', 'overdubbing'):
            for index in range(0, len(incoming), 2):
                for channel in (0, 1):
                    offset = self.position + channel
                    sample = self.samples[offset]
                    if self.mode == 'overdubbing':
                        self.samples[offset] = max(-32768, min(32767, sample + incoming[index + channel]))
                    if not self.muted:
                        output[index + channel] = sample
                self.position += -2 if self.reverse else 2
                if self.position < 0 or self.position >= len(self.samples):
                    self.position %= len(self.samples)
                    if self.once:
                        self.once = False
                        self.mode = 'paused'
                        break
        if sys.byteorder != 'little':
            output.byteswap()
        return output.tobytes()


class InputMeter:
    def __init__(self):
        self.level = 0.0
        self.clipping = False
        self.history = deque([0.0] * 64, maxlen=64)
        self.frames = 0
        self.peak = 0.0

    def observe(self, data):
        samples = array('h', data)
        if sys.byteorder != 'little':
            samples.byteswap()
        peak = max(abs(min(samples, default=0)), abs(max(samples, default=0))) / 32768
        self.level = max(peak, self.level * .95)
        self.clipping = peak >= .999
        self.peak = max(self.peak, peak)
        self.frames += len(samples) // 2
        if self.frames >= RATE // 20:
            self.history.append(round(self.peak, 3))
            self.frames = 0
            self.peak = 0.0


class LoopTrack:
    def __init__(self, identifier, name):
        self.id, self.name = identifier, name
        self.buffer = LoopBuffer()
        self.volume = 100
        self.origin = 0
        self.capacity = MAX_SAMPLES
        self.meter = InputMeter()


class TrackLooper:
    """Sample-clock-aligned independent tracks; only the audio thread mutates PCM."""
    def __init__(self):
        self.tracks = []
        self.selected_id = None
        self.next_id = 1
        self.clock = 0
        self.cycle = 0
        self.output_clipping = False
        self.add()

    @property
    def selected(self):
        return next(track for track in self.tracks if track.id == self.selected_id)

    def add(self):
        if len(self.tracks) >= MAX_TRACKS:
            raise ValueError(f"A session supports up to {MAX_TRACKS} tracks.")
        track = LoopTrack(self.next_id, f"Track {self.next_id}")
        self.next_id += 1
        self.tracks.append(track)
        self.selected_id = track.id
        return track

    def used(self):
        return sum(len(track.buffer.samples) for track in self.tracks)

    def reset_clock_if_empty(self):
        if not any(track.buffer.samples or track.buffer.mode == 'recording' for track in self.tracks):
            self.clock = self.cycle = 0

    def finish(self, track):
        buf = track.buffer
        if buf.mode != 'recording':
            return
        if not buf.samples:
            buf.mode = 'empty'
            return
        if not self.cycle:
            self.cycle = len(buf.samples)
        length = ((len(buf.samples) + self.cycle - 1) // self.cycle) * self.cycle
        buf.samples.extend(array('h', [0]) * (length - len(buf.samples)))
        buf.mode = 'playing'
        buf.position = (self.clock - track.origin) % len(buf.samples)

    def finish_recordings(self):
        for track in self.tracks:
            self.finish(track)
            if track.buffer.mode == 'overdubbing':
                track.buffer.mode = 'playing'

    def command(self, command, track_id=None, name=None, volume=None):
        if not isinstance(command, str) or command not in LOOP_COMMANDS:
            raise ValueError('Unsupported looper command.')
        if track_id is not None:
            if type(track_id) is not int or not any(track.id == track_id for track in self.tracks):
                raise ValueError('That track no longer exists.')
            self.selected_id = track_id
        track = self.selected
        if command == 'select_track':
            if track_id is None:
                raise ValueError('Choose a track.')
        elif command in ('next_track', 'scroll_tracks', 'previous_track'):
            index = self.tracks.index(track)
            self.selected_id = self.tracks[(index + (-1 if command == 'previous_track' else 1)) % len(self.tracks)].id
        elif command in ('add_track', 'record_new_track'):
            if len(self.tracks) >= MAX_TRACKS:
                raise ValueError(f"A session supports up to {MAX_TRACKS} tracks.")
            self.finish_recordings()
            track = self.add()
            if command == 'record_new_track':
                self.command('record')
        elif command == 'finish_recording':
            self.finish_recordings()
        elif command == 'rename_track':
            if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60:
                raise ValueError('Track names must contain 1–60 characters.')
            track.name = name.strip()
        elif command in ('volume_up', 'volume_down', 'set_volume'):
            if command == 'set_volume':
                if type(volume) is not int or not 0 <= volume <= 100:
                    raise ValueError('Track volume must be from 0 to 100.')
                track.volume = volume
            else:
                track.volume = max(0, min(100, track.volume + (10 if command == 'volume_up' else -10)))
        elif command == 'delete_track':
            index = self.tracks.index(track)
            self.tracks.remove(track)
            if not self.tracks:
                self.add()
            else:
                self.selected_id = self.tracks[min(index, len(self.tracks) - 1)].id
            self.reset_clock_if_empty()
        elif command == 'duplicate_track':
            if len(self.tracks) >= MAX_TRACKS or self.used() + len(track.buffer.samples) > MAX_SAMPLES:
                raise ValueError('Not enough track space to duplicate this track.')
            self.finish_recordings()
            if self.used() + len(track.buffer.samples) > MAX_SAMPLES:
                raise ValueError('Not enough track space to duplicate this track.')
            other = self.add()
            other.name = (track.name + ' copy')[:60]
            other.volume, other.origin = track.volume, track.origin
            other.buffer.samples = track.buffer.samples[:]
            other.buffer.position = track.buffer.position
            other.buffer.mode = 'playing' if track.buffer.mode in ('playing', 'overdubbing') else track.buffer.mode
            other.buffer.muted, other.buffer.reverse = track.buffer.muted, track.buffer.reverse
            other.meter.history = deque(track.meter.history, maxlen=64)
        elif command in ('play_all', 'stop_all'):
            self.finish_recordings()
            for item in self.tracks:
                if item.buffer.samples:
                    item.buffer.mode = 'playing' if command == 'play_all' else 'paused'
                    item.buffer.once = False
        elif command == 'clear_all':
            for item in self.tracks:
                item.buffer = LoopBuffer()
                item.meter = InputMeter()
                item.origin = 0
            self.reset_clock_if_empty()
        elif command == 'record':
            if track.buffer.mode == 'recording':
                self.finish(track)
            else:
                self.finish_recordings()
                if not any(item is not track and item.buffer.samples for item in self.tracks):
                    self.cycle = 0
                capacity = MAX_SAMPLES - self.used() + len(track.buffer.samples)
                if self.cycle:
                    capacity = capacity // self.cycle * self.cycle
                if capacity < 2:
                    raise ValueError('Track audio is full. Clear or delete a track first.')
                track.buffer.command('record')
                track.meter = InputMeter()
                track.origin, track.capacity = self.clock, capacity
        elif command == 'clear':
            track.buffer.command('clear')
            track.meter = InputMeter()
            track.origin = self.clock
            self.reset_clock_if_empty()
        else:
            if command == 'overdub' and track.buffer.mode != 'overdubbing':
                self.finish_recordings()
            if track.buffer.mode == 'recording' and command in ('pause', 'play_stop', 'overdub'):
                self.finish(track)
            track.buffer.command(command)
            if command in ('trigger', 'oneshot'):
                track.origin = self.clock
            elif command == 'reverse' and track.buffer.samples:
                phase = len(track.buffer.samples) - 2 - track.buffer.position if track.buffer.reverse else track.buffer.position
                track.origin = self.clock - phase

    def process(self, data):
        outputs = []
        advancing = any(track.buffer.mode in ('playing', 'recording', 'overdubbing') for track in self.tracks)
        for track in self.tracks:
            buf = track.buffer
            mode = buf.mode
            if mode in ('playing', 'overdubbing') and buf.samples:
                phase = (self.clock - track.origin) % len(buf.samples)
                buf.position = len(buf.samples) - 2 - phase if buf.reverse else phase
            if mode == 'recording':
                remaining = track.capacity - len(buf.samples)
                captured = data[:max(0, remaining) * 2]
                buf.process(captured)
                track.meter.observe(captured)
                if len(buf.samples) >= track.capacity or buf.mode != 'recording':
                    # LoopBuffer's own cap may finish recording at the boundary.
                    buf.mode = 'recording'
                    self.finish(track)
                continue
            output = buf.process(data)
            if mode == 'overdubbing':
                track.meter.observe(data)
            if mode in ('playing', 'overdubbing') and not buf.muted and track.volume:
                outputs.append((output, track.volume))
        if advancing:
            self.clock += len(data) // 2
        self.output_clipping = False
        if not outputs:
            return bytes(len(data))
        if len(outputs) == 1 and outputs[0][1] == 100:
            return outputs[0][0]
        # Sum in 32-bit space and saturate once; NumPy keeps mixing off the
        # Python per-sample path on the Pi. Full-volume single tracks stay exact.
        samples = np.frombuffer(b''.join(output for output, _ in outputs), dtype='<i2').reshape(len(outputs), -1)
        volumes = [volume for _, volume in outputs]
        if all(volume == 100 for volume in volumes):
            mixed = samples.sum(axis=0, dtype=np.int32)
        else:
            weighted = np.multiply(samples, np.asarray(volumes, dtype=np.int32)[:, None], dtype=np.int32)
            scaled = np.trunc(weighted / 100).astype(np.int32)
            mixed = scaled.sum(axis=0, dtype=np.int32)
        self.output_clipping = bool(np.any(mixed > 32767) or np.any(mixed < -32768))
        np.clip(mixed, -32768, 32767, out=mixed)
        return mixed.astype('<i2').tobytes()

    def pause_all(self):
        self.finish_recordings()
        for track in self.tracks:
            if track.buffer.mode in ('playing', 'overdubbing'):
                track.buffer.mode = 'paused'

    def state(self):
        return [{'id': track.id, 'name': track.name, 'selected': track.id == self.selected_id,
                 'mode': track.buffer.mode, 'seconds': round(len(track.buffer.samples) / (RATE * 2), 3),
                 'position': track.buffer.position / max(2, len(track.buffer.samples)),
                 'muted': track.buffer.muted, 'reverse': track.buffer.reverse, 'volume': track.volume,
                 'waveform': list(track.meter.history)} for track in self.tracks]


class AudioLooper:
    def __init__(self):
        self.looper = TrackLooper()
        self.meter = InputMeter()
        self.notice = ''
        self.frames = FRAMES
        self.commands = deque()
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.thread = None
        self.capture = self.playback = None
        self.error = ''
        self.device = ''
        self.active = False
        self.last_command_ms = None

    @property
    def buffer(self):
        return self.looper.selected.buffer

    def start_demo(self):
        if self.active:
            return
        self.stop.clear()
        self.error = ''
        self.active = True
        self.device = 'Demo audio'
        self.thread = threading.Thread(target=self.run_demo, name='demo-looper', daemon=True)
        self.thread.start()

    def run_demo(self):
        try:
            while not self.stop.wait(self.frames / RATE):
                with self.lock:
                    self.process(bytes(self.frames * 4))
        finally:
            self.active = False

    def edit(self, command, **options):
        if self.active:
            self.hit(command, **options)
        else:
            if command in ('record', 'record_new_track', 'overdub', 'play_all', 'trigger', 'oneshot', 'play_stop', 'pause'):
                raise ValueError('Start the looper before recording or playback.')
            with self.lock:
                self.looper.command(command, **options)
                self.notice = ''

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        from alsa_audio import PCM
        import re
        cards = Path('/proc/asound/cards').read_text()
        matches = re.findall(r'^\s*\d+\s+\[([^]]+)\].*\n\s*(.*)', cards, re.M)
        card = next((name.strip() for name, description in matches
                     if 'KATANA:GO' in description or 'KATANAGO' in name), None)
        if not card:
            raise ValueError('Connect the GO:2 USB audio interface before starting the looper.')
        self.device = f'hw:CARD={card},DEV=0'
        self.error = ''
        self.stop.clear()
        try:
            self.capture = PCM(self.device, capture=True)
            self.playback = PCM(self.device)
            # Match the hardware period instead of crossing period boundaries
            # with arbitrary 128-frame reads/writes.
            from math import gcd
            self.frames = gcd(self.capture.period_frames, self.playback.period_frames)
            self.active = True
            self.thread = threading.Thread(target=self.run, name='go2-looper', daemon=True)
            self.thread.start()
        except Exception as error:
            self.close()
            self.error = f'GO:2 audio could not start: {error}'
            raise ValueError(self.error) from error

    def hit(self, command, **options):
        if self.error:
            raise ValueError(self.error)
        if not self.active:
            raise ValueError('GO:2 looper is not running. Start pedals again.')
        # deque append/pop are atomic: a stomp never waits for DSP or undo copies.
        if not isinstance(command, str) or command not in LOOP_COMMANDS:
            raise ValueError('Unsupported looper command.')
        if len(self.commands) >= 64:
            raise ValueError('Looper command queue is full. Try again.')
        self.commands.append((command, time.monotonic(), options))

    def process(self, data):
        """Apply pedal commands immediately at the next audio block."""
        while self.commands:
            item = self.commands.popleft()
            command, requested = item[:2]
            options = item[2] if len(item) > 2 else {}
            self.last_command_ms = round((time.monotonic() - requested) * 1000, 2)
            try:
                self.looper.command(command, **options)
                self.notice = ''
            except ValueError as error:
                self.notice = str(error)
        output = self.looper.process(data)
        self.meter.observe(data)
        return output

    def run(self):
        try:
            # Prime playback before capture so both USB directions are running.
            # Start explicitly: the small audio blocks can be below ALSA's
            # automatic start threshold. Do not wait for a full pipe or buffer.
            prime_frames = min(self.frames * 3, self.playback.buffer_frames)
            self.playback.transfer(bytes(prime_frames * 4), prime_frames, self.stop)
            if not self.stop.is_set():
                self.playback.start_if_prepared()
            while not self.stop.is_set():
                data = self.capture.transfer(None, self.frames, self.stop, capture=True)
                if self.stop.is_set():
                    break
                with self.lock:
                    output = self.process(data)
                self.playback.transfer(output, len(output) // 4, self.stop)
        except Exception as error:
            if not self.stop.is_set():
                self.error = str(error)
        finally:
            self.active = False
            for pcm in (self.capture, self.playback):
                if pcm:
                    pcm.close()

    def state(self):
        with self.lock:
            return {'tracks': self.looper.state(), 'selected_track': self.looper.selected_id,
                    'cycle_seconds': self.looper.cycle / (RATE * 2), 'max_tracks': MAX_TRACKS,
                    'notice': self.notice, 'output_clipping': self.looper.output_clipping,
                    'mode': self.buffer.mode, 'seconds': round(len(self.buffer.samples) / (RATE * 2), 2),
                    'position': self.buffer.position / max(2, len(self.buffer.samples)),
                    'error': self.error, 'device': self.device, 'active': self.active,
                    'muted': self.buffer.muted, 'reverse': self.buffer.reverse,
                    'level': round(self.meter.level, 3), 'waveform': list(self.meter.history),
                    'clipping': self.meter.clipping,
                    'command_ms': self.last_command_ms,
                    'block_ms': round(self.frames / RATE * 1000, 2),
                    'buffer_ms': round(self.playback.buffer_frames / RATE * 1000, 2) if self.playback else None,
                    'xruns': sum(pcm.xruns for pcm in (self.capture, self.playback) if pcm)}

    def close(self):
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=5)
        if self.thread and self.thread.is_alive():
            raise RuntimeError('Audio thread did not stop; restart the app.')
        for pcm in (self.capture, self.playback):
            if pcm:
                pcm.close()
        self.capture = self.playback = None
        self.active = False
        with self.lock:
            self.commands.clear()
            self.looper.pause_all()
