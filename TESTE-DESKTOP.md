# Teste remoto — Discordy Desktop 0.10.0

## Adaptive Quality — 0.9.0

### 1. Estado inicial

1. Abra host e convidado.
2. Entre na mesma sala.
3. Abra **Diagnóstico WebRTC**.
4. Confirme **Qualidade adaptativa** habilitada.
5. Aguarde pelo menos 4 segundos.

Esperado por peer:

- nível de qualidade visível;
- RTT e packet loss atualizados;
- upload disponível quando fornecido pelo Chromium;
- FPS/escala TX exibidos;
- sem erros repetitivos em logs.

### 2. Screen share 1080p60

1. Inicie compartilhamento em `1080p60` com bitrate alto, por exemplo `8000 Kbps`.
2. Confirme em conexão boa:
   - `excellent` ou `good`;
   - FPS alvo próximo do preset;
   - escala `1.00x`.
3. Limite artificialmente a conexão do transmissor/receptor ou introduza perda/latência.
4. Aguarde algumas amostras.

Esperado:

```text
loss/RTT/upload pioram
        ↓
nível cai
        ↓
bitrate de vídeo diminui
FPS diminui
scaleResolutionDownBy aumenta
        ↓
áudio continua ativo
```

### 3. Packet loss

Introduza aproximadamente `3–8%` de packet loss.

Esperado:

- nível entra em `fair` ou `poor`;
- painel mostra o motivo baseado em packet loss;
- vídeo perde qualidade antes do áudio.

Com perda acima de aproximadamente `12%`, o nível pode chegar a `critical`.

### 4. RTT alto

Simule latência crescente:

```text
150+ ms → pode cair para good
250+ ms → fair
400+ ms → poor
700+ ms → critical
```

Validar que os thresholds são usados junto com loss/upload — o pior sinal prevalece.

### 5. Recuperação

1. Depois de degradar a conexão, remova a limitação.
2. Observe o painel por pelo menos 20 segundos.

Esperado:

- não volta imediatamente para `excellent`;
- exige múltiplas amostras estáveis;
- recupera um nível por vez;
- não fica alternando rapidamente entre níveis.

### 6. Qualidade independente por peer

Com 3 ou 4 participantes:

1. deixe um peer em rede boa;
2. limite apenas outro peer;
3. compartilhe tela/câmera.

Esperado:

- cada `RTCPeerConnection` possui nível próprio;
- peer ruim recebe sender com bitrate/FPS/resolução menores;
- peer bom mantém qualidade superior.

### 7. Prioridade do áudio

Durante uma condição `poor` ou `critical`:

- confirme microfone audível;
- confirme que câmera/tela degradam;
- logs devem registrar `microphone prioridade=high`;
- sender de vídeo deve registrar parâmetros reduzidos.

### 8. Desativar Adaptive Quality

1. Desative **Qualidade adaptativa** no diagnóstico.
2. Confirme que os senders voltam ao perfil máximo configurado.
3. Reative a opção.
4. Confirme retomada da coleta e adaptação automática.
5. Reinicie o aplicativo e valide persistência da preferência.

---

# Histórico de testes — Discordy Desktop 0.10.0

## Desktop Experience — 0.8.0

### 1. Tray e ciclo da janela

1. Abra o Discordy.
2. Minimize a janela.
3. Com **Minimizar para bandeja** habilitado, a janela deve desaparecer da barra de tarefas e a chamada deve continuar.
4. Clique no ícone do Discordy na bandeja: a janela deve voltar.
5. Feche pelo `X`.
6. Com **Fechar para bandeja** habilitado, o processo deve continuar ativo.
7. Use **Encerrar Discordy** no menu da bandeja para finalizar de verdade.

### 2. Notificações nativas

1. Habilite **Notificações nativas**.
2. Deixe o Discordy oculto/minimizado.
3. Em outro cliente, envie uma mensagem P2P.
4. A notificação deve mostrar remetente e trecho da mensagem.
5. Repita entrando com outro participante e, no host, com aprovação manual ativada.
6. Clique na notificação: a janela deve ser restaurada e focada.

### 3. Atalhos globais

Com Discordy minimizado:

```text
Ctrl+Shift+M       alterna mute
Ctrl+Shift+D       alterna deafen
Ctrl+Shift+Espaço  mostra/oculta a janela
```

Confirme visualmente no tray e, ao reabrir, nos controles da chamada.

### 4. Push-to-Talk global

1. Selecione **Push-to-Talk**.
2. Minimize o Discordy.
3. Mantenha `V` pressionado em outro aplicativo.
4. O áudio deve ser transmitido apenas enquanto `V` estiver pressionado.
5. Solte `V`: a transmissão deve fechar imediatamente.
6. Com Push-to-Mute habilitado, faça o mesmo com `M` e confirme o comportamento inverso.

### 5. Deep link

Com Discordy fechado e depois com Discordy já aberto, teste um convite `discordy://join/...`.

Esperado:

- inicia/restaura a mesma instância;
- traz a janela para frente;
- preenche o convite e inicia o fluxo de entrada quando o nome estiver disponível.

### 6. Iniciar com Windows

No build empacotado/instalado:

1. Habilite **Iniciar com o Windows**.
2. Reinicie a sessão do Windows ou valide em **Aplicativos de Inicialização**.
3. O Discordy deve iniciar com `--hidden`, disponível apenas na bandeja.
4. Desabilite a opção e confirme a remoção do login item.

### 7. Persistência

1. Selecione microfone, saída e câmera diferentes.
2. Troque tema/densidade e configurações de voz/tela.
3. Altere nome e defaults de criação da sala.
4. Feche completamente pelo menu da bandeja.
5. Abra novamente.
6. As opções devem ser restauradas; PIN da sala não deve ser persistido.

---

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

# TURN / Connectivity — 0.5.1

## 22. Configuração STUN/TURN

1. Abra **Diagnóstico WebRTC**.
2. No bloco **STUN / TURN**, confirme os modos:
   - `Automático — P2P → TURN`;
   - `Somente P2P / STUN`;
   - `Somente TURN / relay`.
3. Informe uma URL STUN válida e salve.
4. Confirme nos logs:

```text
[ICE] configuração aplicada
```

5. Reabra o aplicativo e confirme que a configuração salva permanece.

## 23. Coturn / teste de TURN

Com um Coturn funcional:

1. Configure `turn:` ou `turns:`.
2. Informe usuário e credencial quando exigidos.
3. Clique em **Testar TURN**.
4. O resultado deve ser **TURN operacional**.
5. Confirme que o teste informa candidato `relay` e protocolo.
6. Altere a senha para uma inválida e repita.
7. O teste deve falhar sem derrubar a sala atual.

## 24. P2P direto

Preferencialmente em dois dispositivos na mesma rede/LAN:

1. Selecione `p2p-only`.
2. Conecte os dois clientes.
3. Abra o diagnóstico.
4. Quando o candidate pair selecionado for `host ↔ host`, o badge deve mostrar:

```text
P2P direto
```

## 25. P2P via NAT

Em dispositivos/redes onde ICE usar `srflx` ou `prflx`:

1. Use `auto` ou `p2p-only`.
2. Conecte os peers.
3. Confirme no diagnóstico:

```text
P2P via NAT
```

4. Confirme os candidate types exibidos.

## 26. TURN obrigatório

1. Configure Coturn válido.
2. Selecione `turn-only`.
3. Clique em **Salvar e aplicar**.
4. Reconecte/aguarde ICE restart.
5. O diagnóstico deve mostrar:

```text
TURN Relay
```

6. O candidate pair selecionado deve incluir `relay`.

## 27. Fallback automático

Este teste deve ser feito em uma rede onde a rota P2P seja bloqueada/restrita, ou com regras de firewall de laboratório.

1. Configure `auto` com STUN + TURN válidos.
2. Inicie a conexão.
3. Deixe a tentativa P2P falhar.
4. Confirme nos logs:

```text
fallback TURN ativado
```

5. Depois da recuperação, o diagnóstico deve mostrar `TURN Relay`.
6. Áudio, câmera e screen share devem continuar funcionando após a troca de rota.

## 28. Regressão 0.5.1

Repetir:

- mute/deafen;
- câmera;
- seleção de dispositivos;
- Push-to-Talk/Push-to-Mute;
- screen share 720p30/1080p30/1080p60;
- múltiplas transmissões;
- fullscreen/PiP;
- Network Diagnostics;
- reconexão WebSocket;
- ICE restart;
- relatório técnico.


# Room Management — 0.6.0

## 29. Nome, host e limite

1. Crie uma sala com nome personalizado.
2. Escolha limite `2`, `3` e `4` em testes separados.
3. Confirme o nome no header, sidebar e convite web.
4. Confirme o badge `HOST` na lista de participantes.
5. Tente reduzir o limite para menos participantes do que já existem e confirme rejeição do servidor.

## 30. Bloquear/desbloquear entrada

1. Com o host conectado, abra **Gerenciar sala**.
2. Clique em **Bloquear**.
3. Tente entrar usando um convite ainda válido em outro PC.
4. Confirmar mensagem de sala bloqueada.
5. Clique em **Desbloquear** e repita a entrada.

## 31. Expulsar participante

1. Entre com um convidado.
2. No host, clique em **Expulsar** no participante.
3. O convidado deve receber a mensagem de remoção e voltar à tela inicial.
4. O participante deve desaparecer da lista e o `peer-left` deve remover a conexão WebRTC.

## 32. Regenerar e invalidar convite

1. Copie o convite A.
2. Clique em **Gerar novo convite** e copie o convite B.
3. Confirme que A não entra mais.
4. Confirme que B entra.
5. Clique em **Invalidar convite**.
6. Confirme que B também deixa de aceitar novas entradas.
7. Confirme que participantes já conectados permanecem na sala.

## 33. PIN opcional

1. Crie uma sala com PIN de 4–12 números.
2. Tente entrar sem PIN: deve receber `PIN_REQUIRED`.
3. Tente PIN incorreto: deve receber `INVALID_PIN`.
4. Informe o PIN correto e confirme entrada.
5. No host, remova o PIN em **Gerenciar sala** e confirme entrada posterior sem PIN.

## 34. Confirmação manual de entrada

1. Crie a sala com **Confirmar cada entrada manualmente**.
2. Convidado tenta entrar e deve ver **Aguardando aprovação**.
3. Host deve ver a solicitação na sidebar.
4. Clique em **Recusar** e confirme retorno do convidado com mensagem.
5. Repita e clique em **Aceitar**.
6. Confirme que o convidado entra sem precisar reconectar manualmente.
7. Deixe uma solicitação sem resposta por 30 segundos e confirme expiração.

## 35. Presença e resume token

1. Com dois PCs conectados, corte a rede do convidado.
2. No host, a presença deve mudar para `Reconectando`.
3. Após aproximadamente 8 segundos, deve mudar para `Desconectado`.
4. Reative a rede antes de aproximadamente 38 segundos.
5. O convidado deve retomar o mesmo `peerId` e voltar a `Online`.
6. Repita deixando a janela de recuperação expirar.
7. Confirme `peer-left` e remoção definitiva da lista.

## 36. Regressão geral

Após Room Management, repetir:

- áudio e câmera;
- screen share múltiplo;
- Network Diagnostics;
- fallback TURN;
- Perfect Negotiation;
- ICE restart;
- layout em janela pequena.

# Chat P2P — 0.7.0

## 37. RTCDataChannel

1. Conecte dois PCs na mesma sala.
2. Abra **Chat** nos dois clientes.
3. Aguarde o indicador mostrar `P2P conectado · 1/1`.
4. Confirme nos logs:

```text
RTCDataChannel de chat criado
RTCDataChannel chat aberto
```

5. Envie uma mensagem de A para B e outra de B para A.
6. Confirme que o signaling server não registra conteúdo de chat.

## 38. Mensagens e links

1. Envie texto simples.
2. Envie uma mensagem com múltiplas linhas usando `Shift+Enter`.
3. Envie:

```text
https://example.com
```

4. Confirme que o link fica clicável.
5. Clique no link e confirme abertura no navegador padrão, não em uma nova janela Electron.
6. Teste também um link `http://`.

## 39. Copiar mensagem

1. Passe o mouse sobre uma mensagem.
2. Clique em **Copiar**.
3. Cole em um editor de texto.
4. Confirme que apenas o conteúdo textual da mensagem foi copiado.

## 40. Indicador digitando

1. Abra o chat nos dois PCs.
2. Em A, comece a digitar sem enviar.
3. B deve mostrar `A está digitando...`.
4. Pare de digitar por aproximadamente 1,4 segundo.
5. O indicador deve desaparecer.
6. Feche/desconecte A enquanto digita e confirme que o indicador não fica preso em B.

## 41. Badge de não lidas

1. Feche o painel Chat em B.
2. Envie 3 mensagens por A.
3. Confirme badge `3` no botão Chat de B.
4. Abra o painel.
5. O badge deve zerar.

## 42. Histórico somente da sessão

1. Troque mensagens entre A e B.
2. Provoque uma reconexão temporária do signaling.
3. Confirme que o histórico local permanece.
4. Saia normalmente da sala.
5. Entre novamente.
6. Confirme que o histórico anterior não reaparece.

## 43. Três ou quatro participantes

1. Conecte pelo menos 3 clientes.
2. Aguarde o painel indicar todos os DataChannels disponíveis.
3. A envia uma mensagem.
4. Confirme recebimento direto em B e C.
5. Faça C responder e confirme recebimento em A e B.
6. Desconecte B e continue trocando mensagens entre A e C.

## 44. Regressão

Após validar o Chat P2P, repetir:

- áudio e mute/deafen;
- câmera;
- compartilhamento de tela;
- múltiplas transmissões;
- Room Management;
- reconexão WebSocket/WebRTC;
- ICE restart;
- TURN fallback;
- Network Diagnostics.


# Segurança — 0.10.0

## 45. Expiração do convite

1. Crie uma sala com expiração de `15 min`.
2. Confirme que a interface mostra a validade do convite.
3. Para teste rápido em desenvolvimento, reduza temporariamente o TTL no servidor.
4. Após expirar, tente usar o link antigo.
5. Confirme `INVITE_EXPIRED`/convite inválido e que participantes já conectados continuam na sala.

## 46. Regeneração e token antigo

1. Copie o convite A.
2. Regenerar o convite e copie B.
3. A deve ser rejeitado imediatamente.
4. B deve continuar válido até expirar ou ser invalidado.
5. Confirme que o `roomId` não mudou.

## 47. Host authorization

1. Entre como convidado.
2. Pelo DevTools em desenvolvimento ou cliente de teste, tente enviar `room-update`, `kick`, `join-decision`, `invite-regenerate` e `invite-invalidate`.
3. O servidor deve responder `HOST_ONLY`.
4. Confirme que nenhuma configuração da sala mudou.

## 48. Peer spoofing

1. Conecte três participantes A, B e C.
2. Faça A enviar signaling para B.
3. Confirme em B que `from` corresponde ao peerId real de A.
4. Tente incluir manualmente um campo `from` no pacote enviado por A.
5. A mensagem deve ser rejeitada pela validação rígida.
6. Tente sinalizar para peer inexistente ou de outra sala; deve receber `INVALID_SIGNAL_TARGET`.

## 49. Validação rígida

Teste mensagens com:

- tipo desconhecido;
- campo extra;
- `peerId` inválido;
- SDP acima do limite;
- ICE candidate malformado;
- metadata de screen share fora dos limites;
- PIN fora de `4–12` dígitos.

Todas devem ser rejeitadas sem alterar estado da sala.

## 50. Limite de payload

1. Envie um frame WebSocket maior que `96 KiB`.
2. A conexão deve ser recusada/fechada com limite de mensagem.
3. Confirme que o processo do signaling continua saudável.

## 51. Rate limiting

1. Em um cliente de teste, dispare mais de 8 `join` em 60 s no mesmo socket.
2. Confirme `RATE_LIMITED`.
3. Repita violações até o limite de abuso.
4. Confirme fechamento da conexão com código `4008`.
5. Teste também rajada de `signal` e ações administrativas.

## 52. Session token rotation

1. Entre normalmente e registre apenas para teste o token de sessão recebido.
2. Provoque perda do WebSocket e resume.
3. Confirme que um novo token de sessão foi entregue.
4. O token anterior não deve conseguir assumir novamente a sessão após a rotação.
5. O `peerId` permanece o mesmo durante o resume legítimo.

## 53. Deep link hardening

Tente abrir:

```text
discordy://join?server=http://example.com&room=ROOM&token=TOKEN&v=2
discordy://join?server=https://example.com&room=ROOM&token=curto&v=2
discordy://evil?server=https://example.com
discordy://join?server=https://user:pass@example.com&room=ROOM&token=TOKEN&v=2
```

Todos os casos inválidos devem ser ignorados/rejeitados. HTTP remoto não é permitido; HTTP só é aceito para loopback.

## 54. Electron CSP / navegação

1. No build empacotado, confirme que DevTools não abre.
2. Tente `window.open()` para uma URL externa.
3. Nenhuma nova BrowserWindow deve ser criada; links permitidos devem abrir no navegador padrão.
4. Tente navegar o renderer para outra origem e confirme bloqueio.
5. Confirme que `window.require`, `process` Node e `ipcRenderer` não estão disponíveis no renderer.

## 55. IPC/preload

1. Confirme que `window.discordy` contém somente métodos explicitamente expostos.
2. Tente chamar IPC a partir de outro WebContents/frame em teste de desenvolvimento.
3. O processo principal deve rejeitar a origem.
4. Teste payloads excessivos no clipboard/notificação e confirme truncamento/limite.

## 56. Regressão pós-hardening

Após os testes de segurança, repetir:

- criar/entrar/reconectar sala;
- Room Management;
- áudio, câmera e PTT;
- screen share e múltiplas transmissões;
- Chat P2P;
- TURN fallback;
- Adaptive Quality;
- tray e deep link legítimo `discordy://`.
