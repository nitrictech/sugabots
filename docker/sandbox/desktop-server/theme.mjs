// The desktop's light or dark look, as the person viewing it has their own.
// GTK apps on the desktop's displays, Chromium's tabs and toolbar among
// them, are given the Sugabots or Sugabots-dark theme through the XSETTINGS
// file each display's xsettingsd serves, which they follow as it changes.
// Chromium's pages follow it only when the browser starts, so they're told
// which the reader prefers. The last viewer to say wins, since people
// sharing a desktop see the same pages.

import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { connectToBrowser } from "./devtools.mjs";

const SCHEMES = new Set(["light", "dark"]);
const GTK_THEMES = { light: "Sugabots", dark: "Sugabots-dark" };
const THEME_SETTING = /^Net\/ThemeName .*$/m;
/** How long to wait before reaching the browser again once it has closed, as it does to start again. */
const RECONNECT_DELAY_MS = 1000;

/**
 * The desktop's look, applied to the browser on DevTools port
 * `devtoolsPort` and written to `xsettingsFile`, and kept on the browser's
 * tabs, new ones included, for as long as the server runs, across the
 * browser starting again.
 */
export async function makeTheme(devtoolsPort, xsettingsFile) {
	let scheme = schemeIn(xsettingsFile);
	/** The browser's pages, by target id, with the session each is reached through once attached. */
	let sessions = new Map();
	let browser;

	const applyTo = (sessionId) =>
		browser
			.send(
				"Emulation.setEmulatedMedia",
				{ features: [{ name: "prefers-color-scheme", value: scheme }] },
				sessionId,
			)
			.catch(report);

	const connect = async () => {
		browser = await connectToBrowser(devtoolsPort);
		const attached = new Map();
		sessions = attached;
		const attach = async (info) => {
			if (info.type !== "page" || attached.has(info.targetId)) return;
			attached.set(info.targetId, undefined);
			const { sessionId } = await browser.send("Target.attachToTarget", {
				targetId: info.targetId,
				flatten: true,
			});
			attached.set(info.targetId, sessionId);
			await applyTo(sessionId);
		};
		browser.on("Target.targetCreated", ({ targetInfo }) => attach(targetInfo).catch(report));
		browser.on("Target.targetDestroyed", ({ targetId }) => attached.delete(targetId));
		browser.onClose(() => setTimeout(reconnect, RECONNECT_DELAY_MS));
		const { targetInfos } = await browser.send("Target.getTargets");
		await Promise.all(targetInfos.map(attach));
		await browser.send("Target.setDiscoverTargets", { discover: true });
	};
	const reconnect = () =>
		connect().catch((error) => {
			report(error);
			setTimeout(reconnect, RECONNECT_DELAY_MS);
		});

	await connect();

	return {
		/** Changes the desktop's look to `next`, `light` or `dark`. */
		set(next) {
			if (!SCHEMES.has(next) || next === scheme) return;
			scheme = next;
			writeFileSync(xsettingsFile, withTheme(readFileSync(xsettingsFile, "utf8"), scheme));
			// Each display's xsettingsd reads its file again when told to.
			execFile("pkill", ["-HUP", "-x", "xsettingsd"], () => {});
			for (const sessionId of sessions.values()) if (sessionId) applyTo(sessionId);
		},
	};
}

/** The look the XSETTINGS file holds, dark if it says nothing yet. */
function schemeIn(xsettingsFile) {
	try {
		const theme = readFileSync(xsettingsFile, "utf8").match(THEME_SETTING)?.[0];
		return theme?.includes(`"${GTK_THEMES.light}"`) ? "light" : "dark";
	} catch {
		return "dark";
	}
}

/** The XSETTINGS file's `settings`, with the GTK theme of `scheme` and the rest as they were. */
function withTheme(settings, scheme) {
	const setting = `Net/ThemeName "${GTK_THEMES[scheme]}"`;
	return THEME_SETTING.test(settings)
		? settings.replace(THEME_SETTING, setting)
		: `${setting}\n${settings}`;
}

function report(error) {
	console.error(error);
}
