export type ParsedInvite = {
  serverUrl: string;
  roomId: string;
};

export function normalizeRoom(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 20);
}

export function createRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join('');
}

export function createInvite(serverUrl: string, roomId: string) {
  const url = new URL(serverUrl);
  url.pathname = '/join';
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', normalizeRoom(roomId));
  return url.toString();
}

export function parseInvite(raw: string): ParsedInvite {
  const value = raw.trim();
  if (!value) throw new Error('Cole um convite do Discordy.');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Convite inválido.');
  }

  let serverUrl = '';
  let roomId = '';

  if (url.protocol === 'discordy:') {
    if (url.hostname !== 'join') throw new Error('Convite Discordy inválido.');
    serverUrl = url.searchParams.get('server') || '';
    roomId = url.searchParams.get('room') || '';
  } else if (url.protocol === 'https:' || url.protocol === 'http:') {
    serverUrl = url.origin;
    roomId = url.searchParams.get('room') || '';
  } else {
    throw new Error('O convite usa um protocolo não suportado.');
  }

  const room = normalizeRoom(roomId);
  if (!room) throw new Error('O convite não contém uma sala válida.');

  let server: URL;
  try {
    server = new URL(serverUrl);
  } catch {
    throw new Error('O convite não contém um servidor válido.');
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(server.protocol)) throw new Error('Servidor do convite inválido.');

  return { serverUrl: server.origin, roomId: room };
}
