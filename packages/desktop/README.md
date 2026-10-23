# @sugabots/desktop

The Sugabots desktop app, built with [Electrobun](https://framework.blackboard.sh/electrobun/).
On first launch it asks for the address of a Sugabots server, checks that
`/api/health` answers as one, saves it, and opens that server's web app in a
native window. The tray menu's Change server… asks again. For development,
`SUGABOTS_URL` opens that server without asking or saving it, for example
`SUGABOTS_URL=https://sugabots.localhost`.

The tray's Pair this computer… pairs the app with the server so bots can
stand for agents running here. The app makes a device token, asks the server
for a pairing code (sending only the token's SHA-256), and opens the web app's
approval page. It then keeps a WebSocket open to `/api/devices/link`
(`src/bun/device-link.ts`).

The app tells the server which agent programs it found (Claude Code, as
`claude` on the PATH) and which agents it lends; the web app shows them under
the person's computers. Lending is asked for there, and decided here: the app
asks natively, and the person chooses the folder. The app hosts each lent
agent's A2A server itself (`src/bun/hosted-agents/`), at an address under
`.invalid` that nothing else can reach, and answers the requests the server
sends down the link with it. Each message is a Claude Code run in that folder,
as the person, resuming the conversation's session; a tool their Claude Code
settings don't already allow is asked about in a native prompt, every time.

With `bun run dev` running, start it from the repository root with
`bun run dev:desktop`, or from this directory:

```sh
bun run start     # build, launch, and rebuild on change
bun run package   # stable build for this OS, into artifacts/
```

The `electrobun` dev dependency fetches the pinned Hutch toolchain on first
use, and `electrobun prepare` writes the Electrobun API into `.hutch/devkit`,
where `tsconfig.json` points imports of `electrobun`.

On Linux, Electrobun needs GTK 3, WebKitGTK 4.1, Ayatana AppIndicator and
librsvg installed. On NixOS, the repository's `nix develop` shell provides them
and Hutch, and needs `programs.nix-ld.enable`.
