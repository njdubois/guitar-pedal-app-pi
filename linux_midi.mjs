import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { choosePort, exchangeMidi } from './vendor/tone-lab/midi-common.js';

export class LinuxMidi extends EventEmitter {
  constructor({ python = process.env.PEDAL_PYTHON ?? 'python3', launch = spawn } = {}) {
    super();
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
    this.failure = null;
    this.child = launch(python, ['-u', fileURLToPath(new URL('./midi_bridge.py', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
      this.startTimer = setTimeout(() => this.fail(new Error('Python MIDI helper startup timed out.')), 10000);
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let event;
      try { event = JSON.parse(line); }
      catch { this.fail(new Error('Invalid JSON from the MIDI helper.')); return; }
      if (event.type === 'ready') { clearTimeout(this.startTimer); this.resolveReady(); }
      else if (event.type === 'message') this.emit('message', event.bytes);
      else if (event.type === 'result') {
        const pending = this.pending.get(event.id);
        if (pending) { clearTimeout(pending.timer); this.pending.delete(event.id); pending.resolve(event.data); }
      } else if (event.type === 'error') this.fail(new Error(event.message));
    });
    this.stderr = '';
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-2000); });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', code => { if (!this.closed) this.fail(new Error(`MIDI helper exited (${code}). ${this.stderr}`)); });
    this.child.stdin.on('error', error => { if (!this.closed) this.fail(error); });
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    clearTimeout(this.startTimer);
    this.rejectReady(error);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.emit('failure', error);
  }

  async request(op, data = {}) {
    await this.ready;
    if (this.failure || this.closed) throw this.failure ?? new Error('MIDI is closed.');
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`MIDI helper timed out during ${op}.`)), 6000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, op, ...data }) + '\n');
    });
  }

  async open(profile, { input, output } = {}) {
    const ports = await this.request('list');
    const selectedInput = choosePort(ports.inputs, input, 'input', profile.portMatcher);
    const selectedOutput = choosePort(ports.outputs, output, 'output', profile.portMatcher);
    await this.request('connect', { input: selectedInput.name, output: selectedOutput.name });
    this.ports = { input: selectedInput, output: selectedOutput };
    return this;
  }

  send(bytes) { return this.request('send', { bytes }); }
  exchange(bytes, predicate, timeout, options) { return exchangeMidi(this, bytes, predicate, timeout, options); }

  async close() {
    if (this.closed) return;
    try { if (!this.failure) await this.request('disconnect'); }
    finally {
      this.closed = true;
      this.fail(new Error('MIDI session closed.'));
      this.lines.close();
      this.child.stdin.end();
      this.child.kill();
    }
  }
}
