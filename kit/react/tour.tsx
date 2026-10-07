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
 *      saying what it is. Only the parts on the page when step 3 starts are walked (onPage()): a page that differs by
 *      its settings (the Herald's sections by variant) keeps one onboarding, and a variant just chosen in step 2 counts.
 * Manor's hire flow opens a new employee's page at #/tour. Done, or Skip, goes back to the page; the browser remembers
 * that this agent's tour was seen (`<id>:toured`).
 *
 * Its required settings (onboarding's `required`, the node part's required.ts) are marked in step 2, which holds until
 * they're filled in and saved: the agent does nothing without them. Skip still leaves; the page then says what it's
 * waiting for, with a link back to this step (#/tour?step=settings).
 *
 * Opened as #/tour?from=<url> (the URL encoded), its last step also offers "Back to <manor>" (the manor's name, as the
 * title bar says it, else Castellan): to that URL, which must be this PC's (tourFrom()), so the hire flow that opened
 * it gets its new employee back.
 */

type Step = 'intro' | 'settings' | 'tour';

/** The parts of a tour whose data-tour element is on the page (all of them where there's no page to look in). */
export function onPage(parts: Onboarding['tour'], doc: Pick<Document, 'querySelector'> | undefined = globalThis.document): Onboarding['tour'] {
  if (typeof doc?.querySelector !== 'function') return parts;
  return parts.filter((p) => doc.querySelector(`[data-tour="${CSS.escape(p.tour)}"]`));
}

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

/**
 * Where the tour was opened from, out of #/tour?from=<url>: an http(s) address on this PC (localhost, 127.0.0.1, [::1]
 * or a *.localhost name), or null. Nothing else is followed, so the link can't send anyone off the PC.
 */
export function tourFrom(hash: string): string | null {
  const q = hash.indexOf('?');
  if (q < 0) return null;
  const raw = new URLSearchParams(hash.slice(q + 1)).get('from');
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
    return (url.protocol === 'http:' || url.protocol === 'https:') && local ? url.href : null;
  } catch {
    return null;
  }
}

/** The tour remembered as seen; then back to the page, or to `to` (where it was opened from). */
function finish(appId: string, to?: string | null) {
  try {
    localStorage.setItem(`${appId}:toured`, '1');
  } catch {
    // Storage blocked: it's offered again next time.
  }
  if (to) location.assign(to);
  else location.hash = '#/';
}

/** What the manor is called when its settings name none: node/manor.ts' MANOR_DEFAULT_NAME, which a page can't import. */
const MANOR_DEFAULT_NAME = 'Castellan';

/** A step's card: where it is in the walkthrough, its words, and Back, Next or Done (and Back to <manor>, when it came from there). */
function TourCard({ docked, place, title, children, back, next, last, appId, wide, from, manorName }: { docked?: boolean; place: string; title: string; children: ReactNode; back?: () => void; next: () => void; last?: boolean; appId: string; wide?: boolean; from?: string | null; manorName?: string | null }) {
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
        {last && from ? (
          <>
            <Button title="Done" variant="secondary" onPress={next} />
            <Button title={`Back to ${manorName?.trim() || MANOR_DEFAULT_NAME}`} onPress={() => finish(appId, from)} />
          </>
        ) : (
          <Button title={last ? 'Done' : 'Next'} onPress={next} />
        )}
      </div>
    </div>
  );
}

/** The step #/tour?step=<name> opens at: the page's "Fill them in" opens the settings. */
export function tourStart(hash: string): Step {
  const q = hash.indexOf('?');
  const step = q < 0 ? null : new URLSearchParams(hash.slice(q + 1)).get('step');
  return step === 'settings' || step === 'tour' ? step : 'intro';
}

export function Tour({ onboarding, app, needs = null, onSettingsSaved, start = tourStart(location.hash), from = tourFrom(location.hash), manorName = null }: { onboarding: Onboarding; app: PageShell['app']; needs?: PageShell['needs']; onSettingsSaved?: () => void; start?: Step; from?: string | null; manorName?: string | null }) {
  // The parts walked in step 3: those on the page as it starts, kept while it runs (null before then: those on it now).
  const [walked, setWalked] = useState<Onboarding['tour'] | null>(null);
  const parts = walked ?? onPage(onboarding.tour);
  const steps: Step[] = ['intro', 'settings', ...(parts.length ? (['tour'] as const) : [])];
  const [step, setStep] = useState<Step>(start);
  const [at, setAt] = useState(0);
  const [dirty, setDirty] = useState(false);
  const n = steps.indexOf(step);
  const place = `Step ${n + 1} of ${steps.length}`;
  const go = (d: 1 | -1) => {
    if (n + d >= steps.length) return finish(app.id);
    const next = steps[Math.max(0, n + d)];
    if (next === 'tour') {
      const now = onPage(onboarding.tour);
      if (!now.length) return finish(app.id);
      setWalked(now);
      setAt(0);
    } else setWalked(null);
    setStep(next);
  };
  const part = step === 'tour' ? parts[at] : null;
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
        <TourCard wide place={place} title="Your settings" back={() => go(-1)} next={() => (dirty ? window.alert('Save your changes first, or Cancel them.') : needs ? window.alert(`${app.name} can't start without ${needs.text}: fill it in and Save first.`) : go(1))} last={steps.length === 2} appId={app.id} from={from} manorName={manorName}>
          <Text variant="muted" as="p">
            {onboarding.settings.length ? `Only what ${app.name} can't choose for you. Everything else has a default that works, and is in Settings.` : `${app.name} needs nothing from you to start.`}
          </Text>
          {needs && (
            <p className="tour-needs" role="status">
              <strong>Needed before it can start:</strong> {needs.text}.
            </p>
          )}
          <SettingsForm keys={onboarding.settings} onDirty={setDirty} onSaved={onSettingsSaved} />
        </TourCard>
      </div>
    );
  const last = at >= parts.length - 1;
  return (
    <TourCard docked place={`${place} · ${at + 1} of ${parts.length}`} title={part?.title ?? app.name} back={() => (at ? setAt(at - 1) : go(-1))} next={() => (last ? go(1) : setAt(at + 1))} last={last} appId={app.id} from={from} manorName={manorName}>
      <Text as="p">{part?.text}</Text>
    </TourCard>
  );
}
