import { hex } from './sysex.js';

// Universal identity replies use either one or three manufacturer bytes.
// Capture the identifiers without assuming an amplifier's editor header.
export function parseIdentityReply(bytes) {
  if (!Array.isArray(bytes) && !ArrayBuffer.isView(bytes)) return null;
  const data = Array.from(bytes);
  if (![15, 17].includes(data.length) || data[0] !== 0xf0 || data.at(-1) !== 0xf7
    || data[1] !== 0x7e || data[3] !== 0x06 || data[4] !== 0x02
    || data.slice(1, -1).some(byte => !Number.isInteger(byte) || byte < 0 || byte > 0x7f)) return null;
  const manufacturerLength = data[5] === 0 ? 3 : 1;
  if (data.length !== 14 + manufacturerLength) return null;
  const offset = 5 + manufacturerLength;
  return { deviceId: data[2], manufacturerId: data.slice(5, offset),
    familyId: data.slice(offset, offset + 2), modelId: data.slice(offset + 2, offset + 4),
    softwareRevision: data.slice(offset + 4, offset + 8), raw: hex(data) };
}
