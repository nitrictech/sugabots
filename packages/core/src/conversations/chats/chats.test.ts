import {
	type ChatMessageItem,
	type FilePart,
	handleFromName,
	threadChannel,
} from "@sugabots/contracts";
import { and, desc, eq, like } from "drizzle-orm";
import { Context, Effect, Stream } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Visibility } from "../../authorization/visibility.ts";
import { EventBus } from "../../database/events/bus.ts";
import { EventStore } from "../../database/events/store.ts";
import {
	agent,
	collaboration,
	event,
	laneRequest,
	message,
	messageReaction,
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
import { Reactions } from "../reactions/reactions.ts";
import { Routines } from "../routines/routines.ts";
import { conversationsForTests } from "../testing.ts";
import { ThreadFiles } from "../thread-files/thread-files.ts";
import { ThreadView } from "../thread-view.ts";
import { ThreadRepository } from "../threads/repository.ts";
import { queueTurnForTests, runningTurns } from "../turns/testing.ts";
import { Turns } from "../turns/turns.ts";
import { ChatFiles } from "./chat-files.ts";
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
		const visibilityAs = (personId: string) =>
			onPostgresAs(personId)({ conversation: visibility.conversation });

		expect(await visibilityAs(userId).conversation(opened.id)).toMatchObject({ id: opened.id });
		for (const personId of [outsider.id, stranger.id]) {
			await expect(visibilityAs(personId).conversation(opened.id)).rejects.toMatchObject({
				_tag: "ResourceHidden",
				resource: "conversation",
			});
		}
		await expect(visibilityAs(userId).conversation("not-a-uuid")).rejects.toMatchObject({
			_tag: "ResourceHidden",
		});
	});

	it("lists a pod's bots newest message first, with bots nobody has messaged last", async () => {
		const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
		await chats.post({
			conversationId: current.id,
			messageId: crypto.randomUUID(),
			content: "\n  Budget   review is Friday\nand bring the numbers",
		});

		const list = await view.list({ workspace: workspaceId, pod: podId });

		expect(list?.items).toEqual([
			{
				agent: expect.objectContaining({ id: agentId }),
				conversation: expect.objectContaining({ id: current.id }),
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
				conversation: null,
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
				threadId: current.id,
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
			await chats.post({
				conversationId: current.id,
				messageId: crypto.randomUUID(),
				content: "Hi",
			});
			expect(await hostRow()).toMatchObject({ unreadMessages: 0 });

			await botWrites(current.id, "Hello!", 1);
			await botWrites(current.id, "", 2);
			await botWrites(current.id, "How can I help?", 3);
			expect(await hostRow()).toMatchObject({ unreadMessages: 2 });

			await chats.markRead(current.id);
			expect(await hostRow()).toMatchObject({ unreadMessages: 0 });

			await botWrites(current.id, "One more thing", 4);
			expect(await hostRow()).toMatchObject({ unreadMessages: 1 });
		});

		it("stops counting what came before the person's own reply", async () => {
			const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
			await botWrites(current.id, "Hello!", -2);
			await botWrites(current.id, "Anything else?", -1);
			expect(await hostRow()).toMatchObject({ unreadMessages: 2 });

			await chats.post({
				conversationId: current.id,
				messageId: crypto.randomUUID(),
				content: "All good",
			});
			expect(await hostRow()).toMatchObject({ unreadMessages: 0 });
		});

		it("keeps a reply that finishes after the chat was read unread", async () => {
			const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
			await chats.post({
				conversationId: current.id,
				messageId: crypto.randomUUID(),
				content: "Hey",
			});
			const [reply] = await onDatabase((db) =>
				db
					.insert(message)
					.values({
						threadId: current.id,
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
			await chats.post({
				conversationId: current.id,
				messageId: crypto.randomUUID(),
				content: "Hey",
			});
			const [reply] = await onDatabase((db) =>
				db
					.insert(message)
					.values({
						threadId: current.id,
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
			await botWrites(current.id, "Meanwhile, the deploy finished.", 2);

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
			const reply = await botWrites(current.id, "Hello!", 1);
			const readsAnnounced = async () =>
				(
					await onDatabase((db) =>
						db
							.select({ type: event.type })
							.from(event)
							.where(eq(event.channel, threadChannel(current.id))),
					)
				).filter(({ type }) => type === "thread.read").length;

			await chats.markRead(current.id);
			await chats.markRead(current.id);

			const [read] = (await threads.get(current.id)).reads;
			expect(read).toEqual({
				person: expect.objectContaining({ kind: "person", id: userId }),
				readThrough: reply.createdAt.toISOString(),
				readAt: expect.any(String),
			});
			expect(await readsAnnounced()).toBe(1);
			// When they read it, not when it was sent: the reply is stamped a second from now.
			expect(Date.parse(read?.readAt ?? "")).toBeLessThan(reply.createdAt.getTime());

			await botWrites(current.id, "One more thing", 2);
			await chats.markRead(current.id);
			const [readAgain] = (await threads.get(current.id)).reads;
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

			await botWrites(current.id, "Hello!");
			await botWrites(current.id, "Are you there?", 1);
			await onDatabase((db) =>
				db.insert(message).values({
					threadId: other.id,
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
			await chats.post({
				conversationId: current.id,
				messageId: crypto.randomUUID(),
				content: "File it",
			});
			// A reply that called a tool without writing a word first.
			const trigger = await botWrites(current.id, "", 1);
			const [asked] = await onDatabase((db) =>
				db
					.insert(turn)
					.values({
						threadId: current.id,
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
					threadId: current.id,
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
				{ name: "Elsewhere", instructions: "Run somewhere else.", triggers: [{ kind: "webhook" }] },
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

	it("opens one conversation when asked twice at once, and queues its messages in it", async () => {
		const input = { workspace: workspaceId, podId, hostAgentId: agentId };
		const [first, retried] = await Promise.all([chats.open(input), chats.open(input)]);
		expect(retried.id).toBe(first.id);
		expect(
			await onDatabase((db) =>
				db
					.select()
					.from(thread)
					.where(
						and(
							eq(thread.type, "conversation"),
							eq(thread.podId, podId),
							eq(thread.hostAgentId, agentId),
						),
					),
			),
		).toHaveLength(1);

		const sent = await chats.post({
			conversationId: first.id,
			messageId: crypto.randomUUID(),
			content: "Investigate this over several steps",
		});
		expect(sent?.threadId).toBe(first.id);
		expect(await runOnPostgres(runningTurns(first.id))).toHaveLength(1);
		expect((await view.history(first.id))?.items).toHaveLength(0);
		expect((await view.messages(first.id))?.items.map((item) => item.kind)).toEqual(["message"]);
	});

	it("opens one chat per pod, where no bot answers, even one named in it", async () => {
		const input = { workspace: workspaceId, podId };
		const [first, again] = await Promise.all([chats.openPodChat(input), chats.openPodChat(input)]);
		expect(again.id).toBe(first.id);
		expect(first).toMatchObject({ podId, hostAgentId: null, title: "Pod chat" });
		const [host] = await onDatabase((db) =>
			db.select({ handle: agent.handle }).from(agent).where(eq(agent.id, agentId)),
		);

		await chats.post({
			conversationId: first.id,
			messageId: crypto.randomUUID(),
			content: `@${host?.handle} can you look at this?`,
		});

		expect(await runOnPostgres(runningTurns(first.id))).toHaveLength(0);
		expect((await view.messages(first.id))?.items.map((item) => item.kind)).toEqual(["message"]);
	});

	it("lists a pod's chat with what the person has not read in it, and counts that on the rail", async () => {
		const podChat = await chats.openPodChat({ workspace: workspaceId, podId });
		await onDatabase((db) =>
			db.insert(message).values({
				threadId: podChat.id,
				authorUserId: administratorId,
				kind: "text",
				status: "complete",
				parts: [{ type: "text", text: "Lunch?" }],
				content: "Lunch?",
			}),
		);

		expect((await view.list({ workspace: workspaceId, pod: podId }))?.podChat).toEqual({
			conversation: expect.objectContaining({ id: podChat.id }),
			unreadMessages: 1,
		});
		expect(await view.podMarkers(workspaceId)).toEqual({
			pods: { [podId]: { unreadMessages: 1, needsApproval: false } },
		});
	});

	it("refuses a message to an agent with no model, and saves nothing", async () => {
		await onDatabase((db) => db.update(agent).set({ model: null }).where(eq(agent.id, agentId)));
		const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
		const messageId = crypto.randomUUID();

		await expect(
			chats.post({
				conversationId: current.id,
				messageId,
				content: "Anyone there?",
			}),
		).rejects.toMatchObject({ _tag: "ChatAgentHasNoModel" });
		expect(
			await onDatabase((db) => db.select().from(message).where(eq(message.id, messageId))),
		).toHaveLength(0);
		expect(await runOnPostgres(runningTurns(current.id))).toHaveLength(0);
	});

	it("retries the same message without creating another message or turn", async () => {
		const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
		const send = {
			conversationId: current.id,
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
		expect(await runOnPostgres(runningTurns(current.id))).toHaveLength(1);
		expect(
			await onDatabase((db) =>
				db
					.select()
					.from(laneRequest)
					.where(like(laneRequest.laneKey, `turn:${current.id}:%`)),
			),
		).toHaveLength(0);
	});

	it("quotes the message a reply answers, but only one in the same chat", async () => {
		const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
		const elsewhere = await chats.open({
			workspace: workspaceId,
			podId,
			hostAgentId: recipientAgentId,
		});
		const asked = await chats.post({
			conversationId: current.id,
			messageId: crypto.randomUUID(),
			content: "Ship the **release** today\nand tell the team",
		});
		const other = await chats.post({
			conversationId: elsewhere.id,
			messageId: crypto.randomUUID(),
			content: "Something else",
		});

		const reply = await chats.post({
			conversationId: current.id,
			messageId: crypto.randomUUID(),
			content: "Actually, tomorrow",
			replyTo: asked.id,
		});

		const quoted = { id: asked.id, author: asked.author, preview: "Ship the release today" };
		expect(reply.replyTo).toEqual(quoted);
		const page = await view.messages(current.id);
		expect(page.items).toContainEqual(
			expect.objectContaining({
				message: expect.objectContaining({ id: reply.id, replyTo: quoted }),
			}),
		);
		await expect(
			chats.post({
				conversationId: current.id,
				messageId: crypto.randomUUID(),
				content: "About that",
				replyTo: other.id,
			}),
		).rejects.toMatchObject({ _tag: "ReplyTargetNotFound" });
	});

	it("lets people react to a message once per emoji, announcing each change", async () => {
		const reactions = onPostgresAs(userId)(Context.get(conversations, Reactions.Service));
		const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
		const asked = await chats.post({
			conversationId: current.id,
			messageId: crypto.randomUUID(),
			content: "Ship it?",
		});
		const announced = () =>
			onDatabase((db) =>
				db
					.select({ payload: event.payload })
					.from(event)
					.where(
						and(
							eq(event.channel, threadChannel(current.id)),
							eq(event.type, "message.reactions_changed"),
						),
					),
			);

		const added = await reactions.add(asked.id, "👍🏽");
		expect(added).toEqual([
			{ emoji: "👍🏽", people: [{ id: userId, name: "Chat member", at: expect.any(String) }] },
		]);
		expect(await reactions.add(asked.id, "👍🏽")).toEqual(added);
		const page = await view.messages(current.id);
		expect(page.items).toContainEqual(
			expect.objectContaining({
				message: expect.objectContaining({ id: asked.id, reactions: added }),
			}),
		);
		expect(await reactions.remove(asked.id, "👍🏽")).toEqual([]);
		expect(await reactions.remove(asked.id, "👍🏽")).toEqual([]);
		expect((await announced()).map(({ payload }) => payload)).toEqual([
			expect.objectContaining({ messageId: asked.id, reactions: added }),
			expect.objectContaining({ messageId: asked.id, reactions: [] }),
		]);

		const [stranger] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: "Stranger", email: `stranger-${crypto.randomUUID()}@example.com` })
				.returning(),
		);
		if (!stranger) throw new Error("Could not create a stranger");
		const strangers = onPostgresAs(stranger.id)(Context.get(conversations, Reactions.Service));
		await expect(strangers.add(asked.id, "👍🏽")).rejects.toMatchObject({ _tag: "ResourceHidden" });
	});

	it("refuses a reaction to a reply still being written, and a new emoji past the limit", async () => {
		const reactions = onPostgresAs(userId)(Context.get(conversations, Reactions.Service));
		const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
		const asked = await chats.post({
			conversationId: current.id,
			messageId: crypto.randomUUID(),
			content: "Ship it?",
		});
		const [writing] = await onDatabase((db) =>
			db
				.insert(message)
				.values({
					threadId: current.id,
					authorAgentId: agentId,
					kind: "text",
					status: "streaming",
					parts: [],
					content: "",
				})
				.returning(),
		);
		if (!writing) throw new Error("Could not start a reply");
		await expect(reactions.add(writing.id, "👍")).rejects.toMatchObject({
			_tag: "MessageNotFinished",
		});

		const used = Array.from("😀😃😄😁😆😅😂🤣😊😇🙂🙃😉😌😍🥰😘😗😙😚");
		await onDatabase((db) =>
			db
				.insert(messageReaction)
				.values(used.map((emoji) => ({ messageId: asked.id, userId: administratorId, emoji }))),
		);
		await expect(reactions.add(asked.id, "🎉")).rejects.toMatchObject({
			_tag: "TooManyReactionEmoji",
		});
		const joined = await reactions.add(asked.id, "😀");
		expect(joined[0]?.people.map((person) => person.id)).toEqual([administratorId, userId]);
	});

	it("says which messages wait for the agent's next turn, and announces when one starts waiting", async () => {
		const threads = onPostgresAs(userId)(Context.get(conversations, ThreadView.Service));
		const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
		const post = (content: string) =>
			chats.post({ conversationId: current.id, messageId: crypto.randomUUID(), content });
		const changesAnnounced = async () =>
			(
				await onDatabase((db) =>
					db
						.select({ type: event.type })
						.from(event)
						.where(eq(event.channel, threadChannel(current.id))),
				)
			).filter(({ type }) => type === "thread.changed").length;

		await post("Is checkout timing out?");
		expect((await threads.get(current.id)).queuedSince).toBeNull();
		const changedBefore = await changesAnnounced();

		const followUp = await post("The Stripe webhook too?");
		await post("Started around 9.");

		expect((await threads.get(current.id)).queuedSince).toBe(followUp.createdAt);
		// Once, when the turn started waiting; the next message joins it.
		expect((await changesAnnounced()) - changedBefore).toBe(1);
	});

	it("queues nothing posted before a turn resumed from an earlier reply starts waiting", async () => {
		const threads = onPostgresAs(userId)(Context.get(conversations, ThreadView.Service));
		const turns = Context.get(conversations, Turns.Service);
		const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
		const asked = await chats.post({
			conversationId: current.id,
			messageId: crypto.randomUUID(),
			content: "Who owns checkout?",
		});

		// A collaboration answered after the agent moved on resumes it from the
		// reply that opened it, which is long since answered.
		await runOnPostgres(
			turns.ask({
				threadId: current.id,
				agentId,
				triggerMessageId: asked.id,
				reason: "resume",
			}),
		);
		const later = await chats.post({
			conversationId: current.id,
			messageId: crypto.randomUUID(),
			content: "And billing?",
		});

		const { queuedSince } = await threads.get(current.id);
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
					and(eq(threadParticipant.threadId, current.id), eq(threadParticipant.agentId, agentId)),
				),
		);

		await chats.post({
			conversationId: current.id,
			messageId: crypto.randomUUID(),
			content: "Are you there?",
		});

		const announced = await onDatabase((db) =>
			db
				.select({ type: event.type })
				.from(event)
				.where(eq(event.channel, threadChannel(current.id)))
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
				triggers: [{ kind: "webhook" }],
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
				triggers: [{ kind: "webhook" }],
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
					threadId: current.id,
					authorUserId: userId,
					kind: "text",
					status: "complete",
					parts: [{ type: "text", text: "Older message" }],
					content: "Older message",
					createdAt: new Date("2026-09-18T09:00:00.000Z"),
				},
				{
					id: newerMessageId,
					threadId: current.id,
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
			conversationId: initiatorChat.id,
			messageId: crypto.randomUUID(),
			content: "Ask Impersonal Agent",
		});
		if (!trigger) throw new Error("Could not create collaboration trigger");
		const collaborationId = crypto.randomUUID();
		const [askingTurn] = await onDatabase((db) =>
			db
				.insert(turn)
				.values({
					threadId: initiatorChat.id,
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
					threadId: initiatorChat.id,
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
					conversationId: initiatorChat.id,
					type: "collaboration",
					title: "Compare the launch plans",
					parentThreadId: initiatorChat.id,
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
				parentThreadId: initiatorChat.id,
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
				triggers: [{ kind: "webhook" }],
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
						conversationId: current.id,
						type: "collaboration" as const,
						title,
						parentThreadId: current.id,
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
			queueTurnForTests({
				threadId: running.id,
				agentId: recipientAgentId,
				triggerMessageId: crypto.randomUUID(),
				reason: "collaboration",
			}),
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

		/** A reply in the chat that called `tool` and stopped for someone to approve it. */
		const askForApproval = async (threadId: string, tool = "linear__create_issue") => {
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
						tool,
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
		const collaborate = async (mainThreadId: string, conversationId: string) => {
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
						conversationId,
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
			const callId = await askForApproval(current.id);

			expect(await view.approvals(workspaceId)).toEqual({
				waiting: [
					expect.objectContaining({
						call: expect.objectContaining({ id: callId, tool: "linear__create_issue" }),
						agent: expect.objectContaining({ id: agentId }),
						podId,
						threadId: current.id,
						conversationId: current.id,
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
				{ name: "Overnight filing", instructions: "File it.", triggers: [{ kind: "webhook" }] },
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
			const callId = await askForApproval(current.id);

			expect((await view.approvals(workspaceId)).waiting).toEqual([
				expect.objectContaining({ call: expect.objectContaining({ id: callId }) }),
			]);
		});

		it("leaves out a request to change the pod's sandbox, which only its managers decide", async () => {
			const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
			await askForApproval(current.id, "request_network_access");
			const callId = await askForApproval(current.id);

			expect((await view.approvals(workspaceId)).waiting).toEqual([
				expect.objectContaining({ call: expect.objectContaining({ id: callId }) }),
			]);
		});

		it("lists what the person has not read, and keeps what mentions them once read", async () => {
			const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
			const news = await botWrites(current.id, "The deploy finished.", 1);
			const mention = await botWrites(current.id, "@chat-member can you check it?", 2);

			expect((await view.activity(workspaceId)).items).toEqual([
				expect.objectContaining({ kind: "mention", messageId: mention.id, unread: true }),
				expect.objectContaining({
					kind: "message",
					messageId: news.id,
					unread: true,
					preview: "The deploy finished.",
					conversationId: current.id,
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
			await botWrites(current.id, "Mail it to ops@chat-member.example", 1);

			expect((await view.activity(workspaceId)).items).toEqual([
				expect.objectContaining({ kind: "message" }),
			]);
		});

		it("lists a routine run in the person's chats, with the start of what it said", async () => {
			const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
			const created = await routines.create(
				{ agentId },
				{ name: "Overnight review", instructions: "Review it.", triggers: [{ kind: "webhook" }] },
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
					conversationId: current.id,
					unread: true,
				}),
			);
		});

		it("lists a collaboration in the person's chats", async () => {
			const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
			const childThreadId = await collaborate(current.id, current.id);

			expect((await view.activity(workspaceId)).items).toContainEqual(
				expect.objectContaining({
					kind: "collaboration",
					threadId: childThreadId,
					initiator: expect.objectContaining({ id: agentId }),
					recipient: expect.objectContaining({ id: recipientAgentId }),
					status: "waiting",
					brief: "Compare the launch plans",
					conversationId: current.id,
					unread: true,
				}),
			);
		});

		it("counts a routine run and a collaboration caught up with once the person writes after them", async () => {
			const current = await chats.open({ workspace: workspaceId, podId, hostAgentId: agentId });
			const created = await routines.create(
				{ agentId },
				{ name: "Overnight review", instructions: "Review it.", triggers: [{ kind: "webhook" }] },
			);
			const run = await routines.run({
				agentId,
				routineId: created.routine.id,
				requestId: crypto.randomUUID(),
			});
			const childThreadId = await collaborate(current.id, current.id);
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
				conversationId: current.id,
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

	describe("sending files", () => {
		/** The chat, with the member's uploads to it. */
		async function aChatWithFiles() {
			const { id: conversationId } = await chats.open({
				workspace: workspaceId,
				podId,
				hostAgentId: agentId,
			});
			const files = onPostgresAs(userId)(Context.get(conversations, ChatFiles.Service));
			const upload = (name: string) =>
				files.upload({
					conversationId,
					name,
					type: "text/plain",
					stream: Stream.succeed(new TextEncoder().encode(name)),
				});
			return { conversationId, files, upload };
		}
		const asPart = ({ id, name, contentType, size }: ThreadFiles.Upload): FilePart => ({
			type: "file",
			id,
			name,
			contentType,
			size,
		});
		const shownMessage = async (conversationId: string, messageId: string) =>
			(await view.messages(conversationId)).items.find(
				(item) => item.kind === "message" && item.message.id === messageId,
			);

		it("sends the files with the message, in the order listed, for its readers to open", async () => {
			const { conversationId, files, upload } = await aChatWithFiles();
			const first = await upload("a.txt");
			const second = await upload("b.txt");

			const sent = await chats.post({
				conversationId,
				messageId: crypto.randomUUID(),
				content: "",
				attachments: [second.id, first.id],
			});

			expect(sent).toMatchObject({ content: "", parts: [asPart(second), asPart(first)] });
			expect(await shownMessage(conversationId, sent.id)).toMatchObject({
				message: { parts: [asPart(second), asPart(first)] },
			});
			// Watching clients add the announced message as it is, so it must carry its files.
			const [announced] = await onDatabase((db) =>
				db
					.select({ payload: event.payload })
					.from(event)
					.where(
						and(eq(event.channel, threadChannel(sent.threadId)), eq(event.type, "message.created")),
					)
					.orderBy(desc(event.seq))
					.limit(1),
			);
			expect(announced?.payload).toMatchObject({
				message: { id: sent.id, parts: [asPart(second), asPart(first)] },
			});
			expect(await files.read({ conversationId, fileId: first.id })).toMatchObject({
				name: "a.txt",
			});
		});

		it("posts nothing when a file is not one of the sender's unsent uploads", async () => {
			const { conversationId, upload } = await aChatWithFiles();
			const sentBefore = await upload("sent.txt");
			await chats.post({
				conversationId,
				messageId: crypto.randomUUID(),
				content: "first",
				attachments: [sentBefore.id],
			});
			const fresh = await upload("fresh.txt");
			const messageId = crypto.randomUUID();

			await expect(
				chats.post({
					conversationId,
					messageId,
					content: "again",
					attachments: [fresh.id, sentBefore.id],
				}),
			).rejects.toBeInstanceOf(ThreadFiles.UploadsNotFound);
			expect(await shownMessage(conversationId, messageId)).toBeUndefined();
			// The fresh upload is still the sender's to send.
			await expect(
				chats.post({ conversationId, messageId, content: "again", attachments: [fresh.id] }),
			).resolves.toMatchObject({ parts: [{ type: "text" }, asPart(fresh)] });
		});

		it("returns a message sent again with its files, and refuses its id for other files", async () => {
			const { conversationId, upload } = await aChatWithFiles();
			const attached = await upload("a.txt");
			const other = await upload("b.txt");
			const messageId = crypto.randomUUID();
			const send = (attachments: string[]) =>
				chats.post({ conversationId, messageId, content: "files", attachments });
			const sent = await send([attached.id]);

			await expect(send([attached.id])).resolves.toEqual(sent);
			await expect(send([other.id])).rejects.toBeInstanceOf(ThreadRepository.MessageIdConflict);
		});
	});

	it("keeps an uploaded file as the type it was given, or else the type its name suggests", async () => {
		const { id: conversationId } = await chats.open({
			workspace: workspaceId,
			podId,
			hostAgentId: agentId,
		});
		const files = onPostgresAs(userId)(Context.get(conversations, ChatFiles.Service));
		const upload = (name: string, type: string | undefined) =>
			files.upload({
				conversationId,
				name,
				type,
				stream: Stream.succeed(new TextEncoder().encode("x")),
			});

		// Browsers give no type for many text files, which bots must still read as text.
		expect(await upload("notes.md", undefined)).toMatchObject({
			contentType: "text/markdown; charset=utf-8",
		});
		expect(await upload("report.csv", "application/octet-stream")).toMatchObject({
			contentType: "text/csv; charset=utf-8",
		});
		expect(await upload("chart", "image/png")).toMatchObject({ contentType: "image/png" });
		expect(await upload("data", undefined)).toMatchObject({
			contentType: "application/octet-stream",
		});
	});
});

function timelineItemId(item: ChatMessageItem) {
	return item.kind === "message" ? item.message.id : item.id;
}
