import type { ConversationDetails, Message, ProjectThread, Run } from "@sugabots/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiAnswers, bots, listedThread, mount, projects, sam } from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

/*
 * A project's thread and its automation are the project's, not its lead bot's:
 * what opens from them opens on the project's pages.
 */

const project = projects[1] as (typeof projects)[number];
/** The project's lead bot, which uses no computer of its own. */
const lead = bots.find((bot) => bot.id === project.leadBotId) as (typeof bots)[number];
const leadParticipant = {
	kind: "bot" as const,
	id: lead.id,
	name: lead.name,
	handle: lead.handle,
	color: lead.color,
	face: lead.face,
	shape: lead.shape,
};
const threadId = "0199a3a0-0000-7000-8000-0000000003e1";
const feedId = "0199a3a0-0000-7000-8000-0000000003e2";
const runConversationId = "0199a3a0-0000-7000-8000-0000000003e3";
const automationId = "0199a3a0-0000-7000-8000-0000000003e4";
const at = "2026-09-18T08:00:00.000Z";

const thread: ProjectThread = {
	kind: "project_thread",
	id: threadId,
	workspaceId: project.workspaceId,
	projectId: project.id,
	botId: null,
	title: "Pricing review",
	archivedAt: null,
	doneAt: null,
	createdAt: at,
	updatedAt: at,
};
const run: Run = {
	id: "0199a3a0-0000-7000-8000-0000000003e5",
	automationId,
	workspaceId: project.workspaceId,
	botId: lead.id,
	conversationId: runConversationId,
	rootConversationId: feedId,
	automationName: "Weekly pricing check",
	instructions: "Check competitors' prices.",
	trigger: { kind: "webhook", receivedAt: at, idempotencyKey: null, payload: {} },
	state: "completed",
	error: null,
	posted: true,
	acceptedAt: at,
	startedAt: at,
	finishedAt: at,
};
/** The run's result, posted in the project's thread. */
const result: Message = {
	id: "0199a3a0-0000-7000-8000-0000000003f1",
	conversationId: threadId,
	author: leadParticipant,
	kind: "text",
	status: "complete",
	parts: [{ type: "text", text: "Prices are unchanged." }],
	content: "Prices are unchanged.",
	createdAt: at,
	automationResultOf: {
		runId: run.id,
		conversationId: runConversationId,
		automationId,
		automationName: run.automationName,
	},
};

function details(
	id: string,
	kind: ConversationDetails["conversation"]["kind"],
	more: Partial<ConversationDetails> = {},
): ConversationDetails {
	return {
		conversation: {
			id,
			workspaceId: project.workspaceId,
			projectId: project.id,
			botId: kind === "run" ? lead.id : null,
			rootConversationId: kind === "run" ? feedId : id,
			kind,
			title: kind === "run" ? run.automationName : thread.title,
			status: "done",
			parentConversationId: kind === "run" ? feedId : null,
			startedById: sam.id,
			doneAt: null,
			createdAt: at,
			updatedAt: at,
		},
		automationRun: null,
		participants: [leadParticipant],
		projectBots: [leadParticipant],
		members: [],
		messages: [],
		olderMessagesCursor: null,
		queuedSince: null,
		reads: [],
		...more,
	};
}

const conversations: Record<string, ConversationDetails> = {
	[threadId]: details(threadId, "project_thread", { messages: [result] }),
	[feedId]: details(feedId, "automation_feed", {
		automation: {
			id: automationId,
			projectId: project.id,
			state: "enabled",
			failed: false,
			pausedAfterFailures: false,
		},
	}),
	[runConversationId]: details(runConversationId, "run", { automationRun: run }),
};

/** The automation's own page, among the project's automations. */
const automationPage = `/suga/projects/${project.slug}/automations/${automationId}`;

beforeEach(() => {
	apiAnswers();
	client.api.chats.list.mockReturnValue(Effect.succeed({ chats: [listedThread(thread)] }));
	client.api.conversations.get.mockImplementation(
		({ params }: { params: { conversationId: string } }) =>
			Effect.succeed(conversations[params.conversationId]),
	);
	client.api.chats.messages.mockImplementation(
		({ params }: { params: { conversationId: string } }) =>
			Effect.succeed({
				items: (conversations[params.conversationId]?.messages ?? []).map((message) => ({
					kind: "message" as const,
					message,
				})),
				nextCursor: null,
			}),
	);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("a project's thread", () => {
	it("opens the automation a result came from among the project's automations", async () => {
		const router = mount(`/suga/projects/${project.slug}/${threadId}`);

		fireEvent.click(await screen.findByRole("button", { name: `From ${run.automationName}` }));

		await waitFor(() => expect(router.state.location.pathname).toBe(automationPage));
	});

	it("shows the project's computer, which its lead bot works on whether or not it has one of its own", async () => {
		client.api.computerProviders.access.mockReturnValue(Effect.succeed({ enabled: true }));
		mount(`/suga/projects/${project.slug}/${threadId}`);

		fireEvent.click(await screen.findByRole("button", { name: "Details" }));
		const sidebar = await screen.findByRole("complementary", { name: "Details" });
		expect(await within(sidebar).findByRole("button", { name: "Not running" })).toBeDefined();
	});

	it("titles its computer's desktop with the project", async () => {
		mount(`/suga/projects/${project.slug}/${threadId}?desktop=true`);

		expect(await screen.findByRole("region", { name: `${project.name}'s computer` })).toBeDefined();
	});
});

describe("a project's automation from Inbox", () => {
	it("leads from its feed to the automation among the project's automations", async () => {
		mount(`/suga/inbox/${feedId}`);

		const open = await screen.findByRole("link", { name: "Open feed" });
		expect(open.getAttribute("href")).toBe(automationPage);
	});

	it("leads from a run's page to the automation's settings among the project's", async () => {
		mount(`/suga/inbox/${feedId}?itemPage=${runConversationId}`);

		const settings = await screen.findByRole("link", { name: "Automation settings" });
		expect(settings.getAttribute("href")).toBe(automationPage);
	});
});
