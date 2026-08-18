# Discordy Desktop 0.4.0 — Screen Share avançado

Evolução da `0.3.0` mantendo Voice & Media, Network Diagnostics e WebRTC Stabilization, com uma camada própria para compartilhamento de tela.

## 0.4.0 — Screen Share avançado

Implementado:

- seletor interno de **monitor ou janela** usando `desktopCapturer`;
- preview das fontes antes de compartilhar;
- áudio do sistema opcional;
- presets:
  - `720p30`;
  - `1080p30`;
  - `1080p60`;
- controle de bitrate entre `500 Kbps` e `20 Mbps`;
- aplicação do bitrate no `RTCRtpSender` via `setParameters()`;
- `degradationPreference = maintain-resolution` para a track de tela;
- FPS real medido no vídeo renderizado com `requestVideoFrameCallback()`;
- resolução efetiva exibida sobre a transmissão;
- fullscreen por transmissão;
- Picture-in-Picture por transmissão;
- expandir/reduzir uma transmissão dentro da sala;
- identificação clara de quem está transmitindo;
- tipo e nome da fonte compartilhada;
- estado `AO VIVO`;
- câmera e tela renderizadas separadamente;
- múltiplos participantes podem compartilhar simultaneamente;
- cada participante continua limitado a uma transmissão de tela ativa por vez nesta versão;
- metadados de tela propagados pelo signaling (`preset`, fonte, bitrate, FPS alvo e áudio do sistema).

## Arquitetura

```text
Participante
├── microphone
├── camera
└── screen
    ├── screenVideo
    ├── screenAudio opcional
    └── ScreenShareMetadata

PeerManager
├── Perfect Negotiation
├── RTCRtpSender screenVideo
│   ├── maxBitrate
│   ├── maxFramerate
│   └── maintain-resolution
└── signaling de estado da transmissão
```

A câmera não é mais substituída visualmente pela tela. O layout trata as transmissões como superfícies independentes:

```text
Screen Share Stage
├── Tela do Victor
├── Tela do João
└── Tela do Pedro

Participant Grid
├── Victor / câmera / voz
├── João / câmera / voz
└── Pedro / câmera / voz
```

## Seleção de monitor/janela

No Electron, o renderer solicita a lista de fontes ao processo principal. Ao clicar em uma fonte, o preload registra sincronamente a origem selecionada e `getDisplayMedia()` inicia a captura na mesma ação do usuário.

```text
Renderer
   │ listSources
   ▼
desktopCapturer
   │
   ├── Monitor 1
   ├── Monitor 2
   ├── Chrome
   └── VS Code

Usuário escolhe
   │
   ▼
setDisplayMediaRequestHandler
   │
   ▼
MediaStream
```

## Áudio do sistema

No Windows, quando habilitado, o processo principal concede `audio: loopback`. O stream somente anuncia áudio do sistema se uma track de áudio realmente tiver sido criada.

## Qualidade e bitrate

Presets padrão:

```text
720p30  → 1280×720  / 30 FPS / 2.5 Mbps inicial
1080p30 → 1920×1080 / 30 FPS / 4.5 Mbps inicial
1080p60 → 1920×1080 / 60 FPS / 8.0 Mbps inicial
```

O bitrate continua ajustável manualmente até `20 Mbps`.

## FPS real

O overlay da transmissão mede frames efetivamente apresentados pelo `<video>` com `requestVideoFrameCallback()`. Portanto o valor mostrado não é apenas o FPS solicitado no preset.

## Recursos preservados

### Voice & Media 0.3.0

- mute;
- deafen;
- volume individual;
- microfone/saída/câmera selecionáveis;
- câmera;
- indicador de fala;
- sensibilidade automática/manual;
- Push-to-Talk;
- Push-to-Mute.

### Network Diagnostics 0.2.3

- candidate pair ICE;
- P2P/TURN;
- RTT;
- jitter;
- packet loss;
- bitrate real de upload/download;
- codecs;
- resolução/FPS recebido;
- relatório técnico.

### WebRTC Stabilization 0.2.2

- tracks separadas;
- Perfect Negotiation;
- `negotiationneeded`;
- ICE restart;
- reconexão automática WebSocket/WebRTC;
- logs RTC.

## Desenvolvimento

```powershell
npm install
npm run dev
```

## Build Windows

```powershell
npm install
npm run dist:win
```

Artefatos em `release/`.

## Limitações atuais

- máximo de 4 participantes;
- Mesh P2P: cada transmissor envia sua tela separadamente para cada peer;
- um screen share ativo por participante;
- áudio loopback do Electron é suportado diretamente no Windows; outros sistemas podem ter limitações próprias;
- sem TURN configurado nesta etapa;
- Quick Tunnel continua temporário para signaling público.
