import {
	type FailureOf,
	type InputOf,
	operationContracts,
	type RequestOperationName,
} from "@sugabots/contracts/operations";
import { eq } from "drizzle-orm";
import { Layer, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Accounts } from "../accounts/accounts.ts";
import {
	seedAutomation,
	seedBot,
	seedConnector,
	seedInvitation,
	seedMember,
	seedMessage,
	seedPage,
	seedProject,
	seedProjectChat,
	seedRun,
	seedTurnAnswering,
	seedWebhookTrigger,
	unique,
} from "../authentication/seed.test-support.ts";
import {
	bot,
	computerProvider,
	membership,
	modelProvider,
	projectMember,
	providerModel,
	searchProvider,
} from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { Files } from "../files/files.ts";
import type { Principal } from "../principal.ts";
import {
	authenticators,
	buildWorld,
	everyKindOfPrincipal,
	principals,
	type World,
} from "../proofs/world.test-support.ts";
import { createEgressUrlValidator, Egress, urlValidation } from "../providers/network/egress.ts";
import { unimplemented } from "../testing.ts";
import { type CallOperation, operationOutcome, servedOperations } from "./testing.ts";

/**
 * Who may call each operation: every one in the registry, called through it
 * as an entrypoint calls it, by each kind of principal. Each row states the
 * operation's rule as what every principal comes to: allowed, or the refusal
 * its proofs answer with. Domain failures count as allowed only where the row
 * names the expected failure for its fixture.
 *
 * The world is `buildWorld`'s: in workspace A, Ed (an editor) made the public
 * bot Pub, which leads the private project J with Helper in it; Ed, Vi (a
 * viewer) and Quinn are in J, and Erin (an editor) isn't. Ed and the admin
 * each have a Personal Assistant, a personal bot, which acts in member bounds.
 */

/** The model workspace A offers, which every bot in it runs on. */
const OFFERED = "offered-model";

/** An address on this machine where nothing answers, so a request to it fails at once. */
const NOWHERE = "http://127.0.0.1:9";

const PRINCIPALS = [
	"admin",
	"editor",
	"viewer",
	"editorOutsideJ",
	"outsider",
	/** Pub answering Ed in J's chat. */
	"botInChatBounds",
	/** Pub answering the admin in J's chat. */
	"adminsBotInChatBounds",
	/** Helper answering Ed in K's chat, though both reach J. */
	"botOutsideBounds",
	/** Ed's Personal Assistant in its own chat. */
	"botInMemberBounds",
	"adminsBotInMemberBounds",
	/** A run of an automation of J. */
	"run",
	/** A call to a webhook trigger of an automation of J. */
	"webhook",
	/** Putting J's computer to sleep. */
	"systemWork",
	/** Whoever holds the address of a page in J's chat. */
	"page",
] as const;

type Caller = (typeof PRINCIPALS)[number];

/**
 * A call succeeds, reaches the expected domain failure for its fixture, or
 * fails with the specified refusal.
 */
type Outcome = "ok" | "ResourceHidden" | "ActionForbidden" | "ApprovalNeeded" | "BotCannotReach";

type Rule = Readonly<Record<Caller, Outcome>>;

const everyone = (outcome: Outcome): Rule =>
	Object.fromEntries(PRINCIPALS.map((caller) => [caller, outcome])) as Rule;

const MEMBERS = ["admin", "editor", "viewer", "editorOutsideJ"] as const;
const BOTS_FOR_ASKERS = [
	"botInChatBounds",
	"adminsBotInChatBounds",
	"botOutsideBounds",
	"botInMemberBounds",
	"adminsBotInMemberBounds",
] as const;
const IN_MEMBER_BOUNDS = ["botInMemberBounds", "adminsBotInMemberBounds"] as const;

const allowing = (rule: Rule, callers: readonly Caller[], outcome: Outcome = "ok"): Rule => ({
	...rule,
	...Object.fromEntries(callers.map((caller) => [caller, outcome])),
});

/** What a member signed in does for themselves alone, such as listing their workspaces. */
const ownOnly = allowing(everyone("ActionForbidden"), [...MEMBERS, "outsider"]);

/** What a member of A does for themselves alone there, such as making a Personal Assistant. */
const ownInA = { ...ownOnly, outsider: "ResourceHidden" } as const satisfies Rule;

/** Reading A as its directory shows it: any member, and a bot only in member bounds. */
const readsA = allowing({ ...everyone("ActionForbidden"), outsider: "ResourceHidden" }, [
	...MEMBERS,
	...IN_MEMBER_BOUNDS,
]);

/** Managing A: its owner and admins, and a bot only in member bounds, for one of them. */
const managesA = allowing({ ...everyone("ActionForbidden"), outsider: "ResourceHidden" }, [
	"admin",
	"adminsBotInMemberBounds",
]);

/** Making something in A: any member but viewers, and a bot only in member bounds. */
const makesInA = allowing({ ...everyone("ActionForbidden"), outsider: "ResourceHidden" }, [
	"admin",
	"editor",
	"editorOutsideJ",
	...IN_MEMBER_BOUNDS,
]);

/** Hidden from whoever doesn't reach J, and from a bot outside the bounds that do. */
const outsideJ = {
	editorOutsideJ: "ResourceHidden",
	outsider: "ResourceHidden",
	botOutsideBounds: "ResourceHidden",
	webhook: "ResourceHidden",
	systemWork: "ResourceHidden",
	page: "ResourceHidden",
} as const;

/** Reading J: whoever reaches it, within a turn's bounds. */
const readsJ = { ...everyone("ok"), ...outsideJ } satisfies Rule;

/** What a member who reaches J does for themselves there, such as posting or choosing their notifications. */
const memberInJ = allowing(
	{ ...everyone("ActionForbidden"), editorOutsideJ: "ResourceHidden", outsider: "ResourceHidden" },
	["admin", "editor", "viewer"],
);

/** Changing J's chats: whoever reaches J but viewers, within a turn's bounds. */
const changesJsChats = { ...readsJ, viewer: "ActionForbidden" } as const satisfies Rule;

/** Changing who is in J: anyone in it but viewers, and a bot only in member bounds. */
const changesWhoIsInJ = {
	...changesJsChats,
	botInChatBounds: "ActionForbidden",
	adminsBotInChatBounds: "ActionForbidden",
	run: "ActionForbidden",
} as const satisfies Rule;

/** Managing J: those who manage it, and a bot within its bounds acting for one; never a run. */
const managesJ = {
	...readsJ,
	editor: "ActionForbidden",
	viewer: "ActionForbidden",
	botInChatBounds: "ActionForbidden",
	botInMemberBounds: "ActionForbidden",
	run: "ActionForbidden",
} as const satisfies Rule;

/** Changing J's settings or allowed hosts, which a bot may do only in member bounds. */
const managesJInMemberBounds = {
	...managesJ,
	adminsBotInChatBounds: "ActionForbidden",
} as const satisfies Rule;

/** Managing J as a member signed in, which no bot does for them. */
const managesJSignedIn = {
	...managesJ,
	adminsBotInChatBounds: "ActionForbidden",
	adminsBotInMemberBounds: "ActionForbidden",
} as const satisfies Rule;

/** A bot's tool on its own turn's chat: every bot in a turn, and nobody else. */
const inItsTurn = allowing(everyone("ResourceHidden"), [...BOTS_FOR_ASKERS, "run"]);

/** `rule` on a project outside every turn's bounds, which J's bots and run don't reach. */
const onAnotherProject = (rule: Rule): Rule => ({
	...rule,
	botInChatBounds: "ResourceHidden",
	adminsBotInChatBounds: "ResourceHidden",
	run: "ResourceHidden",
});

/** `rule` with every bot it allows waiting for its approver first. */
const askingEveryBot = (rule: Rule): Rule => ({
	...rule,
	...Object.fromEntries(
		BOTS_FOR_ASKERS.filter((caller) => rule[caller] === "ok").map((caller) => [
			caller,
			"ApprovalNeeded",
		]),
	),
});

/** `rule` with a personal bot's change waiting for its creator, as each one does. */
const askingPersonalBots = (rule: Rule): Rule => ({
	...rule,
	...Object.fromEntries(
		IN_MEMBER_BOUNDS.filter((caller) => rule[caller] === "ok").map((caller) => [
			caller,
			"ApprovalNeeded",
		]),
	),
});

type Who = Awaited<ReturnType<typeof everyKindOfPrincipal>>;

/** What a row's input is made from: the world, and the registry to set things up through. */
interface Fixture {
	readonly a: World["a"];
	readonly who: Who;
	readonly call: CallOperation;
	readonly gitHubConnector: string;
}

/**
 * An operation's rule, with the input it is called with, made afresh for each
 * principal so one principal's change never decides another's outcome.
 */
interface Row<Name extends RequestOperationName> {
	readonly input: (fixture: Fixture) => Promise<InputOf<Name>> | InputOf<Name>;
	readonly outcomes: Rule;
	readonly postProofFailure?: FailureOf<Name>["_tag"];
}

/** An operation exercised outside the table, with its coverage recorded here. */
interface TestedElsewhere {
	readonly testedIn: string;
}

/** Fresh targets in workspace A, each in J unless it says otherwise. */
const fresh = {
	chat: ({ a }: Fixture) => seedProjectChat(a.workspace, a.project, a.ed),
	page: async (fixture: Fixture) => seedPage(await fresh.chat(fixture)),
	/** A file Pub wrote, with its content stored. */
	writtenFile: async (fixture: Fixture) => {
		const chatId = await fresh.chat(fixture);
		const written = await runOnPostgres(
			Files.seedWrittenFile(
				{ botId: fixture.a.pub.id, chatId },
				{ kind: "markdown", title: "Notes", content: "# Notes" },
			),
		);
		return { chatId, fileId: written.id };
	},
	runChat: async ({ a }: Fixture) => {
		const automationId = await seedAutomation(a.workspace, a.project);
		return (await seedRun(a.workspace, automationId, a.pub.id, "manual")).chat;
	},
	/** A new private project like J, which no turn's bounds take in. */
	project: ({ a }: Fixture, visibility: "public" | "private" = "private") =>
		seedProject(a.workspace, {
			leadBotId: a.pub.id,
			bots: [a.helper.id],
			members: [a.ed, a.vi, a.quinn],
			visibility,
		}),
	automation: async ({ a }: Fixture) => ({
		projectId: a.project,
		automationId: await seedAutomation(a.workspace, a.project),
	}),
	trigger: async (fixture: Fixture) => {
		const automation = await fresh.automation(fixture);
		const triggerId = await seedWebhookTrigger(
			automation.automationId,
			fixture.a.workspace,
			{ kind: "bearer" },
			null,
		);
		return { ...automation, triggerId };
	},
	connector: async ({ a }: Fixture) => ({
		projectId: a.project,
		connectorId: await seedConnector(a.workspace, a.project),
	}),
	computerProvider: async ({ a }: Fixture) => {
		const [row] = await onDatabase((db) =>
			db
				.insert(computerProvider)
				.values({ workspaceId: a.workspace, settings: { builtIn: "e2b" } })
				.returning({ id: computerProvider.id }),
		);
		if (!row) throw new Error("Expected a computer provider");
		return { workspace: a.workspace, providerId: row.id };
	},
	/** A model provider of A with no credential, and one model. */
	modelProvider: async ({ a }: Fixture) => {
		const [row] = await onDatabase((db) =>
			db
				.insert(modelProvider)
				.values({
					workspaceId: a.workspace,
					name: `Models ${unique()}`,
					baseUrl: "https://models.example/v1",
					apiFormat: "openai",
					active: true,
				})
				.returning({ id: modelProvider.id }),
		);
		if (!row) throw new Error("Expected a model provider");
		const modelId = `model-${unique()}`;
		await onDatabase((db) =>
			db.insert(providerModel).values({
				workspaceId: a.workspace,
				providerId: row.id,
				modelId,
				enabled: true,
				source: "manual",
			}),
		);
		return { workspace: a.workspace, providerId: row.id, modelId };
	},
	/** The membership of a new editor of A. */
	membership: async ({ a }: Fixture) => {
		const memberId = await seedMember(a.workspace, "editor");
		const [row] = await onDatabase((db) =>
			db.select({ id: membership.id }).from(membership).where(eq(membership.memberId, memberId)),
		);
		if (!row) throw new Error("Expected a membership");
		return row.id;
	},
	editorInJ: async ({ a }: Fixture) => {
		const memberId = await seedMember(a.workspace, "editor");
		await onDatabase((db) =>
			db.insert(projectMember).values({ workspaceId: a.workspace, projectId: a.project, memberId }),
		);
		return memberId;
	},
	host: () => `host-${unique()}.example.com`,
};

const inA = ({ a }: Fixture) => ({ workspace: a.workspace });
const inJ = ({ a }: Fixture) => ({ projectId: a.project });
const inGitHubApp = ({ a, gitHubConnector }: Fixture) => ({
	projectId: a.project,
	connectorId: gitHubConnector,
});
const freshChat = async (fixture: Fixture) => ({ chatId: await fresh.chat(fixture) });
const freshPage = async (fixture: Fixture) => ({ fileId: await fresh.page(fixture) });
const freshProject = async (fixture: Fixture) => ({ projectId: await fresh.project(fixture) });
const configuredSearch = async ({ a }: Fixture) => {
	await onDatabase((db) =>
		db
			.insert(searchProvider)
			.values({ workspaceId: a.workspace, builtIn: "brave", baseUrl: "https://search.example" })
			.onConflictDoNothing({ target: searchProvider.workspaceId }),
	);
	return { workspace: a.workspace };
};
const freshModelProvider = async (fixture: Fixture) => {
	const { workspace, providerId } = await fresh.modelProvider(fixture);
	return { workspace, providerId };
};
const onAHost = ({ a }: Fixture) => ({ workspace: a.workspace, host: fresh.host() });
const onAHostOfJ = ({ a }: Fixture) => ({ projectId: a.project, host: fresh.host() });

const TURN_STEPS =
	"The loop exercises valid calls in packages/bot-loop/src. Shared turn ownership, reach and loss are exercised in proofs/turns.test.ts.";
const STORED_WORK =
	"Scheduler dispatch and effects: packages/server/src/scheduler/scheduler.test.ts. These cases use authenticated work.";
const COMPUTER_TOOLS =
	"Computer behavior: chats/tools/computer.test.ts. Tool dispatch, reach and approval: packages/bot-loop/src/computer-tools.test.ts.";

const rows: {
	readonly [Name in RequestOperationName]: Row<Name> | TestedElsewhere;
} = {
	"workspaces.list": { input: () => ({}), outcomes: ownOnly },
	"workspaces.create": {
		input: () => ({ name: "Elsewhere", slug: `elsewhere-${unique()}`, timeZone: "UTC" }),
		outcomes: ownOnly,
	},
	"referrals.link": { input: () => ({}), outcomes: ownOnly },
	"referrals.resetLink": { input: () => ({}), postProofFailure: "ReferralsOff", outcomes: ownOnly },
	"system.rename": { input: () => ({ name: "Renamed" }), outcomes: ownOnly },
	"notifications.settings": { input: () => ({}), outcomes: ownOnly },
	"notifications.updatePreferences": {
		input: () => ({
			level: "all",
			pausedUntil: null,
			quietHours: null,
			turnFailures: true,
			automationRuns: "all",
		}),
		outcomes: ownOnly,
	},
	"notifications.sendTest": { input: () => ({}), outcomes: ownOnly },
	"notifications.reportPresence": {
		input: () => ({ clientId: crypto.randomUUID(), chatId: null, sequence: 1 }),
		outcomes: ownOnly,
	},
	"bots.createAssistant": { input: inA, outcomes: ownInA },

	"workspaces.guide": {
		input: () => ({}),
		outcomes: allowing(everyone("ResourceHidden"), IN_MEMBER_BOUNDS),
	},
	"workspaces.memberships": { input: inA, outcomes: readsA },
	"workspaces.invitations": { input: inA, outcomes: readsA },
	"system.workspaceAccess": { input: inA, outcomes: readsA },
	"projects.list": { input: inA, outcomes: readsA },
	"bots.list": { input: inA, outcomes: readsA },
	"systemBots.list": { input: inA, outcomes: readsA },
	"computerProviders.access": { input: inA, outcomes: readsA },
	"modelProviders.listEnabledModels": { input: inA, outcomes: readsA },
	"searchProviders.webAccess": { input: inA, outcomes: readsA },
	"chats.attention": { input: inA, outcomes: readsA },
	"chats.attentionMarks": { input: inA, outcomes: readsA },
	"chats.approvals": { input: inA, outcomes: readsA },
	"computerProviders.disks": {
		input: inA,
		// Each sees the computers of what it reaches, which may be none.
		outcomes: { ...everyone("ok"), outsider: "ResourceHidden" },
	},

	"bots.create": {
		input: ({ a }) => ({ workspace: a.workspace, name: `Bot ${unique()}`, model: OFFERED }),
		outcomes: makesInA,
	},
	"projects.create": {
		input: ({ a }) => ({
			workspace: a.workspace,
			name: `Project ${unique()}`,
			leadBotId: a.pub.id,
		}),
		outcomes: askingEveryBot(makesInA),
	},

	"workspaces.update": {
		input: ({ a }) => ({ workspace: a.workspace, name: "Workspace A", slug: `a-${a.workspace}` }),
		outcomes: managesA,
	},
	"workspaces.timeZone": { input: inA, outcomes: managesA },
	"workspaces.changeTimeZone": {
		input: ({ a }) => ({ workspace: a.workspace, timeZone: "UTC" }),
		outcomes: managesA,
	},
	"usage.month": {
		input: ({ a }) => ({ workspace: a.workspace, month: "2026-09" }),
		outcomes: managesA,
	},
	"workspaces.changeRole": {
		input: async (fixture) => ({
			workspace: fixture.a.workspace,
			membershipId: await fresh.membership(fixture),
			role: "viewer",
		}),
		outcomes: managesA,
	},
	"workspaces.removeMembership": {
		input: async (fixture) => ({
			workspace: fixture.a.workspace,
			membershipId: await fresh.membership(fixture),
		}),
		outcomes: managesA,
	},
	"workspaces.invite": {
		input: ({ a }) => ({
			workspace: a.workspace,
			email: `invited-${unique()}@example.com`,
			role: "editor",
		}),
		outcomes: managesA,
	},
	"workspaces.cancelInvitation": {
		input: async ({ a }) => ({
			invitationId: await seedInvitation(a.workspace, a.owner, {
				email: `invited-${unique()}@example.com`,
			}),
		}),
		// Its invitation names the workspace, which only a member is in.
		outcomes: {
			...managesA,
			run: "ResourceHidden",
			webhook: "ResourceHidden",
			systemWork: "ResourceHidden",
			page: "ResourceHidden",
		},
	},
	"workspaceSetup.complete": {
		// The first bot is one its manager made.
		input: async ({ a }) => {
			const target = await seedBot(a.workspace, { createdById: a.admin });
			await onDatabase((db) => db.update(bot).set({ model: OFFERED }).where(eq(bot.id, target.id)));
			return { workspaceId: a.workspace, botId: target.id };
		},
		outcomes: managesA,
	},
	"systemBots.update": {
		input: ({ a }) => ({ workspace: a.workspace, key: "compact", model: OFFERED }),
		outcomes: managesA,
	},
	"computerProviders.list": { input: inA, outcomes: managesA },
	"computerProviders.network": { input: inA, outcomes: managesA },
	"computerProviders.create": {
		input: ({ a }) => ({ workspace: a.workspace, settings: { builtIn: "e2b" } }),
		outcomes: managesA,
	},
	"computerProviders.update": {
		input: async (fixture) => ({
			...(await fresh.computerProvider(fixture)),
			changes: { enabled: false },
		}),
		outcomes: managesA,
	},
	"computerProviders.remove": { input: fresh.computerProvider, outcomes: managesA },
	"computerProviders.template": { input: fresh.computerProvider, outcomes: managesA },
	"computerProviders.prepareTemplate": {
		input: fresh.computerProvider,
		postProofFailure: "NoTemplates",
		outcomes: managesA,
	},
	"computerProviders.test": { input: fresh.computerProvider, outcomes: managesA },
	"computerProviders.addHost": { input: onAHost, outcomes: managesA },
	"computerProviders.removeHost": { input: onAHost, outcomes: managesA },
	"computerProviders.blockHost": { input: onAHost, outcomes: managesA },
	"computerProviders.unblockHost": { input: onAHost, outcomes: managesA },
	"modelProviders.list": { input: inA, outcomes: managesA },
	"modelProviders.setDefaultModel": {
		input: ({ a }) => ({ workspace: a.workspace, model: OFFERED }),
		outcomes: managesA,
	},
	"modelProviders.create": {
		input: ({ a }) => ({
			workspace: a.workspace,
			provider: {
				name: `Gateway ${unique()}`,
				baseUrl: "https://models.example/v1",
				apiFormat: "openai",
				customHeaders: [],
			},
		}),
		outcomes: managesA,
	},
	"modelProviders.update": {
		input: async (fixture) => ({
			...(await freshModelProvider(fixture)),
			changes: { active: true },
		}),
		postProofFailure: "ProviderActivationRequiresCredential",
		outcomes: managesA,
	},
	"modelProviders.remove": { input: freshModelProvider, outcomes: managesA },
	"modelProviders.switchOff": {
		input: async (fixture) => ({ ...(await freshModelProvider(fixture)), moveBots: [] }),
		outcomes: managesA,
	},
	"modelProviders.test": { input: freshModelProvider, outcomes: managesA },
	"modelProviders.startSignIn": {
		input: freshModelProvider,
		postProofFailure: "ProviderSignInNotOffered",
		outcomes: managesA,
	},
	"modelProviders.completeSignIn": {
		testedIn:
			"Only the session that started the attempt may complete it: providers/model-providers/sign-in/sign-in.test.ts.",
	},
	"modelProviders.signOut": {
		input: freshModelProvider,
		postProofFailure: "ProviderSignInNotOffered",
		outcomes: managesA,
	},
	"modelProviders.discoverModels": {
		input: freshModelProvider,
		postProofFailure: "DiscoveryCredentialsMissing",
		outcomes: managesA,
	},
	"modelProviders.addModel": {
		input: async (fixture) => ({
			...(await freshModelProvider(fixture)),
			model: { modelId: `model-${unique()}`, capabilities: [] },
		}),
		postProofFailure: "ProviderModelsRequireCredential",
		outcomes: managesA,
	},
	"modelProviders.updateModel": {
		input: async (fixture) => ({
			...(await fresh.modelProvider(fixture)),
			changes: { enabled: true },
		}),
		postProofFailure: "ProviderModelsRequireCredential",
		outcomes: managesA,
	},
	"modelProviders.switchOffModel": {
		input: fresh.modelProvider,
		postProofFailure: "ProviderModelsRequireCredential",
		outcomes: managesA,
	},
	"searchProviders.get": { input: inA, outcomes: managesA },
	"searchProviders.replace": {
		input: ({ a }) => ({ workspace: a.workspace, builtIn: "brave" }),
		outcomes: managesA,
	},
	"searchProviders.update": {
		input: async (fixture) => ({
			...(await configuredSearch(fixture)),
			changes: { enabled: false },
		}),
		outcomes: managesA,
	},
	"searchProviders.remove": { input: configuredSearch, outcomes: managesA },
	"searchProviders.test": {
		input: configuredSearch,
		outcomes: managesA,
	},

	"workspaces.delete": {
		testedIn: "Done, it leaves no world: workspace/workspace.test.ts, for its owner alone.",
	},
	"workspaces.handOverOwnership": {
		testedIn: "Done, it leaves no world: workspace/workspace.test.ts, for its owner alone.",
	},
	"workspaces.leave": {
		testedIn: "workspace/workspace.test.ts, where a member leaves a workspace of their own.",
	},
	"workspaces.invitation": {
		testedIn: "It is for the address an invitation is sent to: workspace/workspace.test.ts.",
	},
	"workspaces.acceptInvitation": {
		testedIn: "It is for the address an invitation is sent to: workspace/workspace.test.ts.",
	},

	"projects.listMembers": { input: inJ, outcomes: readsJ },
	"projects.listMembersReaching": { input: inJ, outcomes: readsJ },
	"projects.listBots": { input: inJ, outcomes: readsJ },
	"chats.projectChats": { input: inJ, outcomes: readsJ },
	"files.listInProject": { input: inJ, outcomes: readsJ },
	"automations.list": { input: inJ, outcomes: readsJ },
	"automations.projectRuns": {
		input: ({ a }) => ({ projectId: a.project, limit: 20 }),
		outcomes: readsJ,
	},
	"projectComputer.get": { input: inJ, outcomes: readsJ },
	"projectComputer.network": { input: inJ, outcomes: readsJ },
	"connectors.list": { input: inJ, outcomes: readsJ },
	"connectors.get": { input: fresh.connector, outcomes: readsJ },
	"gitHubConnectors.repositories": { input: inGitHubApp, outcomes: readsJ },
	"chats.openAutomationFeed": {
		input: async (fixture) => ({
			workspace: fixture.a.workspace,
			automationId: (await fresh.automation(fixture)).automationId,
		}),
		outcomes: readsJ,
	},
	"chats.messages": {
		input: async (fixture) => ({ ...(await freshChat(fixture)), limit: 10 }),
		outcomes: readsJ,
	},
	"chats.get": {
		input: async (fixture) => ({ ...(await freshChat(fixture)), limit: 10 }),
		outcomes: readsJ,
	},
	"chats.context": { input: freshChat, outcomes: readsJ },
	"files.get": {
		input: async (fixture) => ({ fileId: (await fresh.writtenFile(fixture)).fileId }),
		outcomes: readsJ,
	},
	"files.getVersion": {
		input: async (fixture) => ({ fileId: (await fresh.writtenFile(fixture)).fileId, version: 1 }),
		outcomes: readsJ,
	},
	"files.readWritten": {
		input: async (fixture) => ({ fileId: (await fresh.writtenFile(fixture)).fileId }),
		outcomes: readsJ,
	},
	"files.versions": { input: freshPage, outcomes: readsJ },
	"files.pageAddress": {
		input: async (fixture) => ({ ...(await freshPage(fixture)), version: 1 }),
		outcomes: readsJ,
	},

	"notifications.setLevel": {
		input: ({ a }) => ({ kind: "project", id: a.project, level: "all" }),
		outcomes: memberInJ,
	},
	"notifications.mute": {
		input: ({ a }) => ({ kind: "project", id: a.project, until: "2099-01-01T00:00:00.000Z" }),
		outcomes: memberInJ,
	},
	"chats.startProjectChat": {
		input: ({ a }) => ({ projectId: a.project, retryKey: crypto.randomUUID(), message: "Hello" }),
		outcomes: memberInJ,
	},
	"chats.send": {
		input: async (fixture) => ({
			...(await freshChat(fixture)),
			retryKey: crypto.randomUUID(),
			message: "Ship it?",
		}),
		outcomes: memberInJ,
	},
	"chats.uploadFile": {
		input: async (fixture) => ({
			...(await freshChat(fixture)),
			name: "notes.txt",
			type: "text/plain",
			content: Stream.make(new TextEncoder().encode("notes")),
		}),
		outcomes: memberInJ,
	},
	"chats.react": {
		input: async (fixture) => ({
			messageId: await seedMessage(await fresh.chat(fixture), { member: fixture.a.ed }),
			emoji: "👍",
		}),
		outcomes: memberInJ,
	},
	"chats.unreact": {
		input: async (fixture) => ({
			messageId: await seedMessage(await fresh.chat(fixture), { member: fixture.a.ed }),
			emoji: "👍",
		}),
		outcomes: memberInJ,
	},
	"chats.markRead": { input: freshChat, outcomes: memberInJ },
	"chats.markNestedChatRead": {
		input: async (fixture) => ({ chatId: await fresh.runChat(fixture) }),
		outcomes: memberInJ,
	},
	"events.reportTyping": { input: freshChat, outcomes: memberInJ },
	"chats.interruptTurn": {
		input: async (fixture) => {
			const { chatId } = await freshChat(fixture);
			const turnId = await seedTurnAnswering(chatId, fixture.a.pub.id, { member: fixture.a.ed });
			return { chatId, turnId };
		},
		// Ed's turn: its asker, and whoever manages J.
		outcomes: { ...memberInJ, viewer: "ActionForbidden" },
	},
	"chats.removeFile": {
		testedIn: "Only its uploader removes an unsent attachment: chats/chats.test.ts.",
	},
	"chats.file": {
		testedIn: "It reads an attachment on a message in the chat it names: chats/chats.test.ts.",
	},
	"approvals.decide": {
		testedIn:
			"Its approvers are the call's, by the rule that fits it: chats/chats.test.ts and shown-permissions.test.ts.",
	},

	"chats.setResolved": {
		input: async (fixture) => ({ ...(await freshChat(fixture)), resolved: true }),
		outcomes: askingPersonalBots(changesJsChats),
	},
	"automations.run": {
		input: async (fixture) => ({
			...(await fresh.automation(fixture)),
			requestId: crypto.randomUUID(),
		}),
		outcomes: { ...changesJsChats, run: "ActionForbidden" },
	},

	"projects.addMember": {
		input: async ({ a }) => ({
			projectId: a.project,
			memberId: await seedMember(a.workspace, "editor"),
		}),
		outcomes: changesWhoIsInJ,
	},
	"projects.removeMember": {
		input: async (fixture) => ({
			projectId: fixture.a.project,
			memberId: await fresh.editorInJ(fixture),
		}),
		outcomes: changesWhoIsInJ,
	},
	"projects.addBot": {
		input: async ({ a }) => ({
			projectId: a.project,
			botId: (await seedBot(a.workspace, { createdById: a.erin })).id,
		}),
		outcomes: askingEveryBot(changesWhoIsInJ),
	},
	"projects.removeBot": {
		input: async (fixture) => {
			const { a } = fixture;
			const { id: botId } = await seedBot(a.workspace, { createdById: a.erin });
			await fixture.call(fixture.who.ed, "projects.addBot", { projectId: a.project, botId });
			return { projectId: a.project, botId };
		},
		outcomes: changesWhoIsInJ,
	},
	"projects.leave": {
		input: freshProject,
		// Anyone in it but an administrator, who is in every project.
		outcomes: onAnotherProject({
			...changesWhoIsInJ,
			admin: "ActionForbidden",
			viewer: "ok",
			adminsBotInMemberBounds: "ActionForbidden",
		}),
	},
	"projects.join": {
		input: async (fixture) => ({ projectId: await fresh.project(fixture, "public") }),
		outcomes: onAnotherProject(
			askingEveryBot({ ...readsJ, editorOutsideJ: "ok", run: "ActionForbidden" }),
		),
	},

	"projects.update": {
		input: ({ a }) => ({ projectId: a.project, changes: { name: `J ${unique()}` } }),
		outcomes: managesJInMemberBounds,
	},
	"projectComputer.addHost": { input: onAHostOfJ, outcomes: managesJInMemberBounds },
	"projectComputer.removeHost": { input: onAHostOfJ, outcomes: managesJInMemberBounds },
	"projects.remove": { input: freshProject, outcomes: onAnotherProject(managesJ) },
	"projectComputer.reset": { input: freshProject, outcomes: onAnotherProject(managesJ) },
	"projectComputer.upgrade": {
		input: inJ,
		postProofFailure: "NoComputerProvider",
		outcomes: managesJ,
	},
	"chats.renameChat": {
		input: async (fixture) => ({ ...(await freshChat(fixture)), name: "Launch notes" }),
		outcomes: managesJ,
	},
	"files.remove": { input: freshPage, outcomes: managesJ },
	"automations.remove": { input: fresh.automation, outcomes: managesJ },
	"automations.addTrigger": {
		input: async (fixture) => ({
			...(await fresh.automation(fixture)),
			trigger: { kind: "webhook", auth: { kind: "bearer" } },
		}),
		outcomes: managesJ,
	},
	"automations.updateTrigger": {
		input: async (fixture) => ({
			...(await fresh.trigger(fixture)),
			trigger: { kind: "webhook", auth: { kind: "bearer" } },
		}),
		outcomes: managesJ,
	},
	"automations.removeTrigger": { input: fresh.trigger, outcomes: managesJ },
	"automations.getSecret": { input: fresh.trigger, outcomes: managesJ },
	"automations.rotateSecret": {
		input: async (fixture) => ({ ...(await fresh.trigger(fixture)), secret: undefined }),
		outcomes: managesJ,
	},
	"connectors.create": {
		input: ({ a }) => ({
			projectId: a.project,
			connector: { kind: "http", name: `Alerts ${unique()}`, url: `${NOWHERE}/v2` },
		}),
		outcomes: managesJ,
	},
	"connectors.testUnsaved": {
		input: ({ a }) => ({ projectId: a.project, url: `${NOWHERE}/mcp` }),
		outcomes: managesJ,
	},
	"connectors.update": {
		input: async (fixture) => ({ ...(await fresh.connector(fixture)), changes: { access: "off" } }),
		outcomes: managesJ,
	},
	"connectors.remove": { input: fresh.connector, outcomes: managesJ },
	"connectors.test": { input: fresh.connector, outcomes: managesJ },
	"gitHubConnectors.start": {
		input: ({ a }) => ({ projectId: a.project, organization: undefined }),
		postProofFailure: "ProjectHasGitHubConnector",
		outcomes: managesJ,
	},
	"gitHubConnectors.installUrl": { input: inGitHubApp, outcomes: managesJ },
	"gitHubConnectors.reachableRepositories": {
		input: inGitHubApp,
		postProofFailure: "GitHubAppNotInstalled",
		outcomes: managesJ,
	},
	"gitHubConnectors.addRepository": {
		input: (fixture) => ({ ...inGitHubApp(fixture), repository: "acme/web" }),
		postProofFailure: "GitHubAppNotInstalled",
		outcomes: managesJ,
	},
	"gitHubConnectors.removeRepository": {
		input: (fixture) => ({ ...inGitHubApp(fixture), repository: "acme/web" }),
		outcomes: managesJ,
	},
	"automations.create": {
		input: ({ a }) => ({
			projectId: a.project,
			name: `Automation ${unique()}`,
			instructions: "Tidy up.",
			triggers: [],
		}),
		outcomes: managesJSignedIn,
	},
	"automations.update": {
		input: async (fixture) => ({
			...(await fresh.automation(fixture)),
			changes: { name: `Automation ${unique()}` },
		}),
		outcomes: managesJSignedIn,
	},
	"connectors.startOAuth": {
		input: fresh.connector,
		postProofFailure: "ConnectorDoesNotUseOAuth",
		outcomes: managesJSignedIn,
	},
	"connectors.connectBuiltIn": {
		input: ({ a }) => ({ projectId: a.project, name: `Docs ${unique()}`, url: `${NOWHERE}/mcp` }),
		postProofFailure: "ConnectorOAuthStartFailed",
		outcomes: managesJSignedIn,
	},
	"connectors.oauthCallback": {
		testedIn: "Only the session that started a sign-in finishes it: connectors/connectors.test.ts.",
	},
	"gitHubConnectors.gitHubAppMade": {
		testedIn:
			"The callback must come from the member named by its state: providers/connectors/github/github-app.test.ts.",
	},
	"gitHubConnectors.gitHubAppInstalled": {
		testedIn:
			"The callback must come from the member named by its state: server/src/scheduler/scheduler.test.ts.",
	},
	"gitHubWebhooks.delivery": {
		testedIn: "Only a delivery its app signed: connectors/connectors.test.ts.",
	},
	"automations.webhook": {
		testedIn: "Only a call its trigger's authenticator accepted: automations/automations.test.ts.",
	},

	"bots.update": {
		input: ({ a }) => ({ botId: a.pub.id, changes: { name: `Pub ${unique()}` } }),
		// Pub's managers, Ed its creator and the admin, and a bot only in member bounds;
		// hidden from whoever neither manages Pub nor reaches it.
		outcomes: allowing(
			{
				...everyone("ActionForbidden"),
				outsider: "ResourceHidden",
				botOutsideBounds: "ResourceHidden",
				webhook: "ResourceHidden",
				systemWork: "ResourceHidden",
				page: "ResourceHidden",
			},
			["admin", "editor", ...IN_MEMBER_BOUNDS],
		),
	},
	"bots.remove": {
		input: async ({ a }) => ({ botId: (await seedBot(a.workspace, { createdById: a.ed })).id }),
		// A bot Ed made, which no turn's bounds take in.
		outcomes: allowing(
			{
				...everyone("ResourceHidden"),
				viewer: "ActionForbidden",
				editorOutsideJ: "ActionForbidden",
			},
			["admin", "editor", ...IN_MEMBER_BOUNDS],
		),
	},
	"chats.startInterview": {
		input: ({ a }) => ({ botId: a.pub.id }),
		outcomes: allowing({ ...everyone("ActionForbidden"), outsider: "ResourceHidden" }, [
			"admin",
			"editor",
		]),
	},
	"bots.pin": {
		input: ({ a }) => ({ botId: a.pub.id }),
		outcomes: askingEveryBot({
			...readsJ,
			editorOutsideJ: "ok",
			botInChatBounds: "ActionForbidden",
			adminsBotInChatBounds: "ActionForbidden",
			run: "ActionForbidden",
		}),
	},
	"bots.unpin": {
		input: ({ a }) => ({ botId: a.pub.id }),
		outcomes: askingEveryBot({
			...readsJ,
			editorOutsideJ: "ok",
			botInChatBounds: "ActionForbidden",
			adminsBotInChatBounds: "ActionForbidden",
			run: "ActionForbidden",
		}),
	},
	"bots.saveInstructions": {
		input: () => ({ instructions: "Help.", description: "Helps." }),
		// Only in a bot's own chats, which a Personal Assistant's are.
		outcomes: askingEveryBot({
			...everyone("ResourceHidden"),
			botInChatBounds: "ActionForbidden",
			adminsBotInChatBounds: "ActionForbidden",
			botOutsideBounds: "ActionForbidden",
			botInMemberBounds: "ok",
			adminsBotInMemberBounds: "ok",
		}),
	},

	"chats.readDocs": { input: () => ({ page: "getting-started" }), outcomes: inItsTurn },
	"chats.workspaceRole": { input: () => ({ member: "Someone" }), outcomes: inItsTurn },
	"chats.searchHistory": { input: () => ({ query: "hello" }), outcomes: inItsTurn },
	"files.listWritten": { input: () => ({}), outcomes: inItsTurn },
	"automations.listInChat": { input: () => ({}), outcomes: inItsTurn },
	"web.search": {
		input: () => ({ query: "weather", count: 5 }),
		postProofFailure: "WebToolOff",
		outcomes: inItsTurn,
	},
	"web.fetch": {
		input: () => ({ url: "https://example.com/" }),
		postProofFailure: "WebToolOff",
		outcomes: inItsTurn,
	},
	"chats.startBriefedChat": {
		input: () => ({ title: "Help", brief: "Look into it." }),
		outcomes: askingEveryBot({ ...inItsTurn, run: "ResourceHidden" }),
	},
	"automations.createWithRoutine": {
		input: () => ({
			name: `Automation ${unique()}`,
			instructions: "Tidy up.",
			routineExpression: "0 9 * * *",
		}),
		// In its turn's project, for an asker who manages it.
		outcomes: askingEveryBot({
			...everyone("ResourceHidden"),
			botInChatBounds: "ActionForbidden",
			adminsBotInChatBounds: "ok",
			botOutsideBounds: "ActionForbidden",
			botInMemberBounds: "ok",
			adminsBotInMemberBounds: "ok",
		}),
	},
	"automations.updateInChat": {
		input: async (fixture) => ({
			automationId: (await fresh.automation(fixture)).automationId,
			name: `Automation ${unique()}`,
		}),
		// An automation of J, from a turn in J, for an asker who manages it.
		outcomes: askingEveryBot({
			...everyone("ResourceHidden"),
			botInChatBounds: "ActionForbidden",
			adminsBotInChatBounds: "ok",
		}),
	},
	"chats.readChatFile": {
		testedIn:
			"It reads a sent attachment within the turn's bounds: packages/bot-loop/src/chat-tools.test.ts.",
	},
	"files.servePage": {
		testedIn:
			"The address must name that page: files/files.test.ts. Expiry and deletion: proofs/reaches-page.test.ts.",
	},
	"files.write": {
		testedIn:
			"Recorded, approved writes and takeover: files/files.test.ts. Approval and reach: packages/bot-loop/src/written-files.test.ts.",
	},
	"files.edit": {
		testedIn:
			"Recorded, approved writes and takeover: files/files.test.ts. Approval and reach: packages/bot-loop/src/written-files.test.ts.",
	},
	"connectors.searchTools": {
		testedIn:
			"Search results and approval after a configuration change: packages/bot-loop/src/connector-tools.test.ts and web-tools.test.ts.",
	},
	"connectors.callTool": {
		testedIn: "Its tool access decides it: bot-loop's connector-tools.test.ts.",
	},
	"computers.runCommand": { testedIn: COMPUTER_TOOLS },
	"computers.readFile": { testedIn: COMPUTER_TOOLS },
	"computers.writeFile": { testedIn: COMPUTER_TOOLS },
	"computers.copyChatFile": { testedIn: COMPUTER_TOOLS },
	"computers.shareFile": { testedIn: COMPUTER_TOOLS },
	"computers.useBrowser": { testedIn: COMPUTER_TOOLS },
	"computers.requestHost": { testedIn: COMPUTER_TOOLS },

	"turns.load": { testedIn: TURN_STEPS },
	"turns.makeModelRequest": { testedIn: TURN_STEPS },
	"turns.recordToolCall": { testedIn: TURN_STEPS },
	"turns.planToolCalls": { testedIn: TURN_STEPS },
	"turns.finishToolCall": { testedIn: TURN_STEPS },
	"turns.startApprovedToolCall": { testedIn: TURN_STEPS },
	"turns.askForApprovals": { testedIn: TURN_STEPS },
	"turns.recordToolResults": { testedIn: TURN_STEPS },
	"turns.end": { testedIn: TURN_STEPS },
	"turns.endLost": { testedIn: TURN_STEPS },

	"projectComputer.sleepIfIdle": {
		input: ({ who }) => {
			const sleep = who.computerSleep;
			if (sleep._tag !== "SystemWork" || sleep.work.kind !== "computerSleep") {
				throw new Error("Expected the work of putting J's computer to sleep");
			}
			return { computerId: sleep.work.computer };
		},
		outcomes: allowing(everyone("ResourceHidden"), ["systemWork"]),
	},
	"approvals.expire": { testedIn: STORED_WORK },
	"deletions.finish": { testedIn: STORED_WORK },
	"automations.runDueRoutine": { testedIn: STORED_WORK },
	"automations.pauseAfterFailures": { testedIn: STORED_WORK },
	"gitHubConnectors.uninstall": { testedIn: STORED_WORK },
};

const tabled = (Object.entries(rows) as [RequestOperationName, Row<never> | TestedElsewhere][])
	.filter((entry): entry is [RequestOperationName, Row<never>] => "outcomes" in entry[1])
	.map(([name, row]) => ({ name, ...row }));

describe("who may call each operation", () => {
	let fixture: Fixture;
	let callers: Record<Caller, Principal>;

	beforeAll(async () => {
		const world = await buildWorld();
		const a = world.a;
		const call = await servedOperations({
			// Sign-up as the server's settings say, which is closed here, so nobody has a referral link.
			accounts: Layer.orDie(Accounts.layer),
			egress: unimplemented(Egress.Service, {
				providers: { for: () => async () => Response.json({ data: [] }) },
				validateProviderUrl: urlValidation(
					createEgressUrlValidator({
						allowPrivateNetwork: true,
						lookup: async () => [{ address: "192.0.2.1", family: 4 }],
					}),
				),
				oauth: async () => new Response(null, { status: 503 }),
				webFetch: async () => new Response(null, { status: 503 }),
			}),
		});
		const who = await everyKindOfPrincipal(world, principals(await authenticators()));
		const gitHubConnector = await seedConnector(a.workspace, a.project, {
			github: { appCredentialEncrypted: "test credential" },
		});
		fixture = { a, who, call, gitHubConnector };
		callers = {
			admin: who.admin,
			editor: who.ed,
			viewer: who.vi,
			editorOutsideJ: who.erin,
			outsider: who.outsider,
			botInChatBounds: who.pubForEd,
			adminsBotInChatBounds: who.pubForAdmin,
			botOutsideBounds: who.helperInK,
			botInMemberBounds: who.edsAssistant,
			adminsBotInMemberBounds: who.adminsAssistant,
			run: who.run,
			webhook: who.webhook,
			systemWork: who.computerSleep,
			page: who.page,
		};
		const [provider] = await onDatabase((db) =>
			db
				.insert(modelProvider)
				.values({
					workspaceId: a.workspace,
					name: "Models",
					baseUrl: "https://models.example/v1",
					apiFormat: "openai",
					active: true,
				})
				.returning({ id: modelProvider.id }),
		);
		if (!provider) throw new Error("Expected a model provider");
		await onDatabase((db) =>
			db.insert(providerModel).values({
				workspaceId: a.workspace,
				providerId: provider.id,
				modelId: OFFERED,
				enabled: true,
				source: "manual",
			}),
		);
		// Every bot answers, so a call reaches whatever it proves after finding the bot's model.
		await onDatabase((db) =>
			db.update(bot).set({ model: OFFERED }).where(eq(bot.workspaceId, a.workspace)),
		);
		// A run's chat is made in its automation's feed.
		if (who.run._tag !== "AutomationRun") throw new Error("Expected an automation run");
		await call(who.admin, "chats.openAutomationFeed", {
			workspace: a.workspace,
			automationId: who.run.automation,
		});
	});

	afterAll(async () => {
		await closeDatabase();
	});

	it.each(tabled)("$name", async ({ name, input, outcomes, postProofFailure }) => {
		// One at a time, so no principal's change races another's.
		for (const caller of PRINCIPALS) {
			const tag = await operationOutcome(fixture.call, callers[caller], name, await input(fixture));
			expect(tag === postProofFailure ? "ok" : tag, caller).toBe(outcomes[caller]);
		}
	});

	it.each([
		"computerProviders.update",
		"computerProviders.remove",
		"computerProviders.template",
		"computerProviders.prepareTemplate",
		"computerProviders.test",
		"modelProviders.update",
		"modelProviders.remove",
		"modelProviders.switchOff",
		"modelProviders.test",
		"modelProviders.startSignIn",
		"modelProviders.signOut",
		"modelProviders.discoverModels",
		"modelProviders.addModel",
		"modelProviders.updateModel",
		"modelProviders.switchOffModel",
	] as const)("%s checks workspace management before looking up its provider", async (name) => {
		const row = rows[name];
		if (!("input" in row)) throw new Error(`Expected a permission row for ${name}`);
		const input = { ...(await row.input(fixture)), providerId: crypto.randomUUID() };
		await expect(fixture.call(callers.editor, name, input)).rejects.toMatchObject({
			_tag: "ActionForbidden",
		});
	});

	it("asks a bot for approval only where the bot loop is offered an operation that changes something", () => {
		const askingWhereOffered = tabled.map(({ name, outcomes }) => {
			const { botLoop, changes } = operationContracts[name];
			return {
				name,
				asks: Object.values(outcomes).includes("ApprovalNeeded"),
				offeredChange: botLoop.kind === "offered" && changes,
			};
		});

		expect(askingWhereOffered.filter(({ asks, offeredChange }) => asks !== offeredChange)).toEqual(
			[],
		);
	});
});
