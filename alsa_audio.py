"""Small typed ALSA PCM binding; direct nonblocking I/O, no pipe buffering."""
import ctypes as C
import ctypes.util
import errno
import time


class PCM:
    def __init__(self, device, capture=False, latency_us=20000):
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
            # S16_LE=2, RW_INTERLEAVED=3; use the native 48 kHz stereo format.
            self.check(self.lib.snd_pcm_set_params(self.handle, 2, 3, 2, 48000, 0, latency_us))
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
        memory = C.create_string_buffer(frames * 4) if capture else C.create_string_buffer(data)
        function = self.lib.snd_pcm_readi if capture else self.lib.snd_pcm_writei
        if capture and not stop.is_set():
            self.start_if_prepared()
        offset = 0
        deadline = time.monotonic() + 2
        while offset < frames and not stop.is_set():
            result = function(self.handle, C.byref(memory, offset * 4), frames - offset)
            if result == -errno.EAGAIN or result == 0:
                if time.monotonic() > deadline:
                    direction = 'capture' if capture else 'playback'
                    state = self.lib.snd_pcm_state(self.handle)
                    raise OSError(f'GO:2 {direction} stalled (ALSA state {state}). Stop and restart pedals.')
                stop.wait(.0005)
            elif result < 0:
                self.check(self.lib.snd_pcm_recover(self.handle, result, 1))
                self.xruns += 1
                if capture:
                    self.start_if_prepared()
                if time.monotonic() > deadline:
                    raise OSError('GO:2 audio could not recover. Restart pedals.')
            else:
                offset += result
                deadline = time.monotonic() + 2
        return memory.raw[:offset * 4] if capture else None

    def close(self):
        if self.handle:
            self.lib.snd_pcm_drop(self.handle)
            self.lib.snd_pcm_close(self.handle)
            self.handle = C.c_void_p()
