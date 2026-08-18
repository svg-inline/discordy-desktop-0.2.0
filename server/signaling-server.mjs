import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

export async function startSignalingServer({ host = '127.0.0.1', port = 0, maxParticipants = 4, logger = () => {} } = {}) {
  const rooms = new Map();
  const clients = new Map();

  function send(ws, payload) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  function cleanRoom(roomId) {
    return String(roomId || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 20);
  }

  function cleanName(name) {
    return String(name || '').trim().slice(0, 40);
  }

  function leave(ws) {
    const client = clients.get(ws);
    if (!client) return;

    const room = rooms.get(client.roomId);
    room?.delete(client.peerId);

    if (room) {
      for (const peer of room.values()) {
        send(peer.ws, { type: 'peer-left', peerId: client.peerId });
      }
      if (room.size === 0) rooms.delete(client.roomId);
    }

    clients.delete(ws);
    logger(`[leave] ${client.name} (${client.peerId.slice(0, 8)}) saiu de ${client.roomId}`);
  }

  function joinRoom(ws, roomIdRaw, nameRaw) {
    if (clients.has(ws)) {
      send(ws, { type: 'error', message: 'Você já entrou em uma sala.' });
      return;
    }

    const roomId = cleanRoom(roomIdRaw);
    const name = cleanName(nameRaw);
    if (!roomId || !name) {
      send(ws, { type: 'error', message: 'Sala ou nome inválido.' });
      return;
    }

    const room = rooms.get(roomId) || new Map();
    if (room.size >= maxParticipants) {
      send(ws, { type: 'error', message: `Sala cheia. Limite: ${maxParticipants} participantes.` });
      return;
    }

    const peerId = randomUUID();
    const peers = Array.from(room.values()).map(({ peerId: id, name: peerName }) => ({ peerId: id, name: peerName }));
    const client = { peerId, name, roomId, ws };

    room.set(peerId, client);
    rooms.set(roomId, room);
    clients.set(ws, client);

    send(ws, { type: 'welcome', peerId, roomId, peers });
    for (const peer of room.values()) {
      if (peer.peerId === peerId) continue;
      send(peer.ws, { type: 'peer-joined', peer: { peerId, name } });
    }

    logger(`[join] ${name} (${peerId.slice(0, 8)}) entrou em ${roomId} - ${room.size}/${maxParticipants}`);
  }

  function relaySignal(ws, target, data) {
    const client = clients.get(ws);
    if (!client || typeof target !== 'string' || !data || typeof data !== 'object') return;

    const room = rooms.get(client.roomId);
    const targetClient = room?.get(target);
    if (!targetClient) return;

    send(targetClient.ws, { type: 'signal', from: client.peerId, data });
  }

  function handleMessage(ws, raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: 'error', message: 'Mensagem inválida.' });
      return;
    }

    if (message.type === 'join') return joinRoom(ws, message.roomId, message.name);
    if (message.type === 'signal') return relaySignal(ws, message.target, message.data);
    if (message.type === 'leave') return leave(ws);
  }

  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (requestUrl.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, connections: clients.size, maxParticipants }));
      return;
    }

    if (requestUrl.pathname === '/join') {
      const room = cleanRoom(requestUrl.searchParams.get('room'));
      if (!room) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Convite Discordy inválido.');
        return;
      }

      const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
      const protocol = forwardedProto === 'https' ? 'https' : 'http';
      const hostHeader = String(req.headers.host || '').replace(/[^a-zA-Z0-9.:[\]-]/g, '');
      const publicBase = `${protocol}://${hostHeader}`;
      const deepLink = `discordy://join?server=${encodeURIComponent(publicBase)}&room=${encodeURIComponent(room)}&v=1`;

      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      });
      res.end(`<!doctype html>
<html lang="pt-BR">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Convite Discordy</title>
<style>body{font-family:system-ui;background:#0b0d12;color:#eef1f7;display:grid;place-items:center;min-height:100vh;margin:0}.card{max-width:460px;padding:32px;border:1px solid #2a3040;border-radius:18px;background:#141822;text-align:center}a{display:inline-block;margin-top:12px;padding:12px 18px;border-radius:10px;background:#5869e8;color:white;text-decoration:none;font-weight:700}p{color:#98a3b8;line-height:1.5}</style>
<div class="card"><h1>Convite Discordy</h1><p>Sala <strong>${room}</strong></p><p>Abra esta sala no aplicativo Discordy.</p><a href="${deepLink}">Abrir no Discordy</a></div>
</html>`);
      return;
    }

    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('Discordy signaling server');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (requestUrl.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => handleMessage(ws, raw));
    ws.on('close', () => leave(ws));
    ws.on('error', (error) => logger(`[ws] ${error.message}`));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        logger('[ws] conexão sem heartbeat; encerrando');
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* socket closing */ }
    }
  }, 20000);
  heartbeat.unref?.();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Não foi possível determinar a porta do signaling.');

  logger(`[server] signaling em http://${host}:${address.port}`);

  return {
    host,
    port: address.port,
    baseUrl: `http://${host}:${address.port}`,
    async close() {
      clearInterval(heartbeat);
      for (const ws of clients.keys()) {
        try { ws.close(); } catch { /* noop */ }
      }
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve) => server.close(() => resolve()));
      logger('[server] signaling encerrado');
    },
  };
}
