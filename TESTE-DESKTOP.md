# Teste remoto — Discordy Desktop 0.2.1

## Host

No PC do host, valide uma única vez:

```powershell
cloudflared --version
```

Depois, no uso normal do aplicativo, nenhum comando Cloudflare é necessário.

### Desenvolvimento

```powershell
npm install
npm run dev
```

No app:

1. Informe o nome.
2. Clique em **Criar uma sala**.
3. Clique em **Criar sala**.
4. Aguarde `Sala pública pronta`.
5. Copie o convite.

## Convidado

No app:

1. Informe o nome.
2. Clique em **Entrar em uma sala**.
3. Cole o convite.
4. Entre.

## O que observar

- Participante aparece na sala.
- Estado WebRTC passa para `connected`.
- Microfone funciona nos dois sentidos.
- Compartilhamento de tela aparece no outro PC.
- Fechar a sala do host derruba signaling/tunnel.

## Diagnóstico

Se o convidado não consegue entrar na sala, no host abra **Detalhes técnicos** e procure:

```text
[server] signaling em http://127.0.0.1:...
[cloudflared] ...trycloudflare.com
[join] ... entrou em ...
```

Se o usuário entra na sala mas o WebRTC não chega a `connected`, o problema tende a estar na conectividade ICE/NAT. A próxima evolução é TURN como fallback.


## UI Foundation

Durante o teste, valide também:

- rail lateral da sala;
- canal de voz `Geral`;
- grid central de participantes;
- dock inferior de controles;
- sidebar de participantes;
- painel de voz conectada;
- alternância Dark/Onyx antes de entrar;
- densidade Confortável/Compacto antes de entrar.
