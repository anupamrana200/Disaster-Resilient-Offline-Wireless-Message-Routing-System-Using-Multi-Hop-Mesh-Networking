/**
 * Settings Screen — device identity, TTL config, and storage management.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  Animated,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useNodeId } from '@/hooks/useNodeId';
import { useNodesSlice } from '@/slices/nodes.slice';
import { useMessagesSlice } from '@/slices/messages.slice';
import { clearAllMeshData, clearChatMessages } from '@/services/storage.service';

const TTL_OPTIONS = [
  { label: '5 Min', value: 300 },
  { label: '10 Min', value: 600 },
  { label: '30 Min', value: 1800 },
  { label: '1 Hour', value: 3600 },
  { label: '6 Hours', value: 21600 },
  { label: '12 Hours', value: 43200 },
  { label: '24 Hours', value: 86400 },
];

type ToastType = 'success' | 'error' | 'info';

interface Toast {
  message: string;
  type: ToastType;
}

export default function SettingsScreen() {
  const { deviceId, displayName, updateDisplayName } = useNodeId();
  const { dispatch: nodesDispatch, defaultTtl, setDefaultTtl } = useNodesSlice();
  const { dispatch: msgsDispatch, messages, pendingQueue, clearMessages } = useMessagesSlice();

  const [nameInput, setNameInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmClearChat, setConfirmClearChat] = useState(false);
  const [customTtlValue, setCustomTtlValue] = useState('');
  const [customTtlUnit, setCustomTtlUnit] = useState<'minutes' | 'hours'>('minutes');

  const toastOpacity = useRef(new Animated.Value(0)).current;
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One-time sync: populate name field when identity loads from storage.
  // Using a ref so this only fires once even if displayName changes after a save.
  const initialized = useRef(false);
  useEffect(() => {
    if (displayName && !initialized.current) {
      initialized.current = true;
      setNameInput(displayName);
    }
  }, [displayName]);

  const showToast = useCallback((message: string, type: ToastType = 'success') => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, type });
    toastOpacity.setValue(0);
    Animated.timing(toastOpacity, {
      toValue: 1,
      duration: 200,
      useNativeDriver: true,
    }).start();
    toastTimer.current = setTimeout(() => {
      Animated.timing(toastOpacity, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }).start(() => setToast(null));
    }, 2500);
  }, [toastOpacity]);

  const handleSaveName = async () => {
    if (!nameInput.trim()) return;
    setIsSaving(true);
    await updateDisplayName(nameInput.trim());
    setIsSaving(false);
    showToast('Display name saved', 'success');
  };

  const handleClearData = async () => {
    await clearAllMeshData();
    msgsDispatch(clearMessages());
    setConfirmClear(false);
    showToast('All mesh data cleared', 'info');
  };

  const handleClearChat = async () => {
    await clearChatMessages();       // wipe AsyncStorage first
    msgsDispatch(clearMessages());   // then clear Redux so UI updates immediately
    setConfirmClearChat(false);
    showToast('Chat history cleared', 'info');
  };

  const handleSetCustomTtl = () => {
    const num = parseInt(customTtlValue, 10);
    if (!num || num <= 0) {
      showToast('Please enter a positive number', 'error');
      return;
    }
    const seconds = customTtlUnit === 'hours' ? num * 3600 : num * 60;
    nodesDispatch(setDefaultTtl(seconds));
    setCustomTtlValue('');
    showToast(`TTL set to ${num} ${customTtlUnit}`, 'success');
  };

  const toastColors: Record<ToastType, string> = {
    success: '#00c896',
    error: '#ff453a',
    info: '#60b4ff',
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* Toast — rendered at the SafeAreaView root so it sits above the
          LinearGradient and ScrollView on Android (zIndex is stacking-context
          scoped; placing it here guarantees it is never occluded). */}
      {toast && (
        <Animated.View
          style={[
            styles.toast,
            { backgroundColor: toastColors[toast.type] + '30', borderColor: toastColors[toast.type], opacity: toastOpacity },
          ]}
        >
          <View style={[styles.toastDot, { backgroundColor: toastColors[toast.type] }]} />
          <Text style={[styles.toastText, { color: toastColors[toast.type] }]}>{toast.message}</Text>
        </Animated.View>
      )}

      <LinearGradient colors={['#0a0e1a', '#0d1117']} style={styles.container}>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>Settings</Text>
            <Text style={styles.subtitle}>Configure your mesh identity</Text>
          </View>

          {/* Identity Section */}
          <Section title="Your Identity">
            <InfoRow label="Device ID" value={deviceId} mono />
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Display Name</Text>
              <View style={styles.inputRow}>
                <TextInput
                  id="settings-name-input"
                  style={styles.input}
                  value={nameInput}
                  onChangeText={setNameInput}
                  placeholder="Enter your name"
                  placeholderTextColor="rgba(255,255,255,0.3)"
                  maxLength={32}
                  selectionColor="#00c896"
                />
                <TouchableOpacity
                  id="settings-save-name"
                  style={[styles.saveButton, isSaving && styles.saveButtonDisabled]}
                  onPress={handleSaveName}
                  disabled={isSaving}
                >
                  <Text style={styles.saveButtonText}>{isSaving ? '...' : 'Save'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </Section>

          {/* TTL Section */}
          <Section title="Message Lifetime (TTL)">
            <Text style={styles.sectionDesc}>
              How long messages are kept alive in the mesh before expiring.
            </Text>
            <View style={styles.ttlGrid}>
              {TTL_OPTIONS.map(opt => (
                <TouchableOpacity
                  key={opt.value}
                  id={`settings-ttl-${opt.value}`}
                  style={[
                    styles.ttlButton,
                    defaultTtl === opt.value && styles.ttlButtonActive,
                  ]}
                  onPress={() => nodesDispatch(setDefaultTtl(opt.value))}
                >
                  <Text
                    style={[
                      styles.ttlLabel,
                      defaultTtl === opt.value && styles.ttlLabelActive,
                    ]}
                  >
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Custom TTL */}
            <View style={styles.customTtlRow}>
              <TextInput
                id="settings-custom-ttl-input"
                style={styles.customTtlInput}
                value={customTtlValue}
                onChangeText={(text) => setCustomTtlValue(text.replace(/[^0-9]/g, ''))}
                placeholder="Custom"
                placeholderTextColor="rgba(255,255,255,0.3)"
                keyboardType="number-pad"
                maxLength={4}
                selectionColor="#00c896"
              />
              <View style={styles.unitToggle}>
                <TouchableOpacity
                  style={[styles.unitButton, customTtlUnit === 'minutes' && styles.unitButtonActive]}
                  onPress={() => setCustomTtlUnit('minutes')}
                >
                  <Text style={[styles.unitText, customTtlUnit === 'minutes' && styles.unitTextActive]}>Min</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.unitButton, customTtlUnit === 'hours' && styles.unitButtonActive]}
                  onPress={() => setCustomTtlUnit('hours')}
                >
                  <Text style={[styles.unitText, customTtlUnit === 'hours' && styles.unitTextActive]}>Hr</Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity
                style={styles.setButton}
                onPress={handleSetCustomTtl}
              >
                <Text style={styles.setButtonText}>Set</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.currentTtl}>
              Current: {defaultTtl >= 3600
                ? `${Math.round(defaultTtl / 3600)} hour${Math.round(defaultTtl / 3600) > 1 ? 's' : ''}`
                : `${Math.round(defaultTtl / 60)} minute${Math.round(defaultTtl / 60) > 1 ? 's' : ''}`}
            </Text>
          </Section>

          {/* Stats Section */}
          <Section title="Storage">
            <InfoRow label="Total Messages" value={String(messages.length)} />
            <InfoRow label="Pending Queue" value={String(pendingQueue.length)} />
          </Section>

          {/* Danger Zone */}
          <Section title="Danger Zone">
            {/* Clear Chat History */}
            {confirmClearChat ? (
              <View style={styles.confirmCard}>
                <Text style={styles.confirmTitle}>Clear chat history?</Text>
                <Text style={styles.confirmDesc}>
                  Removes all messages from the chat screen. Peer and node data is kept.
                </Text>
                <View style={styles.confirmButtons}>
                  <TouchableOpacity
                    style={styles.confirmCancel}
                    onPress={() => setConfirmClearChat(false)}
                  >
                    <Text style={styles.confirmCancelText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.confirmDelete}
                    onPress={handleClearChat}
                  >
                    <Text style={styles.confirmDeleteText}>Clear</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <TouchableOpacity
                id="settings-clear-chat"
                style={styles.dangerButton}
                onPress={() => setConfirmClearChat(true)}
                activeOpacity={0.8}
              >
                <Text style={styles.dangerButtonText}>Clear Chat History</Text>
              </TouchableOpacity>
            )}

            {/* Clear All Mesh Data */}
            {confirmClear ? (
              <View style={styles.confirmCard}>
                <Text style={styles.confirmTitle}>Delete all messages?</Text>
                <Text style={styles.confirmDesc}>
                  This will permanently remove all messages and peer history.
                </Text>
                <View style={styles.confirmButtons}>
                  <TouchableOpacity
                    style={styles.confirmCancel}
                    onPress={() => setConfirmClear(false)}
                  >
                    <Text style={styles.confirmCancelText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.confirmDelete}
                    onPress={handleClearData}
                  >
                    <Text style={styles.confirmDeleteText}>Delete</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <TouchableOpacity
                id="settings-clear-data"
                style={styles.dangerButton}
                onPress={() => setConfirmClear(true)}
                activeOpacity={0.8}
              >
                <Text style={styles.dangerButtonText}>Clear All Mesh Data</Text>
              </TouchableOpacity>
            )}
          </Section>

          {/* App Info */}
          <View style={styles.footer}>
            <Text style={styles.footerText}>
              DisasterMesh v1.0 · Offline-first · No internet required
            </Text>
          </View>
        </ScrollView>
      </LinearGradient>
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionCard}>{children}</View>
    </View>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text
        style={[styles.infoValue, mono && styles.infoValueMono]}
        numberOfLines={1}
        ellipsizeMode="middle"
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0a0e1a' },
  container: { flex: 1 },
  scroll: { paddingBottom: 40 },

  // ─── Toast ────────────────────────────────────────────────────────────────
  // Not absolute — flows naturally at the top of SafeAreaView above the
  // LinearGradient so it's never occluded by the scroll content on Android.
  toast: {
    marginHorizontal: 16,
    marginTop: 10,
    marginBottom: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  toastDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  toastText: {
    fontSize: 14,
    fontFamily: 'OpenSans-Semibold',
    flex: 1,
  },

  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  title: { fontSize: 26, fontWeight: '800', color: '#f0f2f5', fontFamily: 'OpenSans-Bold' },
  subtitle: { fontSize: 13, color: 'rgba(255,255,255,0.45)', fontFamily: 'OpenSans-Regular', marginTop: 2 },

  section: { marginTop: 20, paddingHorizontal: 16 },
  sectionTitle: {
    fontSize: 12,
    color: '#60b4ff',
    fontFamily: 'OpenSans-Bold',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  sectionDesc: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.45)',
    fontFamily: 'OpenSans-Regular',
    marginBottom: 12,
  },
  sectionCard: {
    backgroundColor: '#1a2133',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    gap: 12,
  },

  field: { gap: 8 },
  fieldLabel: { fontSize: 12, color: 'rgba(255,255,255,0.5)', fontFamily: 'OpenSans-Semibold' },
  inputRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  input: {
    flex: 1,
    backgroundColor: '#0d1117',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#f0f2f5',
    fontSize: 15,
    fontFamily: 'OpenSans-Regular',
    borderWidth: 1,
    borderColor: 'rgba(0,200,150,0.2)',
  },
  saveButton: {
    backgroundColor: '#00c896',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  saveButtonDisabled: { opacity: 0.5 },
  saveButtonText: { color: '#fff', fontWeight: '700', fontFamily: 'OpenSans-Bold', fontSize: 14 },

  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  infoLabel: { fontSize: 14, color: 'rgba(255,255,255,0.6)', fontFamily: 'OpenSans-Regular' },
  infoValue: { fontSize: 14, color: '#f0f2f5', fontFamily: 'OpenSans-Semibold', maxWidth: '60%' },
  infoValueMono: { fontFamily: 'OpenSans-Regular', color: '#60b4ff', fontSize: 12 },

  ttlGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  ttlButton: {
    backgroundColor: '#0d1117',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  ttlButtonActive: { backgroundColor: '#00c89622', borderColor: '#00c896' },
  ttlLabel: { color: 'rgba(255,255,255,0.6)', fontSize: 13, fontFamily: 'OpenSans-Semibold' },
  ttlLabelActive: { color: '#00c896' },

  customTtlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
  },
  customTtlInput: {
    flex: 1,
    backgroundColor: '#0d1117',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    color: '#f0f2f5',
    fontSize: 15,
    fontFamily: 'OpenSans-Regular',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    textAlign: 'center',
  },
  unitToggle: {
    flexDirection: 'row',
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  unitButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#0d1117',
  },
  unitButtonActive: {
    backgroundColor: '#00c89633',
  },
  unitText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'OpenSans-Bold',
  },
  unitTextActive: { color: '#00c896' },
  setButton: {
    backgroundColor: '#00c896',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  setButtonText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
    fontFamily: 'OpenSans-Bold',
  },
  currentTtl: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.4)',
    fontFamily: 'OpenSans-Regular',
    marginTop: 8,
    textAlign: 'center',
  },

  // ─── Danger Zone ──────────────────────────────────────────────────────────
  dangerButton: {
    backgroundColor: '#ff453a22',
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ff453a',
  },
  dangerButtonText: { color: '#ff453a', fontWeight: '700', fontSize: 14, fontFamily: 'OpenSans-Bold' },

  // ─── Inline Confirm Card ──────────────────────────────────────────────────
  confirmCard: {
    backgroundColor: '#ff453a11',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#ff453a55',
    gap: 8,
  },
  confirmTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#ff453a',
    fontFamily: 'OpenSans-Bold',
  },
  confirmDesc: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.5)',
    fontFamily: 'OpenSans-Regular',
    lineHeight: 18,
  },
  confirmButtons: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  confirmCancel: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 10,
    padding: 10,
    alignItems: 'center',
  },
  confirmCancelText: {
    color: 'rgba(255,255,255,0.7)',
    fontWeight: '600',
    fontSize: 14,
    fontFamily: 'OpenSans-Semibold',
  },
  confirmDelete: {
    flex: 1,
    backgroundColor: '#ff453a',
    borderRadius: 10,
    padding: 10,
    alignItems: 'center',
  },
  confirmDeleteText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
    fontFamily: 'OpenSans-Bold',
  },

  footer: { marginTop: 32, alignItems: 'center', paddingHorizontal: 20 },
  footerText: { fontSize: 12, color: 'rgba(255,255,255,0.25)', fontFamily: 'OpenSans-Regular', textAlign: 'center' },
});
