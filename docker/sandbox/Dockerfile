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
# an Xfce session, a browser, a terminal and file manager, and what
# computer-use tools drive them with.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		bash ca-certificates curl wget git openssh-client less file procps \
		unzip zip xz-utils jq ripgrep fd-find tree \
		build-essential pkg-config \
		python3 python3-pip python3-venv \
		nodejs npm \
		tigervnc-standalone-server tigervnc-tools websockify x11-utils x11-xserver-utils xterm \
		xfce4-session xfwm4 xfce4-panel xfce4-docklike-plugin xfdesktop4 xfce4-settings \
		xfce4-terminal thunar adwaita-icon-theme librsvg2-common librsvg2-bin \
		xfonts-base dbus-x11 fonts-inter fonts-jetbrains-mono \
		nix-bin \
		chromium libnss3-tools xdotool scrot xclip fonts-dejavu fonts-noto-color-emoji \
	&& ln -s /usr/bin/fdfind /usr/local/bin/fd \
	&& rm -rf /var/lib/apt/lists/*

# The browser agents drive: Playwright MCP, on Debian's Chromium rather than
# a browser Playwright downloads.
ARG PLAYWRIGHT_MCP_VERSION
RUN npm install --global --omit=dev "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
	&& npm cache clean --force

# The desktop: an Xfce session, set up for every user by these defaults.
# The dock is a panel holding the docklike plugin, which reads its settings
# only from the user's home, where sugabots-desktop puts them. Its launchers
# stand in for the apps' own, so the dock matches their windows to them.
COPY xfce/*.xml /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/
COPY xfce/docklike.rc /usr/share/sugabots-desktop/docklike.rc
# The dock's plugin runs inside the panel rather than in a process of its
# own, whose window, embedded a pixel inside the bar, draws the bar again
# over it and dents its rounded corners.
RUN sed -i 's/^X-XFCE-Internal=false$/X-XFCE-Internal=true/' /usr/share/xfce4/panel/plugins/docklike.desktop \
	&& grep -qx 'X-XFCE-Internal=true' /usr/share/xfce4/panel/plugins/docklike.desktop
COPY --from=dock-icons /icons /usr/share/sugabots-desktop/icons
COPY dock/*.desktop /usr/share/applications/
# The look: Adwaita with the agent's colour for GTK apps and the dock, and
# the wallpaper and window frames sugabots-desktop-look draws in it.
COPY theme/ /usr/share/themes/Sugabots/
COPY sugabots-desktop-look /usr/local/bin/sugabots-desktop-look
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

COPY sugabots-desktop sugabots-browser-logins /usr/local/bin/

RUN mkdir -p /workspace && chmod 755 /usr/local/bin/sugabots-desktop /usr/local/bin/sugabots-desktop-look \
	/usr/local/bin/sugabots-browser-logins

WORKDIR /workspace
