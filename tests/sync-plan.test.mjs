import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { copyFile, mkdtemp, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import YAML from "yaml";
import {
  assignIdentity,
  assertChaptersMatch,
  chaptersFromSyncPlan,
  contentTypeForFile,
  fingerprintFile,
  hasOnlyIdentityAnnouncement,
  identityForTarget,
  listAudioFiles,
  localTracksFromDirectories,
  localTracksFromFiles,
  outputDirFromConfig,
  parseTarget,
  planDirectorySync,
  readIdentityDatabase,
  reconcileIdentities,
  resolveTarget,
  syncFiles,
  syncTargetsFromConfig,
  updateManifestForTarget,
  uploadFile,
  verifyChapters,
  withIdentityDatabase,
  writeIdentityDatabase,
  writeRemoteSnapshot
} from "../dist/client.js";
import { clear, migrateIdentityConfigReferences, syncIdentities } from "../dist/commands.js";

function track(title, seconds, fingerprint = title, path = `/audio/${title}.mp3`) {
  return {
    path,
    directory: "/audio",
    relativePath: path.replace("/audio/", ""),
    title,
    seconds,
    size: 1000 + seconds,
    fingerprint
  };
}

function chapter(title, seconds, id) {
  return { id, file: id, title, seconds, type: "file" };
}

async function sparseAudio(path, bytes) {
  const file = await open(path, "w");
  try {
    await file.truncate(bytes);
  } finally {
    await file.close();
  }
}

function traceAudioAnalysis(context, paths) {
  const originalStream = fs.createReadStream;
  const originalStat = fs.promises.stat;
  const trace = { active: 0, maximum: 0, visited: new Set() };
  const statMock = context.mock.method(fs.promises, "stat", (...args) => {
    if (paths.includes(args[0])) trace.visited.add(args[0]);
    return originalStat(...args);
  });
  const streamMock = context.mock.method(fs, "createReadStream", (path, options) => {
    trace.active++;
    trace.maximum = Math.max(trace.maximum, trace.active);
    const stream = Readable.from((async function* () {
      await new Promise(resolve => setTimeout(resolve, 10));
      yield* originalStream(path, options);
    })());
    let completed = false;
    const finish = () => { if (!completed) { completed = true; trace.active--; } };
    stream.once("end", finish);
    stream.once("error", finish);
    return stream;
  });
  syncBuiltinESMExports();
  context.after(() => {
    statMock.mock.restore();
    streamMock.mock.restore();
    syncBuiltinESMExports();
  });
  return trace;
}

function rng(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test("parseTarget accepts a mytonies Creative-Tonie URL", () => {
  assert.deepEqual(
    parseTarget("https://my.tonies.com/creative-tonies/a60bfacb-d087-4b5f-afa8-11fe5dc1983f/E039371D500304E0"),
    { householdId: "a60bfacb-d087-4b5f-afa8-11fe5dc1983f", creativeTonieId: "E039371D500304E0" }
  );
  assert.deepEqual(parseTarget("household/tonie"), { householdId: "household", creativeTonieId: "tonie" });
  assert.deepEqual(parseTarget("tonie"), { creativeTonieId: "tonie" });
});

test("manifest matching preserves uploads across rename and reorder", () => {
  const desired = [track("Second renamed", 20, "f2"), track("First", 10, "f1")];
  const remote = [chapter("First", 10, "id-a"), chapter("Second", 20, "id-b")];
  const manifest = {
    version: 1,
    targets: {
      "hh/ct": [
        { fingerprint: "f1", id: "id-a", file: "id-a", title: "First", seconds: 10, size: 1010, updatedAt: "2026-01-01T00:00:00.000Z" },
        { fingerprint: "f2", id: "id-b", file: "id-b", title: "Second", seconds: 20, size: 1020, updatedAt: "2026-01-01T00:00:00.000Z" }
      ]
    }
  };
  const plan = planDirectorySync("hh/ct", desired, remote, manifest);
  assert.equal(plan.uploads.length, 0);
  assert.deepEqual(plan.reused.map((item) => item.reason), ["manifest", "manifest"]);
  assert.equal(plan.changed, true);
  assert.deepEqual(chaptersFromSyncPlan(plan, []).map((item) => item.id), ["id-b", "id-a"]);
});

test("unique title and duration matches without a manifest entry", () => {
  const desired = [track("Only Song", 41, "new-fingerprint")];
  const remote = [chapter("Only Song", 40, "id-only")];
  const plan = planDirectorySync("hh/ct", desired, remote, { version: 1, targets: {} });
  assert.equal(plan.uploads.length, 0);
  assert.equal(plan.reused[0].reason, "unique-title-duration");
});

test("unique title duration handles pure reorders without a manifest", () => {
  const desired = [track("B", 20, "f-b"), track("C", 30, "f-c"), track("A", 10, "f-a")];
  const remote = [chapter("A", 10, "id-a"), chapter("B", 20, "id-b"), chapter("C", 30, "id-c")];
  const plan = planDirectorySync("hh/ct", desired, remote, { version: 1, targets: {} });
  assert.equal(plan.uploads.length, 0);
  assert.deepEqual(chaptersFromSyncPlan(plan, []).map((item) => item.id), ["id-b", "id-c", "id-a"]);
});

test("stale manifest entries do not block a title duration reuse", () => {
  const desired = [track("Song", 15, "f1")];
  const remote = [chapter("Song", 15, "new-id")];
  const manifest = {
    version: 1,
    targets: {
      "hh/ct": [
        { fingerprint: "f1", id: "old-id", file: "old-id", title: "Song", seconds: 15, size: 1015, updatedAt: "2026-01-01T00:00:00.000Z" }
      ]
    }
  };
  const plan = planDirectorySync("hh/ct", desired, remote, manifest);
  assert.equal(plan.uploads.length, 0);
  assert.equal(plan.reused[0].chapter.id, "new-id");
});

test("duplicate fingerprints can reuse multiple manifest entries", () => {
  const desired = [track("Copy One", 22, "same-fingerprint"), track("Copy Two", 22, "same-fingerprint")];
  const remote = [chapter("Copy One", 22, "id-1"), chapter("Copy Two", 22, "id-2")];
  const manifest = {
    version: 1,
    targets: {
      "hh/ct": [
        { fingerprint: "same-fingerprint", id: "id-1", file: "id-1", title: "Copy One", seconds: 22, size: 1022, updatedAt: "2026-01-01T00:00:00.000Z" },
        { fingerprint: "same-fingerprint", id: "id-2", file: "id-2", title: "Copy Two", seconds: 22, size: 1022, updatedAt: "2026-01-01T00:00:00.000Z" }
      ]
    }
  };
  const plan = planDirectorySync("hh/ct", desired, remote, manifest);
  assert.equal(plan.uploads.length, 0);
  assert.deepEqual(plan.reused.map((item) => item.chapter.id), ["id-1", "id-2"]);
});

test("duplicate title duration never reuses the same remote chapter twice", () => {
  const desired = [track("Same", 30, "f1"), track("Same", 30, "f2")];
  const remote = [chapter("Same", 30, "id-a")];
  const plan = planDirectorySync("hh/ct", desired, remote, { version: 1, targets: {} });
  assert.equal(plan.reused.length, 1);
  assert.equal(plan.uploads.length, 1);
  assert.equal(new Set(plan.reused.map((item) => item.chapter.id)).size, plan.reused.length);
});

test("remote extras are deleted from the final desired state", () => {
  const desired = [track("Keep", 12, "f1")];
  const remote = [chapter("Keep", 12, "id-a"), chapter("Delete", 9, "id-b")];
  const plan = planDirectorySync("hh/ct", desired, remote, { version: 1, targets: {} });
  assert.deepEqual(plan.deletes.map((item) => item.id), ["id-b"]);
  assert.equal(plan.changed, true);
});

test("uploaded chapters are inserted at the unmatched desired index", () => {
  const desired = [track("A", 10, "f1"), track("B", 11, "f2"), track("C", 12, "f3")];
  const remote = [chapter("A", 10, "id-a"), chapter("C", 12, "id-c")];
  const manifest = {
    version: 1,
    targets: {
      "hh/ct": [
        { fingerprint: "f1", id: "id-a", file: "id-a", title: "A", seconds: 10, size: 1010, updatedAt: "2026-01-01T00:00:00.000Z" },
        { fingerprint: "f3", id: "id-c", file: "id-c", title: "C", seconds: 12, size: 1012, updatedAt: "2026-01-01T00:00:00.000Z" }
      ]
    }
  };
  const plan = planDirectorySync("hh/ct", desired, remote, manifest);
  assert.deepEqual(plan.uploads.map((item) => item.index), [1]);
  const final = chaptersFromSyncPlan(plan, [{ index: 1, chapter: chapter("B", 11, "id-b") }]);
  assert.deepEqual(final.map((item) => item.title), ["A", "B", "C"]);
});

test("verification and assertion fail on title mismatches", () => {
  const desired = [track("Right", 7, "f1")];
  const remote = [chapter("Wrong", 7, "id-a")];
  assert.deepEqual(verifyChapters(desired, remote).ok, false);
  assert.throws(() => assertChaptersMatch(desired, remote), /Creative-Tonie chapter assertion failed/);
  assert.equal(verifyChapters([track("Exact Title", 7, "f1")], [chapter("exact-title", 7, "id-b")]).ok, false);
});

test("duration tolerance accepts two seconds and rejects three", () => {
  assert.equal(verifyChapters([track("Song", 20, "f1")], [chapter("Song", 22, "id-a")]).ok, true);
  assert.equal(verifyChapters([track("Song", 20, "f1")], [chapter("Song", 23, "id-a")]).ok, false);
});

test("manifest update records final chapter ids in desired order", () => {
  const manifest = { version: 1, targets: {} };
  const desired = [track("One", 1, "f1"), track("Two", 2, "f2")];
  const updated = updateManifestForTarget(manifest, "hh/ct", desired, [chapter("One", 1, "id-1"), chapter("Two", 2, "id-2")]);
  assert.deepEqual(updated.targets["hh/ct"].map((item) => item.id), ["id-1", "id-2"]);
  assert.deepEqual(updated.targets["hh/ct"].map((item) => item.fingerprint), ["f1", "f2"]);
});

test("remote snapshots keep timestamped version history per target", async () => {
  const root = await mkdtemp(join(tmpdir(), "tonies-snapshots-"));
  const manifestPath = join(root, "manifest.json");
  const tonie = {
    id: "ct",
    name: "Creative",
    live: true,
    private: false,
    secondsRemaining: 100,
    secondsPresent: 10,
    chapters: [chapter("Before", 10, "id-before")]
  };
  const first = await writeRemoteSnapshot(manifestPath, "hh", "ct", tonie, "2026-01-02T03:04:05.006Z");
  const second = await writeRemoteSnapshot(manifestPath, "hh", "ct", tonie, "2026-01-02T03:04:06.006Z");
  const snapshot = JSON.parse(await readFile(first, "utf8"));

  assert.notEqual(first, second);
  assert.equal(snapshot.key, "hh/ct");
  assert.equal(snapshot.remoteCount, 1);
  assert.equal(snapshot.tonie.chapters[0].title, "Before");
  assert.deepEqual((await readdir(dirname(first))).sort(), ["2026-01-02T03-04-05-006Z.json", "2026-01-02T03-04-06-006Z.json"]);
});

test("config targets and output dir resolve supported shapes", () => {
  assert.deepEqual(syncTargetsFromConfig({ tonies: ["a"] }), ["a"]);
  assert.deepEqual(syncTargetsFromConfig({ sync: { tonies: ["b"] } }), ["b"]);
  assert.deepEqual(syncTargetsFromConfig({ config: { tonies: ["c"], path: "builds/custom" } }), ["c"]);
  assert.deepEqual(syncTargetsFromConfig({ config: { id: "d", path: "builds/custom" } }), ["d"]);
  assert.deepEqual(syncTargetsFromConfig({ sync: { id: "e" } }), ["e"]);
  assert.deepEqual(syncTargetsFromConfig({ id: "f" }), ["f"]);
  assert.deepEqual(syncTargetsFromConfig({ config: { householdId: "hh", creativeTonieId: "ct" } }), [{ householdId: "hh", creativeTonieId: "ct" }]);
  assert.equal(outputDirFromConfig({ config: { path: "builds/custom" } }), "builds/custom");
  assert.equal(outputDirFromConfig({}), "builds");
});

test("sdk commands do not import root project source helpers", async () => {
  const commandsSource = await readFile(new URL("../dist/commands.js", import.meta.url), "utf8");
  assert.equal(commandsSource.includes("source_utils"), false);
  assert.equal(commandsSource.includes("buildProjectPackageInputs"), false);
});

test("audio file discovery covers API-supported extensions and stable natural order", async () => {
  const root = await mkdtemp(join(tmpdir(), "tonies-audio-files-"));
  await mkdir(join(root, "nested"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "10-last.WMA"), ""),
    writeFile(join(root, "02-second.m4b"), ""),
    writeFile(join(root, "01-first.MP3"), ""),
    writeFile(join(root, "nested", "03-third.opus"), ""),
    writeFile(join(root, "nested", "04-fourth.aiff"), ""),
    writeFile(join(root, "ignore.txt"), "")
  ]);
  assert.deepEqual(
    (await listAudioFiles(root)).map((file) => file.replace(`${root}/`, "")),
    ["01-first.MP3", "02-second.m4b", "10-last.WMA", "nested/03-third.opus", "nested/04-fourth.aiff"]
  );
});

test("content types include non-mp3 formats accepted by mytonies", () => {
  assert.equal(contentTypeForFile("song.m4b"), "audio/mp4");
  assert.equal(contentTypeForFile("song.opus"), "audio/opus");
  assert.equal(contentTypeForFile("song.wma"), "audio/x-ms-wma");
  assert.equal(contentTypeForFile("song.aif"), "audio/aiff");
});

test("sync planner fuzz preserves desired order and single-use remote chapters", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const random = rng(seed);
    const desired = Array.from({ length: 1 + Math.floor(random() * 6) }, (_, index) => {
      const seconds = 10 + Math.floor(random() * 40);
      const title = random() < 0.35 ? "Duplicate" : `Song ${Math.floor(random() * 5)}`;
      return track(title, seconds, `fingerprint-${Math.floor(random() * 5)}`, `/audio/${seed}-${index}.mp3`);
    });
    const remote = desired
      .map((item, index) => chapter(random() < 0.2 ? `${item.title} old` : item.title, item.seconds + (random() < 0.2 ? 1 : 0), `id-${seed}-${index}`))
      .filter(() => random() > 0.2)
      .sort(() => random() - 0.5);
    if (random() > 0.5) remote.push(chapter("Extra", 12, `extra-${seed}`));
    const manifest = {
      version: 1,
      targets: {
        "hh/ct": desired.map((item, index) => ({
          fingerprint: item.fingerprint,
          file: `id-${seed}-${index}`,
          id: `id-${seed}-${index}`,
          title: item.title,
          seconds: item.seconds,
          size: item.size,
          updatedAt: "2026-01-01T00:00:00.000Z"
        }))
      }
    };
    const plan = planDirectorySync("hh/ct", desired, remote, manifest);
    assert.equal(new Set(plan.reused.map((item) => item.chapter.id)).size, plan.reused.length);
    const uploaded = plan.uploads.map((item) => ({ index: item.index, chapter: chapter(item.track.title, item.track.seconds, `upload-${seed}-${item.index}`) }));
    const final = chaptersFromSyncPlan(plan, uploaded);
    assertChaptersMatch(desired, final);
  }
});

function identityTonie(id, name = "Creative Tonie", chapters = []) {
  const secondsPresent = chapters.reduce((total, item) => total + item.seconds, 0);
  return { id, name, chapters, chaptersPresent: chapters.length, secondsPresent, secondsRemaining: 5400 - secondsPresent, live: false, private: true };
}

function identityAccount(tonies, householdId = "household") {
  return { households: [{ id: householdId, name: "Household", creativeTonies: tonies }] };
}

async function identityFixture(context, tonies, remainingAnimals = ["tiger", "panda", "owl", "otter", "bear", "fox"]) {
  const root = await mkdtemp(join(tmpdir(), "tonies-identities-"));
  const previousDirectory = process.cwd();
  const previousToken = process.env.TONIES_ACCESS_TOKEN;
  context.after(() => {
    process.chdir(previousDirectory);
    if (previousToken === undefined) delete process.env.TONIES_ACCESS_TOKEN;
    else process.env.TONIES_ACCESS_TOKEN = previousToken;
  });
  process.chdir(root);
  process.env.TONIES_ACCESS_TOKEN = `header.${Buffer.from(JSON.stringify({ exp: 9999999999 })).toString("base64url")}.signature`;
  await mkdir(join(root, "configs"));
  await writeFile(join(root, "tonies-identities.json"), JSON.stringify({ version: 1, remainingAnimals, identities: {}, log: [] }));
  const audio = Buffer.alloc(16044);
  audio.write("RIFF", 0);
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8000, 24);
  audio.writeUInt32LE(16000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(16000, 40);
  const audioPath = join(root, "identity.wav");
  await writeFile(audioPath, audio);
  const cloud = { data: identityAccount(tonies), uploads: [], patches: [], spoken: [], requests: [], beforeRequest: undefined };
  context.mock.method(globalThis, "fetch", async (url, options) => {
    const pathname = new URL(url).pathname;
    const body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
    cloud.requests.push({ pathname, body, method: options.method });
    if (cloud.beforeRequest) await cloud.beforeRequest(pathname, body, options.method);
    if (pathname === "/v2/graphql") {
      const householdId = body.variables?.householdId;
      const tonieId = body.variables?.creativeTonieId;
      const data = householdId ? { households: cloud.data.households.filter(household => household.id === householdId).map(household => ({ ...household, creativeTonies: household.creativeTonies.filter(tonie => tonie.id === tonieId) })) } : cloud.data;
      return Response.json({ data });
    }
    if (pathname === "/v2/file") {
      const fileId = `blob_uploaded-${cloud.uploads.length + 1}`;
      cloud.uploads.push(fileId);
      return Response.json({ fileId, request: { url: "https://upload.invalid/audio", fields: {} } });
    }
    if (pathname === "/audio") return new Response("");
    if (options.method === "PATCH") {
      const parts = pathname.split("/");
      const household = cloud.data.households.find(entry => entry.id === parts[3]);
      const tonie = household.creativeTonies.find(entry => entry.id === parts[5]);
      cloud.patches.push({ id: tonie.id, body: structuredClone(body) });
      Object.assign(tonie, body);
      tonie.chapters = tonie.chapters.map(item => ({ ...item, id: item.file.split("_").at(-1) }));
      tonie.chaptersPresent = tonie.chapters.length;
      tonie.secondsPresent = tonie.chapters.reduce((total, item) => total + item.seconds, 0);
      return Response.json(tonie);
    }
    assert.fail(`Unexpected identity request: ${options.method} ${url}`);
  });
  const generateAudio = async codename => { cloud.spoken.push(codename); return audioPath; };
  return { root, cloud, audioPath, options: { rootDirectory: root, generateAudio }, databasePath: join(root, "tonies-identities.json") };
}

test("fingerprints match SHA-256 across multiple stream chunks", async context => {
  const root = await mkdtemp(join(tmpdir(), "tonies-fingerprints-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "audio.mp3");
  const data = Buffer.alloc(250000, 123);
  await writeFile(path, data);
  assert.equal(await fingerprintFile(path), createHash("sha256").update(data).digest("hex"));
  await writeFile(path, "");
  assert.equal(await fingerprintFile(path), createHash("sha256").digest("hex"));
  await assert.rejects(fingerprintFile(join(root, "missing.mp3")), { code: "ENOENT" });
});

test("large audio uploads do not allocate a whole-file multipart buffer", async context => {
  const { root, cloud } = await identityFixture(context, []);
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "large.mp3");
  const bytes = 128 * 1024 * 1024;
  await sparseAudio(path, bytes);
  const expected = createHash("sha256");
  const zeros = Buffer.alloc(65536);
  for (let offset = 0; offset < bytes; offset += zeros.length) expected.update(zeros);
  global.gc?.();
  const baseline = process.memoryUsage().arrayBuffers;
  let maximum = baseline;
  let prepared;
  cloud.beforeRequest = async (pathname, body) => {
    if (pathname !== "/audio") return;
    const audio = body.get("file");
    prepared = process.memoryUsage().arrayBuffers - baseline;
    assert(prepared < 8 * 1024 * 1024, `Multipart preparation allocated ${prepared} bytes for a ${bytes}-byte file`);
    assert.equal(audio.name, "blob_uploaded-1");
    assert.equal(audio.type, "audio/mpeg");
    assert.equal(audio.size, bytes);
    const uploaded = createHash("sha256");
    let chunks = 0;
    for await (const chunk of audio.stream()) {
      uploaded.update(chunk);
      if (++chunks % 128 === 0) global.gc?.();
      maximum = Math.max(maximum, process.memoryUsage().arrayBuffers);
    }
    assert.equal(uploaded.digest("hex"), expected.digest("hex"));
    let multipartBytes = 0;
    const request = new Request("https://upload.invalid/audio", { method: "POST", body });
    for await (const chunk of request.body) {
      multipartBytes += chunk.length;
      if (++chunks % 128 === 0) global.gc?.();
      maximum = Math.max(maximum, process.memoryUsage().arrayBuffers);
    }
    assert(multipartBytes > bytes && multipartBytes < bytes + 2048);
  };
  assert.deepEqual(await uploadFile(path, "Large story", 3600), { id: "blob_uploaded-1", file: "blob_uploaded-1", title: "Large story", seconds: 3600, type: "file" });
  if (global.gc) assert(maximum - baseline < 32 * 1024 * 1024);
  context.diagnostic(`128 MiB upload: prepared buffers ${prepared} bytes; peak buffer delta ${maximum - baseline} bytes${global.gc ? " with GC" : " (GC not forced)"}`);
});

test("large-file fingerprints keep bounded live buffers", async context => {
  const root = await mkdtemp(join(tmpdir(), "tonies-large-fingerprint-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "large.mp3");
  const bytes = 128 * 1024 * 1024;
  await sparseAudio(path, bytes);
  const expected = createHash("sha256");
  const zeros = Buffer.alloc(65536);
  for (let offset = 0; offset < bytes; offset += zeros.length) expected.update(zeros);
  global.gc?.();
  const baseline = process.memoryUsage().arrayBuffers;
  let maximum = baseline;
  let samples = 0;
  const sample = () => {
    if (++samples % 16 === 0) global.gc?.();
    maximum = Math.max(maximum, process.memoryUsage().arrayBuffers);
  };
  const timer = setInterval(sample, 1);
  try {
    assert.equal(await fingerprintFile(path), expected.digest("hex"));
    sample();
  } finally {
    clearInterval(timer);
  }
  assert(maximum - baseline < 64 * 1024 * 1024, `Fingerprinting retained ${maximum - baseline} bytes of buffers`);
  context.diagnostic(`128 MiB fingerprint: peak buffer delta ${maximum - baseline} bytes over ${samples} samples`);
});

test("uploads reject source modification before the file-backed body is read", async context => {
  const { root, cloud, audioPath } = await identityFixture(context, []);
  context.after(() => rm(root, { recursive: true, force: true }));
  cloud.beforeRequest = async (pathname, body) => {
    if (pathname !== "/audio") return;
    await writeFile(audioPath, "changed after preparing the upload");
    for await (const chunk of body.get("file").stream()) assert(chunk.length > 0);
  };
  await assert.rejects(uploadFile(audioPath, "Story", 1), { name: "NotReadableError" });
});

test("invalid local uploads fail before reserving remote files", async context => {
  const { root, cloud, audioPath } = await identityFixture(context, []);
  context.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(uploadFile(join(root, "missing.wav")), { code: "ENOENT" });
  await assert.rejects(uploadFile(root, "Directory", 1), /not a regular file/);
  for (const seconds of [0, -1, NaN, Infinity]) {
    await assert.rejects(uploadFile(audioPath, "Invalid duration", seconds), /Invalid upload duration/);
  }
  await writeFile(audioPath, "");
  await assert.rejects(uploadFile(audioPath, "Empty audio", 1), /Audio source is empty/);
  await writeFile(audioPath, "invalid audio");
  await assert.rejects(uploadFile(audioPath));
  assert.deepEqual(cloud.requests, []);
});

test("uploads preserve parsed duration and multipart file metadata", async context => {
  const { root, cloud, audioPath } = await identityFixture(context, []);
  context.after(() => rm(root, { recursive: true, force: true }));
  const uploaded = await uploadFile(audioPath);
  assert.deepEqual(uploaded, { id: "blob_uploaded-1", file: "blob_uploaded-1", title: "identity", seconds: 1, type: "file" });
  const file = cloud.requests.find(request => request.pathname === "/audio").body.get("file");
  assert.equal(file.type, "audio/wav");
  assert.equal(file.name, uploaded.file);
  assert.equal(file.size, 16044);
});

test("audio analysis bounds concurrent readers while preserving input order", async context => {
  const { root, audioPath } = await identityFixture(context, []);
  context.after(() => rm(root, { recursive: true, force: true }));
  const paths = Array.from({ length: 32 }, (_, index) => join(root, `${32 - index}.wav`));
  await Promise.all(paths.map(path => copyFile(audioPath, path)));
  const trace = traceAudioAnalysis(context, paths);
  const tracks = await localTracksFromFiles(paths, root);
  assert.deepEqual(tracks.map(track => track.path), paths);
  assert(tracks.every(track => track.seconds === 1 && track.fingerprint === tracks[0].fingerprint));
  assert(trace.maximum <= 4, `Opened ${trace.maximum} concurrent readers`);
  assert.equal(trace.active, 0);
  assert.equal(trace.visited.size, paths.length);
});

test("failed audio analysis stops queued work and drains active readers", async context => {
  const { root, audioPath } = await identityFixture(context, []);
  context.after(() => rm(root, { recursive: true, force: true }));
  const paths = Array.from({ length: 32 }, (_, index) => join(root, `${index}.wav`));
  await Promise.all(paths.slice(1).map(path => copyFile(audioPath, path)));
  const trace = traceAudioAnalysis(context, paths);
  await assert.rejects(localTracksFromFiles(paths, root), { code: "ENOENT" });
  assert.equal(trace.active, 0);
  assert(trace.visited.size <= 4, `Started ${trace.visited.size} files after a failed analysis`);
  assert.equal((await localTracksFromFiles([audioPath], root)).length, 1);
});

test("directory audio analysis shares one reader limit and preserves natural ordering", async context => {
  const { root, audioPath } = await identityFixture(context, []);
  context.after(() => rm(root, { recursive: true, force: true }));
  const directories = [join(root, "second"), join(root, "first")];
  await Promise.all(directories.map(directory => mkdir(directory)));
  const paths = directories.flatMap(directory => Array.from({ length: 12 }, (_, index) => join(directory, `${index + 1}.wav`)));
  await Promise.all(paths.map(path => copyFile(audioPath, path)));
  const trace = traceAudioAnalysis(context, paths);
  const tracks = await localTracksFromDirectories(directories);
  assert.deepEqual(tracks.map(track => track.path), paths);
  assert.deepEqual(tracks.map(track => track.directory), paths.map(path => dirname(path)));
  assert(trace.maximum <= 4, `Opened ${trace.maximum} concurrent readers across directories`);
  assert.equal(trace.active, 0);
  assert.deepEqual(await localTracksFromDirectories([]), []);
  assert.deepEqual(await localTracksFromFiles([]), []);
});

test("audio analysis rejects directories before opening a reader", async context => {
  const { root } = await identityFixture(context, []);
  context.after(() => rm(root, { recursive: true, force: true }));
  const trace = traceAudioAnalysis(context, [root]);
  await assert.rejects(localTracksFromFiles([root]), /not a regular file/);
  assert.equal(trace.maximum, 0);
});

test("animal assignments cover occupied Tonies, survive reordering and absence, and never recycle", async () => {
  const database = await readIdentityDatabase(join(await mkdtemp(join(tmpdir(), "tonies-pool-")), "identities.json"));
  assert(database.remainingAnimals.length > 250);
  assert.equal(new Set(database.remainingAnimals).size, database.remainingAnimals.length);
  const initialAnimals = [...database.remainingAnimals];
  const first = identityAccount([identityTonie("occupied", "My music"), identityTonie("empty")]);
  reconcileIdentities(database, first, "2026-08-01");
  assert.equal(identityForTarget(database, "empty").codename, initialAnimals.at(-1));
  assert.equal(identityForTarget(database, "occupied").codename, initialAnimals.at(-2));
  assert.deepEqual(database.remainingAnimals, initialAnimals.slice(0, -2));
  reconcileIdentities(database, identityAccount([identityTonie("occupied", "New title")]), "2026-08-02");
  assert.equal(identityForTarget(database, "empty").present, false);
  reconcileIdentities(database, identityAccount([identityTonie("new"), ...first.households[0].creativeTonies.reverse()]), "2026-08-03");
  assert.equal(identityForTarget(database, "empty").codename, initialAnimals.at(-1));
  assert.equal(identityForTarget(database, "new").codename, initialAnimals.at(-3));
  assert.deepEqual(database.remainingAnimals, initialAnimals.slice(0, -3));
  assert.equal(database.log.length, 3);
  assert.equal(identityForTarget(database, "empty").firstSeen, "2026-08-01");
  assert.equal(identityForTarget(database, "empty").lastSeen, "2026-08-03");
  database.remainingAnimals = [];
  assert.throws(() => reconcileIdentities(database, identityAccount([identityTonie("another")])), /unused animals/);
});

test("manual codenames are unique, case insensitive, and retain reserved historical aliases", async () => {
  const database = { version: 1, remainingAnimals: ["otter", "bear", "fox"], identities: {}, log: [] };
  reconcileIdentities(database, identityAccount([identityTonie("one"), identityTonie("two")]));
  const fox = identityForTarget(database, "FOX");
  assignIdentity(database, fox, "  Red-Panda  ");
  assert.equal(identityForTarget(database, "fox"), fox);
  assert.equal(identityForTarget(database, { codename: "red-panda", householdId: "household" }), fox);
  assert.equal(identityForTarget(database, { codename: "red-panda", householdId: "other" }), undefined);
  assert.throws(() => assignIdentity(database, identityForTarget(database, "bear"), "fox"), /reserved/);
  assert.throws(() => assignIdentity(database, fox, "../bad"), /animal codename/);
  assignIdentity(database, fox, "fox");
  assert.deepEqual(fox.aliases, ["red-panda"]);
  assert.equal(database.log.at(-1).previous, "red-panda");
  assert.deepEqual(database.remainingAnimals, ["otter"]);
});

test("identity writes are atomic and locked throughout asynchronous work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tonies-lock-"));
  const databasePath = join(directory, "identities.json");
  const nextAnimal = (await readIdentityDatabase(databasePath)).remainingAnimals.at(-1);
  await withIdentityDatabase(async database => {
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(withIdentityDatabase(async () => assert.fail("Concurrent lock acquired"), databasePath), { code: "EEXIST" });
    reconcileIdentities(database, identityAccount([identityTonie("one")]));
    await writeIdentityDatabase(database, databasePath);
  }, databasePath);
  assert.equal(identityForTarget(await readIdentityDatabase(databasePath), nextAnimal).id, "one");
  await assert.rejects(withIdentityDatabase(async () => { throw new Error("interrupted"); }, databasePath), /interrupted/);
  await withIdentityDatabase(async database => assert.equal(database.log.length, 1), databasePath);
});

test("config migration covers scalar, object, URL, array, inherited and ignored references without rewriting content", async () => {
  const root = await mkdtemp(join(tmpdir(), "tonies-migration-"));
  const configs = join(root, "configs");
  await mkdir(configs);
  const database = { version: 1, remainingAnimals: ["bear", "fox"], identities: {}, log: [] };
  reconcileIdentities(database, identityAccount([identityTonie("one"), identityTonie("two")]));
  const sources = {
    "parent.yaml": 'config:\n  id: "one" # keep this\n  title: "one"\n',
    "child.yaml": 'extends: parent.yaml\nconfig:\n  title: Child\n',
    "array.yaml": 'tonies:\n  - household/one\n  - id: two\n    householdId: household\nconfig:\n  path: builds/one\n',
    "url.yaml": 'sync:\n  id: https://my.tonies.com/creative-tonies/household/one\n',
    "object.yaml": 'config:\n  creativeTonieId: one\n  householdId: household\n',
    "unknown.yaml": 'id: unknown\n'
  };
  for (const [file, contents] of Object.entries(sources)) await writeFile(join(configs, file), contents);
  await writeFile(join(root, "tonies-ignore.yaml"), 'ignored:\n  - id: two\n    name: Untouched\n');
  assert.equal((await migrateIdentityConfigReferences(configs, database)).length, 5);
  assert.equal(await readFile(join(configs, "parent.yaml"), "utf8"), 'config:\n  id: "fox" # keep this\n  title: "one"\n');
  assert.deepEqual(YAML.parse(await readFile(join(configs, "array.yaml"), "utf8")).tonies, ["fox", { id: "bear", householdId: "household" }]);
  assert.equal(await readFile(join(configs, "child.yaml"), "utf8"), sources["child.yaml"]);
  assert.equal(await readFile(join(configs, "unknown.yaml"), "utf8"), sources["unknown.yaml"]);
  assert.deepEqual(await migrateIdentityConfigReferences(configs, database), []);
});

test("discovery announces only truly unused Tonies and keeps identity-only Tonies free on repeated scans", async context => {
  const fixture = await identityFixture(context, [
    identityTonie("available"),
    identityTonie("configured"),
    identityTonie("ignored"),
    identityTonie("occupied", "Bedtime", [chapter("Story", 100, "story")]),
    identityTonie("spoof", "Creative Tonie", [chapter("Tonie identity: fox", 1, "not-our-upload")])
  ]);
  await writeFile(join(fixture.root, "configs", "parent.yaml"), "config:\n  id: configured\n");
  await writeFile(join(fixture.root, "configs", "child.yaml"), "extends: parent.yaml\n");
  await writeFile(join(fixture.root, "tonies-ignore.yaml"), "ignored:\n  - id: ignored\n");
  const before = structuredClone(fixture.cloud.data);
  const first = await syncIdentities(fixture.options);
  assert.equal(first.tonies.length, 5);
  assert.deepEqual(first.tonies.filter(row => row.free).map(row => row.id), ["available"]);
  assert(first.tonies.find(row => row.id === "available").identityOnly);
  assert.equal(first.tonies.find(row => row.id === "configured").configs, "child.yaml, parent.yaml");
  assert.equal(fixture.cloud.uploads.length, 1);
  assert.equal(fixture.cloud.patches.length, 1);
  assert.deepEqual(Object.keys(fixture.cloud.patches[0].body), ["chapters"]);
  for (const tonie of before.households[0].creativeTonies.slice(1)) assert.deepEqual(fixture.cloud.data.households[0].creativeTonies.find(entry => entry.id === tonie.id), tonie);
  const second = await syncIdentities(fixture.options);
  assert.equal(fixture.cloud.uploads.length, 1);
  assert.equal(fixture.cloud.patches.length, 1);
  assert.deepEqual(second.tonies.filter(row => row.free).map(row => row.codename), ["fox"]);
  assert.equal((await readIdentityDatabase(fixture.databasePath)).log.length, 5);
  const renamed = await syncIdentities({ ...fixture.options, assignment: { target: "fox", codename: "red-panda" } });
  assert.equal(renamed.tonies.find(row => row.id === "available").codename, "red-panda");
  assert.equal(fixture.cloud.uploads.length, 2);
  assert.equal(fixture.cloud.data.households[0].creativeTonies[0].name, "Creative Tonie");
  assert.deepEqual(await resolveTarget("FOX"), { householdId: "household", creativeTonieId: "available" });
  assert.deepEqual(await resolveTarget({ codename: "RED-PANDA" }), { householdId: "household", creativeTonieId: "available" });
  const occupied = renamed.tonies.find(row => row.id === "occupied");
  await writeFile(join(fixture.root, "configs", "occupied.yaml"), `config:\n  id: ${occupied.codename}\n`);
  await syncIdentities({ ...fixture.options, assignment: { target: occupied.codename, codename: "snow-leopard" } });
  assert.equal(YAML.parse(await readFile(join(fixture.root, "configs", "occupied.yaml"), "utf8")).config.id, "snow-leopard");
  assert.equal(fixture.cloud.patches.length, 2);
  fixture.cloud.data = identityAccount([]);
  await assert.rejects(resolveTarget("red-panda"), /not found/);
});

test("identity provenance rejects titles, short content, extra chapters, and transcoding alone", () => {
  const announcement = { codename: "fox", chapter: { ...chapter("Tonie identity: fox", 2, "proof"), type: "file" } };
  const identity = { announcement };
  assert(hasOnlyIdentityAnnouncement(identity, [announcement.chapter]));
  assert(!hasOnlyIdentityAnnouncement(identity, [{ ...announcement.chapter, id: "other" }]));
  assert(!hasOnlyIdentityAnnouncement(identity, [{ ...announcement.chapter, file: "other" }]));
  assert(!hasOnlyIdentityAnnouncement(identity, [{ ...announcement.chapter, title: "Other" }]));
  assert(!hasOnlyIdentityAnnouncement(identity, [{ ...announcement.chapter, transcoding: true }]));
  assert(!hasOnlyIdentityAnnouncement(identity, [{ ...announcement.chapter, seconds: 0 }]));
  assert(!hasOnlyIdentityAnnouncement(identity, [announcement.chapter, chapter("Story", 2, "extra")]));
});

test("interrupted onboarding resumes a persisted upload without duplicate uploads", async context => {
  const fixture = await identityFixture(context, [identityTonie("available")]);
  fixture.cloud.beforeRequest = async (pathname, body, method) => { if (method === "PATCH") throw new Error("interrupted before patch"); };
  await assert.rejects(syncIdentities(fixture.options), /interrupted before patch/);
  const pending = identityForTarget(await readIdentityDatabase(fixture.databasePath), "fox").pendingAnnouncement;
  assert.equal(pending.chapter.id, "blob_uploaded-1");
  fixture.cloud.beforeRequest = undefined;
  const resumed = await syncIdentities(fixture.options);
  assert(resumed.tonies[0].free);
  assert.equal(fixture.cloud.uploads.length, 1);
  assert.equal(fixture.cloud.patches.length, 1);
  assert.equal(identityForTarget(await readIdentityDatabase(fixture.databasePath), "fox").pendingAnnouncement, undefined);
});

test("onboarding rechecks remote content before attaching any identity audio", async context => {
  const fixture = await identityFixture(context, [identityTonie("available")]);
  fixture.cloud.beforeRequest = async pathname => {
    if (pathname === "/audio") Object.assign(fixture.cloud.data.households[0].creativeTonies[0], identityTonie("available", "Creative Tonie", [chapter("New story", 20, "new-story")]));
  };
  const result = await syncIdentities(fixture.options);
  assert.equal(result.tonies[0].free, false);
  assert.equal(fixture.cloud.patches.length, 0);
  assert.equal(fixture.cloud.data.households[0].creativeTonies[0].chapters[0].id, "new-story");
  await syncIdentities(fixture.options);
  assert.equal(fixture.cloud.uploads.length, 1);
});

test("normal config-target sync replaces the announcement and is idempotent by codename", async context => {
  const fixture = await identityFixture(context, [identityTonie("available")]);
  await syncIdentities(fixture.options);
  await writeFile(join(fixture.root, "configs", "story.yaml"), "config:\n  id: fox\n");
  const options = { manifestPath: join(fixture.root, "manifest.json"), verifyDelayMs: 0 };
  const first = await syncFiles("fox", [fixture.audioPath], options);
  assert.equal(first.uploads.length, 1);
  assert.equal(first.deletes.length, 1);
  const second = await syncFiles({ id: "fox" }, [fixture.audioPath], options);
  assert.equal(second.uploads.length, 0);
  assert.equal(second.patched, false);
  assert.equal(second.verification.ok, true);
  const listed = await syncIdentities(fixture.options);
  assert.equal(listed.tonies[0].free, false);
  assert.equal(fixture.cloud.uploads.length, 2);
});

test("read-only discovery previews assignments and migrations without local or cloud writes", async context => {
  const fixture = await identityFixture(context, [identityTonie("available"), identityTonie("configured")]);
  const configPath = join(fixture.root, "configs", "project.yaml");
  const source = "config:\n  id: configured\n";
  await writeFile(configPath, source);
  const beforeFiles = await readdir(fixture.root);
  const beforeDatabase = await readFile(fixture.databasePath, "utf8");
  const preview = await syncIdentities({ ...fixture.options, dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.deepEqual(preview.migrated, [configPath]);
  assert.equal(preview.tonies[0].codename, "fox");
  assert.equal(preview.tonies[0].announcementNeeded, true);
  assert.deepEqual(await readdir(fixture.root), beforeFiles);
  assert.equal(await readFile(fixture.databasePath, "utf8"), beforeDatabase);
  assert.equal(await readFile(configPath, "utf8"), source);
  assert.equal(fixture.cloud.uploads.length, 0);
  assert.equal(fixture.cloud.patches.length, 0);
  assert.deepEqual(fixture.cloud.spoken, []);
});

test("onboarding resumes after the server canonicalizes a pending chapter ID", async context => {
  const fixture = await identityFixture(context, [identityTonie("available")]);
  fixture.cloud.beforeRequest = async pathname => {
    if (pathname === "/v2/graphql" && fixture.cloud.patches.length) throw new Error("interrupted after patch");
  };
  await assert.rejects(syncIdentities(fixture.options), /interrupted after patch/);
  fixture.cloud.beforeRequest = undefined;
  assert.equal(fixture.cloud.data.households[0].creativeTonies[0].chapters[0].id, "uploaded-1");
  const result = await syncIdentities(fixture.options);
  assert(result.tonies[0].free);
  assert.equal(fixture.cloud.uploads.length, 1);
  assert.equal(fixture.cloud.patches.length, 1);
  const identity = identityForTarget(await readIdentityDatabase(fixture.databasePath), "fox");
  assert.equal(identity.announcement.chapter.id, "uploaded-1");
  assert.equal(identity.announcement.chapter.file, "blob_uploaded-1");
  assert.equal(identity.pendingAnnouncement, undefined);
});

test("renaming an identity-only Tonie resumes safely after an interrupted replacement", async context => {
  const fixture = await identityFixture(context, [identityTonie("available")]);
  await syncIdentities(fixture.options);
  fixture.cloud.beforeRequest = async (pathname, body, method) => { if (method === "PATCH") throw new Error("interrupted replacement"); };
  await assert.rejects(syncIdentities({ ...fixture.options, assignment: { target: "fox", codename: "red-panda" } }), /interrupted replacement/);
  const interrupted = identityForTarget(await readIdentityDatabase(fixture.databasePath), "red-panda");
  assert.equal(interrupted.announcement.codename, "fox");
  assert.equal(interrupted.pendingAnnouncement.codename, "red-panda");
  fixture.cloud.beforeRequest = undefined;
  const result = await syncIdentities(fixture.options);
  assert.equal(result.tonies[0].codename, "red-panda");
  assert(result.tonies[0].free);
  assert.equal(fixture.cloud.uploads.length, 2);
  assert.equal(fixture.cloud.patches.length, 2);
});

test("multiple households retain independent hardware mappings and ignore exclusions", async context => {
  const fixture = await identityFixture(context, [identityTonie("same")]);
  fixture.cloud.data.households.push({ id: "other", name: "Other", creativeTonies: [identityTonie("same")] });
  await writeFile(join(fixture.root, "tonies-ignore.yaml"), "ignored:\n  - householdId: other\n    id: same\n");
  const result = await syncIdentities(fixture.options);
  assert.equal(new Set(result.tonies.map(row => row.codename)).size, 2);
  assert.equal(result.tonies.filter(row => row.free).length, 1);
  assert.equal(result.tonies.find(row => row.householdId === "other").ignored, true);
  await assert.rejects(resolveTarget("same"), /Ambiguous/);
  for (const row of result.tonies) assert.deepEqual(await resolveTarget(row.codename), { householdId: row.householdId, creativeTonieId: row.id });
});

test("clear preserves the codename and restores its announcement without leaving inherited associations", async context => {
  const fixture = await identityFixture(context, [identityTonie("available")]);
  await syncIdentities(fixture.options);
  const configPath = join(fixture.root, "configs", "story.yaml");
  const manifestPath = join(fixture.root, "manifest.json");
  await writeFile(configPath, "config:\n  id: fox\n  title: Story\n");
  await writeFile(manifestPath, JSON.stringify({ version: 1, targets: { "household/available": [] } }));
  const cleared = await clear(configPath, manifestPath, fixture.options.generateAudio);
  assert.equal(cleared.codename, "fox");
  assert.equal(cleared.free, true);
  assert.equal(cleared.identityOnly, true);
  assert.equal(YAML.parse(await readFile(configPath, "utf8")).config.id, undefined);
  assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).targets["household/available"], undefined);
  assert.equal(identityForTarget(await readIdentityDatabase(fixture.databasePath), "fox").id, "available");
  await writeFile(join(fixture.root, "configs", "parent.yaml"), "id: fox\n");
  await writeFile(configPath, "extends: parent.yaml\n");
  const shared = await clear(configPath, manifestPath, fixture.options.generateAudio);
  assert.equal(shared.free, false);
  assert.equal(shared.configs, "parent.yaml");
  assert.deepEqual(YAML.parse(await readFile(configPath, "utf8")).tonies, []);
  await writeFile(configPath, "tonies: [fox, bear]\n");
  const patchCount = fixture.cloud.patches.length;
  await assert.rejects(clear(configPath, manifestPath, fixture.options.generateAudio), /exactly one/);
  assert.equal(fixture.cloud.patches.length, patchCount);
});

test("discovery pops the saved animal list and speaks that animal without prioritizing empty Tonies", async context => {
  const fixture = await identityFixture(context, [identityTonie("first", "Occupied"), identityTonie("second")], ["ibis", "mole", "yak"]);
  const result = await syncIdentities(fixture.options);
  assert.deepEqual(result.tonies.map(tonie => tonie.codename), ["yak", "mole"]);
  assert.deepEqual(fixture.cloud.spoken, ["mole"]);
  assert.equal(fixture.cloud.patches[0].body.chapters[0].title, "Tonie identity: mole");
  assert.deepEqual((await readIdentityDatabase(fixture.databasePath)).remainingAnimals, ["ibis"]);
  fixture.cloud.data.households[0].creativeTonies.push(identityTonie("third"));
  await syncIdentities(fixture.options);
  assert.deepEqual(fixture.cloud.spoken, ["mole", "ibis"]);
  const database = await readIdentityDatabase(fixture.databasePath);
  assert.deepEqual(database.remainingAnimals, []);
  assert.deepEqual(database.log.map(entry => entry.codename), ["yak", "mole", "ibis"]);
});
