#!/bin/sh
set -eu

cd "$(dirname "$0")"

# Bestehende Konfiguration schützen
if [ -e .env ] || [ -e secrets ]; then
    echo 'Konfiguration existiert bereits; keine Passwörter überschrieben.'
    exit 1
fi

# Root-Rechte für Dateiberechtigungen sicherstellen
if [ "$(id -u)" -ne 0 ]; then
    echo 'Bitte das Skript mit Root-Rechten ausführen.'
    exit 1
fi

umask 077

mkdir secrets

# Zufällige Passwörter generieren
server=$(openssl rand -hex 24)
player=$(openssl rand -hex 24)
demo=$(openssl rand -hex 12)

# Umgebungsvariablen speichern
printf 'SERVER_PASSWORD=%s\nPLAYER_PASSWORD=%s\nTUNNEL_TOKEN=\n' \
    "$server" "$player" > .env

chmod 600 .env

# MQTT-Passwortdatei erzeugen
docker run --rm \
    --user 0:0 \
    -v "$PWD/secrets:/out" \
    eclipse-mosquitto:2 \
    sh -c 'mosquitto_passwd -b -c /out/passwords server "$1" &&
           mosquitto_passwd -b /out/passwords player "$2"' \
    sh "$server" "$player"

# Mosquitto-Dateiberechtigungen setzen
chown 1883:1883 secrets/passwords acl mosquitto.conf
chmod 600 secrets/passwords acl
chmod 644 mosquitto.conf

# Demo-Passwortdatei mit bcrypt erzeugen
printf '%s\n' "$demo" | docker run --rm -i \
    --user 0:0 \
    -v "$PWD/secrets:/secrets" \
    httpd:2.4-alpine \
    htpasswd -i -c -B /secrets/htpasswd demo

# Demo-Passwort überprüfen
printf '%s\n' "$demo" | docker run --rm -i \
    --user 0:0 \
    -v "$PWD/secrets:/secrets:ro" \
    httpd:2.4-alpine \
    htpasswd -i -v /secrets/htpasswd demo

# Nginx-Dateiberechtigungen setzen
chown 101:101 secrets/htpasswd
chmod 600 secrets/htpasswd

# Zugangsdaten einmalig ausgeben
printf '\n'
printf 'Konfiguration erfolgreich erstellt.\n'
printf 'Demo-Zugang: demo / %s\n' "$demo"
printf 'Bitte sicher speichern.\n'

unset server player demo
