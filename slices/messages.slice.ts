/**
 * messagesSlice — manages all message state for the mesh network.
 *
 * State:
 *   messages      — full message history (received + sent)
 *   pendingQueue  — messages waiting to be transmitted
 *   seenIds       — in-memory dedup cache (Set serialized as array)
 */

import { createSlice, PayloadAction, createAsyncThunk } from '@reduxjs/toolkit';
import { useDispatch, useSelector } from 'react-redux';
import { State, Dispatch } from '@/utils/store';
import { Message } from '@/types';
import {
  getMessages,
  saveMessage,
  updateMessageStatus,
  deleteExpiredMessages,
  getPendingQueue,
  enqueueMessage,
  dequeueMessage,
  getSeenIds,
  markAsSeen,
} from '@/services/storage.service';

// ─── State Shape ─────────────────────────────────────────────────────────────

export interface MessagesState {
  messages: Message[];
  pendingQueue: Message[];
  seenIds: string[];
  isLoading: boolean;
}

const initialState: MessagesState = {
  messages: [],
  pendingQueue: [],
  seenIds: [],
  isLoading: false,
};

// ─── Async Thunks ─────────────────────────────────────────────────────────────

/** Load all messages and pending queue from AsyncStorage on app start. */
export const loadMessagesAsync = createAsyncThunk(
  'messages/loadAll',
  async () => {
    const [messages, pendingQueue, seenIdsSet] = await Promise.all([
      getMessages(),
      getPendingQueue(),
      getSeenIds(),
    ]);
    return {
      messages,
      pendingQueue,
      seenIds: Array.from(seenIdsSet),
    };
  },
);

/** Add a message both to Redux state and AsyncStorage. */
export const addMessageAsync = createAsyncThunk(
  'messages/add',
  async (msg: Message) => {
    await saveMessage(msg);
    await markAsSeen(msg.message_id);
    return msg;
  },
);

/** Save a message to the pending queue (no node in range). */
export const enqueueMessageAsync = createAsyncThunk(
  'messages/enqueue',
  async (msg: Message) => {
    await enqueueMessage(msg);
    return msg;
  },
);

/** Remove a message from the pending queue after relay. */
export const dequeueMessageAsync = createAsyncThunk(
  'messages/dequeue',
  async (messageId: string) => {
    await dequeueMessage(messageId);
    return messageId;
  },
);

/** Update a message's status (sent/delivered/relayed/expired). */
export const updateStatusAsync = createAsyncThunk(
  'messages/updateStatus',
  async ({ id, status }: { id: string; status: Message['status'] }) => {
    await updateMessageStatus(id, status);
    return { id, status };
  },
);

/** Prune expired messages from storage and state. */
export const pruneExpiredAsync = createAsyncThunk(
  'messages/pruneExpired',
  async () => {
    await deleteExpiredMessages();
    const fresh = await getMessages();
    const freshPending = await getPendingQueue();
    return { messages: fresh, pendingQueue: freshPending };
  },
);

// ─── Slice ───────────────────────────────────────────────────────────────────

const slice = createSlice({
  name: 'messages',
  initialState,
  reducers: {
    /** Add a message to local state only (no storage write — use addMessageAsync for persistence). */
    addMessageLocal: (state, { payload }: PayloadAction<Message>) => {
      const exists = state.messages.some(m => m.message_id === payload.message_id);
      if (!exists) {
        state.messages.push(payload);
        state.seenIds.push(payload.message_id);
      }
    },

    /** Update message status in-memory only. */
    updateStatusLocal: (
      state,
      { payload }: PayloadAction<{ id: string; status: Message['status'] }>,
    ) => {
      const msg = state.messages.find(m => m.message_id === payload.id);
      if (msg) msg.status = payload.status;
    },

    /**
     * Tag an existing message with the transport that delivered it (in-memory
     * only). Used by the UI to render a "(Mesh)" label on Meshtastic-delivered
     * messages without requiring a storage write for what is purely a local
     * metadata hint.
     */
    updateViaLocal: (
      state,
      { payload }: PayloadAction<{ id: string; via: Message['via'] }>,
    ) => {
      const msg = state.messages.find(m => m.message_id === payload.id);
      if (msg) msg.via = payload.via;
    },

    /** Add a seen ID to the in-memory dedup cache. */
    addSeenId: (state, { payload }: PayloadAction<string>) => {
      if (!state.seenIds.includes(payload)) {
        state.seenIds.push(payload);
        // Cap in-memory cache at 2000
        if (state.seenIds.length > 2000) {
          state.seenIds = state.seenIds.slice(-2000);
        }
      }
    },

    /** Clear all messages (for testing / hard reset). */
    clearMessages: () => initialState,
  },
  extraReducers: builder => {
    // loadMessagesAsync
    builder.addCase(loadMessagesAsync.pending, state => {
      state.isLoading = true;
    });
    builder.addCase(loadMessagesAsync.fulfilled, (state, { payload }) => {
      state.isLoading = false;
      state.messages = payload.messages;
      state.pendingQueue = payload.pendingQueue;
      // Expand seenIds: for every full UUID already stored, also add its 8-char
      // short version. This ensures relay echoes are blocked by seenIdsRef even
      // after an app restart when the dedup Sets (_processedMids, seenMids) are
      // freshly empty.
      const expanded = new Set<string>(payload.seenIds);
      for (const id of payload.seenIds) {
        expanded.add(id.replace(/-/g, '').slice(0, 8).toLowerCase());
      }
      state.seenIds = Array.from(expanded);
    });
    builder.addCase(loadMessagesAsync.rejected, state => {
      state.isLoading = false;
    });

    // addMessageAsync
    builder.addCase(addMessageAsync.fulfilled, (state, { payload }) => {
      // Dedup by exact ID AND by 8-char short prefix.
      // Relay messages carry a truncated ID ("460c8400") while the original
      // sent message has a full UUID ("460c8400-e29b-..."). Without the prefix
      // check, both would pass the exact-match test and appear as duplicates.
      const shortPayload = payload.message_id.replace(/-/g, '').slice(0, 8).toLowerCase();
      const exists = state.messages.some(m => {
        if (m.message_id === payload.message_id) return true;
        return m.message_id.replace(/-/g, '').slice(0, 8).toLowerCase() === shortPayload;
      });
      if (!exists) {
        state.messages.push(payload);
        // Add both the exact ID and its 8-char short form to seenIds so that
        // relay echoes (which carry the truncated ID) are always blocked by
        // seenIdsRef.current even before a React re-render.
        if (!state.seenIds.includes(payload.message_id)) {
          state.seenIds.push(payload.message_id);
        }
        if (!state.seenIds.includes(shortPayload)) {
          state.seenIds.push(shortPayload);
        }
      }
    });

    // enqueueMessageAsync
    builder.addCase(enqueueMessageAsync.fulfilled, (state, { payload }) => {
      const alreadyQueued = state.pendingQueue.some(
        m => m.message_id === payload.message_id,
      );
      if (!alreadyQueued) state.pendingQueue.push(payload);
    });

    // dequeueMessageAsync
    builder.addCase(dequeueMessageAsync.fulfilled, (state, { payload: id }) => {
      state.pendingQueue = state.pendingQueue.filter(m => m.message_id !== id);
    });

    // updateStatusAsync
    builder.addCase(updateStatusAsync.fulfilled, (state, { payload }) => {
      const msg = state.messages.find(m => m.message_id === payload.id);
      if (msg) msg.status = payload.status;
    });

    // pruneExpiredAsync
    builder.addCase(pruneExpiredAsync.fulfilled, (state, { payload }) => {
      state.messages = payload.messages;
      state.pendingQueue = payload.pendingQueue;
    });
  },
});

export const { addMessageLocal, updateStatusLocal, updateViaLocal, addSeenId, clearMessages } = slice.actions;

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useMessagesSlice() {
  const dispatch = useDispatch<Dispatch>();
  const state = useSelector(({ messages }: State) => messages);
  return {
    dispatch,
    ...state,
    ...slice.actions,
    loadMessagesAsync,
    addMessageAsync,
    enqueueMessageAsync,
    dequeueMessageAsync,
    updateStatusAsync,
    pruneExpiredAsync,
  };
}

export default slice.reducer;
