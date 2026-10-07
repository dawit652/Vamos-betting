import { MESSAGES } from '@vamos/i18n';

export default function HomePage() {
  const am = MESSAGES.am;
  const en = MESSAGES.en;
  return (
    <main className="shell">
      <p className="demo-banner" role="status">
        {am.demo.banner} · {en.demo.banner}
      </p>
      <h1>{en.app.name}</h1>
      <p>{am.app.tagline}</p>
      <p className="muted">{am.rg.ageNotice}</p>
    </main>
  );
}
