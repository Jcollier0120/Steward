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
 *
 * Busy and asking: a Button whose onPress returns a promise spins until it settles, BusyButton does the same for a
 * button of the page's own classes, and BusyArea disables the part of the page the work changes. confirmDialog and
 * alertDialog are the page's own confirm() and alert(): never the browser's.
 *
 * The whole page waits on an action (kit 2.144.0, page-busy.ts; spec/PAGE-ACTIONS.md): while one runs, every control on
 * the page is disabled, with the busy cursor and aria-busy, and the button pressed spins; a dialog the action opens is
 * usable. An action button is therefore one of these, never a bare <button onClick> with a fetch of its own:
 *
 *   <PostButton title="Run now" path="/api/run" />                              a POST, then the page looks for news
 *   <Button title="Save" onPress={() => save()} />                               onPress returns the work's promise
 *   <BusyButton className="mine" onClick={() => save()}>Save</BusyButton>         the same, in the page's own classes
 *
 * where the work POSTs with post(): a post() a press started holds the page by itself, and spins the button pressed,
 * even from a plain <button>. Long work holds the page only until its request answers (Run now, a job started): its
 * progress is the page's to show. Work that can't go through post() (a stream) holds it with holdPage() until it answers.
 */
export { BUSY_LOOK_MS, freshToken, initialData, pageToken, PING_LOOK_MS, post, roundState, useOutOfDate, usePageData, type PageData, type PageShell, type ShellTheme } from './page-data.ts';
export { mount, Page, ThemeMenu, useRoute, type Route } from './shell.tsx';
export { DeveloperOnly, DeveloperProvider, useDeveloper } from './developer.tsx';
export { ago, useNow } from './time.ts';
export { Icon, Spinner, type IconName } from './icons.tsx';
export { Badge, Button, Card, CardFooter, DetailRow, IconButton, LinkButton, Notes, PostButton, ReloadProvider, Section, Text, type BadgeTone, type ButtonProps, type ButtonSize, type ButtonVariant, type TextVariant } from './ui.tsx';
export { ChoiceGroup, Input, SaveStatus, Segmented, Select, Switch, type ChoiceLayout, type ChoiceOption, type ChoiceValue, type SegmentedOption, type SelectOption } from './forms.tsx';
export { EmptyNote, ErrorNote, Loading, QueryView, Toast, type QueryLike } from './feedback.tsx';
export { alertDialog, confirmDialog, DialogHost, dialogsOpen, ModalCard, nextStop, type DialogOptions } from './modal.tsx';
export { BusyArea, BusyButton, PageArea, useTracked, type BusyButtonProps } from './busy.tsx';
export { holdPage, openDialog, PAGE_WAIT_MS, pageHeld, pageWait } from './page-busy.ts';
export { UI_CSS } from './styles.ts';
export { SettingsForm } from './settings-form.tsx';
export { pageTabInHash, PageTabs, settingsTabInHash, SHOW_TAB, Tabs, usePageTab, useSettingsTab, type PageTab, type SettingsTab } from './tabs.tsx';
export { blank, canon, same, shownNow, tidy, words, type Messages, type SettingsData, type SettingsField } from './settings-values.ts';
export { onPage, Tour, tourFrom, tourStart } from './tour.tsx';
export { OnPageList, type OnPageItem } from './lists.tsx';
export { ConnectAI, Glance, Kept, NeedsYou, Output, Paste, Row, showSection, SidePanel, StaffLayout, useFold, type ClientSetup, type ConnectedClient, type GlanceTile, type GlanceTone, type KeptRow, type KeptStat, type Need } from './staff.tsx';
export type { Onboarding } from './page-data.ts';
