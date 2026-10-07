import { type ChatMessageItem, handleFromName, threadChannel } from "@sugabots/contracts";
import { and, eq, like } from "drizzle-orm";
import { Context, Effect } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Visibility } from "../../authorization/visibility.ts";
import { EventBus } from "../../database/events/bus.ts";
import { EventStore } from "../../database/events/store.ts";
import {
	agent,
	chat,
	collaboration,
	event,
	laneRequest,
	message,
	pod,
	podMember,
	routineExecution,
	thread,
	threadParticipant,
	toolCall,
	turn,
	user,
	workspace,
	workspaceMember,
} from "../../database/schema.ts";
import { closeDatabase, onDatabase, type Promised, runOnPostgres } from "../../database/testing.ts";
import { onPostgresAs } from "../../workspaces/testing.ts";
import { Routines } from "../routines/routines.ts";
import { conversationsForTests } from "../testing.ts";
import { ThreadView } from "../thread-view.ts";
import { queueFacilitationForTests, runningTurns } from "../turns/testing.ts";
import { Turns } from "../turns/turns.ts";
import { ChatView } from "./chat-view.ts";
import { Chats } from "./chats.ts";

const eventStore = await runOnPostgres(EventStore.make);

describe.skipIf(!process.env.DATABASE_URL)("chats, against Postgres", async () => {
	const conversations = await conversationsForTests(EventBus.inProcess({ store: eventStore }));
	/** As the member the chats are with. */
	let chats: Promised<Chats.Interface>;
	let view: Promised<ChatView.Interface>;
	/** As an administrator, who may define and run the agents' routines. */
	let routines: Promised<Routines.Interface>;
	let workspaceId: string;
	let podId: string;
	let agentId: string;
	let recipientAgentId: string;
	let userId: string;
	let administratorId: string;

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		const suffix = crypto.randomUUID();
		const [person, administrator] = await onDatabase((db) =>
			db
				.insert(user)
				.values([
					{ name: "Chat member", email: `chat-${suffix}@example.com` },
					{ name: "Chat admin", email: `chat-admin-${suffix}@example.com` },
				])
				.returning(),
		);
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: "Chat workspace", slug: `chat-${suffix}` })
				.returning(),
		);
		if (!person || !administrator || !space) throw new Error("Could not create chat test identity");
		userId = person.id;
		administratorId = administrator.id;
		workspaceId = space.id;
		await onDatabase((db) =>
			db.insert(workspaceMember).values([
				{ workspaceId, userId },
				{ workspaceId, userId: administrator.id, role: "admin" },
			]),
		);
		chats = onPostgresAs(userId)(Context.get(conversations, Chats.Service));
		view = onPostgresAs(userId)(Context.get(conversations, ChatView.Service));
		routines = onPostgresAs(administrator.id)(Context.get(conversations, Routines.Service));
		const [room] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId,
					ownerId: userId,
					kind: "shared",
					name: "Chat pod",
					slug: `chat-${suffix}`,
					createdById: userId,
				})
				.returning(),
		);
		if (!room) throw new Error("Could not create chat test pod");
		podId = room.id;
		await onDatabase((db) => db.insert(podMember).values({ workspaceId, podId, userId }));
		const [host, recipient] = await onDatabase((db) =>
			db
				.insert(agent)
				.values([
					{
						workspaceId,
						podId,
						name: "Personal Agent",
						handle: handleFromName(`Personal Agent ${suffix}`),
						color: "green",
						face: "pill",
						model: "test/model",
						createdById: userId,
					},
					{
						workspaceId,
						podId,
						name: "Impersonal Agent",
						handle: handleFromName(`Impersonal Agent ${suffix}`),
						color: "sky",
						face: "square",
						model: "test/model",
						createdById: userId,
					},
				])
				.returning(),
		);
		if (!host || !recipient) throw new Error("Could not create chat test agents");
		agentId = host.id;
		recipientAgentId = recipient.id;
	});

	it("shows a chat to whoever reaches its pod, and to nobody else", async () => {
		const opened = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
		const [outsider, stranger] = await onDatabase((db) =>
			db
				.insert(user)
				.values([
					{ name: "Outside the pod", email: `outsider-${crypto.randomUUID()}@example.com` },
					{ name: "Outside the workspace", email: `stranger-${crypto.randomUUID()}@example.com` },
				])
				.returning(),
		);
		if (!outsider || !stranger) throw new Error("Could not create the people");
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId, userId: outsider.id, role: "member" }),
		);
		const visibility = await runOnPostgres(Effect.provide(Visibility.Service, Visibility.layer));
		const visibilityAs = (personId: string) => onPostgresAs(personId)({ chat: visibility.chat });

		expect(await visibilityAs(userId).chat(opened.id)).toMatchObject({ id: opened.id });
		for (const personId of [outsider.id, stranger.id]) {
			await expect(visibilityAs(personId).chat(opened.id)).rejects.toMatchObject({
				_tag: "ResourceHidden",
				resource: "chat",
			});
		}
		await expect(visibilityAs(userId).chat("not-a-uuid")).rejects.toMatchObject({
			_tag: "ResourceHidden",
		});
	});

	it("lists a pod's bots newest message first, with bots nobody has messaged last", async () => {
		const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
		await chats.post({
			chatId: current.id,
			messageId: crypto.randomUUID(),
			content: "\n  Budget   review is Friday\nand bring the numbers",
		});

		const list = await view.list({ workspace: workspaceId, pod: podId });

		expect(list?.items).toEqual([
			{
				agent: expect.objectContaining({ id: agentId }),
				chat: expect.objectContaining({ id: current.id, mainThreadId: current.mainThreadId }),
				lastMessage: {
					preview: "Budget review is Friday",
					authorUserId: userId,
					at: expect.any(String),
				},
				waitingOn: null,
				unreadMessages: 0,
				needsApproval: false,
			},
			{
				agent: expect.objectContaining({ id: recipientAgentId }),
				chat: null,
				lastMessage: null,
				waitingOn: null,
				unreadMessages: 0,
				needsApproval: false,
			},
		]);
	});

	it("lists a pod by its slug as by its id, as an address names it", async () => {
		const byId = await view.list({ workspace: workspaceId, pod: podId });
		const [room] = await onDatabase((db) =>
			db.select({ slug: pod.slug }).from(pod).where(eq(pod.id, podId)),
		);

		expect(await view.list({ workspace: workspaceId, pod: room?.slug ?? "" })).toEqual(byId);
	});

	it("previews a bot's reply as the chat shows it, without the words before a tool call", async () => {
		const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
		await onDatabase((db) =>
			db.insert(message).values({
				threadId: current.mainThreadId,
				authorAgentId: agentId,
				kind: "text",
				status: "complete",
				parts: [
					{ type: "text", text: "Let me try again:" },
					{ type: "tool_call", toolCallId: crypto.randomUUID() },
					{ type: "text", text: "I'm still getting denied." },
				],
				content: "Let me try again:I'm still getting denied.",
			}),
		);

		const list = await view.list({ workspace: workspaceId, pod: podId });

		const host = list?.items.find((item) => item.agent.id === agentId);
		expect(host?.lastMessage?.preview).toBe("I'm still getting denied.");
	});

	describe("unread and waiting chats", () => {
		/** The host writes `content` in its chat, `secondsLater` after now, and returns the message. */
		const botWrites = async (threadId: string, content: string, secondsLater = 0) => {
			const [written] = await onDatabase((db) =>
				db
					.insert(message)
					.values({
						threadId,
						authorAgentId: agentId,
						kind: "text",
						status: "complete",
						parts: content ? [{ type: "text", text: content }] : [],
						content,
						createdAt: new Date(Date.now() + secondsLater * 1000),
					})
					.returning(),
			);
			if (!written) throw new Error("fixture");
			return written;
		};
		const hostRow = async () =>
			(await view.list({ workspace: workspaceId, pod: podId }))?.items.find(
				(item) => item.agent.id === agentId,
			);

		it("counts what a bot writes after the person last read the chat", async () => {
			const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
			await chats.post({ chatId: current.id, messageId: crypto.randomUUID(), content: "Hi" });
			expect(await hostRow()).toMatchObject({ unreadMessages: 0 });

			await botWrites(current.mainThreadId, "Hello!", 1);
			await botWrites(current.mainThreadId, "", 2);
			await botWrites(current.mainThreadId, "How can I help?", 3);
			expect(await hostRow()).toMatchObject({ unreadMessages: 2 });

			await chats.markRead(current.id);
			expect(await hostRow()).toMatchObject({ unreadMessages: 0 });

			await botWrites(current.mainThreadId, "One more thing", 4);
			expect(await hostRow()).toMatchObject({ unreadMessages: 1 });
		});

		it("stops counting what came before the person's own reply", async () => {
			const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
			await botWrites(current.mainThreadId, "Hello!", -2);
			await botWrites(current.mainThreadId, "Anything else?", -1);
			expect(await hostRow()).toMatchObject({ unreadMessages: 2 });

			await chats.post({ chatId: current.id, messageId: crypto.randomUUID(), content: "All good" });
			expect(await hostRow()).toMatchObject({ unreadMessages: 0 });
		});

		it("keeps a reply that finishes after the chat was read unread", async () => {
			const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
			await chats.post({ chatId: current.id, messageId: crypto.randomUUID(), content: "Hey" });
			const [reply] = await onDatabase((db) =>
				db
					.insert(message)
					.values({
						threadId: current.mainThreadId,
						authorAgentId: agentId,
						kind: "text",
						status: "streaming",
						parts: [],
						content: "",
						createdAt: new Date(Date.now() + 1000),
					})
					.returning({ id: message.id }),
			);
			if (!reply) throw new Error("fixture");

			await chats.markRead(current.id);
			await onDatabase((db) =>
				db
					.update(message)
					.set({
						status: "complete",
						content: "Hi there",
						parts: [{ type: "text", text: "Hi there" }],
					})
					.where(eq(message.id, reply.id)),
			);

			expect(await hostRow()).toMatchObject({ unreadMessages: 1 });
		});

		it("keeps a reply unread that began before something the person read while it was written", async () => {
			const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
			await chats.post({ chatId: current.id, messageId: crypto.randomUUID(), content: "Hey" });
			const [reply] = await onDatabase((db) =>
				db
					.insert(message)
					.values({
						threadId: current.mainThreadId,
						authorAgentId: agentId,
						kind: "text",
						status: "streaming",
						parts: [],
						content: "",
						createdAt: new Date(Date.now() + 1000),
					})
					.returning({ id: message.id }),
			);
			if (!reply) throw new Error("fixture");
			await botWrites(current.mainThreadId, "Meanwhile, the deploy finished.", 2);

			await chats.markRead(current.id);
			await onDatabase((db) =>
				db
					.update(message)
					.set({
						status: "complete",
						content: "Hi there",
						parts: [{ type: "text", text: "Hi there" }],
					})
					.where(eq(message.id, reply.id)),
			);

			expect(await hostRow()).toMatchObject({ unreadMessages: 2 });
		});

		it("shows how far the person has read, and announces it only when they read further", async () => {
			const threads = onPostgresAs(userId)(Context.get(conversations, ThreadView.Service));
			const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
			const reply = await botWrites(current.mainThreadId, "Hello!", 1);
			const readsAnnounced = async () =>
				(
					await onDatabase((db) =>
						db
							.select({ type: event.type })
							.from(event)
							.where(eq(event.channel, threadChannel(current.mainThreadId))),
					)
				).filter(({ type }) => type === "thread.read").length;

			await chats.markRead(current.id);
			await chats.markRead(current.id);

			const [read] = (await threads.get(current.mainThreadId)).reads;
			expect(read).toEqual({
				person: expect.objectContaining({ kind: "person", id: userId }),
				readThrough: reply.createdAt.toISOString(),
				readAt: expect.any(String),
			});
			expect(await readsAnnounced()).toBe(1);
			// When they read it, not when it was sent: the reply is stamped a second from now.
			expect(Date.parse(read?.readAt ?? "")).toBeLessThan(reply.createdAt.getTime());

			await botWrites(current.mainThreadId, "One more thing", 2);
			await chats.markRead(current.id);
			const [readAgain] = (await threads.get(current.mainThreadId)).reads;
			expect(Date.parse(readAgain?.readAt ?? "")).toBeGreaterThan(Date.parse(read?.readAt ?? ""));
		});

		it("adds up each pod's unread messages for the rail", async () => {
			const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
			const other = await chats.open({
				workspace: workspaceId,
				podId,
				hostAgentId: recipientAgentId,
			});
			expect(await view.podMarkers(workspaceId)).toEqual({ pods: {} });

			await botWrites(current.mainThreadId, "Hello!");
			await botWrites(current.mainThreadId, "Are you there?", 1);
			await onDatabase((db) =>
				db.insert(message).values({
					threadId: other.mainThreadId,
					authorAgentId: recipientAgentId,
					kind: "text",
					status: "complete",
					parts: [{ type: "text", text: "Morning" }],
					content: "Morning",
				}),
			);

			expect(await view.podMarkers(workspaceId)).toEqual({
				pods: { [podId]: { unreadMessages: 3, needsApproval: false } },
			});
		});

		it("marks a chat waiting on a tool call the person may decide", async () => {
			const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
			await chats.post({ chatId: current.id, messageId: crypto.randomUUID(), content: "File it" });
			// A reply that called a tool without writing a word first.
			const trigger = await botWrites(current.mainThreadId, "", 1);
			const [asked] = await onDatabase((db) =>
				db
					.insert(turn)
					.values({
						threadId: current.mainThreadId,
						agentId,
						triggerMessageId: trigger.id,
						status: "waiting",
						model: "test/model",
						startedAt: new Date(),
					})
					.returning({ id: turn.id }),
			);
			if (!asked) throw new Error("fixture");
			await onDatabase((db) =>
				db.insert(toolCall).values({
					threadId: current.mainThreadId,
					messageId: trigger.id,
					turnId: asked.id,
					tool: "linear__create_issue",
					approvalId: `approval-${crypto.randomUUID()}`,
					approvalStatus: "pending",
					status: "awaiting_approval",
					input: {},
					atOffset: 0,
				}),
			);

			// A routine run elsewhere, so an approval outside any run must not be taken for one.
			const elsewhere = await routines.create(
				{ agentId: recipientAgentId },
				{ name: "Elsewhere", instructions: "Run somewhere else.", trigger: { kind: "webhook" } },
			);
			await routines.run({
				agentId: recipientAgentId,
				routineId: elsewhere.routine.id,
				requestId: crypto.randomUUID(),
			});

			expect(await hostRow()).toMatchObject({
				needsApproval: true,
				waitingOn: "linear__create_issue",
				lastMessage: { preview: "File it" },
			});
			expect(await view.podMarkers(workspaceId)).toEqual({
				pods: { [podId]: { unreadMessages: 0, needsApproval: true } },
			});
		});
	});

	it("lists a pod the person reaches, and hides one they cannot", async () => {
		const suffix = crypto.randomUUID();
		const [personal, unjoined] = await onDatabase((db) =>
			db
				.insert(pod)
				.values([
					{
						workspaceId,
						ownerId: userId,
						kind: "personal",
						name: "Personal",
						slug: "personal",
						createdById: userId,
					},
					{
						workspaceId,
						ownerId: userId,
						kind: "shared",
						name: "Elsewhere",
						slug: `elsewhere-${suffix}`,
						createdById: userId,
					},
				])
				.returning(),
		);
		if (!personal || !unjoined) throw new Error("Could not create list test pods");
		await onDatabase((db) =>
			db.insert(agent).values(
				[personal, unjoined].map((room) => ({
					workspaceId,
					podId: room.id,
					name: `Bot in ${room.name}`,
					handle: handleFromName(`Bot in ${room.name} ${suffix}`),
					color: "rose" as const,
					face: "dot" as const,
					model: "test/model",
					createdById: userId,
				})),
			),
		);

		await expect(view.list({ workspace: workspaceId, pod: unjoined.id })).rejects.toMatchObject({
			_tag: "ResourceHidden",
		});
		expect((await view.list({ workspace: workspaceId, pod: personal.id }))?.items).toHaveLength(1);
	});

	it("lists the person's own Personal pod by the slug every Personal pod shares", async () => {
		const suffix = crypto.randomUUID();
		const [mine, theirs] = await onDatabase((db) =>
			db
				.insert(pod)
				.values(
					[userId, administratorId].map((ownerId) => ({
						workspaceId,
						ownerId,
						kind: "personal" as const,
						name: "Personal",
						slug: "personal",
						createdById: ownerId,
					})),
				)
				.returning(),
		);
		if (!mine || !theirs) throw new Error("Could not create Personal pods");
		await onDatabase((db) =>
			db.insert(agent).values(
				[mine, theirs].map((room) => ({
					workspaceId,
					podId: room.id,
					name: `Assistant ${room.id === mine.id ? "mine" : "theirs"}`,
					handle: handleFromName(`Assistant ${room.id} ${suffix}`),
					color: "rose" as const,
					face: "dot" as const,
					model: "test/model",
					createdById: room.ownerId,
				})),
			),
		);
		const asAdministrator = onPostgresAs(administratorId)(
			Context.get(conversations, ChatView.Service),
		);

		const listed = async (list: Promised<ChatView.Interface>) =>
			(await list.list({ workspace: workspaceId, pod: "personal" }))?.items.map(
				(item) => item.agent.name,
			);

		expect(await listed(view)).toEqual(["Assistant mine"]);
		expect(await listed(asAdministrator)).toEqual(["Assistant theirs"]);
	});

	it("keeps one chat per pod and host and queues top-level messages in the main Chat", async () => {
		const input = { workspace: workspaceId, podId, hostAgentId: agentId };
		const [first, retried] = await Promise.all([chats.open(input), chats.open(input)]);
		expect(retried.id).toBe(first.id);
		expect(
			await onDatabase((db) => db.select().from(chat).where(eq(chat.id, first.id))),
		).toHaveLength(1);

		const sent = await chats.post({
			chatId: first.id,
			messageId: crypto.randomUUID(),
			content: "Investigate this over several steps",
		});
		expect(sent?.threadId).toBe(first.mainThreadId);
		expect(await runOnPostgres(runningTurns(first.mainThreadId))).toHaveLength(1);
		expect((await view.history(first.id))?.items).toHaveLength(0);
		expect((await view.messages(first.id))?.items.map((item) => item.kind)).toEqual(["message"]);
	});

	it("refuses a message to an agent with no model, and saves nothing", async () => {
		await onDatabase((db) => db.update(agent).set({ model: null }).where(eq(agent.id, agentId)));
		const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
		const messageId = crypto.randomUUID();

		await expect(
			chats.post({
				chatId: current.id,
				messageId,
				content: "Anyone there?",
			}),
		).rejects.toMatchObject({ _tag: "ChatAgentHasNoModel" });
		expect(
			await onDatabase((db) => db.select().from(message).where(eq(message.id, messageId))),
		).toHaveLength(0);
		expect(await runOnPostgres(runningTurns(current.mainThreadId))).toHaveLength(0);
	});

	it("retries the same message without creating another message or turn", async () => {
		const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
		const send = {
			chatId: current.id,
			messageId: crypto.randomUUID(),
			content: "A simple question",
		};
		const messageId = send.messageId;
		const [first, retried] = await Promise.all([chats.post(send), chats.post(send)]);
		expect(retried).toEqual(first);
		await expect(chats.post({ ...send, content: "Another question" })).rejects.toMatchObject({
			_tag: "MessageIdConflict",
		});
		expect(
			await onDatabase((db) => db.select().from(message).where(eq(message.id, messageId))),
		).toHaveLength(1);
		expect(await runOnPostgres(runningTurns(current.mainThreadId))).toHaveLength(1);
		expect(
			await onDatabase((db) =>
				db
					.select()
					.from(laneRequest)
					.where(like(laneRequest.laneKey, `turn:${current.mainThreadId}:%`)),
			),
		).toHaveLength(0);
	});

	it("says which messages wait for the agent's next turn, and announces when one starts waiting", async () => {
		const threads = onPostgresAs(userId)(Context.get(conversations, ThreadView.Service));
		const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
		const post = (content: string) =>
			chats.post({ chatId: current.id, messageId: crypto.randomUUID(), content });
		const changesAnnounced = async () =>
			(
				await onDatabase((db) =>
					db
						.select({ type: event.type })
						.from(event)
						.where(eq(event.channel, threadChannel(current.mainThreadId))),
				)
			).filter(({ type }) => type === "thread.changed").length;

		await post("Is checkout timing out?");
		expect((await threads.get(current.mainThreadId)).queuedSince).toBeNull();
		const changedBefore = await changesAnnounced();

		const followUp = await post("The Stripe webhook too?");
		await post("Started around 9.");

		expect((await threads.get(current.mainThreadId)).queuedSince).toBe(followUp.createdAt);
		// Once, when the turn started waiting; the next message joins it.
		expect((await changesAnnounced()) - changedBefore).toBe(1);
	});

	it("queues nothing posted before a turn resumed from an earlier reply starts waiting", async () => {
		const threads = onPostgresAs(userId)(Context.get(conversations, ThreadView.Service));
		const turns = Context.get(conversations, Turns.Service);
		const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
		const asked = await chats.post({
			chatId: current.id,
			messageId: crypto.randomUUID(),
			content: "Who owns checkout?",
		});

		// A collaboration answered after the agent moved on resumes it from the
		// reply that opened it, which is long since answered.
		await runOnPostgres(
			turns.ask({
				threadId: current.mainThreadId,
				agentId,
				triggerMessageId: asked.id,
				reason: "resume",
			}),
		);
		const later = await chats.post({
			chatId: current.id,
			messageId: crypto.randomUUID(),
			content: "And billing?",
		});

		const { queuedSince } = await threads.get(current.mainThreadId);
		expect(Date.parse(queuedSince ?? "")).toBeGreaterThan(Date.parse(asked.createdAt));
		expect(Date.parse(queuedSince ?? "")).toBeLessThanOrEqual(Date.parse(later.createdAt));
	});

	it("announces a person's message before the agent it brings into the thread", async () => {
		const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
		// The chat's agent has not joined its thread yet, so the message brings it in.
		await onDatabase((db) =>
			db
				.delete(threadParticipant)
				.where(
					and(
						eq(threadParticipant.threadId, current.mainThreadId),
						eq(threadParticipant.agentId, agentId),
					),
				),
		);

		await chats.post({
			chatId: current.id,
			messageId: crypto.randomUUID(),
			content: "Are you there?",
		});

		const announced = await onDatabase((db) =>
			db
				.select({ type: event.type })
				.from(event)
				.where(eq(event.channel, threadChannel(current.mainThreadId)))
				.orderBy(event.seq),
		);
		expect(announced.slice(0, 2).map(({ type }) => type)).toEqual([
			"message.created",
			"thread.changed",
		]);
	});

	it("includes Routine runs in the main Chat timeline", async () => {
		const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
		const created = await routines.create(
			{ agentId },
			{
				name: "Overnight review",
				instructions: "Review overnight changes.",
				trigger: { kind: "webhook" },
			},
		);
		const requestId = crypto.randomUUID();
		const accepted = await routines.run({ agentId, routineId: created.routine.id, requestId });

		expect((await view.messages(current.id))?.items).toEqual([
			expect.objectContaining({
				kind: "routine",
				id: accepted.executionId,
				threadId: accepted.threadId,
				routineName: "Overnight review",
				triggerKind: "manual",
			}),
		]);
	});

	it("paginates interleaved messages and Routine runs without gaps", async () => {
		const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
		const created = await routines.create(
			{ agentId },
			{
				name: "Overnight review",
				instructions: "Review overnight changes.",
				trigger: { kind: "webhook" },
			},
		);
		const requestId = crypto.randomUUID();
		const accepted = await routines.run({ agentId, routineId: created.routine.id, requestId });
		const olderMessageId = crypto.randomUUID();
		const newerMessageId = crypto.randomUUID();
		await onDatabase((db) =>
			db.insert(message).values([
				{
					id: olderMessageId,
					threadId: current.mainThreadId,
					authorUserId: userId,
					kind: "text",
					status: "complete",
					parts: [{ type: "text", text: "Older message" }],
					content: "Older message",
					createdAt: new Date("2026-09-18T09:00:00.000Z"),
				},
				{
					id: newerMessageId,
					threadId: current.mainThreadId,
					authorUserId: userId,
					kind: "text",
					status: "complete",
					parts: [{ type: "text", text: "Newer message" }],
					content: "Newer message",
					createdAt: new Date("2026-09-18T11:00:00.000Z"),
				},
			]),
		);
		await onDatabase((db) =>
			db
				.update(routineExecution)
				.set({ acceptedAt: new Date("2026-09-18T10:00:00.000Z") })
				.where(eq(routineExecution.id, accepted.executionId)),
		);

		const firstPage = await view.messages(current.id, { limit: 2 });
		expect(firstPage?.items.map(timelineItemId)).toEqual([accepted.executionId, newerMessageId]);
		expect(firstPage?.nextCursor).toBeTypeOf("string");
		if (!firstPage?.nextCursor) throw new Error("Expected another Chat timeline page");

		const secondPage = await view.messages(current.id, {
			limit: 2,
			cursor: firstPage.nextCursor,
		});
		expect(secondPage?.items.map(timelineItemId)).toEqual([olderMessageId]);
		expect(secondPage?.nextCursor).toBeNull();
	});

	it("shows an agent collaboration in both agents' Chats", async () => {
		const initiatorChat = await chats.open({
			workspace: workspaceId,
			podId,
			hostAgentId: agentId,
		});
		const recipientChat = await chats.open({
			workspace: workspaceId,
			podId,
			hostAgentId: recipientAgentId,
		});
		const trigger = await chats.post({
			chatId: initiatorChat.id,
			messageId: crypto.randomUUID(),
			content: "Ask Impersonal Agent",
		});
		if (!trigger) throw new Error("Could not create collaboration trigger");
		const collaborationId = crypto.randomUUID();
		const [askingTurn] = await onDatabase((db) =>
			db
				.insert(turn)
				.values({
					threadId: initiatorChat.mainThreadId,
					agentId,
					triggerMessageId: trigger.id,
					status: "done",
					model: "test/model",
					startedAt: new Date(),
					finishedAt: new Date(),
					reason: "default",
				})
				.returning(),
		);
		if (!askingTurn) throw new Error("Could not create asking turn");
		const [parentMessage] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					threadId: initiatorChat.mainThreadId,
					authorAgentId: agentId,
					kind: "text",
					status: "complete",
					parts: [{ type: "collaboration", collaborationId }],
					content: "",
					turnId: askingTurn.id,
				})
				.returning(),
		);
		const [child] = await onDatabase((db) =>
			db
				.insert(thread)
				.values({
					workspaceId,
					podId,
					hostAgentId: recipientAgentId,
					chatId: initiatorChat.id,
					type: "collaboration",
					title: "Compare the launch plans",
					parentThreadId: initiatorChat.mainThreadId,
					initiatorUserId: userId,
				})
				.returning(),
		);
		if (!parentMessage || !child) throw new Error("Could not create collaboration threads");
		await onDatabase((db) =>
			db.insert(threadParticipant).values([
				{ threadId: child.id, agentId },
				{ threadId: child.id, agentId: recipientAgentId },
			]),
		);
		await onDatabase((db) =>
			db.insert(collaboration).values({
				id: collaborationId,
				parentThreadId: initiatorChat.mainThreadId,
				parentMessageId: parentMessage.id,
				turnId: askingTurn.id,
				childThreadId: child.id,
				collaboratorAgentId: recipientAgentId,
				brief: "Compare the launch plans",
				status: "waiting",
				atOffset: 0,
			}),
		);

		const outbound = await view.messages(initiatorChat.id);
		const inbound = await view.messages(recipientChat.id);
		expect(outbound?.items.at(-1)).toMatchObject({
			kind: "message",
			message: { parts: [{ type: "collaboration", threadId: child.id }] },
		});
		expect(inbound?.items).toEqual([
			expect.objectContaining({
				kind: "collaboration",
				id: collaborationId,
				threadId: child.id,
				initiator: expect.objectContaining({ id: agentId, name: "Personal Agent" }),
			}),
		]);
		expect((await view.history(recipientChat.id))?.items).toEqual([
			expect.objectContaining({ threadId: child.id, type: "collaboration" }),
		]);
	});

	it("reports each history thread's own status, participants, and Routine run", async () => {
		const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
		const created = await routines.create(
			{ agentId },
			{
				name: "Overnight review",
				instructions: "Review overnight changes.",
				trigger: { kind: "webhook" },
			},
		);
		const requestId = crypto.randomUUID();
		const accepted = await routines.run({ agentId, routineId: created.routine.id, requestId });
		const [failed, running] = await onDatabase((db) =>
			db
				.insert(thread)
				.values(
					["Failed collaboration", "Running collaboration"].map((title) => ({
						workspaceId,
						podId,
						hostAgentId: agentId,
						chatId: current.id,
						type: "collaboration" as const,
						title,
						parentThreadId: current.mainThreadId,
						initiatorUserId: userId,
					})),
				)
				.returning(),
		);
		if (!failed || !running) throw new Error("Could not create collaboration threads");
		await onDatabase((db) =>
			db.insert(threadParticipant).values([
				{ threadId: failed.id, agentId },
				{ threadId: running.id, userId },
				{ threadId: running.id, agentId: recipientAgentId },
			]),
		);
		const [failedTrigger] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					threadId: failed.id,
					authorUserId: userId,
					kind: "text",
					status: "complete",
					parts: [{ type: "text", text: "Try this" }],
					content: "Try this",
				})
				.returning(),
		);
		if (!failedTrigger) throw new Error("Could not create failed turn trigger");
		await onDatabase((db) =>
			db.insert(turn).values({
				threadId: failed.id,
				agentId,
				triggerMessageId: failedTrigger.id,
				status: "failed",
				model: "test/model",
				startedAt: new Date(),
				finishedAt: new Date(),
				reason: "default",
			}),
		);
		await runOnPostgres(
			queueFacilitationForTests({ threadId: running.id, triggerMessageId: crypto.randomUUID() }),
		);

		const items = (await view.history(current.id))?.items ?? [];
		const entry = (threadId: string) => items.find((item) => item.threadId === threadId);
		expect(items).toHaveLength(3);
		expect(entry(failed.id)).toMatchObject({
			status: "failed",
			participants: [expect.objectContaining({ id: agentId })],
			routineExecution: null,
		});
		expect(entry(running.id)).toMatchObject({
			status: "running",
			participants: [
				expect.objectContaining({ id: userId }),
				expect.objectContaining({ id: recipientAgentId }),
			],
			routineExecution: null,
		});
		expect(entry(accepted.threadId)).toMatchObject({
			type: "routine",
			status: "queued",
			routineExecution: {
				executionId: accepted.executionId,
				routineId: created.routine.id,
				routineName: "Overnight review",
				triggerKind: "manual",
				triggeredAt: expect.any(String),
			},
		});
	});

	describe("the approvals and activity across a workspace", () => {
		/** The host writes `content` in `threadId`, `secondsLater` after now, and returns the message. */
		const botWrites = async (threadId: string, content: string, secondsLater = 0) => {
			const [written] = await onDatabase((db) =>
				db
					.insert(message)
					.values({
						threadId,
						authorAgentId: agentId,
						kind: "text",
						status: "complete",
						parts: content ? [{ type: "text", text: content }] : [],
						content,
						createdAt: new Date(Date.now() + secondsLater * 1000),
					})
					.returning(),
			);
			if (!written) throw new Error("fixture");
			return written;
		};

		/** A reply in the chat that called a write and stopped for someone to approve it. */
		const askForApproval = async (threadId: string) => {
			const reply = await botWrites(threadId, "", 1);
			const [asked] = await onDatabase((db) =>
				db
					.insert(turn)
					.values({
						threadId,
						agentId,
						triggerMessageId: reply.id,
						status: "waiting",
						model: "test/model",
						startedAt: new Date(),
					})
					.returning({ id: turn.id }),
			);
			if (!asked) throw new Error("fixture");
			const [call] = await onDatabase((db) =>
				db
					.insert(toolCall)
					.values({
						threadId,
						messageId: reply.id,
						turnId: asked.id,
						tool: "linear__create_issue",
						approvalId: `approval-${crypto.randomUUID()}`,
						approvalStatus: "pending",
						status: "awaiting_approval",
						input: { title: "Checkout times out" },
						atOffset: 0,
					})
					.returning({ id: toolCall.id }),
			);
			if (!call) throw new Error("fixture");
			return call.id;
		};

		/** The host asks the other bot in its chat to compare the launch plans, and returns the asked bot's thread. */
		const collaborate = async (mainThreadId: string, chatId: string) => {
			const trigger = await botWrites(mainThreadId, "", 0);
			const [askingTurn] = await onDatabase((db) =>
				db
					.insert(turn)
					.values({
						threadId: mainThreadId,
						agentId,
						triggerMessageId: trigger.id,
						status: "done",
						model: "test/model",
						startedAt: new Date(),
						finishedAt: new Date(),
						reason: "default",
					})
					.returning(),
			);
			if (!askingTurn) throw new Error("fixture");
			const collaborationId = crypto.randomUUID();
			const [asking] = await onDatabase((db) =>
				db
					.insert(message)
					.values({
						threadId: mainThreadId,
						authorAgentId: agentId,
						kind: "text",
						status: "complete",
						parts: [{ type: "collaboration", collaborationId }],
						content: "",
						turnId: askingTurn.id,
					})
					.returning(),
			);
			const [child] = await onDatabase((db) =>
				db
					.insert(thread)
					.values({
						workspaceId,
						podId,
						hostAgentId: recipientAgentId,
						chatId,
						type: "collaboration",
						title: "Compare the launch plans",
						parentThreadId: mainThreadId,
						initiatorUserId: userId,
					})
					.returning(),
			);
			if (!asking || !child) throw new Error("fixture");
			await onDatabase((db) =>
				db.insert(collaboration).values({
					id: collaborationId,
					parentThreadId: mainThreadId,
					parentMessageId: asking.id,
					turnId: askingTurn.id,
					childThreadId: child.id,
					collaboratorAgentId: recipientAgentId,
					brief: "Compare the launch plans",
					status: "waiting",
					atOffset: 0,
				}),
			);
			return child.id;
		};

		it("lists a call waiting on the person's decision, then among the answered once decided", async () => {
			const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
			const callId = await askForApproval(current.mainThreadId);

			expect(await view.approvals(workspaceId)).toEqual({
				waiting: [
					expect.objectContaining({
						call: expect.objectContaining({ id: callId, tool: "linear__create_issue" }),
						agent: expect.objectContaining({ id: agentId }),
						podId,
						threadId: current.mainThreadId,
						chatAgentId: agentId,
						inMainThread: true,
					}),
				],
				answered: [],
			});

			await onDatabase((db) =>
				db
					.update(toolCall)
					.set({ approvalStatus: "denied", decidedById: administratorId, decidedAt: new Date() })
					.where(eq(toolCall.id, callId)),
			);

			const inbox = await view.approvals(workspaceId);
			expect(inbox.waiting).toEqual([]);
			expect(inbox.answered).toEqual([
				expect.objectContaining({
					call: expect.objectContaining({ id: callId }),
					answer: expect.objectContaining({ status: "denied", decidedByName: "Chat admin" }),
				}),
			]);
		});

		it("lists a call waiting on the person's decision behind many they may not decide", async () => {
			const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
			const created = await routines.create(
				{ agentId },
				{ name: "Overnight filing", instructions: "File it.", trigger: { kind: "webhook" } },
			);
			const run = await routines.run({
				agentId,
				routineId: created.routine.id,
				requestId: crypto.randomUUID(),
			});
			// A member may not decide what a routine asks, and these are older than
			// every call the inbox would list, so they would fill it first.
			const reply = await botWrites(run.threadId, "", 1);
			const [asked] = await onDatabase((db) =>
				db
					.insert(turn)
					.values({
						threadId: run.threadId,
						agentId,
						triggerMessageId: reply.id,
						status: "waiting",
						model: "test/model",
						startedAt: new Date(),
					})
					.returning({ id: turn.id }),
			);
			if (!asked) throw new Error("fixture");
			const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
			await onDatabase((db) =>
				db.insert(toolCall).values(
					Array.from({ length: 101 }, () => ({
						threadId: run.threadId,
						messageId: reply.id,
						turnId: asked.id,
						tool: "linear__create_issue",
						approvalId: `approval-${crypto.randomUUID()}`,
						approvalStatus: "pending" as const,
						status: "awaiting_approval" as const,
						input: {},
						atOffset: 0,
						startedAt: hourAgo,
					})),
				),
			);
			const callId = await askForApproval(current.mainThreadId);

			expect((await view.approvals(workspaceId)).waiting).toEqual([
				expect.objectContaining({ call: expect.objectContaining({ id: callId }) }),
			]);
		});

		it("lists what the person has not read, and keeps what mentions them once read", async () => {
			const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
			const news = await botWrites(current.mainThreadId, "The deploy finished.", 1);
			const mention = await botWrites(current.mainThreadId, "@chat-member can you check it?", 2);

			expect((await view.activity(workspaceId)).items).toEqual([
				expect.objectContaining({ kind: "mention", messageId: mention.id, unread: true }),
				expect.objectContaining({
					kind: "message",
					messageId: news.id,
					unread: true,
					preview: "The deploy finished.",
					chatAgentId: agentId,
				}),
			]);

			await chats.markRead(current.id);

			expect((await view.activity(workspaceId)).items).toEqual([
				expect.objectContaining({ kind: "mention", messageId: mention.id, unread: false }),
			]);
		});

		it("does not take an email address for a mention", async () => {
			const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
			await chats.markRead(current.id);
			await botWrites(current.mainThreadId, "Mail it to ops@chat-member.example", 1);

			expect((await view.activity(workspaceId)).items).toEqual([
				expect.objectContaining({ kind: "message" }),
			]);
		});

		it("lists a routine run in the person's chats, with the start of what it said", async () => {
			await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
			const created = await routines.create(
				{ agentId },
				{ name: "Overnight review", instructions: "Review it.", trigger: { kind: "webhook" } },
			);
			const accepted = await routines.run({
				agentId,
				routineId: created.routine.id,
				requestId: crypto.randomUUID(),
			});
			await botWrites(accepted.threadId, "Two PRs merged.\nThe release branch is green.", 1);

			expect((await view.activity(workspaceId)).items).toContainEqual(
				expect.objectContaining({
					kind: "routine",
					threadId: accepted.threadId,
					routineName: "Overnight review",
					triggerKind: "manual",
					agent: expect.objectContaining({ id: agentId }),
					preview: "Two PRs merged. The release branch is green.",
					chatAgentId: agentId,
					unread: true,
				}),
			);
		});

		it("lists a collaboration in the person's chats", async () => {
			const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
			const childThreadId = await collaborate(current.mainThreadId, current.id);

			expect((await view.activity(workspaceId)).items).toContainEqual(
				expect.objectContaining({
					kind: "collaboration",
					threadId: childThreadId,
					initiator: expect.objectContaining({ id: agentId }),
					recipient: expect.objectContaining({ id: recipientAgentId }),
					status: "waiting",
					brief: "Compare the launch plans",
					chatAgentId: agentId,
					unread: true,
				}),
			);
		});

		it("counts a routine run and a collaboration caught up with once the person writes after them", async () => {
			const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
			const created = await routines.create(
				{ agentId },
				{ name: "Overnight review", instructions: "Review it.", trigger: { kind: "webhook" } },
			);
			const run = await routines.run({
				agentId,
				routineId: created.routine.id,
				requestId: crypto.randomUUID(),
			});
			const childThreadId = await collaborate(current.mainThreadId, current.id);
			const unreadOf = async () =>
				(await view.activity(workspaceId)).items.flatMap((item) =>
					item.kind === "routine" || item.kind === "collaboration"
						? [{ threadId: item.threadId, unread: item.unread }]
						: [],
				);
			expect(await unreadOf()).toEqual(
				expect.arrayContaining([
					{ threadId: run.threadId, unread: true },
					{ threadId: childThreadId, unread: true },
				]),
			);

			await chats.post({
				chatId: current.id,
				messageId: crypto.randomUUID(),
				content: "Seen both",
			});

			expect(await unreadOf()).toEqual(
				expect.arrayContaining([
					{ threadId: run.threadId, unread: false },
					{ threadId: childThreadId, unread: false },
				]),
			);
		});
	});
});

function timelineItemId(item: ChatMessageItem) {
	return item.kind === "message" ? item.message.id : item.id;
}
