import { handleFromName } from "@sugabots/contracts";
import { type SQL, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Accounts } from "./accounts/accounts.ts";
import { CurrentActor } from "./authorization/current-actor.ts";
import { ChatView } from "./conversations/chats/chat-view.ts";
import { Chats } from "./conversations/chats/chats.ts";
import type { Conversations } from "./conversations/conversations.ts";
import { ModelTrials } from "./conversations/model-trials/model-trials.ts";
import { RoutineView } from "./conversations/routines/routine-view.ts";
import { Routines } from "./conversations/routines/routines.ts";
import { conversationsForTests } from "./conversations/testing.ts";
import { ThreadView } from "./conversations/threads/thread-view.ts";
import { prepareRunnable, runningTurns, TurnExecution } from "./conversations/turns/testing.ts";
import { Turns } from "./conversations/turns/turns.ts";
import { query } from "./database/database.ts";
import { EventBus } from "./database/events/bus.ts";
import { EventStore } from "./database/events/store.ts";
import {
	agent,
	chat,
	connection,
	message,
	modelProvider,
	pod,
	podMember,
	providerModel,
	routine,
	routineExecution,
	searchProvider,
	thread,
	threadParticipant,
	toolCall,
	turn,
	user,
	workspace,
	workspaceInvite,
	workspaceMember,
} from "./database/schema.ts";
import {
	closeDatabase,
	onDatabase,
	onPostgres,
	runOnPostgres,
	testInfrastructure,
} from "./database/testing.ts";
import { Email } from "./email/email.ts";
import { Installation } from "./installation/installation.ts";
import { ConnectionSetup } from "./providers/connections/connection-setup.ts";
import { ModelProviderSetup } from "./providers/model-providers/model-provider-setup.ts";
import { Models } from "./providers/models/models.ts";
import { Egress } from "./providers/network/egress.ts";
import { SearchProviderSetup } from "./providers/search-providers/search-provider-setup.ts";
import { unimplemented } from "./testing.ts";
import { AgentAdministration } from "./workspaces/agents/agent-administration.ts";
import { Membership } from "./workspaces/membership/membership.ts";
import { Onboarding } from "./workspaces/onboarding/onboarding.ts";
import { PodAdministration } from "./workspaces/pods/pod-administration.ts";
import { onPostgresAs } from "./workspaces/testing.ts";

/**
 * Every use case and view that acts for the current actor, called by somebody
 * who has no part in what it is about, against Postgres.
 *
 * A signed-in stranger, outside the workspace, is told each resource is not
 * there, and nothing is written. Where the workspace has somebody who reaches
 * the resource but lacks the permission, they are forbidden, and nothing is
 * written either. The table must name every method of every service, so a
 * method added without deciding how it refuses fails here.
 */

/** Everything the calls are about, all of it real. */
interface Fixture {
	workspaceId: string;
	podId: string;
	agentId: string;
	routineId: string;
	chatId: string;
	threadId: string;
	turnId: string;
	connectionId: string;
	providerId: string;
	invitationId: string;
	/** The viewer's membership of the workspace, for the roster's methods. */
	viewerMemberId: string;
	viewerId: string;
}

/** Somebody in the workspace, in the pod, who may do less than the method needs. */
type Lacking = "member" | "viewer";

type Call<Shape> = (
	service: Shape,
	fixture: Fixture,
) => Effect.Effect<unknown, unknown, CurrentActor.Service>;

type Entry<Shape> =
	| { readonly call: Call<Shape>; readonly forbiddenFor?: Lacking }
	| { readonly exempt: string };

/** One entry for each of the service's methods, none left out. */
type Entries<Shape> = { readonly [Method in keyof Shape]-?: Entry<Shape> };

/** Every service the table calls, as the case builds them. */
type Everything = Conversations.Services | Layer.Success<typeof workspaceServices>;

/** A service's entries, each bound to the service as the context holds it. */
interface ServiceRefusals {
	readonly name: string;
	readonly methodsOf: (services: Context.Context<Everything>) => string[];
	readonly entries: ReadonlyArray<{
		readonly method: string;
		readonly forbiddenFor?: Lacking;
		readonly call?: (
			services: Context.Context<Everything>,
			fixture: Fixture,
		) => Effect.Effect<unknown, unknown, CurrentActor.Service>;
	}>;
}

const refusing = <Identifier extends Everything, Shape extends object>(
	key: Context.Key<Identifier, Shape>,
	entries: Entries<Shape>,
): ServiceRefusals => ({
	name: key.key,
	methodsOf: (services) => Object.keys(Context.get(services, key)),
	entries: Object.entries<Entry<Shape>>(entries).map(([method, entry]) =>
		"exempt" in entry
			? { method }
			: {
					method,
					forbiddenFor: entry.forbiddenFor,
					call: (services, fixture) => entry.call(Context.get(services, key), fixture),
				},
	),
});

const table: ReadonlyArray<ServiceRefusals> = [
	refusing(Membership.Service, {
		workspaces: { exempt: "lists only the actor's own workspaces" },
		create: { exempt: "anybody signed in may create a workspace" },
		update: {
			call: (m, f) =>
				m.update({
					workspace: f.workspaceId,
					details: { name: "Taken", slug: `taken-${f.podId}` },
				}),
			forbiddenFor: "member",
		},
		access: { call: (m, f) => m.access({ workspace: f.workspaceId }) },
		members: { call: (m, f) => m.members({ workspace: f.workspaceId }) },
		changeRole: {
			call: (m, f) =>
				m.changeRole({ workspace: f.workspaceId, memberId: f.viewerMemberId, role: "admin" }),
			forbiddenFor: "member",
		},
		remove: {
			call: (m, f) => m.remove({ workspace: f.workspaceId, memberId: f.viewerMemberId }),
			forbiddenFor: "member",
		},
		leave: { call: (m, f) => m.leave({ workspace: f.workspaceId }) },
		invitations: { call: (m, f) => m.invitations({ workspace: f.workspaceId }) },
		invite: {
			call: (m, f) =>
				m.invite({
					workspace: f.workspaceId,
					invitation: { email: "another@example.com", role: "member" },
				}),
			forbiddenFor: "member",
		},
		cancelInvitation: {
			call: (m, f) => m.cancelInvitation({ invitationId: f.invitationId }),
			forbiddenFor: "member",
		},
		invitation: { exempt: "a link answers whoever holds it: NotTheInvitee unless it is theirs" },
		accept: { exempt: "a link answers whoever holds it: NotTheInvitee unless it is theirs" },
	}),
	refusing(Onboarding.Service, {
		isCompleted: { exempt: "answers only about the actor" },
		complete: {
			call: (o, f) =>
				o.complete({ workspaceId: f.workspaceId, podId: f.podId, agentId: f.agentId }),
			forbiddenFor: "member",
		},
		completeAcceptedInvite: {
			exempt: "finds only an invitation the actor accepted, so is InvitationNotAccepted to others",
		},
	}),
	refusing(PodAdministration.Service, {
		list: { call: (p, f) => p.list({ workspace: f.workspaceId }) },
		create: {
			call: (p, f) => p.create({ workspace: f.workspaceId, name: "Mine", slug: "mine" }),
			forbiddenFor: "member",
		},
		ensurePersonal: {
			call: (p, f) => p.ensurePersonal({ workspace: f.workspaceId, model: OFFERED_MODEL }),
		},
		update: {
			call: (p, f) => p.update({ podId: f.podId, changes: { name: "Renamed" } }),
			forbiddenFor: "member",
		},
		remove: { call: (p, f) => p.remove({ podId: f.podId }), forbiddenFor: "member" },
		members: { call: (p, f) => p.members({ podId: f.podId }) },
		addMember: {
			call: (p, f) => p.addMember({ podId: f.podId, userId: f.viewerId }),
			forbiddenFor: "member",
		},
		removeMember: {
			call: (p, f) => p.removeMember({ podId: f.podId, userId: f.viewerId }),
			forbiddenFor: "member",
		},
		leave: { call: (p, f) => p.leave({ podId: f.podId }) },
	}),
	refusing(AgentAdministration.Service, {
		list: { call: (a, f) => a.list({ workspace: f.workspaceId }) },
		get: { call: (a, f) => a.get({ agentId: f.agentId }) },
		create: {
			call: (a, f) => a.create({ podId: f.podId, agent: { name: "Scout", model: OFFERED_MODEL } }),
			forbiddenFor: "viewer",
		},
		update: {
			call: (a, f) => a.update({ agentId: f.agentId, changes: { name: "Renamed" } }),
			forbiddenFor: "viewer",
		},
		remove: { call: (a, f) => a.remove({ agentId: f.agentId }), forbiddenFor: "member" },
		systemAgents: { call: (a, f) => a.systemAgents({ workspace: f.workspaceId }) },
		setSystemAgentModel: {
			call: (a, f) =>
				a.setSystemAgentModel({ workspace: f.workspaceId, key: "summarise", model: OFFERED_MODEL }),
			forbiddenFor: "member",
		},
	}),
	refusing(ModelProviderSetup.Service, {
		list: { call: (s, f) => s.list({ workspace: f.workspaceId }), forbiddenFor: "member" },
		listEnabledModels: { call: (s, f) => s.listEnabledModels({ workspace: f.workspaceId }) },
		get: { call: (s, f) => s.get(inProvider(f)), forbiddenFor: "member" },
		create: {
			call: (s, f) =>
				s.create({
					workspace: f.workspaceId,
					provider: { preset: "openai" },
				}),
			forbiddenFor: "member",
		},
		update: {
			call: (s, f) => s.update({ ...inProvider(f), changes: { active: false } }),
			forbiddenFor: "member",
		},
		remove: { call: (s, f) => s.remove(inProvider(f)), forbiddenFor: "member" },
		test: { call: (s, f) => s.test(inProvider(f)), forbiddenFor: "member" },
		startChatgptSignIn: {
			call: (s, f) => s.startChatgptSignIn(inProvider(f)),
			forbiddenFor: "member",
		},
		completeChatgptSignIn: {
			call: (s, f) => s.completeChatgptSignIn({ ...inProvider(f), attempt: "attempt" }),
			forbiddenFor: "member",
		},
		signOutChatgpt: { call: (s, f) => s.signOutChatgpt(inProvider(f)), forbiddenFor: "member" },
		fetchModels: { call: (s, f) => s.fetchModels(inProvider(f)), forbiddenFor: "member" },
		addModel: {
			call: (s, f) =>
				s.addModel({ ...inProvider(f), model: { modelId: "another-model", capabilities: [] } }),
			forbiddenFor: "member",
		},
		setModelsEnabled: {
			call: (s, f) =>
				s.setModelsEnabled({ ...inProvider(f), modelIds: [OFFERED_MODEL], enabled: false }),
			forbiddenFor: "member",
		},
		updateModel: {
			call: (s, f) =>
				s.updateModel({ ...inProvider(f), modelId: OFFERED_MODEL, changes: { enabled: false } }),
			forbiddenFor: "member",
		},
		removeModel: {
			call: (s, f) => s.removeModel({ ...inProvider(f), modelId: OFFERED_MODEL }),
			forbiddenFor: "member",
		},
	}),
	refusing(SearchProviderSetup.Service, {
		get: { call: (s, f) => s.get(f.workspaceId), forbiddenFor: "member" },
		webAccess: { call: (s, f) => s.webAccess(f.workspaceId) },
		replace: {
			call: (s, f) => s.replace({ workspace: f.workspaceId, provider: { preset: "exa" } }),
			forbiddenFor: "member",
		},
		update: {
			call: (s, f) => s.update({ workspace: f.workspaceId, changes: { enabled: false } }),
			forbiddenFor: "member",
		},
		remove: { call: (s, f) => s.remove(f.workspaceId), forbiddenFor: "member" },
		test: { call: (s, f) => s.test(f.workspaceId), forbiddenFor: "member" },
	}),
	refusing(ConnectionSetup.Service, {
		list: { call: (c, f) => c.list({ podId: f.podId }) },
		get: { call: (c, f) => c.get(inConnection(f)) },
		create: {
			call: (c, f) =>
				c.create({
					podId: f.podId,
					connection: { name: "Another", url: "https://another.example/mcp" },
				}),
			forbiddenFor: "member",
		},
		update: {
			call: (c, f) => c.update({ ...inConnection(f), changes: { name: "Renamed" } }),
			forbiddenFor: "member",
		},
		remove: { call: (c, f) => c.remove(inConnection(f)), forbiddenFor: "member" },
		test: { call: (c, f) => c.test(inConnection(f)), forbiddenFor: "member" },
		connectFromCatalog: {
			call: (c, f) =>
				c.connectFromCatalog({
					podId: f.podId,
					server: { name: "Catalogued", url: "https://catalogued.example/mcp" },
				}),
			forbiddenFor: "member",
		},
		startOAuth: { call: (c, f) => c.startOAuth(inConnection(f)), forbiddenFor: "member" },
		completeOAuth: {
			exempt:
				"keyed by a sign-in's state, not an id, and answers not_allowed to anybody but whoever started it",
		},
	}),
	refusing(ModelTrials.Service, {
		run: {
			call: (t, f) =>
				t.run({ workspace: f.workspaceId, systemAgentKey: "summarise", model: OFFERED_MODEL }),
			forbiddenFor: "member",
		},
	}),
	refusing(Chats.Service, {
		open: {
			call: (c, f) => c.open({ workspace: f.workspaceId, podId: f.podId, hostAgentId: f.agentId }),
		},
		post: {
			call: (c, f) =>
				c.post({ chatId: f.chatId, messageId: crypto.randomUUID(), content: "Let me in" }),
		},
	}),
	refusing(ChatView.Service, {
		list: { call: (v, f) => v.list({ workspace: f.workspaceId, pod: f.podId }) },
		messages: { call: (v, f) => v.messages(f.chatId) },
		history: { call: (v, f) => v.history(f.chatId) },
	}),
	refusing(ThreadView.Service, {
		list: { call: (v, f) => v.list(f.workspaceId) },
		get: { call: (v, f) => v.get(f.threadId) },
		activity: { call: (v, f) => v.activity(f.threadId) },
	}),
	refusing(Turns.Controls, {
		cancel: { call: (c, f) => c.cancel(f.turnId) },
		decide: {
			call: (a, f) =>
				a.decide({ podId: f.podId, toolCallId: crypto.randomUUID(), decision: "allow_once" }),
			forbiddenFor: "viewer",
		},
	}),
	refusing(Routines.Service, {
		create: {
			call: (r, f) =>
				r.create(
					{ agentId: f.agentId },
					{ name: "Another", instructions: "Do it.", trigger: { kind: "webhook" } },
				),
			forbiddenFor: "member",
		},
		update: {
			call: (r, f) => r.update(onAgent(f), { name: "Renamed" }),
			forbiddenFor: "member",
		},
		remove: { call: (r, f) => r.remove(onAgent(f)), forbiddenFor: "member" },
		rotateSecret: { call: (r, f) => r.rotateSecret(onAgent(f)), forbiddenFor: "member" },
		previewSchedule: {
			call: (r, f) =>
				r.previewSchedule({ agentId: f.agentId, expression: "0 9 * * *", timezone: "UTC" }),
			forbiddenFor: "member",
		},
		run: {
			call: (r, f) => r.run({ ...onAgent(f), requestId: crypto.randomUUID() }),
			forbiddenFor: "member",
		},
	}),
	refusing(RoutineView.Service, {
		listInWorkspace: { call: (v, f) => v.listInWorkspace(f.workspaceId) },
		list: { call: (v, f) => v.list({ agentId: f.agentId }) },
		get: { call: (v, f) => v.get(onAgent(f)) },
		listExecutions: { call: (v, f) => v.listExecutions(onAgent(f)) },
	}),
];

const OFFERED_MODEL = "offered-model";

const inProvider = (f: Fixture) => ({ workspace: f.workspaceId, providerId: f.providerId });
const inConnection = (f: Fixture) => ({ podId: f.podId, connectionId: f.connectionId });
const onAgent = (f: Fixture) => ({ agentId: f.agentId, routineId: f.routineId });

/**
 * The services not built with the conversations, over doubles of what they
 * would reach past the database. None of these is reached before a refusal,
 * so each dies if it is.
 */
const workspaceServices = Layer.mergeAll(
	Membership.layer,
	Onboarding.layer,
	PodAdministration.layer,
	AgentAdministration.layer,
	ModelProviderSetup.layer,
	SearchProviderSetup.layer,
	ConnectionSetup.layer,
	ModelTrials.layer,
).pipe(
	Layer.provide([
		// The ChatGPT sign-in builds its client when the setup is built, and
		// only a request through it is past a refusal.
		unimplemented(Egress.Service, {
			providers: {
				for: () => async () => {
					throw new Error("Egress.providers has no test double in this test");
				},
			},
		}),
		unimplemented(Models.Service),
		unimplemented(Email.Service),
		Layer.succeed(
			Accounts.Service,
			Accounts.Service.of({ admit: () => Effect.void, requireEmailVerification: false }),
		),
		Layer.succeed(
			Installation.Service,
			Installation.fromUrls({
				isProduction: false,
				publicUrl: "http://localhost:3000",
				webAppUrl: "http://localhost:5173",
			}),
		),
	]),
	Layer.provideMerge(testInfrastructure),
);

describe.skipIf(!process.env.DATABASE_URL)("refusing whoever may not", async () => {
	const conversations = await conversationsForTests(
		EventBus.inProcess({ store: EventStore.inMemory() }),
	);
	let services: Context.Context<Everything>;
	let fixture: Fixture;
	let people: Record<"stranger" | Lacking, string>;

	beforeAll(async () => {
		const workspaceContext = await runOnPostgres(
			Effect.context<Layer.Success<typeof workspaceServices>>().pipe(
				Effect.provide(workspaceServices),
			),
		);
		services = Context.merge(conversations, workspaceContext);
		({ fixture, people } = await aWorkspace(conversations));
	});

	afterAll(async () => {
		await closeDatabase();
	});

	/** The call's failure, run as `userId`, and whether it changed anything. */
	const refusalOf = async (
		call: NonNullable<ServiceRefusals["entries"][number]["call"]>,
		userId: string,
	) => {
		const before = await snapshot(fixture, Object.values(people));
		const failure = await runOnPostgres(
			Effect.flip(call(services, fixture)).pipe(
				CurrentActor.provide(CurrentActor.AuthenticatedUserId.vouchedFor(userId)),
			),
		);
		const after = await snapshot(fixture, Object.values(people));
		return { failure, changed: after !== before };
	};

	for (const service of table) {
		describe(service.name, () => {
			it("names every method", () => {
				expect(service.entries.map(({ method }) => method).sort()).toEqual(
					service.methodsOf(services).sort(),
				);
			});

			for (const entry of service.entries) {
				const { call, forbiddenFor } = entry;
				if (!call) continue;

				it(`${entry.method} is hidden from somebody outside the workspace`, async () => {
					const { failure, changed } = await refusalOf(call, people.stranger);
					expect(failure).toMatchObject({ _tag: "ResourceHidden" });
					expect(changed).toBe(false);
				});

				if (forbiddenFor) {
					it(`${entry.method} is forbidden to a ${forbiddenFor}`, async () => {
						const { failure, changed } = await refusalOf(call, people[forbiddenFor]);
						expect(failure).toMatchObject({ _tag: "ActionForbidden" });
						expect(changed).toBe(false);
					});
				}
			}
		});
	}
});

/**
 * A workspace an administrator runs, with a member and a viewer in its shared
 * pod, whose crew agent has a routine, a chat with a turn in it, a connection
 * and a model provider, and an invitation out; and a stranger, signed in,
 * who belongs to none of it.
 */
async function aWorkspace(
	conversations: Context.Context<Conversations.Services | TurnExecution.Service>,
) {
	const suffix = crypto.randomUUID();
	const [admin, member, viewer, stranger] = await onDatabase((db) =>
		db
			.insert(user)
			.values(
				["admin", "member", "viewer", "stranger"].map((name) => ({
					name,
					email: `${name}-${suffix}@example.com`,
				})),
			)
			.returning(),
	);
	const [space] = await onDatabase((db) =>
		db
			.insert(workspace)
			.values({ name: "Refusals", slug: `refusals-${suffix}` })
			.returning(),
	);
	if (!admin || !member || !viewer || !stranger || !space) throw new Error("fixture");
	const workspaceId = space.id;
	const [, , viewerMember] = await onDatabase((db) =>
		db
			.insert(workspaceMember)
			.values([
				{ workspaceId, userId: admin.id, role: "admin" },
				{ workspaceId, userId: member.id, role: "member" },
				{ workspaceId, userId: viewer.id, role: "viewer" },
			])
			.returning(),
	);
	const [room] = await onDatabase((db) =>
		db
			.insert(pod)
			.values({ workspaceId, kind: "shared", name: "Room", slug: `room-${suffix}` })
			.returning(),
	);
	if (!viewerMember || !room) throw new Error("fixture");
	const podId = room.id;
	await onDatabase((db) =>
		db.insert(podMember).values([
			{ workspaceId, podId, userId: member.id },
			{ workspaceId, podId, userId: viewer.id },
		]),
	);
	const [host] = await onDatabase((db) =>
		db
			.insert(agent)
			.values({
				workspaceId,
				podId,
				name: "Host",
				handle: handleFromName(`Host ${suffix}`),
				color: "rose",
				face: "pill",
				model: OFFERED_MODEL,
				createdById: admin.id,
			})
			.returning(),
	);
	const [provider] = await onDatabase((db) =>
		db
			.insert(modelProvider)
			.values({
				workspaceId,
				name: "Models",
				baseUrl: "https://models.example/v1",
				apiFormat: "openai",
				active: true,
			})
			.returning(),
	);
	const [connected] = await onDatabase((db) =>
		db
			.insert(connection)
			.values({
				workspaceId,
				podId,
				name: "Linear",
				handle: `linear-${suffix}`,
				url: "https://linear.example/mcp",
				authKind: "header",
				access: "allow",
				createdById: admin.id,
			})
			.returning(),
	);
	if (!host || !provider || !connected) throw new Error("fixture");
	await onDatabase((db) =>
		db.insert(providerModel).values({
			workspaceId,
			providerId: provider.id,
			modelId: OFFERED_MODEL,
			enabled: true,
			source: "manual",
		}),
	);
	await onDatabase((db) =>
		db
			.insert(searchProvider)
			.values({ workspaceId, preset: "exa", baseUrl: "https://api.exa.ai", enabled: true }),
	);

	const asAdmin = onPostgresAs(admin.id);
	const routineDefined = await asAdmin(Context.get(conversations, Routines.Service)).create(
		{ agentId: host.id },
		{ name: "Nightly", instructions: "Run nightly.", trigger: { kind: "webhook" } },
	);
	const [invited] = await onDatabase((db) =>
		db
			.insert(workspaceInvite)
			.values({
				id: crypto.randomUUID(),
				workspaceId,
				email: `invited-${suffix}@example.com`,
				role: "member",
				inviterId: admin.id,
				expiresAt: new Date(Date.now() + 86_400_000),
			})
			.returning(),
	);
	const chats = onPostgresAs(member.id)(Context.get(conversations, Chats.Service));
	const opened = await chats.open({ workspace: workspaceId, podId, hostAgentId: host.id });
	await chats.post({ chatId: opened.id, messageId: crypto.randomUUID(), content: "Hello" });
	const [run] = await runOnPostgres(runningTurns(opened.mainThreadId));
	if (!invited || !run) throw new Error("fixture");
	const prepared = await prepareRunnable(
		onPostgres({ prepare: Context.get(conversations, TurnExecution.Service).prepare }),
		run,
	);

	return {
		fixture: {
			workspaceId,
			podId,
			agentId: host.id,
			routineId: routineDefined.routine.id,
			chatId: opened.id,
			threadId: opened.mainThreadId,
			turnId: prepared.turnId,
			connectionId: connected.id,
			providerId: provider.id,
			invitationId: invited.id,
			viewerMemberId: viewerMember.id,
			viewerId: viewer.id,
		},
		people: { stranger: stranger.id, member: member.id, viewer: viewer.id },
	};
}

/**
 * Every row of the workspace, and of the people in the case, as one string, so
 * that any insert, update or delete a refused call made shows as a change.
 */
async function snapshot(fixture: Fixture, userIds: string[]) {
	const inWorkspace = (table: SQL) =>
		sql`(select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from ${table} t where t.workspace_id = ${fixture.workspaceId})`;
	const inThreads = (table: SQL) =>
		sql`(select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from ${table} t where t.thread_id in (select id from ${thread} where workspace_id = ${fixture.workspaceId}))`;
	const tables = {
		workspace_member: inWorkspace(sql`${workspaceMember}`),
		workspace_invite: inWorkspace(sql`${workspaceInvite}`),
		pod: inWorkspace(sql`${pod}`),
		pod_member: inWorkspace(sql`${podMember}`),
		agent: inWorkspace(sql`${agent}`),
		model_provider: inWorkspace(sql`${modelProvider}`),
		provider_model: inWorkspace(sql`${providerModel}`),
		search_provider: inWorkspace(sql`${searchProvider}`),
		connection: inWorkspace(sql`${connection}`),
		routine: inWorkspace(sql`${routine}`),
		routine_execution: inWorkspace(sql`${routineExecution}`),
		chat: inWorkspace(sql`${chat}`),
		thread: inWorkspace(sql`${thread}`),
		message: inThreads(sql`${message}`),
		turn: inThreads(sql`${turn}`),
		thread_participant: inThreads(sql`${threadParticipant}`),
		tool_call: inThreads(sql`${toolCall}`),
	};
	const [row] = await runOnPostgres(
		query((db) =>
			db.execute<{ everything: unknown }>(
				sql`select jsonb_build_object(
					'workspace', (select to_jsonb(w) from ${workspace} w where w.id = ${fixture.workspaceId}),
					'people', (select jsonb_agg(to_jsonb(u) order by u.id) from ${user} u where u.id in (${sql.join(
						userIds.map((id) => sql`${id}`),
						sql`, `,
					)})),
					${sql.join(
						Object.entries(tables).map(([name, rows]) => sql`${name}::text, ${rows}`),
						sql`, `,
					)}
				) as everything`,
				"objects",
			),
		),
	);
	return JSON.stringify(row?.everything);
}
