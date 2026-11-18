# @sugabots/desktop

The Sugabots desktop app, built with [Electron](https://www.electronjs.org/) and
[electron-vite](https://electron-vite.org/). On first launch it asks for the
address of a Sugabots server, checks that `/api/health` answers as one, saves
it, and opens that server's web app in a window.

The Workspace menu, in the window and the tray, lists the workspaces on every
server added with Add server…, under the account each is signed in as, and opens
any of them, with Ctrl/⌘+1 to 9 for the first nine. A server with no workspace,
such as one signed out, is listed as itself. With only one place to go, the
menu lists none. Each server keeps its own session, so switching back finds you
still signed in. Add another account… saves the open server again with a new
session, for being signed in to two accounts on one server at once. Removing
one deletes its session. When a server can't be reached, the window says so and
offers to try again or switch.

Closing the window leaves the app running in the tray; launching it again
reopens the window, and the tray's Quit ends it.

For development, `SUGABOTS_URL` opens that server without asking or saving it,
for example `SUGABOTS_URL=https://sugabots.localhost`. A development build keeps
its servers and sessions in a `Sugabots Development` folder, apart from an
installed copy's.

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
