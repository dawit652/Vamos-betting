'use client';

import { useEffect } from 'react';

/**
 * Registers /sw.js in production builds (static assets only; see public/sw.js).
 * In development it removes any worker left from a production run, so stale
 * cached bundles never shadow hot reloads.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    if (process.env.NODE_ENV !== 'production') {
      void navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => Promise.all(registrations.map((r) => r.unregister())));
      return;
    }
    const register = () => {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/', updateViaCache: 'none' })
        .catch((error: unknown) => console.warn('service worker registration failed', error));
    };
    // After the page has loaded and gone idle, so it never competes with the first paint.
    const whenIdle = () =>
      'requestIdleCallback' in window
        ? window.requestIdleCallback(register, { timeout: 5_000 })
        : setTimeout(register, 2_000); // Safari has no requestIdleCallback
    if (document.readyState === 'complete') whenIdle();
    else window.addEventListener('load', whenIdle, { once: true });
  }, []);
  return null;
}
