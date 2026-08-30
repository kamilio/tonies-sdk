import assert from "node:assert/strict";
import { EventEmitter, getEventListeners, once } from "node:events";
import { createRequire } from "node:module";
import { Duplex } from "node:stream";
import { MqttClient } from "mqtt";
import test from "node:test";
import { TonieCloudClient, isToniebox2, tonieboxCapabilities, toniesPath } from "../dist/cloud.js";
import { ToniesRealtime, isPlaying, playbackPosition, TONIES_STATE_TOPICS } from "../dist/realtime.js";

const box = { id: "BOX2", householdId: "household", name: "Test", macAddress: "aabbccddeeff", generation: "tng", product: "tb2", features: ["playbackControls", "sleepTimerAlarm", "tngSettings"], maxVolume: 75, maxHeadphoneVolume: 50 };
const jwt = () => `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
const response = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolved, rejected) => { resolve = resolved; reject = rejected; });
  return { promise, resolve, reject };
}

function authTimers(context) {
  const timers = new Set();
  context.mock.method(globalThis, "setInterval", (callback, delay) => {
    const timer = { callback, delay, unreferenced: false, unref() { this.unreferenced = true; return this; } };
    timers.add(timer);
    return timer;
  });
  context.mock.method(globalThis, "clearInterval", timer => timers.delete(timer));
  return timers;
}

function memoryBroker() {
  const mqttPacket = createRequire(import.meta.resolve("mqtt"))("mqtt-packet");
  const broker = { acknowledged: false, published: [], connections: 0, accept: () => true };
  broker.connector = async (_, options) => {
    const client = new MqttClient(() => {
      broker.connections++;
      const parser = mqttPacket.parser({ protocolVersion: 5 });
      const transport = new Duplex({ read() {}, write(bytes, encoding, callback) { parser.parse(bytes); callback(); } });
      const send = packet => transport.push(mqttPacket.generate(packet, { protocolVersion: 5 }));
      parser.on("packet", packet => {
        if (packet.cmd === "connect") send({ cmd: "connack", sessionPresent: false, reasonCode: broker.accept(packet.password?.toString()) ? 0 : 135 });
        if (packet.cmd === "subscribe") {
          send({ cmd: "suback", messageId: packet.messageId, granted: packet.subscriptions.map(() => 1) });
          send({ cmd: "publish", topic: "external/toniebox/AABBCCDDEEFF/online-state", payload: '{"onlineState":"connected"}', qos: 0, retain: true });
        }
        if (packet.cmd === "publish") {
          broker.published.push(packet);
          if (broker.acknowledged) send({ cmd: "puback", messageId: packet.messageId, reasonCode: 0 });
        }
        if (packet.cmd === "pingreq") send({ cmd: "pingresp" });
      });
      broker.transport = transport;
      return broker.transport;
    }, { ...options, manualConnect: true, reconnectPeriod: 10 });
    broker.client = client;
    const connected = once(client, "connect");
    client.connect();
    await connected;
    return client;
  };
  return broker;
}

async function fixture(options = {}) {
  const requests = [];
  const cloud = new TonieCloudClient({ auth: { accessToken: jwt() }, fetch: async (url, init) => {
    requests.push({ url, ...init });
    if (url.includes("openid-connect") && options.tokenResponse) return response(options.tokenResponse);
    return response({ uuid: "account" });
  } });
  const socket = new EventEmitter();
  socket.options = {};
  socket.connected = true;
  socket.published = [];
  socket.getLastMessageId = () => socket.published.length;
  socket.removeOutgoingMessage = id => { socket.removed = [...socket.removed ?? [], id]; };
  socket.subscribeAsync = async (topics, settings) => { socket.subscriptions = { topics, settings }; };
  socket.publishAsync = async (...args) => { socket.published.push(args); };
  socket.endAsync = async () => { socket.closed = true; };
  const live = new ToniesRealtime(cloud, { connect: async (url, settings) => {
    socket.url = url;
    socket.options = settings;
    return options.connector ? options.connector(socket) : socket;
  }, reconnectPeriod: 0, commandTimeoutMs: options.commandTimeoutMs });
  if (!options.disconnected) await live.connect([options.box ?? box]);
  const send = (topic, payload, retain = false) => socket.emit("message", `external/toniebox/AABBCCDDEEFF/${topic}`, Buffer.from(JSON.stringify(payload)), { retain });
  if (!options.disconnected) send("online-state", { onlineState: options.offline ? "offline" : "connected" }, true);
  return { cloud, socket, live, send, requests };
}

test("strict TB2 discovery excludes classic boxes and other TNG products", () => {
  assert(isToniebox2(box));
  assert(!isToniebox2({ ...box, product: "tbl" }));
  assert(!isToniebox2({ ...box, generation: "classic" }));
  assert.equal(tonieboxCapabilities(box).remoteWake, false);
  assert.equal(toniesPath("households", "a/b", "tonieboxes", "?id"), "/households/a%2Fb/tonieboxes/%3Fid");
});

test("REST requests preserve false and zero, scope auth, and handle empty responses", async () => {
  const requests = [];
  const cloud = new TonieCloudClient({ auth: { accessToken: jwt() }, fetch: async (url, init) => {
    requests.push({ url, ...init });
    return new Response(null, { status: 204 });
  } });
  assert.deepEqual(await cloud.request("PATCH", "/test", { enabled: false, brightness: 0 }), { status: 204 });
  assert.equal(requests[0].body, '{"enabled":false,"brightness":0}');
  assert.equal(requests[0].redirect, "error");
  await assert.rejects(cloud.request("GET", "https://untrusted.test"));
  await assert.rejects(cloud.request("GET", "//untrusted.test"));
});

test("token refresh is serialized across concurrent requests and persists rotated credentials", async () => {
  let refreshed = 0;
  const saved = [];
  const cloud = new TonieCloudClient({ auth: { refreshToken: "refresh" }, onAuth: auth => saved.push(auth), fetch: async url => {
    if (url.includes("openid-connect")) { refreshed++; return response({ access_token: jwt(), refresh_token: "rotated", expires_in: 3600 }); }
    return response({ ok: true });
  } });
  await Promise.all([cloud.request("GET", "/me"), cloud.request("GET", "/me")]);
  assert.equal(refreshed, 1);
  assert.equal(saved[0].refreshToken, "rotated");
});

test("late unauthorized responses reuse an already rotated access token", async () => {
  const late = deferred();
  let refreshes = 0;
  let oldRequests = 0;
  const cloud = new TonieCloudClient({ auth: { accessToken: "old", refreshToken: "refresh", expiresAt: Date.now() + 3600000 }, fetch: async (url, init) => {
    if (url.includes("openid-connect")) { refreshes++; return response({ access_token: "new", refresh_token: "rotated", expires_in: 3600 }); }
    if (init.headers.Authorization === "Bearer old") {
      oldRequests++;
      if (oldRequests === 2) await late.promise;
      return new Response(null, { status: 401 });
    }
    return response({ ok: true });
  } });
  const first = cloud.request("GET", "/first");
  const second = cloud.request("GET", "/second");
  await first;
  late.resolve();
  await second;
  assert.equal(refreshes, 1);
});

test("adopting a repaired login prevents an older refresh from replacing it", async () => {
  const pending = deferred();
  const saved = [];
  const cloud = new TonieCloudClient({ auth: { refreshToken: "old" }, onAuth: auth => saved.push(auth), fetch: () => pending.promise });
  const refreshing = cloud.refresh();
  const repaired = { accessToken: "repaired", refreshToken: "new", expiresAt: Date.now() + 3600000 };
  await cloud.setAuth(repaired);
  pending.resolve(response({ access_token: "stale", refresh_token: "stale", expires_in: 3600 }));
  assert.equal(await refreshing, repaired);
  assert.equal(cloud.auth, repaired);
  assert.deepEqual(saved, [repaired]);
});

test("concurrent provider reads share one credential lookup", async () => {
  const pending = deferred();
  let lookups = 0;
  const cloud = new TonieCloudClient({ getAuth: () => { lookups++; return pending.promise; } });
  const requests = Array.from({ length: 100 }, () => cloud.accessToken());
  pending.resolve({ accessToken: "provided", expiresAt: Date.now() + 3600000 });
  assert.deepEqual(new Set(await Promise.all(requests)), new Set(["provided"]));
  assert.equal(lookups, 1);
});

test("a password login supersedes old refreshes and prevents redirecting credentials", async () => {
  const previous = deferred();
  const next = deferred();
  let requests = 0;
  const cloud = new TonieCloudClient({ auth: { refreshToken: "old" }, fetch: async (_, init) => {
    requests++;
    assert.equal(init.redirect, "error");
    return init.body.get("grant_type") === "password" ? next.promise : previous.promise;
  } });
  const oldRefresh = cloud.refresh();
  const login = cloud.login("user@example.com", "private");
  const sameLogin = cloud.refresh();
  next.resolve(response({ access_token: "new", refresh_token: "new-refresh", expires_in: 3600 }));
  assert.equal((await login).accessToken, "new");
  assert.equal((await sameLogin).accessToken, "new");
  previous.resolve(new Response(null, { status: 401 }));
  assert.equal((await oldRefresh).accessToken, "new");
  assert.equal(requests, 2);
});

test("credential persistence serializes writes and coalesces superseded credentials", async () => {
  const started = deferred();
  const blocked = deferred();
  const saved = [];
  const emitted = [];
  let active = 0;
  let maximum = 0;
  const cloud = new TonieCloudClient({ onAuth: async auth => {
    active++;
    maximum = Math.max(maximum, active);
    if (auth.accessToken === "first") { started.resolve(); await blocked.promise; }
    saved.push(auth.accessToken);
    active--;
  } });
  cloud.on("auth", auth => emitted.push(auth.accessToken));
  const first = cloud.setAuth({ accessToken: "first" });
  await started.promise;
  const middle = cloud.setAuth({ accessToken: "middle" });
  const latest = cloud.setAuth({ accessToken: "latest" });
  blocked.resolve();
  const results = await Promise.all([first, middle, latest]);
  assert.equal(maximum, 1);
  assert.deepEqual(saved, ["first", "latest"]);
  assert.deepEqual(emitted, ["latest"]);
  assert(results.every(auth => auth.accessToken === "latest"));
  assert.equal(first, latest);
});

test("failed credential persistence does not poison subsequent saves", async () => {
  const cloud = new TonieCloudClient({ onAuth: auth => { assert.notEqual(auth.accessToken, "failed"); } });
  await assert.rejects(cloud.setAuth({ accessToken: "failed" }));
  assert.equal((await cloud.setAuth({ accessToken: "repaired" })).accessToken, "repaired");
});

test("SDK surfaces HTTP and GraphQL failures rather than false success", async () => {
  const auth = { accessToken: jwt() };
  await assert.rejects(new TonieCloudClient({ auth, fetch: async () => new Response(null, { status: 403 }) }).request("GET", "/me"), /403/);
  await assert.rejects(new TonieCloudClient({ auth, fetch: async () => response({ errors: [{ message: "Denied" }] }) }).graphql("{}"), /Denied/);
});

test("OpenAPI operation dispatch includes shared path params and required query/body values", async () => {
  const calls = [];
  const spec = { paths: { "/households/{household}/test": {
    parameters: [{ name: "household", in: "path", required: true }],
    patch: { operationId: "test_update", parameters: [{ name: "version", in: "query", required: true }, { name: "data", in: "body", required: true }] }
  } } };
  const cloud = new TonieCloudClient({ auth: { accessToken: jwt() }, fetch: async (url, init) => {
    if (url.includes("format=openapi")) return response(spec);
    calls.push({ url, init });
    return response({ ok: true });
  } });
  await cloud.operation("test_update", { household: "a/b", version: 0 }, { enabled: false });
  assert(calls[0].url.endsWith("/households/a%2Fb/test?version=0"));
  assert.equal(calls[0].init.method, "PATCH");
  await assert.rejects(cloud.operation("test_update", { household: "a" }, {}), /version/);
  await assert.rejects(cloud.operation("missing"), /Unknown/);
});

test("realtime subscribes only known state topics with correct MQTT identity", async () => {
  const { socket, live } = await fixture();
  assert.equal(socket.options.protocolVersion, 5);
  assert.equal(socket.options.username, "account");
  assert.equal(socket.subscriptions.topics.length, TONIES_STATE_TOPICS.length);
  assert(socket.subscriptions.topics.every(topic => topic.startsWith("external/toniebox/AABBCCDDEEFF/")));
  await live.disconnect();
  assert(socket.closed);
});

test("idle realtime connections renew credentials without REST polling", async context => {
  const timers = authTimers(context);
  const { cloud, socket, live, requests } = await fixture({ tokenResponse: { access_token: "renewed-token", refresh_token: "rotated-refresh", expires_in: 300 } });
  context.after(() => live.disconnect());
  assert.equal(timers.size, 1);
  const [timer] = timers;
  assert.equal(timer.delay, 30000);
  assert(timer.unreferenced);
  const before = requests.length;
  timer.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, before);
  await cloud.setAuth({ accessToken: "old-token", refreshToken: "refresh", expiresAt: Date.now() + 1000 });
  timer.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, before + 1);
  assert(requests.at(-1).url.includes("openid-connect"));
  assert.equal(socket.options.password, "renewed-token");
  assert.equal(cloud.auth.refreshToken, "rotated-refresh");
  await live.disconnect();
  assert.equal(timers.size, 0);
});

test("credential maintenance is single-flight and recovers after a failed lookup", async context => {
  const timers = authTimers(context);
  const { cloud, live } = await fixture();
  context.after(() => live.disconnect());
  const [timer] = timers;
  assert(timer);
  const reported = [];
  live.on("error", error => reported.push(error));
  let lookup = deferred();
  let calls = 0;
  context.mock.method(cloud, "accessToken", () => { calls++; return lookup.promise; });
  for (let index = 0; index < 100; index++) timer.callback();
  assert.equal(calls, 1);
  lookup.reject(new Error("temporary credential failure"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reported.length, 1);
  assert.match(reported[0].message, /temporary credential failure/);
  lookup = deferred();
  timer.callback();
  assert.equal(calls, 2);
  await live.disconnect();
  assert.equal(timers.size, 0);
  lookup.reject(new Error("late credential failure after shutdown"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reported.length, 1);
  timer.callback();
  assert.equal(calls, 2);
});

test("credential timers are removed after failed subscriptions and repeated reconnects", async context => {
  const timers = authTimers(context);
  const { live, socket } = await fixture({ disconnected: true });
  context.after(() => live.disconnect());
  socket.subscribeAsync = async () => { throw new Error("subscription denied"); };
  await assert.rejects(live.connect([box]), /subscription denied/);
  assert.equal(timers.size, 0);
  socket.subscribeAsync = async () => {};
  for (let index = 0; index < 50; index++) {
    await live.connect([box]);
    assert.equal(timers.size, 1);
    await live.disconnect();
    assert.equal(timers.size, 0);
  }
});

test("credentials repaired while a socket opens are used for subsequent reconnects", async context => {
  const opening = deferred();
  const opened = deferred();
  const { live, cloud, socket } = await fixture({ disconnected: true, connector: async socket => {
    opening.resolve();
    await opened.promise;
    return socket;
  } });
  context.after(() => live.disconnect());
  const connected = live.connect([box]);
  await opening.promise;
  await cloud.setAuth({ accessToken: "repaired-during-connect", expiresAt: Date.now() + 3600000 });
  opened.resolve();
  await connected;
  assert.equal(socket.options.password, "repaired-during-connect");
  assert.equal(cloud.listenerCount("auth"), 1);
});

test("play/pause/seek/volume/night controls use exact wire payloads and never retain commands", async () => {
  const { socket, live, send } = await fixture();
  send("playback/state", { tonie: "TONIE", chapter: 1, paused: false }, true);
  send("volume/state", { level: 10 }, true);
  await live.pause(box.id);
  await live.play(box.id);
  await live.skip(box.id, 1);
  await live.skip(box.id, -1);
  await live.seek(box.id, 2, 1234);
  await live.changeVolume(box.id, -1);
  await live.sleepTimer(box.id, 1800);
  await live.sleepTimer(box.id, 0);
  assert.deepEqual(socket.published.map(([topic, payload]) => [topic.split("/").at(-1), JSON.parse(payload)]), [
    ["playback", { action: "pause" }], ["playback", { action: "start" }],
    ["playback", { action: "setPosition", chapter: 2, ms: 0 }], ["playback", { action: "setPosition", chapter: 0, ms: 0 }],
    ["playback", { action: "setPosition", chapter: 2, ms: 1234 }], ["volume", { level: 9 }],
    ["stl", { state: "on", duration: 1800 }], ["stl", { state: "off" }]
  ]);
  for (const [, , options] of socket.published) assert.deepEqual(options, { qos: 1, retain: false, properties: { messageExpiryInterval: 10 } });
  assert.throws(() => live.setVolume(box.id, 14));
  assert.throws(() => live.seek(box.id, -1));
  await live.disconnect();
});

test("offline and unsupported boxes cannot receive controls", async () => {
  const { socket, live } = await fixture({ offline: true });
  await assert.rejects(live.pause(box.id), /offline/);
  assert.equal(socket.published.length, 0);
  await live.disconnect();
  const unsupported = await fixture({ box: { ...box, features: [] } });
  assert.throws(() => unsupported.live.pause(box.id), /playbackControls/);
  await unsupported.live.disconnect();
});

test("commands are not queued while the broker is disconnected", async () => {
  const { socket, live } = await fixture();
  socket.connected = false;
  await assert.rejects(live.pause(box.id), /not queued/);
  assert.equal(socket.published.length, 0);
  await live.disconnect();
});

test("relative controls reject disconnected brokers before waiting for missing telemetry", async context => {
  const { live, socket } = await fixture();
  context.after(() => live.disconnect());
  socket.connected = false;
  socket.emit("close");
  const reads = context.mock.method(live, "waitForState", async () => { throw new Error("Unexpected telemetry wait"); });
  await assert.rejects(live.skip(box.id, 1), /broker is disconnected/);
  await assert.rejects(live.changeVolume(box.id, 1), /broker is disconnected/);
  assert.equal(reads.mock.callCount(), 0);
  assert.equal(socket.published.length, 0);
});

test("relative controls stop waiting when a device goes offline", async context => {
  const { live, socket, send } = await fixture();
  context.after(() => live.disconnect());
  const skipped = assert.rejects(live.skip(box.id, 1), /Toniebox is offline/);
  const changed = assert.rejects(live.changeVolume(box.id, 1), /Toniebox is offline/);
  send("online-state", { onlineState: "offline" });
  await Promise.all([skipped, changed]);
  assert.equal(socket.published.length, 0);
  assert.equal(live.listenerCount("state"), 0);
});

test("broker loss cancels relative controls waiting for telemetry", async context => {
  const { live, socket } = await fixture();
  context.after(() => live.disconnect());
  const skipped = assert.rejects(live.skip(box.id, 1), /broker disconnected/);
  const changed = assert.rejects(live.changeVolume(box.id, -1), /broker disconnected/);
  socket.connected = false;
  socket.emit("close");
  await Promise.all([skipped, changed]);
  assert.equal(socket.published.length, 0);
  assert.equal(live.listenerCount("state"), 0);
});

test("relative controls accept retained telemetry but reject invalid step values", async context => {
  const { live, socket, send } = await fixture();
  context.after(() => live.disconnect());
  const skipped = live.skip(box.id, 1);
  send("playback/state", { chapter: 2 }, true);
  await skipped;
  const changed = live.changeVolume(box.id, -1);
  send("volume/state", { level: 4 }, true);
  await changed;
  assert.deepEqual(socket.published.map(([, payload]) => JSON.parse(payload)), [{ action: "setPosition", chapter: 3, ms: 0 }, { level: 3 }]);
  for (const offset of [0, 2, -2, NaN, Infinity]) {
    await assert.rejects(live.skip(box.id, offset), /offset must be/);
    await assert.rejects(live.changeVolume(box.id, offset), /offset must be/);
  }
  assert.equal(socket.published.length, 2);
});

test("concurrent connect cannot open duplicate sockets", async () => {
  const ready = deferred();
  const opened = deferred();
  let connections = 0;
  const { live } = await fixture({ disconnected: true, connector: async socket => {
    connections++;
    opened.resolve();
    await ready.promise;
    return socket;
  } });
  const connecting = live.connect([box]);
  await assert.rejects(live.connect([box]), /connecting/);
  await opened.promise;
  ready.resolve();
  await connecting;
  assert.equal(connections, 1);
  await live.disconnect();
});

test("disconnect during socket creation disposes the late socket", async () => {
  const ready = deferred();
  const opened = deferred();
  const { live, cloud, socket } = await fixture({ disconnected: true, connector: async socket => {
    opened.resolve();
    await ready.promise;
    return socket;
  } });
  const connecting = live.connect([box]);
  await opened.promise;
  await live.disconnect();
  ready.resolve();
  await assert.rejects(connecting, { name: "AbortError" });
  assert.equal(socket.closed, true);
  assert.equal(socket.listenerCount("message"), 0);
  assert.equal(cloud.listenerCount("auth"), 0);
  assert.equal(live.states.size, 0);
});

test("failed subscriptions close the connection and allow a clean retry", async () => {
  const { live, socket, cloud } = await fixture({ disconnected: true });
  socket.subscribeAsync = async () => { throw new Error("subscription denied"); };
  await assert.rejects(live.connect([box]), /subscription denied/);
  assert.equal(socket.closed, true);
  assert.equal(socket.listenerCount("message"), 0);
  assert.equal(cloud.listenerCount("auth"), 0);
  socket.subscribeAsync = async () => {};
  await live.connect([box]);
  assert.equal(socket.listenerCount("message"), 1);
  await live.disconnect();
});

test("disconnect and timeouts release state waiters and timers", async () => {
  const { live, socket, cloud } = await fixture();
  await assert.rejects(live.waitForState("unknown", () => false), /Connect/);
  await assert.rejects(live.waitForState(box.id, () => false, 1), { name: "AbortError" });
  assert.equal(live.listenerCount("state"), 0);
  const waiting = live.waitForState(box.id, () => false);
  const rejected = assert.rejects(waiting, { name: "AbortError" });
  await live.disconnect();
  await rejected;
  assert.equal(live.listenerCount("state"), 0);
  assert.equal(live.listenerCount("error"), 0);
  assert.equal(socket.listenerCount("message"), 0);
  assert.equal(cloud.listenerCount("auth"), 0);
});

test("fresh confirmations ignore cached, retained, and unrelated state", async () => {
  const { live, send } = await fixture();
  send("app-reply/bedtime-state", { stl: { state: "on" } }, true);
  let completed = false;
  const waiting = live.withConfirmation(box.id, "app-reply/bedtime-state", state => state.bedtime?.stl?.state === "on", () => live.sleepTimer(box.id, 1800));
  waiting.then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  send("volume/state", { level: 7 });
  send("app-reply/bedtime-state", { stl: { state: "on" } }, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  send("app-reply/bedtime-state", { stl: { state: "on" } });
  const result = await waiting;
  assert.equal(result.deviceConfirmed, true);
  assert.equal(result.acknowledged, true);
  assert.equal(live.listenerCount("state"), 0);
  await live.disconnect();
});

test("device replies arriving before broker acknowledgment still confirm commands", async () => {
  const { live, send } = await fixture();
  const result = await live.withConfirmation(box.id, "app-reply/bedtime-state", state => state.bedtime?.stl?.state === "on", async () => {
    send("app-reply/bedtime-state", { stl: { state: "on" } });
    await new Promise(resolve => setImmediate(resolve));
    return { acknowledged: true };
  });
  assert.equal(result.deviceConfirmed, true);
  assert.equal(result.state.bedtime.stl.state, "on");
  await live.disconnect();
});

test("a synchronous telemetry burst cannot lose a matching fresh reply", async () => {
  const { live, send } = await fixture();
  const waiting = live.withConfirmation(box.id, "app-reply/bedtime-state", state => state.bedtime?.stl?.state === "on", async () => {
    send("volume/state", { level: 3 });
    send("app-reply/bedtime-state", { stl: { state: "on" } }, true);
    send("app-reply/bedtime-state", { stl: { state: "on" } });
    send("volume/state", { level: 4 });
    return { acknowledged: true };
  });
  assert.equal((await waiting).deviceConfirmed, true);
  await live.disconnect();
});

test("a failing state predicate rejects and releases its persistent listener", async () => {
  const { live, send } = await fixture();
  const waiting = live.waitForState(box.id, () => { throw new Error("invalid predicate"); }, 10000, { fresh: true });
  const rejected = assert.rejects(waiting, /invalid predicate/);
  send("volume/state", { level: 3 });
  send("volume/state", { level: 4 });
  send("volume/state", { level: 5 });
  await rejected;
  assert.equal(live.listenerCount("state"), 0);
  assert.equal(live.listenerCount("error"), 0);
  await live.disconnect();
});

test("failed or timed-out confirmations release their state listeners", async () => {
  const { live } = await fixture();
  await assert.rejects(live.withConfirmation(box.id, "app-reply/bedtime-state", () => true, () => { throw new Error("publish failed"); }), /publish failed/);
  assert.equal(live.listenerCount("state"), 0);
  assert.equal(live.listenerCount("error"), 0);
  await assert.rejects(live.withConfirmation(box.id, "app-reply/bedtime-state", () => true, async () => ({ acknowledged: true }), 1), { name: "AbortError" });
  assert.equal(live.listenerCount("state"), 0);
  assert.equal(live.listenerCount("error"), 0);
  await live.disconnect();
});

test("confirmation timeout cancels commands still waiting for initial telemetry", async context => {
  const { live, socket, send } = await fixture({ disconnected: true });
  context.after(() => live.disconnect());
  await live.connect([box]);
  await assert.rejects(live.withConfirmation(box.id, "app-reply/bedtime-state", () => true, () => live.sleepTimer(box.id, 1800), 1), { name: "AbortError" });
  send("online-state", { onlineState: "connected" }, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(socket.published.length, 0);
  assert.equal(live.listenerCount("state"), 0);
});

test("confirmation timeout removes commands still awaiting broker acknowledgment", async context => {
  const { live, socket } = await fixture();
  context.after(() => live.disconnect());
  socket.publishAsync = (...args) => { socket.published.push(args); return new Promise(() => {}); };
  await assert.rejects(live.withConfirmation(box.id, "app-reply/bedtime-state", () => true, () => live.sleepTimer(box.id, 1800), 5), { name: "AbortError" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(socket.removed, [1]);
});

test("operation abort listeners cannot suppress removal of timed-out commands", async context => {
  const { live, socket } = await fixture();
  context.after(() => live.disconnect());
  socket.publishAsync = (...args) => { socket.published.push(args); return new Promise(() => {}); };
  await assert.rejects(live.withConfirmation(box.id, "app-reply/bedtime-state", () => true, signal => {
    signal.addEventListener("abort", event => event.stopImmediatePropagation());
    return live.sleepTimer(box.id, 1800);
  }, 5), { name: "AbortError" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(socket.removed, [1]);
});

test("late confirmation work cannot publish after timeout or cancel unrelated controls", async context => {
  const { live, socket } = await fixture();
  context.after(() => live.disconnect());
  const ready = deferred();
  await assert.rejects(live.withConfirmation(box.id, "app-reply/bedtime-state", () => true, async () => {
    await ready.promise;
    return live.sleepTimer(box.id, 1800);
  }, 1), { name: "AbortError" });
  ready.resolve();
  await live.pause(box.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(socket.published.map(([, payload]) => JSON.parse(payload)), [{ action: "pause" }]);
});

test("nested confirmations inherit cancellation and expose an operation signal", async context => {
  const { live, socket } = await fixture();
  context.after(() => live.disconnect());
  const ready = deferred();
  let signal;
  await assert.rejects(live.withConfirmation(box.id, "app-reply/bedtime-state", () => true, () =>
    live.withConfirmation(box.id, "volume/state", () => true, async operationSignal => {
      signal = operationSignal;
      await ready.promise;
      return live.setVolume(box.id, 3);
    }), 5), { name: "AbortError" });
  assert(signal instanceof AbortSignal);
  assert(signal.aborted);
  ready.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(socket.published.length, 0);
  assert.equal(live.listenerCount("state"), 0);
  assert.equal(live.listenerCount("error"), 0);
});

test("late work from a closed session cannot command a newly connected session", async context => {
  const { live, socket, send } = await fixture();
  context.after(() => live.disconnect());
  const ready = deferred();
  const rejected = assert.rejects(live.withConfirmation(box.id, "app-reply/bedtime-state", () => true, async () => {
    await ready.promise;
    return live.sleepTimer(box.id, 1800);
  }), { name: "AbortError" });
  await new Promise(resolve => setImmediate(resolve));
  await live.disconnect();
  await rejected;
  await live.connect([box]);
  send("online-state", { onlineState: "connected" }, true);
  ready.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(socket.published.length, 0);
});

test("10000 confirmed controls release cancellation scopes and retained heap", async context => {
  const { live, socket, send } = await fixture();
  context.after(() => live.disconnect());
  let messageId = 0;
  socket.publishAsync = async () => {};
  socket.getLastMessageId = () => ++messageId;
  const confirm = () => live.withConfirmation(box.id, "volume/state", state => state.volume?.level === 4, async () => {
    const result = await live.setVolume(box.id, 4);
    send("volume/state", { level: 4 });
    return result;
  });
  for (let index = 0; index < 20; index++) await confirm();
  global.gc?.();
  const baseline = process.memoryUsage().heapUsed;
  const started = performance.now();
  for (let index = 0; index < 10000; index++) await confirm();
  await new Promise(resolve => setImmediate(resolve));
  global.gc?.();
  await new Promise(resolve => setImmediate(resolve));
  global.gc?.();
  const retained = process.memoryUsage().heapUsed - baseline;
  assert.equal(live.listenerCount("state"), 0);
  assert.equal(live.listenerCount("error"), 0);
  assert.equal(live.states.size, 1);
  if (global.gc) assert(retained < 2 * 1024 * 1024, `Confirmed controls retained ${retained} heap bytes`);
  context.diagnostic(`10000 confirmed controls: ${(performance.now() - started).toFixed(1)} ms; retained heap delta ${retained} bytes${global.gc ? " after GC" : " (GC not forced)"}`);
});

test("broker loss removes a confirmed command only once", async context => {
  const { live, socket } = await fixture();
  context.after(() => live.disconnect());
  socket.publishAsync = (...args) => { socket.published.push(args); return new Promise(() => {}); };
  const rejected = assert.rejects(live.withConfirmation(box.id, "app-reply/bedtime-state", () => true, () => live.sleepTimer(box.id, 1800)), /broker disconnected/);
  await new Promise(resolve => setImmediate(resolve));
  socket.connected = false;
  socket.emit("close");
  await rejected;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(socket.removed, [1]);
});

test("already-aborted waiters never accept cached state", async () => {
  const { live } = await fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(live.waitForState(box.id, () => true, 10000, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(live.listenerCount("state"), 0);
  await live.disconnect();
});

test("invalid confirmation targets never execute the operation", async () => {
  const { live } = await fixture();
  let calls = 0;
  const operation = async () => { calls++; return {}; };
  await assert.rejects(live.withConfirmation("unknown", "volume/state", () => true, operation), /Connect/);
  await assert.rejects(live.withConfirmation(box.id, "unknown", () => true, operation), /subscribed/);
  assert.equal(calls, 0);
  await live.disconnect();
});

test("256 concurrent confirmations share listeners and cap pending memory", async () => {
  const { live, send } = await fixture();
  const controller = new AbortController();
  const waiting = Array.from({ length: 256 }, () => live.waitForState(box.id, state => state.volume?.level === 4, 10000, { fresh: true, signal: controller.signal }));
  assert.equal(live.listenerCount("state"), 1);
  assert.equal(live.listenerCount("error"), 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  await assert.rejects(live.waitForState(box.id, () => false), /At most 256/);
  let operations = 0;
  await assert.rejects(live.withConfirmation(box.id, "volume/state", () => true, async () => { operations++; return {}; }), /At most 256/);
  assert.equal(operations, 0);
  send("volume/state", { level: 3 });
  send("volume/state", { level: 4 });
  assert.equal((await Promise.all(waiting)).length, 256);
  assert.equal(live.listenerCount("state"), 0);
  assert.equal(live.listenerCount("error"), 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const reason = new Error("Cancel all state observers");
  const cancelled = Array.from({ length: 256 }, () => assert.rejects(live.waitForState(box.id, () => false, 10000, { signal: controller.signal }), error => error === reason));
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort(reason);
  await Promise.all(cancelled);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(live.listenerCount("state"), 0);
  await live.disconnect();
});

test("state cancellation cannot be suppressed by another abort listener", async context => {
  const { live } = await fixture();
  context.after(() => live.disconnect());
  const controller = new AbortController();
  controller.signal.addEventListener("abort", event => event.stopImmediatePropagation());
  const rejected = assert.rejects(live.waitForState(box.id, () => false, 20, { signal: controller.signal }), /caller cancelled/);
  controller.abort(new Error("caller cancelled"));
  await rejected;
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
});

test("async subscriber failures propagate through the existing error event", async () => {
  const { live, send } = await fixture();
  const reported = deferred();
  live.on("error", error => reported.resolve(error));
  live.on("state", async () => { throw new Error("Homey capability rejected"); });
  send("volume/state", { level: 3 });
  assert.match((await reported.promise).message, /capability rejected/);
  await live.disconnect();
});

test("unsubscribed topics never create state or allocate payloads", async () => {
  const { live, socket } = await fixture();
  const before = live.states.get(box.id);
  socket.emit("message", "external/toniebox/AABBCCDDEEFF/unexpected", Buffer.from("not JSON"), { retain: false });
  socket.emit("message", "external/toniebox/AABBCCDDEEFF-other/playback/state", Buffer.from("not JSON"), { retain: false });
  assert.equal(live.states.get(box.id), before);
  await live.disconnect();
});

test("invalid or oversized state messages report errors without blocking later updates", async () => {
  const { live, socket, send } = await fixture();
  const errors = [];
  live.on("error", error => errors.push(error));
  for (const bytes of [Buffer.from("not JSON"), Buffer.from("null"), Buffer.from("[]"), Buffer.alloc(65537)]) {
    socket.emit("message", "external/toniebox/AABBCCDDEEFF/playback/state", bytes, { retain: false });
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 4);
  send("volume/state", { level: 4 });
  assert.equal(live.states.get(box.id).volume.level, 4);
  await live.disconnect();
});

test("unacknowledged commands expire and are removed from the outgoing store", async () => {
  const { live, socket } = await fixture({ commandTimeoutMs: 1 });
  socket.publishAsync = (...args) => { socket.published.push(args); return new Promise(() => {}); };
  await assert.rejects(live.pause(box.id), /timed out/);
  assert.deepEqual(socket.removed, [1]);
  await live.disconnect();
});

test("broker loss cancels pending commands and invalidates retained box state", async () => {
  const { live, socket, send } = await fixture();
  send("playback/state", { tonie: "TONIE", paused: false });
  socket.publishAsync = (...args) => { socket.published.push(args); return new Promise(() => {}); };
  const command = live.pause(box.id);
  const rejected = assert.rejects(command, /interrupted/);
  await new Promise(resolve => setImmediate(resolve));
  socket.connected = false;
  socket.emit("offline");
  socket.emit("close");
  await rejected;
  assert.deepEqual(socket.removed, [1]);
  assert.equal(live.states.get(box.id).onlineState, "unknown");
  assert.equal(live.states.get(box.id).playback, undefined);
  socket.connected = true;
  socket.emit("connect");
  await assert.rejects(live.play(box.id), /offline/);
  await live.disconnect();
});

test("broker loss rejects acknowledged commands still awaiting physical confirmation", async context => {
  const { live, socket, send } = await fixture();
  context.after(() => live.disconnect());
  let acknowledged = false;
  const confirmation = live.withConfirmation(box.id, "app-reply/bedtime-state", state => state.bedtime?.stl?.state === "on", async () => {
    const result = await live.sleepTimer(box.id, 1800);
    acknowledged = true;
    return result;
  }, 50);
  const rejected = assert.rejects(confirmation, /broker disconnected/);
  await new Promise(resolve => setImmediate(resolve));
  assert(acknowledged);
  socket.connected = false;
  socket.emit("close");
  await rejected;
  assert.equal(live.listenerCount("state"), 0);
  assert.equal(live.listenerCount("error"), 0);
  const observed = live.waitForState(box.id, state => state.onlineState === "connected");
  socket.connected = true;
  socket.emit("connect");
  send("online-state", { onlineState: "connected" }, true);
  await observed;
  const next = live.withConfirmation(box.id, "app-reply/bedtime-state", state => state.bedtime?.stl?.state === "on", () => live.sleepTimer(box.id, 1800));
  await new Promise(resolve => setImmediate(resolve));
  send("app-reply/bedtime-state", { stl: { state: "on" } });
  assert.equal((await next).deviceConfirmed, true);
});

test("disconnected transports cannot restore stale state or emit playback transitions", async context => {
  const { live, socket, send } = await fixture();
  context.after(() => live.disconnect());
  let snapshots = 0;
  let starts = 0;
  live.on("state", () => { snapshots++; });
  live.on("playback-started", () => { starts++; });
  socket.connected = false;
  socket.emit("close");
  const disconnectedSnapshots = snapshots;
  send("online-state", { onlineState: "connected" }, true);
  send("playback/state", { tonie: "OLD", paused: false });
  send("app-reply/bedtime-state", { stl: { state: "on", duration: 1800 } });
  assert.deepEqual(live.states.get(box.id), { onlineState: "unknown" });
  assert.equal(snapshots, disconnectedSnapshots);
  assert.equal(starts, 0);
  socket.connected = true;
  socket.emit("connect");
  send("online-state", { onlineState: "connected" }, true);
  send("playback/state", { tonie: "CURRENT", paused: false }, true);
  assert.equal(live.states.get(box.id).playback.tonie, "CURRENT");
  assert.equal(starts, 0);
});

test("retained telemetry arriving during initial subscription is accepted", async context => {
  const { live, socket } = await fixture({ disconnected: true });
  context.after(() => live.disconnect());
  socket.subscribeAsync = async () => {
    socket.emit("message", "external/toniebox/AABBCCDDEEFF/online-state", Buffer.from('{"onlineState":"connected"}'), { retain: true });
  };
  await live.connect([box]);
  assert.equal(live.states.get(box.id).onlineState, "connected");
});

test("confirmations cannot execute operations while the broker is disconnected", async context => {
  const { live, socket } = await fixture();
  context.after(() => live.disconnect());
  socket.connected = false;
  socket.emit("close");
  let operations = 0;
  await assert.rejects(live.withConfirmation(box.id, "volume/state", () => true, async () => { operations++; return {}; }, 1), /broker disconnected/);
  assert.equal(operations, 0);
});

test("disconnect before a confirmation operation starts prevents its execution", async context => {
  const { live, socket } = await fixture();
  context.after(() => live.disconnect());
  let operations = 0;
  const confirmation = live.withConfirmation(box.id, "volume/state", () => true, async () => { operations++; return {}; });
  socket.connected = false;
  socket.emit("close");
  await assert.rejects(confirmation, /broker disconnected/);
  assert.equal(operations, 0);
});

test("explicit shutdown cancels a confirmation before its operation starts", async () => {
  const { live } = await fixture();
  let operations = 0;
  const confirmation = live.withConfirmation(box.id, "volume/state", () => true, async () => { operations++; return {}; });
  const disconnected = live.disconnect();
  await assert.rejects(confirmation, { name: "AbortError" });
  await disconnected;
  assert.equal(operations, 0);
});

test("overlapping controls cannot claim the same uncorrelated device reply", async context => {
  const { live, send } = await fixture();
  context.after(() => live.disconnect());
  const first = live.withConfirmation(box.id, "app-reply/bedtime-state", state => state.bedtime?.stl?.state === "on", () => live.sleepTimer(box.id, 1800));
  const settled = Promise.allSettled([first]);
  context.after(() => settled);
  let duplicateOperations = 0;
  await assert.rejects(live.withConfirmation(box.id, "app-reply/bedtime-state", () => true, async () => { duplicateOperations++; return {}; }, 50), /confirmation is already pending/);
  assert.equal(duplicateOperations, 0);
  const volume = live.withConfirmation(box.id, "volume/state", state => state.volume?.level === 3, () => live.setVolume(box.id, 3));
  await new Promise(resolve => setImmediate(resolve));
  send("app-reply/bedtime-state", { stl: { state: "on", duration: 1800 } });
  send("volume/state", { level: 3 });
  assert((await first).deviceConfirmed);
  assert((await volume).deviceConfirmed);
  const next = live.withConfirmation(box.id, "app-reply/bedtime-state", state => state.bedtime?.stl?.state === "off", () => live.sleepTimer(box.id, 0));
  await new Promise(resolve => setImmediate(resolve));
  send("app-reply/bedtime-state", { stl: { state: "off" } });
  assert((await next).deviceConfirmed);
});

test("connection loss during initial subscription cannot report a ready client", async context => {
  const subscribing = deferred();
  const subscribed = deferred();
  const { live, socket, cloud } = await fixture({ disconnected: true, connector: async socket => {
    socket.subscribeAsync = async () => { subscribing.resolve(); await subscribed.promise; };
    return socket;
  } });
  context.after(() => live.disconnect());
  const connected = live.connect([box]);
  await subscribing.promise;
  socket.connected = false;
  socket.emit("close");
  subscribed.resolve();
  await assert.rejects(connected, /connection lost during subscription/);
  assert.equal(socket.closed, true);
  assert.equal(cloud.listenerCount("auth"), 0);
  assert.equal(socket.listenerCount("message"), 0);
  assert.equal(live.states.size, 0);
});

test("at most 32 commands can occupy the outgoing MQTT store", async () => {
  const { live, socket } = await fixture();
  socket.publishAsync = (...args) => { socket.published.push(args); return new Promise(() => {}); };
  const commands = Array.from({ length: 32 }, () => live.pause(box.id));
  const results = Promise.allSettled(commands);
  await assert.rejects(live.pause(box.id), /At most 32/);
  await live.disconnect();
  assert.equal((await results).filter(result => result.status === "rejected").length, 32);
  assert.equal(socket.removed.length, 32);
});

test("control admission includes telemetry preparation and releases failed slots", async context => {
  const { live, socket, send } = await fixture({ disconnected: true });
  context.after(() => live.disconnect());
  await live.connect([box]);
  const controls = Array.from({ length: 32 }, (_, index) => index % 2 ? live.skip(box.id, 1) : live.changeVolume(box.id, 1));
  const results = Promise.allSettled(controls);
  const excess = await Promise.race([
    assert.rejects(live.pause(box.id), /At most 32/).then(() => "rejected"),
    new Promise(resolve => setImmediate(() => resolve("waiting")))
  ]);
  assert.equal(excess, "rejected");
  assert.equal(socket.published.length, 0);
  send("online-state", { onlineState: "offline" });
  assert.equal((await results).filter(result => result.status === "rejected").length, 32);
  send("online-state", { onlineState: "connected" });
  assert((await live.pause(box.id)).acknowledged);
});

test("cached-state control bursts admit only 32 operations before allocating waits", async context => {
  const { live, socket } = await fixture();
  context.after(() => live.disconnect());
  let waits = 0;
  const waitForState = live.waitForState.bind(live);
  live.waitForState = (...args) => { waits++; return waitForState(...args); };
  const controls = Array.from({ length: 1000 }, () => live.pause(box.id));
  const results = await Promise.allSettled(controls);
  assert.equal(waits, 32);
  assert.equal(socket.published.length, 32);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 32);
  assert(results.filter(result => result.status === "rejected").every(result => /At most 32/.test(result.reason.message)));
  assert((await live.pause(box.id)).acknowledged);
});

test("control admission slots survive failed serialization, publishing, and session replacement", async context => {
  const { live, socket, send } = await fixture();
  context.after(() => live.disconnect());
  const circular = {};
  circular.circular = circular;
  for (let index = 0; index < 40; index++) await assert.rejects(live.command(box.id, "volume", circular), /circular/i);
  const publish = socket.publishAsync;
  socket.publishAsync = () => { throw new Error("publish failed"); };
  for (let index = 0; index < 40; index++) await assert.rejects(live.pause(box.id), /publish failed/);
  socket.publishAsync = publish;
  const pending = Promise.allSettled(Array.from({ length: 32 }, () => live.changeVolume(box.id, 1)));
  await live.disconnect();
  assert.equal((await pending).filter(result => result.status === "rejected").length, 32);
  await live.connect([box]);
  send("online-state", { onlineState: "connected" }, true);
  const next = await Promise.all(Array.from({ length: 32 }, () => live.pause(box.id)));
  assert(next.every(result => result.acknowledged));
});

test("a reconnect between cached control preparation and publish cannot replay the command", async context => {
  const { live, socket, send } = await fixture();
  context.after(() => live.disconnect());
  const command = live.pause(box.id);
  const rejected = assert.rejects(command, /broker disconnected/);
  socket.connected = false;
  socket.emit("close");
  socket.connected = true;
  socket.emit("connect");
  send("online-state", { onlineState: "connected" }, true);
  await rejected;
  assert.equal(socket.published.length, 0);
  assert((await live.pause(box.id)).acknowledged);
});

test("an offline update before cached control publication cancels the command", async context => {
  const { live, socket, send } = await fixture();
  context.after(() => live.disconnect());
  const command = live.pause(box.id);
  const rejected = assert.rejects(command, /offline/);
  send("online-state", { onlineState: "offline" });
  await rejected;
  assert.equal(socket.published.length, 0);
});

test("real MQTT transport never replays an expired command after reconnect", { timeout: 5000 }, async context => {
  const broker = memoryBroker();
  const cloud = new TonieCloudClient({ auth: { accessToken: jwt() }, fetch: async () => response({ uuid: "account" }) });
  const live = new ToniesRealtime(cloud, { connect: broker.connector, commandTimeoutMs: 100 });
  context.after(() => live.disconnect());
  await live.connect([box]);
  await live.waitForState(box.id, state => state.onlineState === "connected");
  await assert.rejects(live.pause(box.id), /timed out/);
  assert.equal(Object.keys(broker.client.outgoing).length, 0);
  assert.equal(broker.published.length, 1);
  await assert.rejects(live.withConfirmation(box.id, "playback/state", () => false, () => live.pause(box.id), 10), { name: "AbortError" });
  assert.equal(Object.keys(broker.client.outgoing).length, 0);
  assert.equal(broker.published.length, 2);
  const reconnecting = once(live, "connected");
  broker.transport.destroy();
  await reconnecting;
  await live.waitForState(box.id, state => state.onlineState === "connected");
  broker.acknowledged = true;
  await live.pause(box.id);
  assert.equal(broker.connections, 2);
  assert.equal(broker.published.length, 3);
  assert.equal(Object.keys(broker.client.outgoing).length, 0);
});

test("a denied reconnect can recover once credentials rotate", { timeout: 3000 }, async context => {
  const broker = memoryBroker();
  const cloud = new TonieCloudClient({ auth: { accessToken: "original", expiresAt: Date.now() + 3600000 }, fetch: async () => response({ uuid: "account" }) });
  const live = new ToniesRealtime(cloud, { connect: broker.connector });
  const denied = deferred();
  live.on("error", error => { if (error.code === 135) denied.resolve(); });
  context.after(() => live.disconnect());
  await live.connect([box]);
  broker.accept = password => password === "repaired";
  broker.transport.destroy();
  await denied.promise;
  const reconnected = deferred();
  live.once("connected", () => reconnected.resolve());
  await cloud.setAuth({ accessToken: "repaired", expiresAt: Date.now() + 3600000 });
  await reconnected.promise;
  assert(broker.connections >= 3);
  await live.waitForState(box.id, state => state.onlineState === "connected");
});

test("100 real MQTT connection lifecycles release listeners and retained heap", async context => {
  const broker = memoryBroker();
  const cloud = new TonieCloudClient({ auth: { accessToken: jwt() }, fetch: async () => response({ uuid: "account" }) });
  const live = new ToniesRealtime(cloud, { connect: broker.connector });
  context.after(() => live.disconnect());
  await live.connect([box]);
  await live.disconnect();
  global.gc?.();
  const baseline = process.memoryUsage().heapUsed;
  const started = performance.now();
  for (let index = 0; index < 100; index++) {
    await live.connect([box]);
    await live.waitForState(box.id, state => state.onlineState === "connected");
    await live.disconnect();
    assert.equal(live.states.size, 0);
    assert.equal(cloud.listenerCount("auth"), 0);
    assert.equal(broker.client.listenerCount("message"), 0);
    assert.equal(live.listenerCount("state"), 0);
  }
  await new Promise(resolve => setImmediate(resolve));
  global.gc?.();
  await new Promise(resolve => setImmediate(resolve));
  global.gc?.();
  const retained = process.memoryUsage().heapUsed - baseline;
  assert.equal(broker.connections, 101);
  if (global.gc) assert(retained < 2 * 1024 * 1024, `MQTT lifecycle test retained ${retained} heap bytes`);
  context.diagnostic(`100 MQTT lifecycles: ${(performance.now() - started).toFixed(1)} ms; retained heap delta ${retained} bytes${global.gc ? " after GC" : " (GC not forced)"}`);
});

test("retained snapshots and duplicate playback events never trigger false starts", async () => {
  const { live, send } = await fixture();
  const events = [];
  for (const event of ["playback-started", "playback-paused", "playback-ended", "chapter-changed", "tonie-changed", "sleep-timer-changed"]) live.on(event, () => events.push(event));
  send("playback/state", { tonie: "TONIE", chapter: 0, paused: false, ended: false }, true);
  assert.deepEqual(events, []);
  send("playback/state", { tonie: "TONIE", chapter: 0, paused: true, ended: false });
  send("playback/state", { tonie: "TONIE", chapter: 0, paused: false, ended: false });
  send("playback/state", { tonie: "TONIE", chapter: 0, paused: false, ended: false });
  send("playback/state", { tonie: "TONIE", chapter: 1, paused: false, ended: false });
  send("playback/state", { tonie: "TONIE", chapter: 1, paused: false, ended: true });
  send("app-reply/bedtime-state", { stl: { state: "on", duration: 1800 } });
  send("app-reply/bedtime-state", { stl: { state: "on", duration: 1800 } });
  assert.deepEqual(events, ["playback-paused", "playback-started", "chapter-changed", "playback-ended", "sleep-timer-changed"]);
  await live.disconnect();
});

test("playback state distinguishes stopped/download/blocked and estimates position", () => {
  assert(isPlaying({ tonie: "TONIE", paused: false }));
  assert(!isPlaying({ tonie: "TONIE", paused: false, downloading: true }));
  assert(!isPlaying({ tonie: "TONIE", paused: false, blocked: true }));
  assert.equal(playbackPosition({ chapterPositionMs: 1250 }), 1.25);
  assert.equal(playbackPosition({ chapterDuration: 100, chapterUntilMs: 90000 }, 10000), 20);
  assert.equal(playbackPosition({}), undefined);
});

test("empty retained-topic updates clear playback and offline snapshots do not keep playing state", async () => {
  const { live, socket, send } = await fixture();
  send("playback/state", { tonie: "TONIE", chapter: 0, paused: false }, true);
  socket.emit("message", "external/toniebox/AABBCCDDEEFF/playback/state", Buffer.alloc(0), { retain: false });
  assert.deepEqual(live.states.get(box.id).playback, {});
  send("playback/state", { tonie: "TONIE", chapter: 0, paused: false });
  send("online-state", { onlineState: "offline" });
  assert.equal(live.states.get(box.id).playback, undefined);
  await live.disconnect();
});

test("Toolcraft management commands preserve typed settings and required empty write bodies", async context => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.TONIES_ACCESS_TOKEN;
  const calls = [];
  process.env.TONIES_ACCESS_TOKEN = jwt();
  globalThis.fetch = async (url, init) => { calls.push({ url, ...init }); return response({ ok: true }); };
  context.after(() => {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.TONIES_ACCESS_TOKEN;
    else process.env.TONIES_ACCESS_TOKEN = previousToken;
  });
  const { createToniesSDK } = await import("../dist/index.js");
  const sdk = createToniesSDK();
  await sdk.tonieboxes.settings({ householdId: "house/hold", tonieboxId: "BOX", maxVolume: 50, skippingEnabled: false, lightringBrightness: 0 });
  assert(calls[0].url.endsWith("/households/house%2Fhold/tonieboxes/BOX"));
  assert.deepEqual(JSON.parse(calls[0].body), { maxVolume: 50, skippingEnabled: false, lightringBrightness: 0 });
  await sdk.tunes.assign({ householdId: "household", tonieId: "tonie", tuneId: "tune" });
  assert.equal(calls[1].body, "{}");
  assert.equal(calls[1].method, "PUT");
});
