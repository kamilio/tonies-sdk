import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

export const TONIES_API_URL = "https://api.prod.tcs.toys/v2";
export const TONIES_TOKEN_URL = "https://login.tonies.com/auth/realms/tonies/protocol/openid-connect/token";
export const TONIES_OPENAPI_URL = "https://api.tonie.cloud/v2/doc/?format=openapi";

export type ToniesAuth = {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: number;
};

export type Toniebox = {
  id: string;
  householdId: string;
  name: string;
  macAddress: string;
  generation: string;
  product: string;
  features: string[];
  maxVolume: number;
  maxHeadphoneVolume: number;
  settingsApplied?: boolean;
  firmwareVersion?: string;
  offlineMode?: boolean;
  [key: string]: unknown;
};

export type TonieboxSettings = {
  name?: string;
  maxVolume?: 25 | 50 | 75 | 100;
  maxHeadphoneVolume?: 25 | 50 | 75 | 100;
  ledLevel?: "on" | "off" | "dimmed";
  accelerometerEnabled?: boolean;
  tapDirection?: "left" | "right";
  ageMode?: "1+" | "3+";
  language?: "de" | "en" | "en-us" | "fr" | null;
  timezone?: string;
  lightringBrightness?: number;
  bedtimeLightringBrightness?: number;
  bedtimeLightringColor?: string;
  bedtimeMaxVolume?: number;
  bedtimeMaxHeadphoneVolume?: number;
  skippingEnabled?: boolean | null;
  skippingDirection?: "left" | "right" | null;
  scrubbingEnabled?: boolean | null;
  reset?: boolean;
};

export type OpenApiParameter = {
  name: string;
  in: string;
  required?: boolean;
  type?: string;
  description?: string;
  schema?: unknown;
};

export type OpenApiOperation = {
  operationId: string;
  description?: string;
  parameters?: OpenApiParameter[];
};

export type ToniesOpenApi = {
  swagger: string;
  paths: Record<string, { parameters?: OpenApiParameter[] } & Record<string, unknown>>;
  definitions: Record<string, unknown>;
};

export function toniesPath(...segments: string[]): string {
  return `/${segments.map(encodeURIComponent).join("/")}`;
}

export function isToniebox2(box: Toniebox): boolean {
  return box.product === "tb2" && box.generation === "tng";
}

export function tonieboxCapabilities(box: Toniebox) {
  return {
    toniebox2: isToniebox2(box),
    realtime: box.generation === "tng",
    playback: box.features.includes("playbackControls"),
    sleepTimer: box.features.includes("sleepTimerAlarm"),
    nightSettings: box.features.includes("tngSettings"),
    bluetoothHeadphones: box.features.includes("bluetoothHeadphones"),
    automaticContentSync: box.features.includes("automaticFreshnessCheck"),
    remoteWake: false,
    features: box.features
  };
}

export class TonieCloudClient extends EventEmitter {
  auth: ToniesAuth;
  private readonly fetcher: typeof fetch;
  private refreshing?: Promise<ToniesAuth>;

  constructor(private readonly options: {
    auth?: ToniesAuth;
    getAuth?: () => Promise<ToniesAuth>;
    onAuth?: (auth: ToniesAuth) => void | Promise<void>;
    fetch?: typeof fetch;
    timeoutMs?: number;
  } = {}) {
    super();
    this.auth = options.auth ?? {};
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  private async token(body: URLSearchParams): Promise<ToniesAuth> {
    const response = await this.fetcher(TONIES_TOKEN_URL, {
      method: "POST", body, signal: AbortSignal.timeout(this.options.timeoutMs ?? 15000)
    });
    assert(response.ok, `Tonies authentication failed (HTTP ${response.status})`);
    const token = await response.json() as { access_token: string; refresh_token?: string; id_token?: string; expires_in: number };
    assert(token.access_token, "Tonies did not return an access token");
    this.auth = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? this.auth.refreshToken,
      idToken: token.id_token,
      expiresAt: Date.now() + token.expires_in * 1000
    };
    await this.options.onAuth?.(this.auth);
    this.emit("auth", this.auth);
    return this.auth;
  }

  async login(email: string, password: string): Promise<ToniesAuth> {
    return this.token(new URLSearchParams({
      grant_type: "password", client_id: "my-tonies", username: email, password,
      scope: "openid email profile"
    }));
  }

  async refresh(): Promise<ToniesAuth> {
    if (this.options.getAuth) {
      this.auth = await this.options.getAuth();
      this.emit("auth", this.auth);
      return this.auth;
    }
    assert(this.auth.refreshToken, "Sign in to Tonies first");
    this.refreshing ??= this.token(new URLSearchParams({
      grant_type: "refresh_token", client_id: "my-tonies", refresh_token: this.auth.refreshToken
    })).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  async accessToken(): Promise<string> {
    if (this.options.getAuth) {
      const previousToken = this.auth.accessToken;
      this.auth = await this.options.getAuth();
      if (previousToken !== this.auth.accessToken) this.emit("auth", this.auth);
    }
    const expiry = this.auth.expiresAt ?? (this.auth.accessToken
      ? JSON.parse(Buffer.from(this.auth.accessToken.split(".")[1], "base64url").toString()).exp * 1000
      : 0);
    if (!this.auth.accessToken || expiry < Date.now() + 30000) await this.refresh();
    assert(this.auth.accessToken, "Sign in to Tonies first");
    return this.auth.accessToken;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    assert(path.startsWith("/") && !path.startsWith("//"), "Use an API-relative path");
    const perform = async () => this.fetcher(`${TONIES_API_URL}${path}`, {
      method: method.toUpperCase(),
      headers: { Authorization: `Bearer ${await this.accessToken()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15000)
    });
    let response = await perform();
    if (response.status === 401 && !this.options.getAuth) {
      await this.refresh();
      response = await perform();
    }
    assert(response.ok, `Tonies ${method} ${path} failed (HTTP ${response.status})`);
    const text = await response.text();
    return (text ? JSON.parse(text) : { status: response.status }) as T;
  }

  async graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const result = await this.request<{ data: T; errors?: unknown[] }>("POST", "/graphql", { query, variables });
    assert(!result.errors?.length, `Tonies GraphQL: ${JSON.stringify(result.errors)}`);
    assert(result.data !== undefined, "Tonies returned no GraphQL data");
    return result.data;
  }

  async listTonieboxes(): Promise<Toniebox[]> {
    const result = await this.graphql<{ households: Array<{ id: string; tonieboxes: Toniebox[] }> }>(`{
      households { id tonieboxes {
        id householdId name macAddress generation product features maxVolume maxHeadphoneVolume
        firmwareVersion offlineMode settingsApplied
      } }
    }`);
    return result.households.flatMap(household => household.tonieboxes.map(box => ({ ...box, householdId: household.id })));
  }

  async findToniebox(id: string): Promise<Toniebox> {
    const boxes = await this.listTonieboxes();
    const matches = boxes.filter(box => box.id.toUpperCase() === id.toUpperCase() || `${box.householdId}/${box.id}`.toUpperCase() === id.toUpperCase());
    assert.equal(matches.length, 1, `Expected exactly one Toniebox matching ${id}`);
    return matches[0];
  }

  getToniebox(householdId: string, id: string): Promise<Toniebox> {
    return this.request("GET", toniesPath("households", householdId, "tonieboxes", id));
  }

  setTonieboxSettings(householdId: string, id: string, settings: TonieboxSettings): Promise<Toniebox> {
    return this.request("PATCH", toniesPath("households", householdId, "tonieboxes", id), settings);
  }

  playbackInfo(boxId: string, tonieId: string, contentVersion = 0) {
    return this.request("GET", `${toniesPath("playback-info", boxId, tonieId)}?contentVersion=${contentVersion}`);
  }

  async openApi(): Promise<ToniesOpenApi> {
    const response = await this.fetcher(TONIES_OPENAPI_URL, { signal: AbortSignal.timeout(this.options.timeoutMs ?? 15000) });
    assert(response.ok, `Tonies OpenAPI HTTP ${response.status}`);
    return response.json() as Promise<ToniesOpenApi>;
  }

  async operations() {
    const spec = await this.openApi();
    return Object.entries(spec.paths).flatMap(([path, methods]) => Object.entries(methods)
      .filter(([method]) => ["get", "post", "put", "patch", "delete", "head", "options"].includes(method))
      .map(([method, value]) => {
        const operation = value as OpenApiOperation;
        const parameters = new Map([...(methods.parameters ?? []), ...(operation.parameters ?? [])].map(parameter => [`${parameter.in}/${parameter.name}`, parameter]));
        return { ...operation, method: method.toUpperCase(), path, parameters: [...parameters.values()] };
      }));
  }

  async operation(id: string, parameters: Record<string, unknown> = {}, body?: unknown) {
    const operation = (await this.operations()).find(operation => operation.operationId === id);
    assert(operation, `Unknown Tonies operation ${id}`);
    let path = operation.path;
    const query = new URLSearchParams();
    for (const parameter of operation.parameters) {
      const value = parameter.in === "body" ? body : parameters[parameter.name];
      assert(!parameter.required || value !== undefined, `Missing ${parameter.in} parameter ${parameter.name}`);
      if (value === undefined) continue;
      if (parameter.in === "path") path = path.replace(`{${parameter.name}}`, encodeURIComponent(String(value)));
      if (parameter.in === "query") query.set(parameter.name, String(value));
    }
    return this.request(operation.method, `${path}${query.size ? `?${query}` : ""}`, body);
  }
}
