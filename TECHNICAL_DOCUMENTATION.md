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
"react-native-ble-plx": "^3.5.1",
"react-native-ble-advertiser": "^0.0.17",
"@reduxjs/toolkit": "^2.5.0",
"@react-native-async-storage/async-storage": "2.2.0",
"expo-notifications": "~0.32.16",
"buffer": "^6.0.3",
"uuid": "^13.0.0"
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
import 'react-native-get-random-values'; // uuid polyfill — must be first
import * as SplashScreen from 'expo-splash-screen';
import { Slot } from 'expo-router';

SplashScreen.preventAutoHideAsync();

function Router() {
  useEffect(() => {
    (async () => {
      try { await Promise.all([loadImages(), loadFonts()]); }
      finally {
        SplashScreen.hideAsync();
        setupNotifications().catch(...);
      }
    })();
  }, []);
  return (<><Slot /><StatusBar style="light" /></>);
}

export default function RootLayout() {
  return <Provider><Router /></Provider>;
}
```

### 3.2 Provider tree — `providers/Provider.tsx`

```tsx
<GestureHandlerRootView style={{ flex: 1 }}>
  <ReduxProvider store={store}>
    <ThemeProvider value={isDark ? DarkTheme : DefaultTheme}>
      {children}
    </ThemeProvider>
  </ReduxProvider>
</GestureHandlerRootView>
```

### 3.3 Tab navigation — `app/(main)/(tabs)/_layout.tsx`

Three tabs (Chat, Nodes, Settings) with safe-area aware bottom padding and dark theme colors.

```tsx
<Tabs screenOptions={{ headerShown: false,
  tabBarStyle: { backgroundColor: '#0d1117', height: 60 + bottom, paddingBottom: 8 + bottom },
  tabBarActiveTintColor: '#00c896' }}>
  <Tabs.Screen name="chat/index"     options={{ title: 'Chat',     tabBarIcon: ... }}/>
  <Tabs.Screen name="nodes/index"    options={{ title: 'Nodes',    tabBarIcon: ... }}/>
  <Tabs.Screen name="settings/index" options={{ title: 'Settings', tabBarIcon: ... }}/>
</Tabs>
```

`app/index.tsx` redirects to chat:
```tsx
export default function Index() {
  return <Redirect href="/(main)/(tabs)/chat" />;
}
```

---

## 4. State Management (Redux Toolkit)

Store at `utils/store.ts` composes three slices: `app`, `messages`, `nodes`. In dev, `redux-logger` is appended to middleware.

```ts
const store = configureStore({
  reducer: { app, messages, nodes },
  middleware: getDefaultMiddleware =>
    isDev
      ? getDefaultMiddleware({ serializableCheck: false }).concat(logger)
      : getDefaultMiddleware({ serializableCheck: false }),
  devTools: isDev,
});
```

### 4.1 `slices/messages.slice.ts`

State shape:
```ts
interface MessagesState {
  messages: Message[];
  pendingQueue: Message[];
  seenIds: string[];   // dedup cache
  isLoading: boolean;
}
```

Async thunks: `loadMessagesAsync`, `addMessageAsync`, `enqueueMessageAsync`, `dequeueMessageAsync`, `updateStatusAsync`, `pruneExpiredAsync`. Each thunk reads/writes through `services/storage.service.ts` and updates the slice via `extraReducers`.

Critical dedup logic in the `addMessageAsync.fulfilled` reducer (handles relay echoes that carry an 8-char short ID while the original has a full UUID):

```ts
builder.addCase(addMessageAsync.fulfilled, (state, { payload }) => {
  const shortPayload = payload.message_id.replace(/-/g, '').slice(0, 8).toLowerCase();
  const exists = state.messages.some(m => {
    if (m.message_id === payload.message_id) return true;
    return m.message_id.replace(/-/g, '').slice(0, 8).toLowerCase() === shortPayload;
  });
  if (!exists) {
    state.messages.push(payload);
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
  nearbyNodes: MeshNode[];
  connectedNodeIds: string[];
  isScanning: boolean;
  myNodeId: string;
  myDisplayName: string;
  defaultTtl: number;   // 86400 = 24h
}
```

Reducers: `setNearbyNodes`, `upsertNode`, `setNodeConnected`, `setNodeDisconnected`, `incrementRelayCount`, `pruneStaleNodes(maxAgeMs)`, `setScanning`, `setMyNodeId`, `setMyDisplayName`, `setDefaultTtl`, `resetNodes`.

`upsertNode` adds-or-replaces by `node_id`:
```ts
upsertNode: (state, { payload }: PayloadAction<MeshNode>) => {
  const index = state.nearbyNodes.findIndex(n => n.node_id === payload.node_id);
  if (index >= 0) state.nearbyNodes[index] = payload;
  else state.nearbyNodes.push(payload);
},
```

---

## 5. Persistent Identity (`useNodeId`)

**File:** `hooks/useNodeId.ts`. Generates a UUID v4 on first launch, persists it via `saveLocalDevice`, and rehydrates it on every subsequent run.

```ts
useEffect(() => {
  (async () => {
    let device = await getLocalDevice();
    if (!device) {
      device = { device_id: uuidv4(), display_name: 'Anonymous', default_ttl: 86400 };
      await saveLocalDevice(device);
    }
    dispatch(setMyNodeId(device.device_id));
    dispatch(setMyDisplayName(device.display_name));
  })();
}, []);
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
export const MESH_SERVICE_UUID    = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
export const MESH_CHAR_TX_UUID    = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';
export const MESH_CHAR_RX_UUID    = 'beb5483e-36e1-4688-b7f5-ea07361b26a9';
export const MESHTASTIC_SERVICE_UUID   = '6ba1b218-15a8-461f-9fa8-5dcae273eafd';
export const MESHTASTIC_TORADIO_UUID   = 'f75c76d2-129e-4dad-a1dd-7866124401e7';
export const MESHTASTIC_FROMRADIO_UUID = '2c55e69e-4993-11ed-b878-0242ac120002';
export const MESHTASTIC_FROMNUM_UUID   = 'ed9da18c-a800-4f66-a670-aa7547e34453';
```

**Permission request** (Android 12+ requires SCAN+CONNECT+ADVERTISE+FINE_LOCATION; Android 13+ also POST_NOTIFICATIONS):
```ts
async requestPermissions(): Promise<boolean> {
  if (Platform.OS === 'android') {
    if (parseInt(String(Platform.Version), 10) >= 31) {
      const perms = [
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ];
      if (parseInt(String(Platform.Version), 10) >= 33)
        perms.push('android.permission.POST_NOTIFICATIONS');
      const r = await PermissionsAndroid.requestMultiple(perms);
      return scanOk && locOk && connectOk && advOk;
    }
  }
}
```

**Wait for Bluetooth power-on** with an immediate-state shortcut (`waitForBluetooth`).

**Connect to a device** with MTU 512 + service discovery:
```ts
const device = await this.manager.connectToDevice(deviceId, {
  autoConnect: false, requestMTU: 512,
});
await device.discoverAllServicesAndCharacteristics();
this.connectedDevices.set(deviceId, device);
device.onDisconnected((error, _dev) => {
  this.connectedDevices.delete(deviceId);
  this.notifySubscriptions.get(deviceId)?.remove();
  onDisconnect?.(deviceId, error);
});
```

**`writeRaw`** is the workhorse for Meshtastic; it tries `writeWithResponse` and falls back to `writeWithoutResponse` (firmware revs differ). Both calls have a 4 s timeout to avoid wedging the BLE stack:
```ts
const r1 = await withTimeout(
  device.writeCharacteristicWithResponseForService(serviceUuid, charUuid, encoded),
  'writeWithResponse');
if (r1.ok) return true;
const r2 = await withTimeout(
  device.writeCharacteristicWithoutResponseForService(serviceUuid, charUuid, encoded),
  'writeWithoutResponse');
return r2.ok;
```

**`readRaw`** wraps the BLE read with a 3 s race-timeout (Meshtastic firmware sometimes never replies):
```ts
const c = await Promise.race([readPromise, timeout]);
if (!c?.value) return null;
return new Uint8Array(Buffer.from(c.value, 'base64'));
```

**`monitorRaw`** subscribes to a notify characteristic and emits raw `Uint8Array` chunks.

### 6.2 `hooks/useBLE.ts`

This hook owns the *advertisement* scan loop and exposes high-level operations to React.

**Why `scan(null, options)` not `scanByService(...)`** — documented in the file's header (lines 1-22):
> `scanByService()` had a NullPointerException bug in `react-native-ble-advertiser@0.0.17` (Java filters=null then `.add()`); we scan all devices and software-filter on the `"DM"` header.

**Scan listener** parses the manufacturer-data bytes inline and dispatches to either the phone-mesh path or the Meshtastic detection path:
```ts
scanListenerRef.current = DeviceEventEmitter.addListener('onDeviceFound', (event: any) => {
  lastScanEventAtRef.current = Date.now();
  const manufData = event.manufData ? (...) : null;
  if (manufData && manufData.length >= 3) {
    if (manufData[0] === 0x44 && manufData[1] === 0x4D) {     // "DM"
      const type = manufData[2];
      if (type === 0x02 && manufData.length >= 9) {
        // Presence beacon — extract deviceIdHex (6 bytes) + ASCII name
        peerDeviceIdHex = manufData.slice(3, 9).map(b => b.toString(16).padStart(2,'0')).join('');
        peerDisplayName = String.fromCharCode(...manufData.slice(9).filter(b => b !== 0)).trim();
        getPhoneMeshService().onPresenceDetected?.({ type:'presence', deviceIdHex, displayName });
      } else if (type === 0x01 && manufData.length >= 12) {
        // Message chunk — see Section 7 wire format
        const chunk = { type:'message', msgIdHex, chunkIndex, totalChunks, srcIdHex, hops, payload };
        if (getPhoneMeshService().isOwnSrcId?.(chunk.srcIdHex)) return;
        if (myShort && chunk.srcIdHex === myShort) return;        // Android 11 self-scan guard
        if (getPhoneMeshService().isMessageSeen(chunk.msgIdHex)) return;
        getPhoneMeshService().handleChunk(chunk);
      }
    }
  }
  // Detect Meshtastic devices by name prefix
  if (deviceName.toLowerCase().includes('meshtastic')) {
    dispatch(upsertNode({ node_id: deviceId, name: deviceName, rssi, type:'meshtastic', ... }));
  }
});
```

**Scan watchdog** — heavy GATT activity (Meshtastic FromRadio reads) can silently wedge the Android scan callback; if no events arrive for 15 s, the watchdog stops and restarts the scanner:
```ts
scanWatchdogRef.current = setInterval(() => {
  if (Date.now() - lastScanEventAtRef.current > 15000) {
    BLEAdvertiser.stopScan();
    BLEAdvertiser.scan(null, { scanMode:2, numberOfMatches:3, matchMode:1 })
      .then(() => { lastScanEventAtRef.current = Date.now(); });
  }
}, 5000);
```

**Connect with auto-reconnect**:
```ts
await ble.connectToDevice(nodeId, (disconnectedId, _error) => {
  dispatch(setNodeDisconnected(disconnectedId));
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
  this.myDeviceId = deviceId;
  this.myDisplayName = displayName;
  const shortSrc = deviceId.replace(/-/g, '').slice(0, 4).toLowerCase();
  if (shortSrc) this.myOwnSrcIds.add(shortSrc);
}
isOwnSrcId(srcIdHex: string): boolean {
  return this.myOwnSrcIds.has(srcIdHex.toLowerCase());
}
```

### 7.3 Broadcasting messages

Each message is split into 10-byte chunks; every chunk is queued **5 times** (`CHUNK_REPEATS`) at 400 ms intervals (`CHUNK_INTERVAL_MS`). After the first pass completes, a second pass re-queues each chunk once more after a 1.2 s gap (`SECOND_PASS_DELAY_MS`) to catch receivers that were briefly busy:

```ts
async broadcastMessage(packet: MessagePacket): Promise<void> {
  const payloadBytes = stringToBytes(packet.pay);
  const totalChunks = Math.max(1, Math.ceil(payloadBytes.length / CHUNK_SIZE));
  const msgIdBytes  = hexToBytes(packet.mid.replace(/-/g, ''), 4);
  const srcIdBytes  = hexToBytes(packet.src.replace(/-/g, ''), 2);

  // Pre-mark our own outgoing message so echoes are dropped instantly
  const outgoingMidHex = msgIdBytes.map(b => b.toString(16).padStart(2,'0')).join('');
  this.seenMids.add(outgoingMidHex);

  const uniqueChunks: number[][] = [];
  for (let i = 0; i < totalChunks; i++) {
    const slice = payloadBytes.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const padded = [...slice, ...new Array(CHUNK_SIZE - slice.length).fill(0)];
    uniqueChunks.push([
      ...DM_HEADER, TYPE_MESSAGE, ...msgIdBytes,
      i, totalChunks, ...srcIdBytes, Math.min(packet.hops ?? 0, 15), ...padded,
    ]);
  }
  this.lastMessageChunks = uniqueChunks;
  for (const chunk of uniqueChunks) for (let r = 0; r < CHUNK_REPEATS; r++)
    this.broadcastQueue.push(chunk);
  this._processQueue();

  // Second-pass retry
  setTimeout(() => {
    for (const chunk of this.lastMessageChunks) this.broadcastQueue.push(chunk);
    this._processQueue();
  }, totalChunks * CHUNK_REPEATS * CHUNK_INTERVAL_MS + SECOND_PASS_DELAY_MS);
}
```

### 7.4 Single-advertiser constraint + retry

Android only allows one active BLE advertiser at a time, so each `_sendAdvertisement` stops the current advertisement, waits 50 ms, then advertises with up to 3 attempts and 150 ms × attempt back-off:
```ts
private async _sendAdvertisement(data: number[]): Promise<void> {
  BLEAdvertiser.setCompanyId(COMPANY_ID);
  try { await BLEAdvertiser.stopBroadcast(); } catch {}
  await new Promise(r => setTimeout(r, 50));
  let attempt = 0;
  while (attempt < 3) {
    try {
      await BLEAdvertiser.broadcast(MESH_SERVICE_UUID.toUpperCase(), data, {
        advertiseMode: 2, txPowerLevel: 3, connectable: false, includeDeviceName: false,
      });
      return;
    } catch {
      attempt++;
      try { await BLEAdvertiser.stopBroadcast(); } catch {}
      await new Promise(r => setTimeout(r, 150 * attempt));
    }
  }
}
```

### 7.5 Presence beacon

Continuously advertised so peers see the device's name in the node list:
```ts
const idBytes   = hexToBytes(deviceId.replace(/-/g, '').slice(0, 12), 6);
const nameBytes = stringToBytes(displayName.slice(0, 10));
const data      = [...DM_HEADER, TYPE_PRESENCE, ...idBytes, ...nameBytes];
await BLEAdvertiser.broadcast(MESH_SERVICE_UUID.toUpperCase(), data, {
  advertiseMode: 1, txPowerLevel: 2, connectable: false, includeDeviceName: false,
});
```

The presence beacon is auto-resumed after a chunk burst finishes (in `_processQueue`):
```ts
if (this.broadcastQueue.length === 0) {
  if (this.myDeviceId && this.myDisplayName) {
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
  if (this.myOwnSrcIds.has(chunk.srcIdHex.toLowerCase())) return;
  if (this.myDeviceId) {
    const myShortId = this.myDeviceId.replace(/-/g, '').slice(0, 4).toLowerCase();
    if (chunk.srcIdHex.toLowerCase() === myShortId) return;
  }
  const key = chunk.msgIdHex.toLowerCase();
  if (this.seenMids.has(key)) return;
  if (!this.chunkBuffers.has(key)) {
    this.chunkBuffers.set(key, { chunks: new Map(), totalChunks: chunk.totalChunks,
      hops: chunk.hops, srcIdHex: chunk.srcIdHex, firstSeen: Date.now() });
  }
  const buf = this.chunkBuffers.get(key)!;
  buf.chunks.set(chunk.chunkIndex, chunk.payload);
  if (Date.now() - buf.firstSeen > 30_000) { this.chunkBuffers.delete(key); return; }
  if (buf.chunks.size === buf.totalChunks) {
    this.chunkBuffers.delete(key);
    this.seenMids.add(key);
    if (this.seenMids.size > 300) this.seenMids.delete(this.seenMids.values().next().value!);
    const payload = this._reassemble(buf);
    this.onMessageReassembled?.({ mid: key, src: buf.srcIdHex, sn: 'Peer', pay: payload,
      ts: Date.now(), ttl: 86400, hops: buf.hops ?? 0 });
  }
}
```

`_reassemble` strips null padding while concatenating chunks:
```ts
private _reassemble(buf: ChunkBuffer): string {
  const allBytes: number[] = [];
  for (let i = 0; i < buf.totalChunks; i++) {
    const c = buf.chunks.get(i);
    if (c) for (const b of c) if (b !== 0) allBytes.push(b);
  }
  return Buffer.from(allBytes).toString('utf8');
}
```

---

## 8. Meshtastic LoRa Bridge (`MeshtasticService`)

**File:** `services/meshtastic.service.ts`. Talks to real Meshtastic firmware over the official BLE GATT API. Hand-rolled protobuf encoding/decoding to avoid Metro's ESM bundling issues with `@meshtastic/protobufs`.

### 8.1 Hand-rolled protobuf

Wire-type primitives:
```ts
function writeVarint(buf: number[], value: number): void {
  value = value >>> 0;
  while (value > 0x7f) { buf.push((value & 0x7f) | 0x80); value = value >>> 7; }
  buf.push(value & 0x7f);
}
function writeFixed32(buf, value)   { ... 4 little-endian bytes }
function writeBytes(buf, fieldNum, data) { writeTag(buf, fieldNum, 2); writeVarint(buf, data.length); for (const b of data) buf.push(b); }
```

`encodeData(portnum, payload)` builds the inner `Data` (PortNum+payload). `encodeMeshPacket(...)` builds a `MeshPacket` with the **verified** Meshtastic field numbers (`from=1`, `to=2`, `channel=3`, `decoded=4`, `id=6`, `hop_limit=9`, `want_ack=10`):

```ts
function encodeMeshPacket(params): Uint8Array {
  const buf: number[] = [];
  if (params.from !== 0) writeFixed32Field(buf, 1, params.from);
  writeFixed32Field(buf, 2, params.to);
  if (params.channel !== 0) writeVarintField(buf, 3, params.channel);
  writeBytes(buf, 4, params.decoded);
  writeFixed32Field(buf, 6, params.id);
  writeVarintField(buf, 9, params.hopLimit);
  if (params.wantAck) writeVarintField(buf, 10, 1);
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
  this.fromNumCleanup = getBLEService().monitorRaw(deviceId,
    MESHTASTIC_SERVICE_UUID, MESHTASTIC_FROMNUM_UUID,
    () => { this._scheduleDrain(); });

  const nonce = (Math.random() * 0xffffffff) >>> 0;
  const ok = await getBLEService().writeRaw(deviceId,
    MESHTASTIC_SERVICE_UUID, MESHTASTIC_TORADIO_UUID, encodeToRadioWantConfig(nonce));
  if (!ok) return false;

  this.deviceId = deviceId;
  await new Promise(r => setTimeout(r, 50));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !configured) {
    if (await this._drainFromRadio(nonce)) configured = true;
    else await new Promise(r => setTimeout(r, 150));
  }
  await this._sendBeacon();
  return true;
}
```

### 8.3 Sending text

```ts
async sendText(text: string, channel = 0): Promise<boolean> {
  const data = encodeData(PORT_TEXT, new TextEncoder().encode(text));
  const pktId = (Math.random() * 0xffffffff) >>> 0;
  const meshPkt = encodeMeshPacket({
    to: BROADCAST_ADDR, from: 0, id: pktId, channel,
    hopLimit: 3, wantAck: false, decoded: data,
  });
  const toRadio = encodeToRadioPacket(meshPkt);
  return getBLEService().writeRaw(this.deviceId,
    MESHTASTIC_SERVICE_UUID, MESHTASTIC_TORADIO_UUID, toRadio);
}
```

### 8.4 Drain coalescing

`FromNum` may fire repeatedly during steady state; running a full 100-iteration drain per notification monopolises the radio and starves the BLE-advertiser scanner. Strategy: at most one drain in flight; if a notification arrives during a drain, remember it and run exactly one more drain after.
```ts
private _scheduleDrain(): void {
  if (this.draining) { this.drainPending = true; return; }
  this._drainFromRadio().catch(() => {}).then(() => {
    if (this.drainPending) { this.drainPending = false; this._scheduleDrain(); }
  });
}
```

Drain budget: 100 frames during the initial handshake (large NodeDB), 8 frames otherwise. A 20 ms yield between reads keeps the BLE-advertiser code paths alive:
```ts
const maxFrames = expectedConfigId !== undefined ? 100 : 8;
for (let i = 0; i < maxFrames; i++) {
  const bytes = await getBLEService().readRaw(this.deviceId, ..., MESHTASTIC_FROMRADIO_UUID);
  if (!bytes || bytes.length === 0) break;
  this._handleFromRadio(bytes, expectedConfigId, m => { if (m) sawConfigComplete = true; });
  await new Promise(r => setTimeout(r, 20));
}
```

### 8.5 Decoding incoming text

`_handleFromRadio` walks the protobuf fields. `field 2 = packet (MeshPacket)`, then within that: `from=1`, `decoded=4`, `id=6`, `rx_time=7`, `channel=3`. If `Data.portnum === PORT_TEXT (1)` and `from !== myNodeNum`, fire `onTextMessage`:
```ts
this.onTextMessage?.({
  fromNodeNum: fromNum,
  fromName: this.nodeNames.get(fromNum) || `!${fromNum.toString(16)}`,
  text: getString(payloadF.value),
  channel: ..., rxTime: ..., id: ...,
});
```

The NodeDB (`nodeNames`) is populated from `field 4 (node_info)` frames during the handshake.

---

## 9. Core Mesh Engine (`useMesh`)

**File:** `hooks/useMesh.ts`. Single hook that ties BLE + Phone-Mesh + Meshtastic into a coherent send/receive/relay engine.

### 9.1 Module-level guards

Some state must outlive React re-renders and be shared between every `useMesh()` instance (Chat & Nodes screens both call it):
```ts
const _processedMids = new Set<string>();   // permanent, never cleared
let _autoStarted = false;                    // only one screen starts the scan
let _autoConnectInFlight = false;            // at most one Meshtastic auto-connect at a time
```

### 9.2 Always-fresh refs

To prevent stale-closure bugs in BLE callbacks, every render rewrites refs:
```ts
seenIdsRef.current        = msgsSlice.seenIds;
myNodeIdRef.current       = nodesSlice.myNodeId;
nearbyNodesRef.current    = nodesSlice.nearbyNodes;
connectedNodeIdsRef.current = nodesSlice.connectedNodeIds;
```

### 9.3 Auto-start scanning

When BLE is ready and the local node ID is known, exactly one screen kicks the scan:
```ts
useEffect(() => {
  if (ble.isReady && nodesSlice.myNodeId && !_autoStarted) {
    _autoStarted = true;
    ble.startScan();
  }
}, [ble.isReady, nodesSlice.myNodeId]);
```

### 9.4 Auto-connect to nearest Meshtastic

```ts
useEffect(() => {
  if (!ble.isReady || _autoConnectInFlight) return;
  const meshtasticNodes = nodesSlice.nearbyNodes.filter(n => n.type === 'meshtastic');
  if (meshtasticNodes.length === 0) return;
  if (meshtasticNodes.some(n => nodesSlice.connectedNodeIds.includes(n.node_id))) return;
  const target = [...meshtasticNodes].sort((a,b) => b.rssi - a.rssi)[0];
  _autoConnectInFlight = true;
  ble.connectToNode(target.node_id).then(async (connected) => {
    if (connected) await getMeshtasticService().connect(target.node_id);
  }).finally(() => { _autoConnectInFlight = false; });
}, [nodesSlice.nearbyNodes, nodesSlice.connectedNodeIds, ble.isReady]);
```

### 9.5 Phone-mesh receive handler (4 layers of dedup + filtering)

```ts
phoneMesh.setMessageCallback((raw) => {
  if (!raw.mid || !raw.pay) return;
  if (getPhoneMeshService().isOwnSrcId?.(raw.src ?? '')) return;             // L0
  const myShortId = myNodeIdRef.current.replace(/-/g, '').slice(0, 4).toLowerCase();
  if ((raw.src ?? '').toLowerCase() === myShortId) return;                   // L1
  if (_processedMids.has(raw.mid)) return;                                   // L2
  if (seenIdsRef.current.includes(raw.mid)) return;                          // L3

  _processedMids.add(raw.mid);
  msgsSlice.dispatch(msgsSlice.addSeenId(raw.mid));
  getPhoneMeshService().markMessageSeen(raw.mid);

  // Hard filter: unknown sender (no presence beacon yet) → drop
  const peerNode = nearbyNodesRef.current.find(n =>
    n.node_id.replace('phone-', '').startsWith(raw.src ?? ''));
  const sourceName = peerNode?.name || `Peer-${(raw.src??'').slice(0,4)}`;
  if (sourceName.startsWith('Peer-')) return;

  const msg: Message = { message_id: raw.mid, source_id: raw.src, ... };
  if (!isExpired(msg) && msg.hops <= MAX_HOPS) {
    msgsSlice.dispatch(msgsSlice.addMessageAsync(msg));
    showMessageNotification(sourceName, msg.payload).catch(() => {});

    // Step 1: hand off to a connected Meshtastic node if any
    const connectedMt = nearbyNodesRef.current.filter(n => n.type === 'meshtastic'
      && connectedNodeIdsRef.current.includes(n.node_id));
    if (connectedMt.length > 0) transmitToAllNodes(msg);

    // Step 2: re-broadcast on phone-mesh (relay)
    getPhoneMeshService().broadcastMessage(messageToPacket(msg));

    if (peerNode) nodesSlice.dispatch(nodesSlice.incrementRelayCount(peerNode.node_id));
  }
});
```

### 9.6 Meshtastic receive handler

Each Meshtastic frame gets a synthetic dedup key (`mt-<id-hex>`) since the radio uses uint32 IDs not UUIDs:
```ts
getMeshtasticService().setTextMessageCallback((incoming) => {
  const dedupKey = `mt-${incoming.id.toString(16).padStart(8, '0')}`;
  if (_processedMids.has(dedupKey)) return;
  if (seenIdsRef.current.includes(dedupKey)) return;
  _processedMids.add(dedupKey);
  msgsSlice.dispatch(msgsSlice.addSeenId(dedupKey));
  const msg: Message = {
    message_id: uuidv4(),
    source_id: `meshtastic-${incoming.fromNodeNum.toString(16)}`,
    source_name: incoming.fromName, payload: incoming.text,
    timestamp: incoming.rxTime ? incoming.rxTime * 1000 : Date.now(),
    ttl: 86400, status: 'relayed', hops: 1, via: 'meshtastic',
    destination_id: '*',
  };
  msgsSlice.dispatch(msgsSlice.addMessageAsync(msg));
  showMessageNotification(incoming.fromName, incoming.text).catch(() => {});
});
```

### 9.7 GATT receive listener

For each connected node, register a `listenToNode` and feed messages through `handleIncomingGATTMessage`. Cleanup happens when a node is removed from `connectedNodeIds`:
```ts
for (const nodeId of nodesSlice.connectedNodeIds) {
  if (cleanupListeners.current.has(nodeId)) continue;
  const stopListening = ble.listenToNode(nodeId, (_devId, rawJson) =>
    handleIncomingGATTMessage(rawJson, nodeId));
  cleanupListeners.current.set(nodeId, stopListening);
}
```

### 9.8 sendMessage — routing decision

The send path tries Meshtastic first (LoRa has the longest reach), then falls back to phone-mesh broadcast, then queues:
```ts
const sendMessage = useCallback(async (text, destinationId='*') => {
  const msg: Message = { message_id: uuidv4(), source_id: nodesSlice.myNodeId,
    source_name: nodesSlice.myDisplayName, payload: text, timestamp: Date.now(),
    ttl: nodesSlice.defaultTtl, status: 'pending', hops: 0, destination_id: destinationId };

  // Pre-mark at all dedup layers BEFORE any await
  const shortMid = msg.message_id.replace(/-/g,'').slice(0,8).toLowerCase();
  _processedMids.add(shortMid); _processedMids.add(msg.message_id);
  msgsSlice.dispatch(msgsSlice.addSeenId(shortMid));
  pm.setMyIdentity?.(nodesSlice.myNodeId, nodesSlice.myDisplayName);
  pm.markMessageSeen(shortMid);

  await msgsSlice.dispatch(msgsSlice.addMessageAsync(msg));
  const packet = messageToPacket(msg);

  // Priority 1: Meshtastic (LoRa)
  const connectedMt = nearbyNodesRef.current.filter(n => n.type==='meshtastic'
    && connectedNodeIdsRef.current.includes(n.node_id));
  if (connectedMt.length > 0) {
    if (mt.getConnectedDeviceId() !== target.node_id) await mt.connect(target.node_id);
    if (await mt.sendText(msg.payload, 0)) {
      msgsSlice.dispatch(msgsSlice.updateStatusAsync({ id: msg.message_id, status: 'sent' }));
      msgsSlice.dispatch(msgsSlice.updateViaLocal({ id: msg.message_id, via: 'meshtastic' }));
      // Also broadcast on phone-mesh so peers without Meshtastic still see it
      getPhoneMeshService().broadcastMessage(packet).catch(() => {});
      return 'meshtastic';
    }
  }

  // Priority 2: phone-mesh BLE advertisement
  await phoneMesh.broadcastMessage(packet);
  return 'phone-mesh';

  // Priority 3: queue if neither works
  msgsSlice.dispatch(msgsSlice.enqueueMessageAsync({ ...msg, status: 'pending' }));
  return 'queued';
}, [...]);
```

### 9.9 Pending-queue flush + TTL prune

Every 10 seconds:
```ts
syncIntervalRef.current = setInterval(() => {
  flushPendingQueue();
  msgsSlice.dispatch(msgsSlice.pruneExpiredAsync());
}, 10_000);
```

`flushPendingQueue` walks the queue, expires anything older than TTL, and re-tries everything else over GATT.

### 9.10 Hook return shape

```ts
return {
  messages, pendingCount, nearbyNodes, connectedNodeIds,
  isScanning: nodesSlice.isScanning,    // shared via Redux, not local useBLE state
  myNodeId, myDisplayName,
  sendMessage, startDiscovery, stopDiscovery,
  connectToNode, disconnectFromNode,
};
```

---

## 10. Storage & Persistence

**File:** `services/storage.service.ts`. Thin wrapper over `AsyncStorage` with five keys:
```ts
const KEYS = {
  DEVICE:   'mesh:device',
  MESSAGES: 'mesh:messages',
  PENDING:  'mesh:pending',
  SEEN_IDS: 'mesh:seen_ids',
  NODES:    'mesh:nodes',
};
```

All read/write via `readJSON<T>` / `writeJSON<T>` helpers.

`saveMessage` deduplicates by both exact ID and 8-char short prefix:
```ts
const msgShort = shortId(msg.message_id);
const alreadyExists = existing.some(m =>
  m.message_id === msg.message_id || shortId(m.message_id) === msgShort);
if (alreadyExists) return;
await writeJSON(KEYS.MESSAGES, [...existing, msg]);
```

`deleteExpiredMessages` filters both messages and the pending queue using `isExpired()`:
```ts
export async function deleteExpiredMessages(): Promise<number> {
  const msgs = await getMessages();
  const valid = msgs.filter(m => !isExpired(m));
  await writeJSON(KEYS.MESSAGES, valid);
  const pending = await getPendingQueue();
  await writeJSON(KEYS.PENDING, pending.filter(m => !isExpired(m)));
  return msgs.length - valid.length;
}
```

`isExpired` (`types/message.ts`):
```ts
export function isExpired(msg: Message): boolean {
  return Date.now() > msg.timestamp + msg.ttl * 1000;
}
```

`markAsSeen` caps the seen-IDs list at 2000 with FIFO eviction:
```ts
const capped = arr.length >= 2000 ? arr.slice(-1999) : arr;
await writeJSON(KEYS.SEEN_IDS, [...capped, messageId]);
```

`clearAllMeshData` wipes everything via `multiRemove`.

---

## 11. Notifications

**File:** `services/notification.service.ts`. Uses `expo-notifications` plus a direct `Vibration.vibrate(300)` to ensure a haptic pulse even when channel vibration is muted.

```ts
const CHANNEL_ID = 'mesh-messages-v2';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: true,
  }),
});

export async function setupNotifications(): Promise<boolean> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Mesh Messages',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 300], enableVibrate: true, enableLights: true,
      lightColor: '#00c896', showBadge: true,
    });
  }
  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === 'granted') return true;
  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

export async function showMessageNotification(senderName, messageText) {
  Vibration.vibrate(300);
  await Notifications.scheduleNotificationAsync({
    content: {
      title: senderName,
      body: messageText.length > 120 ? messageText.slice(0,117) + '…' : messageText,
      sound: 'default', data: { type: 'mesh-message' }, color: '#00c896',
      ...(Platform.OS === 'android' && { channelId: CHANNEL_ID, vibrate: [0,300], priority: 'high' as const }),
    },
    trigger: null,
  });
}
```

Setup is invoked **after** the splash hides (`app/_layout.tsx`) so the Android 13+ permission dialog never blocks first launch.

---

## 12. Debug Log Subsystem

**File:** `services/debug-log.service.ts`. Provides an in-memory rolling 500-entry buffer with subscription support, mirrored to console for `adb logcat`.

```ts
private push(level, tag, message): void {
  const entry = { id: this.nextId++, ts: Date.now(), level, tag, message };
  this.buffer.push(entry);
  if (this.buffer.length > this.MAX_ENTRIES)
    this.buffer.splice(0, this.buffer.length - this.MAX_ENTRIES);
  for (const l of this.listeners) l(this.buffer.slice());
  // mirror to console...
}
info(tag, message)  { this.push('info', tag, message); }
warn(tag, message)  { this.push('warn', tag, message); }
error(tag, message) { this.push('error', tag, message); }
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
  const peer = nearbyNodes.find(n => n.node_id.replace('phone-','').startsWith(msg.source_id));
  return peer?.name || msg.source_name;
}
```

Outgoing messages display a transient toast indicating the chosen route:
```ts
const handleSend = async (text) => {
  const route = await sendMessage(text);
  showRouteToast(route);  // 'meshtastic' | 'phone-mesh' | 'queued'
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
rotation.value = withRepeat(withTiming(360, { duration: 2500, easing: Easing.linear }), -1, false);
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
export const IS_EXPO_GO =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

export function getBLEService(): any {
  if (_instance) return _instance;
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
    'android.permission.BLUETOOTH',
    'android.permission.BLUETOOTH_ADMIN',
    'android.permission.BLUETOOTH_SCAN',
    'android.permission.BLUETOOTH_CONNECT',
    'android.permission.BLUETOOTH_ADVERTISE',
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.RECEIVE_BOOT_COMPLETED',
  ],
}
```

Plugins:
```ts
plugins: [
  'expo-router',
  ['expo-notifications', { color: '#00c896', defaultChannel: 'mesh-messages' }],
  ['react-native-ble-plx', {
      isBackgroundEnabled: true,
      modes: ['peripheral', 'central'],
      bluetoothAlwaysPermission: 'Allow DisasterMesh to use Bluetooth ...',
  }],
  ['expo-splash-screen', { backgroundColor: '#ffffff', image: './assets/images/logo-lg.png', ... }],
  ['expo-font', { fonts: [...OpenSans variants] }],
],
```

The `react-native-ble-plx` plugin enables **background** central + peripheral so the app can still receive mesh messages while suspended.

### 15.2 Runtime permission flow

`BLEService.requestPermissions()` is invoked from `useBLE`'s init effect; if denied, an `Alert.alert(...)` directs the user to system settings:
```ts
if (!granted) {
  Alert.alert('Bluetooth Permissions Required', '...',
    [{ text: 'Open Settings', onPress: () => Linking.openSettings() },
     { text: 'Cancel', style: 'cancel' }]);
}
```

---

## 16. Wire Formats

### 16.1 `Message` (in-memory & storage)

```ts
interface Message {
  message_id: string;        // UUID v4
  source_id: string;
  destination_id: string;    // UUID or '*' for broadcast
  source_name: string;
  payload: string;
  timestamp: number;
  ttl: number;               // seconds
  status: 'pending' | 'sent' | 'delivered' | 'relayed' | 'expired';
  hops: number;
  via?: 'meshtastic' | 'phone-mesh' | 'gatt';   // local-only metadata
}
```

### 16.2 `MessagePacket` (compact JSON over GATT)

Short-keyed for size:
```ts
interface MessagePacket { mid; src; dst; sn; pay; ts; ttl; hops; }
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
const expanded = new Set<string>(payload.seenIds);
for (const id of payload.seenIds)
  expanded.add(id.replace(/-/g,'').slice(0,8).toLowerCase());
state.seenIds = Array.from(expanded);
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
