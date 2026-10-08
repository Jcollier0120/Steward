import { createContext, useContext, type ReactNode } from 'react';

/**
 * The manor's Developer options on a React page (kit 2.39.0; the rule is spec/DEVELOPER-OPTIONS.md). The server says
 * it in the page's data (react-page.ts's PageShell `developer`, read afresh for every page and /api/page), and <Page>
 * hands it down; a flip in Manor shows within seconds (usePageData looks again when /api/ping says it changed).
 *
 * Hiding here is the second half: what a non-developer may not see must first be left out of what the server sends
 * (the node part's developer.ts: developerOnly, withoutDeveloper, failureFor). A page only hides what it was sent.
 *
 *   const dev = useDeveloper();
 *   <DeveloperOnly fallback={<Text>It couldn't finish; it tries again at the next round.</Text>}>
 *     <pre>{data.body.log}</pre>
 *   </DeveloperOnly>
 */
const DeveloperContext = createContext(false);

/** Hands the switch down: <Page> does, from its data. Off outside one. */
export function DeveloperProvider({ on, children }: { on: boolean; children: ReactNode }) {
  return <DeveloperContext.Provider value={on}>{children}</DeveloperContext.Provider>;
}

/** Whether the page may show developer content now: off unless the server said on. */
export const useDeveloper = () => useContext(DeveloperContext);

/** Its children only while Developer options are on; `fallback` (plain words, or nothing) otherwise. */
export function DeveloperOnly({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  return <>{useDeveloper() ? children : fallback}</>;
}
