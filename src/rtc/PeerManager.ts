import type { ChatMessage, MediaSource, PeerInfo, RemotePeer, ScreenShareMetadata, SignalPayload } from '../lib/types';
import { collectPeerDiagnostics } from './diagnostics';
import type { PeerDiagnostics } from './diagnostics';
import { ADAPTIVE_QUALITY_ORDER, ADAPTIVE_QUALITY_PROFILES, collectAdaptiveNetworkSample, initialAdaptiveSnapshot, makeAdaptiveSnapshot, recommendAdaptiveQuality } from './adaptiveQuality';
import type { AdaptiveQualityLevel, AdaptiveQualitySnapshot } from './adaptiveQuality';

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
  mediaTrackIds: Partial<Record<MediaSource, string>>;
  screenShare: ScreenShareMetadata | null;
  turnFallbackActive: boolean;
  chatChannel: RTCDataChannel | null;
  chatReady: boolean;
  seenChatMessageIds: Set<string>;
  adaptiveQuality: AdaptiveQualitySnapshot;
  adaptiveCandidate: AdaptiveQualityLevel;
  adaptiveCandidateCount: number;
  senderPolicyKeys: Partial<Record<keyof SenderSlots, string>>;
};

type PeerManagerOptions = {
  rtcConfiguration: RTCConfiguration;
  turnFallbackConfiguration?: RTCConfiguration | null;
  sendSignal: (target: string, data: SignalPayload) => boolean;
  onPeersChanged: (peers: RemotePeer[]) => void;
  onChatMessage?: (message: ChatMessage) => void;
  onTypingChanged?: (peerId: string, typing: boolean) => void;
  onChatChannelChanged?: (peerId: string, ready: boolean) => void;
  adaptiveQualityEnabled?: boolean;
  onLog?: (message: string) => void;
};

const MAX_ICE_RESTART_ATTEMPTS = 3;
const DISCONNECTED_RESTART_DELAY_MS = 3500;
const CHAT_CHANNEL_LABEL = 'discordy-chat';
const CHAT_PROTOCOL = 'discordy-chat-v1';
const MAX_CHAT_MESSAGE_LENGTH = 2000;
const MAX_CHAT_PACKET_BYTES = 8192;
const ADAPTIVE_SAMPLE_INTERVAL_MS = 2000;
const CAMERA_BASELINE_BITRATE_KBPS = 1800;
const AUDIO_MAX_BITRATE_BPS = 96000;

type ExtendedEncodingParameters = RTCRtpEncodingParameters & {
  priority?: 'very-low' | 'low' | 'medium' | 'high';
};

export class PeerManager {
  private readonly peers = new Map<string, PeerState>();
  private rtcConfiguration: RTCConfiguration;
  private turnFallbackConfiguration: RTCConfiguration | null;
  private readonly sendSignal: PeerManagerOptions['sendSignal'];
  private readonly onPeersChanged: PeerManagerOptions['onPeersChanged'];
  private readonly onChatMessage: NonNullable<PeerManagerOptions['onChatMessage']>;
  private readonly onTypingChanged: NonNullable<PeerManagerOptions['onTypingChanged']>;
  private readonly onChatChannelChanged: NonNullable<PeerManagerOptions['onChatChannelChanged']>;
  private readonly onLog: NonNullable<PeerManagerOptions['onLog']>;

  private localPeerId: string | null = null;
  private microphoneStream: MediaStream | null = null;
  private cameraStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private microphoneEnabled = true;
  private screenShareMetadata: ScreenShareMetadata | null = null;
  private screenBitrateKbps = 4500;
  private adaptiveQualityEnabled = true;
  private adaptiveQualityTimer: number | null = null;
  private adaptiveQualityCycleRunning = false;

  constructor(options: PeerManagerOptions) {
    this.rtcConfiguration = { ...options.rtcConfiguration, iceServers: [...(options.rtcConfiguration.iceServers ?? [])] };
    this.turnFallbackConfiguration = options.turnFallbackConfiguration ? { ...options.turnFallbackConfiguration, iceServers: [...(options.turnFallbackConfiguration.iceServers ?? [])] } : null;
    this.sendSignal = options.sendSignal;
    this.onPeersChanged = options.onPeersChanged;
    this.onChatMessage = options.onChatMessage ?? (() => undefined);
    this.onTypingChanged = options.onTypingChanged ?? (() => undefined);
    this.onChatChannelChanged = options.onChatChannelChanged ?? (() => undefined);
    this.adaptiveQualityEnabled = options.adaptiveQualityEnabled ?? true;
    this.onLog = options.onLog ?? (() => undefined);
  }


  updateConnectivityConfiguration(rtcConfiguration: RTCConfiguration, turnFallbackConfiguration: RTCConfiguration | null) {
    this.rtcConfiguration = { ...rtcConfiguration, iceServers: [...(rtcConfiguration.iceServers ?? [])] };
    this.turnFallbackConfiguration = turnFallbackConfiguration ? { ...turnFallbackConfiguration, iceServers: [...(turnFallbackConfiguration.iceServers ?? [])] } : null;

    for (const state of this.peers.values()) {
      state.turnFallbackActive = this.rtcConfiguration.iceTransportPolicy === 'relay';
      state.restartAttempts = 0;
      this.clearDisconnectedTimer(state);
      this.clearRecoveryTimer(state);
      try {
        state.pc.setConfiguration(this.rtcConfiguration);
        state.pc.restartIce();
        this.log(state.info.peerId, `configuração ICE atualizada policy=${this.rtcConfiguration.iceTransportPolicy ?? 'all'} servers=${this.rtcConfiguration.iceServers?.length ?? 0}`);
      } catch (cause) {
        this.log(state.info.peerId, `falha aplicando configuração ICE: ${this.errorMessage(cause)}`);
      }
    }
  }

  setLocalPeerId(peerId: string | null) {
    this.localPeerId = peerId;
  }

  hasPeer(peerId: string) {
    return this.peers.has(peerId);
  }

  setAdaptiveQualityEnabled(enabled: boolean) {
    this.adaptiveQualityEnabled = enabled;
    this.logAll(`qualidade adaptativa ${enabled ? 'ativada' : 'desativada'}`);
    for (const state of this.peers.values()) {
      state.adaptiveCandidate = 'excellent';
      state.adaptiveCandidateCount = 0;
      if (!enabled) {
        const sample = {
          sampledAt: new Date().toISOString(),
          connectionState: state.pc.connectionState,
          iceConnectionState: state.pc.iceConnectionState,
          packetLossPct: null,
          rttMs: null,
          availableOutgoingKbps: null,
        };
        state.adaptiveQuality = makeAdaptiveSnapshot(sample, 'excellent', 'controle adaptativo desativado', this.screenStream ? this.screenBitrateKbps : null, this.cameraStream ? CAMERA_BASELINE_BITRATE_KBPS : null);
      }
      void this.applyAdaptiveSenderParameters(state);
    }
    if (enabled) this.ensureAdaptiveQualityLoop();
    else this.stopAdaptiveQualityLoop();
    this.emitPeers();
  }

  isAdaptiveQualityEnabled() {
    return this.adaptiveQualityEnabled;
  }

  setMicrophone(stream: MediaStream | null) {
    this.microphoneStream = stream;
    for (const state of this.peers.values()) this.syncLocalMedia(state);
    this.broadcastMediaState('microphone', Boolean(stream) && this.microphoneEnabled, stream?.getAudioTracks()[0]?.id ?? null);
  }

  setMicrophoneEnabled(enabled: boolean) {
    this.microphoneEnabled = enabled;
    this.broadcastMediaState('microphone', Boolean(this.microphoneStream) && enabled, this.microphoneStream?.getAudioTracks()[0]?.id ?? null);
    this.logAll(`microfone ${enabled ? 'ativado' : 'silenciado'}`);
  }

  setCamera(stream: MediaStream | null) {
    this.cameraStream = stream;
    for (const state of this.peers.values()) this.syncLocalMedia(state);
    this.broadcastMediaState('camera', Boolean(stream), stream?.getVideoTracks()[0]?.id ?? null);
  }

  setScreen(stream: MediaStream | null, metadata: ScreenShareMetadata | null = null) {
    this.screenStream = stream;
    this.screenShareMetadata = stream ? metadata : null;
    if (metadata) this.screenBitrateKbps = metadata.bitrateKbps;
    for (const state of this.peers.values()) this.syncLocalMedia(state);
    this.broadcastMediaState('screen', Boolean(stream), stream?.getVideoTracks()[0]?.id ?? null, this.screenShareMetadata);
    this.logAll(`compartilhamento de tela ${stream ? 'iniciado' : 'encerrado'}`);
  }

  setScreenBitrate(bitrateKbps: number) {
    this.screenBitrateKbps = Math.max(500, Math.min(20000, Math.round(bitrateKbps)));
    if (this.screenShareMetadata) this.screenShareMetadata = { ...this.screenShareMetadata, bitrateKbps: this.screenBitrateKbps };
    for (const state of this.peers.values()) {
      const sender = state.senders.screenVideo;
      if (sender) void this.applyAdaptiveVideoSenderParameters(state, 'screenVideo', sender);
    }
    if (this.screenStream) this.broadcastMediaState('screen', true, this.screenStream.getVideoTracks()[0]?.id ?? null, this.screenShareMetadata);
    this.logAll(`bitrate máximo da tela=${this.screenBitrateKbps} Kbps`);
  }

  updateScreenMetadata(metadata: ScreenShareMetadata) {
    this.screenShareMetadata = metadata;
    this.screenBitrateKbps = metadata.bitrateKbps;
    for (const state of this.peers.values()) {
      const sender = state.senders.screenVideo;
      if (sender) void this.applyAdaptiveVideoSenderParameters(state, 'screenVideo', sender);
    }
    if (this.screenStream) this.broadcastMediaState('screen', true, this.screenStream.getVideoTracks()[0]?.id ?? null, metadata);
  }

  createPeer(info: PeerInfo): void {
    const existing = this.peers.get(info.peerId);
    if (existing) {
      existing.info = info;
      this.emitPeers();
      return;
    }

    const pc = new RTCPeerConnection(this.rtcConfiguration);
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
      mediaTrackIds: {},
      screenShare: null,
      turnFallbackActive: this.rtcConfiguration.iceTransportPolicy === 'relay',
      chatChannel: null,
      chatReady: false,
      seenChatMessageIds: new Set<string>(),
      adaptiveQuality: initialAdaptiveSnapshot(),
      adaptiveCandidate: 'excellent',
      adaptiveCandidateCount: 0,
      senderPolicyKeys: {},
    };

    this.peers.set(info.peerId, state);
    this.bindPeerEvents(state);
    this.setupChatDataChannel(state);
    this.syncLocalMedia(state);
    this.sendCurrentMediaState(info.peerId);
    this.log(info.peerId, `peer criado (${polite ? 'polite' : 'impolite'})`);
    this.ensureAdaptiveQualityLoop();
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
    state.pc.ondatachannel = null;
    this.closeChatChannel(state);
    if (state.pc.signalingState !== 'closed') state.pc.close();
    this.peers.delete(peerId);
    if (this.peers.size === 0) this.stopAdaptiveQualityLoop();
    this.log(peerId, `peer removido (${reason})`);
    this.emitPeers();
  }

  resetPeers(reason = 'reset') {
    for (const peerId of [...this.peers.keys()]) this.removePeer(peerId, reason);
    this.peers.clear();
    this.emitPeers();
  }

  reset() {
    this.stopAdaptiveQualityLoop();
    this.resetPeers('session-reset');
    this.localPeerId = null;
    this.microphoneStream = null;
    this.cameraStream = null;
    this.screenStream = null;
    this.microphoneEnabled = true;
    this.screenShareMetadata = null;
    this.screenBitrateKbps = 4500;
  }

  sendChatMessage(message: ChatMessage): number {
    const text = message.text.trim();
    if (!text || text.length > MAX_CHAT_MESSAGE_LENGTH) return 0;
    const packet = JSON.stringify({ type: 'chat-message', id: message.id, text, sentAt: message.sentAt });
    let sent = 0;
    for (const state of this.peers.values()) {
      if (this.sendChatPacket(state, packet)) sent += 1;
    }
    this.logAll(`chat enviado para ${sent}/${this.peers.size} peer(s)`);
    return sent;
  }

  sendTyping(typing: boolean): number {
    const packet = JSON.stringify({ type: 'typing', typing, sentAt: Date.now() });
    let sent = 0;
    for (const state of this.peers.values()) {
      if (this.sendChatPacket(state, packet)) sent += 1;
    }
    return sent;
  }

  getChatReadyPeerCount(): number {
    let count = 0;
    for (const state of this.peers.values()) if (state.chatReady) count += 1;
    return count;
  }

  async getDiagnostics(): Promise<PeerDiagnostics[]> {
    const results = await Promise.all([...this.peers.values()].map(async (state) => {
      try {
        const diagnostics = await collectPeerDiagnostics(state.info.peerId, state.info.name, state.pc);
        const result: PeerDiagnostics = { ...diagnostics, adaptiveQuality: { ...state.adaptiveQuality } };
        return result;
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
      if (data.media.trackId) state.mediaTrackIds[data.media.source] = data.media.trackId;
      else if (!data.media.active) delete state.mediaTrackIds[data.media.source];
      if (data.media.source === 'screen') state.screenShare = data.media.active ? (data.media.screen ?? state.screenShare) : null;
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

    pc.ondatachannel = (event) => {
      if (event.channel.label !== CHAT_CHANNEL_LABEL) {
        this.log(info.peerId, `DataChannel desconhecido ignorado: ${event.channel.label}`);
        event.channel.close();
        return;
      }
      this.bindChatChannel(state, event.channel, 'remote');
    };

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

  private setupChatDataChannel(state: PeerState) {
    if (!this.localPeerId) return;
    const initiator = this.localPeerId.localeCompare(state.info.peerId) < 0;
    if (!initiator) {
      this.log(state.info.peerId, 'aguardando RTCDataChannel de chat do peer iniciador');
      return;
    }
    try {
      const channel = state.pc.createDataChannel(CHAT_CHANNEL_LABEL, {
        ordered: true,
        protocol: CHAT_PROTOCOL,
      });
      this.bindChatChannel(state, channel, 'local');
      this.log(state.info.peerId, 'RTCDataChannel de chat criado');
    } catch (cause) {
      this.log(state.info.peerId, `falha criando RTCDataChannel: ${this.errorMessage(cause)}`);
    }
  }

  private bindChatChannel(state: PeerState, channel: RTCDataChannel, origin: 'local' | 'remote') {
    if (state.chatChannel && state.chatChannel !== channel) {
      if (state.chatChannel.readyState === 'open') {
        this.log(state.info.peerId, `RTCDataChannel duplicado (${origin}) descartado`);
        channel.close();
        return;
      }
      try { state.chatChannel.close(); } catch { /* noop */ }
    }

    state.chatChannel = channel;
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      if (state.chatChannel !== channel) return;
      state.chatReady = true;
      this.onChatChannelChanged(state.info.peerId, true);
      this.log(state.info.peerId, `RTCDataChannel chat aberto (${origin})`);
    };

    channel.onclose = () => {
      if (state.chatChannel !== channel) return;
      state.chatReady = false;
      this.onTypingChanged(state.info.peerId, false);
      this.onChatChannelChanged(state.info.peerId, false);
      this.log(state.info.peerId, 'RTCDataChannel chat fechado');
    };

    channel.onerror = () => {
      this.log(state.info.peerId, 'erro no RTCDataChannel de chat');
    };

    channel.onmessage = (event) => {
      this.handleChatPacket(state, event.data);
    };
  }

  private handleChatPacket(state: PeerState, raw: unknown) {
    if (typeof raw !== 'string') {
      this.log(state.info.peerId, 'pacote de chat não-textual ignorado');
      return;
    }
    if (new TextEncoder().encode(raw).byteLength > MAX_CHAT_PACKET_BYTES) {
      this.log(state.info.peerId, 'pacote de chat excedeu o limite e foi descartado');
      return;
    }

    let packet: unknown;
    try {
      packet = JSON.parse(raw);
    } catch {
      this.log(state.info.peerId, 'JSON inválido recebido no chat');
      return;
    }
    if (!packet || typeof packet !== 'object') return;
    const value = packet as Record<string, unknown>;

    if (value.type === 'typing') {
      if (typeof value.typing !== 'boolean') return;
      this.onTypingChanged(state.info.peerId, value.typing);
      return;
    }

    if (value.type !== 'chat-message') return;
    if (typeof value.id !== 'string' || value.id.length < 8 || value.id.length > 128) return;
    if (typeof value.text !== 'string') return;
    const text = value.text.trim();
    if (!text || text.length > MAX_CHAT_MESSAGE_LENGTH) return;
    if (state.seenChatMessageIds.has(value.id)) return;
    state.seenChatMessageIds.add(value.id);
    if (state.seenChatMessageIds.size > 500) {
      const first = state.seenChatMessageIds.values().next().value as string | undefined;
      if (first) state.seenChatMessageIds.delete(first);
    }

    const sentAt = typeof value.sentAt === 'number' && Number.isFinite(value.sentAt) ? value.sentAt : Date.now();
    this.onTypingChanged(state.info.peerId, false);
    this.onChatMessage({
      id: value.id,
      senderId: state.info.peerId,
      senderName: state.info.name,
      text,
      sentAt,
    });
    this.log(state.info.peerId, `mensagem P2P recebida (${text.length} chars)`);
  }

  private sendChatPacket(state: PeerState, packet: string): boolean {
    const channel = state.chatChannel;
    if (!channel || channel.readyState !== 'open') return false;
    if (channel.bufferedAmount > 1024 * 1024) {
      this.log(state.info.peerId, 'chat aguardando: buffer do DataChannel acima de 1 MiB');
      return false;
    }
    try {
      channel.send(packet);
      return true;
    } catch (cause) {
      this.log(state.info.peerId, `falha enviando chat P2P: ${this.errorMessage(cause)}`);
      return false;
    }
  }

  private closeChatChannel(state: PeerState) {
    const channel = state.chatChannel;
    state.chatChannel = null;
    state.chatReady = false;
    this.onTypingChanged(state.info.peerId, false);
    this.onChatChannelChanged(state.info.peerId, false);
    if (!channel) return;
    channel.onopen = null;
    channel.onclose = null;
    channel.onerror = null;
    channel.onmessage = null;
    if (channel.readyState !== 'closed') {
      try { channel.close(); } catch { /* noop */ }
    }
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
        delete state.senderPolicyKeys[slot];
      }
      return;
    }

    if (current?.track === track) return;
    if (current && current.track?.kind === track.kind) {
      void current.replaceTrack(track).then(() => {
        this.log(state.info.peerId, `${slot} substituído sem renegociação`);
        delete state.senderPolicyKeys[slot];
        void this.applySenderPolicy(state, slot, current);
      }).catch((cause) => {
        this.log(state.info.peerId, `falha em replaceTrack(${slot}): ${this.errorMessage(cause)}`);
      });
      return;
    }

    state.senders[slot] = state.pc.addTrack(track, stream);
    void this.applySenderPolicy(state, slot, state.senders[slot]!);
    this.log(state.info.peerId, `${slot} adicionado (${track.kind}/${track.id.slice(0, 8)})`);
  }

  private broadcastMediaState(source: MediaSource, active: boolean, trackId: string | null = null, screen: ScreenShareMetadata | null = null) {
    for (const peerId of this.peers.keys()) this.sendSignal(peerId, { media: { source, active, trackId, ...(source === 'screen' ? { screen } : {}) } });
  }

  private sendCurrentMediaState(peerId: string) {
    this.sendSignal(peerId, { media: { source: 'microphone', active: Boolean(this.microphoneStream) && this.microphoneEnabled, trackId: this.microphoneStream?.getAudioTracks()[0]?.id ?? null } });
    this.sendSignal(peerId, { media: { source: 'camera', active: Boolean(this.cameraStream), trackId: this.cameraStream?.getVideoTracks()[0]?.id ?? null } });
    this.sendSignal(peerId, { media: { source: 'screen', active: Boolean(this.screenStream), trackId: this.screenStream?.getVideoTracks()[0]?.id ?? null, screen: this.screenShareMetadata } });
  }

  private scheduleDisconnectedRestart(state: PeerState) {
    if (state.disconnectedTimer !== null) return;
    state.disconnectedTimer = window.setTimeout(() => {
      state.disconnectedTimer = null;
      if (state.pc.connectionState === 'disconnected') this.restartIce(state, 'disconnected-timeout');
    }, DISCONNECTED_RESTART_DELAY_MS);
    this.log(state.info.peerId, `desconectado; ICE restart em ${DISCONNECTED_RESTART_DELAY_MS}ms se não recuperar`);
  }


  private activateTurnFallback(state: PeerState, reason: string): boolean {
    if (!this.turnFallbackConfiguration || state.turnFallbackActive || state.pc.signalingState === 'closed') return false;
    try {
      state.pc.setConfiguration(this.turnFallbackConfiguration);
      state.turnFallbackActive = true;
      state.restartAttempts = 0;
      state.pc.restartIce();
      this.log(state.info.peerId, `fallback TURN ativado (${reason}); reiniciando ICE com ${this.turnFallbackConfiguration.iceServers?.length ?? 0} servidor(es)`);
      state.recoveryTimer = window.setTimeout(() => {
        state.recoveryTimer = null;
        const connectionBad = state.pc.connectionState === 'failed' || state.pc.connectionState === 'disconnected';
        const iceBad = state.pc.iceConnectionState === 'failed' || state.pc.iceConnectionState === 'disconnected';
        if (connectionBad || iceBad) this.restartIce(state, 'turn-fallback-timeout');
      }, 6000);
      return true;
    } catch (cause) {
      this.log(state.info.peerId, `falha ativando fallback TURN: ${this.errorMessage(cause)}`);
      return false;
    }
  }

  private restartIce(state: PeerState, reason: string) {
    if (state.pc.signalingState === 'closed' || state.recoveryTimer !== null) return;

    const hardFailure = reason.includes('failed');
    if (!state.turnFallbackActive && this.turnFallbackConfiguration && (hardFailure || state.restartAttempts >= 1)) {
      if (this.activateTurnFallback(state, reason)) return;
    }

    if (state.restartAttempts >= MAX_ICE_RESTART_ATTEMPTS) {
      if (!state.turnFallbackActive && this.activateTurnFallback(state, 'direct-restarts-exhausted')) return;
      this.log(state.info.peerId, `recuperação WebRTC esgotada após ${MAX_ICE_RESTART_ATTEMPTS} ICE restart(s)${state.turnFallbackActive ? ' com TURN ativo' : ''}`);
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
      mediaTrackIds: { ...state.mediaTrackIds },
      screenShare: state.screenShare ? { ...state.screenShare } : null,
    })));
  }

  private ensureAdaptiveQualityLoop() {
    if (!this.adaptiveQualityEnabled || this.peers.size === 0 || this.adaptiveQualityTimer !== null) return;
    void this.runAdaptiveQualityCycle();
    this.adaptiveQualityTimer = window.setInterval(() => void this.runAdaptiveQualityCycle(), ADAPTIVE_SAMPLE_INTERVAL_MS);
  }

  private stopAdaptiveQualityLoop() {
    if (this.adaptiveQualityTimer !== null) window.clearInterval(this.adaptiveQualityTimer);
    this.adaptiveQualityTimer = null;
  }

  private requestedVideoBitrateKbps() {
    return (this.screenStream ? this.screenBitrateKbps : 0) + (this.cameraStream ? CAMERA_BASELINE_BITRATE_KBPS : 0);
  }

  private async runAdaptiveQualityCycle() {
    if (!this.adaptiveQualityEnabled || this.adaptiveQualityCycleRunning || this.peers.size === 0) return;
    this.adaptiveQualityCycleRunning = true;
    try {
      const requestedVideoKbps = this.requestedVideoBitrateKbps();
      for (const state of this.peers.values()) {
        if (state.pc.signalingState === 'closed') continue;
        try {
          const sample = await collectAdaptiveNetworkSample(state.pc);
          const recommendation = recommendAdaptiveQuality(sample, requestedVideoKbps);
          const nextLevel = this.resolveAdaptiveLevel(state, recommendation.level);
          const previousLevel = state.adaptiveQuality.level;
          state.adaptiveQuality = makeAdaptiveSnapshot(
            sample,
            nextLevel,
            recommendation.reason,
            this.screenStream ? this.screenBitrateKbps : null,
            this.cameraStream ? CAMERA_BASELINE_BITRATE_KBPS : null,
          );
          await this.applyAdaptiveSenderParameters(state);
          if (previousLevel !== nextLevel) {
            this.log(state.info.peerId, `qualidade adaptativa ${previousLevel} -> ${nextLevel}: ${recommendation.reason}; loss=${sample.packetLossPct?.toFixed(1) ?? 'n/d'}% rtt=${sample.rttMs?.toFixed(0) ?? 'n/d'}ms out=${sample.availableOutgoingKbps?.toFixed(0) ?? 'n/d'}Kbps`);
            this.emitPeers();
          }
        } catch (cause) {
          this.log(state.info.peerId, `falha no ciclo de qualidade adaptativa: ${this.errorMessage(cause)}`);
        }
      }
    } finally {
      this.adaptiveQualityCycleRunning = false;
    }
  }

  private resolveAdaptiveLevel(state: PeerState, recommended: AdaptiveQualityLevel): AdaptiveQualityLevel {
    const current = state.adaptiveQuality.level;
    const currentRank = ADAPTIVE_QUALITY_ORDER.indexOf(current);
    const recommendedRank = ADAPTIVE_QUALITY_ORDER.indexOf(recommended);
    if (recommended === current) {
      state.adaptiveCandidate = recommended;
      state.adaptiveCandidateCount = 0;
      return current;
    }

    if (state.adaptiveCandidate !== recommended) {
      state.adaptiveCandidate = recommended;
      state.adaptiveCandidateCount = 1;
    } else {
      state.adaptiveCandidateCount += 1;
    }

    if (recommendedRank > currentRank) {
      const required = recommended === 'critical' ? 1 : 2;
      if (state.adaptiveCandidateCount < required) return current;
      state.adaptiveCandidateCount = 0;
      return recommended;
    }

    if (state.adaptiveCandidateCount < 4) return current;
    state.adaptiveCandidateCount = 0;
    return ADAPTIVE_QUALITY_ORDER[Math.max(0, currentRank - 1)];
  }

  private async applyAdaptiveSenderParameters(state: PeerState) {
    const tasks: Promise<void>[] = [];
    for (const slot of Object.keys(state.senders) as Array<keyof SenderSlots>) {
      const sender = state.senders[slot];
      if (sender) tasks.push(this.applySenderPolicy(state, slot, sender));
    }
    await Promise.all(tasks);
  }

  private async applySenderPolicy(state: PeerState, slot: keyof SenderSlots, sender: RTCRtpSender) {
    if (slot === 'microphone' || slot === 'screenAudio') {
      await this.applyAudioSenderParameters(state, slot, sender);
      return;
    }
    await this.applyAdaptiveVideoSenderParameters(state, slot, sender);
  }

  private async applyAudioSenderParameters(state: PeerState, slot: 'microphone' | 'screenAudio', sender: RTCRtpSender) {
    const policyKey = `${sender.track?.id ?? 'none'}:audio:high:${AUDIO_MAX_BITRATE_BPS}`;
    if (state.senderPolicyKeys[slot] === policyKey) return;
    try {
      const parameters = sender.getParameters();
      parameters.encodings ??= [{}];
      if (parameters.encodings.length === 0) parameters.encodings.push({});
      const encoding = parameters.encodings[0] as ExtendedEncodingParameters;
      encoding.maxBitrate = AUDIO_MAX_BITRATE_BPS;
      encoding.priority = 'high';
      await sender.setParameters(parameters);
      state.senderPolicyKeys[slot] = policyKey;
      this.log(state.info.peerId, `${slot} prioridade=high maxBitrate=${Math.round(AUDIO_MAX_BITRATE_BPS / 1000)}Kbps`);
    } catch (cause) {
      this.log(state.info.peerId, `falha priorizando ${slot}: ${this.errorMessage(cause)}`);
    }
  }

  private async applyAdaptiveVideoSenderParameters(state: PeerState, slot: 'camera' | 'screenVideo', sender: RTCRtpSender) {
    try {
      const profile = this.adaptiveQualityEnabled ? ADAPTIVE_QUALITY_PROFILES[state.adaptiveQuality.level] : ADAPTIVE_QUALITY_PROFILES.excellent;
      const baselineKbps = slot === 'screenVideo' ? this.screenBitrateKbps : CAMERA_BASELINE_BITRATE_KBPS;
      const sourceFps = slot === 'screenVideo' ? (this.screenShareMetadata?.targetFps ?? 30) : 30;
      const policyKey = `${sender.track?.id ?? 'none'}:${state.adaptiveQuality.level}:${baselineKbps}:${sourceFps}:${profile.bitrateFactor}:${profile.maxFps}:${profile.scaleResolutionDownBy}`;
      if (state.senderPolicyKeys[slot] === policyKey) return;
      const parameters = sender.getParameters();
      parameters.encodings ??= [{}];
      if (parameters.encodings.length === 0) parameters.encodings.push({});
      const encoding = parameters.encodings[0] as ExtendedEncodingParameters;
      const minBitrateKbps = slot === 'screenVideo' ? 250 : 180;
      encoding.maxBitrate = Math.max(minBitrateKbps, Math.round(baselineKbps * profile.bitrateFactor)) * 1000;
      encoding.maxFramerate = Math.min(sourceFps, profile.maxFps);
      encoding.scaleResolutionDownBy = profile.scaleResolutionDownBy;
      encoding.priority = profile.badConnection ? 'very-low' : 'low';
      parameters.degradationPreference = 'balanced';
      await sender.setParameters(parameters);
      state.senderPolicyKeys[slot] = policyKey;
      this.log(state.info.peerId, `${slot} adaptive=${state.adaptiveQuality.level} maxBitrate=${Math.round((encoding.maxBitrate ?? 0) / 1000)}Kbps maxFps=${encoding.maxFramerate ?? 'n/d'} scale=${encoding.scaleResolutionDownBy ?? 1}`);
    } catch (cause) {
      this.log(state.info.peerId, `falha ajustando ${slot} adaptativamente: ${this.errorMessage(cause)}`);
    }
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
