import type { ClientMessage, ServerMessage } from './types';

type Handler = (message: ServerMessage) => void;
export type SignalingState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
type StateHandler = (state: SignalingState, details?: { attempt?: number; delayMs?: number; reconnected?: boolean }) => void;

type SessionContext = {
  roomId: string;
  name: string;
};

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
  private stateHandlers = new Set<StateHandler>();
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private manualClose = false;
  private session: SessionContext | null = null;
  private generation = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly onLog: (message: string) => void = () => undefined,
  ) {}

  setSession(roomId: string, name: string) {
    this.session = { roomId, name };
  }

  async connect(): Promise<void> {
    this.manualClose = false;
    this.clearReconnectTimer();
    await this.openSocket(false);
  }

  onMessage(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onStateChange(handler: StateHandler): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  send(message: ClientMessage): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  close(): void {
    this.manualClose = true;
    this.generation += 1;
    this.clearReconnectTimer();
    if (this.socket?.readyState === WebSocket.OPEN) this.send({ type: 'leave' });
    this.socket?.close(1000, 'client-close');
    this.socket = null;
    this.emitState('closed');
    this.log('fechado pelo cliente');
  }

  private openSocket(isReconnect: boolean): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();

    const generation = ++this.generation;
    const wsUrl = createWebSocketUrl(this.baseUrl);
    this.emitState(isReconnect ? 'reconnecting' : 'connecting', isReconnect ? { attempt: this.reconnectAttempt } : undefined);
    this.log(`${isReconnect ? 'reconectando' : 'conectando'} em ${wsUrl}`);

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      this.socket = socket;
      let settled = false;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      const timer = window.setTimeout(() => {
        try { socket.close(); } catch { /* noop */ }
        fail(new Error('Tempo limite ao conectar ao servidor da sala.'));
      }, 15000);

      socket.addEventListener('open', () => {
        if (generation !== this.generation) {
          socket.close();
          return;
        }
        window.clearTimeout(timer);
        settled = true;
        this.socket = socket;
        const reconnected = isReconnect || this.reconnectAttempt > 0;
        this.reconnectAttempt = 0;
        this.emitState('open', { reconnected });
        this.log(reconnected ? 'WebSocket reconectado' : 'WebSocket conectado');
        if (this.session) {
          this.send({ type: 'join', roomId: this.session.roomId, name: this.session.name });
          this.log(`join enviado para sala ${this.session.roomId}`);
        }
        resolve();
      }, { once: true });

      socket.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(String(event.data)) as ServerMessage;
          for (const handler of this.handlers) handler(message);
        } catch (error) {
          this.log(`mensagem inválida: ${error instanceof Error ? error.message : String(error)}`);
        }
      });

      socket.addEventListener('error', () => {
        window.clearTimeout(timer);
        if (!settled) fail(new Error('Falha ao conectar ao servidor da sala.'));
      });

      socket.addEventListener('close', (event) => {
        window.clearTimeout(timer);
        if (generation !== this.generation) return;
        if (this.socket === socket) this.socket = null;
        this.log(`WebSocket fechado code=${event.code} reason=${event.reason || 'sem motivo'}`);
        if (!settled) fail(new Error('Conexão WebSocket encerrada antes de ficar pronta.'));
        if (!this.manualClose) this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect() {
    if (this.manualClose || this.reconnectTimer !== null) return;
    this.reconnectAttempt += 1;
    const delayMs = Math.min(1000 * 2 ** Math.min(this.reconnectAttempt - 1, 4), 10000);
    this.emitState('reconnecting', { attempt: this.reconnectAttempt, delayMs });
    this.log(`nova tentativa de signaling em ${delayMs}ms (#${this.reconnectAttempt})`);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket(true).catch((error) => {
        this.log(`reconexão falhou: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, delayMs);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer === null) return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private emitState(state: SignalingState, details?: { attempt?: number; delayMs?: number; reconnected?: boolean }) {
    for (const handler of this.stateHandlers) handler(state, details);
  }

  private log(message: string) {
    this.onLog(`[WS] ${message}`);
  }
}
