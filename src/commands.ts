import { defineCommand, defineGroup, S, type AnySchema } from "toolcraft";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import YAML from "yaml";
import { apiMap } from "./api-map.js";
import { TonieCloudClient, tonieboxCapabilities } from "./cloud.js";
import { ToniesRealtime } from "./realtime.js";
import {
  assertChaptersMatch,
  assignIdentity,
  apiRequest,
  fetchCreativeTonie,
  firstCreativeTonie,
  generateIdentityAudio,
  graphql,
  hasOnlyIdentityAnnouncement,
  identityForTarget,
  localTracksFromFiles,
  loginWithPassword,
  localTracksFromDirectories,
  parseTarget,
  onboardIdentity,
  patchCreativeTonie,
  readYaml,
  readManifest,
  readIdentityDatabase,
  readProfileAuth,
  readStorageAuth,
  refreshToken,
  reconcileIdentities,
  repoRoot,
  reorderChapters,
  resolveTarget,
  resolveAuth,
  syncDirectories,
  syncTargetsFromConfig,
  targetKey,
  uploadFile,
  verifySyncedChapters,
  writeManifest,
  writeStorageAuth,
  withIdentityDatabase,
  writeIdentityDatabase,
  type Chapter,
  type DetailData,
  type ListData,
  type IdentityDatabase,
  type SyncTargetInput
} from "./client.js";
import {
  contentTonieDetailQuery,
  creativeTonieDetailQuery,
  creativeTonieRefreshQuery,
  listCreativeToniesQuery,
  tonieboxesQuery
} from "./queries.js";

const householdId = S.String({ description: "Household ID" });
const creativeTonieId = S.String({ description: "Creative-Tonie ID" });
const tonieboxId = S.String({ description: "Toniebox ID" });
const targetBox = S.String({ description: "Toniebox ID or householdId/tonieboxId" });
const cloud = new TonieCloudClient({ getAuth: resolveAuth });

function restCommand<const Name extends string, const Shape extends Record<string, AnySchema>>(
  name: Name, description: string, method: string, path: string, shape: Shape
) {
  const positional = [...path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
  return defineCommand({
    name, description, positional, params: S.Object(shape),
    confirm: method === "DELETE",
    handler: async ({ params }) => {
      const values = params as Record<string, unknown>;
      const resolved = path.replace(/\{([^}]+)\}/g, (_, key: string) => encodeURIComponent(String(values[key])));
      const body = Object.fromEntries(Object.entries(values).filter(([key, value]) => !positional.includes(key) && value !== undefined));
      return cloud.request(method, resolved, Object.keys(body).length ? body : undefined);
    }
  });
}

async function withRealtime<Result>(target: string, action: (realtime: ToniesRealtime, boxId: string) => Promise<Result>): Promise<Result> {
  const box = await cloud.findToniebox(target);
  const realtime = new ToniesRealtime(cloud, { reconnectPeriod: 0 });
  try {
    await realtime.connect([box]);
    return await action(realtime, box.id);
  } finally {
    await realtime.disconnect();
  }
}

function controlCommand<const Name extends string>(name: Name, description: string, action: (realtime: ToniesRealtime, boxId: string) => Promise<unknown>) {
  return defineCommand({
    name, description, positional: ["target"], params: S.Object({ target: targetBox }),
    handler: async ({ params }) => withRealtime(params.target, action)
  });
}

async function commandInput(value: string): Promise<string> {
  return value.startsWith("@") ? readFile(value.slice(1), "utf8") : value;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function configTargetKey(database: IdentityDatabase, target: SyncTargetInput): string {
  const identity = identityForTarget(database, target);
  if (identity) return targetKey(identity.householdId, identity.id);
  if (typeof target === "string") return parseTarget(target).creativeTonieId;
  return target.codename ?? target.creativeTonieId ?? target.tonieId ?? target.id ?? "";
}

async function readInheritedConfig(file: string, parents: string[] = []): Promise<Record<string, unknown>> {
  assert(!parents.includes(file), `Circular config inheritance: ${file}`);
  const config = await readYaml(file);
  if (typeof config.extends !== "string") return config;
  const parent = await readInheritedConfig(join(dirname(file), config.extends), [...parents, file]);
  return { ...parent, ...config, config: { ...recordValue(parent.config), ...recordValue(config.config) }, sync: { ...recordValue(parent.sync), ...recordValue(config.sync) } };
}

async function configTonieRefs(configsDir: string, database: IdentityDatabase) {
  if (!existsSync(configsDir)) return [];
  const files = (await readdir(configsDir)).filter((file) => /\.ya?ml$/i.test(file)).sort();
  const refs: Array<{ id: string; config: string }> = [];
  for (const file of files) {
    const config = await readInheritedConfig(join(configsDir, file));
    for (const target of syncTargetsFromConfig(config)) refs.push({ id: configTargetKey(database, target), config: basename(file) });
  }
  return refs;
}

function targetInputsFromValue(value: unknown): SyncTargetInput[] {
  if (Array.isArray(value)) return value as SyncTargetInput[];
  return value ? [value as SyncTargetInput] : [];
}

async function ignoredTonieIds(excludeConfig: string, database: IdentityDatabase) {
  if (!existsSync(excludeConfig)) return new Set<string>();
  const config = await readYaml(excludeConfig);
  const record = recordValue(config);
  const ids = [
    ...targetInputsFromValue(record.ignored),
    ...targetInputsFromValue(record.ignore),
    ...targetInputsFromValue(record.excluded),
    ...targetInputsFromValue(record.exclude)
  ].map(target => configTargetKey(database, target)).filter(Boolean);
  return new Set(ids);
}

export async function migrateIdentityConfigReferences(directory: string, database: IdentityDatabase, excludeFile = join(dirname(directory), "tonies-ignore.yaml"), dryRun = false): Promise<string[]> {
  const files = existsSync(directory) ? (await readdir(directory)).filter(file => /\.ya?ml$/i.test(file)).map(file => join(directory, file)) : [];
  if (existsSync(excludeFile)) files.push(excludeFile);
  const changed: string[] = [];
  for (const file of files) {
    const original = await readFile(file, "utf8");
    const document = YAML.parseDocument(original);
    let modified = false;
    const migrateTarget = (node: unknown): void => {
      if (YAML.isScalar(node) && typeof node.value === "string") {
        const identity = identityForTarget(database, node.value);
        if (identity && node.value !== identity.codename) { node.value = identity.codename; modified = true; }
      } else if (YAML.isSeq(node)) {
        for (const item of node.items) migrateTarget(item);
      } else if (YAML.isMap(node)) {
        const identity = identityForTarget(database, node.toJSON());
        if (identity) for (const field of ["codename", "id", "tonieId", "creativeTonieId"]) {
          const value = node.get(field, true);
          if (YAML.isScalar(value) && value.value !== identity.codename) { value.value = identity.codename; modified = true; }
        }
      }
    };
    for (const section of [document.contents, document.get("config", true), document.get("sync", true)]) {
      if (!YAML.isMap(section)) continue;
      migrateTarget(section);
      migrateTarget(section.get("tonies", true));
    }
    if (file === excludeFile) for (const field of ["ignored", "ignore", "excluded", "exclude"]) migrateTarget(document.get(field, true));
    if (modified) {
      if (!dryRun) await writeFile(file, document.toString());
      changed.push(file);
    }
  }
  return changed;
}

export async function syncIdentities(options: {
  rootDirectory?: string;
  assignment?: { target: SyncTargetInput; codename: string };
  generateAudio?: Parameters<typeof onboardIdentity>[2];
  dryRun?: boolean;
} = {}) {
  const directory = options.rootDirectory ?? repoRoot();
  const databasePath = join(directory, "tonies-identities.json");
  const sync = async (database: IdentityDatabase) => {
    const data = await graphql<ListData>(listCreativeToniesQuery);
    reconcileIdentities(database, data);
    if (options.assignment) {
      const identity = identityForTarget(database, options.assignment.target);
      assert(identity?.present, "The Tonie must be present on this account before assigning a codename");
      assignIdentity(database, identity, options.assignment.codename);
    }
    const save = () => writeIdentityDatabase(database, databasePath);
    if (!options.dryRun) await save();
    const configsDirectory = join(directory, "configs");
    const migrated = await migrateIdentityConfigReferences(configsDirectory, database, join(directory, "tonies-ignore.yaml"), options.dryRun);
    const refs = await configTonieRefs(configsDirectory, database);
    const ignoredIds = await ignoredTonieIds(join(directory, "tonies-ignore.yaml"), database);
    const byId = new Map<string, string[]>();
    for (const ref of refs) byId.set(ref.id, [...(byId.get(ref.id) ?? []), ref.config]);
    const tonies = [];
    for (const household of data.households) for (const listed of household.creativeTonies) {
      const key = targetKey(household.id, listed.id);
      const identity = database.identities[key];
      const configs = byId.get(key) ?? [];
      const ignored = ignoredIds.has(key);
      const eligible = configs.length === 0 && !ignored && listed.name === "Creative Tonie";
      const generateAudio = options.generateAudio ?? (codename => generateIdentityAudio(codename, join(directory, ".tonies-identities")));
      const detail = eligible ? options.dryRun ? await fetchCreativeTonie(household.id, listed.id) : await onboardIdentity(identity, save, generateAudio) : undefined;
      const tonie = detail ?? listed;
      const identityOnly = detail ? hasOnlyIdentityAnnouncement(identity, detail.chapters) : false;
      const chaptersPresent = detail ? detail.chapters.length : listed.chaptersPresent;
      identity.name = tonie.name;
      tonies.push({
        codename: identity.codename,
        free: eligible && tonie.name === "Creative Tonie" && (identityOnly || (chaptersPresent === 0 && tonie.secondsPresent === 0)),
        identityOnly,
        announcementNeeded: eligible && tonie.name === "Creative Tonie"
          && ((chaptersPresent === 0 && tonie.secondsPresent === 0) || (identityOnly && identity.announcement?.codename !== identity.codename)),
        ignored,
        id: tonie.id,
        name: tonie.name,
        live: tonie.live,
        private: tonie.private,
        configs: configs.join(", "),
        householdId: household.id,
        householdName: household.name,
        chaptersPresent,
        secondsPresent: tonie.secondsPresent,
        secondsRemaining: tonie.secondsRemaining
      });
    }
    if (!options.dryRun) await save();
    return { databasePath, dryRun: options.dryRun ?? false, migrated, tonies };
  };
  return options.dryRun ? sync(await readIdentityDatabase(databasePath)) : withIdentityDatabase(sync, databasePath);
}

export async function clear(configFile: string, manifestPath = join(repoRoot(), ".tonies-sync-manifest.json"), generateAudio = generateIdentityAudio) {
  const path = isAbsolute(configFile) ? configFile : join(repoRoot(), configFile);
  const document = YAML.parseDocument(await readFile(path, "utf8"));
  const config = await readInheritedConfig(path);
  const targets = syncTargetsFromConfig(config);
  assert.equal(targets.length, 1, "Clear requires exactly one configured Tonie");
  const target = targets[0];
  const resolved = await resolveTarget(target);
  const key = `${resolved.householdId}/${resolved.creativeTonieId}`;

  await patchCreativeTonie(resolved.householdId, resolved.creativeTonieId, { name: "Creative Tonie", chapters: [] });
  const tonie = await fetchCreativeTonie(resolved.householdId, resolved.creativeTonieId);

  for (const section of [document.contents, document.get("config", true), document.get("sync", true)]) {
    if (!YAML.isMap(section)) continue;
    for (const field of ["codename", "id", "tonieId", "creativeTonieId", "tonies"]) section.delete(field);
  }
  if (config.extends) document.set("tonies", []);
  await writeFile(path, document.toString());

  const manifest = await readManifest(manifestPath);
  delete manifest.targets[key];
  await writeManifest(manifestPath, manifest);
  const identities = await syncIdentities({ generateAudio });
  const identity = identities.tonies.find(row => row.householdId === resolved.householdId && row.id === resolved.creativeTonieId);
  return { ...identity, name: identity?.name ?? tonie.name, configFile: path, manifestKey: key };
}

export const apiCommands = defineGroup({
  name: "api",
  description: "Inspect discovered mytonies API surfaces",
  children: [
    defineCommand({
      name: "map",
      description: "Print known mytonies endpoints discovered from the web app",
      params: S.Object({}),
      handler: async () => apiMap
    }),
    defineCommand({
      name: "openapi", description: "Fetch the complete official REST specification, including request schemas",
      params: S.Object({}), handler: async () => cloud.openApi()
    }),
    defineCommand({
      name: "operations", description: "List every official REST operation, path, and parameter; invoke with raw operation",
      params: S.Object({}), handler: async () => cloud.operations()
    }),
    defineCommand({
      name: "schema", description: "Inspect the live GraphQL schema and available query types",
      params: S.Object({}),
      handler: async () => cloud.graphql(`{ __schema {
        queryType { name } mutationType { name } subscriptionType { name }
        types { name kind description fields { name description args { name defaultValue type { kind name ofType { kind name ofType { kind name } } } } type { kind name ofType { kind name ofType { kind name } } } } }
      } }`)
    })
  ]
});

export const authCommands = defineGroup({
  name: "auth",
  description: "Manage mytonies tokens",
  children: [
    defineCommand({
      name: "extract-storage",
      description: "Extract tokens from Playwright storage state JSON",
      params: S.Object({}),
      handler: async () => readStorageAuth()
    }),
    defineCommand({
      name: "login",
      description: "Log in with TONIES_EMAIL and TONIES_PASSWORD and save storage auth",
      params: S.Object({}),
      handler: async () => {
        const { storagePath, auth } = await loginWithPassword();
        return { storagePath, accessToken: Boolean(auth.accessToken), refreshToken: Boolean(auth.refreshToken), idToken: Boolean(auth.idToken) };
      }
    }),
    defineCommand({
      name: "extract-profile",
      description: "Extract latest tokens from a persistent Playwright profile",
      params: S.Object({}),
      handler: async () => {
        const auth = await readProfileAuth();
        if (auth.accessToken) await writeStorageAuth(auth);
        return {
          accessToken: Boolean(auth.accessToken),
          refreshToken: Boolean(auth.refreshToken),
          idToken: Boolean(auth.idToken)
        };
      }
    }),
    defineCommand({
      name: "refresh",
      description: "Refresh an access token",
      params: S.Object({}),
      handler: async () => {
        const current = await readStorageAuth();
        if (!current.refreshToken) {
          throw new Error("No refresh token in storage. Run \"tonies auth login\" (needs TONIES_EMAIL and TONIES_PASSWORD) or \"tonies auth extract-profile\" after a browser login.");
        }
        const auth = await refreshToken(current.refreshToken);
        await writeStorageAuth(auth);
        return { refreshed: true, accessToken: Boolean(auth.accessToken), refreshToken: Boolean(auth.refreshToken), idToken: Boolean(auth.idToken) };
      }
    })
  ]
});

export const creativeCommands = defineGroup({
  name: "creative",
  description: "List, inspect, and edit Creative-Tonies",
  children: [
    defineCommand({
      name: "cloud-list", description: "Read all Creative-Tonies without updating local identities or recordings",
      params: S.Object({}), handler: async () => graphql(listCreativeToniesQuery)
    }),
    restCommand("permissions", "List Creative-Tonie permissions", "GET", "/households/{householdId}/creativetonies/{creativeTonieId}/permissions", { householdId, creativeTonieId }),
    restCommand("set-permission", "Grant or remove explicit member access", "PUT", "/households/{householdId}/creativetonies/{creativeTonieId}/permissions/{membershipId}", {
      householdId, creativeTonieId, membershipId: S.String(), permission: S.Enum(["explicit", "none"] as const)
    }),
    restCommand("redeem-token", "Redeem a content token on a Creative-Tonie", "POST", "/households/{householdId}/creativetonies/{creativeTonieId}/redeem-token", {
      householdId, creativeTonieId, token: S.String()
    }),
    defineCommand({
      name: "list",
      description: "Sync animal identities and list all Creative-Tonies without changing their names",
      params: S.Object({ dryRun: S.Boolean({ default: false }) }),
      handler: async ({ params }) => (await syncIdentities(params)).tonies
    }),
    defineCommand({
      name: "identities",
      description: "Persist animal codenames, migrate config targets, and announce unused Creative-Tonies",
      params: S.Object({ dryRun: S.Boolean({ default: false }) }),
      handler: async ({ params }) => syncIdentities(params)
    }),
    defineCommand({
      name: "assign",
      description: "Assign a local codename; preserve cloud names, content, and historical aliases",
      positional: ["target", "codename"],
      params: S.Object({ target: S.String(), codename: S.String(), dryRun: S.Boolean({ default: false }) }),
      handler: async ({ params }) => syncIdentities({ dryRun: params.dryRun, assignment: { target: params.target, codename: params.codename } })
    }),
    defineCommand({
      name: "free",
      description: "Find unconfigured, nonignored Tonies that are empty or contain only their verified identity announcement",
      params: S.Object({ dryRun: S.Boolean({ default: false }) }),
      handler: async ({ params }) => {
        const rows = (await syncIdentities(params)).tonies;
        return rows.filter((row) => row.free && !row.ignored);
      }
    }),
    defineCommand({
      name: "clear",
      description: "Reset a configured Creative-Tonie and remove local associations",
      positional: ["configFile"],
      params: S.Object({
        configFile: S.String({ description: "Project config path" }),
        manifestPath: S.String({ default: join(repoRoot(), ".tonies-sync-manifest.json") })
      }),
      handler: async ({ params }) => clear(params.configFile, params.manifestPath)
    }),
    defineCommand({
      name: "config-map",
      description: "Sync animal identities and map Creative-Tonies to configs",
      params: S.Object({ dryRun: S.Boolean({ default: false }) }),
      handler: async ({ params }) => (await syncIdentities(params)).tonies
    }),
    defineCommand({
      name: "detail",
      description: "Fetch Creative-Tonie detail",
      positional: ["householdId", "creativeTonieId"],
      params: S.Object({ householdId, creativeTonieId }),
      handler: async ({ params }) =>
        graphql<DetailData>(creativeTonieDetailQuery, {
          householdId: params.householdId,
          creativeTonieId: params.creativeTonieId
        })
    }),
    defineCommand({
      name: "refresh",
      description: "Fetch Creative-Tonie transcoding and chapter refresh state",
      positional: ["householdId", "creativeTonieId"],
      params: S.Object({ householdId, creativeTonieId }),
      handler: async ({ params }) =>
        graphql<DetailData>(creativeTonieRefreshQuery, {
          householdId: params.householdId,
          creativeTonieId: params.creativeTonieId
        })
    }),
    defineCommand({
      name: "rename",
      description: "Rename a Creative-Tonie",
      positional: ["householdId", "creativeTonieId", "name"],
      params: S.Object({
        householdId,
        creativeTonieId,
        name: S.String({ description: "New Creative-Tonie name" })
      }),
      handler: async ({ params }) =>
        patchCreativeTonie(params.householdId, params.creativeTonieId, { name: params.name })
    }),
    defineCommand({
      name: "set-flags",
      description: "Set live/private flags",
      positional: ["householdId", "creativeTonieId"],
      params: S.Object({
        householdId,
        creativeTonieId,
        live: S.Optional(S.Boolean({ description: "Set live mode" })),
        private: S.Optional(S.Boolean({ description: "Restrict playback to this household" }))
      }),
      handler: async ({ params }) => {
        const body: Record<string, boolean> = {};
        if (params.live !== undefined) body.live = params.live;
        if (params.private !== undefined) body.private = params.private;
        return patchCreativeTonie(params.householdId, params.creativeTonieId, body);
      }
    }),
    defineCommand({
      name: "save-chapters",
      description: "Replace playlist chapters from JSON",
      positional: ["householdId", "creativeTonieId", "chaptersJson"],
      params: S.Object({
        householdId,
        creativeTonieId,
        chaptersJson: S.String({ description: "JSON array of chapter objects" })
      }),
      handler: async ({ params }) =>
        patchCreativeTonie(params.householdId, params.creativeTonieId, {
          chapters: JSON.parse(params.chaptersJson)
        })
    }),
    defineCommand({
      name: "delete-chapter",
      description: "Delete a chapter by id or file",
      positional: ["householdId", "creativeTonieId", "chapterId"],
      params: S.Object({
        householdId,
        creativeTonieId,
        chapterId: S.String({ description: "Chapter id or file id" })
      }),
      handler: async ({ params }) => {
        const data = await graphql<DetailData>(creativeTonieDetailQuery, {
          householdId: params.householdId,
          creativeTonieId: params.creativeTonieId
        });
        const tonie = firstCreativeTonie(data);
        const chapters = tonie.chapters.filter((chapter) => chapter.id !== params.chapterId && chapter.file !== params.chapterId);
        if (chapters.length === tonie.chapters.length) throw new Error(`No chapter matched ${params.chapterId}`);
        return patchCreativeTonie(params.householdId, params.creativeTonieId, { chapters });
      }
    }),
    defineCommand({
      name: "edit-chapter",
      description: "Edit a chapter title or duration by id or file",
      positional: ["householdId", "creativeTonieId", "chapterId"],
      params: S.Object({
        householdId,
        creativeTonieId,
        chapterId: S.String({ description: "Chapter id or file id" }),
        title: S.Optional(S.String({ description: "New chapter title" })),
        seconds: S.Optional(S.Number({ description: "New chapter duration" }))
      }),
      handler: async ({ params }) => {
        const data = await graphql<DetailData>(creativeTonieDetailQuery, {
          householdId: params.householdId,
          creativeTonieId: params.creativeTonieId
        });
        const tonie = firstCreativeTonie(data);
        const chapters = tonie.chapters.map((chapter) => chapter.id === params.chapterId || chapter.file === params.chapterId
          ? {
              ...chapter,
              title: params.title ?? chapter.title,
              seconds: params.seconds ?? chapter.seconds
            }
          : chapter);
        return patchCreativeTonie(params.householdId, params.creativeTonieId, { chapters });
      }
    }),
    defineCommand({
      name: "reorder-chapters",
      description: "Reorder chapters by id or file list, keeping unlisted chapters at the end",
      positional: ["householdId", "creativeTonieId", "chapterIds"],
      params: S.Object({
        householdId,
        creativeTonieId,
        chapterIds: S.Array(S.String(), { description: "Chapter ids or file ids in desired order" })
      }),
      handler: async ({ params }) => {
        const data = await graphql<DetailData>(creativeTonieDetailQuery, {
          householdId: params.householdId,
          creativeTonieId: params.creativeTonieId
        });
        const tonie = firstCreativeTonie(data);
        return patchCreativeTonie(params.householdId, params.creativeTonieId, {
          chapters: reorderChapters(tonie.chapters, params.chapterIds)
        });
      }
    }),
    defineCommand({
      name: "upload",
      description: "Upload audio files and save them into the playlist (replace mode verifies transcoding)",
      positional: ["householdId", "creativeTonieId", "files"],
      params: S.Object({
        householdId,
        creativeTonieId,
        files: S.Array(S.String(), { description: "Audio file paths" }),
        titles: S.Optional(S.Array(S.String(), { description: "Per-file title overrides" })),
        seconds: S.Optional(S.Array(S.Number(), { description: "Per-file duration overrides" })),
        mode: S.Enum(["append", "prepend", "replace"] as const, { default: "append" })
      }),
      handler: async ({ params }) => {
        const uploaded: Chapter[] = [];
        for (const [index, file] of params.files.entries()) {
          uploaded.push(await uploadFile(file, params.titles?.[index], params.seconds?.[index]));
        }
        const data = await graphql<DetailData>(creativeTonieDetailQuery, {
          householdId: params.householdId,
          creativeTonieId: params.creativeTonieId
        });
        const existing = params.mode === "replace" ? [] : firstCreativeTonie(data).chapters;
        const chapters = params.mode === "prepend" ? [...uploaded, ...existing] : [...existing, ...uploaded];
        const patched = await patchCreativeTonie(params.householdId, params.creativeTonieId, { chapters });
        if (params.mode !== "replace") return patched;
        const desired = await localTracksFromFiles(params.files);
        for (const [index, track] of desired.entries()) {
          track.title = params.titles?.[index] ?? track.title;
          track.seconds = params.seconds?.[index] ?? track.seconds;
        }
        return { patched, verification: await verifySyncedChapters(params.householdId, params.creativeTonieId, desired, 60, 3000) };
      }
    }),
    defineCommand({
      name: "delete",
      description: "Remove a Creative-Tonie from a household",
      positional: ["householdId", "creativeTonieId"],
      params: S.Object({ householdId, creativeTonieId }),
      handler: async ({ params }) =>
        apiRequest("DELETE", `/households/${params.householdId}/creativetonies/${params.creativeTonieId}`)
    })
  ]
});

export const contentCommands = defineGroup({
  name: "content",
  description: "Inspect and manage Content-Tonies",
  children: [
    defineCommand({
      name: "list", description: "List Content-Tonies across all households",
      params: S.Object({}), handler: async () => graphql(`{ households { id name contentTonies { id title imageUrl secondsPresent } } }`)
    }),
    restCommand("delete", "Remove a Content-Tonie from its household", "DELETE", "/households/{householdId}/contenttonies/{contentTonieId}", {
      householdId, contentTonieId: S.String()
    }),
    defineCommand({
      name: "detail",
      description: "Fetch Content-Tonie detail",
      positional: ["householdId", "contentTonieId"],
      params: S.Object({
        householdId,
        contentTonieId: S.String({ description: "Content-Tonie ID" })
      }),
      handler: async ({ params }) =>
        graphql(contentTonieDetailQuery, {
          householdId: params.householdId,
          contentTonieId: params.contentTonieId
        })
    }),
    defineCommand({
      name: "set-lock",
      description: "Set Content-Tonie lock state",
      positional: ["householdId", "contentTonieId", "lock"],
      params: S.Object({
        householdId,
        contentTonieId: S.String({ description: "Content-Tonie ID" }),
        lock: S.Boolean({ description: "Lock state" })
      }),
      handler: async ({ params }) =>
        apiRequest("PATCH", `/households/${params.householdId}/contenttonies/${params.contentTonieId}`, {
          lock: params.lock
        })
    })
  ]
});

export const tonieboxCommands = defineGroup({
  name: "tonieboxes",
  description: "Manage boxes, playback, volume, sleep light, and realtime state (controls require supported firmware)",
  children: [
    defineCommand({
      name: "list",
      description: "List Tonieboxes",
      params: S.Object({}),
      handler: async () => cloud.listTonieboxes()
    }),
    restCommand("detail", "Read all settings, firmware, and capability flags", "GET", "/households/{householdId}/tonieboxes/{tonieboxId}", { householdId, tonieboxId }),
    restCommand("add", "Add an already set-up Toniebox 1; use raw operation for Toniebox 2 setup", "POST", "/households/{householdId}/tonieboxes", {
      householdId, id: tonieboxId, name: S.Optional(S.String())
    }),
    restCommand("delete", "Reset and remove a Toniebox from the household", "DELETE", "/households/{householdId}/tonieboxes/{tonieboxId}", { householdId, tonieboxId }),
    restCommand("settings", "Change cloud settings; volume limits are NOT the live volume level", "PATCH", "/households/{householdId}/tonieboxes/{tonieboxId}", {
      householdId, tonieboxId,
      name: S.Optional(S.String({ minLength: 1, maxLength: 50 })),
      maxVolume: S.Optional(S.Enum([25, 50, 75, 100] as const)),
      maxHeadphoneVolume: S.Optional(S.Enum([25, 50, 75, 100] as const)),
      ledLevel: S.Optional(S.Enum(["on", "off", "dimmed"] as const)),
      accelerometerEnabled: S.Optional(S.Boolean()),
      tapDirection: S.Optional(S.Enum(["left", "right"] as const)),
      ageMode: S.Optional(S.Enum(["1+", "3+"] as const)),
      language: S.Optional(S.Enum(["de", "en", "en-us", "fr"] as const, { nullable: true })),
      timezone: S.Optional(S.String()),
      lightringBrightness: S.Optional(S.Number({ jsonType: "integer", minimum: 0, maximum: 100 })),
      bedtimeLightringBrightness: S.Optional(S.Number({ jsonType: "integer", minimum: 0, maximum: 100 })),
      bedtimeLightringColor: S.Optional(S.String({ pattern: "^#[a-f0-9]{6}$" })),
      bedtimeMaxVolume: S.Optional(S.Number({ jsonType: "integer", minimum: 1, maximum: 100 })),
      bedtimeMaxHeadphoneVolume: S.Optional(S.Number({ jsonType: "integer", minimum: 1, maximum: 100 })),
      skippingEnabled: S.Optional(S.Boolean({ nullable: true })),
      skippingDirection: S.Optional(S.Enum(["left", "right"] as const, { nullable: true })),
      scrubbingEnabled: S.Optional(S.Boolean({ nullable: true }))
    }),
    defineCommand({
      name: "capabilities", description: "Identify real supported features; cloud wake is unavailable",
      positional: ["target"], params: S.Object({ target: targetBox }),
      handler: async ({ params }) => tonieboxCapabilities(await cloud.findToniebox(params.target))
    }),
    defineCommand({
      name: "watch", description: "Collect realtime state for a bounded number of seconds, including retained snapshots",
      positional: ["target"], params: S.Object({ target: targetBox, seconds: S.Number({ default: 5, minimum: 1, maximum: 300 }) }),
      handler: async ({ params }) => withRealtime(params.target, async (realtime, boxId) => {
        await new Promise(resolve => setTimeout(resolve, params.seconds * 1000));
        return { boxId, state: realtime.states.get(boxId) ?? {} };
      })
    }),
    controlCommand("play", "Resume playback on an online supported box", (realtime, boxId) => realtime.play(boxId)),
    controlCommand("pause", "Pause playback on an online supported box", (realtime, boxId) => realtime.pause(boxId)),
    controlCommand("next", "Skip to the next chapter using live playback state", (realtime, boxId) => realtime.skip(boxId, 1)),
    controlCommand("previous", "Skip to the previous chapter using live playback state", (realtime, boxId) => realtime.skip(boxId, -1)),
    controlCommand("volume-up", "Raise live volume by one device step", (realtime, boxId) => realtime.changeVolume(boxId, 1)),
    controlCommand("volume-down", "Lower live volume by one device step", (realtime, boxId) => realtime.changeVolume(boxId, -1)),
    controlCommand("sleep", "Put the box to sleep now; it cannot be woken remotely", (realtime, boxId) => realtime.sleep(boxId)),
    defineCommand({
      name: "volume", description: "Set LIVE playback volume, 0–13 (not a percentage or volume limit)",
      positional: ["target", "level"], params: S.Object({ target: targetBox, level: S.Number({ jsonType: "integer", minimum: 0, maximum: 13 }) }),
      handler: async ({ params }) => withRealtime(params.target, (realtime, boxId) => realtime.setVolume(boxId, params.level))
    }),
    defineCommand({
      name: "seek", description: "Seek to a zero-based chapter and millisecond offset",
      positional: ["target", "chapter"], params: S.Object({ target: targetBox, chapter: S.Number({ jsonType: "integer", minimum: 0 }), ms: S.Number({ default: 0, jsonType: "integer", minimum: 0 }) }),
      handler: async ({ params }) => withRealtime(params.target, (realtime, boxId) => realtime.seek(boxId, params.chapter, params.ms))
    }),
    defineCommand({
      name: "sleep-timer", description: "Start the native sleep timer with light; 0 cancels it",
      positional: ["target", "seconds"], params: S.Object({ target: targetBox, seconds: S.Number({ jsonType: "integer", minimum: 0 }) }),
      handler: async ({ params }) => withRealtime(params.target, (realtime, boxId) => realtime.sleepTimer(boxId, params.seconds))
    }),
    defineCommand({
      name: "night-mode", description: "Enable the native sleep timer with light (night mode); disabling cancels that timer, not scheduled alarms",
      positional: ["target", "enabled"], params: S.Object({ target: targetBox, enabled: S.Boolean(), seconds: S.Number({ default: 1800, jsonType: "integer", minimum: 1 }) }),
      handler: async ({ params }) => withRealtime(params.target, (realtime, boxId) => realtime.sleepTimer(boxId, params.enabled ? params.seconds : 0))
    }),
    defineCommand({
      name: "playback-info", description: "Fetch current Tonie metadata and chapters for a content version",
      positional: ["tonieboxId", "tonieId"], params: S.Object({ tonieboxId, tonieId: S.String(), contentVersion: S.Number({ default: 0, jsonType: "integer", minimum: 0 }) }),
      handler: async ({ params }) => cloud.playbackInfo(params.tonieboxId, params.tonieId, params.contentVersion)
    })
  ]
});

export const rawCommands = defineGroup({
  name: "raw",
  description: "Call discovered APIs directly",
  children: [
    defineCommand({
      name: "graphql",
      description: "Run a raw GraphQL query",
      params: S.Object({
        query: S.String({ description: "GraphQL query string" }),
        variables: S.Optional(S.String({ description: "Variables JSON" }))
      }),
      handler: async ({ params }) =>
        graphql(await commandInput(params.query), params.variables ? JSON.parse(await commandInput(params.variables)) : undefined)
    }),
    defineCommand({
      name: "request",
      description: "Run a raw REST request against https://api.prod.tcs.toys/v2",
      positional: ["method", "path"],
      params: S.Object({
        method: S.String({ description: "HTTP method" }),
        path: S.String({ description: "API path" }),
        body: S.Optional(S.String({ description: "JSON body" }))
      }),
      handler: async ({ params }) =>
        apiRequest(params.method.toUpperCase(), params.path, params.body ? JSON.parse(await commandInput(params.body)) : undefined)
    }),
    defineCommand({
      name: "operation", description: "Invoke ANY official REST operation by operationId; JSON values accept @file paths",
      positional: ["operationId"], params: S.Object({ operationId: S.String(), parameters: S.Optional(S.String()), body: S.Optional(S.String()) }),
      handler: async ({ params }) => cloud.operation(params.operationId, params.parameters ? JSON.parse(await commandInput(params.parameters)) : {}, params.body ? JSON.parse(await commandInput(params.body)) : undefined)
    }),
    defineCommand({
      name: "mqtt", description: "Publish a low-level app-control command to an online supported Toniebox; broker ACK is not device confirmation",
      positional: ["target", "command", "payload"], params: S.Object({ target: targetBox, command: S.String(), payload: S.String() }),
      handler: async ({ params }) => withRealtime(params.target, async (realtime, boxId) => realtime.command(boxId, params.command, JSON.parse(await commandInput(params.payload))))
    })
  ]
});

export const householdCommands = defineGroup({
  name: "households", description: "Manage households, members, and invitations",
  children: [
    restCommand("list", "List households", "GET", "/households", {}),
    restCommand("detail", "Read household details", "GET", "/households/{householdId}", { householdId }),
    restCommand("create", "Create a household", "POST", "/households", {}),
    restCommand("settings", "Update household settings", "PATCH", "/households/{householdId}", {
      householdId, name: S.Optional(S.String({ minLength: 1, maxLength: 30 })),
      foreignCreativeTonieContent: S.Optional(S.Boolean()), biTracking: S.Optional(S.Boolean({ nullable: true }))
    }),
    restCommand("delete", "Delete a household", "DELETE", "/households/{householdId}", { householdId }),
    restCommand("members", "List memberships", "GET", "/households/{householdId}/memberships", { householdId }),
    restCommand("set-member", "Change member access; owner transfers household ownership", "PUT", "/households/{householdId}/memberships/{membershipId}", {
      householdId, membershipId: S.String(), mtype: S.Enum(["owner", "full", "limited"] as const)
    }),
    restCommand("remove-member", "Remove a household membership", "DELETE", "/households/{householdId}/memberships/{membershipId}", { householdId, membershipId: S.String() }),
    restCommand("invitations", "List household invitations", "GET", "/households/{householdId}/invitations", { householdId }),
    restCommand("invite", "Send a household invitation", "POST", "/households/{householdId}/invitations", {
      householdId, email: S.String(), itype: S.Enum(["full", "limited"] as const)
    }),
    restCommand("resend-invitation", "Resend an invitation email", "POST", "/households/{householdId}/invitations/{invitationId}/resend", { householdId, invitationId: S.String() }),
    restCommand("delete-invitation", "Delete a household invitation", "DELETE", "/households/{householdId}/invitations/{invitationId}", { householdId, invitationId: S.String() }),
    restCommand("children", "List household child profiles", "GET", "/households/{householdId}/children", { householdId })
  ]
});

export const accountCommands = defineGroup({
  name: "account", description: "Read account, server configuration, and invitations",
  children: [
    restCommand("me", "Read the authenticated account", "GET", "/me", {}),
    restCommand("config", "Read cloud upload limits and configuration", "GET", "/config", {}),
    restCommand("invitations", "List received invitations", "GET", "/invitations", {}),
    restCommand("accept-invitation", "Accept an invitation", "POST", "/invitations/{invitationId}/accept", { invitationId: S.String() }),
    restCommand("notifications", "Read notifications", "GET", "/notifications", {})
  ]
});

export const tuneCommands = defineGroup({
  name: "tunes", description: "Inspect and assign owned digital content",
  children: [
    defineCommand({ name: "list", description: "List owned Tunes", params: S.Object({}), handler: async () => graphql(`{ myTunes { id item { id title } } }`) }),
    restCommand("assign", "Assign owned digital content to a Tonie", "PUT", "/households/{householdId}/tonie/{tonieId}/tune/{tuneId}", {
      householdId, tonieId: S.String(), tuneId: S.String()
    }),
    restCommand("remove", "Remove assigned content and restore the underlying playlist", "DELETE", "/households/{householdId}/tonie/{tonieId}/tune", { householdId, tonieId: S.String() })
  ]
});

export const syncCommands = defineGroup({
  name: "sync",
  description: "Sync local builds to Creative-Tonies",
  children: [
    defineCommand({
      name: "directories",
      description: "Sync one or more audio directories to a Creative-Tonie with minimal uploads",
      positional: ["target", "directories"],
      params: S.Object({
        target: S.String({ description: "Creative-Tonie URL, householdId/creativeTonieId, or Creative-Tonie ID" }),
        directories: S.Array(S.String(), { description: "Audio directories in desired playlist order" }),
        manifestPath: S.String({ default: ".tonies-sync-manifest.json" }),
        dryRun: S.Boolean({ default: false }),
        verifyAttempts: S.Number({ default: 60 }),
        verifyDelayMs: S.Number({ default: 3000 })
      }),
      handler: async ({ params }) =>
        syncDirectories(params.target, params.directories, {
          manifestPath: params.manifestPath,
          dryRun: params.dryRun,
          verifyAttempts: params.verifyAttempts,
          verifyDelayMs: params.verifyDelayMs
        })
    }),
    defineCommand({
      name: "assert-directories",
      description: "Assert a Creative-Tonie exactly matches one or more audio directories",
      positional: ["target", "directories"],
      params: S.Object({
        target: S.String({ description: "Creative-Tonie URL, householdId/creativeTonieId, or Creative-Tonie ID" }),
        directories: S.Array(S.String(), { description: "Audio directories in desired playlist order" })
      }),
      handler: async ({ params }) => {
        const resolved = await resolveTarget(params.target);
        const desired = await localTracksFromDirectories(params.directories);
        const tonie = await fetchCreativeTonie(resolved.householdId, resolved.creativeTonieId);
        return assertChaptersMatch(desired, tonie.chapters);
      }
    }),
    defineCommand({
      name: "assert-roundtrip",
      description: "Run real upload, edit, delete, reorder, resync, and final-state assertions",
      positional: ["target", "directories"],
      params: S.Object({
        target: S.String({ description: "Creative-Tonie URL, householdId/creativeTonieId, or Creative-Tonie ID" }),
        directories: S.Array(S.String(), { description: "Audio directories in desired playlist order" }),
        manifestPath: S.String({ default: ".tonies-sync-manifest.json" }),
        verifyAttempts: S.Number({ default: 60 }),
        verifyDelayMs: S.Number({ default: 3000 }),
        force: S.Boolean({ default: false, description: "Required: this test reverses, deletes, and edits chapters on the target" })
      }),
      handler: async ({ params }) => {
        if (!params.force) throw new Error("assert-roundtrip mutates the target Creative-Tonie (reverses, deletes, and edits chapters). Pass --force to run it.");
        const options = {
          manifestPath: params.manifestPath,
          dryRun: false,
          verifyAttempts: params.verifyAttempts,
          verifyDelayMs: params.verifyDelayMs
        };
        const first = await syncDirectories(params.target, params.directories, options);
        const second = await syncDirectories(params.target, params.directories, options);
        if (second.uploads.length !== 0) throw new Error(`Minimal resync uploaded ${second.uploads.length} chapters`);
        const resolved = await resolveTarget(params.target);
        const afterSecond = await fetchCreativeTonie(resolved.householdId, resolved.creativeTonieId);
        await patchCreativeTonie(resolved.householdId, resolved.creativeTonieId, { chapters: [...afterSecond.chapters].reverse() });
        const afterReorder = await syncDirectories(params.target, params.directories, options);
        if (afterReorder.uploads.length !== 0) throw new Error(`Reorder resync uploaded ${afterReorder.uploads.length} chapters`);
        const afterReorderDetail = await fetchCreativeTonie(resolved.householdId, resolved.creativeTonieId);
        await patchCreativeTonie(resolved.householdId, resolved.creativeTonieId, { chapters: afterReorderDetail.chapters.slice(1) });
        const afterDelete = await syncDirectories(params.target, params.directories, options);
        if (afterDelete.uploads.length !== 1) throw new Error(`Delete resync uploaded ${afterDelete.uploads.length} chapters`);
        const afterDeleteDetail = await fetchCreativeTonie(resolved.householdId, resolved.creativeTonieId);
        const edited = afterDeleteDetail.chapters.map((chapter, index) => index === 0 ? { ...chapter, title: `${chapter.title} edited` } : chapter);
        await patchCreativeTonie(resolved.householdId, resolved.creativeTonieId, { chapters: edited });
        const afterEdit = await syncDirectories(params.target, params.directories, options);
        if (afterEdit.uploads.length !== 0) throw new Error(`Edit resync uploaded ${afterEdit.uploads.length} chapters`);
        const desired = await localTracksFromDirectories(params.directories);
        const finalTonie = await fetchCreativeTonie(resolved.householdId, resolved.creativeTonieId);
        return {
          first,
          second,
          afterReorder,
          afterDelete,
          afterEdit,
          final: assertChaptersMatch(desired, finalTonie.chapters)
        };
      }
    })
  ]
});
