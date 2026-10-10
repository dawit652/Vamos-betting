import type { Metadata } from 'next';
import Link from 'next/link';
import { accountPaths } from '@/components/account/paths';
import { StaticPage, StaticSection } from '@/components/account/StaticPage';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('account.pages.rg.title') };
}

const SECTIONS = ['age', 'playMoney', 'tips', 'signs', 'tools', 'help'] as const;

export default async function ResponsibleGamblingPage() {
  const t = await getT();
  return (
    <StaticPage title={t('account.pages.rg.title')} intro={t('account.pages.rg.intro')}>
      {SECTIONS.map((section) => (
        <StaticSection key={section} title={t(`account.pages.rg.sections.${section}.title`)}>
          <p>{t(`account.pages.rg.sections.${section}.body`)}</p>
          {section === 'tools' ? (
            <div className="flex flex-wrap gap-2 pt-1">
              <Link href={accountPaths.limits} prefetch={false} className="btn btn-primary">
                {t('account.pages.rg.limitsLink')}
              </Link>
              <Link href={accountPaths.selfExclusion} prefetch={false} className="btn btn-outline">
                {t('account.pages.rg.exclusionLink')}
              </Link>
            </div>
          ) : null}
        </StaticSection>
      ))}
    </StaticPage>
  );
}
