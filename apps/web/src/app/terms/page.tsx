import type { Metadata } from 'next';
import { StaticPage, StaticSection } from '@/components/account/StaticPage';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('account.pages.terms.title') };
}

const SECTIONS = ['demo', 'age', 'account', 'bets', 'rg', 'changes'] as const;

export default async function TermsPage() {
  const t = await getT();
  return (
    <StaticPage title={t('account.pages.terms.title')} intro={t('account.pages.terms.intro')}>
      {SECTIONS.map((section, index) => (
        <StaticSection
          key={section}
          title={`${index + 1}. ${t(`account.pages.terms.sections.${section}.title`)}`}
        >
          <p>{t(`account.pages.terms.sections.${section}.body`)}</p>
        </StaticSection>
      ))}
    </StaticPage>
  );
}
