# Speedchallenge

Kleines Multiplayer-Tippspiel mit C#, TypeScript, HTML und CSS. Die gesamte Spielkommunikation erfolgt über MQTT via WebSockets.

## Lokal starten

Voraussetzungen: .NET SDK 10.0.300 oder neuer innerhalb .NET 10, Node.js 22.12+ und Docker mit laufender Linux-Engine.
Alle Befehle aus dem Projektordner ausführen.

Broker starten:

```powershell
docker compose -f infrastructure/docker-compose.yml up -d
```

Spielserver in einem eigenen Terminal starten:

```powershell
dotnet run --project server
```

Nach Codeänderungen den alten Spielserver zuerst mit Strg+C beenden und erneut starten. Nur eine Instanz auf den gleichen Topics verwenden. Erwartete Meldung: `MQTT verbunden. Warte auf Spieler.`

Browseroberfläche in einem zweiten Terminal starten:

```powershell
npm.cmd --prefix client run dev
```

**Im Browser http://127.0.0.1:5173 öffnen. Port 9001 ist ausschließlich für MQTT-WebSockets und liefert keine Website.** Beide Terminals während des Spiels offen lassen.

Nur bei der ersten Einrichtung oder geänderter Lockdatei vorher installieren:

```powershell
npm.cmd --prefix client ci
```

Vor `npm ci` den Vite-Server mit Strg+C beenden: Unter Windows kann er die Rollup-Datei sperren (`EPERM`). Wenn anschließend `vite` fehlt, nach dem Stoppen erneut `npm ci` erfolgreich ausführen.

Broker beenden:

```powershell
docker compose -f infrastructure/docker-compose.yml down
```

## Spielablauf

1. Die Anwendung in mindestens zwei Browser-Tabs oder auf zwei Geräten öffnen.
2. Unterschiedliche Namen eingeben und beitreten. Beide Tabs zeigen beide Spieler.
3. Beide Spieler auf „Bereit“ setzen. Ein einzelner Spieler reicht nicht.
4. Der Server startet einen Countdown von drei Sekunden. Die Eingabe bleibt gesperrt und der Text verborgen.
5. Nach dem Start sehen beide denselben serverseitig generierten Satz. Die Eingabe wird für Teilnehmer freigegeben.
6. Einen Tippfehler machen: Die Oberfläche meldet den Fehler, die Runde läuft weiter. Groß-/Kleinschreibung, Leerzeichen und Satzzeichen müssen exakt stimmen.
7. Ein Spieler tippt den Satz vollständig korrekt. Beide sehen denselben Gewinner und die vom Server gemessene Zeit. Beide Eingaben werden gesperrt.
8. „Neue Runde“ drücken: Alle Bereitschaftsmarkierungen und Fortschritte werden zurückgesetzt. Beide erneut bereit melden.
9. Optional einen dritten Tab während einer Runde anmelden: Er sieht die Runde, wartet aber bis zur nächsten Runde auf seine Teilnahme.
10. Einen teilnehmenden Tab während Countdown oder Spiel schließen: Die Runde wird abgebrochen. „Neue Runde“ führt zurück zur Lobby.

Ohne Gewinner endet eine Runde nach zwei Minuten. Entscheidend für den Sieg ist die erste vollständig korrekte Eingabe beim Server, nicht eine vom Client behauptete Zeit. Netzwerkverzögerungen zählen damit zur gemessenen Zeit. Die Anwendung verhindert weder Einfügen von Text noch manipulierte Clients; es ist keine Anti-Cheat-Lösung.

## Architektur und Projektstruktur

- `server/Program.cs`: Verbindungsaufbau, Zustandswechsel, Texte, Prüfung und Ergebnis als einfache Funktionen. Records sind reine Datenmodelle.
- `client/src/main.ts`: MQTT-Verbindung, Darstellung und Benutzeraktionen.
- `infrastructure/`: lokaler Mosquitto-Broker, ausschließlich WebSockets auf Port 9001.
- `NuGet.Config`: projektlokale Paketquelle unabhängig von persönlichen Package-Source-Mappings.

Keine eigene Klassenhierarchie, Service-Schichten oder Dependency Injection. Ein Lock schützt den gemeinsamen Serverzustand zwischen Nachrichtenempfang und periodischem Versand.

## MQTT-Protokoll

Alle Nachrichten sind JSON, ohne Retain.

| Topic | Richtung | Inhalt |
| --- | --- | --- |
| `speedchallenge/commands` | Client → Server | `type`, `playerId` und befehlsspezifische Daten |
| `speedchallenge/lobby` | Server → alle Clients | Gemeinsamer Snapshot alle 100 ms |

Befehle:

- `join`: `name`; wiederholtes Join dient als Heartbeat und erhält die Bereitschaft.
- `ready`: boolesches `ready`, nur in der Lobby.
- `status`: `roundId` und aktueller Eingabetext `text`, nur für Teilnehmer der laufenden Runde.
- `restart`: aktuelle `roundId`, nur nach einem Ergebnis.
- `leave`: Spieler abmelden.

Der Snapshot enthält `players` (`id`, `name`, `ready`, `progress`, `playing`), `allReady`, `phase`, `roundId`, `text`, `result` und `countdown`. `phase` wechselt von `lobby` zu `countdown`, `running` und `result`. Der Text wird erst ab `running` übertragen. Die Anzahl korrekter Zeichen am Textanfang ist der Fortschritt; ausschließlich vollständige Textgleichheit gewinnt. Spätere oder fremde Rundenmeldungen verändern das Ergebnis nicht.

MQTT Last Will meldet Verbindungsabbrüche. Zusätzlich senden Clients alle zwei Sekunden ein Lebenszeichen; nach 15 Sekunden entfernt der Server inaktive Spieler. Schlafende oder stark gedrosselte Tabs können deshalb vorübergehend verschwinden. Bei Server- oder Broker-Neustart wird die Runde zurückgesetzt, Clients melden sich erneut an. Nach etwa 5–7 Sekunden ohne Serversnapshot sperrt die Oberfläche die Spielaktionen.

## Build und Integrationstests

```powershell
dotnet build server
npm.cmd --prefix client run build
node client/tests/game.mjs
```

Der Integrationstest benötigt einen laufenden Broker und den aktuellen Spielserver sowie eine ansonsten leere Lobby. Er prüft mit mehreren MQTT-WebSocket-Clients Mindestspielerzahl, Countdown, gemeinsamen Text, falsche und veraltete Eingaben, Fortschritt, Gewinner in allen Clients, späten Beitritt, neue Runde, Verbindungsabbruch, ungültiges JSON und Spieler-Timeout. Dauer ungefähr 25 Sekunden.

Optional: `MQTT_URL` (Server) und `VITE_MQTT_URL` (Client) ändern die Brokeradresse. `MQTT_TOPIC_PREFIX` und `VITE_MQTT_TOPIC_PREFIX` trennen Testinstanzen; Standard ist jeweils `speedchallenge`. Der Integrationstest übernimmt `MQTT_TOPIC_PREFIX`.

Der lokale Broker erlaubt anonymen Zugriff und ist nur an 127.0.0.1 gebunden. Für die Online-Bereitstellung steht eine separate Konfiguration mit Authentifizierung und Topic-Zugriffskontrolle zur Verfügung.

## Online-Bereitstellung

Die lokale Entwicklung bleibt unverändert. Die Online-Konfiguration liegt in `infrastructure/online`. Nginx liefert das gebaute Frontend und leitet `/mqtt` an Mosquitto weiter. Der Browser verwendet automatisch WSS auf der HTTPS-Domain. Der C#-Server verbindet sich intern per WS. Es gibt keine veröffentlichten Broker-Ports.

### Docker-Host (SSH, Docker Compose, OpenSSL)

Projekt vollständig auf den Docker-Host kopieren. Aus dem Projektordner:

```sh
cd infrastructure/online
sh setup.sh
docker compose up -d --build
docker compose logs --tail=50 server broker web
```

Das Setup einmalig ausführen; es erzeugt `.env`, Broker-Passwortdatei und HTTP-Zugang. Zugang sicher speichern. Lokaler HTTP-Test ausschließlich auf dem Docker-Host (`curl -u demo http://127.0.0.1:18080/` fragt das Passwort ab), alternativ SSH-Portweiterleitung vom PC: `ssh -L 18080:127.0.0.1:18080 BENUTZER@HOST-IP` und `http://localhost:18080` öffnen. Kein unverschlüsseltes HTTP über das LAN veröffentlichen.

### Cloudflare

Im Zero-Trust-Dashboard einen neuen, remote verwalteten Cloudflared-Tunnel erstellen. Token in die bereits erzeugte `.env` unter `TUNNEL_TOKEN` eintragen. Als veröffentlichte Anwendung `speedchallenge.example.com` und Diensttyp HTTP, URL `web:8080` konfigurieren. Voraussetzung: Domain in Cloudflare verwaltet, Subdomain frei. Der neue Tunnel läuft im selben Compose-Netz wie Nginx; ein bestehender Tunnel außerhalb dieses Netzes kann `web` nicht auflösen. Keine Router-Portfreigabe notwendig.

```sh
docker compose --profile online up -d --build
docker compose --profile online ps
docker compose --profile online logs --tail=50 tunnel server
```

HTTPS und WSS laufen über Cloudflare. WebSocket-Unterstützung aktiv lassen. Für den Host Cache umgehen und keine Browser-Challenges auf `/mqtt` konfigurieren. HTTP-Zugang per separatem Kanal weitergeben. HTTP Basic Auth schützt Website und WebSocket-Handshake; Browser-Verhalten nach Anmeldung unbedingt prüfen. Bei 401 im WebSocket-Handshake nicht den Schutz entfernen, sondern zunächst Browser/Proxy-Konfiguration prüfen.

### Sicherheitsgrenzen

Mosquitto verlangt Benutzer/Passwort. ACL: Spieler dürfen ausschließlich Commands schreiben und Lobby lesen; Server umgekehrt. Das Spielerpasswort ist absichtlich im Browserbundle sichtbar und kein Geheimnis. Der separate HTTP-Zugang ist die Zugangsschranke. Teilnehmer können weiterhin fremde Spieler-IDs vortäuschen, die gemeinsame Lobby stören oder automatisiert tippen. Keine öffentliche anonyme Dauerbereitstellung; keine sensiblen Daten eingeben. Maximal 32 Spieler, 64 Broker-Verbindungen. Keine Anti-Cheat- oder individuelle Benutzerverwaltung. `.env` und `secrets/` nicht veröffentlichen. Bei Weitergabe oder Verlust des HTTP-Zugangs Zugang rotieren und nicht benötigte Instanzen abschalten.

### Betrieb und Fehlerdiagnose

```sh
docker compose --profile online ps
docker compose --profile online logs --tail=50 tunnel server broker web
```

Bei einer erfolgreichen WebSocket-Verbindung zeigt der Browser für `/mqtt` den HTTP-Status 101. Die Online-Konfiguration muss vor dem produktiven Einsatz auf dem Zielsystem getestet werden.

Zum Beenden der Container:

```sh
docker compose --profile online down
```

## Weiterführende Dokumentation

- [MQTTnet](https://github.com/dotnet/MQTTnet)
- [MQTT.js](https://github.com/mqttjs/MQTT.js)
- [Mosquitto](https://mosquitto.org/man/mosquitto-conf-5.html)
