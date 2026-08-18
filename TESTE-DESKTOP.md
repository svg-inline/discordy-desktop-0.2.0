# Teste remoto — Discordy Desktop 0.4.0

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

## Voice & Media — 0.3.0

### 1. Mute e Deafen

1. Conecte dois PCs.
2. Fale no PC A e confirme áudio no PC B.
3. Clique em **Mute** no PC A e confirme que B deixa de receber voz.
4. Reative o microfone.
5. Clique em **Deafen** no PC A.
6. Confirme que A deixa de ouvir B e que o envio do microfone de A também fica fechado enquanto o deafen estiver ativo.
7. Desative o deafen e confirme restauração do estado anterior do microfone.

### 2. Seleção de microfone

1. Abra **Voz e vídeo**.
2. Escolha outro microfone.
3. Confirme que a chamada não desconecta.
4. Confirme nos logs a troca de microfone.
5. Fale e valide áudio remoto.

### 3. Seleção de saída

1. Com dois dispositivos de saída disponíveis, abra **Voz e vídeo**.
2. Escolha a saída alternativa.
3. Confirme que o áudio remoto passa para o dispositivo selecionado.
4. Retorne para **Padrão do sistema**.

### 4. Câmera

1. Clique em **Vídeo**.
2. Confirme preview local e vídeo remoto.
3. Abra **Voz e vídeo** e troque de câmera com a câmera ativa.
4. Confirme que não há queda da `RTCPeerConnection`.
5. Ligue a câmera e o compartilhamento de tela simultaneamente.
6. Confirme que o receptor mostra câmera no tile do participante e a tela separadamente no Screen Share Stage.
7. Pare a tela e confirme que a câmera permanece ativa.

### 5. Indicador de fala

1. Fale normalmente em A.
2. Confirme highlight verde no tile/avatar de A localmente.
3. Confirme highlight **Falando** para A no PC B.
4. Pare de falar e confirme remoção do indicador após o pequeno hangover.

### 6. Sensibilidade automática

1. Selecione **Atividade de voz** + **Automática**.
2. Observe o meter de entrada.
3. Fique alguns segundos em silêncio para o noise-floor se ajustar.
4. Fale e confirme abertura da transmissão.
5. Gere ruído ambiente constante e verifique adaptação gradual do threshold.

### 7. Sensibilidade manual

1. Mude para **Manual**.
2. Ajuste o threshold para um valor mais alto, por exemplo `-35 dB`.
3. Fale baixo e confirme que a transmissão pode permanecer fechada.
4. Reduza para aproximadamente `-55 dB`.
5. Confirme abertura com voz mais baixa.

### 8. Push-to-Talk

1. Selecione **Push-to-Talk**.
2. Sem pressionar nenhuma tecla, fale e confirme que o remoto não recebe áudio.
3. Segure `V` e fale.
4. Confirme transmissão e indicador de fala.
5. Solte `V` e confirme fechamento imediato do envio.

### 9. Push-to-Mute

1. Ative **Push-to-Mute**.
2. Em Atividade de voz ou Push-to-Talk, inicie uma transmissão válida.
3. Segure `M`.
4. Confirme corte temporário do microfone e estado remoto de microfone silenciado.
5. Solte `M` e confirme restauração.
6. Tire o foco da janela enquanto segura a tecla e confirme que o estado não fica preso.

### 10. Volume individual

1. Com três participantes, altere o slider de um peer para `0%`.
2. Confirme que apenas esse peer fica inaudível.
3. Mantenha outro peer em `100%` e confirme que continua audível.
4. Retorne o primeiro para `100%`.

### 11. Regressão WebRTC

Após os testes de Voice & Media, repetir:

- compartilhamento de tela;
- Perfect Negotiation;
- reconexão WebSocket;
- ICE restart;
- Network Diagnostics;
- copiar relatório técnico.

# Screen Share avançado — 0.4.0

## 12. Seletor de monitor e janela

1. Conecte dois PCs.
2. Clique em **Compartilhar tela**.
3. Confirme que o Discordy lista monitores e janelas com preview.
4. Escolha uma janela específica.
5. Confirme no receptor que apenas essa janela aparece.
6. Pare a transmissão.
7. Compartilhe novamente escolhendo um monitor inteiro.
8. Confirme que a origem exibida no overlay muda para `Monitor`.

## 13. Áudio do sistema opcional

No Windows:

1. Abra o seletor de tela.
2. Ative **Compartilhar áudio do sistema**.
3. Compartilhe um monitor/janela e reproduza áudio no PC transmissor.
4. Confirme áudio no receptor.
5. Pare a tela.
6. Desative **Compartilhar áudio do sistema**.
7. Compartilhe novamente e confirme que a tela continua chegando, mas sem a track de áudio do sistema.

## 14. Presets de qualidade

Repetir a transmissão com:

```text
720p30
1080p30
1080p60
```

Validar:

- overlay mostra o preset selecionado;
- resolução efetiva aparece no overlay;
- FPS real aparece e atualiza durante a transmissão;
- em `1080p60`, uma máquina/fonte capaz deve se aproximar de 60 FPS, sem exigir que a rede consiga sustentar esse valor em todas as situações.

## 15. Bitrate

1. Inicie uma transmissão.
2. Abra **Voz, vídeo e tela**.
3. Alterne o bitrate entre valores baixos e altos.
4. Confirme nos logs:

```text
screenVideo encoding: maxBitrate=...Kbps
```

5. Abra Network Diagnostics no receptor e observe a mudança gradual do bitrate real recebido.

## 16. Expandir transmissão

1. Com pelo menos uma tela ativa, clique em **Expandir**.
2. Confirme que apenas a transmissão escolhida ocupa o Screen Share Stage.
3. Clique em **Reduzir** ou **Mostrar todas**.
4. Confirme retorno ao grid de transmissões.

## 17. Fullscreen

1. Passe o mouse sobre uma transmissão.
2. Clique em **Tela cheia**.
3. Confirme que a transmissão ocupa o fullscreen.
4. Saia com `Esc`.

## 18. Picture-in-Picture

1. Passe o mouse sobre a transmissão.
2. Clique em **PiP**.
3. Confirme abertura da janela Picture-in-Picture do Chromium.
4. Continue usando o Discordy e confirme que a transmissão permanece visível no PiP.

## 19. Câmera + tela simultâneas

1. Ative a câmera de A.
2. Inicie o compartilhamento de tela de A.
3. No receptor, confirme:
   - câmera de A continua no tile do participante;
   - tela de A aparece separadamente no Screen Share Stage;
   - áudio de A não duplica.
4. Pare a tela e confirme que a câmera continua ativa.

## 20. Múltiplas transmissões simultâneas

Com 3 ou 4 participantes:

1. A inicia compartilhamento.
2. B inicia compartilhamento sem A parar.
3. C inicia compartilhamento, se disponível.
4. Todos os clientes devem mostrar um tile independente para cada transmissão.
5. Expanda a transmissão de B e depois volte para **Mostrar todas**.
6. Pare somente a transmissão de A e confirme que B/C continuam ativos.

## 21. Regressão final

Após os testes da 0.4.0, repetir:

- câmera;
- mute/deafen;
- Push-to-Talk/Push-to-Mute;
- compartilhamento iniciar/parar/reiniciar;
- Perfect Negotiation com dois peers iniciando mídia quase simultaneamente;
- reconexão WebSocket;
- ICE restart;
- Network Diagnostics;
- copiar relatório técnico.
