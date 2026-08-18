export type AdaptiveQualityLevel = 'excellent' | 'good' | 'fair' | 'poor' | 'critical';

export type AdaptiveNetworkSample = {
  sampledAt: string;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  packetLossPct: number | null;
  rttMs: number | null;
  availableOutgoingKbps: number | null;
};

export type AdaptiveQualityProfile = {
  level: AdaptiveQualityLevel;
  bitrateFactor: number;
  maxFps: number;
  scaleResolutionDownBy: number;
  badConnection: boolean;
};

export type AdaptiveQualitySnapshot = AdaptiveNetworkSample & {
  level: AdaptiveQualityLevel;
  badConnection: boolean;
  reason: string;
  targetScreenBitrateKbps: number | null;
  targetCameraBitrateKbps: number | null;
  targetFps: number;
  scaleResolutionDownBy: number;
};

type ExtendedRTCStats = RTCStats & Record<string, unknown>;

type PreviousAdaptiveSample = {
  packetsSent: number;
  packetsLost: number;
};

const previousSamples = new WeakMap<RTCPeerConnection, PreviousAdaptiveSample>();

export const ADAPTIVE_QUALITY_PROFILES: Record<AdaptiveQualityLevel, AdaptiveQualityProfile> = {
  excellent: { level: 'excellent', bitrateFactor: 1, maxFps: 60, scaleResolutionDownBy: 1, badConnection: false },
  good: { level: 'good', bitrateFactor: 0.85, maxFps: 45, scaleResolutionDownBy: 1, badConnection: false },
  fair: { level: 'fair', bitrateFactor: 0.65, maxFps: 30, scaleResolutionDownBy: 1.25, badConnection: false },
  poor: { level: 'poor', bitrateFactor: 0.45, maxFps: 20, scaleResolutionDownBy: 1.75, badConnection: true },
  critical: { level: 'critical', bitrateFactor: 0.25, maxFps: 12, scaleResolutionDownBy: 2.5, badConnection: true },
};

export const ADAPTIVE_QUALITY_ORDER: AdaptiveQualityLevel[] = ['excellent', 'good', 'fair', 'poor', 'critical'];

function indexStats(stats: RTCStatsReport) {
  const map = new Map<string, RTCStats>();
  stats.forEach((report) => map.set(report.id, report));
  return map;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function findSelectedCandidatePair(reports: Map<string, RTCStats>): ExtendedRTCStats | null {
  let fallback: ExtendedRTCStats | null = null;
  for (const report of reports.values()) {
    const extended = report as ExtendedRTCStats;
    if (report.type === 'transport' && typeof extended.selectedCandidatePairId === 'string') {
      const selected = reports.get(extended.selectedCandidatePairId);
      if (selected) return selected as ExtendedRTCStats;
    }
    if (report.type === 'candidate-pair') {
      if (extended.selected === true) return extended;
      if (extended.nominated === true && extended.state === 'succeeded') fallback = extended;
    }
  }
  return fallback;
}

export async function collectAdaptiveNetworkSample(pc: RTCPeerConnection): Promise<AdaptiveNetworkSample> {
  const stats = await pc.getStats();
  const reports = indexStats(stats);
  const selectedPair = findSelectedCandidatePair(reports);

  let packetsSent = 0;
  let packetsLost = 0;
  const remoteRtts: number[] = [];

  for (const report of reports.values()) {
    const extended = report as ExtendedRTCStats;
    if (report.type === 'outbound-rtp' && extended.isRemote !== true) {
      if (typeof extended.packetsSent === 'number' && extended.packetsSent > 0) packetsSent += extended.packetsSent;
    }
    if (report.type === 'remote-inbound-rtp') {
      if (typeof extended.packetsLost === 'number' && extended.packetsLost > 0) packetsLost += extended.packetsLost;
      if (typeof extended.roundTripTime === 'number' && extended.roundTripTime >= 0) remoteRtts.push(extended.roundTripTime * 1000);
    }
  }

  const previous = previousSamples.get(pc);
  let packetLossPct: number | null = null;
  if (previous) {
    const sentDelta = Math.max(0, packetsSent - previous.packetsSent);
    const lostDelta = Math.max(0, packetsLost - previous.packetsLost);
    if (sentDelta > 0) packetLossPct = Math.max(0, Math.min(100, (lostDelta / sentDelta) * 100));
  }
  previousSamples.set(pc, { packetsSent, packetsLost });

  const pairRttSeconds = numberOrNull(selectedPair?.currentRoundTripTime);
  const rttMs = pairRttSeconds !== null
    ? pairRttSeconds * 1000
    : remoteRtts.length > 0 ? Math.max(...remoteRtts) : null;
  const availableOutgoingBitrate = numberOrNull(selectedPair?.availableOutgoingBitrate);

  return {
    sampledAt: new Date().toISOString(),
    connectionState: pc.connectionState,
    iceConnectionState: pc.iceConnectionState,
    packetLossPct,
    rttMs,
    availableOutgoingKbps: availableOutgoingBitrate !== null && availableOutgoingBitrate > 0 ? availableOutgoingBitrate / 1000 : null,
  };
}

export function recommendAdaptiveQuality(sample: AdaptiveNetworkSample, requestedVideoKbps: number): { level: AdaptiveQualityLevel; reason: string } {
  if (sample.connectionState === 'failed' || sample.iceConnectionState === 'failed') return { level: 'critical', reason: 'WebRTC/ICE em falha' };
  if (sample.connectionState === 'disconnected' || sample.iceConnectionState === 'disconnected') return { level: 'poor', reason: 'conexão WebRTC instável' };

  const candidates: Array<{ level: AdaptiveQualityLevel; reason: string }> = [];
  const loss = sample.packetLossPct;
  if (loss !== null) {
    if (loss >= 12) candidates.push({ level: 'critical', reason: `packet loss ${loss.toFixed(1)}%` });
    else if (loss >= 6) candidates.push({ level: 'poor', reason: `packet loss ${loss.toFixed(1)}%` });
    else if (loss >= 2.5) candidates.push({ level: 'fair', reason: `packet loss ${loss.toFixed(1)}%` });
    else if (loss >= 1) candidates.push({ level: 'good', reason: `packet loss ${loss.toFixed(1)}%` });
  }

  const rtt = sample.rttMs;
  if (rtt !== null) {
    if (rtt >= 700) candidates.push({ level: 'critical', reason: `RTT ${Math.round(rtt)} ms` });
    else if (rtt >= 400) candidates.push({ level: 'poor', reason: `RTT ${Math.round(rtt)} ms` });
    else if (rtt >= 250) candidates.push({ level: 'fair', reason: `RTT ${Math.round(rtt)} ms` });
    else if (rtt >= 150) candidates.push({ level: 'good', reason: `RTT ${Math.round(rtt)} ms` });
  }

  if (requestedVideoKbps > 0 && sample.availableOutgoingKbps !== null) {
    const ratio = sample.availableOutgoingKbps / requestedVideoKbps;
    if (ratio < 0.35) candidates.push({ level: 'critical', reason: `upload disponível ${Math.round(sample.availableOutgoingKbps)} Kbps` });
    else if (ratio < 0.55) candidates.push({ level: 'poor', reason: `upload disponível ${Math.round(sample.availableOutgoingKbps)} Kbps` });
    else if (ratio < 0.8) candidates.push({ level: 'fair', reason: `upload disponível ${Math.round(sample.availableOutgoingKbps)} Kbps` });
    else if (ratio < 1.05) candidates.push({ level: 'good', reason: `upload próximo do limite (${Math.round(sample.availableOutgoingKbps)} Kbps)` });
  }

  if (candidates.length === 0) return { level: 'excellent', reason: 'conexão estável' };
  candidates.sort((a, b) => ADAPTIVE_QUALITY_ORDER.indexOf(b.level) - ADAPTIVE_QUALITY_ORDER.indexOf(a.level));
  return candidates[0];
}

export function makeAdaptiveSnapshot(
  sample: AdaptiveNetworkSample,
  level: AdaptiveQualityLevel,
  reason: string,
  screenBaselineKbps: number | null,
  cameraBaselineKbps: number | null,
): AdaptiveQualitySnapshot {
  const profile = ADAPTIVE_QUALITY_PROFILES[level];
  return {
    ...sample,
    level,
    badConnection: profile.badConnection,
    reason,
    targetScreenBitrateKbps: screenBaselineKbps === null ? null : Math.max(250, Math.round(screenBaselineKbps * profile.bitrateFactor)),
    targetCameraBitrateKbps: cameraBaselineKbps === null ? null : Math.max(180, Math.round(cameraBaselineKbps * profile.bitrateFactor)),
    targetFps: profile.maxFps,
    scaleResolutionDownBy: profile.scaleResolutionDownBy,
  };
}

export function initialAdaptiveSnapshot(): AdaptiveQualitySnapshot {
  return makeAdaptiveSnapshot({
    sampledAt: new Date(0).toISOString(),
    connectionState: 'new',
    iceConnectionState: 'new',
    packetLossPct: null,
    rttMs: null,
    availableOutgoingKbps: null,
  }, 'excellent', 'aguardando métricas', null, null);
}
