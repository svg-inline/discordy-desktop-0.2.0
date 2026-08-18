export {};

type CloudflaredCheck = {
  installed: boolean;
  binary: string | null;
  version: string | null;
  error?: string;
};

type HostStartOptions = {
  roomId: string;
  roomName: string;
  maxParticipants: 2 | 3 | 4;
  pin?: string;
  approvalRequired?: boolean;
};

type HostStartResult = {
  localUrl: string;
  publicUrl: string;
  port: number;
  cloudflaredVersion: string;
  room: {
    roomId: string;
    name: string;
    maxParticipants: 2 | 3 | 4;
  };
  hostSecret: string;
  inviteToken: string;
};

type HostStatus = {
  phase: string;
  message: string;
  localUrl?: string;
  publicUrl?: string;
};

type ScreenSourceInfo = {
  id: string;
  name: string;
  type: 'monitor' | 'window';
  thumbnail: string;
  displayId: string | null;
};

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

type DesktopCommand = {
  type: 'toggle-mute' | 'toggle-deafen' | 'toggle-window' | 'ptt-down' | 'ptt-up' | 'ptm-down' | 'ptm-up';
  source: string;
  at: number;
};

declare global {
  interface Window {
    discordy: {
      platform: string;
      cloudflared: {
        check(): Promise<CloudflaredCheck>;
        openDownload(): Promise<boolean>;
      };
      host: {
        start(options: HostStartOptions): Promise<HostStartResult>;
        stop(): Promise<boolean>;
        onStatus(callback: (status: HostStatus) => void): () => void;
        onLog(callback: (line: string) => void): () => void;
      };
      screen: {
        listSources(): Promise<ScreenSourceInfo[]>;
        selectSource(sourceId: string, includeAudio: boolean): boolean;
      };
      clipboard: {
        writeText(text: string): Promise<boolean>;
      };
      desktop: {
        getState(): Promise<DesktopRuntimeState>;
        updatePreferences(changes: Partial<DesktopPreferences>): Promise<DesktopRuntimeState>;
        notify(payload: { title: string; body: string; silent?: boolean }): Promise<boolean>;
        showWindow(): Promise<boolean>;
        hideWindow(): Promise<boolean>;
        updateMediaState(state: { micEnabled?: boolean; deafened?: boolean }): void;
        onCommand(callback: (command: DesktopCommand) => void): () => void;
        onPreferencesChanged(callback: (state: DesktopRuntimeState) => void): () => void;
      };
      onDeepLink(callback: (url: string) => void): () => void;
    };
  }
}
