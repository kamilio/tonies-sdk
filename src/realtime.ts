import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { connectAsync, type MqttClient, type IClientOptions, type IPublishPacket } from "mqtt";
import { TonieCloudClient, tonieboxCapabilities, type Toniebox } from "./cloud.js";

export const TONIES_MQTT_URL = "wss://ici.tonie.cloud/";
export const TONIES_STATE_TOPICS = [
  "online-state", "metrics/battery", "metrics/headphones", "settings-applied",
  "playback/state", "volume/state", "app-reply/bedtime-state"
] as const;

export type PlaybackState = {
  tonie?: string;
  chapter?: number;
  paused?: boolean;
  ended?: boolean;
  blocked?: boolean;
  downloading?: boolean;
  chapterDuration?: number;
  chapterPositionMs?: number;
  chapterUntilMs?: number;
  contentVersion?: number;
  [key: string]: unknown;
};

export type BedtimeTimer = { state?: "on" | "off" | "completed"; duration?: number; until?: number };
export type TonieboxState = {
  onlineState?: string;
  battery?: { percent?: number; status?: string };
  headphones?: Record<string, unknown>;
  playback?: PlaybackState;
  volume?: { level?: number; hardwarePercentage?: number };
  bedtime?: { stl?: BedtimeTimer; [key: string]: unknown };
  settingsApplied?: boolean;
};

export type TonieboxEvent = {
  boxId: string;
  topic: string;
  payload: Record<string, unknown>;
  retained: boolean;
  state: TonieboxState;
  previous: TonieboxState;
};

export function isPlaying(playback?: PlaybackState): boolean {
  return Boolean(playback?.tonie && playback.paused === false && !playback.ended && !playback.blocked && !playback.downloading);
}

export function playbackPosition(playback: PlaybackState, now = Date.now()): number | undefined {
  if (typeof playback.chapterPositionMs === "number") return Math.max(0, playback.chapterPositionMs / 1000);
  if (typeof playback.chapterDuration === "number" && typeof playback.chapterUntilMs === "number") {
    return Math.max(0, Math.min(playback.chapterDuration, playback.chapterDuration - (playback.chapterUntilMs - now) / 1000));
  }
  return undefined;
}

export class ToniesRealtime extends EventEmitter {
  readonly states = new Map<string, TonieboxState>();
  private connection?: MqttClient;
  private boxes = new Map<string, Toniebox>();
  private readonly authListener = (auth: { accessToken?: string }) => {
    if (this.connection) this.connection.options.password = auth.accessToken;
  };

  constructor(readonly cloud: TonieCloudClient, private readonly options: {
    connect?: (url: string, options: IClientOptions) => Promise<MqttClient>;
    reconnectPeriod?: number;
    timeoutMs?: number;
  } = {}) { super(); }

  async connect(boxes: Toniebox[]): Promise<void> {
    assert(!this.connection, "Realtime client is already connected");
    const supported = boxes.filter(box => tonieboxCapabilities(box).realtime);
    assert(supported.length, "These Tonieboxes do not support realtime controls");
    for (const box of supported) this.boxes.set(box.id, box);
    const me = await this.cloud.request<{ uuid?: string; id?: string }>("GET", "/me");
    const username = me.uuid ?? me.id;
    assert(username, "Tonies account has no MQTT identity");
    this.connection = await (this.options.connect ?? connectAsync)(TONIES_MQTT_URL, {
      protocolVersion: 5,
      clientId: `${username}_tonies_sdk_${randomUUID()}`,
      username,
      password: await this.cloud.accessToken(),
      reconnectPeriod: this.options.reconnectPeriod ?? 5000,
      connectTimeout: this.options.timeoutMs ?? 15000,
      clean: true
    });
    this.cloud.on("auth", this.authListener);
    this.connection.on("message", (topic, payload, packet) => this.receive(topic, payload, packet));
    this.connection.on("connect", () => this.emit("connected"));
    this.connection.on("offline", () => this.emit("disconnected"));
    this.connection.on("close", () => this.emit("disconnected"));
    this.connection.on("error", error => this.emit("error", error));
    const topics = supported.flatMap(box => TONIES_STATE_TOPICS.map(topic => this.topic(box, topic)));
    await this.connection.subscribeAsync(topics, { qos: 1 });
    this.emit("connected");
  }

  private topic(box: Toniebox, suffix: string): string {
    return `external/toniebox/${box.macAddress.toUpperCase()}/${suffix}`;
  }

  receive(topic: string, bytes: Buffer, packet: Pick<IPublishPacket, "retain">): void {
    const box = [...this.boxes.values()].find(box => topic.startsWith(this.topic(box, "")));
    if (!box) return;
    const suffix = topic.slice(this.topic(box, "").length);
    const payload = (bytes.length ? JSON.parse(bytes.toString()) : {}) as Record<string, unknown>;
    const previous = this.states.get(box.id) ?? {};
    const state = { ...previous };
    if (suffix === "online-state") {
      state.onlineState = payload.onlineState as string;
      if (state.onlineState !== "connected") state.playback = undefined;
    }
    if (suffix === "metrics/battery") state.battery = payload;
    if (suffix === "metrics/headphones") state.headphones = payload;
    if (suffix === "settings-applied") state.settingsApplied = true;
    if (suffix === "playback/state") state.playback = payload;
    if (suffix === "volume/state") state.volume = payload;
    if (suffix === "app-reply/bedtime-state") state.bedtime = payload;
    this.states.set(box.id, state);
    const event: TonieboxEvent = { boxId: box.id, topic: suffix, payload, retained: packet.retain, state, previous };
    this.emit("state", event);
    if (packet.retain) return;
    if (suffix === "playback/state") {
      if (isPlaying(state.playback) && !isPlaying(previous.playback)) this.emit("playback-started", event);
      if (state.playback?.paused === true && previous.playback?.paused === false) this.emit("playback-paused", event);
      if (state.playback?.ended === true && previous.playback?.ended === false) this.emit("playback-ended", event);
      if (previous.playback && state.playback?.tonie !== previous.playback.tonie) this.emit("tonie-changed", event);
      if (previous.playback && state.playback?.chapter !== previous.playback.chapter) this.emit("chapter-changed", event);
    }
    if (suffix === "app-reply/bedtime-state" && state.bedtime?.stl?.state !== previous.bedtime?.stl?.state) this.emit("sleep-timer-changed", event);
    if (suffix === "online-state" && state.onlineState !== previous.onlineState) this.emit("online-changed", event);
  }

  async waitForState(boxId: string, predicate: (state: TonieboxState) => boolean, timeoutMs = 10000): Promise<TonieboxState> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      while (!predicate(this.states.get(boxId) ?? {})) await once(this, "state", { signal: controller.signal });
      return this.states.get(boxId)!;
    } finally {
      clearTimeout(timer);
    }
  }

  async command(boxId: string, command: string, payload: Record<string, unknown>) {
    const box = this.boxes.get(boxId);
    assert(box && this.connection, "Connect to this Toniebox first");
    assert(/^[a-z][a-z0-9-]*$/.test(command), "Invalid control topic");
    const state = await this.waitForState(boxId, state => state.onlineState !== undefined);
    assert.equal(state.onlineState, "connected", "Toniebox is offline; cloud wake is not supported");
    assert(this.connection.connected, "Tonies realtime broker is disconnected; commands are not queued");
    const topic = this.topic(box, `app-control/${command}`);
    await this.connection.publishAsync(topic, JSON.stringify(payload), {
      qos: 1, retain: false, properties: { messageExpiryInterval: 10 }
    });
    return { boxId, command, payload, acknowledged: true, deviceConfirmed: false };
  }

  private requireFeature(boxId: string, feature: string): void {
    assert(this.boxes.get(boxId)?.features.includes(feature), `Toniebox does not support ${feature}`);
  }

  play(boxId: string) {
    this.requireFeature(boxId, "playbackControls");
    return this.command(boxId, "playback", { action: "start" });
  }

  pause(boxId: string) {
    this.requireFeature(boxId, "playbackControls");
    return this.command(boxId, "playback", { action: "pause" });
  }

  seek(boxId: string, chapter: number, ms = 0) {
    this.requireFeature(boxId, "playbackControls");
    assert(Number.isInteger(chapter) && chapter >= 0 && Number.isInteger(ms) && ms >= 0, "Use a zero-based chapter and nonnegative milliseconds");
    return this.command(boxId, "playback", { action: "setPosition", chapter, ms });
  }

  async skip(boxId: string, offset: -1 | 1) {
    const state = await this.waitForState(boxId, state => Number.isInteger(state.playback?.chapter));
    return this.seek(boxId, Math.max(0, state.playback!.chapter! + offset));
  }

  setVolume(boxId: string, level: number) {
    this.requireFeature(boxId, "playbackControls");
    assert(Number.isInteger(level) && level >= 0 && level <= 13, "Volume level must be an integer from 0 to 13");
    return this.command(boxId, "volume", { level });
  }

  async changeVolume(boxId: string, offset: -1 | 1) {
    const state = await this.waitForState(boxId, state => Number.isInteger(state.volume?.level));
    return this.setVolume(boxId, Math.max(0, Math.min(13, state.volume!.level! + offset)));
  }

  sleepTimer(boxId: string, seconds: number) {
    this.requireFeature(boxId, "sleepTimerAlarm");
    assert(Number.isInteger(seconds) && seconds >= 0, "Sleep timer must be nonnegative seconds; 0 cancels it");
    return this.command(boxId, "stl", seconds ? { state: "on", duration: seconds } : { state: "off" });
  }

  async sleep(boxId: string) {
    await this.sleepTimer(boxId, 300);
    return this.command(boxId, "sleep", {});
  }

  async disconnect(): Promise<void> {
    this.cloud.off("auth", this.authListener);
    const connection = this.connection;
    this.connection = undefined;
    await connection?.endAsync(true);
    this.boxes.clear();
    this.states.clear();
  }
}
