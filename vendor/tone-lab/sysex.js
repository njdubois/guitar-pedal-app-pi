function sevenBit(bytes, label) {
  if (!Array.isArray(bytes) || bytes.some(b => !Number.isInteger(b) || b < 0 || b > 127)) {
    throw new Error(`${label} must contain 7-bit MIDI bytes.`);
  }
}

export const IDENTITY_REQUEST = [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7];
export const hex = bytes => bytes.map(b => b.toString(16).padStart(2, '0')).join(' ').toUpperCase();
export const checksum = bytes => (128 - bytes.reduce((sum, b) => sum + b, 0) % 128) % 128;

export function addressNumber(bytes) {
  sevenBit(bytes, 'Address');
  if (bytes.length !== 4) throw new Error('Address must contain four bytes.');
  return bytes.reduce((sum, b) => sum * 128 + b, 0);
}

export function toAddress(value) {
  if (!Number.isInteger(value) || value < 0 || value >= 128 ** 4) throw new Error('Address is out of range.');
  return [21, 14, 7, 0].map(shift => Math.floor(value / 2 ** shift) % 128);
}

function rolandMessage(modelId, deviceId, command, address, data) {
  sevenBit(modelId, 'Model ID');
  sevenBit([deviceId], 'Device ID');
  addressNumber(address);
  sevenBit(data, 'Data');
  if (!modelId.length || !data.length) throw new Error('Model ID and data must not be empty.');
  return [0xf0, 0x41, deviceId, ...modelId, command, ...address, ...data, checksum([...address, ...data]), 0xf7];
}

export const dt1 = (modelId, deviceId, address, data) => rolandMessage(modelId, deviceId, 0x12, address, data);
export const rq1 = (modelId, deviceId, address, size) => rolandMessage(modelId, deviceId, 0x11, address, toAddress(size));

export function parseDt1(bytes, profile, deviceId) {
  const header = [0xf0, 0x41, deviceId, ...profile.modelId, 0x12];
  if (bytes.length < header.length + 7 || header.some((b, i) => b !== bytes[i]) || bytes.at(-1) !== 0xf7) return null;
  const payload = bytes.slice(header.length, -2);
  if (payload.some(b => b < 0 || b > 127) || checksum(payload) !== bytes.at(-2)) return null;
  return { address: payload.slice(0, 4), data: payload.slice(4) };
}

export function parseIdentity(bytes, profile) {
  if (bytes.length !== 15 || bytes[0] !== 0xf0 || bytes[1] !== 0x7e || bytes[3] !== 0x06 || bytes[4] !== 0x02
    || bytes[5] !== 0x41 || bytes.at(-1) !== 0xf7 || bytes.slice(1, -1).some(b => b > 127 || b < 0)) return null;
  if (profile.identityFamily.some((b, i) => bytes[6 + i] !== b) || !profile.modelCodes.includes(bytes[10])) return null;
  return { deviceId: bytes[2], modelCode: bytes[10], raw: hex(bytes) };
}
