# Coturn — Discordy 0.5.0

O Discordy aceita servidores Coturn através das URLs `turn:` e `turns:` configuradas no painel **Diagnóstico WebRTC → STUN / TURN** ou pelos defaults `.env`.

## Portas usuais

- `3478/UDP` e `3478/TCP`: TURN/STUN.
- `5349/TCP`: TURN sobre TLS (`turns:`).
- faixa relay configurada no `turnserver.conf` (no exemplo, `49160-49200/UDP`).

## Cliente Discordy

Exemplo:

```text
STUN:
stun:turn.example.com:3478

TURN:
turn:turn.example.com:3478?transport=udp
turn:turn.example.com:3478?transport=tcp
turns:turn.example.com:5349?transport=tcp
```

No modo `auto`, novas conexões começam com STUN/P2P. Se ICE falhar, o `PeerManager` aplica STUN + TURN e chama `restartIce()`.

No modo `turn-only`, `iceTransportPolicy` é `relay`; isso é útil para validar o Coturn e para redes onde P2P deve ser desabilitado.

## Credenciais

A 0.5.0 aceita credenciais TURN estáticas. O suporte a credenciais temporárias baseadas em secret/TURN REST API fica reservado para evolução futura, conforme o roadmap.
