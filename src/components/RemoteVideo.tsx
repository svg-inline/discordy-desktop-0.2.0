import { useEffect, useRef } from 'react';
import type { RemotePeer } from '../lib/types';

type Props = {
  peer: RemotePeer;
};

function initialFor(value: string) {
  return value.trim().charAt(0).toUpperCase() || '?';
}

export function RemoteVideo({ peer }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.srcObject = peer.stream;

    const play = () => videoRef.current?.play().catch(() => undefined);
    play();
    peer.stream.addEventListener('addtrack', play);

    return () => peer.stream.removeEventListener('addtrack', play);
  }, [peer.stream]);

  const hasLiveVideoTrack = peer.stream.getVideoTracks().some((track) => track.readyState === 'live');
  const hasVideo = hasLiveVideoTrack && (peer.media.screen || peer.media.camera);

  return (
    <article className={`media-tile media-tile--remote ${hasVideo ? 'has-video' : ''}`}>
      <div className="media-tile__viewport">
        <video ref={videoRef} autoPlay playsInline />
        {!hasVideo && (
          <div className="media-fallback">
            <span className="avatar avatar--xl avatar--remote">{initialFor(peer.name)}</span>
          </div>
        )}
        <div className="media-tile__status">
          <span>{peer.name}{peer.media.screen ? <small> · compartilhando tela</small> : null}</span>
          <span className={`connection-badge connection-badge--${peer.connectionState}`}>{peer.connectionState}</span>
        </div>
      </div>
    </article>
  );
}
