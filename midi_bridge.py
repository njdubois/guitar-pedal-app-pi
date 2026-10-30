"""Mido USB MIDI transport for katana_tones.mjs; newline-delimited JSON IPC.

No GPIO or amplifier parameter addresses live here. Each process owns one
input/output pair. Sysex reception remains enabled by Mido's RtMidi backend.
"""
import json
import sys
import threading


class MidiBridge:
    def __init__(self, backend, emit):
        self.backend = backend
        self.emit = emit
        self.input = None
        self.output = None

    def ports(self):
        return {direction: [{"id": name, "name": name} for name in getter()]
                for direction, getter in (("inputs", self.backend.get_input_names),
                                          ("outputs", self.backend.get_output_names))}

    def received(self, message):
        self.emit({"type": "message", "bytes": list(message.bytes())})

    def request(self, record):
        op = record.get("op")
        if op == "list":
            return self.ports()
        if op == "connect":
            if self.input or self.output:
                raise ValueError("A MIDI session is already open")
            ports = self.ports()
            for direction in ("input", "output"):
                if record.get(direction) not in [p["name"] for p in ports[direction + "s"]]:
                    raise ValueError(f"Selected MIDI {direction} is unavailable")
            try:
                self.input = self.backend.open_input(record["input"], callback=self.received)
                self.output = self.backend.open_output(record["output"], autoreset=False)
            except Exception:
                self.close()
                raise
            return {"connected": True}
        if op == "send":
            if self.output is None:
                raise ValueError("No MIDI output is open")
            data = record.get("bytes")
            if (not isinstance(data, list) or not data or
                    any(type(b) is not int or b < 0 or b > 255 for b in data)):
                raise ValueError("MIDI bytes must be integers in 0..255")
            self.output.send(self.backend.Message.from_bytes(data))
            return {"sent": True}
        if op == "disconnect":
            self.close()
            return {"closed": True}
        raise ValueError(f"Unknown MIDI operation: {op}")

    def close(self):
        for name in ("output", "input"):
            port = getattr(self, name)
            setattr(self, name, None)
            if port is not None:
                port.close()


def main():
    lock = threading.Lock()

    def emit(event):
        with lock:
            print(json.dumps(event), flush=True)

    try:
        import mido
        # Explicit backend keeps installations using an unrelated default from
        # silently choosing a different MIDI implementation.
        mido.set_backend("mido.backends.rtmidi")
        bridge = MidiBridge(mido, emit)
        emit({"type": "ready"})
        try:
            for line in sys.stdin:
                record = {}
                try:
                    record = json.loads(line)
                    if not isinstance(record, dict):
                        raise ValueError("MIDI request must be an object")
                    result = bridge.request(record)
                    emit({"type": "result", "id": record.get("id"), "data": result})
                except Exception as error:
                    emit({"type": "error", "id": record.get("id") if isinstance(record, dict) else None,
                          "message": str(error)})
        finally:
            bridge.close()
    except Exception as error:
        emit({"type": "error", "message": f"USB MIDI unavailable: {error}. Install requirements.txt with the Python used by the controller."})
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
