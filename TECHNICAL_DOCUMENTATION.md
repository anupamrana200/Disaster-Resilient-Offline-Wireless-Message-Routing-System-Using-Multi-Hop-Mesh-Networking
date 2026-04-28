# DisasterMesh — Technical Documentation

**Disaster-Resilient Offline Wireless Message Routing System Using Multi-Hop Mesh Networking**

This document is a deep technical reference for the DisasterMesh application. It enumerates every feature, the file(s) that implement it, and the actual code segments that power the implementation. It is intended for engineers extending or auditing the system.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Tech Stack & Project Layout](#2-tech-stack--project-layout)
3. [Application Bootstrap & Navigation](#3-application-bootstrap--navigation)
4. [State Management (Redux Toolkit)](#4-state-management-redux-toolkit)
5. [Persistent Identity (`useNodeId`)](#5-persistent-identity-usenodeid)
6. [BLE Layer — `useBLE` & `BLEService`](#6-ble-layer--useble--bleservice)
7. [Phone-to-Phone BLE Mesh (`PhoneMeshService`)](#7-phone-to-phone-ble-mesh-phonemeshservice)
8. [Meshtastic LoRa Bridge (`MeshtasticService`)](#8-meshtastic-lora-bridge-meshtasticservice)
9. [Core Mesh Engine (`useMesh`)](#9-core-mesh-engine-usemesh)
10. [Storage & Persistence](#10-storage--persistence)
11. [Notifications](#11-notifications)
12. [Debug Log Subsystem](#12-debug-log-subsystem)
13. [UI — Chat / Nodes / Settings Screens](#13-ui--chat--nodes--settings-screens)
14. [Mock Layer (Expo Go fallback)](#14-mock-layer-expo-go-fallback)
15. [Permissions & Platform Configuration](#15-permissions--platform-configuration)
16. [Wire Formats](#16-wire-formats)
17. [Deduplication Strategy (3-Layer)](#17-deduplication-strategy-3-layer)

---

## 1. System Overview

DisasterMesh is an Android-first, offline messaging app that creates an ad‑hoc multi‑hop mesh between nearby phones using BLE, and optionally bridges to long-range LoRa using Meshtastic ESP32 nodes over BLE GATT. No internet, no cellular, no central server.

```
Phone A ──BLE──► Phone B ──BLE──► Meshtastic ──LoRa──► Phone C
(sender)         (relay)          (gateway)             (recipient)
```

Two transports run in parallel:
- **Phone-mesh** — BLE *advertisement* broadcasting (connectionless), implemented in `services/phone-mesh.service.ts`.
- **Meshtastic LoRa** — BLE *GATT* with hand-rolled protobuf to drive a Meshtastic radio, implemented in `services/meshtastic.service.ts`.

The orchestration hook `useMesh` (`hooks/useMesh.ts`) chooses the route, deduplicates, persists, relays, and exposes a single API to the UI.

---

## 2. Tech Stack & Project Layout

| Layer | Technology |
|---|---|
| Framework | React Native + Expo SDK 54 |
| Language | TypeScript (strict mode) |
| Navigation | Expo Router v6 (flat, file-based) |
| State | Redux Toolkit + react-redux |
| BLE GATT | `react-native-ble-plx` |
| BLE Advertising/Scan | `react-native-ble-advertiser` |
| Storage | `@react-native-async-storage/async-storage` |
| Notifications | `expo-notifications` + `Vibration` |
| Animation | `react-native-reanimated`, `Animated` |
| Routing | Expo Router v6 |

Key dependencies (`package.json:30-77`):
```json
"react-native-ble-plx": "^3.5.1",            // BLE GATT client/central — connect & read/write characteristics
"react-native-ble-advertiser": "^0.0.17",    // BLE peripheral advertising + raw scan with manufacturer data
"@reduxjs/toolkit": "^2.5.0",                // Predictable global state with slices and async thunks
"@react-native-async-storage/async-storage": "2.2.0",  // Key-value persistence backing Messages/Nodes/Identity
"expo-notifications": "~0.32.16",            // Local push notifications when a mesh message arrives
"buffer": "^6.0.3",                          // Node Buffer polyfill — used for base64 ↔ bytes conversion
"uuid": "^13.0.0"                            // RFC4122 v4 UUIDs for stable device + message IDs
```

Directory map:
```
app/                   Expo Router routes (chat, nodes, settings)
components/            Reusable UI (chat/, elements/, layouts/, nodes/)
hooks/                 useMesh, useBLE, useNodeId, useKeyboard, useDataPersist, useColorScheme
services/              BLE / phone-mesh / meshtastic / storage / notification / debug-log + adapters + mocks
slices/                Redux Toolkit slices (app, messages, nodes)
providers/             Redux + ThemeProvider + GestureHandler root
theme/                 Colors / fonts / images
types/                 Message, MeshNode, env types
utils/                 store, config, deviceInfo
```

---

## 3. Application Bootstrap & Navigation

### 3.1 Root layout — `app/_layout.tsx`

Loads fonts/images, hides splash screen, registers notification channel, and mounts the providers tree.

```tsx
// Polyfill MUST be the very first import — uuid uses crypto.getRandomValues which Hermes lacks
import 'react-native-get-random-values';
import * as SplashScreen from 'expo-splash-screen';
import { Slot } from 'expo-router';

// Tell Expo to keep the splash screen visible until we manually hide it
SplashScreen.preventAutoHideAsync();

function Router() {
  useEffect(() => {
    // Async IIFE — preload assets concurrently then drop the splash and request notif perms
    (async () => {
      try { await Promise.all([loadImages(), loadFonts()]); }   // Parallelize image + font loading
      finally {
        SplashScreen.hideAsync();                                // Always hide splash, even on asset failure
        setupNotifications().catch(...);                         // Fire-and-forget; do NOT block UI on this
      }
    })();
  }, []); // Empty deps — run exactly once on mount
  // <Slot /> is Expo Router's outlet — renders the active route tree
  return (<><Slot /><StatusBar style="light" /></>);
}

export default function RootLayout() {
  // Wrap every route with the global Provider tree (Redux + Theme + Gesture)
  return <Provider><Router /></Provider>;
}
```

### 3.2 Provider tree — `providers/Provider.tsx`

```tsx
// GestureHandlerRootView MUST be the outermost wrapper for react-native-gesture-handler to work
<GestureHandlerRootView style={{ flex: 1 }}>
  {/* Redux store is injected here so every screen/hook can use useDispatch/useSelector */}
  <ReduxProvider store={store}>
    {/* Switches React Navigation's color tokens based on the OS color scheme */}
    <ThemeProvider value={isDark ? DarkTheme : DefaultTheme}>
      {children}
    </ThemeProvider>
  </ReduxProvider>
</GestureHandlerRootView>
```

### 3.3 Tab navigation — `app/(main)/(tabs)/_layout.tsx`

Three tabs (Chat, Nodes, Settings) with safe-area aware bottom padding and dark theme colors.

```tsx
<Tabs screenOptions={{ headerShown: false,                       // Hide the default top header — screens render their own
  tabBarStyle: {
    backgroundColor: '#0d1117',                                  // Dark theme matching app background
    height: 60 + bottom,                                         // Add system inset so tab bar clears the gesture bar
    paddingBottom: 8 + bottom                                    // Push content up by the same inset
  },
  tabBarActiveTintColor: '#00c896' }}>                           // Teal accent for the focused tab
  {/* File-based routing: each screen maps to a file under app/(main)/(tabs)/ */}
  <Tabs.Screen name="chat/index"     options={{ title: 'Chat',     tabBarIcon: ... }}/>
  <Tabs.Screen name="nodes/index"    options={{ title: 'Nodes',    tabBarIcon: ... }}/>
  <Tabs.Screen name="settings/index" options={{ title: 'Settings', tabBarIcon: ... }}/>
</Tabs>
```

`app/index.tsx` redirects to chat:
```tsx
export default function Index() {
  // Skip the implicit landing page — open the Chat tab right after splash
  return <Redirect href="/(main)/(tabs)/chat" />;
}
```

---

## 4. State Management (Redux Toolkit)

Store at `utils/store.ts` composes three slices: `app`, `messages`, `nodes`. In dev, `redux-logger` is appended to middleware.

```ts
const store = configureStore({
  reducer: { app, messages, nodes },                             // Three top-level slices combined into root state
  middleware: getDefaultMiddleware =>
    isDev
      // serializableCheck disabled because we hold non-serializable objects (e.g. timers, Sets) in transit
      ? getDefaultMiddleware({ serializableCheck: false }).concat(logger)  // Dev: console-log every action
      : getDefaultMiddleware({ serializableCheck: false }),                // Prod: skip the logger overhead
  devTools: isDev,                                                // Connect to Redux DevTools only in dev
});
```

### 4.1 `slices/messages.slice.ts`

State shape:
```ts
interface MessagesState {
  messages: Message[];        // Full chat history — both sent and received
  pendingQueue: Message[];    // Outbound messages awaiting a peer to reach
  seenIds: string[];          // In-memory dedup cache so relay echoes get dropped
  isLoading: boolean;         // True while loadMessagesAsync is hydrating from AsyncStorage
}
```

Async thunks: `loadMessagesAsync`, `addMessageAsync`, `enqueueMessageAsync`, `dequeueMessageAsync`, `updateStatusAsync`, `pruneExpiredAsync`. Each thunk reads/writes through `services/storage.service.ts` and updates the slice via `extraReducers`.

Critical dedup logic in the `addMessageAsync.fulfilled` reducer (handles relay echoes that carry an 8-char short ID while the original has a full UUID):

```ts
builder.addCase(addMessageAsync.fulfilled, (state, { payload }) => {
  // Compute the truncated 8-char hex form used by phone-mesh BLE chunks
  const shortPayload = payload.message_id.replace(/-/g, '').slice(0, 8).toLowerCase();
  // Existence check matches BOTH the full UUID and the 8-char prefix to catch relay echoes
  const exists = state.messages.some(m => {
    if (m.message_id === payload.message_id) return true;          // Exact match (locally sent message)
    return m.message_id.replace(/-/g, '').slice(0, 8).toLowerCase() === shortPayload; // Prefix match (relayed copy)
  });
  if (!exists) {
    state.messages.push(payload);                                  // Append to history in-place (Immer-safe)
    // Track BOTH ID forms so future dedup checks find the message regardless of which form arrives
    if (!state.seenIds.includes(payload.message_id)) state.seenIds.push(payload.message_id);
    if (!state.seenIds.includes(shortPayload))      state.seenIds.push(shortPayload);
  }
});
```

`addSeenId` caps the seen-ID array at 2000 entries (FIFO).

### 4.2 `slices/nodes.slice.ts`

State shape:
```ts
interface NodesState {
  nearbyNodes: MeshNode[];        // Devices we've heard via BLE scan/advert (phones + Meshtastic)
  connectedNodeIds: string[];     // Subset that we've established a GATT session with
  isScanning: boolean;            // True while BLE scan is active (drives radar/banner UI)
  myNodeId: string;               // This device's stable UUID v4 (loaded from storage)
  myDisplayName: string;          // User-chosen friendly name shown in presence beacons
  defaultTtl: number;             // 86400 = 24h — outgoing message lifetime in seconds
}
```

Reducers: `setNearbyNodes`, `upsertNode`, `setNodeConnected`, `setNodeDisconnected`, `incrementRelayCount`, `pruneStaleNodes(maxAgeMs)`, `setScanning`, `setMyNodeId`, `setMyDisplayName`, `setDefaultTtl`, `resetNodes`.

`upsertNode` adds-or-replaces by `node_id`:
```ts
upsertNode: (state, { payload }: PayloadAction<MeshNode>) => {
  // Find an existing node by its unique BLE address / UUID
  const index = state.nearbyNodes.findIndex(n => n.node_id === payload.node_id);
  if (index >= 0) state.nearbyNodes[index] = payload;   // Update in place — refreshes RSSI & last_seen
  else state.nearbyNodes.push(payload);                  // Brand new node — append to the list
},
```

---

## 5. Persistent Identity (`useNodeId`)

**File:** `hooks/useNodeId.ts`. Generates a UUID v4 on first launch, persists it via `saveLocalDevice`, and rehydrates it on every subsequent run.

```ts
useEffect(() => {
  (async () => {
    // Try to read the persisted identity from AsyncStorage
    let device = await getLocalDevice();
    if (!device) {
      // First launch — generate a new identity and persist it
      device = { device_id: uuidv4(), display_name: 'Anonymous', default_ttl: 86400 };
      await saveLocalDevice(device);                           // Persist so future launches re-use this same UUID
    }
    // Push identity into Redux so every screen and hook can read it synchronously
    dispatch(setMyNodeId(device.device_id));
    dispatch(setMyDisplayName(device.display_name));
  })();
}, []); // Empty deps — runs exactly once on mount
```

`updateDisplayName(name)` patches both Redux and AsyncStorage atomically. `app/_layout.tsx` imports `react-native-get-random-values` first so `uuid` works on Hermes.

---

## 6. BLE Layer — `useBLE` & `BLEService`

The app uses **two** BLE libraries simultaneously:
- `react-native-ble-plx` for **GATT** connections (Meshtastic, ESP32 demo).
- `react-native-ble-advertiser` for **scanning + advertising** raw manufacturer-data packets (the only library that exposes both sides of advertising on Android).

Why both: `ble-plx` doesn't peripheral-advertise on Android in user-friendly mode; `ble-advertiser` doesn't do GATT.

### 6.1 `services/ble.service.ts`

Singleton wrapper around `BleManager` from `react-native-ble-plx`. Key responsibilities:

**GATT UUIDs** (lines 45-55):
```ts
// DisasterMesh phone-mesh tag — also reused as the legacy ESP32 demo service UUID
export const MESH_SERVICE_UUID    = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
export const MESH_CHAR_TX_UUID    = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';   // phone → ESP32 (write)
export const MESH_CHAR_RX_UUID    = 'beb5483e-36e1-4688-b7f5-ea07361b26a9';   // ESP32 → phone (notify)

// Official Meshtastic firmware GATT API — DO NOT change these constants
export const MESHTASTIC_SERVICE_UUID   = '6ba1b218-15a8-461f-9fa8-5dcae273eafd'; // Meshtastic primary service
export const MESHTASTIC_TORADIO_UUID   = 'f75c76d2-129e-4dad-a1dd-7866124401e7'; // write: ToRadio protobuf
export const MESHTASTIC_FROMRADIO_UUID = '2c55e69e-4993-11ed-b878-0242ac120002'; // read: FromRadio protobuf
export const MESHTASTIC_FROMNUM_UUID   = 'ed9da18c-a800-4f66-a670-aa7547e34453'; // notify: "data ready"
```

**Permission request** (Android 12+ requires SCAN+CONNECT+ADVERTISE+FINE_LOCATION; Android 13+ also POST_NOTIFICATIONS):
```ts
async requestPermissions(): Promise<boolean> {
  if (Platform.OS === 'android') {
    // API 31 == Android 12 — runtime BLE permission model was introduced here
    if (parseInt(String(Platform.Version), 10) >= 31) {
      const perms = [
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,         // Discover nearby devices
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,      // Open GATT connections
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,    // Broadcast our presence beacons
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,   // Required for scan results to surface manuf data
      ];
      // API 33 == Android 13 — POST_NOTIFICATIONS becomes a runtime permission
      if (parseInt(String(Platform.Version), 10) >= 33)
        perms.push('android.permission.POST_NOTIFICATIONS');
      const r = await PermissionsAndroid.requestMultiple(perms); // Single OS dialog batch-asks the user
      // All four BLE permissions must be granted — partial grants leave the mesh broken
      return scanOk && locOk && connectOk && advOk;
    }
  }
}
```

**Wait for Bluetooth power-on** with an immediate-state shortcut (`waitForBluetooth`).

**Connect to a device** with MTU 512 + service discovery:
```ts
// Establish the GATT connection — autoConnect:false means "fail fast, no background retry"
const device = await this.manager.connectToDevice(deviceId, {
  autoConnect: false,                 // Reject silently if device is out of range — caller will retry
  requestMTU: 512,                    // Increase MTU so JSON / protobuf frames fit in a single write
});
// MUST be called before any read/write — populates the device's service+characteristic tree
await device.discoverAllServicesAndCharacteristics();
this.connectedDevices.set(deviceId, device); // Cache so future calls don't re-discover

// React to a peer-initiated disconnect (e.g. went out of range, peripheral powered off)
device.onDisconnected((error, _dev) => {
  this.connectedDevices.delete(deviceId);                   // Clean up cache
  this.notifySubscriptions.get(deviceId)?.remove();         // Tear down notify subscription
  onDisconnect?.(deviceId, error);                          // Notify the higher-level hook (drives reconnect)
});
```

**`writeRaw`** is the workhorse for Meshtastic; it tries `writeWithResponse` and falls back to `writeWithoutResponse` (firmware revs differ). Both calls have a 4 s timeout to avoid wedging the BLE stack:
```ts
// First attempt: write-with-response — generates an ACK at the BLE layer
const r1 = await withTimeout(
  device.writeCharacteristicWithResponseForService(serviceUuid, charUuid, encoded),
  'writeWithResponse');
if (r1.ok) return true;                                      // Success on first attempt — done
// Fallback: some Meshtastic firmware revisions only support write-without-response on ToRadio
const r2 = await withTimeout(
  device.writeCharacteristicWithoutResponseForService(serviceUuid, charUuid, encoded),
  'writeWithoutResponse');
return r2.ok;                                                // Final result — both methods exhausted
```

**`readRaw`** wraps the BLE read with a 3 s race-timeout (Meshtastic firmware sometimes never replies):
```ts
// Promise.race — whichever resolves first wins; the timeout guarantees we never block forever
const c = await Promise.race([readPromise, timeout]);
if (!c?.value) return null;                                  // Empty read → caller knows there are no more frames
// ble-plx returns base64-encoded characteristic values — decode to raw bytes for the protobuf parser
return new Uint8Array(Buffer.from(c.value, 'base64'));
```

**`monitorRaw`** subscribes to a notify characteristic and emits raw `Uint8Array` chunks.

### 6.2 `hooks/useBLE.ts`

This hook owns the *advertisement* scan loop and exposes high-level operations to React.

**Why `scan(null, options)` not `scanByService(...)`** — documented in the file's header (lines 1-22):
> `scanByService()` had a NullPointerException bug in `react-native-ble-advertiser@0.0.17` (Java filters=null then `.add()`); we scan all devices and software-filter on the `"DM"` header.

**Scan listener** parses the manufacturer-data bytes inline and dispatches to either the phone-mesh path or the Meshtastic detection path:
```ts
// Native module fires DeviceEventEmitter for every advert it sees that matches our COMPANY_ID
scanListenerRef.current = DeviceEventEmitter.addListener('onDeviceFound', (event: any) => {
  lastScanEventAtRef.current = Date.now();                           // Tickle the wedge-watchdog
  const manufData = event.manufData ? (...) : null;                  // May be array or object — normalise
  if (manufData && manufData.length >= 3) {
    // First two bytes act as our app-level magic header
    if (manufData[0] === 0x44 && manufData[1] === 0x4D) {     // ASCII "DM" = DisasterMesh
      const type = manufData[2];                              // Third byte = packet type
      if (type === 0x02 && manufData.length >= 9) {
        // Presence beacon — extract deviceIdHex (6 bytes) + ASCII name
        // hex-encode the 6 device-id bytes
        peerDeviceIdHex = manufData.slice(3, 9).map(b => b.toString(16).padStart(2,'0')).join('');
        // Strip null padding then convert to ASCII for the display name
        peerDisplayName = String.fromCharCode(...manufData.slice(9).filter(b => b !== 0)).trim();
        // Hand off to PhoneMeshService so it can update the visible peer list
        getPhoneMeshService().onPresenceDetected?.({ type:'presence', deviceIdHex, displayName });
      } else if (type === 0x01 && manufData.length >= 12) {
        // Message chunk — see Section 7 wire format
        const chunk = { type:'message', msgIdHex, chunkIndex, totalChunks, srcIdHex, hops, payload };
        // Drop chunks that originated from THIS device (echoes from relays)
        if (getPhoneMeshService().isOwnSrcId?.(chunk.srcIdHex)) return;
        if (myShort && chunk.srcIdHex === myShort) return;        // Android 11 self-scan guard
        // Already delivered or pre-marked? Skip buffering altogether
        if (getPhoneMeshService().isMessageSeen(chunk.msgIdHex)) return;
        // Feed into the chunk reassembly buffer
        getPhoneMeshService().handleChunk(chunk);
      }
    }
  }
  // Detect Meshtastic devices by name prefix
  if (deviceName.toLowerCase().includes('meshtastic')) {
    // Insert/refresh in Redux — the Nodes screen will surface it for connecting
    dispatch(upsertNode({ node_id: deviceId, name: deviceName, rssi, type:'meshtastic', ... }));
  }
});
```

**Scan watchdog** — heavy GATT activity (Meshtastic FromRadio reads) can silently wedge the Android scan callback; if no events arrive for 15 s, the watchdog stops and restarts the scanner:
```ts
// Wakes every 5 s; if scanner has been silent for >15 s assume it's wedged
scanWatchdogRef.current = setInterval(() => {
  if (Date.now() - lastScanEventAtRef.current > 15000) {
    BLEAdvertiser.stopScan();                                   // Tear down the dead scanner
    // Re-issue scan with the same aggressive parameters
    BLEAdvertiser.scan(null, { scanMode:2, numberOfMatches:3, matchMode:1 })
      .then(() => { lastScanEventAtRef.current = Date.now(); }); // Reset watchdog timer
  }
}, 5000);
```

**Connect with auto-reconnect**:
```ts
// Pass a disconnect callback into the BLE service — it fires only on UNSOLICITED disconnects
await ble.connectToDevice(nodeId, (disconnectedId, _error) => {
  dispatch(setNodeDisconnected(disconnectedId));                // Update Redux so UI reflects offline state
  // Schedule a reconnect 3 s later — bounded by reconnectTimers map so we don't spawn endless timers
  reconnectTimers.current.set(disconnectedId,
    setTimeout(() => connectToNode(disconnectedId), 3000));
});
```

The hook returns `{ isReady, isScanning, permissionsGranted, startScan, stopScan, connectToNode, disconnectFromNode, sendToNode, listenToNode }`.

---

## 7. Phone-to-Phone BLE Mesh (`PhoneMeshService`)

**File:** `services/phone-mesh.service.ts`. Implements connectionless multi-hop messaging by encoding each message as a sequence of BLE *advertisement manufacturer-data* packets (≤ 22 bytes per chunk).

### 7.1 Wire format

```
[0-1]  "DM"    — DisasterMesh identifier
[2]    type    — 0x01 = message chunk, 0x02 = presence beacon

For type=0x01 (chunk):
[3-6]  msgId   — first 4 bytes of message UUID
[7]    chunk   — chunk index
[8]    total   — total chunks
[9-10] srcId   — first 2 bytes of source UUID
[11]   hops    — relay hop count (cap 15)
[12-21] pay    — 10 bytes UTF-8 payload

For type=0x02 (presence):
[3-8]  devId   — first 6 bytes of device UUID
[9+]   name    — up to 10 bytes ASCII
```

### 7.2 Identity tracking

The service stores its own srcId prefix(es) in a `Set` — used to drop self-echoed advertisements at the earliest possible point:
```ts
setMyIdentity(deviceId: string, displayName: string): void {
  this.myDeviceId = deviceId;                                                // Cached for the presence-beacon resume logic
  this.myDisplayName = displayName;
  // BLE chunk packets only carry the first 4 hex chars (2 bytes) of the source UUID
  const shortSrc = deviceId.replace(/-/g, '').slice(0, 4).toLowerCase();
  if (shortSrc) this.myOwnSrcIds.add(shortSrc);                              // Register so we can recognise echoes
}
isOwnSrcId(srcIdHex: string): boolean {
  // Case-insensitive lookup — incoming bytes are always lowercase but UUIDs may not be
  return this.myOwnSrcIds.has(srcIdHex.toLowerCase());
}
```

### 7.3 Broadcasting messages

Each message is split into 10-byte chunks; every chunk is queued **5 times** (`CHUNK_REPEATS`) at 400 ms intervals (`CHUNK_INTERVAL_MS`). After the first pass completes, a second pass re-queues each chunk once more after a 1.2 s gap (`SECOND_PASS_DELAY_MS`) to catch receivers that were briefly busy:

```ts
async broadcastMessage(packet: MessagePacket): Promise<void> {
  const payloadBytes = stringToBytes(packet.pay);                                  // UTF-8 → bytes for the wire
  const totalChunks = Math.max(1, Math.ceil(payloadBytes.length / CHUNK_SIZE));    // 10-byte chunks; min 1 even for empty msgs
  const msgIdBytes  = hexToBytes(packet.mid.replace(/-/g, ''), 4);                 // Truncated 4-byte message ID for the chunk header
  const srcIdBytes  = hexToBytes(packet.src.replace(/-/g, ''), 2);                 // 2-byte source-id prefix

  // Pre-mark our own outgoing message so echoes are dropped instantly
  const outgoingMidHex = msgIdBytes.map(b => b.toString(16).padStart(2,'0')).join('');
  this.seenMids.add(outgoingMidHex);                                               // Future incoming chunks with this ID are ours

  const uniqueChunks: number[][] = [];
  for (let i = 0; i < totalChunks; i++) {
    const slice = payloadBytes.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);        // Take next 10 bytes of payload
    // Zero-pad the last chunk so every advert has the same length — receivers strip nulls during reassembly
    const padded = [...slice, ...new Array(CHUNK_SIZE - slice.length).fill(0)];
    // Build the full 22-byte advert: header + type + msgId + index + total + src + hops + padded payload
    uniqueChunks.push([
      ...DM_HEADER, TYPE_MESSAGE, ...msgIdBytes,
      i, totalChunks, ...srcIdBytes, Math.min(packet.hops ?? 0, 15), ...padded,
    ]);
  }
  this.lastMessageChunks = uniqueChunks;                                           // Save for the second-pass retry below

  // First pass: enqueue each unique chunk CHUNK_REPEATS times for redundancy
  for (const chunk of uniqueChunks) for (let r = 0; r < CHUNK_REPEATS; r++)
    this.broadcastQueue.push(chunk);
  this._processQueue();                                                             // Kick off the timer chain

  // Second-pass retry — once the first burst is over, send each chunk one more time
  setTimeout(() => {
    for (const chunk of this.lastMessageChunks) this.broadcastQueue.push(chunk);   // Enqueue exactly one copy per chunk
    this._processQueue();                                                           // Re-arm the queue processor
  }, totalChunks * CHUNK_REPEATS * CHUNK_INTERVAL_MS + SECOND_PASS_DELAY_MS);       // Compute first-pass duration + gap
}
```

### 7.4 Single-advertiser constraint + retry

Android only allows one active BLE advertiser at a time, so each `_sendAdvertisement` stops the current advertisement, waits 50 ms, then advertises with up to 3 attempts and 150 ms × attempt back-off:
```ts
private async _sendAdvertisement(data: number[]): Promise<void> {
  BLEAdvertiser.setCompanyId(COMPANY_ID);                              // 0xFFFF — internal/test company ID
  try { await BLEAdvertiser.stopBroadcast(); } catch {}                // Always tear down current advert (Android allows ONE)
  await new Promise(r => setTimeout(r, 50));                           // Settle gap so the radio can finish the stop
  let attempt = 0;
  while (attempt < 3) {                                                // Up to 3 retry attempts
    try {
      await BLEAdvertiser.broadcast(MESH_SERVICE_UUID.toUpperCase(), data, {
        advertiseMode: 2,             // LOW_LATENCY — fastest delivery cadence
        txPowerLevel: 3,              // HIGH — maximum range
        connectable: false,           // Beacon-style only — peers should not try to GATT-connect
        includeDeviceName: false,     // Save advert bytes — caller already encoded the name
      });
      return;                                                           // Success — exit the retry loop
    } catch {
      attempt++;
      try { await BLEAdvertiser.stopBroadcast(); } catch {}              // Reset radio between attempts
      await new Promise(r => setTimeout(r, 150 * attempt));              // Linear back-off (150 / 300 ms)
    }
  }
}
```

### 7.5 Presence beacon

Continuously advertised so peers see the device's name in the node list:
```ts
const idBytes   = hexToBytes(deviceId.replace(/-/g, '').slice(0, 12), 6);   // 6-byte device-id (12 hex chars)
const nameBytes = stringToBytes(displayName.slice(0, 10));                  // Cap name at 10 bytes — BLE advert limit
const data      = [...DM_HEADER, TYPE_PRESENCE, ...idBytes, ...nameBytes];  // Layout: "DM" + 0x02 + id + name
await BLEAdvertiser.broadcast(MESH_SERVICE_UUID.toUpperCase(), data, {
  advertiseMode: 1,        // BALANCED — presence beacons run forever, prefer power-efficient mode
  txPowerLevel: 2,         // MEDIUM tx power — discoverable but doesn't drain battery
  connectable: false,      // Pure beacon — no GATT
  includeDeviceName: false,
});
```

The presence beacon is auto-resumed after a chunk burst finishes (in `_processQueue`):
```ts
if (this.broadcastQueue.length === 0) {                              // No more chunks pending
  if (this.myDeviceId && this.myDisplayName) {                       // Identity is set
    // Restart presence broadcast so peers continue to see us between message bursts
    this.startPresenceBeacon(this.myDeviceId, this.myDisplayName).catch(() => {});
  }
}
```

### 7.6 Chunk reassembly

`handleChunk(chunk)` performs three guards and one buffer:
1. Own-message guard via `myOwnSrcIds` (and direct `myDeviceId` comparison).
2. Service-level dedup via `seenMids`.
3. Stale-buffer prune (>30 s old).

```ts
handleChunk(chunk: MessageChunk): void {
  // GUARD 1 — registered own-src set (populated by setMyIdentity + broadcastMessage)
  if (this.myOwnSrcIds.has(chunk.srcIdHex.toLowerCase())) return;
  // GUARD 2 — direct comparison fallback against the cached device id
  if (this.myDeviceId) {
    const myShortId = this.myDeviceId.replace(/-/g, '').slice(0, 4).toLowerCase();
    if (chunk.srcIdHex.toLowerCase() === myShortId) return;
  }
  const key = chunk.msgIdHex.toLowerCase();                              // Lowercase for consistent map keys
  if (this.seenMids.has(key)) return;                                    // Already delivered this message — drop
  // First chunk for this message? Allocate a new accumulator buffer
  if (!this.chunkBuffers.has(key)) {
    this.chunkBuffers.set(key, { chunks: new Map(), totalChunks: chunk.totalChunks,
      hops: chunk.hops, srcIdHex: chunk.srcIdHex, firstSeen: Date.now() });
  }
  const buf = this.chunkBuffers.get(key)!;
  buf.chunks.set(chunk.chunkIndex, chunk.payload);                       // Store this chunk by its index
  // Garbage-collect stale partial messages — chunks lost in transit shouldn't linger forever
  if (Date.now() - buf.firstSeen > 30_000) { this.chunkBuffers.delete(key); return; }
  if (buf.chunks.size === buf.totalChunks) {                             // All chunks arrived
    this.chunkBuffers.delete(key);                                       // Free buffer memory
    this.seenMids.add(key);                                              // Mark seen so duplicates get dropped
    // Cap dedup set at 300 entries — FIFO eviction by deleting the first inserted key
    if (this.seenMids.size > 300) this.seenMids.delete(this.seenMids.values().next().value!);
    const payload = this._reassemble(buf);
    // Fire the high-level callback with a partial MessagePacket — useMesh hydrates the rest
    this.onMessageReassembled?.({ mid: key, src: buf.srcIdHex, sn: 'Peer', pay: payload,
      ts: Date.now(), ttl: 86400, hops: buf.hops ?? 0 });
  }
}
```

`_reassemble` strips null padding while concatenating chunks:
```ts
private _reassemble(buf: ChunkBuffer): string {
  const allBytes: number[] = [];
  // Walk chunks in order so the payload is reconstructed correctly
  for (let i = 0; i < buf.totalChunks; i++) {
    const c = buf.chunks.get(i);
    // Skip nulls — they were padding bytes added by the sender to fill 10-byte chunks
    if (c) for (const b of c) if (b !== 0) allBytes.push(b);
  }
  return Buffer.from(allBytes).toString('utf8');                          // Decode UTF-8 back to a JS string
}
```

---

## 8. Meshtastic LoRa Bridge (`MeshtasticService`)

**File:** `services/meshtastic.service.ts`. Talks to real Meshtastic firmware over the official BLE GATT API. Hand-rolled protobuf encoding/decoding to avoid Metro's ESM bundling issues with `@meshtastic/protobufs`.

### 8.1 Hand-rolled protobuf

Wire-type primitives:
```ts
// Encode an integer in protobuf varint format (7 data bits per byte, MSB=1 for continuation)
function writeVarint(buf: number[], value: number): void {
  value = value >>> 0;                                          // Coerce to unsigned 32-bit
  while (value > 0x7f) {                                        // While more than 7 bits remain
    buf.push((value & 0x7f) | 0x80);                            // Write low 7 bits with continuation flag
    value = value >>> 7;                                        // Shift right by 7 for next byte
  }
  buf.push(value & 0x7f);                                       // Final byte — continuation bit clear
}
function writeFixed32(buf, value)   { ... 4 little-endian bytes }   // protobuf wire-type 5: 32-bit LE
// LEN-prefixed encoder: tag with wireType=2, then varint length, then raw bytes
function writeBytes(buf, fieldNum, data) { writeTag(buf, fieldNum, 2); writeVarint(buf, data.length); for (const b of data) buf.push(b); }
```

`encodeData(portnum, payload)` builds the inner `Data` (PortNum+payload). `encodeMeshPacket(...)` builds a `MeshPacket` with the **verified** Meshtastic field numbers (`from=1`, `to=2`, `channel=3`, `decoded=4`, `id=6`, `hop_limit=9`, `want_ack=10`):

```ts
function encodeMeshPacket(params): Uint8Array {
  const buf: number[] = [];
  // proto3 semantics — only emit non-default fields. from=0 means "let radio fill it"
  if (params.from !== 0) writeFixed32Field(buf, 1, params.from);
  writeFixed32Field(buf, 2, params.to);                                // Destination — BROADCAST_ADDR or specific node
  if (params.channel !== 0) writeVarintField(buf, 3, params.channel);  // 0 == primary channel; omit when default
  writeBytes(buf, 4, params.decoded);                                   // Wraps the inner Data message (portnum + payload)
  writeFixed32Field(buf, 6, params.id);                                 // 32-bit packet ID — used for ACKs and dedup
  writeVarintField(buf, 9, params.hopLimit);                            // Decremented per-hop — Meshtastic relay control
  if (params.wantAck) writeVarintField(buf, 10, 1);                     // bool true → request ACK back from peer
  return new Uint8Array(buf);
}
```

`decodeMessage(data)` parses TLV protobuf wire types (0=varint, 2=length-delimited, 5=fixed32) into `{fieldNum, wireType, value}` records.

### 8.2 Connection handshake

Steps performed by `connect(deviceId)`:
1. Subscribe `FromNum` notifications **before** writing `want_config` (avoids race).
2. Write `want_config_id` with a random nonce.
3. Drain `FromRadio` until either the matching `config_complete_id` arrives or 5 s elapses.
4. Send a NODEINFO_APP "warm-up" beacon so the LoRa channel is primed and the user's first text isn't lost as the cold-start packet.

```ts
async connect(deviceId: string): Promise<boolean> {
  // Subscribe FromNum BEFORE writing want_config — otherwise we miss the "config_complete" notification
  this.fromNumCleanup = getBLEService().monitorRaw(deviceId,
    MESHTASTIC_SERVICE_UUID, MESHTASTIC_FROMNUM_UUID,
    () => { this._scheduleDrain(); });                       // Notification handler — coalesces overlapping drains

  const nonce = (Math.random() * 0xffffffff) >>> 0;          // Random 32-bit ID — radio will echo it back when done
  // Send want_config_id — instructs the radio to dump its NodeDB and config to us
  const ok = await getBLEService().writeRaw(deviceId,
    MESHTASTIC_SERVICE_UUID, MESHTASTIC_TORADIO_UUID, encodeToRadioWantConfig(nonce));
  if (!ok) return false;                                     // GATT write failed — abort

  this.deviceId = deviceId;                                  // Mark this device as our active session
  await new Promise(r => setTimeout(r, 50));                 // Match official app's 10ms-ish post-write nap
  const deadline = Date.now() + 5000;                        // 5 second handshake deadline
  while (Date.now() < deadline && !configured) {             // Poll-drain until config_complete or timeout
    if (await this._drainFromRadio(nonce)) configured = true;// True when we see config_complete_id == nonce
    else await new Promise(r => setTimeout(r, 150));         // Back-off between polls
  }
  // Send a NODEINFO beacon so the LoRa channel is "warm" before any user message
  await this._sendBeacon();
  return true;
}
```

### 8.3 Sending text

```ts
async sendText(text: string, channel = 0): Promise<boolean> {
  // Wrap the UTF-8 text in a Data message with portnum=TEXT_MESSAGE_APP (1)
  const data = encodeData(PORT_TEXT, new TextEncoder().encode(text));
  const pktId = (Math.random() * 0xffffffff) >>> 0;          // Random 32-bit packet ID
  const meshPkt = encodeMeshPacket({
    to: BROADCAST_ADDR,            // 0xffffffff = primary-channel flood broadcast
    from: 0,                       // Tell firmware to fill in its own node number
    id: pktId, channel,
    hopLimit: 3,                   // Allow up to 3 LoRa hops in the Meshtastic network
    wantAck: false,                // Broadcast — no point asking for ACK from every recipient
    decoded: data,                 // Inner Data payload (portnum + UTF-8 bytes)
  });
  const toRadio = encodeToRadioPacket(meshPkt);              // Wrap MeshPacket in a ToRadio frame
  // Push the bytes over GATT — radio picks it up and queues for LoRa TX
  return getBLEService().writeRaw(this.deviceId,
    MESHTASTIC_SERVICE_UUID, MESHTASTIC_TORADIO_UUID, toRadio);
}
```

### 8.4 Drain coalescing

`FromNum` may fire repeatedly during steady state; running a full 100-iteration drain per notification monopolises the radio and starves the BLE-advertiser scanner. Strategy: at most one drain in flight; if a notification arrives during a drain, remember it and run exactly one more drain after.
```ts
private _scheduleDrain(): void {
  // If a drain is already running, just remember that another notification arrived
  if (this.draining) { this.drainPending = true; return; }
  // Run a drain; once it completes, if a notification arrived during it, run exactly one more
  this._drainFromRadio().catch(() => {}).then(() => {
    if (this.drainPending) { this.drainPending = false; this._scheduleDrain(); }
  });
}
```

Drain budget: 100 frames during the initial handshake (large NodeDB), 8 frames otherwise. A 20 ms yield between reads keeps the BLE-advertiser code paths alive:
```ts
// Initial handshake reads many NodeInfo frames; runtime drains read only the new packets
const maxFrames = expectedConfigId !== undefined ? 100 : 8;
for (let i = 0; i < maxFrames; i++) {
  const bytes = await getBLEService().readRaw(this.deviceId, ..., MESHTASTIC_FROMRADIO_UUID);
  if (!bytes || bytes.length === 0) break;                    // Empty read = no more frames in radio's queue
  // Decode and handle the FromRadio frame; flag sawConfigComplete when nonce matches
  this._handleFromRadio(bytes, expectedConfigId, m => { if (m) sawConfigComplete = true; });
  // Yield 20ms so the BLE-advertiser code can run between reads (prevents starvation)
  await new Promise(r => setTimeout(r, 20));
}
```

### 8.5 Decoding incoming text

`_handleFromRadio` walks the protobuf fields. `field 2 = packet (MeshPacket)`, then within that: `from=1`, `decoded=4`, `id=6`, `rx_time=7`, `channel=3`. If `Data.portnum === PORT_TEXT (1)` and `from !== myNodeNum`, fire `onTextMessage`:
```ts
// Hand the decoded text up to useMesh — it builds a Message object and dispatches
this.onTextMessage?.({
  fromNodeNum: fromNum,                                                       // Sender's Meshtastic node number
  // Friendly name from the NodeDB; fall back to "!<hex>" if not yet learned
  fromName: this.nodeNames.get(fromNum) || `!${fromNum.toString(16)}`,
  text: getString(payloadF.value),                                            // UTF-8 decode of the protobuf bytes
  channel: ..., rxTime: ..., id: ...,                                         // Pass through metadata for dedup + UI
});
```

The NodeDB (`nodeNames`) is populated from `field 4 (node_info)` frames during the handshake.

---

## 9. Core Mesh Engine (`useMesh`)

**File:** `hooks/useMesh.ts`. Single hook that ties BLE + Phone-Mesh + Meshtastic into a coherent send/receive/relay engine.

### 9.1 Module-level guards

Some state must outlive React re-renders and be shared between every `useMesh()` instance (Chat & Nodes screens both call it):
```ts
// Module-scope: lives outside React, never wiped by re-render or unmount
const _processedMids = new Set<string>();   // permanent dedup, never cleared
let _autoStarted = false;                    // only one screen starts the scan (latch flag)
let _autoConnectInFlight = false;            // at most one Meshtastic auto-connect at a time
```

### 9.2 Always-fresh refs

To prevent stale-closure bugs in BLE callbacks, every render rewrites refs:
```ts
// Refs always point at the LATEST Redux state — callbacks registered once-only still read fresh values
seenIdsRef.current        = msgsSlice.seenIds;       // Latest dedup cache
myNodeIdRef.current       = nodesSlice.myNodeId;     // Our own UUID
nearbyNodesRef.current    = nodesSlice.nearbyNodes;  // Live peer list
connectedNodeIdsRef.current = nodesSlice.connectedNodeIds; // Active GATT sessions
```

### 9.3 Auto-start scanning

When BLE is ready and the local node ID is known, exactly one screen kicks the scan:
```ts
useEffect(() => {
  // Three preconditions: BT ready, identity loaded, no other instance has started scanning
  if (ble.isReady && nodesSlice.myNodeId && !_autoStarted) {
    _autoStarted = true;                            // Latch — second mount short-circuits here
    ble.startScan();                                 // Begin BLE advert scan + listener registration
  }
}, [ble.isReady, nodesSlice.myNodeId]);             // Re-checks whenever BLE state or identity changes
```

### 9.4 Auto-connect to nearest Meshtastic

```ts
useEffect(() => {
  if (!ble.isReady || _autoConnectInFlight) return;                        // Need BT up + no concurrent attempt
  const meshtasticNodes = nodesSlice.nearbyNodes.filter(n => n.type === 'meshtastic');
  if (meshtasticNodes.length === 0) return;                                // No Meshtastic in range — nothing to do
  // Already connected to ANY Meshtastic node? Skip — one connection is enough
  if (meshtasticNodes.some(n => nodesSlice.connectedNodeIds.includes(n.node_id))) return;
  // Pick the strongest signal (highest RSSI) — most stable GATT session
  const target = [...meshtasticNodes].sort((a,b) => b.rssi - a.rssi)[0];
  _autoConnectInFlight = true;                                             // Mark in-flight to prevent re-entry
  ble.connectToNode(target.node_id).then(async (connected) => {
    if (connected) await getMeshtasticService().connect(target.node_id);   // Run protobuf handshake after BLE connect
  }).finally(() => { _autoConnectInFlight = false; });                     // ALWAYS clear the flag (success/fail)
}, [nodesSlice.nearbyNodes, nodesSlice.connectedNodeIds, ble.isReady]);   // Re-evaluate when any of these change
```

### 9.5 Phone-mesh receive handler (4 layers of dedup + filtering)

```ts
phoneMesh.setMessageCallback((raw) => {
  if (!raw.mid || !raw.pay) return;                                          // Ignore malformed packets
  if (getPhoneMeshService().isOwnSrcId?.(raw.src ?? '')) return;             // L0 — service-level own-src guard
  const myShortId = myNodeIdRef.current.replace(/-/g, '').slice(0, 4).toLowerCase();
  if ((raw.src ?? '').toLowerCase() === myShortId) return;                   // L1 — direct compare against our id
  if (_processedMids.has(raw.mid)) return;                                   // L2 — module-level permanent set
  if (seenIdsRef.current.includes(raw.mid)) return;                          // L3 — Redux seenIds (cross-restart)

  // Mark seen at ALL layers BEFORE any async work — prevents re-entrant duplicates
  _processedMids.add(raw.mid);
  msgsSlice.dispatch(msgsSlice.addSeenId(raw.mid));
  getPhoneMeshService().markMessageSeen(raw.mid);

  // Hard filter: unknown sender (no presence beacon yet) → drop
  // Sender is identified by srcIdHex — match it against the prefix of any phone-* node_id
  const peerNode = nearbyNodesRef.current.find(n =>
    n.node_id.replace('phone-', '').startsWith(raw.src ?? ''));
  const sourceName = peerNode?.name || `Peer-${(raw.src??'').slice(0,4)}`;
  // If we have no node record, this is overwhelmingly an own-message echo — drop silently
  if (sourceName.startsWith('Peer-')) return;

  const msg: Message = { message_id: raw.mid, source_id: raw.src, ... };
  // Drop if expired or hop-count exceeded — prevents infinite forwarding loops
  if (!isExpired(msg) && msg.hops <= MAX_HOPS) {
    msgsSlice.dispatch(msgsSlice.addMessageAsync(msg));                      // Persist + show in chat
    showMessageNotification(sourceName, msg.payload).catch(() => {});         // OS notification + vibrate

    // Step 1: hand off to a connected Meshtastic node if any
    const connectedMt = nearbyNodesRef.current.filter(n => n.type === 'meshtastic'
      && connectedNodeIdsRef.current.includes(n.node_id));
    if (connectedMt.length > 0) transmitToAllNodes(msg);                     // LoRa hand-off — extends reach to km

    // Step 2: re-broadcast on phone-mesh (relay)
    // 3-layer dedup guarantees this won't loop — every phone processes each msgId exactly once
    getPhoneMeshService().broadcastMessage(messageToPacket(msg));

    // Bookkeeping: increment relay counter on the peer that sent us this message
    if (peerNode) nodesSlice.dispatch(nodesSlice.incrementRelayCount(peerNode.node_id));
  }
});
```

### 9.6 Meshtastic receive handler

Each Meshtastic frame gets a synthetic dedup key (`mt-<id-hex>`) since the radio uses uint32 IDs not UUIDs:
```ts
getMeshtasticService().setTextMessageCallback((incoming) => {
  // Build a synthetic dedup key — Meshtastic uses uint32 ids, our other paths use UUID strings
  const dedupKey = `mt-${incoming.id.toString(16).padStart(8, '0')}`;
  if (_processedMids.has(dedupKey)) return;                          // Already handled this packet — drop
  if (seenIdsRef.current.includes(dedupKey)) return;                 // Already in cross-restart cache
  _processedMids.add(dedupKey);                                      // Mark before async dispatch
  msgsSlice.dispatch(msgsSlice.addSeenId(dedupKey));
  const msg: Message = {
    message_id: uuidv4(),                                            // Fresh UUID — local-only ID for storage
    source_id: `meshtastic-${incoming.fromNodeNum.toString(16)}`,    // Synthetic source id namespaced by transport
    source_name: incoming.fromName, payload: incoming.text,
    // rxTime from radio is in seconds; multiply by 1000 for JS ms; fall back to now()
    timestamp: incoming.rxTime ? incoming.rxTime * 1000 : Date.now(),
    ttl: 86400, status: 'relayed', hops: 1, via: 'meshtastic',       // Tag transport so UI shows "(Mesh)"
    destination_id: '*',                                              // Broadcast — Meshtastic floods primary channel
  };
  msgsSlice.dispatch(msgsSlice.addMessageAsync(msg));                // Persist + render in chat
  showMessageNotification(incoming.fromName, incoming.text).catch(() => {});
});
```

### 9.7 GATT receive listener

For each connected node, register a `listenToNode` and feed messages through `handleIncomingGATTMessage`. Cleanup happens when a node is removed from `connectedNodeIds`:
```ts
// Iterate every node we have an active GATT session with
for (const nodeId of nodesSlice.connectedNodeIds) {
  if (cleanupListeners.current.has(nodeId)) continue;        // Already listening — don't double-subscribe
  // Subscribe to RX-characteristic notifications; rawJson is the Meshtastic-style JSON frame
  const stopListening = ble.listenToNode(nodeId, (_devId, rawJson) =>
    handleIncomingGATTMessage(rawJson, nodeId));
  cleanupListeners.current.set(nodeId, stopListening);       // Stash teardown fn for later cleanup
}
```

### 9.8 sendMessage — routing decision

The send path tries Meshtastic first (LoRa has the longest reach), then falls back to phone-mesh broadcast, then queues:
```ts
const sendMessage = useCallback(async (text, destinationId='*') => {
  // Build the Message object — UUID v4 ID, "pending" until a transport accepts it
  const msg: Message = { message_id: uuidv4(), source_id: nodesSlice.myNodeId,
    source_name: nodesSlice.myDisplayName, payload: text, timestamp: Date.now(),
    ttl: nodesSlice.defaultTtl, status: 'pending', hops: 0, destination_id: destinationId };

  // Pre-mark at all dedup layers BEFORE any await
  // The 8-char form is what BLE chunks carry — peers will echo back with this shorter ID
  const shortMid = msg.message_id.replace(/-/g,'').slice(0,8).toLowerCase();
  _processedMids.add(shortMid); _processedMids.add(msg.message_id);              // Module-level set — both forms
  msgsSlice.dispatch(msgsSlice.addSeenId(shortMid));                              // Redux + AsyncStorage
  pm.setMyIdentity?.(nodesSlice.myNodeId, nodesSlice.myDisplayName);              // Bootstrap own-src guard if not set
  pm.markMessageSeen(shortMid);                                                   // Service-level seenMids

  await msgsSlice.dispatch(msgsSlice.addMessageAsync(msg));                       // Optimistic insert — UI updates instantly
  const packet = messageToPacket(msg);                                            // Compact wire form

  // Priority 1: Meshtastic (LoRa) — longest reach
  const connectedMt = nearbyNodesRef.current.filter(n => n.type==='meshtastic'
    && connectedNodeIdsRef.current.includes(n.node_id));
  if (connectedMt.length > 0) {
    // If session is stale, run the protobuf handshake before sending
    if (mt.getConnectedDeviceId() !== target.node_id) await mt.connect(target.node_id);
    if (await mt.sendText(msg.payload, 0)) {                                      // Channel 0 = primary
      msgsSlice.dispatch(msgsSlice.updateStatusAsync({ id: msg.message_id, status: 'sent' }));
      msgsSlice.dispatch(msgsSlice.updateViaLocal({ id: msg.message_id, via: 'meshtastic' })); // Show "(Mesh)" tag
      // Also broadcast on phone-mesh so peers without Meshtastic still see it
      getPhoneMeshService().broadcastMessage(packet).catch(() => {});
      return 'meshtastic';                                                        // UI shows the "Sent via Meshtastic" toast
    }
  }

  // Priority 2: phone-mesh BLE advertisement (no Meshtastic in range or send failed)
  await phoneMesh.broadcastMessage(packet);
  return 'phone-mesh';

  // Priority 3: queue if neither works (no peers at all)
  msgsSlice.dispatch(msgsSlice.enqueueMessageAsync({ ...msg, status: 'pending' }));
  return 'queued';                                                                // Will retry every 10 s via flushPendingQueue
}, [...]);
```

### 9.9 Pending-queue flush + TTL prune

Every 10 seconds:
```ts
// Single recurring tick handles two responsibilities to avoid running two timers
syncIntervalRef.current = setInterval(() => {
  flushPendingQueue();                                       // Retry queued sends if peers are now reachable
  msgsSlice.dispatch(msgsSlice.pruneExpiredAsync());         // Drop any messages whose TTL has elapsed
}, 10_000);                                                   // 10 s — balanced between responsiveness and battery
```

`flushPendingQueue` walks the queue, expires anything older than TTL, and re-tries everything else over GATT.

### 9.10 Hook return shape

```ts
return {
  messages, pendingCount, nearbyNodes, connectedNodeIds,                    // Live state for UI
  isScanning: nodesSlice.isScanning,    // shared via Redux, not local useBLE state — consistent across screens
  myNodeId, myDisplayName,                                                   // Self identity for header / settings
  sendMessage, startDiscovery, stopDiscovery,                                // Action API for UI buttons
  connectToNode, disconnectFromNode,                                         // Per-node connect/disconnect controls
};
```

---

## 10. Storage & Persistence

**File:** `services/storage.service.ts`. Thin wrapper over `AsyncStorage` with five keys:
```ts
// Namespaced keys keep DisasterMesh data isolated from other AsyncStorage users
const KEYS = {
  DEVICE:   'mesh:device',     // LocalDevice — own UUID + name + default TTL
  MESSAGES: 'mesh:messages',   // Full chat history
  PENDING:  'mesh:pending',    // Outbound queue waiting for a peer
  SEEN_IDS: 'mesh:seen_ids',   // Cross-restart dedup cache
  NODES:    'mesh:nodes',      // Snapshot of last-seen peer list
};
```

All read/write via `readJSON<T>` / `writeJSON<T>` helpers.

`saveMessage` deduplicates by both exact ID and 8-char short prefix:
```ts
const msgShort = shortId(msg.message_id);                       // Compute short form for relay-echo matching
// Check both forms — relay echoes carry the truncated 8-char ID, originals carry full UUID
const alreadyExists = existing.some(m =>
  m.message_id === msg.message_id || shortId(m.message_id) === msgShort);
if (alreadyExists) return;                                       // Skip silently — not an error
await writeJSON(KEYS.MESSAGES, [...existing, msg]);              // Append-only persistence
```

`deleteExpiredMessages` filters both messages and the pending queue using `isExpired()`:
```ts
export async function deleteExpiredMessages(): Promise<number> {
  const msgs = await getMessages();
  const valid = msgs.filter(m => !isExpired(m));                       // Drop anything past its TTL
  await writeJSON(KEYS.MESSAGES, valid);                                // Persist filtered list
  const pending = await getPendingQueue();
  await writeJSON(KEYS.PENDING, pending.filter(m => !isExpired(m)));    // Same prune for the outbound queue
  return msgs.length - valid.length;                                    // Caller can log the count if desired
}
```

`isExpired` (`types/message.ts`):
```ts
export function isExpired(msg: Message): boolean {
  // ttl is in seconds; multiply by 1000 to compare with Date.now() in ms
  return Date.now() > msg.timestamp + msg.ttl * 1000;
}
```

`markAsSeen` caps the seen-IDs list at 2000 with FIFO eviction:
```ts
// If at cap, drop the oldest entry (slice(-1999) keeps the most recent 1999) then append new
const capped = arr.length >= 2000 ? arr.slice(-1999) : arr;
await writeJSON(KEYS.SEEN_IDS, [...capped, messageId]);
```

`clearAllMeshData` wipes everything via `multiRemove`.

---

## 11. Notifications

**File:** `services/notification.service.ts`. Uses `expo-notifications` plus a direct `Vibration.vibrate(300)` to ensure a haptic pulse even when channel vibration is muted.

```ts
// Versioned channel id — bumping forces Android to recreate it with current settings
const CHANNEL_ID = 'mesh-messages-v2';

// Foreground behaviour: even when app is open, show the alert and play sound
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: true,
  }),
});

export async function setupNotifications(): Promise<boolean> {
  if (Platform.OS === 'android') {
    // Channels are required on Android 8+; importance HIGH means it pops as a heads-up
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Mesh Messages',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 300], enableVibrate: true, enableLights: true,
      lightColor: '#00c896', showBadge: true,
    });
  }
  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === 'granted') return true;                          // Already granted previously
  const { status } = await Notifications.requestPermissionsAsync(); // Show OS prompt (Android 13+ / iOS)
  return status === 'granted';
}

export async function showMessageNotification(senderName, messageText) {
  // Direct hardware vibrate as a fallback — works even if user disabled notif vibration
  Vibration.vibrate(300);
  await Notifications.scheduleNotificationAsync({
    content: {
      title: senderName,
      // Trim long messages to keep the notification body compact (120 chars + ellipsis)
      body: messageText.length > 120 ? messageText.slice(0,117) + '…' : messageText,
      sound: 'default', data: { type: 'mesh-message' }, color: '#00c896',
      // Android-specific options merged in conditionally — channelId is required for visible notifications
      ...(Platform.OS === 'android' && { channelId: CHANNEL_ID, vibrate: [0,300], priority: 'high' as const }),
    },
    trigger: null,                                                   // null = fire immediately, no schedule
  });
}
```

Setup is invoked **after** the splash hides (`app/_layout.tsx`) so the Android 13+ permission dialog never blocks first launch.

---

## 12. Debug Log Subsystem

**File:** `services/debug-log.service.ts`. Provides an in-memory rolling 500-entry buffer with subscription support, mirrored to console for `adb logcat`.

```ts
private push(level, tag, message): void {
  // Build immutable entry with monotonically increasing id
  const entry = { id: this.nextId++, ts: Date.now(), level, tag, message };
  this.buffer.push(entry);
  // Trim oldest entries when capacity is exceeded — bounded memory
  if (this.buffer.length > this.MAX_ENTRIES)
    this.buffer.splice(0, this.buffer.length - this.MAX_ENTRIES);
  // Notify every UI subscriber — pass a SLICE so subscribers can't mutate the buffer
  for (const l of this.listeners) l(this.buffer.slice());
  // mirror to console...                                  // Also goes to adb logcat for off-device debugging
}
// Convenience wrappers — keeps call sites short: dlog.info('Mesh', '...')
info(tag, message)  { this.push('info', tag, message); }
warn(tag, message)  { this.push('warn', tag, message); }
error(tag, message) { this.push('error', tag, message); }
// Subscribe pattern — caller gets immediate snapshot then live updates; returns unsubscribe fn
subscribe(listener) { this.listeners.add(listener); listener(this.buffer.slice());
  return () => this.listeners.delete(listener); }
```

Consumed by `components/nodes/DebugLogPanel.tsx`, which subscribes via `dlog.subscribe(setEntries)` and renders the latest entries on the Nodes screen with copy-to-clipboard.

---

## 13. UI — Chat / Nodes / Settings Screens

### 13.1 Chat — `app/(main)/(tabs)/chat/index.tsx`

A `KeyboardAvoidingView`-wrapped `FlatList` of message bubbles + a sticky `ChatInput`. Sender names are resolved live by looking up the source UUID prefix in `nearbyNodes`:
```ts
function resolveSenderName(msg, nearbyNodes) {
  // node_id is shaped "phone-<12hexchars>"; source_id of a chunked msg is just first 4 hex chars
  const peer = nearbyNodes.find(n => n.node_id.replace('phone-','').startsWith(msg.source_id));
  // Prefer the LATEST display name from the live presence beacons; fall back to whatever was on the message
  return peer?.name || msg.source_name;
}
```

Outgoing messages display a transient toast indicating the chosen route:
```ts
const handleSend = async (text) => {
  const route = await sendMessage(text);                // Returns the chosen transport
  showRouteToast(route);  // 'meshtastic' | 'phone-mesh' | 'queued' — drives toast color/icon
};
```

Messages are grouped by date with separator rows (Today / Yesterday / formatted date).

### 13.2 MessageBubble — `components/chat/MessageBubble.tsx`

Own messages right-aligned (teal `#00c896`), others left-aligned (dark `#1e2535`). Footer shows `time · status · (Mesh) · ↷hops`. The `via === 'meshtastic'` flag adds a `(Mesh)` orange tag.

### 13.3 ChatInput — `components/chat/ChatInput.tsx`

Multiline `TextInput` (max 400 chars) inside a rounded pill, plus a glowing send button that activates only when text is non-empty and not sending.

### 13.4 StatusBanner — `components/chat/StatusBanner.tsx`

Animated dot that blinks while scanning. Five states:
- `connectedCount > 0 && isScanning` — teal "X devices in mesh — broadcasting"
- `connectedCount > 0` — teal "X devices in mesh"
- `isScanning` — blue "Scanning for mesh peers..."
- `pendingCount > 0` — orange "Messages queued"
- otherwise — red "Offline"

### 13.5 Nodes — `app/(main)/(tabs)/nodes/index.tsx`

Three stat boxes (Phones/Meshtastic/Relayed), animated radar (`RadarAnimation`), Start/Stop scan button, `DebugLogPanel`, and a `FlatList` of `NodeCard`s sorted by RSSI.

### 13.6 NodeCard — `components/nodes/NodeCard.tsx`

For Meshtastic devices it shows a `Connect`/`Disconnect` button; phone peers show an `Auto-Mesh` badge (no GATT needed). RSSI is converted to 5 bars: `bars = round((rssi + 100) / 12)`.

### 13.7 RadarAnimation — `components/nodes/RadarAnimation.tsx`

Reanimated-based radar: rotating sweep wedge (2.5 s linear loop), two pulse rings, and a scale pulse. All animations are gated on `isActive`:
```ts
// Continuous 360° rotation; `-1` = infinite repeat, `false` = don't reverse
rotation.value = withRepeat(withTiming(360, { duration: 2500, easing: Easing.linear }), -1, false);
// Pulse ring fade in then out on a 2.4s cycle — mimics radar ping
ring1Opacity.value = withRepeat(withSequence(withTiming(0.6,{duration:1200}), withTiming(0,{duration:1200})), -1, false);
```

### 13.8 Settings — `app/(main)/(tabs)/settings/index.tsx`

Sections:
- **Identity** — display Device ID, edit Display Name (saves through `useNodeId.updateDisplayName`)
- **TTL** — preset buttons (5 min → 24 h) + custom (Min/Hr toggle), updates Redux `defaultTtl`
- **Storage** — counts of total messages and pending queue
- **Danger Zone** — `clearAllMeshData()` wipes AsyncStorage and dispatches `clearMessages()`

---

## 14. Mock Layer (Expo Go fallback)

`services/ble-adapter.ts` and `services/phone-mesh-adapter.ts` swap real implementations for in-memory mocks when running inside Expo Go (no native modules):

```ts
// StoreClient = Expo Go (no native modules); anything else = custom dev build with full BLE access
export const IS_EXPO_GO =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

export function getBLEService(): any {
  if (_instance) return _instance;                                    // Lazy singleton — one instance per app run
  // require() is conditional and lazy so the heavy native code isn't loaded in Expo Go
  if (IS_EXPO_GO) _instance = require('./mock-ble.service').default.getInstance();
  else            _instance = require('./ble.service').default.getInstance();
  return _instance;
}
```

Every consumer goes through `getBLEService()` / `getPhoneMeshService()` so a custom dev build automatically uses the real native modules.

---

## 15. Permissions & Platform Configuration

### 15.1 `app.config.ts`

Android permissions block:
```ts
android: {
  permissions: [
    'android.permission.BLUETOOTH',                       // Pre-Android-12 BT support (legacy)
    'android.permission.BLUETOOTH_ADMIN',                 // Pre-Android-12 enable/disable BT (legacy)
    'android.permission.BLUETOOTH_SCAN',                  // Android 12+ scan for BLE devices
    'android.permission.BLUETOOTH_CONNECT',               // Android 12+ open GATT sessions
    'android.permission.BLUETOOTH_ADVERTISE',             // Android 12+ broadcast our presence beacons
    'android.permission.ACCESS_FINE_LOCATION',            // Required for BLE scan results to include manufData
    'android.permission.ACCESS_COARSE_LOCATION',          // Fallback for older devices
    'android.permission.FOREGROUND_SERVICE',              // Lets us keep BLE running even when app is backgrounded
    'android.permission.RECEIVE_BOOT_COMPLETED',          // Allows scheduled mesh tasks across reboots (future use)
  ],
}
```

Plugins:
```ts
plugins: [
  'expo-router',                                                  // File-based routing for app/ directory
  ['expo-notifications', { color: '#00c896', defaultChannel: 'mesh-messages' }],  // Local notification setup
  ['react-native-ble-plx', {
      isBackgroundEnabled: true,                                  // Keep BLE alive in background (iOS + Android)
      modes: ['peripheral', 'central'],                           // Run as both — central=client, peripheral=advert
      bluetoothAlwaysPermission: 'Allow DisasterMesh to use Bluetooth ...',  // iOS Info.plist string
  }],
  ['expo-splash-screen', { backgroundColor: '#ffffff', image: './assets/images/logo-lg.png', ... }],
  ['expo-font', { fonts: [...OpenSans variants] }],               // Bundle custom fonts at build time
],
```

The `react-native-ble-plx` plugin enables **background** central + peripheral so the app can still receive mesh messages while suspended.

### 15.2 Runtime permission flow

`BLEService.requestPermissions()` is invoked from `useBLE`'s init effect; if denied, an `Alert.alert(...)` directs the user to system settings:
```ts
if (!granted) {
  // Two-button alert — provides direct deep link to system settings for the user
  Alert.alert('Bluetooth Permissions Required', '...',
    [{ text: 'Open Settings', onPress: () => Linking.openSettings() },   // Opens our app's permissions page
     { text: 'Cancel', style: 'cancel' }]);                                // User can dismiss but mesh won't work
}
```

---

## 16. Wire Formats

### 16.1 `Message` (in-memory & storage)

```ts
interface Message {
  message_id: string;        // UUID v4 — uniquely identifies the message across the entire mesh
  source_id: string;         // Sender's device UUID (full UUID for own msgs, 4-char prefix for relayed)
  destination_id: string;    // UUID or '*' for broadcast
  source_name: string;       // Sender's display name (resolved live from presence beacons in UI)
  payload: string;           // Plaintext message body (UTF-8)
  timestamp: number;         // Unix epoch ms — when message was originally created
  ttl: number;               // seconds — message lifetime; combined with timestamp for isExpired()
  status: 'pending' | 'sent' | 'delivered' | 'relayed' | 'expired';   // Lifecycle state shown in MessageBubble footer
  hops: number;              // Relay count — incremented each time a peer forwards; capped by MAX_HOPS
  via?: 'meshtastic' | 'phone-mesh' | 'gatt';   // local-only metadata — drives "(Mesh)" tag in UI
}
```

### 16.2 `MessagePacket` (compact JSON over GATT)

Short-keyed for size:
```ts
// Tiny field names — keeps the JSON string under the BLE MTU even with long payloads
interface MessagePacket { mid; src; dst; sn; pay; ts; ttl; hops; }
//                         ↑    ↑    ↑    ↑   ↑    ↑   ↑    ↑
//                  message_id, source_id, destination_id, source_name, payload, timestamp, ttl, hops
```

### 16.3 BLE manufacturer-data (phone-mesh)

| Offset | Bytes | Field |
|---|---|---|
| 0-1 | `0x44 0x4D` | "DM" header |
| 2 | 1 | type (0x01 chunk, 0x02 presence) |
| 3-6 | 4 | msgId (chunk only) |
| 7 | 1 | chunk index |
| 8 | 1 | total chunks |
| 9-10 | 2 | srcId |
| 11 | 1 | hops (≤15) |
| 12-21 | 10 | payload |

### 16.4 Meshtastic protobuf (subset)

`ToRadio` field 1 = `MeshPacket` (LEN), field 3 = `want_config_id` (varint).
`MeshPacket`: from(1)/to(2)/channel(3)/decoded(4)/id(6)/hop_limit(9)/want_ack(10).
`Data`: portnum(1)/payload(2). `PortNum.TEXT_MESSAGE_APP = 1`.

---

## 17. Deduplication Strategy (3-Layer)

The system survives the chaotic loops of an ad-hoc mesh by deduplicating at three independent levels:

| Layer | Storage | Lifetime | Code |
|---|---|---|---|
| **L1 — module-level Set** | `_processedMids` in `useMesh.ts` | App process | Permanent, never cleared |
| **L2 — service-level Set** | `seenMids` in `PhoneMeshService` | App process | Capped at 300, FIFO |
| **L3 — Redux + AsyncStorage** | `messages.seenIds` + `mesh:seen_ids` | Cross-restart | Capped at 2000, FIFO |

In addition, three own-message guards prevent the sender from receiving its own echoes:
1. **`PhoneMeshService.isOwnSrcId()`** — populated by `setMyIdentity` and by `broadcastMessage`.
2. **myNodeIdRef compare** — `chunk.srcIdHex === firstFourCharsOf(myNodeId)`.
3. **Android 11 self-scan guard** — same compare in `useBLE.ts` scan listener.

`MAX_HOPS = 5` caps the relay depth as the final safety net.

The `loadMessagesAsync.fulfilled` reducer expands stored seenIds to also include their 8-char short-prefix forms, so relay echoes are blocked even immediately after an app restart when `_processedMids` and `seenMids` are freshly empty:
```ts
// Start with whatever was persisted across launches
const expanded = new Set<string>(payload.seenIds);
// For each stored UUID, also add its 8-char short form so relay echoes are blocked instantly
for (const id of payload.seenIds)
  expanded.add(id.replace(/-/g,'').slice(0,8).toLowerCase());
state.seenIds = Array.from(expanded);                              // Convert back to array for Redux storage
```

---

## Appendix — Lifecycle Walk-Through

1. **App start** → `app/_layout.tsx` preloads fonts/images, hides splash, calls `setupNotifications()`.
2. **Provider tree mounts** → Redux store, gesture handler, theme.
3. **Tab layout renders** → first useMesh() → `useNodeId` loads UUID from AsyncStorage (or generates one) → Redux `myNodeId` populated.
4. **`useBLE` init effect** runs: requests Android permissions, waits for BT power on (10 s timeout), sets `isReady`.
5. **`useMesh` auto-start** sees `isReady && myNodeId && !_autoStarted` → `ble.startScan()`.
6. **`ble.startScan`** registers `onDeviceFound` listener on `DeviceEventEmitter`, calls `BLEAdvertiser.scan(null, {...})`, kicks off the 5 s watchdog.
7. **`PhoneMeshService.startPresenceBeacon`** advertises this phone's identity so peers see it.
8. **Presence beacons / message chunks arriving** → parsed inline → upsert into `nearbyNodes` or fed into `phoneMesh.handleChunk` → reassembled → `onMessageReassembled` callback in `useMesh` → dedup → store → notify → relay (Meshtastic if connected, phone-mesh re-broadcast).
9. **User types and hits send** → `useMesh.sendMessage` → pre-mark all dedup layers → optimistic local insert → try Meshtastic → fall back to phone-mesh advertisement → fall back to pending queue.
10. **Every 10 s** → `flushPendingQueue` retries unsent messages over GATT; `pruneExpiredAsync` removes TTL-expired records from storage and Redux.
