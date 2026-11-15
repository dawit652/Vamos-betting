import Link from 'next/link';
import { getT } from '@/i18n/server';
import { routes } from '@/lib/routes';

export default async function NotFound() {
  const t = await getT();
  return (
    <section className="card mx-auto my-3 max-w-md space-y-3 text-center">
      <p className="font-semibold">{t('common.errors.notFound')}</p>
      <Link href={routes.home} className="btn btn-primary">
        {t('common.nav.home')}
      </Link>
    </section>
  );
}
