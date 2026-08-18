# Discordy Desktop 0.2.1 — UI Foundation

Protótipo desktop Electron baseado no WebRTC P2P já validado entre redes diferentes.


## UI Foundation 0.2.1

Esta versão estabelece o shell visual base do Discordy antes da estabilização WebRTC:

- rail lateral de salas;
- sidebar da sala e canal de voz `Geral`;
- painel de voz conectada;
- painel do usuário atual;
- área central de mídia em grid;
- dock de controles de chamada;
- sidebar de participantes;
- convite integrado ao layout;
- painel técnico em drawer;
- temas `Dark` e `Onyx`;
- densidade `Confortável` e `Compacto`;
- layout responsivo para janelas menores.

A lógica WebRTC/signaling da 0.2.0 foi preservada; a estabilização de negociação, reconexão e screen share remoto fica para a próxima etapa.

## Objetivo desta versão

Uso normal sem terminal:

- **Criar sala:** o Electron inicia o signaling local, detecta `cloudflared`, abre um Quick Tunnel e gera um convite.
- **Entrar na sala:** basta instalar o Discordy e colar/clicar no convite. O convidado não precisa de `cloudflared`.
- **Mídia:** áudio e compartilhamento de tela continuam WebRTC P2P; Cloudflare transporta apenas HTTP/WebSocket de signaling.

## Requisitos para desenvolvimento

- Node.js >= 22.12
- npm
- Windows recomendado para o primeiro teste
- `cloudflared` instalado somente na máquina que for hospedar a sala

## Desenvolvimento

```powershell
npm install
npm run dev
```

## Executar como Electron sem servidor Vite

```powershell
npm install
npm start
```

## Gerar instalador/portable do Windows

```powershell
npm install
npm run dist:win
```

Os instaladores/portables são gerados em `release/`.

## Fluxo do host

1. Abra o Discordy.
2. Informe seu nome.
3. Clique em **Criar uma sala**.
4. O aplicativo verifica se `cloudflared` existe.
5. Clique em **Criar sala**.
6. O app inicia signaling local em uma porta livre.
7. O app executa automaticamente `cloudflared tunnel --url http://127.0.0.1:<porta>`.
8. A URL `*.trycloudflare.com` é capturada automaticamente.
9. O app gera um convite HTTPS normal `https://...trycloudflare.com/join?room=ABC123`.
10. Clique em **Copiar convite** e envie ao amigo.

## Fluxo do convidado

1. Abra o Discordy.
2. Informe seu nome.
3. Clique em **Entrar em uma sala**.
4. Cole o convite.
5. Clique em **Entrar na sala**.

Não é necessário Node.js nem `cloudflared` para quem apenas entra usando um aplicativo já empacotado.

## Deep link

O convite compartilhado é uma URL HTTPS normal. Ao abrir no navegador, uma página mínima do próprio host oferece **Abrir no Discordy**, usando internamente o protocolo:

```text
discordy://join?server=https%3A%2F%2Fexample.trycloudflare.com&room=ABC123&v=1
```

O mesmo convite HTTPS pode ser colado diretamente no aplicativo.

## Segurança Electron

- `contextIsolation: true`
- `nodeIntegration: false`
- renderer sandboxed
- operações privilegiadas apenas via `preload` + IPC
- janela não navega para conteúdo remoto
- URLs HTTPS externas são abertas no navegador padrão

## Limitações atuais

- Quick Tunnel é apropriado para teste/desenvolvimento, não possui garantia de uptime.
- Sem TURN: algumas combinações de NAT/firewall podem impedir o WebRTC P2P.
- Máximo de 4 participantes.
- Sem autenticação/contas/banco de dados.
- O protocolo `discordy://` funciona corretamente depois do app ser instalado/registrado no sistema; durante desenvolvimento, pode variar por plataforma.
