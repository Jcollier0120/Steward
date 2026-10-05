/**
 * The kit's react part (kit 2.21.0): an agent's page drawn in the browser. An agent takes it in kit.json's parts
 * ("react", which brings "web"), writes its page in src/web/main.tsx, and serves its data as /api/page; the kit's
 * node part does the rest (react-page.ts: the HTML shell, the first data in it, /page.js built with esbuild).
 *
 *   import { mount, Page, usePageData, Card, Muted } from '../kit/react/index.ts';
 *   function App() {
 *     const { data, reload } = usePageData<MyBody>();
 *     return <Page data={data} reload={reload}><Card><Muted>{data.body.words}</Muted></Card></Page>;
 *   }
 *   mount(<App />);
 */
export { BUSY_LOOK_MS, initialData, pageToken, post, usePageData, type PageData, type PageShell, type ShellTheme } from './page-data.ts';
export { mount, Page, ThemeMenu } from './shell.tsx';
export { ago, useNow } from './time.ts';
export { Badge, Card, Muted, Notes, PostButton, ReloadProvider } from './ui.tsx';
