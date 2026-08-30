import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { resolveAuth } from "../dist/client.js";
import { TonieCloudClient, isToniebox2 } from "../dist/cloud.js";
import { ToniesRealtime } from "../dist/realtime.js";

test("real Toniebox 2 confirms night mode and volume and restores original state", {
  skip: !process.env.TONIES_LIVE_BOX,
  timeout: 180000
}, async context => {
  const cloud = new TonieCloudClient({ getAuth: resolveAuth });
  const box = await cloud.findToniebox(process.env.TONIES_LIVE_BOX);
  assert(isToniebox2(box));
  const realtime = new ToniesRealtime(cloud);
  const refresh = setInterval(() => cloud.accessToken(), 30000);
  let original;
  try {
    await realtime.connect([box]);
    context.diagnostic(`Waiting for ${box.id} to be awake with its night timer off`);
    original = await realtime.waitForState(box.id, state => state.onlineState === "connected" && state.bedtime?.stl?.state === "off" && Number.isInteger(state.volume?.level), 120000);
    await realtime.sleepTimer(box.id, 1800);
    await realtime.waitForState(box.id, state => state.bedtime?.stl?.state === "on");
    context.diagnostic("Native night-mode timer confirmed ON by the device");
    await realtime.sleepTimer(box.id, 0);
    await realtime.waitForState(box.id, state => state.bedtime?.stl?.state === "off");
    context.diagnostic("Native night-mode timer confirmed OFF by the device");
    const lower = Math.max(0, original.volume.level - 1);
    await realtime.setVolume(box.id, lower);
    await realtime.waitForState(box.id, state => state.volume?.level === lower);
    await realtime.setVolume(box.id, original.volume.level);
    await realtime.waitForState(box.id, state => state.volume?.level === original.volume.level);
    context.diagnostic("Live volume confirmed and restored");
  } finally {
    clearInterval(refresh);
    if (original && realtime.states.get(box.id)?.onlineState === "connected") {
      if (realtime.states.get(box.id)?.bedtime?.stl?.state === "on") await realtime.sleepTimer(box.id, 0);
      if (realtime.states.get(box.id)?.volume?.level !== original.volume.level) await realtime.setVolume(box.id, original.volume.level);
    }
    await realtime.disconnect();
  }
});
