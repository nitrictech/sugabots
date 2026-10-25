// The sites the pages open in a desktop's browser tried and failed to reach
// because they have no address, one host a line: what `sugabots-desktop
// unreached-sites` prints. OpenSandbox's egress refuses to look up a site the
// sandbox may not reach, so its loads fail with ERR_NAME_NOT_RESOLVED.
// Chromium records each failed load on the page's log, as coming from the
// network, which a page's own scripts can't write, and replays the log to
// whoever attaches, so nothing has to watch the page as it loads. A page that
// couldn't load at all shows Chromium's error page instead, and counts if its
// site still doesn't resolve here.
//
//   node unreached-sites.mjs <Playwright MCP's directory> <DevTools address> [reload host...]
//
// With `reload`, it loads again the pages that failed to reach any of the
// hosts, once they are allowed, and prints nothing. Playwright is the one
// Playwright MCP brings, so the image needs no other. It attaches without
// changing the browser's settings, and leaves its tabs as they were.

import { lookup } from "node:dns/promises";
import { createRequire } from "node:module";

const [playwrightMcp, devtools, action, ...reloadHosts] = process.argv.slice(2);
const { chromium } = createRequire(`${playwrightMcp}/package.json`)("playwright-core");

const NOT_RESOLVED = "net::ERR_NAME_NOT_RESOLVED";
const MOST_HOSTS = 50;
const RELOAD_TIMEOUT_MS = 10_000;

function parseHostname(address) {
	return URL.canParse(address) ? new URL(address).hostname : "";
}

/** Whether `host` has no address here, as a site the sandbox may not reach has none. */
async function isUnresolved(host) {
	try {
		await lookup(host);
		return false;
	} catch (error) {
		return error.code === "ENOTFOUND";
	}
}

/**
 * The hosts the page failed to reach: its own, when it couldn't load at all,
 * or those of what it loads. Chromium's error page has Chromium's address;
 * the page's target still has the one it was opening.
 */
async function findUnreached(page) {
	const session = await page.context().newCDPSession(page);
	try {
		if (page.url().startsWith("chrome-error:")) {
			const { targetInfo } = await session.send("Target.getTargetInfo");
			const host = parseHostname(targetInfo.url);
			return host && (await isUnresolved(host)) ? [host] : [];
		}
		const hosts = [];
		session.on("Log.entryAdded", ({ entry }) => {
			if (
				entry.source === "network" &&
				entry.level === "error" &&
				entry.text.includes(NOT_RESOLVED)
			) {
				hosts.push(parseHostname(entry.url ?? ""));
			}
		});
		// The entries collected so far arrive before Log.enable answers.
		await session.send("Log.enable");
		return hosts.filter(Boolean);
	} finally {
		await session.detach();
	}
}

const browser = await chromium.connectOverCDP(devtools, { noDefaults: true });
try {
	const found = new Set();
	for (const page of browser.contexts().flatMap((context) => context.pages())) {
		const unreached = await findUnreached(page);
		if (action !== "reload") {
			for (const host of unreached) found.add(host);
		} else if (unreached.some((host) => reloadHosts.includes(host))) {
			// Waits only for the page to start loading, so a slow site doesn't hold
			// up the others.
			await page.reload({ waitUntil: "commit", timeout: RELOAD_TIMEOUT_MS }).catch(() => undefined);
		}
	}
	for (const host of [...found].slice(0, MOST_HOSTS)) console.log(host);
} finally {
	await browser.close();
}
