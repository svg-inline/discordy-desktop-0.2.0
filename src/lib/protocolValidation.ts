import type { ParticipantInfo, PeerInfo, RoomInfo, ScreenShareMetadata, ServerMessage, SignalPayload } from './types';

export const MAX_SIGNALING_MESSAGE_BYTES = 96 * 1024;

const ID_RE = /^[A-Za-z0-9_-]{20,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{40,128}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{12,64}$/;
const ROOM_RE = /^[A-Z0-9_-]{1,20}$/;
const PRESENCE = new Set(['online', 'reconnecting', 'disconnected']);
const MEDIA_SOURCES = new Set(['microphone', 'camera', 'screen']);
const SCREEN_SOURCE_TYPES = new Set(['monitor', 'window', 'browser']);
const SCREEN_PRESETS = new Set(['720p30', '1080p30', '1080p60']);
const INVITE_TTLS = new Set([15, 30, 60, 360, 1440]);

function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('objeto esperado');
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[]) {
  const set = new Set(allowed);
  if (Object.keys(value).some((key) => !set.has(key))) throw new Error('campo não permitido');
}

function text(value: unknown, max: number, min = 0): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) throw new Error('texto inválido');
  return value;
}

function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('boolean inválido');
  return value;
}

function id(value: unknown): string {
  const result = text(value, 64, 20);
  if (!ID_RE.test(result)) throw new Error('ID inválido');
  return result;
}

function participant(value: unknown): ParticipantInfo {
  const item = plain(value);
  exactKeys(item, ['peerId', 'name', 'isHost', 'presence']);
  const presence = text(item.presence, 20);
  if (!PRESENCE.has(presence)) throw new Error('presence inválido');
  return { peerId: id(item.peerId), name: text(item.name, 40, 1), isHost: bool(item.isHost), presence: presence as ParticipantInfo['presence'] };
}

function peer(value: unknown): PeerInfo {
  const item = plain(value);
  exactKeys(item, ['peerId', 'name', 'isHost', 'presence']);
  const presenceValue = item.presence === undefined ? undefined : text(item.presence, 20);
  if (presenceValue !== undefined && !PRESENCE.has(presenceValue)) throw new Error('presence inválido');
  return {
    peerId: id(item.peerId),
    name: text(item.name, 40, 1),
    isHost: item.isHost === undefined ? undefined : bool(item.isHost),
    presence: presenceValue as PeerInfo['presence'],
  };
}

function room(value: unknown): RoomInfo {
  const item = plain(value);
  exactKeys(item, ['roomId', 'name', 'maxParticipants', 'locked', 'pinRequired', 'approvalRequired', 'inviteEnabled', 'inviteExpiresAt', 'inviteTtlMinutes', 'hostPeerId']);
  const roomId = text(item.roomId, 20, 1);
  if (!ROOM_RE.test(roomId)) throw new Error('roomId inválido');
  const limit = Number(item.maxParticipants);
  if (![2, 3, 4].includes(limit)) throw new Error('limite inválido');
  const ttl = Number(item.inviteTtlMinutes);
  if (!INVITE_TTLS.has(ttl)) throw new Error('TTL inválido');
  const expiresAt = item.inviteExpiresAt === null ? null : Number(item.inviteExpiresAt);
  if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= 0)) throw new Error('expiração inválida');
  const hostPeerId = item.hostPeerId === null ? null : id(item.hostPeerId);
  return {
    roomId,
    name: text(item.name, 60, 1),
    maxParticipants: limit as RoomInfo['maxParticipants'],
    locked: bool(item.locked),
    pinRequired: bool(item.pinRequired),
    approvalRequired: bool(item.approvalRequired),
    inviteEnabled: bool(item.inviteEnabled),
    inviteExpiresAt: expiresAt,
    inviteTtlMinutes: ttl as RoomInfo['inviteTtlMinutes'],
    hostPeerId,
  };
}

function screenMetadata(value: unknown): ScreenShareMetadata | null {
  if (value === null || value === undefined) return null;
  const item = plain(value);
  exactKeys(item, ['sourceName', 'sourceType', 'preset', 'targetWidth', 'targetHeight', 'targetFps', 'bitrateKbps', 'systemAudio']);
  const sourceType = text(item.sourceType, 20);
  const preset = text(item.preset, 20);
  if (!SCREEN_SOURCE_TYPES.has(sourceType) || !SCREEN_PRESETS.has(preset)) throw new Error('screen metadata inválido');
  const targetWidth = Number(item.targetWidth);
  const targetHeight = Number(item.targetHeight);
  const targetFps = Number(item.targetFps);
  const bitrateKbps = Number(item.bitrateKbps);
  if (!Number.isInteger(targetWidth) || targetWidth < 320 || targetWidth > 3840) throw new Error('width inválido');
  if (!Number.isInteger(targetHeight) || targetHeight < 180 || targetHeight > 2160) throw new Error('height inválido');
  if (![15, 24, 30, 60].includes(targetFps)) throw new Error('fps inválido');
  if (!Number.isInteger(bitrateKbps) || bitrateKbps < 250 || bitrateKbps > 25000) throw new Error('bitrate inválido');
  return {
    sourceName: text(item.sourceName, 160, 1),
    sourceType: sourceType as ScreenShareMetadata['sourceType'],
    preset: preset as ScreenShareMetadata['preset'],
    targetWidth,
    targetHeight,
    targetFps,
    bitrateKbps,
    systemAudio: bool(item.systemAudio),
  };
}

function signalPayload(value: unknown): SignalPayload {
  const item = plain(value);
  const keys = Object.keys(item);
  if (keys.length !== 1) throw new Error('signal ambíguo');
  if (Object.hasOwn(item, 'description')) {
    const description = plain(item.description);
    exactKeys(description, ['type', 'sdp']);
    const type = text(description.type, 16);
    if (type !== 'offer' && type !== 'answer') throw new Error('SDP type inválido');
    return { description: { type, sdp: text(description.sdp, 64 * 1024, 1) } };
  }
  if (Object.hasOwn(item, 'candidate')) {
    const candidate = plain(item.candidate);
    exactKeys(candidate, ['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment']);
    const sdpMLineIndex = candidate.sdpMLineIndex === null ? null : Number(candidate.sdpMLineIndex);
    if (sdpMLineIndex !== null && (!Number.isInteger(sdpMLineIndex) || sdpMLineIndex < 0 || sdpMLineIndex > 64)) throw new Error('mline inválido');
    return {
      candidate: {
        candidate: text(candidate.candidate, 4096),
        sdpMid: candidate.sdpMid === null ? null : text(candidate.sdpMid, 128),
        sdpMLineIndex,
        usernameFragment: candidate.usernameFragment === null || candidate.usernameFragment === undefined ? null : text(candidate.usernameFragment, 256),
      },
    };
  }
  if (Object.hasOwn(item, 'media')) {
    const media = plain(item.media);
    exactKeys(media, ['source', 'active', 'trackId', 'screen']);
    const source = text(media.source, 20);
    if (!MEDIA_SOURCES.has(source)) throw new Error('media source inválida');
    return {
      media: {
        source: source as 'microphone' | 'camera' | 'screen',
        active: bool(media.active),
        trackId: media.trackId === null || media.trackId === undefined ? null : text(media.trackId, 160),
        screen: source === 'screen' ? screenMetadata(media.screen) : null,
      },
    };
  }
  throw new Error('signal inválido');
}

export function parseServerMessage(raw: string): ServerMessage {
  if (new TextEncoder().encode(raw).byteLength > MAX_SIGNALING_MESSAGE_BYTES) throw new Error('mensagem do servidor excede o limite');
  const value = plain(JSON.parse(raw));
  const type = text(value.type, 40, 1);

  if (type === 'welcome') {
    exactKeys(value, ['type', 'peerId', 'roomId', 'peers', 'room', 'participants', 'sessionToken']);
    if (!Array.isArray(value.peers) || value.peers.length > 3 || !Array.isArray(value.participants) || value.participants.length > 4) throw new Error('lista de peers inválida');
    const roomId = text(value.roomId, 20, 1);
    if (!ROOM_RE.test(roomId)) throw new Error('sala inválida');
    const token = text(value.sessionToken, 128, 40);
    if (!TOKEN_RE.test(token)) throw new Error('token de sessão inválido');
    return { type, peerId: id(value.peerId), roomId, peers: value.peers.map(peer), room: room(value.room), participants: value.participants.map(participant), sessionToken: token };
  }
  if (type === 'peer-joined') { exactKeys(value, ['type', 'peer']); return { type, peer: peer(value.peer) }; }
  if (type === 'peer-left') { exactKeys(value, ['type', 'peerId']); return { type, peerId: id(value.peerId) }; }
  if (type === 'participant-state') { exactKeys(value, ['type', 'participant']); return { type, participant: participant(value.participant) }; }
  if (type === 'room-state') { exactKeys(value, ['type', 'room']); return { type, room: room(value.room) }; }
  if (type === 'join-pending') {
    exactKeys(value, ['type', 'requestId', 'roomName']);
    const requestId = text(value.requestId, 64, 12); if (!REQUEST_ID_RE.test(requestId)) throw new Error('request inválido');
    return { type, requestId, roomName: text(value.roomName, 60, 1) };
  }
  if (type === 'join-request') {
    exactKeys(value, ['type', 'request']);
    const request = plain(value.request); exactKeys(request, ['requestId', 'name']);
    const requestId = text(request.requestId, 64, 12); if (!REQUEST_ID_RE.test(requestId)) throw new Error('request inválido');
    return { type, request: { requestId, name: text(request.name, 40, 1) } };
  }
  if (type === 'join-request-removed') {
    exactKeys(value, ['type', 'requestId']);
    const requestId = text(value.requestId, 64, 12); if (!REQUEST_ID_RE.test(requestId)) throw new Error('request inválido');
    return { type, requestId };
  }
  if (type === 'join-denied') { exactKeys(value, ['type', 'message']); return { type, message: text(value.message, 500, 1) }; }
  if (type === 'invite-updated') {
    exactKeys(value, ['type', 'enabled', 'inviteToken', 'expiresAt', 'reason']);
    const enabled = bool(value.enabled);
    const inviteToken = value.inviteToken === undefined ? undefined : text(value.inviteToken, 128, 40);
    if (inviteToken !== undefined && !TOKEN_RE.test(inviteToken)) throw new Error('invite token inválido');
    const expiresAt = value.expiresAt === undefined ? undefined : Number(value.expiresAt);
    if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= 0)) throw new Error('expiração inválida');
    const reason = value.reason === undefined ? undefined : text(value.reason, 20);
    if (reason !== undefined && reason !== 'expired') throw new Error('motivo inválido');
    return { type, enabled, inviteToken, expiresAt, reason: reason as 'expired' | undefined };
  }
  if (type === 'kicked') { exactKeys(value, ['type', 'message']); return { type, message: text(value.message, 500, 1) }; }
  if (type === 'signal') { exactKeys(value, ['type', 'from', 'data']); return { type, from: id(value.from), data: signalPayload(value.data) }; }
  if (type === 'error') {
    exactKeys(value, ['type', 'message', 'code']);
    return { type, message: text(value.message, 500, 1), code: value.code === undefined ? undefined : text(value.code, 80) };
  }
  throw new Error('tipo de mensagem do servidor não suportado');
}
