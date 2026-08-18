# Discordy 0.10.1 — Media Stall Recovery

Correção focada em compartilhamento de tela que permanece em um frame estático mesmo com WebRTC/ICE em estado `connected`.

## Implementado

- remoção explícita de tracks remotas antigas ao parar/reabrir screen share;
- watchdog baseado em `requestVideoFrameCallback()` no tile de transmissão;
- rebind automático do `HTMLVideoElement` quando a apresentação de frames trava;
- pedido P2P de recuperação pelo `RTCDataChannel` quando o vídeo remoto não volta;
- reciclagem do `RTCRtpSender` de screen share via `replaceTrack(null)` → `replaceTrack(track)`;
- fallback para recriação do sender quando `replaceTrack()` falha;
- recuperação escalonada: sender → ICE restart → recriação somente da `RTCPeerConnection` afetada;
- reset automático do contador de recuperação quando os frames retornam;
- logs `[SCREEN WATCHDOG]` e `[RTC ...]` para diagnóstico;
- badge `RECUPERANDO` durante stall detectado.

## Escalonamento

1. Rebind local do `<video>`.
2. Refresh do screen sender no peer transmissor via DataChannel.
3. ICE restart se o stall persistir ou DataChannel não estiver disponível.
4. Recriação isolada da conexão daquele peer após stalls repetidos.

A sala e as demais conexões não são reiniciadas.
