import { useEffect, useMemo, useRef, useState } from 'react';
import type { RemotePeer } from '../lib/types';

type Props = {
  peer: RemotePeer;
  volume?: number;
  deafened?: boolean;
  outputDeviceId?: string;
  onSpeakingChange?: (peerId: string, speaking: boolean) => void;
};

function initialFor(value: string) {
  return value.trim().charAt(0).toUpperCase() || '?';
}

function chooseCameraTrack(peer: RemotePeer) {
  const tracks = peer.stream.getVideoTracks().filter((track) => track.readyState === 'live');
  const preferredId = peer.mediaTrackIds.camera;
  if (preferredId) return tracks.find((track) => track.id === preferredId) ?? null;
  if (!peer.media.camera) return null;
  const screenId = peer.mediaTrackIds.screen;
  return tracks.find((track) => track.id !== screenId) ?? null;
}

export function RemoteVideo({
  peer,
  volume = 100,
  deafened = false,
  outputDeviceId = '',
  onSpeakingChange,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const trackSignature = peer.stream.getTracks().map((track) => `${track.kind}:${track.id}:${track.readyState}`).join('|');
  const selectedVideoTrack = chooseCameraTrack(peer);
  const hasVideo = Boolean(selectedVideoTrack) && peer.media.camera;

  const playbackStream = useMemo(() => {
    const tracks: MediaStreamTrack[] = [...peer.stream.getAudioTracks()];
    const video = chooseCameraTrack(peer);
    if (video) tracks.push(video);
    return new MediaStream(tracks);
    // trackSignature intentionally forces recreation when tracks are added/removed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peer.stream, peer.media.camera, peer.mediaTrackIds.screen, peer.mediaTrackIds.camera, trackSignature]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    element.srcObject = playbackStream;
    element.volume = Math.max(0, Math.min(1, volume / 100));
    element.muted = deafened;

    const sinkElement = element as HTMLVideoElement & { setSinkId?: (sinkId: string) => Promise<void> };
    if (sinkElement.setSinkId) void sinkElement.setSinkId(outputDeviceId).catch(() => undefined);
    void element.play().catch(() => undefined);
  }, [deafened, outputDeviceId, playbackStream, volume]);

  useEffect(() => {
    const audioTracks = peer.stream.getAudioTracks().filter((track) => track.readyState === 'live');
    if (audioTracks.length === 0) {
      setIsSpeaking(false);
      onSpeakingChange?.(peer.peerId, false);
      return undefined;
    }

    const context = new AudioContext({ latencyHint: 'interactive' });
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.35;
    const source = context.createMediaStreamSource(new MediaStream(audioTracks));
    source.connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    let timer: number | null = null;
    let speaking = false;
    let hangoverUntil = 0;

    const tick = () => {
      analyser.getFloatTimeDomainData(buffer);
      let sumSquares = 0;
      for (let index = 0; index < buffer.length; index += 1) sumSquares += buffer[index] * buffer[index];
      const rms = Math.sqrt(sumSquares / buffer.length);
      const db = rms > 0.000015 ? 20 * Math.log10(rms) : -96;
      const now = performance.now();
      if (db >= -52) {
        hangoverUntil = now + 180;
        if (!speaking) {
          speaking = true;
          setIsSpeaking(true);
          onSpeakingChange?.(peer.peerId, true);
        }
      } else if (speaking && now >= hangoverUntil) {
        speaking = false;
        setIsSpeaking(false);
        onSpeakingChange?.(peer.peerId, false);
      }
      timer = window.setTimeout(tick, 55);
    };

    void context.resume().catch(() => undefined);
    tick();
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      source.disconnect();
      analyser.disconnect();
      void context.close().catch(() => undefined);
      onSpeakingChange?.(peer.peerId, false);
    };
  }, [onSpeakingChange, peer.peerId, trackSignature]);

  return (
    <article className={`media-tile media-tile--remote ${hasVideo ? 'has-video' : ''} ${isSpeaking ? 'is-speaking' : ''}`}>
      <div className="media-tile__viewport">
        <video ref={videoRef} autoPlay playsInline />
        {!hasVideo && (
          <div className="media-fallback">
            <span className="avatar avatar--xl avatar--remote">{initialFor(peer.name)}</span>
          </div>
        )}
        <div className="media-tile__status">
          <span>{peer.name}{peer.media.camera ? <small> · câmera</small> : peer.media.screen ? <small> · transmitindo tela</small> : null}</span>
          <span className="media-tile__indicators">
            {isSpeaking && <span className="speaking-badge">Falando</span>}
            <span className={`connection-badge connection-badge--${peer.connectionState}`}>{peer.connectionState}</span>
          </span>
        </div>
      </div>
    </article>
  );
}
