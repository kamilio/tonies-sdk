# Tonies SDK and CLI

Install from this repository with Node 20.5 or later, run `npm install`, then use `node dist/cli.js --help` (or the installed `tonies` executable).

## Authentication

Set `TONIES_EMAIL` and `TONIES_PASSWORD`, then run `tonies auth login`. The desktop CLI also reads existing Playwright storage or `TONIES_ACCESS_TOKEN` / `TONIES_REFRESH_TOKEN`. Keep `.tonies-storage.json` private. Cloud-only integrations use `TonieCloudClient` with instance-specific tokens and an `onAuth` callback; they do not use browser profiles or filesystem credentials.

Desktop credential storage, identity databases, sync manifests, and remote snapshots are written to private temporary files, flushed, and atomically renamed into place. Concurrent readers see complete JSON, failed writes preserve the previous file, and token updates retain other browser-storage fields. On POSIX systems these files are owner-readable/writable only (`0600`); this does not coordinate refresh-token rotation between separate processes.

Before discarding a cloud client, stop its realtime connection and other request producers, then await `cloud.flushAuth()`. This drains already-started authentication and token persistence without starting a new request, so an in-flight refresh cannot lose its rotated refresh token during teardown. Keep the persistence callback active until draining finishes, and serialize replacement clients behind that barrier. Authentication or persistence failures still reject after the pending work settles.

Failed HTTP response streams are canceled before status errors are surfaced, including the final failed response after a token-refresh retry; error bodies are not downloaded into memory.

The desktop management and authentication paths also use 15-second request deadlines and reject redirects. Uploads reject redirects and release their response streams on success or failure; their file-backed transfer is not subject to the short metadata-request deadline.

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
tonies tonieboxes seek BOX 2
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

Event snapshots include `retained`, `previous`, and `state`. Retained MQTT snapshots populate capabilities but never generate transition events; duplicate packets do not trigger repeated starts. Events include playback started/paused/ended, Tonie changes, chapter changes, online changes, and sleep-timer changes. Realtime connections check credentials every 30 seconds without polling cloud/device state; valid instance tokens require no HTTP request, while near-expiry tokens refresh and update MQTT reconnect credentials. External auth providers are queried on that schedule and retain their own refresh policy. Only one credential lookup can run at a time, and disconnect clears the unreferenced maintenance timer. Disconnect on app/device removal.

Register an `error` listener when embedding the realtime client: asynchronous subscriber failures and malformed state packets are reported through that event. Raw MQTT input is also observable through `message` (topic, bytes, packet); only known subscribed topics update state, and state payloads are limited to 64 KiB. Broker loss replaces cached state with an unknown-online snapshot without firing physical-box transition events; buffered packets from a disconnected transport cannot restore stale state.

There can be at most 32 active control commands, including relative controls still waiting for telemetry and commands awaiting acknowledgment; excess commands reject before allocating state waits. A command is removed from the MQTT outgoing store on broker loss, explicit disconnect, or acknowledgment timeout (10 seconds by default), preventing delayed replay after reconnect. Relative volume/chapter controls reject disconnected brokers before waiting for telemetry; pending control-state waits stop when the box goes offline or the broker disconnects. State waiters are canceled on explicit disconnect. Concurrent connection attempts are rejected and partially opened connections are closed.

Automatic reconnect retries continue after a rejected CONNACK, allowing a later credential rotation to recover without restarting the client.

For device confirmation, use `withConfirmation(boxId, topic, predicate, operation)`: it starts listening before publishing, ignores cached/retained/unrelated state, and cancels the waiter if the operation fails. For example, `await realtime.withConfirmation(boxId, 'app-reply/bedtime-state', state => state.bedtime?.stl?.state === 'on', () => realtime.sleepTimer(boxId, 1800))`. A successful result includes `deviceConfirmed: true` and the matching state; this confirms the predicate, not every possible physical effect. `waitForState` also accepts a fourth options argument with `fresh`, `live`, `topic`, and an abort `signal`. At most 256 state waiters share a single pair of event listeners; synchronous telemetry bursts cannot lose a matching reply between listener registrations.

Use `await cloud.setAuth(repairedAuth)` to adopt credentials from a new login rather than assigning the public auth field. This prevents an older in-flight refresh from replacing repaired credentials. Concurrent provider lookups and refreshes share requests; late HTTP 401 responses reuse an already rotated token instead of refreshing it again. Credential persistence is serialized, keeping only the latest waiting auth update while a write is in flight; a slow older write cannot overwrite a newer persisted login, and failed writes do not poison later saves.

Live device confirmations are scoped to the current broker connection: disconnect rejects an outstanding confirmation even after broker acknowledgment, and reconnect cannot satisfy it with an unrelated later reply. Overlapping confirmed controls for the same box/topic are rejected because device replies have no request correlation IDs; await the previous action before starting another. Ordinary state observation can continue across reconnects.

Realtime commands started inside a confirmation operation inherit its cancellation, including commands delayed by asynchronous work or missing telemetry. Timeout removes pending commands from the outgoing store and prevents later publication; nested confirmations inherit parent cancellation without affecting unrelated controls. The operation callback also receives an `AbortSignal` for your own asynchronous work. Cancellation cannot undo a command already processed by the device.

For a device lifecycle or caller-owned cancellation scope, use `realtime.withCancellation(signal, operation)`. SDK controls and nested confirmations inside the callback inherit that signal without closing the shared MQTT connection; unrelated devices remain usable. The scope also expires when the callback settles, preventing asynchronous work left behind by the callback from publishing later. Custom asynchronous work must honor the callback's supplied signal, and callers should drain their pending operations before releasing the shared account.

`realtime.withConnection(operation)` additionally binds work to the current connected broker session, including any parent cancellation scope. A broker disconnect invalidates the whole operation even if MQTT reconnects before delayed work resumes; it cannot publish commands against the replacement connection. This is useful when serializing multi-step controls that first wait for telemetry.

Playback controls also reject a known Tonie replacement during asynchronous command preparation, before publishing. Chapter indices must be nonnegative safe integers. On the Toniebox 2 tested on August 30, 2026, a nonzero `ms` offset was ignored and the chapter restarted; high-level seeking therefore selects chapters only and rejects nonzero time offsets. A paused chapter-selection reply may omit position and duration, so chapter confirmation does not claim an exact time position. Relative chapter and volume methods use the current cached telemetry; serialize and confirm repeated relative controls so each operation uses the preceding device result rather than repeating a stale target.

When a box goes offline, its playback, volume, bedtime, and headphone snapshots become unknown until new telemetry arrives; waking alone does not restore these stale values. Battery readings remain available as last-known measurements.

## Verification

`npm run test:memory` runs realtime and audio regressions with explicit garbage collection, including 100 real MQTT connection lifecycles against an in-memory broker, 10,000 confirmed controls, retained-heap bounds, 128 MiB upload/hash fixtures, bounded reader concurrency, and failure drainage.

Set `TONIES_CONTROL_SOAK_ITERATIONS` from 1 to 1000000 to scale the confirmed-control memory benchmark; the default is 10000. This benchmark uses simulated device replies, not physical controls, and keeps the same retained-heap limit at higher iteration counts.

`TONIES_LIVE_SOAK=1 node --test --test-name-pattern='read-only idle' tests/real-box.test.mjs` runs a seven-minute, read-only MQTT token-expiry soak using your existing account credentials. Set `TONIES_LIVE_SOAK_SECONDS` to an integer from 420 to 86400 for a longer run; `TONIES_LIVE_SOAK=1 TONIES_LIVE_SOAK_SECONDS=1800 node --expose-gc tests/real-box.test.mjs` also samples post-GC heap during a thirty-minute run. Boxes may remain offline; the test sends no device commands or REST state polls after connecting, and verifies credential renewal, bounded state/listener counts, plus usable state after reconnect. It refreshes/persists authentication, so do not run multiple live auth processes against the same stored refresh token concurrently.

`npm test` runs offline regressions, including MQTT wire payloads, state transitions, strict device filtering, authentication isolation/rotation, and low-level operation routing. An in-memory broker exercises the real MQTT client, including timeout removal and reconnect without command replay. Destructive live Creative-Tonie tests are opt-in. Actual playback and sleep-light effects must be verified with an online device; tests using a fake broker cannot establish hardware behavior.
