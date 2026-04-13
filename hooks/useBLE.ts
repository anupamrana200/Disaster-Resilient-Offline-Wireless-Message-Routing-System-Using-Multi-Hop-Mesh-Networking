/**
 * useBLE — manages BLE scanning and connections.
 *
 * SCANNING:  Uses react-native-ble-advertiser's scan() with NO filter.
 *            This is the correct library to use for reading manufacturer data
 *            from advertisements. It emits 'onDeviceFound' events via
 *            DeviceEventEmitter.
 *
 *            scanByService() was NOT used because it had a NullPointerException
 *            bug in the library's Java source (v0.0.17): it sets filters=null
 *            then calls null.add(), so mScanner.startScan() was never reached
 *            and the scan never actually ran.
 *
 *            scan(null, options) is used instead — scans ALL BLE devices with
 *            no filter. Only DisasterMesh devices (DM header in manufData) are
 *            added to the node list.
 *
 * ADVERTISING: react-native-ble-advertiser broadcast() — presence beacons and
 *              message chunks (handled by PhoneMeshService).
 *
 * CONNECTIONS: Uses react-native-ble-plx for GATT connections to ESP32 nodes.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { Alert, Linking, DeviceEventEmitter, Platform } from 'react-native';
import { getBLEService } from '@/services/ble-adapter';
import { MESH_SERVICE_UUID } from '@/services/ble.service';
import type { MessageReceivedCallback } from '@/services/ble.service';
import { getPhoneMeshService } from '@/services/phone-mesh-adapter';
import { useNodesSlice } from '@/slices/nodes.slice';

interface UseBLEResult {
  isReady: boolean;
  isScanning: boolean;
  permissionsGranted: boolean;
  startScan: () => void;
  stopScan: () => void;
  connectToNode: (nodeId: string) => Promise<boolean>;
  disconnectFromNode: (nodeId: string) => Promise<void>;
  sendToNode: (nodeId: string, payload: string) => Promise<boolean>;
  listenToNode: (nodeId: string, callback: MessageReceivedCallback) => () => void;
}

export function useBLE(): UseBLEResult {
  const { dispatch, upsertNode, setNodeConnected, setNodeDisconnected, setScanning, myNodeId } =
    useNodesSlice();

  const [isReady, setReady] = useState(false);
  const [isScanning, setIsScanningState] = useState(false);
  const [permissionsGranted, setPermissionsGranted] = useState(false);
  const reconnectTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const isReadyRef = useRef(false);
  const isScanningRef = useRef(false);
  const scanListenerRef = useRef<any>(null);

  // Always-fresh ref — never stale in closures.
  // Used to filter out our own BLE advertisement chunks on Android 11,
  // which reports the device's own broadcasts back via the scan listener.
  const myNodeIdRef = useRef<string>('');
  myNodeIdRef.current = myNodeId;

  // ─── Init: permissions + BT state ──────────────────────────────────────────
  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        console.log('[BLE] Initializing BLE service...');
        const ble = getBLEService();

        console.log('[BLE] Requesting permissions...');
        const granted = await ble.requestPermissions();
        console.log('[BLE] Permissions granted:', granted);

        if (!mounted) return;
        setPermissionsGranted(granted);

        if (!granted) {
          console.warn('[BLE] Permissions denied — scan will not work');
          Alert.alert(
            'Bluetooth Permissions Required',
            'DisasterMesh needs Bluetooth and Location permissions to discover nearby mesh nodes.\n\nPlease go to Settings → Apps → DisasterMesh → Permissions and grant:\n• Nearby Devices (Scan + Advertise + Connect)\n• Location (Precise)',
            [
              { text: 'Open Settings', onPress: () => Linking.openSettings() },
              { text: 'Cancel', style: 'cancel' },
            ],
          );
          setReady(true);
          isReadyRef.current = true;
          return;
        }

        console.log('[BLE] Waiting for Bluetooth to power on...');
        const btReady = await Promise.race([
          ble.waitForBluetooth(),
          new Promise<'timeout'>((resolve) =>
            setTimeout(() => resolve('timeout'), 10_000),
          ),
        ]);

        if (!mounted) return;

        if (btReady === 'timeout') {
          console.warn('[BLE] Bluetooth not powered on within 10s — still marking ready');
        } else {
          console.log('[BLE] Bluetooth powered on — BLE ready');
        }

        setReady(true);
        isReadyRef.current = true;
      } catch (err) {
        console.error('[BLE] Init error:', err);
        if (mounted) {
          setReady(true);
          isReadyRef.current = true;
        }
      }
    })();

    return () => {
      mounted = false;
      if (scanListenerRef.current) {
        scanListenerRef.current.remove();
        scanListenerRef.current = null;
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const BLEAdvertiser = require('react-native-ble-advertiser');
        BLEAdvertiser.stopScan();
      } catch (_) {}
      reconnectTimers.current.forEach(t => clearTimeout(t));
    };
  }, []);

  // ─── Scanning via react-native-ble-advertiser ──────────────────────────────
  //
  // Uses scan(null, options) — no filter — to scan ALL nearby BLE devices.
  // The 'onDeviceFound' event includes manufData (company ID stripped) only for
  // devices that match the companyId set via setCompanyId(). We then filter by
  // the "DM" header to identify DisasterMesh phones.

  const startScan = useCallback(() => {
    console.log('[BLE] startScan called | isReady:', isReadyRef.current, '| isScanning:', isScanningRef.current);

    if (isScanningRef.current) {
      console.log('[BLE] Already scanning');
      return;
    }

    if (!isReadyRef.current) {
      console.warn('[BLE] Not ready yet — BLE may still be initializing');
      return;
    }

    if (Platform.OS !== 'android') {
      console.warn('[BLE] Only Android is supported');
      return;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const BLEAdvertiser = require('react-native-ble-advertiser');
      BLEAdvertiser.setCompanyId(0xFFFF);

      // Remove stale listener
      if (scanListenerRef.current) {
        scanListenerRef.current.remove();
        scanListenerRef.current = null;
      }

      // Listen for scan results.
      // manufData is returned WITHOUT company ID prefix (the library strips it).
      // It is only present in the event when the device advertises manufacturer
      // data for our company ID (0xFFFF). Non-DM devices have no manufData field.
      scanListenerRef.current = DeviceEventEmitter.addListener(
        'onDeviceFound',
        (event: any) => {
          try {
            const deviceId: string = event.deviceAddress ?? event.deviceName ?? `unknown-${Date.now()}`;
            const deviceName: string = event.deviceName ?? '';
            const rssi: number = event.rssi ?? -100;

            const manufData: number[] | null = event.manufData
              ? (Array.isArray(event.manufData)
                ? event.manufData
                : Object.values(event.manufData).map(Number))
              : null;

            let isDMPresence = false;
            let peerDeviceIdHex = '';
            let peerDisplayName = '';

            if (manufData && manufData.length >= 3) {
              // manufData starts directly with "DM" — no company ID prefix
              if (manufData[0] === 0x44 && manufData[1] === 0x4D) {
                const type = manufData[2];

                if (type === 0x02 && manufData.length >= 9) {
                  // Presence beacon
                  isDMPresence = true;
                  peerDeviceIdHex = manufData
                    .slice(3, 9)
                    .map((b: number) => b.toString(16).padStart(2, '0'))
                    .join('');
                  const nameBytes = manufData.slice(9).filter((b: number) => b !== 0);
                  peerDisplayName = String.fromCharCode(...nameBytes).trim();
                  console.log(`[BLE] Presence from ${peerDeviceIdHex}: "${peerDisplayName}"`);

                  const phoneMesh = getPhoneMeshService();
                  phoneMesh.onPresenceDetected?.({
                    type: 'presence',
                    deviceIdHex: peerDeviceIdHex,
                    displayName: peerDisplayName,
                  });

                } else if (type === 0x01 && manufData.length >= 12) {
                  // Message chunk
                  const chunk = {
                    type: 'message' as const,
                    msgIdHex: manufData.slice(3, 7).map((b: number) => b.toString(16).padStart(2, '0')).join(''),
                    chunkIndex: manufData[7],
                    totalChunks: manufData[8],
                    srcIdHex: manufData.slice(9, 11).map((b: number) => b.toString(16).padStart(2, '0')).join(''),
                    hops: manufData[11] ?? 0,
                    payload: manufData.slice(12, 22),
                  };

                  // ── Android 11 self-scan guard ─────────────────────────────
                  // Android ≤11 (API 30) reports the device's own BLE
                  // advertisements back to its own scan listener. Android 12+
                  // does not. Without this check the sender would receive and
                  // relay its own message, causing the receiver to see it twice.
                  const myShort = myNodeIdRef.current.replace(/-/g, '').slice(0, 4);
                  if (myShort && chunk.srcIdHex === myShort) {
                    console.log(`[BLE] Dropping own chunk (self-scan) msg=${chunk.msgIdHex}`);
                    return;
                  }

                  // ── Early seenMids filter ──────────────────────────────────
                  // If PhoneMeshService already delivered or pre-marked this
                  // message ID (e.g. outgoing message), discard before buffering.
                  if (getPhoneMeshService().isMessageSeen(chunk.msgIdHex)) {
                    return;
                  }

                  console.log(`[BLE] Chunk ${chunk.chunkIndex + 1}/${chunk.totalChunks} from ${chunk.srcIdHex}`);
                  getPhoneMeshService().handleChunk(chunk);
                }
              }
            }

            if (isDMPresence) {
              dispatch(upsertNode({
                node_id: `phone-${peerDeviceIdHex}`,
                name: peerDisplayName || `Phone-${peerDeviceIdHex.slice(0, 4)}`,
                rssi,
                type: 'ble-phone',
                last_seen: Date.now(),
                is_connected: false,
                relay_count: 0,
              }));
            } else {
              // Check for ESP32 node (identified by device name)
              const isESP = deviceName.toLowerCase().includes('esp') ||
                            deviceName.toLowerCase().includes('lora');
              if (isESP) {
                dispatch(upsertNode({
                  node_id: deviceId,
                  name: deviceName.trim() || `ESP32-${deviceId.slice(-5).replace(':', '')}`,
                  rssi,
                  type: 'esp32-lora',
                  last_seen: Date.now(),
                  is_connected: false,
                  relay_count: 0,
                }));
              }
            }
          } catch (err) {
            console.warn('[BLE] Scan event parse error:', err);
          }
        },
      );

      // scan(null, options) — no manufacturer filter, no UUID filter.
      // Scans ALL nearby BLE devices. The fixed Java code passes null filters
      // to mScanner.startScan() which means "scan everything".
      // Only DisasterMesh devices will have manufData in the event.
      BLEAdvertiser.scan(null, {
        scanMode: 2,         // LOW_LATENCY — fastest discovery
        numberOfMatches: 3,  // MAX_ADVERTISEMENT — see all
        matchMode: 1,        // AGGRESSIVE — find quickly
      })
      .then(() => {
        console.log('[BLE] ✅ Scan started (all devices, DM filter in software)');
      })
      .catch((err: any) => {
        console.error('[BLE] Scan failed:', err);
      });

      setIsScanningState(true);
      isScanningRef.current = true;
      dispatch(setScanning(true));

    } catch (err) {
      console.error('[BLE] startScan error:', err);
    }
  }, [dispatch, setScanning, upsertNode]);

  const stopScan = useCallback(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const BLEAdvertiser = require('react-native-ble-advertiser');
      BLEAdvertiser.stopScan();
    } catch (_) {}

    if (scanListenerRef.current) {
      scanListenerRef.current.remove();
      scanListenerRef.current = null;
    }

    setIsScanningState(false);
    isScanningRef.current = false;
    dispatch(setScanning(false));
    console.log('[BLE] Scan stopped');
  }, [dispatch, setScanning]);

  // ─── GATT Connection (ESP32 nodes only) ─────────────────────────────────────

  const connectToNode = useCallback(
    async (nodeId: string): Promise<boolean> => {
      try {
        const ble = getBLEService();
        await ble.connectToDevice(nodeId, (disconnectedId: string, _error: any) => {
          dispatch(setNodeDisconnected(disconnectedId));
          const timer = setTimeout(() => {
            connectToNode(disconnectedId);
          }, 3000);
          reconnectTimers.current.set(disconnectedId, timer);
        });

        dispatch(setNodeConnected(nodeId));
        return true;
      } catch (err) {
        console.warn('[BLE] Connection failed:', err);
        return false;
      }
    },
    [dispatch, setNodeConnected, setNodeDisconnected],
  );

  const disconnectFromNode = useCallback(async (nodeId: string): Promise<void> => {
    const timer = reconnectTimers.current.get(nodeId);
    if (timer) {
      clearTimeout(timer);
      reconnectTimers.current.delete(nodeId);
    }
    await getBLEService().disconnectDevice(nodeId);
    dispatch(setNodeDisconnected(nodeId));
  }, [dispatch, setNodeDisconnected]);

  // ─── Data Transfer ──────────────────────────────────────────────────────────

  const sendToNode = useCallback(async (nodeId: string, payload: string): Promise<boolean> => {
    return getBLEService().sendMessage(nodeId, payload);
  }, []);

  const listenToNode = useCallback(
    (nodeId: string, callback: MessageReceivedCallback): (() => void) => {
      return getBLEService().listenForMessages(nodeId, callback);
    },
    [],
  );

  return {
    isReady,
    isScanning,
    permissionsGranted,
    startScan,
    stopScan,
    connectToNode,
    disconnectFromNode,
    sendToNode,
    listenToNode,
  };
}
