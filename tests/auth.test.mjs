import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClassicLevel } from "classic-level";
import { DEFAULT_PROFILE_PATH, DEFAULT_STORAGE_PATH, isExpired, readProfileAuth, readStorageAuth, resolveAuth, writeStorageAuth } from "../dist/client.js";

function jwt(exp) {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify({ exp })).toString("base64url"),
    "signature"
  ].join(".");
}

test("storage auth roundtrips Playwright localStorage fields", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "tonies-sdk-auth-"));
  const oldCwd = process.cwd();
  t.after(() => process.chdir(oldCwd));
  process.chdir(dir);
  await writeStorageAuth({
    accessToken: "access",
    refreshToken: "refresh",
    idToken: "id"
  });
  assert.deepEqual(await readStorageAuth(), {
    accessToken: "access",
    refreshToken: "refresh",
    idToken: "id"
  });
  if (process.platform !== "win32") assert.equal((await stat(DEFAULT_STORAGE_PATH)).mode & 0o777, 0o600);
});

test("token rotation never exposes partially written storage to concurrent readers", async context => {
  const directory = await mkdtemp(join(tmpdir(), "tonies-sdk-atomic-auth-"));
  const previousCwd = process.cwd();
  context.after(async () => { process.chdir(previousCwd); await rm(directory, { recursive: true, force: true }); });
  process.chdir(directory);
  const preference = "x".repeat(128 * 1024);
  await writeFile(DEFAULT_STORAGE_PATH, JSON.stringify({ cookies: [{ name: "preserved", value: "cookie" }], origins: [{ origin: "https://my.tonies.com", localStorage: [{ name: "preference", value: preference }] }] }));
  const writing = async () => {
    for (let index = 0; index < 100; index++) await writeStorageAuth({ accessToken: `access-${index}`, refreshToken: `refresh-${index}` });
  };
  const reading = async () => {
    for (let index = 0; index < 300; index++) assert.equal(JSON.parse(await readFile(DEFAULT_STORAGE_PATH, "utf8")).cookies[0].value, "cookie");
  };
  const results = await Promise.allSettled([writing(), reading()]);
  for (const result of results) assert.equal(result.status, "fulfilled", result.reason?.message);
  assert.equal((await readStorageAuth()).refreshToken, "refresh-99");
  const stored = JSON.parse(await readFile(DEFAULT_STORAGE_PATH, "utf8"));
  assert.equal(stored.origins[0].localStorage.find(entry => entry.name === "preference").value, preference);
  assert.deepEqual(await readdir(directory), [DEFAULT_STORAGE_PATH]);
  if (process.platform !== "win32") assert.equal((await stat(DEFAULT_STORAGE_PATH)).mode & 0o777, 0o600);
});

test("partial storage omits missing tokens instead of stringifying undefined", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "tonies-sdk-auth-"));
  const oldCwd = process.cwd();
  t.after(() => process.chdir(oldCwd));
  process.chdir(dir);
  await writeStorageAuth({
    refreshToken: "refresh"
  });
  const storage = JSON.parse(await readFile(DEFAULT_STORAGE_PATH, "utf8"));
  const values = Object.fromEntries(storage.origins[0].localStorage.map((entry) => [entry.name, entry.value]));
  assert.deepEqual(values, { refreshToken: "refresh" });
});

test("token expiry uses the five second renewal window", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(isExpired(jwt(now + 4)), true);
  assert.equal(isExpired(jwt(now + 30)), false);
});

test("profile auth reads Chrome localStorage LevelDB records", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "tonies-sdk-profile-"));
  const oldCwd = process.cwd();
  t.after(() => process.chdir(oldCwd));
  process.chdir(dir);
  const levelPath = join(dir, DEFAULT_PROFILE_PATH, "Default", "Local Storage", "leveldb");
  const db = new ClassicLevel(levelPath, { valueEncoding: "utf8" });
  await db.open();
  await db.put("_https://my.tonies.com\x00\x01authorization", "\x01access");
  await db.put("_https://my.tonies.com\x00\x01refreshToken", "\x01refresh");
  await db.put("_https://my.tonies.com\x00\x01idToken", "\x01id");
  await db.close();
  assert.deepEqual(await readProfileAuth(), {
    accessToken: "access",
    refreshToken: "refresh",
    idToken: "id"
  });
});

test("resolve auth writes refreshed default storage tokens back to disk", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "tonies-sdk-auth-"));
  const oldCwd = process.cwd();
  const oldFetch = globalThis.fetch;
  const oldEnv = { ...process.env };
  const now = Math.floor(Date.now() / 1000);
  t.after(() => {
    process.chdir(oldCwd);
    globalThis.fetch = oldFetch;
    process.env = oldEnv;
  });
  process.chdir(dir);
  await writeStorageAuth({
    accessToken: jwt(now - 30),
    refreshToken: "old-refresh",
    idToken: "old-id"
  });
  process.env = { ...oldEnv };
  delete process.env.TONIES_ACCESS_TOKEN;
  delete process.env.TONIES_REFRESH_TOKEN;
  globalThis.fetch = async () => new Response(JSON.stringify({
    access_token: jwt(now + 3600),
    refresh_token: "new-refresh",
    id_token: "new-id"
  }));
  const auth = await resolveAuth();
  const stored = await readStorageAuth();
  assert.equal(auth.refreshToken, "new-refresh");
  assert.equal(stored.refreshToken, "new-refresh");
  assert.equal(stored.idToken, "new-id");
});

test("resolve auth reads default storage without path env vars", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "tonies-sdk-default-storage-"));
  const oldCwd = process.cwd();
  const oldEnv = { ...process.env };
  t.after(() => {
    process.chdir(oldCwd);
    process.env = oldEnv;
  });
  process.chdir(dir);
  process.env = { ...oldEnv };
  delete process.env.TONIES_ACCESS_TOKEN;
  delete process.env.TONIES_REFRESH_TOKEN;
  await writeStorageAuth({
    accessToken: jwt(Math.floor(Date.now() / 1000) + 3600),
    refreshToken: "default-refresh",
    idToken: "default-id"
  });
  const auth = await resolveAuth();
  assert.equal(auth.refreshToken, "default-refresh");
});

test("resolve auth reads default profile without path env vars", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "tonies-sdk-default-profile-"));
  const oldCwd = process.cwd();
  const oldEnv = { ...process.env };
  t.after(() => {
    process.chdir(oldCwd);
    process.env = oldEnv;
  });
  process.chdir(dir);
  process.env = { ...oldEnv };
  delete process.env.TONIES_ACCESS_TOKEN;
  delete process.env.TONIES_REFRESH_TOKEN;
  const levelPath = join(dir, DEFAULT_PROFILE_PATH, "Default", "Local Storage", "leveldb");
  const db = new ClassicLevel(levelPath, { valueEncoding: "utf8" });
  await db.open();
  await db.put("_https://my.tonies.com\x00\x01authorization", `\x01${jwt(Math.floor(Date.now() / 1000) + 3600)}`);
  await db.put("_https://my.tonies.com\x00\x01refreshToken", "\x01default-profile-refresh");
  await db.put("_https://my.tonies.com\x00\x01idToken", "\x01default-profile-id");
  await db.close();
  const auth = await resolveAuth();
  assert.equal(auth.refreshToken, "default-profile-refresh");
});
