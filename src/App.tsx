import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { RemoteVideo } from './components/RemoteVideo';
import { createInvite, createRoomCode, parseInvite } from './lib/invite';
import { SignalingClient } from './lib/signaling';
import type { PeerInfo, RemotePeer, ServerMessage, SignalPayload } from './lib/types';

const DEFAULT_STUN = typeof import.meta.env.VITE_STUN_URL === 'string' ? import.meta.env.VITE_STUN_URL : 'stun:stun.l.google.com:19302';
const MAX_PARTICIPANTS = 4;

type PeerConnectionState = {
  info: PeerInfo;
  pc: RTCPeerConnection;
  remoteStream: MediaStream;
  pendingCandidates: RTCIceCandidateInit[];
  screenSenders: RTCRtpSender[];
};

type HomeMode = 'home' | 'host' | 'join';
type ThemeMode = 'dark' | 'onyx';
type DensityMode = 'comfortable' | 'compact';

type HostState = {
  localUrl: string;
  publicUrl: string;
  invite: string;
} | null;

type IconName =
  | 'home'
  | 'plus'
  | 'volume'
  | 'mic'
  | 'micOff'
  | 'headphones'
  | 'screen'
  | 'phone'
  | 'video'
  | 'copy'
  | 'users'
  | 'settings'
  | 'logs'
  | 'chevron'
  | 'arrow';

const ICON_PATHS: Record<IconName, string[]> = {
  home: ['M3 11.5 12 4l9 7.5', 'M5 10.5V20h14v-9.5', 'M9 20v-6h6v6'],
  plus: ['M12 5v14', 'M5 12h14'],
  volume: ['M5 9v6h4l5 4V5L9 9H5Z', 'M17 9.5a4 4 0 0 1 0 5', 'M19.5 7a7 7 0 0 1 0 10'],
  mic: ['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z', 'M5 11a7 7 0 0 0 14 0', 'M12 18v3', 'M9 21h6'],
  micOff: ['m4 4 16 16', 'M9 9v3a3 3 0 0 0 4.3 2.7', 'M15 9V6a3 3 0 0 0-5.8-1', 'M5 11a7 7 0 0 0 11.8 5.1', 'M12 18v3', 'M9 21h6'],
  headphones: ['M4 14v-2a8 8 0 0 1 16 0v2', 'M4 14h3v6H5a1 1 0 0 1-1-1v-5Z', 'M20 14h-3v6h2a1 1 0 0 0 1-1v-5Z'],
  screen: ['M3 5h18v12H3z', 'M8 21h8', 'M12 17v4'],
  phone: ['M7.5 4.5c.8 0 1.3.4 1.6 1.1l1 2.4c.2.6.1 1.2-.4 1.6l-1.2 1a14.7 14.7 0 0 0 4.9 4.9l1-1.2c.4-.5 1-.6 1.6-.4l2.4 1c.7.3 1.1.8 1.1 1.6V20c0 .6-.4 1-1 1C10 21 3 14 3 5.5c0-.6.4-1 1-1h3.5Z'],
  video: ['M3 7h12v10H3z', 'm15 10 6-3v10l-6-3'],
  copy: ['M8 8h11v11H8z', 'M5 16H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1'],
  users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
  settings: ['M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z', 'M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.12 2.12-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.55V20.3h-3v-.09a1.7 1.7 0 0 0-1.03-1.55 1.7 1.7 0 0 0-1.88.34l-.06.06-2.12-2.12.06-.06A1.7 1.7 0 0 0 7 15a1.7 1.7 0 0 0-1.55-1.03H5.3v-3h.15A1.7 1.7 0 0 0 7 9.94a1.7 1.7 0 0 0-.34-1.88L6.6 8l2.12-2.12.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 11.7 4.7v-.1h3v.1a1.7 1.7 0 0 0 1.03 1.55 1.7 1.7 0 0 0 1.88-.34l.06-.06L19.8 8l-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.55 1.03h.15v3h-.15A1.7 1.7 0 0 0 19.4 15Z'],
  logs: ['M4 4h16v16H4z', 'M8 9h8', 'M8 13h8', 'M8 17h5'],
  chevron: ['m9 18 6-6-6-6'],
  arrow: ['M5 12h14', 'm13 6 6 6-6 6'],
};

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {ICON_PATHS[name].map((path, index) => <path key={index} d={path} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />)}
    </svg>
  );
}

function initialFor(value: string) {
  return value.trim().charAt(0).toUpperCase() || 'D';
}

function App() {
  const [name, setName] = useState(() => localStorage.getItem('discordy:name') || '');
  const [mode, setMode] = useState<HomeMode>('home');
  const [theme, setTheme] = useState<ThemeMode>(() => (localStorage.getItem('discordy:theme') === 'onyx' ? 'onyx' : 'dark'));
  const [density, setDensity] = useState<DensityMode>(() => (localStorage.getItem('discordy:density') === 'compact' ? 'compact' : 'comfortable'));
  const [inviteInput, setInviteInput] = useState('');
  const [roomId, setRoomId] = useState<string | null>(null);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [hostState, setHostState] = useState<HostState>(null);
  const [isHosting, setIsHosting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Pronto');
  const [error, setError] = useState<string | null>(null);
  const [micEnabled, setMicEnabled] = useState(true);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [remotePeers, setRemotePeers] = useState<RemotePeer[]>([]);
  const [cloudflared, setCloudflared] = useState<{ installed: boolean; version: string | null } | null>(null);
  const [technicalLogs, setTechnicalLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);

  const signalingRef = useRef<SignalingClient | null>(null);
  const peersRef = useRef(new Map<string, PeerConnectionState>());
  const micStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const localPreviewRef = useRef<HTMLVideoElement | null>(null);

  const refreshPeers = useCallback(() => {
    setRemotePeers(Array.from(peersRef.current.values()).map((peer) => ({
      ...peer.info,
      stream: peer.remoteStream,
      connectionState: peer.pc.connectionState,
    })));
  }, []);

  const sendSignal = useCallback((target: string, data: SignalPayload) => {
    signalingRef.current?.send({ type: 'signal', target, data });
  }, []);

  const addCurrentLocalTracks = useCallback((state: PeerConnectionState) => {
    const micStream = micStreamRef.current;
    if (micStream) {
      for (const track of micStream.getTracks()) {
        if (!state.pc.getSenders().some((sender) => sender.track === track)) state.pc.addTrack(track, micStream);
      }
    }

    const currentScreen = screenStreamRef.current;
    if (currentScreen && state.screenSenders.length === 0) {
      state.screenSenders = currentScreen.getTracks().map((track) => state.pc.addTrack(track, currentScreen));
    }
  }, []);

  const negotiate = useCallback(async (peerId: string) => {
    const state = peersRef.current.get(peerId);
    if (!state || state.pc.signalingState !== 'stable') return;
    try {
      const offer = await state.pc.createOffer();
      await state.pc.setLocalDescription(offer);
      sendSignal(peerId, { description: state.pc.localDescription! });
    } catch (cause) {
      console.error('Falha ao negociar peer:', cause);
    }
  }, [sendSignal]);

  const createPeer = useCallback((info: PeerInfo) => {
    const existing = peersRef.current.get(info.peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: [{ urls: DEFAULT_STUN }] });
    const state: PeerConnectionState = {
      info,
      pc,
      remoteStream: new MediaStream(),
      pendingCandidates: [],
      screenSenders: [],
    };

    peersRef.current.set(info.peerId, state);
    addCurrentLocalTracks(state);

    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal(info.peerId, { candidate: event.candidate.toJSON() });
    };
    pc.ontrack = (event) => {
      if (!state.remoteStream.getTracks().some((track) => track.id === event.track.id)) state.remoteStream.addTrack(event.track);
      event.track.addEventListener('ended', () => {
        state.remoteStream.removeTrack(event.track);
        refreshPeers();
      });
      refreshPeers();
    };
    pc.onconnectionstatechange = refreshPeers;
    refreshPeers();
    return state;
  }, [addCurrentLocalTracks, refreshPeers, sendSignal]);

  const flushCandidates = useCallback(async (state: PeerConnectionState) => {
    if (!state.pc.remoteDescription) return;
    for (const candidate of state.pendingCandidates.splice(0)) await state.pc.addIceCandidate(candidate);
  }, []);

  const handleSignal = useCallback(async (from: string, data: SignalPayload) => {
    let state = peersRef.current.get(from);
    if (!state) state = createPeer({ peerId: from, name: `Peer ${from.slice(0, 5)}` });

    try {
      if ('description' in data) {
        const description = data.description;
        if (description.type === 'offer' && state.pc.signalingState !== 'stable') return;
        await state.pc.setRemoteDescription(description);
        await flushCandidates(state);
        if (description.type === 'offer') {
          const answer = await state.pc.createAnswer();
          await state.pc.setLocalDescription(answer);
          sendSignal(from, { description: state.pc.localDescription! });
        }
        return;
      }

      if (state.pc.remoteDescription) await state.pc.addIceCandidate(data.candidate);
      else state.pendingCandidates.push(data.candidate);
    } catch (cause) {
      console.error('Erro processando sinal WebRTC:', cause);
      setError('Falha na negociação WebRTC. Abra os detalhes técnicos para diagnóstico.');
    }
  }, [createPeer, flushCandidates, sendSignal]);

  const handleServerMessage = useCallback(async (message: ServerMessage) => {
    if (message.type === 'error') return setError(message.message);
    if (message.type === 'welcome') {
      setSelfId(message.peerId);
      setRoomId(message.roomId);
      setStatus('Conectado');
      for (const peer of message.peers) createPeer(peer);
      for (const peer of message.peers) await negotiate(peer.peerId);
      return;
    }
    if (message.type === 'peer-joined') return void createPeer(message.peer);
    if (message.type === 'peer-left') {
      peersRef.current.get(message.peerId)?.pc.close();
      peersRef.current.delete(message.peerId);
      refreshPeers();
      return;
    }
    if (message.type === 'signal') await handleSignal(message.from, message.data);
  }, [createPeer, handleSignal, negotiate, refreshPeers]);

  const ensureMicrophone = useCallback(async () => {
    if (micStreamRef.current) return micStreamRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      micStreamRef.current = stream;
      return stream;
    } catch (cause) {
      console.warn('Microfone indisponível:', cause);
      setMicEnabled(false);
      return null;
    }
  }, []);

  const connectToRoom = useCallback(async (targetServer: string, targetRoom: string, requestedName: string) => {
    const cleanName = requestedName.trim().slice(0, 40);
    if (!cleanName) throw new Error('Informe seu nome.');

    localStorage.setItem('discordy:name', cleanName);
    setError(null);
    setStatus('Conectando...');
    await ensureMicrophone();

    const signaling = new SignalingClient(targetServer);
    signalingRef.current = signaling;
    signaling.onMessage((message) => void handleServerMessage(message));
    await signaling.connect();
    signaling.send({ type: 'join', roomId: targetRoom, name: cleanName });
    setServerUrl(targetServer);
  }, [ensureMicrophone, handleServerMessage]);

  const checkCloudflared = useCallback(async () => {
    const result = await window.discordy.cloudflared.check();
    setCloudflared({ installed: result.installed, version: result.version });
    return result;
  }, []);

  const createHostedRoom = async () => {
    if (!name.trim()) return setError('Informe seu nome antes de criar a sala.');
    setBusy(true);
    setError(null);
    setTechnicalLogs([]);
    try {
      const check = await checkCloudflared();
      if (!check.installed) {
        setError('Cloudflared não está instalado. Ele só é necessário para quem hospeda a sala.');
        return;
      }

      setStatus('Preparando sala...');
      const hosted = await window.discordy.host.start();
      const code = createRoomCode();
      const invite = createInvite(hosted.publicUrl, code);
      setHostState({ localUrl: hosted.localUrl, publicUrl: hosted.publicUrl, invite });
      setIsHosting(true);
      await connectToRoom(hosted.localUrl, code, name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível criar a sala.');
      await window.discordy.host.stop().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const joinFromInvite = async (rawInvite: string) => {
    if (!name.trim()) return setError('Informe seu nome antes de entrar.');
    setBusy(true);
    setError(null);
    try {
      const parsed = parseInvite(rawInvite);
      setHostState(null);
      setIsHosting(false);
      await connectToRoom(parsed.serverUrl, parsed.roomId, name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível entrar na sala.');
    } finally {
      setBusy(false);
    }
  };

  const leave = useCallback(async () => {
    signalingRef.current?.close();
    signalingRef.current = null;
    for (const state of peersRef.current.values()) state.pc.close();
    peersRef.current.clear();
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current = null;
    setScreenStream(null);
    setRemotePeers([]);
    setRoomId(null);
    setSelfId(null);
    setServerUrl(null);
    setStatus('Pronto');
    setShowLogs(false);

    if (isHosting) await window.discordy.host.stop().catch(() => undefined);
    setIsHosting(false);
    setHostState(null);
    setMode('home');
  }, [isHosting]);

  const toggleMic = () => {
    const next = !micEnabled;
    setMicEnabled(next);
    for (const track of micStreamRef.current?.getAudioTracks() || []) track.enabled = next;
  };

  const stopScreenShare = useCallback(async () => {
    const stream = screenStreamRef.current;
    if (!stream) return;
    screenStreamRef.current = null;
    setScreenStream(null);
    for (const track of stream.getTracks()) track.stop();
    for (const state of peersRef.current.values()) {
      for (const sender of state.screenSenders) {
        try { state.pc.removeTrack(sender); } catch { /* closed peer */ }
      }
      state.screenSenders = [];
    }
    for (const peerId of peersRef.current.keys()) await negotiate(peerId);
  }, [negotiate]);

  const startScreenShare = async () => {
    if (screenStreamRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 60 } }, audio: true });
      screenStreamRef.current = stream;
      setScreenStream(stream);
      for (const state of peersRef.current.values()) state.screenSenders = stream.getTracks().map((track) => state.pc.addTrack(track, stream));
      stream.getVideoTracks()[0]?.addEventListener('ended', () => void stopScreenShare(), { once: true });
      for (const peerId of peersRef.current.keys()) await negotiate(peerId);
    } catch (cause) {
      console.warn('Compartilhamento cancelado/indisponível:', cause);
    }
  };

  const copyInvite = async () => {
    if (!hostState) return;
    await window.discordy.clipboard.writeText(hostState.invite);
    setStatus('Convite copiado');
  };

  const updateTheme = (next: ThemeMode) => {
    setTheme(next);
    localStorage.setItem('discordy:theme', next);
  };

  const updateDensity = (next: DensityMode) => {
    setDensity(next);
    localStorage.setItem('discordy:density', next);
  };

  useEffect(() => {
    if (localPreviewRef.current) localPreviewRef.current.srcObject = screenStream;
  }, [screenStream]);

  useEffect(() => {
    const unsubscribeStatus = window.discordy.host.onStatus((next) => setStatus(next.message));
    const unsubscribeLog = window.discordy.host.onLog((line) => setTechnicalLogs((logs) => [...logs.slice(-199), line]));
    const unsubscribeDeepLink = window.discordy.onDeepLink((url) => {
      setInviteInput(url);
      setMode('join');
      if (name.trim() && !roomId) void joinFromInvite(url);
    });
    void checkCloudflared();
    return () => {
      unsubscribeStatus();
      unsubscribeLog();
      unsubscribeDeepLink();
    };
    // Deep-link auto join intentionally tracks the current identity/session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkCloudflared, name, roomId]);

  useEffect(() => () => {
    signalingRef.current?.close();
    for (const state of peersRef.current.values()) state.pc.close();
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const rootClassName = `discordy-root theme-${theme} density-${density}`;

  if (roomId) {
    const totalParticipants = remotePeers.length + 1;

    return (
      <main className={rootClassName}>
        <div className="discord-shell">
          <aside className="server-rail" aria-label="Navegação de salas">
            <button className="rail-button rail-button--brand" title="Discordy" aria-label="Discordy"><span>D</span></button>
            <div className="rail-separator" />
            <button className="rail-button rail-button--room rail-button--active" title={`Sala ${roomId}`} aria-label={`Sala ${roomId}`}>
              <span>{roomId.slice(0, 2).toUpperCase()}</span>
            </button>
            <button className="rail-button rail-button--add" title="Crie outra sala depois de sair" aria-label="Nova sala" disabled><Icon name="plus" /></button>
          </aside>

          <aside className="room-sidebar">
            <header className="sidebar-room-header">
              <div>
                <strong>Sala {roomId}</strong>
                <span>{isHosting ? 'Hospedada neste PC' : 'Sala privada'}</span>
              </div>
              <Icon name="chevron" size={16} />
            </header>

            <div className="channel-scroll">
              <section className="channel-section">
                <div className="channel-category"><span>CANAIS DE VOZ</span></div>
                <button className="channel-item channel-item--active">
                  <Icon name="volume" size={17} />
                  <span>Geral</span>
                </button>
                <div className="voice-users">
                  <div className="voice-user">
                    <span className="avatar avatar--xs">{initialFor(name)}</span>
                    <span className="voice-user__name">{name || 'Você'}</span>
                    {!micEnabled && <Icon name="micOff" size={13} />}
                  </div>
                  {remotePeers.map((peer) => (
                    <div className="voice-user" key={peer.peerId}>
                      <span className="avatar avatar--xs avatar--remote">{initialFor(peer.name)}</span>
                      <span className="voice-user__name">{peer.name}</span>
                    </div>
                  ))}
                </div>
              </section>

              {hostState && (
                <section className="sidebar-card">
                  <div className="sidebar-card__title"><Icon name="users" size={15} /><strong>Convite da sala</strong></div>
                  <p>{hostState.publicUrl.replace(/^https?:\/\//, '')}</p>
                  <button className="sidebar-action" onClick={() => void copyInvite()}><Icon name="copy" size={15} />Copiar convite</button>
                </section>
              )}
            </div>

            <div className="sidebar-bottom">
              <section className="voice-status-panel">
                <div className="voice-status-row">
                  <div><span className="connection-dot" /><strong>Voz conectada</strong><small>WebRTC P2P · {status}</small></div>
                  {isHosting && <button className={`icon-button icon-button--small ${showLogs ? 'is-active' : ''}`} title="Detalhes técnicos" onClick={() => setShowLogs((value) => !value)}><Icon name="logs" size={16} /></button>}
                </div>
                <div className="voice-status-actions">
                  <button className="mini-action" onClick={() => void (screenStream ? stopScreenShare() : startScreenShare())}><Icon name="screen" size={15} />{screenStream ? 'Parar tela' : 'Tela'}</button>
                  <button className="mini-action" disabled title="Câmera será adicionada em Voice & Media"><Icon name="video" size={15} />Vídeo</button>
                </div>
              </section>

              <section className="current-user-panel">
                <span className="avatar avatar--sm">{initialFor(name)}</span>
                <div className="current-user-copy"><strong>{name || 'Você'}</strong><span>{selfId ? `#${selfId.slice(0, 4)}` : 'local'}</span></div>
                <button className={`icon-button icon-button--small ${!micEnabled ? 'is-danger' : ''}`} title={micEnabled ? 'Silenciar microfone' : 'Ativar microfone'} onClick={toggleMic}><Icon name={micEnabled ? 'mic' : 'micOff'} size={17} /></button>
                <button className="icon-button icon-button--small" title="Desativar áudio de saída (em breve)" disabled><Icon name="headphones" size={17} /></button>
                <button className="icon-button icon-button--small" title="Configurações (em breve)" disabled><Icon name="settings" size={17} /></button>
              </section>
            </div>
          </aside>

          <section className="main-stage">
            <header className="topbar">
              <div className="topbar-channel">
                <Icon name="volume" size={19} />
                <strong>Geral</strong>
                <span className="topbar-divider" />
                <span>Sala {roomId}</span>
              </div>
              <div className="topbar-actions">
                <span className="participant-count"><Icon name="users" size={17} />{totalParticipants}</span>
                {hostState && <button className="topbar-button" onClick={() => void copyInvite()} title="Copiar convite"><Icon name="copy" size={17} /><span>Convidar</span></button>}
              </div>
            </header>

            <div className="stage-content">
              {error && <div className="alert alert--stage">{error}</div>}

              {showLogs && isHosting && (
                <section className="technical-drawer">
                  <div className="technical-drawer__header"><strong>Detalhes técnicos</strong><button className="text-button" onClick={() => setShowLogs(false)}>Fechar</button></div>
                  <pre>{technicalLogs.length ? technicalLogs.join('\n') : 'Sem logs ainda.'}</pre>
                </section>
              )}

              <section className={`media-grid media-grid--${Math.min(totalParticipants, 4)}`}>
                <article className={`media-tile media-tile--self ${screenStream ? 'has-video' : ''}`}>
                  <div className="media-tile__viewport">
                    <video ref={localPreviewRef} autoPlay muted playsInline />
                    {!screenStream && (
                      <div className="media-fallback">
                        <span className="avatar avatar--xl">{initialFor(name)}</span>
                      </div>
                    )}
                    <div className="media-tile__status">
                      <span>{name || 'Você'} <small>Você</small></span>
                      {!micEnabled && <span className="media-state-icon"><Icon name="micOff" size={14} /></span>}
                    </div>
                  </div>
                </article>
                {remotePeers.map((peer) => <RemoteVideo key={peer.peerId} peer={peer} />)}
              </section>

              {remotePeers.length === 0 && (
                <div className="waiting-copy">
                  <strong>Você está sozinho por enquanto</strong>
                  <span>{hostState ? 'Envie o convite para seus amigos entrarem na sala.' : 'Aguardando outros participantes.'}</span>
                  {hostState && <button className="button button--primary" onClick={() => void copyInvite()}><Icon name="copy" size={16} />Copiar convite</button>}
                </div>
              )}

              <div className="media-dock" aria-label="Controles da chamada">
                <button className={`dock-button ${!micEnabled ? 'dock-button--danger' : ''}`} onClick={toggleMic} title={micEnabled ? 'Silenciar' : 'Ativar microfone'}><Icon name={micEnabled ? 'mic' : 'micOff'} size={20} /></button>
                <button className="dock-button" disabled title="Desativar áudio de saída será implementado em Voice & Media"><Icon name="headphones" size={20} /></button>
                <button className={`dock-button ${screenStream ? 'dock-button--active' : ''}`} onClick={() => void (screenStream ? stopScreenShare() : startScreenShare())} title={screenStream ? 'Parar compartilhamento' : 'Compartilhar tela'}><Icon name="screen" size={20} /></button>
                <button className="dock-button" disabled title="Câmera será implementada em Voice & Media"><Icon name="video" size={20} /></button>
                <button className="dock-button dock-button--hangup" onClick={() => void leave()} title="Desconectar"><Icon name="phone" size={21} /></button>
              </div>
            </div>
          </section>

          <aside className="members-sidebar">
            <header className="members-header"><strong>Participantes</strong><span>{totalParticipants}/{MAX_PARTICIPANTS}</span></header>
            <div className="members-list">
              <div className="members-group-title">NA SALA — {totalParticipants}</div>
              <div className="member-row">
                <span className="avatar avatar--sm">{initialFor(name)}</span>
                <div><strong>{name || 'Você'}</strong><span>{isHosting ? 'Host · conectado' : 'Você · conectado'}</span></div>
                <span className="presence-dot" />
              </div>
              {remotePeers.map((peer) => (
                <div className="member-row" key={peer.peerId}>
                  <span className="avatar avatar--sm avatar--remote">{initialFor(peer.name)}</span>
                  <div><strong>{peer.name}</strong><span>{peer.connectionState === 'connected' ? 'Conectado' : peer.connectionState}</span></div>
                  <span className={`presence-dot ${peer.connectionState !== 'connected' ? 'presence-dot--idle' : ''}`} />
                </div>
              ))}
            </div>
            <footer className="members-footer">
              <span>{isHosting ? 'Servidor local + Quick Tunnel' : 'Conectado por convite'}</span>
              <small>{serverUrl}</small>
            </footer>
          </aside>
        </div>
      </main>
    );
  }

  const submitJoin = (event: FormEvent) => {
    event.preventDefault();
    void joinFromInvite(inviteInput);
  };

  return (
    <main className={rootClassName}>
      <div className="welcome-shell">
        <aside className="server-rail server-rail--welcome">
          <button className="rail-button rail-button--brand rail-button--active" title="Discordy" aria-label="Discordy"><span>D</span></button>
          <div className="rail-separator" />
          <button className="rail-button rail-button--add" title="Criar ou entrar em uma sala" aria-label="Criar ou entrar"><Icon name="plus" /></button>
        </aside>

        <section className="welcome-content">
          <div className="welcome-topbar">
            <div className="welcome-brand"><span className="brand-orb">D</span><strong>Discordy</strong><small>Desktop</small></div>
            <div className="preference-controls" aria-label="Preferências visuais">
              <div className="segmented-control">
                <button className={theme === 'dark' ? 'is-active' : ''} onClick={() => updateTheme('dark')}>Dark</button>
                <button className={theme === 'onyx' ? 'is-active' : ''} onClick={() => updateTheme('onyx')}>Onyx</button>
              </div>
              <div className="segmented-control">
                <button className={density === 'comfortable' ? 'is-active' : ''} onClick={() => updateDensity('comfortable')}>Confortável</button>
                <button className={density === 'compact' ? 'is-active' : ''} onClick={() => updateDensity('compact')}>Compacto</button>
              </div>
            </div>
          </div>

          <div className="welcome-center">
            <section className="welcome-card">
              <div className="welcome-card__intro">
                <div className="welcome-logo">D</div>
                <p className="eyebrow">Discordy Desktop 0.2.1</p>
                <h1>Sua sala privada, direto entre os participantes.</h1>
                <p>WebRTC P2P para voz e compartilhamento de tela, com signaling hospedado pelo próprio host.</p>
              </div>

              <label className="identity-field">
                <span>Seu nome</span>
                <input value={name} onChange={(event) => setName(event.target.value)} maxLength={40} placeholder="Victor" />
              </label>

              {mode === 'home' && (
                <div className="welcome-actions">
                  <button className="action-card action-card--primary" onClick={() => setMode('host')}>
                    <span className="action-card__icon"><Icon name="plus" size={21} /></span>
                    <span><strong>Criar uma sala</strong><small>Hospede no seu PC e gere um convite.</small></span>
                    <Icon name="arrow" size={18} />
                  </button>
                  <button className="action-card" onClick={() => setMode('join')}>
                    <span className="action-card__icon"><Icon name="arrow" size={21} /></span>
                    <span><strong>Entrar em uma sala</strong><small>Cole o convite enviado por um amigo.</small></span>
                    <Icon name="arrow" size={18} />
                  </button>
                </div>
              )}

              {mode === 'host' && (
                <div className="flow-section">
                  <button className="back-link" onClick={() => setMode('home')}>← Voltar</button>
                  <div className="flow-heading"><span className="action-card__icon"><Icon name="plus" size={20} /></span><div><strong>Criar sala neste PC</strong><small>O signaling será iniciado localmente.</small></div></div>
                  <div className={`dependency ${cloudflared?.installed ? 'dependency--ok' : 'dependency--missing'}`}>
                    <span className="dependency-dot" />
                    <div><strong>{cloudflared?.installed ? 'Cloudflared encontrado' : 'Cloudflared não encontrado'}</strong><span>{cloudflared?.version || 'Necessário somente para hospedar.'}</span></div>
                  </div>
                  {!cloudflared?.installed ? (
                    <div className="actions"><button className="button button--primary" onClick={() => void window.discordy.cloudflared.openDownload()}>Baixar Cloudflared</button><button className="button" onClick={() => void checkCloudflared()}>Verificar novamente</button></div>
                  ) : (
                    <button className="button button--primary button--large" disabled={busy} onClick={() => void createHostedRoom()}>{busy ? status : 'Criar sala'}</button>
                  )}
                </div>
              )}

              {mode === 'join' && (
                <div className="flow-section">
                  <button className="back-link" onClick={() => setMode('home')}>← Voltar</button>
                  <div className="flow-heading"><span className="action-card__icon"><Icon name="arrow" size={20} /></span><div><strong>Entrar por convite</strong><small>Quem entra não precisa do Cloudflared.</small></div></div>
                  <form onSubmit={submitJoin} className="join-form">
                    <label>Convite<input value={inviteInput} onChange={(event) => setInviteInput(event.target.value)} placeholder="discordy://join?..." autoFocus /></label>
                    <button className="button button--primary button--large" disabled={busy}>{busy ? 'Conectando...' : 'Entrar na sala'}</button>
                  </form>
                </div>
              )}

              {error && <div className="alert home-alert">{error}</div>}

              <div className="welcome-card__footer">
                <span><span className="connection-dot" />WebRTC Mesh</span>
                <span>Até {MAX_PARTICIPANTS} participantes</span>
              </div>
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}

export default App;
