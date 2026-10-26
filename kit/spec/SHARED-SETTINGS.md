# The staff's shared settings: set once, in Manor

Since kit 2.140.0, the settings several agents share are set in one place while Manor is installed: Manor's Settings, **Staff settings** (`#/settings/staff`). An agent's own Settings leaves them out and says so in a line, with the way there, as Repositories are kept in Manor (spec/REPOSITORIES.md). Without Manor, an agent shows and keeps them as before.

## Which settings

The fields come from `node/shared-settings.ts`, one factory and one read function each. Each field's `inManor` says how Manor keeps it.

| Key | Field | Read with | `inManor` | Kept in |
|---|---|---|---|---|
| `roundEvery` | `roundEveryField` | `readRoundEvery`, `roundEveryMs` | `own` | the agent's own settings.json |
| `modelCallsPerRound` | `modelCallsField` | `readModelCalls` | `own` | the agent's own settings.json |
| `plainNotes` | `plainNotesField` | `readPlainNotes` | `shared` | Manor's settings.json, `"shared"` |
| `semanticRerank` | `semanticRerankField` | `readSemanticRerank` | `shared` | Manor's settings.json, `"shared"` |
| `preset` (video quality) | `videoQualityField` | `readVideoQuality` | `shared` | Manor's settings.json, `"shared"` |
| `keepVideoTags` | `keepVideoTagsField` | `readKeepVideoTags` | `shared` | Manor's settings.json, `"shared"` |

- **`own`:** each agent's own value. Its bounds, default and label are the agent's ("Look every", 5 to 60 minutes). Manor's Settings lists them by employee, beside its name, and saves them through the agent.
- **`shared`:** one value for the whole staff. Manor keeps it as `"shared": { "plainNotes": false, … }` in its settings.json. An agent's read function takes Manor's value first, whenever Manor says one it can use (a switch true or false, a quality the list has). It falls back to the agent's own value while Manor doesn't say: an older Manor, or a setting never saved there. Read afresh through the file cache, so a change in Manor applies at once.

A field an agent builds by hand has no `inManor`, so it stays on the agent's own page. Build these settings from the factories, and read them with the read functions, so they move to Manor.

Manor's Staff settings draws the `shared` ones from `manorSharedFields()`, with `MANOR_SHARED_DEFAULTS` while neither Manor nor an agent says a value (kit 2.141.0), so a shared setting the kit adds shows there too.

## The API

`/api/settings` serves a form by where it's asked from (`settings-kit.ts`' `FormPlace`, from `formPlace(query)`):

- **The agent's own page,** with Manor installed (`sharedSettingsManor()`): the schema leaves out every field with `inManor`, and the reply says which, as `inManor: { manor, url, labels }`. The form says them in a line, linking to Manor's Staff settings, and onboarding's few settings never do. A save that names one is refused, and the refusal says where it's set.
- **Manor's Settings,** asking with `?manor=1` (signed in with the agent's token, as Run now is): GET returns only the fields with `inManor`, so Manor sees the agent's own values and which manor-wide settings it uses. POST saves only the `own` ones. A `shared` one is Manor's to keep, and the agent refuses it, as it does any other setting.
- **Without Manor:** every field, as before.

Under node --test no Manor is read unless a test says where (`manorShared(key, home)`, the read functions' `home`, or a `FormPlace` of its own).

## The form

`SettingsForm` takes `api` for where it's read and saved, `/api/settings` unless said. Manor draws each employee's own settings with it, from Manor's own address for them.

A list of more than two short words is drawn in columns rather than one a line: no path, and none longer than 24 characters (a Pinder's runtimes, a Shepherd's apps).
