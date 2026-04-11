/**
 * nodesSlice — manages nearby BLE mesh node discovery state.
 *
 * State:
 *   nearbyNodes      — all nodes seen during the current scan session
 *   connectedNodeIds — IDs of nodes with active BLE GATT connections
 *   isScanning       — whether BLE scan is active
 *   myNodeId         — this device's own stable UUID
 *   myDisplayName    — user-chosen display name
 *   defaultTtl       — default TTL (seconds) for outgoing messages
 */

import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { useDispatch, useSelector } from 'react-redux';
import { State, Dispatch } from '@/utils/store';
import { MeshNode } from '@/types';

// ─── State Shape ─────────────────────────────────────────────────────────────

export interface NodesState {
  nearbyNodes: MeshNode[];
  connectedNodeIds: string[];
  isScanning: boolean;
  myNodeId: string;
  myDisplayName: string;
  defaultTtl: number;
}

const initialState: NodesState = {
  nearbyNodes: [],
  connectedNodeIds: [],
  isScanning: false,
  myNodeId: '',
  myDisplayName: 'Anonymous',
  defaultTtl: 86400, // 24 hours
};

// ─── Slice ───────────────────────────────────────────────────────────────────

const slice = createSlice({
  name: 'nodes',
  initialState,
  reducers: {
    /** Replace the entire nearby node list (from a fresh scan result). */
    setNearbyNodes: (state, { payload }: PayloadAction<MeshNode[]>) => {
      state.nearbyNodes = payload;
    },

    /**
     * Upsert a single node (add if new, update if already in list).
     * Called on each BLE advertisement event during scanning.
     */
    upsertNode: (state, { payload }: PayloadAction<MeshNode>) => {
      const index = state.nearbyNodes.findIndex(n => n.node_id === payload.node_id);
      if (index >= 0) {
        state.nearbyNodes[index] = payload;
      } else {
        state.nearbyNodes.push(payload);
      }
    },

    /** Mark a node as connected (GATT connection established). */
    setNodeConnected: (state, { payload: nodeId }: PayloadAction<string>) => {
      if (!state.connectedNodeIds.includes(nodeId)) {
        state.connectedNodeIds.push(nodeId);
      }
      const node = state.nearbyNodes.find(n => n.node_id === nodeId);
      if (node) node.is_connected = true;
    },

    /** Mark a node as disconnected. */
    setNodeDisconnected: (state, { payload: nodeId }: PayloadAction<string>) => {
      state.connectedNodeIds = state.connectedNodeIds.filter(id => id !== nodeId);
      const node = state.nearbyNodes.find(n => n.node_id === nodeId);
      if (node) node.is_connected = false;
    },

    /** Increment relay count for a specific node. */
    incrementRelayCount: (state, { payload: nodeId }: PayloadAction<string>) => {
      const node = state.nearbyNodes.find(n => n.node_id === nodeId);
      if (node) node.relay_count += 1;
    },

    /** Remove nodes not seen in the last N milliseconds (stale cleanup). */
    pruneStaleNodes: (state, { payload: maxAgeMs }: PayloadAction<number>) => {
      const cutoff = Date.now() - maxAgeMs;
      state.nearbyNodes = state.nearbyNodes.filter(n => n.last_seen > cutoff);
    },

    /** Toggle the BLE scanning indicator. */
    setScanning: (state, { payload }: PayloadAction<boolean>) => {
      state.isScanning = payload;
    },

    /** Set this device's stable node ID (loaded from storage on first launch). */
    setMyNodeId: (state, { payload }: PayloadAction<string>) => {
      state.myNodeId = payload;
    },

    /** Update user's display name. */
    setMyDisplayName: (state, { payload }: PayloadAction<string>) => {
      state.myDisplayName = payload;
    },

    /** Update default TTL for outgoing messages. */
    setDefaultTtl: (state, { payload }: PayloadAction<number>) => {
      state.defaultTtl = payload;
    },

    /** Clear all node state. */
    resetNodes: () => initialState,
  },
});

export const {
  setNearbyNodes,
  upsertNode,
  setNodeConnected,
  setNodeDisconnected,
  incrementRelayCount,
  pruneStaleNodes,
  setScanning,
  setMyNodeId,
  setMyDisplayName,
  setDefaultTtl,
  resetNodes,
} = slice.actions;

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useNodesSlice() {
  const dispatch = useDispatch<Dispatch>();
  const state = useSelector(({ nodes }: State) => nodes);
  return { dispatch, ...state, ...slice.actions };
}

export default slice.reducer;
