import test from 'node:test';
import assert from 'node:assert/strict';
import {
  controllerEndpoint, defaultControllerUrl, FALLBACK_CONTROLLER_URL, normalizeControllerUrl,
} from '../ui/server-url.js';
import { apiBaseForRequestHost } from '../web/server-config.js';

test('normalizes Pi mDNS names and IP addresses to an HTTP origin', () => {
  assert.equal(normalizeControllerUrl('guitar-pedal.local:8080'), 'http://guitar-pedal.local:8080');
  assert.equal(normalizeControllerUrl('http://192.168.1.42:8080/'), 'http://192.168.1.42:8080');
  assert.equal(controllerEndpoint('192.168.1.42:8080', '/api/state'), 'http://192.168.1.42:8080/api/state');
});

test('rejects unsafe or malformed Pi addresses', () => {
  assert.throws(() => normalizeControllerUrl(''), /Enter the Raspberry Pi/);
  assert.throws(() => normalizeControllerUrl('ftp://device.local'), /HTTP or HTTPS/);
  assert.throws(() => normalizeControllerUrl('http://user:pass@device.local'), /credentials/);
  assert.throws(() => normalizeControllerUrl('http://device.local/path'), /without a path/);
});

test('the separate browser app defaults to the Pi mDNS server', () => {
  assert.equal(defaultControllerUrl(), FALLBACK_CONTROLLER_URL);
  assert.equal(defaultControllerUrl('http://stage-pedal.local:8080'), 'http://stage-pedal.local:8080');
  assert.equal(defaultControllerUrl('not a url/path'), FALLBACK_CONTROLLER_URL);
});

test('Pi-hosted frontend derives its API URL from the Android request hostname', () => {
  assert.equal(apiBaseForRequestHost('guitar-pedal.local:4173'), 'http://guitar-pedal.local:8080');
  assert.equal(apiBaseForRequestHost('192.168.1.42:4173'), 'http://192.168.1.42:8080');
  assert.equal(apiBaseForRequestHost('[fd00::42]:4173'), 'http://[fd00::42]:8080');
  assert.throws(() => apiBaseForRequestHost('example.com/path'), /Invalid request host/);
});
