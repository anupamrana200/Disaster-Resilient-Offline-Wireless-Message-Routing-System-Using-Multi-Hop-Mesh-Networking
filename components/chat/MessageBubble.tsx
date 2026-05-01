/**
 * MessageBubble — renders a single chat message.
 * Own messages: right-aligned with teal gradient.
 * Others: left-aligned with dark card.
 * Shows sender name, timestamp, and delivery status icon.
 */

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Linking, Alert } from 'react-native';
import { Message } from '@/types';
import {
  isSOSPayload,
  parseSOSPayload,
  buildGeoUrl,
  formatDistance,
  haversineMeters,
  bearingLabel,
} from '@/services/sos.service';

interface Props {
  message: Message;
  isOwn: boolean;
  /**
   * Optional viewer location used to compute "X km NE of you" on incoming SOS
   * cards. When omitted, the SOS card renders without distance/bearing —
   * existing chat-bubble code paths are unchanged.
   */
  myLocation?: { lat: number; lon: number } | null;
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

function StatusLabel({ status }: { status: Message['status'] }) {
  const labels: Record<Message['status'], { text: string; color: string }> = {
    pending: { text: 'pending', color: '#888' },
    sent: { text: 'sent', color: '#60b4ff' },
    delivered: { text: 'delivered', color: '#4cd964' },
    relayed: { text: 'relayed', color: '#ff9f0a' },
    expired: { text: 'expired', color: '#ff453a' },
  };
  const label = labels[status] ?? labels.pending;
  return <Text style={[styles.statusLabel, { color: label.color }]}>· {label.text}</Text>;
}

/**
 * Branch shown only for SOS-typed messages — payload starts with "SOS|".
 * Renders a full-width red alert card with coordinates, optional distance
 * + bearing relative to the viewer, and an "Open in Map" button that fires
 * a `geo:` intent (handled by Organic Maps when installed, falls back to
 * any other map app available on the device).
 */
function SOSCard({
  message,
  isOwn,
  myLocation,
}: {
  message: Message;
  isOwn: boolean;
  myLocation?: { lat: number; lon: number } | null;
}) {
  const sos = parseSOSPayload(message.payload);
  // Defensive — if parse fails (malformed payload), fall back to plain bubble
  // so the chat is never blank for the user.
  if (!sos) {
    return (
      <View style={[styles.row, isOwn ? styles.rowOwn : styles.rowOther]}>
        <View style={[styles.bubble, isOwn ? styles.bubbleOwn : styles.bubbleOther]}>
          <Text style={[styles.payload, isOwn ? styles.payloadOwn : styles.payloadOther]}>
            {message.payload}
          </Text>
        </View>
      </View>
    );
  }

  // Compute distance + 16-wind bearing locally — no internet, no map tiles.
  const distance = myLocation
    ? haversineMeters(myLocation.lat, myLocation.lon, sos.lat, sos.lon)
    : null;
  const bearing = myLocation ? bearingLabel(myLocation.lat, myLocation.lon, sos.lat, sos.lon) : '';

  // Tapping the card opens the location in Organic Maps (or whichever map
  // app handles geo: URLs). Format mirrors the example shared by the user:
  //   geo:22.2288825,88.4495031?z=16.0&q=22.2288825,88.4495031(Sender)
  const handleOpen = async () => {
    const url = buildGeoUrl(sos.lat, sos.lon, message.source_name);
    try {
      // Linking.openURL throws if no app is registered for the geo: scheme
      await Linking.openURL(url);
    } catch (_err) {
      // Most common failure: user has no map app installed at all. Surface
      // a helpful message + the raw coordinates so they're never stranded.
      Alert.alert(
        'No map app found',
        `Coordinates: ${sos.lat.toFixed(5)}, ${sos.lon.toFixed(5)}\n\nInstall Organic Maps (free, offline) for full SOS support.`,
        [{ text: 'OK' }],
      );
    }
  };

  // Format the timestamp as a short HH:MM identical to regular bubbles.
  const time = formatTime(message.timestamp);

  return (
    // Outer row uses the same alignment rules as a normal bubble so own SOS
    // appears right-aligned and incoming SOS left-aligned.
    <View style={[styles.row, styles.sosRow]}>
      <View style={styles.sosCard}>
        {/* Header — distinguishes own (sent) vs incoming SOS */}
        <View style={styles.sosHeader}>
          <Text style={styles.sosTitle}>🆘 {isOwn ? 'SOS sent' : 'SOS — IMMEDIATE HELP'}</Text>
          <Text style={styles.sosSender}>{isOwn ? 'You' : message.source_name}</Text>
        </View>

        {/* Coordinates block — primary information for any rescuer */}
        <View style={styles.sosBody}>
          <Text style={styles.sosCoord}>
            📍 {sos.lat.toFixed(5)}°, {sos.lon.toFixed(5)}°
          </Text>
          {/* Accuracy + battery tell the rescuer how reliable the fix is and
              how much time the victim has before their phone dies. */}
          <Text style={styles.sosMeta}>
            🎯 ±{sos.accuracy} m 🔋 {sos.battery > 0 ? `${sos.battery}%` : 'unknown'}
          </Text>
          {/* Local-only haversine distance — only shown when viewer location known */}
          {distance !== null && (
            <Text style={styles.sosMeta}>
              🧭 {formatDistance(distance)} {bearing} of you
            </Text>
          )}
          {/* Footer with timestamp + relay hop count from the original Message */}
          <Text style={styles.sosTime}>
            {time}
            {message.hops > 0 ? `  ↷${message.hops}` : ''}
          </Text>
        </View>

        {/* Action — only shown to the receiver. Sender already knows where they are. */}
        {!isOwn && (
          <TouchableOpacity
            id="sos-open-map"
            style={styles.sosButton}
            onPress={handleOpen}
            activeOpacity={0.85}>
            <Text style={styles.sosButtonText}>🗺️ Open in Map</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

export default function MessageBubble({ message, isOwn, myLocation }: Props) {
  // SOS messages take a completely different visual path — branch early.
  // Existing (non-SOS) rendering below is byte-for-byte unchanged.
  if (isSOSPayload(message.payload)) {
    return <SOSCard message={message} isOwn={isOwn} myLocation={myLocation} />;
  }

  return (
    <View style={[styles.row, isOwn ? styles.rowOwn : styles.rowOther]}>
      <View style={[styles.bubble, isOwn ? styles.bubbleOwn : styles.bubbleOther]}>
        {!isOwn && (
          <View style={styles.senderRow}>
            <Text style={styles.senderName}>{message.source_name}</Text>
            {message.via === 'meshtastic' && <Text style={styles.meshTag}> (Mesh)</Text>}
          </View>
        )}
        <Text style={[styles.payload, isOwn ? styles.payloadOwn : styles.payloadOther]}>
          {message.payload}
        </Text>
        <View style={styles.footer}>
          <Text style={styles.time}>{formatTime(message.timestamp)}</Text>
          {isOwn && <StatusLabel status={message.status} />}
          {isOwn && message.via === 'meshtastic' && <Text style={styles.meshTag}>(Mesh)</Text>}
          {message.hops > 0 && <Text style={styles.hops}> ↷{message.hops}</Text>}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    marginVertical: 3,
    marginHorizontal: 12,
    flexDirection: 'row',
  },
  rowOwn: {
    justifyContent: 'flex-end',
  },
  rowOther: {
    justifyContent: 'flex-start',
  },
  bubble: {
    maxWidth: '78%',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 9,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 2,
  },
  bubbleOwn: {
    backgroundColor: '#00c896',
    borderBottomRightRadius: 4,
  },
  bubbleOther: {
    backgroundColor: '#1e2535',
    borderBottomLeftRadius: 4,
  },
  senderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 3,
  },
  senderName: {
    fontSize: 11,
    fontWeight: '700',
    color: '#60b4ff',
    fontFamily: 'OpenSans-Semibold',
  },
  meshTag: {
    fontSize: 10,
    fontWeight: '600',
    color: '#ff9f0a',
    fontFamily: 'OpenSans-Semibold',
  },
  payload: {
    fontSize: 15,
    lineHeight: 21,
    fontFamily: 'OpenSans-Regular',
  },
  payloadOwn: {
    color: '#fff',
  },
  payloadOther: {
    color: '#e8eaf0',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    gap: 4,
  },
  time: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.55)',
    fontFamily: 'OpenSans-Regular',
  },
  statusLabel: {
    fontSize: 10,
    fontFamily: 'OpenSans-Regular',
  },
  hops: {
    fontSize: 10,
    color: '#ff9f0a',
    fontFamily: 'OpenSans-Regular',
  },

  // ─── SOS card ─────────────────────────────────────────────────────────────
  // Full-width red alert card — visually distinct from chat bubbles to ensure
  // a rescuer cannot miss it while scrolling. Sits inside the same FlatList
  // so it inherits the date separators and auto-scroll behaviour.
  sosRow: {
    justifyContent: 'center', // Center the card horizontally
    marginVertical: 6,
    marginHorizontal: 10,
  },
  sosCard: {
    flex: 1,
    backgroundColor: '#2a0e0c', // Deep red background — unmistakable
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: '#ff453a',
    padding: 12,
    shadowColor: '#ff453a',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 10,
    elevation: 6,
  },
  sosHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  sosTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#ff6961',
    fontFamily: 'OpenSans-Bold',
    letterSpacing: 0.5,
  },
  sosSender: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.55)',
    fontFamily: 'OpenSans-Semibold',
  },
  sosBody: {
    gap: 4,
    marginBottom: 10,
  },
  sosCoord: {
    fontSize: 15,
    color: '#fff',
    fontFamily: 'OpenSans-Bold',
    letterSpacing: 0.3,
  },
  sosMeta: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.75)',
    fontFamily: 'OpenSans-Regular',
  },
  sosTime: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.45)',
    fontFamily: 'OpenSans-Regular',
    marginTop: 4,
  },
  sosButton: {
    backgroundColor: '#ff453a',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  sosButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
    fontFamily: 'OpenSans-Bold',
  },
});
