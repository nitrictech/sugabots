import { NodeRuntime } from "@effect/platform-node";
import type {
	AgentColor,
	AgentFace,
	AgentShape,
	NewRoutine,
	PodColor,
	ProviderPresetId,
} from "@sugabots/contracts";
import { Artifacts } from "@sugabots/core/artifacts/artifacts";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { BlobStore } from "@sugabots/core/blob-store/blob-store";
import { ConversationEvents } from "@sugabots/core/conversations/conversation-events";
import { Routines } from "@sugabots/core/conversations/routines/routines";
import { RoutineRuns } from "@sugabots/core/conversations/routines/runs";
import { Credentials } from "@sugabots/core/credentials/credentials";
import { layer as databaseLayer, query } from "@sugabots/core/database/database";
import {
	agent,
	modelProvider,
	modelRequest,
	pod,
	providerModel,
	routineTrigger,
	user,
	workspace,
	workspaceDefaultModel,
} from "@sugabots/core/database/schema";
import { Email } from "@sugabots/core/email/email";
import { Ids } from "@sugabots/core/ids/ids";
import { Installation } from "@sugabots/core/installation/installation";
import { ModelProviderRepository } from "@sugabots/core/providers/model-providers/model-provider-repository";
import { unimplemented } from "@sugabots/core/testing";
import { AgentRepository } from "@sugabots/core/workspaces/agents/agent-repository";
import { Membership } from "@sugabots/core/workspaces/membership/membership";
import { Onboarding } from "@sugabots/core/workspaces/onboarding/onboarding";
import { PersonalPods } from "@sugabots/core/workspaces/pods/personal-pods";
import { PodRepository } from "@sugabots/core/workspaces/pods/pod-repository";
import { Authentication } from "@sugabots/server/auth/authentication";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { ensureAccount, seedAccountsLayer } from "../accounts.ts";
import {
	ensureConnections,
	ensureConversations,
	type RoutineRun,
	type Scene,
	type SeedConnection,
} from "./conversations.ts";
import { QUEUE_REPORT, QUEUE_REPORT_TITLE } from "./queue-report.ts";

/**
 * Showcase seed: Fieldnote, a small company with the people, pods and bots
 * the website's screenshots and demo video show. Run it with
 * `bun run db:seed:showcase`, against a migrated database.
 *
 * Everyone signs in with `PASSWORD`, and has an Unsplash portrait for a face.
 * Anita owns the workspace; sign in as her.
 *
 * The pods' chats come already written (see `conversations.ts`):
 * people and bots talking, a collaboration, an artifact, and routine runs.
 * Ticket Desk's chat stops at the morning queue, where the demo's story
 * starts (see `stage.ts`). The pods' connections are added too,
 * signed out.
 *
 * Each bot goes on the first model the workspace offers that it prefers,
 * else the workspace's default. A new workspace offers none, so connect
 * providers in Settings and run this again to move the bots onto them.
 *
 * It also fills the ledger with six weeks of model requests, so the Usage
 * page has a history. Those rows have no turn, which is how a later run
 * knows they are there.
 *
 * Its routines show as on but are held a year from running, since they would
 * otherwise run on schedule and fail without a model.
 *
 * Every step is idempotent, so it can be run again over its own data.
 */

const PASSWORD = "showcase";
const WORKSPACE = { name: "Fieldnote", slug: "fieldnote" };

type PersonKey = "anita" | "gary" | "lorraine" | "doreen" | "rob";

/** Anita owns the workspace, which puts her in every shared pod. */
const OWNER: PersonKey = "anita";

/**
 * A face from Unsplash, free to use under the Unsplash License, cropped to it
 * by Unsplash's image service. The comment by each names its photographer.
 */
const unsplashPortrait = (photo: string) =>
	`https://images.unsplash.com/${photo}?w=256&h=256&fit=crop&crop=faces&auto=format`;

const PEOPLE: Record<PersonKey, { name: string; email: string; image: string }> = {
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

type SharedPodKey = "growth" | "support" | "engineering";

const SHARED_PODS: Record<
	SharedPodKey,
	{ name: string; color: PodColor; members: readonly PersonKey[] }
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
	preset: ProviderPresetId;
	matches: RegExp;
	ledgerModel: string;
	usdPerMillion: { input: number; output: number };
}

const CLAUDE_SONNET: ModelChoice = {
	preset: "anthropic",
	matches: /^claude-sonnet/,
	ledgerModel: "claude-sonnet-4-5",
	usdPerMillion: { input: 3, output: 15 },
};
const CLAUDE_HAIKU: ModelChoice = {
	preset: "anthropic",
	matches: /^claude-haiku/,
	ledgerModel: "claude-haiku-4-5",
	usdPerMillion: { input: 1, output: 5 },
};
const CHATGPT: ModelChoice = {
	preset: "chatgpt",
	matches: /^gpt-5/,
	ledgerModel: "gpt-5",
	usdPerMillion: { input: 0, output: 0 },
};
const OPENAI_MINI: ModelChoice = {
	preset: "openai",
	matches: /^gpt-5.*mini/,
	ledgerModel: "gpt-5-mini",
	usdPerMillion: { input: 0.25, output: 2 },
};
const GEMINI_FLASH: ModelChoice = {
	preset: "gemini",
	matches: /gemini-.*flash/,
	ledgerModel: "gemini-2.5-flash",
	usdPerMillion: { input: 0.3, output: 2.5 },
};
const OLLAMA_LLAMA: ModelChoice = {
	preset: "ollama",
	matches: /^llama/,
	ledgerModel: "llama3.2",
	usdPerMillion: { input: 0, output: 0 },
};
/** Claude through OpenRouter, for a workspace that reaches Anthropic that way. */
const OPENROUTER_CLAUDE: ModelChoice = {
	preset: "openrouter",
	matches: /^anthropic\/claude-(sonnet|haiku)/,
	ledgerModel: "anthropic/claude-sonnet-4.5",
	usdPerMillion: { input: 3, output: 15 },
};

interface SeedBot {
	name: string;
	pod: SharedPodKey | "personal";
	color: AgentColor;
	face: AgentFace;
	shape: AgentShape;
	description: string;
	prompt: string;
	/** In order of preference; the first is what the ledger's history is on. */
	models: readonly [ModelChoice, ...ModelChoice[]];
	usesSandbox?: boolean;
	/** Roughly how many model requests it makes on a weekday, for the ledger. */
	requestsPerWeekday: number;
}

const BOTS: readonly SeedBot[] = [
	{
		name: "Growth Desk",
		pod: "growth",
		color: "green",
		face: "pill",
		shape: "leaf",
		description: "Answers pricing and renewal questions for the sales team.",
		prompt:
			"You help Fieldnote's sales team answer customers about pricing, renewals and discounts. Keep replies short and ready to send. When a discount or a custom quote comes up, ask Pricing Analyst to check the margin before you agree to anything.",
		models: [CLAUDE_SONNET, OPENROUTER_CLAUDE],
		requestsPerWeekday: 34,
	},
	{
		name: "Pricing Analyst",
		pod: "growth",
		color: "sky",
		face: "square",
		shape: "hexagon",
		description: "Checks discounts against margin and drafts quotes.",
		prompt:
			"You check proposed discounts against Fieldnote's margins and draft quotes. List tiers are Team at $24 per seat a month and Business at $48, with annual plans at 15% off. Never let gross margin fall below 70%. Say plainly whether a deal clears and give the quote number when you draft one.",
		models: [OPENAI_MINI, CLAUDE_SONNET, OPENROUTER_CLAUDE],
		requestsPerWeekday: 12,
	},
	{
		name: "Copywriter",
		pod: "growth",
		color: "orange",
		face: "arc",
		shape: "blob",
		description: "Drafts replies, posts and invites.",
		prompt:
			"You write for Fieldnote: customer replies, launch posts, newsletters and event invites. Plain, warm and short. Offer one draft, not three, and say what you'd cut if it needs to be shorter.",
		models: [CHATGPT, CLAUDE_SONNET, OPENROUTER_CLAUDE],
		requestsPerWeekday: 22,
	},
	{
		name: "Ticket Desk",
		pod: "support",
		color: "purple",
		face: "dot",
		shape: "circle",
		description: "Works the support queue and handles refunds.",
		prompt:
			"You work Fieldnote's support queue. Find the customer, read their history, and either answer or hand the ticket to the right person in the pod. Refunds go through Stripe: before you issue one, state the customer, the amount and the reason.",
		models: [CLAUDE_HAIKU, OPENROUTER_CLAUDE],
		requestsPerWeekday: 41,
	},
	{
		name: "Inbox Sorter",
		pod: "support",
		color: "yellow",
		face: "pill",
		shape: "squircle",
		description: "Triage, reminders and quick jobs.",
		prompt:
			"You sort the support inbox. Label each email as bug, billing, how-to or sales, flag anything urgent, and post a short list of what needs a person today.",
		models: [GEMINI_FLASH, CLAUDE_HAIKU, OPENROUTER_CLAUDE],
		requestsPerWeekday: 28,
	},
	{
		name: "Code Reviewer",
		pod: "engineering",
		color: "rose",
		face: "wink",
		shape: "octagon",
		description: "Reviews pull requests and runs the tests in its sandbox.",
		prompt:
			"You review Fieldnote's pull requests. Check out the branch in your sandbox, run the tests, and reply with what fails, what's risky and what you'd change. Lead with the one thing that matters most.",
		models: [CLAUDE_SONNET, OPENROUTER_CLAUDE],
		usesSandbox: true,
		requestsPerWeekday: 18,
	},
	{
		name: "Researcher",
		pod: "engineering",
		color: "ice",
		face: "arc",
		shape: "drop",
		description: "Reads the long stuff so you don't have to.",
		prompt:
			"You read papers, docs, changelogs and long threads for the engineering team, and summarise what matters for Fieldnote. Quote the source for every claim. Use your sandbox to try code samples before recommending them.",
		models: [CLAUDE_SONNET, OPENROUTER_CLAUDE],
		usesSandbox: true,
		requestsPerWeekday: 9,
	},
	{
		name: "Journal",
		pod: "personal",
		color: "teal",
		face: "dot",
		shape: "pebble",
		description: "Private notes that stay private.",
		prompt:
			"You keep Anita's private work journal. When she writes, file it under the day, and when she asks, remind her what she noted before. Never suggest sharing anything from here.",
		models: [OLLAMA_LLAMA],
		requestsPerWeekday: 6,
	},
	{
		name: "Trip Planner",
		pod: "personal",
		color: "sky",
		face: "pill",
		shape: "dome",
		description: "Plans trips and keeps the bookings in one place.",
		prompt:
			"You plan Anita's work trips: flights, hotels near the venue, and a day-by-day plan. Keep every booking reference in one list she can find again.",
		models: [GEMINI_FLASH, CLAUDE_HAIKU, OPENROUTER_CLAUDE],
		requestsPerWeekday: 3,
	},
];

const minutes = (hours: number, minutesPastHour = 0) => hours * 60 + minutesPastHour;

const ROUTINES: readonly { bot: string; routine: NewRoutine }[] = [
	{
		bot: "Growth Desk",
		routine: {
			name: "Monday pipeline summary",
			instructions:
				"Summarise last week's deals: what closed, what slipped and what needs a reply today. Post it to the pod.",
			results: "post_to_chat",
			triggers: [weekly(["mon"], [minutes(9)])],
		},
	},
	{
		bot: "Ticket Desk",
		routine: {
			name: "Morning queue",
			instructions:
				"Go through the tickets that came in overnight. Answer what you can and list what needs a person, oldest first.",
			results: "post_to_chat",
			triggers: [weekly(["mon", "tue", "wed", "thu", "fri"], [minutes(8, 30)])],
		},
	},
	{
		bot: "Inbox Sorter",
		routine: {
			name: "Inbox triage",
			instructions: "Label the new support emails and flag anything urgent.",
			triggers: [daily([minutes(7), minutes(13)])],
		},
	},
	{
		bot: "Code Reviewer",
		routine: {
			name: "Review new pull requests",
			instructions:
				"A pull request was opened or updated. Review it, run the tests, and post what you find.",
			results: "post_to_chat",
			triggers: [{ kind: "webhook", auth: { kind: "github" } }],
		},
	},
	{
		bot: "Researcher",
		routine: {
			name: "Friday dependency digest",
			instructions:
				"Read this week's release notes for our main dependencies and summarise anything that affects us.",
			triggers: [weekly(["fri"], [minutes(15)])],
		},
	},
	{
		bot: "Journal",
		routine: {
			name: "End-of-day prompt",
			instructions: "Ask Anita what went well today and what's still on her mind.",
			state: "paused",
			triggers: [daily([minutes(18)])],
		},
	},
];

/**
 * The chats the screenshots show. Times are on the morning of the day they
 * happen (see `conversations.ts`), and a reply quotes by `key`.
 */
const SCENES: readonly Scene<PersonKey>[] = [
	{
		pod: "growth",
		bot: "Growth Desk",
		messages: [
			{
				at: { time: "9:12" },
				from: { person: "gary" },
				parts: [
					{ text: "Fernhill Outfitters replied about pricing. Can someone draft the answer?" },
				],
			},
			{
				key: "northwind-draft",
				at: { time: "9:13" },
				from: { bot: "Growth Desk" },
				parts: [
					{
						text: "Drafted. Their usage is up 40% since March, so I've led with Business:\n\n> Hi Dana, thanks for coming back to us. With 32 people now using Fieldnote every week, Business is the better fit: SSO, audit logs and priority support at $48 a seat, or $40.80 on an annual plan. Happy to walk your team through it this week.\n\nWant me to send it from the shared inbox?",
					},
				],
				reactions: [{ emoji: "👍", by: ["anita", "lorraine"] }],
			},
			{
				at: { time: "9:15" },
				from: { person: "lorraine" },
				replyTo: "northwind-draft",
				parts: [{ text: "Hold it until I've spoken to their team tomorrow." }],
			},
			{
				at: { time: "9:16" },
				from: { person: "gary" },
				parts: [{ text: "Makes sense. I'll leave it in drafts." }],
			},
			{
				at: { time: "10:02" },
				from: { person: "gary" },
				parts: [{ text: "Brightwater Supply wants 25% off the annual tier. Can we do it?" }],
			},
			{
				at: { time: "10:04" },
				from: { bot: "Growth Desk" },
				parts: [
					{ text: "I'll check the margin with Pricing Analyst." },
					{
						collaboration: {
							with: "Pricing Analyst",
							title: "Margin check for Brightwater Supply",
							brief:
								"Brightwater Supply wants 25% off the annual Business tier for 40 seats. Does that clear our 70% margin floor? If it does, draft the quote.",
							answer:
								"It clears. 25% off list puts Business at $36 a seat, which leaves a 72% gross margin at 40 seats. I've drafted quote Q-1182: 40 seats, annual, $17,280 a year.",
							answeredAt: { time: "10:03" },
						},
					},
					{
						text: "Yes. At 25% off, Business comes to $36 a seat and still clears our margin floor. Pricing Analyst has drafted quote Q-1182 for 40 seats at $17,280 a year. Want me to send it to Brightwater?",
					},
				],
				reactions: [{ emoji: "🎉", by: ["gary"] }],
			},
			{
				at: { time: "10:06" },
				from: { person: "lorraine" },
				parts: [{ text: "Nice. Send it, and copy me in." }],
			},
		],
	},
	{
		pod: "growth",
		bot: "Copywriter",
		messages: [
			{
				at: { time: "10:40" },
				from: { person: "lorraine" },
				parts: [{ text: "Can you draft a short post announcing invoices in AUD?" }],
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
		],
	},
	{
		pod: "engineering",
		bot: "Code Reviewer",
		messages: [
			{
				at: { time: "10:20" },
				from: { person: "rob" },
				parts: [
					{
						text: "Can you review PR #482 before I merge? It moves the export job onto the new queue.",
					},
				],
			},
			{
				at: { time: "10:26" },
				from: { bot: "Code Reviewer" },
				parts: [
					{
						text: "Reviewed #482 and ran the tests in my sandbox: 212 passed, 1 failed.\n\n**Fix before merging**\n- `export.test.ts` fails: the job now retries 5 times, but the test still expects 3.\n\n**Worth a look**\n- `ExportJob.run` sets no timeout, so a stuck export holds a worker for good.\n- The queue name is written out in two places. A constant would keep them in step.\n\nThe rest looks good, and the new retry backoff is a clear improvement.",
					},
				],
				reactions: [{ emoji: "👀", by: ["gary"] }],
			},
			{
				at: { time: "10:31" },
				from: { person: "rob" },
				parts: [{ text: "Good catch on the timeout. Fixing both now." }],
			},
		],
	},
	{
		pod: "engineering",
		bot: "Researcher",
		messages: [
			{
				at: { time: "11:05" },
				from: { person: "gary" },
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
				from: { person: "gary" },
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
					{ artifact: { kind: "html", title: QUEUE_REPORT_TITLE, content: QUEUE_REPORT } },
					{
						text: "Graphile Worker fits best: it picks up jobs over LISTEN/NOTIFY, has cron built in, and retries with backoff, all on the Postgres we already run. pg-boss is a close second. The comparison and next steps are in the page below.",
					},
				],
				reactions: [{ emoji: "🙌", by: ["rob"] }],
			},
		],
	},
	{
		pod: "personal",
		bot: "Journal",
		messages: [
			{
				at: { time: "8:05" },
				from: { person: "anita" },
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
];

/** Past runs of routines that post to their bot's chat, so their chats and run lists have history. */
const ROUTINE_RUNS: readonly RoutineRun[] = [
	{
		pod: "support",
		bot: "Ticket Desk",
		routine: "Morning queue",
		scheduledAt: { time: "8:30", day: "previous weekday" },
		finishedAt: { time: "8:32", day: "previous weekday" },
		result:
			"Morning queue: 4 new tickets overnight.\n\n- Answered 3 how-to questions (exports, seat changes, SSO setup)\n- Oakridge: asking about invoices in AUD. Needs a person\n\nOldest waiting: Oakridge, 9 hours.",
	},
	{
		pod: "support",
		bot: "Ticket Desk",
		routine: "Morning queue",
		scheduledAt: { time: "8:30" },
		finishedAt: { time: "8:33" },
		result:
			"Morning queue: 7 new tickets overnight.\n\n- Answered 4 how-to questions (exports, SSO setup, seat changes)\n- Kestrel Freight: charged twice on 3 Oct. Needs a refund\n- Brightline: can't sign in since the SSO change. Handed to Doreen\n- Oakridge: still waiting on AUD invoices. Needs a person\n\nOldest waiting: Oakridge, 33 hours.",
	},
	{
		pod: "growth",
		bot: "Growth Desk",
		routine: "Monday pipeline summary",
		scheduledAt: { time: "9:00", day: "previous monday" },
		finishedAt: { time: "9:02", day: "previous monday" },
		result:
			"Last week's pipeline:\n\n- **Closed:** Lumen Health (Business, 60 seats), Parcel & Co (Team, 12 seats)\n- **Slipped:** Brightwater Supply, now waiting on pricing\n- **Needs a reply today:** Fernhill Outfitters asked about Business pricing\n\nNew annual revenue: $64,300.",
	},
];

/** The pods' MCP servers, signed out: sign in to one in Settings to use it for real. */
/** Linear's own MCP tools, so its connection's permissions look as they do when signed in for real. */
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
function connectionTool(name: string, { readOnly }: { readOnly: boolean }) {
	const words = name.replaceAll("_", " ");
	return {
		name,
		description: words[0]?.toUpperCase() + words.slice(1),
		readOnly,
		destructive: name.startsWith("delete_"),
	};
}

const CONNECTIONS: readonly SeedConnection[] = [
	{
		pod: "support",
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
		pod: "engineering",
		name: "Linear",
		handle: "linear",
		url: "https://mcp.linear.app/mcp",
		tools: [
			...LINEAR_READING.map((name) => connectionTool(name, { readOnly: true })),
			...LINEAR_CHANGES.map((name) => connectionTool(name, { readOnly: false })),
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
		pod: "engineering",
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
	const installation = yield* Installation.Service;
	if (installation.isProduction) {
		return yield* Effect.die(new Error("The showcase seed cannot run in production."));
	}

	const people = yield* Effect.forEach(
		Object.entries(PEOPLE) as [PersonKey, (typeof PEOPLE)[PersonKey]][],
		([key, person]) =>
			Effect.gen(function* () {
				const id = yield* ensureAccount({
					name: person.name,
					email: person.email,
					password: PASSWORD,
				});
				yield* query((db) => db.update(user).set({ image: person.image }).where(eq(user.id, id)));
				return [key, id] as const;
			}),
	).pipe(Effect.map((entries) => Object.fromEntries(entries) as Record<PersonKey, string>));

	const workspaceId = yield* ensureWorkspace(people[OWNER]);
	yield* Onboarding.recordSetupCompleted(workspaceId);
	yield* Effect.forEach(
		(Object.keys(PEOPLE) as PersonKey[]).filter((key) => key !== OWNER),
		(key) =>
			joinWorkspace({
				workspaceId,
				ownerId: people[OWNER],
				email: PEOPLE[key].email,
				userId: people[key],
			}),
		{ discard: true },
	);

	const podIds = yield* ensurePods(workspaceId, people);
	yield* ensureProviders(workspaceId, people[OWNER]);
	const offered = yield* offeredModels(workspaceId);
	const botIds = yield* Effect.forEach(BOTS, (bot) =>
		Effect.map(
			ensureBot({
				workspaceId,
				podId: podIds[bot.pod],
				createdById: people[OWNER],
				bot,
				model: chooseModel(bot, offered),
			}),
			(id) => [bot.name, id] as const,
		),
	).pipe(Effect.map((entries) => new Map(entries)));

	yield* Effect.forEach(
		ROUTINES,
		({ bot, routine }) => {
			const agentId = botIds.get(bot);
			return agentId
				? ensureRoutine({ agentId, routine })
				: Effect.die(new Error(`No bot is named ${bot}`));
		},
		{ discard: true },
	).pipe(CurrentActor.provide(CurrentActor.AuthenticatedUserId.vouchedFor(people[OWNER])));
	yield* holdScheduledRoutines(workspaceId);

	yield* ensureConnections({
		workspaceId,
		podIds,
		createdById: people[OWNER],
		connections: CONNECTIONS,
	});
	const conversations = yield* ensureConversations(
		{
			workspaceId,
			people,
			podIds,
			botIds,
			botModels: new Map(BOTS.map((bot) => [bot.name, chooseModel(bot, offered)])),
		},
		SCENES,
		ROUTINE_RUNS,
	);

	const ledgerRows = yield* fillLedger({ workspaceId, podIds, botIds });

	console.log(`workspace ${WORKSPACE.slug}, owned by ${PEOPLE[OWNER].email}`);
	console.log(
		`people: ${Object.values(PEOPLE)
			.map((person) => person.email)
			.join(", ")} (password: ${PASSWORD})`,
	);
	console.log(
		offered.length === 0
			? "The workspace offers no models yet: connect providers in Settings, then run this again."
			: `bots on: ${BOTS.map((bot) => `${bot.name} → ${chooseModel(bot, offered)}`).join(", ")}`,
	);
	console.log(
		conversations === 0
			? "conversations already there"
			: `conversations: ${conversations} chats and routine runs written`,
	);
	console.log(
		ledgerRows === 0
			? "usage history already there"
			: `usage history: ${ledgerRows} model requests over ${LEDGER_DAYS} days`,
	);
});

/** Made the way the app makes one, so it has its system agents, preset providers and the owner's Personal pod. */
const ensureWorkspace = (ownerId: string) =>
	Effect.gen(function* () {
		const membership = yield* Membership.Service;
		return yield* membership
			.create({
				details: {
					...WORKSPACE,
					timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				},
			})
			.pipe(
				CurrentActor.provide(CurrentActor.AuthenticatedUserId.vouchedFor(ownerId)),
				Effect.map((created) => created.id),
				Effect.catchTag("SlugTaken", () =>
					Effect.flatMap(
						query((db) =>
							db
								.select({ id: workspace.id })
								.from(workspace)
								.where(eq(workspace.slug, WORKSPACE.slug)),
						),
						([row]) =>
							row ? Effect.succeed(row.id) : Effect.die(new Error("The workspace is missing")),
					),
				),
			);
	});

/** By invitation, the way a teammate joins, which also gives them their Personal pod. */
const joinWorkspace = (input: {
	workspaceId: string;
	ownerId: string;
	email: string;
	userId: string;
}) =>
	Effect.gen(function* () {
		const membership = yield* Membership.Service;
		const invite = (resend: boolean) =>
			membership
				.invite({
					workspace: input.workspaceId,
					invitation: { email: input.email, role: "member", resend },
				})
				.pipe(CurrentActor.provide(CurrentActor.AuthenticatedUserId.vouchedFor(input.ownerId)));
		const invitation = yield* invite(false).pipe(
			Effect.catchTag("AlreadyInvited", () => invite(true)),
			Effect.catchTag("AlreadyMember", () => Effect.succeed(undefined)),
			Effect.orDie,
		);
		if (!invitation) return;
		yield* membership
			.accept({ invitationId: invitation.id })
			.pipe(
				CurrentActor.provide(CurrentActor.AuthenticatedUserId.vouchedFor(input.userId)),
				Effect.orDie,
			);
	});

/** The shared pods with their members, and the owner's Personal pod, by key. */
const ensurePods = (workspaceId: string, people: Record<PersonKey, string>) =>
	Effect.gen(function* () {
		const pods = yield* PodRepository.Service;
		const personalPods = yield* PersonalPods.Service;
		const personal = yield* personalPods.provision({ workspaceId, userId: people[OWNER] });
		const shared = yield* Effect.forEach(
			Object.entries(SHARED_PODS) as [SharedPodKey, (typeof SHARED_PODS)[SharedPodKey]][],
			([key, { name, color, members }]) =>
				Effect.gen(function* () {
					const podId = yield* pods
						.create(workspaceId, { creatorId: people[OWNER], name, slug: key, color })
						.pipe(
							Effect.map((created) => created.id),
							Effect.catchTag("PodSlugTaken", () => podIdBySlug(workspaceId, key)),
						);
					yield* Effect.forEach(
						members,
						(member) => pods.addMember(workspaceId, podId, people[member]),
						{ discard: true },
					);
					return [key, podId] as const;
				}),
		);
		return { ...Object.fromEntries(shared), personal: personal.id } as Record<
			SharedPodKey | "personal",
			string
		>;
	});

const podIdBySlug = (workspaceId: string, slug: string) =>
	Effect.flatMap(
		query((db) =>
			db
				.select({ id: pod.id })
				.from(pod)
				.where(and(eq(pod.workspaceId, workspaceId), eq(pod.slug, slug), eq(pod.kind, "shared"))),
		),
		([row]) => (row ? Effect.succeed(row.id) : Effect.die(new Error(`Pod ${slug} is missing`))),
	);

/**
 * The catalog providers the bots prefer that a new workspace isn't given,
 * added switched off and without a key, so the ledger's history names them.
 * Connecting one is left to Settings.
 */
const ensureProviders = (workspaceId: string, createdById: string) =>
	Effect.gen(function* () {
		const providers = yield* ModelProviderRepository.Service;
		const presets = new Set(BOTS.flatMap((bot) => bot.models.map((choice) => choice.preset)));
		yield* Effect.forEach(
			presets,
			(preset) =>
				providers
					.create(workspaceId, { createdById, provider: { preset } })
					.pipe(Effect.catchTag("ModelProviderNameConflict", () => Effect.void)),
			{ discard: true },
		);
	});

interface OfferedModel {
	modelId: string;
	preset: ProviderPresetId | null;
	isDefault: boolean;
}

/** The models the workspace's active providers offer its bots. */
const offeredModels = (workspaceId: string) =>
	query((db) =>
		db
			.select({
				modelId: providerModel.modelId,
				preset: modelProvider.preset,
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
					preset: row.preset,
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
			(model) => model.preset === choice.preset && choice.matches.test(model.modelId),
		);
		if (match) return match.modelId;
	}
	return offered.find((model) => model.isDefault)?.modelId ?? bot.models[0].ledgerModel;
}

/** Creates the bot, or moves the one a previous run made onto `model`. */
const ensureBot = (input: {
	workspaceId: string;
	podId: string;
	createdById: string;
	bot: SeedBot;
	model: string;
}) =>
	Effect.gen(function* () {
		const agents = yield* AgentRepository.Service;
		const { bot } = input;
		const created = yield* agents
			.create(input.workspaceId, {
				createdById: input.createdById,
				agent: {
					podId: input.podId,
					name: bot.name,
					color: bot.color,
					face: bot.face,
					shape: bot.shape,
					description: bot.description,
					prompt: bot.prompt,
					model: input.model,
					usesSandbox: bot.usesSandbox ?? false,
				},
			})
			.pipe(
				Effect.map((row) => row.id),
				Effect.catchTag("AgentNameTaken", () => Effect.succeed(undefined)),
				Effect.orDie,
			);
		if (created) return created;
		const [existing] = yield* query((db) =>
			db
				.select({ id: agent.id })
				.from(agent)
				.where(and(eq(agent.podId, input.podId), eq(agent.name, bot.name))),
		);
		if (!existing) {
			return yield* Effect.die(new Error(`${bot.name} is named by another pod's bot`));
		}
		yield* agents
			.update(input.workspaceId, existing.id, { model: input.model, shape: bot.shape })
			.pipe(Effect.orDie);
		return existing.id;
	});

const ensureRoutine = (input: { agentId: string; routine: NewRoutine }) =>
	Effect.gen(function* () {
		const routines = yield* Routines.Service;
		yield* routines.create({ agentId: input.agentId }, input.routine).pipe(
			Effect.asVoid,
			Effect.catchTag("RoutineNameTaken", () => Effect.void),
			Effect.orDie,
		);
	});

/** How far off the seeded routines' next runs are put. */
const ROUTINE_HOLD_DAYS = 365;

/**
 * Puts every scheduled trigger's next run a year out, so the routines show as
 * on, with their schedules, but never come due while the showcase is in use.
 * Due, they would run, and fail where the workspace offers no model. A paused
 * routine's schedule has no next run, and keeps none.
 */
const holdScheduledRoutines = (workspaceId: string) =>
	query((db) =>
		db
			.update(routineTrigger)
			.set({ nextScheduledAt: new Date(Date.now() + ROUTINE_HOLD_DAYS * MILLISECONDS_PER_DAY) })
			.where(
				and(
					eq(routineTrigger.workspaceId, workspaceId),
					eq(routineTrigger.kind, "cron"),
					isNotNull(routineTrigger.nextScheduledAt),
				),
			),
	);

type ScheduledTrigger = Extract<NewRoutine["triggers"][number], { kind: "cron" }>;

function weekly(
	days: readonly ("mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun")[],
	times: readonly number[],
): ScheduledTrigger {
	return {
		kind: "cron",
		schedule: { repeat: "weekly", every: 1, days, times, startsOn: today() },
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	};
}

function daily(times: readonly number[]): ScheduledTrigger {
	return {
		kind: "cron",
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
 * page has days, bots, models and pods to show. Skipped when an earlier run
 * wrote them: seeded rows are the only agent turns with no turn.
 */
const fillLedger = (input: {
	workspaceId: string;
	podIds: Record<SharedPodKey | "personal", string>;
	botIds: ReadonlyMap<string, string>;
}) =>
	Effect.gen(function* () {
		const [seeded] = yield* query((db) =>
			db
				.select({ id: modelRequest.id })
				.from(modelRequest)
				.where(
					and(
						eq(modelRequest.workspaceId, input.workspaceId),
						eq(modelRequest.purpose, "agent-turn"),
						isNull(modelRequest.turnId),
					),
				)
				.limit(1),
		);
		if (seeded) return 0;

		const providers = yield* query((db) =>
			db
				.select({ id: modelProvider.id, preset: modelProvider.preset })
				.from(modelProvider)
				.where(eq(modelProvider.workspaceId, input.workspaceId)),
		);
		const providerIdByPreset = new Map(providers.map((row) => [row.preset, row.id]));
		const random = seededRandom(LEDGER_DAYS);
		const now = Date.now();
		const rows: (typeof modelRequest.$inferInsert)[] = [];

		for (let daysAgo = LEDGER_DAYS - 1; daysAgo >= 0; daysAgo--) {
			const day = new Date(now - daysAgo * MILLISECONDS_PER_DAY);
			day.setHours(WORKDAY_START_HOUR, 0, 0, 0);
			const isWeekend = day.getDay() === 0 || day.getDay() === 6;
			for (const bot of BOTS) {
				const [choice] = bot.models;
				const providerId = providerIdByPreset.get(choice.preset);
				const agentId = input.botIds.get(bot.name);
				if (!providerId || !agentId) continue;
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
						purpose: "agent-turn",
						podId: input.podIds[bot.pod],
						agentId,
						step: 0,
						providerId,
						preset: choice.preset,
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
	if (choice.preset === "ollama") return "local";
	if (choice.preset === "chatgpt") return "subscription";
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
			Membership.layer,
			PersonalPods.layer,
			PodRepository.layer,
			AgentRepository.layer,
			ModelProviderRepository.layer,
			Artifacts.authoringLayer,
			// The seed defines routines and never runs one, which is all these are for.
			Routines.layer.pipe(
				Layer.provide([
					unimplemented(RoutineRuns.Service, {}),
					unimplemented(ConversationEvents.Service, {}),
				]),
			),
		).pipe(
			Layer.provideMerge(
				Layer.mergeAll(
					Credentials.layer,
					seedAccountsLayer,
					BlobStore.layer,
					Layer.succeed(Email.Service, Email.Service.of({ send: () => Effect.void })),
				).pipe(
					Layer.provideMerge(Ids.layer),
					Layer.provideMerge(Installation.layer),
					Layer.provideMerge(databaseLayer),
				),
			),
		),
	),
	NodeRuntime.runMain,
);
