/**
 * MeshNodeType distinguishes between two kinds of network participants:
 * - ble-phone:   Another phone running this app, reachable via BLE
 * - esp32-lora:  An ESP32 hardware node that bridges BLE ↔ LoRa radio
 */
export type MeshNodeType = 'ble-phone' | 'esp32-lora';

/**
 * Represents a discovered node in the mesh network.
 * Updated in real-time as BLE scan results arrive.
 */
export interface MeshNode {
  /** Unique BLE device ID (MAC on Android, UUID on iOS) */
  node_id: string;

  /** Human-readable device name (BLE advertisement name) */
  name: string;

  /** Received Signal Strength Indicator in dBm (e.g. -70) */
  rssi: number;

  /** Whether this is a phone peer or an ESP32 LoRa gateway */
  type: MeshNodeType;

  /** Unix timestamp ms of last BLE advertisement seen */
  last_seen: number;

  /** True if we currently have an active BLE GATT connection */
  is_connected: boolean;

  /** Number of messages successfully relayed through this node */
  relay_count: number;
}

/**
 * Own device identity — persisted to AsyncStorage on first launch.
 */
export interface LocalDevice {
  /** UUID v4 — stable across app restarts */
  device_id: string;

  /** User-chosen display name */
  display_name: string;

  /** Default TTL (seconds) for outgoing messages */
  default_ttl: number;
}

/** Default values for a new local device */
export const DEFAULT_LOCAL_DEVICE: Omit<LocalDevice, 'device_id'> = {
  display_name: 'Anonymous',
  default_ttl: 86400, // 24 hours
};
