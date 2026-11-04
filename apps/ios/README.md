# Sugabots for iOS

A native SwiftUI app for iPhone (iOS 17+) that copies the web app's phone layout (`packages/web`, below its `md` breakpoint) screen for screen: the same pages, words, sizes, colour tokens (light, dark or system, dark by default), Rubik and JetBrains Mono, and Lucide icons. It keeps iOS's own behaviour where the two differ: swipe back, sheets you drag down, the keyboard lifting the composer, and long-press menus where the web has hover toolbars.

- **Home, Inbox, Approvals and You** sit under the web's floating tab bar.
- **Conversations** (a pod's channels, bots' channels, threads, routines' threads) stream live, with tool steps, approvals, files, reactions, replies, threads under their messages, side threads in a sheet, and Details.
- **Settings**, **Routines**, **Artifacts**, **New bot**, **New thread** and the signed-out screens follow their web pages.
- A bot's **live desktop** is the web's own phone desktop page in a web view, signed in with the app's session cookie.

When the web changes, compare the page in `packages/web/src` and change its Swift copy to match. The generated files below come straight from the web's packages and the API.

## The API

The app reaches the server only through `Sugabots/API/API.generated.swift`, which is generated from `packages/contracts/openapi.json`, which is in turn generated from the API's definition in `@sugabots/contracts`. It has a Swift type for each schema the contracts export, named as they are (`podSchema` is `Pod`), and a typed request for each route, grouped as the web's client groups them: `api.threads.get(...)` on the web is `client.threads.get(threadId:)` here. After the API changes:

```sh
bun run --cwd packages/contracts generate
node apps/ios/scripts/generate.ts
```

The contracts' and the app's tests fail until both have been run, and the app then fails to build wherever it relied on what changed. That is how a change to the API reaches this app: as compile errors, not as a decoding failure in someone's hands.

What it decodes stays open to a newer server: an enum or a union decodes a value it doesn't know as `unknown`, and fields it doesn't know are ignored. A field that may be left out of a request and may also be sent as null to clear it is a double optional (`String??`): `nil` leaves it out, `.some(nil)` sends null.

Add what the app needs on top of these types (labels, `Identifiable`, derived values) as extensions in `API/Models.swift` and its neighbours, never by editing the generated file.

## Rules copied from the web

Some of the web's rules are written again in Swift: how a tool step is named (`Conversation/ToolNames.swift`), how names are listed (`Conversation/Names.swift`), how times are written (`Conversation/Times.swift`), and how a routine's schedule is worded (`Routines/ScheduleWords.swift`). Their cases are in `packages/web/src/lib/*.cases.json`, which the web's `shared-cases.test.ts` runs against the web's rules and `scripts/check-rules.sh` runs against the Swift ones, so a rule changed on one side and not the other fails one of them. The script builds those files into a Mac program with `RuleChecks/main.swift`, so each must import only Foundation. To copy another rule, add its cases to a case file and the rule to both runners.

## Run it

Open `Sugabots.xcodeproj` in Xcode and run the `Sugabots` scheme on an iPhone simulator. The app has no package dependencies.

Sign-in asks for the workspace first, as Slack does: its name, which opens `https://[name].sugabots.ai`, or a name and another ending for a self-hosted server, such as `sugabots` + `.yourcompany.com`. The app talks to `/api` under that address. It signs in with better-auth's bearer plugin and keeps the token in the Keychain. Debug builds suggest `sugabots` + `.local`, that is `https://sugabots.local`, which Portless serves on your network in LAN mode.

better-auth only accepts a sign-in whose `Origin` is in the server's trusted origins (`PUBLIC_URL`, `WEB_APP_URL`). The app sends the workspace address's origin, so sign in at the same address the web app uses. For a local server, the simulator also has to trust Portless's certificate:

```sh
xcrun simctl keychain booted add-root-cert ~/.portless/ca.pem
```

## Layout

| Folder | What it holds |
| --- | --- |
| `Sugabots/API` | The generated types and requests, what the app adds to them, the HTTP client, the event stream, the Keychain token |
| `Sugabots/App` | Entry point, routes, `Session` (server and sign-in), `WorkspaceStore` and its extensions (what each area loads and changes) |
| `Sugabots/Home` | Home: the pod rail and the pod's conversation list, with its sheets |
| `Sugabots/Conversation` | A conversation: live model, header, messages, tool steps, approvals, files, composer, Details, side threads, the computer |
| `Sugabots/Attention` | Inbox, Approvals and You |
| `Sugabots/Settings`, `Routines`, `Artifacts`, `NewBot`, `SignIn` | Those pages, each as the web has it |
| `Sugabots/Emoji` | The emoji picker and shortcodes, over `Resources/Emoji.json` |
| `Sugabots/Design` | The web's colour tokens and type, Lucide icons, its controls as a phone draws them (`WebControls.swift`), bot faces, logos |
| `Sugabots/Fonts` | Rubik (TTF) and JetBrains Mono (the web's own woff2), under the SIL Open Font License (`OFL-*.txt`) |

Debug builds can sign in and open a page at launch, for screenshots: set `SUGABOTS_SERVER`, `SUGABOTS_EMAIL` and `SUGABOTS_PASSWORD`, and `SUGABOTS_OPEN` (see `App/DebugLaunch.swift` and the `DebugOpen` files), with `SIMCTL_CHILD_` before each when launching with `xcrun simctl launch`.

These files are generated, each by its script in `scripts/`, from the web's packages and the API. `node apps/ios/scripts/generate.ts` from the repo root regenerates all of them, and the `ios` tests fail while any is out of date:

| Script | Writes | From |
| --- | --- | --- |
| `generate-api.ts` | `API/API.generated.swift`, and Android's `apps/android/api` client | `packages/contracts/openapi.json`, read by `api/model.ts` and written by `api/swift.ts` and `api/kotlin.ts` |
| `generate-palette.ts` | `Design/Palette.generated.swift` | the colour tokens on `:root` in `packages/web/src/app.css` |
| `generate-built-in-tools.ts` | `Conversation/BuiltInTools.generated.swift` | `builtInToolCatalog` in `@sugabots/contracts` |
| `generate-limits.ts` | `API/Limits.generated.swift` | the limits in `@sugabots/contracts`, including the screens' own in `client-limits.ts` |
| `generate-catalogs.ts` | `API/Catalogs.generated.swift` | the search and computer provider catalogs, role labels and webhook prefixes in `@sugabots/contracts`; the web's words and lists in `packages/web/src/lib` (`notification-choices.ts`, `model-makers.ts`, `tool-access-words.ts`, `routine-trigger-words.ts`, `artifact-kind-files.ts`, `provider-hues.ts`) |
| `generate-artifact-pages.ts` | `Artifacts/ArtifactPages.generated.swift` | `artifact-pages.ts` in `@sugabots/contracts`, `lib/page-frame.ts`, and `app.css`'s colours |

The web modules these read are plain data, imported by the web's components and by the scripts, which Node runs as they are: they import nothing but types, so no React and no `@/` paths. Each script builds its data apart from the Swift it writes, so another app's copy can be written from the same data.
| `generate-bot-looks.ts` | `Design/BotLooks.generated.swift` | `@sugabots/avatars`, the pod palette |
| `generate-lucide-icons.ts` | `Design/Lucide.generated.swift` | every icon `packages/web` imports from `lucide-react` |
| `generate-connection-marks.ts` | `Design/ConnectionMarks.generated.swift` | `ui/connection-mark.tsx` |
| `generate-provider-logos.ts` | `Assets.xcassets/ProviderLogos`, `Design/ProviderLogos.generated.swift` | `@sugabots/provider-logos`, contracts |
| `generate-emoji.ts` | `Resources/Emoji.json` | `@sugabots/emoji` |

The project file lists its sources. When you add a Swift file, add it in Xcode so it joins the target.
