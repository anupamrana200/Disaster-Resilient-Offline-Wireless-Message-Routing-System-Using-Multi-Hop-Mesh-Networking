/**
 * MockPhoneMeshService — simulates phone-to-phone BLE mesh for Expo Go.
 * Mirrors the PhoneMeshService API but uses timers instead of real BLE.
 */

import { MessagePacket } from '@/types';
import type { ParsedAdvertisement, PresenceBeacon } from './phone-mesh.service';

class MockPhoneMeshService {
  private static _instance: MockPhoneMeshService;
  private onMessageReassembled: ((raw: any) => void) | null = null;
  private onPresenceDetected: ((beacon: PresenceBeacon) => void) | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];

  static getInstance(): MockPhoneMeshService {
    if (!MockPhoneMeshService._instance) {
      MockPhoneMeshService._instance = new MockPhoneMeshService();
    }
    return MockPhoneMeshService._instance;
  }

  setMessageCallback(cb: (raw: any) => void): void {
    this.onMessageReassembled = cb;
  }

  setPresenceCallback(cb: (beacon: PresenceBeacon) => void): void {
    this.onPresenceDetected = cb;
  }

  async startPresenceBeacon(_deviceId: string, _displayName: string): Promise<boolean> {
    console.log('[MockPhoneMesh] Presence beacon simulated');
    return true;
  }

  async broadcastMessage(packet: MessagePacket): Promise<void> {
    // Simulate echo back to self after 2s (demo roundtrip)
    const t = setTimeout(() => {
      this.onMessageReassembled?.({
        mid: `echo-${packet.mid}`,
        src: 'mock-peer-phone',
        sn: 'MockPeer',
        pay: `[echo] ${packet.pay}`,
        ts: Date.now(),
        ttl: 86400,
        hops: 1,
      });
    }, 2000);
    this.timers.push(t);
  }

  async stopAdvertising(): Promise<void> {}

  parseAdvertisement(_data: string | null): ParsedAdvertisement | null {
    return null;
  }

  handleChunk(_chunk: any): void {}

  destroy(): void {
    this.timers.forEach(t => clearTimeout(t));
    this.timers = [];
  }
}

export default MockPhoneMeshService;
