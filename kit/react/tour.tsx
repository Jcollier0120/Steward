import { useEffect, useState, type ReactNode } from 'react';
import type { Onboarding, PageShell } from './page-data.ts';
import { SettingsForm } from './settings-form.tsx';
import { Button, LinkButton, Text } from './ui.tsx';

/**
 * A new hire's walkthrough of its page, at #/tour, from its onboarding (the node part's onboarding.ts): three steps.
 *   1. What the role is.
 *   2. Its few day-one settings, in the Settings form (at most three, never an advanced one), saved there and then; or,
 *      with none, that the defaults just work.
 *   3. What its page shows, part by part: each part (by its data-tour name) brought into view and outlined, with a card
 *      saying what it is.
 * Manor's hire flow opens a new employee's page at #/tour. Done, or Skip, goes back to the page; the browser remembers
 * that this agent's tour was seen (`<id>:toured`).
 */

type Step = 'intro' | 'settings' | 'tour';

/** The part of the page a tour step is about, brought into view and outlined while the step shows. */
function useSpotlight(name: string | null) {
  useEffect(() => {
    if (!name) return;
    const el = document.querySelector<HTMLElement>(`[data-tour="${CSS.escape(name)}"]`);
    if (!el) return;
    el.classList.add('tour-target');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return () => el.classList.remove('tour-target');
  }, [name]);
}

/** Back to the page, the tour remembered as seen. */
function finish(appId: string) {
  try {
    localStorage.setItem(`${appId}:toured`, '1');
  } catch {
    // Storage blocked: it's offered again next time.
  }
  location.hash = '#/';
}

/** A step's card: where it is in the walkthrough, its words, and Back, Next or Done. */
function TourCard({ docked, place, title, children, back, next, last, appId, wide }: { docked?: boolean; place: string; title: string; children: ReactNode; back?: () => void; next: () => void; last?: boolean; appId: string; wide?: boolean }) {
  return (
    <div className={['tour-card', docked ? 'tour-dock' : 'tour-center', wide && 'tour-wide'].filter(Boolean).join(' ')}>
      <Text variant="label" as="p">
        {place}
      </Text>
      <Text variant="title" as="h2">
        {title}
      </Text>
      {children}
      <div className="tour-actions">
        <LinkButton title="Skip the tour" onPress={() => finish(appId)} />
        <span className="sf-spacer" />
        {back && <Button title="Back" variant="secondary" onPress={back} />}
        <Button title={last ? 'Done' : 'Next'} onPress={next} />
      </div>
    </div>
  );
}

export function Tour({ onboarding, app, onSettingsSaved, start = 'intro' }: { onboarding: Onboarding; app: PageShell['app']; onSettingsSaved?: () => void; start?: Step }) {
  const steps: Step[] = ['intro', 'settings', ...(onboarding.tour.length ? (['tour'] as const) : [])];
  const [step, setStep] = useState<Step>(start);
  const [at, setAt] = useState(0);
  const [dirty, setDirty] = useState(false);
  const n = steps.indexOf(step);
  const place = `Step ${n + 1} of ${steps.length}`;
  const go = (d: 1 | -1) => (n + d >= steps.length ? finish(app.id) : setStep(steps[Math.max(0, n + d)]));
  const part = step === 'tour' ? onboarding.tour[at] : null;
  useSpotlight(part?.tour ?? null);
  if (step === 'intro')
    return (
      <div className="tour-backdrop">
        <TourCard place={place} title={onboarding.intro.title} next={() => go(1)} appId={app.id}>
          <Text as="p">{onboarding.intro.text}</Text>
        </TourCard>
      </div>
    );
  if (step === 'settings')
    return (
      <div className="tour-backdrop">
        <TourCard wide place={place} title="Your settings" back={() => go(-1)} next={() => (dirty ? window.alert('Save your changes first, or Cancel them.') : go(1))} last={steps.length === 2} appId={app.id}>
          <Text variant="muted" as="p">
            {onboarding.settings.length ? `Only what ${app.name} can't choose for you. Everything else has a default that works, and is in Settings.` : `${app.name} needs nothing from you to start.`}
          </Text>
          <SettingsForm keys={onboarding.settings} onDirty={setDirty} onSaved={onSettingsSaved} />
        </TourCard>
      </div>
    );
  const last = at === onboarding.tour.length - 1;
  return (
    <TourCard docked place={`${place} · ${at + 1} of ${onboarding.tour.length}`} title={part?.title ?? app.name} back={() => (at ? setAt(at - 1) : go(-1))} next={() => (last ? go(1) : setAt(at + 1))} last={last} appId={app.id}>
      <Text as="p">{part?.text}</Text>
    </TourCard>
  );
}
