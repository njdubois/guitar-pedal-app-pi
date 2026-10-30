#!/usr/bin/env python3
"""Watch the pedal UI's GPIO readings and report physical switch changes.

This reads /api/state from the running UI, so it does not open or claim GPIO pins.
Run on the Pi while the UI is running, then press each pedal twice.
"""
import argparse
from collections import Counter
import json
import time
from urllib.error import HTTPError, URLError
from urllib.request import urlopen


def read_state(url):
    with urlopen(url.rstrip("/") + "/api/state", timeout=3) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8080", help="Pedal UI URL (default: %(default)s)")
    parser.add_argument("--interval", type=float, default=0.05, help="GPIO polling interval in seconds (default: %(default)s)")
    args = parser.parse_args()
    if not 0.01 <= args.interval <= 2:
        parser.error("--interval must be between 0.01 and 2 seconds")

    try:
        initial = read_state(args.url)
    except (HTTPError, URLError, TimeoutError, OSError, ValueError) as error:
        raise SystemExit(f"Cannot read pedal UI at {args.url}: {error}\nStart/retry the UI and check the URL.")

    gpio = initial.get("gpio", {})
    if gpio.get("status") != "ready":
        raise SystemExit(f"GPIO inputs are {gpio.get('status', 'unknown')}: {gpio.get('error') or 'check the UI connection status.'}")

    configured = {str(pedal.get("gpio")): pedal.get("name", pedal.get("id", "?"))
                  for pedal in initial.get("config", {}).get("switches", []) if pedal.get("gpio") is not None}
    pins = gpio.get("pins", [])
    levels = initial.get("levels", {})
    counts = Counter()
    previous = {str(pin["gpio"]): levels.get(str(pin["gpio"])) for pin in pins}
    print("Pedal GPIO monitor connected. Press a pedal until it clicks, release it, then repeat.")
    print("A pin passes identification input when this monitor sees two state changes on it.")
    print(f"Saved setup: {len(configured)} pedal(s). Monitoring {len(pins)} BCM inputs. Ctrl+C to stop.\n")
    for pin in pins:
        number = str(pin["gpio"])
        label = f"assigned to {configured[number]}" if number in configured else "unassigned"
        print(f"BCM {number:>2} · header {pin['header']:>2} · {label} · initial={'B' if previous[number] else 'A'}")
    print("\nWaiting for pedal changes…", flush=True)

    try:
        while True:
            state = read_state(args.url)
            if state.get("gpio", {}).get("status") != "ready":
                raise SystemExit(f"GPIO monitor stopped: {state.get('gpio', {}).get('error') or 'inputs unavailable'}")
            levels = state.get("levels", {})
            for pin in state.get("gpio", {}).get("pins", []):
                number = str(pin["gpio"])
                value = levels.get(number)
                if value is None or value == previous.get(number):
                    continue
                previous[number] = value
                counts[number] += 1
                label = f" · {configured[number]}" if number in configured else " · unassigned"
                result = "PASS: two changes seen" if counts[number] >= 2 else "press once more"
                print(f"BCM {number} / header {pin['header']}: {'B' if value else 'A'} "
                      f"({counts[number]} change{'s' if counts[number] != 1 else ''}){label} · {result}", flush=True)
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\nStopped. Change counts:")
        for number, count in sorted(counts.items(), key=lambda item: int(item[0])):
            pin = next(item for item in pins if str(item["gpio"]) == number)
            print(f"  BCM {number} / header {pin['header']}: {count} change(s)")
        silent = [str(pin["gpio"]) for pin in pins if not counts[str(pin["gpio"])] ]
        if silent:
            print("  No changes seen on: " + ", ".join(f"BCM {number}" for number in silent))


if __name__ == "__main__":
    main()
