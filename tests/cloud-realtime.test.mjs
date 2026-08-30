import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { TonieCloudClient, isToniebox2, tonieboxCapabilities, toniesPath } from "../dist/cloud.js";
import { ToniesRealtime, isPlaying, playbackPosition, TONIES_STATE_TOPICS } from "../dist/realtime.js";

const box = { id: "BOX2", householdId: "household", name: "Test", macAddress: "aabbccddeeff", generation: "tng", product: "tb2", features: ["playbackControls", "sleepTimerAlarm", "tngSettings"], maxVolume: 75, maxHeadphoneVolume: 50 };
const jwt = () => `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
const response = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

async function fixture(options = {}) {
  const requests = [];
  const cloud = new TonieCloudClient({ auth: { accessToken: jwt() }, fetch: async (url, init) => {
    requests.push({ url, ...init });
    return response({ uuid: "account" });
  } });
  const socket = new EventEmitter();
  socket.options = {};
  socket.published = [];
  socket.subscribeAsync = async (topics, settings) => { socket.subscriptions = { topics, settings }; };
  socket.publishAsync = async (...args) => { socket.published.push(args); };
  socket.endAsync = async () => { socket.closed = true; };
  const live = new ToniesRealtime(cloud, { connect: async (url, settings) => { socket.url = url; socket.options = settings; return socket; }, reconnectPeriod: 0 });
  await live.connect([options.box ?? box]);
  const send = (topic, payload, retain = false) => socket.emit("message", `external/toniebox/AABBCCDDEEFF/${topic}`, Buffer.from(JSON.stringify(payload)), { retain });
  send("online-state", { onlineState: options.offline ? "offline" : "connected" }, true);
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
