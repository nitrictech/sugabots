import { handleFromName } from "@sugabots/contracts";
import type { Tool } from "ai";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
	agent,
	message,
	pod,
	thread,
	user,
	workspace,
	workspaceMember,
} from "../../../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../../../database/testing.ts";
import {
	LIST_THREADS_TOOL,
	type ListThreadsResult,
	podThreadTools,
	READ_THREAD_TOOL,
	type ReadThreadResult,
} from "./tool.ts";

describe.skipIf(!process.env.DATABASE_URL)("list_threads and read_thread, against Postgres", () => {
	let suffix: string;
	let workspaceId: string;
	let podId: string;
	let personId: string;
	let botId: string;
	let ownThreadId: string;

	afterAll(async () => {
		await closeDatabase();
	});

	async function call<Result>(key: string, input: Record<string, unknown>): Promise<Result> {
		const tools: Record<string, Tool> = podThreadTools({
			podId,
			threadId: ownThreadId,
			run: runOnPostgres,
		});
		const result = await tools[key]?.execute?.(input, {
			toolCallId: "call",
			messages: [],
			context: {},
		});
		return result as Result;
	}

	const listThreads = (input: { title?: string } = {}) =>
		call<ListThreadsResult>(LIST_THREADS_TOOL, input);
	const readThread = (input: { thread: string; query?: string; continueFrom?: string }) =>
		call<ReadThreadResult>(READ_THREAD_TOOL, input);

	async function createPod(name: string) {
		const [created] = await onDatabase((db) =>
			db
				.insert(pod)
				.values({
					workspaceId,
					ownerId: personId,
					kind: "shared",
					name,
					slug: `${name.toLowerCase().replaceAll(" ", "-")}-${suffix}`,
					createdById: personId,
				})
				.returning(),
		);
		if (!created) throw new Error("Could not create a pod");
		return created.id;
	}

	async function createThread(values: Partial<typeof thread.$inferInsert> & { title: string }) {
		const [created] = await onDatabase((db) =>
			db
				.insert(thread)
				.values({ workspaceId, podId, type: "conversation", hostAgentId: botId, ...values })
				.returning(),
		);
		if (!created) throw new Error("Could not create a thread");
		return created.id;
	}

	const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

	/** Messages from the person, a minute apart, ending `endingMinutesAgo` minutes ago. */
	async function post(threadId: string, texts: string[], endingMinutesAgo = 0) {
		const now = Date.now();
		await onDatabase((db) =>
			db.insert(message).values(
				texts.map((text, index) => ({
					threadId,
					authorUserId: personId,
					kind: "text" as const,
					status: "complete" as const,
					parts: [{ type: "text" as const, text }],
					content: text,
					createdAt: new Date(now - (endingMinutesAgo + texts.length - index) * 60_000),
				})),
			),
		);
	}

	beforeEach(async () => {
		suffix = crypto.randomUUID().slice(0, 8);
		const [space] = await onDatabase((db) =>
			db
				.insert(workspace)
				.values({ name: "Threads workspace", slug: `threads-${suffix}` })
				.returning(),
		);
		if (!space) throw new Error("Could not create a workspace");
		workspaceId = space.id;
		const [person] = await onDatabase((db) =>
			db
				.insert(user)
				.values({ name: `Sam ${suffix}`, email: `sam-${suffix}@example.com` })
				.returning(),
		);
		if (!person) throw new Error("Could not create a person");
		personId = person.id;
		await onDatabase((db) =>
			db.insert(workspaceMember).values({ workspaceId, userId: personId, role: "owner" }),
		);
		podId = await createPod("Threads pod");
		const [bot] = await onDatabase((db) =>
			db
				.insert(agent)
				.values({
					workspaceId,
					podId,
					name: "Helper",
					handle: handleFromName(`Helper ${suffix}`),
					color: "green",
					face: "pill",
					model: "test/model",
					createdById: personId,
				})
				.returning(),
		);
		if (!bot) throw new Error("Could not create an agent");
		botId = bot.id;
		ownThreadId = await createThread({ title: "Where the bot is" });
	});

	it("lists the pod's other threads people open, most recently active first", async () => {
		const launch = await createThread({ title: "Plan for the launch", updatedAt: minutesAgo(10) });
		const chat = await createThread({
			type: "pod_chat",
			hostAgentId: null,
			title: "Threads pod",
			updatedAt: minutesAgo(1),
		});
		const channel = await createThread({
			type: "bot_channel",
			title: "Helper",
			updatedAt: minutesAgo(5),
		});
		const done = await createThread({
			title: "Old budget",
			doneAt: new Date(),
			updatedAt: minutesAgo(60),
		});
		await createThread({ type: "collaboration", title: "Hidden collaboration" });
		await createThread({
			type: "pod_chat",
			hostAgentId: null,
			title: "Archived chat",
			archivedAt: new Date(),
		});
		const elsewhere = await createPod("Other pod");
		await createThread({ podId: elsewhere, hostAgentId: null, title: "Another pod's thread" });

		const listed = await listThreads();

		expect(listed).toEqual({
			threads: [
				expect.objectContaining({ id: chat, kind: "pod chat", title: "Threads pod", done: false }),
				expect.objectContaining({ id: channel, kind: "channel", bot: "Helper" }),
				expect.objectContaining({ id: launch, kind: "thread", bot: "Helper", done: false }),
				expect.objectContaining({ id: done, title: "Old budget", done: true }),
			],
			more: false,
		});
		expect(await listThreads({ title: "launch plan" })).toEqual({
			threads: [expect.objectContaining({ id: launch })],
			more: false,
		});
	});

	it("reads a thread's newest messages oldest first, then reads back from where it stopped", async () => {
		const long = await createThread({ title: "Long thread" });
		const texts = Array.from({ length: 25 }, (_, index) => `Message ${index + 1}`);
		await post(long, texts);

		const newest = await readThread({ thread: long });
		if (!("messages" in newest)) throw new Error(newest.refused);
		expect(newest.thread).toEqual({ id: long, title: "Long thread" });
		expect(newest.messages.map((found) => found.text)).toEqual(texts.slice(5));
		expect(newest.messages[0]?.author).toBe(`Sam ${suffix}`);
		if (!newest.continueFrom) throw new Error("Expected more to read");

		const earlier = await readThread({ thread: long, continueFrom: newest.continueFrom });
		if (!("messages" in earlier)) throw new Error(earlier.refused);
		expect(earlier.messages.map((found) => found.text)).toEqual(texts.slice(0, 5));
		expect(earlier.continueFrom).toBeUndefined();
	});

	it("finds messages in a thread by their words", async () => {
		const trip = await createThread({ title: "Trip" });
		await post(trip, ["The hotels are booked", "Flights next week", "Dinner on Friday"]);

		const found = await readThread({ thread: trip, query: "hotel" });

		expect(found).toEqual({
			thread: { id: trip, title: "Trip" },
			messages: [expect.objectContaining({ text: "The hotels are booked" })],
			more: false,
		});
	});

	it("gives a thread started from a pod chat message with the message it answers", async () => {
		const chat = await createThread({ type: "pod_chat", hostAgentId: null, title: "Threads pod" });
		await post(chat, ["Can we move the launch to May?"], 5);
		const [question] = await onDatabase((db) =>
			db.select({ id: message.id }).from(message).where(eq(message.threadId, chat)),
		);
		const replies = await createThread({
			hostAgentId: null,
			title: "Launch date",
			originMessageId: question?.id ?? null,
		});
		await post(replies, ["Agreed"]);

		expect(await readThread({ thread: replies })).toEqual({
			thread: { id: replies, title: "Launch date" },
			startedFrom: expect.objectContaining({ text: "Can we move the launch to May?" }),
			messages: [expect.objectContaining({ text: "Agreed" })],
		});
	});

	it("refuses a thread outside the pod, its own thread, and a hidden one", async () => {
		const elsewhere = await createPod("Other pod");
		const outside = await createThread({ podId: elsewhere, hostAgentId: null, title: "Outside" });
		const hidden = await createThread({ type: "collaboration", title: "Hidden" });

		for (const id of [outside, ownThreadId, hidden, "not-an-id"]) {
			expect(await readThread({ thread: id })).toEqual({
				refused: expect.stringContaining("no other thread in this pod"),
			});
		}
	});
});
