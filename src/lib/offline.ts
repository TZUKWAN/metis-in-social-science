/**
 * Offline detection + graceful degradation for network-dependent features.
 *
 * Listens to navigator.onLine and provides a hook for components. When
 * offline, DOI/arXiv resolution, RSS refresh, and web search should show a
 * friendly "offline" message instead of an error.
 */

import { useEffect, useState } from 'react';

/** Current online status (reactive). */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  return online;
}

/** Human-readable offline message for a feature name. */
export function offlineMessage(feature: string, locale: string): string {
  return locale === 'zh'
    ? `${feature}需要联网，当前处于离线状态。`
    : `${feature} requires an internet connection. You are currently offline.`;
}
