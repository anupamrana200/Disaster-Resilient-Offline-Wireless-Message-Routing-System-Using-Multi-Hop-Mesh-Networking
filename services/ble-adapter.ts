/**
 * BLEAdapter — auto-selects real or mock BLE based on runtime environment.
 *
 * In Expo Go (StoreClient):  → MockBLEService (no native modules)
 * In custom dev build:       → BLEService    (real react-native-ble-plx)
 *
 * This is the ONLY file that conditionally imports BLE libs.
 * All hooks use getBLEService() — never import ble.service.ts directly.
 */

import Constants, { ExecutionEnvironment } from 'expo-constants';

// True when running inside Expo Go
export const IS_EXPO_GO =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

// Lazy singleton
let _instance: any = null;

export function getBLEService(): any {
  if (_instance) return _instance;

  if (IS_EXPO_GO) {
    console.log('[BLEAdapter] Expo Go detected → MockBLEService');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const MockBLEService = require('./mock-ble.service').default;
    _instance = MockBLEService.getInstance();
  } else {
    console.log('[BLEAdapter] Custom build detected → BLEService');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BLEService = require('./ble.service').default;
    _instance = BLEService.getInstance();
  }

  return _instance;
}
