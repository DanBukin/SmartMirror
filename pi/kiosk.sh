#!/usr/bin/env bash
# Экран зеркала во весь экран. Запускается при входе в рабочий стол (pi/install.sh).
# Если Chromium закрылся или упал — открывается снова.

# только один экземпляр, даже если сработали оба способа автозапуска
exec 9> "${XDG_RUNTIME_DIR:-/tmp}/smartmirror-kiosk.lock"
flock -n 9 || exit 0

URL="${SCREEN_URL:-http://localhost:8090/screen}"
BROWSER="$(command -v chromium || command -v chromium-browser)"
PROFILE="$HOME/.config/smartmirror-kiosk"

# ждём, пока служба smartmirror поднимет страницу
until curl -fs -o /dev/null "$URL"; do sleep 1; done

while true; do
	# после внезапного выключения Chromium предлагает «восстановить вкладки» — убираем это
	sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]*"/"exit_type":"Normal"/' "$PROFILE/Default/Preferences" 2> /dev/null || true
	"$BROWSER" --kiosk --noerrdialogs --disable-infobars --no-first-run \
		--disable-session-crashed-bubble --disable-features=Translate --password-store=basic \
		--check-for-update-interval=31536000 --autoplay-policy=no-user-gesture-required \
		--user-data-dir="$PROFILE" "$URL"
	sleep 2
done
