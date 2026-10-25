#!/usr/bin/env bash
# Установка SmartMirror на Raspberry Pi 4 (Raspberry Pi OS Bookworm или новее, с рабочим столом).
#
#   git clone https://github.com/danbukin/smartmirror.git ~/smartmirror
#   ~/smartmirror/pi/install.sh
#   sudo reboot
#
# Что делает:
#   • ставит Node.js 22, Chromium и MagicMirror² (../MagicMirror);
#   • запускает Studio как службу systemd (smartmirror.service): она управляет Wi‑Fi через
#     NetworkManager, раздаёт свою сеть SmartMirror-XXXX, если знакомой нет, и запускает MagicMirror²;
#   • открывает экран зеркала (http://localhost:8090/screen) на весь экран при входе в рабочий стол;
#   • включает автовход, отключает гашение экрана, задаёт страну Wi‑Fi.
#
# Переменные: WIFI_COUNTRY (RU), MM_DIR (../MagicMirror), MIRROR_HOSTNAME (smartmirror).
# ROOT — каталог вместо «/» для системных файлов (для проверки скрипта без Pi), HOME — для файлов пользователя.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
USER_NAME="$(id -un)"
HOME_DIR="${HOME:-/home/$USER_NAME}"
MM_DIR="${MM_DIR:-$(dirname "$REPO")/MagicMirror}"
WIFI_COUNTRY="${WIFI_COUNTRY:-RU}"
MIRROR_HOSTNAME="${MIRROR_HOSTNAME:-smartmirror}"
NODE_MAJOR=22
ROOT="${ROOT:-}"

say () { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
warn () { printf '\033[1;33m! %s\033[0m\n' "$*"; }

# Записывает системный файл (содержимое — из stdin).
put () {
	sudo mkdir -p "$(dirname "$ROOT$1")"
	sudo tee "$ROOT$1" > /dev/null
	sudo chmod "${2:-644}" "$ROOT$1"
}

if [ "$(id -u)" -eq 0 ]; then
	echo "Запускайте от обычного пользователя (например, pi), без sudo: скрипт сам попросит пароль, где нужно." >&2
	exit 1
fi
if ! command -v nmcli > /dev/null; then
	echo "Нет NetworkManager (nmcli). Нужна Raspberry Pi OS Bookworm или новее." >&2
	exit 1
fi
[ -f /etc/rpi-issue ] || warn "Похоже, это не Raspberry Pi OS — продолжаю, но шаги raspi-config будут пропущены."

say "Пакеты: git, curl, Chromium, dnsmasq"
sudo apt-get update
CHROMIUM=chromium
apt-cache show chromium > /dev/null 2>&1 || CHROMIUM=chromium-browser
sudo apt-get install -y git curl ca-certificates dnsmasq-base "$CHROMIUM"

say "Node.js $NODE_MAJOR"
if ! command -v node > /dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ]; then
	curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
	sudo apt-get install -y nodejs
fi
NODE_BIN="$(command -v node)"
echo "node $("$NODE_BIN" -v) → $NODE_BIN"

say "MagicMirror² → $MM_DIR"
# Экран показывает Chromium, поэтому Electron не нужен
MM_DIR="$MM_DIR" "$REPO/scripts/setup.sh"

if command -v raspi-config > /dev/null; then
	say "Raspberry Pi: страна Wi‑Fi $WIFI_COUNTRY, автовход в рабочий стол, экран не гаснет"
	# без страны Wi‑Fi заблокирован и точка доступа не включится
	sudo raspi-config nonint do_wifi_country "$WIFI_COUNTRY"
	sudo raspi-config nonint do_boot_behaviour B4
	sudo raspi-config nonint do_blanking 1
	if [ "$(hostname)" = "raspberrypi" ]; then
		sudo raspi-config nonint do_hostname "$MIRROR_HOSTNAME"
		echo "Имя в сети: $MIRROR_HOSTNAME.local"
	fi
fi
sudo rfkill unblock wifi 2> /dev/null || true

say "Права на управление Wi‑Fi для службы (polkit)"
put /etc/polkit-1/rules.d/50-smartmirror-network.rules <<RULES
// SmartMirror: служба smartmirror.service (пользователь $USER_NAME) управляет Wi‑Fi через NetworkManager
polkit.addRule(function (action, subject) {
	if (action.id.indexOf("org.freedesktop.NetworkManager.") === 0 && subject.user === "$USER_NAME") {
		return polkit.Result.YES;
	}
});
RULES

say "Страница настройки открывается на телефоне сама (DNS точки доступа)"
# Действует только для сети SmartMirror-XXXX: любое имя → зеркало, а Studio на порту 80
# отправляет на страницу настройки. На домашнюю сеть не влияет.
put /etc/NetworkManager/dnsmasq-shared.d/smartmirror-captive.conf <<'CONF'
address=/#/10.42.0.1
CONF

say "Служба smartmirror.service"
put /etc/systemd/system/smartmirror.service <<UNIT
[Unit]
Description=SmartMirror: Studio, Wi-Fi setup and MagicMirror²
Wants=NetworkManager.service
After=NetworkManager.service

[Service]
User=$USER_NAME
WorkingDirectory=$REPO/studio
Environment=NET_BACKEND=nmcli
Environment=PAIRING=1
Environment=CAPTIVE_PORT=80
Environment=MM_DIR=$MM_DIR
Environment=MM_ADDRESS=0.0.0.0
Environment=MM_IP_WHITELIST=
ExecStart=$NODE_BIN server.js
# порт 80 для страницы настройки без прав root
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

say "Экран зеркала при входе в рабочий стол"
chmod +x "$REPO/pi/kiosk.sh"
mkdir -p "$HOME_DIR/.config/autostart"
cat > "$HOME_DIR/.config/autostart/smartmirror-kiosk.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=SmartMirror
Exec=$REPO/pi/kiosk.sh
X-GNOME-Autostart-enabled=true
DESKTOP
# labwc (Raspberry Pi OS с конца 2024) — свой autostart; берём системный и добавляем экран зеркала.
# Повторный запуск kiosk.sh ничего не делает, так что два способа автозапуска не мешают друг другу.
LABWC="$HOME_DIR/.config/labwc/autostart"
if [ -f "$ROOT/etc/xdg/labwc/autostart" ] || [ -f "$LABWC" ]; then
	mkdir -p "$(dirname "$LABWC")"
	[ -f "$LABWC" ] || cp "$ROOT/etc/xdg/labwc/autostart" "$LABWC"
	grep -q "pi/kiosk.sh" "$LABWC" || echo "$REPO/pi/kiosk.sh &" >> "$LABWC"
fi

if [ -z "$ROOT" ]; then
	sudo systemctl daemon-reload
	sudo systemctl enable smartmirror.service
	sudo systemctl restart smartmirror.service
fi

say "Готово"
cat <<DONE
Перезагрузите Raspberry Pi:  sudo reboot

После загрузки:
  • знакомого Wi‑Fi нет → на экране QR-код сети SmartMirror-XXXX, дальше всё с телефона;
  • Wi‑Fi есть → MagicMirror² и QR-код для Studio на телефоне.

Журнал службы:   journalctl -u smartmirror -f
Studio в сети:   http://$MIRROR_HOSTNAME.local:8090 (или по адресу Pi)
DONE
