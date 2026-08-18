import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { RemoteVideo } from './components/RemoteVideo';
import { ChatPanel } from './components/ChatPanel';
import { ScreenShareTile } from './components/ScreenShareTile';
import { createInvite, createRoomCode, parseInvite } from './lib/invite';
import { SignalingClient } from './lib/signaling';
import type { SignalingState } from './lib/signaling';
import { PeerManager } from './rtc/PeerManager';
import type { PeerDiagnostics } from './rtc/diagnostics';
import { configSummary, defaultIceConnectivityConfig, fallbackRtcConfiguration, initialRtcConfiguration, loadIceConnectivityConfig, normalizeIceConnectivityConfig, saveIceConnectivityConfig, testTurnConnectivity } from './rtc/iceConfig';
import type { IceConnectivityConfig, TurnTestResult } from './rtc/iceConfig';
import type { ChatMessage, InviteTtlMinutes, JoinRequestInfo, ParticipantInfo, PresenceState, RemotePeer, RoomInfo, ScreenShareMetadata, ServerMessage } from './lib/types';
import { VoiceMediaController } from './media/VoiceMediaController';
import type { MediaDeviceCatalog, SensitivityMode, VoiceActivitySnapshot, VoiceInputMode } from './media/VoiceMediaController';
import { SCREEN_QUALITY_PRESETS, ScreenShareController } from './media/ScreenShareController';
import type { ScreenQualityPreset, ScreenSourceInfo } from './media/ScreenShareController';

const DEFAULT_MAX_PARTICIPANTS = 4;
const APP_VERSION = '0.11.0';

type HomeMode = 'home' | 'host' | 'join';
type ThemeMode = 'dark' | 'onyx';
type DensityMode = 'comfortable' | 'compact';

type DesktopPreferences = {
  minimizeToTray: boolean;
  closeToTray: boolean;
  notifications: boolean;
  launchAtStartup: boolean;
  globalShortcuts: boolean;
};

type DesktopRuntimeState = {
  preferences: DesktopPreferences;
  launchAtStartupSupported: boolean;
  notificationSupported: boolean;
  globalHoldSupported: boolean;
  shortcuts: {
    mute: boolean;
    deafen: boolean;
    toggleWindow: boolean;
    holdKeys: boolean;
  };
  windowVisible: boolean;
};

type UpdateRuntimeState = {
  supported: boolean;
  status: 'unsupported' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';
  currentVersion: string;
  availableVersion: string | null;
  progress: number | null;
  message: string;
  error: string | null;
  portable: boolean;
};

type HostState = {
  localUrl: string;
  publicUrl: string;
  invite: string | null;
  inviteToken: string | null;
  inviteExpiresAt: number | null;
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
  | 'activity'
  | 'chevron'
  | 'arrow'
  | 'chat';

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
  activity: ['M3 12h4l2.2-6 4.1 12 2.5-7H21'],
  chevron: ['m9 18 6-6-6-6'],
  arrow: ['M5 12h14', 'm13 6 6 6-6 6'],
  chat: ['M4 5h16v11H8l-4 4V5Z', 'M8 9h8', 'M8 12h5'],
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

function formatMetric(value: number | null, unit = '', digits = 1) {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}${unit}`;
}

function formatBitrate(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '—';
  if (value >= 1000) return `${(value / 1000).toFixed(2)} Mbps`;
  return `${value.toFixed(1)} Kbps`;
}

function routeLabel(route: PeerDiagnostics['route']) {
  if (route === 'turn') return 'TURN Relay';
  if (route === 'nat') return 'P2P via NAT';
  if (route === 'direct') return 'P2P direto';
  return 'Indeterminado';
}

function videoLabel(video: PeerDiagnostics['receivedVideo']) {
  if (!video) return '—';
  const size = video.width && video.height ? `${video.width}×${video.height}` : 'resolução n/d';
  const fps = video.fps !== null ? `${video.fps.toFixed(1)} FPS` : 'FPS n/d';
  return `${size} · ${fps}`;
}

function adaptiveQualityLabel(level: NonNullable<PeerDiagnostics['adaptiveQuality']>['level']) {
  if (level === 'excellent') return 'Excelente';
  if (level === 'good') return 'Boa';
  if (level === 'fair') return 'Moderada';
  if (level === 'poor') return 'Ruim';
  return 'Crítica';
}


function presenceLabel(presence: PresenceState) {
  if (presence === 'online') return 'Online';
  if (presence === 'reconnecting') return 'Reconectando';
  return 'Desconectado';
}

function inviteExpiryLabel(expiresAt: number | null | undefined) {
  if (!expiresAt) return 'Sem convite ativo';
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return 'Expirado';
  const minutes = Math.max(1, Math.ceil(remaining / 60_000));
  if (minutes < 60) return `Expira em ${minutes} min`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `Expira em ${hours} h`;
  return `Expira em ${Math.ceil(hours / 24)} dia(s)`;
}

function UpdateBanner({
  state,
  onCheck,
  onDownload,
  onInstall,
}: {
  state: UpdateRuntimeState | null;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
}) {
  if (!state || state.status === 'idle' || state.status === 'unsupported') return null;
  const version = state.availableVersion ? ` ${state.availableVersion}` : '';
  const progress = state.progress === null ? null : Math.max(0, Math.min(100, state.progress));

  return (
    <aside className={`update-banner update-banner--${state.status}`} role="status" aria-live="polite">
      <div className="update-banner__body">
        <strong>
          {state.status === 'checking' && 'Verificando atualizações'}
          {state.status === 'available' && `Discordy${version} disponível`}
          {state.status === 'downloading' && `Baixando Discordy${version}`}
          {state.status === 'downloaded' && `Discordy${version} pronto para instalar`}
          {state.status === 'error' && 'Falha na atualização'}
        </strong>
        <span>{state.error || state.message}</span>
        {state.status === 'downloading' && progress !== null && (
          <div className="update-progress" aria-label={`Download ${Math.round(progress)}%`}>
            <span style={{ width: `${progress}%` }} />
          </div>
        )}
      </div>
      <div className="update-banner__actions">
        {state.status === 'available' && <button className="button button--primary" onClick={onDownload}>Baixar</button>}
        {state.status === 'downloaded' && <button className="button button--primary" onClick={onInstall}>Reiniciar e atualizar</button>}
        {state.status === 'error' && <button className="button" onClick={onCheck}>Tentar novamente</button>}
      </div>
    </aside>
  );
}

function createChatMessageId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function upsertParticipant(list: ParticipantInfo[], participant: ParticipantInfo) {
  const index = list.findIndex((item) => item.peerId === participant.peerId);
  if (index < 0) return [...list, participant];
  const next = [...list];
  next[index] = participant;
  return next;
}

function App() {
  const [name, setName] = useState(() => localStorage.getItem('discordy:name') || '');
  const [mode, setMode] = useState<HomeMode>('home');
  const [theme, setTheme] = useState<ThemeMode>(() => (localStorage.getItem('discordy:theme') === 'onyx' ? 'onyx' : 'dark'));
  const [density, setDensity] = useState<DensityMode>(() => (localStorage.getItem('discordy:density') === 'compact' ? 'compact' : 'comfortable'));
  const [inviteInput, setInviteInput] = useState('');
  const [joinPin, setJoinPin] = useState('');
  const [joinPending, setJoinPending] = useState(false);
  const [joinPendingRoomName, setJoinPendingRoomName] = useState('');
  const [roomId, setRoomId] = useState<string | null>(null);
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  const [participants, setParticipants] = useState<ParticipantInfo[]>([]);
  const [pendingJoinRequests, setPendingJoinRequests] = useState<JoinRequestInfo[]>([]);
  const [selfPresence, setSelfPresence] = useState<PresenceState>('disconnected');
  const [showRoomSettings, setShowRoomSettings] = useState(false);
  const [hostRoomName, setHostRoomName] = useState(() => localStorage.getItem('discordy:host-room-name') || 'Minha sala');
  const [hostMaxParticipants, setHostMaxParticipants] = useState<2 | 3 | 4>(() => {
    const stored = Number(localStorage.getItem('discordy:host-max-participants') || '4');
    return stored === 2 || stored === 3 ? stored : 4;
  });
  const [hostPin, setHostPin] = useState('');
  const [hostApprovalRequired, setHostApprovalRequired] = useState(() => localStorage.getItem('discordy:host-approval-required') === 'true');
  const [hostInviteTtlMinutes, setHostInviteTtlMinutes] = useState<InviteTtlMinutes>(() => {
    const stored = Number(localStorage.getItem('discordy:host-invite-ttl') || '60');
    return stored === 15 || stored === 30 || stored === 360 || stored === 1440 ? stored : 60;
  });
  const [roomNameDraft, setRoomNameDraft] = useState('');
  const [roomLimitDraft, setRoomLimitDraft] = useState<2 | 3 | 4>(4);
  const [roomPinDraft, setRoomPinDraft] = useState('');
  const [roomApprovalDraft, setRoomApprovalDraft] = useState(false);
  const [roomInviteTtlDraft, setRoomInviteTtlDraft] = useState<InviteTtlMinutes>(60);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [hostState, setHostState] = useState<HostState>(null);
  const [isHosting, setIsHosting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Pronto');
  const [error, setError] = useState<string | null>(null);
  const [micEnabled, setMicEnabled] = useState(true);
  const [deafened, setDeafened] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [screenMetadata, setScreenMetadata] = useState<ScreenShareMetadata | null>(null);
  const [screenPickerOpen, setScreenPickerOpen] = useState(false);
  const [screenSources, setScreenSources] = useState<ScreenSourceInfo[]>([]);
  const [screenSourcesLoading, setScreenSourcesLoading] = useState(false);
  const [screenQuality, setScreenQuality] = useState<ScreenQualityPreset>(() => {
    const value = localStorage.getItem('discordy:screen-quality');
    return value === '720p30' || value === '1080p60' ? value : '1080p30';
  });
  const [screenBitrateKbps, setScreenBitrateKbps] = useState(() => {
    const value = Number(localStorage.getItem('discordy:screen-bitrate') || '4500');
    return Number.isFinite(value) ? Math.max(500, Math.min(20000, value)) : 4500;
  });
  const [screenSystemAudio, setScreenSystemAudio] = useState(() => localStorage.getItem('discordy:screen-system-audio') !== 'false');
  const [expandedScreenKey, setExpandedScreenKey] = useState<string | null>(null);
  const [showMediaSettings, setShowMediaSettings] = useState(false);
  const [mediaDevices, setMediaDevices] = useState<MediaDeviceCatalog>({ audioInputs: [], audioOutputs: [], videoInputs: [] });
  const [microphoneDeviceId, setMicrophoneDeviceId] = useState(() => localStorage.getItem('discordy:microphone-device') || '');
  const [outputDeviceId, setOutputDeviceId] = useState(() => localStorage.getItem('discordy:output-device') || '');
  const [cameraDeviceId, setCameraDeviceId] = useState(() => localStorage.getItem('discordy:camera-device') || '');
  const [inputMode, setInputMode] = useState<VoiceInputMode>(() => localStorage.getItem('discordy:input-mode') === 'push-to-talk' ? 'push-to-talk' : 'voice-activity');
  const [sensitivityMode, setSensitivityMode] = useState<SensitivityMode>(() => localStorage.getItem('discordy:sensitivity-mode') === 'manual' ? 'manual' : 'automatic');
  const [manualSensitivityDb, setManualSensitivityDb] = useState(() => {
    const stored = Number(localStorage.getItem('discordy:sensitivity-db') || '-48');
    return Number.isFinite(stored) ? Math.max(-80, Math.min(-20, stored)) : -48;
  });
  const [pushToMuteEnabled, setPushToMuteEnabled] = useState(() => localStorage.getItem('discordy:push-to-mute') !== 'false');
  const [pushToTalkPressed, setPushToTalkPressed] = useState(false);
  const [pushToMutePressed, setPushToMutePressed] = useState(false);
  const [voiceActivity, setVoiceActivity] = useState<VoiceActivitySnapshot>({ levelDb: -96, thresholdDb: -48, speaking: false, transmitting: false });
  const [peerVolumes, setPeerVolumes] = useState<Record<string, number>>({});
  const [remoteSpeaking, setRemoteSpeaking] = useState<Record<string, boolean>>({});
  const [remotePeers, setRemotePeers] = useState<RemotePeer[]>([]);
  const [cloudflared, setCloudflared] = useState<{ installed: boolean; version: string | null } | null>(null);
  const [technicalLogs, setTechnicalLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [networkDiagnostics, setNetworkDiagnostics] = useState<PeerDiagnostics[]>([]);
  const [networkTesting, setNetworkTesting] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [diagnosticsUpdatedAt, setDiagnosticsUpdatedAt] = useState<Date | null>(null);
  const [adaptiveQualityEnabled, setAdaptiveQualityEnabled] = useState(() => localStorage.getItem('discordy:adaptive-quality') !== 'false');
  const [iceConfig, setIceConfig] = useState<IceConnectivityConfig>(() => loadIceConnectivityConfig());
  const [iceDraft, setIceDraft] = useState<IceConnectivityConfig>(() => loadIceConnectivityConfig());
  const [turnTesting, setTurnTesting] = useState(false);
  const [turnTestResult, setTurnTestResult] = useState<TurnTestResult | null>(null);
  const [showChat, setShowChat] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const [chatTypingPeers, setChatTypingPeers] = useState<Record<string, boolean>>({});
  const [chatReadyPeers, setChatReadyPeers] = useState<Record<string, boolean>>({});
  const [chatUnread, setChatUnread] = useState(0);
  const [desktopRuntime, setDesktopRuntime] = useState<DesktopRuntimeState | null>(null);
  const [updateState, setUpdateState] = useState<UpdateRuntimeState | null>(null);

  const signalingRef = useRef<SignalingClient | null>(null);
  const peerManagerRef = useRef<PeerManager | null>(null);
  const mediaControllerRef = useRef<VoiceMediaController | null>(null);
  const screenShareControllerRef = useRef<ScreenShareController | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const localPreviewRef = useRef<HTMLVideoElement | null>(null);
  const selfIdRef = useRef<string | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const leaveRef = useRef<(() => Promise<void>) | null>(null);
  const showChatRef = useRef(false);
  const localTypingTimerRef = useRef<number | null>(null);
  const localTypingSentRef = useRef(false);

  showChatRef.current = showChat;

  const appendTechnicalLog = useCallback((line: string) => {
    const timestamp = new Date().toLocaleTimeString('pt-BR', { hour12: false });
    setTechnicalLogs((logs) => [...logs.slice(-399), `[${timestamp}] ${line}`]);
  }, []);

  const notifyWhenBackground = useCallback((title: string, body: string) => {
    if (!document.hidden && document.hasFocus()) return;
    void window.discordy.desktop.notify({ title, body }).catch(() => undefined);
  }, []);

  if (!mediaControllerRef.current) {
    mediaControllerRef.current = new VoiceMediaController({
      onVoiceActivity: setVoiceActivity,
      onLog: (message) => appendTechnicalLog(`[VOICE] ${message}`),
    });
  }

  if (!screenShareControllerRef.current) screenShareControllerRef.current = new ScreenShareController();

  if (!peerManagerRef.current) {
    peerManagerRef.current = new PeerManager({
      rtcConfiguration: initialRtcConfiguration(iceConfig),
      turnFallbackConfiguration: fallbackRtcConfiguration(iceConfig),
      sendSignal: (target, data) => signalingRef.current?.send({ type: 'signal', target, data }) ?? false,
      onPeersChanged: setRemotePeers,
      onChatMessage: (message) => {
        setChatMessages((current) => current.some((item) => item.id === message.id) ? current : [...current.slice(-499), message]);
        setChatTypingPeers((current) => ({ ...current, [message.senderId]: false }));
        if (!showChatRef.current) setChatUnread((current) => current + 1);
        notifyWhenBackground(message.senderName || 'Discordy', message.text.length > 140 ? `${message.text.slice(0, 137)}...` : message.text);
      },
      onTypingChanged: (peerId, typing) => setChatTypingPeers((current) => ({ ...current, [peerId]: typing })),
      onChatChannelChanged: (peerId, ready) => setChatReadyPeers((current) => ({ ...current, [peerId]: ready })),
      adaptiveQualityEnabled,
      onLog: appendTechnicalLog,
    });
  }

  const stopLocalTyping = useCallback(() => {
    if (localTypingTimerRef.current !== null) {
      window.clearTimeout(localTypingTimerRef.current);
      localTypingTimerRef.current = null;
    }
    if (localTypingSentRef.current) {
      peerManagerRef.current?.sendTyping(false);
      localTypingSentRef.current = false;
    }
  }, []);

  const updateChatDraft = useCallback((value: string) => {
    const next = value.slice(0, 2000);
    setChatDraft(next);
    const typing = Boolean(next.trim());
    if (!typing) {
      stopLocalTyping();
      return;
    }
    if (!localTypingSentRef.current) {
      const sent = peerManagerRef.current?.sendTyping(true) ?? 0;
      localTypingSentRef.current = sent > 0;
    }
    if (localTypingTimerRef.current !== null) window.clearTimeout(localTypingTimerRef.current);
    localTypingTimerRef.current = window.setTimeout(() => {
      localTypingTimerRef.current = null;
      if (localTypingSentRef.current) {
        peerManagerRef.current?.sendTyping(false);
        localTypingSentRef.current = false;
      }
    }, 1400);
  }, [stopLocalTyping]);

  const sendChatMessage = useCallback(() => {
    const text = chatDraft.trim();
    if (!text || !selfIdRef.current) return;
    const message: ChatMessage = {
      id: createChatMessageId(),
      senderId: selfIdRef.current,
      senderName: name.trim() || 'Você',
      text,
      sentAt: Date.now(),
    };
    const sent = peerManagerRef.current?.sendChatMessage(message) ?? 0;
    if (sent === 0) {
      setStatus('Chat P2P ainda não está conectado');
      appendTechnicalLog('[CHAT] mensagem não enviada: nenhum RTCDataChannel aberto');
      return;
    }
    setChatMessages((current) => [...current.slice(-499), message]);
    setChatDraft('');
    stopLocalTyping();
    appendTechnicalLog(`[CHAT] mensagem enviada diretamente para ${sent} peer(s)`);
  }, [appendTechnicalLog, chatDraft, name, stopLocalTyping]);

  const toggleChatPanel = useCallback(() => {
    setShowChat((current) => {
      const next = !current;
      if (next) {
        setChatUnread(0);
        setShowRoomSettings(false);
        setShowMediaSettings(false);
        setShowDiagnostics(false);
        setShowLogs(false);
      } else {
        stopLocalTyping();
      }
      return next;
    });
  }, [stopLocalTyping]);

  const handleServerMessage = useCallback(async (message: ServerMessage) => {
    const peerManager = peerManagerRef.current!;

    if (message.type === 'error') {
      appendTechnicalLog(`[SERVER${message.code ? ` ${message.code}` : ''}] ${message.message}`);
      setJoinPending(false);
      setError(message.message);
      return;
    }

    if (message.type === 'join-pending') {
      setJoinPending(true);
      setJoinPendingRoomName(message.roomName);
      setStatus('Aguardando aprovação do host...');
      setError(null);
      appendTechnicalLog(`[ROOM] solicitação ${message.requestId.slice(0, 8)} aguardando aprovação`);
      return;
    }

    if (message.type === 'join-denied') {
      setJoinPending(false);
      setStatus('Entrada não aprovada');
      setError(message.message);
      appendTechnicalLog(`[ROOM] entrada recusada: ${message.message}`);
      return;
    }

    if (message.type === 'kicked') {
      appendTechnicalLog(`[ROOM] removido pelo host: ${message.message}`);
      signalingRef.current?.close();
      void leaveRef.current?.().then(() => setError(message.message));
      return;
    }

    if (message.type === 'welcome') {
      const hadSession = Boolean(selfIdRef.current);
      const peerIdChanged = Boolean(selfIdRef.current && selfIdRef.current !== message.peerId);
      if (peerIdChanged) {
        appendTechnicalLog(`[RTC] identidade de sessão alterada; reconstruindo ${message.peers.length} peer(s)`);
        peerManager.resetPeers('signaling-identity-changed');
      }

      selfIdRef.current = message.peerId;
      roomIdRef.current = message.roomId;
      peerManager.setLocalPeerId(message.peerId);
      setSelfId(message.peerId);
      setRoomId(message.roomId);
      setRoomInfo(message.room);
      setParticipants(message.participants);
      setRoomNameDraft(message.room.name);
      setRoomLimitDraft(message.room.maxParticipants);
      setRoomApprovalDraft(message.room.approvalRequired);
      setRoomInviteTtlDraft(message.room.inviteTtlMinutes);
      setJoinPending(false);
      setJoinPin('');
      setInviteInput('');
      setSelfPresence('online');
      setStatus(hadSession ? 'Reconectado' : 'Conectado');
      setError(null);

      for (const peer of message.peers) peerManager.createPeer(peer);
      appendTechnicalLog(`[SERVER] welcome ${message.peerId.slice(0, 8)} em ${message.roomId}; peers=${message.peers.length}; room=${message.room.name}`);
      return;
    }

    if (message.type === 'room-state') {
      setRoomInfo(message.room);
      setRoomNameDraft(message.room.name);
      setRoomLimitDraft(message.room.maxParticipants);
      setRoomApprovalDraft(message.room.approvalRequired);
      setRoomInviteTtlDraft(message.room.inviteTtlMinutes);
      appendTechnicalLog(`[ROOM] estado atualizado name="${message.room.name}" limit=${message.room.maxParticipants} locked=${message.room.locked} approval=${message.room.approvalRequired}`);
      return;
    }

    if (message.type === 'participant-state') {
      setParticipants((current) => upsertParticipant(current, message.participant));
      appendTechnicalLog(`[PRESENCE] ${message.participant.name} -> ${message.participant.presence}`);
      return;
    }

    if (message.type === 'join-request') {
      setPendingJoinRequests((current) => current.some((request) => request.requestId === message.request.requestId) ? current : [...current, message.request]);
      appendTechnicalLog(`[ROOM] solicitação de entrada: ${message.request.name}`);
      notifyWhenBackground('Solicitação de entrada', `${message.request.name} quer entrar na sala.`);
      return;
    }

    if (message.type === 'join-request-removed') {
      setPendingJoinRequests((current) => current.filter((request) => request.requestId !== message.requestId));
      return;
    }

    if (message.type === 'invite-updated') {
      setHostState((current) => {
        if (!current) return current;
        if (!message.enabled || !message.inviteToken || !roomIdRef.current) return { ...current, invite: null, inviteToken: null, inviteExpiresAt: null };
        return {
          ...current,
          inviteToken: message.inviteToken,
          inviteExpiresAt: message.expiresAt ?? null,
          invite: createInvite(current.publicUrl, roomIdRef.current, message.inviteToken),
        };
      });
      setStatus(message.enabled ? 'Novo convite gerado' : message.reason === 'expired' ? 'Convite expirado' : 'Convite invalidado');
      return;
    }

    if (message.type === 'peer-joined') {
      peerManager.createPeer(message.peer);
      setParticipants((current) => upsertParticipant(current, {
        peerId: message.peer.peerId,
        name: message.peer.name,
        isHost: Boolean(message.peer.isHost),
        presence: message.peer.presence ?? 'online',
      }));
      appendTechnicalLog(`[SERVER] ${message.peer.name} entrou (${message.peer.peerId.slice(0, 8)})${message.peer.isHost ? ' [HOST]' : ''}`);
      notifyWhenBackground('Participante conectado', `${message.peer.name} entrou na sala.`);
      return;
    }

    if (message.type === 'peer-left') {
      peerManager.removePeer(message.peerId, 'peer-left');
      setParticipants((current) => current.filter((participant) => participant.peerId !== message.peerId));
      return;
    }

    if (message.type === 'signal') {
      if (!peerManager.hasPeer(message.from)) {
        appendTechnicalLog(`[SECURITY] signaling de peer desconhecido bloqueado: ${message.from.slice(0, 8)}`);
        return;
      }
      try {
        await peerManager.handleSignal(message.from, message.data);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        appendTechnicalLog(`[RTC ${message.from.slice(0, 8)}] erro processando signaling: ${detail}`);
        setError('Falha na negociação WebRTC. Abra os detalhes técnicos para diagnóstico.');
      }
    }
  }, [appendTechnicalLog, notifyWhenBackground]);

  const handleSignalingState = useCallback((next: SignalingState, details?: { attempt?: number; delayMs?: number; reconnected?: boolean }) => {
    if (next === 'connecting') {
      setStatus('Conectando signaling...');
      setSelfPresence('reconnecting');
    }
    if (next === 'open') {
      setStatus(details?.reconnected ? 'Reentrando na sala...' : 'Signaling conectado');
      if (!roomIdRef.current) setSelfPresence('reconnecting');
    }
    if (next === 'reconnecting') {
      const suffix = details?.delayMs ? ` em ${Math.ceil(details.delayMs / 1000)}s` : '';
      setStatus(`Reconectando signaling${suffix}`);
      setSelfPresence('reconnecting');
    }
    if (next === 'closed' && roomIdRef.current) {
      setStatus('Signaling encerrado');
      setSelfPresence('disconnected');
    }
  }, []);

  const refreshMediaDevices = useCallback(async () => {
    try {
      const devices = await mediaControllerRef.current!.enumerateDevices();
      setMediaDevices(devices);
      return devices;
    } catch (cause) {
      appendTechnicalLog(`[MEDIA] falha enumerando dispositivos: ${cause instanceof Error ? cause.message : String(cause)}`);
      return { audioInputs: [], audioOutputs: [], videoInputs: [] } satisfies MediaDeviceCatalog;
    }
  }, [appendTechnicalLog]);

  const ensureMicrophone = useCallback(async () => {
    if (micStreamRef.current) return micStreamRef.current;
    try {
      const controller = mediaControllerRef.current!;
      controller.setMuted(!micEnabled);
      controller.setDeafened(deafened);
      controller.setInputMode(inputMode);
      controller.setSensitivity(sensitivityMode, manualSensitivityDb);
      let stream: MediaStream;
      try {
        stream = await controller.startMicrophone(microphoneDeviceId || undefined);
      } catch (cause) {
        if (!microphoneDeviceId) throw cause;
        appendTechnicalLog('[MEDIA] microfone salvo não está disponível; usando dispositivo padrão');
        setMicrophoneDeviceId('');
        localStorage.setItem('discordy:microphone-device', '');
        stream = await controller.startMicrophone();
      }
      micStreamRef.current = stream;
      peerManagerRef.current?.setMicrophone(stream);
      peerManagerRef.current?.setMicrophoneEnabled(micEnabled && !deafened);
      appendTechnicalLog(`[MEDIA] microphone=${stream.getAudioTracks()[0]?.id.slice(0, 8) || 'none'}`);
      void refreshMediaDevices();
      return stream;
    } catch (cause) {
      appendTechnicalLog(`[MEDIA] microfone indisponível: ${cause instanceof Error ? cause.message : String(cause)}`);
      setMicEnabled(false);
      peerManagerRef.current?.setMicrophone(null);
      return null;
    }
  }, [appendTechnicalLog, deafened, inputMode, manualSensitivityDb, micEnabled, microphoneDeviceId, refreshMediaDevices, sensitivityMode]);

  const connectToRoom = useCallback(async (
    targetServer: string,
    targetRoom: string,
    requestedName: string,
    auth: { inviteToken?: string; pin?: string; hostSecret?: string } = {},
  ) => {
    const cleanName = requestedName.trim().slice(0, 40);
    if (!cleanName) throw new Error('Informe seu nome.');

    localStorage.setItem('discordy:name', cleanName);
    setError(null);
    setJoinPending(false);
    setStatus('Conectando...');
    await ensureMicrophone();

    signalingRef.current?.close();
    const signaling = new SignalingClient(targetServer, appendTechnicalLog);
    signalingRef.current = signaling;
    signaling.setSession(targetRoom, cleanName, auth);
    signaling.onMessage((message) => void handleServerMessage(message));
    signaling.onStateChange(handleSignalingState);

    try {
      await signaling.connect();
      setServerUrl(targetServer);
    } catch (cause) {
      signaling.close();
      if (signalingRef.current === signaling) signalingRef.current = null;
      throw cause;
    }
  }, [appendTechnicalLog, ensureMicrophone, handleServerMessage, handleSignalingState]);

  const checkCloudflared = useCallback(async () => {
    const result = await window.discordy.cloudflared.check();
    setCloudflared({ installed: result.installed, version: result.version });
    return result;
  }, []);

  const createHostedRoom = async () => {
    if (!name.trim()) return setError('Informe seu nome antes de criar a sala.');
    if (!hostRoomName.trim()) return setError('Informe um nome para a sala.');
    if (hostPin && !/^\d{4,12}$/.test(hostPin)) return setError('O PIN deve conter de 4 a 12 números.');
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
      const code = createRoomCode();
      const hosted = await window.discordy.host.start({
        roomId: code,
        roomName: hostRoomName.trim(),
        maxParticipants: hostMaxParticipants,
        pin: hostPin || undefined,
        approvalRequired: hostApprovalRequired,
        inviteTtlMinutes: hostInviteTtlMinutes,
      });
      const invite = createInvite(hosted.publicUrl, hosted.room.roomId, hosted.inviteToken);
      setHostState({ localUrl: hosted.localUrl, publicUrl: hosted.publicUrl, invite, inviteToken: hosted.inviteToken, inviteExpiresAt: hosted.inviteExpiresAt });
      setRoomPinDraft(hostPin);
      setIsHosting(true);
      await connectToRoom(hosted.localUrl, hosted.room.roomId, name, { hostSecret: hosted.hostSecret });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível criar a sala.');
      setIsHosting(false);
      setHostState(null);
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
      await connectToRoom(parsed.serverUrl, parsed.roomId, name, { inviteToken: parsed.inviteToken, pin: joinPin || undefined });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível entrar na sala.');
    } finally {
      setBusy(false);
    }
  };

  const leave = useCallback(async () => {
    signalingRef.current?.close();
    signalingRef.current = null;
    peerManagerRef.current?.reset();

    await mediaControllerRef.current?.destroy();
    micStreamRef.current = null;
    cameraStreamRef.current = null;
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current = null;
    selfIdRef.current = null;
    roomIdRef.current = null;

    setCameraStream(null);
    setScreenStream(null);
    setScreenMetadata(null);
    setExpandedScreenKey(null);
    setScreenPickerOpen(false);
    setRemotePeers([]);
    setParticipants([]);
    setPendingJoinRequests([]);
    setRoomInfo(null);
    setRemoteSpeaking({});
    setPeerVolumes({});
    setChatMessages([]);
    setChatDraft('');
    setChatTypingPeers({});
    setChatReadyPeers({});
    setChatUnread(0);
    setShowChat(false);
    stopLocalTyping();
    setRoomId(null);
    setSelfId(null);
    setSelfPresence('disconnected');
    setServerUrl(null);
    setStatus('Pronto');
    setJoinPending(false);
    setJoinPendingRoomName('');
    setShowLogs(false);
    setShowDiagnostics(false);
    setShowMediaSettings(false);
    setShowRoomSettings(false);
    setDeafened(false);
    setNetworkDiagnostics([]);
    setDiagnosticsError(null);
    setDiagnosticsUpdatedAt(null);

    if (isHosting) await window.discordy.host.stop().catch(() => undefined);
    setIsHosting(false);
    setHostState(null);
    setMode('home');
  }, [isHosting, stopLocalTyping]);
  leaveRef.current = leave;

  const updateRoomSettings = useCallback(() => {
    if (!roomInfo || !isHosting) return;
    if (!roomNameDraft.trim()) return setError('Informe um nome válido para a sala.');
    if (roomPinDraft && !/^\d{4,12}$/.test(roomPinDraft)) return setError('O PIN deve conter de 4 a 12 números.');
    setError(null);
    signalingRef.current?.send({
      type: 'room-update',
      changes: {
        name: roomNameDraft.trim(),
        maxParticipants: roomLimitDraft,
        approvalRequired: roomApprovalDraft,
        pin: roomPinDraft || null,
        inviteTtlMinutes: roomInviteTtlDraft,
      },
    });
    setStatus('Configurações da sala enviadas');
  }, [isHosting, roomApprovalDraft, roomInfo, roomInviteTtlDraft, roomLimitDraft, roomNameDraft, roomPinDraft]);

  const toggleRoomLocked = useCallback(() => {
    if (!roomInfo || !isHosting) return;
    signalingRef.current?.send({ type: 'room-update', changes: { locked: !roomInfo.locked } });
  }, [isHosting, roomInfo]);

  const regenerateInvite = useCallback(() => {
    if (!isHosting) return;
    signalingRef.current?.send({ type: 'invite-regenerate' });
  }, [isHosting]);

  const invalidateInvite = useCallback(() => {
    if (!isHosting) return;
    signalingRef.current?.send({ type: 'invite-invalidate' });
  }, [isHosting]);

  const kickParticipant = useCallback((peerId: string) => {
    if (!isHosting) return;
    signalingRef.current?.send({ type: 'kick', peerId });
  }, [isHosting]);

  const decideJoinRequest = useCallback((requestId: string, approved: boolean) => {
    signalingRef.current?.send({ type: 'join-decision', requestId, approved });
    setPendingJoinRequests((current) => current.filter((request) => request.requestId !== requestId));
  }, []);

  const toggleMic = useCallback(() => {
    const next = !micEnabled;
    setMicEnabled(next);
    mediaControllerRef.current?.setMuted(!next);
    peerManagerRef.current?.setMicrophoneEnabled(next && !deafened);
    appendTechnicalLog(`[VOICE] mute=${!next}`);
  }, [appendTechnicalLog, deafened, micEnabled]);

  const toggleDeafen = useCallback(() => {
    const next = !deafened;
    setDeafened(next);
    mediaControllerRef.current?.setDeafened(next);
    peerManagerRef.current?.setMicrophoneEnabled(micEnabled && !next);
    appendTechnicalLog(`[VOICE] deafen=${next}`);
  }, [appendTechnicalLog, deafened, micEnabled]);

  const toggleCamera = useCallback(async () => {
    const controller = mediaControllerRef.current!;
    if (cameraStreamRef.current) {
      controller.stopCamera();
      cameraStreamRef.current = null;
      peerManagerRef.current?.setCamera(null);
      setCameraStream(null);
      return;
    }
    try {
      let stream: MediaStream;
      try {
        stream = await controller.startCamera(cameraDeviceId || undefined);
      } catch (cause) {
        if (!cameraDeviceId) throw cause;
        appendTechnicalLog('[MEDIA] câmera salva não está disponível; usando dispositivo padrão');
        setCameraDeviceId('');
        localStorage.setItem('discordy:camera-device', '');
        stream = await controller.startCamera();
      }
      cameraStreamRef.current = stream;
      peerManagerRef.current?.setCamera(stream);
      setCameraStream(stream);
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (cameraStreamRef.current !== stream) return;
        cameraStreamRef.current = null;
        peerManagerRef.current?.setCamera(null);
        setCameraStream(null);
      }, { once: true });
      void refreshMediaDevices();
    } catch (cause) {
      appendTechnicalLog(`[MEDIA] câmera indisponível: ${cause instanceof Error ? cause.message : String(cause)}`);
      setError('Não foi possível acessar a câmera selecionada.');
    }
  }, [appendTechnicalLog, cameraDeviceId, refreshMediaDevices]);

  const changeMicrophone = useCallback(async (deviceId: string) => {
    setMicrophoneDeviceId(deviceId);
    localStorage.setItem('discordy:microphone-device', deviceId);
    if (!roomIdRef.current) return;
    try {
      const stream = await mediaControllerRef.current!.switchMicrophone(deviceId || undefined);
      micStreamRef.current = stream;
      peerManagerRef.current?.setMicrophone(stream);
      peerManagerRef.current?.setMicrophoneEnabled(micEnabled && !deafened);
      void refreshMediaDevices();
    } catch (cause) {
      appendTechnicalLog(`[MEDIA] falha trocando microfone: ${cause instanceof Error ? cause.message : String(cause)}`);
      setError('Não foi possível trocar o microfone.');
    }
  }, [appendTechnicalLog, deafened, micEnabled, refreshMediaDevices]);

  const changeCamera = useCallback(async (deviceId: string) => {
    setCameraDeviceId(deviceId);
    localStorage.setItem('discordy:camera-device', deviceId);
    if (!cameraStreamRef.current) return;
    try {
      const stream = await mediaControllerRef.current!.switchCamera(deviceId || undefined);
      cameraStreamRef.current = stream;
      peerManagerRef.current?.setCamera(stream);
      setCameraStream(stream);
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (cameraStreamRef.current !== stream) return;
        cameraStreamRef.current = null;
        peerManagerRef.current?.setCamera(null);
        setCameraStream(null);
      }, { once: true });
      void refreshMediaDevices();
    } catch (cause) {
      appendTechnicalLog(`[MEDIA] falha trocando câmera: ${cause instanceof Error ? cause.message : String(cause)}`);
      setError('Não foi possível trocar a câmera.');
    }
  }, [appendTechnicalLog, refreshMediaDevices]);

  const changeOutputDevice = (deviceId: string) => {
    setOutputDeviceId(deviceId);
    localStorage.setItem('discordy:output-device', deviceId);
    appendTechnicalLog(`[MEDIA] saída de áudio=${deviceId || 'default'}`);
  };

  const handleRemoteSpeaking = useCallback((peerId: string, speaking: boolean) => {
    setRemoteSpeaking((current) => current[peerId] === speaking ? current : { ...current, [peerId]: speaking });
  }, []);

  const stopScreenShare = useCallback(async () => {
    const stream = screenStreamRef.current;
    if (!stream) return;
    screenStreamRef.current = null;
    peerManagerRef.current?.setScreen(null, null);
    setScreenStream(null);
    setScreenMetadata(null);
    setExpandedScreenKey((key) => key === 'local' ? null : key);
    for (const track of stream.getTracks()) track.stop();
    appendTechnicalLog('[SCREEN] compartilhamento local encerrado');
  }, [appendTechnicalLog]);

  const openScreenPicker = useCallback(async () => {
    if (screenStreamRef.current) return;
    setScreenPickerOpen(true);
    setScreenSourcesLoading(true);
    setError(null);
    try {
      const sources = await screenShareControllerRef.current!.listSources();
      setScreenSources(sources);
      appendTechnicalLog(`[SCREEN] ${sources.length} fonte(s) de captura encontrada(s)`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError('Não foi possível listar monitores e janelas.');
      appendTechnicalLog(`[SCREEN] falha listando fontes: ${message}`);
    } finally {
      setScreenSourcesLoading(false);
    }
  }, [appendTechnicalLog]);

  const startScreenShare = useCallback(async (source: ScreenSourceInfo) => {
    if (screenStreamRef.current) return;
    try {
      const session = await screenShareControllerRef.current!.start(source, {
        preset: screenQuality,
        bitrateKbps: screenBitrateKbps,
        systemAudio: screenSystemAudio,
      });
      const { stream, metadata } = session;
      screenStreamRef.current = stream;
      peerManagerRef.current?.setScreen(stream, metadata);
      peerManagerRef.current?.setScreenBitrate(metadata.bitrateKbps);
      setScreenStream(stream);
      setScreenMetadata(metadata);
      setScreenPickerOpen(false);
      const videoTrack = stream.getVideoTracks()[0];
      const settings = videoTrack?.getSettings();
      appendTechnicalLog(`[SCREEN] ${metadata.sourceType}/${metadata.sourceName} preset=${metadata.preset} bitrate=${metadata.bitrateKbps}Kbps audio=${metadata.systemAudio} captura=${settings?.width ?? '?'}x${settings?.height ?? '?'}@${settings?.frameRate ?? '?'}fps`);
      videoTrack?.addEventListener('ended', () => void stopScreenShare(), { once: true });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      appendTechnicalLog(`[SCREEN] compartilhamento cancelado/indisponível: ${message}`);
      if (!(cause instanceof DOMException && cause.name === 'NotAllowedError')) setError('Não foi possível iniciar o compartilhamento selecionado.');
    }
  }, [appendTechnicalLog, screenBitrateKbps, screenQuality, screenSystemAudio, stopScreenShare]);

  const updateScreenQuality = useCallback(async (preset: ScreenQualityPreset) => {
    setScreenQuality(preset);
    localStorage.setItem('discordy:screen-quality', preset);
    const defaultBitrate = SCREEN_QUALITY_PRESETS[preset].defaultBitrateKbps;
    setScreenBitrateKbps(defaultBitrate);
    localStorage.setItem('discordy:screen-bitrate', String(defaultBitrate));
    peerManagerRef.current?.setScreenBitrate(defaultBitrate);

    const stream = screenStreamRef.current;
    if (!stream) return;
    await screenShareControllerRef.current!.applyQuality(stream, preset).catch((cause) => {
      appendTechnicalLog(`[SCREEN] falha aplicando preset ${preset}: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
    const current = screenMetadata;
    if (current) {
      const quality = SCREEN_QUALITY_PRESETS[preset];
      const metadata: ScreenShareMetadata = { ...current, preset, targetWidth: quality.width, targetHeight: quality.height, targetFps: quality.fps, bitrateKbps: defaultBitrate };
      setScreenMetadata(metadata);
      peerManagerRef.current?.updateScreenMetadata(metadata);
    }
  }, [appendTechnicalLog, screenMetadata]);

  const updateScreenBitrate = useCallback((value: number) => {
    const bitrate = Math.max(500, Math.min(20000, Math.round(value)));
    setScreenBitrateKbps(bitrate);
    localStorage.setItem('discordy:screen-bitrate', String(bitrate));
    peerManagerRef.current?.setScreenBitrate(bitrate);
    setScreenMetadata((current) => {
      if (!current) return current;
      const next = { ...current, bitrateKbps: bitrate };
      peerManagerRef.current?.updateScreenMetadata(next);
      return next;
    });
  }, []);

  const updateScreenSystemAudio = (enabled: boolean) => {
    setScreenSystemAudio(enabled);
    localStorage.setItem('discordy:screen-system-audio', String(enabled));
  };

  const copyInvite = async () => {
    if (!hostState?.invite) {
      setStatus('Convite está invalidado');
      return;
    }
    await window.discordy.clipboard.writeText(hostState.invite);
    setStatus('Convite copiado');
  };

  const refreshDiagnostics = useCallback(async () => {
    if (!peerManagerRef.current) return [];
    try {
      const diagnostics = await peerManagerRef.current.getDiagnostics();
      setNetworkDiagnostics(diagnostics);
      setDiagnosticsUpdatedAt(new Date());
      setDiagnosticsError(null);
      return diagnostics;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setDiagnosticsError(message);
      appendTechnicalLog(`[DIAG] falha coletando métricas: ${message}`);
      return [];
    }
  }, [appendTechnicalLog]);

  const testConnections = useCallback(async () => {
    if (!peerManagerRef.current || networkTesting) return;
    setNetworkTesting(true);
    setDiagnosticsError(null);
    appendTechnicalLog('[DIAG] teste de conexão solicitado pelo usuário');
    try {
      const diagnostics = await peerManagerRef.current.testConnections();
      setNetworkDiagnostics(diagnostics);
      setDiagnosticsUpdatedAt(new Date());
      if (diagnostics.length === 0) setDiagnosticsError('Nenhum peer remoto conectado para testar.');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setDiagnosticsError(message);
      appendTechnicalLog(`[DIAG] teste falhou: ${message}`);
    } finally {
      setNetworkTesting(false);
    }
  }, [appendTechnicalLog, networkTesting]);

  const buildTechnicalReport = useCallback((diagnostics: PeerDiagnostics[]) => {
    const lines = [
      `Discordy ${APP_VERSION} — Relatório de rede`,
      `Gerado em: ${new Date().toISOString()}`,
      `Sala: ${roomIdRef.current ?? 'n/d'}`,
      `Peer local: ${selfIdRef.current ?? 'n/d'}`,
      `Servidor: ${serverUrl ?? 'n/d'}`,
      `Modo: ${isHosting ? 'host' : 'convidado'}`,
      `Status: ${status}`,
      `Peers remotos: ${diagnostics.length}`,
      `ICE mode: ${iceConfig.mode}`,
      `STUN: ${iceConfig.stunUrls.join(', ') || 'nenhum'}`,
      `TURN: ${iceConfig.turnUrls.join(', ') || 'nenhum'}`,
      `TURN auth: ${iceConfig.turnUsername ? 'configurada' : 'não configurada'}`,
      `Qualidade adaptativa: ${adaptiveQualityEnabled ? 'ativada' : 'desativada'}`,
      '',
    ];

    for (const peer of diagnostics) {
      lines.push(
        `Peer: ${peer.name} (${peer.peerId})`,
        `  Rota: ${routeLabel(peer.route)}`,
        `  ICE candidates: ${peer.localCandidateType} ↔ ${peer.remoteCandidateType}`,
        `  Transporte: ${peer.candidateProtocol}${peer.relayProtocol ? ` / relay=${peer.relayProtocol}` : ''}`,
        `  Connection: ${peer.connectionState}`,
        `  ICE: ${peer.iceConnectionState} / gathering=${peer.iceGatheringState}`,
        `  Signaling: ${peer.signalingState}`,
        `  RTT: ${formatMetric(peer.rttMs, ' ms')}`,
        `  Jitter: ${formatMetric(peer.jitterMs, ' ms')}`,
        `  Packet loss: ${formatMetric(peer.packetLossPct, '%', 2)} (${peer.packetsLost}/${peer.packetsReceived + peer.packetsLost})`,
        `  Upload: ${formatBitrate(peer.bitrateUpKbps)}`,
        `  Download: ${formatBitrate(peer.bitrateDownKbps)}`,
        `  Codecs TX: ${peer.outboundCodecs.join(', ') || 'n/d'}`,
        `  Codecs RX: ${peer.inboundCodecs.join(', ') || 'n/d'}`,
        `  Vídeo RX: ${videoLabel(peer.receivedVideo)}`,
        ...(peer.adaptiveQuality ? [
          `  Adaptive: ${adaptiveQualityLabel(peer.adaptiveQuality.level)}${peer.adaptiveQuality.badConnection ? ' [CONEXÃO RUIM]' : ''}`,
          `  Adaptive reason: ${peer.adaptiveQuality.reason}`,
          `  Outgoing disponível: ${formatBitrate(peer.adaptiveQuality.availableOutgoingKbps)}`,
          `  Alvo tela: ${peer.adaptiveQuality.targetScreenBitrateKbps === null ? 'n/d' : formatBitrate(peer.adaptiveQuality.targetScreenBitrateKbps)}`,
          `  Alvo câmera: ${peer.adaptiveQuality.targetCameraBitrateKbps === null ? 'n/d' : formatBitrate(peer.adaptiveQuality.targetCameraBitrateKbps)}`,
          `  Adaptive FPS/scale: ${peer.adaptiveQuality.targetFps} FPS / ${peer.adaptiveQuality.scaleResolutionDownBy.toFixed(2)}x`,
        ] : []),
        '',
      );
    }

    lines.push('User-Agent:', navigator.userAgent, '', 'Logs recentes:');
    lines.push(...(technicalLogs.length ? technicalLogs.slice(-80) : ['Sem logs técnicos.']));
    return lines.join('\n');
  }, [adaptiveQualityEnabled, iceConfig, isHosting, serverUrl, status, technicalLogs]);

  const copyTechnicalReport = useCallback(async () => {
    const diagnostics = networkDiagnostics.length > 0 ? networkDiagnostics : await refreshDiagnostics();
    const report = buildTechnicalReport(diagnostics);
    await window.discordy.clipboard.writeText(report);
    setStatus('Relatório técnico copiado');
    appendTechnicalLog(`[DIAG] relatório técnico copiado (${diagnostics.length} peer(s))`);
  }, [appendTechnicalLog, buildTechnicalReport, networkDiagnostics, refreshDiagnostics]);

  const applyIceConnectivity = useCallback(() => {
    const normalized = normalizeIceConnectivityConfig(iceDraft);
    if (normalized.mode === 'turn-only' && normalized.turnUrls.length === 0) {
      setDiagnosticsError('Modo TURN obrigatório exige ao menos uma URL turn: ou turns:.');
      return;
    }
    saveIceConnectivityConfig(normalized);
    setIceConfig(normalized);
    setIceDraft(normalized);
    peerManagerRef.current?.updateConnectivityConfiguration(initialRtcConfiguration(normalized), fallbackRtcConfiguration(normalized));
    setTurnTestResult(null);
    setDiagnosticsError(null);
    setStatus('Configuração ICE aplicada');
    appendTechnicalLog(`[ICE] configuração aplicada: ${configSummary(normalized)}`);
  }, [appendTechnicalLog, iceDraft]);

  const restoreDefaultIceConnectivity = useCallback(() => {
    const defaults = defaultIceConnectivityConfig();
    setIceDraft(defaults);
    setTurnTestResult(null);
    appendTechnicalLog(`[ICE] defaults externos carregados: ${configSummary(defaults)}`);
  }, [appendTechnicalLog]);

  const runTurnTest = useCallback(async () => {
    if (turnTesting) return;
    const candidate = normalizeIceConnectivityConfig(iceDraft);
    setTurnTesting(true);
    setTurnTestResult(null);
    setDiagnosticsError(null);
    appendTechnicalLog(`[TURN] teste iniciado: ${candidate.turnUrls.join(', ') || 'sem servidor'}`);
    try {
      const result = await testTurnConnectivity(candidate);
      setTurnTestResult(result);
      appendTechnicalLog(`[TURN] teste ${result.ok ? 'OK' : 'FALHOU'} em ${Math.round(result.durationMs)}ms: ${result.message}${result.protocol ? ` protocol=${result.protocol}` : ''}`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setTurnTestResult({ ok: false, durationMs: 0, candidateType: null, protocol: null, relayProtocol: null, address: null, port: null, message });
      appendTechnicalLog(`[TURN] teste falhou: ${message}`);
    } finally {
      setTurnTesting(false);
    }
  }, [appendTechnicalLog, iceDraft, turnTesting]);

  const updateAdaptiveQuality = useCallback((enabled: boolean) => {
    setAdaptiveQualityEnabled(enabled);
    localStorage.setItem('discordy:adaptive-quality', String(enabled));
    peerManagerRef.current?.setAdaptiveQualityEnabled(enabled);
    setStatus(enabled ? 'Qualidade adaptativa ativada' : 'Qualidade adaptativa desativada');
    appendTechnicalLog(`[ADAPTIVE] ${enabled ? 'ativado' : 'desativado'} pelo usuário`);
  }, [appendTechnicalLog]);

  const updateTheme = (next: ThemeMode) => {
    setTheme(next);
    localStorage.setItem('discordy:theme', next);
  };

  const updateDensity = (next: DensityMode) => {
    setDensity(next);
    localStorage.setItem('discordy:density', next);
  };

  const updateInputMode = (next: VoiceInputMode) => {
    setInputMode(next);
    localStorage.setItem('discordy:input-mode', next);
    mediaControllerRef.current?.setInputMode(next);
  };

  const updateSensitivityMode = (next: SensitivityMode) => {
    setSensitivityMode(next);
    localStorage.setItem('discordy:sensitivity-mode', next);
    mediaControllerRef.current?.setSensitivity(next, manualSensitivityDb);
  };

  const updateManualSensitivity = (next: number) => {
    setManualSensitivityDb(next);
    localStorage.setItem('discordy:sensitivity-db', String(next));
    mediaControllerRef.current?.setSensitivity(sensitivityMode, next);
  };

  const updatePushToMute = (enabled: boolean) => {
    setPushToMuteEnabled(enabled);
    localStorage.setItem('discordy:push-to-mute', String(enabled));
    if (!enabled) {
      setPushToMutePressed(false);
      mediaControllerRef.current?.setPushToMutePressed(false);
    }
  };

  const checkForUpdates = useCallback(async () => {
    try { setUpdateState(await window.discordy.updates.check()); } catch { /* updater publica o erro */ }
  }, []);

  const downloadUpdate = useCallback(async () => {
    try { setUpdateState(await window.discordy.updates.download()); } catch { /* updater publica o erro */ }
  }, []);

  const installUpdate = useCallback(async () => {
    try { await window.discordy.updates.install(); } catch { /* updater publica o erro */ }
  }, []);

  const updateDesktopPreference = useCallback(async <K extends keyof DesktopPreferences>(key: K, value: DesktopPreferences[K]) => {
    try {
      const next = await window.discordy.desktop.updatePreferences({ [key]: value });
      setDesktopRuntime(next);
      appendTechnicalLog(`[DESKTOP] ${key}=${String(value)}`);
    } catch (cause) {
      appendTechnicalLog(`[DESKTOP] falha atualizando ${key}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }, [appendTechnicalLog]);

  const setPeerVolume = (peerId: string, volume: number) => {
    setPeerVolumes((current) => ({ ...current, [peerId]: volume }));
  };

  useEffect(() => {
    localStorage.setItem('discordy:name', name.slice(0, 40));
  }, [name]);

  useEffect(() => {
    localStorage.setItem('discordy:host-room-name', hostRoomName.slice(0, 60));
    localStorage.setItem('discordy:host-max-participants', String(hostMaxParticipants));
    localStorage.setItem('discordy:host-approval-required', String(hostApprovalRequired));
    localStorage.setItem('discordy:host-invite-ttl', String(hostInviteTtlMinutes));
  }, [hostApprovalRequired, hostInviteTtlMinutes, hostMaxParticipants, hostRoomName]);

  useEffect(() => {
    if (localPreviewRef.current) localPreviewRef.current.srcObject = cameraStream;
  }, [cameraStream]);

  useEffect(() => {
    const controller = mediaControllerRef.current!;
    controller.setMuted(!micEnabled);
    controller.setDeafened(deafened);
    controller.setInputMode(inputMode);
    controller.setSensitivity(sensitivityMode, manualSensitivityDb);
  }, [deafened, inputMode, manualSensitivityDb, micEnabled, sensitivityMode]);

  useEffect(() => {
    if (!navigator.mediaDevices?.addEventListener) return undefined;
    const handleDeviceChange = () => void refreshMediaDevices();
    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
  }, [refreshMediaDevices]);

  useEffect(() => {
    if (!roomId) return undefined;
    const isEditableTarget = (target: EventTarget | null) => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target) || event.repeat) return;
      if (event.code === 'KeyV' && inputMode === 'push-to-talk') {
        setPushToTalkPressed(true);
        mediaControllerRef.current?.setPushToTalkPressed(true);
      }
      if (event.code === 'KeyM' && pushToMuteEnabled) {
        setPushToMutePressed(true);
        mediaControllerRef.current?.setPushToMutePressed(true);
        peerManagerRef.current?.setMicrophoneEnabled(false);
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'KeyV') {
        setPushToTalkPressed(false);
        mediaControllerRef.current?.setPushToTalkPressed(false);
      }
      if (event.code === 'KeyM') {
        setPushToMutePressed(false);
        mediaControllerRef.current?.setPushToMutePressed(false);
        peerManagerRef.current?.setMicrophoneEnabled(micEnabled && !deafened);
      }
    };
    const releaseShortcuts = () => {
      setPushToTalkPressed(false);
      setPushToMutePressed(false);
      mediaControllerRef.current?.setPushToTalkPressed(false);
      mediaControllerRef.current?.setPushToMutePressed(false);
      peerManagerRef.current?.setMicrophoneEnabled(micEnabled && !deafened);
    };
    const handleBlur = () => {
      if (desktopRuntime?.preferences.globalShortcuts && desktopRuntime.shortcuts.holdKeys) return;
      releaseShortcuts();
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
      if (!(desktopRuntime?.preferences.globalShortcuts && desktopRuntime.shortcuts.holdKeys)) releaseShortcuts();
    };
  }, [deafened, desktopRuntime?.preferences.globalShortcuts, desktopRuntime?.shortcuts.holdKeys, inputMode, micEnabled, pushToMuteEnabled, roomId]);

  useEffect(() => {
    let active = true;
    void window.discordy.updates.getState()
      .then((state) => { if (active) setUpdateState(state); })
      .catch(() => undefined);
    const unsubscribe = window.discordy.updates.onState((state) => setUpdateState(state));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;
    void window.discordy.desktop.getState().then((state) => {
      if (!active) return;
      setDesktopRuntime(state);
      appendTechnicalLog(`[DESKTOP] tray=${state.preferences.closeToTray || state.preferences.minimizeToTray} startup=${state.preferences.launchAtStartup} global=${state.preferences.globalShortcuts}`);
    }).catch((cause) => appendTechnicalLog(`[DESKTOP] falha lendo estado: ${cause instanceof Error ? cause.message : String(cause)}`));

    const unsubscribeCommand = window.discordy.desktop.onCommand((command) => {
      if (command.type === 'toggle-mute') {
        toggleMic();
        return;
      }
      if (command.type === 'toggle-deafen') {
        toggleDeafen();
        return;
      }
      if (command.type === 'ptt-down' && roomIdRef.current && inputMode === 'push-to-talk') {
        setPushToTalkPressed(true);
        mediaControllerRef.current?.setPushToTalkPressed(true);
        return;
      }
      if (command.type === 'ptt-up') {
        setPushToTalkPressed(false);
        mediaControllerRef.current?.setPushToTalkPressed(false);
        return;
      }
      if (command.type === 'ptm-down' && roomIdRef.current && pushToMuteEnabled) {
        setPushToMutePressed(true);
        mediaControllerRef.current?.setPushToMutePressed(true);
        peerManagerRef.current?.setMicrophoneEnabled(false);
        return;
      }
      if (command.type === 'ptm-up') {
        setPushToMutePressed(false);
        mediaControllerRef.current?.setPushToMutePressed(false);
        peerManagerRef.current?.setMicrophoneEnabled(micEnabled && !deafened);
      }
    });
    const unsubscribePreferences = window.discordy.desktop.onPreferencesChanged((state) => setDesktopRuntime(state));

    return () => {
      active = false;
      unsubscribeCommand();
      unsubscribePreferences();
    };
  }, [appendTechnicalLog, deafened, inputMode, micEnabled, pushToMuteEnabled, toggleDeafen, toggleMic]);

  useEffect(() => {
    window.discordy.desktop.updateMediaState({ micEnabled, deafened });
  }, [deafened, micEnabled]);

  useEffect(() => {
    if (!expandedScreenKey) return;
    if (expandedScreenKey === 'local') {
      if (!screenStream) setExpandedScreenKey(null);
      return;
    }
    const peerId = expandedScreenKey.startsWith('peer:') ? expandedScreenKey.slice(5) : '';
    const active = remotePeers.some((peer) => peer.peerId === peerId && peer.media.screen);
    if (!active) setExpandedScreenKey(null);
  }, [expandedScreenKey, remotePeers, screenStream]);

  useEffect(() => {
    if (!showDiagnostics || !roomId || networkTesting) return undefined;
    void refreshDiagnostics();
    const timer = window.setInterval(() => void refreshDiagnostics(), 2000);
    return () => window.clearInterval(timer);
  }, [networkTesting, refreshDiagnostics, roomId, showDiagnostics]);

  useEffect(() => {
    const unsubscribeStatus = window.discordy.host.onStatus((next) => setStatus(next.message));
    const unsubscribeLog = window.discordy.host.onLog((line) => appendTechnicalLog(`[HOST] ${line}`));
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
  }, [appendTechnicalLog, checkCloudflared, name, roomId]);

  useEffect(() => () => {
    stopLocalTyping();
    signalingRef.current?.close();
    peerManagerRef.current?.reset();
    void mediaControllerRef.current?.destroy();
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
  }, [stopLocalTyping]);

  const rootClassName = `discordy-root theme-${theme} density-${density}`;

  if (roomId) {
    const fallbackParticipants: ParticipantInfo[] = [
      { peerId: selfId || 'local', name: name || 'Você', isHost: isHosting, presence: selfPresence },
      ...remotePeers.map((peer) => ({ peerId: peer.peerId, name: peer.name, isHost: Boolean(peer.isHost), presence: peer.presence ?? (peer.connectionState === 'connected' ? 'online' : 'reconnecting') as PresenceState })),
    ];
    const listedParticipants = (participants.length ? participants : fallbackParticipants).map((participant) => participant.peerId === selfId ? { ...participant, presence: selfPresence } : participant);
    const totalParticipants = listedParticipants.length;
    const roomLimit = roomInfo?.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS;
    const roomDisplayName = roomInfo?.name || `Sala ${roomId}`;
    const inputLevelPercent = Math.max(0, Math.min(100, ((voiceActivity.levelDb + 80) / 60) * 100));
    const thresholdPercent = Math.max(0, Math.min(100, ((voiceActivity.thresholdDb + 80) / 60) * 100));
    const remoteScreenPeers = remotePeers.filter((peer) => peer.media.screen && peer.stream.getVideoTracks().some((track) => track.readyState === 'live' && (!peer.mediaTrackIds.screen || track.id === peer.mediaTrackIds.screen)));
    const screenShareCount = remoteScreenPeers.length + (screenStream ? 1 : 0);
    const hasScreenShares = screenShareCount > 0;
    const chatReadyCount = remotePeers.reduce((count, peer) => count + (chatReadyPeers[peer.peerId] ? 1 : 0), 0);
    const typingNames = remotePeers.filter((peer) => chatTypingPeers[peer.peerId]).map((peer) => peer.name);

    return (
      <main className={rootClassName}>
        <UpdateBanner state={updateState} onCheck={() => void checkForUpdates()} onDownload={() => void downloadUpdate()} onInstall={() => void installUpdate()} />
        <div className="discord-shell">
          <aside className="server-rail" aria-label="Navegação de salas">
            <button className="rail-button rail-button--brand" title="Discordy" aria-label="Discordy"><span>D</span></button>
            <div className="rail-separator" />
            <button className="rail-button rail-button--room rail-button--active" title={roomDisplayName} aria-label={roomDisplayName}>
              <span>{roomId.slice(0, 2).toUpperCase()}</span>
            </button>
            <button className="rail-button rail-button--add" title="Crie outra sala depois de sair" aria-label="Nova sala" disabled><Icon name="plus" /></button>
          </aside>

          <aside className="room-sidebar">
            <header className="sidebar-room-header">
              <div>
                <strong>{roomDisplayName}</strong>
                <span>{isHosting ? 'Hospedada neste PC' : roomInfo?.locked ? 'Entrada bloqueada' : 'Sala privada'}</span>
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
                  <div className={`voice-user ${voiceActivity.speaking ? 'is-speaking' : ''}`}>
                    <span className="avatar avatar--xs">{initialFor(name)}</span>
                    <span className="voice-user__name">{name || 'Você'}</span>
                    {(!micEnabled || deafened) && <Icon name="micOff" size={13} />}
                  </div>
                  {remotePeers.map((peer) => (
                    <div className={`voice-user ${remoteSpeaking[peer.peerId] ? 'is-speaking' : ''}`} key={peer.peerId}>
                      <span className="avatar avatar--xs avatar--remote">{initialFor(peer.name)}</span>
                      <span className="voice-user__name">{peer.name}</span>
                      {!peer.media.microphone && <Icon name="micOff" size={13} />}
                    </div>
                  ))}
                </div>
              </section>

              {hostState && (
                <section className={`sidebar-card ${!hostState.invite ? 'sidebar-card--muted' : ''}`}>
                  <div className="sidebar-card__title"><Icon name="users" size={15} /><strong>Convite da sala</strong></div>
                  <p>{hostState.invite ? `${hostState.publicUrl.replace(/^https?:\/\//, '')} · ${inviteExpiryLabel(hostState.inviteExpiresAt)}` : 'Convite inválido ou expirado'}</p>
                  <div className="sidebar-card__actions">
                    <button className="sidebar-action" disabled={!hostState.invite} onClick={() => void copyInvite()}><Icon name="copy" size={15} />Copiar</button>
                    <button className="sidebar-action sidebar-action--secondary" onClick={regenerateInvite}>Novo</button>
                  </div>
                </section>
              )}

              {isHosting && pendingJoinRequests.length > 0 && (
                <section className="sidebar-card join-requests-card">
                  <div className="sidebar-card__title"><Icon name="users" size={15} /><strong>Solicitações</strong><span className="request-count">{pendingJoinRequests.length}</span></div>
                  {pendingJoinRequests.map((request) => (
                    <div className="join-request-row" key={request.requestId}>
                      <span className="avatar avatar--xs avatar--remote">{initialFor(request.name)}</span>
                      <div><strong>{request.name}</strong><small>Quer entrar na sala</small></div>
                      <button className="request-button request-button--approve" onClick={() => decideJoinRequest(request.requestId, true)}>Aceitar</button>
                      <button className="request-button" onClick={() => decideJoinRequest(request.requestId, false)}>Recusar</button>
                    </div>
                  ))}
                </section>
              )}
            </div>

            <div className="sidebar-bottom">
              <section className="voice-status-panel">
                <div className="voice-status-row">
                  <div><span className="connection-dot" /><strong>Voz conectada</strong><small>WebRTC P2P · {status}</small></div>
                  <div className="voice-status-tools">
                    <button className={`icon-button icon-button--small ${showDiagnostics ? 'is-active' : ''}`} title="Diagnóstico de rede" onClick={() => { setShowDiagnostics((value) => !value); setShowLogs(false); setShowMediaSettings(false); setShowRoomSettings(false); setShowChat(false); stopLocalTyping(); }}><Icon name="activity" size={16} /></button>
                    <button className={`icon-button icon-button--small ${showLogs ? 'is-active' : ''}`} title="Logs técnicos" onClick={() => { setShowLogs((value) => !value); setShowDiagnostics(false); setShowMediaSettings(false); setShowRoomSettings(false); setShowChat(false); stopLocalTyping(); }}><Icon name="logs" size={16} /></button>
                  </div>
                </div>
                <div className="voice-status-actions">
                  <button className="mini-action" onClick={() => void (screenStream ? stopScreenShare() : openScreenPicker())}><Icon name="screen" size={15} />{screenStream ? 'Parar tela' : 'Tela'}</button>
                  <button className={`mini-action ${cameraStream ? 'is-active' : ''}`} onClick={() => void toggleCamera()}><Icon name="video" size={15} />{cameraStream ? 'Parar vídeo' : 'Vídeo'}</button>
                </div>
              </section>

              <section className="current-user-panel">
                <span className="avatar avatar--sm">{initialFor(name)}</span>
                <div className="current-user-copy"><strong>{name || 'Você'}</strong><span>{selfId ? `#${selfId.slice(0, 4)}` : 'local'}</span></div>
                <button className={`icon-button icon-button--small ${!micEnabled ? 'is-danger' : ''}`} title={micEnabled ? 'Silenciar microfone' : 'Ativar microfone'} onClick={toggleMic}><Icon name={micEnabled ? 'mic' : 'micOff'} size={17} /></button>
                <button className={`icon-button icon-button--small ${deafened ? 'is-danger' : ''}`} title={deafened ? 'Ativar áudio' : 'Deafen'} onClick={toggleDeafen}><Icon name="headphones" size={17} /></button>
                <button className={`icon-button icon-button--small ${showMediaSettings ? 'is-active' : ''}`} title="Voz e vídeo" onClick={() => { setShowMediaSettings((value) => !value); setShowDiagnostics(false); setShowLogs(false); setShowRoomSettings(false); setShowChat(false); stopLocalTyping(); void refreshMediaDevices(); }}><Icon name="settings" size={17} /></button>
              </section>
            </div>
          </aside>

          <section className="main-stage">
            <header className="topbar">
              <div className="topbar-channel">
                <Icon name="volume" size={19} />
                <strong>Geral</strong>
                <span className="topbar-divider" />
                <span>{roomDisplayName}</span>
                <small className="room-code-label">{roomId}</small>
              </div>
              <div className="topbar-actions">
                <span className="participant-count"><Icon name="users" size={17} />{totalParticipants}/{roomLimit}</span>
                <button className={`topbar-button chat-toggle ${showChat ? 'is-active' : ''}`} onClick={toggleChatPanel} title="Chat P2P">
                  <Icon name="chat" size={17} /><span>Chat</span>{chatUnread > 0 && <b className="chat-unread">{chatUnread > 99 ? '99+' : chatUnread}</b>}
                </button>
                {isHosting && <button className={`topbar-button ${showRoomSettings ? 'is-active' : ''}`} onClick={() => { setShowRoomSettings((value) => !value); setShowMediaSettings(false); setShowDiagnostics(false); setShowLogs(false); setShowChat(false); stopLocalTyping(); }} title="Gerenciar sala"><Icon name="settings" size={17} /><span>Gerenciar</span></button>}
                {hostState?.invite && <button className="topbar-button" onClick={() => void copyInvite()} title="Copiar convite"><Icon name="copy" size={17} /><span>Convidar</span></button>}
              </div>
            </header>

            <div className={`stage-content ${hasScreenShares ? 'stage-content--with-screen' : ''}`}>
              {error && <div className="alert alert--stage">{error}</div>}

              {showChat && (
                <ChatPanel
                  messages={chatMessages}
                  selfId={selfId}
                  draft={chatDraft}
                  typingNames={typingNames}
                  readyPeerCount={chatReadyCount}
                  remotePeerCount={remotePeers.length}
                  onDraftChange={updateChatDraft}
                  onSend={sendChatMessage}
                  onClose={toggleChatPanel}
                />
              )}

              {screenPickerOpen && (
                <section className="screen-picker-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setScreenPickerOpen(false); }}>
                  <div className="screen-picker" role="dialog" aria-modal="true" aria-label="Compartilhar tela">
                    <header className="screen-picker__header">
                      <div><strong>Compartilhar sua tela</strong><span>Escolha um monitor ou uma janela.</span></div>
                      <button className="text-button" onClick={() => setScreenPickerOpen(false)}>Cancelar</button>
                    </header>
                    <div className="screen-picker__settings">
                      <label>Qualidade
                        <select value={screenQuality} onChange={(event) => void updateScreenQuality(event.target.value as ScreenQualityPreset)}>
                          {Object.entries(SCREEN_QUALITY_PRESETS).map(([key, preset]) => <option key={key} value={key}>{preset.label}</option>)}
                        </select>
                      </label>
                      <label>Bitrate
                        <select value={screenBitrateKbps} onChange={(event) => updateScreenBitrate(Number(event.target.value))}>
                          {[1500, 2500, 4500, 6000, 8000, 12000, 16000, 20000].map((value) => <option key={value} value={value}>{value >= 1000 ? `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)} Mbps` : `${value} Kbps`}</option>)}
                        </select>
                      </label>
                      <label className="screen-audio-toggle"><input type="checkbox" checked={screenSystemAudio} onChange={(event) => updateScreenSystemAudio(event.target.checked)} /><span>Compartilhar áudio do sistema</span></label>
                    </div>
                    <div className="screen-picker__body">
                      {screenSourcesLoading && <div className="screen-picker__empty">Buscando monitores e janelas...</div>}
                      {!screenSourcesLoading && screenSources.length === 0 && <div className="screen-picker__empty">Nenhuma fonte de captura disponível.</div>}
                      {screenSources.map((source) => (
                        <button className="screen-source-card" key={source.id} onClick={() => void startScreenShare(source)}>
                          <span className="screen-source-card__preview">{source.thumbnail ? <img src={source.thumbnail} alt="" /> : <span>Sem prévia</span>}</span>
                          <span className="screen-source-card__copy"><strong>{source.name}</strong><small>{source.type === 'monitor' ? 'Monitor' : 'Janela'}</small></span>
                        </button>
                      ))}
                    </div>
                  </div>
                </section>
              )}

              {showRoomSettings && isHosting && roomInfo && (
                <section className="media-settings-drawer room-settings-drawer">
                  <div className="media-settings__header">
                    <div><strong>Gerenciar sala</strong><span>Identidade, acesso e convite</span></div>
                    <button className="text-button" onClick={() => setShowRoomSettings(false)}>Fechar</button>
                  </div>
                  <div className="media-settings__body room-settings__body">
                    <div className="settings-group">
                      <strong>Sala</strong>
                      <label>Nome da sala
                        <input value={roomNameDraft} maxLength={60} onChange={(event) => setRoomNameDraft(event.target.value)} />
                      </label>
                      <label>Limite de participantes
                        <select value={roomLimitDraft} onChange={(event) => setRoomLimitDraft(Number(event.target.value) as 2 | 3 | 4)}>
                          <option value={2}>2 participantes</option>
                          <option value={3}>3 participantes</option>
                          <option value={4}>4 participantes</option>
                        </select>
                      </label>
                      <label>PIN opcional
                        <input type="password" inputMode="numeric" value={roomPinDraft} maxLength={12} onChange={(event) => setRoomPinDraft(event.target.value.replace(/\D/g, '').slice(0, 12))} placeholder={roomInfo.pinRequired ? 'PIN atual configurado' : 'Sem PIN'} />
                      </label>
                      <label>Expiração de novos convites
                        <select value={roomInviteTtlDraft} onChange={(event) => setRoomInviteTtlDraft(Number(event.target.value) as InviteTtlMinutes)}><option value={15}>15 minutos</option><option value={30}>30 minutos</option><option value={60}>1 hora</option><option value={360}>6 horas</option><option value={1440}>24 horas</option></select>
                      </label>
                      <label className="settings-checkbox"><input type="checkbox" checked={roomApprovalDraft} onChange={(event) => setRoomApprovalDraft(event.target.checked)} /><span>Exigir confirmação do host para entrar</span></label>
                      <button className="button button--primary" onClick={updateRoomSettings}>Salvar configurações</button>
                    </div>

                    <div className="settings-group">
                      <strong>Controle de entrada</strong>
                      <div className="room-access-state">
                        <span className={`room-state-dot ${roomInfo.locked ? 'is-locked' : ''}`} />
                        <div><strong>{roomInfo.locked ? 'Entrada bloqueada' : 'Entrada liberada'}</strong><small>{roomInfo.locked ? 'Novos participantes não podem entrar.' : 'Convites válidos podem solicitar entrada.'}</small></div>
                        <button className={`button ${roomInfo.locked ? 'button--primary' : ''}`} onClick={toggleRoomLocked}>{roomInfo.locked ? 'Desbloquear' : 'Bloquear'}</button>
                      </div>
                    </div>

                    <div className="settings-group">
                      <strong>Convite</strong>
                      <div className="room-invite-state">
                        <div><strong>{roomInfo.inviteEnabled ? 'Convite ativo' : 'Convite inválido/expirado'}</strong><small>{roomInfo.inviteEnabled ? `${inviteExpiryLabel(roomInfo.inviteExpiresAt)} · Gerar outro invalida o link atual.` : 'Gere um novo convite para liberar novas entradas.'}</small></div>
                        <div className="actions">
                          <button className="button" onClick={regenerateInvite}>Gerar novo convite</button>
                          <button className="button button--danger-subtle" disabled={!roomInfo.inviteEnabled} onClick={invalidateInvite}>Invalidar convite</button>
                        </div>
                      </div>
                    </div>
                  </div>
                </section>
              )}

              {showMediaSettings && (
                <section className="media-settings-drawer">
                  <div className="media-settings__header">
                    <div><strong>Voz, vídeo e tela</strong><span>Dispositivos, sensibilidade e compartilhamento</span></div>
                    <button className="text-button" onClick={() => setShowMediaSettings(false)}>Fechar</button>
                  </div>
                  <div className="media-settings__body">
                    <div className="settings-group">
                      <strong>Dispositivos</strong>
                      <label>Microfone
                        <select value={microphoneDeviceId} onChange={(event) => void changeMicrophone(event.target.value)}>
                          <option value="">Padrão do sistema</option>
                          {mediaDevices.audioInputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microfone ${index + 1}`}</option>)}
                        </select>
                      </label>
                      <label>Saída de áudio
                        <select value={outputDeviceId} onChange={(event) => changeOutputDevice(event.target.value)}>
                          <option value="">Padrão do sistema</option>
                          {mediaDevices.audioOutputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Saída ${index + 1}`}</option>)}
                        </select>
                      </label>
                      <label>Câmera
                        <select value={cameraDeviceId} onChange={(event) => void changeCamera(event.target.value)}>
                          <option value="">Padrão do sistema</option>
                          {mediaDevices.videoInputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Câmera ${index + 1}`}</option>)}
                        </select>
                      </label>
                    </div>

                    <div className="settings-group">
                      <strong>Modo de entrada</strong>
                      <div className="segmented-control segmented-control--wide">
                        <button className={inputMode === 'voice-activity' ? 'is-active' : ''} onClick={() => updateInputMode('voice-activity')}>Atividade de voz</button>
                        <button className={inputMode === 'push-to-talk' ? 'is-active' : ''} onClick={() => updateInputMode('push-to-talk')}>Push-to-Talk</button>
                      </div>
                      {inputMode === 'push-to-talk' && <div className={`shortcut-state ${pushToTalkPressed ? 'is-active' : ''}`}><kbd>V</kbd><span>Segure V para transmitir</span></div>}
                    </div>

                    <div className="settings-group">
                      <div className="settings-row settings-row--between"><strong>Sensibilidade</strong><span>{Math.round(voiceActivity.thresholdDb)} dB</span></div>
                      <div className="segmented-control segmented-control--wide">
                        <button className={sensitivityMode === 'automatic' ? 'is-active' : ''} onClick={() => updateSensitivityMode('automatic')}>Automática</button>
                        <button className={sensitivityMode === 'manual' ? 'is-active' : ''} onClick={() => updateSensitivityMode('manual')}>Manual</button>
                      </div>
                      <div className="voice-meter">
                        <span className="voice-meter__level" style={{ width: `${inputLevelPercent}%` }} />
                        <span className="voice-meter__threshold" style={{ left: `${thresholdPercent}%` }} />
                      </div>
                      {sensitivityMode === 'manual' && (
                        <input className="sensitivity-range" type="range" min="-80" max="-20" step="1" value={manualSensitivityDb} onChange={(event) => updateManualSensitivity(Number(event.target.value))} />
                      )}
                      <small>{voiceActivity.transmitting ? 'Transmitindo voz' : voiceActivity.speaking ? 'Voz detectada' : 'Aguardando voz'}</small>
                    </div>

                    <div className="settings-group">
                      <div className="settings-row settings-row--between">
                        <div><strong>Push-to-Mute</strong><small>Segure M para cortar o microfone.</small></div>
                        <label className="switch-control"><input type="checkbox" checked={pushToMuteEnabled} onChange={(event) => updatePushToMute(event.target.checked)} /><span /></label>
                      </div>
                      {pushToMuteEnabled && <div className={`shortcut-state ${pushToMutePressed ? 'is-danger' : ''}`}><kbd>M</kbd><span>{pushToMutePressed ? 'Microfone temporariamente fechado' : 'Segure M para silenciar'}</span></div>}
                    </div>

                    {desktopRuntime && (
                      <div className="settings-group desktop-settings-group">
                        <div className="settings-row settings-row--between"><strong>Experiência desktop</strong><span>Bandeja, Windows e atalhos</span></div>
                        <div className="desktop-toggle-list">
                          <div className="settings-row settings-row--between"><div><strong>Minimizar para bandeja</strong><small>O botão minimizar oculta a janela e mantém a chamada ativa.</small></div><label className="switch-control"><input type="checkbox" checked={desktopRuntime.preferences.minimizeToTray} onChange={(event) => void updateDesktopPreference('minimizeToTray', event.target.checked)} /><span /></label></div>
                          <div className="settings-row settings-row--between"><div><strong>Fechar para bandeja</strong><small>Fechar a janela não encerra o Discordy.</small></div><label className="switch-control"><input type="checkbox" checked={desktopRuntime.preferences.closeToTray} onChange={(event) => void updateDesktopPreference('closeToTray', event.target.checked)} /><span /></label></div>
                          <div className="settings-row settings-row--between"><div><strong>Notificações nativas</strong><small>Mensagens, participantes e solicitações quando o app estiver em segundo plano.</small></div><label className="switch-control"><input type="checkbox" checked={desktopRuntime.preferences.notifications} disabled={!desktopRuntime.notificationSupported} onChange={(event) => void updateDesktopPreference('notifications', event.target.checked)} /><span /></label></div>
                          <div className="settings-row settings-row--between"><div><strong>Iniciar com o Windows</strong><small>{desktopRuntime.launchAtStartupSupported ? 'Inicia oculto na bandeja.' : 'Disponível no aplicativo empacotado/instalado.'}</small></div><label className="switch-control"><input type="checkbox" checked={desktopRuntime.preferences.launchAtStartup} disabled={!desktopRuntime.launchAtStartupSupported} onChange={(event) => void updateDesktopPreference('launchAtStartup', event.target.checked)} /><span /></label></div>
                          <div className="settings-row settings-row--between"><div><strong>Atalhos globais</strong><small>Funcionam mesmo com o Discordy minimizado.</small></div><label className="switch-control"><input type="checkbox" checked={desktopRuntime.preferences.globalShortcuts} onChange={(event) => void updateDesktopPreference('globalShortcuts', event.target.checked)} /><span /></label></div>
                        </div>
                        <div className="desktop-shortcuts-list">
                          <div><kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>M</kbd><small>Mute</small></div>
                          <div><kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>D</kbd><small>Deafen</small></div>
                          <div><kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>Espaço</kbd><small>Mostrar/ocultar</small></div>
                          <div><kbd>V</kbd><small>Push-to-Talk pressionar/soltar</small></div>
                          <div><kbd>M</kbd><small>Push-to-Mute pressionar/soltar</small></div>
                        </div>
                        <small className="desktop-runtime-note">Atalhos: mute {desktopRuntime.shortcuts.mute ? '✓' : '×'} · deafen {desktopRuntime.shortcuts.deafen ? '✓' : '×'} · janela {desktopRuntime.shortcuts.toggleWindow ? '✓' : '×'} · PTT global {desktopRuntime.shortcuts.holdKeys ? '✓' : desktopRuntime.globalHoldSupported ? '×' : 'n/d'}</small>
                        {updateState && (
                          <div className="desktop-update-status">
                            <div><strong>Atualizações</strong><small>Versão instalada: {updateState.currentVersion}. {updateState.message}</small></div>
                            <button className="button" disabled={!updateState.supported || updateState.status === 'checking' || updateState.status === 'downloading'} onClick={() => void checkForUpdates()}>Verificar agora</button>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="settings-group">
                      <div className="settings-row settings-row--between"><strong>Compartilhamento de tela</strong><span>{screenStream ? 'Transmitindo' : 'Pronto'}</span></div>
                      <label>Qualidade
                        <select value={screenQuality} onChange={(event) => void updateScreenQuality(event.target.value as ScreenQualityPreset)}>
                          {Object.entries(SCREEN_QUALITY_PRESETS).map(([key, preset]) => <option key={key} value={key}>{preset.label}</option>)}
                        </select>
                      </label>
                      <label>Bitrate máximo <span className="inline-value">{screenBitrateKbps >= 1000 ? `${(screenBitrateKbps / 1000).toFixed(1)} Mbps` : `${screenBitrateKbps} Kbps`}</span>
                        <input type="range" min="500" max="20000" step="250" value={screenBitrateKbps} onChange={(event) => updateScreenBitrate(Number(event.target.value))} />
                      </label>
                      <div className="settings-row settings-row--between">
                        <div><strong>Áudio do sistema</strong><small>Opcional. No Windows usa captura loopback.</small></div>
                        <label className="switch-control"><input type="checkbox" checked={screenSystemAudio} disabled={Boolean(screenStream)} onChange={(event) => updateScreenSystemAudio(event.target.checked)} /><span /></label>
                      </div>
                      {screenStream && <small>Para alterar a origem ou o áudio do sistema, pare a transmissão atual e compartilhe novamente.</small>}
                    </div>

                    {remotePeers.length > 0 && (
                      <div className="settings-group">
                        <strong>Volumes individuais</strong>
                        {remotePeers.map((peer) => (
                          <label className="settings-peer-volume" key={peer.peerId}>
                            <span>{peer.name}</span>
                            <input type="range" min="0" max="100" step="5" value={peerVolumes[peer.peerId] ?? 100} onChange={(event) => setPeerVolume(peer.peerId, Number(event.target.value))} />
                            <small>{peerVolumes[peer.peerId] ?? 100}%</small>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                </section>
              )}

              {showDiagnostics && (
                <section className="network-drawer">
                  <div className="network-drawer__header">
                    <div><strong>Diagnóstico WebRTC</strong><span>{diagnosticsUpdatedAt ? `Atualizado ${diagnosticsUpdatedAt.toLocaleTimeString('pt-BR', { hour12: false })}` : 'Coletando métricas...'}</span></div>
                    <div className="network-drawer__actions">
                      <button className="button button--compact" disabled={networkTesting} onClick={() => void testConnections()}>{networkTesting ? 'Testando...' : 'Testar conexão'}</button>
                      <button className="button button--compact" onClick={() => void copyTechnicalReport()}><Icon name="copy" size={14} />Copiar relatório</button>
                      <button className="text-button" onClick={() => setShowDiagnostics(false)}>Fechar</button>
                    </div>
                  </div>
                  <div className="network-drawer__body">
                    <section className="adaptive-quality-settings">
                      <div className="adaptive-quality-settings__header">
                        <div><strong>Qualidade adaptativa</strong><span>Bitrate, FPS e resolução por peer usando getStats()</span></div>
                        <label className="switch-control"><input type="checkbox" checked={adaptiveQualityEnabled} onChange={(event) => updateAdaptiveQuality(event.target.checked)} /><span /></label>
                      </div>
                      <p className="connectivity-note">O Discordy reduz vídeo/tela quando detecta packet loss, RTT alto ou pouco upload disponível e recupera qualidade gradualmente. Áudio recebe prioridade alta e vídeo é degradado primeiro.</p>
                    </section>

                    <section className="connectivity-settings">
                      <div className="connectivity-settings__header">
                        <div><strong>STUN / TURN</strong><span>Ativo: {configSummary(iceConfig)}</span></div>
                        <span className={`connectivity-mode connectivity-mode--${iceConfig.mode}`}>{iceConfig.mode === 'auto' ? 'Fallback automático' : iceConfig.mode === 'turn-only' ? 'TURN obrigatório' : 'Somente P2P'}</span>
                      </div>
                      <div className="connectivity-grid">
                        <label>Modo de conectividade
                          <select value={iceDraft.mode} onChange={(event) => setIceDraft((current) => ({ ...current, mode: event.target.value as IceConnectivityConfig['mode'] }))}>
                            <option value="auto">Automático — P2P → TURN</option>
                            <option value="p2p-only">Somente P2P / STUN</option>
                            <option value="turn-only">Somente TURN / relay</option>
                          </select>
                        </label>
                        <label>STUN URLs <small>Uma por linha</small>
                          <textarea rows={3} value={iceDraft.stunUrls.join('\n')} onChange={(event) => setIceDraft((current) => ({ ...current, stunUrls: event.target.value.split(/[\n,;]+/).map((value) => value.trim()).filter(Boolean) }))} placeholder="stun:stun.example.com:3478" />
                        </label>
                        <label className="connectivity-grid__wide">TURN URLs <small>Compatível com Coturn · turn: e turns:</small>
                          <textarea rows={3} value={iceDraft.turnUrls.join('\n')} onChange={(event) => setIceDraft((current) => ({ ...current, turnUrls: event.target.value.split(/[\n,;]+/).map((value) => value.trim()).filter(Boolean) }))} placeholder={'turn:turn.example.com:3478?transport=udp\nturns:turn.example.com:5349?transport=tcp'} />
                        </label>
                        <label>Usuário TURN
                          <input value={iceDraft.turnUsername} onChange={(event) => setIceDraft((current) => ({ ...current, turnUsername: event.target.value }))} placeholder="discordy" autoComplete="off" />
                        </label>
                        <label>Credencial TURN
                          <input type="password" value={iceDraft.turnCredential} onChange={(event) => setIceDraft((current) => ({ ...current, turnCredential: event.target.value }))} placeholder="senha / credencial" autoComplete="new-password" />
                        </label>
                      </div>
                      <div className="connectivity-actions">
                        <button className="button button--compact" onClick={applyIceConnectivity}>Salvar e aplicar</button>
                        <button className="button button--compact" disabled={turnTesting || iceDraft.turnUrls.length === 0} onClick={() => void runTurnTest()}>{turnTesting ? 'Testando TURN...' : 'Testar TURN'}</button>
                        <button className="text-button" onClick={restoreDefaultIceConnectivity}>Carregar defaults externos</button>
                      </div>
                      <p className="connectivity-note">No modo Automático, o Discordy inicia com STUN/P2P e só adiciona o TURN após falha ICE. Credenciais temporárias via serviço de autenticação ficam reservadas para uma versão futura.</p>
                      {turnTestResult && (
                        <div className={`turn-test-result ${turnTestResult.ok ? 'is-success' : 'is-error'}`}>
                          <strong>{turnTestResult.ok ? 'TURN operacional' : 'TURN indisponível'}</strong>
                          <span>{turnTestResult.message}</span>
                          <small>{Math.round(turnTestResult.durationMs)} ms{turnTestResult.protocol ? ` · ${turnTestResult.protocol}` : ''}{turnTestResult.relayProtocol ? `/${turnTestResult.relayProtocol}` : ''}{turnTestResult.address ? ` · ${turnTestResult.address}${turnTestResult.port ? `:${turnTestResult.port}` : ''}` : ''}</small>
                        </div>
                      )}
                    </section>
                    {diagnosticsError && <div className="network-empty network-empty--error">{diagnosticsError}</div>}
                    {!diagnosticsError && networkDiagnostics.length === 0 && <div className="network-empty">Nenhum peer remoto conectado. O diagnóstico passa a coletar dados quando outro participante entra.</div>}
                    {networkDiagnostics.map((peer) => (
                      <article className="network-peer" key={peer.peerId}>
                        <header className="network-peer__header">
                          <div><span className="avatar avatar--xs avatar--remote">{initialFor(peer.name)}</span><div><strong>{peer.name}</strong><span>{peer.peerId.slice(0, 8)}</span></div></div>
                          <div className="network-peer__badges">
                            {peer.adaptiveQuality && <span className={`quality-badge quality-badge--${peer.adaptiveQuality.level}`}>{peer.adaptiveQuality.badConnection ? 'Conexão ruim' : adaptiveQualityLabel(peer.adaptiveQuality.level)}</span>}
                            <span className={`route-badge route-badge--${peer.route}`}>{routeLabel(peer.route)}</span>
                          </div>
                        </header>
                        <div className="network-route">
                          <span><small>ICE selecionado</small><strong>{peer.localCandidateType} ↔ {peer.remoteCandidateType}</strong></span>
                          <span><small>Protocolo</small><strong>{peer.candidateProtocol}{peer.relayProtocol ? ` / ${peer.relayProtocol}` : ''}</strong></span>
                          <span><small>Estado ICE</small><strong>{peer.iceConnectionState}</strong></span>
                          <span><small>Connection</small><strong>{peer.connectionState}</strong></span>
                        </div>
                        <div className="network-metrics">
                          <span><small>RTT / ping</small><strong>{formatMetric(peer.rttMs, ' ms')}</strong></span>
                          <span><small>Jitter</small><strong>{formatMetric(peer.jitterMs, ' ms')}</strong></span>
                          <span><small>Packet loss</small><strong>{formatMetric(peer.packetLossPct, '%', 2)}</strong></span>
                          <span><small>Upload</small><strong>{formatBitrate(peer.bitrateUpKbps)}</strong></span>
                          <span><small>Download</small><strong>{formatBitrate(peer.bitrateDownKbps)}</strong></span>
                          <span><small>Vídeo recebido</small><strong>{videoLabel(peer.receivedVideo)}</strong></span>
                          {peer.adaptiveQuality && <span><small>Upload disponível</small><strong>{formatBitrate(peer.adaptiveQuality.availableOutgoingKbps)}</strong></span>}
                          {peer.adaptiveQuality && <span><small>Qualidade TX</small><strong>{adaptiveQualityLabel(peer.adaptiveQuality.level)}</strong></span>}
                          {peer.adaptiveQuality && <span><small>FPS / escala TX</small><strong>{peer.adaptiveQuality.targetFps} FPS · {peer.adaptiveQuality.scaleResolutionDownBy.toFixed(2)}×</strong></span>}
                        </div>
                        {peer.adaptiveQuality && (
                          <div className={`adaptive-peer-state ${peer.adaptiveQuality.badConnection ? 'is-bad' : ''}`}>
                            <strong>{peer.adaptiveQuality.badConnection ? 'Conexão ruim detectada' : `Controle adaptativo: ${adaptiveQualityLabel(peer.adaptiveQuality.level)}`}</strong>
                            <span>{peer.adaptiveQuality.reason}</span>
                            <small>Tela {peer.adaptiveQuality.targetScreenBitrateKbps === null ? '—' : formatBitrate(peer.adaptiveQuality.targetScreenBitrateKbps)} · Câmera {peer.adaptiveQuality.targetCameraBitrateKbps === null ? '—' : formatBitrate(peer.adaptiveQuality.targetCameraBitrateKbps)}</small>
                          </div>
                        )}
                        <div className="network-codecs">
                          <span><small>Codec TX</small><strong>{peer.outboundCodecs.join(', ') || '—'}</strong></span>
                          <span><small>Codec RX</small><strong>{peer.inboundCodecs.join(', ') || '—'}</strong></span>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              )}

              {showLogs && (
                <section className="technical-drawer">
                  <div className="technical-drawer__header"><strong>Detalhes técnicos</strong><button className="text-button" onClick={() => setShowLogs(false)}>Fechar</button></div>
                  <pre>{technicalLogs.length ? technicalLogs.join('\n') : 'Sem logs ainda.'}</pre>
                </section>
              )}

              {hasScreenShares && (
                <section className={`screen-share-stage ${expandedScreenKey ? 'screen-share-stage--focused' : ''}`}>
                  <header className="screen-share-stage__header">
                    <div><span className="live-dot" /><strong>{screenShareCount === 1 ? '1 transmissão ativa' : `${screenShareCount} transmissões ativas`}</strong></div>
                    {expandedScreenKey && <button className="text-button" onClick={() => setExpandedScreenKey(null)}>Mostrar todas</button>}
                  </header>
                  <div className={`screen-share-grid screen-share-grid--${Math.min(screenShareCount, 4)}`}>
                    {screenStream && (!expandedScreenKey || expandedScreenKey === 'local') && (
                      <ScreenShareTile
                        stream={screenStream}
                        trackId={screenStream.getVideoTracks()[0]?.id}
                        broadcasterName={name || 'Você'}
                        metadata={screenMetadata}
                        local
                        expanded={expandedScreenKey === 'local'}
                        onToggleExpand={() => setExpandedScreenKey((current) => current === 'local' ? null : 'local')}
                      />
                    )}
                    {remoteScreenPeers.map((peer) => {
                      const key = `peer:${peer.peerId}`;
                      if (expandedScreenKey && expandedScreenKey !== key) return null;
                      return <ScreenShareTile
                        key={key}
                        stream={peer.stream}
                        trackId={peer.mediaTrackIds.screen}
                        broadcasterName={peer.name}
                        metadata={peer.screenShare}
                        expanded={expandedScreenKey === key}
                        onToggleExpand={() => setExpandedScreenKey((current) => current === key ? null : key)}
                        onStall={({ noFrameMs, trackMuted }) => {
                          appendTechnicalLog(`[SCREEN WATCHDOG] ${peer.name}: sem frame há ${Math.round(noFrameMs)}ms muted=${trackMuted}`);
                          void peerManagerRef.current?.recoverRemoteScreen(peer.peerId, trackMuted ? 'track-muted' : 'renderer-no-frames');
                        }}
                        onRecovered={() => {
                          appendTechnicalLog(`[SCREEN WATCHDOG] ${peer.name}: frames retomados`);
                          peerManagerRef.current?.markRemoteScreenHealthy(peer.peerId);
                        }}
                      />;
                    })}
                  </div>
                </section>
              )}

              <section className={`media-grid media-grid--${Math.min(totalParticipants, 4)} ${hasScreenShares ? 'media-grid--with-screen' : ''}`}>
                <article className={`media-tile media-tile--self ${cameraStream ? 'has-video' : ''} ${voiceActivity.speaking ? 'is-speaking' : ''}`}>
                  <div className="media-tile__viewport">
                    <video ref={localPreviewRef} autoPlay muted playsInline />
                    {!cameraStream && (
                      <div className="media-fallback">
                        <span className="avatar avatar--xl">{initialFor(name)}</span>
                      </div>
                    )}
                    <div className="media-tile__status">
                      <span>{name || 'Você'} <small>{cameraStream ? 'Você · câmera' : screenStream ? 'Você · transmitindo tela' : 'Você'}</small></span>
                      <span className="media-tile__indicators">
                        {voiceActivity.speaking && <span className="speaking-badge">Falando</span>}
                        {screenStream && <span className="streaming-badge">AO VIVO</span>}
                        {(!micEnabled || deafened) && <span className="media-state-icon"><Icon name="micOff" size={14} /></span>}
                      </span>
                    </div>
                  </div>
                </article>
                {remotePeers.map((peer) => <RemoteVideo key={peer.peerId} peer={peer} volume={peerVolumes[peer.peerId] ?? 100} deafened={deafened} outputDeviceId={outputDeviceId} onSpeakingChange={handleRemoteSpeaking} />)}
              </section>

              {remotePeers.length === 0 && (
                <div className="waiting-copy">
                  <strong>Você está sozinho por enquanto</strong>
                  <span>{hostState ? 'Envie o convite para seus amigos entrarem na sala.' : 'Aguardando outros participantes.'}</span>
                  {hostState && <button className="button button--primary" onClick={() => void copyInvite()}><Icon name="copy" size={16} />Copiar convite</button>}
                </div>
              )}

              <div className="media-dock" aria-label="Controles da chamada">
                <button className={`dock-button ${!micEnabled ? 'dock-button--danger' : ''} ${voiceActivity.transmitting ? 'is-transmitting' : ''}`} onClick={toggleMic} title={micEnabled ? 'Silenciar' : 'Ativar microfone'}><Icon name={micEnabled ? 'mic' : 'micOff'} size={20} /></button>
                <button className={`dock-button ${deafened ? 'dock-button--danger' : ''}`} onClick={toggleDeafen} title={deafened ? 'Ativar áudio' : 'Deafen'}><Icon name="headphones" size={20} /></button>
                <button className={`dock-button ${screenStream ? 'dock-button--active' : ''}`} onClick={() => void (screenStream ? stopScreenShare() : openScreenPicker())} title={screenStream ? 'Parar compartilhamento' : 'Compartilhar tela'}><Icon name="screen" size={20} /></button>
                <button className={`dock-button ${cameraStream ? 'dock-button--active' : ''}`} onClick={() => void toggleCamera()} title={cameraStream ? 'Desligar câmera' : 'Ligar câmera'}><Icon name="video" size={20} /></button>
                <button className="dock-button dock-button--hangup" onClick={() => void leave()} title="Desconectar"><Icon name="phone" size={21} /></button>
              </div>
            </div>
          </section>

          <aside className="members-sidebar">
            <header className="members-header"><strong>Participantes</strong><span>{totalParticipants}/{roomLimit}</span></header>
            <div className="members-list">
              <div className="members-group-title">NA SALA — {totalParticipants}</div>
              {listedParticipants.map((participant) => {
                const isSelf = participant.peerId === selfId || (!selfId && participant.peerId === 'local');
                const peer = remotePeers.find((candidate) => candidate.peerId === participant.peerId);
                const speaking = isSelf ? voiceActivity.speaking : Boolean(remoteSpeaking[participant.peerId]);
                const detail = participant.isHost
                  ? `Host · ${presenceLabel(participant.presence).toLowerCase()}`
                  : peer?.media.screen
                    ? 'Transmitindo tela'
                    : speaking
                      ? 'Falando'
                      : presenceLabel(participant.presence);
                return (
                  <div className={`member-entry ${speaking ? 'is-speaking' : ''} presence-${participant.presence}`} key={participant.peerId}>
                    <div className="member-row">
                      <span className={`avatar avatar--sm ${isSelf ? '' : 'avatar--remote'}`}>{initialFor(participant.name)}</span>
                      <div className="member-copy"><strong>{participant.name}{isSelf ? ' (você)' : ''}</strong><span>{detail}</span></div>
                      {participant.isHost && <span className="host-badge">HOST</span>}
                      {peer && !peer.media.microphone && <Icon name="micOff" size={13} />}
                      <span className={`presence-dot presence-dot--${participant.presence}`} />
                      {isHosting && !isSelf && !participant.isHost && <button className="kick-button" title={`Expulsar ${participant.name}`} onClick={() => kickParticipant(participant.peerId)}>Expulsar</button>}
                    </div>
                    {!isSelf && peer && (
                      <label className="member-volume"><Icon name="volume" size={13} /><input type="range" min="0" max="100" step="5" value={peerVolumes[participant.peerId] ?? 100} onChange={(event) => setPeerVolume(participant.peerId, Number(event.target.value))} /><span>{peerVolumes[participant.peerId] ?? 100}%</span></label>
                    )}
                  </div>
                );
              })}
            </div>
            <footer className="members-footer">
              <span>{isHosting ? 'Servidor local + Quick Tunnel' : 'Conectado por convite'}</span>
              <small>{roomInfo?.locked ? 'Entrada bloqueada · ' : ''}{serverUrl}</small>
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
      <UpdateBanner state={updateState} onCheck={() => void checkForUpdates()} onDownload={() => void downloadUpdate()} onInstall={() => void installUpdate()} />
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
                <p className="eyebrow">Discordy Desktop {updateState?.currentVersion || APP_VERSION}</p>
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
                  <div className="room-create-fields">
                    <label>Nome da sala<input value={hostRoomName} maxLength={60} onChange={(event) => setHostRoomName(event.target.value)} placeholder="Sala dos amigos" /></label>
                    <label>Limite<select value={hostMaxParticipants} onChange={(event) => setHostMaxParticipants(Number(event.target.value) as 2 | 3 | 4)}><option value={2}>2 participantes</option><option value={3}>3 participantes</option><option value={4}>4 participantes</option></select></label>
                    <label>PIN opcional<input type="password" inputMode="numeric" value={hostPin} maxLength={12} onChange={(event) => setHostPin(event.target.value.replace(/\D/g, '').slice(0, 12))} placeholder="4–12 números" /></label>
                    <label>Expiração do convite<select value={hostInviteTtlMinutes} onChange={(event) => setHostInviteTtlMinutes(Number(event.target.value) as InviteTtlMinutes)}><option value={15}>15 minutos</option><option value={30}>30 minutos</option><option value={60}>1 hora</option><option value={360}>6 horas</option><option value={1440}>24 horas</option></select></label>
                    <label className="settings-checkbox room-create-checkbox"><input type="checkbox" checked={hostApprovalRequired} onChange={(event) => setHostApprovalRequired(event.target.checked)} /><span>Confirmar cada entrada manualmente</span></label>
                  </div>
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
                  <button className="back-link" onClick={() => { signalingRef.current?.close(); signalingRef.current = null; setJoinPending(false); setError(null); setMode('home'); }}>← Voltar</button>
                  <div className="flow-heading"><span className="action-card__icon"><Icon name="arrow" size={20} /></span><div><strong>Entrar por convite</strong><small>Quem entra não precisa do Cloudflared.</small></div></div>
                  <form onSubmit={submitJoin} className="join-form">
                    <label>Convite<input value={inviteInput} onChange={(event) => setInviteInput(event.target.value)} placeholder="discordy://join?..." autoFocus /></label>
                    <label>PIN da sala <span className="optional-label">opcional</span><input type="password" inputMode="numeric" value={joinPin} maxLength={12} onChange={(event) => setJoinPin(event.target.value.replace(/\D/g, '').slice(0, 12))} placeholder="Informe apenas se a sala exigir" /></label>
                    {joinPending && <div className="join-pending-state"><span className="presence-spinner" /><div><strong>Aguardando aprovação</strong><small>{joinPendingRoomName || 'O host precisa confirmar sua entrada.'}</small></div></div>}
                    <button className="button button--primary button--large" disabled={busy || joinPending}>{joinPending ? 'Aguardando host...' : busy ? 'Conectando...' : 'Entrar na sala'}</button>
                  </form>
                </div>
              )}

              {error && <div className="alert home-alert">{error}</div>}

              <div className="welcome-card__footer">
                <span><span className="connection-dot" />WebRTC Mesh</span>
                <span>Até {DEFAULT_MAX_PARTICIPANTS} participantes</span>
                <button className="update-check-button" disabled={!updateState?.supported || updateState.status === 'checking' || updateState.status === 'downloading'} onClick={() => void checkForUpdates()}>
                  {updateState?.status === 'checking' ? 'Verificando...' : updateState?.portable ? 'Portable: update manual' : 'Verificar atualização'}
                </button>
              </div>
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}

export default App;
