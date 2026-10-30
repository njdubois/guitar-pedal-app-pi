#!/usr/bin/env python3
"""Pi 4 latching stomp switches -> local Katana tones and looper commands.

Run --simulate --dry-run anywhere. Hardware GPIO is imported only in GPIO mode.
Every debounced state CHANGE is one stomp; neither latch state means release.
"""
import argparse
import copy
import json
import logging
import math
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parent
LOG = logging.getLogger("pedals")
from audio_looper import LOOP_COMMANDS as AUDIO_LOOP_COMMANDS, OSC_LOOP_COMMANDS
LOOP_COMMANDS = AUDIO_LOOP_COMMANDS - {"select_track", "set_volume"}


class DebouncedLatch:
    def __init__(self, initial, now, seconds=0.030, immediate=False):
        self.stable = bool(initial)
        self.candidate = self.stable
        self.changed_at = now
        self.seconds = seconds
        self.immediate = immediate
        self.locked = False

    def update(self, value, now):
        value = bool(value)
        if self.immediate:
            if value != self.candidate:
                self.candidate = value
                self.changed_at = now
            if self.locked:
                self.stable = value
                if now - self.changed_at >= self.seconds:
                    self.locked = False
                return False
            if value != self.stable:
                self.stable = value
                self.locked = True
                return True
            return False
        if value != self.candidate:
            self.candidate = value
            self.changed_at = now
        if self.candidate != self.stable and now - self.changed_at >= self.seconds:
            self.stable = self.candidate
            return True
        return False


def osc_string(value):
    data = value.encode("utf-8") + b"\0"
    return data + b"\0" * (-len(data) % 4)


def looper_packet(loop, command):
    if type(loop) is not int or loop < 0 or not isinstance(command, str) or command not in OSC_LOOP_COMMANDS:
        raise ValueError("Invalid loop index or SooperLooper command")
    return osc_string(f"/sl/{loop}/hit") + osc_string(",s") + osc_string(command)


def load_config(filename):
    filename = Path(filename).resolve()
    return validate_config(json.loads(filename.read_text()), filename)


def action_groups(switch):
    groups = [switch["actions"]]
    positions = switch.get("position_actions")
    if positions is not None:
        if not isinstance(positions, dict) or set(positions) != {"open", "closed"}:
            raise ValueError("Position actions need open and closed arrays")
        groups.extend([positions["open"], positions["closed"]])
    return groups


def validate_config(document, filename):
    filename = Path(filename).resolve()
    config = copy.deepcopy(document)
    if not isinstance(config, dict) or config.get("version") != 1:
        raise ValueError("Config must be a version 1 JSON object")
    config["_root"] = filename.parent
    for field, default, low, high in (("debounce_ms", 30, 5, 250), ("poll_ms", 5, 1, 20)):
        value = config.setdefault(field, default)
        if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
            raise ValueError(f"{field} must be between {low} and {high}")
    amp = config.setdefault("amp", {"profile": "go2"})
    if not isinstance(amp, dict) or amp.get("profile") not in ("go2", "mkii"):
        raise ValueError("amp.profile must be go2 or mkii")
    for key in ("input", "output"):
        if amp.get(key) is not None and (not isinstance(amp[key], str) or not amp[key]):
            raise ValueError(f"amp.{key} must be an exact port name or null")
    looper = config.setdefault("looper", {"host": "127.0.0.1", "port": 9951, "loop": 0})
    if (not isinstance(looper, dict) or not isinstance(looper.get("host"), str)
            or not looper["host"] or type(looper.get("port")) is not int
            or not 1 <= looper["port"] <= 65535
            or type(looper.get("loop")) is not int or looper["loop"] < 0):
        raise ValueError("looper needs host, port 1..65535, and a nonnegative loop index")
    if looper.get("engine", "builtin" if amp["profile"] == "go2" else "osc") not in ("builtin", "osc"):
        raise ValueError("looper.engine must be builtin or osc")
    switches = config.get("switches")
    if not isinstance(switches, list) or not switches:
        raise ValueError("Configure at least one switch")
    ids, pins = set(), set()
    for switch in switches:
        if not isinstance(switch, dict):
            raise ValueError("Each switch must be an object")
        sid, pin = switch.get("id"), switch.get("gpio")
        if not isinstance(sid, str) or not sid or sid in ids:
            raise ValueError("Switch IDs must be unique nonempty strings")
        if type(pin) is not int or pin not in range(4, 28) or pin in pins:
            raise ValueError("Use unique BCM GPIO numbers 4..27, not physical header pin numbers")
        ids.add(sid)
        pins.add(pin)
        if "actions" not in switch:
            raise ValueError("Each switch needs actions")
        for actions in action_groups(switch):
            if not isinstance(actions, list) or not actions:
                raise ValueError(f"Switch {sid} needs actions")
            for action in actions:
                if not isinstance(action, dict):
                    raise ValueError("Each action must be an object")
                kind = action.get("type")
                if kind == "tone":
                    name = action.get("file")
                    if not isinstance(name, str) or not name:
                        raise ValueError("Tone action needs a file")
                    file = (filename.parent / name).resolve()
                    if not file.is_file():
                        raise ValueError(f"Missing tone file: {file}")
                    action["_file"] = file
                elif kind == "channel":
                    if amp["profile"] != "go2" or type(action.get("bank")) is not int or action["bank"] not in range(1,11) or action.get("channel") not in ("A","B","C"):
                        raise ValueError("Channel action requires GO:2 bank 1–10 and channel A/B/C")
                elif kind == "looper":
                    if not isinstance(action.get("command"), str) or action["command"] not in LOOP_COMMANDS:
                        raise ValueError("Unsupported looper command")
                    if action["command"] == "rename_track" and (not isinstance(action.get("name"), str) or not 1 <= len(action["name"].strip()) <= 60):
                        raise ValueError("Rename track needs a name of 1–60 characters")
                    if (looper.get("engine", "builtin" if amp["profile"] == "go2" else "osc") == "osc"
                            and action["command"] not in OSC_LOOP_COMMANDS):
                        raise ValueError("Track management, Start / stop and Clear require the built-in looper")
                elif kind == "event":
                    if not isinstance(action.get("name"), str) or not action["name"]:
                        raise ValueError("Event action needs a name")
                else:
                    raise ValueError(f"Unknown action type: {kind}")
    return config


def tone_command(config, command, filename, node="node"):
    args = [node, str(ROOT / "katana_tones.mjs"), command,
            "--profile", config["amp"]["profile"], "--file", str(filename)]
    if command == "apply":
        args += ["--state-dir", str(config["_root"] / ".state")]
        for direction in ("input", "output"):
            if config["amp"].get(direction):
                args += [f"--{direction}", config["amp"][direction]]
    return args


class ChannelTarget:
    def __init__(self, bank, channel):
        self.bank, self.channel = bank, channel
        self.name = self.stem = f"Bank {bank} / {channel}"


def memory_command(config, command, bank, channel, node="node"):
    args = [node, str(ROOT / "katana_tones.mjs"), command, "--profile", "go2",
            "--bank", str(bank), "--channel", channel, "--state-dir", str(config["_root"] / ".state")]
    for direction in ("input", "output"):
        if config["amp"].get(direction):
            args += [f"--{direction}", config["amp"][direction]]
    return args


def validate_tones(config, node="node"):
    files = {a["_file"] for s in config["switches"] for group in action_groups(s) for a in group if a["type"] == "tone"}
    for filename in sorted(files):
        result = subprocess.run(tone_command(config, "validate", filename, node),
                                capture_output=True, text=True, timeout=15, check=False)
        if result.returncode:
            raise ValueError(result.stderr.strip() or result.stdout.strip() or "Tone validation failed")


class ToneWorker:
    """One active amp operation, one latest pending tone, never automatic retry.

    Amp I/O does not block GPIO sampling or OSC looper hits. A pending request
    older than three seconds is discarded instead of being recalled much later.
    """
    def __init__(self, config, dry_run=False, node="node", status=None):
        self.status = status or (lambda *args: None)
        self.config, self.dry_run, self.node = config, dry_run, node
        self.condition = threading.Condition()
        self.pending = None
        self.busy = False
        self.stopping = False
        self.process = None
        self.thread = threading.Thread(target=self.run, name="katana-tones", daemon=True)
        self.thread.start()

    def submit(self, filename):
        if self.dry_run:
            LOG.info("DRY RUN: would apply %s [%s]", filename.name, self.config["amp"]["profile"])
            self.status("test", filename, "Test: would apply tone.")
            return
        with self.condition:
            if self.pending:
                LOG.info("Replacing pending tone with %s", filename.name)
            self.pending = (filename, time.monotonic())
            self.condition.notify_all()

    def run(self):
        while True:
            with self.condition:
                self.condition.wait_for(lambda: self.stopping or self.pending is not None)
                if self.stopping:
                    return
                filename, requested_at = self.pending
                self.pending = None
                self.busy = True
            try:
                if time.monotonic() - requested_at > 3:
                    LOG.warning("Skipped stale tone %s; stomp again", filename.name)
                    continue
                LOG.info("Applying %s...", filename.name)
                env = {**os.environ, "PEDAL_PYTHON": sys.executable}
                with self.condition:
                    if self.stopping:
                        return
                    self.process = subprocess.Popen((memory_command(self.config, "recall-memory", filename.bank, filename.channel, self.node) if isinstance(filename, ChannelTarget) else tone_command(self.config, "apply", filename, self.node)),
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                        env=env, start_new_session=True)
                    process = self.process
                try:
                    stdout, stderr = process.communicate(timeout=60)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.communicate()
                    raise RuntimeError("Tone operation timed out; it may have changed the amp. Read before retrying")
                if process.returncode:
                    LOG.error("Tone failed: %s", stderr.strip() or stdout.strip())
                    self.status("error", filename, stderr.strip() or stdout.strip())
                else:
                    LOG.info("Tone readback verified: %s", stdout.strip())
                    self.status("verified", filename, stdout.strip())
            except Exception as error:
                LOG.error("Tone error: %s", error)
                self.status("error", filename, str(error))
            finally:
                with self.condition:
                    self.process = None
                    self.busy = False
                    self.condition.notify_all()

    def drain(self):
        with self.condition:
            return self.condition.wait_for(lambda: not self.busy and self.pending is None, timeout=70)

    def close(self):
        with self.condition:
            self.stopping = True
            self.pending = None
            process = self.process
            self.condition.notify_all()
        if process is not None and process.poll() is None:
            process.terminate()
        self.thread.join(timeout=3)
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            self.thread.join(timeout=2)


def uses_builtin_looper(config):
    return config["looper"].get("engine", "builtin" if config["amp"]["profile"] == "go2" else "osc") == "builtin"


def has_looper(config):
    return any(a["type"] == "looper" for s in config["switches"] for group in action_groups(s) for a in group)


def dispatch(switch, config, worker, dry_run, position=None, audio_looper=None):
    LOG.info("STOMP %s: %s [BCM %s]", switch["id"], switch.get("name", ""), switch["gpio"])
    actions = switch["actions"]
    if position is not None and switch.get("position_actions"):
        actions = switch["position_actions"]["closed" if position else "open"]
    for action in actions:
        if action["type"] == "tone":
            worker.submit(action["_file"])
        elif action["type"] == "channel":
            worker.submit(ChannelTarget(action["bank"], action["channel"]))
        elif action["type"] == "looper":
            if uses_builtin_looper(config):
                if dry_run:
                    LOG.info("DRY RUN: GO:2 looper %s", action["command"])
                elif audio_looper is None:
                    raise ValueError("GO:2 looper is not running")
                else:
                    if action["command"] == "rename_track":
                        audio_looper.hit(action["command"], name=action["name"])
                    else:
                        audio_looper.hit(action["command"])
                continue
            if action["command"] not in OSC_LOOP_COMMANDS:
                raise ValueError("Track management, Start / stop and Clear require the built-in looper")
            looper = config["looper"]
            packet = looper_packet(looper["loop"], action["command"])
            if dry_run:
                LOG.info("DRY RUN: would send /sl/%s/hit %s to %s:%s", looper["loop"], action["command"], looper["host"], looper["port"])
            else:
                try:
                    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
                        udp.sendto(packet, (looper["host"], looper["port"]))
                    LOG.info("OSC sent: %s (UDP delivery is not a looper acknowledgement)", action["command"])
                except OSError as error:
                    LOG.error("Looper send failed: %s", error)
        else:
            print(json.dumps({"event": action["name"], "switch": switch["id"],
                              "timestamp": time.monotonic(), "dry_run": dry_run}), flush=True)


def run_gpio(config, worker, dry_run, audio_looper=None):
    from gpiozero import Button
    buttons = []
    try:
        for switch in config["switches"]:
            # Debouncing is handled by the stable-state sampler, not an edge
            # suppression timer that could miss a latch transition.
            buttons.append(Button(switch["gpio"], pull_up=True, bounce_time=None))
        time.sleep(0.15)  # Establish inputs before arming; boot is not a stomp.
        now = time.monotonic()
        latches = [DebouncedLatch(b.is_pressed, now, config["debounce_ms"] / 1000,
                                  immediate=any(a["type"] == "looper" for group in action_groups(s) for a in group))
                   for s, b in zip(config["switches"], buttons)]
        LOG.info("GPIO armed; either latched state can be the starting state. Ctrl+C to stop.")
        while True:
            now = time.monotonic()
            for switch, button, latch in zip(config["switches"], buttons, latches):
                if latch.update(button.is_pressed, now):
                    dispatch(switch, config, worker, dry_run, position=latch.stable, audio_looper=audio_looper)
            time.sleep(min(config["poll_ms"], 1 if has_looper(config) else config["poll_ms"]) / 1000)
    finally:
        for button in buttons:
            button.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=str(ROOT / "pedals.json"))
    parser.add_argument("--dry-run", action="store_true", help="Validate/log; no MIDI or OSC is sent")
    parser.add_argument("--simulate", action="store_true", help="Type switch IDs instead of using GPIO")
    parser.add_argument("--stomp", help="Dispatch one switch ID without GPIO, then exit")
    parser.add_argument("--node", default="node", help="Path to Node.js 22.12 or newer")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    config = load_config(args.config)
    validate_tones(config, args.node)  # Pure local validation; no MIDI is opened.
    switches = {switch["id"]: switch for switch in config["switches"]}
    if args.stomp and args.stomp not in switches:
        raise ValueError(f"Unknown switch ID {args.stomp}")
    from audio_looper import AudioLooper
    audio_looper = AudioLooper()
    worker = ToneWorker(config, args.dry_run, args.node)
    try:
        if not args.dry_run and uses_builtin_looper(config) and has_looper(config):
            audio_looper.start()
        if args.stomp:
            dispatch(switches[args.stomp], config, worker, args.dry_run, audio_looper=audio_looper)
            worker.drain()
        elif args.simulate:
            LOG.info("Type a switch ID (%s), then Enter; q to quit. %s",
                     ", ".join(switches), "DRY RUN" if args.dry_run else "REAL AMP/OSC ACTIONS ENABLED")
            for line in sys.stdin:
                sid = line.strip()
                if sid.lower() in ("q", "quit"):
                    break
                if sid in switches:
                    dispatch(switches[sid], config, worker, args.dry_run, audio_looper=audio_looper)
                elif sid:
                    LOG.warning("Unknown switch ID %s", sid)
            worker.drain()
        else:
            run_gpio(config, worker, args.dry_run, audio_looper)
    finally:
        audio_looper.close()
        worker.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        LOG.info("Stopped")
    except Exception as error:
        LOG.error("Controller: %s", error)
        sys.exit(1)
