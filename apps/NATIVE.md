# Where the native apps differ from the web

The native apps copy the web app's phone layout (`packages/web`, below its `md` breakpoint) screen for screen. These are the places they deliberately don't, each with its value, why, and what the web does instead. A new native app (Android next) takes the same decisions.

The numbers and strings below live in [`native-constants.json`](native-constants.json), which each app's generator turns into its own constants (`NativeConstants` in the iOS app, from `ios/scripts/generate-native-constants.ts`). Change a value there, not in an app. Everything else the apps share with the web, such as limits, catalogs and words, is generated from `@sugabots/contracts` and `packages/web/src/lib` (see [`ios/README.md`](ios/README.md)).

## Signing in starts with the workspace

- **Value:** a box for the workspace's name with `.sugabots.ai` (`hostedWorkspaceEnding`) written after it, which opens `https://[name].sugabots.ai`. "Self-hosted?" swaps it for one box taking a server's whole address, such as `sugabots.yourcompany.com`. A whole address typed or pasted into the name box is split into the name and its ending.
- **Why:** an app isn't opened at an address, so it has to ask which server to talk to before it can sign anyone in. Slack's apps ask the same way.
- **Replaces:** the web signs in on whatever server served the page, so it never asks.

## Holding a message slides its actions up from the foot

- **Value:** a sheet with a row of quick reactions, 5 of them (`quickReactionCount`): the emoji chosen lately on the device first, then 👍 ❤️ 😂 🎉 👀 (`usualReactions`), then a button for the picker. Under them, Reply, Thread and Copy as tiles. Holding brings the sheet up rather than selecting the message's text.
- **Why:** a phone has no hover, and a held press is how iOS and Slack offer what can be done with something.
- **Replaces:** the web's toolbar that appears over a message on hover, with its emoji, reply and thread buttons; text on the web can be selected.

## Reaction chips are a fingertip's size

- **Value:** 32 points tall (`reactionChipHeight`).
- **Why:** the web's chips are sized for a pointer and are hard to hit with a finger. Slack's phone chips are about this size.
- **Replaces:** the web's smaller chips.

## A conversation's header is a frosted row, after Slack's

- **Value:** Back, then one glass pill 44 points tall (`headerPillHeight`) holding the conversation's face at 32 points (`headerFaceSize`, set 6 points in from the pill's rounded end), its name, and a quieter line under it: a bot's model, or for a pod's channel how many people and bots are in it. The pill opens Details. The header sits 8 points below the Dynamic Island (`headerGapBelowIsland`) and the conversation scrolls under its frost.
- **Why:** it reads as one thing to tap, puts the name where a thumb reaches, and keeps the conversation visible to the top of the screen.
- **Replaces:** the web's header, with the face over the name in the middle and Computer and Details at the right.

## The tab bar and composer sit low and in from the sides

- **Value:** the tab bar sinks up to 12 points (`tabBarSink`) into the home indicator's band, keeping 8 points off the screen's edge. The tab bar and the composer sit 21 points (`barSideInset`) in from the screen's sides.
- **Why:** it leaves the content more room and lines the bars up with the system's own floating bars.
- **Replaces:** the web's tab bar, which sits above the safe area (or 12 pixels off the edge without one), 16 pixels in from the sides.

## The composer keeps a gap over the keyboard

- **Value:** 8 points (`keyboardGap`) between the composer and the keyboard, backed by frost so the gap isn't a dark band.
- **Why:** iOS lifts the composer with the keyboard; without a gap it sits flush against it.
- **Replaces:** the web, where the browser decides how the keyboard and the page meet.

## Routines live under a bot channel's ⋯

- **Value:** a bot's channel has a ⋯ at the right of its header with Computer and Routines. Home has no Routines row under a bot. A red dot marks both the bot's row on Home and the ⋯ while one of its routines' latest run failed.
- **Why:** the header has room for one control, and a bot's routines belong with the bot's own channel.
- **Replaces:** the web's Computer button in the header and the Routines row under each bot on Home.

## Pages open on the open tab

- **Value:** any page, such as Settings, a bot's routines, or a pod's settings, is pushed onto the tab that is open, and swiping back returns to where it was opened from.
- **Why:** an iOS tab keeps its own stack; jumping to another tab to show a page loses the person's place.
- **Replaces:** the web, where settings pages sit under You.

## Tapping the open tab returns to its first page

- **Value:** tapping the tab that is already open pops it back to its root.
- **Why:** it's what every iOS tab bar does.
- **Replaces:** nothing different in effect: each of the web's tabs is a link to its first page. An iOS tab keeps its stack, so the app pops it on purpose.

## Settings switches are the system's, in the system's green

- **Value:** the platform's own switch, at a phone's size, tinted the system's green.
- **Why:** the web's small switch is hard to hit with a finger, and the app's accent, near white in dark, hid the switch's white knob.
- **Replaces:** the web's small switch in the app's accent.

## A bot's face is lively in its Details

- **Value:** the bot's face at the top of its Details moves as the web's faces do where a bot is answering.
- **Why:** Details is where a person meets the bot on a phone, and the face is large there.
- **Replaces:** the web's still face in Details. The face's own values come with the face work on its own branch and join `native-constants.json` then.

## Holding a pod's icon brings up its notifications

- **Value:** holding a pod's icon in Home's rail opens the pod's notification menu, as holding a bot's row does.
- **Why:** a phone has no right-click; holding is how iOS offers a menu.
- **Replaces:** the web's notification menu on right-clicking a pod.

## Holding a channel offers Rename and Archive

- **Value:** holding a pod's channel on Home offers Rename and Archive, as its Details does.
- **Why:** holding is the phone's menu, and opening a channel's Details to rename it is a long way round on a phone.
- **Replaces:** the web, which offers them only in the channel's Details.

## No New workspace

- **Value:** You has no New workspace.
- **Why:** the app finds a workspace by its server when signing in, and each workspace has its own server, so the app has nowhere to make one. A new workspace is made on the web.
- **Replaces:** the web's New workspace in You.

## Not a difference: threads under a bot

A bot shows 6 of its open threads before the rest are offered, as the web does. The app reads the web's own value (`THREADS_SHOWN` in `@sugabots/contracts`), so it is listed here only because it once differed.
