export const matchesMkiiiPort = port => /katana(?:[\s:_-]*(?:3|gen[\s:_-]*3|mk[\s:_-]*(?:iii|3)))\b/i.test(port.name)
  && !/katana[\s:_-]*go\b/i.test(port.name);
export const matchesMkiiPort = port => /katana/i.test(port.name)
  && !/katana[\s:_-]*go\b/i.test(port.name) && !matchesMkiiiPort(port);

export function choosePort(ports, selection, direction, matches = port => /katana/i.test(port.name)) {
  const available = ports.filter(port => !port.offline && port.state !== 'disconnected');
  if (selection) {
    const matches = available.filter(port => String(port.id) === String(selection) || port.name === selection);
    if (matches.length === 1) return matches[0];
    if (ports.some(port => (port.offline || port.state === 'disconnected') && (String(port.id) === String(selection) || port.name === selection))) {
      throw new Error(`The selected Katana MIDI ${direction} "${selection}" is offline. Reconnect and power on the amp.`);
    }
    throw new Error(`Cannot uniquely select MIDI ${direction} "${selection}". Select an exact name or ID.`);
  }
  const candidates = available.filter(port => matches(port) && !/daw/i.test(port.name));
  const preferred = candidates.filter(port => /ctrl/i.test(port.name));
  const choices = preferred.length ? preferred : candidates;
  if (choices.length === 1) return choices[0];
  throw new Error(choices.length ? `Multiple Katana ${direction}s found. Select an ${direction} port.`
    : `No Katana MIDI ${direction} found. Connect and power on the Katana, and check its BOSS USB driver.`);
}

export function exchangeMidi(transport, bytes, predicate, timeout = 4000, { signal } = {}) {
  if (transport.failure || transport.closed) return Promise.reject(transport.failure ?? new Error('MIDI connection is closed.'));
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); transport.off('message', message); transport.off('failure', failure); signal?.removeEventListener('abort', aborted); };
    const failure = error => { cleanup(); reject(error); };
    const aborted = () => failure(signal.reason);
    const message = incoming => {
      try {
        const result = predicate(incoming);
        if (result) { cleanup(); resolve(result); }
      } catch (error) { failure(error); }
    };
    const timer = setTimeout(() => transport.fail(new Error('KATANA NOT RESPONDING: no reply to the MIDI request. Check amp power, USB, selected ports, and close Tone Studio before retrying.')), timeout);
    transport.on('message', message);
    transport.on('failure', failure);
    signal?.addEventListener('abort', aborted, { once: true });
    transport.send(bytes).catch(failure);
  });
}
