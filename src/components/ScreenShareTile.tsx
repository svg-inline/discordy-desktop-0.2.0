import { useEffect, useMemo, useRef, useState } from 'react';
import type { ScreenShareMetadata } from '../lib/types';

type Props = {
  stream: MediaStream;
  trackId?: string | null;
  broadcasterName: string;
  metadata?: ScreenShareMetadata | null;
  local?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
};

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: { mediaTime?: number; presentedFrames?: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

function selectTrack(stream: MediaStream, trackId?: string | null) {
  const tracks = stream.getVideoTracks().filter((track) => track.readyState === 'live');
  if (trackId) return tracks.find((track) => track.id === trackId) ?? tracks[0] ?? null;
  return tracks[0] ?? null;
}

function sourceLabel(type?: ScreenShareMetadata['sourceType']) {
  if (type === 'monitor') return 'Monitor';
  if (type === 'window') return 'Janela';
  if (type === 'browser') return 'Aba';
  return 'Tela';
}

function formatBitrate(kbps?: number) {
  if (!kbps) return '—';
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(kbps % 1000 === 0 ? 0 : 1)} Mbps` : `${kbps} Kbps`;
}

export function ScreenShareTile({
  stream,
  trackId,
  broadcasterName,
  metadata,
  local = false,
  expanded = false,
  onToggleExpand,
}: Props) {
  const videoRef = useRef<VideoWithFrameCallback | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [fps, setFps] = useState<number | null>(null);
  const [dimensions, setDimensions] = useState<string>('—');

  const track = useMemo(() => selectTrack(stream, trackId), [stream, trackId]);
  const playback = useMemo(() => track ? new MediaStream([track]) : new MediaStream(), [track]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = playback;
    video.muted = true;
    void video.play().catch(() => undefined);
  }, [playback]);

  useEffect(() => {
    if (!track) {
      setDimensions('—');
      return;
    }
    const update = () => {
      const settings = track.getSettings();
      const width = settings.width;
      const height = settings.height;
      setDimensions(width && height ? `${width}×${height}` : '—');
    };
    update();
    track.addEventListener('mute', update);
    track.addEventListener('unmute', update);
    return () => {
      track.removeEventListener('mute', update);
      track.removeEventListener('unmute', update);
    };
  }, [track]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (typeof video.requestVideoFrameCallback !== 'function') {
      const fallback = track?.getSettings().frameRate;
      setFps(typeof fallback === 'number' ? fallback : null);
      return;
    }

    let handle = 0;
    let frames = 0;
    let startedAt = performance.now();
    let cancelled = false;

    const tick = (now: number) => {
      if (cancelled) return;
      frames += 1;
      const elapsed = now - startedAt;
      if (elapsed >= 1000) {
        setFps((frames * 1000) / elapsed);
        if (video.videoWidth && video.videoHeight) setDimensions(`${video.videoWidth}×${video.videoHeight}`);
        frames = 0;
        startedAt = now;
      }
      handle = video.requestVideoFrameCallback!(tick);
    };
    handle = video.requestVideoFrameCallback(tick);

    return () => {
      cancelled = true;
      if (handle && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handle);
    };
  }, [playback, track]);

  const toggleFullscreen = async () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
    else await viewport.requestFullscreen().catch(() => undefined);
  };

  const togglePictureInPicture = async () => {
    const video = videoRef.current;
    if (!video || typeof video.requestPictureInPicture !== 'function') return;
    if (document.pictureInPictureElement === video) await document.exitPictureInPicture().catch(() => undefined);
    else await video.requestPictureInPicture().catch(() => undefined);
  };

  return (
    <article className={`screen-share-tile ${expanded ? 'screen-share-tile--expanded' : ''}`}>
      <div className="screen-share-tile__viewport" ref={viewportRef}>
        <video ref={videoRef} autoPlay muted playsInline />
        <div className="screen-share-tile__live"><span />AO VIVO</div>
        <div className="screen-share-tile__actions">
          {onToggleExpand && <button onClick={onToggleExpand}>{expanded ? 'Reduzir' : 'Expandir'}</button>}
          <button onClick={() => void togglePictureInPicture()}>PiP</button>
          <button onClick={() => void toggleFullscreen()}>Tela cheia</button>
        </div>
        <div className="screen-share-tile__info">
          <div>
            <strong>{broadcasterName}{local ? ' · Você' : ''}</strong>
            <span>{sourceLabel(metadata?.sourceType)}{metadata?.sourceName ? ` · ${metadata.sourceName}` : ''}</span>
          </div>
          <div className="screen-share-tile__metrics">
            <span>{dimensions}</span>
            <span>{fps === null ? 'FPS —' : `${fps.toFixed(1)} FPS`}</span>
            <span>{metadata?.preset ?? 'qualidade n/d'}</span>
            <span>{formatBitrate(metadata?.bitrateKbps)}</span>
            {metadata?.systemAudio && <span>áudio do sistema</span>}
          </div>
        </div>
      </div>
    </article>
  );
}
