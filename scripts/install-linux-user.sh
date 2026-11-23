#!/usr/bin/env bash
# Instala o Visor DVR só para o usuário atual (sem sudo), a partir de dist/linux-unpacked:
#   - app em ~/.local/opt/visor-dvr
#   - atalho no menu de aplicativos e ícone
#   - fixa na dock do Ubuntu (favoritos)
#   - abre ao entrar na sessão (~/.config/autostart)
# Uso: npm run dist:linux (ou: npx electron-builder --linux dir) e depois bash scripts/install-linux-user.sh
# Para desinstalar: bash scripts/install-linux-user.sh --uninstall
set -euo pipefail
cd "$(dirname "$0")/.."

APP_DIR="$HOME/.local/opt/visor-dvr"
DESKTOP="$HOME/.local/share/applications/visor-dvr.desktop"
AUTOSTART="$HOME/.config/autostart/visor-dvr.desktop"
ICON="$HOME/.local/share/icons/hicolor/512x512/apps/visor-dvr.png"

remove_favorite() {
  command -v gsettings >/dev/null || return 0
  local favs
  favs=$(gsettings get org.gnome.shell favorite-apps 2>/dev/null) || return 0
  gsettings set org.gnome.shell favorite-apps "$(python3 -c "import ast,sys; f=ast.literal_eval(sys.argv[1]); print([x for x in f if x != 'visor-dvr.desktop'])" "$favs")"
}

if [ "${1:-}" = "--uninstall" ]; then
  remove_favorite
  rm -f "$DESKTOP" "$AUTOSTART" "$ICON"
  [ -d "$APP_DIR" ] && rm -r "$APP_DIR"
  echo "Visor DVR removido. A configuração continua em ~/.config/Visor DVR (apague se quiser)."
  exit 0
fi

[ -x dist/linux-unpacked/visor-dvr ] || { echo "Falta dist/linux-unpacked. Rode: npx electron-builder --linux dir"; exit 1; }

# Copia para uma pasta nova e troca de uma vez (não deixa instalação pela metade).
mkdir -p "$(dirname "$APP_DIR")"
rm -rf "$APP_DIR.new"
cp -r dist/linux-unpacked "$APP_DIR.new"
if [ -d "$APP_DIR" ]; then mv "$APP_DIR" "$APP_DIR.old"; fi
mv "$APP_DIR.new" "$APP_DIR"
[ -d "$APP_DIR.old" ] && rm -r "$APP_DIR.old"

mkdir -p "$(dirname "$ICON")" "$(dirname "$DESKTOP")" "$(dirname "$AUTOSTART")"
cp build/icon.png "$ICON"

cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Visor DVR
Comment=Câmeras do DVR: ao vivo, gravações e recortes
Exec="$APP_DIR/visor-dvr" %U
Icon=visor-dvr
Terminal=false
Categories=Video;AudioVideo;
StartupWMClass=visor-dvr
StartupNotify=true
EOF

cat > "$AUTOSTART" <<EOF
[Desktop Entry]
Type=Application
Name=Visor DVR
Exec="$APP_DIR/visor-dvr"
Icon=visor-dvr
Terminal=false
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=10
EOF

command -v update-desktop-database >/dev/null && update-desktop-database "$(dirname "$DESKTOP")" 2>/dev/null || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true

# Fixa na dock (no fim da lista), se ainda não estiver.
if command -v gsettings >/dev/null; then
  favs=$(gsettings get org.gnome.shell favorite-apps)
  case "$favs" in
    *visor-dvr.desktop*) ;;
    *) gsettings set org.gnome.shell favorite-apps "$(python3 -c "import ast,sys; f=ast.literal_eval(sys.argv[1]); print(f+['visor-dvr.desktop'])" "$favs")" ;;
  esac
fi

echo "Instalado em $APP_DIR"
echo "Menu: $DESKTOP"
echo "Início automático: $AUTOSTART"
