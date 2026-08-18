import type { ScreenShareMetadata } from '../lib/types';

export type ScreenQualityPreset = '720p30' | '1080p30' | '1080p60';

export type ScreenSourceInfo = {
  id: string;
  name: string;
  type: 'monitor' | 'window';
  thumbnail: string;
  displayId: string | null;
};

export type ScreenShareOptions = {
  preset: ScreenQualityPreset;
  bitrateKbps: number;
  systemAudio: boolean;
};

export type ScreenShareSession = {
  stream: MediaStream;
  metadata: ScreenShareMetadata;
};

export const SCREEN_QUALITY_PRESETS: Record<ScreenQualityPreset, { label: string; width: number; height: number; fps: number; defaultBitrateKbps: number }> = {
  '720p30': { label: '720p · 30 FPS', width: 1280, height: 720, fps: 30, defaultBitrateKbps: 2500 },
  '1080p30': { label: '1080p · 30 FPS', width: 1920, height: 1080, fps: 30, defaultBitrateKbps: 4500 },
  '1080p60': { label: '1080p · 60 FPS', width: 1920, height: 1080, fps: 60, defaultBitrateKbps: 8000 },
};

function clampBitrate(value: number) {
  return Math.max(500, Math.min(20000, Math.round(value)));
}

export class ScreenShareController {
  async listSources(): Promise<ScreenSourceInfo[]> {
    return await window.discordy.screen.listSources();
  }

  async start(source: ScreenSourceInfo, options: ScreenShareOptions): Promise<ScreenShareSession> {
    const preset = SCREEN_QUALITY_PRESETS[options.preset];
    const bitrateKbps = clampBitrate(options.bitrateKbps);

    // Synchronous IPC intentionally keeps this action in the same user-gesture task
    // before getDisplayMedia() is called.
    window.discordy.screen.selectSource(source.id, options.systemAudio);

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: preset.width, max: preset.width },
        height: { ideal: preset.height, max: preset.height },
        frameRate: { ideal: preset.fps, max: preset.fps },
      },
      audio: options.systemAudio,
    });

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      for (const track of stream.getTracks()) track.stop();
      throw new Error('A fonte selecionada não retornou uma track de vídeo.');
    }

    try {
      videoTrack.contentHint = 'detail';
    } catch {
      // Chromium versions without writable contentHint can safely ignore this.
    }

    await this.applyQuality(stream, options.preset).catch(() => undefined);

    const settings = videoTrack.getSettings();
    const displaySurface = typeof settings.displaySurface === 'string'
      ? settings.displaySurface
      : source.type === 'monitor' ? 'monitor' : 'window';

    return {
      stream,
      metadata: {
        sourceName: source.name,
        sourceType: displaySurface === 'monitor' ? 'monitor' : displaySurface === 'browser' ? 'browser' : 'window',
        preset: options.preset,
        targetWidth: preset.width,
        targetHeight: preset.height,
        targetFps: preset.fps,
        bitrateKbps,
        systemAudio: stream.getAudioTracks().length > 0,
      },
    };
  }

  async applyQuality(stream: MediaStream, presetName: ScreenQualityPreset) {
    const preset = SCREEN_QUALITY_PRESETS[presetName];
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    await track.applyConstraints({
      width: { ideal: preset.width, max: preset.width },
      height: { ideal: preset.height, max: preset.height },
      frameRate: { ideal: preset.fps, max: preset.fps },
    });
  }
}
