/**
 * DebugLogService — in-app rolling log buffer for field diagnostics.
 *
 * Purpose: mirror console.log output into a memory buffer so developers can
 * read recent BLE / Meshtastic / Mesh events directly on the device without
 * needing a USB cable + adb logcat. Subscribers (UI panels) are notified
 * whenever a new entry is pushed, and the buffer is capped so it never grows
 * without bound.
 *
 * Usage:
 *   import { dlog } from '@/services/debug-log.service';
 *   dlog.info('Mesh', 'Meshtastic send ok');
 *   dlog.subscribe(entries => setEntries(entries));
 */

export type DebugLogLevel = 'info' | 'warn' | 'error';

export interface DebugLogEntry {
  id: number;
  ts: number;
  level: DebugLogLevel;
  tag: string;
  message: string;
}

class DebugLogService {
  private buffer: DebugLogEntry[] = [];
  private listeners = new Set<(entries: DebugLogEntry[]) => void>();
  private nextId = 1;
  private readonly MAX_ENTRIES = 500;

  private push(level: DebugLogLevel, tag: string, message: string): void {
    const entry: DebugLogEntry = {
      id: this.nextId++,
      ts: Date.now(),
      level,
      tag,
      message,
    };
    this.buffer.push(entry);
    if (this.buffer.length > this.MAX_ENTRIES) {
      this.buffer.splice(0, this.buffer.length - this.MAX_ENTRIES);
    }
    for (const l of this.listeners) l(this.buffer.slice());

    // Mirror to console so adb logcat still sees everything
    const line = `[${tag}] ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  info(tag: string, message: string): void { this.push('info', tag, message); }
  warn(tag: string, message: string): void { this.push('warn', tag, message); }
  error(tag: string, message: string): void { this.push('error', tag, message); }

  getAll(): DebugLogEntry[] {
    return this.buffer.slice();
  }

  clear(): void {
    this.buffer = [];
    for (const l of this.listeners) l([]);
  }

  subscribe(listener: (entries: DebugLogEntry[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.buffer.slice());
    return () => { this.listeners.delete(listener); };
  }
}

export const dlog = new DebugLogService();
export default dlog;
