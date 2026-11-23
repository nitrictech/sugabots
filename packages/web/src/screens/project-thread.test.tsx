import {
	botParticipantOf,
	type ConversationDetails,
	type Message,
	type ProjectThread,
	type Run,
} from "@sugabots/contracts";
import { Conflict } from "@sugabots/contracts/http";
import { listedThread, type TestConnection, testPerson } from "@sugabots/contracts/testing";
import { userText } from "@sugabots/errors";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiAnswers,
	bots,
	mount,
	projects,
	sam,
	serveConnections,
	writeDraft,
} from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

/*
 * A project's thread and its automation are the project's, not its lead bot's:
 * what opens from them opens on the project's pages.
 */

const project = projects[1] as (typeof projects)[number];
/** The project's lead bot, which uses no computer of its own. */
const lead = bots.find((bot) => bot.id === project.leadBotId) as (typeof bots)[number];
const leadParticipant = botParticipantOf(lead);
/** Another of the project's bots. */
const other = bots.find((bot) => bot.id !== lead.id) as (typeof bots)[number];
const otherParticipant = botParticipantOf(other);
/** One of the project's people. */
const robin = testPerson({ id: "0199a3a0-0000-7000-8000-0000000003d1", name: "Robin Vale" });
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
/** The lead bot's reply in the project's thread. */
const result: Message = {
	id: "0199a3a0-0000-7000-8000-0000000003f1",
	conversationId: threadId,
	author: leadParticipant,
	kind: "text",
	status: "complete",
	parts: [{ type: "text", text: "Prices are unchanged." }],
	content: "Prices are unchanged.",
	createdAt: at,
};

/**
 * A connection of the project `projectId` named `name`, whose sign-in the
 * server refused: its tokens cleared, so signed out and marked expired.
 */
function expiredConnection(id: string, projectId: string, name: string): TestConnection {
	return {
		id,
		workspaceId: project.workspaceId,
		projectId,
		name,
		handle: name.toLowerCase(),
		url: `https://mcp.${name.toLowerCase()}.example/mcp`,
		kind: "mcp",
		auth: "oauth",
		signedIn: false,
		signInExpired: true,
		secretHeader: null,
		hasSecret: false,
		appSettingsUrl: null,
		status: "connected",
		tools: [],
		lastTestError: null,
		connectedBy: null,
		createdAt: at,
	};
}

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
			// In a project people made, no conversation is with a bot of its own, not even a run.
			botId: null,
			rootConversationId: kind === "run" ? feedId : id,
			kind,
			title: kind === "run" ? run.automationName : thread.title,
			status: "done",
			parentConversationId: kind === "run" ? feedId : null,
			doneAt: null,
			createdAt: at,
			updatedAt: at,
		},
		automationRun: null,
		participants: [leadParticipant],
		projectBots: [leadParticipant, otherParticipant],
		peopleReachingProject: [robin],
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
	client.api.chats.threads.mockReturnValue(
		Effect.succeed({ threads: [listedThread(thread)], automations: [] }),
	);
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
	it("shows the project's computer, which its lead bot works on whether or not it has one of its own", async () => {
		client.api.computerProviders.access.mockReturnValue(Effect.succeed({ enabled: true }));
		mount(`/suga/projects/${project.slug}/${threadId}`);

		fireEvent.click(await screen.findByRole("button", { name: "Details" }));
		const sidebar = await screen.findByRole("complementary", { name: "Details" });
		expect(await within(sidebar).findByRole("button", { name: "Not running" })).toBeDefined();
	});

	it("says who will answer a draft that mentions someone: the bots it mentions, else the lead, which may let one for people pass", async () => {
		mount(`/suga/projects/${project.slug}/${threadId}`);
		const composer = await screen.findByLabelText(`Message ${thread.title}`);
		expect(screen.queryByText(/will reply here/)).toBeNull();

		writeDraft(composer, `@${other.handle} can you check?`);
		expect(await screen.findByText(`${other.name} will reply here.`)).toBeDefined();

		writeDraft(composer, `@${robin.handle} can you check?`);
		expect(await screen.findByText(`${lead.name} may reply.`)).toBeDefined();
	});

	it("promises no reply to a draft for people when the lead has no model to answer with", async () => {
		client.api.bots.list.mockReturnValue(
			Effect.succeed(bots.map((bot) => (bot.id === lead.id ? { ...bot, model: null } : bot))),
		);
		mount(`/suga/projects/${project.slug}/${threadId}`);

		writeDraft(await screen.findByRole("textbox"), `@${robin.handle} can you check?`);

		expect(await screen.findByLabelText(`Message ${robin.name}`)).toBeDefined();
		expect(screen.queryByText(`${lead.name} may reply.`)).toBeNull();
	});

	it("holds a draft for a bot with no model, not one for the lead, which has one", async () => {
		client.api.bots.list.mockReturnValue(
			Effect.succeed(bots.map((bot) => (bot.id === other.id ? { ...bot, model: null } : bot))),
		);
		mount(`/suga/projects/${project.slug}/${threadId}`);
		const composer = await screen.findByRole("textbox");

		writeDraft(composer, `@${other.handle} can you check?`);
		expect(
			await screen.findByText(`${other.name} has no model yet, so it cannot answer.`, {
				exact: false,
			}),
		).toBeDefined();
		const send = screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
		expect(send.disabled).toBe(true);
		expect(screen.queryByText(`${other.name} will reply here.`)).toBeNull();

		writeDraft(composer, "Can you check?");
		await waitFor(() => expect(send.disabled).toBe(false));
		expect(screen.queryByText(/has no model yet/)).toBeNull();
	});

	it("names a bot once when the draft both replies to it and mentions it", async () => {
		mount(`/suga/projects/${project.slug}/${threadId}`);
		const composer = await screen.findByRole("textbox");
		const answer = (await screen.findByText("Prices are unchanged.")).closest("article");
		fireEvent.click(within(answer as HTMLElement).getByRole("button", { name: "Reply" }));

		writeDraft(composer, `@${lead.handle} can you check?`);

		expect(await screen.findByText(`${lead.name} will reply here.`)).toBeDefined();
	});

	it("offers to sign one of the project's connections in again once its sign-in expired", async () => {
		serveConnections(
			expiredConnection("0199a3a0-0000-7000-8000-0000000003f2", project.id, "Linear"),
		);
		mount(`/suga/projects/${project.slug}/${threadId}`);

		expect(
			await screen.findByRole("button", { name: `Sign in to Linear for ${project.name}` }),
		).toBeDefined();
	});

	it("warns that its lead bot can't use one of the bot's own connections once its sign-in expired", async () => {
		serveConnections(
			expiredConnection("0199a3a0-0000-7000-8000-0000000003f3", lead.defaultProjectId, "Sentry"),
		);
		mount(`/suga/projects/${project.slug}/${threadId}`);

		expect(
			await screen.findByText(`${lead.name} can't use Sentry until you sign in again.`),
		).toBeDefined();
	});

	it("says on a phone whose sign-in expired when the project and its lead bot each have a connection of the same name", async () => {
		serveConnections(
			expiredConnection("0199a3a0-0000-7000-8000-0000000003f4", project.id, "Linear"),
			expiredConnection("0199a3a0-0000-7000-8000-0000000003f5", lead.defaultProjectId, "Linear"),
		);
		mount(`/suga/projects/${project.slug}/${threadId}`);

		expect(await screen.findByText(`${project.name}'s Linear sign-in expired.`)).toBeDefined();
		expect(await screen.findByText(`${lead.name}'s Linear sign-in expired.`)).toBeDefined();
		expect(
			screen.getByRole("button", { name: `Sign in to Linear for ${project.name}` }),
		).toBeDefined();
		expect(
			screen.getByRole("button", { name: `Sign in to Linear for ${lead.name}` }),
		).toBeDefined();
	});

	it("warns of a new lead bot's expired connection though the old lead's warning was closed", async () => {
		const newLead = other;
		serveConnections(
			expiredConnection("0199a3a0-0000-7000-8000-0000000003f6", lead.defaultProjectId, "Sentry"),
			expiredConnection("0199a3a0-0000-7000-8000-0000000003f7", newLead.defaultProjectId, "Notion"),
		);
		const { queries } = mount(`/suga/projects/${project.slug}/${threadId}`);
		const warning = await screen.findByText(
			`${lead.name} can't use Sentry until you sign in again.`,
		);
		const strip = warning.closest("p")?.parentElement as HTMLElement;
		fireEvent.click(within(strip).getByRole("button", { name: "Dismiss" }));
		await waitFor(() => expect(screen.queryByText(/can't use Sentry/)).toBeNull());

		client.api.projects.list.mockReturnValue(
			Effect.succeed(
				projects.map((one) => (one.id === project.id ? { ...one, leadBotId: newLead.id } : one)),
			),
		);
		await act(() => queries.invalidateQueries({ queryKey: ["projects"] }));

		expect(
			await screen.findByText(`${newLead.name} can't use Notion until you sign in again.`),
		).toBeDefined();
	});

	it("titles its computer's desktop with the project", async () => {
		mount(`/suga/projects/${project.slug}/${threadId}?desktop=true`);

		expect(await screen.findByRole("region", { name: `${project.name}'s computer` })).toBeDefined();
	});
});

describe("a project's new thread", () => {
	it("starts a thread for a bot with a model, though the lead has none", async () => {
		client.api.bots.list.mockReturnValue(
			Effect.succeed(bots.map((bot) => (bot.id === lead.id ? { ...bot, model: null } : bot))),
		);
		client.api.projects.listBots.mockReturnValue(Effect.succeed([lead, other]));
		mount(`/suga/projects/${project.slug}/new`);
		const composer = await screen.findByLabelText(`Message ${project.name}`);

		writeDraft(composer, "Check the prices");
		expect(
			await screen.findByText(`${lead.name} has no model yet, so it cannot answer.`, {
				exact: false,
			}),
		).toBeDefined();
		const start = screen.getByRole("button", { name: "Start thread" }) as HTMLButtonElement;
		expect(start.disabled).toBe(true);

		writeDraft(composer, `@${other.handle} check the prices`);
		await waitFor(() => expect(screen.queryByText(/has no model yet/)).toBeNull());
		expect(start.disabled).toBe(false);
	});

	it("starts a thread for a person the first message names, though the lead has no model", async () => {
		client.api.bots.list.mockReturnValue(
			Effect.succeed(bots.map((bot) => (bot.id === lead.id ? { ...bot, model: null } : bot))),
		);
		client.api.projects.listBots.mockReturnValue(Effect.succeed([lead, other]));
		client.api.projects.listPeople.mockReturnValue(
			Effect.succeed([testPerson({ id: sam.id, name: sam.name }), robin]),
		);
		mount(`/suga/projects/${project.slug}/new`);
		const composer = await screen.findByLabelText(`Message ${project.name}`);

		writeDraft(composer, `@${robin.handle} can you check the prices?`);

		const start = screen.getByRole("button", { name: "Start thread" }) as HTMLButtonElement;
		await waitFor(() => expect(start.disabled).toBe(false));
		expect(screen.queryByText(/has no model yet/)).toBeNull();
	});

	it("offers @here and @channel in the first message, as in any of the project's threads", async () => {
		client.api.projects.listPeople.mockReturnValue(
			Effect.succeed([testPerson({ id: sam.id, name: sam.name }), robin]),
		);
		mount(`/suga/projects/${project.slug}/new`);
		const composer = await screen.findByLabelText(`Message ${project.name}`);
		await waitFor(() => expect(client.api.projects.listPeople).toHaveBeenCalled());
		writeDraft(composer, "@");

		const list = within(await screen.findByRole("listbox"));
		expect(await list.findByRole("option", { name: new RegExp(robin.name) })).toBeDefined();
		expect(list.queryByRole("option", { name: new RegExp(sam.name) })).toBeNull();
		expect(list.getByRole("option", { name: /@here/ })).toBeDefined();
		expect(list.getByRole("option", { name: /@channel/ })).toBeDefined();
	});
});

describe("a project's automation from Inbox", () => {
	it("shows its feed under the project's automations, run by the project's lead", async () => {
		mount(`/suga/inbox/${feedId}`);

		const automations = await screen.findByRole("link", { name: "Automations" });
		expect(automations.getAttribute("href")).toBe(`/suga/projects/${project.slug}/automations`);
		expect(await screen.findByText(`Runs as ${lead.name}. Each run posts here.`)).toBeDefined();
	});

	it("says only the lead answers in its feed, whichever other bot is mentioned", async () => {
		mount(`/suga/inbox/${feedId}`);
		const composer = await screen.findByLabelText(`Message ${lead.name} about this automation`);

		writeDraft(composer, `@${other.handle} can you check?`);
		expect(await screen.findByText(`${lead.name} will reply here.`)).toBeDefined();
		expect(screen.queryByText(`${other.name} will reply here.`)).toBeNull();

		writeDraft(screen.getByRole("textbox"), `@${robin.handle} can you check?`);
		expect(await screen.findByText(`${lead.name} won't reply.`)).toBeDefined();
	});

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

	it("downloads a file a run's reply attached from the run, where it is kept", async () => {
		const fileId = "0199a3a0-0000-7000-8000-0000000003f2";
		const report: Message = {
			...result,
			id: "0199a3a0-0000-7000-8000-0000000003f3",
			conversationId: runConversationId,
			parts: [
				{ type: "text", text: "Prices are unchanged." },
				{ type: "file", id: fileId, name: "prices.csv", contentType: "text/csv", size: 512 },
			],
		};
		const ranWithReport = details(runConversationId, "run", {
			automationRun: run,
			messages: [report],
		});
		client.api.conversations.get.mockImplementation(
			({ params }: { params: { conversationId: string } }) =>
				Effect.succeed(
					params.conversationId === runConversationId
						? ranWithReport
						: conversations[params.conversationId],
				),
		);
		client.api.chats.messages.mockImplementation(
			({ params }: { params: { conversationId: string } }) =>
				Effect.succeed({
					items: (params.conversationId === runConversationId ? [report] : []).map((message) => ({
						kind: "message" as const,
						message,
					})),
					nextCursor: null,
				}),
		);
		mount(`/suga/inbox/${feedId}?itemPage=${runConversationId}`);

		const download = await screen.findByRole("link", { name: "Download prices.csv" });
		expect(download.getAttribute("href")).toContain(
			`/conversations/${runConversationId}/files/${fileId}`,
		);
	});

	it("sends a failed run's page to the project's connections, not its lead bot's", async () => {
		serveFailedRun();
		mount(`/suga/inbox/${feedId}?itemPage=${runConversationId}`);

		const fix = await screen.findByRole("link", { name: "Fix connection" });
		expect(fix.getAttribute("href")).toBe(`/suga/projects/${project.slug}/connections`);
	});

	it("offers no Retry on a failed run to a viewer, who may not run it", async () => {
		apiAnswers({ role: "viewer" });
		serveFailedRun();
		mount(`/suga/inbox/${feedId}?itemPage=${runConversationId}`);

		expect(await screen.findByRole("link", { name: "Fix connection" })).toBeDefined();
		expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
	});

	it("says why a retry of a failed run was refused", async () => {
		serveFailedRun();
		client.api.automations.run.mockReturnValue(
			Effect.fail(new Conflict({ message: userText`The automation is already running.` })),
		);
		mount(`/suga/inbox/${feedId}?itemPage=${runConversationId}`);

		fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

		expect((await screen.findByRole("alert")).textContent).toBe(
			"The automation is already running.",
		);
	});
});

/**
 * Serves the run as one that failed, the automation's latest, where Retry and
 * Fix connection are offered.
 */
function serveFailedRun() {
	const failed: Run = {
		...run,
		state: "failed",
		error: "The connection refused the request.",
		posted: false,
	};
	client.api.automations.projectRuns.mockReturnValue(
		Effect.succeed({ items: [failed], nextCursor: null }),
	);
	// Fix connection is offered on the automation's latest run only.
	client.api.automations.list.mockReturnValue(
		Effect.succeed([
			{
				id: automationId,
				workspaceId: project.workspaceId,
				projectId: project.id,
				name: run.automationName,
				instructions: run.instructions,
				triggers: [],
				state: "enabled",
				pausedAfterFailures: false,
				createdById: sam.id,
				createdAt: at,
				updatedAt: at,
				status: {
					failing: true,
					latestRun: {
						id: failed.id,
						state: failed.state,
						posted: failed.posted,
						acceptedAt: failed.acceptedAt,
						error: failed.error,
					},
				},
			},
		]),
	);
	client.api.conversations.get.mockImplementation(
		({ params }: { params: { conversationId: string } }) =>
			Effect.succeed(
				params.conversationId === runConversationId
					? details(runConversationId, "run", { automationRun: failed })
					: conversations[params.conversationId],
			),
	);
}
