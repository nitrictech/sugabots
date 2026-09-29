import { memberChannel, type NotificationKind } from "@sugabots/contracts";
import { eq } from "drizzle-orm";
import { Context } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CurrentActor } from "../authorization/current-actor.ts";
import { Chats } from "../conversations/chats/chats.ts";
import { conversationsForTests } from "../conversations/testing.ts";
import {
	aChatAwaitingReply,
	type PreparedTurn,
	prepareRunnable,
	replyTurnOf,
	runningTurns,
	type ToolCallRepository,
	TurnExecution,
	TurnRepository,
} from "../conversations/turns/testing.ts";
import type { CommittedEvent } from "../database/events/outbox.ts";
import {
	agent,
	notification,
	podMember,
	routine,
	routineExecution,
	user,
	workspaceMember,
} from "../database/schema.ts";
import { closeDatabase, onDatabase, onPostgres, runOnPostgres } from "../database/testing.ts";
import { onPostgresAs } from "../workspaces/testing.ts";
import { Notifications } from "./notifications.ts";

/**
 * Notifications against Postgres, through the conversation services as the
 * server composes them, so a turn stopping for approvals reaches the real
 * handler inside the transaction that stopped it.
 */
describe.skipIf(!process.env.DATABASE_URL)("notifications, against Postgres", async () => {
	let delivered: CommittedEvent[] = [];
	const conversations = await conversationsForTests({
		publishCommitted: async (events) => {
			delivered.push(...events);
		},
	});
	const turns = onPostgres(Context.get(conversations, TurnRepository.Service));
	const chatsAs = (userId: string) =>
		onPostgresAs(userId)(Context.get(conversations, Chats.Service));
	const execution = onPostgres({
		prepare: Context.get(conversations, TurnExecution.Service).prepare,
	});
	const notifications = Context.get(conversations, Notifications.Service);
	const as = (userId: string) =>
		CurrentActor.provide(CurrentActor.AuthenticatedUserId.vouchedFor(userId));
	const preferencesOf = (userId: string) =>
		runOnPostgres(notifications.preferences.pipe(as(userId)));
	const setPreference = (userId: string, kind: NotificationKind, enabled: boolean) =>
		runOnPostgres(notifications.setPreference({ kind, enabled }).pipe(as(userId)));

	let workspaceId: string;
	let podId: string;
	let threadId: string;
	let connectionId: string;
	let hostId: string;
	let people: Record<"owner" | "admin" | "member" | "viewer" | "bystander" | "outsider", string>;
	let prepared: PreparedTurn;

	afterAll(async () => {
		await closeDatabase();
	});

	/** A person, in the workspace as `role` unless left out of it. */
	async function aPerson(name: string, role?: "owner" | "member" | "viewer") {
		const [row] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name, email: `${name.toLowerCase()}-${crypto.randomUUID()}@example.com` })
				.returning({ id: user.id }),
		);
		if (!row) throw new Error("fixture");
		if (role) {
			await onDatabase((db) =>
				db.insert(workspaceMember).values({ workspaceId, userId: row.id, role }),
			);
		}
		return row.id;
	}

	// The fixture's admin asked the pod's host. The database puts them and the
	// owner in the pod; a member and a viewer join it; a bystander is in the
	// workspace only.
	beforeEach(async () => {
		const chat = await aChatAwaitingReply(chatsAs);
		({ workspaceId, podId, threadId, connectionId, hostId } = chat);
		people = {
			owner: await aPerson("Owner", "owner"),
			admin: chat.memberId,
			member: await aPerson("Member", "member"),
			viewer: await aPerson("Viewer", "viewer"),
			bystander: await aPerson("Bystander", "member"),
			outsider: await aPerson("Outsider"),
		};
		await onDatabase((db) =>
			db.insert(podMember).values([
				{ workspaceId, podId, userId: people.member },
				{ workspaceId, podId, userId: people.viewer },
			]),
		);
		const [run] = await runOnPostgres(runningTurns(threadId));
		if (!run) throw new Error("no turn running");
		prepared = await prepareRunnable(execution, run);
		delivered = [];
	});

	const pendingCall = (tool: string, atOffset: number): ToolCallRepository.PendingToolApproval => ({
		id: crypto.randomUUID(),
		approvalId: `approval-${crypto.randomUUID()}`,
		sdkToolCallId: `sdk-${tool}`,
		tool,
		input: { title: "Fix mobile navigation" },
		connectionId,
		connectionRevision: 1,
		remoteToolName: tool,
		mutating: true,
		atOffset,
	});

	/** Stops the host's turn to wait for `approvals`. */
	const suspendFor = (approvals: readonly ToolCallRepository.PendingToolApproval[]) =>
		turns.suspend(
			replyTurnOf(prepared),
			{
				messages: [],
				approvals: approvals.map((pending) => ({
					approvalId: pending.approvalId,
					tool: pending.tool,
					connectionId,
					connectionRevision: 1,
					remoteToolName: pending.remoteToolName,
				})),
				modelInput: { model: "test", system: "test", messages: [] },
				reply: {
					content: "",
					collaborations: [],
					toolCalls: approvals.map(({ id, atOffset }) => ({ id, atOffset })),
				},
				modelCalls: 1,
			},
			approvals,
		);

	const toldUsers = async () =>
		(
			await onDatabase((db) =>
				db
					.select({ userId: notification.userId })
					.from(notification)
					.where(eq(notification.workspaceId, workspaceId)),
			)
		)
			.map(({ userId }) => userId)
			.sort();

	const noticesDelivered = () =>
		delivered.filter(({ event }) => event.type === "notification.created");

	it("tells the pod's people who may decide the approvals, on their own channels", async () => {
		expect(
			await suspendFor([pendingCall("linear__create_issue", 0), pendingCall("linear__close", 4)]),
		).toBe(true);

		expect(await toldUsers()).toEqual([people.owner, people.admin, people.member].sort());
		const [host] = await onDatabase((db) =>
			db.select({ name: agent.name }).from(agent).where(eq(agent.id, hostId)),
		);
		const [membersNotice] = await onDatabase((db) =>
			db.select().from(notification).where(eq(notification.userId, people.member)),
		);
		expect(membersNotice?.subject).toMatchObject({
			kind: "approve",
			podId,
			threadId,
			agentId: hostId,
			agentName: host?.name,
			tools: ["linear__create_issue", "linear__close"],
		});
		expect(membersNotice?.subject.chatId).toEqual(expect.any(String));
		expect(
			noticesDelivered()
				.map(({ channel }) => channel)
				.sort(),
		).toEqual(
			[people.owner, people.admin, people.member]
				.map((userId) => memberChannel(workspaceId, userId))
				.sort(),
		);
		expect(noticesDelivered()[0]?.event).toMatchObject({
			audiencePodId: podId,
			notification: { workspaceId, subject: { kind: "approve" } },
		});
	});

	it("leaves out somebody who turned approvals off", async () => {
		await setPreference(people.member, "approve", false);

		await suspendFor([pendingCall("linear__create_issue", 0)]);

		expect(await toldUsers()).toEqual([people.owner, people.admin].sort());
	});

	it("tells somebody who turned approvals back on", async () => {
		await setPreference(people.member, "approve", false);
		await setPreference(people.member, "approve", true);

		await suspendFor([pendingCall("linear__create_issue", 0)]);

		expect(await toldUsers()).toEqual([people.owner, people.admin, people.member].sort());
	});

	it("tells nobody when the turn stops with nothing to decide", async () => {
		expect(await suspendFor([])).toBe(true);

		expect(await toldUsers()).toEqual([]);
		expect(noticesDelivered()).toEqual([]);
	});

	it("tells only the people who may decide a routine's approvals while it runs", async () => {
		const [scheduled] = await onDatabase((db) =>
			db
				.insert(routine)
				.values({
					workspaceId,
					agentId: hostId,
					name: "Triage",
					instructions: "Triage the inbox",
					triggerKind: "webhook",
					webhookSecretDigest: "digest",
				})
				.returning({ id: routine.id }),
		);
		if (!scheduled) throw new Error("fixture");
		const now = new Date();
		await onDatabase((db) =>
			db.insert(routineExecution).values({
				routineId: scheduled.id,
				workspaceId,
				agentId: hostId,
				threadId,
				triggerKind: "webhook",
				trigger: {
					kind: "webhook",
					receivedAt: now.toISOString(),
					idempotencyKey: null,
					payload: {},
				},
				routineName: "Triage",
				instructions: "Triage the inbox",
				state: "running",
				startedAt: now,
			}),
		);

		await suspendFor([pendingCall("linear__create_issue", 0)]);

		expect(await toldUsers()).toEqual([people.owner, people.admin].sort());
	});

	it("hears about every kind by default, and remembers a change", async () => {
		expect(await preferencesOf(people.member)).toEqual({ approve: true });

		expect(await setPreference(people.member, "approve", false)).toEqual({ approve: false });
		expect(await preferencesOf(people.member)).toEqual({ approve: false });
		expect(await preferencesOf(people.admin)).toEqual({ approve: true });
	});
});
