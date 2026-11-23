# Visor DVR

Visualizador simples para o DVR Intelbras (MHDX 1208-C e outros com firmware Dahua).
Funciona em Windows, macOS e Linux, sem plugin e sem Internet Explorer.

## O que faz

- **Grade ao vivo** no stream principal. Para PCs fracos há "Ao vivo: leve" (substream 352×240).
  Duplo clique amplia uma câmera e `Esc` volta.
- **Voltar no tempo**: clique na linha do tempo, use −10m/−1m/−10s/+10s/+1m/+10m ou digite em "Ir"
  (`23/11/2026 10:05:00` ou só `10:05:00` no dia exibido). As câmeras da grade tocam juntas.
- **Velocidade 1×, 2×, 4×, 8×, 16×** nas gravações. Em 16× aparecem só os quadros-chave (~1 por segundo de gravação).
- **Movimento**: os trechos com movimento ficam em vermelho na linha do tempo. "⟸ mov." / "mov. ⟹"
  (ou `[` / `]`) pulam para o movimento anterior ou o próximo, começando 3 s antes.
- **Zoom digital**: roda do mouse sobre a câmera aproxima até 8×, arrastar move a imagem, e o botão "1×" volta.
- **Foto**: o botão 📷 de cada câmera salva o quadro atual em JPG 1920×1080 (ao vivo ou da gravação).
- **Prévia**: ao passar o mouse na linha do tempo aparece a miniatura daquele horário.
- **Recorte**: arraste na linha do tempo (ou preencha Início/Fim, ou use "⤓ atual"), marque as câmeras e escolha:
  - *arquivos separados*: um MP4 por câmera, *original* (H.265, rápido e sem perda) ou *compatível* (H.264);
  - *vídeo em grade*: um MP4 só (H.264, 1920×1080) com as câmeras lado a lado.
- **Câmeras da grade** (▦): escolha quais aparecem. Para mudar a ordem, arraste pelo nome da câmera.
- **HD**: mostra o tamanho do disco e quantos dias de gravação ele guarda. Com o HD cheio, o DVR apaga o mais antigo.
- O app **lembra** a janela, a qualidade, a velocidade, a ordem das câmeras, a pasta e o último recorte.

Atalhos: `espaço` pausa, `←`/`→` ±10 s, `Shift+←`/`→` ±1 min, `[`/`]` movimento anterior/próximo.
Na linha do tempo, a roda do mouse faz zoom e `Shift+roda` move para os lados.

## Marcação de movimento no DVR

O app só mostra movimentos que o DVR marca nas gravações. Para isso, a agenda de gravação de cada canal precisa ser
"contínua + movimento" (no DVR: Armazenamento → Agenda, marcar "Movimento" além de "Contínuo"; na API,
`Record[canal].TimeSection[dia][0]=3 00:00:00-23:59:59`). A gravação continua contínua. A diferença é que os trechos
com movimento ficam marcados, e só a partir do momento da mudança.

## Instalar

Pegue o instalador do seu sistema (ver "Gerar os instaladores"). Na primeira abertura, informe o IP, o usuário
e a senha do DVR (⚙). A senha fica cifrada no cofre do sistema (Keychain, DPAPI ou keyring).

- **Linux (Ubuntu)**: `.deb` (`sudo apt install ./visor-dvr_1.0.0_amd64.deb`), ou sem sudo, só para o seu usuário:
  `npx electron-builder --linux dir && bash scripts/install-linux-user.sh`. O script põe no menu, fixa na dock e
  liga a abertura ao entrar na sessão (`--uninstall` desfaz). O AppImage pode não abrir no Ubuntu 24.04 por causa da
  restrição do AppArmor ao sandbox do Chromium.
- **Windows**: `Visor DVR Setup 1.0.0.exe`. Sem certificado pago, o SmartScreen avisa: "Mais informações → Executar assim mesmo".
- **macOS**: `.dmg`. Sem assinatura da Apple, a primeira abertura é bloqueada: Ajustes do Sistema → Privacidade e
  Segurança → "Abrir mesmo assim".

## Desenvolvimento

```sh
npm install
npm start
```

Teste de ponta a ponta contra o DVR real (Linux, sem abrir janela), com capturas em `/tmp/visor-smoke`:

```sh
export DVR_HOST=192.168.0.10 DVR_USER=admin DVR_PASS='...'
xvfb-run -a npx electron --no-sandbox scripts/smoke.js
```

## Gerar os instaladores

- **Linux**, nesta máquina: `npm run dist:linux` → `dist/*.AppImage` e `dist/*.deb`.
- **Windows e macOS**: precisam ser gerados no próprio sistema. O jeito simples é subir esta pasta para um repositório
  no GitHub e rodar o workflow `.github/workflows/build.yml` (Actions → Build → Run workflow, ou publicar uma tag `v1.0.0`).
  Ele gera os instaladores dos três sistemas (Mac Intel e Apple Silicon) e deixa para baixar em "Artifacts".

## Como funciona

- **Electron**: a interface (`src/renderer`) roda isolada, sem acesso ao Node. Ela pede tudo ao processo principal (`src/main`) por IPC.
- **API HTTP do DVR** (Digest): canais, relógio, HD, busca de gravações e movimentos (`mediaFileFind.cgi`) e
  download de trechos (`loadfile.cgi`).
- **Vídeo**: o ffmpeg embutido (`ffmpeg-static`) entrega MPEG-TS H.264 num servidor local (só `127.0.0.1`, com token).
  Quem toca é o `mpegts.js`.
  - Ao vivo: RTSP do DVR, stream principal H.265 convertido para H.264 (ou o substream, no modo leve).
  - Gravação: o trecho é baixado por HTTP e o ffmpeg toca no ritmo certo com `-readrate`. Abre em 1 a 2 s (o RTSP de
    reprodução do DVR levava 4 a 8 s). Como o DVR entrega o download até ~15× mais rápido que tempo real por câmera,
    também dá para acelerar.
- O DVR grava em 960×1080 ("1080N"), que é exibido em 16:9. O app, as fotos e os recortes já corrigem a proporção.

## Limitações conhecidas

- A gravação começa no quadro-chave até 1 s antes do horário pedido.
- As câmeras podem ficar até ~2 s fora de sincronia entre si (cada uma tem a sua conexão).
- Em 16× com 4 câmeras, o download soma ~80 Mbit/s, perto do limite do DVR. Se travar, use 8× ou amplie uma câmera.
- Sem áudio: o áudio está desligado em todos os canais do DVR (`AudioEnable=false`).
- Fora de casa: o app funciona com qualquer endereço do DVR. Para acessar de fora, use uma VPN (ex.: Tailscale num
  aparelho da rede de casa). Não abra as portas do DVR no roteador.
- A senha vai na URL RTSP do ao vivo passada ao ffmpeg. Outros usuários do mesmo computador podem vê-la na lista de processos.
