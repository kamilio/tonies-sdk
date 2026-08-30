# Tonies SDK and CLI

Install from this repository with Node 20 or later, run `npm install`, then use `node dist/cli.js --help` (or the installed `tonies` executable).

## Authentication

Set `TONIES_EMAIL` and `TONIES_PASSWORD`, then run `tonies auth login`. The desktop CLI also reads existing Playwright storage or `TONIES_ACCESS_TOKEN` / `TONIES_REFRESH_TOKEN`. Keep `.tonies-storage.json` private. Cloud-only integrations use `TonieCloudClient` with instance-specific tokens and an `onAuth` callback; they do not use browser profiles or filesystem credentials.

## Management

```
tonies households list
tonies creative cloud-list
tonies content list
tonies tonieboxes list
tonies tonieboxes detail HOUSEHOLD BOX
tonies tonieboxes settings HOUSEHOLD BOX --max-volume 50
tonies tonieboxes settings HOUSEHOLD BOX --bedtime-lightring-brightness 20 --bedtime-max-volume 25
tonies api operations
tonies api openapi
tonies api schema
tonies raw request GET /me
tonies raw graphql --query @query.graphql --variables @variables.json
tonies raw operation households_read --parameters '{"id":"HOUSEHOLD"}'
```

`api operations` exposes the complete official REST inventory, including children, invitation links, memberships, permissions, setup, notifications, and content assignment. `raw operation` accepts each documented operation ID, its path/query parameters as JSON, and an optional JSON body; `@file` works for JSON inputs. This avoids restricting the CLI to a hand-maintained subset. API schemas are fetched live, so these discovery commands require network access.

Existing upload, chapter-edit/reorder, identity, and directory-sync commands remain available. `creative cloud-list` is read-only; the legacy identity commands can modify local config mappings and onboard unused Creative-Tonies. Never use identity discovery just to list remote Tonies in an integration.

Audio uploads use file-backed multipart bodies and fingerprints stream SHA-256 instead of buffering entire files. Local files and durations are validated before reserving an upload; do not modify a source file while it is uploading. File and directory sync analyze at most four tracks concurrently, preserve requested/natural order, and stop queued work while draining active readers if analysis fails.

## Realtime controls

```
tonies tonieboxes capabilities BOX
tonies tonieboxes watch BOX --seconds 5
tonies tonieboxes pause BOX
tonies tonieboxes play BOX
tonies tonieboxes next BOX
tonies tonieboxes previous BOX
tonies tonieboxes seek BOX 2 --ms 1500
tonies tonieboxes volume BOX 5
tonies tonieboxes night-mode BOX true --seconds 1800
tonies tonieboxes night-mode BOX false
tonies tonieboxes sleep-timer BOX 900
```

Live volume uses integer device levels 0–13, not percentage; `maxVolume` and `maxHeadphoneVolume` are separate cloud limits. Chapters are zero-based. Controls require an online box advertising the corresponding firmware feature. Homey device discovery should require both `product === "tb2"` and `generation === "tng"`, not generation alone.

Night mode here means the native **sleep timer with light** (`stl`). The bedtime light color/brightness and maximum volumes are configured separately. Cancelling the timer does not disable scheduled sunrise alarms or claim to disable every possible bedtime mode. The SDK exposes the raw bedtime reply so integrations can observe the device's actual timer state. Sleep immediately puts the box offline; there is no supported cloud wake command. MQTT publish results explicitly distinguish a broker acknowledgement from a device-confirmed state change.

## Cloud-only embedding

```js
import { TonieCloudClient, isToniebox2 } from '@kamils-jamco/tonies-sdk/cloud';
import { ToniesRealtime } from '@kamils-jamco/tonies-sdk/realtime';

const cloud = new TonieCloudClient({ auth: savedAuth, onAuth: saveAuth });
const boxes = (await cloud.listTonieboxes()).filter(isToniebox2);
const realtime = new ToniesRealtime(cloud);
realtime.on('state', event => updateDevice(event.boxId, event.state));
realtime.on('playback-started', event => triggerFlow(event.boxId));
await realtime.connect(boxes);
await realtime.sleepTimer(boxes[0].id, 1800);
await realtime.disconnect();
```

Event snapshots include `retained`, `previous`, and `state`. Retained MQTT snapshots populate capabilities but never generate transition events; duplicate packets do not trigger repeated starts. Events include playback started/paused/ended, Tonie changes, chapter changes, online changes, and sleep-timer changes. Keep cloud tokens fresh during long-running integrations by periodically reading cloud state; refreshed tokens update MQTT reconnect credentials. Disconnect on app/device removal.

Register an `error` listener when embedding the realtime client: asynchronous subscriber failures and malformed state packets are reported through that event. Raw MQTT input is also observable through `message` (topic, bytes, packet); only known subscribed topics update state, and state payloads are limited to 64 KiB. Broker loss replaces cached state with an unknown-online snapshot without firing physical-box transition events.

There can be at most 32 unacknowledged control commands. A command is removed from the MQTT outgoing store on broker loss, explicit disconnect, or acknowledgment timeout (10 seconds by default), preventing delayed replay after reconnect. State waiters are canceled on explicit disconnect. Concurrent connection attempts are rejected and partially opened connections are closed.

Automatic reconnect retries continue after a rejected CONNACK, allowing a later credential rotation to recover without restarting the client.

For device confirmation, use `withConfirmation(boxId, topic, predicate, operation)`: it starts listening before publishing, ignores cached/retained/unrelated state, and cancels the waiter if the operation fails. For example, `await realtime.withConfirmation(boxId, 'app-reply/bedtime-state', state => state.bedtime?.stl?.state === 'on', () => realtime.sleepTimer(boxId, 1800))`. A successful result includes `deviceConfirmed: true` and the matching state; this confirms the predicate, not every possible physical effect. `waitForState` also accepts a fourth options argument with `fresh`, `live`, `topic`, and an abort `signal`. At most 256 state waiters share a single pair of event listeners; synchronous telemetry bursts cannot lose a matching reply between listener registrations.

Use `await cloud.setAuth(repairedAuth)` to adopt credentials from a new login rather than assigning the public auth field. This prevents an older in-flight refresh from replacing repaired credentials. Concurrent provider lookups and refreshes share requests; late HTTP 401 responses reuse an already rotated token instead of refreshing it again. Credential persistence is serialized, keeping only the latest waiting auth update while a write is in flight; a slow older write cannot overwrite a newer persisted login, and failed writes do not poison later saves.

## Verification

`npm run test:memory` runs audio regressions with explicit garbage collection, including 128 MiB upload/hash fixtures, bounded reader concurrency, and failure drainage.

`npm test` runs offline regressions, including MQTT wire payloads, state transitions, strict device filtering, authentication isolation/rotation, and low-level operation routing. An in-memory broker exercises the real MQTT client, including timeout removal and reconnect without command replay. Destructive live Creative-Tonie tests are opt-in. Actual playback and sleep-light effects must be verified with an online device; tests using a fake broker cannot establish hardware behavior.
