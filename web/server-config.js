export function apiBaseForRequestHost(hostHeader, apiPort = 8080) {
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
    throw new Error('Invalid API port.');
  }
  const value = String(hostHeader || '').trim();
  if (!value) throw new Error('Missing request host.');
  const parsed = new URL(`http://${value}`);
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Invalid request host.');
  }
  let hostname = parsed.hostname;
  if (!hostname) throw new Error('Invalid request host.');
  if (hostname.includes(':') && !hostname.startsWith('[')) hostname = `[${hostname}]`;
  return `http://${hostname}:${apiPort}`;
}
