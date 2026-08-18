import type { AdaptiveQualitySnapshot } from './adaptiveQuality';
export type ConnectionRoute = 'direct' | 'nat' | 'turn' | 'unknown';

export type VideoReceiveMetrics = {
  width: number | null;
  height: number | null;
  fps: number | null;
};

export type PeerDiagnostics = {
  peerId: string;
  name: string;
  sampledAt: string;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  iceGatheringState: RTCIceGatheringState;
  signalingState: RTCSignalingState;
  route: ConnectionRoute;
  localCandidateType: string;
  remoteCandidateType: string;
  candidateProtocol: string;
  relayProtocol: string | null;
  rttMs: number | null;
  jitterMs: number | null;
  packetLossPct: number | null;
  packetsLost: number;
  packetsReceived: number;
  bitrateUpKbps: number | null;
  bitrateDownKbps: number | null;
  outboundCodecs: string[];
  inboundCodecs: string[];
  receivedVideo: VideoReceiveMetrics | null;
  adaptiveQuality?: AdaptiveQualitySnapshot;
};

type ExtendedRTCStats = RTCStats & Record<string, unknown>;

type PreviousSample = {
  at: number;
  bytesSent: number;
  bytesReceived: number;
};

const previousSamples = new WeakMap<RTCPeerConnection, PreviousSample>();

function indexStats(stats: RTCStatsReport) {
  const map = new Map<string, RTCStats>();
  stats.forEach((report) => map.set(report.id, report));
  return map;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrUnknown(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : 'unknown';
}

function codecLabel(report: RTCStats | undefined): string | null {
  if (!report || report.type !== 'codec') return null;
  const extended = report as ExtendedRTCStats;
  const mimeType = typeof extended.mimeType === 'string' ? extended.mimeType : null;
  if (!mimeType) return null;
  const clockRate = typeof extended.clockRate === 'number' ? extended.clockRate : null;
  return clockRate ? `${mimeType} @ ${clockRate}Hz` : mimeType;
}

function findSelectedCandidatePair(reports: Map<string, RTCStats>): RTCStats | undefined {
  let fallback: RTCStats | undefined;

  for (const report of reports.values()) {
    const extended = report as ExtendedRTCStats;
    if (report.type === 'transport' && typeof extended.selectedCandidatePairId === 'string') {
      const selected = reports.get(extended.selectedCandidatePairId);
      if (selected) return selected;
    }

    if (report.type === 'candidate-pair') {
      if (extended.selected === true) return report;
      if (extended.nominated === true && extended.state === 'succeeded') fallback = report;
    }
  }

  return fallback;
}

function deriveRoute(localType: string, remoteType: string): ConnectionRoute {
  if (localType === 'relay' || remoteType === 'relay') return 'turn';
  if (localType === 'host' && remoteType === 'host') return 'direct';
  if (['host', 'srflx', 'prflx'].includes(localType) || ['host', 'srflx', 'prflx'].includes(remoteType)) return 'nat';
  return 'unknown';
}

function bitrateKbps(bytes: number, previousBytes: number, elapsedMs: number): number | null {
  if (elapsedMs <= 0 || bytes < previousBytes) return null;
  return ((bytes - previousBytes) * 8) / elapsedMs;
}

export async function collectPeerDiagnostics(
  peerId: string,
  name: string,
  pc: RTCPeerConnection,
): Promise<PeerDiagnostics> {
  const stats = await pc.getStats();
  const reports = indexStats(stats);
  const selectedPair = findSelectedCandidatePair(reports);
  const selected = selectedPair as ExtendedRTCStats | undefined;
  const localCandidate = selected && typeof selected.localCandidateId === 'string'
    ? reports.get(selected.localCandidateId)
    : undefined;
  const remoteCandidate = selected && typeof selected.remoteCandidateId === 'string'
    ? reports.get(selected.remoteCandidateId)
    : undefined;

  const local = localCandidate as ExtendedRTCStats | undefined;
  const remote = remoteCandidate as ExtendedRTCStats | undefined;
  const localCandidateType = stringOrUnknown(local?.candidateType);
  const remoteCandidateType = stringOrUnknown(remote?.candidateType);
  const candidateProtocol = stringOrUnknown(local?.protocol ?? remote?.protocol);
  const relayProtocolRaw = local?.relayProtocol ?? remote?.relayProtocol;
  const relayProtocol = typeof relayProtocolRaw === 'string' ? relayProtocolRaw : null;

  let packetsLost = 0;
  let packetsReceived = 0;
  const jitters: number[] = [];
  const inboundCodecs = new Set<string>();
  const outboundCodecs = new Set<string>();
  let receivedVideo: VideoReceiveMetrics | null = null;
  let inboundRtpBytes = 0;
  let outboundRtpBytes = 0;

  for (const report of reports.values()) {
    const extended = report as ExtendedRTCStats;
    if (report.type === 'inbound-rtp' && extended.isRemote !== true) {
      if (typeof extended.bytesReceived === 'number' && extended.bytesReceived > 0) inboundRtpBytes += extended.bytesReceived;
      if (typeof extended.packetsLost === 'number' && extended.packetsLost > 0) packetsLost += extended.packetsLost;
      if (typeof extended.packetsReceived === 'number' && extended.packetsReceived > 0) packetsReceived += extended.packetsReceived;
      if (typeof extended.jitter === 'number' && extended.jitter >= 0) jitters.push(extended.jitter * 1000);

      if (typeof extended.codecId === 'string') {
        const label = codecLabel(reports.get(extended.codecId));
        if (label) inboundCodecs.add(label);
      }

      if (extended.kind === 'video' || extended.mediaType === 'video') {
        const width = numberOrNull(extended.frameWidth);
        const height = numberOrNull(extended.frameHeight);
        const fps = numberOrNull(extended.framesPerSecond);
        if (width !== null || height !== null || fps !== null) receivedVideo = { width, height, fps };
      }
    }

    if (report.type === 'outbound-rtp' && extended.isRemote !== true) {
      if (typeof extended.bytesSent === 'number' && extended.bytesSent > 0) outboundRtpBytes += extended.bytesSent;
      if (typeof extended.codecId === 'string') {
        const label = codecLabel(reports.get(extended.codecId));
        if (label) outboundCodecs.add(label);
      }
    }
  }

  const totalPackets = packetsReceived + packetsLost;
  const packetLossPct = totalPackets > 0 ? (packetsLost / totalPackets) * 100 : null;
  const jitterMs = jitters.length > 0 ? Math.max(...jitters) : null;
  const rttSeconds = numberOrNull(selected?.currentRoundTripTime);
  const rttMs = rttSeconds === null ? null : rttSeconds * 1000;

  const bytesSent = numberOrNull(selected?.bytesSent) ?? outboundRtpBytes;
  const bytesReceived = numberOrNull(selected?.bytesReceived) ?? inboundRtpBytes;
  const now = performance.now();
  const previous = previousSamples.get(pc);
  let bitrateUpKbps: number | null = null;
  let bitrateDownKbps: number | null = null;

  if (previous) {
    const elapsedMs = now - previous.at;
    bitrateUpKbps = bitrateKbps(bytesSent, previous.bytesSent, elapsedMs);
    bitrateDownKbps = bitrateKbps(bytesReceived, previous.bytesReceived, elapsedMs);
  }
  previousSamples.set(pc, { at: now, bytesSent, bytesReceived });

  return {
    peerId,
    name,
    sampledAt: new Date().toISOString(),
    connectionState: pc.connectionState,
    iceConnectionState: pc.iceConnectionState,
    iceGatheringState: pc.iceGatheringState,
    signalingState: pc.signalingState,
    route: deriveRoute(localCandidateType, remoteCandidateType),
    localCandidateType,
    remoteCandidateType,
    candidateProtocol,
    relayProtocol,
    rttMs,
    jitterMs,
    packetLossPct,
    packetsLost,
    packetsReceived,
    bitrateUpKbps,
    bitrateDownKbps,
    outboundCodecs: [...outboundCodecs].sort(),
    inboundCodecs: [...inboundCodecs].sort(),
    receivedVideo,
  };
}
