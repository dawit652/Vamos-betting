import type { Metadata } from 'next';
import { StaticPage, StaticSection } from '@/components/account/StaticPage';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('account.pages.privacy.title') };
}

const SECTIONS = ['collect', 'use', 'share', 'keep', 'rights', 'consent'] as const;

/** What personal data Vamos keeps, why and for how long (ASVS 8.3.3; wording to confirm with counsel). */
export default async function PrivacyPage() {
  const t = await getT();
  return (
    <StaticPage title={t('account.pages.privacy.title')} intro={t('account.pages.privacy.intro')}>
      {SECTIONS.map((section, index) => (
        <StaticSection
          key={section}
          title={`${index + 1}. ${t(`account.pages.privacy.sections.${section}.title`)}`}
        >
          <p>{t(`account.pages.privacy.sections.${section}.body`)}</p>
        </StaticSection>
      ))}
    </StaticPage>
  );
}
