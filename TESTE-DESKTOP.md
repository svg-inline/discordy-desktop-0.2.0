# Teste remoto — Discordy Desktop 0.2.2

## 1. Conexão inicial

Host:

1. Abra o Discordy.
2. Crie uma sala.
3. Copie o convite.

Convidado:

1. Abra o Discordy em outra rede.
2. Entre pelo convite.

Validar:

- ambos aparecem na sala;
- `connectionState` chega a `connected`;
- áudio funciona nos dois sentidos.

## 2. Compartilhamento de tela remoto

1. Host inicia **Compartilhar tela**.
2. Convidado deve visualizar a tela sem precisar sair/reentrar.
3. Pare o compartilhamento.
4. Inicie novamente.
5. Repita com o convidado compartilhando para o host.

Nos logs, procurar:

```text
[MEDIA] screen video=...
[RTC ...] screenVideo adicionado
[RTC ...] negotiationneeded
[RTC ...] SDP offer enviado
[RTC ...] SDP answer remoto aplicado
[RTC ...] estado remoto screen: ativo
```

Ao parar:

```text
[RTC ...] screenVideo removido
[RTC ...] estado remoto screen: inativo
```

## 3. Colisão de renegociação

Com dois participantes conectados:

1. Ambos iniciam compartilhamento quase ao mesmo tempo.
2. A conexão não deve travar em `have-local-offer`.
3. Logs podem mostrar `offer em colisão ignorado` somente no peer impolite.
4. O peer polite deve aplicar a oferta remota e responder normalmente.

## 4. Reconexão WebSocket

No convidado:

1. Desative a rede por alguns segundos ou interrompa temporariamente o acesso ao tunnel.
2. Reative a rede.
3. O Discordy deve tentar reconectar automaticamente.
4. Após `welcome`, os peers WebRTC devem ser reconstruídos.

Logs esperados:

```text
[WS] WebSocket fechado ...
[WS] nova tentativa de signaling ...
[WS] WebSocket reconectado
[WS] join enviado ...
[RTC] sessão de signaling renovada ...
```

## 5. ICE restart

Para provocar instabilidade de rede sem fechar o aplicativo:

1. Troque rapidamente de rede/interface quando possível.
2. Observe `disconnected`/`failed`.
3. O app deve solicitar `ICE restart` automaticamente.

Logs esperados:

```text
connectionState=disconnected
ICE restart #1 solicitado
negotiationneeded
```

ou:

```text
iceConnectionState=failed
ICE restart #1 solicitado
```

## 6. Logs técnicos

**Detalhes técnicos** deve estar disponível tanto para host quanto para convidado.

Verificar registros de:

- HOST;
- WS;
- SERVER;
- RTC;
- MEDIA.

## Network Diagnostics — 0.2.3

1. Abra uma sala com dois PCs.
2. Aguarde o WebRTC ficar conectado.
3. No painel **Voz conectada**, clique no ícone de atividade/rede.
4. Confirme que aparece um card para cada peer remoto.
5. Verifique `ICE selecionado`, por exemplo `host ↔ srflx`, e a classificação `P2P direto` ou `TURN Relay`.
6. Clique em **Testar conexão** e aguarde a segunda amostra.
7. Verifique RTT, jitter, packet loss e bitrate de upload/download.
8. Inicie compartilhamento de tela e confira codec RX, resolução e FPS no receptor.
9. Clique em **Copiar relatório** e cole em um editor de texto para validar o relatório completo.
10. Desconecte/reconecte a rede e confirme que os estados ICE/Connection refletem a recuperação implementada na 0.2.2.
