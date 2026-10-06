import type { ReactNode } from 'react';
import { EmptyNote } from './feedback.tsx';
import { Card, PostButton, Section, Text } from './ui.tsx';

/** One entry of an OnPageList. */
export interface OnPageItem {
  /** What Remove sends to say which one (also React's key). */
  id: string;
  /** Its name, as the page shows it. */
  label: ReactNode;
  /** A muted line under it: why it's there, since when. */
  detail?: ReactNode;
}

/**
 * A list a person keeps with buttons on the page, not in Settings: what they trusted, ignored or put off, each added by
 * a button where it came up ("Trust this", "Never file these") and taken off here with Remove. The list belongs on the
 * page because a person finds an entry where its effect shows, and a setting would have them type what a button knows.
 *
 * Remove posts `{ [field]: id }` to `remove` (default field "id") through the page's PostButton, which reloads the page
 * when it's done. `confirm` asks first ("Stop trusting {label}?" style, said once for every entry). `tour` names it for
 * the page's tour.
 */
export function OnPageList({ title, items, remove, field = 'id', noun = 'entry', empty, help, confirm, tour }: { title: string; items: OnPageItem[]; remove: string; field?: string; noun?: string; empty: string; help?: ReactNode; confirm?: string; tour?: string }) {
  return (
    <Section title={title} count={items.length} tour={tour}>
      {help && (
        <Text variant="muted" as="p">
          {help}
        </Text>
      )}
      {items.length ? (
        <Card className="ui-onpage-list">
          <ul>
            {items.map((it, i) => (
              <li key={it.id}>
                <div className="ui-onpage-what">
                  <span>{it.label}</span>
                  {it.detail && (
                    <Text variant="muted" as="div">
                      {it.detail}
                    </Text>
                  )}
                </div>
                <PostButton title="Remove" variant="secondary" size="sm" path={remove} body={{ [field]: it.id }} confirm={confirm} accessibilityLabel={`Remove ${noun} ${i + 1}`} />
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <EmptyNote message={empty} />
      )}
    </Section>
  );
}
