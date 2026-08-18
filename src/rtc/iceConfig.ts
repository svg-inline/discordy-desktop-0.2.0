export type IceConnectivityMode = 'auto' | 'p2p-only' | 'turn-only';

export type IceConnectivityConfig = {
  mode: IceConnectivityMode;
  stunUrls: string[];
  turnUrls: string[];
  turnUsername: string;
  turnCredential: string;
};

export type TurnTestResult = {
  ok: boolean;
  durationMs: number;
  candidateType: string | null;
  protocol: string | null;
  relayProtocol: string | null;
  address: string | null;
  port: number | null;
  message: string;
};

const STORAGE_KEY = 'discordy:ice-connectivity';
const DEFAULT_STUN = 'stun:stun.l.google.com:19302';

function splitUrls(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return [...new Set(value.split(/[\n,;\s]+/).map((item) => item.trim()).filter(Boolean))];
}

function envString(name: string): string {
  const env = ((import.meta as ImportMeta & { env?: Record<string, unknown> }).env ?? {});
  const value = env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeMode(value: unknown): IceConnectivityMode {
  return value === 'p2p-only' || value === 'turn-only' ? value : 'auto';
}

function normalizeUrls(urls: unknown, schemes: string[]) {
  if (!Array.isArray(urls)) return [];
  return [...new Set(urls.filter((url): url is string => typeof url === 'string').map((url) => url.trim()).filter((url) => schemes.some((scheme) => url.toLowerCase().startsWith(`${scheme}:`))))];
}

export function defaultIceConnectivityConfig(): IceConnectivityConfig {
  const legacyStun = envString('VITE_STUN_URL');
  const stunUrls = splitUrls(envString('VITE_STUN_URLS') || legacyStun || DEFAULT_STUN);
  const turnUrls = splitUrls(envString('VITE_TURN_URLS'));
  return {
    mode: normalizeMode(envString('VITE_ICE_MODE')),
    stunUrls: stunUrls.length ? stunUrls : [DEFAULT_STUN],
    turnUrls,
    turnUsername: envString('VITE_TURN_USERNAME'),
    turnCredential: envString('VITE_TURN_CREDENTIAL'),
  };
}

export function normalizeIceConnectivityConfig(value: Partial<IceConnectivityConfig> | null | undefined): IceConnectivityConfig {
  const defaults = defaultIceConnectivityConfig();
  return {
    mode: normalizeMode(value?.mode ?? defaults.mode),
    stunUrls: normalizeUrls(value?.stunUrls, ['stun', 'stuns']).length ? normalizeUrls(value?.stunUrls, ['stun', 'stuns']) : defaults.stunUrls,
    turnUrls: normalizeUrls(value?.turnUrls, ['turn', 'turns']),
    turnUsername: typeof value?.turnUsername === 'string' ? value.turnUsername.trim() : defaults.turnUsername,
    turnCredential: typeof value?.turnCredential === 'string' ? value.turnCredential : defaults.turnCredential,
  };
}

export function loadIceConnectivityConfig(): IceConnectivityConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultIceConnectivityConfig();
    return normalizeIceConnectivityConfig(JSON.parse(raw) as Partial<IceConnectivityConfig>);
  } catch {
    return defaultIceConnectivityConfig();
  }
}

export function saveIceConnectivityConfig(config: IceConnectivityConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeIceConnectivityConfig(config)));
}

export function hasTurnServer(config: IceConnectivityConfig): boolean {
  return config.turnUrls.length > 0;
}

export function directIceServers(config: IceConnectivityConfig): RTCIceServer[] {
  return config.stunUrls.length ? [{ urls: config.stunUrls }] : [];
}

export function turnIceServer(config: IceConnectivityConfig): RTCIceServer | null {
  if (!hasTurnServer(config)) return null;
  const server: RTCIceServer = { urls: config.turnUrls };
  if (config.turnUsername) server.username = config.turnUsername;
  if (config.turnCredential) server.credential = config.turnCredential;
  return server;
}

export function fullIceServers(config: IceConnectivityConfig): RTCIceServer[] {
  const servers = directIceServers(config);
  const turn = turnIceServer(config);
  if (turn) servers.push(turn);
  return servers;
}

export function initialRtcConfiguration(config: IceConnectivityConfig): RTCConfiguration {
  if (config.mode === 'turn-only') {
    const turn = turnIceServer(config);
    return { iceServers: turn ? [turn] : [], iceTransportPolicy: 'relay' };
  }
  return { iceServers: directIceServers(config), iceTransportPolicy: 'all' };
}

export function fallbackRtcConfiguration(config: IceConnectivityConfig): RTCConfiguration | null {
  if (config.mode !== 'auto' || !hasTurnServer(config)) return null;
  return { iceServers: fullIceServers(config), iceTransportPolicy: 'all' };
}

export function configSummary(config: IceConnectivityConfig) {
  const turn = hasTurnServer(config) ? `${config.turnUrls.length} TURN` : 'sem TURN';
  return `${config.mode} · ${config.stunUrls.length} STUN · ${turn}`;
}

function candidateAddress(candidate: RTCIceCandidate): string | null {
  const candidateRecord = candidate as RTCIceCandidate & { address?: string | null; port?: number | null; protocol?: string | null; relayProtocol?: string | null };
  return candidateRecord.address ?? null;
}

export async function testTurnConnectivity(config: IceConnectivityConfig, timeoutMs = 8000): Promise<TurnTestResult> {
  const turn = turnIceServer(config);
  if (!turn) return { ok: false, durationMs: 0, candidateType: null, protocol: null, relayProtocol: null, address: null, port: null, message: 'Nenhum servidor TURN configurado.' };

  const startedAt = performance.now();
  const pc = new RTCPeerConnection({ iceServers: [turn], iceTransportPolicy: 'relay' });
  pc.createDataChannel('discordy-turn-test');

  try {
    return await new Promise<TurnTestResult>(async (resolve) => {
      let settled = false;
      const finish = (result: Omit<TurnTestResult, 'durationMs'>) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        const durationMs = Math.max(0, performance.now() - startedAt);
        try { pc.close(); } catch { /* noop */ }
        resolve({ ...result, durationMs });
      };

      const timer = window.setTimeout(() => finish({
        ok: false,
        candidateType: null,
        protocol: null,
        relayProtocol: null,
        address: null,
        port: null,
        message: 'Timeout: nenhum candidato relay foi obtido.',
      }), timeoutMs);

      pc.onicecandidate = (event) => {
        const candidate = event.candidate;
        if (!candidate) return;
        if (candidate.type !== 'relay') return;
        const extended = candidate as RTCIceCandidate & { protocol?: string | null; relayProtocol?: string | null; port?: number | null };
        finish({
          ok: true,
          candidateType: candidate.type,
          protocol: extended.protocol ?? null,
          relayProtocol: extended.relayProtocol ?? null,
          address: candidateAddress(candidate),
          port: extended.port ?? null,
          message: 'TURN respondeu e forneceu candidato relay.',
        });
      };

      pc.onicecandidateerror = (event) => {
        const detail = `${event.errorCode || ''} ${event.errorText || ''}`.trim();
        if (event.errorCode >= 400) finish({
          ok: false,
          candidateType: null,
          protocol: null,
          relayProtocol: null,
          address: null,
          port: null,
          message: detail ? `TURN falhou: ${detail}` : 'TURN falhou durante a coleta ICE.',
        });
      };

      try {
        await pc.setLocalDescription(await pc.createOffer());
      } catch (cause) {
        finish({
          ok: false,
          candidateType: null,
          protocol: null,
          relayProtocol: null,
          address: null,
          port: null,
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    });
  } finally {
    if (pc.connectionState !== 'closed') pc.close();
  }
}
