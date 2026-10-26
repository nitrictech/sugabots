# The default sandbox image: Debian with what agents reach for when they work
# on code, and the apps of the desktops Sugabots' web app draws around them,
# each on a display of its own: a browser agents drive through Playwright
# MCP, and any app an agent starts. Commands run without a
# screen; `sugabots-desktop start` gives one a display.
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

FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8

# The tools agents use on a repository, then the desktop's apps: virtual
# displays and a window manager to keep each app filling its own, a browser,
# and what computer-use tools drive them with.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		bash ca-certificates curl wget git openssh-client less file procps \
		unzip zip xz-utils jq ripgrep fd-find tree \
		build-essential pkg-config \
		python3 python3-pip python3-venv \
		nodejs npm \
		tigervnc-standalone-server tigervnc-tools websockify x11-utils openbox xterm \
		xfonts-base dbus-x11 \
		adwaita-icon-theme librsvg2-common \
		nix-bin \
		chromium libnss3-tools xdotool wmctrl xsettingsd scrot xclip fonts-dejavu fonts-noto-color-emoji \
	&& ln -s /usr/bin/fdfind /usr/local/bin/fd \
	&& rm -rf /var/lib/apt/lists/*

# The browser agents drive: Playwright MCP, on Debian's Chromium rather than
# a browser Playwright downloads.
ARG PLAYWRIGHT_MCP_VERSION
RUN npm install --global --omit=dev "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
	&& npm cache clean --force

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
COPY openbox/rc.xml /usr/share/sugabots-desktop/openbox.xml

# What the web app reaches a desktop through besides its displays: the
# browser's tabs, the terminal, the files, and which windows the desktop has. Its
# terminal is node-pty's, built here against the image's Node.
COPY desktop-server/package.json desktop-server/package-lock.json desktop-server/*.mjs /usr/local/lib/sugabots-desktop-server/
RUN cd /usr/local/lib/sugabots-desktop-server && npm ci --omit=dev && npm cache clean --force

RUN mkdir -p /workspace && chmod 755 /usr/local/bin/sugabots-desktop

WORKDIR /workspace
