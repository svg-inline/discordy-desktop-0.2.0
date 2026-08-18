export type PeerInfo = {
  peerId: string;
  name: string;
};

export type MediaSource = 'microphone' | 'camera' | 'screen';

export type SignalPayload =
  | { description: RTCSessionDescriptionInit }
  | { candidate: RTCIceCandidateInit }
  | { media: { source: MediaSource; active: boolean } };

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
};
