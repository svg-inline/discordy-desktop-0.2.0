import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const MAX_SIGNALING_MESSAGE_BYTES = 96 * 1024;
export const DEFAULT_INVITE_TTL_MINUTES = 60;
export const ALLOWED_INVITE_TTL_MINUTES = Object.freeze([15, 30, 60, 360, 1440]);

const PEER_ID_RE = /^[A-Za-z0-9_-]{20,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{24,128}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{12,64}$/;
const ROOM_RE = /^[A-Z0-9_-]{1,20}$/;
const DESCRIPTION_TYPES = new Set(['offer', 'answer']);
const MEDIA_SOURCES = new Set(['microphone', 'camera', 'screen']);
const SCREEN_SOURCE_TYPES = new Set(['monitor', 'window', 'browser']);
const SCREEN_PRESETS = new Set(['720p30', '1080p30', '1080p60']);

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function randomId(bytes = 18) {
  return randomBytes(bytes).toString('base64url');
}

export function tokenDigest(token) {
  return createHash('sha256').update(String(token), 'utf8').digest();
}

export function tokenMatches(token, digest) {
  if (!digest || typeof token !== 'string' || !TOKEN_RE.test(token)) return false;
  const candidate = tokenDigest(token);
  return candidate.length === digest.length && timingSafeEqual(candidate, digest);
}

export function normalizeInviteTtl(value) {
  const parsed = Number(value ?? DEFAULT_INVITE_TTL_MINUTES);
  return ALLOWED_INVITE_TTL_MINUTES.includes(parsed) ? parsed : DEFAULT_INVITE_TTL_MINUTES;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function requirePlainObject(value, name) {
  if (!isPlainObject(value)) throw new Error(`${name} inválido.`);
  return value;
}

function requireString(value, name, { min = 0, max, pattern } = {}) {
  if (typeof value !== 'string') throw new Error(`${name} inválido.`);
  if (value.length < min || (max !== undefined && value.length > max) || (pattern && !pattern.test(value))) throw new Error(`${name} inválido.`);
  return value;
}

function optionalString(value, name, options = {}) {
  if (value === undefined) return undefined;
  return requireString(value, name, options);
}

function requireBoolean(value, name) {
  if (typeof value !== 'boolean') throw new Error(`${name} inválido.`);
  return value;
}

function validateDescription(value) {
  const description = requirePlainObject(value, 'SDP');
  if (!hasOnlyKeys(description, new Set(['type', 'sdp']))) throw new Error('SDP contém campos não permitidos.');
  if (!DESCRIPTION_TYPES.has(description.type)) throw new Error('Tipo SDP inválido.');
  requireString(description.sdp, 'SDP', { min: 1, max: 64 * 1024 });
  return { type: description.type, sdp: description.sdp };
}

function validateCandidate(value) {
  const candidate = requirePlainObject(value, 'ICE candidate');
  const allowed = new Set(['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment']);
  if (!hasOnlyKeys(candidate, allowed)) throw new Error('ICE candidate contém campos não permitidos.');
  const text = requireString(candidate.candidate, 'ICE candidate', { max: 4096 });
  const sdpMid = candidate.sdpMid === null || candidate.sdpMid === undefined ? null : requireString(candidate.sdpMid, 'sdpMid', { max: 128 });
  const sdpMLineIndex = candidate.sdpMLineIndex === null || candidate.sdpMLineIndex === undefined ? null : Number(candidate.sdpMLineIndex);
  if (sdpMLineIndex !== null && (!Number.isInteger(sdpMLineIndex) || sdpMLineIndex < 0 || sdpMLineIndex > 64)) throw new Error('sdpMLineIndex inválido.');
  const usernameFragment = candidate.usernameFragment === null || candidate.usernameFragment === undefined
    ? null
    : requireString(candidate.usernameFragment, 'usernameFragment', { max: 256 });
  return { candidate: text, sdpMid, sdpMLineIndex, usernameFragment };
}

function validateScreenMetadata(value) {
  if (value === null || value === undefined) return null;
  const screen = requirePlainObject(value, 'Metadados de tela');
  const allowed = new Set(['sourceName', 'sourceType', 'preset', 'targetWidth', 'targetHeight', 'targetFps', 'bitrateKbps', 'systemAudio']);
  if (!hasOnlyKeys(screen, allowed)) throw new Error('Metadados de tela contêm campos não permitidos.');
  const sourceName = requireString(screen.sourceName, 'Nome da fonte', { min: 1, max: 160 });
  if (!SCREEN_SOURCE_TYPES.has(screen.sourceType)) throw new Error('Tipo de fonte inválido.');
  if (!SCREEN_PRESETS.has(screen.preset)) throw new Error('Preset de tela inválido.');
  const targetWidth = Number(screen.targetWidth);
  const targetHeight = Number(screen.targetHeight);
  const targetFps = Number(screen.targetFps);
  const bitrateKbps = Number(screen.bitrateKbps);
  if (!Number.isInteger(targetWidth) || targetWidth < 320 || targetWidth > 3840) throw new Error('Largura de tela inválida.');
  if (!Number.isInteger(targetHeight) || targetHeight < 180 || targetHeight > 2160) throw new Error('Altura de tela inválida.');
  if (![15, 24, 30, 60].includes(targetFps)) throw new Error('FPS de tela inválido.');
  if (!Number.isInteger(bitrateKbps) || bitrateKbps < 250 || bitrateKbps > 25000) throw new Error('Bitrate de tela inválido.');
  requireBoolean(screen.systemAudio, 'Áudio do sistema');
  return { sourceName, sourceType: screen.sourceType, preset: screen.preset, targetWidth, targetHeight, targetFps, bitrateKbps, systemAudio: screen.systemAudio };
}

function validateMedia(value) {
  const media = requirePlainObject(value, 'Estado de mídia');
  const allowed = new Set(['source', 'active', 'trackId', 'screen']);
  if (!hasOnlyKeys(media, allowed)) throw new Error('Estado de mídia contém campos não permitidos.');
  if (!MEDIA_SOURCES.has(media.source)) throw new Error('Fonte de mídia inválida.');
  requireBoolean(media.active, 'Estado de mídia');
  const trackId = media.trackId === null || media.trackId === undefined ? null : requireString(media.trackId, 'Track ID', { max: 160 });
  const screen = media.source === 'screen' ? validateScreenMetadata(media.screen) : null;
  return { source: media.source, active: media.active, trackId, screen };
}

function validateSignalData(value) {
  const data = requirePlainObject(value, 'Payload de signaling');
  const keys = Object.keys(data);
  if (keys.length !== 1) throw new Error('Payload de signaling ambíguo.');
  if (Object.hasOwn(data, 'description')) return { description: validateDescription(data.description) };
  if (Object.hasOwn(data, 'candidate')) return { candidate: validateCandidate(data.candidate) };
  if (Object.hasOwn(data, 'media')) return { media: validateMedia(data.media) };
  throw new Error('Payload de signaling não suportado.');
}

export function validateClientMessage(input) {
  const message = requirePlainObject(input, 'Mensagem');
  const type = requireString(message.type, 'Tipo de mensagem', { min: 1, max: 40 });

  if (type === 'join') {
    if (!hasOnlyKeys(message, new Set(['type', 'roomId', 'name', 'inviteToken', 'pin', 'hostSecret', 'resumeToken']))) throw new Error('join contém campos não permitidos.');
    const roomId = requireString(message.roomId, 'Sala', { min: 1, max: 20, pattern: ROOM_RE });
    const name = requireString(message.name, 'Nome', { min: 1, max: 40 });
    const inviteToken = optionalString(message.inviteToken, 'Token de convite', { min: 24, max: 128, pattern: TOKEN_RE });
    const pin = optionalString(message.pin, 'PIN', { max: 12, pattern: /^\d{4,12}$/ });
    const hostSecret = optionalString(message.hostSecret, 'Credencial do host', { min: 24, max: 128, pattern: TOKEN_RE });
    const resumeToken = optionalString(message.resumeToken, 'Token de sessão', { min: 24, max: 128, pattern: TOKEN_RE });
    return { type, roomId, name, inviteToken, pin, hostSecret, resumeToken };
  }

  if (type === 'signal') {
    if (!hasOnlyKeys(message, new Set(['type', 'target', 'data']))) throw new Error('signal contém campos não permitidos.');
    const target = requireString(message.target, 'Peer alvo', { min: 20, max: 64, pattern: PEER_ID_RE });
    return { type, target, data: validateSignalData(message.data) };
  }

  if (type === 'room-update') {
    if (!hasOnlyKeys(message, new Set(['type', 'changes']))) throw new Error('room-update contém campos não permitidos.');
    const changes = requirePlainObject(message.changes, 'Alterações da sala');
    const allowed = new Set(['name', 'maxParticipants', 'locked', 'approvalRequired', 'pin', 'inviteTtlMinutes']);
    if (!hasOnlyKeys(changes, allowed) || Object.keys(changes).length === 0) throw new Error('Alterações da sala inválidas.');
    const normalized = {};
    if (Object.hasOwn(changes, 'name')) normalized.name = requireString(changes.name, 'Nome da sala', { min: 1, max: 60 });
    if (Object.hasOwn(changes, 'maxParticipants')) {
      const limit = Number(changes.maxParticipants);
      if (![2, 3, 4].includes(limit)) throw new Error('Limite de participantes inválido.');
      normalized.maxParticipants = limit;
    }
    if (Object.hasOwn(changes, 'locked')) normalized.locked = requireBoolean(changes.locked, 'Bloqueio da sala');
    if (Object.hasOwn(changes, 'approvalRequired')) normalized.approvalRequired = requireBoolean(changes.approvalRequired, 'Aprovação');
    if (Object.hasOwn(changes, 'pin')) {
      if (changes.pin !== null && changes.pin !== '') requireString(changes.pin, 'PIN', { max: 12, pattern: /^\d{4,12}$/ });
      normalized.pin = changes.pin ?? null;
    }
    if (Object.hasOwn(changes, 'inviteTtlMinutes')) normalized.inviteTtlMinutes = normalizeInviteTtl(changes.inviteTtlMinutes);
    return { type, changes: normalized };
  }

  if (type === 'kick') {
    if (!hasOnlyKeys(message, new Set(['type', 'peerId']))) throw new Error('kick contém campos não permitidos.');
    return { type, peerId: requireString(message.peerId, 'Peer ID', { min: 20, max: 64, pattern: PEER_ID_RE }) };
  }

  if (type === 'join-decision') {
    if (!hasOnlyKeys(message, new Set(['type', 'requestId', 'approved']))) throw new Error('join-decision contém campos não permitidos.');
    return {
      type,
      requestId: requireString(message.requestId, 'Request ID', { min: 12, max: 64, pattern: REQUEST_ID_RE }),
      approved: requireBoolean(message.approved, 'Decisão'),
    };
  }

  if (type === 'invite-regenerate' || type === 'invite-invalidate' || type === 'leave') {
    if (!hasOnlyKeys(message, new Set(['type']))) throw new Error(`${type} contém campos não permitidos.`);
    return { type };
  }

  throw new Error('Tipo de mensagem não suportado.');
}

export function getRawDataSize(raw) {
  if (typeof raw === 'string') return Buffer.byteLength(raw, 'utf8');
  if (Buffer.isBuffer(raw)) return raw.byteLength;
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  if (Array.isArray(raw)) return raw.reduce((total, item) => total + getRawDataSize(item), 0);
  return Buffer.byteLength(String(raw), 'utf8');
}

export function requestIdentity(req) {
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const remote = String(req.socket?.remoteAddress || 'unknown');
  const candidate = cf || forwarded || remote;
  return candidate.replace(/[^a-fA-F0-9:._-]/g, '').slice(0, 80) || 'unknown';
}

export class FixedWindowRateLimiter {
  constructor({ limit, windowMs, maxEntries = 2048 }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  consume(key, now = Date.now()) {
    let entry = this.entries.get(key);
    if (!entry || now - entry.startedAt >= this.windowMs) entry = { startedAt: now, count: 0 };
    entry.count += 1;
    this.entries.set(key, entry);
    if (this.entries.size > this.maxEntries) this.prune(now);
    const retryAfterMs = Math.max(0, this.windowMs - (now - entry.startedAt));
    return { allowed: entry.count <= this.limit, remaining: Math.max(0, this.limit - entry.count), retryAfterMs };
  }

  prune(now = Date.now()) {
    for (const [key, entry] of this.entries) {
      if (now - entry.startedAt >= this.windowMs * 2) this.entries.delete(key);
    }
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
  }
}

export class SocketRateLimiter {
  constructor() {
    this.states = new WeakMap();
  }

  consume(ws, bucket, { limit, windowMs }, now = Date.now()) {
    let state = this.states.get(ws);
    if (!state) {
      state = { violations: 0, buckets: new Map() };
      this.states.set(ws, state);
    }
    let entry = state.buckets.get(bucket);
    if (!entry || now - entry.startedAt >= windowMs) entry = { startedAt: now, count: 0 };
    entry.count += 1;
    state.buckets.set(bucket, entry);
    const allowed = entry.count <= limit;
    if (!allowed) state.violations += 1;
    return {
      allowed,
      violations: state.violations,
      retryAfterMs: Math.max(0, windowMs - (now - entry.startedAt)),
    };
  }
}
