import { execFileSync, spawn } from "node:child_process";
import type { BrowserContext } from "playwright";
import { freePort } from "./environment.ts";

/**
 * A real sandbox desktop for the Sandboxes slide, without a sandbox provider:
 * the sandbox image in plain Docker, its desktop started as Sugabots starts
 * it, with a terminal that has just cloned the repository. The app's desktop
 * viewer is pointed at it in place of the API's relay.
 */

const IMAGE = "ghcr.io/nitrictech/sugabots-sandbox:latest";
/** A VNC server of its own on the desktop, without a password, as the relay presents it to the viewer. */
const VIEWER_PORT = 5950;
const REPOSITORY = "https://github.com/nitrictech/sugabots";
/** What the terminal has run, typed on the desktop so it shows as a person left it. */
const COMMANDS = [`git clone --depth 1 ${REPOSITORY}`, "cd sugabots && ls"];
const TERMINAL = { width: 1040, height: 600, x: 120, y: 60 };
/** Large enough to read once the desktop is scaled down beside the chat. */
const TERMINAL_CONFIG = "[general]\nfontname=Monospace 13\n";
const CLONE_SECONDS = 60;

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
		const started = docker(
			"exec",
			container,
			"sugabots-desktop",
			"desktop",
			"capture",
			"/tmp/profile",
			"/tmp/output",
		);
		const display = /display=(\d+)/.exec(started)?.[1];
		if (display !== "1") throw new Error(`The desktop started on display ${display}, not 1`);
		docker(
			"exec",
			"-d",
			container,
			"x11vnc",
			"-display",
			":1",
			"-nopw",
			"-forever",
			"-shared",
			"-quiet",
			"-rfbport",
			String(VIEWER_PORT),
		);
		docker(
			"exec",
			container,
			"sh",
			"-c",
			`mkdir -p ~/.config/lxterminal && printf '${TERMINAL_CONFIG}' > ~/.config/lxterminal/lxterminal.conf`,
		);
		spawn(
			"docker",
			["exec", "-e", "DISPLAY=:1", container, "sugabots-desktop", "open", "terminal"],
			{
				stdio: "ignore",
			},
		).unref();
		const terminal =
			onDesktop("xdotool", "search", "--sync", "--onlyvisible", "--class", "lxterminal")
				.trim()
				.split("\n")[0] ?? "";
		onDesktop(
			"xdotool",
			"windowsize",
			"--sync",
			terminal,
			String(TERMINAL.width),
			String(TERMINAL.height),
			"windowmove",
			terminal,
			String(TERMINAL.x),
			String(TERMINAL.y),
			"windowactivate",
			"--sync",
			terminal,
		);
		for (const command of COMMANDS) {
			onDesktop("xdotool", "type", "--delay", "20", `${command}\n`);
			await finished(container);
		}
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

/** Waits until the terminal's shell has nothing running under it: what it was typed has finished. */
async function finished(container: string) {
	const until = Date.now() + CLONE_SECONDS * 1000;
	await new Promise((resolve) => setTimeout(resolve, 500));
	while (Date.now() < until) {
		const busy = execFileSync(
			"docker",
			["exec", container, "sh", "-c", "pgrep -f '^git ' || pgrep -x ls || true"],
			{ encoding: "utf8" },
		).trim();
		if (!busy) return;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`The desktop's terminal was still busy after ${CLONE_SECONDS} seconds`);
}
