/**
 * MessageBubble — renders a single chat message.
 * Own messages: right-aligned with teal gradient.
 * Others: left-aligned with dark card.
 * Shows sender name, timestamp, and delivery status icon.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Message } from '@/types';

interface Props {
  message: Message;
  isOwn: boolean;
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

export default function MessageBubble({ message, isOwn }: Props) {
  return (
    <View style={[styles.row, isOwn ? styles.rowOwn : styles.rowOther]}>
      <View style={[styles.bubble, isOwn ? styles.bubbleOwn : styles.bubbleOther]}>
        {!isOwn && (
          <Text style={styles.senderName}>{message.source_name}</Text>
        )}
        <Text style={[styles.payload, isOwn ? styles.payloadOwn : styles.payloadOther]}>
          {message.payload}
        </Text>
        <View style={styles.footer}>
          <Text style={styles.time}>{formatTime(message.timestamp)}</Text>
          {isOwn && <StatusLabel status={message.status} />}
          {message.hops > 0 && (
            <Text style={styles.hops}> ↷{message.hops}</Text>
          )}
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
  senderName: {
    fontSize: 11,
    fontWeight: '700',
    color: '#60b4ff',
    marginBottom: 3,
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
});
