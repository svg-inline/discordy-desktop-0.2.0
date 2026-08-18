import type { ClientMessage, ServerMessage } from './types';

type Handler = (message: ServerMessage) => void;

function createWebSocketUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('Servidor precisa usar http, https, ws ou wss.');
  url.pathname = '/ws';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export class SignalingClient {
  private socket: WebSocket | null = null;
  private handlers = new Set<Handler>();

  constructor(private readonly baseUrl: string) {}

  connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();

    const wsUrl = createWebSocketUrl(this.baseUrl);
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      this.socket = socket;

      const timer = window.setTimeout(() => {
        socket.close();
        reject(new Error('Tempo limite ao conectar ao servidor da sala.'));
      }, 15000);

      socket.addEventListener('open', () => {
        window.clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        window.clearTimeout(timer);
        reject(new Error('Falha ao conectar ao servidor da sala.'));
      }, { once: true });
      socket.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(String(event.data)) as ServerMessage;
          for (const handler of this.handlers) handler(message);
        } catch (error) {
          console.error('Mensagem de signaling inválida:', error);
        }
      });
    });
  }

  onMessage(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('WebSocket não está conectado.');
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.send({ type: 'leave' });
    this.socket?.close();
    this.socket = null;
  }
}
