import { NodeRuntime } from "@effect/platform-node";
import type {
	BotColor,
	BotEyes,
	BotShape,
	BuiltInProviderId,
	NewAutomation,
	ProjectColor,
} from "@sugabots/contracts";
import { API_BASE_PATH } from "@sugabots/contracts/http";
import { SessionAuthentication } from "@sugabots/core/authentication/session";
import { BlobStore } from "@sugabots/core/blob-store/blob-store";
import { ProjectAutomations } from "@sugabots/core/chats/automations/project-automations";
import { AutomationRuns } from "@sugabots/core/chats/automations/runs";
import { ChatEvents } from "@sugabots/core/chats/chat-events";
import { ComputerSignIn } from "@sugabots/core/computers/computer-sign-in";
import { layer as databaseLayer, query } from "@sugabots/core/database/database";
import { EventOutbox } from "@sugabots/core/database/events/outbox";
import {
	automationTrigger,
	bot as botTable,
	member,
	modelProvider,
	modelRequest,
	project,
	providerModel,
	workspace,
	workspaceDefaultModel,
} from "@sugabots/core/database/schema";
import { Email } from "@sugabots/core/email/email";
import { Ids } from "@sugabots/core/ids/ids";
import { automationsOperations } from "@sugabots/core/operations/automations/index";
import type { MemberSession } from "@sugabots/core/principal";
import { ModelProviderStore } from "@sugabots/core/providers/model-providers/model-provider-store";
import { Egress } from "@sugabots/core/providers/network/egress";
import { SearchProviderStore } from "@sugabots/core/providers/search-providers/search-provider-store";
import { Secrets } from "@sugabots/core/secrets/secrets";
import { ServerSettings } from "@sugabots/core/server-settings/server-settings";
import { unimplemented } from "@sugabots/core/testing";
import { processLayer } from "@sugabots/core/tiers";
import { BotStore } from "@sugabots/core/workspaces/bots/bot-store";
import { PersonalAssistants } from "@sugabots/core/workspaces/bots/personal-assistants";
import { Membership } from "@sugabots/core/workspaces/membership/membership";
import { defaultProjectOf } from "@sugabots/core/workspaces/projects/project-reads";
import { ProjectStore } from "@sugabots/core/workspaces/projects/project-store";
import { WorkspaceSetup } from "@sugabots/core/workspaces/workspace-setup/workspace-setup";
import { userText } from "@sugabots/errors";
import { Authentication } from "@sugabots/server/auth/authentication";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { ensureAccount, seedAccountsLayer } from "../accounts.ts";
import {
	type AutomationRun,
	type BotChatScene,
	ensureChats,
	ensureConnectors,
	type ProjectChatScene,
	type SeedConnector,
	SUPPORT_HANDOVER_CHAT,
} from "./chats.ts";
import { QUEUE_REPORT, QUEUE_REPORT_TITLE } from "./queue-report.ts";

/**
 * Showcase seed: Fieldnote, a small company with the members, projects and
 * bots the website's screenshots and demo video show. Run it with
 * `bun run db:seed:showcase`, against a migrated database.
 *
 * Everyone signs in with `PASSWORD`, and has an Unsplash portrait for a face.
 * Anita owns the workspace; sign in as her.
 *
 * Anita made every bot. The team's bots are public, each added to the
 * project whose work it does and pinned for that project's members; her own
 * two are private. The chats come already written (see
 * `chats.ts`): members talking in the projects' chats and the
 * bots they mention answering there, chats members started with a bot, a
 * file, and automation runs. Support's chat holds only the
 * morning's handover, where the demo's story starts (see `stage.ts`). Each
 * project's bots get its connectors too, signed out.
 *
 * Each bot goes on the first model the workspace offers that it prefers,
 * else the workspace's default. A new workspace offers none, so connect
 * providers in Settings and run this again to move the bots onto them.
 *
 * It also fills the ledger with six weeks of model requests, so the Usage
 * page has a history. Those rows have no turn, which is how a later run
 * knows they are there.
 *
 * Its automations show as on but are held a year from running, since they would
 * otherwise run on their timetables and fail without a model.
 *
 * Every step is idempotent, so it can be run again over its own data.
 */

const PASSWORD = "showcase";
const WORKSPACE = { name: "Fieldnote", slug: "fieldnote" };

type MemberKey = "anita" | "gary" | "lorraine" | "doreen" | "rob";

/** Anita owns the workspace, which puts her in every project members made. */
const OWNER: MemberKey = "anita";

/**
 * A face from Unsplash, free to use under the Unsplash License, cropped to it
 * by Unsplash's image service. The comment by each names its photographer.
 */
const unsplashPortrait = (photo: string) =>
	`https://images.unsplash.com/${photo}?w=256&h=256&fit=crop&crop=faces&auto=format`;

const MEMBERS: Record<MemberKey, { name: string; email: string; image: string }> = {
	// Pargat Dhillon, unsplash.com/photos/lUwb63aNXoM
	anita: {
		name: "Anita Bhatt",
		email: "anita@fieldnote.test",
		image: unsplashPortrait("photo-1624610262404-e6530e871c17"),
	},
	// Dylan Ferreira, unsplash.com/photos/jIM8kVsFKlM
	gary: {
		name: "Gary Lum",
		email: "gary@fieldnote.test",
		image: unsplashPortrait("photo-1579420593648-0deba81fd762"),
	},
	// Jose G. Ortega Castro, unsplash.com/photos/3uYHxJ7sd2w
	lorraine: {
		name: "Lorraine Delgado",
		email: "lorraine@fieldnote.test",
		image: unsplashPortrait("photo-1581322929625-f4aab333778a"),
	},
	// Vitaly Gariev, unsplash.com/photos/1B6u5vhDxJU
	doreen: {
		name: "Doreen Nakamura",
		email: "doreen@fieldnote.test",
		image: unsplashPortrait("photo-1790574340486-1ea958f106aa"),
	},
	// Josias Garibay, unsplash.com/photos/rifCUO-4X8k
	rob: {
		name: "Rob Mendoza",
		email: "rob@fieldnote.test",
		image: unsplashPortrait("photo-1757744705465-ea08b0ddc38a"),
	},
};

type ProjectKey = "growth" | "support" | "engineering";

const PROJECTS: Record<
	ProjectKey,
	{ name: string; color: ProjectColor; members: readonly MemberKey[] }
> = {
	growth: { name: "Growth", color: "green", members: ["gary", "lorraine"] },
	support: { name: "Support", color: "blue", members: ["lorraine", "doreen"] },
	engineering: { name: "Engineering", color: "plum", members: ["gary", "rob"] },
};

/**
 * A model a bot would like to be on: the provider it comes from, how to
 * recognise it among what that provider lists, the id the ledger records its
 * past requests under, and what it charges in US dollars per million tokens.
 * Subscription and local providers charge nothing.
 */
interface ModelChoice {
	builtIn: BuiltInProviderId;
	matches: RegExp;
	ledgerModel: string;
	usdPerMillion: { input: number; output: number };
}

const CLAUDE_SONNET: ModelChoice = {
	builtIn: "anthropic",
	matches: /^claude-sonnet/,
	ledgerModel: "claude-sonnet-4-5",
	usdPerMillion: { input: 3, output: 15 },
};
const CLAUDE_HAIKU: ModelChoice = {
	builtIn: "anthropic",
	matches: /^claude-haiku/,
	ledgerModel: "claude-haiku-4-5",
	usdPerMillion: { input: 1, output: 5 },
};
const CHATGPT: ModelChoice = {
	builtIn: "chatgpt",
	matches: /^gpt-5/,
	ledgerModel: "gpt-5",
	usdPerMillion: { input: 0, output: 0 },
};
const OPENAI_MINI: ModelChoice = {
	builtIn: "openai",
	matches: /^gpt-5.*mini/,
	ledgerModel: "gpt-5-mini",
	usdPerMillion: { input: 0.25, output: 2 },
};
const GEMINI_FLASH: ModelChoice = {
	builtIn: "gemini",
	matches: /gemini-.*flash/,
	ledgerModel: "gemini-2.5-flash",
	usdPerMillion: { input: 0.3, output: 2.5 },
};
const OLLAMA_LLAMA: ModelChoice = {
	builtIn: "ollama",
	matches: /^llama/,
	ledgerModel: "llama3.2",
	usdPerMillion: { input: 0, output: 0 },
};
/** Claude through OpenRouter, for a workspace that reaches Anthropic that way. */
const OPENROUTER_CLAUDE: ModelChoice = {
	builtIn: "openrouter",
	matches: /^anthropic\/claude-(sonnet|haiku)/,
	ledgerModel: "anthropic/claude-sonnet-4.5",
	usdPerMillion: { input: 3, output: 15 },
};

interface SeedBot {
	name: string;
	/** The project a public bot is in; a personal bot, only Anita's, is in none. */
	project: ProjectKey | "personal";
	color: BotColor;
	eyes: BotEyes;
	shape: BotShape;
	description: string;
	instructions: string;
	/** In order of preference; the first is what the ledger's history is on. */
	models: readonly [ModelChoice, ...ModelChoice[]];
	usesComputer?: boolean;
	/** Roughly how many model requests it makes on a weekday, for the ledger. */
	requestsPerWeekday: number;
}

const BOTS: readonly SeedBot[] = [
	{
		name: "Growth Desk",
		project: "growth",
		color: "green",
		eyes: "pill",
		shape: "leaf",
		description: "Answers pricing and renewal questions for the sales team.",
		instructions:
			"You help Fieldnote's sales team answer customers about pricing, renewals and discounts. Keep replies short and ready to send. When a discount or a custom quote comes up, ask Pricing Analyst to check the margin before you agree to anything.",
		models: [CLAUDE_SONNET, OPENROUTER_CLAUDE],
		requestsPerWeekday: 34,
	},
	{
		name: "Pricing Analyst",
		project: "growth",
		color: "sky",
		eyes: "square",
		shape: "hexagon",
		description: "Checks discounts against margin and drafts quotes.",
		instructions:
			"You check proposed discounts against Fieldnote's margins and draft quotes. List tiers are Team at $24 per seat a month and Business at $48, with annual plans at 15% off. Never let gross margin fall below 70%. Say plainly whether a deal clears and give the quote number when you draft one.",
		models: [OPENAI_MINI, CLAUDE_SONNET, OPENROUTER_CLAUDE],
		requestsPerWeekday: 12,
	},
	{
		name: "Copywriter",
		project: "growth",
		color: "orange",
		eyes: "arc",
		shape: "blob",
		description: "Drafts replies, posts and invites.",
		instructions:
			"You write for Fieldnote: customer replies, launch posts, newsletters and event invites. Plain, warm and short. Offer one draft, not three, and say what you'd cut if it needs to be shorter.",
		models: [CHATGPT, CLAUDE_SONNET, OPENROUTER_CLAUDE],
		requestsPerWeekday: 22,
	},
	{
		name: "Ticket Desk",
		project: "support",
		color: "purple",
		eyes: "dot",
		shape: "circle",
		description: "Works the support queue and handles refunds.",
		instructions:
			"You work Fieldnote's support queue. Find the customer, read their history, and either answer or hand the ticket to the right member in the project. Refunds go through Stripe: before you issue one, state the customer, the amount and the reason. When a billing problem needs explaining, ask Billing Engineer why it happened.",
		models: [CLAUDE_HAIKU, OPENROUTER_CLAUDE],
		requestsPerWeekday: 41,
	},
	{
		name: "Inbox Sorter",
		project: "support",
		color: "yellow",
		eyes: "pill",
		shape: "squircle",
		description: "Triage, reminders and quick jobs.",
		instructions:
			"You sort the support inbox. Label each email as bug, billing, how-to or sales, flag anything urgent, and post a short list of what needs a member today.",
		models: [GEMINI_FLASH, CLAUDE_HAIKU, OPENROUTER_CLAUDE],
		requestsPerWeekday: 28,
	},
	{
		name: "Billing Engineer",
		project: "support",
		color: "red",
		eyes: "square",
		shape: "antenna",
		description: "Digs into billing bugs on its computer.",
		instructions:
			"You find out why billing went wrong for a customer. Reproduce it on your computer against the billing code, run the tests, and say plainly what caused it and what fixes it. Open a pull request with the fix, and write the incident up for the team.",
		models: [CLAUDE_SONNET, OPENROUTER_CLAUDE],
		usesComputer: true,
		requestsPerWeekday: 7,
	},
	{
		name: "Code Reviewer",
		project: "engineering",
		color: "rose",
		eyes: "wink",
		shape: "octagon",
		description: "Reviews pull requests and runs the tests on its computer.",
		instructions:
			"You review Fieldnote's pull requests. Check out the branch on your computer, run the tests, and reply with what fails, what's risky and what you'd change. Lead with the one thing that matters most.",
		models: [CLAUDE_SONNET, OPENROUTER_CLAUDE],
		usesComputer: true,
		requestsPerWeekday: 18,
	},
	{
		name: "Researcher",
		project: "engineering",
		color: "ice",
		eyes: "arc",
		shape: "drop",
		description: "Reads the long stuff so you don't have to.",
		instructions:
			"You read papers, docs, changelogs and long chats for the engineering team, and summarise what matters for Fieldnote. Quote the source for every claim. Use your computer to try code samples before recommending them.",
		models: [CLAUDE_SONNET, OPENROUTER_CLAUDE],
		usesComputer: true,
		requestsPerWeekday: 9,
	},
	{
		name: "Journal",
		project: "personal",
		color: "teal",
		eyes: "dot",
		shape: "pebble",
		description: "Private notes that stay private.",
		instructions:
			"You keep Anita's private work journal. When she writes, file it under the day, and when she asks, remind her what she noted before. Never suggest sharing anything from here.",
		models: [OLLAMA_LLAMA],
		requestsPerWeekday: 6,
	},
	{
		name: "Trip Planner",
		project: "personal",
		color: "sky",
		eyes: "pill",
		shape: "dome",
		description: "Plans trips and keeps the bookings in one place.",
		instructions:
			"You plan Anita's work trips: flights, hotels near the venue, and a day-by-day plan. Keep every booking reference in one list she can find again.",
		models: [GEMINI_FLASH, CLAUDE_HAIKU, OPENROUTER_CLAUDE],
		requestsPerWeekday: 3,
	},
];

const minutes = (hours: number, minutesPastHour = 0) => hours * 60 + minutesPastHour;

const AUTOMATIONS: readonly { bot: string; automation: NewAutomation }[] = [
	{
		bot: "Growth Desk",
		automation: {
			name: "Renewal risk check",
			instructions:
				"Each morning, look through HubSpot for renewals in the next 30 days with falling usage, and list them with what to do about each.",
			triggers: [daily([minutes(8)])],
		},
	},
	{
		bot: "Growth Desk",
		automation: {
			name: "Monday pipeline summary",
			instructions:
				"Summarise last week's deals: what closed, what slipped and what needs a reply today.",
			triggers: [weekly(["mon"], [minutes(9)])],
		},
	},
	{
		bot: "Ticket Desk",
		automation: {
			name: "Morning queue",
			instructions:
				"Go through the tickets that came in overnight. Answer what you can and list what needs a member, oldest first.",
			triggers: [weekly(["mon", "tue", "wed", "thu", "fri"], [minutes(8, 30)])],
		},
	},
	{
		bot: "Inbox Sorter",
		automation: {
			name: "Inbox triage",
			instructions: "Label the new support emails and flag anything urgent.",
			triggers: [daily([minutes(7), minutes(13)])],
		},
	},
	{
		bot: "Code Reviewer",
		automation: {
			name: "Review new pull requests",
			instructions:
				"A pull request was opened or updated. Review it, run the tests, and post what you find.",
			triggers: [{ kind: "webhook", auth: { kind: "github" } }],
		},
	},
	{
		bot: "Researcher",
		automation: {
			name: "Friday dependency digest",
			instructions:
				"Read this week's release notes for our main dependencies and summarise anything that affects us.",
			triggers: [weekly(["fri"], [minutes(15)])],
		},
	},
	{
		bot: "Journal",
		automation: {
			name: "End-of-day prompt",
			instructions: "Ask Anita what went well today and what's still on her mind.",
			state: "paused",
			triggers: [daily([minutes(18)])],
		},
	},
];

/**
 * What the projects' members said in their chats, and what the bots they
 * mentioned answered there. Times are on the morning of the day they happen
 * (see `chats.ts`). Support's chat has only the morning's handover,
 * where the demo's story starts.
 */
const PROJECT_CHATS: readonly ProjectChatScene<MemberKey>[] = [
	{
		project: "growth",
		chat: "Pipeline",
		messages: [
			{
				at: { time: "9:02" },
				from: { member: "lorraine" },
				parts: [{ text: "Morning! Pipeline review has moved to 2pm today." }],
			},
			{
				at: { time: "10:40" },
				from: { member: "lorraine" },
				parts: [{ text: "@copywriter Can you draft a short post announcing invoices in AUD?" }],
			},
			{
				at: { time: "10:41" },
				from: { bot: "Copywriter" },
				parts: [
					{
						text: "**Invoices in Australian dollars**\n\nFieldnote now bills in AUD. Teams in Australia can switch their currency in Settings → Billing, and their next invoice arrives in dollars they don't have to convert. No new plan, no price change, just one less line on your bank statement.\n\nIf it needs to be shorter, I'd cut the last sentence.",
					},
				],
				reactions: [{ emoji: "❤️", by: ["lorraine"] }],
			},
			{
				at: { time: "10:52" },
				from: { member: "gary" },
				parts: [{ text: "Brightwater signed! Quote's accepted, 40 seats annual." }],
				reactions: [{ emoji: "🎉", by: ["lorraine", "anita"] }],
			},
			{
				at: { time: "10:55" },
				from: { member: "lorraine" },
				parts: [{ text: "Great work. I'll book their onboarding call for next week." }],
			},
		],
	},
	{
		project: "engineering",
		chat: "Export queue",
		messages: [
			{
				at: { time: "9:40" },
				from: { member: "rob" },
				parts: [{ text: "The new export queue is live on staging." }],
				reactions: [{ emoji: "🚀", by: ["gary"] }],
			},
			{
				at: { time: "10:20" },
				from: { member: "rob" },
				parts: [
					{
						text: "@code-reviewer Can you review PR #482 before I merge? It moves the export job onto the new queue.",
					},
				],
			},
			{
				at: { time: "10:26" },
				from: { bot: "Code Reviewer" },
				parts: [
					{
						text: "Reviewed #482 and ran the tests on my computer: 212 passed, 1 failed.\n\n**Fix before merging**\n- `export.test.ts` fails: the job now retries 5 times, but the test still expects 3.\n\n**Worth a look**\n- `ExportJob.run` sets no timeout, so a stuck export holds a worker for good.\n- The queue name is written out in two places. A constant would keep them in step.\n\nThe rest looks good, and the new retry backoff is a clear improvement.",
					},
				],
				reactions: [{ emoji: "👀", by: ["gary"] }],
			},
			{
				at: { time: "10:31" },
				from: { member: "rob" },
				parts: [{ text: "Good catch on the timeout. Fixing both now." }],
			},
		],
	},
	{
		project: "support",
		chat: SUPPORT_HANDOVER_CHAT,
		messages: [
			{
				at: { time: "8:41" },
				from: { member: "doreen" },
				parts: [
					{
						text: "Morning queue's in. Brightline can't sign in since the SSO change, so I'm taking that one.",
					},
				],
			},
			{
				at: { time: "8:44" },
				from: { member: "lorraine" },
				parts: [
					{
						text: "Thanks. Kestrel Freight says they were charged twice on 3 Oct, so that needs a refund today.",
					},
				],
			},
		],
	},
];

/**
 * Chats members started with a bot. Anyone who can see the bot can read them
 * and join in, as Lorraine does in Gary's.
 */
const BOT_CHATS: readonly BotChatScene<MemberKey>[] = [
	{
		bot: "Growth Desk",
		messages: [
			{
				at: { time: "9:12" },
				from: { member: "gary" },
				parts: [{ text: "Fernhill Outfitters replied about pricing. Can you draft the answer?" }],
			},
			{
				key: "fernhill-draft",
				at: { time: "9:13" },
				from: { bot: "Growth Desk" },
				parts: [
					{
						text: "Drafted. Their usage is up 40% since March, so I've led with Business:\n\n> Hi Dana, thanks for coming back to us. With 32 members now using Fieldnote every week, Business is the better fit: SSO, audit logs and priority support at $48 a seat, or $40.80 on an annual plan. Happy to walk your team through it this week.\n\nWant me to send it from the shared inbox?",
					},
				],
				reactions: [{ emoji: "👍", by: ["anita", "lorraine"] }],
			},
			{
				at: { time: "9:15" },
				from: { member: "lorraine" },
				replyTo: "fernhill-draft",
				parts: [{ text: "Hold it until I've spoken to their team tomorrow." }],
			},
			{
				at: { time: "9:16" },
				from: { member: "gary" },
				parts: [{ text: "Makes sense. I'll leave it in drafts." }],
			},
			{
				at: { time: "9:20" },
				from: { member: "anita" },
				parts: [
					{
						text: "Before Lorraine's call, can you pull together what we know about Fernhill? Seats, usage, anything open.",
					},
				],
			},
			{
				key: "fernhill-brief",
				at: { time: "9:21" },
				from: { bot: "Growth Desk" },
				parts: [
					{ text: "Pulling their account and deals from HubSpot, and checking their site.\n\n" },
					{
						toolCall: {
							connector: "hubspot",
							tool: "search_companies",
							input: { query: "Fernhill Outfitters" },
							output: {
								results: [
									{
										id: "18842",
										name: "Fernhill Outfitters",
										domain: "fernhilloutfitters.co.nz",
										plan: "Team",
										seats: 25,
									},
								],
							},
							readOnly: true,
						},
					},
					{
						toolCall: {
							connector: "hubspot",
							tool: "search_deals",
							input: { companyId: "18842", stage: "open" },
							output: {
								results: [
									{
										name: "Fernhill: Business upgrade",
										amount: 13824,
										stage: "Proposal",
										owner: "Lorraine Delgado",
									},
								],
							},
							readOnly: true,
						},
					},
					{
						toolCall: {
							tool: "web_fetch",
							input: { url: "https://fernhilloutfitters.co.nz/news" },
							output: {
								title: "News | Fernhill Outfitters",
								excerpt:
									"This spring we opened two new stores in Wellington, bringing us to six across the North Island.",
							},
							readOnly: true,
						},
					},
					{
						text: "Here's Fernhill at a glance:\n\n| | Now | In March |\n|---|---|---|\n| Weekly active members | 32 | 23 |\n| Seats on Team | 25 | 25 |\n| Monthly spend | $500 | $500 |\n\n**Open deal:** *Fernhill: Business upgrade*, $13,824 a year at list, at the *Proposal* stage with Lorraine.\n\n**Worth knowing before the call:**\n\n1. They're 7 members over their 25 Team seats, so they already hit the seat limit most weeks.\n2. Dana Whitfield, their operations lead, decides. Their CFO, Marcus Ng, joined the last two calls.\n3. Their site says they opened two stores in Wellington this spring, which lines up with the jump in usage.\n\nIf they push back on Business, 30 seats on Team at `$20/seat` keeps them at $600 a month.",
					},
				],
				reactions: [{ emoji: "🙌", by: ["anita"] }],
			},
			{
				at: { time: "9:24" },
				from: { member: "lorraine" },
				replyTo: "fernhill-brief",
				parts: [
					{
						text: "This is great. Did they ask about SSO anywhere? I have a feeling that's the real blocker.",
					},
				],
			},
			{
				key: "fernhill-sso",
				at: { time: "9:25" },
				from: { bot: "Growth Desk" },
				parts: [
					{
						toolCall: {
							connector: "hubspot",
							tool: "search_notes",
							input: { companyId: "18842", query: "SSO" },
							output: {
								results: [
									{
										date: "2026-10-14",
										author: "Lorraine Delgado",
										text: "Dana asked whether Team has SSO.",
									},
									{
										date: "2026-11-02",
										author: "Ari (IT contractor)",
										text: "We'd need Okta SSO before rolling Fieldnote out to the store teams.",
									},
								],
							},
							readOnly: true,
						},
					},
					{
						text: "Twice. Dana asked about it on the 14 October call, and their IT contractor emailed on 2 November:\n\n> We'd need Okta SSO before rolling Fieldnote out to the store teams.\n\nSo SSO is likely what decides it. Business includes it and Team doesn't.",
					},
				],
				reactions: [{ emoji: "💯", by: ["lorraine", "anita"] }],
			},
			{
				at: { time: "9:27" },
				from: { member: "anita" },
				parts: [
					{
						text: "Good catch. Lorraine, lead with SSO tomorrow, and offer the annual price if they commit before the end of the month.",
					},
				],
				reactions: [{ emoji: "👍", by: ["lorraine"] }],
			},
			{
				at: { time: "9:28" },
				from: { member: "lorraine" },
				parts: [{ text: "Will do 👌" }],
			},
			{
				at: { time: "9:31" },
				from: { member: "anita" },
				parts: [{ text: "Update the draft so it mentions Okta, and keep it short." }],
			},
			{
				at: { time: "9:32" },
				from: { bot: "Growth Desk" },
				parts: [
					{
						text: "Updated:\n\n> Hi Dana, thanks for coming back to us. Business includes Okta SSO, so your store teams can sign in with the accounts they already have. With 32 members on Fieldnote each week it's $48 a seat, or $40.80 on an annual plan if you go ahead before the end of the month.\n\nIt's still in drafts until Lorraine's call.",
					},
				],
			},
			{
				at: { time: "9:40" },
				from: { member: "gary" },
				parts: [{ text: "Long shot, but do we know when their current plan renews?" }],
			},
			{
				at: { time: "9:41" },
				from: { bot: "Growth Desk" },
				parts: [
					{
						toolCall: {
							connector: "hubspot",
							tool: "get_company",
							input: { companyId: "18842", properties: ["renewal_date", "billing_cycle"] },
							output: { renewal_date: "2027-01-14", billing_cycle: "monthly" },
							readOnly: true,
						},
					},
					{
						text: "Their Team plan renews on **14 January**, billed monthly. Moving to Business before then prorates the rest of the month, so the first Business invoice would carry a credit of about $410.",
					},
				],
			},
			{
				at: { time: "9:44" },
				from: { member: "anita" },
				parts: [{ text: "Perfect, thanks. That's everything we need for tomorrow." }],
			},
		],
	},
	{
		bot: "Growth Desk",
		messages: [
			{
				at: { time: "10:02" },
				from: { member: "gary" },
				parts: [{ text: "Brightwater Supply wants 25% off the annual tier. Can we do it?" }],
			},
			{
				at: { time: "10:04" },
				from: { bot: "Growth Desk" },
				parts: [
					{
						text: "Yes. At 25% off, Business comes to $36 a seat, which still clears our 70% margin floor at 40 seats. I've drafted quote Q-1182 for 40 seats at $17,280 a year. Want me to send it to Brightwater?",
					},
				],
				reactions: [{ emoji: "🎉", by: ["gary"] }],
			},
			{
				at: { time: "10:06" },
				from: { member: "lorraine" },
				parts: [{ text: "Nice. Send it, and copy me in." }],
			},
		],
	},
	{
		bot: "Researcher",
		messages: [
			{
				at: { time: "11:05" },
				from: { member: "gary" },
				parts: [{ text: "What changed in Postgres 18 that matters for us?" }],
			},
			{
				at: { time: "11:07" },
				from: { bot: "Researcher" },
				parts: [
					{
						text: "Three things, from the release notes:\n\n1. **Asynchronous I/O.** Sequential scans and vacuum read ahead in parallel. Our nightly export scans should get faster with no changes.\n2. **`uuidv7()` built in.** We generate v7 ids in the app today; the database can now do it, and they sort by time.\n3. **Upgrades keep planner statistics.** No slow queries for the first hour after a major upgrade.\n\nNothing in it breaks our schema. I'd try it on staging first for the I/O change.",
					},
				],
			},
			{
				at: { time: "11:12" },
				from: { member: "gary" },
				parts: [
					{
						text: "Can you compare pg-boss, Graphile Worker and pgmq for the export queue? One page is plenty.",
					},
				],
			},
			{
				at: { time: "11:16" },
				from: { bot: "Researcher" },
				parts: [
					{ file: { kind: "html", title: QUEUE_REPORT_TITLE, content: QUEUE_REPORT } },
					{
						text: "Graphile Worker fits best: it picks up jobs over LISTEN/NOTIFY, has cron built in, and retries with backoff, all on the Postgres we already run. pg-boss is a close second. The comparison and next steps are in the page below.",
					},
				],
				reactions: [{ emoji: "🙌", by: ["rob"] }],
			},
		],
	},
	{
		bot: "Journal",
		messages: [
			{
				at: { time: "8:05" },
				from: { member: "anita" },
				parts: [
					{
						text: "Big day: Brightwater pricing and the Kestrel refund. Remind me to check in on Doreen's SSO ticket.",
					},
				],
			},
			{
				at: { time: "8:05" },
				from: { bot: "Journal" },
				parts: [
					{
						text: "Filed under today. Next time you check in, I'll start with Doreen's SSO ticket.",
					},
				],
			},
		],
	},
	{
		bot: "Code Reviewer",
		messages: [
			{
				at: { time: "11:02" },
				from: { member: "rob" },
				parts: [
					{
						text: "The nightly export took 3 hours last night instead of the usual 40 minutes. Can you find out why?",
					},
				],
			},
			{
				at: { time: "11:05" },
				from: { bot: "Code Reviewer" },
				parts: [
					{ text: "I'll start with last night's run in the job log.\n\n" },
					{
						toolCall: {
							tool: "run_command",
							input: { command: 'grep -n "ExportJob" logs/jobs-2026-11-17.log | tail -20' },
							output: {
								stdout:
									"4812: ExportJob started  batch=1/38  rows=50000\n4977: ExportJob finished batch=1/38  took=41s\n...\n9120: ExportJob started  batch=38/38 rows=50000\n9188: ExportJob finished batch=38/38 took=7m12s\n9189: ExportJob done total=3h02m",
								exitCode: 0,
							},
							readOnly: true,
						},
					},
					{
						toolCall: {
							tool: "run_command",
							input: { command: 'grep -c "retrying" logs/jobs-2026-11-17.log' },
							output: { stdout: "0", exitCode: 0 },
							readOnly: true,
						},
					},
					{
						toolCall: {
							tool: "run_command",
							input: {
								command:
									"awk '/ExportJob finished/ {print $5}' logs/jobs-2026-11-17.log | head -40",
							},
							output: {
								stdout:
									"took=41s\ntook=44s\ntook=52s\ntook=1m09s\ntook=1m31s\ntook=1m58s\ntook=2m40s\ntook=3m22s\ntook=4m05s\n...",
								exitCode: 0,
							},
							readOnly: true,
						},
					},
					{
						text: "No retries, but every batch is slower than the one before it, which points at the query rather than the queue. Reading how a batch is fetched.\n\n",
					},
					{
						toolCall: {
							tool: "read_file",
							input: { path: "src/exports/export-job.ts" },
							output: {
								content:
									"export async function runBatch(cursor: number) {\n  const rows = await db.query(\n    `select * from events order by created_at offset $1 limit $2`,\n    [cursor, BATCH_SIZE],\n  );\n  ...",
							},
							readOnly: true,
						},
					},
					{
						toolCall: {
							tool: "read_file",
							input: { path: "src/exports/batch-size.ts" },
							output: { content: "export const BATCH_SIZE = 50_000;" },
							readOnly: true,
						},
					},
					{
						toolCall: {
							tool: "run_command",
							input: { command: "git log --oneline -5 -- src/exports/" },
							output: {
								stdout:
									"a91c2e4 feat(exports): page events by offset, not created_at\n6f03b11 fix(exports): retry 5 times with backoff\n2d7e9a0 feat(exports): move the export job onto the new queue",
								exitCode: 0,
							},
							readOnly: true,
						},
					},
					{
						toolCall: {
							tool: "run_command",
							input: { command: "git show a91c2e4 --stat" },
							output: {
								stdout:
									"src/exports/export-job.ts | 12 +++++-------\n1 file changed, 5 insertions(+), 7 deletions(-)",
								exitCode: 0,
							},
							readOnly: true,
						},
					},
					{
						text: "That commit swapped keyset paging for `offset`. Checking what Postgres does with it on a copy of production.\n\n",
					},
					{
						toolCall: {
							tool: "run_command",
							input: {
								command:
									'psql $STAGING_URL -c "explain analyze select * from events order by created_at offset 1850000 limit 50000"',
							},
							output: {
								stdout:
									"Limit  (actual time=402113.2..412480.9 rows=50000)\n  ->  Index Scan using events_created_at_idx on events  (rows=1900000)\nExecution Time: 412491.7 ms",
								exitCode: 0,
							},
							readOnly: true,
						},
					},
					{
						toolCall: {
							tool: "run_command",
							input: {
								command:
									"psql $STAGING_URL -c \"explain analyze select * from events where created_at > '2026-11-17 02:14' order by created_at limit 50000\"",
							},
							output: {
								stdout:
									"Limit  (actual time=0.09..388.4 rows=50000)\n  ->  Index Scan using events_created_at_idx on events\nExecution Time: 391.2 ms",
								exitCode: 0,
							},
							readOnly: true,
						},
					},
					{
						toolCall: {
							tool: "run_command",
							input: { command: 'psql $STAGING_URL -c "select count(*) from events"' },
							output: { stdout: " count\n---------\n 1900412", exitCode: 0 },
							readOnly: true,
						},
					},
					{
						toolCall: {
							tool: "run_command",
							input: { command: 'grep -rn "offset" src/exports/ src/reports/' },
							output: {
								stdout:
									"src/exports/export-job.ts:4:    `select * from events order by created_at offset $1 limit $2`,\nsrc/reports/monthly.ts:18:  .offset(page * PAGE_SIZE)",
								exitCode: 0,
							},
							readOnly: true,
						},
					},
					{
						toolCall: {
							tool: "read_file",
							input: { path: "src/reports/monthly.ts" },
							output: {
								content:
									"export const monthly = (page: number) =>\n  db.select().from(invoices).orderBy(invoices.issuedAt)\n    .limit(PAGE_SIZE)\n    .offset(page * PAGE_SIZE);",
							},
							readOnly: true,
						},
					},
					{
						text: "Found it. a91c2e4 (Tuesday) moved the export from keyset paging to `offset`. With `offset`, Postgres reads and throws away every row before the page it wants, so batch 38 reads 1.9M rows to return 50k. That's why each batch was slower than the last, and the whole run took **3h02m** instead of 40m.\n\n**Fix**\n- Go back to paging by `created_at`, starting each batch after the last row of the one before. On staging that batch went from **412s to 0.4s**.\n\n**Worth a look**\n- `src/reports/monthly.ts` pages with `offset` too. It's small today, but it'll slow down the same way as invoices grow.\n\nWant me to open a PR reverting the paging in `export-job.ts`?",
					},
				],
			},
		],
	},
];

/** Past runs of automations, so their chats and run lists have history. */
const AUTOMATION_RUNS: readonly AutomationRun[] = [
	{
		bot: "Growth Desk",
		automation: "Renewal risk check",
		scheduledAt: { time: "8:00", day: "previous weekday" },
		finishedAt: { time: "8:03", day: "previous weekday" },
		result:
			"Two renewals at risk this month:\n\n- **Fernhill Outfitters** (14 Jan): usage up, but they're 7 over their seats. Offer Business before renewal.\n- **Parcel & Co** (22 Jan): weekly active members down from 12 to 5. Worth a check-in call.",
	},
	{
		bot: "Growth Desk",
		automation: "Renewal risk check",
		scheduledAt: { time: "8:00" },
		finishedAt: { time: "8:01" },
		result: "I started on this morning's renewals but couldn't read the deals.",
		failed: userText`HubSpot's sign-in has expired, so the renewals couldn't be read. Sign in to HubSpot again in Growth Desk's connectors, then run it again.`,
	},
	{
		bot: "Ticket Desk",
		automation: "Morning queue",
		scheduledAt: { time: "8:30", day: "previous weekday" },
		finishedAt: { time: "8:32", day: "previous weekday" },
		result:
			"Morning queue: 4 new tickets overnight.\n\n- Answered 3 how-to questions (exports, seat changes, SSO setup)\n- Oakridge: asking about invoices in AUD. Needs a member\n\nOldest waiting: Oakridge, 9 hours.",
	},
	{
		bot: "Ticket Desk",
		automation: "Morning queue",
		scheduledAt: { time: "8:30" },
		finishedAt: { time: "8:33" },
		result:
			"Morning queue: 7 new tickets overnight.\n\n- Answered 4 how-to questions (exports, SSO setup, seat changes)\n- Kestrel Freight: charged twice on 3 Oct. Needs a refund\n- Brightline: can't sign in since the SSO change. Handed to Doreen\n- Oakridge: still waiting on AUD invoices. Needs a member\n\nOldest waiting: Oakridge, 33 hours.",
	},
	{
		bot: "Growth Desk",
		automation: "Monday pipeline summary",
		scheduledAt: { time: "9:00", day: "previous monday" },
		finishedAt: { time: "9:02", day: "previous monday" },
		result:
			"Last week's pipeline:\n\n- **Closed:** Lumen Health (Business, 60 seats), Parcel & Co (Team, 12 seats)\n- **Slipped:** Brightwater Supply, now waiting on pricing\n- **Needs a reply today:** Fernhill Outfitters asked about Business pricing\n\nNew annual revenue: $64,300.",
	},
];

/** Linear's own connector tools, so its tool access looks as it does when signed in for real. */
const LINEAR_READING = [
	"list_issues",
	"get_issue",
	"list_comments",
	"list_cycles",
	"list_documents",
	"get_document",
	"list_issue_labels",
	"list_issue_statuses",
	"get_issue_status",
	"list_projects",
	"get_project",
	"list_project_labels",
	"list_milestones",
	"get_milestone",
	"list_teams",
	"get_team",
	"list_users",
	"get_user",
	"get_attachment",
	"search_documentation",
] as const;
const LINEAR_CHANGES = [
	"prepare_attachment_upload",
	"create_attachment_from_upload",
	"create_attachment",
	"delete_attachment",
	"save_comment",
	"delete_comment",
	"save_document",
	"save_issue",
	"save_issue_label",
	"create_issue_label",
	"retire_issue_label",
	"restore_issue_label",
	"save_project",
	"save_milestone",
	"retire_project_label",
	"save_status_update",
] as const;
const LINEAR_OFF = [
	"delete_attachment",
	"delete_comment",
	"save_document",
	"save_issue_label",
	"retire_issue_label",
	"restore_issue_label",
	"save_project",
	"save_milestone",
	"retire_project_label",
	"save_status_update",
] as const;

/** A tool described as its name reads: `save_issue` is "Save issue". */
function connectorTool(name: string, { readOnly }: { readOnly: boolean }) {
	const words = name.replaceAll("_", " ");
	return {
		name,
		description: words[0]?.toUpperCase() + words.slice(1),
		readOnly,
		destructive: name.startsWith("delete_"),
	};
}

/** The projects' MCP servers, signed out: sign in to one in Settings to use it for real. */
const CONNECTORS: readonly SeedConnector[] = [
	{
		project: "growth",
		name: "HubSpot",
		handle: "hubspot",
		url: "https://mcp.hubspot.com",
		tools: [
			...["search_companies", "get_company", "search_deals", "search_notes"].map((name) =>
				connectorTool(name, { readOnly: true }),
			),
			connectorTool("create_note", { readOnly: false }),
		],
		toolAccess: { create_note: "ask" },
	},
	{
		project: "support",
		name: "Stripe",
		handle: "stripe",
		url: "https://mcp.stripe.com",
		tools: [
			{ name: "list_customers", description: "List customers", readOnly: true, destructive: false },
			{
				name: "list_payment_intents",
				description: "List payments",
				readOnly: true,
				destructive: false,
			},
			{
				name: "retrieve_balance",
				description: "Get the account balance",
				readOnly: true,
				destructive: false,
			},
			{
				name: "create_refund",
				description: "Refund a payment",
				readOnly: false,
				destructive: true,
			},
			{
				name: "create_invoice",
				description: "Create an invoice",
				readOnly: false,
				destructive: false,
			},
		],
		toolAccess: { create_refund: "ask", create_invoice: "ask" },
	},
	{
		project: "engineering",
		name: "Linear",
		handle: "linear",
		url: "https://mcp.linear.app/mcp",
		tools: [
			...LINEAR_READING.map((name) => connectorTool(name, { readOnly: true })),
			...LINEAR_CHANGES.map((name) => connectorTool(name, { readOnly: false })),
		],
		toolAccess: {
			save_issue: "ask",
			save_comment: "allow",
			create_issue_label: "ask",
			prepare_attachment_upload: "ask",
			create_attachment_from_upload: "ask",
			create_attachment: "ask",
			...Object.fromEntries(LINEAR_OFF.map((name) => [name, "off" as const])),
		},
	},
	{
		project: "engineering",
		name: "Notion",
		handle: "notion",
		url: "https://mcp.notion.com/mcp",
		tools: [
			{ name: "search", description: "Search the workspace", readOnly: true, destructive: false },
			{ name: "fetch", description: "Read a page or database", readOnly: true, destructive: false },
			{ name: "create_pages", description: "Create pages", readOnly: false, destructive: false },
			{ name: "update_page", description: "Update a page", readOnly: false, destructive: false },
		],
		toolAccess: { create_pages: "ask", update_page: "ask" },
	},
];

const seed = Effect.gen(function* () {
	const serverSettings = yield* ServerSettings.Service;
	if (serverSettings.isProduction) {
		return yield* Effect.die(new Error("The showcase seed cannot run in production."));
	}

	const members = yield* Effect.forEach(
		Object.entries(MEMBERS) as [MemberKey, (typeof MEMBERS)[MemberKey]][],
		([key, seed]) =>
			Effect.gen(function* () {
				const id = yield* ensureAccount({
					name: seed.name,
					email: seed.email,
					password: PASSWORD,
				});
				yield* query((db) => db.update(member).set({ image: seed.image }).where(eq(member.id, id)));
				return [key, id] as const;
			}),
	).pipe(Effect.map((entries) => Object.fromEntries(entries) as Record<MemberKey, string>));

	const workspaceId = yield* ensureWorkspace(members[OWNER]);
	yield* WorkspaceSetup.recordSetUp(workspaceId);
	yield* Effect.forEach(
		(Object.keys(MEMBERS) as MemberKey[]).filter((key) => key !== OWNER),
		(key) => joinWorkspace({ workspaceId, memberId: members[key] }),
		{ discard: true },
	);

	yield* ensureProviders(workspaceId, members[OWNER]);
	const offered = yield* offeredModels(workspaceId);
	const botIds = yield* Effect.forEach(BOTS, (bot) =>
		Effect.map(
			ensureBot({
				workspaceId,
				createdById: members[OWNER],
				bot,
				model: chooseModel(bot, offered),
			}),
			(id) => [bot.name, id] as const,
		),
	).pipe(Effect.map((entries) => new Map(entries)));
	const projectIds = yield* ensureProjects(workspaceId, members, botIds);
	yield* placeBots({ workspaceId, members, projectIds, botIds });

	const owner = yield* signInOwner;
	yield* Effect.forEach(
		AUTOMATIONS,
		({ bot, automation }) => {
			const botId = botIds.get(bot);
			return botId
				? ensureAutomation(owner, { botId, automation })
				: Effect.die(new Error(`No bot is named ${bot}`));
		},
		{ discard: true },
	);
	yield* holdScheduledAutomations(workspaceId);

	yield* ensureConnectors({
		workspaceId,
		projectIds,
		createdById: members[OWNER],
		connectors: CONNECTORS,
	});
	const chats = yield* ensureChats(
		{
			workspaceId,
			members,
			projectIds,
			botIds,
			botModels: new Map(BOTS.map((bot) => [bot.name, chooseModel(bot, offered)])),
		},
		{ projectChats: PROJECT_CHATS, botChats: BOT_CHATS, runs: AUTOMATION_RUNS },
	);

	const ledgerRows = yield* fillLedger({ workspaceId, botIds });

	console.log(`workspace ${WORKSPACE.slug}, owned by ${MEMBERS[OWNER].email}`);
	console.log(
		`members: ${Object.values(MEMBERS)
			.map((member) => member.email)
			.join(", ")} (password: ${PASSWORD})`,
	);
	console.log(
		offered.length === 0
			? "The workspace offers no models yet: connect providers in Settings, then run this again."
			: `bots on: ${BOTS.map((bot) => `${bot.name} → ${chooseModel(bot, offered)}`).join(", ")}`,
	);
	console.log(
		chats === 0
			? "chats already there"
			: `chats: ${chats} projects' chats, bots' chats and automation runs written`,
	);
	console.log(
		ledgerRows === 0
			? "usage history already there"
			: `usage history: ${ledgerRows} model requests over ${LEDGER_DAYS} days`,
	);
});

/** Made the way the app makes one, so it has its system bots, built-in providers and the owner's Personal Assistant. */
const ensureWorkspace = (ownerId: string) =>
	Membership.createWorkspace(ownerId, {
		...WORKSPACE,
		timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	}).pipe(
		Effect.map((created) => created.id),
		Effect.catchTag("SlugTaken", () =>
			Effect.flatMap(
				query((db) =>
					db.select({ id: workspace.id }).from(workspace).where(eq(workspace.slug, WORKSPACE.slug)),
				),
				([row]) =>
					row ? Effect.succeed(row.id) : Effect.die(new Error("The workspace is missing")),
			),
		),
	);

/** As an accepted invitation lets a teammate in, with their Personal Assistant. */
const joinWorkspace = (input: { workspaceId: string; memberId: string }) =>
	Membership.join(input.workspaceId, input.memberId, "editor");

/** The projects with their members, by key, each led by the first of its bots. */
const ensureProjects = (
	workspaceId: string,
	memberIds: Record<MemberKey, string>,
	botIds: ReadonlyMap<string, string>,
) =>
	Effect.gen(function* () {
		const projectStore = yield* ProjectStore.Service;
		const projects = yield* Effect.forEach(
			Object.entries(PROJECTS) as [ProjectKey, (typeof PROJECTS)[ProjectKey]][],
			([key, { name, color, members }]) =>
				Effect.gen(function* () {
					const lead = BOTS.find((bot) => bot.project === key);
					const leadBotId = lead && botIds.get(lead.name);
					if (!leadBotId)
						return yield* Effect.die(new Error(`Project ${key} has no bot to lead it`));
					const projectId = yield* projectStore
						.create(workspaceId, { creatorId: memberIds[OWNER], name, slug: key, color, leadBotId })
						.pipe(
							Effect.map((created) => created.id),
							Effect.catchTag("ProjectSlugTaken", () => projectIdBySlug(workspaceId, key)),
							Effect.catchTag("BotNotPublic", Effect.die),
						);
					yield* Effect.forEach(
						members,
						(member) => projectStore.addMember(workspaceId, projectId, memberIds[member]),
						{ discard: true },
					);
					return [key, projectId] as const;
				}),
		);
		return Object.fromEntries(projects) as Record<ProjectKey, string>;
	});

const projectIdBySlug = (workspaceId: string, slug: string) =>
	Effect.flatMap(
		query((db) =>
			db
				.select({ id: project.id })
				.from(project)
				.where(and(eq(project.workspaceId, workspaceId), eq(project.slug, slug))),
		),
		([row]) => (row ? Effect.succeed(row.id) : Effect.die(new Error(`Project ${slug} is missing`))),
	);

/**
 * Adds each public bot to its project, and pins it for the project's members.
 * Anita made them all, so they are already pinned for her.
 */
const placeBots = (input: {
	workspaceId: string;
	members: Record<MemberKey, string>;
	projectIds: Record<ProjectKey, string>;
	botIds: ReadonlyMap<string, string>;
}) =>
	Effect.gen(function* () {
		const projects = yield* ProjectStore.Service;
		const bots = yield* BotStore.Service;
		for (const bot of BOTS) {
			const botId = input.botIds.get(bot.name);
			if (bot.project === "personal" || !botId) continue;
			yield* projects
				.addBot(input.workspaceId, input.projectIds[bot.project], botId)
				.pipe(Effect.orDie);
			yield* Effect.forEach(
				PROJECTS[bot.project].members,
				(member) =>
					bots.setPinned({
						workspaceId: input.workspaceId,
						memberId: input.members[member],
						botId,
						pinned: true,
					}),
				{ discard: true },
			);
		}
	});

/**
 * The built-in providers the bots prefer that a new workspace isn't given,
 * added switched off and without a key, so the ledger's history names them.
 * Connecting one is left to Settings.
 */
const ensureProviders = (workspaceId: string, createdById: string) =>
	Effect.gen(function* () {
		const providers = yield* ModelProviderStore.Service;
		const builtIns = new Set(BOTS.flatMap((bot) => bot.models.map((choice) => choice.builtIn)));
		yield* Effect.forEach(
			builtIns,
			(builtIn) =>
				providers
					.create(workspaceId, { createdById, provider: { builtIn } })
					.pipe(Effect.catchTag("ModelProviderNameConflict", () => Effect.void)),
			{ discard: true },
		);
	});

interface OfferedModel {
	modelId: string;
	builtIn: BuiltInProviderId | null;
	isDefault: boolean;
}

/** The models the workspace's active providers offer its bots. */
const offeredModels = (workspaceId: string) =>
	query((db) =>
		db
			.select({
				modelId: providerModel.modelId,
				builtIn: modelProvider.builtIn,
				defaultModel: workspaceDefaultModel.modelId,
			})
			.from(providerModel)
			.innerJoin(modelProvider, eq(modelProvider.id, providerModel.providerId))
			.leftJoin(workspaceDefaultModel, eq(workspaceDefaultModel.workspaceId, workspaceId))
			.where(
				and(
					eq(providerModel.workspaceId, workspaceId),
					eq(providerModel.enabled, true),
					eq(modelProvider.active, true),
				),
			),
	).pipe(
		Effect.map((rows): OfferedModel[] =>
			rows
				.map((row) => ({
					modelId: row.modelId,
					builtIn: row.builtIn,
					isDefault: row.modelId === row.defaultModel,
				}))
				// Newest first among a provider's matches, as model ids carry their version.
				.sort((a, b) => b.modelId.localeCompare(a.modelId, undefined, { numeric: true })),
		),
	);

/** The first offered model the bot prefers, else the workspace's default, else its first choice's id. */
function chooseModel(bot: SeedBot, offered: readonly OfferedModel[]): string {
	for (const choice of bot.models) {
		const match = offered.find(
			(model) => model.builtIn === choice.builtIn && choice.matches.test(model.modelId),
		);
		if (match) return match.modelId;
	}
	return offered.find((model) => model.isDefault)?.modelId ?? bot.models[0].ledgerModel;
}

/** Creates the bot, or moves the one a previous run made onto `model`. */
const ensureBot = (input: {
	workspaceId: string;
	createdById: string;
	bot: SeedBot;
	model: string;
}) =>
	Effect.gen(function* () {
		const bots = yield* BotStore.Service;
		const { bot } = input;
		const created = yield* bots
			.create(input.workspaceId, {
				createdById: input.createdById,
				bot: {
					name: bot.name,
					visibility: bot.project === "personal" ? "personal" : "public",
					color: bot.color,
					eyes: bot.eyes,
					shape: bot.shape,
					description: bot.description,
					instructions: bot.instructions,
					model: input.model,
					usesComputer: bot.usesComputer ?? false,
				},
			})
			.pipe(
				Effect.map((row) => row.id),
				Effect.catchTag("BotNameTaken", () => Effect.succeed(undefined)),
				Effect.orDie,
			);
		if (created) return created;
		const [existing] = yield* query((db) =>
			db
				.select({ id: botTable.id })
				.from(botTable)
				.where(and(eq(botTable.workspaceId, input.workspaceId), eq(botTable.name, bot.name))),
		);
		if (!existing) return yield* Effect.die(new Error(`${bot.name} was not made`));
		yield* bots
			.update(input.workspaceId, existing.id, { model: input.model }, input.createdById)
			.pipe(Effect.orDie);
		return existing.id;
	});

const signInOwner = Effect.gen(function* () {
	const { publicUrl } = yield* ServerSettings.Service;
	const authentication = yield* Authentication.Service;
	const sessions = yield* SessionAuthentication.Service;
	const response = yield* authentication.handler(
		new Request(`${publicUrl}${API_BASE_PATH}/auth/sign-in/email`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: new URL(publicUrl).origin,
			},
			body: JSON.stringify({ email: MEMBERS[OWNER].email, password: PASSWORD }),
		}),
	);
	if (!response.ok) return yield* Effect.die(new Error("Could not sign in the showcase owner"));
	const body: unknown = yield* Effect.promise(() => response.json());
	const { token } = yield* Schema.decodeUnknownEffect(Schema.Struct({ token: Schema.String }))(
		body,
	);
	return yield* sessions.authenticate(new Headers({ authorization: `Bearer ${token}` })).pipe(
		Effect.provideService(SessionAuthentication.Cookies, {
			read: () => Effect.succeed(undefined),
		}),
	);
}).pipe(Effect.orDie);

const ensureAutomation = (
	owner: MemberSession,
	input: { botId: string; automation: NewAutomation },
) =>
	Effect.gen(function* () {
		const projectId = yield* defaultProjectOf(input.botId);
		const ids = yield* Ids.Service;
		yield* automationsOperations["automations.create"]
			.run(owner, { projectId, ...input.automation }, { kind: "request", request: yield* ids.next })
			.pipe(
				Effect.asVoid,
				Effect.catchTag("AutomationNameTaken", () => Effect.void),
				Effect.orDie,
			);
	});

/** How far off the seeded automations' next runs are put. */
const AUTOMATION_HOLD_DAYS = 365;

/**
 * Puts every routine's next run a year out, so the automations show as on,
 * with their routines, but never come due while the showcase is in use. Due,
 * they would run, and fail where the workspace offers no model. A paused
 * automation's routine has no next run, and keeps none.
 */
const holdScheduledAutomations = (workspaceId: string) =>
	query((db) =>
		db
			.update(automationTrigger)
			.set({ nextScheduledAt: new Date(Date.now() + AUTOMATION_HOLD_DAYS * MILLISECONDS_PER_DAY) })
			.where(
				and(
					eq(automationTrigger.workspaceId, workspaceId),
					eq(automationTrigger.kind, "routine"),
					isNotNull(automationTrigger.nextScheduledAt),
				),
			),
	);

type RoutineTrigger = Extract<NewAutomation["triggers"][number], { kind: "routine" }>;

function weekly(
	days: readonly ("mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun")[],
	times: readonly number[],
): RoutineTrigger {
	return {
		kind: "routine",
		schedule: { repeat: "weekly", every: 1, days, times, startsOn: today() },
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	};
}

function daily(times: readonly number[]): RoutineTrigger {
	return {
		kind: "routine",
		schedule: { repeat: "daily", every: 1, times, startsOn: today() },
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	};
}

/** Today's date where the seed runs, as `YYYY-MM-DD`. */
function today(): string {
	return new Date().toLocaleDateString("en-CA");
}

const LEDGER_DAYS = 42;
const WEEKEND_SHARE = 0.25;
const MILLISECONDS_PER_DAY = 86_400_000;
const WORKDAY_START_HOUR = 8;
const WORKDAY_HOURS = 10;
const LEDGER_INSERT_BATCH = 500;

/**
 * Six weeks of the bots' model requests, quieter at weekends, so the Usage
 * page has days, bots and models to show. Skipped when an earlier run
 * wrote them: seeded rows are the only bot turns with no turn.
 */
const fillLedger = (input: { workspaceId: string; botIds: ReadonlyMap<string, string> }) =>
	Effect.gen(function* () {
		const [seeded] = yield* query((db) =>
			db
				.select({ id: modelRequest.id })
				.from(modelRequest)
				.where(
					and(
						eq(modelRequest.workspaceId, input.workspaceId),
						eq(modelRequest.purpose, "bot-turn"),
						isNull(modelRequest.turnId),
					),
				)
				.limit(1),
		);
		if (seeded) return 0;

		const providers = yield* query((db) =>
			db
				.select({ id: modelProvider.id, builtIn: modelProvider.builtIn })
				.from(modelProvider)
				.where(eq(modelProvider.workspaceId, input.workspaceId)),
		);
		const providerIdByBuiltIn = new Map(providers.map((row) => [row.builtIn, row.id]));
		const random = seededRandom(LEDGER_DAYS);
		const now = Date.now();
		const rows: (typeof modelRequest.$inferInsert)[] = [];

		for (let daysAgo = LEDGER_DAYS - 1; daysAgo >= 0; daysAgo--) {
			const day = new Date(now - daysAgo * MILLISECONDS_PER_DAY);
			day.setHours(WORKDAY_START_HOUR, 0, 0, 0);
			const isWeekend = day.getDay() === 0 || day.getDay() === 6;
			for (const bot of BOTS) {
				const [choice] = bot.models;
				const providerId = providerIdByBuiltIn.get(choice.builtIn);
				const botId = input.botIds.get(bot.name);
				if (!providerId || !botId) continue;
				const busyness = (isWeekend ? WEEKEND_SHARE : 1) * (0.6 + random() * 0.8);
				const requests = Math.round(bot.requestsPerWeekday * busyness);
				for (let request = 0; request < requests; request++) {
					const startedAt = new Date(day.getTime() + random() * WORKDAY_HOURS * 3_600_000);
					if (startedAt.getTime() > now) continue;
					const inputTokens = Math.round(4_000 + random() * 26_000);
					const cacheReadTokens = Math.round(inputTokens * random() * 0.6);
					const outputTokens = Math.round(250 + random() * 1_400);
					const costUsd =
						((inputTokens - cacheReadTokens) * choice.usdPerMillion.input +
							cacheReadTokens * choice.usdPerMillion.input * 0.1 +
							outputTokens * choice.usdPerMillion.output) /
						1_000_000;
					rows.push({
						workspaceId: input.workspaceId,
						purpose: "bot-turn",
						botId,
						step: 0,
						providerId,
						builtIn: choice.builtIn,
						model: choice.ledgerModel,
						outcome: "completed",
						inputTokens,
						cacheReadTokens,
						cacheWriteTokens: 0,
						outputTokens,
						reasoningTokens: 0,
						costUsd,
						costSource: costSourceOf(choice),
						startedAt,
						endedAt: new Date(startedAt.getTime() + 2_000 + random() * 18_000),
					});
				}
			}
		}

		for (let start = 0; start < rows.length; start += LEDGER_INSERT_BATCH) {
			const batch = rows.slice(start, start + LEDGER_INSERT_BATCH);
			yield* query((db) => db.insert(modelRequest).values(batch));
		}
		return rows.length;
	});

/** As `request-cost.ts` would have named it. */
function costSourceOf(choice: ModelChoice): string {
	if (choice.builtIn === "ollama") return "local";
	if (choice.builtIn === "chatgpt") return "subscription";
	return "showcase-seed";
}

/** The same sequence on every run, so the Usage page looks the same each time it's seeded. */
function seededRandom(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
		mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
	};
}

seed.pipe(
	Effect.scoped,
	Effect.provide(
		Layer.mergeAll(
			Authentication.layer,
			SessionAuthentication.layer,
			ProjectStore.layer,
			BotStore.layer,
			ModelProviderStore.layer,
			// What a workspace is made with, and a member let in with: providers and Personal Assistants.
			PersonalAssistants.layer,
			SearchProviderStore.layer,
			// The seed defines automations and never runs one, which is all these are for.
			ProjectAutomations.layer.pipe(
				Layer.provide([
					unimplemented(AutomationRuns.Service, {}),
					unimplemented(ChatEvents.Service, {}),
				]),
			),
		).pipe(
			Layer.provideMerge(
				Layer.mergeAll(
					Secrets.layer,
					// Leaving and deleting go through the bots' computers; the seed never makes one.
					Egress.layer,
					ComputerSignIn.none,
					seedAccountsLayer,
					// No server runs, so no stream follows a session to hear it end.
					Layer.succeed(EventOutbox.Service, { publish: () => Effect.void }).pipe(processLayer),
					BlobStore.layer,
					Layer.succeed(Email.Service, Email.Service.of({ send: () => Effect.void })).pipe(
						processLayer,
					),
				).pipe(
					Layer.provideMerge(Ids.layer),
					Layer.provideMerge(ServerSettings.layer),
					Layer.provideMerge(databaseLayer),
				),
			),
		),
	),
	NodeRuntime.runMain,
);
