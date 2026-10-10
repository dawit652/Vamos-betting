'use client';

import { useSyncExternalStore } from 'react';
import {
  parseStoredPlacement,
  PLACEMENT_STORAGE_KEY,
  serializePlacement,
  type PendingPlacement,
} from './placement';

/**
 * Where the pending placement lives: module state (outlives the drawer, which
 * unmounts when closed) mirrored to sessionStorage (outlives a reload or a
 * discarded tab). Only the drawer imports this, so it stays out of the bundle
 * every page loads.
 */

let current: PendingPlacement | null | undefined; // undefined: not read from storage yet
const listeners = new Set<() => void>();

function read(): PendingPlacement | null {
  if (current === undefined) {
    try {
      current = parseStoredPlacement(window.sessionStorage.getItem(PLACEMENT_STORAGE_KEY));
    } catch {
      current = null; // storage disabled
    }
  }
  return current;
}

export function getPlacement(): PendingPlacement | null {
  return typeof window === 'undefined' ? null : read();
}

/** Saves synchronously (before the request goes out) or clears the pending placement. */
export function setPlacement(next: PendingPlacement | null): void {
  current = next;
  try {
    if (next === null) window.sessionStorage.removeItem(PLACEMENT_STORAGE_KEY);
    else window.sessionStorage.setItem(PLACEMENT_STORAGE_KEY, serializePlacement(next));
  } catch {
    // storage disabled: the key still lives in memory for this page view
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePendingPlacement(): PendingPlacement | null {
  return useSyncExternalStore(subscribe, getPlacement, () => null);
}
