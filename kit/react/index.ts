/**
 * The kit's react part: an agent's page drawn in the browser, on GamerNexus's UI kit API (apps/mobile/components/ui:
 * its names, props, variants and behaviour) in the manor's look. An agent takes it in kit.json's parts ("react", which
 * brings node and web), writes its page in src/web/main.tsx, and serves its data as /api/page; the kit's node part
 * does the rest (react-page.ts: the HTML shell, the first data in it, /page.js built with esbuild).
 *
 *   import { mount, Page, usePageData, Section, Card, Text, Badge } from '../kit/react/index.ts';
 *   function App() {
 *     const { data, reload } = usePageData<MyBody>();
 *     return (
 *       <Page data={data} reload={reload}>
 *         <Section title="Today">
 *           <Card><Text variant="muted">{data.body.words}</Text> <Badge label="new" tone="info" /></Card>
 *         </Section>
 *       </Page>
 *     );
 *   }
 *   mount(<App />);
 */
export { BUSY_LOOK_MS, initialData, pageToken, PING_LOOK_MS, post, roundState, usePageData, type PageData, type PageShell, type ShellTheme } from './page-data.ts';
export { mount, Page, ThemeMenu, useRoute, type Route } from './shell.tsx';
export { DeveloperOnly, DeveloperProvider, useDeveloper } from './developer.tsx';
export { ago, useNow } from './time.ts';
export { Icon, Spinner, type IconName } from './icons.tsx';
export { Badge, Button, Card, CardFooter, DetailRow, IconButton, LinkButton, Notes, PostButton, ReloadProvider, Section, Text, type BadgeTone, type ButtonProps, type ButtonSize, type ButtonVariant, type TextVariant } from './ui.tsx';
export { ChoiceGroup, Input, SaveStatus, Segmented, Select, Switch, type ChoiceLayout, type ChoiceOption, type ChoiceValue, type SegmentedOption, type SelectOption } from './forms.tsx';
export { EmptyNote, ErrorNote, Loading, ModalCard, QueryView, Toast, type QueryLike } from './feedback.tsx';
export { UI_CSS } from './styles.ts';
export { SettingsForm } from './settings-form.tsx';
export { settingsTabInHash, Tabs, useSettingsTab, type SettingsTab } from './tabs.tsx';
export { blank, canon, same, shownNow, tidy, words, type Messages, type SettingsData, type SettingsField } from './settings-values.ts';
export { onPage, Tour, tourFrom, tourStart } from './tour.tsx';
export { OnPageList, type OnPageItem } from './lists.tsx';
export type { Onboarding } from './page-data.ts';
