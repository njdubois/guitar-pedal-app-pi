"""Small typed ALSA PCM binding; direct nonblocking I/O, no pipe buffering."""
from array import array
import ctypes as C
import ctypes.util
import errno
import time


class PCM:
    def __init__(self, device, capture=False, latency_us=40000, channels=2):
        self.channels = channels
        self.lib = C.CDLL(ctypes.util.find_library('asound') or 'libasound.so.2')
        signatures = {
            'snd_pcm_open': ([C.POINTER(C.c_void_p), C.c_char_p, C.c_int, C.c_int], C.c_int),
            'snd_pcm_set_params': ([C.c_void_p, C.c_int, C.c_int, C.c_uint, C.c_uint, C.c_int, C.c_uint], C.c_int),
            'snd_pcm_get_params': ([C.c_void_p, C.POINTER(C.c_ulong), C.POINTER(C.c_ulong)], C.c_int),
            'snd_pcm_readi': ([C.c_void_p, C.c_void_p, C.c_ulong], C.c_long),
            'snd_pcm_writei': ([C.c_void_p, C.c_void_p, C.c_ulong], C.c_long),
            'snd_pcm_start': ([C.c_void_p], C.c_int),
            'snd_pcm_state': ([C.c_void_p], C.c_int),
            'snd_pcm_recover': ([C.c_void_p, C.c_int, C.c_int], C.c_int),
            'snd_pcm_drop': ([C.c_void_p], C.c_int),
            'snd_pcm_close': ([C.c_void_p], C.c_int),
            'snd_strerror': ([C.c_int], C.c_char_p),
        }
        for name, (args, result) in signatures.items():
            function = getattr(self.lib, name)
            function.argtypes, function.restype = args, result
        self.handle = C.c_void_p()
        self.xruns = 0
        self.check(self.lib.snd_pcm_open(C.byref(self.handle), device.encode(), int(capture), 1))
        try:
            # S16_LE=2, RW_INTERLEAVED=3; plug devices may resample to 48 kHz.
            self.check(self.lib.snd_pcm_set_params(self.handle, 2, 3, channels, 48000, int(device.startswith("plughw:")), latency_us))
            size, period = C.c_ulong(), C.c_ulong()
            self.check(self.lib.snd_pcm_get_params(self.handle, C.byref(size), C.byref(period)))
            self.buffer_frames, self.period_frames = size.value, period.value
        except Exception:
            self.close()
            raise

    def check(self, result):
        if result < 0:
            raise OSError(self.lib.snd_strerror(result).decode())
        return result

    def start_if_prepared(self):
        # Small nonblocking reads do not necessarily meet ALSA's automatic
        # capture start threshold. Explicitly arm capture (also after recovery).
        if self.lib.snd_pcm_state(self.handle) == 2:  # SND_PCM_STATE_PREPARED
            self.check(self.lib.snd_pcm_start(self.handle))

    def transfer(self, data, frames, stop, capture=False):
        channels = getattr(self, 'channels', 2)
        frame_bytes = channels * 2
        if not capture and channels == 4:
            # Primary USB pair only; keep the secondary reamp pair silent.
            stereo = array('h', data)
            expanded = array('h', [0]) * (frames * 4)
            expanded[0::4], expanded[1::4] = stereo[0::2], stereo[1::2]
            data = expanded.tobytes()
        memory = C.create_string_buffer(frames * frame_bytes) if capture else C.create_string_buffer(data)
        function = self.lib.snd_pcm_readi if capture else self.lib.snd_pcm_writei
        if capture and not stop.is_set():
            self.start_if_prepared()
        offset = 0
        deadline = time.monotonic() + 2
        while offset < frames and not stop.is_set():
            result = function(self.handle, C.byref(memory, offset * frame_bytes), frames - offset)
            if result == -errno.EAGAIN or result == 0:
                if time.monotonic() > deadline:
                    direction = 'capture' if capture else 'playback'
                    state = self.lib.snd_pcm_state(self.handle)
                    raise OSError(f'USB audio {direction} stalled (ALSA state {state}). Stop and restart pedals.')
                stop.wait(.0005)
            elif result < 0:
                self.check(self.lib.snd_pcm_recover(self.handle, result, 1))
                self.xruns += 1
                if capture:
                    self.start_if_prepared()
                if time.monotonic() > deadline:
                    raise OSError('USB audio audio could not recover. Restart pedals.')
            else:
                offset += result
                deadline = time.monotonic() + 2
        if not capture:
            return None
        data = memory.raw[:offset * frame_bytes]
        if channels == 4:
            # Ignore secondary dry guitar channels rather than ALSA downmixing.
            incoming = array('h', data)
            stereo = array('h', [0]) * (offset * 2)
            stereo[0::2], stereo[1::2] = incoming[0::4], incoming[1::4]
            return stereo.tobytes()
        return data

    def close(self):
        if self.handle:
            self.lib.snd_pcm_drop(self.handle)
            self.lib.snd_pcm_close(self.handle)
            self.handle = C.c_void_p()
