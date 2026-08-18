import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;

async function resolveBinary() {
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    const { stdout } = await execFileAsync(command, ['cloudflared'], { windowsHide: true });
    const first = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (first) return first;
  } catch {
    // Continue with known Windows install locations.
  }

  if (process.platform === 'win32') {
    const candidates = [
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'cloudflared', 'cloudflared.exe'),
      process.env.ProgramFiles && join(process.env.ProgramFiles, 'cloudflared', 'cloudflared.exe'),
      process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'cloudflared', 'cloudflared.exe'),
    ].filter(Boolean);

    const installed = candidates.find((candidate) => existsSync(candidate));
    if (installed) return installed;
    return 'cloudflared.exe';
  }

  return 'cloudflared';
}

export class TunnelService {
  constructor({ logger = () => {}, onStatus = () => {} } = {}) {
    this.logger = logger;
    this.onStatus = onStatus;
    this.process = null;
    this.publicUrl = null;
  }

  async checkInstalled() {
    const binary = await resolveBinary();
    try {
      const { stdout, stderr } = await execFileAsync(binary, ['--version'], { windowsHide: true, timeout: 8000 });
      return { installed: true, binary, version: (stdout || stderr).trim() };
    } catch (error) {
      return { installed: false, binary: null, version: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async start(originUrl) {
    if (this.process) await this.stop();

    const check = await this.checkInstalled();
    if (!check.installed || !check.binary) {
      const error = new Error('Cloudflared não encontrado. Instale o Cloudflare Tunnel antes de hospedar uma sala.');
      error.code = 'CLOUDFLARED_NOT_FOUND';
      throw error;
    }

    this.onStatus({ phase: 'tunnel-starting', message: 'Criando conexão pública...' });
    this.logger(`[cloudflared] ${check.version}`);

    const child = spawn(check.binary, ['tunnel', '--url', originUrl], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.process = child;

    return await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.stop();
        reject(new Error('O Cloudflare Tunnel não retornou uma URL pública.'));
      }, 45000);

      const finishError = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      const inspect = (buffer) => {
        const text = buffer.toString();
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) this.logger(`[cloudflared] ${line.trim()}`);
        }

        const match = text.match(QUICK_TUNNEL_URL)?.[0];
        if (!match || settled) return;

        settled = true;
        clearTimeout(timeout);
        this.publicUrl = match;
        this.onStatus({ phase: 'ready', message: 'Sala pública pronta.', publicUrl: match });
        resolve({ publicUrl: match, version: check.version });
      };

      child.stdout.on('data', inspect);
      child.stderr.on('data', inspect);
      child.once('error', finishError);
      child.once('exit', (code, signal) => {
        this.process = null;
        if (!settled) finishError(new Error(`Cloudflared encerrou antes de criar o túnel (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`));
      });
    });
  }

  async stop() {
    const child = this.process;
    this.process = null;
    this.publicUrl = null;
    if (!child) return;

    try {
      child.kill();
    } catch {
      // Process may already be gone.
    }
    this.onStatus({ phase: 'stopped', message: 'Tunnel encerrado.' });
  }
}
