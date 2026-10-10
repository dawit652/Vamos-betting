import type { ReactNode } from 'react';
import { getT } from '@/i18n/server';

/**
 * Layout of the short static pages (help, terms, responsible gambling): server
 * only, no client JavaScript. Always ends with the 21+ and play-money notices.
 */
export async function StaticPage({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children: ReactNode;
}) {
  const t = await getT();
  return (
    <article className="space-y-3 px-3 pt-3">
      <header className="space-y-1">
        <h1 className="text-lg font-bold">{title}</h1>
        <p className="text-muted">{intro}</p>
      </header>
      {children}
      <aside className="card space-y-1 border-l-4 border-accent-strong text-xs font-semibold">
        <p>{t('common.rg.ageNotice')}</p>
        <p>{t('common.demo.banner')}</p>
      </aside>
    </article>
  );
}

export function StaticSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card space-y-1">
      <h2 className="font-bold">{title}</h2>
      <div className="space-y-2 leading-relaxed">{children}</div>
    </section>
  );
}
