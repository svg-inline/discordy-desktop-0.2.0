import type { MediaSource, PeerInfo, RemotePeer, SignalPayload } from '../lib/types';
import { collectPeerDiagnostics } from './diagnostics';
import type { PeerDiagnostics } from './diagnostics';

type SenderSlots = {
  microphone?: RTCRtpSender;
  camera?: RTCRtpSender;
  screenVideo?: RTCRtpSender;
  screenAudio?: RTCRtpSender;
};

type PeerState = {
  info: PeerInfo;
  pc: RTCPeerConnection;
  remoteStream: MediaStream;
  pendingCandidates: RTCIceCandidateInit[];
  senders: SenderSlots;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  polite: boolean;
  restartAttempts: number;
  disconnectedTimer: number | null;
  recoveryTimer: number | null;
  media: Record<MediaSource, boolean>;
};

type PeerManagerOptions = {
  iceServers: RTCIceServer[];
  sendSignal: (target: string, data: SignalPayload) => boolean;
  onPeersChanged: (peers: RemotePeer[]) => void;
  onLog?: (message: string) => void;
};

const MAX_ICE_RESTART_ATTEMPTS = 3;
const DISCONNECTED_RESTART_DELAY_MS = 3500;

export class PeerManager {
  private readonly peers = new Map<string, PeerState>();
  private readonly iceServers: RTCIceServer[];
  private readonly sendSignal: PeerManagerOptions['sendSignal'];
  private readonly onPeersChanged: PeerManagerOptions['onPeersChanged'];
  private readonly onLog: NonNullable<PeerManagerOptions['onLog']>;

  private localPeerId: string | null = null;
  private microphoneStream: MediaStream | null = null;
  private cameraStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private microphoneEnabled = true;

  constructor(options: PeerManagerOptions) {
    this.iceServers = options.iceServers;
    this.sendSignal = options.sendSignal;
    this.onPeersChanged = options.onPeersChanged;
    this.onLog = options.onLog ?? (() => undefined);
  }

  setLocalPeerId(peerId: string | null) {
    this.localPeerId = peerId;
  }

  setMicrophone(stream: MediaStream | null) {
    this.microphoneStream = stream;
    for (const state of this.peers.values()) this.syncLocalMedia(state);
    this.broadcastMediaState('microphone', Boolean(stream) && this.microphoneEnabled);
  }

  setMicrophoneEnabled(enabled: boolean) {
    this.microphoneEnabled = enabled;
    for (const track of this.microphoneStream?.getAudioTracks() ?? []) track.enabled = enabled;
    this.broadcastMediaState('microphone', Boolean(this.microphoneStream) && enabled);
    this.logAll(`microfone ${enabled ? 'ativado' : 'silenciado'}`);
  }

  setCamera(stream: MediaStream | null) {
    this.cameraStream = stream;
    for (const state of this.peers.values()) this.syncLocalMedia(state);
    this.broadcastMediaState('camera', Boolean(stream));
  }

  setScreen(stream: MediaStream | null) {
    this.screenStream = stream;
    for (const state of this.peers.values()) this.syncLocalMedia(state);
    this.broadcastMediaState('screen', Boolean(stream));
    this.logAll(`compartilhamento de tela ${stream ? 'iniciado' : 'encerrado'}`);
  }

  createPeer(info: PeerInfo): void {
    const existing = this.peers.get(info.peerId);
    if (existing) {
      existing.info = info;
      this.emitPeers();
      return;
    }

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const polite = this.localPeerId ? this.localPeerId.localeCompare(info.peerId) > 0 : false;
    const state: PeerState = {
      info,
      pc,
      remoteStream: new MediaStream(),
      pendingCandidates: [],
      senders: {},
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      polite,
      restartAttempts: 0,
      disconnectedTimer: null,
      recoveryTimer: null,
      media: { microphone: true, camera: false, screen: false },
    };

    this.peers.set(info.peerId, state);
    this.bindPeerEvents(state);
    this.syncLocalMedia(state);
    this.sendCurrentMediaState(info.peerId);
    this.log(info.peerId, `peer criado (${polite ? 'polite' : 'impolite'})`);
    this.emitPeers();
  }

  removePeer(peerId: string, reason = 'peer-left') {
    const state = this.peers.get(peerId);
    if (!state) return;
    this.clearDisconnectedTimer(state);
    this.clearRecoveryTimer(state);
    state.pc.onnegotiationneeded = null;
    state.pc.onicecandidate = null;
    state.pc.ontrack = null;
    state.pc.onconnectionstatechange = null;
    state.pc.oniceconnectionstatechange = null;
    if (state.pc.signalingState !== 'closed') state.pc.close();
    this.peers.delete(peerId);
    this.log(peerId, `peer removido (${reason})`);
    this.emitPeers();
  }

  resetPeers(reason = 'reset') {
    for (const peerId of [...this.peers.keys()]) this.removePeer(peerId, reason);
    this.peers.clear();
    this.emitPeers();
  }

  reset() {
    this.resetPeers('session-reset');
    this.localPeerId = null;
    this.microphoneStream = null;
    this.cameraStream = null;
    this.screenStream = null;
    this.microphoneEnabled = true;
  }

  async getDiagnostics(): Promise<PeerDiagnostics[]> {
    const results = await Promise.all([...this.peers.values()].map(async (state) => {
      try {
        return await collectPeerDiagnostics(state.info.peerId, state.info.name, state.pc);
      } catch (cause) {
        this.log(state.info.peerId, `falha coletando getStats(): ${this.errorMessage(cause)}`);
        return null;
      }
    }));
    return results.filter((result): result is PeerDiagnostics => result !== null);
  }

  async testConnections(sampleDelayMs = 1200): Promise<PeerDiagnostics[]> {
    if (this.peers.size === 0) return [];
    this.logAll(`teste de conexão iniciado para ${this.peers.size} peer(s)`);
    await this.getDiagnostics();
    await new Promise<void>((resolve) => window.setTimeout(resolve, sampleDelayMs));
    const diagnostics = await this.getDiagnostics();
    this.logAll(`teste de conexão concluído para ${diagnostics.length} peer(s)`);
    return diagnostics;
  }

  async handleSignal(from: string, data: SignalPayload) {
    let state = this.peers.get(from);
    if (!state) {
      this.createPeer({ peerId: from, name: `Peer ${from.slice(0, 5)}` });
      state = this.peers.get(from)!;
    }

    if ('media' in data) {
      state.media[data.media.source] = data.media.active;
      this.log(from, `estado remoto ${data.media.source}: ${data.media.active ? 'ativo' : 'inativo'}`);
      this.emitPeers();
      return;
    }

    if ('description' in data) {
      await this.handleDescription(state, data.description);
      return;
    }

    await this.handleCandidate(state, data.candidate);
  }

  private bindPeerEvents(state: PeerState) {
    const { pc, info } = state;

    pc.onnegotiationneeded = async () => {
      try {
        state.makingOffer = true;
        this.log(info.peerId, `negotiationneeded (${pc.signalingState})`);
        await pc.setLocalDescription();
        if (pc.localDescription) {
          this.sendSignal(info.peerId, { description: pc.localDescription });
          this.log(info.peerId, `SDP ${pc.localDescription.type} enviado`);
        }
      } catch (cause) {
        this.log(info.peerId, `falha em negotiationneeded: ${this.errorMessage(cause)}`);
      } finally {
        state.makingOffer = false;
      }
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate) {
        this.log(info.peerId, 'ICE gathering concluído');
        return;
      }
      const candidate = event.candidate.toJSON();
      this.sendSignal(info.peerId, { candidate });
      const type = event.candidate.type ?? 'unknown';
      this.log(info.peerId, `ICE candidate enviado (${type})`);
    };

    pc.ontrack = (event) => {
      if (!state.remoteStream.getTracks().some((track) => track.id === event.track.id)) {
        state.remoteStream.addTrack(event.track);
      }
      this.log(info.peerId, `track remota recebida: ${event.track.kind}/${event.track.id.slice(0, 8)}`);
      event.track.addEventListener('ended', () => {
        state.remoteStream.removeTrack(event.track);
        this.log(info.peerId, `track remota encerrada: ${event.track.kind}/${event.track.id.slice(0, 8)}`);
        this.emitPeers();
      });
      this.emitPeers();
    };

    pc.onconnectionstatechange = () => {
      this.log(info.peerId, `connectionState=${pc.connectionState}`);
      if (pc.connectionState === 'connected') {
        state.restartAttempts = 0;
        this.clearDisconnectedTimer(state);
        this.clearRecoveryTimer(state);
      } else if (pc.connectionState === 'disconnected') {
        this.scheduleDisconnectedRestart(state);
      } else if (pc.connectionState === 'failed') {
        this.clearDisconnectedTimer(state);
        this.restartIce(state, 'connection-failed');
      } else if (pc.connectionState === 'closed') {
        this.clearDisconnectedTimer(state);
      }
      this.emitPeers();
    };

    pc.oniceconnectionstatechange = () => {
      this.log(info.peerId, `iceConnectionState=${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'failed') this.restartIce(state, 'ice-failed');
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        state.restartAttempts = 0;
        this.clearDisconnectedTimer(state);
        this.clearRecoveryTimer(state);
      }
    };
  }

  private async handleDescription(state: PeerState, description: RTCSessionDescriptionInit) {
    const { pc } = state;
    try {
      const readyForOffer = !state.makingOffer
        && (pc.signalingState === 'stable' || state.isSettingRemoteAnswerPending);
      const offerCollision = description.type === 'offer' && !readyForOffer;

      state.ignoreOffer = !state.polite && offerCollision;
      if (state.ignoreOffer) {
        this.log(state.info.peerId, `offer em colisão ignorado (${pc.signalingState})`);
        return;
      }

      state.isSettingRemoteAnswerPending = description.type === 'answer';
      await pc.setRemoteDescription(description);
      state.isSettingRemoteAnswerPending = false;
      this.log(state.info.peerId, `SDP ${description.type} remoto aplicado`);
      await this.flushCandidates(state);

      if (description.type === 'offer') {
        await pc.setLocalDescription();
        if (pc.localDescription) {
          this.sendSignal(state.info.peerId, { description: pc.localDescription });
          this.log(state.info.peerId, `SDP ${pc.localDescription.type} enviado em resposta`);
        }
      }
    } catch (cause) {
      state.isSettingRemoteAnswerPending = false;
      this.log(state.info.peerId, `erro aplicando SDP ${description.type}: ${this.errorMessage(cause)}`);
      throw cause;
    }
  }

  private async handleCandidate(state: PeerState, candidate: RTCIceCandidateInit) {
    try {
      if (!state.pc.remoteDescription) {
        state.pendingCandidates.push(candidate);
        this.log(state.info.peerId, `ICE candidate enfileirado (${state.pendingCandidates.length})`);
        return;
      }
      await state.pc.addIceCandidate(candidate);
    } catch (cause) {
      if (!state.ignoreOffer) {
        this.log(state.info.peerId, `erro adicionando ICE candidate: ${this.errorMessage(cause)}`);
        throw cause;
      }
    }
  }

  private async flushCandidates(state: PeerState) {
    if (!state.pc.remoteDescription || state.pendingCandidates.length === 0) return;
    const candidates = state.pendingCandidates.splice(0);
    for (const candidate of candidates) await state.pc.addIceCandidate(candidate);
    this.log(state.info.peerId, `${candidates.length} ICE candidate(s) pendente(s) aplicado(s)`);
  }

  private syncLocalMedia(state: PeerState) {
    this.syncSender(state, 'microphone', this.microphoneStream?.getAudioTracks()[0] ?? null, this.microphoneStream);
    this.syncSender(state, 'camera', this.cameraStream?.getVideoTracks()[0] ?? null, this.cameraStream);
    this.syncSender(state, 'screenVideo', this.screenStream?.getVideoTracks()[0] ?? null, this.screenStream);
    this.syncSender(state, 'screenAudio', this.screenStream?.getAudioTracks()[0] ?? null, this.screenStream);
  }

  private syncSender(
    state: PeerState,
    slot: keyof SenderSlots,
    track: MediaStreamTrack | null,
    stream: MediaStream | null,
  ) {
    const current = state.senders[slot];

    if (!track || !stream) {
      if (current) {
        try {
          state.pc.removeTrack(current);
          this.log(state.info.peerId, `${slot} removido`);
        } catch (cause) {
          this.log(state.info.peerId, `falha removendo ${slot}: ${this.errorMessage(cause)}`);
        }
        delete state.senders[slot];
      }
      return;
    }

    if (current?.track === track) return;
    if (current && current.track?.kind === track.kind) {
      void current.replaceTrack(track).then(() => {
        this.log(state.info.peerId, `${slot} substituído sem renegociação`);
      }).catch((cause) => {
        this.log(state.info.peerId, `falha em replaceTrack(${slot}): ${this.errorMessage(cause)}`);
      });
      return;
    }

    state.senders[slot] = state.pc.addTrack(track, stream);
    this.log(state.info.peerId, `${slot} adicionado (${track.kind}/${track.id.slice(0, 8)})`);
  }

  private broadcastMediaState(source: MediaSource, active: boolean) {
    for (const peerId of this.peers.keys()) this.sendSignal(peerId, { media: { source, active } });
  }

  private sendCurrentMediaState(peerId: string) {
    this.sendSignal(peerId, { media: { source: 'microphone', active: Boolean(this.microphoneStream) && this.microphoneEnabled } });
    this.sendSignal(peerId, { media: { source: 'camera', active: Boolean(this.cameraStream) } });
    this.sendSignal(peerId, { media: { source: 'screen', active: Boolean(this.screenStream) } });
  }

  private scheduleDisconnectedRestart(state: PeerState) {
    if (state.disconnectedTimer !== null) return;
    state.disconnectedTimer = window.setTimeout(() => {
      state.disconnectedTimer = null;
      if (state.pc.connectionState === 'disconnected') this.restartIce(state, 'disconnected-timeout');
    }, DISCONNECTED_RESTART_DELAY_MS);
    this.log(state.info.peerId, `desconectado; ICE restart em ${DISCONNECTED_RESTART_DELAY_MS}ms se não recuperar`);
  }

  private restartIce(state: PeerState, reason: string) {
    if (state.pc.signalingState === 'closed' || state.recoveryTimer !== null) return;
    if (state.restartAttempts >= MAX_ICE_RESTART_ATTEMPTS) {
      this.log(state.info.peerId, `recuperação WebRTC esgotada após ${MAX_ICE_RESTART_ATTEMPTS} ICE restart(s)`);
      return;
    }
    state.restartAttempts += 1;
    try {
      state.pc.restartIce();
      this.log(state.info.peerId, `ICE restart #${state.restartAttempts} solicitado (${reason})`);
      state.recoveryTimer = window.setTimeout(() => {
        state.recoveryTimer = null;
        const connectionBad = state.pc.connectionState === 'failed' || state.pc.connectionState === 'disconnected';
        const iceBad = state.pc.iceConnectionState === 'failed' || state.pc.iceConnectionState === 'disconnected';
        if (connectionBad || iceBad) this.restartIce(state, 'recovery-timeout');
      }, 5000);
    } catch (cause) {
      this.log(state.info.peerId, `falha solicitando ICE restart: ${this.errorMessage(cause)}`);
    }
  }

  private clearDisconnectedTimer(state: PeerState) {
    if (state.disconnectedTimer === null) return;
    window.clearTimeout(state.disconnectedTimer);
    state.disconnectedTimer = null;
  }

  private clearRecoveryTimer(state: PeerState) {
    if (state.recoveryTimer === null) return;
    window.clearTimeout(state.recoveryTimer);
    state.recoveryTimer = null;
  }

  private emitPeers() {
    this.onPeersChanged([...this.peers.values()].map((state) => ({
      ...state.info,
      stream: state.remoteStream,
      connectionState: state.pc.connectionState,
      media: { ...state.media },
    })));
  }

  private log(peerId: string, message: string) {
    this.onLog(`[RTC ${peerId.slice(0, 8)}] ${message}`);
  }

  private logAll(message: string) {
    this.onLog(`[RTC] ${message}`);
  }

  private errorMessage(cause: unknown) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}
