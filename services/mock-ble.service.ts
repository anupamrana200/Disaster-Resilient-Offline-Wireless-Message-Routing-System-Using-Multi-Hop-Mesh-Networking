/**
 * MockBLEService — simulates BLE for Expo Go / demo mode.
 *
 * Behaves exactly like BLEService but uses timers instead of
 * real Bluetooth hardware. Use this to develop UI without
 * needing a custom dev build.
 *
 * To switch to real BLE: set USE_MOCK_BLE = false in config.ts
 */

import type { DeviceFoundCallback, MessageReceivedCallback, DisconnectCallback } from './ble.service';

// ── Fake Devices ─────────────────────────────────────────────────────────────

const FAKE_DEVICES = [
  {
    id: 'esp32-node-001',
    name: 'ESP32-LoRa-001',
    rssi: -58,
    type: 'esp32-lora' as const,
  },
  {
    id: 'esp32-node-002',
    name: 'ESP32-LoRa-002',
    rssi: -74,
    type: 'esp32-lora' as const,
  },
  {
    id: 'phone-peer-abc',
    name: 'Peer-Phone-Anup',
    rssi: -65,
    type: 'ble-phone' as const,
  },
  {
    id: 'phone-peer-xyz',
    name: 'Peer-Phone-Riya',
    rssi: -82,
    type: 'ble-phone' as const,
  },
];

// ── Fake incoming messages ────────────────────────────────────────────────────

const FAKE_MESSAGES = [
  { src: 'phone-peer-abc', name: 'Riya', text: 'Is the bridge safe to cross?' },
  { src: 'esp32-node-001', name: 'Node-001', text: '[RELAY] All units move to sector 4' },
  { src: 'phone-peer-xyz', name: 'Anup', text: 'Medical team needed at school building' },
  { src: 'phone-peer-abc', name: 'Riya', text: 'Water supply is cut off in area B' },
  { src: 'esp32-node-002', name: 'Node-002', text: '[RELAY] Rescue team eta 15 minutes' },
];

// ─── MockBLEService Singleton ─────────────────────────────────────────────────

class MockBLEService {
  private static instance: MockBLEService;

  private connectedDevices: Set<string> = new Set();
  private scanIntervals: ReturnType<typeof setInterval>[] = [];
  private msgIntervals: ReturnType<typeof setInterval>[] = [];
  private messageListeners: Map<string, MessageReceivedCallback> = new Map();

  static getInstance(): MockBLEService {
    if (!MockBLEService.instance) {
      MockBLEService.instance = new MockBLEService();
    }
    return MockBLEService.instance;
  }

  async requestPermissions(): Promise<boolean> {
    // Always granted in mock mode
    return true;
  }

  async waitForBluetooth(): Promise<void> {
    // Instantly "powered on"
    return Promise.resolve();
  }

  // ─── Scan ──────────────────────────────────────────────────────────────────

  startScan(onDeviceFound: DeviceFoundCallback): void {
    this.stopScan();

    // Emit fake devices one by one with staggered delays
    FAKE_DEVICES.forEach((dev, i) => {
      const timer = setTimeout(() => {
        onDeviceFound({
          id: dev.id,
          name: dev.name,
          localName: dev.name,
          rssi: dev.rssi + Math.floor(Math.random() * 8 - 4), // slight RSSI variation
        } as any);
      }, 800 + i * 1200);

      this.scanIntervals.push(timer as any);
    });

    // Repeat scan cycle every 12 seconds to simulate dynamic discovery
    const cycleTimer = setInterval(() => {
      FAKE_DEVICES.forEach((dev, i) => {
        setTimeout(() => {
          onDeviceFound({
            id: dev.id,
            name: dev.name,
            localName: dev.name,
            rssi: dev.rssi + Math.floor(Math.random() * 10 - 5),
          } as any);
        }, i * 600);
      });
    }, 12_000);

    this.scanIntervals.push(cycleTimer);
  }

  startMeshScan(onDeviceFound: DeviceFoundCallback): void {
    // In real build this filters by MESH_SERVICE_UUID.
    // In mock, all fake devices (esp32 + phones) appear.
    this.startScan(onDeviceFound);
  }

  stopScan(): void {
    this.scanIntervals.forEach(t => clearTimeout(t));
    this.scanIntervals = [];
  }

  // ─── Connection ────────────────────────────────────────────────────────────

  async connectToDevice(
    deviceId: string,
    _onDisconnect?: DisconnectCallback,
  ): Promise<any> {
    await new Promise(r => setTimeout(r, 800)); // simulate connect delay
    this.connectedDevices.add(deviceId);

    // After connection, auto-start sending fake incoming messages
    this._startFakeIncoming(deviceId);

    return { id: deviceId };
  }

  async disconnectDevice(deviceId: string): Promise<void> {
    this.connectedDevices.delete(deviceId);
    const timer = this.msgIntervals.shift();
    if (timer) clearInterval(timer);
  }

  isConnected(deviceId: string): boolean {
    return this.connectedDevices.has(deviceId);
  }

  getConnectedDeviceIds(): string[] {
    return Array.from(this.connectedDevices);
  }

  // ─── Data Transfer ─────────────────────────────────────────────────────────

  async sendMessage(_deviceId: string, _payload: string): Promise<boolean> {
    await new Promise(r => setTimeout(r, 300)); // simulate BLE write delay
    return true;
  }

  listenForMessages(deviceId: string, callback: MessageReceivedCallback): () => void {
    this.messageListeners.set(deviceId, callback);
    return () => this.messageListeners.delete(deviceId);
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private _startFakeIncoming(deviceId: string): void {
    let msgIndex = 0;

    // Send first message after 3 seconds
    const firstTimer = setTimeout(() => {
      this._emitFakeMessage(deviceId, msgIndex++);
    }, 3000);

    // Then random messages every 10-20 seconds
    const interval = setInterval(() => {
      if (msgIndex < FAKE_MESSAGES.length) {
        this._emitFakeMessage(deviceId, msgIndex++);
      }
    }, 12_000);

    this.msgIntervals.push(firstTimer as any, interval);
  }

  private _emitFakeMessage(deviceId: string, index: number): void {
    const fakeMsg = FAKE_MESSAGES[index % FAKE_MESSAGES.length];
    const packet = {
      mid: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      src: fakeMsg.src,
      dst: '*',
      sn: fakeMsg.name,
      pay: fakeMsg.text,
      ts: Date.now(),
      ttl: 86400,
      hops: Math.floor(Math.random() * 3),
    };

    const listener = this.messageListeners.get(deviceId);
    if (listener) {
      listener(deviceId, JSON.stringify(packet));
    }
  }

  async destroy(): Promise<void> {
    this.stopScan();
    this.msgIntervals.forEach(t => clearInterval(t));
    this.msgIntervals = [];
  }
}

export default MockBLEService;
