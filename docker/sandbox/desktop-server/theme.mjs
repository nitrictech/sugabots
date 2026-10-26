// The desktop's light or dark look, as the person viewing it has their own:
// the browser's pages are told which the reader prefers, and GTK apps on the
// desktop's displays are given Adwaita or Adwaita-dark through the
// XSETTINGS file each display's xsettingsd serves, which they follow as it
// changes. The last viewer to say wins, since people sharing a desktop see
// the same pages.

import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { connectToBrowser } from "./devtools.mjs";

const SCHEMES = new Set(["light", "dark"]);
const GTK_THEMES = { light: "Adwaita", dark: "Adwaita-dark" };

/**
 * The desktop's look, applied to the browser on DevTools port
 * `devtoolsPort` and written to `xsettingsFile`, and kept on the browser's
 * tabs, new ones included, for as long as the server runs.
 */
export async function makeTheme(devtoolsPort, xsettingsFile) {
	let scheme = schemeIn(xsettingsFile);
	const browser = await connectToBrowser(devtoolsPort);
	const sessions = new Map();

	const applyTo = (sessionId) =>
		browser
			.send(
				"Emulation.setEmulatedMedia",
				{ features: [{ name: "prefers-color-scheme", value: scheme }] },
				sessionId,
			)
			.catch(report);

	const attach = async (info) => {
		if (info.type !== "page" || sessions.has(info.targetId)) return;
		sessions.set(info.targetId, undefined);
		const { sessionId } = await browser.send("Target.attachToTarget", {
			targetId: info.targetId,
			flatten: true,
		});
		sessions.set(info.targetId, sessionId);
		await applyTo(sessionId);
	};

	browser.on("Target.targetCreated", ({ targetInfo }) => attach(targetInfo).catch(report));
	browser.on("Target.targetDestroyed", ({ targetId }) => sessions.delete(targetId));
	const { targetInfos } = await browser.send("Target.getTargets");
	await Promise.all(targetInfos.map(attach));
	await browser.send("Target.setDiscoverTargets", { discover: true });

	return {
		/** Changes the desktop's look to `next`, `light` or `dark`. */
		set(next) {
			if (!SCHEMES.has(next) || next === scheme) return;
			scheme = next;
			writeFileSync(xsettingsFile, xsettingsFor(scheme));
			// Each display's xsettingsd reads its file again when told to.
			execFile("pkill", ["-HUP", "-x", "xsettingsd"], () => {});
			for (const sessionId of sessions.values()) if (sessionId) applyTo(sessionId);
		},
	};
}

/** The look the XSETTINGS file holds, dark if it says nothing yet. */
function schemeIn(xsettingsFile) {
	try {
		return readFileSync(xsettingsFile, "utf8").includes(`"${GTK_THEMES.light}"`) ? "light" : "dark";
	} catch {
		return "dark";
	}
}

function xsettingsFor(scheme) {
	return `Net/ThemeName "${GTK_THEMES[scheme]}"\n`;
}

function report(error) {
	console.error(error);
}
