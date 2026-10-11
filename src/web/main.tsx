import { mount, Page, usePageData } from '../kit/react/index.ts';
import { RunNow, StewardAbout, StewardBody } from './steward.tsx';
import type { StewardView } from './types.ts';

/** The Steward's page, drawn in the browser: its body in the kit's frame, Run now and About in the title bar. */
function App() {
  const { data, reload } = usePageData<StewardView>();
  return (
    <Page data={data} reload={reload} action={<RunNow v={data.body} />} about={<StewardAbout v={data.body} />}>
      <StewardBody v={data.body} />
    </Page>
  );
}

mount(<App />);
