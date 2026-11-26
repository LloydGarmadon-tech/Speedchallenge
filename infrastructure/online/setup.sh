#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ -e .env ] || [ -e secrets ]; then echo 'Konfiguration existiert bereits; keine Passwörter überschrieben.'; exit 1; fi
umask 077
mkdir secrets
server=$(openssl rand -hex 24)
player=$(openssl rand -hex 24)
demo=$(openssl rand -hex 12)
printf 'SERVER_PASSWORD=%s\nPLAYER_PASSWORD=%s\nTUNNEL_TOKEN=\n' "$server" "$player" > .env
docker run --rm --user 0:0 -v "$PWD/secrets:/out" eclipse-mosquitto:2 sh -c 'mosquitto_passwd -b -c /out/passwords server "$1" && mosquitto_passwd -b /out/passwords player "$2"' sh "$server" "$player"
printf 'demo:%s\n' "$(openssl passwd -apr1 "$demo")" > secrets/htpasswd
chmod 644 secrets/passwords secrets/htpasswd
printf 'Demo-Zugang: demo / %s\nBitte sicher speichern.\n' "$demo"
