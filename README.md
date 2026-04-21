# DisasterMesh

**Disaster-Resilient Offline Wireless Message Routing System Using Multi-Hop Mesh Networking**

A mobile application that enables text communication in disaster scenarios where traditional internet and cellular infrastructure has failed. It works entirely offline using Bluetooth Low Energy (BLE) to form a peer-to-peer mesh network between phones, with optional LoRa long-range radio via Meshtastic devices.

---

## How It Works

Messages travel across a multi-hop mesh network — each phone acts as both a sender and a relay node. If the recipient is out of direct BLE range, intermediate phones automatically forward the message until it reaches the destination (up to 5 hops). When a Meshtastic LoRa device is nearby, the app uses it as a gateway to extend range significantly beyond BLE limits.

```
Phone A  ──BLE──►  Phone B  ──BLE──►  Meshtastic  ──LoRa──►  Phone C
(sender)           (relay)            (gateway)               (recipient)
```

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│           Chat / Nodes / Settings Screens            │
├─────────────────────────────────────────────────────┤
│            useMesh() Hook  (core mesh logic)         │
├───────────────────────┬─────────────────────────────┤
│   useBLE Hook         │   PhoneMeshService           │
│   (GATT connections)  │   (BLE advertisement mesh)   │
├───────────────────────┼─────────────────────────────┤
│   react-native-ble-plx│   react-native-ble-advertiser│
├───────────────────────┴─────────────────────────────┤
│        Redux Slices: messages · nodes · app          │
├─────────────────────────────────────────────────────┤
│              AsyncStorage (persistence)              │
├─────────────────────────────────────────────────────┤
│   Physical Layer                                     │
│   ├─ BLE GATT  ↔  Meshtastic ESP32 (LoRa)           │
│   └─ BLE Advertising  ↔  Nearby Phones              │
└─────────────────────────────────────────────────────┘
```

### Data Flow

1. User types a message → `ChatInput` component
2. `useMesh.sendMessage()` marks the message as seen across 3 dedup layers
3. **Routing decision:**
   - Connected Meshtastic nearby → send via GATT (LoRa priority)
   - Meshtastic in range but not connected → auto-connect, then send
   - No Meshtastic → broadcast via `PhoneMeshService` (BLE ads)
4. Receiving phones deduplicate, store, and relay the message onward
5. All messages persisted to AsyncStorage; TTL-expired messages pruned every 10 seconds

---

## Transport Layers

### Phone-to-Phone BLE Mesh (`phone-mesh.service.ts`)
- Messages are chunked into 10-byte payloads and broadcast as BLE manufacturer data packets
- Each chunk repeated 5× at 400 ms intervals for reliability
- BLE advertisement format: `[DM header][type][msgId/deviceId][chunk metadata][payload]`
- Presence beacons advertise device ID + display name so peers appear in the node list
- Android only (iOS restricts background BLE advertising)

### Meshtastic LoRa Gateway (`ble.service.ts`)
- App connects via GATT to ESP32 nodes running Meshtastic firmware
- Uses hardcoded UUIDs matching the Meshtastic firmware:
  - Service UUID: `4fafc201-1fb5-459e-8fcc-c5c9c331914b`
  - TX (phone → ESP32): `beb5483e-36e1-4688-b7f5-ea07361b26a8`
  - RX (ESP32 → phone): `beb5483e-36e1-4688-b7f5-ea07361b26a9`
- Compact `MessagePacket` JSON sent over GATT; Meshtastic handles LoRa transmission

---

## Message Routing Logic

- **MAX_HOPS = 5** — prevents infinite relay loops
- **3-layer deduplication:** module-level `Set` (permanent), service-level `Set`, Redux `seenIds` array
- **Relay priority:** Meshtastic (LoRa) → phone mesh BLE → pending queue
- **Pending queue:** messages queued when no nodes are reachable; flushed every 10 seconds
- **TTL:** default 24 hours, configurable per device; expired messages auto-removed

---

## Screens

### Chat
WhatsApp-style messaging interface.
- Real-time message list with auto-scroll
- Message bubbles: own messages right-aligned (teal), others left-aligned (dark)
- Shows sender name, timestamp, delivery status, and hop count (↷)
- Connectivity status banner with blinking indicator and pending message count
- Keyboard-aware sticky input bar (max 400 characters)
- Toast notification showing which route a message used (Meshtastic / phone-mesh / queued)

### Nodes
BLE discovery and connection management.
- Animated radar visualization during scanning
- Node list with type icon (phone or Meshtastic), RSSI signal bars (5-level), last-seen time, relay count
- Connect / disconnect controls for Meshtastic devices
- Live stats: connected node count, total discovered, total relayed

### Settings
Device identity and configuration.
- Set and edit display name (persisted across restarts via UUID)
- Configure message TTL (preset or custom duration)
- Storage management and data reset

---

## Key Files

| File | Purpose |
|---|---|
| `hooks/useMesh.ts` | Core mesh networking: routing, relay, dedup, dual transport |
| `hooks/useBLE.ts` | BLE scanning, GATT connections, Meshtastic discovery |
| `hooks/useNodeId.ts` | Stable device UUID generation and persistence |
| `services/phone-mesh.service.ts` | Phone-to-phone BLE advertisement broadcasting |
| `services/ble.service.ts` | Meshtastic GATT wrapper |
| `services/storage.service.ts` | AsyncStorage with TTL, dedup, JSON serialization |
| `slices/messages.slice.ts` | Message state (history, pending queue, dedup cache) |
| `slices/nodes.slice.ts` | Node discovery state (nearby nodes, connections) |
| `types/message.ts` | `Message`, `MessagePacket`, `MessageStatus` types |
| `types/node.ts` | `MeshNode`, `LocalDevice`, `MeshNodeType` types |
| `app/(main)/(tabs)/chat/` | Chat screen route |
| `app/(main)/(tabs)/nodes/` | Nodes screen route |
| `app/(main)/(tabs)/settings/` | Settings screen route |

---

## Message Data Model

```typescript
interface Message {
  message_id: string;        // UUID v4
  source_id: string;         // sender device UUID
  destination_id: string;    // recipient UUID or '*' for broadcast
  source_name: string;       // display name of sender
  payload: string;           // message text
  timestamp: number;         // Unix ms
  ttl: number;               // seconds until expiry
  status: MessageStatus;     // pending | sent | delivered | relayed | expired
  hops: number;              // relay hop count
}
```

Wire format (`MessagePacket`) is a compact JSON with short keys (`mid`, `src`, `dst`, `sn`, `pay`, `ts`, `ttl`, `hops`) to minimise BLE payload size.

---

## Node Data Model

```typescript
interface MeshNode {
  node_id: string;           // UUID v4
  name: string;              // display name
  rssi: number;              // signal strength in dBm
  type: 'ble-phone' | 'meshtastic';
  last_seen: number;         // Unix ms
  is_connected: boolean;
  relay_count: number;       // messages relayed through this node
}
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | React Native + Expo SDK 54 |
| Language | TypeScript (strict mode) |
| Navigation | Expo Router v6 (file-based) |
| State | Redux Toolkit |
| BLE (GATT) | react-native-ble-plx |
| BLE (Advertising) | react-native-ble-advertiser |
| Storage | AsyncStorage |
| Notifications | expo-notifications |
| UI | StyleSheet + custom dark theme |

---

## Android Permissions Required

```
BLUETOOTH, BLUETOOTH_ADMIN
BLUETOOTH_SCAN, BLUETOOTH_CONNECT, BLUETOOTH_ADVERTISE
ACCESS_FINE_LOCATION, ACCESS_COARSE_LOCATION
FOREGROUND_SERVICE, RECEIVE_BOOT_COMPLETED
```

BLE PLX is configured with background mode enabled (peripheral + central) so messages can be received when the app is backgrounded.

---

## Getting Started

### Prerequisites
- Node 20.x or higher
- Expo CLI
- Android device (BLE advertising required; iOS has background advertising restrictions)
- Optional: Meshtastic ESP32 device for LoRa range extension

### Setup

```bash
# Install dependencies
npm install

# Start development server
npm run dev:android
```

### Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start Expo dev server (all platforms) |
| `npm run dev:android` | Start for Android only |
| `npm run dev:ios` | Start for iOS only |
| `npm run dev:build:mobile` | Build APK + IPA via EAS |
| `npm run lint` | Run ESLint |
| `npm run format` | Run Prettier |
| `npm run test` | Run Jest tests |

---

## Disaster Scenario Usage

1. **No infrastructure needed** — app works with only Bluetooth enabled
2. **Launch app** on multiple Android devices
3. Go to **Nodes** tab — devices will auto-discover each other via BLE scan
4. Go to **Chat** tab — send a broadcast message (`*`) to reach all nodes
5. Each device in range automatically **relays** the message further
6. If a **Meshtastic** device is nearby, connect to it in the Nodes tab for LoRa range (km-scale)
7. Messages are stored locally and retried — they survive temporary disconnections

---

## License

MIT
