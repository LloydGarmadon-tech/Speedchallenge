import { connectAsync } from 'mqtt';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const prefix = process.env.MQTT_TOPIC_PREFIX ?? 'speedchallenge';
const clients = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function player(name) {
  const id = randomUUID();
  const client = await connectAsync(process.env.MQTT_URL ?? 'ws://127.0.0.1:9001', {
    username: process.env.MQTT_USERNAME, password: process.env.MQTT_PASSWORD,
    wsOptions: process.env.DEMO_AUTH ? { headers: { Authorization: 'Basic ' + Buffer.from(process.env.DEMO_AUTH).toString('base64') } } : undefined,
    clientId: id, reconnectPeriod: 0, connectTimeout: 5000,
    will: { topic: `${prefix}/commands`, payload: JSON.stringify({ type: 'leave', playerId: id }), qos: 0, retain: false },
  });
  const p = { id, client, name, state: null };
  clients.push(p);
  client.on('message', (_, data) => { p.state = JSON.parse(data.toString()); });
  await client.subscribeAsync(`${prefix}/lobby`);
  await send(p, 'join', { name });
  p.heartbeat = setInterval(() => { if (client.connected) send(p, 'join', { name }); }, 2000);
  return p;
}
function send(p, type, extra = {}) {
  return p.client.publishAsync(`${prefix}/commands`, JSON.stringify({ type, playerId: p.id, ...extra }));
}
async function until(predicate, label, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return console.log('OK:', label);
    await wait(50);
  }
  assert.fail(label);
}
async function start(a, b) {
  await send(a, 'ready', { ready: true });
  await send(b, 'ready', { ready: true });
  await until(() => a.state?.phase === 'countdown', 'Countdown startet');
  assert.equal(a.state.text, '');
  const id = a.state.roundId;
  await send(a, 'status', { roundId: id, text: 'Zu früh' });
  await until(() => a.state?.phase === 'running' && b.state?.phase === 'running', 'Startsignal in beiden Clients');
  assert.equal(a.state.text, b.state.text);
  assert.ok(a.state.text.length > 10);
  return id;
}
try {
  const a = await player('Anna');
  await send(a, 'ready', { ready: true });
  await until(() => a.state?.players.some(p => p.id === a.id && p.ready), 'Ein Spieler bleibt in der Lobby');
  assert.equal(a.state.phase, 'lobby');
  const b = await player('Ben');
  const round = await start(a, b);
  const c = await player('Clara');
  await until(() => c.state?.players.some(p => p.id === c.id && !p.playing), 'Später Beitritt wartet');
  await send(c, 'status', { roundId: round, text: a.state.text });
  await send(a, 'status', { roundId: 'alte-runde', text: a.state.text });
  await send(a, 'status', { roundId: round, text: a.state.text + '!' });
  await wait(300);
  assert.equal(a.state.phase, 'running');
  await send(a, 'status', { roundId: round, text: a.state.text.slice(0, 5) });
  await until(() => b.state.players.find(p => p.id === a.id)?.progress === 5, 'Server prüft Fortschritt');
  await send(b, 'status', { roundId: round, text: a.state.text });
  await until(() => clients.every(p => p.state?.phase === 'result' && p.state.result.startsWith('Ben gewinnt')), 'Gewinner in allen Clients identisch');
  await send(a, 'status', { roundId: round, text: a.state.text });
  await wait(200);
  assert.ok(a.state.result.startsWith('Ben gewinnt'));
  clearInterval(c.heartbeat);
  await send(c, 'leave');
  await send(a, 'restart', { roundId: round });
  await until(() => a.state.phase === 'lobby' && a.state.players.every(p => !p.ready && p.progress === 0), 'Neue Runde setzt Bereitschaft und Fortschritt zurück');
  const next = await start(a, b);
  assert.notEqual(next, round);
  await send(a, 'status', { roundId: round, text: a.state.text });
  await wait(200);
  assert.equal(a.state.phase, 'running');
  clearInterval(b.heartbeat);
  await b.client.endAsync(true);
  await until(() => a.state.phase === 'result' && a.state.result.includes('abgebrochen'), 'Verbindungsabbruch beendet laufende Runde');
  await send(a, 'restart', { roundId: next });
  await until(() => a.state.phase === 'lobby', 'Abgebrochene Runde neu starten');
  await a.client.publishAsync(`${prefix}/commands`, '{invalid');
  clearInterval(a.heartbeat);
  await until(() => !a.state.players.some(p => p.id === a.id), 'Timeout entfernt inaktiven Spieler', 18000);
} finally {
  for (const p of clients) {
    clearInterval(p.heartbeat);
    if (p.client.connected) { await send(p, 'leave'); await p.client.endAsync(); }
  }
}
