import mqttLibrary from 'mqtt';
import './styles.css';

type Player = { id: string; name: string; ready: boolean; progress: number; playing: boolean };
type Lobby = { players: Player[]; allReady: boolean; phase: 'lobby' | 'countdown' | 'running' | 'result'; roundId: string; text: string; result: string; countdown: number };
const topicPrefix = import.meta.env.VITE_MQTT_TOPIC_PREFIX ?? 'speedchallenge';
const commandsTopic = `${topicPrefix}/commands`;
const lobbyTopic = `${topicPrefix}/lobby`;
const playerId = crypto.randomUUID(); // Jeder Tab ist ein eigener Spieler.
const nameInput = document.querySelector<HTMLInputElement>('#player-name')!;
const joinButton = document.querySelector<HTMLButtonElement>('#join')!;
const leaveButton = document.querySelector<HTMLButtonElement>('#leave')!;
const readyButton = document.querySelector<HTMLButtonElement>('#ready')!;
const status = document.querySelector<HTMLParagraphElement>('#connection-status')!;
const lobbyStatus = document.querySelector<HTMLParagraphElement>('#lobby-status')!;
const playerList = document.querySelector<HTMLUListElement>('#players')!;
const input = document.querySelector<HTMLTextAreaElement>('#typing-input')!;
const gameStatus = document.querySelector<HTMLParagraphElement>('#game-status')!;
const targetText = document.querySelector<HTMLParagraphElement>('#target-text')!;
const feedback = document.querySelector<HTMLParagraphElement>('#input-feedback')!;
const restartButton = document.querySelector<HTMLButtonElement>('#restart')!;
let joinedName = '';
let lobby: Lobby = { players: [], allReady: false, phase: 'lobby', roundId: '', text: '', result: '', countdown: 0 };
let lastSnapshot = 0;

const brokerUrl = import.meta.env.VITE_MQTT_URL ?? 'ws://127.0.0.1:9001';
const mqtt = mqttLibrary.connect(brokerUrl === 'same-origin'
  ? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/mqtt` : brokerUrl, {
  username: import.meta.env.VITE_MQTT_USERNAME, password: import.meta.env.VITE_MQTT_PASSWORD,
  clientId: playerId, reconnectPeriod: 2000, connectTimeout: 5000,
  keepalive: 5, clean: true, queueQoSZero: false,
  will: { topic: commandsTopic, payload: JSON.stringify({ type: 'leave', playerId }), qos: 0, retain: false },
});
function send(type: string, extra: object = {}) {
  if (mqtt.connected) mqtt.publish(commandsTopic, JSON.stringify({ type, playerId, ...extra }));
}
function announce() {
  if (joinedName) send('join', { name: joinedName });
}
function render() {
  const online = mqtt.connected && Date.now() - lastSnapshot < 5000;
  const me = online ? lobby.players.find(p => p.id === playerId) : undefined;
  status.textContent = !mqtt.connected ? 'Broker nicht erreichbar. Verbinde erneut …'
    : !online ? 'Broker verbunden. Warte auf den Spielserver …'
    : me ? `Angemeldet als ${me.name}.` : joinedName ? 'Anmeldung läuft …' : 'Verbunden. Gib deinen Namen ein.';
  nameInput.disabled = !!joinedName;
  joinButton.disabled = !online || !!joinedName || !nameInput.value.trim();
  leaveButton.hidden = !joinedName;
  readyButton.disabled = !me || lobby.phase !== 'lobby';
  readyButton.textContent = me?.ready ? 'Nicht mehr bereit' : 'Bereit';
  readyButton.setAttribute('aria-pressed', String(me?.ready ?? false));
  playerList.replaceChildren(...(online ? lobby.players : []).map(player => {
    const item = document.createElement('li');
    const detail = lobby.phase === 'lobby' ? (player.ready ? 'Bereit' : 'Nicht bereit')
      : !player.playing ? 'Wartet auf nächste Runde' : `${player.progress} / ${lobby.text.length || '–'} Zeichen`;
    item.textContent = `${player.name}${player.id === playerId ? ' (du)' : ''} – ${detail}`;
    return item;
  }));
  lobbyStatus.textContent = !online ? 'Warte auf Verbindung zum Spielserver.'
    : lobby.phase !== 'lobby' ? 'Die Teilnehmer dieser Runde stehen fest.'
    : lobby.players.length < 2 ? 'Mindestens zwei Spieler werden benötigt.' : 'Warte, bis alle Spieler bereit sind.';
  const wasDisabled = input.disabled;
  input.disabled = !online || !joinedName || !me?.playing || lobby.phase !== 'running';
  if (wasDisabled && !input.disabled) input.focus();
  restartButton.hidden = !online || !me || lobby.phase !== 'result';
  targetText.textContent = online && lobby.text ? lobby.text : 'Der Text erscheint, sobald die Runde startet.';
  gameStatus.textContent = !online ? 'Warte auf den Spielserver.'
    : lobby.phase === 'countdown' ? `Start in ${lobby.countdown} …`
    : lobby.phase === 'running' ? (me?.playing ? 'Los! Tippe den Satz exakt ab. Zeitlimit: 2 Minuten.' : 'Runde läuft. Du kannst in der nächsten Runde mitspielen.')
    : lobby.phase === 'result' ? lobby.result : 'Warte, bis alle bereit sind.';
  feedback.textContent = !input.disabled && input.value
    ? lobby.text.startsWith(input.value) ? 'Bisher korrekt.' : 'Ein Tippfehler ist enthalten. Bitte korrigieren.' : '';
}
mqtt.on('connect', () => {
  lastSnapshot = 0;
  mqtt.subscribe(lobbyTopic, error => { if (!error) announce(); });
  render();
});
mqtt.on('close', () => { lastSnapshot = 0; render(); });
mqtt.on('error', () => { lastSnapshot = 0; render(); });
mqtt.on('message', (topic, payload) => {
  if (topic !== lobbyTopic) return;
  try {
    const data = JSON.parse(payload.toString());
    if (!Array.isArray(data.players) || typeof data.allReady !== 'boolean' ||
      !['lobby', 'countdown', 'running', 'result'].includes(data.phase) ||
      typeof data.roundId !== 'string' || typeof data.text !== 'string' || typeof data.result !== 'string' || typeof data.countdown !== 'number' ||
      !data.players.every((p: Player) => p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.ready === 'boolean' && typeof p.progress === 'number' && typeof p.playing === 'boolean')) return;
    if (data.roundId !== lobby.roundId) input.value = '';
    lobby = data;
    lastSnapshot = Date.now();
    render();
  } catch { /* Ungültige Nachrichten ignorieren. */ }
});
nameInput.addEventListener('input', render);
joinButton.addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name || name.length > 24 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) {
    status.textContent = 'Bitte einen Namen mit 1–24 Zeichen ohne Steuerzeichen eingeben.';
    return;
  }
  joinedName = name;
  announce();
  render();
});
leaveButton.addEventListener('click', () => {
  joinedName = '';
  send('leave');
  render();
});
readyButton.addEventListener('click', () => {
  const me = lobby.players.find(p => p.id === playerId);
  if (me) send('ready', { ready: !me.ready });
});
input.addEventListener('input', () => {
  if (!input.disabled) send('status', { roundId: lobby.roundId, text: input.value });
  render();
});
restartButton.addEventListener('click', () => send('restart', { roundId: lobby.roundId }));
const heartbeat = window.setInterval(() => { announce(); render(); }, 2000);
render();
import.meta.hot?.dispose(() => {
  clearInterval(heartbeat);
  mqtt.end(true);
});
