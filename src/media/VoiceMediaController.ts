export type VoiceInputMode = 'voice-activity' | 'push-to-talk';
export type SensitivityMode = 'automatic' | 'manual';

export type VoiceActivitySnapshot = {
  levelDb: number;
  thresholdDb: number;
  speaking: boolean;
  transmitting: boolean;
};

export type MediaDeviceCatalog = {
  audioInputs: MediaDeviceInfo[];
  audioOutputs: MediaDeviceInfo[];
  videoInputs: MediaDeviceInfo[];
};

type ControllerOptions = {
  onVoiceActivity?: (snapshot: VoiceActivitySnapshot) => void;
  onLog?: (message: string) => void;
};

const SILENCE_DB = -96;
const AUTO_THRESHOLD_MIN_DB = -58;
const AUTO_THRESHOLD_MAX_DB = -32;
const SPEECH_HANGOVER_MS = 220;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export class VoiceMediaController {
  private readonly onVoiceActivity: NonNullable<ControllerOptions['onVoiceActivity']>;
  private readonly onLog: NonNullable<ControllerOptions['onLog']>;

  private rawMicrophoneStream: MediaStream | null = null;
  private processedMicrophoneStream: MediaStream | null = null;
  private cameraStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private microphoneGain: GainNode | null = null;
  private monitorTimer: number | null = null;
  private analyserBuffer: Float32Array<ArrayBuffer> | null = null;

  private muted = false;
  private deafened = false;
  private inputMode: VoiceInputMode = 'voice-activity';
  private sensitivityMode: SensitivityMode = 'automatic';
  private manualThresholdDb = -48;
  private autoThresholdDb = -48;
  private noiseFloorDb = -72;
  private noiseFloorInitialized = false;
  private pushToTalkPressed = false;
  private pushToMutePressed = false;
  private speaking = false;
  private speechHangoverUntil = 0;
  private lastTransmitting = false;

  constructor(options: ControllerOptions = {}) {
    this.onVoiceActivity = options.onVoiceActivity ?? (() => undefined);
    this.onLog = options.onLog ?? (() => undefined);
  }

  async enumerateDevices(): Promise<MediaDeviceCatalog> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      audioInputs: devices.filter((device) => device.kind === 'audioinput'),
      audioOutputs: devices.filter((device) => device.kind === 'audiooutput'),
      videoInputs: devices.filter((device) => device.kind === 'videoinput'),
    };
  }

  async startMicrophone(deviceId?: string): Promise<MediaStream> {
    await this.stopMicrophoneGraph();

    const audio: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (deviceId) audio.deviceId = { exact: deviceId };

    const raw = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    const context = new AudioContext({ latencyHint: 'interactive' });
    if (context.state === 'suspended') await context.resume().catch(() => undefined);

    const source = context.createMediaStreamSource(raw);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.25;

    const gain = context.createGain();
    gain.gain.value = 0;
    const destination = context.createMediaStreamDestination();

    source.connect(analyser);
    source.connect(gain);
    gain.connect(destination);

    this.rawMicrophoneStream = raw;
    this.processedMicrophoneStream = destination.stream;
    this.audioContext = context;
    this.analyser = analyser;
    this.microphoneGain = gain;
    this.analyserBuffer = new Float32Array(analyser.fftSize);
    this.noiseFloorDb = -72;
    this.noiseFloorInitialized = false;
    this.autoThresholdDb = -48;
    this.speaking = false;
    this.speechHangoverUntil = 0;
    this.startMonitor();
    this.applyGate();

    const track = raw.getAudioTracks()[0];
    this.onLog(`microfone capturado: ${track?.label || 'dispositivo padrão'} (${track?.id.slice(0, 8) || 'none'})`);
    return destination.stream;
  }

  async switchMicrophone(deviceId?: string): Promise<MediaStream> {
    this.onLog(`alterando microfone para ${deviceId || 'padrão do sistema'}`);
    return this.startMicrophone(deviceId);
  }

  async startCamera(deviceId?: string): Promise<MediaStream> {
    this.stopCamera();
    const video: MediaTrackConstraints = {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 60 },
    };
    if (deviceId) video.deviceId = { exact: deviceId };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
    this.cameraStream = stream;
    const track = stream.getVideoTracks()[0];
    this.onLog(`câmera capturada: ${track?.label || 'dispositivo padrão'} (${track?.id.slice(0, 8) || 'none'})`);
    return stream;
  }

  async switchCamera(deviceId?: string): Promise<MediaStream> {
    this.onLog(`alterando câmera para ${deviceId || 'padrão do sistema'}`);
    return this.startCamera(deviceId);
  }

  stopCamera() {
    if (!this.cameraStream) return;
    for (const track of this.cameraStream.getTracks()) track.stop();
    this.cameraStream = null;
    this.onLog('câmera encerrada');
  }

  getMicrophoneStream() {
    return this.processedMicrophoneStream;
  }

  getCameraStream() {
    return this.cameraStream;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.applyGate();
  }

  setDeafened(deafened: boolean) {
    this.deafened = deafened;
    this.applyGate();
  }

  setInputMode(mode: VoiceInputMode) {
    this.inputMode = mode;
    this.applyGate();
  }

  setSensitivity(mode: SensitivityMode, manualThresholdDb: number) {
    if (mode === 'automatic' && this.sensitivityMode !== 'automatic') this.noiseFloorInitialized = false;
    this.sensitivityMode = mode;
    this.manualThresholdDb = clamp(Number.isFinite(manualThresholdDb) ? manualThresholdDb : -48, -80, -20);
    this.applyGate();
  }

  setPushToTalkPressed(pressed: boolean) {
    if (this.pushToTalkPressed === pressed) return;
    this.pushToTalkPressed = pressed;
    this.applyGate();
  }

  setPushToMutePressed(pressed: boolean) {
    if (this.pushToMutePressed === pressed) return;
    this.pushToMutePressed = pressed;
    this.applyGate();
  }

  async destroy() {
    this.stopCamera();
    await this.stopMicrophoneGraph();
  }

  private startMonitor() {
    this.stopMonitor();
    const tick = () => {
      this.sampleVoiceActivity();
      this.monitorTimer = window.setTimeout(tick, 45);
    };
    tick();
  }

  private stopMonitor() {
    if (this.monitorTimer === null) return;
    window.clearTimeout(this.monitorTimer);
    this.monitorTimer = null;
  }

  private sampleVoiceActivity() {
    const analyser = this.analyser;
    const buffer = this.analyserBuffer;
    if (!analyser || !buffer) return;

    analyser.getFloatTimeDomainData(buffer);
    let sumSquares = 0;
    for (let index = 0; index < buffer.length; index += 1) sumSquares += buffer[index] * buffer[index];
    const rms = Math.sqrt(sumSquares / buffer.length);
    const levelDb = rms > 0.000015 ? 20 * Math.log10(rms) : SILENCE_DB;

    if (this.sensitivityMode === 'automatic') {
      const bounded = clamp(levelDb, -90, -30);
      if (!this.noiseFloorInitialized) {
        this.noiseFloorDb = bounded;
        this.noiseFloorInitialized = true;
      } else {
        const alpha = this.speaking ? 0.0025 : 0.035;
        this.noiseFloorDb = (this.noiseFloorDb * (1 - alpha)) + (bounded * alpha);
      }
      this.autoThresholdDb = clamp(this.noiseFloorDb + 13, AUTO_THRESHOLD_MIN_DB, AUTO_THRESHOLD_MAX_DB);
    }

    const thresholdDb = this.sensitivityMode === 'automatic' ? this.autoThresholdDb : this.manualThresholdDb;
    const now = performance.now();
    const enterThreshold = thresholdDb;
    const leaveThreshold = thresholdDb - 4;

    if (levelDb >= (this.speaking ? leaveThreshold : enterThreshold)) {
      this.speaking = true;
      this.speechHangoverUntil = now + SPEECH_HANGOVER_MS;
    } else if (now >= this.speechHangoverUntil) {
      this.speaking = false;
    }

    this.applyGate(levelDb, thresholdDb);
  }

  private applyGate(levelDb = SILENCE_DB, thresholdDb = this.sensitivityMode === 'automatic' ? this.autoThresholdDb : this.manualThresholdDb) {
    const modeAllows = this.inputMode === 'push-to-talk' ? this.pushToTalkPressed : this.speaking;
    const transmitting = !this.muted && !this.deafened && !this.pushToMutePressed && modeAllows;

    if (this.microphoneGain && this.audioContext) {
      const now = this.audioContext.currentTime;
      this.microphoneGain.gain.cancelScheduledValues(now);
      this.microphoneGain.gain.setTargetAtTime(transmitting ? 1 : 0, now, transmitting ? 0.008 : 0.015);
    }

    if (transmitting !== this.lastTransmitting) {
      this.lastTransmitting = transmitting;
      this.onLog(`transmissão do microfone ${transmitting ? 'aberta' : 'fechada'}`);
    }

    this.onVoiceActivity({ levelDb, thresholdDb, speaking: this.speaking && transmitting, transmitting });
  }

  private async stopMicrophoneGraph() {
    this.stopMonitor();
    for (const track of this.rawMicrophoneStream?.getTracks() ?? []) track.stop();
    for (const track of this.processedMicrophoneStream?.getTracks() ?? []) track.stop();
    this.rawMicrophoneStream = null;
    this.processedMicrophoneStream = null;
    this.analyser = null;
    this.microphoneGain = null;
    this.analyserBuffer = null;
    const context = this.audioContext;
    this.audioContext = null;
    if (context && context.state !== 'closed') await context.close().catch(() => undefined);
  }
}
