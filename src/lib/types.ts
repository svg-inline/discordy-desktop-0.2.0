export type PeerInfo = {
  peerId: string;
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
  | { type: 'join'; roomId: string; name: string }
  | { type: 'signal'; target: string; data: SignalPayload }
  | { type: 'leave' };

export type ServerMessage =
  | { type: 'welcome'; peerId: string; roomId: string; peers: PeerInfo[] }
  | { type: 'peer-joined'; peer: PeerInfo }
  | { type: 'peer-left'; peerId: string }
  | { type: 'signal'; from: string; data: SignalPayload }
  | { type: 'error'; message: string };

export type RemotePeer = PeerInfo & {
  stream: MediaStream;
  connectionState: RTCPeerConnectionState;
  media: Record<MediaSource, boolean>;
  mediaTrackIds: Partial<Record<MediaSource, string>>;
  screenShare: ScreenShareMetadata | null;
};
