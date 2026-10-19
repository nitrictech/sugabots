# @sugabots/desktop

The Sugabots desktop app, built with [Electrobun](https://framework.blackboard.sh/electrobun/).
On first launch it asks for the address of a Sugabots server, checks that
`/api/health` answers as one, saves it, and opens that server's web app in a
native window. The tray menu's Change server… asks again. For development,
`SUGABOTS_URL` opens that server without asking or saving it, for example
`SUGABOTS_URL=https://sugabots.localhost`.

With `bun run dev` running, start it from the repository root with
`bun run dev:desktop`, or from this directory:

```sh
bun run dev       # build, launch, and rebuild on change
bun run package   # stable build for this OS, into artifacts/
```

The `electrobun` dev dependency fetches the pinned Hutch toolchain on first
use, and `electrobun prepare` writes the Electrobun API into `.hutch/devkit`,
where `tsconfig.json` points imports of `electrobun`.

On Linux, Electrobun needs GTK 3, WebKitGTK 4.1, Ayatana AppIndicator and
librsvg installed. On NixOS, the repository's `nix develop` shell provides them
and Hutch, and needs `programs.nix-ld.enable`.
