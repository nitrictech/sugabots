import { execFileSync } from "node:child_process";
import { botColors } from "@sugabots/avatars/bot-colors";
import type { BrowserContext } from "playwright";
import { freePort } from "./environment.ts";

/**
 * A real sandbox desktop for the Sandboxes slide, without a sandbox provider:
 * the sandbox image in plain Docker, its desktop started as Sugabots starts
 * it when a bot uses its browser, in Code Reviewer's colour, with the browser
 * on Sugabots' own site. The app's desktop viewer is pointed at it in place of
 * the API's relay.
 */

const IMAGE = "ghcr.io/nitrictech/sugabots-sandbox:latest";
/** The desktop's own WebSocket for VNC viewers: display 1's, at 5900 + 1. */
const VIEWER_PORT = 5901;
/** Code Reviewer's, the bot the slide shows, which the desktop is drawn in as the app would draw it. */
const ACCENT = botColors.rose.face;
/**
 * The desktop asks viewers for a password, which the API's relay gives and
 * the viewer, pointed past it, can't. In front of the real Xvnc on the
 * container's PATH, this starts it without one; its last setting wins.
 */
const XVNC_WITHOUT_PASSWORD = '#!/bin/sh\nexec /usr/bin/Xvnc "$@" -SecurityTypes None\n';
const SITE = "https://sugabots.ai";
/** The browser's DevTools on display 1, at 9230 + 1, which opens the site in it. */
const DEVTOOLS = "http://127.0.0.1:9231";
/** The desktop's screen, as `sugabots-desktop` starts it. */
const DISPLAY_SIZE = { width: 1280, height: 960 };
/** The class `sugabots-desktop` gives its browser's windows. */
const BROWSER_WINDOW_CLASS = "sugabots-browser";
const LOAD_SECONDS = 30;
/** How long the site's entrance animations take once its title is set. */
const SETTLE_MILLISECONDS = 2500;

export interface Desktop {
	/** Points the app's desktop viewer at this desktop, and says sandboxes are on. */
	showIn(context: BrowserContext): Promise<void>;
	stop(): void;
}

/** The desktop, or nothing when the sandbox image hasn't been built here. */
export async function startDesktop(): Promise<Desktop | undefined> {
	try {
		execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" });
	} catch {
		console.warn(`  No ${IMAGE}: run \`bun run build:sandbox\` for the Sandboxes slide.`);
		return undefined;
	}
	const port = await freePort();
	const container = `sugabots-capture-desktop-${process.pid}`;
	const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" });
	const onDesktop = (...args: string[]) => docker("exec", "-e", "DISPLAY=:1", container, ...args);
	docker(
		"run",
		"-d",
		"--rm",
		"--name",
		container,
		"-p",
		`127.0.0.1:${port}:${VIEWER_PORT}`,
		IMAGE,
		"sleep",
		"infinity",
	);
	const stop = () => {
		execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
	};
	try {
		docker(
			"exec",
			container,
			"sh",
			"-c",
			`printf '${XVNC_WITHOUT_PASSWORD}' > /usr/local/bin/Xvnc && chmod +x /usr/local/bin/Xvnc`,
		);
		const started = docker(
			"exec",
			container,
			"sugabots-desktop",
			"session",
			"capture",
			"/tmp/profile",
			"/tmp/output",
			"--accent",
			ACCENT,
		);
		const display = /display=(\d+)/.exec(started)?.[1];
		if (display !== "1") throw new Error(`The desktop started on display ${display}, not 1`);
		await openSite(container);
		await maximizeBrowser(onDesktop);
		// The pointer starts in the middle of the screen, over the page.
		onDesktop("xdotool", "mousemove", String(DISPLAY_SIZE.width), String(DISPLAY_SIZE.height));
	} catch (error) {
		stop();
		throw error;
	}
	return {
		async showIn(context) {
			await context.route("**/api/workspaces/*/sandbox-providers/access", (route) =>
				route.fulfill({ json: { enabled: true } }),
			);
			// The viewer connects to the desktop's VNC server itself, which takes a
			// WebSocket from any page: it only asks that the browser give an origin.
			await context.addInitScript((desktopUrl) => {
				// Native sockets, not a subclass's: noVNC checks a socket's methods on its own prototype.
				window.WebSocket = new Proxy(window.WebSocket, {
					construct: (Native, [url, protocols]: [string | URL, string | string[] | undefined]) =>
						new Native(/\/agents\/[^/]+\/desktop$/.test(String(url)) ? desktopUrl : url, protocols),
				});
			}, `ws://127.0.0.1:${port}`);
		},
		stop,
	};
}

/** Opens the site in the browser's blank tab, and waits for it to load. */
async function openSite(container: string) {
	const devtools = (path: string, method = "GET") =>
		execFileSync(
			"docker",
			[
				"exec",
				container,
				"curl",
				"-sf",
				"--retry",
				"20",
				"--retry-connrefused",
				"-X",
				method,
				`${DEVTOOLS}${path}`,
			],
			{ encoding: "utf8" },
		);
	const pages = () =>
		(
			JSON.parse(devtools("/json/list")) as {
				id: string;
				type: string;
				url: string;
				title: string;
			}[]
		).filter((target) => target.type === "page");
	const blank = pages().filter((page) => page.url === "about:blank");
	devtools(`/json/new?${SITE}`, "PUT");
	for (const page of blank) devtools(`/json/close/${page.id}`);
	const until = Date.now() + LOAD_SECONDS * 1000;
	while (Date.now() < until) {
		if (pages().some((page) => page.url.startsWith(SITE) && page.title.startsWith("Sugabots"))) {
			await new Promise((resolve) => setTimeout(resolve, SETTLE_MILLISECONDS));
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`${SITE} didn't load in the desktop's browser within ${LOAD_SECONDS} seconds`);
}

/**
 * Maximizes the browser's window, as a person would. It opens at Chromium's
 * default size inside a frame of its own drawing, whose shadow the viewer
 * shows as a black border; a maximized window has none.
 */
async function maximizeBrowser(onDesktop: (...args: string[]) => string) {
	const until = Date.now() + LOAD_SECONDS * 1000;
	let window: string | undefined;
	while (!window && Date.now() < until) {
		try {
			window = onDesktop("xdotool", "search", "--onlyvisible", "--class", BROWSER_WINDOW_CLASS)
				.trim()
				.split("\n")
				.at(-1);
		} catch {
			// xdotool fails when no window matches yet.
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	}
	if (!window) throw new Error(`The desktop's browser didn't open within ${LOAD_SECONDS} seconds`);
	// The window manager's Maximize shortcut toggles, and the window may already be maximized.
	if (!onDesktop("xprop", "-id", window, "_NET_WM_STATE").includes("MAXIMIZED_VERT"))
		onDesktop("xdotool", "windowactivate", "--sync", window, "key", "alt+F10");
	await new Promise((resolve) => setTimeout(resolve, SETTLE_MILLISECONDS));
}
