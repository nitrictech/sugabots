import { MAX_DIRECT_MESSAGE_PEOPLE } from "@sugabots/contracts";

import { and, eq } from "drizzle-orm";
import { Context, Effect } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Visibility } from "../../authorization/visibility.ts";
import { EventBus } from "../../database/events/bus.ts";
import { EventStore } from "../../database/events/store.ts";
import { pod, podMember, user, workspace, workspaceMember } from "../../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../../database/testing.ts";
import { onPostgresAs } from "../../workspaces/testing.ts";
import { ChatView } from "../chats/chat-view.ts";
import { Chats } from "../chats/chats.ts";
import { conversationsForTests } from "../testing.ts";
import { ThreadView } from "../thread-view.ts";

const eventStore = await runOnPostgres(EventStore.make);

describe.skipIf(!process.env.DATABASE_URL)("direct messages, against Postgres", async () => {
	const conversations = await conversationsForTests(EventBus.inProcess({ store: eventStore }));
	const visibility = await runOnPostgres(Effect.provide(Visibility.Service, Visibility.layer));

	/** The chat services as one person, and what they can see. */
	const as = (userId: string) => ({
		chats: onPostgresAs(userId)(Context.get(conversations, Chats.Service)),
		view: onPostgresAs(userId)(Context.get(conversations, ChatView.Service)),
		threads: onPostgresAs(userId)(Context.get(conversations, ThreadView.Service)),
		visibility: onPostgresAs(userId)({ pods: visibility.pods }),
	});

	let workspaceId: string;
	let podId: string;
	/** In the pod. */
	let member: { id: string; name: string };
	/** In the pod too. */
	let colleague: { id: string; name: string };
	/** An administrator, in every shared pod. */
	let administrator: { id: string; name: string };
	/** In the workspace, not the pod. */
	let outsider: { id: string; name: string };

	afterAll(async () => {
		await closeDatabase();
	});

	beforeEach(async () => {
		const suffix = crypto.randomUUID();
		const people = await onDatabase((db) =>
			db
				.insert(user)
				.values(
					["Dana Member", "Colin Colleague", "Ada Admin", "Otto Outsider"].map((name) => ({
						name: `${name} ${suffix.slice(0, 8)}`,
						email: `${name.split(" ")[0]?.toLowerCase()}-${suffix}@example.com`,
					})),
				)
				.returning({ id: user.id, name: user.name }),
		);
		const [first, second, third, fourth] = people;
		if (!first || !second || !third || !fourth) throw new Error("Could not create the people");
		[member, colleague, administrator, outsider] = [first, second, third, fourth];
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: "Direct workspace", slug: `direct-${suffix}` })
				.returning(),
		);
		if (!space) throw new Error("Could not create the workspace");
		workspaceId = space.id;
		await onDatabase((db) =>
			db.insert(workspaceMember).values([
				{ workspaceId, userId: member.id },
				{ workspaceId, userId: colleague.id },
				{ workspaceId, userId: administrator.id, role: "admin" },
				{ workspaceId, userId: outsider.id },
			]),
		);
		const [room] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({ workspaceId, kind: "shared", name: "Ops", slug: `ops-${suffix}` })
				.returning(),
		);
		if (!room) throw new Error("Could not create the pod");
		podId = room.id;
		await onDatabase((db) =>
			db.insert(podMember).values([
				{ workspaceId, podId, userId: member.id },
				{ workspaceId, podId, userId: colleague.id },
			]),
		);
	});

	/** `from` writes `content` to `to`, in the direct message between them. */
	const send = (from: string, to: readonly string[], content: string) =>
		as(from).chats.sendDirectMessage({
			workspace: workspaceId,
			userIds: to,
			messageId: crypto.randomUUID(),
			content,
		});

	/** `userId` writes `content` in a conversation they are in. */
	const say = (userId: string, conversationId: string, content: string) =>
		as(userId).chats.post({ conversationId, messageId: crypto.randomUUID(), content });

	/** Takes `userId` out of the workspace, keeping their account. */
	const leaveWorkspace = (userId: string) =>
		onDatabase((db) =>
			db
				.delete(workspaceMember)
				.where(
					and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, userId)),
				),
		);

	describe("between people", () => {
		it("sends to one direct message for two people, whichever of them writes", async () => {
			const sent = await send(member.id, [colleague.id], "Are you around for the deploy?");
			const answered = await send(colleague.id, [member.id], "Yes, five minutes");

			expect(answered.conversation.id).toBe(sent.conversation.id);
			expect(sent.message.content).toBe("Are you around for the deploy?");
		});

		it("names the same people the same way however their ids are written", async () => {
			const sent = await send(member.id, [colleague.id], "Lower case");
			const shouted = await send(
				member.id,
				[colleague.id.toUpperCase(), member.id.toUpperCase()],
				"Upper case",
			);

			expect(shouted.conversation.id).toBe(sent.conversation.id);
		});

		it("lists it for the other person, with what they have not read", async () => {
			const { conversation } = await send(member.id, [colleague.id], "Are you around?");

			const { items } = await as(colleague.id).view.directMessages(workspaceId);

			expect(items).toEqual([
				{
					conversation: expect.objectContaining({ kind: "direct", id: conversation.id }),
					people: [expect.objectContaining({ id: member.id, name: member.name })],
					formerMembers: 0,
					lastMessage: expect.objectContaining({
						preview: "Are you around?",
						authorUserId: member.id,
					}),
					unreadMessages: 1,
				},
			]);
			expect(await as(colleague.id).view.directMessage(conversation.id)).toEqual(items[0]);
		});

		it("tells the other person in their activity, as a message in no pod", async () => {
			const { conversation } = await send(member.id, [colleague.id], "Ping");

			const { items } = await as(colleague.id).view.activity(workspaceId);

			expect(items).toEqual([
				expect.objectContaining({ conversationId: conversation.id, podId: null, unread: true }),
			]);
		});

		it("does not take @here or @channel in it as mentioning anybody, as everybody in it is told anyway", async () => {
			await send(member.id, [colleague.id], "@here can you look");

			const { items } = await as(colleague.id).view.activity(workspaceId);

			expect(items).toEqual([expect.objectContaining({ kind: "message" })]);
		});

		it("keeps it from everybody else, administrators included", async () => {
			const { conversation } = await send(member.id, [colleague.id], "Just between us");

			for (const other of [administrator, outsider]) {
				await expect(as(other.id).view.messages(conversation.id)).rejects.toMatchObject({
					_tag: "ResourceHidden",
				});
				await expect(as(other.id).view.directMessage(conversation.id)).rejects.toMatchObject({
					_tag: "ResourceHidden",
				});
				await expect(say(other.id, conversation.id, "Let me in")).rejects.toMatchObject({
					_tag: "ResourceHidden",
				});
				expect((await as(other.id).view.directMessages(workspaceId)).items).toEqual([]);
				expect((await as(other.id).view.activity(workspaceId)).items).toEqual([]);
				await expect(as(other.id).threads.activity(conversation.id)).rejects.toMatchObject({
					_tag: "ResourceHidden",
				});
				expect((await as(other.id).threads.list(workspaceId)).map(({ id }) => id)).not.toContain(
					conversation.id,
				);
			}
		});

		it("is a thread its people read like any other: listed, and with its activity", async () => {
			const { conversation } = await send(member.id, [colleague.id], "Just between us");

			for (const person of [member, colleague]) {
				expect((await as(person.id).threads.list(workspaceId)).map(({ id }) => id)).toContain(
					conversation.id,
				);
				await expect(as(person.id).threads.activity(conversation.id)).resolves.toMatchObject({
					summary: null,
				});
			}
		});

		it("counts somebody who left the workspace as a former member, who no longer reads it", async () => {
			const { conversation } = await send(member.id, [colleague.id], "Handing over the pager");
			await leaveWorkspace(colleague.id);

			const { items } = await as(member.id).view.directMessages(workspaceId);

			expect(items).toEqual([
				expect.objectContaining({
					conversation: expect.objectContaining({ id: conversation.id }),
					people: [],
					formerMembers: 1,
				}),
			]);
			await expect(as(colleague.id).view.messages(conversation.id)).rejects.toMatchObject({
				_tag: "ResourceHidden",
			});
		});

		it("gives it back to somebody who rejoins the workspace, without anybody opening it again", async () => {
			const { conversation } = await send(member.id, [colleague.id], "Before you went");
			await leaveWorkspace(colleague.id);
			await onDatabase((db) =>
				db.insert(workspaceMember).values({ workspaceId, userId: colleague.id }),
			);

			await say(colleague.id, conversation.id, "I'm back");

			expect((await as(colleague.id).view.directMessages(workspaceId)).items).toEqual([
				expect.objectContaining({ conversation: expect.objectContaining({ id: conversation.id }) }),
			]);
		});

		it("is in no pod, so the pods its people reach are unchanged", async () => {
			const { conversation } = await send(member.id, [colleague.id], "Hello");

			const pods = await as(member.id).visibility.pods(workspaceId);

			expect(conversation).not.toHaveProperty("podId");
			expect(pods.map((standing) => standing.pod.id)).toEqual([podId]);
		});

		it("refuses a direct message with yourself, or with somebody outside the workspace", async () => {
			await expect(send(member.id, [member.id], "Note to self")).rejects.toMatchObject({
				_tag: "DirectToSelf",
			});
			await expect(send(member.id, [crypto.randomUUID()], "Hello?")).rejects.toMatchObject({
				_tag: "ResourceHidden",
				resource: "member",
			});
			expect((await as(member.id).view.directMessages(workspaceId)).items).toEqual([]);
		});
	});

	describe("in a group", () => {
		it("sends to one for each set of people, whoever writes and in whatever order", async () => {
			const group = await send(member.id, [colleague.id, administrator.id], "Group");
			const same = await send(
				administrator.id,
				[member.id, colleague.id, administrator.id],
				"Same group",
			);
			const pair = await send(member.id, [colleague.id], "Pair");
			const bigger = await send(member.id, [colleague.id, administrator.id, outsider.id], "Bigger");

			expect(same.conversation.id).toBe(group.conversation.id);
			expect(
				new Set([group.conversation.id, pair.conversation.id, bigger.conversation.id]).size,
			).toBe(3);
		});

		it("lists the others in it for each of them, and keeps it from anybody not in it", async () => {
			const { conversation } = await send(
				member.id,
				[colleague.id, administrator.id],
				"Standup moved to 10",
			);

			const { items } = await as(colleague.id).view.directMessages(workspaceId);

			expect(items).toEqual([
				expect.objectContaining({
					conversation: expect.objectContaining({ id: conversation.id }),
					people: expect.arrayContaining([
						expect.objectContaining({ id: member.id }),
						expect.objectContaining({ id: administrator.id }),
					]),
					unreadMessages: 1,
				}),
			]);
			expect(items[0]?.people).toHaveLength(2);
			await expect(as(outsider.id).view.messages(conversation.id)).rejects.toMatchObject({
				_tag: "ResourceHidden",
			});
		});

		it("is still written in by the others while somebody in it has left the workspace", async () => {
			const { conversation } = await send(member.id, [colleague.id, administrator.id], "Hi all");
			await leaveWorkspace(administrator.id);

			await say(colleague.id, conversation.id, "Still here");

			expect((await as(member.id).view.directMessages(workspaceId)).items).toEqual([
				expect.objectContaining({ formerMembers: 1, unreadMessages: 1 }),
			]);
		});

		it("leaves who has left the workspace out of its people, so nobody can mention them", async () => {
			const { conversation } = await send(member.id, [colleague.id, administrator.id], "Hi all");
			await say(colleague.id, conversation.id, "Hello");
			await say(administrator.id, conversation.id, "Before I go");
			await as(administrator.id).chats.markRead(conversation.id);
			await leaveWorkspace(administrator.id);

			const details = await as(member.id).threads.get(conversation.id);

			const stillHere = [member.id, colleague.id].sort();
			expect(details.members.map((person) => person.id).sort()).toEqual(stillHere);
			expect(details.participants.map((person) => person.id).sort()).toEqual(stillHere);
			expect(details.reads.map((read) => read.person.id)).not.toContain(administrator.id);
		});

		it("refuses more people than a direct message may have", async () => {
			await expect(
				send(
					member.id,
					Array.from({ length: MAX_DIRECT_MESSAGE_PEOPLE }, () => crypto.randomUUID()),
					"Everyone",
				),
			).rejects.toMatchObject({ _tag: "TooManyInDirect" });
		});
	});
});
