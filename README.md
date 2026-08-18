# Discordy Desktop 0.2.2 — WebRTC Stabilization

Versão de estabilização da base WebRTC P2P sobre a UI Foundation 0.2.1.

## WebRTC Stabilization 0.2.2

Implementado:

- compartilhamento de tela remoto renegociado corretamente;
- tracks separadas para `microphone`, `camera`, `screenVideo` e `screenAudio`;
- `Perfect Negotiation` para tratar colisões de ofertas;
- negociação automática por `negotiationneeded`;
- fila de ICE candidates enquanto a descrição remota ainda não existe;
- `restartIce()` automático em `failed`;
- `restartIce()` após `disconnected` persistente;
- reconexão automática do WebSocket com backoff;
- reentrada automática na sala depois da reconexão do signaling;
- reconstrução das conexões WebRTC quando o signaling recebe uma nova sessão/peer ID;
- tratamento de `connected`, `disconnected`, `failed` e `closed`;
- heartbeat WebSocket no signaling server;
- estado de mídia sinalizado separadamente para microfone, câmera e tela;
- logs RTC/ICE/SDP/WebSocket disponíveis também para convidados;
- `RTCPeerConnection` isolado da UI em `src/rtc/PeerManager.ts`.

## Fluxo da mídia

```text
microphone  ─┐
camera      ─┼─> PeerManager ─> RTCPeerConnection
screenVideo ─┤
screenAudio ─┘
```

A câmera já possui slot independente na camada RTC, mas a captura/UI de câmera continua reservada para a etapa **Voice & Media**.

## Recuperação automática

### WebSocket

```text
WebSocket perdido
  -> reconnect 1s
  -> reconnect 2s
  -> reconnect 4s
  -> reconnect 8s
  -> máximo 10s entre tentativas
  -> join automático na sala
  -> recebe novo welcome
  -> reconstrói peers WebRTC
```

### WebRTC

```text
connected
   ↓
disconnected
   ↓ 3.5s sem recuperar
restartIce()

failed
   ↓
restartIce() imediato
   ↓
negotiationneeded
   ↓
Perfect Negotiation
```

## Requisitos para desenvolvimento

- Node.js >= 22.12
- npm
- Windows recomendado para o primeiro teste
- `cloudflared` instalado somente na máquina que hospeda a sala

## Desenvolvimento

```powershell
npm install
npm run dev
```

## Executar como Electron

```powershell
npm install
npm start
```

## Gerar instalador/portable do Windows

```powershell
npm install
npm run dist:win
```

Os artefatos são gerados em `release/`.

## Fluxo do host

1. Abra o Discordy.
2. Informe seu nome.
3. Clique em **Criar uma sala**.
4. O aplicativo verifica `cloudflared`.
5. Crie a sala.
6. Copie o convite e envie aos participantes.
7. Abra **Detalhes técnicos** para acompanhar signaling/RTC quando necessário.

## Fluxo do convidado

1. Abra o Discordy.
2. Informe seu nome.
3. Clique em **Entrar em uma sala**.
4. Cole o convite.
5. Entre na sala.

O convidado não precisa instalar `cloudflared`.

## Diagnóstico 0.2.2

Os logs agora identificam a camada:

```text
[HOST] ...
[WS] ...
[SERVER] ...
[RTC abc12345] ...
[MEDIA] ...
```

Eventos importantes incluem:

```text
negotiationneeded
SDP offer enviado
SDP answer remoto aplicado
ICE candidate enviado (host/srflx/relay)
connectionState=connected
connectionState=disconnected
ICE restart #1 solicitado
WebSocket reconectado
sessão de signaling renovada
```

## Limitações atuais

- Sem TURN: algumas combinações de NAT/firewall ainda podem impedir o P2P.
- Máximo de 4 participantes.
- Sem autenticação/contas/banco de dados.
- Câmera ainda sem captura/UI, embora a camada RTC já esteja preparada.
- Quick Tunnel continua sendo a solução temporária de signaling público.

## 0.2.3 — Network Diagnostics

A versão 0.2.3 adiciona diagnóstico WebRTC por peer sem alterar o transporte de mídia:

- `RTCPeerConnection.getStats()`;
- candidate pair ICE selecionado;
- tipos `host`, `srflx`, `prflx` e `relay` quando reportados pelo Chromium;
- classificação automática `P2P direto` ou `TURN Relay`;
- RTT;
- jitter;
- packet loss;
- bitrate de upload/download calculado por delta de bytes;
- codecs TX/RX;
- resolução e FPS do vídeo recebido;
- estados `connectionState`, `iceConnectionState`, `iceGatheringState` e `signalingState`;
- teste ativo de conexão com duas amostras;
- relatório técnico copiável incluindo métricas e logs recentes.

Abra o ícone de atividade ao lado dos logs na seção **Voz conectada**.
