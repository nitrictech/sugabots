# @sugabots/desktop

The Sugabots desktop app, built with [Electron](https://www.electronjs.org/) and
[electron-vite](https://electron-vite.org/). On first launch it asks for the
address of a Sugabots server, checks that `/api/health` answers as one, saves
it, and opens that server's web app in a window. The tray menu's Change server…
asks again. Closing the window leaves the app running in the tray; launching it
again reopens the window, and the tray's Quit ends it.

For development, `SUGABOTS_URL` opens that server without asking or saving it,
for example `SUGABOTS_URL=https://sugabots.localhost`. A development build keeps
its settings in a `Sugabots Development` folder, apart from an installed copy's.

With `bun run dev` running, start it from the repository root with
`bun run dev:desktop`, or from this directory with `bun run start`. It rebuilds
on change, reloading the setup page and restarting Electron for the main
process and preload.

The `electron` package doesn't download its binary when installed, so `start`
runs its `install-electron` first, which does nothing once the binary is there.
On NixOS that binary can't find its libraries, so use nixpkgs' Electron of the
same major version:

```sh
ELECTRON_EXEC_PATH=$(nix build --no-link --print-out-paths nixpkgs#electron_45)/bin/electron \
  bun run dev:desktop
```
