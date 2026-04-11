/**
 * useNodeId — generates and persists a stable UUID for this device.
 *
 * On first launch: creates a new UUID, saves it with a display name.
 * On subsequent launches: loads the saved identity from AsyncStorage.
 * Populates Redux nodes state (myNodeId, myDisplayName, defaultTtl).
 */

import { useEffect, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { getLocalDevice, saveLocalDevice } from '@/services/storage.service';
import { useNodesSlice } from '@/slices';
import type { LocalDevice } from '@/types';

interface UseNodeIdResult {
  deviceId: string;
  displayName: string;
  isReady: boolean;
  updateDisplayName: (name: string) => Promise<void>;
}

export function useNodeId(): UseNodeIdResult {
  const [isReady, setReady] = useState(false);
  const { dispatch, myNodeId, myDisplayName, setMyNodeId, setMyDisplayName, defaultTtl } =
    useNodesSlice();

  useEffect(() => {
    (async () => {
      try {
        let device = await getLocalDevice();
        if (!device) {
          // First launch — generate stable identity
          device = {
            device_id: uuidv4(),
            display_name: 'Anonymous',
            default_ttl: 86400,
          };
          await saveLocalDevice(device);
        }
        dispatch(setMyNodeId(device.device_id));
        dispatch(setMyDisplayName(device.display_name));
      } catch (err) {
        console.warn('[useNodeId] Failed to load device identity:', err);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const updateDisplayName = async (name: string) => {
    dispatch(setMyDisplayName(name));
    const device = await getLocalDevice();
    if (device) {
      await saveLocalDevice({ ...device, display_name: name });
    }
  };

  return {
    deviceId: myNodeId,
    displayName: myDisplayName,
    isReady,
    updateDisplayName,
  };
}
