import { useEffect, type ReactNode } from 'react';
import { Spinner } from './icons.tsx';
import { Button, Card, Text } from './ui.tsx';

/**
 * The page's states and notices, on GamerNexus's API (apps/mobile/components/ui): loading, an error with Try again,
 * an empty note, the async boundary that picks between them (QueryView), and a toast. The modal card is modal.tsx's.
 */

/** A centred spinner, while something loads. */
export function Loading() {
  return (
    <div className="ui-loading">
      <Spinner size={20} label="Loading" />
    </div>
  );
}

/** What went wrong, and Try again when there is a way back. */
export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Card className="ui-error-note">
      <Text variant="label" as="p">
        Something went wrong
      </Text>
      <Text as="p">{message}</Text>
      {onRetry && <Button title="Try again" variant="secondary" size="sm" icon="refresh" onPress={onRetry} />}
    </Card>
  );
}

/** A quiet line where a list has nothing in it. */
export function EmptyNote({ message }: { message: string }) {
  return (
    <Text variant="muted" as="p" className="ui-empty-note">
      {message}
    </Text>
  );
}

/** What QueryView reads of a query: GamerNexus's React Query subset, which a page's own fetch can fill in too. */
export interface QueryLike<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  error: { message: string } | null;
  refetch?: () => unknown;
  /** "paused" while the fetch waits for this PC to be back online. */
  fetchStatus?: string;
}

const OFFLINE_UNLOADED = "This PC is offline. This loads when it's back online.";

/**
 * The async boundary: the data as soon as there is any (so a refetch never flashes a spinner), else the error with
 * Try again, else the offline note, else loading, else the empty note.
 */
export function QueryView<T>({ query, children, emptyMessage, loading }: { query: QueryLike<T>; children: (data: NonNullable<T>) => ReactNode; emptyMessage?: string; loading?: ReactNode }) {
  if (query.data != null) return <>{children(query.data as NonNullable<T>)}</>;
  if (query.isError) {
    const { refetch } = query;
    return <ErrorNote message={query.error?.message ?? 'Something went wrong.'} onRetry={refetch ? () => void refetch() : undefined} />;
  }
  if (query.fetchStatus === 'paused') return <EmptyNote message={OFFLINE_UNLOADED} />;
  if (query.isLoading) return <>{loading ?? <Loading />}</>;
  return emptyMessage ? <EmptyNote message={emptyMessage} /> : <>{loading ?? <Loading />}</>;
}

/** A brief message at the bottom of the window that hides itself after `duration`; null shows nothing. */
export function Toast({ message, onHide, duration = 2600 }: { message: string | null; onHide: () => void; duration?: number }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onHide, duration);
    return () => clearTimeout(t);
  }, [message, duration, onHide]);
  if (!message) return null;
  return (
    <div className="ui-toast" role="status">
      <span>{message}</span>
    </div>
  );
}

/** The modal card is modal.tsx's, beside the page's own confirm and alert dialogs; it is said here too, as it was. */
export { ModalCard } from './modal.tsx';
