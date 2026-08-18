# Discordy — Security Model 0.10.0

## Trust boundaries

O Discordy considera como fronteiras distintas:

1. renderer Electron;
2. preload/IPC;
3. processo principal;
4. signaling server;
5. peers WebRTC remotos;
6. links/deep links externos.

Nenhuma mensagem recebida de outra fronteira é tratada como confiável sem validação.

## Convites e sessões

- Tokens usam CSPRNG (`node:crypto` / Web Crypto).
- Invite tokens possuem 256 bits e expiram.
- O servidor guarda somente digest SHA-256 do invite token.
- Regenerar ou invalidar remove imediatamente a validade do token anterior.
- O bootstrap secret do host é de uso único.
- Session tokens são armazenados somente como digest no servidor e rotacionados após resume.
- O PIN da sala não é persistido no cliente.

## Signaling

- Payload máximo: 96 KiB.
- `perMessageDeflate` desativado.
- Mensagens passam por allow-list de tipos, campos e limites.
- Mensagens desconhecidas ou com campos extras são rejeitadas.
- `signal.from` é sempre atribuído pelo servidor.
- Um peer só pode sinalizar para outro peer online da mesma sala.
- Ações administrativas exigem sessão autenticada do host e correspondência com `room.hostPeerId`.

## Rate limits

| Escopo | Limite |
| --- | ---: |
| WebSocket geral | 300 / 10 s |
| WebRTC signaling | 240 / 10 s |
| Join por socket | 8 / min |
| Controles por socket | 40 / min |
| Upgrade WebSocket por identidade | 60 / min |
| `/join` por identidade | 120 / min |

Quatro violações de rate limit na mesma conexão resultam em fechamento do WebSocket.

## Electron

O `BrowserWindow` usa:

```text
contextIsolation = true
nodeIntegration = false
sandbox = true
webSecurity = true
webviewTag = false
allowRunningInsecureContent = false
```

Além disso:

- DevTools são desabilitadas no aplicativo empacotado;
- navegação fora do documento confiável é bloqueada;
- `window.open` não cria nova BrowserWindow;
- `webview` é bloqueado;
- links externos passam por allow-list `http:`/`https:`;
- todo IPC verifica sender, frame e URL do renderer;
- preload não expõe `ipcRenderer`.

## CSP

O renderer usa CSP restritiva, sem `unsafe-eval` e sem scripts externos. `style-src-attr 'unsafe-inline'` permanece exclusivamente porque a UI atual usa estilos React inline dinâmicos para medidores visuais.

## Limitações conhecidas

Esta release não substitui assinatura de código, atualização assinada, armazenamento em Keychain/Credential Manager, autenticação por conta ou credenciais TURN temporárias. Esses itens exigem infraestrutura própria e devem ser tratados em releases posteriores.
