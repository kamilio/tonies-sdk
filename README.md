# Tonies SDK

**Your Tonies account, Creative-Tonies, and Toniebox controls—from a terminal or JavaScript.**

[![Checks](https://github.com/kamilio/tonies-sdk/actions/workflows/test.yml/badge.svg)](https://github.com/kamilio/tonies-sdk/actions/workflows/test.yml)
![Node.js](https://img.shields.io/badge/Node.js-20.5%2B-43853d)
![License](https://img.shields.io/badge/license-MIT-blue)

Start bedtime mode. Pause a story. Upload your own chapters. Watch playback events. Inspect the REST, GraphQL, and MQTT messages underneath it all.

**Unofficial, cloud-connected, and not affiliated with Tonies.** Playback controls depend on the box's firmware features; Toniebox 2 is the live-tested target. There is no remote wake or precise time seeking.

**[Get started](#get-started) · [Recipes](#recipes) · [Command cards](#command-cards) · [JavaScript](#javascript) · [Events and wire topics](#events-and-wire-topics) · [Limits](#what-works-and-what-doesnt)**

Want buttons and automations instead? **[Toniebox 2 for Homey](https://github.com/kamilio/tonies-homey)** uses this SDK.

## Get started

### 1. Install directly from GitHub

Requires **Git and Node.js 20.5+**. No npm publication, GitHub account, or private package registry is needed.

```sh
npm install --global 'git+https://github.com/kamilio/tonies-sdk.git'
tonies --help
```

For an existing JavaScript project:

```sh
npm install 'git+https://github.com/kamilio/tonies-sdk.git'
```

npm builds the SDK during installation. Commit your application's lockfile to keep the resolved GitHub commit pinned; add `#COMMIT_SHA` to the Git URL when you want an explicit revision.

### 2. Sign in

In bash or zsh, enter your password without putting it in shell history:

```sh
export TONIES_EMAIL='you@example.com'
printf 'Tonies password: '
read -r -s TONIES_PASSWORD
printf '\n'
export TONIES_PASSWORD
tonies auth login
unset TONIES_PASSWORD
```

Login saves rotating tokens in **`.tonies-storage.json` in the current directory**. Run subsequent commands from that directory. Keep this file private and out of version control. Existing tokens can instead be supplied through `TONIES_ACCESS_TOKEN` and `TONIES_REFRESH_TOKEN`.

### 3. Find your box and Tonies

```sh
tonies households list
tonies tonieboxes list
tonies creative cloud-list
tonies content list
```

Use the returned IDs in the examples: `BOX` is a Toniebox ID, `HOUSEHOLD` a household ID, and `CREATIVE` a Creative-Tonie ID. They are placeholders, not names to enter literally.

> **Listing must stay read-only?** Use `creative cloud-list`. The legacy `creative list`, `identities`, `free`, and `config-map` workflows manage local identities and can onboard unused Creative-Tonies; they are not interchangeable with a cloud inventory.

## Recipes

### Bedtime in three commands

Wake the box physically first, then configure the light and start its native sleep-light timer:

```sh
tonies tonieboxes settings HOUSEHOLD BOX --bedtime-lightring-color '#ff8800' --bedtime-lightring-brightness 15 --bedtime-max-volume 25
tonies tonieboxes night-mode BOX true --seconds 1800
tonies tonieboxes watch BOX --seconds 10
```

Stop that timer without changing scheduled sunrise alarms:

```sh
tonies tonieboxes night-mode BOX false
```

Night mode means **sleep timer with light**, not a simulated Homey/host timer. Bedtime settings can affect playback volume. The timer duration here is in **seconds**.

### Pause, turn it down, continue

```sh
tonies tonieboxes pause BOX
tonies tonieboxes volume BOX 4
tonies tonieboxes play BOX
```

Live volume is an integer **0–13**, not a percentage. To cap the speaker separately:

```sh
tonies tonieboxes settings HOUSEHOLD BOX --max-volume 50
```

### Jump to the third chapter

```sh
tonies tonieboxes seek BOX 2
```

SDK/CLI chapters start at **0**. This selects the chapter's beginning; it does not seek to a time within it. Next and previous use the box's current playback state.

### Add two recordings to a Creative-Tonie

Inspect the target first, then append audio without replacing the existing playlist:

```sh
tonies creative detail HOUSEHOLD CREATIVE
tonies creative upload HOUSEHOLD CREATIVE ./hello.mp3 ./story.mp3 --mode append
tonies creative refresh HOUSEHOLD CREATIVE
```

Rename a chapter or change its position using IDs returned by `detail`:

```sh
tonies creative edit-chapter HOUSEHOLD CREATIVE CHAPTER_A --title 'A new adventure'
tonies creative reorder-chapters HOUSEHOLD CREATIVE CHAPTER_B CHAPTER_A
```

Unlisted chapters stay at the end. Uploads change cloud content; they do not remotely wake a box or force it to download immediately.

### Make a Creative-Tonie match a local folder

**This reconciles the cloud playlist with local audio, including removing content that is no longer in the desired playlist.** Preview before applying:

```sh
tonies sync directories HOUSEHOLD/CREATIVE ./bedtime-audio --dry-run
tonies sync directories HOUSEHOLD/CREATIVE ./bedtime-audio
tonies sync assert-directories HOUSEHOLD/CREATIVE ./bedtime-audio
```

Multiple directories are accepted in playlist order. Sync minimizes uploads and verifies transcoding. There is no SDK `sync config` command; this CLI works directly with audio directories.

### Look underneath the high-level API

```sh
tonies api map
tonies api operations
tonies api openapi
tonies api schema
tonies raw request GET /me
tonies raw operation households_read --parameters '{"id":"HOUSEHOLD"}'
tonies raw graphql --query @query.graphql --variables @variables.json
```

`operations` and `openapi` fetch the server's REST inventory, not just this CLI's named commands. Inspect an operation's required parameters before invoking it. GraphQL schema discovery reports the server's available query types; no GraphQL mutations or remote box pull/sync endpoint were found during investigation.

A low-level **volume write** looks like this:

```sh
tonies raw mqtt BOX volume '{"level":4}'
```

This is a real device command, not a dry run. An MQTT broker acknowledgment alone is **not** device confirmation.

## Command cards

Every row below names a command or command family; use `tonies GROUP COMMAND --help` for its complete arguments. Commands that write, remove, assign, clear, or sync content act on your real account.

### Toniebox controls

| Command | What it does |
| --- | --- |
| `tonies tonieboxes list` | Find boxes across your households. |
| `tonies tonieboxes detail HOUSEHOLD BOX` | Read settings, firmware, and feature flags. |
| `tonies tonieboxes capabilities BOX` | Check supported controls and explicit limitations. |
| `tonies tonieboxes watch BOX --seconds 30` | Collect live and retained state for a bounded interval. |
| `tonies tonieboxes play BOX` | Resume playback; does not wake a sleeping box. |
| `tonies tonieboxes pause BOX` | Pause the current story. |
| `tonies tonieboxes next BOX` | Select the next chapter. |
| `tonies tonieboxes previous BOX` | Select the previous chapter. |
| `tonies tonieboxes seek BOX 0` | Select the first chapter; zero-based, no time offset. |
| `tonies tonieboxes volume BOX 4` | Set live volume, integer 0–13. |
| `tonies tonieboxes volume-up BOX` | Raise live volume one device step. |
| `tonies tonieboxes volume-down BOX` | Lower live volume one device step. |
| `tonies tonieboxes night-mode BOX true --seconds 1800` | Start 30 minutes of sleep timer with light. |
| `tonies tonieboxes night-mode BOX false` | Cancel the sleep-light timer. |
| `tonies tonieboxes sleep-timer BOX 900` | Start a 15-minute sleep-light timer; `0` cancels. |
| `tonies tonieboxes sleep BOX` | Sleep now; **physical interaction is needed to wake**. |
| `tonies tonieboxes settings HOUSEHOLD BOX --max-volume 50` | Change cloud settings, not live playback volume. |
| `tonies tonieboxes playback-info BOX TONIE` | Read a playing Tonie's metadata and chapters. |
| `tonies tonieboxes add HOUSEHOLD --id BOX` | Add an already-set-up original Toniebox; not TB2 setup. |
| `tonies tonieboxes delete HOUSEHOLD BOX` | **Reset and remove** a box from the household. |

<details>
<summary><strong>Settings flag card</strong> — lights, volume limits, gestures, language</summary>

All flags belong to `tonies tonieboxes settings HOUSEHOLD BOX`.

| Flags | Values / meaning |
| --- | --- |
| `--name` | Box display name. |
| `--max-volume`, `--max-headphone-volume` | Speaker/headphone caps: 25, 50, 75, or 100. |
| `--bedtime-max-volume`, `--bedtime-max-headphone-volume` | Nighttime speaker/headphone caps: 1–100. |
| `--lightring-brightness`, `--bedtime-lightring-brightness` | Normal/night light brightness: 0–100. |
| `--bedtime-lightring-color` | Lowercase hex color, e.g. `'#ff8800'`. |
| `--led-level` | `on`, `off`, or `dimmed`; device-dependent. |
| `--accelerometer-enabled`, `--skipping-enabled`, `--scrubbing-enabled` | Boolean gesture settings; device-dependent. |
| `--tap-direction`, `--skipping-direction` | `left` or `right`. |
| `--age-mode` | `1+` or `3+`. |
| `--language`, `--timezone` | Language (`de`, `en`, `en-us`, `fr`) and timezone. |

Not every generation supports every setting. Check `detail` and `capabilities` before writing.

</details>

### Tonies and account management

Each entry in the middle column is a subcommand of the named group.

| Group | Commands | Use it for |
| --- | --- | --- |
| `auth` | `login`, `refresh` | Sign in and renew stored tokens. |
| `auth` | `extract-storage`, `extract-profile` | Read existing browser credentials; **output contains secrets**. |
| `account` | `me`, `config`, `notifications`, `invitations`, `accept-invitation` | Account details, upload configuration, and received invitations. |
| `households` | `list`, `detail`, `create`, `settings`, `delete`, `children` | Household inventory, settings, and child profile listing. |
| `households` | `members`, `set-member`, `remove-member` | Membership access; assigning `owner` transfers ownership. |
| `households` | `invitations`, `invite`, `resend-invitation`, `delete-invitation` | Household sharing. |
| `creative` | `cloud-list`, `detail`, `refresh` | Read-only inventory, chapters, and processing state. |
| `creative` | `rename`, `set-flags`, `upload` | Name, live/private flags, and audio upload. |
| `creative` | `save-chapters`, `edit-chapter`, `reorder-chapters`, `delete-chapter` | Playlist replacement, editing, ordering, and removal. |
| `creative` | `permissions`, `set-permission`, `redeem-token`, `delete` | Access, content redemption, and household removal. |
| `creative` | `list`, `identities`, `assign`, `free`, `config-map`, `clear` | Local identity/config workflows; **not a read-only listing API**. |
| `content` | `list`, `detail`, `set-lock`, `delete` | Content-Tonie inventory, lock state, and household removal. |
| `tunes` | `list`, `assign`, `remove` | Owned digital content and assignment to a Tonie. |
| `sync` | `directories`, `assert-directories` | Reconcile local audio and verify cloud content. |
| `sync` | `assert-roundtrip` | **Destructive live exercise**: edits, deletes, reorders, and resyncs; requires `--force`. |
| `api` | `map`, `openapi`, `operations`, `schema` | Endpoint map, REST specification, and GraphQL discovery. |
| `raw` | `request`, `operation`, `graphql`, `mqtt` | Direct REST, operation-ID, GraphQL, and MQTT access. |

## JavaScript

Use the **cloud** and **realtime** entry points for integrations; they avoid loading the desktop CLI and local identity/audio tooling.

This ESM example starts a 30-minute night timer on `TONIES_BOX_ID`, waits for a matching device reply, and logs playback starts for one minute. Supply `TONIES_ACCESS_TOKEN` securely with a currently valid token; this short-lived example does not persist credentials.

```js
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { TonieCloudClient, isToniebox2 } from '@kamils-jamco/tonies-sdk/cloud';
import { ToniesRealtime } from '@kamils-jamco/tonies-sdk/realtime';

const cloud = new TonieCloudClient({
  auth: { accessToken: process.env.TONIES_ACCESS_TOKEN },
});
const boxes = (await cloud.listTonieboxes()).filter(isToniebox2);
const box = boxes.find(candidate => candidate.id === process.env.TONIES_BOX_ID);
assert(box, 'Select a Toniebox 2 belonging to this account');

const realtime = new ToniesRealtime(cloud);
realtime.on('error', console.error);
realtime.on('playback-started', event => {
  console.log('Playing', event.boxId, event.state.playback?.tonie);
});

try {
  await realtime.connect([box]);
  await realtime.withConfirmation(
    box.id,
    'app-reply/bedtime-state',
    state => state.bedtime?.stl?.state === 'on' && state.bedtime.stl.duration === 1800,
    () => realtime.sleepTimer(box.id, 1800),
  );
  await setTimeout(60_000);
} finally {
  await realtime.disconnect();
  await cloud.flushAuth();
}
```

The timer continues on the box after this program exits. For a long-running integration, provide account-specific `auth` with a refresh token and an `onAuth` callback that saves rotated tokens in your private credential store; see [session and confirmation details](USAGE.md#authentication). Do not run multiple independent refresh processes against the same stored refresh token.

| SDK call | Meaning |
| --- | --- |
| `cloud.listTonieboxes()` | List account boxes. |
| `cloud.getToniebox(householdId, boxId)` | Read full box details. |
| `cloud.setTonieboxSettings(householdId, boxId, settings)` | Write cloud settings. |
| `realtime.play(boxId)` / `realtime.pause(boxId)` | Resume / pause. |
| `realtime.skip(boxId, 1)` / `realtime.skip(boxId, -1)` | Next / previous chapter. |
| `realtime.seek(boxId, 2)` | Select chapter 3; no nonzero time offsets. |
| `realtime.setVolume(boxId, 4)` | Live volume 0–13. |
| `realtime.changeVolume(boxId, 1)` | One step louder; use `-1` for quieter. |
| `realtime.sleepTimer(boxId, 1800)` | Native night mode; `0` stops it. |
| `realtime.sleep(boxId)` | Put the box to sleep; no remote wake. |
| `realtime.command(boxId, 'volume', { level: 4 })` | Raw app-control command. |
| `realtime.withConfirmation(boxId, topic, predicate, operation)` | Require fresh matching device telemetry, not just broker ACK. |

Await confirmed relative controls one at a time so rapid volume/chapter changes use fresh state. A broker disconnect invalidates pending confirmations; commands are not replayed later after reconnect.

## Events and wire topics

Subscribe with `realtime.on(eventName, listener)`. State/transition events carry `{ boxId, topic, payload, retained, previous, state }`.

| SDK event | When it fires |
| --- | --- |
| `state` | A recognized state update, including retained snapshots and connection invalidation. |
| `playback-started` | Playback becomes active, including resume. |
| `playback-paused` | Playback changes from unpaused to paused. |
| `playback-ended` | The box reports an ended transition; not merely going offline. |
| `tonie-changed` | Tonie identity changes from a previous playback snapshot. |
| `chapter-changed` | Chapter changes from a previous playback snapshot. |
| `sleep-timer-changed` | The native sleep-light state changes. |
| `online-changed` | Box online-state telemetry changes. |
| `connected`, `disconnected` | MQTT broker connection lifecycle, not a physical wake/sleep guarantee. |
| `message` | Raw `(topic, bytes, packet)` from MQTT. |
| `error` | Connection, malformed-packet, or asynchronous subscriber failures. |

Retained snapshots initialize state without generating playback transition events. Duplicate state does not repeatedly fire transition events. Battery, headphones, volume, and settings updates are available through `state`.

<details>
<summary><strong>MQTT topic card</strong> — state beneath the events</summary>

Transport: MQTT 5 over authenticated WebSockets. These are topic suffixes; the SDK resolves the selected box's routing.

| Topic suffix | State |
| --- | --- |
| `online-state` | Connected / offline. |
| `playback/state` | Tonie, chapter, pause/end flags, and available position information. |
| `volume/state` | Current device volume. |
| `app-reply/bedtime-state` | Sleep timer with light, under `stl`. |
| `metrics/battery` | Battery percentage/status. |
| `metrics/headphones` | Headphone connection information. |
| `settings-applied` | Settings application status. |

Raw replies and field types are available in [the realtime module](src/realtime.ts). Wire behavior can change with firmware; inspect actual replies instead of assuming a publish changed the device.

</details>

## What works and what doesn't

| Capability | Status |
| --- | --- |
| Night mode on/off, pause/resume, live volume, next chapter | Verified on a real Toniebox 2 on **August 30, 2026**. |
| Other exposed controls and settings | Implemented; support depends on firmware features and is not uniformly hardware-verified. |
| Exact time seeking | **Unsupported.** The tested box restarted the selected chapter instead of honoring nonzero `ms`; high-level calls reject that offset. |
| Remote wake | **Unavailable.** Wake the box physically by squeezing an ear. |
| Remote Tonie selection | No supported action to summon an arbitrary figurine's content; playback acts on the current Tonie. |
| Remote pull/sync | No discovered command to force a box to download cloud changes. |
| Offline/LAN-only controls | Not provided; cloud access is required. |

### Something not responding?

- **Box offline:** wake it, check Wi-Fi, then run `tonies tonieboxes watch BOX --seconds 10`.
- **Unsupported control:** inspect `tonies tonieboxes capabilities BOX` and firmware details; an original Toniebox does not gain TB2 playback controls through this SDK.
- **Volume looks wrong:** live level is 0–13; normal/nighttime percentage caps are separate settings.
- **Session expired:** run `tonies auth login` from the directory where you keep credentials; do not share token files in an issue.
- **Cloud upload isn't on the box yet:** cloud content management and physical device download are separate operations.

[Report a reproducible issue](https://github.com/kamilio/tonies-sdk/issues) with the command, SDK revision, Node version, box generation, firmware, and redacted output. Never include passwords, token files, raw authenticated captures, or private device identifiers. Pull requests are welcome; [USAGE.md](USAGE.md) covers the detailed API contracts.

## License

MIT. Tonies names and trademarks belong to their respective owners; this project is independent.

<details>
<summary>MIT license text</summary>

Copyright (c) 2026 Kamil Jopek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

</details>
