'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

/** Longest the bar stays without the page changing (a failed or same-page navigation). */
const MAX_MS = 15_000;

/**
 * A thin bar at the top from the tap on a link of this site until the next page is shown (owner,
 * 17 Nov 2026: buttons felt stuck on slow data, because a tab, chip or league link waits for the
 * server before anything changes). Listens in the capture phase, before the links handle the click.
 */
export function NavigationProgress() {
  const pathname = usePathname();
  const search = useSearchParams();
  const [active, setActive] = useState(false);

  useEffect(() => {
    setActive(false);
  }, [pathname, search]);

  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setActive(false), MAX_MS);
    return () => clearTimeout(timer);
  }, [active]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const anchor = event.target instanceof Element ? event.target.closest('a') : null;
      if (anchor === null || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      // The same page (a #fragment or the current URL): nothing will load.
      if (url.pathname === window.location.pathname && url.search === window.location.search) {
        return;
      }
      setActive(true);
    };
    const onPop = () => setActive(false);
    document.addEventListener('click', onClick, true);
    window.addEventListener('popstate', onPop);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', onPop);
    };
  }, []);

  return <div aria-hidden="true" className={`nav-progress ${active ? 'nav-progress-on' : ''}`} />;
}
