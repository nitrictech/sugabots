/**
 * Finds, in tracked files, the words GLOSSARY.md retires and the banned
 * synonyms it can tell apart from other senses: in identifiers, comments,
 * strings and docs alike.
 *
 * `node lint/check-glossary.ts` fails if any is found, listing where, so none
 * can come back. `--report` also counts each by package.
 *
 * Only words a machine can tell are meant in the banned sense are checked.
 * Retired words whose meaning changed rather than ended, such as "task",
 * "schedule", "document" and "routine", are left to the reader, as is
 * "summary", which is plain English as often as it is the retired summary.
 * So are banned synonyms that are everyday words or another system's own:
 * "user" (HTTP's user agent, a user message, the current user), "workspace
 * bot" and "internal bot" (any bot in the workspace, and a made-up project's
 * name), "done" and "archived" alone (only their names for a chat's state are
 * checked), "activity" (the workflow engine's word for a step), "streaming"
 * and "reasoning" (the model providers' and the event stream's), "snapshot"
 * (Playwright's), "VNC" (the desktop's protocol), "callback", "endpoint" and
 * "hook" (OAuth's, HTTP's, and React's and better-auth's hooks), "sender" (an
 * email's), "condition" (a query's), "system prompt" and "function call" (a
 * model provider's API), "organisation" (GitHub's), "routing", "dispatch",
 * "seen", "app" (the web app, a GitHub app), "scope", "context" and "sandbox"
 * (turn bounds'; OAuth's scopes, React's contexts, a browser's sandbox): only
 * "approval app", a tool source's old compound name, is checked.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

interface CheckedWord {
	/** The singular in lower case, as it starts an identifier. */
	readonly word: string;
	readonly plural: string;
	/** What GLOSSARY.md says to use instead. */
	readonly replacement: string;
	/** The glossary term this word is a banned synonym of; absent for a retired term. */
	readonly bannedFor?: string;
	/** Uses of the word that mean something else, removed before matching. */
	readonly otherMeanings?: RegExp;
	/** Files where the word is only ever someone else's, so it isn't checked there. */
	readonly keptIn?: readonly RegExp[];
}

/** The glossary's Retired terms: words for things that no longer exist. */
const RETIRED_WORDS: readonly CheckedWord[] = [
	{
		word: "pod",
		plural: "pods",
		replacement: "project, or the bot",
		// Apple's iPod.
		otherMeanings: /iPod/g,
	},
	{ word: "crew", plural: "crews", replacement: "the project's bots" },
	{
		word: "channel",
		plural: "channels",
		replacement: "project",
		// Others' channels: Slack's `@channel`, which a member writes to mention
		// everyone in a chat, and the Postgres notification channel.
		otherMeanings:
			/@channel|"here", "channel"|handle: "channel"|name: "Channel"|\[\["channel", "reviewer"\]\]|`here` or `channel`|"here and channel"|NOTIFY_CHANNEL|notification channel/g,
		keptIn: [
			// A colour's red, green and blue channels.
			/^docker\/computer\/sugabots-desktop-look$/,
			// Xfce's settings, kept in channels.
			/^docker\/computer\/xfce\//,
			// Mock Service Worker's own script, talking to its page over a MessageChannel.
			/^packages\/web\/\.storybook\/public\/mockServiceWorker\.js$/,
		],
	},
	{ word: "main chat", plural: "main chats", replacement: "a project's chats" },
	{ word: "main thread", plural: "main threads", replacement: "a project's chats" },
	{ word: "artifact", plural: "artifacts", replacement: "file" },
	{
		word: "sandbox",
		plural: "sandboxes",
		replacement: "computer",
		// Others' names: the OpenSandbox provider, its server's setting, SDK and
		// container names; E2B's `sandboxUrl`; Chromium's and an iframe's
		// sandbox. And names kept because something outside the code holds
		// them: the published image and E2B template `sugabots-sandbox`, the
		// certificate name in computers' homes, the tool name earlier calls
		// record, and the tables as a database not yet migrated has them.
		otherMeanings:
			/OpenSandbox|SANDBOX_CONFIG_PATH|SandboxManager|listSandboxInfos|`sandbox-\$\{|sandboxUrl|E2B_SANDBOX_URL|--no-sandbox|chromium_sandbox_flags|Chromium's flags for its own sandbox|sugabots-sandbox|PROVIDER_AUTHORITY=sandbox-provider|copy_file_to_sandbox|toHaveAttribute\("sandbox"/g,
		keptIn: [
			// Talking to each provider in its own words.
			/^packages\/core\/src\/computers\/implementations\//,
			// Nix's build sandbox.
			/^docker\/computer\/nix\/nix\.conf$/,
			// The browser's: an iframe's `sandbox` and Content-Security-Policy's.
			/^packages\/web\/src\/screens\/HtmlFrame\.tsx$/,
			/^packages\/server\/src\/http\/content-pages(\.test)?\.ts$/,
			/^packages\/server\/src\/routes\/chats\/(file-response|files\.test)\.ts$/,
		],
	},
	{
		word: "agent",
		plural: "agents",
		replacement: "bot",
		// Others' agents: the HTTP user agent, coding agents, crawlers and AI
		// agents generally, and SSH's and GPG's.
		otherMeanings:
			/user[-_ ]?agents?|AI agents?|your[- ]agent|(?:ssh|gpg)-agent|SSH and GPG agents/gi,
		keptIn: [
			// undici's Agent, the connection pool requests are sent through.
			/^packages\/core\/src\/providers\/network\/egress(\.test)?\.ts$/,
		],
	},
	{ word: "bot summary", plural: "bot summaries", replacement: "nothing: summaries are gone" },
	{ word: "summariser", plural: "summarisers", replacement: "nothing: summaries are gone" },
	{ word: "summarizer", plural: "summarizers", replacement: "nothing: summaries are gone" },
	{ word: "scribe", plural: "scribes", replacement: "nothing: summaries are gone" },
	{
		word: "inbox",
		plural: "inboxes",
		replacement: "the Personal Assistant, which tells a member what needs their attention",
		// An email inbox: the one a sign-up link is sent to, and the ones bots
		// in examples sort.
		otherMeanings:
			/(?:in|[Ss]ort|[Ss]orts|[Ss]orting) (?:its|the) inbox|(?:support|shared) inbox|inbox sweep|Inbox (?:Sorter|Manager|triage)|inboxSorter|read_inbox/g,
	},
	{
		word: "direct message",
		plural: "direct messages",
		replacement: "a project's chat, or a bot's",
	},
];

/** Banned synonyms: words for something the glossary names otherwise. */
const BANNED_SYNONYMS: readonly CheckedWord[] = [
	// Members and the workspace
	{ word: "tenant", plural: "tenants", bannedFor: "Workspace", replacement: "workspace" },
	{
		word: "person",
		plural: "persons",
		bannedFor: "Member",
		replacement: "member",
		// PostHog's own setting for the profiles it keeps of a site's visitors,
		// and "personal" in capitals, which the acronym-led form would match.
		otherMeanings: /person_profiles|PERSONAL_/g,
	},
	{ word: "people", plural: "people", bannedFor: "Member", replacement: "members" },
	{
		word: "session user",
		plural: "session users",
		bannedFor: "Member",
		replacement: "current user",
	},
	{
		word: "transfer ownership",
		plural: "transferred ownership",
		bannedFor: "Owner",
		replacement: "hand over ownership",
	},
	{ word: "super admin", plural: "super admins", bannedFor: "Owner", replacement: "owner" },
	{ word: "superuser", plural: "superusers", bannedFor: "Admin", replacement: "admin" },
	{
		word: "workspace invite",
		plural: "workspace invites",
		bannedFor: "Invitation",
		replacement: "invitation",
	},
	{ word: "sysadmin", plural: "sysadmins", bannedFor: "Operator", replacement: "operator" },

	// Bots
	{ word: "shared bot", plural: "shared bots", bannedFor: "Public bot", replacement: "public bot" },
	{
		word: "unlisted bot",
		plural: "unlisted bots",
		bannedFor: "Private bot",
		replacement: "private bot",
	},
	{
		word: "invite-only bot",
		plural: "invite-only bots",
		bannedFor: "Private bot",
		replacement: "private bot",
	},
	{
		word: "hidden bot",
		plural: "hidden bots",
		bannedFor: "Personal bot",
		replacement: "personal bot",
	},
	{
		word: "secret bot",
		plural: "secret bots",
		bannedFor: "Personal bot",
		replacement: "personal bot",
	},
	{
		word: "background bot",
		plural: "background bots",
		bannedFor: "System bot",
		replacement: "system bot",
	},
	{
		word: "llm provider",
		plural: "llm providers",
		bannedFor: "Model provider",
		replacement: "model provider",
	},
	{
		word: "native tool",
		plural: "native tools",
		bannedFor: "Built-in tool",
		replacement: "built-in tool",
	},
	{
		word: "mcp tool",
		plural: "mcp tools",
		bannedFor: "Connector tool",
		replacement: "connector tool",
		// The protocol's own word for a tool's result, and Exa's search tool.
		otherMeanings: /MCP tool result|Exa's MCP tool/g,
	},
	{
		word: "preset",
		plural: "presets",
		bannedFor: "Built-in connector",
		replacement: "built-in connector",
		// Others' presets: Biome's rules and ffmpeg's encoder speed.
		otherMeanings: /"preset": "recommended"|"-preset",/g,
	},
	{
		word: "catalog entry",
		plural: "catalog entries",
		bannedFor: "Built-in connector",
		replacement: "built-in connector",
		// A tool that tool search can find, in the turn's catalog of them.
		otherMeanings: /CatalogEntry/g,
	},

	// Projects and chats
	{
		word: "thread",
		plural: "threads",
		bannedFor: "Chat",
		replacement: "chat",
		// A web forum's, and GitHub's comments on a pull request's code.
		otherMeanings: /forum thread|review thread|reviewThreadId/g,
	},
	{ word: "conversation", plural: "conversations", bannedFor: "Chat", replacement: "chat" },
	{ word: "default bot", plural: "default bots", bannedFor: "Lead bot", replacement: "lead bot" },
	{
		word: "home project",
		plural: "home projects",
		bannedFor: "Default project",
		replacement: "default project",
	},
	{ word: "mark done", plural: "marked done", bannedFor: "Resolved", replacement: "mark resolved" },
	{
		word: "chat done",
		plural: "chats done",
		bannedFor: "Resolved",
		replacement: "a resolved chat",
	},
	{ word: "done at", plural: "done at", bannedFor: "Resolved", replacement: "resolved at" },
	{
		word: "archive chat",
		plural: "archived chat",
		bannedFor: "Resolved",
		replacement: "a resolved chat",
	},
	{
		word: "subagent",
		plural: "subagents",
		bannedFor: "Collaboration",
		replacement: "collaboration",
	},
	{
		word: "kickoff message",
		plural: "kickoff messages",
		bannedFor: "Brief",
		replacement: "brief",
	},
	{ word: "handover note", plural: "handover notes", bannedFor: "Brief", replacement: "brief" },
	{ word: "decider", plural: "deciders", bannedFor: "Approver", replacement: "approver" },
	{ word: "chat type", plural: "chat types", bannedFor: "Chat kind", replacement: "chat kind" },
	{
		word: "read state",
		plural: "read states",
		bannedFor: "Read cursor",
		replacement: "read cursor",
	},
	{
		word: "read receipt",
		plural: "read receipts",
		bannedFor: "Read cursor",
		replacement: "read cursor",
	},

	// A project's resources
	{
		word: "sealed address",
		plural: "sealed addresses",
		bannedFor: "Page address",
		replacement: "page address",
	},
	{
		word: "share link",
		plural: "share links",
		bannedFor: "Page address",
		replacement: "page address",
	},
	{
		word: "connection",
		plural: "connections",
		bannedFor: "Connector",
		replacement: "connector",
		// Other connections: a socket's, an HTTP request's, a WebSocket's, the
		// event stream's, a database's, and the computer providers' SDKs' own.
		otherMeanings:
			/closeAllConnections|ProviderConnectionLost|ConnectionConfig|connectionConfig|ConnectionOpts|Connections Sugabots makes|viewer's connection|per connection|No connection to|connection never made|dead connection|same connection|(?:[Cc]heck|lost|dropped|refused|open|first|desktop viewer's|hidden page's) (?:the |your )?connection|connection (?:drops|dropped|refused|ended|open|could be made|is made|to (?:one|any other host|the browser|the event stream|\$\{)|holds the computer awake|pool)|(?:A|a) connection (?:to|holds)|direct connection/g,
		keptIn: [
			// A model request's socket, made, refused or dropped.
			/^packages\/core\/src\/providers\/models\/request-failures\.ts$/,
			// The HTTP headers a client owns, `Connection` among them.
			/^packages\/contracts\/src\/model-providers(?:\.test)?\.ts$/,
			// Database, network and socket connections.
			/^packages\/core\/src\/database\//,
			/^packages\/workflow\//,
			/^packages\/core\/src\/accounting\/usage\.ts$/,
			/^packages\/core\/src\/providers\/network\//,
			/^packages\/server\/src\/auth\/authentication\.ts$/,
			/^packages\/sdk\/src\/events(?:\.test)?\.ts$/,
			/^packages\/docs\/content\/(?:configuration|deploy-with-docker)\.mdx$/,
			/^packages\/website\/scripts\/capture\/environment\.ts$/,
			/^\.env\.example$/,
			/^compose\.yml$/,
			/^docker\//,
			/^LICENSE\.md$/,
		],
	},
	{
		word: "whitelist",
		plural: "whitelists",
		bannedFor: "Allowed host",
		replacement: "allowed hosts",
	},
	{
		word: "allowed domain",
		plural: "allowed domains",
		bannedFor: "Allowed host",
		replacement: "allowed host",
	},
	{
		word: "blacklist",
		plural: "blacklists",
		bannedFor: "Blocked host",
		replacement: "blocked hosts",
	},
	{
		word: "denylist",
		plural: "denylists",
		bannedFor: "Blocked host",
		replacement: "blocked hosts",
	},
	{
		word: "blocked domain",
		plural: "blocked domains",
		bannedFor: "Blocked host",
		replacement: "blocked host",
	},
	{
		word: "allowlist",
		plural: "allowlists",
		bannedFor: "Network mode",
		replacement: "allowed hosts only, the allowed hosts, a host request or the trusted hosts",
	},
	{
		word: "network access request",
		plural: "network access requests",
		bannedFor: "Host request",
		replacement: "host request",
	},
	{ word: "unpriced", plural: "unpriced", bannedFor: "Unknown cost", replacement: "unknown cost" },
	{ word: "estimated cost", plural: "estimated costs", bannedFor: "Cost", replacement: "cost" },
	{ word: "sealed value", plural: "sealed values", bannedFor: "Secret", replacement: "secret" },
	{
		word: "encrypted value",
		plural: "encrypted values",
		bannedFor: "Secret",
		replacement: "secret",
	},
	{
		word: "screen share",
		plural: "screen shares",
		bannedFor: "Desktop viewer",
		replacement: "desktop viewer",
	},
	{
		word: "remote view",
		plural: "remote views",
		bannedFor: "Desktop viewer",
		replacement: "desktop viewer",
	},
	{ word: "ad-hoc run", plural: "ad-hoc runs", bannedFor: "Manual run", replacement: "manual run" },
	{ word: "run now", plural: "run now", bannedFor: "Manual run", replacement: "start a run" },
	{
		word: "approval app",
		plural: "approval apps",
		bannedFor: "Tool source",
		replacement: "tool source",
	},
	{
		word: "tool permission",
		plural: "tool permissions",
		bannedFor: "Tool access",
		replacement: "tool access",
	},
	{
		word: "tool policy",
		plural: "tool policies",
		bannedFor: "Tool access",
		replacement: "tool access",
	},

	// Architecture
	{
		word: "entry point",
		plural: "entry points",
		bannedFor: "Entrypoint",
		replacement: "entrypoint",
		// Docker's entrypoint, which names the program a container starts.
		otherMeanings: /ENTRYPOINT/g,
	},
	{ word: "agent loop", plural: "agent loops", bannedFor: "Bot loop", replacement: "bot loop" },
	{
		word: "agent runtime",
		plural: "agent runtimes",
		bannedFor: "Bot loop",
		replacement: "bot loop",
	},
	{
		word: "use case",
		plural: "use cases",
		bannedFor: "Operation",
		replacement: "operation",
		// Plain English for what a story or an issue is for, and Mock Service
		// Worker's own script.
		keptIn: [
			/^packages\/web\/\.storybook\/public\/mockServiceWorker\.js$/,
			/^CONTRIBUTING\.md$/,
			/^\.github\//,
		],
	},
	{
		word: "tool registry",
		plural: "tool registries",
		bannedFor: "Exposure manifest",
		replacement: "exposure manifest",
	},
	{
		word: "chain of thought",
		plural: "chains of thought",
		bannedFor: "Thinking",
		replacement: "thinking",
	},
	{
		word: "live typing",
		plural: "live typing",
		bannedFor: "Token stream",
		replacement: "token stream",
	},
	{
		word: "model call",
		plural: "model calls",
		bannedFor: "Model request",
		replacement: "model request",
		// The verb: what the model calls, a tool. And the AI SDK's callbacks.
		otherMeanings: /(?:[Tt]he|key the) model calls|LanguageModelCall/g,
	},
	{
		word: "mutates",
		plural: "mutates",
		bannedFor: "Changes",
		replacement: "changes",
	},
	{
		word: "mutating",
		plural: "mutating",
		bannedFor: "Write/delete tool call",
		replacement: "write/delete tool call",
		// TanStack Query's count of requests under way.
		otherMeanings: /useIsMutating|isMutating/g,
	},
	{
		word: "spill file",
		plural: "spill files",
		bannedFor: "Long tool result",
		replacement: "long tool result",
	},
	{ word: "rerun", plural: "reruns", bannedFor: "Retry", replacement: "retry" },

	// Errors
	{ word: "error id", plural: "error ids", bannedFor: "Reference id", replacement: "reference id" },
	{
		word: "incident number",
		plural: "incident numbers",
		bannedFor: "Reference id",
		replacement: "reference id",
	},
	{
		word: "wire error",
		plural: "wire errors",
		bannedFor: "Public error",
		replacement: "public error",
	},
	{
		word: "third-party error",
		plural: "third-party errors",
		bannedFor: "Upstream error",
		replacement: "upstream error",
	},
	{
		word: "display message",
		plural: "display messages",
		bannedFor: "User message",
		replacement: "user message",
	},
];

const CHECKED_WORDS: readonly CheckedWord[] = [...RETIRED_WORDS, ...BANNED_SYNONYMS];

/** Tracked files that keep old words on purpose, or aren't ours to edit. */
const SKIPPED_PATHS: readonly RegExp[] = [
	/^GLOSSARY\.md$/,
	/^lint\/check-glossary\.ts$/,
	/^packages\/core\/drizzle\//,
	/^packages\/emoji\/src\/emoji\.json$/,
	/(^|\/)bun\.lock$/,
	/\.(svg|png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|mp4|webm)$/,
];

/**
 * The word as a whole word or as one part of an identifier: `pod`, `pods`,
 * `podId`, `isPod`, `PodComputers`, `pod_id` and `POD_ID`, but not `tripod`
 * or `podcast`. A word of several, such as "main chat", is matched with its
 * parts apart or joined as an identifier joins them: `main chat`, `main-chat`,
 * `mainChat`, `MainChat` and `MAIN_CHAT`. One led by an acronym is matched
 * with the acronym in capitals too: `MCP tool`, `MCPTool` and `LLM provider`.
 */
function wordPattern({ word, plural }: CheckedWord): RegExp {
	const forms = (casing: (part: string) => string, joinings: (part: string) => string[]) =>
		[plural, word]
			.map((phrase) => {
				const [first = "", ...rest] = phrase.split(" ");
				return casing(first) + rest.map((part) => `(?:${joinings(part).join("|")})`).join("");
			})
			.join("|");
	const lower = forms(
		(part) => part,
		(part) => [`[ _-]${part}`, `[ _-]?${capitalise(part)}`],
	);
	const capitalised = forms(capitalise, (part) => [`[ _-]${part}`, `[ _-]?${capitalise(part)}`]);
	const upper = forms(
		(part) => part.toUpperCase(),
		(part) => [`[ _-]?${part.toUpperCase()}`],
	);
	const acronymLed = forms(
		(part) => part.toUpperCase(),
		(part) => [`[ _-]${part}`, `[ _-]?${capitalise(part)}`],
	);
	return new RegExp(
		[
			`(?<![A-Za-z])(?:${lower})(?![a-z])`,
			`(?<![A-Z])(?:${capitalised})(?![a-z])`,
			`(?<![A-Za-z])(?:${upper})(?![A-Za-z])`,
			`(?<![A-Za-z])(?:${acronymLed})(?![a-z])`,
		].join("|"),
		"g",
	);
}

function capitalise(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "retired", or what the word is a banned synonym of. */
function describe({ bannedFor }: CheckedWord): string {
	return bannedFor === undefined ? "retired" : `banned for ${bannedFor}`;
}

interface Finding {
	readonly path: string;
	readonly line: number;
	readonly text: string;
}

function findingsOf(checked: CheckedWord, files: ReadonlyMap<string, string>): Finding[] {
	const pattern = wordPattern(checked);
	const findings: Finding[] = [];
	for (const [path, contents] of files) {
		if (checked.keptIn?.some((kept) => kept.test(path))) continue;
		contents.split("\n").forEach((text, index) => {
			const kept = checked.otherMeanings ? text.replace(checked.otherMeanings, "") : text;
			for (const _match of kept.matchAll(pattern)) {
				findings.push({ path, line: index + 1, text: text.trim() });
			}
		});
	}
	return findings;
}

/** `packages/core/src/x.ts` is in `packages/core`; a file at the root is in `.`. */
function areaOf(path: string): string {
	const [first, second] = path.split("/");
	if (second === undefined) return ".";
	return first === "packages" || first === "apps" ? `${first}/${second}` : first;
}

function trackedFiles(): Map<string, string> {
	const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
		.split("\0")
		// A tracked file deleted in the working tree has nothing left to check.
		.filter(
			(path) =>
				path !== "" && !SKIPPED_PATHS.some((skipped) => skipped.test(path)) && existsSync(path),
		);
	return new Map(paths.map((path) => [path, readFileSync(path, "utf8")]));
}

function printReport(checked: CheckedWord, findings: readonly Finding[]): void {
	const byArea = new Map<string, number>();
	for (const { path } of findings) {
		const area = areaOf(path);
		byArea.set(area, (byArea.get(area) ?? 0) + 1);
	}
	console.log(
		`${checked.word} (${describe(checked)}) → ${checked.replacement}: ${findings.length}`,
	);
	for (const [area, count] of [...byArea].sort(([, a], [, b]) => b - a)) {
		console.log(`  ${String(count).padStart(6)}  ${area}`);
	}
}

const report = process.argv.includes("--report");
const files = trackedFiles();
let failed = false;
for (const checked of CHECKED_WORDS) {
	const findings = findingsOf(checked, files);
	if (report) printReport(checked, findings);
	if (findings.length === 0) continue;
	failed = true;
	console.error(
		`"${checked.word}" is ${describe(checked)}; GLOSSARY.md says to use ${checked.replacement}:`,
	);
	for (const { path, line, text } of findings) console.error(`  ${path}:${line}  ${text}`);
}
process.exitCode = failed ? 1 : 0;
