# The default sandbox image: Debian with what agents reach for when they work
# on code, and desktops with a browser they drive through Playwright MCP.
# Commands run without a screen; `sugabots-desktop` starts a desktop, each on
# its own display.
#
#   bun run build:sandbox
#
# Builds ghcr.io/nitrictech/sugabots-sandbox:latest, where releases publish it
# too, and to docker.io/nitrictech/sugabots-sandbox: the image OpenSandbox
# providers use unless a workspace sets another, and the one E2B templates are
# built from. The agents' user is the provider's to
# make: OpenSandbox's when it makes a sandbox, and E2B's own `user`, uid 1000,
# so this image has none of its own to clash with them.

ARG PLAYWRIGHT_MCP_VERSION=0.0.83

# The desktop's wallpaper, rendered at the display's size, so the renderer
# doesn't ship in the image.
FROM debian:trixie-slim AS wallpaper
RUN apt-get update \
	&& apt-get install -y --no-install-recommends librsvg2-bin \
	&& rm -rf /var/lib/apt/lists/*
COPY wallpaper.svg /wallpaper.svg
RUN rsvg-convert --width 1280 --height 800 /wallpaper.svg --output /wallpaper.png

# The dock's icons, from Papirus, without the rest of its 380 MB.
FROM debian:trixie-slim AS dock-icons
RUN apt-get update \
	&& apt-get install -y --no-install-recommends papirus-icon-theme \
	&& rm -rf /var/lib/apt/lists/*
RUN mkdir /icons \
	&& cd /usr/share/icons/Papirus/64x64/apps \
	&& cp -L chromium.svg /icons/browser.svg \
	&& cp -L utilities-terminal.svg /icons/terminal.svg \
	&& cp -L system-file-manager.svg /icons/files.svg

FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8

# The tools agents use on a repository, then the desktop: a virtual display,
# a window manager and dock, a browser, a file manager, and what computer-use
# tools drive them with.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		bash ca-certificates curl wget git openssh-client less file procps \
		unzip zip xz-utils jq ripgrep fd-find tree \
		build-essential pkg-config \
		python3 python3-pip python3-venv \
		nodejs npm \
		xvfb x11vnc x11-utils openbox plank dconf-gsettings-backend dconf-cli xcompmgr xterm \
		xfonts-base dbus-x11 hsetroot \
		lxterminal pcmanfm adwaita-icon-theme librsvg2-common \
		nix-bin \
		chromium xdotool scrot xclip fonts-dejavu fonts-noto-color-emoji \
	&& ln -s /usr/bin/fdfind /usr/local/bin/fd \
	&& rm -rf /var/lib/apt/lists/*

# The browser agents drive: Playwright MCP, on Debian's Chromium rather than
# a browser Playwright downloads.
ARG PLAYWRIGHT_MCP_VERSION
RUN npm install --global --omit=dev "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
	&& npm cache clean --force

COPY --from=wallpaper /wallpaper.png /usr/share/sugabots-desktop/wallpaper.png
COPY --from=dock-icons /icons /usr/share/sugabots-desktop/icons
# The dock's launchers stand in for the apps' own, so the dock matches their
# windows to them, and its settings are the system's dconf defaults.
COPY dock/*.desktop /usr/share/applications/
COPY dock/plank/ /usr/share/sugabots-desktop/plank/
COPY dock/plank-theme/dock.theme /usr/share/plank/themes/Sugabots/dock.theme
COPY dock/plank.dconf /etc/dconf/db/local.d/00-plank
RUN mkdir -p /etc/dconf/profile \
	&& printf 'user-db:user\nsystem-db:local\n' >/etc/dconf/profile/user \
	&& dconf update
# Nix, for software beyond this image: `nix profile install nixpkgs#ffmpeg`,
# or `nix shell nixpkgs#ffmpeg` for one command. The agents' user owns the
# store, so it installs without root. `nixpkgs` follows a NixOS release and
# `nixpkgs-unstable` its newer versions, by branch, so the image never needs
# moving forward; whatever pins exact versions records the commit it used.
COPY nix/nix.conf nix/registry.json /etc/nix/
# Nix looks for its state here, and without it falls back to a store in the
# user's home that needs namespaces the agents' user can't make.
RUN mkdir -p /nix/store /nix/var/nix && chown -R 1000:1000 /nix

COPY sugabots-desktop /usr/local/bin/sugabots-desktop

RUN mkdir -p /workspace && chmod 755 /usr/local/bin/sugabots-desktop

WORKDIR /workspace
