import { useEffect, useRef, type ReactNode } from 'react';
import { Spinner } from './icons.tsx';
import { Button, Card, Text } from './ui.tsx';

/**
 * The page's states and notices, on GamerNexus's API (apps/mobile/components/ui): loading, an error with Try again,
 * an empty note, the async boundary that picks between them (QueryView), a toast, and a modal card.
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

/**
 * A card over a dimmed page: Escape or a click outside closes it (unless `dismissOnBackdrop` is false, for an editor an
 * accidental click mustn't discard), and focus moves into it, then back to where it was.
 */
export function ModalCard({ visible, onClose, children, maxHeightRatio = 0.8, className, dismissOnBackdrop = true, label }: { visible: boolean; onClose: () => void; children: ReactNode; maxHeightRatio?: number; className?: string; dismissOnBackdrop?: boolean; label?: string }) {
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!visible) return;
    const before = document.activeElement as HTMLElement | null;
    card.current?.focus();
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', keys);
    return () => {
      document.removeEventListener('keydown', keys);
      before?.focus?.();
    };
  }, [visible, onClose]);
  if (!visible) return null;
  return (
    <div className="ui-modal" onClick={dismissOnBackdrop ? onClose : undefined}>
      <div ref={card} className={className ? `ui-modal-card ${className}` : 'ui-modal-card'} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} style={{ maxHeight: `${Math.round(maxHeightRatio * 100)}vh` }} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
