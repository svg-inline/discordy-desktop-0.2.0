# Discordy 0.11.0 — GitHub Releases e Auto-Update

## Requisito de distribuição

O auto-update desta versão usa GitHub Releases como provider do `electron-updater`.

Para distribuir o Discordy para terceiros sem colocar credenciais dentro do aplicativo, use um repositório GitHub **público**. Se o repositório for privado, troque o provider por uma infraestrutura de update autenticada antes de distribuir.

## Builds Windows

O projeto gera dois artefatos distintos:

```text
Discordy-Setup-0.11.0-x64.exe       → NSIS, suporta auto-update
Discordy-Portable-0.11.0-x64.exe    → Portable, update manual
```

O instalador NSIS também gera os metadados usados pelo updater:

```text
Discordy-Setup-0.11.0-x64.exe.blockmap
latest.yml
```

O `latest.yml`, o `.blockmap` e o `Setup.exe` devem sempre vir da mesma execução de release.

## Primeira instalação

Para receber atualizações automáticas, instale o Discordy usando:

```text
Discordy-Setup-<versão>-x64.exe
```

A edição Portable continua disponível, mas não executa instalação automática. Nela, o Discordy mostra que a atualização é manual.

## Publicar uma versão

Exemplo para publicar `0.11.1`:

```powershell
npm install
npm version 0.11.1 --no-git-tag-version
npm run typecheck
npm run test:security

git add .
git commit -m "release: 0.11.1"
git tag v0.11.1
git push origin main
git push origin v0.11.1
```

A tag precisa ser exatamente a versão do `package.json` com prefixo `v`:

```text
package.json: 0.11.1
Git tag:       v0.11.1
```

`scripts/validate-release.mjs` bloqueia a publicação se esses valores divergirem.

## GitHub Actions

O workflow está em:

```text
.github/workflows/release.yml
```

Ao receber uma tag `v*`, ele executa:

```text
checkout
  ↓
Node.js 22.12
  ↓
npm install
  ↓
validação tag ↔ package.json
  ↓
typecheck
  ↓
testes de segurança
  ↓
Vite build
  ↓
electron-builder
  ↓
GitHub Release
```

A Release recebe:

```text
Discordy-Setup-<version>-x64.exe
Discordy-Setup-<version>-x64.exe.blockmap
Discordy-Portable-<version>-x64.exe
latest.yml
```

`GITHUB_TOKEN` é fornecido pelo próprio GitHub Actions. O workflow usa `contents: write` somente para publicar a Release e seus assets.

## Fluxo dentro do Discordy

No build NSIS instalado:

```text
Discordy inicia
  ↓
aguarda 4,5 s
  ↓
consulta GitHub Releases
  ↓
nova versão?
  ├── não → "Discordy está atualizado"
  └── sim → banner "Discordy X disponível"
               ↓
             Baixar
               ↓
         progresso do download
               ↓
       "Reiniciar e atualizar"
               ↓
          quitAndInstall()
```

Também existe verificação manual na tela inicial e em Configurações → Atualizações.

## Segurança do updater

O renderer não acessa `electron-updater` diretamente.

```text
React Renderer
    ↓
preload.cjs
    ↓
IPC com assertTrustedIpc()
    ↓
Electron Main
    ↓
electron-updater
```

A superfície IPC exposta é apenas:

```text
updates:get-state
updates:check
updates:download
updates:install
updates:state
```

## Desenvolvimento e builds locais

Auto-update fica desativado quando:

```text
app.isPackaged = false
plataforma != Windows
edição Portable
app-update.yml ausente
```

Isso impede um build local sem provider de release de tentar consultar um endpoint incompleto.

## Build local sem publicar

```powershell
npm install
npm run dist:win
```

Esse comando gera Setup + Portable localmente, mas a publicação oficial deve ser feita pela tag GitHub.

## Build/publicação manual pelo terminal

Se necessário, fora do GitHub Actions:

```powershell
$env:DISCORDY_GITHUB_REPOSITORY="OWNER/REPO"
$env:GH_TOKEN="SEU_TOKEN"
npm run release:win
```

Não coloque `GH_TOKEN` no código, `.env`, instalador ou repositório.

## Assinatura de código

A automação de release não adiciona certificado de assinatura Windows. Para distribuição mais ampla, configure code signing no `electron-builder` antes de tratar o instalador como release de produção.
