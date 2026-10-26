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
		tigervnc-standalone-server tigervnc-tools websockify x11-utils x11-xserver-utils \
		xfwm4 xfce4-panel xfce4-docklike-plugin picom xterm \
		xfonts-base dbus-x11 hsetroot fonts-inter fonts-jetbrains-mono \
		lxterminal nautilus adwaita-icon-theme librsvg2-common librsvg2-bin \
		nix-bin \
		chromium libnss3-tools xdotool scrot xclip fonts-dejavu fonts-noto-color-emoji \
	&& ln -s /usr/bin/fdfind /usr/local/bin/fd \
	&& rm -rf /var/lib/apt/lists/*

# The browser agents drive: Playwright MCP, on Debian's Chromium rather than
# a browser Playwright downloads.
ARG PLAYWRIGHT_MCP_VERSION
RUN npm install --global --omit=dev "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
	&& npm cache clean --force

# The wallpaper of a desktop Sugabots gives none, rendered at the display's
# size. `sugabots-desktop` renders the ones it is given the same way.
COPY wallpaper.svg /usr/share/sugabots-desktop/wallpaper.svg
RUN rsvg-convert --width 1280 --height 800 /usr/share/sugabots-desktop/wallpaper.svg \
	--output /usr/share/sugabots-desktop/wallpaper.png
# The dock: an Xfce panel holding the docklike plugin. Its launchers stand
# in for the apps' own, so the dock matches their windows to them. The
# plugin reads its settings only from the user's home, where sugabots-desktop
# puts them.
COPY --from=dock-icons /icons /usr/share/sugabots-desktop/icons
COPY dock/*.desktop /usr/share/applications/
COPY dock/xfce4-panel.xml /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml
COPY dock/docklike.rc /usr/share/sugabots-desktop/docklike.rc
# The desktop's look, light unless a desktop is started dark: the GTK
# themes of the apps and of the dock, xfwm4's frames, drawn by
# sugabots-window-theme with each theme's own edge round the focused window
# until a desktop is given an accent, the terminal's colours, and the
# compositor's shadows.
COPY themes/ /usr/share/themes/
COPY sugabots-window-theme /usr/local/bin/sugabots-window-theme
RUN sugabots-window-theme light /usr/share/themes/Sugabots \
	&& sugabots-window-theme dark /usr/share/themes/Sugabots-Dark
COPY xfwm4/xfwm4.xml /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml
COPY picom.conf /usr/share/sugabots-desktop/picom.conf
# GTK reads its system settings from /etc/gtk-3.0; it ignores /etc/xdg here.
COPY gtk/settings.ini /etc/gtk-3.0/settings.ini
COPY lxterminal/lxterminal.conf /usr/share/lxterminal/lxterminal.conf
COPY lxterminal/dark/lxterminal.conf /usr/share/sugabots-desktop/dark/lxterminal/lxterminal.conf
# Nautilus's look, a GTK 4 app's, which reads none of GTK 3's. Without the
# file indexer it depends on, which Nautilus would otherwise start to index
# the sandbox in the background, its search reads folders as it goes.
RUN rm /usr/share/dbus-1/services/org.freedesktop.LocalSearch3*.service \
	/usr/share/dbus-1/services/org.freedesktop.Tracker3.Miner.Files*.service \
	/usr/share/dbus-1/services/org.freedesktop.Tracker3.Writeback.service
COPY gtk4/settings.ini /etc/gtk-4.0/settings.ini
COPY gtk4/*.css /usr/share/sugabots-desktop/gtk-4.0/
# Nix, for software beyond this image: `nix profile install nixpkgs#ffmpeg`,
# or `nix shell nixpkgs#ffmpeg` for one command. The agents' user owns the
# store, so it installs without root. `nixpkgs` follows a NixOS release and
# `nixpkgs-unstable` its newer versions, by branch, so the image never needs
# moving forward; whatever pins exact versions records the commit it used.
COPY nix/nix.conf nix/registry.json /etc/nix/
# Nix looks for its state here, and without it falls back to a store in the
# user's home that needs namespaces the agents' user can't make.
RUN mkdir -p /nix/store /nix/var/nix && chown -R 1000:1000 /nix

# Chromium's managed policy, root's so agents can't change it. No page from
# outside the sandbox may reach the sandbox itself or its network, such as
# Playwright MCP, which has no password, and Chromium doesn't ask. And the
# browser connects as the rest of the sandbox does, so its egress rules,
# which allow hosts by the name a TLS connection gives, let it through: over
# TCP rather than QUIC, and without Encrypted Client Hello, which hides that
# name behind the CDN's own (Cloudflare's cloudflare-ech.com).
COPY chromium/policies.json /etc/chromium/policies/managed/sugabots.json

COPY sugabots-desktop /usr/local/bin/sugabots-desktop

RUN mkdir -p /workspace && chmod 755 /usr/local/bin/sugabots-desktop

WORKDIR /workspace
