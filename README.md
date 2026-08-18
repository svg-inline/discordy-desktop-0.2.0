# Discordy Desktop 0.8.0 — Desktop Experience

Evolução da `0.7.0` adicionando integração real com o desktop Windows sem alterar o transporte WebRTC/RTCDataChannel.

## 0.8.0 — Desktop Experience

Implementado:

- minimizar para a bandeja do sistema;
- fechar para a bandeja sem encerrar chamadas/túnel;
- menu de tray para abrir, mute, deafen, iniciar com Windows e encerrar;
- notificações nativas para mensagens, participantes e solicitações quando o app estiver em segundo plano;
- atalhos globais:
  - `Ctrl+Shift+M` — mute;
  - `Ctrl+Shift+D` — deafen;
  - `Ctrl+Shift+Espaço` — mostrar/ocultar Discordy;
- Push-to-Talk global real no Windows com `V` pressionar/soltar;
- Push-to-Mute global real no Windows com `M` pressionar/soltar;
- `discordy://` registrado no sistema e entregue à instância única já aberta;
- iniciar com Windows opcional usando `--hidden` para abrir diretamente na bandeja;
- preferências Desktop persistidas em `userData/desktop-preferences.json`;
- nome, dispositivos de áudio/vídeo, tema, densidade, screen share e preferências de criação de sala persistidos localmente;
- tray atualiza os rótulos de mute/deafen conforme o estado do renderer.

### Atalhos globais

Os atalhos de ação usam `globalShortcut` no processo principal. No Windows, o estado pressionar/soltar de `V` e `M` usa `electron/global-key-monitor.ps1`, que consulta `GetAsyncKeyState` e envia somente transições ao processo principal.

```text
V down  → PTT_DOWN → renderer → abre gate do microfone
V up    → PTT_UP   → renderer → fecha gate do microfone

M down  → PTM_DOWN → renderer → fecha temporariamente
M up    → PTM_UP   → renderer → restaura estado anterior
```

O monitor ignora `V/M` quando Shift, Ctrl, Alt ou Win estão pressionados para não colidir com os atalhos compostos.

### Inicialização com Windows

A opção é aplicada somente no aplicativo empacotado. O login item executa:

```text
Discordy.exe --hidden
```

A janela é criada, mas permanece oculta na bandeja. Um deep link `discordy://` continua trazendo a janela para frente automaticamente.

### Preferências preservadas

```text
Processo principal
└── desktop-preferences.json
    ├── minimizeToTray
    ├── closeToTray
    ├── notifications
    ├── launchAtStartup
    └── globalShortcuts

Renderer / localStorage
├── nome
├── microfone
├── saída de áudio
├── câmera
├── tema/densidade
├── PTT/sensibilidade
├── screen share
└── defaults de criação de sala
```



Evolução da `0.6.0` adicionando chat de sessão diretamente entre os peers por `RTCDataChannel`. O signaling server continua sem transportar mensagens de chat.

## 0.7.0 — Chat P2P

Implementado:

- `RTCDataChannel` ordenado por par WebRTC;
- mensagens de texto diretamente peer-to-peer;
- links `http://` e `https://` clicáveis;
- abrir links no navegador padrão pelo processo principal do Electron;
- copiar mensagens individualmente;
- indicador remoto de quem está digitando;
- badge de mensagens não lidas quando o painel está fechado;
- envio sem passar pelo WebSocket/signaling server;
- histórico somente em memória durante a sessão atual da sala;
- histórico preservado durante reconexão temporária do signaling/WebRTC;
- histórico limpo ao sair, ser expulso ou encerrar a sessão;
- limite de `2000` caracteres por mensagem;
- validação de payload e limite de tamanho no `RTCDataChannel`;
- proteção simples contra IDs duplicados;
- controle de `bufferedAmount` para evitar envio quando o canal acumula mais de 1 MiB.

### Fluxo

```text
Client A ───── RTCDataChannel ───── Client B
   │                                  │
   ├── chat-message                   ├── render local
   └── typing                         └── typing indicator

Signaling Server
   └── NÃO recebe o conteúdo do chat
```

Cada `RTCPeerConnection` possui um canal lógico:

```text
label    = discordy-chat
protocol = discordy-chat-v1
ordered  = true
```

Em salas Mesh, uma mensagem é enviada diretamente a cada peer com DataChannel aberto:

```text
A ──► B
A ──► C
A ──► D
```

Não há armazenamento ou retransmissão de mensagens pelo servidor nesta versão.

### Histórico da sessão

O histórico existe apenas no estado React do cliente. Portanto:

```text
queda temporária / ICE restart
→ histórico permanece

sair da sala / kick / fechar sessão
→ histórico é descartado
```

Sincronização de histórico entre peers novos não faz parte da `0.7.0`.



Evolução da `0.5.1` com gerenciamento autoritativo da sala no signaling server, sem alterar a arquitetura Mesh P2P da mídia.

## 0.6.0 — Room Management

Implementado:

- nome configurável da sala;
- host identificado e validado pelo signaling server;
- limite configurável de `2`, `3` ou `4` participantes;
- bloquear/desbloquear novas entradas;
- expulsar participantes;
- convite com token separado do `roomId`;
- regeneração de convite com invalidação imediata do link anterior;
- invalidação manual do convite sem derrubar participantes conectados;
- PIN opcional de 4–12 dígitos;
- confirmação manual de entrada pelo host;
- lista de participantes independente da grade de mídia;
- presença `online`, `reconnecting` e `disconnected`;
- token de sessão para retomar a mesma identidade após queda do WebSocket;
- janela de recuperação antes de remover definitivamente um participante;
- autoridade de sala aplicada no servidor para `kick`, configuração, lock, aprovação e convite.

### Convites rotativos

O código da sala não muda quando o host gera um novo convite:

```text
roomId = ABC123
inviteToken = token-1
        ↓ regenerar
roomId = ABC123
inviteToken = token-2
```

O `token-1` deixa de aceitar novas entradas. Participantes já conectados ou em reconexão usam sua `sessionToken` e não são expulsos.

### Presença e reconexão

```text
online
  ↓ transporte WebSocket cai
reconnecting
  ↓ 8s sem retomar
disconnected
  ↓ janela total de ~38s expira
peer-left
```

Se o cliente voltar dentro da janela, envia a `resumeToken`, mantém o mesmo `peerId` e volta para `online`.

### Aprovação de entrada

Quando habilitada:

```text
Convidado → join-pending
Host      → join-request
             ├─ Aceitar → welcome
             └─ Recusar → join-denied
```

Solicitações expiram automaticamente após 30 segundos.

### PIN

O PIN não é colocado no convite. O convidado o informa no aplicativo. O signaling mantém apenas o hash SHA-256 em memória durante a vida da sala.

## 0.5.1 — Layout Stabilization

Correções de layout para impedir que screen share e tiles de participantes aumentem a altura da aplicação além da janela:

- shell limitado a `100dvh`;
- `min-height: 0` aplicado nos itens Grid/Flex críticos;
- Stage de screen share limitado à área útil;
- faixa de participantes com altura limitada;
- overflow mantido dentro dos painéis;
- comportamento específico para janelas com pouca altura;
- dock de chamada permanece visível.


## Base herdada — TURN / Connectivity

Implementado:

- configuração STUN/TURN em runtime pelo painel **Diagnóstico WebRTC → STUN / TURN**;
- defaults externos por `.env`;
- modos `auto`, `p2p-only` e `turn-only`;
- suporte a Coturn com `turn:` e `turns:`;
- fallback automático `STUN/P2P → TURN` após falha ICE no modo `auto`;
- aplicação dinâmica via `RTCPeerConnection.setConfiguration()` + `restartIce()`;
- teste isolado do TURN forçando `iceTransportPolicy = relay`;
- diagnóstico de rota com três estados: **P2P direto**, **P2P via NAT** e **TURN Relay**;
- relatório técnico inclui configuração ICE ativa;
- exemplo de `turnserver.conf` em `infrastructure/coturn/`;
- credenciais TURN estáticas nesta versão; credenciais temporárias permanecem planejadas para evolução futura.

### Estratégia de fallback

```text
auto
  │
  ├─ cria peer com STUN / iceTransportPolicy=all
  │
  ├─ P2P funciona → permanece P2P
  │
  └─ ICE falha
       │
       ├─ injeta STUN + TURN com setConfiguration()
       └─ restartIce()
            │
            └─ candidate relay pode ser selecionado
```

`p2p-only` nunca ativa TURN. `turn-only` inicia diretamente com `iceTransportPolicy=relay`.

### Coturn

O cliente aceita múltiplas URLs, por exemplo:

```text
turn:turn.example.com:3478?transport=udp
turn:turn.example.com:3478?transport=tcp
turns:turn.example.com:5349?transport=tcp
```

Veja `infrastructure/coturn/README.md` e `turnserver.conf.example`.

### Configuração externa

`.env`:

```text
VITE_ICE_MODE=auto
VITE_STUN_URLS=stun:stun.l.google.com:19302
VITE_TURN_URLS=turn:turn.example.com:3478?transport=udp
VITE_TURN_USERNAME=discordy
VITE_TURN_CREDENTIAL=senha
```

A configuração salva pela UI sobrescreve esses defaults em runtime.

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

- limite configurável entre 2 e 4 participantes;
- Mesh P2P: cada transmissor envia sua tela separadamente para cada peer;
- um screen share ativo por participante;
- áudio loopback do Electron é suportado diretamente no Windows; outros sistemas podem ter limitações próprias;
- TURN é opcional; sem servidor configurado, o modo `auto` opera somente com STUN/P2P;
- Quick Tunnel continua temporário para signaling público.
