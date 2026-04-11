/**
 * BLEService — React Native BLE PLX wrapper for mesh networking.
 *
 * Roles:
 *   Central: Scans for and connects to ESP32 LoRa nodes + other phones.
 *   GATT Client: Reads/writes characteristics, subscribes to notifications.
 *
 * ESP32 GATT Profile (must match firmware):
 *   Service UUID   : 4fafc201-1fb5-459e-8fcc-c5c9c331914b
 *   TX Char UUID   : beb5483e-36e1-4688-b7f5-ea07361b26a8  (phone → ESP32)
 *   RX Char UUID   : beb5483e-36e1-4688-b7f5-ea07361b26a9  (ESP32 → phone, notify)
 *
 * Usage:
 *   const ble = BLEService.getInstance();
 *   ble.startScan(onDeviceFound);
 *   ble.sendMessage(deviceId, jsonString);
 *   ble.listenForMessages(deviceId, onMessage);
 */

import {
  BleManager,
  Device,
  BleError,
  Characteristic,
  State as BleState,
} from 'react-native-ble-plx';
import { Platform, PermissionsAndroid } from 'react-native';
import { Buffer } from 'buffer';

// ─── GATT UUIDs ───────────────────────────────────────────────────────────────
// These must match exactly what is programmed in the ESP32 firmware.

export const MESH_SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
export const MESH_CHAR_TX_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a8'; // phone→node
export const MESH_CHAR_RX_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a9'; // node→phone

/** Callback signatures */
export type DeviceFoundCallback = (device: Device) => void;
export type MessageReceivedCallback = (deviceId: string, rawJson: string) => void;
export type DisconnectCallback = (deviceId: string, error: BleError | null) => void;

// ─── BLE Service Singleton ───────────────────────────────────────────────────

class BLEService {
  private static instance: BLEService;
  private manager: BleManager;

  /** deviceId → Device map for active GATT connections */
  private connectedDevices: Map<string, Device> = new Map();

  /** Subscription handles (for cleanup) */
  private scanSubscription: ReturnType<BleManager['startDeviceScan']> | null = null;
  private notifySubscriptions: Map<string, { remove: () => void }> = new Map();

  private constructor() {
    this.manager = new BleManager();
  }

  static getInstance(): BLEService {
    if (!BLEService.instance) {
      BLEService.instance = new BLEService();
    }
    return BLEService.instance;
  }

  // ─── Permission Handling ────────────────────────────────────────────────────

  /**
   * Request all necessary BLE permissions.
   * On Android 12+ requires BLUETOOTH_SCAN, BLUETOOTH_CONNECT, and fine location.
   * On iOS: handled by Info.plist — no runtime request needed.
   * Returns true if all permissions granted.
   */
  async requestPermissions(): Promise<boolean> {
    if (Platform.OS === 'ios') return true;

    if (Platform.OS === 'android') {
      const androidVersion = parseInt(String(Platform.Version), 10);

      if (androidVersion >= 31) {
        // Android 12+ — request all BLE permissions
        const results = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]);

        // Essential permissions: SCAN + LOCATION are needed for discovery
        const scanOk = results[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] === PermissionsAndroid.RESULTS.GRANTED;
        const locOk = results[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED;
        const connectOk = results[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] === PermissionsAndroid.RESULTS.GRANTED;
        const advOk = results[PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE] === PermissionsAndroid.RESULTS.GRANTED;

        console.log(`[BLE] Permissions — Scan:${scanOk} Loc:${locOk} Connect:${connectOk} Advertise:${advOk}`);

        // All four permissions are required:
        //   SCAN     — to discover nearby devices
        //   LOCATION — required by Android for BLE scan results to include data
        //   CONNECT  — to establish GATT connections to ESP32 nodes
        //   ADVERTISE — to broadcast presence beacons so others can discover us
        return scanOk && locOk && connectOk && advOk;
      } else {
        // Android < 12 — only need location
        const result = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        );
        return result === PermissionsAndroid.RESULTS.GRANTED;
      }
    }

    return false;
  }

  /**
   * Wait until Bluetooth is powered on.
   * Checks current state first, then listens for changes.
   * Resolves immediately if already on.
   */
  async waitForBluetooth(): Promise<BleState> {
    return new Promise((resolve, reject) => {
      // Check current state first
      this.manager.state().then(currentState => {
        if (currentState === BleState.PoweredOn) {
          resolve(currentState);
          return;
        }
        // Not on yet — listen for state changes
        const subscription = this.manager.onStateChange(state => {
          if (state === BleState.PoweredOn) {
            subscription.remove();
            resolve(state);
          }
        }, true); // true = emit current state immediately
      }).catch(err => {
        console.warn('[BLE] Failed to get BT state:', err);
        reject(err);
      });
    });
  }

  // ─── Scanning ───────────────────────────────────────────────────────────────

  /**
   * Start scanning for BLE devices.
   * Calls onDeviceFound for every unique advertisement received.
   * If serviceUUIDs is provided, only devices advertising those UUIDs appear.
   * Pass null to find ALL nearby BLE devices.
   */
  startScan(
    onDeviceFound: DeviceFoundCallback,
    serviceUUIDs: string[] | null = null,
  ): void {
    this.stopScan(); // always stop previous scan first

    this.manager.startDeviceScan(
      serviceUUIDs,
      { allowDuplicates: true }, // true: re-emit same device so we see updated manufacturer data
      (error, device) => {
        if (error) {
          console.warn('[BLE] Scan error:', error.message);
          return;
        }
        if (device) {
          onDeviceFound(device);
        }
      },
    );
  }

  /**
   * Scan for ALL nearby BLE devices — no UUID filter.
   * Used as a fallback for ESP32 node discovery via ble-plx.
   * Phone peer discovery is handled by BLEAdvertiser in useBLE.ts.
   */
  startMeshScan(onDeviceFound: DeviceFoundCallback): void {
    this.startScan(onDeviceFound, null);
  }

  /** Stop any active BLE scan. */
  stopScan(): void {
    this.manager.stopDeviceScan();
  }

  // ─── Connection ─────────────────────────────────────────────────────────────

  /**
   * Connect to a BLE device and discover its GATT services + characteristics.
   * Returns the connected Device on success.
   * Throws on failure.
   */
  async connectToDevice(
    deviceId: string,
    onDisconnect?: DisconnectCallback,
  ): Promise<Device> {
    if (this.connectedDevices.has(deviceId)) {
      return this.connectedDevices.get(deviceId)!;
    }

    const device = await this.manager.connectToDevice(deviceId, {
      autoConnect: false,
      requestMTU: 512, // request large MTU for full JSON packets
    });

    await device.discoverAllServicesAndCharacteristics();
    this.connectedDevices.set(deviceId, device);

    // Set up disconnect listener for reconnect logic
    device.onDisconnected((error, _dev) => {
      this.connectedDevices.delete(deviceId);
      this.notifySubscriptions.get(deviceId)?.remove();
      this.notifySubscriptions.delete(deviceId);
      onDisconnect?.(deviceId, error);
    });

    return device;
  }

  /**
   * Disconnect from a device and clean up subscriptions.
   */
  async disconnectDevice(deviceId: string): Promise<void> {
    const device = this.connectedDevices.get(deviceId);
    if (!device) return;

    this.notifySubscriptions.get(deviceId)?.remove();
    this.notifySubscriptions.delete(deviceId);
    await device.cancelConnection();
    this.connectedDevices.delete(deviceId);
  }

  /** Check if a device is currently connected. */
  isConnected(deviceId: string): boolean {
    return this.connectedDevices.has(deviceId);
  }

  /** Get all currently connected device IDs. */
  getConnectedDeviceIds(): string[] {
    return Array.from(this.connectedDevices.keys());
  }

  // ─── GATT Read / Write ──────────────────────────────────────────────────────

  /**
   * Send a JSON string message to a connected node via the TX characteristic.
   * Automatically chunks if the string exceeds MTU limits.
   * Returns true on success.
   */
  async sendMessage(deviceId: string, jsonPayload: string): Promise<boolean> {
    const device = this.connectedDevices.get(deviceId);
    if (!device) {
      console.warn('[BLE] Cannot send — not connected to', deviceId);
      return false;
    }

    try {
      const encoded = Buffer.from(jsonPayload, 'utf8').toString('base64');
      await device.writeCharacteristicWithResponseForService(
        MESH_SERVICE_UUID,
        MESH_CHAR_TX_UUID,
        encoded,
      );
      return true;
    } catch (err) {
      console.warn('[BLE] Send error:', err);
      return false;
    }
  }

  /**
   * Subscribe to incoming notifications on the RX characteristic.
   * Calls onMessage whenever the ESP32 pushes new data.
   * Returns a cleanup function.
   */
  listenForMessages(
    deviceId: string,
    onMessage: MessageReceivedCallback,
  ): () => void {
    const device = this.connectedDevices.get(deviceId);
    if (!device) {
      console.warn('[BLE] Cannot listen — not connected to', deviceId);
      return () => {};
    }

    const subscription = device.monitorCharacteristicForService(
      MESH_SERVICE_UUID,
      MESH_CHAR_RX_UUID,
      (error, characteristic: Characteristic | null) => {
        if (error) {
          console.warn('[BLE] Notify error:', error.message);
          return;
        }
        if (characteristic?.value) {
          const decoded = Buffer.from(characteristic.value, 'base64').toString('utf8');
          onMessage(deviceId, decoded);
        }
      },
    );

    this.notifySubscriptions.set(deviceId, subscription);
    return () => subscription.remove();
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────────────

  /** Disconnect all devices and destroy the BLE manager. */
  async destroy(): Promise<void> {
    this.stopScan();
    for (const id of this.connectedDevices.keys()) {
      await this.disconnectDevice(id);
    }
    this.manager.destroy();
  }
}

export default BLEService;
