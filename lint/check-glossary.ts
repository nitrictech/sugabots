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
 * "user" (HTTP's user agent, a user message), "member" (a project member),
 * "workspace bot" and "internal bot" (any bot in the workspace, and a made-up
 * project's name), "done" and "archived" alone (only their names for a chat's
 * state are checked), "activity" (the workflow engine's word for a step),
 * "streaming" and "reasoning" (the model providers' and the event stream's),
 * "template" and "snapshot" (E2B's and Playwright's), "volume" (Docker's),
 * "VNC" (the desktop's protocol), "callback", "endpoint" and "hook" (OAuth's,
 * HTTP's, and React's and better-auth's hooks), "sender" (an email's),
 * "condition" (a query's), "system prompt" and "function call" (a model
 * provider's API), "health check" (the server's health address),
 * "organisation" (GitHub's), "spec", "routing", "dispatch" and "busy". So are
 * "item" (a list's, a menu's and a chat's timeline's), "marker" and "badge"
 * (a list's and a day's markers; a count badge), "seen", "subject", "app"
 * (the web app, a GitHub app), "look" and "icon" (a file's, a button's) and
 * "sidebar": only their compound names for a nested chat, an attention mark,
 * a chat's status, a tool source and a mark are checked.
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

/** Migrations by their names, which keep the words they were written with. */
const MIGRATION_NAME = /\b\d{14}_[a-z0-9_]+/g;

/** The glossary's Retired terms: words for things that no longer exist. */
const RETIRED_WORDS: readonly CheckedWord[] = [
	{
		word: "pod",
		plural: "pods",
		replacement: "project, or the bot",
		// Migrations by their names, and Apple's iPod.
		otherMeanings: /\b\d{14}_[a-z0-9_]+|iPod/g,
	},
	{ word: "crew", plural: "crews", replacement: "the project's bots" },
	{
		word: "channel",
		plural: "channels",
		replacement: "project",
		// Others' channels: Slack's, and its `@channel`, which a person writes to
		// mention everyone in a chat; the browser's MessageChannel; the
		// Postgres notification channel; Xfce's settings channels. And
		// migrations by their names.
		otherMeanings:
			/@channel|"here", "channel"|handle: "channel"|name: "Channel"|\[\["channel", "reviewer"\]\]|`here` or `channel`|"here and channel"|Slack's channel|per channel\.|MessageChannel|NOTIFY_CHANNEL|notification channel|perchannel|\b\d{14}_[a-z0-9_]+/g,
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
		// Others' agents: the HTTP user agent, coding agents and their
		// AGENTS.md, crawlers and AI agents generally, and SSH's and GPG's.
		otherMeanings:
			/user[-_ ]?agents?|AGENTS\.md|AI agents?|your[- ]agent|(?:ssh|gpg)-agent|SSH and GPG agents/gi,
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
		replacement: "the Personal Assistant, which tells a person what needs their attention",
		// An email inbox: the one a sign-up link is sent to, and the ones bots
		// in examples sort. And migrations by their names.
		otherMeanings:
			/(?:in|[Ss]ort|[Ss]orts|[Ss]orting) (?:its|the) inbox|(?:support|shared) inbox|inbox sweep|Inbox (?:Sorter|Manager|triage)|inboxSorter|read_inbox|\b\d{14}_[a-z0-9_]+/g,
	},
	{
		word: "direct message",
		plural: "direct messages",
		replacement: "a project's chat, or a bot's",
	},
];

/** Banned synonyms: words for something the glossary names otherwise. */
const BANNED_SYNONYMS: readonly CheckedWord[] = [
	// People and the workspace
	{ word: "tenant", plural: "tenants", bannedFor: "Workspace", replacement: "workspace" },
	{
		word: "workspace member",
		plural: "workspace members",
		bannedFor: "Person",
		replacement: "membership, or a person in the workspace",
	},
	{
		word: "session user",
		plural: "session users",
		bannedFor: "Person",
		replacement: "signed-in person",
	},
	{
		word: "current user",
		plural: "current users",
		bannedFor: "Signed-in person",
		replacement: "signed-in person",
	},
	{ word: "snooze", plural: "snoozed", bannedFor: "Notification pause", replacement: "pause" },
	{
		word: "do not disturb",
		plural: "do not disturb",
		bannedFor: "Notification pause",
		replacement: "notification pause, or quiet hours",
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
	{
		word: "invite link",
		plural: "invite links",
		bannedFor: "Referral link",
		replacement: "referral link",
	},
	{
		word: "onboarding",
		plural: "onboardings",
		bannedFor: "Workspace setup",
		replacement: "workspace setup, or a bot's interview",
		// A customer's onboarding, in the showcase's made-up chats.
		otherMeanings: /onboarding call/g,
	},
	{
		word: "log in",
		plural: "logged in",
		bannedFor: "Sign in",
		replacement: "sign in",
		// GitHub's login, which names an account there.
		otherMeanings: /BOT_LOGIN/g,
		// Signing in to a computer's desktop, which is the desktop's own login.
		keptIn: [/^packages\/server\/src\/http\/desktop-viewer(\.test)?\.ts$/],
	},
	{
		word: "log out",
		plural: "logged out",
		bannedFor: "Sign out",
		replacement: "sign out",
		// lucide's icon of that name.
		otherMeanings: /\bLogOut\b/g,
	},
	{ word: "sysadmin", plural: "sysadmins", bannedFor: "Operator", replacement: "operator" },

	// Bots
	{
		word: "personal bot",
		plural: "personal bots",
		bannedFor: "Private bot",
		replacement: "private bot",
	},
	{ word: "shared bot", plural: "shared bots", bannedFor: "Public bot", replacement: "public bot" },
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
		word: "model trial",
		plural: "model trials",
		bannedFor: "Model test",
		replacement: "model test",
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
		bannedFor: "Built-in provider",
		replacement: "built-in provider, or built-in connector",
		// Others' presets: Biome's rules and ffmpeg's encoder speed.
		otherMeanings: /"preset": "recommended"|"-preset",/g,
	},
	{
		word: "provider catalog",
		plural: "provider catalogs",
		bannedFor: "Built-in provider",
		replacement: "built-in providers",
	},
	{
		word: "catalog entry",
		plural: "catalog entries",
		bannedFor: "Built-in provider",
		replacement: "built-in provider, or built-in connector",
		// A tool that tool search can find, in the turn's catalog of them.
		otherMeanings: /CatalogEntry/g,
	},
	{
		word: "model sync",
		plural: "model syncs",
		bannedFor: "Model discovery",
		replacement: "model discovery",
	},
	{
		word: "custom endpoint",
		plural: "custom endpoints",
		bannedFor: "Custom model provider",
		replacement: "custom model provider",
	},
	{
		word: "deferred tool",
		plural: "deferred tools",
		bannedFor: "Tool search",
		replacement: "tool search",
	},
	{
		word: "token limit",
		plural: "token limits",
		bannedFor: "Context window",
		replacement: "context window",
	},

	// Projects and chats
	{
		word: "thread",
		plural: "threads",
		bannedFor: "Chat",
		replacement: "chat",
		otherMeanings: MIGRATION_NAME,
	},
	{
		word: "conversation",
		plural: "conversations",
		bannedFor: "Chat",
		replacement: "chat",
		otherMeanings: MIGRATION_NAME,
	},
	{ word: "default bot", plural: "default bots", bannedFor: "Lead bot", replacement: "lead bot" },
	{
		word: "home project",
		plural: "home projects",
		bannedFor: "Default project",
		replacement: "default project",
	},
	{
		word: "pending message",
		plural: "pending messages",
		bannedFor: "Queued message",
		replacement: "queued message",
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
	{ word: "decider", plural: "deciders", bannedFor: "Approver", replacement: "approver" },
	{
		word: "details sidebar",
		plural: "details sidebars",
		bannedFor: "Details panel",
		replacement: "details panel",
	},
	{
		word: "info panel",
		plural: "info panels",
		bannedFor: "Details panel",
		replacement: "details panel",
	},
	{ word: "topic name", plural: "topic names", bannedFor: "Chat title", replacement: "chat title" },
	{ word: "chat type", plural: "chat types", bannedFor: "Chat kind", replacement: "chat kind" },
	// A nested chat by its old name: the `?item=` it opened by, `markItemRead`,
	// `ItemPanel` and `ItemChatPage`.
	{ word: "item chat", plural: "item chats", bannedFor: "Nested chat", replacement: "nested chat" },
	{
		word: "item panel",
		plural: "item panels",
		bannedFor: "Nested chat",
		replacement: "nested chat panel",
	},
	{
		word: "item page",
		plural: "item pages",
		bannedFor: "Nested chat",
		replacement: "nested chat page",
	},
	{
		word: "item read",
		plural: "items read",
		bannedFor: "Nested chat",
		replacement: "nested chat read",
	},
	{ word: "sub chat", plural: "sub chats", bannedFor: "Nested chat", replacement: "nested chat" },
	{ word: "subchat", plural: "subchats", bannedFor: "Nested chat", replacement: "nested chat" },
	{
		word: "read receipt",
		plural: "read receipts",
		bannedFor: "Read state",
		replacement: "read state",
	},
	{
		word: "listed chat activity",
		plural: "listed chat activities",
		bannedFor: "Chat status",
		replacement: "chat status",
	},
	{
		word: "project marker",
		plural: "project markers",
		bannedFor: "Attention mark",
		replacement: "attention mark",
	},
	{
		word: "chat marker",
		plural: "chat markers",
		bannedFor: "Attention mark",
		replacement: "attention mark",
	},

	// A project's resources
	{
		word: "connection",
		plural: "connections",
		bannedFor: "Connector",
		replacement: "connector, or a provider's provider access",
		// Other connections: a socket's, an HTTP request's and its `Connection`
		// header, a WebSocket's, a database's and its pool's, the event
		// stream's, and the computer providers' SDKs' own. And migrations by
		// their names.
		otherMeanings:
			/closeAllConnections|max_connections|maxConnections|connectionString|connection string|pg-connection-string|proxy-connection|\$connection_upgrade|proxy_set_header Connection|"Connection",|ProviderConnectionLost|CONNECTION_DROPPED|ConnectionConfig|connectionConfig|ConnectionOpts|Connections Sugabots makes|viewer's connection|per connection|No connection to|connection never made|dead connection|same connection|(?:[Cc]heck|lost|dropped|refused|open|first|desktop viewer's|hidden page's) (?:the |your )?connection|connection (?:drops|dropped|refused|ended|open|could be made|is made|to (?:one|any other host|the browser|\$\{)|holds the computer awake|pool)|(?:A|a) connection (?:to|holds)|One connection|ended a connection|held connection|\b\d{14}_[a-z0-9_]+/g,
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
			/^packages\/server\/src\/(?:auth\/authentication|workflows)\.ts$/,
			/^packages\/sdk\/src\/events(?:\.test)?\.ts$/,
			/^packages\/docs\/content\/(?:configuration|deploy-with-docker)\.mdx$/,
			/^packages\/website\/scripts\/capture\/environment\.ts$/,
			/^packages\/web\/vite\.config\.ts$/,
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
		word: "connector look",
		plural: "connector looks",
		bannedFor: "Mark",
		replacement: "mark, or a marked connector",
	},
	{
		word: "approval app",
		plural: "approval apps",
		bannedFor: "Tool source",
		replacement: "tool source",
	},
	{
		word: "home directory",
		plural: "home directories",
		bannedFor: "Home folder",
		replacement: "home folder",
	},
	{
		word: "take control",
		plural: "took control",
		bannedFor: "Computer take over",
		replacement: "take over",
	},
	{
		word: "remote control",
		plural: "remote controls",
		bannedFor: "Computer take over",
		replacement: "take over",
	},
	{
		word: "internet access",
		plural: "internet access",
		bannedFor: "Web access",
		replacement: "web access",
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
 * `mainChat`, `MainChat` and `MAIN_CHAT`.
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
	return new RegExp(
		[
			`(?<![A-Za-z])(?:${lower})(?![a-z])`,
			`(?<![A-Z])(?:${capitalised})(?![a-z])`,
			`(?<![A-Za-z])(?:${upper})(?![A-Za-z])`,
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
