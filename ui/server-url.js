export const FALLBACK_CONTROLLER_URL = "http://guitar-pedal.local:8080";

export function normalizeControllerUrl(value) {
  const entered = String(value || "").trim();
  if (!entered) throw new Error("Enter the Raspberry Pi server URL.");
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(entered) ? entered : `http://${entered}`;
  let url;
  try { url = new URL(candidate); }
  catch { throw new Error("Enter a valid Raspberry Pi server URL."); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("The server URL must use HTTP or HTTPS.");
  if (url.username || url.password) throw new Error("Do not put credentials in the server URL.");
  if (url.pathname !== '/' || url.search || url.hash) throw new Error("Enter only the server origin, without a path or query.");
  return url.origin;
}

export function defaultControllerUrl(configured = globalThis.PEDAL_API_BASE) {
  if (configured) {
    try { return normalizeControllerUrl(configured); } catch {}
  }
  return FALLBACK_CONTROLLER_URL;
}

export function controllerEndpoint(controllerUrl, path) {
  return new URL(path, `${normalizeControllerUrl(controllerUrl)}/`).href;
}
