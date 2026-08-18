import { startSignalingServer } from '../server/signaling-server.mjs';
import { TunnelService } from './tunnel-service.mjs';

export class HostService {
  constructor({ logger = () => {}, onStatus = () => {} } = {}) {
    this.logger = logger;
    this.onStatus = onStatus;
    this.signaling = null;
    this.tunnel = new TunnelService({ logger, onStatus });
  }

  async checkCloudflared() {
    return await this.tunnel.checkInstalled();
  }

  async start(options = {}) {
    await this.stop();
    this.onStatus({ phase: 'server-starting', message: 'Iniciando servidor local...' });

    this.signaling = await startSignalingServer({
      host: '127.0.0.1',
      port: 0,
      initialRoom: {
        roomId: options.roomId,
        name: options.roomName,
        maxParticipants: options.maxParticipants,
        pin: options.pin,
        approvalRequired: options.approvalRequired,
        inviteTtlMinutes: options.inviteTtlMinutes,
      },
      logger: this.logger,
    });

    this.onStatus({ phase: 'server-ready', message: 'Servidor local pronto.', localUrl: this.signaling.baseUrl });

    try {
      const tunnel = await this.tunnel.start(this.signaling.baseUrl);
      const hostSecret = this.signaling.hostSecret;
      const inviteToken = this.signaling.inviteToken;
      // O objeto de serviço não precisa conservar uma segunda referência das credenciais brutas.
      this.signaling.hostSecret = null;
      this.signaling.inviteToken = null;
      return {
        localUrl: this.signaling.baseUrl,
        publicUrl: tunnel.publicUrl,
        port: this.signaling.port,
        cloudflaredVersion: tunnel.version,
        room: {
          roomId: this.signaling.roomId,
          name: this.signaling.roomName,
          maxParticipants: this.signaling.maxParticipants,
        },
        hostSecret,
        inviteToken,
        inviteExpiresAt: this.signaling.inviteExpiresAt,
      };
    } catch (error) {
      await this.signaling.close();
      this.signaling = null;
      throw error;
    }
  }

  async stop() {
    await this.tunnel.stop();
    if (this.signaling) {
      const server = this.signaling;
      this.signaling = null;
      await server.close();
    }
    this.onStatus({ phase: 'idle', message: 'Servidor parado.' });
  }
}
