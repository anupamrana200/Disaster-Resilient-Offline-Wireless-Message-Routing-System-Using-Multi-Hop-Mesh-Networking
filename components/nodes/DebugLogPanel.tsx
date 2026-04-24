/**
 * DebugLogPanel — collapsible in-app log viewer.
 *
 * Mounted inside the Nodes screen so you can watch BLE / Meshtastic / Mesh
 * events in real time on the device. Newest entries at the top. Tapping the
 * header toggles the panel open/closed so it doesn't steal screen real-estate
 * when not needed.
 */

import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Clipboard } from 'react-native';
import { dlog, DebugLogEntry } from '@/services/debug-log.service';

function formatTime(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const s = d.getSeconds().toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function colorForLevel(level: DebugLogEntry['level']): string {
  if (level === 'error') return '#ff453a';
  if (level === 'warn')  return '#ff9f0a';
  return '#00c896';
}

export default function DebugLogPanel() {
  const [entries, setEntries] = useState<DebugLogEntry[]>([]);
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    return dlog.subscribe(setEntries);
  }, []);

  const reversed = [...entries].reverse();

  const handleCopy = () => {
    const text = [...entries]
      .reverse()
      .map(e => `${formatTime(e.ts)} [${e.tag}] ${e.message}`)
      .join('\n');
    Clipboard.setString(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={styles.header}
        onPress={() => setOpen(o => !o)}
        activeOpacity={0.7}
      >
        <Text style={styles.headerText}>
          🪲 Debug Log ({entries.length})
        </Text>
        <View style={styles.headerActions}>
          <TouchableOpacity
            onPress={(e) => { e.stopPropagation?.(); handleCopy(); }}
            style={styles.copyBtn}
          >
            <Text style={styles.copyText}>{copied ? '✓ Copied' : 'Copy'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={(e) => { e.stopPropagation?.(); dlog.clear(); }}
            style={styles.clearBtn}
          >
            <Text style={styles.clearText}>Clear</Text>
          </TouchableOpacity>
          <Text style={styles.chevron}>{open ? '▼' : '▶'}</Text>
        </View>
      </TouchableOpacity>

      {open && (
        <ScrollView
          style={styles.body}
          contentContainerStyle={styles.bodyContent}
          nestedScrollEnabled
        >
          {reversed.length === 0 ? (
            <Text style={styles.emptyText}>No log entries yet — try sending a message.</Text>
          ) : (
            reversed.map(e => (
              <View key={e.id} style={styles.row}>
                <Text style={styles.time}>{formatTime(e.ts)}</Text>
                <Text style={[styles.tag, { color: colorForLevel(e.level) }]}>
                  {e.tag}
                </Text>
                <Text style={styles.message}>{e.message}</Text>
              </View>
            ))
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 8,
    backgroundColor: '#0b0f1a',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#141b2d',
  },
  headerText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#f0f2f5',
    fontFamily: 'OpenSans-Semibold',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  copyBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: 'rgba(0,200,150,0.15)',
    borderRadius: 6,
  },
  copyText: {
    fontSize: 10,
    color: '#00c896',
    fontFamily: 'OpenSans-Semibold',
    fontWeight: '700',
  },
  clearBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: 'rgba(255,69,58,0.18)',
    borderRadius: 6,
  },
  clearText: {
    fontSize: 10,
    color: '#ff6a60',
    fontFamily: 'OpenSans-Semibold',
    fontWeight: '700',
  },
  chevron: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 12,
  },
  body: {
    maxHeight: 260,
  },
  bodyContent: {
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 3,
    gap: 6,
  },
  time: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.35)',
    fontFamily: 'OpenSans-Regular',
    width: 58,
  },
  tag: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'OpenSans-Semibold',
    width: 76,
  },
  message: {
    flex: 1,
    fontSize: 11,
    color: '#e8eaf0',
    fontFamily: 'OpenSans-Regular',
  },
  emptyText: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.35)',
    textAlign: 'center',
    padding: 12,
    fontFamily: 'OpenSans-Regular',
  },
});
