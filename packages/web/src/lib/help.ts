import type { HealthResponse } from "@sugabots/contracts";
import { projectLinks } from "@sugabots/contracts/project-links";
import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";

/** The version a build reports when it wasn't given one, such as `bun run dev`. */
const UNKNOWN_VERSION = "unknown";

/** How many characters of a commit hash identify it, as `git rev-parse --short` prints it. */
const SHORT_COMMIT_LENGTH = 7;

/** The build this installation runs: its release, and the commit it was made from. */
export interface Build {
	/** The release as the API reports it, such as `0.2.0` or `edge`; `unknown` when not `versioned`. */
	version: string;
	/** Whether the build was given a version. A local `bun run dev` or a platform building from source isn't. */
	versioned: boolean;
	/** The commit, shortened; undefined when the build didn't record one. */
	commit: string | undefined;
}

/** What is known of the running build: still being asked for, couldn't be had, or known. */
export type RunningBuild =
	| { state: "checking" }
	| { state: "unavailable" }
	| { state: "known"; build: Build };

/** The browser and operating system this page runs in, named for a bug report. */
export interface Environment {
	browser: string;
	system: string;
}

/**
 * The build the API reports. Asked for only while `enabled`, so the Help menu
 * costs nothing until it is opened.
 */
export function useRunningBuild(enabled: boolean): RunningBuild {
	const query = useQuery({
		queryKey: ["build"],
		queryFn: ({ signal }) => Effect.runPromise(client.api.health(), { signal }),
		select: toBuild,
		enabled,
	});
	if (query.data) return { state: "known", build: query.data };
	if (query.isError) return { state: "unavailable" };
	return { state: "checking" };
}

function toBuild({ version, commit }: HealthResponse): Build {
	return {
		version,
		versioned: version !== UNKNOWN_VERSION,
		commit: commit?.slice(0, SHORT_COMMIT_LENGTH) ?? undefined,
	};
}

/** Names the browser and system a user agent string describes, such as `Chrome 141` on `macOS`. */
export function describeEnvironment(userAgent: string): Environment {
	return { browser: browserIn(userAgent), system: systemIn(userAgent) };
}

/**
 * Browsers whose user agent names another as well, so the first match wins:
 * Edge and Opera say Chrome, Chrome says Safari, and iOS browsers have their own tokens.
 */
const BROWSERS: readonly [name: string, version: RegExp][] = [
	["Edge", /Edg(?:A|iOS)?\/(\d+)/],
	["Opera", /OPR\/(\d+)/],
	["Firefox", /(?:Firefox|FxiOS)\/(\d+)/],
	["Chrome", /(?:Chrome|CriOS)\/(\d+)/],
	["Safari", /Version\/(\d+(?:\.\d+)?).*Safari\//],
];

function browserIn(userAgent: string): string {
	for (const [name, version] of BROWSERS) {
		const match = version.exec(userAgent);
		if (match) return `${name} ${match[1]}`;
	}
	return "Unknown browser";
}

/**
 * Systems in the order they must be tested: an iPhone's user agent also says
 * Mac OS X, and Android's says Linux. Versions are left out because browsers
 * freeze them, so macOS 15 still reports 10.15.7 and Windows 11 reports 10.
 */
const SYSTEMS: readonly [name: string, pattern: RegExp][] = [
	["iOS", /iPhone|iPad|iPod/],
	["Android", /Android/],
	["ChromeOS", /CrOS/],
	["Windows", /Windows/],
	["macOS", /Macintosh|Mac OS X/],
	["Linux", /Linux/],
];

function systemIn(userAgent: string): string {
	return SYSTEMS.find(([, pattern]) => pattern.test(userAgent))?.[0] ?? "Unknown system";
}

/** What About shows and Copy debug info copies, each as the words a person reads. */
export interface DebugDetails {
	version: string;
	commit: string;
	browser: string;
	system: string;
}

/** The running build and this browser, worded for About and the clipboard. */
export function debugDetails(running: RunningBuild, environment: Environment): DebugDetails {
	const { version, commit } = buildDetails(running);
	return { version, commit, ...environment };
}

function buildDetails(running: RunningBuild): Pick<DebugDetails, "version" | "commit"> {
	switch (running.state) {
		case "checking":
			return { version: "Checking…", commit: "Checking…" };
		case "unavailable":
			return { version: "Not available", commit: "Not available" };
		case "known": {
			const { build } = running;
			return {
				version: build.versioned ? build.version : "Unknown",
				commit: build.commit ?? "Not recorded",
			};
		}
	}
}

/** What Copy debug info puts on the clipboard, a `Label: value` line for each detail. */
export function debugText({ version, commit, browser, system }: DebugDetails): string {
	return [
		`Version: ${version}`,
		`Commit: ${commit}`,
		`Browser: ${browser}`,
		`System: ${system}`,
	].join("\n");
}

/**
 * A new issue from the bug report form, `.github/ISSUE_TEMPLATE/bug-report.yml`,
 * with its `version` and `environment` fields filled in: the version, and the
 * reporter's browser and system among the lines the form's placeholder asks
 * for. GitHub ignores fields the form doesn't have, so keep these in step with
 * it. The version is left for the reporter when neither it nor the commit is
 * known, because the form asks them to say how they installed it instead.
 */
export function bugReportUrl(build: Build | undefined, environment: Environment): string {
	const url = new URL(`${projectLinks.repository}/issues/new`);
	url.searchParams.set("template", "bug-report.yml");
	const version = build && versionLine(build);
	if (version) url.searchParams.set("version", version);
	url.searchParams.set(
		"environment",
		[
			"Hosting platform:",
			"Model provider and model:",
			`Browser: ${environment.browser}`,
			`Operating system: ${environment.system}`,
		].join("\n"),
	);
	return url.href;
}

/** The version as the bug report form asks for it, `0.2.0 (338298a)`, or `unknown (338298a)` for a build without one. */
function versionLine({ version, versioned, commit }: Build): string | undefined {
	if (commit) return `${version} (${commit})`;
	return versioned ? version : undefined;
}
