import { describe, expect, it } from "vitest";
import {
	bugReportUrl,
	debugDetails,
	debugText,
	describeEnvironment,
	type RunningBuild,
} from "@/lib/help.ts";

const userAgents = {
	chromeOnMac:
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
	edgeOnWindows:
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.3537.57",
	firefoxOnLinux: "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0",
	safariOnIphone:
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
	chromeOnAndroid:
		"Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
	operaOnWindows:
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/124.0.0.0",
};

describe("the environment a bug report names", () => {
	it.each([
		["Chrome on a Mac", userAgents.chromeOnMac, "Chrome 141", "macOS"],
		["Edge, which also says Chrome", userAgents.edgeOnWindows, "Edge 141", "Windows"],
		["Opera, which also says Chrome", userAgents.operaOnWindows, "Opera 124", "Windows"],
		["Firefox on Linux", userAgents.firefoxOnLinux, "Firefox 143", "Linux"],
		[
			"Safari on an iPhone, which also says Mac OS X",
			userAgents.safariOnIphone,
			"Safari 18.6",
			"iOS",
		],
		[
			"Chrome on Android, which also says Linux",
			userAgents.chromeOnAndroid,
			"Chrome 141",
			"Android",
		],
	])("names %s", (_label, userAgent, browser, system) => {
		expect(describeEnvironment(userAgent)).toEqual({ browser, system });
	});

	it("says so when it doesn't recognise either", () => {
		expect(describeEnvironment("curl/8.7.1")).toEqual({
			browser: "Unknown browser",
			system: "Unknown system",
		});
	});
});

const environment = { browser: "Chrome 141", system: "macOS" };
const release = { version: "0.2.0", versioned: true, commit: "338298a" };
const unversioned = { version: "unknown", versioned: false, commit: undefined };

function copied(running: RunningBuild) {
	return debugText(debugDetails(running, environment));
}

describe("debug info", () => {
	it("is a line for each detail", () => {
		expect(copied({ state: "known", build: release })).toBe(
			"Version: 0.2.0\nCommit: 338298a\nBrowser: Chrome 141\nSystem: macOS",
		);
	});

	it("names a build without a version or commit", () => {
		expect(copied({ state: "known", build: unversioned })).toContain(
			"Version: Unknown\nCommit: Not recorded",
		);
	});

	it("says the version and commit aren't available when the API couldn't report them", () => {
		expect(copied({ state: "unavailable" })).toContain(
			"Version: Not available\nCommit: Not available",
		);
	});
});

describe("a bug report", () => {
	function fields(url: string) {
		const { origin, pathname, searchParams } = new URL(url);
		return { page: origin + pathname, ...Object.fromEntries(searchParams) };
	}

	it("opens the bug report form with the version, browser and system filled in", () => {
		expect(fields(bugReportUrl(release, environment))).toEqual({
			page: "https://github.com/nitrictech/sugabots/issues/new",
			template: "bug-report.yml",
			version: "0.2.0 (338298a)",
			environment:
				"Hosting platform:\nModel provider and model:\nBrowser: Chrome 141\nOperating system: macOS",
		});
	});

	it("gives the commit of a build without a version", () => {
		expect(fields(bugReportUrl({ ...unversioned, commit: "338298a" }, environment))).toMatchObject({
			version: "unknown (338298a)",
		});
	});

	it("leaves the version to the reporter when nothing is known of it", () => {
		expect(fields(bugReportUrl(unversioned, environment))).not.toHaveProperty("version");
		expect(fields(bugReportUrl(undefined, environment))).not.toHaveProperty("version");
	});
});
