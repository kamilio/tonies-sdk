import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { promisify } from "node:util";
import { ClassicLevel } from "classic-level";
import { parseFile } from "music-metadata";
import YAML from "yaml";
import { creativeTonieDetailQuery, listCreativeToniesQuery } from "./queries.js";

export type Chapter = {
  id: string;
  file: string;
  title: string;
  seconds: number;
  thumbnail?: string;
  transcoding?: boolean;
  type?: string;
};

export type RuntimeAuth = {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
};

export type PasswordLoginOptions = {
  email?: string;
  password?: string;
};

export type LocalTrack = {
  path: string;
  directory: string;
  relativePath: string;
  title: string;
  seconds: number;
  size: number;
  fingerprint: string;
};

export type SyncManifestEntry = {
  fingerprint: string;
  file: string;
  id: string;
  title: string;
  seconds: number;
  size: number;
  path?: string;
  updatedAt: string;
};

export type SyncManifest = {
  version: 1;
  targets: Record<string, SyncManifestEntry[]>;
};

export type RemoteSnapshot = {
  version: 1;
  capturedAt: string;
  householdId: string;
  creativeTonieId: string;
  key: string;
  remoteCount: number;
  tonie: CreativeTonie;
};

export type DirectorySyncPlan = {
  targetKey: string;
  desired: LocalTrack[];
  remote: Chapter[];
  chapterSlots: Array<Chapter | null>;
  reused: Array<{ index: number; track: LocalTrack; chapter: Chapter; reason: string }>;
  uploads: Array<{ index: number; track: LocalTrack }>;
  deletes: Chapter[];
  changed: boolean;
};

export type SyncVerification = {
  ok: boolean;
  mismatches: string[];
};

export type SyncTargetInput = string | {
  codename?: string;
  id?: string;
  tonieId?: string;
  creativeTonieId?: string;
  householdId?: string;
  household_id?: string;
};

export type CreativeTonie = {
  id: string;
  name: string;
  live: boolean;
  private: boolean;
  secondsRemaining: number;
  secondsPresent: number;
  chapters: Chapter[];
};

export type DetailData = {
  households: Array<{
    id: string;
    name: string;
    creativeTonies: CreativeTonie[];
  }>;
};

export type ListData = {
  households: Array<{
    id: string;
    name: string;
    creativeTonies: Array<{
      id: string;
      name: string;
      live: boolean;
      private: boolean;
      secondsPresent: number;
      secondsRemaining: number;
      chaptersPresent: number;
    }>;
  }>;
};

export type SyncRunOptions = {
  manifestPath?: string;
  dryRun?: boolean;
  verifyAttempts?: number;
  verifyDelayMs?: number;
  baseDirectory?: string;
  forceUpload?: boolean;
};

const apiBaseUrl = "https://api.prod.tcs.toys/v2";
const tokenUrl = "https://login.tonies.com/auth/realms/tonies/protocol/openid-connect/token";
const audioExtensions = new Set([".mp3", ".m4a", ".m4b", ".aac", ".wav", ".flac", ".ogg", ".oga", ".opus", ".wma", ".aif", ".aiff"]);
export const DEFAULT_STORAGE_PATH = ".tonies-storage.json";
export const DEFAULT_PROFILE_PATH = ".tonies-sdk-profile";

export type TonieIdentity = {
  householdId: string;
  id: string;
  codename: string;
  aliases: string[];
  name: string;
  present: boolean;
  firstSeen: string;
  lastSeen: string;
  announcement?: { codename: string; chapter: Chapter };
  pendingAnnouncement?: { codename: string; chapter: Chapter };
};

export type IdentityDatabase = {
  version: 1;
  remainingAnimals: string[];
  identities: Record<string, TonieIdentity>;
  log: Array<{ at: string; key: string; codename: string; previous?: string }>;
};

const animals = `fox bear otter owl panda tiger lion wolf rabbit deer badger beaver
  hedgehog squirrel raccoon koala kangaroo wombat possum platypus echidna wallaby
  elephant giraffe zebra hippo rhino buffalo bison moose elk antelope gazelle
  camel llama alpaca horse donkey pony goat sheep cow pig dog cat mouse hamster
  gerbil chinchilla ferret meerkat mongoose lemur monkey gorilla chimpanzee
  orangutan gibbon sloth armadillo anteater aardvark pangolin tapir okapi capybara
  porcupine marmot groundhog chipmunk shrew mole bat lynx bobcat cougar jaguar
  leopard cheetah ocelot caracal serval hyena jackal coyote dingo wolverine
  marten mink stoat weasel sable skunk seal walrus sea-lion dolphin porpoise
  whale narwhal beluga orca manatee dugong penguin puffin pelican flamingo
  swan goose duck mallard heron crane stork ibis spoonbill egret ostrich emu
  cassowary kiwi eagle falcon hawk kestrel osprey condor vulture raven crow
  magpie jay robin sparrow finch canary cardinal bluebird blackbird thrush
  lark wren swallow swift hummingbird kingfisher woodpecker toucan hornbill
  parrot macaw cockatoo budgie pigeon dove peacock pheasant quail turkey
  chicken rooster grouse albatross petrel gull tern sandpiper lapwing curlew
  plover avocet turtle tortoise gecko lizard iguana chameleon dragon crocodile
  alligator caiman snake python cobra viper boa frog toad newt salamander
  axolotl fish salmon trout tuna cod haddock halibut flounder sole eel
  seahorse clownfish angelfish butterflyfish goldfish guppy carp koi pike
  perch bass catfish swordfish marlin sailfish shark ray manta stingray
  octopus squid cuttlefish nautilus jellyfish starfish urchin crab lobster
  shrimp prawn crayfish krill barnacle clam mussel oyster scallop snail slug
  butterfly moth bee bumblebee ladybird beetle dragonfly damselfly firefly
  cricket grasshopper locust mantis cicada ant termite stick-insect leaf-insect
  spider tarantula scorpion centipede millipede worm leech silverfish mayfly
  dragonet sunfish lungfish paddlefish sturgeon archerfish mudskipper blenny
  goby wrasse tang surgeonfish triggerfish pufferfish lionfish stonefish
  rockfish garibaldi gar barracuda remora anchovy sardine herring mackerel
  bonito pollock whiting char grayling roach rudd tench bream loach minnow
  dunnock nuthatch treecreeper waxwing crossbill bullfinch goldfinch siskin
  redstart nightingale warbler chiffchaff wheatear stonechat whinchat dipper
  wagtail pipit redwing fieldfare jackdaw rook chough hoopoe bee-eater roller
  bustard bittern rail coot moorhen grebe cormorant shrew-mole flying-fox
  sugar-glider quokka quoll numbat bilby bandicoot potoroo bettong antechinus
  tarsier loris galago indri sifaka tamarin marmoset howler capuchin
  spider-monkey woolly-monkey saiga ibex chamois takin muskox yak zebu wildebeest
  kudu impala oryx addax eland nyala bongo dik-dik duiker pronghorn vicuna
  guanaco reindeer caribou wildcat sand-cat fishing-cat civet genet binturong
  fossa red-panda pika hyrax tenrec desman solenodon jerboa dormouse springhare`;

export function repoRoot(): string {
  let directory = process.cwd();
  while (directory !== dirname(directory)) {
    if (existsSync(join(directory, "package.json")) && existsSync(join(directory, "configs"))) return directory;
    directory = dirname(directory);
  }
  return process.cwd();
}

export function identityDatabasePath(): string {
  return join(repoRoot(), "tonies-identities.json");
}

export async function readIdentityDatabase(path = identityDatabasePath()): Promise<IdentityDatabase> {
  if (!existsSync(path)) return { version: 1, remainingAnimals: animals.split(/\s+/), identities: {}, log: [] };
  const database: IdentityDatabase = JSON.parse(await readFile(path, "utf8"));
  assert.equal(database.version, 1);
  const reserved = Object.values(database.identities).flatMap(identity => [identity.codename, ...identity.aliases]);
  assert.equal(new Set(reserved).size, reserved.length, "Duplicate Tonie codenames or aliases");
  assert.equal(new Set(database.remainingAnimals).size, database.remainingAnimals.length, "Duplicate animal pool entries");
  assert(database.remainingAnimals.every(animal => !reserved.includes(animal)), "Assigned animals must not remain in the pool");
  return database;
}

export async function writeIdentityDatabase(database: IdentityDatabase, path = identityDatabasePath()): Promise<void> {
  const cache = join(dirname(path), ".tonies-identities");
  await mkdir(cache, { recursive: true });
  const temporary = join(cache, `database-${process.pid}.json`);
  await writeFile(temporary, `${JSON.stringify(database, null, 2)}\n`);
  await rename(temporary, path);
}

export async function withIdentityDatabase<Result>(action: (database: IdentityDatabase) => Promise<Result>, path = identityDatabasePath()): Promise<Result> {
  const cache = join(dirname(path), ".tonies-identities");
  await mkdir(cache, { recursive: true });
  const lockPath = join(cache, "lock");
  const handle = await open(lockPath, "wx");
  await using lock = { [Symbol.asyncDispose]: async () => { await handle.close(); await unlink(lockPath); } };
  await handle.writeFile(String(process.pid));
  return await action(await readIdentityDatabase(path));
}

export function identityForTarget(database: IdentityDatabase, target: SyncTargetInput): TonieIdentity | undefined {
  const parsed = parseTargetInput(target);
  const reference = parsed.creativeTonieId.toLowerCase();
  const matches = Object.values(database.identities).filter(identity =>
    (!parsed.householdId || parsed.householdId === identity.householdId)
    && (identity.id.toLowerCase() === reference || identity.codename === reference || identity.aliases.includes(reference))
  );
  assert(matches.length <= 1, `Ambiguous Tonie reference: ${parsed.creativeTonieId}`);
  return matches[0];
}

export function assignIdentity(database: IdentityDatabase, identity: TonieIdentity, codename: string, at = new Date().toISOString()): void {
  codename = codename.trim().toLowerCase();
  assert.match(codename, /^[a-z]+(?:-[a-z]+)*$/, "Use a lowercase animal codename, with hyphens between words");
  const previousOwner = identityForTarget(database, codename);
  assert(!previousOwner || previousOwner === identity, `Codename ${codename} is already reserved`);
  if (identity.codename === codename) return;
  const previous = identity.codename || undefined;
  identity.aliases = [...new Set([...identity.aliases, ...(previous ? [previous] : [])])].filter(alias => alias !== codename);
  identity.codename = codename;
  database.remainingAnimals = database.remainingAnimals.filter(animal => animal !== codename);
  database.log.push({ at, key: targetKey(identity.householdId, identity.id), codename, ...(previous ? { previous } : {}) });
}

export function reconcileIdentities(database: IdentityDatabase, data: ListData, at = new Date().toISOString()): IdentityDatabase {
  for (const identity of Object.values(database.identities)) identity.present = false;
  for (const household of [...data.households].sort((left, right) => left.id.localeCompare(right.id))) {
    for (const tonie of [...household.creativeTonies].sort((left, right) => left.id.localeCompare(right.id))) {
      const key = targetKey(household.id, tonie.id);
      if (!database.identities[key]) {
        assert(database.remainingAnimals.length > 0, "Add more unused animals to tonies-identities.json before discovering new Tonies");
        const identity: TonieIdentity = { householdId: household.id, id: tonie.id, codename: "", aliases: [], name: tonie.name, present: true, firstSeen: at, lastSeen: at };
        assignIdentity(database, identity, database.remainingAnimals.pop()!, at);
        database.identities[key] = identity;
      }
      Object.assign(database.identities[key], { name: tonie.name, present: true, lastSeen: at });
    }
  }
  return database;
}

function identityAnnouncementForChapters(identity: TonieIdentity, chapters: Chapter[]) {
  return [identity.pendingAnnouncement, identity.announcement].find(announcement => {
    const expected = announcement?.chapter;
    return expected && chapters.length === 1 && (announcement === identity.pendingAnnouncement || chapters[0].id === expected.id) && chapters[0].file === expected.file
      && chapters[0].title === expected.title && chapters[0].type === expected.type;
  });
}

export function hasOnlyIdentityAnnouncement(identity: TonieIdentity, chapters: Chapter[]): boolean {
  return Boolean(identityAnnouncementForChapters(identity, chapters) && !chapters[0].transcoding && chapters[0].seconds > 0);
}

export async function generateIdentityAudio(codename: string, directory = join(repoRoot(), ".tonies-identities")): Promise<string> {
  assert.match(codename, /^[a-z]+(?:-[a-z]+)*$/);
  await mkdir(directory, { recursive: true });
  const output = join(directory, `${codename}.mp3`);
  if (!existsSync(output)) {
    const run = promisify(execFile);
    const spokenName = codename.replaceAll("-", " ");
    await run("say", ["-v", "Samantha", "-r", "145", "-o", join(directory, `${codename}.aiff`), `I am ${spokenName}. My codename is ${spokenName}.`]);
    const temporary = join(directory, `${codename}.tmp.mp3`);
    await run("ffmpeg", ["-nostdin", "-v", "error", "-y", "-i", join(directory, `${codename}.aiff`), "-ar", "44100", "-ac", "1", "-codec:a", "libmp3lame", "-b:a", "128k", temporary]);
    await rename(temporary, output);
  }
  return output;
}

export async function onboardIdentity(identity: TonieIdentity, save: () => Promise<void>, generateAudio = generateIdentityAudio): Promise<CreativeTonie> {
  const tonie = await fetchCreativeTonie(identity.householdId, identity.id);
  const empty = tonie.chapters.length === 0 && tonie.secondsPresent === 0;
  const currentAnnouncement = identityAnnouncementForChapters(identity, tonie.chapters);
  if (tonie.name !== "Creative Tonie" || (!empty && !currentAnnouncement)) return tonie;
  if (currentAnnouncement?.codename === identity.codename && hasOnlyIdentityAnnouncement(identity, tonie.chapters)) {
    identity.announcement = { codename: currentAnnouncement.codename, chapter: tonie.chapters[0] };
    delete identity.pendingAnnouncement;
    await save();
    return tonie;
  }
  const audioPath = await generateAudio(identity.codename);
  const desired = await localTracksFromFiles([audioPath]);
  desired[0].title = `Tonie identity: ${identity.codename}`;
  if (currentAnnouncement?.codename !== identity.codename) {
    if (identity.pendingAnnouncement?.codename !== identity.codename) {
      const chapter = await uploadFile(audioPath, desired[0].title, desired[0].seconds);
      identity.pendingAnnouncement = { codename: identity.codename, chapter };
      await save();
    }
    const fresh = await fetchCreativeTonie(identity.householdId, identity.id);
    const unchanged = fresh.name === tonie.name && fresh.secondsPresent === tonie.secondsPresent
      && JSON.stringify(fresh.chapters) === JSON.stringify(tonie.chapters);
    if (!unchanged) return fresh;
    await patchCreativeTonie(identity.householdId, identity.id, { chapters: [identity.pendingAnnouncement!.chapter] });
  }
  await verifySyncedChapters(identity.householdId, identity.id, desired, 60, 3000);
  const verified = await fetchCreativeTonie(identity.householdId, identity.id);
  assert.equal(verified.name, tonie.name, "Identity onboarding must not rename a Tonie");
  assert(hasOnlyIdentityAnnouncement(identity, verified.chapters));
  identity.announcement = { codename: identity.codename, chapter: verified.chapters[0] };
  delete identity.pendingAnnouncement;
  await save();
  return verified;
}

export async function readStorageAuth(): Promise<RuntimeAuth> {
  const storage = JSON.parse(await readFile(DEFAULT_STORAGE_PATH, "utf8"));
  const origin = storage.origins?.find((entry: { origin: string }) => entry.origin === "https://my.tonies.com");
  if (!Array.isArray(origin?.localStorage)) {
    throw new Error(`No https://my.tonies.com tokens found in ${DEFAULT_STORAGE_PATH}. Run "tonies auth login" or "tonies auth extract-profile".`);
  }
  const values = Object.fromEntries(origin.localStorage.map((entry: { name: string; value: string }) => [entry.name, entry.value]));
  return {
    accessToken: values.authorization ? String(values.authorization) : undefined,
    refreshToken: values.refreshToken ? String(values.refreshToken) : undefined,
    idToken: values.idToken ? String(values.idToken) : undefined
  };
}

export async function writeStorageAuth(auth: RuntimeAuth): Promise<{ path: string }> {
  const tokenEntries = [
    { name: "authorization", value: auth.accessToken },
    { name: "refreshToken", value: auth.refreshToken },
    { name: "idToken", value: auth.idToken }
  ].filter((entry): entry is { name: string; value: string } => Boolean(entry.value));
  let storage: { cookies?: unknown[]; origins?: Array<{ origin: string; localStorage?: Array<{ name: string; value: string }> }> } = { cookies: [], origins: [] };
  if (existsSync(DEFAULT_STORAGE_PATH)) storage = JSON.parse(await readFile(DEFAULT_STORAGE_PATH, "utf8"));
  storage.cookies ??= [];
  storage.origins ??= [];
  let origin = storage.origins.find((entry) => entry.origin === "https://my.tonies.com");
  if (!origin) {
    origin = { origin: "https://my.tonies.com", localStorage: [] };
    storage.origins.push(origin);
  }
  origin.localStorage = [...(origin.localStorage ?? []).filter((entry) => !["authorization", "refreshToken", "idToken"].includes(entry.name)), ...tokenEntries];
  await writeFile(DEFAULT_STORAGE_PATH, `${JSON.stringify(storage, null, 2)}\n`);
  return { path: DEFAULT_STORAGE_PATH };
}

export async function readProfileAuth(): Promise<RuntimeAuth> {
  const dir = `${DEFAULT_PROFILE_PATH}/Default/Local Storage/leveldb`;
  const db = new ClassicLevel(dir, { valueEncoding: "utf8" });
  await db.open();
  const localValues: Record<string, string> = {};
  try {
    for await (const [key, value] of db.iterator()) {
      const name = String(key).split("\x00\x01").at(-1) ?? "";
      if (String(key).startsWith("_https://my.tonies.com\x00\x01") && ["authorization", "refreshToken", "idToken"].includes(name)) localValues[name] = String(value).replace(/^\x01/, "");
    }
  } finally {
    await db.close();
  }
  if (localValues.authorization || localValues.refreshToken || localValues.idToken) {
    return {
      accessToken: localValues.authorization,
      refreshToken: localValues.refreshToken,
      idToken: localValues.idToken
    };
  }
  const files = (await readdir(dir)).filter((file) => /\.(log|ldb)$/.test(file));
  const tokens = [];
  for (const file of files) {
    const text = await readFile(`${dir}/${file}`, "latin1");
    for (const match of text.matchAll(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g)) {
      const token = match[0];
      let payload;
      try {
        payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
      } catch {
        continue;
      }
      if (payload.azp === "my-tonies" || payload.aud === "https://login.tonies.com/auth/realms/tonies" || payload.aud?.includes?.("my-tonies")) tokens.push({ token, payload });
    }
  }
  const groups = new Map<number, Record<string, string>>();
  for (const { token, payload } of tokens) {
    const group = groups.get(payload.iat) ?? {};
    group[payload.typ] = token;
    groups.set(payload.iat, group);
  }
  const complete = [...groups.entries()].filter(([, group]) => group.Bearer && group.Refresh).sort(([a], [b]) => b - a)[0];
  const latest = complete ?? [...groups.entries()].sort(([a], [b]) => b - a)[0];
  const byType = latest?.[1] ?? {};
  return {
    accessToken: byType.Bearer,
    refreshToken: byType.Refresh,
    idToken: byType.ID
  };
}

export function isExpired(jwt: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    return Number(payload.exp) - 5 < Math.floor(Date.now() / 1000);
  } catch {
    return true;
  }
}

async function tokenResponse(response: Response, action: string): Promise<{ access_token: string; refresh_token?: string; id_token?: string }> {
  const text = await response.text();
  let json: { access_token?: string; refresh_token?: string; id_token?: string; error?: string; error_description?: string };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Token ${action} failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  if (!response.ok || !json.access_token) {
    const detail = json.error_description ?? json.error ?? text.slice(0, 500);
    throw new Error(
      `Token ${action} failed: ${detail}.\n` +
      `The stored Tonies session is no longer valid. Run "tonies auth login" ` +
      `(needs TONIES_EMAIL and TONIES_PASSWORD) or "tonies auth extract-profile" after a browser login to get fresh tokens.`
    );
  }
  return json as { access_token: string; refresh_token?: string; id_token?: string };
}

export async function refreshToken(refreshTokenValue: string): Promise<RuntimeAuth> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshTokenValue,
    client_id: "my-tonies"
  });
  const response = await fetch(tokenUrl, { method: "POST", body });
  const json = await tokenResponse(response, "refresh");
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? refreshTokenValue,
    idToken: json.id_token
  };
}

export async function loginWithPassword(options: PasswordLoginOptions = {}): Promise<{ storagePath: string; auth: RuntimeAuth }> {
  const email = options.email ?? process.env.TONIES_EMAIL ?? "";
  const password = options.password ?? process.env.TONIES_PASSWORD ?? "";
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: "my-tonies",
    username: email,
    password,
    scope: "openid bx-profiles basic shop-de bx-user-attributes cloudservices web-origins shop-us email profile roles shop-uk"
  });
  const response = await fetch(tokenUrl, { method: "POST", body });
  const json = await tokenResponse(response, "login");
  const auth = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    idToken: json.id_token
  };
  if (auth.accessToken) await writeStorageAuth(auth);
  return { storagePath: DEFAULT_STORAGE_PATH, auth };
}

function canPasswordLogin(): boolean {
  return Boolean(process.env.TONIES_EMAIL && process.env.TONIES_PASSWORD);
}

async function recoverAuth(current?: RuntimeAuth): Promise<RuntimeAuth> {
  let refreshError: unknown;
  if (current?.refreshToken) {
    try {
      const refreshed = await refreshToken(current.refreshToken);
      await writeStorageAuth(refreshed);
      return refreshed;
    } catch (error) {
      refreshError = error;
      if (!canPasswordLogin()) throw error;
    }
  }
  if (canPasswordLogin()) {
    try {
      const { auth } = await loginWithPassword();
      return auth;
    } catch (error) {
      const message = (value: unknown) => value instanceof Error ? value.message : String(value);
      throw new Error(`Tonies session recovery failed.${refreshError ? ` Refresh: ${message(refreshError)}.` : ""} Login: ${message(error)}`);
    }
  }
  throw new Error("Tonies session is invalid and cannot be recovered automatically. Set TONIES_EMAIL and TONIES_PASSWORD in .env, or run \"tonies auth login\" / \"tonies auth extract-profile\".");
}

export async function resolveAuth(): Promise<RuntimeAuth> {
  let auth: RuntimeAuth | undefined;
  if (process.env.TONIES_ACCESS_TOKEN) {
    auth = {
      accessToken: process.env.TONIES_ACCESS_TOKEN,
      refreshToken: process.env.TONIES_REFRESH_TOKEN
    };
  }
  if (!auth && existsSync(DEFAULT_STORAGE_PATH)) {
    auth = await readStorageAuth();
  }
  if (!auth && existsSync(`${DEFAULT_PROFILE_PATH}/Default/Local Storage/leveldb`)) {
    auth = await readProfileAuth();
  }
  if (!auth) {
    return recoverAuth(undefined);
  }
  if (!auth.accessToken || isExpired(auth.accessToken)) {
    return recoverAuth(auth);
  }
  return auth;
}

export async function apiRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const perform = async (auth: RuntimeAuth) => {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { response, text: await response.text() };
  };
  let auth = await resolveAuth();
  let { response, text } = await perform(auth);
  if (response.status === 401) {
    auth = await recoverAuth(auth);
    ({ response, text } = await perform(auth));
  }
  if (!response.ok) {
    throw new Error(`API ${method} ${path} -> ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  }
  try {
    return text ? JSON.parse(text) : { status: response.status };
  } catch {
    throw new Error(`API ${method} ${path} -> ${response.status} returned non-JSON body: ${text.slice(0, 500)}`);
  }
}

export async function graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const json = await apiRequest("POST", "/graphql", { query, variables }) as { data?: T; errors?: Array<{ message?: string }> };
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${json.errors.map((entry) => entry.message ?? JSON.stringify(entry)).join("; ")}`);
  }
  if (json.data === undefined) throw new Error("GraphQL response contained no data");
  return json.data;
}

export function creativeToniePath(householdId: string, creativeTonieId: string): string {
  return `/households/${householdId}/creativetonies/${creativeTonieId}`;
}

export async function patchCreativeTonie(householdId: string, creativeTonieId: string, body: unknown): Promise<unknown> {
  return apiRequest("PATCH", creativeToniePath(householdId, creativeTonieId), body);
}

export async function getUploadRequest(): Promise<{ fileId: string; request: { url: string; fields: Record<string, string> } }> {
  return apiRequest("POST", "/file", { headers: {} }) as Promise<{ fileId: string; request: { url: string; fields: Record<string, string> } }>;
}

export function contentTypeForFile(path: string): string {
  const ext = extname(path).toLowerCase();
  const map: Record<string, string> = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".m4b": "audio/mp4",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/opus",
    ".wma": "audio/x-ms-wma",
    ".aif": "audio/aiff",
    ".aiff": "audio/aiff"
  };
  return map[ext] ?? "application/octet-stream";
}

export function titleForFile(path: string): string {
  const name = basename(path);
  const ext = extname(name).toLowerCase();
  return audioExtensions.has(ext) ? name.slice(0, -ext.length) : name;
}

export async function durationForFile(path: string): Promise<number> {
  const metadata = await parseFile(path);
  const seconds = Math.ceil(metadata.format.duration ?? 0);
  if (!seconds) throw new Error(`No duration found in ${path}`);
  return seconds;
}

export async function uploadFile(path: string, title?: string, seconds?: number): Promise<Chapter> {
  const upload = await getUploadRequest();
  const form = new FormData();
  for (const [key, value] of Object.entries(upload.request.fields)) form.append(key, value);
  const buffer = await readFile(path);
  form.append("file", new Blob([buffer], { type: contentTypeForFile(path) }), upload.fileId);
  const uploadResponse = await fetch(upload.request.url, { method: "POST", body: form });
  if (!uploadResponse.ok) {
    throw new Error(`File upload for ${path} failed with ${uploadResponse.status} ${uploadResponse.statusText}: ${(await uploadResponse.text()).slice(0, 500)}`);
  }
  return {
    id: upload.fileId,
    file: upload.fileId,
    title: title ?? titleForFile(path),
    seconds: seconds ?? await durationForFile(path),
    type: "file"
  };
}

export async function fingerprintFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

export async function localTrack(path: string, directory: string): Promise<LocalTrack> {
  const fileStat = await stat(path);
  return {
    path,
    directory,
    relativePath: relative(directory, path),
    title: titleForFile(path),
    seconds: await durationForFile(path),
    size: fileStat.size,
    fingerprint: await fingerprintFile(path)
  };
}

export async function readManifest(path: string): Promise<SyncManifest> {
  if (!existsSync(path)) return { version: 1, targets: {} };
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeManifest(path: string, manifest: SyncManifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function safeSnapshotPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_");
}

export function syncSnapshotPath(manifestPath: string, householdId: string, creativeTonieId: string, capturedAt: string): string {
  const timestamp = capturedAt.replace(/[:.]/g, "-");
  return join(dirname(manifestPath), ".tonies-sync-snapshots", safeSnapshotPart(householdId), safeSnapshotPart(creativeTonieId), `${timestamp}.json`);
}

export async function writeRemoteSnapshot(manifestPath: string, householdId: string, creativeTonieId: string, tonie: CreativeTonie, capturedAt = new Date().toISOString()): Promise<string> {
  const path = syncSnapshotPath(manifestPath, householdId, creativeTonieId, capturedAt);
  const snapshot: RemoteSnapshot = {
    version: 1,
    capturedAt,
    householdId,
    creativeTonieId,
    key: targetKey(householdId, creativeTonieId),
    remoteCount: tonie.chapters.length,
    tonie
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`);
  return path;
}

export async function localTracksFromDirectories(dirs: string[]): Promise<LocalTrack[]> {
  const groups = await Promise.all(dirs.map(async (dir) => {
    const files = await listAudioFiles(dir);
    return Promise.all(files.map((file) => localTrack(file, dir)));
  }));
  return groups.flat();
}

export async function localTracksFromFiles(files: string[], directory?: string): Promise<LocalTrack[]> {
  return Promise.all(files.map((file) => localTrack(file, directory ?? dirname(file))));
}

export function reorderChapters(chapters: Chapter[], chapterIds: string[]): Chapter[] {
  const byKey = new Map<string, Chapter>();
  for (const chapter of chapters) {
    byKey.set(chapter.id, chapter);
    byKey.set(chapter.file, chapter);
  }
  const picked = chapterIds.map((id) => byKey.get(id)).filter((chapter): chapter is Chapter => Boolean(chapter));
  const pickedSet = new Set(picked.map((chapter) => chapter.id));
  return [...picked, ...chapters.filter((chapter) => !pickedSet.has(chapter.id))];
}

export async function readYaml(path: string): Promise<Record<string, unknown>> {
  return YAML.parse(await readFile(path, "utf8"));
}

export async function listAudioFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const groups = await Promise.all(entries.map(async (entry) => {
    const path = `${dir.replace(/\/$/, "")}/${entry.name}`;
    if (entry.isDirectory()) return listAudioFiles(path);
    return audioExtensions.has(extname(entry.name).toLowerCase()) ? [path] : [];
  }));
  return groups.flat().sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function targetInputValue(value: unknown): SyncTargetInput | undefined {
  if (typeof value === "string") return value;
  const record = recordValue(value);
  if (record.codename || record.id || record.tonieId || record.creativeTonieId) return record as SyncTargetInput;
  return undefined;
}

function targetInputArray(value: unknown): SyncTargetInput[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(targetInputValue).filter((target): target is SyncTargetInput => Boolean(target));
}

function firstTargets(...values: unknown[]): SyncTargetInput[] {
  for (const value of values) {
    const targets = targetInputArray(value);
    if (targets) return targets;
    const target = targetInputValue(value);
    if (target) return [target];
  }
  return [];
}

export function syncTargetsFromConfig(config: Record<string, unknown>): SyncTargetInput[] {
  const sync = recordValue(config.sync);
  const configSection = recordValue(config.config);
  return firstTargets(
    config.tonies,
    sync.tonies,
    configSection.tonies,
    config.codename,
    sync.codename,
    configSection.codename,
    config.id,
    sync.id,
    configSection.id,
    config.tonieId,
    sync.tonieId,
    configSection.tonieId,
    config,
    sync,
    configSection
  );
}

export function outputDirFromConfig(config: Record<string, unknown>): string {
  const configSection = config.config as { path?: string } | undefined;
  return configSection?.path ?? "builds";
}

export function parseTarget(input: string): { householdId?: string; creativeTonieId: string } {
  if (input.includes("my.tonies.com")) {
    const url = new URL(input);
    const parts = url.pathname.split("/").filter(Boolean);
    return { householdId: parts[1], creativeTonieId: parts[2] };
  }
  if (input.includes("/")) {
    const [householdId, creativeTonieId] = input.split("/");
    return { householdId, creativeTonieId };
  }
  return { creativeTonieId: input };
}

function parseTargetInput(target: SyncTargetInput): { householdId?: string; creativeTonieId: string } {
  if (typeof target === "string") return parseTarget(target);
  const parsed = parseTarget(target.codename ?? target.creativeTonieId ?? target.tonieId ?? target.id ?? "");
  return { ...parsed, householdId: target.householdId ?? target.household_id ?? parsed.householdId };
}

export function targetKey(householdId: string, creativeTonieId: string): string {
  return `${householdId}/${creativeTonieId}`;
}

export function firstCreativeTonie(data: DetailData): CreativeTonie {
  const tonie = data.households?.[0]?.creativeTonies?.[0];
  if (!tonie) throw new Error("Creative-Tonie not found — check the household and Creative-Tonie IDs");
  return tonie;
}

export async function resolveTarget(target: SyncTargetInput): Promise<{ householdId: string; creativeTonieId: string }> {
  const parsed = parseTargetInput(target);
  const identity = identityForTarget(await readIdentityDatabase(), target);
  const creativeTonieId = identity?.id ?? parsed.creativeTonieId;
  const householdId = identity?.householdId ?? parsed.householdId ?? "";
  if (householdId && !identity) return { householdId, creativeTonieId };
  const data = await graphql<ListData>(listCreativeToniesQuery);
  const household = data.households.find((entry) => (!householdId || entry.id === householdId) && entry.creativeTonies.some((tonie) => tonie.id === creativeTonieId));
  if (!household) throw new Error(`Creative-Tonie ${creativeTonieId} not found in any household`);
  return { householdId: household.id, creativeTonieId };
}

export async function fetchCreativeTonie(householdId: string, creativeTonieId: string): Promise<CreativeTonie> {
  const data = await graphql<DetailData>(creativeTonieDetailQuery, { householdId, creativeTonieId });
  return firstCreativeTonie(data);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function verifySyncedChapters(householdId: string, creativeTonieId: string, desired: Awaited<ReturnType<typeof localTracksFromDirectories>>, attempts: number, delayMs: number): Promise<{ ok: true; count: number; titles: string[]; attempts: number }> {
  let tonie = await fetchCreativeTonie(householdId, creativeTonieId);
  let ready = tonie.chapters.length === desired.length && tonie.chapters.every((chapter) => !chapter.transcoding && chapter.seconds > 0);
  let verification = verifyChapters(desired, tonie.chapters);
  let attempt = 1;
  while ((!ready || !verification.ok) && attempt < attempts) {
    await sleep(delayMs);
    tonie = await fetchCreativeTonie(householdId, creativeTonieId);
    ready = tonie.chapters.length === desired.length && tonie.chapters.every((chapter) => !chapter.transcoding && chapter.seconds > 0);
    verification = verifyChapters(desired, tonie.chapters);
    attempt++;
  }
  const assertion = assertChaptersMatch(desired, tonie.chapters);
  return { ...assertion, attempts: attempt };
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\.[a-z0-9]{1,5}$/, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function durationClose(a: number, b: number): boolean {
  return Math.abs(a - b) <= 2;
}

function chapterMatchesTrack(chapter: Chapter, track: LocalTrack): boolean {
  return normalizeTitle(chapter.title) === normalizeTitle(track.title) && durationClose(chapter.seconds || 0, track.seconds);
}

function sameChapter(a: Chapter, b: Chapter): boolean {
  return a.id === b.id && a.file === b.file && a.title === b.title && durationClose(a.seconds || 0, b.seconds || 0);
}

function lcsPairs(desired: LocalTrack[], remote: Chapter[]): Array<[number, number]> {
  const table = Array.from({ length: desired.length + 1 }, () => Array(remote.length + 1).fill(0) as number[]);
  for (let i = desired.length - 1; i >= 0; i--) {
    for (let j = remote.length - 1; j >= 0; j--) {
      table[i][j] = chapterMatchesTrack(remote[j], desired[i])
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < desired.length && j < remote.length) {
    if (chapterMatchesTrack(remote[j], desired[i])) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

export function planDirectorySync(target: string, desired: LocalTrack[], remote: Chapter[], manifest: SyncManifest): DirectorySyncPlan {
  const entries = manifest.targets[target] ?? [];
  const usedRemote = new Set<number>();
  const usedDesired = new Set<number>();
  const picked = new Map<number, { chapter: Chapter; reason: string }>();

  for (let i = 0; i < desired.length; i++) {
    const matchingEntries = entries.filter((entry) => entry.fingerprint === desired[i].fingerprint);
    const remoteIndex = matchingEntries
      .map((entry) => remote.findIndex((chapter, index) => !usedRemote.has(index) && (chapter.file === entry.file || chapter.id === entry.id)))
      .find((index) => index >= 0) ?? -1;
    if (remoteIndex >= 0) {
      usedDesired.add(i);
      usedRemote.add(remoteIndex);
      picked.set(i, { chapter: remote[remoteIndex], reason: "manifest" });
    }
  }

  for (let i = 0; i < desired.length; i++) {
    if (usedDesired.has(i)) continue;
    const candidates = remote
      .map((chapter, index) => ({ chapter, index }))
      .filter(({ chapter, index }) => !usedRemote.has(index) && chapterMatchesTrack(chapter, desired[i]));
    if (candidates.length === 0) continue;
    const desiredSame = desired.filter((track, index) => !usedDesired.has(index) && chapterMatchesTrack(candidates[0].chapter, track));
    if (candidates.length === 1 && desiredSame.length === 1) {
      usedDesired.add(i);
      usedRemote.add(candidates[0].index);
      picked.set(i, { chapter: candidates[0].chapter, reason: "unique-title-duration" });
    }
  }

  const remainingDesired = desired.map((track, index) => ({ track, index })).filter(({ index }) => !usedDesired.has(index));
  const remainingRemote = remote.map((chapter, index) => ({ chapter, index })).filter(({ index }) => !usedRemote.has(index));
  for (const [desiredIndex, remoteIndex] of lcsPairs(remainingDesired.map(({ track }) => track), remainingRemote.map(({ chapter }) => chapter))) {
    const originalDesired = remainingDesired[desiredIndex].index;
    const originalRemote = remainingRemote[remoteIndex].index;
    if (!usedDesired.has(originalDesired) && !usedRemote.has(originalRemote)) {
      usedDesired.add(originalDesired);
      usedRemote.add(originalRemote);
      picked.set(originalDesired, { chapter: remote[originalRemote], reason: "lcs-title-duration" });
    }
  }

  const chapterSlots: Array<Chapter | null> = [];
  const reused: Array<{ index: number; track: LocalTrack; chapter: Chapter; reason: string }> = [];
  const uploads: Array<{ index: number; track: LocalTrack }> = [];
  for (let i = 0; i < desired.length; i++) {
    const match = picked.get(i);
    if (match) {
      const chapter = { ...match.chapter, title: desired[i].title, seconds: desired[i].seconds, type: match.chapter.type ?? "file" };
      chapterSlots.push(chapter);
      reused.push({ index: i, track: desired[i], chapter, reason: match.reason });
    } else {
      chapterSlots.push(null);
      uploads.push({ index: i, track: desired[i] });
    }
  }

  const deletes = remote.filter((_, index) => !usedRemote.has(index));
  const changed = remote.length !== desired.length || remote.some((chapter, index) => {
    const planned = chapterSlots[index];
    return !planned || !sameChapter(chapter, planned);
  });

  return { targetKey: target, desired, remote, chapterSlots, reused, uploads, deletes, changed: changed || uploads.length > 0 };
}

export function chaptersFromSyncPlan(plan: DirectorySyncPlan, uploaded: Array<{ index: number; chapter: Chapter }>): Chapter[] {
  const uploadedByIndex = new Map(uploaded.map((entry) => [entry.index, entry.chapter]));
  return plan.desired.map((track, index) => {
    const reused = plan.chapterSlots[index];
    const chapter = reused ?? uploadedByIndex.get(index) as Chapter;
    return { ...chapter, title: track.title, seconds: track.seconds, type: chapter.type ?? "file" };
  });
}

export function verifyChapters(desired: LocalTrack[], remote: Chapter[]): SyncVerification {
  const mismatches: string[] = [];
  if (desired.length !== remote.length) mismatches.push(`count ${remote.length} != ${desired.length}`);
  for (let i = 0; i < Math.max(desired.length, remote.length); i++) {
    const track = desired[i];
    const chapter = remote[i];
    if (!track) {
      mismatches.push(`extra chapter ${i + 1}: ${chapter.title}`);
      continue;
    }
    if (!chapter) {
      mismatches.push(`missing track ${i + 1}: ${track.title}`);
      continue;
    }
    if (chapter.title !== track.title) mismatches.push(`title ${i + 1}: ${chapter.title} != ${track.title}`);
    if (!durationClose(track.seconds, chapter.seconds || 0)) mismatches.push(`seconds ${i + 1}: ${chapter.seconds} != ${track.seconds}`);
  }
  return { ok: mismatches.length === 0, mismatches };
}

export function assertChaptersMatch(desired: LocalTrack[], remote: Chapter[]): { ok: true; count: number; titles: string[] } {
  const verification = verifyChapters(desired, remote);
  if (!verification.ok) throw new Error(`Creative-Tonie chapter assertion failed\n${verification.mismatches.join("\n")}`);
  return { ok: true, count: desired.length, titles: desired.map((track) => track.title) };
}

export function updateManifestForTarget(manifest: SyncManifest, target: string, tracks: LocalTrack[], chapters: Chapter[]): SyncManifest {
  manifest.targets[target] = tracks.map((track, index) => ({
    fingerprint: track.fingerprint,
    file: chapters[index].file,
    id: chapters[index].id,
    title: track.title,
    seconds: track.seconds,
    size: track.size,
    path: track.path,
    updatedAt: new Date().toISOString()
  }));
  return manifest;
}

async function syncLocalTracks(target: SyncTargetInput, desired: LocalTrack[], input: { directories?: string[]; files?: string[] }, options: SyncRunOptions = {}) {
  const syncOptions = {
    manifestPath: ".tonies-sync-manifest.json",
    dryRun: false,
    verifyAttempts: 60,
    verifyDelayMs: 3000,
    ...options
  };
  const resolved = await resolveTarget(target);
  const tonie = await fetchCreativeTonie(resolved.householdId, resolved.creativeTonieId);
  const snapshotPath = syncOptions.dryRun ? undefined : await writeRemoteSnapshot(syncOptions.manifestPath, resolved.householdId, resolved.creativeTonieId, tonie);
  const manifest = await readManifest(syncOptions.manifestPath);
  const key = targetKey(resolved.householdId, resolved.creativeTonieId);
  const plan = planDirectorySync(key, desired, tonie.chapters, manifest);
  const uploadPlan = syncOptions.forceUpload ? desired.map((track, index) => ({ index, track })) : plan.uploads;
  const uploaded: Array<{ index: number; chapter: Chapter }> = [];
  if (!syncOptions.dryRun) {
    for (const item of uploadPlan) {
      uploaded.push({
        index: item.index,
        chapter: await uploadFile(item.track.path, item.track.title, item.track.seconds)
      });
    }
  }
  const chapters = syncOptions.dryRun ? [] : syncOptions.forceUpload ? uploaded.map(item => item.chapter) : chaptersFromSyncPlan(plan, uploaded);
  let patched = false;
  if (!syncOptions.dryRun && (plan.changed || syncOptions.forceUpload)) {
    await patchCreativeTonie(resolved.householdId, resolved.creativeTonieId, { chapters });
    patched = true;
  }
  const verification = syncOptions.dryRun ? { ok: true, count: desired.length, titles: desired.map((track) => track.title), attempts: 0 } : await verifySyncedChapters(resolved.householdId, resolved.creativeTonieId, desired, syncOptions.verifyAttempts, syncOptions.verifyDelayMs);
  if (!syncOptions.dryRun) {
    const verifiedTonie = await fetchCreativeTonie(resolved.householdId, resolved.creativeTonieId);
    updateManifestForTarget(manifest, key, desired, verifiedTonie.chapters);
    await writeManifest(syncOptions.manifestPath, manifest);
  }
  return {
    ...resolved,
    key,
    ...input,
    manifestPath: syncOptions.manifestPath,
    snapshotPath,
    dryRun: syncOptions.dryRun,
    remoteCount: tonie.chapters.length,
    desiredCount: desired.length,
    reused: syncOptions.forceUpload ? [] : plan.reused.map((item) => ({ index: item.index, title: item.track.title, id: item.chapter.id, file: item.chapter.file, reason: item.reason })),
    uploads: uploadPlan.map((item) => ({ index: item.index, path: item.track.path, title: item.track.title })),
    deletes: (syncOptions.forceUpload ? tonie.chapters : plan.deletes).map((chapter) => ({ id: chapter.id, file: chapter.file, title: chapter.title })),
    patched,
    verification
  };
}

export async function syncFiles(target: SyncTargetInput, files: string[], options: SyncRunOptions = {}) {
  const desired = await localTracksFromFiles(files, options.baseDirectory);
  return syncLocalTracks(target, desired, { files }, options);
}

export async function syncDirectories(target: SyncTargetInput, directories: string[], options: SyncRunOptions = {}) {
  const desired = await localTracksFromDirectories(directories);
  return syncLocalTracks(target, desired, { directories }, options);
}
