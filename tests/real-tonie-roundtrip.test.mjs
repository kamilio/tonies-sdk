import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  assertChaptersMatch,
  fetchCreativeTonie,
  localTracksFromDirectories,
  patchCreativeTonie,
  resolveTarget,
  syncDirectories
} from "../dist/client.js";

const run = promisify(execFile);
const target = process.env.TONIES_E2E_TARGET;
const directories = (process.env.TONIES_E2E_DIRS ?? "").split(delimiter).filter(Boolean);
const manifestPath = process.env.TONIES_E2E_MANIFEST_PATH ?? ".tonies-sync-e2e-manifest.json";

test("real Creative-Tonie sync roundtrip uploads, edits, deletes, reorders, and verifies", { skip: !target || directories.length === 0 }, async () => {
  await run(process.execPath, [
    "dist/cli.js",
    "sync",
    "assert-roundtrip",
    target,
    ...directories,
    "--manifest-path",
    manifestPath,
    "--verify-attempts",
    "10",
    "--verify-delay-ms",
    "6000"
  ], {
    env: process.env,
    timeout: 600000
  });
});

async function assertRemoteMatches(target, directories) {
  const resolved = await resolveTarget(target);
  const desired = await localTracksFromDirectories(directories);
  const tonie = await fetchCreativeTonie(resolved.householdId, resolved.creativeTonieId);
  return assertChaptersMatch(desired, tonie.chapters);
}

test("real Creative-Tonie sync edge matrix keeps output exact", { skip: !target || directories.length === 0, timeout: 1200000 }, async () => {
  const fixtures = await localTracksFromDirectories(directories);
  assert.ok(fixtures.length >= 2);
  const resolved = await resolveTarget(target);
  const root = join(tmpdir(), `tonies-edge-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const manifestPath = join(root, "manifest.json");
  const options = { manifestPath, verifyAttempts: 12, verifyDelayMs: 5000 };
  const empty = join(root, "empty");
  const one = join(root, "one");
  const two = join(root, "two");
  const duplicateOne = join(root, "duplicate-one", "nested");
  const duplicateTwo = join(root, "duplicate-two");
  const renamedOne = join(root, "renamed-one");
  const renamedTwo = join(root, "renamed-two", "nested");
  const dry = join(root, "dry");
  const configDir = join(root, "config-dir");
  const configPath = join(root, "config.yaml");
  await mkdir(empty, { recursive: true });
  await mkdir(join(one, "nested"), { recursive: true });
  await mkdir(two, { recursive: true });
  await mkdir(duplicateOne, { recursive: true });
  await mkdir(duplicateTwo, { recursive: true });
  await mkdir(renamedOne, { recursive: true });
  await mkdir(renamedTwo, { recursive: true });
  await mkdir(dry, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await copyFile(fixtures[0].path, join(one, "nested", "01 Alpha & Spaces!.MP3"));
  await copyFile(fixtures[1].path, join(two, "02 Beta.mp3"));
  await copyFile(fixtures[0].path, join(duplicateOne, "01 Same.mp3"));
  await copyFile(fixtures[0].path, join(duplicateTwo, "01 Same.mp3"));
  await copyFile(fixtures[0].path, join(renamedOne, "01 Same renamed.mp3"));
  await copyFile(fixtures[0].path, join(renamedTwo, "02 Same renamed.mp3"));
  await copyFile(fixtures[1].path, join(dry, "03 Dry Run Only.mp3"));
  await copyFile(fixtures[0].path, join(configDir, "01 Config Sync.mp3"));
  await copyFile(fixtures[1].path, join(configDir, "02 Config Sync.mp3"));
  await writeFile(configPath, [
    "tonies:",
    `  - householdId: ${resolved.householdId}`,
    `    creativeTonieId: ${resolved.creativeTonieId}`,
    "config:",
    `  path: ${JSON.stringify(configDir)}`
  ].join("\n"));

  const reset = await syncDirectories(target, [empty], options);
  assert.equal(reset.desiredCount, 0);
  assert.equal(reset.uploads.length, 0);
  await assertRemoteMatches(target, [empty]);

  const first = await syncDirectories(target, [one, two], options);
  assert.equal(first.uploads.length, 2);
  await assertRemoteMatches(target, [one, two]);

  const second = await syncDirectories(target, [one, two], options);
  assert.equal(second.uploads.length, 0);
  assert.equal(second.patched, false);

  const dryRun = await syncDirectories(target, [one, two, dry], { ...options, dryRun: true });
  assert.equal(dryRun.uploads.length, 1);
  await assertRemoteMatches(target, [one, two]);

  const duplicates = await syncDirectories(target, [duplicateOne, duplicateTwo], options);
  assert.equal(duplicates.uploads.length, 1);
  await assertRemoteMatches(target, [duplicateOne, duplicateTwo]);

  const duplicateAgain = await syncDirectories(target, [duplicateOne, duplicateTwo], options);
  assert.equal(duplicateAgain.uploads.length, 0);
  assert.equal(duplicateAgain.patched, false);

  const afterDuplicates = await fetchCreativeTonie(resolved.householdId, resolved.creativeTonieId);
  await patchCreativeTonie(resolved.householdId, resolved.creativeTonieId, { chapters: [...afterDuplicates.chapters].reverse() });
  const reorderRepair = await syncDirectories(target, [duplicateOne, duplicateTwo], options);
  assert.equal(reorderRepair.uploads.length, 0);
  await assertRemoteMatches(target, [duplicateOne, duplicateTwo]);

  const renameRepair = await syncDirectories(target, [renamedOne, renamedTwo], options);
  assert.equal(renameRepair.uploads.length, 0);
  await assertRemoteMatches(target, [renamedOne, renamedTwo]);

  const afterRename = await fetchCreativeTonie(resolved.householdId, resolved.creativeTonieId);
  await patchCreativeTonie(resolved.householdId, resolved.creativeTonieId, { chapters: afterRename.chapters.map((chapter, index) => index === 0 ? { ...chapter, title: "Remote Wrong Title" } : chapter) });
  const editRepair = await syncDirectories(target, [renamedOne, renamedTwo], options);
  assert.equal(editRepair.uploads.length, 0);
  await assertRemoteMatches(target, [renamedOne, renamedTwo]);

  const afterEdit = await fetchCreativeTonie(resolved.householdId, resolved.creativeTonieId);
  await patchCreativeTonie(resolved.householdId, resolved.creativeTonieId, { chapters: afterEdit.chapters.slice(1) });
  const deleteRepair = await syncDirectories(target, [renamedOne, renamedTwo], options);
  assert.equal(deleteRepair.uploads.length, 1);
  await assertRemoteMatches(target, [renamedOne, renamedTwo]);

  await run(process.execPath, [
    "dist/cli.js",
    "sync",
    "config",
    configPath,
    "--manifest-path",
    manifestPath,
    "--verify-attempts",
    "12",
    "--verify-delay-ms",
    "5000"
  ], {
    env: process.env,
    timeout: 600000
  });
  await assertRemoteMatches(target, [configDir]);

  const emptySync = await syncDirectories(target, [empty], options);
  assert.equal(emptySync.uploads.length, 0);
  await assertRemoteMatches(target, [empty]);

  const emptyAgain = await syncDirectories(target, [empty], options);
  assert.equal(emptyAgain.uploads.length, 0);
  assert.equal(emptyAgain.patched, false);

  const restore = await syncDirectories(target, directories, options);
  assert.equal(restore.uploads.length, fixtures.length);
  const final = await assertRemoteMatches(target, directories);
  assert.equal(final.count, fixtures.length);
});

test("real Creative-Tonie creative CLI commands upload edit reorder delete and save", { skip: !target || directories.length === 0, timeout: 1200000 }, async () => {
  const fixtures = await localTracksFromDirectories(directories);
  assert.ok(fixtures.length >= 2);
  const resolved = await resolveTarget(target);
  const root = join(tmpdir(), `tonies-creative-cli-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const empty = join(root, "empty");
  const manifestPath = join(root, "manifest.json");
  await mkdir(empty, { recursive: true });
  await syncDirectories(target, [empty], { manifestPath, verifyAttempts: 12, verifyDelayMs: 5000 });

  await run(process.execPath, [
    "dist/cli.js",
    "creative",
    "upload",
    resolved.householdId,
    resolved.creativeTonieId,
    fixtures[0].path,
    "--titles",
    "CLI Upload One",
    "--mode",
    "replace"
  ], { env: process.env, timeout: 600000 });
  let chapters = (await fetchCreativeTonie(resolved.householdId, resolved.creativeTonieId)).chapters;
  assert.deepEqual(chapters.map((chapter) => chapter.title), ["CLI Upload One"]);

  await run(process.execPath, [
    "dist/cli.js",
    "creative",
    "upload",
    resolved.householdId,
    resolved.creativeTonieId,
    fixtures[1].path,
    "--titles",
    "CLI Upload Two"
  ], { env: process.env, timeout: 600000 });
  chapters = (await fetchCreativeTonie(resolved.householdId, resolved.creativeTonieId)).chapters;
  assert.deepEqual(chapters.map((chapter) => chapter.title), ["CLI Upload One", "CLI Upload Two"]);

  await run(process.execPath, [
    "dist/cli.js",
    "creative",
    "edit-chapter",
    resolved.householdId,
    resolved.creativeTonieId,
    chapters[0].id,
    "--title",
    "CLI Edited One"
  ], { env: process.env, timeout: 600000 });
  chapters = (await fetchCreativeTonie(resolved.householdId, resolved.creativeTonieId)).chapters;
  assert.deepEqual(chapters.map((chapter) => chapter.title), ["CLI Edited One", "CLI Upload Two"]);

  await run(process.execPath, [
    "dist/cli.js",
    "creative",
    "reorder-chapters",
    resolved.householdId,
    resolved.creativeTonieId,
    chapters[1].id,
    chapters[0].id
  ], { env: process.env, timeout: 600000 });
  chapters = (await fetchCreativeTonie(resolved.householdId, resolved.creativeTonieId)).chapters;
  assert.deepEqual(chapters.map((chapter) => chapter.title), ["CLI Upload Two", "CLI Edited One"]);

  await run(process.execPath, [
    "dist/cli.js",
    "creative",
    "delete-chapter",
    resolved.householdId,
    resolved.creativeTonieId,
    chapters[1].file
  ], { env: process.env, timeout: 600000 });
  chapters = (await fetchCreativeTonie(resolved.householdId, resolved.creativeTonieId)).chapters;
  assert.deepEqual(chapters.map((chapter) => chapter.title), ["CLI Upload Two"]);

  await run(process.execPath, [
    "dist/cli.js",
    "creative",
    "save-chapters",
    resolved.householdId,
    resolved.creativeTonieId,
    "[]"
  ], { env: process.env, timeout: 600000 });
  chapters = (await fetchCreativeTonie(resolved.householdId, resolved.creativeTonieId)).chapters;
  assert.deepEqual(chapters, []);

  await syncDirectories(target, directories, { manifestPath, verifyAttempts: 12, verifyDelayMs: 5000 });
  const final = await assertRemoteMatches(target, directories);
  assert.equal(final.count, fixtures.length);
});

test("real Creative-Tonie sync handles duplicate titles across subset superset and order swaps", { skip: !target || directories.length === 0, timeout: 1200000 }, async () => {
  const fixtures = await localTracksFromDirectories(directories);
  assert.ok(fixtures.length >= 2);
  const root = join(tmpdir(), `tonies-subset-superset-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const empty = join(root, "empty");
  const first = join(root, "first", "nested");
  const second = join(root, "second");
  const manifestPath = join(root, "manifest.json");
  await mkdir(empty, { recursive: true });
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  await writeFile(join(first, "not-audio.txt"), "ignored");
  await copyFile(fixtures[0].path, join(first, "01 Same Title.mp3"));
  await copyFile(fixtures[1].path, join(second, "01 Same Title.mp3"));

  await syncDirectories(target, [empty], { manifestPath, verifyAttempts: 12, verifyDelayMs: 5000 });
  const full = await syncDirectories(target, [join(root, "first"), second], { manifestPath, verifyAttempts: 12, verifyDelayMs: 5000 });
  assert.equal(full.uploads.length, 2);
  await assertRemoteMatches(target, [join(root, "first"), second]);

  const fullAgain = await syncDirectories(target, [join(root, "first"), second], { manifestPath, verifyAttempts: 12, verifyDelayMs: 5000 });
  assert.equal(fullAgain.uploads.length, 0);
  assert.equal(fullAgain.patched, false);

  const subset = await syncDirectories(target, [second], { manifestPath, verifyAttempts: 12, verifyDelayMs: 5000 });
  assert.equal(subset.uploads.length, 0);
  await assertRemoteMatches(target, [second]);

  const superset = await syncDirectories(target, [join(root, "first"), second], { manifestPath, verifyAttempts: 12, verifyDelayMs: 5000 });
  assert.equal(superset.uploads.length, 1);
  await assertRemoteMatches(target, [join(root, "first"), second]);

  const swapped = await syncDirectories(target, [second, join(root, "first")], { manifestPath, verifyAttempts: 12, verifyDelayMs: 5000 });
  assert.equal(swapped.uploads.length, 0);
  await assertRemoteMatches(target, [second, join(root, "first")]);

  const swappedAgain = await syncDirectories(target, [second, join(root, "first")], { manifestPath, verifyAttempts: 12, verifyDelayMs: 5000 });
  assert.equal(swappedAgain.uploads.length, 0);
  assert.equal(swappedAgain.patched, false);

  await syncDirectories(target, directories, { manifestPath, verifyAttempts: 12, verifyDelayMs: 5000 });
  const final = await assertRemoteMatches(target, directories);
  assert.equal(final.count, fixtures.length);
});
