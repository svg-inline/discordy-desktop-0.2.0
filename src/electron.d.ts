export {};

type CloudflaredCheck = {
  installed: boolean;
  binary: string | null;
  version: string | null;
  error?: string;
};

type HostStartResult = {
  localUrl: string;
  publicUrl: string;
  port: number;
  cloudflaredVersion: string;
};

type HostStatus = {
  phase: string;
  message: string;
  localUrl?: string;
  publicUrl?: string;
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
        start(): Promise<HostStartResult>;
        stop(): Promise<boolean>;
        onStatus(callback: (status: HostStatus) => void): () => void;
        onLog(callback: (line: string) => void): () => void;
      };
      clipboard: {
        writeText(text: string): Promise<boolean>;
      };
      onDeepLink(callback: (url: string) => void): () => void;
    };
  }
}
