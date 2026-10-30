#!/usr/bin/env python3
"""Local mouse/keyboard interface for the existing Pi pedal controller.

Run: python pedal_ui.py
Preview without a Pi or amp: python pedal_ui.py --demo
No extra Python or browser packages are required.
"""
import argparse
import copy
from datetime import datetime
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import parse_qs, urlparse
import uuid
import webbrowser

from pedal_controller import (
    ROOT, DebouncedLatch, ToneWorker, action_groups, dispatch,
    load_config, tone_command, validate_config, validate_tones, has_looper, uses_builtin_looper,
)

WATCH_PINS = [17, 27, 22, 5, 6, 13, 19, 26, 23, 24]
HEADER_PINS = {4: 7, 5: 29, 6: 31, 7: 26, 8: 24, 9: 21, 10: 19,
               11: 23, 12: 32, 13: 33, 14: 8, 15: 10, 16: 36, 17: 11,
               18: 12, 19: 35, 20: 38, 21: 40, 22: 15, 23: 16, 24: 18,
               25: 22, 26: 37, 27: 13}
MAX_BODY = 2 * 1024 * 1024


class UIError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def public(value):
    """Remove the controller's resolved internal fields before serialization."""
    if isinstance(value, dict):
        return {k: public(v) for k, v in value.items() if not k.startswith("_")}
    if isinstance(value, list):
        return [public(v) for v in value]
    return str(value) if isinstance(value, Path) else value


def fingerprint(value):
    return hashlib.sha256(json.dumps(public(value), sort_keys=True).encode()).hexdigest()


def atomic_write(path, document):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            stream.write(json.dumps(document, indent=2) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


class GPIOMonitor:
    """One owner of the input pins, shared by learning and normal operation."""
    def __init__(self, app):
        self.app = app
        self.stop_event = threading.Event()
        self.thread = None

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self.run, name="pedal-inputs", daemon=True)
        self.thread.start()

    def run(self):
        buttons = []
        try:
            os.environ.setdefault("GPIOZERO_PIN_FACTORY", "lgpio")
            from gpiozero import Button
            for pin in self.app.watch_pins:
                buttons.append((pin, Button(pin, pull_up=True, bounce_time=None)))
            if self.stop_event.wait(.15):
                return
            now = time.monotonic()
            latches = {pin: DebouncedLatch(button.is_pressed, now) for pin, button in buttons}
            with self.app.lock:
                self.app.levels = {pin: latch.stable for pin, latch in latches.items()}
                self.app.gpio_status = "ready"
                self.app.gpio_error = ""
            self.app.log("info", "Pedal inputs are ready.")
            while not self.stop_event.wait(.001):
                now = time.monotonic()
                for pin, button in buttons:
                    latch = latches[pin]
                    with self.app.lock:
                        latch.seconds = self.app.config.get("debounce_ms", 30) / 1000
                        latch.immediate = not self.app.learning and any(
                            s["gpio"] == pin and any(a["type"] == "looper" for group in action_groups(s) for a in group)
                            for s in self.app.config["switches"])
                    if latch.update(button.is_pressed, now):
                        self.app.edge(pin, latch.stable)
        except Exception as error:
            with self.app.lock:
                self.app.gpio_status = "error"
                self.app.gpio_error = (
                    f"{error}. Stop any other pedal_controller.py process, "
                    "then click Retry inputs. Launch this app with the same Python environment."
                )
            self.app.log("error", self.app.gpio_error)
        finally:
            for _, button in buttons:
                button.close()

    def close(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=3)


class PedalApp:
    def __init__(self, config_path, demo=False, node="node"):
        self.path = Path(config_path).resolve()
        self.root = self.path.parent
        self.config = load_config(self.path)
        self.document = public(self.config)
        self.revision = fingerprint(self.document)
        self.demo, self.node = demo, node
        self.lock = threading.RLock()
        self.operations = threading.RLock()
        self.token = secrets.token_urlsafe(32)
        self.events = []
        self.sequence = 0
        self.looper_action_id = 0
        self.running = False
        self.stopping = False
        self.dry_run = False
        from audio_looper import AudioLooper
        self.audio_looper = AudioLooper()
        self.worker = None
        self.learning = None
        self.identification = None
        self.levels = {}
        self.last_hits = {}
        self.gpio_status = "ready" if demo else "starting"
        self.gpio_error = ""
        self.amp = {"status": "unchecked", "message": "Connection not checked.", "ports": None}
        self.connection_stop = threading.Event()
        self.amp_busy = False
        self.amp_settings = {}
        self.amp_all_settings = {}
        self.midi_process = None
        self.watch_pins = list(dict.fromkeys(WATCH_PINS + [s["gpio"] for s in self.config["switches"]]))
        self.monitor = GPIOMonitor(self)
        if demo:
            self.levels = {pin: False for pin in self.watch_pins}
        self.library_items = []
        self.refresh_library()
        self.connection_thread = threading.Thread(target=self.watch_connection, daemon=True, name="amp-presence")
        self.connection_thread.start()
        self.log("info", "Demo mode: virtual pedals; the amp is unchanged." if demo else "Ready to set up your pedals.")

    def log(self, kind, message, **extra):
        with self.lock:
            self.sequence += 1
            self.events.append({"id": self.sequence, "time": datetime.now().strftime("%H:%M:%S"),
                                "kind": kind, "message": str(message), **extra})
            self.events = self.events[-80:]

    def tone_status(self, status, filename, message):
        details = None
        if status == "verified":
            try:
                details = json.loads(message)
            except (TypeError, ValueError):
                pass
        self.log("error" if status == "error" else "tone", f"{filename.stem}: " +
                 ("Tone loaded and verified." if details else message))
        if status in ("verified", "error"):
            with self.lock:
                self.amp.update(status="connected" if status == "verified" else "error",
                                message="Tone loaded and verified." if details else message)
                if details and isinstance(details.get("settings"), dict):
                    if details.get("memory"):
                        self.amp["memory"] = details["memory"]
                    self.amp_settings = details["settings"]
                    self.amp_all_settings = details.get("allSettings", self.amp_settings)

    def refresh_library(self):
        metadata_path = self.root / ".state/tone-library.json"
        metadata = json.loads(metadata_path.read_text()) if metadata_path.is_file() else {}
        files = set((self.root / "tones").rglob("*.json"))
        for switch in self.config["switches"]:
            for group in action_groups(switch):
                files.update(a["_file"] for a in group if a["type"] == "tone")
        items = []
        for path in sorted(files):
            try:
                document = json.loads(path.read_text())
                if not isinstance(document, dict):
                    continue
                relative = os.path.relpath(path, self.root)
                info = metadata.get(relative, {})
                inferred = "mkii" if "mkii" in path.parts else self.config["amp"]["profile"]
                profile = document.get("profile", info.get("profile", inferred))
                plan = document.get("plan", document)
                summary = plan.get("explanation", "Captured amp settings." if document.get("settings") else "")
                items.append({"file": relative, "name": info.get("name", path.stem.replace("-", " ").replace("_", " ").title()),
                              "profile": profile, "summary": str(summary)[:300]})
            except (OSError, ValueError, AttributeError):
                continue
        with self.lock:
            self.library_items = items
        return items

    def state(self):
        with self.lock:
            if self.learning and time.monotonic() > self.learning["deadline"]:
                self.log("info", "Identification timed out. Click Identify pedal to try again.")
                self.learning = None
            learning = copy.deepcopy(self.learning)
            if learning:
                learning["remaining"] = max(0, round(learning.pop("deadline") - time.monotonic()))
            return {
                "token": self.token, "config": self.document, "revision": self.revision,
                "library": self.library_items, "running": self.running,
                "stopping": self.stopping, "dry_run": self.dry_run, "demo": self.demo,
                "gpio": {"status": self.gpio_status, "error": self.gpio_error,
                         "pins": [{"gpio": pin, "header": HEADER_PINS[pin]} for pin in self.watch_pins]},
                "levels": self.levels, "last_hits": self.last_hits,
                "learning": learning, "identification": self.identification,
                "amp_all_settings": self.amp_all_settings, "amp_settings": self.amp_settings, "looper": self.audio_looper.state(), "looper_action_id": self.looper_action_id, "amp": self.amp, "amp_busy": self.amp_busy, "events": self.events,
            }

    def pause(self):
        with self.operations:
            with self.lock:
                was_running = self.running
                self.running = False
                worker, self.worker = self.worker, None
                self.stopping = worker is not None
            self.audio_looper.close()
            if worker:
                # Discard waiting tones; let an active amp transaction finish.
                with worker.condition:
                    worker.pending = None
                    worker.condition.notify_all()
                worker.drain()
                worker.close()
            with self.lock:
                self.stopping = False
            if was_running:
                self.log("info", "Pedals stopped.")

    def save(self, document, revision):
        with self.operations:
            if revision != self.revision:
                raise UIError("The saved setup changed in another window. Reload this page before saving.", 409)
            if fingerprint(json.loads(self.path.read_text())) != self.revision:
                raise UIError("The setup file changed outside this app. Restart the app to load those changes.", 409)
            document = public(copy.deepcopy(document))
            switches = document.get("switches", []) if isinstance(document, dict) else []
            if not 1 <= len(switches) <= 10:
                raise UIError("Choose between 1 and 10 pedals.")
            for switch in switches:
                if switch.get("gpio") is None:
                    raise UIError(f"Identify {switch.get('name') or 'every pedal'} before saving.")
                if switch.get("gpio") not in self.watch_pins:
                    raise UIError("That connection is not monitored. Use Identify pedal to select a wired input.")
            config = validate_config(document, self.path)
            validate_tones(config, self.node)
            self.pause()
            backup = self.root / ".state/config-backups" / f"{time.time_ns()}.json"
            atomic_write(backup, json.loads(self.path.read_text()))
            atomic_write(self.path, public(config))
            with self.lock:
                self.config = config
                self.document = public(config)
                self.revision = fingerprint(self.document)
                self.learning = None
            self.log("info", "Setup saved. Previous setup backed up automatically.")
            return {"revision": self.revision, "config": self.document}

    def start(self, revision, dry_run=False):
        with self.operations:
            if revision != self.revision:
                raise UIError("Save the current setup before starting.", 409)
            if self.amp_busy:
                raise UIError("Wait for the amp connection check to finish.", 409)
            if self.gpio_status != "ready":
                raise UIError(self.gpio_error or "Pedal inputs are still starting.")
            self.pause()
            validate_tones(self.config, self.node)
            if not (dry_run or self.demo) and has_looper(self.config) and uses_builtin_looper(self.config):
                self.audio_looper.start()
            with self.lock:
                self.learning = None
                self.dry_run = bool(dry_run) or self.demo
                self.worker = ToneWorker(self.config, self.dry_run, self.node, self.tone_status)
                self.running = True
            self.log("info", "Test mode started; the amp is unchanged." if self.dry_run else "Pedals started. Assigned actions are live.")

    def looper_action(self, body):
        from audio_looper import LOOP_COMMANDS
        with self.operations:
            if self.config["amp"]["profile"] != "go2" or not uses_builtin_looper(self.config):
                raise UIError("Track controls require the GO:2 built-in looper.")
            command = body.get("command")
            if command == "start_audio":
                if self.demo:
                    self.audio_looper.start_demo()
                else:
                    self.audio_looper.start()
            elif command == "stop_audio":
                self.audio_looper.close()
            else:
                if not isinstance(command, str) or command not in LOOP_COMMANDS:
                    raise UIError("Choose a looper command.")
                options = {key: body[key] for key in ("track_id", "name", "volume") if key in body}
                self.audio_looper.edit(command, **options)
            with self.lock:
                self.looper_action_id += 1
            self.log("info", f"Looper: {command.replace('_', ' ')}")
            return {"looper": self.audio_looper.state()}

    def identify(self, slot):
        with self.operations:
            if not isinstance(slot, str) or not slot or len(slot) > 80:
                raise UIError("Choose a pedal to identify.")
            if self.gpio_status != "ready":
                raise UIError(self.gpio_error or "Wait for the pedal inputs to start.")
            self.pause()
            with self.lock:
                self.learning = {"token": uuid.uuid4().hex, "slot": slot, "candidate": None,
                                 "changes": 0, "deadline": time.monotonic() + 25}
                self.identification = None
            self.log("info", f"Identifying pedal {slot}: click that pedal twice.")
            return public(self.learning)

    def edge(self, pin, closed):
        with self.lock:
            self.levels[pin] = bool(closed)
            if self.learning and time.monotonic() > self.learning["deadline"]:
                self.learning = None
            if self.learning:
                learning = self.learning
                if learning["candidate"] != pin:
                    learning["candidate"], learning["changes"] = pin, 1
                else:
                    learning["changes"] += 1
                if learning["changes"] >= 2:
                    self.identification = {"token": learning["token"], "slot": learning["slot"],
                                           "gpio": pin, "header": HEADER_PINS[pin]}
                    self.log("identified", f"Pedal {learning['slot']} identified on header pin {HEADER_PINS[pin]}.")
                    self.learning = None
                return
            if not self.running or not self.worker:
                return
            switch = next((s for s in self.config["switches"] if s["gpio"] == pin), None)
            if switch:
                self.last_hits[switch["id"]] = self.sequence + 1
                position = "B" if closed else "A"
                self.log("pedal", f"{switch.get('name', switch['id'])}: position {position}.", pedal=switch["id"])
                actions = switch.get("position_actions", {}).get("closed" if closed else "open", switch["actions"])
                if any(action["type"] == "looper" for action in actions):
                    self.looper_action_id += 1
                try:
                    dispatch(switch, self.config, self.worker, self.dry_run, position=bool(closed), audio_looper=self.audio_looper)
                except (ValueError, OSError) as error:
                    self.log("error", f"Looper: {error}")

    def import_tone(self, body):
        with self.operations:
            name = body.get("name", "")
            if not isinstance(name, str):
                raise UIError("Give the tone a name.")
            name = name.strip()
            if not name or len(name) > 100:
                raise UIError("Give the tone a name between 1 and 100 characters.")
            profile = body.get("profile")
            if profile not in ("go2", "mkii"):
                raise UIError("Choose KATANA:GO:2 or Katana MkII.")
            document = body.get("document")
            if not isinstance(document, dict):
                raise UIError("The tone must be a JSON object from Tone Lab or a captured tone.")
            if len(json.dumps(document).encode()) > 1024 * 1024:
                raise UIError("Tone files must be smaller than 1 MB.")
            file = self.root / "tones/user" / f"{uuid.uuid4().hex}.json"
            atomic_write(file, document)
            try:
                config = {"amp": {"profile": profile}, "_root": self.root}
                result = subprocess.run(tone_command(config, "validate", file, self.node),
                                        capture_output=True, text=True, timeout=15)
                if result.returncode:
                    raise UIError(result.stderr.strip() or result.stdout.strip() or "Invalid tone JSON.")
                path = self.root / ".state/tone-library.json"
                metadata = json.loads(path.read_text()) if path.is_file() else {}
                relative = os.path.relpath(file, self.root)
                metadata[relative] = {"name": name, "profile": profile}
                atomic_write(path, metadata)
            except Exception:
                file.unlink(missing_ok=True)
                raise
            self.refresh_library()
            self.log("info", f'Imported tone "{name}".')
            return {"file": relative, "library": self.library_items}

    def tone_file(self, filename):
        if filename not in {item["file"] for item in self.library_items}:
            raise UIError("Tone not found.", 404)
        return json.loads((self.root / filename).read_text())

    def watch_connection(self):
        # Enumeration leaves the tone worker's MIDI session alone.
        while not self.connection_stop.wait(3):
            with self.lock:
                if self.demo or self.amp_busy or self.amp["status"] != "connected":
                    continue
                options = copy.deepcopy(self.amp.get("options", self.config["amp"]))
            try:
                args = [self.node, str(ROOT / "katana_tones.mjs"), "presence", "--profile", options["profile"]]
                for direction in ("input", "output"):
                    if options.get(direction):
                        args += [f"--{direction}", options[direction]]
                result = subprocess.run(args,
                                        capture_output=True, text=True, timeout=15,
                                        env={**os.environ, "PEDAL_PYTHON": sys.executable})
                if result.returncode:
                    with self.lock:
                        if self.amp_busy or self.amp.get("options", self.config["amp"]) != options:
                            continue
                        self.amp.update(status="error", message="Amp disconnected. Check USB and reconnect.")
                    self.log("error", "Amp disconnected. Check USB and reconnect.")
                    self.pause()
            except (OSError, subprocess.SubprocessError) as error:
                self.log("error", f"Connection monitor: {error}")

    def capture_amp(self, body):
        with self.operations:
            if self.amp_busy or self.amp["status"] != "connected":
                raise UIError("Connect your amp before saving a tone.", 409)
            profile = self.amp["profile"]
            self.pause()
            if not self.demo:
                options = self.amp["options"]
                args = [self.node, str(ROOT / "katana_tones.mjs"), "read", "--profile", profile]
                for direction in ("input", "output"):
                    if options.get(direction):
                        args += [f"--{direction}", options[direction]]
                result = subprocess.run(args, capture_output=True, text=True, timeout=90,
                                        env={**os.environ, "PEDAL_PYTHON": sys.executable})
                if result.returncode:
                    self.amp.update(status="error", message=result.stderr.strip())
                    raise UIError(result.stderr.strip() or "Could not read the amp.")
                read = json.loads(result.stdout)
                self.amp_settings = read["settings"]
                self.amp_all_settings = read.get("allSettings", self.amp_settings)
            schema = self.amp_schema(profile)
            document = {"kind": "pi-pedal-tone-snapshot", "version": 2, "profile": profile,
                        "createdAt": datetime.now().isoformat(), "settings": {key: value for key, value in self.amp_settings.items()
                        if schema[key].get("scope") != "system"}}
            return self.import_tone({"name": body.get("name"), "document": document, "profile": profile})

    def memory_action(self, body):
        from pedal_controller import memory_command
        bank, channel, command = body.get("bank"), body.get("channel"), body.get("command")
        if type(bank) is not int or bank not in range(1,11) or channel not in ("A","B","C") or command not in ("recall-memory","write-memory"):
            raise UIError("Choose bank 1–10, channel A/B/C and Recall or Write.")
        with self.operations:
            if self.amp_busy or self.amp.get("status") != "connected" or self.amp.get("profile") != "go2":
                raise UIError("Connect GO:2 and wait for the current operation.",409)
            if self.running:
                raise UIError("Pause pedal control before recalling or writing a channel here.",409)
            if self.demo:
                result = {"verified":True,"settings":self.amp_settings,"allSettings":self.amp_all_settings}
            else:
                config = {"amp":{**self.config["amp"],**self.amp.get("options",{})},"_root":self.root}
                process = subprocess.run(memory_command(config,command,bank,channel,self.node), capture_output=True,text=True,timeout=90,
                                         env={**os.environ,"PEDAL_PYTHON":sys.executable})
                if process.returncode:
                    raise UIError(process.stderr.strip() or "Memory operation failed. Read the amp before retrying.")
                result = json.loads(process.stdout)
            self.amp_settings = result["settings"]
            self.amp_all_settings = result.get("allSettings",self.amp_settings)
            if command == "recall-memory":
                self.amp["memory"] = {"bank":bank,"channel":channel}
            self.log("info",f'{"Wrote current tone to" if command == "write-memory" else "Recalled"} Bank {bank} / {channel}.' + (f' Backup: {result["backup"]}' if result.get("backup") else ""))
            return result

    def demo_settings(self, profile, values=None):
        values = dict(values or {})
        schema = self.amp_schema(profile)
        for key, p in schema.items():
            if not p.get("algorithm"):
                values.setdefault(key, next(iter(p["values"])) if "values" in p else False if p.get("boolean") else p.get("min", 0))
        for key, p in schema.items():
            if p.get("algorithm"):
                if p["algorithm"] == values.get(p["group"] + "Type"):
                    values.setdefault(key, self.amp_all_settings.get(key, next(iter(p["values"])) if "values" in p else False if p.get("boolean") else p.get("min", 0)))
                else:
                    values.pop(key, None)
        return values

    def amp_schema(self, profile):
        if profile not in ("go2", "mkii"):
            raise UIError("Select an amp model.")
        result = subprocess.run([self.node, str(ROOT / "katana_tones.mjs"), "schema", "--profile", profile],
                                capture_output=True, text=True, timeout=15)
        if result.returncode:
            raise UIError(result.stderr.strip())
        return json.loads(result.stdout)

    def edit_amp(self, body):
        with self.operations:
            if self.amp_busy or self.amp["status"] != "connected":
                raise UIError("Connect the amp and wait for the current operation.", 409)
            profile = self.amp["profile"]
            document = self.tone_file(body["file"]) if isinstance(body.get("file"), str) else None
            changes = (document.get("settings") or document.get("plan", document).get("changes")) if document else body.get("changes")
            if not isinstance(changes, dict) or not changes:
                raise UIError("Choose amp settings to apply.")
            self.pause()
            with tempfile.TemporaryDirectory() as directory:
                file = Path(directory) / "edit.json"
                atomic_write(file, document or {"profile": profile, "plan": {"explanation": "Amp editor", "changes": changes}})
                config = {"amp": {**self.config["amp"], **self.amp.get("options", {}), "profile": profile}, "_root": self.root}
                for command in (["validate"] if self.demo else ["validate", "apply", "read"]):
                    args = ([self.node, str(ROOT / "katana_tones.mjs"), "read", "--profile", profile]
                            if command == "read" else tone_command(config, command, file, self.node))
                    if command == "read":
                        for direction in ("input", "output"):
                            if config["amp"].get(direction):
                                args += [f"--{direction}", config["amp"][direction]]
                    try:
                        result = subprocess.run(args, capture_output=True, text=True, timeout=90,
                                                env={**os.environ, "PEDAL_PYTHON": sys.executable})
                    except (OSError, subprocess.SubprocessError) as error:
                        if command != "validate":
                            self.amp.update(status="error", message=str(error))
                        self.log("error", f"Amp editor: {error}")
                        raise UIError(str(error)) from error
                    if result.returncode:
                        if command != "validate":
                            self.amp.update(status="error", message=result.stderr.strip())
                        self.log("error", result.stderr.strip() or "Amp edit failed.")
                        raise UIError(result.stderr.strip() or "Amp edit failed.")
                    if command == "read":
                        read = json.loads(result.stdout)
                        self.amp_settings = read["settings"]
                        self.amp_all_settings = read.get("allSettings", self.amp_settings)
            if self.demo:
                self.amp_all_settings.update(changes)
                self.amp_settings.update(changes)
                self.amp_settings = self.demo_settings(profile, self.amp_settings)
            self.log("info", "Amp settings applied." if not self.demo else "Demo amp settings updated.")
            return {"settings": self.amp_settings, "allSettings": self.amp_all_settings}

    def check_amp(self, options, ports_only=False):
        with self.operations:
            if self.amp_busy:
                raise UIError("An amp check is already running.", 409)
            if options.get("profile") not in ("go2", "mkii"):
                raise UIError("Select an amp model.")
            for direction in ("input", "output"):
                if options.get(direction) is not None and not isinstance(options[direction], str):
                    raise UIError("Select a MIDI port or Automatic.")
            self.pause()
            with self.lock:
                self.amp_busy = True
                self.amp.update(status="checking", message="Looking for MIDI ports..." if ports_only else "Reading amp settings...")
            threading.Thread(target=self._check_amp, args=(copy.deepcopy(options), ports_only),
                             name="amp-check", daemon=True).start()

    def _check_amp(self, options, ports_only):
        try:
            if self.demo:
                time.sleep(.2)
                result = {"inputs": [{"name": "Demo GO:2 MIDI"}], "outputs": [{"name": "Demo GO:2 MIDI"}]}
            else:
                args = [self.node, str(ROOT / "katana_tones.mjs"), "ports" if ports_only else "read",
                        "--profile", options["profile"]]
                if not ports_only:
                    for direction in ("input", "output"):
                        if options.get(direction):
                            args.extend([f"--{direction}", options[direction]])
                env = {**os.environ, "PEDAL_PYTHON": sys.executable}
                process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                           text=True, env=env, start_new_session=True)
                with self.lock:
                    self.midi_process = process
                try:
                    stdout, stderr = process.communicate(timeout=70)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate()
                    raise UIError("The amp check timed out. Check the USB connection and try again.")
                if process.returncode:
                    raise UIError(stderr.strip() or stdout.strip() or "Amp connection failed.")
                result = json.loads(stdout)
            with self.lock:
                if ports_only:
                    self.amp.update(ports=result, status="unchecked", message="MIDI ports refreshed. Click Check amp to read the amp.")
                else:
                    if result.get("memory"):
                        self.amp["memory"] = result["memory"]
                    self.amp_settings = result.get("settings", {})
                    self.amp_all_settings = result.get("allSettings", self.amp_settings)
                    self.amp["options"] = options
                    if self.demo and not self.amp_settings:
                        self.amp_settings = self.demo_settings(options["profile"])
                        self.amp_all_settings = {key: self.amp_settings.get(key, next(iter(p["values"])) if "values" in p else False if p.get("boolean") else p.get("min", 0)) for key, p in self.amp_schema(options["profile"]).items()}
                    self.amp.update(status="connected", profile=options["profile"],
                                    message="Demo amp connected." if self.demo else "Connected. Amp settings read successfully.")
            self.log("info", self.amp["message"])
        except Exception as error:
            with self.lock:
                self.amp.update(status="error", message=str(error))
            self.log("error", f"Amp connection: {error}")
        finally:
            with self.lock:
                self.amp_busy = False
                self.midi_process = None

    def close(self):
        self.connection_stop.set()
        self.monitor.close()
        self.pause()
        with self.lock:
            process = self.midi_process
        if process and process.poll() is None:
            process.terminate()


class Handler(BaseHTTPRequestHandler):
    @property
    def app(self):
        return self.server.app

    def log_message(self, fmt, *args):
        if args and str(args[1] if len(args) > 1 else "").startswith("5"):
            super().log_message(fmt, *args)

    def send(self, status, body, content_type="application/json; charset=utf-8"):
        if not isinstance(body, bytes):
            body = json.dumps(body, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        self.end_headers()
        self.wfile.write(body)

    def check_origin(self):
        host = self.headers.get("Host", "")
        if urlparse("//" + host).hostname not in ("localhost", "127.0.0.1", "::1"):
            raise UIError("Open this app through localhost or 127.0.0.1.", 403)
        origin = self.headers.get("Origin")
        if origin and urlparse(origin).netloc != host:
            raise UIError("This request must come from the pedal interface.", 403)

    def do_GET(self):
        try:
            self.check_origin()
            parsed = urlparse(self.path)
            if parsed.path == "/api/state":
                return self.send(200, self.app.state())
            if parsed.path == "/api/amp/schema":
                return self.send(200, self.app.amp_schema(parse_qs(parsed.query).get("profile", ["go2"])[0]))
            if parsed.path == "/api/tone":
                filename = parse_qs(parsed.query).get("file", [""])[0]
                return self.send(200, self.app.tone_file(filename))
            static = {"/": ("index.html", "text/html; charset=utf-8"),
                      "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                      "/app.css": ("app.css", "text/css; charset=utf-8")}
            if parsed.path in static:
                filename, content_type = static[parsed.path]
                return self.send(200, (ROOT / "ui" / filename).read_bytes(), content_type)
            raise UIError("Page not found.", 404)
        except Exception as error:
            self.send(getattr(error, "status", 500), {"error": str(error)})

    def do_POST(self):
        try:
            self.check_origin()
            if not secrets.compare_digest(self.headers.get("X-Pedal-Token", ""), self.app.token):
                raise UIError("Reload the page to reconnect to the controller.", 403)
            if self.headers.get_content_type() != "application/json":
                raise UIError("Send a JSON request.", 415)
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                raise UIError("Invalid request size.")
            if not 0 < length <= MAX_BODY:
                raise UIError("Request is empty or too large.", 413)
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise UIError("Request must be a JSON object.")
            path = urlparse(self.path).path
            result = {}
            if path == "/api/setup":
                result = self.app.save(body.get("config"), body.get("revision"))
            elif path == "/api/start":
                self.app.start(body.get("revision"), body.get("dry_run", False))
            elif path == "/api/pause":
                self.app.pause()
            elif path == "/api/learn":
                result = self.app.identify(body.get("slot"))
            elif path == "/api/learn/cancel":
                with self.app.lock:
                    self.app.learning = None
            elif path == "/api/looper":
                result = self.app.looper_action(body)
            elif path == "/api/amp/capture":
                result = self.app.capture_amp(body)
            elif path == "/api/amp/memory":
                result = self.app.memory_action(body)
            elif path == "/api/amp/edit":
                result = self.app.edit_amp(body)
            elif path == "/api/tones":
                result = self.app.import_tone(body)
            elif path == "/api/library/refresh":
                self.app.refresh_library()
            elif path in ("/api/amp/check", "/api/amp/ports"):
                self.app.check_amp(body, ports_only=path.endswith("/ports"))
            elif path == "/api/hardware/retry":
                if not self.app.demo:
                    self.app.monitor.start()
            elif path == "/api/demo/toggle" and self.app.demo:
                pin = body.get("gpio")
                if type(pin) is not int or pin not in self.app.watch_pins:
                    raise UIError("Choose a demo pedal.")
                self.app.edge(pin, not self.app.levels[pin])
            else:
                raise UIError("Action not found.", 404)
            self.send(200, {"ok": True, **result})
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            self.send(getattr(error, "status", 400), {"error": str(error)})
        except Exception as error:
            logging.exception("Interface request failed")
            self.send(500, {"error": str(error)})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=str(ROOT / "pedals.json"))
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--node", default="node")
    parser.add_argument("--demo", action="store_true")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    temporary = None
    config_path = Path(args.config).resolve()
    if args.demo:
        temporary = tempfile.TemporaryDirectory(prefix="pedal-ui-demo-")
        demo_root = Path(temporary.name)
        shutil.copytree(config_path.parent / "tones", demo_root / "tones")
        shutil.copyfile(config_path, demo_root / "pedals.json")
        config_path = demo_root / "pedals.json"
    app = PedalApp(config_path, args.demo, args.node)
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
        server.daemon_threads = True
        server.app = app
        if not args.demo:
            app.monitor.start()
        url = f"http://127.0.0.1:{server.server_port}"
        print(f"\nPedal interface: {url}\nKeep this terminal open. Ctrl+C to stop.\n", flush=True)
        if not args.no_browser:
            threading.Timer(.4, lambda: webbrowser.open(url)).start()
        try:
            server.serve_forever(poll_interval=.2)
        except KeyboardInterrupt:
            print("\nStopping pedal interface...", flush=True)
        finally:
            server.server_close()
    finally:
        app.close()
        if temporary:
            temporary.cleanup()


if __name__ == "__main__":
    main()
