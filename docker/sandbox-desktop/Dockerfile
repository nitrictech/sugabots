# A sandbox image with a desktop people can watch: Xfce on a virtual display,
# Firefox, and noVNC serving it to a browser on port 8080, the one port
# OpenSandbox's Docker mode publishes for a sandbox's own use.
#
#   docker build -t sugabots/sandbox-desktop docker/sandbox-desktop
#
# Then set the workspace's sandbox image to sugabots/sandbox-desktop. Sugabots
# starts the desktop when it makes the sandbox, by running
# /usr/local/bin/sugabots-desktop if the image has it.
FROM debian:bookworm

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		bash ca-certificates curl git python3 procps \
		xvfb x11vnc novnc python3-websockify \
		xfce4 xfce4-terminal dbus-x11 xdotool \
		firefox-esr fonts-dejavu-core scrot \
	&& rm -rf /var/lib/apt/lists/*

# Opens noVNC's viewer straight away rather than its landing page.
RUN ln -sf /usr/share/novnc/vnc.html /usr/share/novnc/index.html

# No first-run pages or prompts: most of them are hosts the sandbox can't reach.
COPY policies.json /usr/lib/firefox-esr/distribution/policies.json

COPY sugabots-desktop /usr/local/bin/sugabots-desktop
RUN chmod 755 /usr/local/bin/sugabots-desktop

CMD ["bash"]
