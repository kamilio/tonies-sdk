import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
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

type RealtimeSession = {
  controller: AbortController;
  commands: Map<number, () => void>;
  brokerOnline: boolean;
  connection?: MqttClient;
  dispose?: () => void;
  ending?: Promise<void>;
};

type StateWaiter = { notify: (event: TonieboxEvent) => void; reject: (error: unknown) => void };

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
  private session?: RealtimeSession;
  private boxes = new Map<string, Toniebox>();
  private routes = new Map<string, { boxId: string; suffix: string }>();
  private waiters = new Map<string, Set<StateWaiter>>();
  private waiterCount = 0;
  private readonly stateWaitListener = async (event: TonieboxEvent) => {
    for (const waiter of this.waiters.get(event.boxId) ?? []) waiter.notify(event);
  };
  private readonly errorWaitListener = (error: unknown) => {
    for (const waiters of this.waiters.values()) for (const waiter of waiters) waiter.reject(error);
  };

  constructor(readonly cloud: TonieCloudClient, private readonly options: {
    connect?: (url: string, options: IClientOptions) => Promise<MqttClient>;
    reconnectPeriod?: number;
    timeoutMs?: number;
    commandTimeoutMs?: number;
  } = {}) {
    super({ captureRejections: true });
    this.on("message", async (topic: string, bytes: Buffer, packet: Pick<IPublishPacket, "retain">) => this.receive(topic, bytes, packet));
  }

  async connect(boxes: Toniebox[]): Promise<void> {
    assert(!this.session, "Realtime client is already connected or connecting");
    const supported = boxes.filter(box => tonieboxCapabilities(box).realtime);
    assert(supported.length, "These Tonieboxes do not support realtime controls");
    const session: RealtimeSession = { controller: new AbortController(), commands: new Map(), brokerOnline: false };
    this.session = session;
    let ready = false;
    try {
      const me = await this.cloud.request<{ uuid?: string; id?: string }>("GET", "/me");
      session.controller.signal.throwIfAborted();
      const username = me.uuid ?? me.id;
      assert(username, "Tonies account has no MQTT identity");
      const password = await this.cloud.accessToken();
      session.controller.signal.throwIfAborted();
      const connection = await (this.options.connect ?? connectAsync)(TONIES_MQTT_URL, {
        protocolVersion: 5,
        clientId: `${username}_tonies_sdk_${randomUUID()}`,
        username, password,
        reconnectPeriod: this.options.reconnectPeriod ?? 5000,
        reconnectOnConnackError: true,
        connectTimeout: this.options.timeoutMs ?? 15000,
        clean: true
      });
      session.connection = connection;
      session.controller.signal.throwIfAborted();
      this.connection = connection;
      for (const box of supported) {
        this.boxes.set(box.id, box);
        for (const suffix of TONIES_STATE_TOPICS) this.routes.set(this.topic(box, suffix), { boxId: box.id, suffix });
      }
      const auth = (auth: { accessToken?: string }) => { connection.options.password = auth.accessToken; };
      const message = (topic: string, payload: Buffer, packet: IPublishPacket) => {
        if (!session.controller.signal.aborted) this.emit("message", topic, payload, packet);
      };
      const connected = () => {
        session.brokerOnline = true;
        this.emit("connected");
      };
      const disconnected = () => {
        if (!session.brokerOnline) return;
        session.brokerOnline = false;
        for (const cancel of session.commands.values()) cancel();
        for (const [boxId, previous] of this.states) {
          const state = { onlineState: "unknown" };
          this.states.set(boxId, state);
          this.emit("state", { boxId, topic: "connection", payload: {}, retained: true, previous, state });
        }
        this.emit("disconnected");
      };
      const error = (error: Error) => this.emit("error", error);
      this.cloud.on("auth", auth);
      connection.on("message", message);
      connection.on("connect", connected);
      connection.on("offline", disconnected);
      connection.on("close", disconnected);
      connection.on("error", error);
      session.dispose = () => {
        this.cloud.off("auth", auth);
        connection.off("message", message);
        connection.off("connect", connected);
        connection.off("offline", disconnected);
        connection.off("close", disconnected);
        connection.off("error", error);
      };
      await connection.subscribeAsync([...this.routes.keys()], { qos: 1 });
      session.controller.signal.throwIfAborted();
      ready = true;
      connected();
    } finally {
      if (!ready) {
        if (this.session === session) await this.disconnect();
        else await this.closeSession(session);
      }
    }
  }

  private topic(box: Toniebox, suffix: string): string {
    return `external/toniebox/${box.macAddress.toUpperCase()}/${suffix}`;
  }

  receive(topic: string, bytes: Buffer, packet: Pick<IPublishPacket, "retain">): void {
    const route = this.routes.get(topic);
    if (!route) return;
    const { boxId, suffix } = route;
    assert(bytes.length <= 65536, "Toniebox state payload exceeds 64 KiB");
    const payload = (bytes.length ? JSON.parse(bytes.toString()) : {}) as Record<string, unknown>;
    assert(payload && typeof payload === "object" && !Array.isArray(payload), "Toniebox state must be a JSON object");
    const previous = this.states.get(boxId) ?? {};
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
    this.states.set(boxId, state);
    const event: TonieboxEvent = { boxId, topic: suffix, payload, retained: packet.retain, state, previous };
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

  async waitForState(boxId: string, predicate: (state: TonieboxState) => boolean, timeoutMs = 10000, options: {
    fresh?: boolean;
    live?: boolean;
    topic?: typeof TONIES_STATE_TOPICS[number];
    signal?: AbortSignal;
  } = {}): Promise<TonieboxState> {
    assert(this.session && this.boxes.has(boxId), "Connect to this Toniebox first");
    options.signal?.throwIfAborted();
    const current = this.states.get(boxId) ?? {};
    if (!options.fresh && !options.live && predicate(current)) return current;
    assert(this.waiterCount < 256, "At most 256 state confirmations may wait concurrently");
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.session.controller.signal, ...options.signal ? [options.signal] : []]);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let resolveState!: (state: TonieboxState) => void;
    let rejectState!: (error: unknown) => void;
    let settled = false;
    const waiting = new Promise<TonieboxState>((resolve, reject) => { resolveState = resolve; rejectState = reject; });
    const notify = (event: TonieboxEvent) => {
      if (settled || event.boxId !== boxId || (options.topic && event.topic !== options.topic) || (options.live && event.retained)) return;
      settled = true;
      if (predicate(event.state)) resolveState(event.state);
      else settled = false;
    };
    const errorListener = (error: unknown) => { settled = true; rejectState(error); };
    const abort = () => errorListener(signal.reason);
    const waiter = { notify, reject: errorListener };
    const waiters = this.waiters.get(boxId) ?? new Set<StateWaiter>();
    this.waiters.set(boxId, waiters);
    waiters.add(waiter);
    if (this.waiterCount++ === 0) {
      this.on("state", this.stateWaitListener);
      this.on("error", this.errorWaitListener);
    }
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      return await waiting;
    } finally {
      clearTimeout(timer);
      waiters.delete(waiter);
      if (!waiters.size) this.waiters.delete(boxId);
      if (--this.waiterCount === 0) {
        this.off("state", this.stateWaitListener);
        this.off("error", this.errorWaitListener);
      }
      signal.removeEventListener("abort", abort);
    }
  }

  async withConfirmation<Result extends object>(boxId: string, topic: typeof TONIES_STATE_TOPICS[number], predicate: (state: TonieboxState) => boolean, operation: () => Promise<Result>, timeoutMs = 10000) {
    assert(this.session && this.boxes.has(boxId), "Connect to this Toniebox first");
    assert(TONIES_STATE_TOPICS.includes(topic), "Confirm against a subscribed state topic");
    assert(this.waiterCount < 256, "At most 256 state confirmations may wait concurrently");
    const controller = new AbortController();
    const confirmed = this.waitForState(boxId, predicate, timeoutMs, { fresh: true, live: true, topic, signal: controller.signal });
    try {
      const [result, state] = await Promise.all([Promise.resolve().then(operation), confirmed]);
      return { ...result, state, deviceConfirmed: true as const };
    } finally {
      controller.abort();
    }
  }

  async command(boxId: string, command: string, payload: Record<string, unknown>) {
    const box = this.boxes.get(boxId);
    const connection = this.connection;
    const session = this.session;
    assert(box && connection && session, "Connect to this Toniebox first");
    assert(/^[a-z][a-z0-9-]*$/.test(command), "Invalid control topic");
    const state = await this.waitForState(boxId, state => state.onlineState !== undefined);
    assert.equal(state.onlineState, "connected", "Toniebox is offline; cloud wake is not supported");
    assert(this.connection === connection && connection.connected && session.brokerOnline, "Tonies realtime broker is disconnected; commands are not queued");
    assert(session.commands.size < 32, "At most 32 Toniebox commands may await acknowledgment");
    const topic = this.topic(box, `app-control/${command}`);
    const published = connection.publishAsync(topic, JSON.stringify(payload), {
      qos: 1, retain: false, properties: { messageExpiryInterval: 10 }
    });
    const messageId = connection.getLastMessageId();
    let cancel!: () => void;
    const interrupted = new Promise<never>((resolve, reject) => {
      cancel = () => {
        reject(new Error("Toniebox command acknowledgment interrupted or timed out; command removed from the outgoing queue"));
        connection.removeOutgoingMessage(messageId);
      };
    });
    session.commands.set(messageId, cancel);
    const timer = setTimeout(cancel, this.options.commandTimeoutMs ?? 10000);
    try {
      await Promise.race([published, interrupted]);
    } finally {
      clearTimeout(timer);
      session.commands.delete(messageId);
    }
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
    const session = this.session;
    this.session = undefined;
    this.connection = undefined;
    this.boxes.clear();
    this.routes.clear();
    this.states.clear();
    if (session) await this.closeSession(session);
  }

  private async closeSession(session: RealtimeSession): Promise<void> {
    session.controller.abort();
    for (const cancel of session.commands.values()) cancel();
    session.dispose?.();
    if (session.connection) session.ending ??= session.connection.endAsync(true);
    await session.ending;
  }
}
