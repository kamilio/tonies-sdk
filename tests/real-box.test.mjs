import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { resolveAuth, writeStorageAuth } from "../dist/client.js";
import { TonieCloudClient, isToniebox2 } from "../dist/cloud.js";
import { ToniesRealtime } from "../dist/realtime.js";

const soakSeconds = Number(process.env.TONIES_LIVE_SOAK_SECONDS ?? 420);
const validSoakDuration = Number.isInteger(soakSeconds) && soakSeconds >= 420 && soakSeconds <= 86400;

test("read-only idle MQTT survives token expiry without REST polling", {
  skip: !process.env.TONIES_LIVE_SOAK,
  timeout: validSoakDuration ? soakSeconds * 1000 + 60000 : 1000
}, async context => {
  assert(validSoakDuration, "TONIES_LIVE_SOAK_SECONDS must be an integer from 420 to 86400");
  const cloud = new TonieCloudClient({ auth: await resolveAuth(), onAuth: writeStorageAuth });
  const boxes = (await cloud.listTonieboxes()).filter(isToniebox2);
  assert(boxes.length, "The idle soak requires at least one Toniebox 2 on the account, even if it is offline");
  const realtime = new ToniesRealtime(cloud);
  const observations = { connections: 0, disconnects: 0, errors: 0, rotations: 0 };
  realtime.on("connected", () => observations.connections++);
  realtime.on("disconnected", () => observations.disconnects++);
  realtime.on("error", () => observations.errors++);
  cloud.on("auth", () => observations.rotations++);
  const memory = { baselineBytes: 0, peakBytes: 0, finalBytes: 0, samples: 0, maxStates: 0, maxAuthListeners: 0 };
  const sample = () => {
    global.gc?.();
    memory.finalBytes = process.memoryUsage().heapUsed;
    memory.peakBytes = Math.max(memory.peakBytes, memory.finalBytes);
    memory.maxStates = Math.max(memory.maxStates, realtime.states.size);
    memory.maxAuthListeners = Math.max(memory.maxAuthListeners, cloud.listenerCount("auth"));
    memory.samples++;
  };
  let sampling;
  try {
    await realtime.connect(boxes);
    const initial = cloud.auth.accessToken;
    const expiresAt = cloud.auth.expiresAt ?? JSON.parse(Buffer.from(initial.split(".")[1], "base64url").toString()).exp * 1000;
    assert(expiresAt < Date.now() + (soakSeconds - 60) * 1000, "The soak must extend past the initial token lifetime");
    for (const box of boxes) await realtime.waitForState(box.id, state => state.onlineState !== undefined && state.onlineState !== "unknown", 10000);
    await new Promise(resolve => setImmediate(resolve));
    sample();
    memory.baselineBytes = memory.finalBytes;
    sampling = setInterval(sample, 60000);
    context.diagnostic(`Observing ${boxes.length} boxes for ${soakSeconds} seconds without sending commands or polling REST state`);
    await new Promise(resolve => setTimeout(resolve, soakSeconds * 1000));
    assert.notEqual(cloud.auth.accessToken, initial, "Idle connections must renew their access token");
    assert(observations.rotations > 0);
    for (const box of boxes) {
      await realtime.waitForState(box.id, state => state.onlineState !== undefined && state.onlineState !== "unknown", 10000);
    }
    sample();
    assert.equal(memory.maxStates, boxes.length);
    assert.equal(memory.maxAuthListeners, 2);
    const retainedBytes = memory.finalBytes - memory.baselineBytes;
    if (global.gc) assert(retainedBytes < 16 * 1024 * 1024, `Idle MQTT retained ${retainedBytes} heap bytes`);
    context.diagnostic(JSON.stringify({ ...observations, states: realtime.states.size, ...memory, retainedBytes, forcedGc: Boolean(global.gc) }));
  } finally {
    clearInterval(sampling);
    await realtime.disconnect();
  }
});

test("real Toniebox 2 confirms night mode and volume and restores original state", {
  skip: !process.env.TONIES_LIVE_BOX,
  timeout: 180000
}, async context => {
  const cloud = new TonieCloudClient({ getAuth: resolveAuth });
  const box = await cloud.findToniebox(process.env.TONIES_LIVE_BOX);
  assert(isToniebox2(box));
  const realtime = new ToniesRealtime(cloud);
  let original;
  try {
    await realtime.connect([box]);
    context.diagnostic(`Waiting for ${box.id} to be awake with its night timer off`);
    original = await realtime.waitForState(box.id, state => state.onlineState === "connected" && state.bedtime?.stl?.state === "off" && Number.isInteger(state.volume?.level), 120000);
    await realtime.withConfirmation(box.id, "app-reply/bedtime-state", state => state.bedtime?.stl?.state === "on" && state.bedtime.stl.duration === 1800, () => realtime.sleepTimer(box.id, 1800));
    context.diagnostic("Native night-mode timer confirmed ON by the device");
    await realtime.withConfirmation(box.id, "app-reply/bedtime-state", state => state.bedtime?.stl?.state === "off", () => realtime.sleepTimer(box.id, 0));
    context.diagnostic("Native night-mode timer confirmed OFF by the device");
    const changed = original.volume.level > 0 ? original.volume.level - 1 : 1;
    await realtime.withConfirmation(box.id, "volume/state", state => state.volume?.level === changed, () => realtime.setVolume(box.id, changed));
    await realtime.withConfirmation(box.id, "volume/state", state => state.volume?.level === original.volume.level, () => realtime.setVolume(box.id, original.volume.level));
    context.diagnostic("Live volume confirmed and restored");
  } finally {
    try {
      if (original && realtime.states.get(box.id)?.onlineState === "connected") {
        if (realtime.states.get(box.id)?.bedtime?.stl?.state === "on") await realtime.sleepTimer(box.id, 0);
        if (realtime.states.get(box.id)?.volume?.level !== original.volume.level) await realtime.setVolume(box.id, original.volume.level);
      }
    } finally {
      await realtime.disconnect();
    }
  }
});
