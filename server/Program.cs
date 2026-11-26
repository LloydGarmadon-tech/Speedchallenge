using System.Text.Json;
using MQTTnet;

var topicPrefix = Environment.GetEnvironmentVariable("MQTT_TOPIC_PREFIX") ?? "speedchallenge";
var commandsTopic = $"{topicPrefix}/commands";
var lobbyTopic = $"{topicPrefix}/lobby";
var jsonOptions = new JsonSerializerOptions(JsonSerializerDefaults.Web);
var players = new Dictionary<string, Player>();
var participants = new HashSet<string>();
var gate = new object();
var phase = "lobby";
var roundId = "";
var text = "";
var result = "";
var deadline = DateTimeOffset.MinValue;
var startedAt = DateTimeOffset.MinValue;
using var shutdown = new CancellationTokenSource();
using var mqtt = new MqttClientFactory().CreateMqttClient();
var brokerUrl = Environment.GetEnvironmentVariable("MQTT_URL") ?? "ws://127.0.0.1:9001";
var optionsBuilder = new MqttClientOptionsBuilder().WithClientId($"{topicPrefix}-server")
    .WithWebSocketServer(ws => ws.WithUri(brokerUrl)).WithCleanSession();
var mqttUser = Environment.GetEnvironmentVariable("MQTT_USERNAME");
if (!string.IsNullOrEmpty(mqttUser))
    optionsBuilder.WithCredentials(mqttUser, Environment.GetEnvironmentVariable("MQTT_PASSWORD") ?? "");
var options = optionsBuilder.Build();

Console.CancelKeyPress += (_, e) => { e.Cancel = true; shutdown.Cancel(); };
mqtt.ApplicationMessageReceivedAsync += e =>
{
    if (e.ApplicationMessage.Retain || e.ApplicationMessage.Payload.Length > 2048)
        return Task.CompletedTask;
    try
    {
        var command = JsonSerializer.Deserialize<Command>(e.ApplicationMessage.ConvertPayloadToString(), jsonOptions);
        if (command is not null && Guid.TryParse(command.PlayerId, out _))
        {
            lock (gate) HandleCommand(command);
        }
    }
    catch (JsonException) { Console.WriteLine("Ungültige Nachricht ignoriert."); }
    return Task.CompletedTask;
};

Console.WriteLine($"Speedchallenge – Spielserver: {brokerUrl} (Beenden mit Strg+C)");
try
{
    while (!shutdown.IsCancellationRequested)
    {
        try
        {
            if (!mqtt.IsConnected)
            {
                lock (gate) { players.Clear(); ResetRound(); }
                await mqtt.ConnectAsync(options, shutdown.Token);
                await mqtt.SubscribeAsync(commandsTopic, cancellationToken: shutdown.Token);
                Console.WriteLine("MQTT verbunden. Warte auf Spieler.");
            }
            string payload;
            lock (gate)
            {
                var now = DateTimeOffset.UtcNow;
                foreach (var id in players.Where(p => now - p.Value.LastSeen > TimeSpan.FromSeconds(15)).Select(p => p.Key).ToArray())
                    RemovePlayer(id);
                if (phase == "countdown" && now >= deadline)
                {
                    phase = "running";
                    startedAt = now;
                    deadline = now.AddMinutes(2);
                }
                if (phase == "running" && now >= deadline) Finish("Zeit abgelaufen. Kein Gewinner.");
                payload = JsonSerializer.Serialize(new
                {
                    players = players.Select(p => new { id = p.Key, name = p.Value.Name, ready = p.Value.Ready,
                        progress = p.Value.Progress, playing = participants.Contains(p.Key) }),
                    allReady = players.Count >= 2 && players.Values.All(p => p.Ready),
                    phase, roundId, text = phase is "running" or "result" ? text : "", result,
                    countdown = phase == "countdown" ? Math.Max(1, (int)Math.Ceiling((deadline - now).TotalSeconds)) : 0
                }, jsonOptions);
            }
            // Ein gemeinsamer Snapshot transportiert Start, Fortschritt und Ergebnis.
            await mqtt.PublishAsync(new MqttApplicationMessageBuilder().WithTopic(lobbyTopic)
                .WithPayload(payload).Build(), shutdown.Token);
            await Task.Delay(100, shutdown.Token);
        }
        catch (OperationCanceledException) when (shutdown.IsCancellationRequested) { break; }
        catch (Exception ex)
        {
            Console.WriteLine($"MQTT nicht verfügbar: {ex.Message}. Neuer Versuch in 2 Sekunden.");
            if (mqtt.IsConnected) await mqtt.DisconnectAsync();
            await Task.Delay(2000, shutdown.Token);
        }
    }
}
catch (OperationCanceledException) when (shutdown.IsCancellationRequested) { }
Console.WriteLine("Server beendet.");

void HandleCommand(Command command)
{
    var id = command.PlayerId!;
    switch (command.Type)
    {
        case "join":
            var name = command.Name?.Trim();
            if (string.IsNullOrEmpty(name) || name.Length > 24 || name.Any(char.IsControl)) return;
            players.TryGetValue(id, out var existing);
            if (existing is null && players.Count >= 32) return;
            players[id] = existing is null ? new Player(name, false, DateTimeOffset.UtcNow, 0)
                : existing with { LastSeen = DateTimeOffset.UtcNow };
            break;
        case "ready" when phase == "lobby" && command.Ready is not null && players.TryGetValue(id, out var player):
            players[id] = player with { Ready = command.Ready.Value, LastSeen = DateTimeOffset.UtcNow };
            if (players.Count >= 2 && players.Values.All(p => p.Ready))
            {
                participants.UnionWith(players.Keys);
                roundId = Guid.NewGuid().ToString();
                text = GenerateText();
                phase = "countdown";
                deadline = DateTimeOffset.UtcNow.AddSeconds(3);
            }
            break;
        case "status" when phase == "running" && command.RoundId == roundId && participants.Contains(id)
            && players.TryGetValue(id, out var typingPlayer) && command.Text is not null:
            if (DateTimeOffset.UtcNow >= deadline) { Finish("Zeit abgelaufen. Kein Gewinner."); break; }
            var correct = 0;
            while (correct < Math.Min(text.Length, command.Text.Length) && text[correct] == command.Text[correct]) correct++;
            players[id] = typingPlayer with { Progress = correct, LastSeen = DateTimeOffset.UtcNow };
            // Nur vollständige, exakt passende Eingaben gewinnen. Empfangsreihenfolge entscheidet.
            if (command.Text == text)
                Finish($"{typingPlayer.Name} gewinnt nach {(DateTimeOffset.UtcNow - startedAt).TotalSeconds:F2} Sekunden!");
            break;
        case "restart" when phase == "result" && command.RoundId == roundId && players.ContainsKey(id):
            ResetRound();
            break;
        case "leave":
            RemovePlayer(id);
            break;
    }
}

void RemovePlayer(string id)
{
    players.Remove(id);
    if (participants.Remove(id) && phase is "countdown" or "running")
        Finish("Runde abgebrochen: Ein Teilnehmer hat die Verbindung verlassen.");
    if (players.Count == 0) ResetRound();
}

void Finish(string message)
{
    phase = "result";
    result = message;
}

void ResetRound()
{
    phase = "lobby";
    roundId = text = result = "";
    participants.Clear();
    foreach (var id in players.Keys.ToArray()) players[id] = players[id] with { Ready = false, Progress = 0 };
}

string GenerateText()
{
    string[] subjects = ["Der flinke Fuchs", "Die kleine Katze", "Ein mutiger Hund", "Der junge Vogel"];
    string[] actions = ["sucht heute", "findet morgens", "bewacht leise", "beobachtet neugierig"];
    string[] objects = ["einen roten Ball", "den alten Garten", "eine blaue Tasche", "das offene Fenster"];
    return $"{subjects[Random.Shared.Next(subjects.Length)]} {actions[Random.Shared.Next(actions.Length)]} {objects[Random.Shared.Next(objects.Length)]}.";
}

// Reine Datenmodelle, keine Service-Schichten oder Klassenhierarchie.
record Command(string? Type, string? PlayerId, string? Name, bool? Ready, string? RoundId, string? Text);
record Player(string Name, bool Ready, DateTimeOffset LastSeen, int Progress);
