"""Idempotent dependency and local-file setup for start-ui.sh."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent


def run(*args):
    subprocess.run(args, check=True)


def ensure_python():
    requirements = ROOT / 'requirements.txt'
    stamp = ROOT / '.venv/.pedal-requirements'
    digest = hashlib.sha256(requirements.read_bytes() + sys.version.encode()).hexdigest()
    imports = ['gpiozero', 'mido', 'rtmidi', 'numpy']
    if sys.platform == 'linux':
        imports.append('lgpio')
    probe = subprocess.run([sys.executable, '-c', '; '.join(f'import {name}' for name in imports)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if stamp.exists() and stamp.read_text() == digest and probe.returncode == 0:
        return
    print('Installing Python dependencies...', flush=True)
    try:
        run(sys.executable, '-m', 'pip', 'install', '-r', str(requirements))
    except subprocess.CalledProcessError:
        if sys.platform != 'linux' or not shutil.which('apt-get'):
            raise RuntimeError('Install the platform C/C++ build tools and retry (on macOS: xcode-select --install).')
        prefix = [] if os.geteuid() == 0 else ['sudo']
        print('Installing Linux build dependencies; sudo may ask for your password.', flush=True)
        run(*prefix, 'apt-get', 'update')
        run(*prefix, 'apt-get', 'install', '-y', 'python3-dev', 'build-essential',
            'pkg-config', 'libasound2-dev', 'alsa-utils')
        run(sys.executable, '-m', 'pip', 'install', '-r', str(requirements))
    run(sys.executable, '-c', '; '.join(f'import {name}' for name in imports))
    stamp.write_text(digest)


def node_works():
    try:
        result = subprocess.run(['node', '-e',
            'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return result.returncode == 0
    except OSError:
        return False


def ensure_node():
    if node_works():
        return
    system = {'Linux': 'linux', 'Darwin': 'darwin'}.get(platform.system())
    arch = {'aarch64': 'arm64', 'arm64': 'arm64', 'x86_64': 'x64',
            'AMD64': 'x64', 'armv7l': 'armv7l'}.get(platform.machine())
    if not system or not arch:
        raise RuntimeError('Install Node.js 22.12 or newer for this platform and retry.')
    base = 'https://nodejs.org/dist/latest-v22.x/'
    print('Downloading a local Node.js 22 runtime...', flush=True)
    with urllib.request.urlopen(base + 'SHASUMS256.txt', timeout=60) as response:
        entries = [line.split() for line in response.read().decode().splitlines()]
    matches = [(digest, name) for digest, name in entries if name.endswith(f'-{system}-{arch}.tar.gz')]
    if len(matches) != 1:
        raise RuntimeError('No compatible Node.js archive found. Install Node.js 22.12+ and retry.')
    digest, name = matches[0]
    runtime = ROOT / '.runtime'
    runtime.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=runtime) as temporary:
        archive = Path(temporary) / name
        with urllib.request.urlopen(base + name, timeout=60) as response, archive.open('wb') as target:
            shutil.copyfileobj(response, target)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != digest:
            raise RuntimeError('Node.js download checksum mismatch; retry startup.')
        with tarfile.open(archive) as source:
            source.extractall(temporary, filter='data')
        destination = runtime / 'node'
        if destination.exists():
            shutil.rmtree(destination)
        (Path(temporary) / name.removesuffix('.tar.gz')).replace(destination)
    if not node_works():
        raise RuntimeError('Downloaded Node.js cannot run on this OS. Install a compatible Node.js 22.12+ and retry.')


def ensure_config(arguments):
    from pedal_controller import load_config
    path = ROOT / 'pedals.json'
    for index, value in enumerate(arguments):
        if value == '--config' and index + 1 < len(arguments):
            path = Path(arguments[index + 1]).resolve()
        elif value.startswith('--config='):
            path = Path(value.split('=', 1)[1]).resolve()
    if not path.exists():
        # Unassigned event actions allow first launch even without a tone library.
        document = {'version': 1, 'debounce_ms': 30, 'poll_ms': 5,
                    'amp': {'profile': 'go2', 'input': None, 'output': None},
                    'looper': {'host': '127.0.0.1', 'port': 9951, 'loop': 0},
                    'switches': [{'id': str(i), 'name': f'Pedal {i}', 'gpio': pin,
                                  'actions': [{'type': 'event', 'name': 'pedal.unassigned'}]}
                                 for i, pin in enumerate([17, 27, 22], 1)]}
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('x') as target:
            json.dump(document, target, indent=2)
            target.write('\n')
        print(f'Created starter setup: {path}', flush=True)
    load_config(path)
    for folder in ['tones/user', '.state']:
        (path.parent / folder).mkdir(parents=True, exist_ok=True)


def main():
    if sys.version_info < (3, 11):
        raise RuntimeError('Python 3.11 or newer is required. Use current Raspberry Pi OS or update Python.')
    ensure_python()
    ensure_node()
    ensure_config(sys.argv[1:])


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        sys.exit(f'Setup error: {error}')
