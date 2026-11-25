import {
	botParticipantOf,
	type ChatDetails,
	type Message,
	type ProjectChat,
	type Run,
} from "@sugabots/contracts";
import { Conflict } from "@sugabots/contracts/http";
import { listedChat, type TestConnector, testMember } from "@sugabots/contracts/testing";
import { userText } from "@sugabots/errors";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiAnswers,
	bots,
	mount,
	projects,
	sam,
	serveConnectors,
	writeDraft,
} from "@/api.test-support.tsx";
import { client } from "@/client.test-support.ts";

import { chatDetailsFixture, robin } from "./chat-fixtures.test-support.ts";

vi.mock("@/api.ts", () => import("@/client.test-support.ts"));

/*
 * A project's chat and its automation are the project's, not its lead bot's:
 * what opens from them opens on the project's pages.
 */

const project = projects[1] as (typeof projects)[number];
/** The project's lead bot, which uses no computer of its own. */
const lead = bots.find((bot) => bot.id === project.leadBotId) as (typeof bots)[number];
const leadParticipant = botParticipantOf(lead);
/** Another of the project's bots. */
const other = bots.find((bot) => bot.id !== lead.id) as (typeof bots)[number];
const otherParticipant = botParticipantOf(other);
const chatId = "0199a3a0-0000-7000-8000-0000000003e1";
const feedId = "0199a3a0-0000-7000-8000-0000000003e2";
const runChatId = "0199a3a0-0000-7000-8000-0000000003e3";
const automationId = "0199a3a0-0000-7000-8000-0000000003e4";
const at = "2026-09-18T08:00:00.000Z";

const chat: ProjectChat = {
	kind: "project_chat",
	id: chatId,
	workspaceId: project.workspaceId,
	projectId: project.id,
	botId: null,
	title: "Pricing review",
	resolvedAt: null,
	createdAt: at,
	updatedAt: at,
};
const run: Run = {
	id: "0199a3a0-0000-7000-8000-0000000003e5",
	automationId,
	workspaceId: project.workspaceId,
	botId: lead.id,
	chatId: runChatId,
	rootChatId: feedId,
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
/** The lead bot's reply in the project's chat. */
const result: Message = {
	id: "0199a3a0-0000-7000-8000-0000000003f1",
	chatId,
	author: leadParticipant,
	status: "complete",
	parts: [{ type: "text", text: "Prices are unchanged." }],
	content: "Prices are unchanged.",
	createdAt: at,
};

/**
 * A connector of the project `projectId` named `name`, whose sign-in the
 * server refused: its tokens cleared, so signed out and marked expired.
 */
function expiredConnector(id: string, projectId: string, name: string): TestConnector {
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
		signedInAs: null,
		createdAt: at,
	};
}

const projectChatDetails = chatDetailsFixture(chat, {
	participants: [leadParticipant],
	projectBots: [leadParticipant, otherParticipant],
	membersReachingProject: [robin],
});
const runDetails = projectChatDetails({
	chat: { id: runChatId, rootChatId: feedId, title: run.automationName, kind: "run" },
	automationRun: run,
});

const chats: Record<string, ChatDetails> = {
	[chatId]: projectChatDetails({ messages: [result] }),
	[feedId]: projectChatDetails({
		chat: { id: feedId, rootChatId: feedId, kind: "automation_feed" },
		automation: {
			id: automationId,
			projectId: project.id,
			state: "enabled",
			failed: false,
			pausedAfterFailures: false,
		},
	}),
	[runChatId]: runDetails,
};

/** The automation's own page, among the project's automations. */
const automationPage = `/suga/projects/${project.slug}/automations/${automationId}`;

beforeEach(() => {
	apiAnswers();
	client.api.chats.projectChats.mockReturnValue(
		Effect.succeed({ chats: [listedChat(chat)], automations: [] }),
	);
	client.api.chats.get.mockImplementation(({ params }: { params: { chatId: string } }) =>
		Effect.succeed(chats[params.chatId]),
	);
	client.api.chats.messages.mockImplementation(({ params }: { params: { chatId: string } }) =>
		Effect.succeed({
			items: (chats[params.chatId]?.messages ?? []).map((message) => ({
				kind: "message" as const,
				message,
			})),
			nextCursor: null,
		}),
	);
});

describe("a project's chat", () => {
	it("shows the project's computer, which its lead bot works on whether or not it has one of its own", async () => {
		client.api.computerProviders.access.mockReturnValue(Effect.succeed({ enabled: true }));
		mount(`/suga/projects/${project.slug}/${chatId}`);

		fireEvent.click(await screen.findByRole("button", { name: "Details" }));
		const sidebar = await screen.findByRole("complementary", { name: "Details" });
		await within(sidebar).findByRole("button", { name: "Not running" });
	});

	it("says who will answer a draft that mentions someone: the bots it mentions, else the lead, which may let one for members pass", async () => {
		mount(`/suga/projects/${project.slug}/${chatId}`);
		const composer = await screen.findByLabelText(`Message ${chat.title}`);
		expect(screen.queryByText(/will reply here/)).toBeNull();

		writeDraft(composer, `@${other.handle} can you check?`);
		await screen.findByText(`${other.name} will reply here.`);

		writeDraft(composer, `@${robin.handle} can you check?`);
		await screen.findByText(`${lead.name} may reply.`);
	});

	it("promises no reply to a draft for members when the lead has no model to answer with", async () => {
		client.api.bots.list.mockReturnValue(
			Effect.succeed(bots.map((bot) => (bot.id === lead.id ? { ...bot, model: null } : bot))),
		);
		mount(`/suga/projects/${project.slug}/${chatId}`);

		writeDraft(await screen.findByRole("textbox"), `@${robin.handle} can you check?`);

		await screen.findByLabelText(`Message ${robin.name}`);
		expect(screen.queryByText(`${lead.name} may reply.`)).toBeNull();
	});

	it("holds a draft for a bot with no model, not one for the lead, which has one", async () => {
		client.api.bots.list.mockReturnValue(
			Effect.succeed(bots.map((bot) => (bot.id === other.id ? { ...bot, model: null } : bot))),
		);
		mount(`/suga/projects/${project.slug}/${chatId}`);
		const composer = await screen.findByRole("textbox");

		writeDraft(composer, `@${other.handle} can you check?`);
		await screen.findByText(`${other.name} has no model yet, so it cannot answer.`, {
			exact: false,
		});
		const send = screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
		expect(send.disabled).toBe(true);
		expect(screen.queryByText(`${other.name} will reply here.`)).toBeNull();

		writeDraft(composer, "Can you check?");
		await waitFor(() => expect(send.disabled).toBe(false));
		expect(screen.queryByText(/has no model yet/)).toBeNull();
	});

	it("names a bot once when the draft both replies to it and mentions it", async () => {
		mount(`/suga/projects/${project.slug}/${chatId}`);
		const composer = await screen.findByRole("textbox");
		const answer = (await screen.findByText("Prices are unchanged.")).closest("article");
		fireEvent.click(within(answer as HTMLElement).getByRole("button", { name: "Reply" }));

		writeDraft(composer, `@${lead.handle} can you check?`);

		await screen.findByText(`${lead.name} will reply here.`);
	});

	it("offers to sign one of the project's connectors in again once its sign-in expired", async () => {
		serveConnectors(expiredConnector("0199a3a0-0000-7000-8000-0000000003f2", project.id, "Linear"));
		mount(`/suga/projects/${project.slug}/${chatId}`);

		await screen.findByRole("button", { name: `Sign in to Linear for ${project.name}` });
	});

	it("warns that its lead bot can't use one of the bot's own connectors once its sign-in expired", async () => {
		serveConnectors(
			expiredConnector("0199a3a0-0000-7000-8000-0000000003f3", lead.defaultProjectId, "Sentry"),
		);
		mount(`/suga/projects/${project.slug}/${chatId}`);

		await screen.findByText(`${lead.name} can't use Sentry until you sign in again.`);
	});

	it("says on a phone whose sign-in expired when the project and its lead bot each have a connector of the same name", async () => {
		serveConnectors(
			expiredConnector("0199a3a0-0000-7000-8000-0000000003f4", project.id, "Linear"),
			expiredConnector("0199a3a0-0000-7000-8000-0000000003f5", lead.defaultProjectId, "Linear"),
		);
		mount(`/suga/projects/${project.slug}/${chatId}`);

		await screen.findByText(`${project.name}'s Linear sign-in expired.`);
		await screen.findByText(`${lead.name}'s Linear sign-in expired.`);
		screen.getByRole("button", { name: `Sign in to Linear for ${project.name}` });
		screen.getByRole("button", { name: `Sign in to Linear for ${lead.name}` });
	});

	it("warns of a new lead bot's expired connector though the old lead's warning was closed", async () => {
		const newLead = other;
		serveConnectors(
			expiredConnector("0199a3a0-0000-7000-8000-0000000003f6", lead.defaultProjectId, "Sentry"),
			expiredConnector("0199a3a0-0000-7000-8000-0000000003f7", newLead.defaultProjectId, "Notion"),
		);
		const { queries } = mount(`/suga/projects/${project.slug}/${chatId}`);
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

		await screen.findByText(`${newLead.name} can't use Notion until you sign in again.`);
	});

	it("titles its computer's desktop with the project", async () => {
		mount(`/suga/projects/${project.slug}/${chatId}?desktop=true`);

		await screen.findByRole("region", { name: `${project.name}'s computer` });
	});
});

describe("a project's new chat", () => {
	it("starts a chat for a bot with a model, though the lead has none", async () => {
		client.api.bots.list.mockReturnValue(
			Effect.succeed(bots.map((bot) => (bot.id === lead.id ? { ...bot, model: null } : bot))),
		);
		client.api.projects.listBots.mockReturnValue(Effect.succeed([lead, other]));
		mount(`/suga/projects/${project.slug}/new`);
		const composer = await screen.findByLabelText(`Message ${project.name}`);

		writeDraft(composer, "Check the prices");
		await screen.findByText(`${lead.name} has no model yet, so it cannot answer.`, {
			exact: false,
		});
		const start = screen.getByRole("button", { name: "Start chat" }) as HTMLButtonElement;
		expect(start.disabled).toBe(true);

		writeDraft(composer, `@${other.handle} check the prices`);
		await waitFor(() => expect(screen.queryByText(/has no model yet/)).toBeNull());
		expect(start.disabled).toBe(false);
	});

	it("starts a chat for a member the first message names, though the lead has no model", async () => {
		client.api.bots.list.mockReturnValue(
			Effect.succeed(bots.map((bot) => (bot.id === lead.id ? { ...bot, model: null } : bot))),
		);
		client.api.projects.listBots.mockReturnValue(Effect.succeed([lead, other]));
		client.api.projects.listMembersReaching.mockReturnValue(
			Effect.succeed([testMember({ id: sam.id, name: sam.name }), robin]),
		);
		mount(`/suga/projects/${project.slug}/new`);
		const composer = await screen.findByLabelText(`Message ${project.name}`);

		writeDraft(composer, `@${robin.handle} can you check the prices?`);

		const start = screen.getByRole("button", { name: "Start chat" }) as HTMLButtonElement;
		await waitFor(() => expect(start.disabled).toBe(false));
		expect(screen.queryByText(/has no model yet/)).toBeNull();
	});

	it("offers @here and @channel in the first message, as in any of the project's chats", async () => {
		client.api.projects.listMembersReaching.mockReturnValue(
			Effect.succeed([testMember({ id: sam.id, name: sam.name }), robin]),
		);
		mount(`/suga/projects/${project.slug}/new`);
		const composer = await screen.findByLabelText(`Message ${project.name}`);
		await waitFor(() => expect(client.api.projects.listMembersReaching).toHaveBeenCalled());
		writeDraft(composer, "@");

		const list = within(await screen.findByRole("listbox"));
		await list.findByRole("option", { name: new RegExp(robin.name) });
		expect(list.queryByRole("option", { name: new RegExp(sam.name) })).toBeNull();
		list.getByRole("option", { name: /@here/ });
		list.getByRole("option", { name: /@channel/ });
	});
});

describe("a project's automation feed, at its own address", () => {
	const feedPage = `/suga/projects/${project.slug}/${feedId}`;

	it("shows its feed under the project's automations, run by the project's lead", async () => {
		mount(feedPage);

		const automations = await screen.findByRole("link", { name: "Automations" });
		expect(automations.getAttribute("href")).toBe(`/suga/projects/${project.slug}/automations`);
		await screen.findByText(`Runs as ${lead.name}. Each run posts here.`);
	});

	it("says only the lead answers in its feed, whichever other bot is mentioned", async () => {
		mount(feedPage);
		const composer = await screen.findByLabelText(`Message ${lead.name} about this automation`);

		writeDraft(composer, `@${other.handle} can you check?`);
		await screen.findByText(`${lead.name} will reply here.`);
		expect(screen.queryByText(`${other.name} will reply here.`)).toBeNull();

		writeDraft(screen.getByRole("textbox"), `@${robin.handle} can you check?`);
		await screen.findByText(`${lead.name} won't reply.`);
	});

	it("leads from a run's page to the automation's settings among the project's", async () => {
		mount(`${feedPage}?nestedChatPage=${runChatId}`);

		const settings = await screen.findByRole("link", { name: "Automation settings" });
		expect(settings.getAttribute("href")).toBe(automationPage);
	});

	it("downloads a file a run's reply attached from the run, where it is kept", async () => {
		const fileId = "0199a3a0-0000-7000-8000-0000000003f2";
		const report: Message = {
			...result,
			id: "0199a3a0-0000-7000-8000-0000000003f3",
			chatId: runChatId,
			parts: [
				{ type: "text", text: "Prices are unchanged." },
				{ type: "file", id: fileId, name: "prices.csv", contentType: "text/csv", size: 512 },
			],
		};
		const ranWithReport: ChatDetails = {
			...runDetails,
			messages: [report],
		};
		client.api.chats.get.mockImplementation(({ params }: { params: { chatId: string } }) =>
			Effect.succeed(params.chatId === runChatId ? ranWithReport : chats[params.chatId]),
		);
		client.api.chats.messages.mockImplementation(({ params }: { params: { chatId: string } }) =>
			Effect.succeed({
				items: (params.chatId === runChatId ? [report] : []).map((message) => ({
					kind: "message" as const,
					message,
				})),
				nextCursor: null,
			}),
		);
		mount(`${feedPage}?nestedChatPage=${runChatId}`);

		const download = await screen.findByRole("link", { name: "Download prices.csv" });
		expect(download.getAttribute("href")).toContain(`/chats/${runChatId}/files/${fileId}`);
	});

	it("sends a failed run's page to the project's connectors, not its lead bot's", async () => {
		serveFailedRun();
		mount(`${feedPage}?nestedChatPage=${runChatId}`);

		const fix = await screen.findByRole("link", { name: "Fix connector" });
		expect(fix.getAttribute("href")).toBe(`/suga/projects/${project.slug}/connectors`);
	});

	it("offers no Retry on a failed run to a viewer, who may not run it", async () => {
		apiAnswers({ role: "viewer" });
		serveFailedRun();
		mount(`${feedPage}?nestedChatPage=${runChatId}`);

		await screen.findByRole("link", { name: "Fix connector" });
		expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
	});

	it("says why a retry of a failed run was refused", async () => {
		serveFailedRun();
		client.api.automations.run.mockReturnValue(
			Effect.fail(new Conflict({ message: userText`The automation is already running.` })),
		);
		mount(`${feedPage}?nestedChatPage=${runChatId}`);

		fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

		expect((await screen.findByRole("alert")).textContent).toBe(
			"The automation is already running.",
		);
	});
});

/**
 * Serves the run as one that failed, the automation's latest, where Retry and
 * Fix connector are offered.
 */
function serveFailedRun() {
	const failed: Run = {
		...run,
		state: "failed",
		error: "The connector refused the request.",
		posted: false,
	};
	client.api.automations.projectRuns.mockReturnValue(
		Effect.succeed({ items: [failed], nextCursor: null }),
	);
	// Fix connector is offered on the automation's latest run only.
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
	client.api.chats.get.mockImplementation(({ params }: { params: { chatId: string } }) =>
		Effect.succeed(
			params.chatId === runChatId ? { ...runDetails, automationRun: failed } : chats[params.chatId],
		),
	);
}
