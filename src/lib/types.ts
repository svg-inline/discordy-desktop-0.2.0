export type PresenceState = 'online' | 'reconnecting' | 'disconnected';
export type InviteTtlMinutes = 15 | 30 | 60 | 360 | 1440;


export type ChatMessage = {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  sentAt: number;
};

export type PeerInfo = {
  peerId: string;
  name: string;
  isHost?: boolean;
  presence?: PresenceState;
};

export type ParticipantInfo = {
  peerId: string;
  name: string;
  isHost: boolean;
  presence: PresenceState;
};

export type RoomInfo = {
  roomId: string;
  name: string;
  maxParticipants: 2 | 3 | 4;
  locked: boolean;
  pinRequired: boolean;
  approvalRequired: boolean;
  inviteEnabled: boolean;
  inviteExpiresAt: number | null;
  inviteTtlMinutes: InviteTtlMinutes;
  hostPeerId: string | null;
};

export type JoinRequestInfo = {
  requestId: string;
  name: string;
};

export type MediaSource = 'microphone' | 'camera' | 'screen';

export type ScreenShareMetadata = {
  sourceName: string;
  sourceType: 'monitor' | 'window' | 'browser';
  preset: '720p30' | '1080p30' | '1080p60';
  targetWidth: number;
  targetHeight: number;
  targetFps: number;
  bitrateKbps: number;
  systemAudio: boolean;
};

export type MediaStateSignal = {
  source: MediaSource;
  active: boolean;
  trackId?: string | null;
  screen?: ScreenShareMetadata | null;
};

export type SignalPayload =
  | { description: RTCSessionDescriptionInit }
  | { candidate: RTCIceCandidateInit }
  | { media: MediaStateSignal };

export type ClientMessage =
  | {
      type: 'join';
      roomId: string;
      name: string;
      inviteToken?: string;
      pin?: string;
      hostSecret?: string;
      resumeToken?: string;
    }
  | { type: 'signal'; target: string; data: SignalPayload }
  | { type: 'room-update'; changes: { name?: string; maxParticipants?: number; locked?: boolean; approvalRequired?: boolean; pin?: string | null; inviteTtlMinutes?: InviteTtlMinutes } }
  | { type: 'kick'; peerId: string }
  | { type: 'join-decision'; requestId: string; approved: boolean }
  | { type: 'invite-regenerate' }
  | { type: 'invite-invalidate' }
  | { type: 'leave' };

export type ServerMessage =
  | { type: 'welcome'; peerId: string; roomId: string; peers: PeerInfo[]; room: RoomInfo; participants: ParticipantInfo[]; sessionToken: string }
  | { type: 'peer-joined'; peer: PeerInfo }
  | { type: 'peer-left'; peerId: string }
  | { type: 'participant-state'; participant: ParticipantInfo }
  | { type: 'room-state'; room: RoomInfo }
  | { type: 'join-pending'; requestId: string; roomName: string }
  | { type: 'join-request'; request: JoinRequestInfo }
  | { type: 'join-request-removed'; requestId: string }
  | { type: 'join-denied'; message: string }
  | { type: 'invite-updated'; enabled: boolean; inviteToken?: string; expiresAt?: number; reason?: 'expired' }
  | { type: 'kicked'; message: string }
  | { type: 'signal'; from: string; data: SignalPayload }
  | { type: 'error'; message: string; code?: string };

export type RemotePeer = PeerInfo & {
  stream: MediaStream;
  connectionState: RTCPeerConnectionState;
  media: Record<MediaSource, boolean>;
  mediaTrackIds: Partial<Record<MediaSource, string>>;
  screenShare: ScreenShareMetadata | null;
};
