import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  DEFAULT_INVITE_TTL_MINUTES,
  FixedWindowRateLimiter,
  MAX_SIGNALING_MESSAGE_BYTES,
  SocketRateLimiter,
  getRawDataSize,
  normalizeInviteTtl,
  randomId,
  randomToken,
  requestIdentity,
  tokenDigest,
  tokenMatches,
  validateClientMessage,
} from './security.mjs';

const RECONNECTING_AFTER_MS = 0;
const DISCONNECTED_AFTER_MS = 8000;
const REMOVE_AFTER_MS = 38000;
const JOIN_REQUEST_TIMEOUT_MS = 30000;


function hashPin(pin) {
  return createHash('sha256').update(String(pin)).digest();
}

function pinMatches(pin, digest) {
  if (!digest) return true;
  const candidate = hashPin(pin || '');
  return candidate.length === digest.length && timingSafeEqual(candidate, digest);
}

function cleanRoom(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 20);
}

function cleanName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 40);
}

function cleanRoomName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 60);
}

function cleanPin(value) {
  const pin = String(value || '').trim();
  if (!pin) return '';
  if (!/^\d{4,12}$/.test(pin)) throw new Error('O PIN deve conter de 4 a 12 números.');
  return pin;
}

function normalizeLimit(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 2 || parsed > 4) throw new Error('O limite deve ser entre 2 e 4 participantes.');
  return parsed;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function writeSecureHeaders(res, extra = {}) {
  const headers = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    ...extra,
  };
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
}

export async function startSignalingServer({ host = '127.0.0.1', port = 0, initialRoom, logger = () => {} } = {}) {
  const rooms = new Map();
  const clients = new Map();
  const pendingBySocket = new Map();
  const socketRateLimiter = new SocketRateLimiter();
  const connectionRateLimiter = new FixedWindowRateLimiter({ limit: 60, windowMs: 60_000, maxEntries: 512 });
  const httpInviteRateLimiter = new FixedWindowRateLimiter({ limit: 120, windowMs: 60_000, maxEntries: 512 });

  if (!initialRoom) throw new Error('A configuração inicial da sala é obrigatória.');

  const roomId = cleanRoom(initialRoom.roomId);
  const roomName = cleanRoomName(initialRoom.name);
  const maxParticipants = normalizeLimit(initialRoom.maxParticipants ?? 4);
  const pin = cleanPin(initialRoom.pin || '');
  if (!roomId || !roomName) throw new Error('Sala ou nome da sala inválido.');

  const initialInviteToken = randomToken(32);
  const initialHostSecret = randomToken(32);
  const inviteTtlMinutes = normalizeInviteTtl(initialRoom.inviteTtlMinutes ?? DEFAULT_INVITE_TTL_MINUTES);
  const room = {
    roomId,
    name: roomName,
    maxParticipants,
    locked: false,
    pinHash: pin ? hashPin(pin) : null,
    approvalRequired: Boolean(initialRoom.approvalRequired),
    inviteEnabled: true,
    inviteTokenDigest: tokenDigest(initialInviteToken),
    inviteTtlMinutes,
    inviteExpiresAt: Date.now() + inviteTtlMinutes * 60_000,
    inviteTimer: null,
    hostSecretDigest: tokenDigest(initialHostSecret),
    hostSecretConsumed: false,
    hostPeerId: null,
    participants: new Map(),
    pending: new Map(),
  };
  rooms.set(roomId, room);

  function send(ws, payload) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  function publicRoom(currentRoom) {
    const inviteActive = currentRoom.inviteEnabled && currentRoom.inviteExpiresAt > Date.now();
    return {
      roomId: currentRoom.roomId,
      name: currentRoom.name,
      maxParticipants: currentRoom.maxParticipants,
      locked: currentRoom.locked,
      pinRequired: Boolean(currentRoom.pinHash),
      approvalRequired: currentRoom.approvalRequired,
      inviteEnabled: inviteActive,
      inviteExpiresAt: inviteActive ? currentRoom.inviteExpiresAt : null,
      inviteTtlMinutes: currentRoom.inviteTtlMinutes,
      hostPeerId: currentRoom.hostPeerId,
    };
  }

  function publicParticipant(participant) {
    return {
      peerId: participant.peerId,
      name: participant.name,
      isHost: participant.isHost,
      presence: participant.presence,
    };
  }

  function participantList(currentRoom) {
    return [...currentRoom.participants.values()].map(publicParticipant);
  }

  function onlinePeers(currentRoom, exceptPeerId) {
    return [...currentRoom.participants.values()]
      .filter((participant) => participant.peerId !== exceptPeerId && participant.presence === 'online')
      .map(publicParticipant);
  }

  function broadcast(currentRoom, payload, exceptPeerId = null) {
    for (const participant of currentRoom.participants.values()) {
      if (participant.peerId === exceptPeerId || participant.presence !== 'online') continue;
      send(participant.ws, payload);
    }
  }

  function broadcastRoomState(currentRoom) {
    broadcast(currentRoom, { type: 'room-state', room: publicRoom(currentRoom) });
  }

  function notifyInviteExpired(currentRoom) {
    const hostParticipant = currentRoom.hostPeerId ? currentRoom.participants.get(currentRoom.hostPeerId) : null;
    if (hostParticipant?.presence === 'online' && hostParticipant.ws) send(hostParticipant.ws, { type: 'invite-updated', enabled: false, reason: 'expired' });
  }

  function scheduleInviteExpiry(currentRoom) {
    if (currentRoom.inviteTimer) clearTimeout(currentRoom.inviteTimer);
    currentRoom.inviteTimer = null;
    if (!currentRoom.inviteEnabled || currentRoom.inviteExpiresAt <= Date.now()) return;
    currentRoom.inviteTimer = setTimeout(() => {
      if (!currentRoom.inviteEnabled || currentRoom.inviteExpiresAt > Date.now()) return;
      invalidateInviteState(currentRoom);
      notifyInviteExpired(currentRoom);
      broadcastRoomState(currentRoom);
      logger(`[invite] convite expirou para ${currentRoom.roomId}`);
    }, Math.max(1, currentRoom.inviteExpiresAt - Date.now()));
    currentRoom.inviteTimer.unref?.();
  }

  function issueInvite(currentRoom) {
    const token = randomToken(32);
    currentRoom.inviteTokenDigest = tokenDigest(token);
    currentRoom.inviteEnabled = true;
    currentRoom.inviteExpiresAt = Date.now() + currentRoom.inviteTtlMinutes * 60_000;
    scheduleInviteExpiry(currentRoom);
    return { token, expiresAt: currentRoom.inviteExpiresAt };
  }

  function invalidateInviteState(currentRoom) {
    if (currentRoom.inviteTimer) clearTimeout(currentRoom.inviteTimer);
    currentRoom.inviteTimer = null;
    currentRoom.inviteEnabled = false;
    currentRoom.inviteTokenDigest = null;
    currentRoom.inviteExpiresAt = 0;
  }

  function isInviteValid(currentRoom, token) {
    if (!currentRoom.inviteEnabled || currentRoom.inviteExpiresAt <= Date.now()) {
      if (currentRoom.inviteEnabled) {
        invalidateInviteState(currentRoom);
        notifyInviteExpired(currentRoom);
        broadcastRoomState(currentRoom);
        logger(`[invite] convite expirou para ${currentRoom.roomId}`);
      }
      return false;
    }
    return tokenMatches(token, currentRoom.inviteTokenDigest);
  }

  scheduleInviteExpiry(room);

  function clearParticipantTimers(participant) {
    if (participant.disconnectedTimer) clearTimeout(participant.disconnectedTimer);
    if (participant.removeTimer) clearTimeout(participant.removeTimer);
    participant.disconnectedTimer = null;
    participant.removeTimer = null;
  }

  function notifyPendingRemoved(pending) {
    const hostParticipant = pending.room.hostPeerId ? pending.room.participants.get(pending.room.hostPeerId) : null;
    if (hostParticipant?.presence === 'online' && hostParticipant.ws) send(hostParticipant.ws, { type: 'join-request-removed', requestId: pending.requestId });
  }

  function cancelPendingForSocket(ws, reason = null) {
    const pending = pendingBySocket.get(ws);
    if (!pending) return;
    pendingBySocket.delete(ws);
    pending.room.pending.delete(pending.requestId);
    if (pending.timer) clearTimeout(pending.timer);
    notifyPendingRemoved(pending);
    if (reason) send(ws, { type: 'join-denied', message: reason });
  }

  function removeParticipant(currentRoom, participant, reason = 'left') {
    clearParticipantTimers(participant);
    if (participant.ws) clients.delete(participant.ws);
    currentRoom.participants.delete(participant.peerId);
    if (currentRoom.hostPeerId === participant.peerId) currentRoom.hostPeerId = null;
    broadcast(currentRoom, { type: 'peer-left', peerId: participant.peerId });
    broadcastRoomState(currentRoom);
    logger(`[leave] ${participant.name} (${participant.peerId.slice(0, 8)}) saiu de ${currentRoom.roomId} (${reason})`);
  }

  function markTransportLost(ws) {
    const participant = clients.get(ws);
    if (!participant) {
      cancelPendingForSocket(ws);
      return;
    }

    clients.delete(ws);
    if (participant.ws === ws) participant.ws = null;
    clearParticipantTimers(participant);
    participant.presence = 'reconnecting';
    broadcast(participant.room, { type: 'participant-state', participant: publicParticipant(participant) }, participant.peerId);
    logger(`[presence] ${participant.name} -> reconnecting`);

    participant.disconnectedTimer = setTimeout(() => {
      if (participant.presence !== 'reconnecting') return;
      participant.presence = 'disconnected';
      broadcast(participant.room, { type: 'participant-state', participant: publicParticipant(participant) }, participant.peerId);
      logger(`[presence] ${participant.name} -> disconnected`);
    }, Math.max(RECONNECTING_AFTER_MS, DISCONNECTED_AFTER_MS));
    participant.disconnectedTimer.unref?.();

    participant.removeTimer = setTimeout(() => {
      if (participant.presence === 'online') return;
      removeParticipant(participant.room, participant, 'reconnect-timeout');
    }, REMOVE_AFTER_MS);
    participant.removeTimer.unref?.();
  }

  function acceptJoin(ws, currentRoom, name, { isHost = false } = {}) {
    if (ws?.readyState !== WebSocket.OPEN) {
      logger(`[join] conexão fechada antes de concluir entrada de ${name}`);
      return null;
    }
    if (currentRoom.participants.size >= currentRoom.maxParticipants) {
      send(ws, { type: 'error', code: 'ROOM_FULL', message: `Sala cheia. Limite: ${currentRoom.maxParticipants} participantes.` });
      return null;
    }

    const peerId = randomId(18);
    const sessionToken = randomToken(32);
    const participant = {
      peerId,
      name,
      room: currentRoom,
      isHost,
      presence: 'online',
      sessionTokenDigest: tokenDigest(sessionToken),
      ws,
      disconnectedTimer: null,
      removeTimer: null,
    };

    if (isHost) currentRoom.hostPeerId = peerId;
    currentRoom.participants.set(peerId, participant);
    clients.set(ws, participant);

    const peer = publicParticipant(participant);
    send(ws, {
      type: 'welcome',
      peerId,
      roomId: currentRoom.roomId,
      peers: onlinePeers(currentRoom, peerId),
      room: publicRoom(currentRoom),
      participants: participantList(currentRoom),
      sessionToken,
    });
    broadcast(currentRoom, { type: 'peer-joined', peer }, peerId);
    broadcastRoomState(currentRoom);
    logger(`[join] ${name} (${peerId.slice(0, 8)}) entrou em ${currentRoom.roomId} - ${currentRoom.participants.size}/${currentRoom.maxParticipants}${isHost ? ' [HOST]' : ''}`);
    return participant;
  }

  function tryResume(ws, currentRoom, resumeToken) {
    if (!resumeToken) return false;
    const participant = [...currentRoom.participants.values()].find((candidate) => tokenMatches(resumeToken, candidate.sessionTokenDigest));
    if (!participant) return false;

    clearParticipantTimers(participant);
    if (participant.ws && participant.ws !== ws) {
      clients.delete(participant.ws);
      try { participant.ws.close(4001, 'session-resumed-elsewhere'); } catch { /* noop */ }
    }
    const nextSessionToken = randomToken(32);
    participant.sessionTokenDigest = tokenDigest(nextSessionToken);
    participant.ws = ws;
    participant.presence = 'online';
    clients.set(ws, participant);

    send(ws, {
      type: 'welcome',
      peerId: participant.peerId,
      roomId: currentRoom.roomId,
      peers: onlinePeers(currentRoom, participant.peerId),
      room: publicRoom(currentRoom),
      participants: participantList(currentRoom),
      sessionToken: nextSessionToken,
    });
    broadcast(currentRoom, { type: 'participant-state', participant: publicParticipant(participant) }, participant.peerId);
    logger(`[resume] ${participant.name} (${participant.peerId.slice(0, 8)}) retomou ${currentRoom.roomId}; token de sessão rotacionado`);
    return true;
  }

  function joinRoom(ws, message) {
    if (clients.has(ws) || pendingBySocket.has(ws)) {
      send(ws, { type: 'error', code: 'ALREADY_JOINED', message: 'Você já entrou ou está aguardando entrada em uma sala.' });
      return;
    }

    const requestedRoomId = cleanRoom(message.roomId);
    const name = cleanName(message.name);
    const currentRoom = rooms.get(requestedRoomId);
    if (!currentRoom || !name) {
      send(ws, { type: 'error', code: 'INVALID_ROOM', message: 'Sala ou nome inválido.' });
      return;
    }

    if (tryResume(ws, currentRoom, String(message.resumeToken || ''))) return;

    const isHost = Boolean(!currentRoom.hostSecretConsumed && message.hostSecret && tokenMatches(message.hostSecret, currentRoom.hostSecretDigest));
    if (isHost) {
      if (currentRoom.hostPeerId && currentRoom.participants.has(currentRoom.hostPeerId)) {
        send(ws, { type: 'error', code: 'HOST_EXISTS', message: 'O host desta sala já está conectado.' });
        return;
      }
      const joined = acceptJoin(ws, currentRoom, name, { isHost: true });
      if (joined) {
        currentRoom.hostSecretConsumed = true;
        currentRoom.hostSecretDigest = null;
      }
      return;
    }

    if (!message.inviteToken || !isInviteValid(currentRoom, message.inviteToken)) {
      send(ws, { type: 'error', code: currentRoom.inviteEnabled ? 'INVALID_INVITE' : 'INVITE_EXPIRED', message: 'Este convite expirou, foi invalidado ou foi substituído. Solicite um novo convite ao host.' });
      return;
    }
    if (currentRoom.locked) {
      send(ws, { type: 'error', code: 'ROOM_LOCKED', message: 'A entrada nesta sala está bloqueada pelo host.' });
      return;
    }
    if (currentRoom.participants.size >= currentRoom.maxParticipants) {
      send(ws, { type: 'error', code: 'ROOM_FULL', message: `Sala cheia. Limite: ${currentRoom.maxParticipants} participantes.` });
      return;
    }
    if (currentRoom.pinHash && !pinMatches(message.pin, currentRoom.pinHash)) {
      send(ws, { type: 'error', code: message.pin ? 'INVALID_PIN' : 'PIN_REQUIRED', message: message.pin ? 'PIN incorreto.' : 'Esta sala exige um PIN.' });
      return;
    }

    if (!currentRoom.approvalRequired) {
      acceptJoin(ws, currentRoom, name);
      return;
    }

    const hostParticipant = currentRoom.hostPeerId ? currentRoom.participants.get(currentRoom.hostPeerId) : null;
    if (!hostParticipant || hostParticipant.presence !== 'online' || !hostParticipant.ws) {
      send(ws, { type: 'error', code: 'HOST_UNAVAILABLE', message: 'O host não está disponível para aprovar sua entrada.' });
      return;
    }

    const requestId = randomId(18);
    const pending = { requestId, name, ws, room: currentRoom, timer: null };
    pending.timer = setTimeout(() => {
      if (!currentRoom.pending.has(requestId)) return;
      currentRoom.pending.delete(requestId);
      pendingBySocket.delete(ws);
      notifyPendingRemoved(pending);
      send(ws, { type: 'join-denied', message: 'A solicitação de entrada expirou.' });
    }, JOIN_REQUEST_TIMEOUT_MS);
    pending.timer.unref?.();
    currentRoom.pending.set(requestId, pending);
    pendingBySocket.set(ws, pending);
    send(ws, { type: 'join-pending', requestId, roomName: currentRoom.name });
    send(hostParticipant.ws, { type: 'join-request', request: { requestId, name } });
    logger(`[approval] ${name} aguarda aprovação em ${currentRoom.roomId}`);
  }

  function relaySignal(ws, target, data) {
    const client = clients.get(ws);
    if (!client || target === client.peerId) return;
    const targetClient = client.room.participants.get(target);
    if (!targetClient || targetClient.room !== client.room || targetClient.presence !== 'online' || !targetClient.ws) {
      send(ws, { type: 'error', code: 'INVALID_SIGNAL_TARGET', message: 'Destino de signaling inválido.' });
      return;
    }
    // O campo `from` é sempre atribuído pelo servidor a partir da sessão autenticada.
    send(targetClient.ws, { type: 'signal', from: client.peerId, data });
  }

  function requireHost(ws) {
    const client = clients.get(ws);
    if (!client || !client.isHost || client.room.hostPeerId !== client.peerId) {
      send(ws, { type: 'error', code: 'HOST_ONLY', message: 'Apenas o host pode executar esta ação.' });
      return null;
    }
    return client;
  }

  function updateRoom(ws, changes) {
    const hostClient = requireHost(ws);
    if (!hostClient || !changes || typeof changes !== 'object') return;
    const currentRoom = hostClient.room;

    try {
      if (Object.hasOwn(changes, 'name')) {
        const nextName = cleanRoomName(changes.name);
        if (!nextName) throw new Error('Informe um nome válido para a sala.');
        currentRoom.name = nextName;
      }
      if (Object.hasOwn(changes, 'maxParticipants')) {
        const nextLimit = normalizeLimit(changes.maxParticipants);
        if (nextLimit < currentRoom.participants.size) throw new Error(`Há ${currentRoom.participants.size} participantes reservados na sala. O limite não pode ser menor.`);
        currentRoom.maxParticipants = nextLimit;
      }
      if (Object.hasOwn(changes, 'locked')) currentRoom.locked = Boolean(changes.locked);
      if (Object.hasOwn(changes, 'approvalRequired')) currentRoom.approvalRequired = Boolean(changes.approvalRequired);
      if (Object.hasOwn(changes, 'pin')) {
        const nextPin = cleanPin(changes.pin || '');
        currentRoom.pinHash = nextPin ? hashPin(nextPin) : null;
      }
      if (Object.hasOwn(changes, 'inviteTtlMinutes')) {
        currentRoom.inviteTtlMinutes = normalizeInviteTtl(changes.inviteTtlMinutes);
        if (currentRoom.inviteEnabled) {
          const nextInvite = issueInvite(currentRoom);
          send(ws, { type: 'invite-updated', enabled: true, inviteToken: nextInvite.token, expiresAt: nextInvite.expiresAt });
        }
      }
      broadcastRoomState(currentRoom);
      logger(`[room] ${currentRoom.roomId} atualizada por ${hostClient.name}`);
    } catch (error) {
      send(ws, { type: 'error', code: 'ROOM_UPDATE_FAILED', message: error instanceof Error ? error.message : String(error) });
    }
  }

  function kickParticipant(ws, peerId) {
    const hostClient = requireHost(ws);
    if (!hostClient) return;
    const target = hostClient.room.participants.get(String(peerId || ''));
    if (!target || target.isHost) {
      send(ws, { type: 'error', code: 'INVALID_KICK', message: 'Participante inválido para expulsão.' });
      return;
    }
    if (target.ws) send(target.ws, { type: 'kicked', message: `Você foi removido da sala por ${hostClient.name}.` });
    const socket = target.ws;
    removeParticipant(hostClient.room, target, 'kicked');
    if (socket) setTimeout(() => { try { socket.close(4003, 'kicked'); } catch { /* noop */ } }, 20);
  }

  function decideJoin(ws, requestId, approved) {
    const hostClient = requireHost(ws);
    if (!hostClient) return;
    const pending = hostClient.room.pending.get(String(requestId || ''));
    if (!pending) {
      send(ws, { type: 'error', code: 'REQUEST_NOT_FOUND', message: 'Esta solicitação de entrada não está mais disponível.' });
      return;
    }
    hostClient.room.pending.delete(pending.requestId);
    pendingBySocket.delete(pending.ws);
    if (pending.timer) clearTimeout(pending.timer);

    if (!approved) {
      send(pending.ws, { type: 'join-denied', message: 'O host recusou sua entrada na sala.' });
      logger(`[approval] ${pending.name} recusado em ${hostClient.room.roomId}`);
      return;
    }
    if (hostClient.room.participants.size >= hostClient.room.maxParticipants) {
      send(pending.ws, { type: 'join-denied', message: 'A sala ficou cheia antes da aprovação.' });
      return;
    }
    acceptJoin(pending.ws, hostClient.room, pending.name);
    logger(`[approval] ${pending.name} aprovado em ${hostClient.room.roomId}`);
  }

  function regenerateInvite(ws) {
    const hostClient = requireHost(ws);
    if (!hostClient) return;
    const nextInvite = issueInvite(hostClient.room);
    send(ws, { type: 'invite-updated', enabled: true, inviteToken: nextInvite.token, expiresAt: nextInvite.expiresAt });
    broadcastRoomState(hostClient.room);
    logger(`[invite] convite regenerado para ${hostClient.room.roomId}`);
  }

  function invalidateInvite(ws) {
    const hostClient = requireHost(ws);
    if (!hostClient) return;
    invalidateInviteState(hostClient.room);
    send(ws, { type: 'invite-updated', enabled: false });
    broadcastRoomState(hostClient.room);
    logger(`[invite] convite invalidado para ${hostClient.room.roomId}`);
  }

  function explicitLeave(ws) {
    const participant = clients.get(ws);
    if (!participant) {
      cancelPendingForSocket(ws);
      return;
    }
    clients.delete(ws);
    participant.ws = null;
    removeParticipant(participant.room, participant, 'explicit-leave');
  }

  function rejectRateLimit(ws, bucket, retryAfterMs, violations) {
    send(ws, { type: 'error', code: 'RATE_LIMITED', message: `Muitas mensagens (${bucket}). Tente novamente em ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s.` });
    if (violations >= 4) {
      logger(`[security] WebSocket encerrado por abuso de rate limit (${bucket})`);
      try { ws.close(4008, 'rate-limit'); } catch { /* noop */ }
    }
  }

  function consumeMessageRate(ws, messageType) {
    const general = socketRateLimiter.consume(ws, 'general', { limit: 300, windowMs: 10_000 });
    if (!general.allowed) {
      rejectRateLimit(ws, 'geral', general.retryAfterMs, general.violations);
      return false;
    }
    const policy = messageType === 'signal'
      ? { bucket: 'signal', limit: 240, windowMs: 10_000 }
      : messageType === 'join'
        ? { bucket: 'join', limit: 8, windowMs: 60_000 }
        : { bucket: 'control', limit: 40, windowMs: 60_000 };
    const result = socketRateLimiter.consume(ws, policy.bucket, policy);
    if (!result.allowed) {
      rejectRateLimit(ws, policy.bucket, result.retryAfterMs, result.violations);
      return false;
    }
    return true;
  }

  function handleMessage(ws, raw) {
    const size = getRawDataSize(raw);
    if (size > MAX_SIGNALING_MESSAGE_BYTES) {
      logger(`[security] payload WebSocket rejeitado: ${size} bytes`);
      try { ws.close(1009, 'message-too-large'); } catch { /* noop */ }
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: 'error', code: 'INVALID_MESSAGE', message: 'JSON inválido.' });
      return;
    }

    let message;
    try {
      message = validateClientMessage(parsed);
    } catch (error) {
      send(ws, { type: 'error', code: 'INVALID_MESSAGE', message: error instanceof Error ? error.message : 'Mensagem inválida.' });
      return;
    }

    if (!consumeMessageRate(ws, message.type)) return;

    if (message.type === 'join') return joinRoom(ws, message);
    if (message.type === 'signal') return relaySignal(ws, message.target, message.data);
    if (message.type === 'room-update') return updateRoom(ws, message.changes);
    if (message.type === 'kick') return kickParticipant(ws, message.peerId);
    if (message.type === 'join-decision') return decideJoin(ws, message.requestId, message.approved);
    if (message.type === 'invite-regenerate') return regenerateInvite(ws);
    if (message.type === 'invite-invalidate') return invalidateInvite(ws);
    if (message.type === 'leave') return explicitLeave(ws);
  }

  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (requestUrl.pathname === '/health') {
      writeSecureHeaders(res, { 'content-type': 'application/json; charset=utf-8' });
      res.writeHead(200);
      res.end(JSON.stringify({
        ok: true,
        rooms: rooms.size,
        connections: clients.size,
      }));
      return;
    }

    if (requestUrl.pathname === '/join') {
      const identity = requestIdentity(req);
      const inviteRate = httpInviteRateLimiter.consume(identity);
      if (!inviteRate.allowed) {
        writeSecureHeaders(res, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': String(Math.max(1, Math.ceil(inviteRate.retryAfterMs / 1000))) });
        res.writeHead(429);
        res.end('Muitas tentativas. Tente novamente mais tarde.');
        return;
      }
      const requestedRoom = cleanRoom(requestUrl.searchParams.get('room'));
      const token = String(requestUrl.searchParams.get('token') || '');
      const targetRoom = rooms.get(requestedRoom);
      if (!targetRoom || !isInviteValid(targetRoom, token)) {
        writeSecureHeaders(res, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
        res.writeHead(410);
        res.end('<!doctype html><meta charset="utf-8"><title>Convite inválido</title><style>body{font-family:system-ui;background:#0b0d12;color:#eef1f7;display:grid;place-items:center;min-height:100vh;margin:0}.card{max-width:460px;padding:32px;border:1px solid #2a3040;border-radius:18px;background:#141822;text-align:center}p{color:#98a3b8}</style><div class="card"><h1>Convite inválido</h1><p>Este convite expirou ou foi substituído pelo host.</p></div>');
        return;
      }

      const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
      const protocol = forwardedProto === 'https' ? 'https' : 'http';
      const hostHeader = String(req.headers.host || '').replace(/[^a-zA-Z0-9.:[\]-]/g, '');
      const publicBase = `${protocol}://${hostHeader}`;
      const deepLink = `discordy://join?server=${encodeURIComponent(publicBase)}&room=${encodeURIComponent(targetRoom.roomId)}&token=${encodeURIComponent(token)}&v=2`;

      writeSecureHeaders(res, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      res.writeHead(200);
      res.end(`<!doctype html>
<html lang="pt-BR">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Convite Discordy</title>
<style>body{font-family:system-ui;background:#0b0d12;color:#eef1f7;display:grid;place-items:center;min-height:100vh;margin:0}.card{max-width:460px;padding:32px;border:1px solid #2a3040;border-radius:18px;background:#141822;text-align:center}a{display:inline-block;margin-top:12px;padding:12px 18px;border-radius:10px;background:#5869e8;color:white;text-decoration:none;font-weight:700}p{color:#98a3b8;line-height:1.5}.meta{font-size:13px}</style>
<div class="card"><h1>${escapeHtml(targetRoom.name)}</h1><p class="meta">Sala ${escapeHtml(targetRoom.roomId)} · ${targetRoom.participants.size}/${targetRoom.maxParticipants}</p><p>Abra este convite no aplicativo Discordy.${targetRoom.pinHash ? ' O PIN será solicitado no aplicativo.' : ''}</p><a href="${deepLink}">Abrir no Discordy</a></div>
</html>`);
      return;
    }

    writeSecureHeaders(res, { 'content-type': 'text/plain; charset=utf-8' });
    res.writeHead(200);
    res.end('Discordy signaling server');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_SIGNALING_MESSAGE_BYTES, perMessageDeflate: false });

  server.on('upgrade', (req, socket, head) => {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (requestUrl.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const identity = requestIdentity(req);
    const connectionRate = connectionRateLimiter.consume(identity);
    if (!connectionRate.allowed) {
      logger(`[security] upgrade WebSocket limitado para ${identity}`);
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nRetry-After: 60\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.securityIdentity = identity;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    logger(`[security] WebSocket aceito de ${ws.securityIdentity || 'unknown'}`);
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => handleMessage(ws, raw));
    ws.on('close', () => markTransportLost(ws));
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
    roomId: room.roomId,
    roomName: room.name,
    maxParticipants: room.maxParticipants,
    hostSecret: initialHostSecret,
    inviteToken: initialInviteToken,
    inviteExpiresAt: room.inviteExpiresAt,
    async close() {
      clearInterval(heartbeat);
      if (room.inviteTimer) clearTimeout(room.inviteTimer);
      for (const pending of room.pending.values()) if (pending.timer) clearTimeout(pending.timer);
      for (const participant of room.participants.values()) clearParticipantTimers(participant);
      for (const ws of wss.clients) {
        try { ws.close(); } catch { /* noop */ }
      }
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve) => server.close(() => resolve()));
      logger('[server] signaling encerrado');
    },
  };
}
