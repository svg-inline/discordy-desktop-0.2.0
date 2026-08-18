export type ParsedInvite = {
  serverUrl: string;
  roomId: string;
  inviteToken: string;
};

const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{40,128}$/;

export function normalizeRoom(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 20);
}

export function createRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const alphabetLength = alphabet.length;
  const threshold = Math.floor(256 / alphabetLength) * alphabetLength;
  let output = '';
  while (output.length < 8) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    for (const value of bytes) {
      if (value >= threshold) continue;
      output += alphabet[value % alphabetLength];
      if (output.length === 8) break;
    }
  }
  return output;
}

function isLoopback(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

function normalizeServerUrl(raw: string) {
  let server: URL;
  try { server = new URL(raw); } catch { throw new Error('O convite não contém um servidor válido.'); }
  if (server.username || server.password || server.search || server.hash) throw new Error('Servidor do convite inválido.');
  if (server.pathname !== '/' && server.pathname !== '') throw new Error('Servidor do convite inválido.');
  if (server.protocol === 'https:') return server.origin;
  if (server.protocol === 'http:' && isLoopback(server.hostname)) return server.origin;
  throw new Error('Convites remotos precisam usar HTTPS.');
}

export function createInvite(serverUrl: string, roomId: string, inviteToken: string) {
  const base = normalizeServerUrl(serverUrl);
  if (!INVITE_TOKEN_RE.test(inviteToken)) throw new Error('Token de convite inválido.');
  const url = new URL(base);
  url.pathname = '/join';
  url.searchParams.set('room', normalizeRoom(roomId));
  url.searchParams.set('token', inviteToken);
  return url.toString();
}

export function parseInvite(raw: string): ParsedInvite {
  const value = raw.trim();
  if (!value) throw new Error('Cole um convite do Discordy.');
  if (value.length > 4096) throw new Error('Convite inválido.');

  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Convite inválido.'); }

  let serverUrl = '';
  let roomId = '';
  let inviteToken = '';

  if (url.protocol === 'discordy:') {
    if (url.hostname !== 'join' || url.username || url.password) throw new Error('Convite Discordy inválido.');
    const allowed = new Set(['server', 'room', 'token', 'v']);
    for (const key of url.searchParams.keys()) if (!allowed.has(key)) throw new Error('Convite contém parâmetros não suportados.');
    if ((url.searchParams.get('v') || '2') !== '2') throw new Error('Versão de convite não suportada.');
    serverUrl = url.searchParams.get('server') || '';
    roomId = url.searchParams.get('room') || '';
    inviteToken = url.searchParams.get('token') || '';
  } else if (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname))) {
    if (url.username || url.password || url.pathname !== '/join') throw new Error('Convite HTTP inválido.');
    serverUrl = url.origin;
    roomId = url.searchParams.get('room') || '';
    inviteToken = url.searchParams.get('token') || '';
  } else {
    throw new Error('Convites remotos precisam usar HTTPS.');
  }

  const room = normalizeRoom(roomId);
  if (!room) throw new Error('O convite não contém uma sala válida.');
  if (!INVITE_TOKEN_RE.test(inviteToken)) throw new Error('Este convite foi invalidado, expirou ou pertence a uma versão antiga do Discordy.');

  return { serverUrl: normalizeServerUrl(serverUrl), roomId: room, inviteToken };
}
