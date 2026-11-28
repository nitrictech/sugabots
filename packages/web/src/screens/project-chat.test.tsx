import {
	botParticipantOf,
	type ChatDetails,
	type ChatMessageItem,
	type Message,
	type ProjectChat,
	type Run,
} from "@sugabots/contracts";
import { Conflict } from "@sugabots/contracts/http";
import { listedChat, type TestConnector, testMember } from "@sugabots/contracts/testing";
import { userText } from "@sugabots/errors";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
	apiAnswers,
	bots,
	linear,
	mount,
	onWideScreen,
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
};

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
		await screen.findByText(`${other.name} has no model yet.`, {
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

	it("keeps its desktop beneath the settings it opens on a phone, and goes back to it as it was", async () => {
		const { router } = mount(`/suga/projects/${project.slug}/${chatId}?desktop=true`);
		const desktop = await screen.findByRole("region", { name: `${project.name}'s computer` });

		fireEvent.click(await within(desktop).findByRole("link", { name: "Set up computers" }));
		await screen.findByRole("heading", { name: "Computers", level: 2 });
		expect(desktop.isConnected).toBe(true);
		fireEvent.click(screen.getByRole("link", { name: "Back" }));

		await waitFor(() => expect(router.state.location.search).toEqual({ desktop: true }));
		expect(screen.getByRole("region", { name: `${project.name}'s computer` })).toBe(desktop);
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
		await screen.findByText(`${lead.name} has no model yet.`, {
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
	const botFeedPage = `/suga/bots/${linear.handle}/chats/${feedId}`;

	it.each([
		{
			source: `/suga/projects/${project.slug}/automations/${automationId}`,
			owner: "project",
			search: "nestedChatPage",
		},
		{
			source: `/suga/bots/${linear.handle}/automations/${automationId}`,
			owner: "bot",
			search: "nestedChatPage",
		},
		{ source: feedPage, owner: "project", search: "nestedChatPage" },
		{ source: botFeedPage, owner: "bot", search: "nestedChatPage" },
		{ source: `/suga/chats/${feedId}`, owner: "bot", search: "nestedChatPage" },
		{ source: `/suga/activity/pricing/${feedId}`, owner: "project", search: "threadPage" },
		{ source: `/suga/activity/pricing/${runChatId}`, owner: "bot", search: "threadPage" },
	])("opens the run from a legacy link at $source", async ({ source, owner, search }) => {
		const bot = owner === "bot" ? linear : undefined;
		const projectId = bot?.defaultProjectId ?? project.id;
		const botId = bot?.id ?? null;
		const author = bot ? botParticipantOf(bot) : leadParticipant;
		const destination = bot ? botFeedPage : feedPage;
		client.api.chats.projectChats.mockReturnValue(
			Effect.succeed({
				chats: [],
				automations: [
					{
						automation: {
							id: automationId,
							name: run.automationName,
							state: "enabled",
							pausedAfterFailures: false,
						},
						chat: {
							...chat,
							kind: "automation_feed",
							id: feedId,
							projectId,
							botId,
							automationId,
						},
						mentionsYou: false,
						status: { failing: false, latestRun: null },
					},
				],
			}),
		);
		const details = chats[feedId] as ChatDetails;
		client.api.chats.get.mockImplementation(({ params: { chatId } }) =>
			Effect.succeed({
				...details,
				chat: {
					...details.chat,
					projectId,
					botId,
					...(chatId === runChatId && { id: runChatId, kind: "run" }),
				},
				participants: [author],
				projectBots: [author],
				automation: details.automation && { ...details.automation, projectId },
			}),
		);
		serveFeed([{ ...ranResult, author }]);
		const { router } = mount(`${source}?${search}=${runChatId}`);

		await waitFor(() =>
			expect(router.state.location.href).toBe(`${destination}?runChat=${runChatId}`),
		);
		const posted = (await screen.findByText(ranResult.content)).closest("article");
		await waitFor(() => expect(document.activeElement).toBe(posted));
	});

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

	it("opens at the run a link names, loading older runs until it is there, and points it out", async () => {
		serveFeed([earlierRunsResult], [ranResult]);
		mount(`${feedPage}?runChat=${runChatId}`);

		const posted = (await screen.findByText(ranResult.content)).closest("article");
		await waitFor(() => {
			expect(document.activeElement).toBe(posted);
			expect(posted?.classList.contains("bg-chip")).toBe(true);
		});
		expect(screen.queryByRole("heading", { name: run.automationName })).toBeNull();
		await screen.findByLabelText(`Message ${lead.name} about this automation`);
	});

	it("shows the work a run did over its result, as a chat shows a reply's", async () => {
		serveFeed([{ kind: "message", message: ranResult, runReply: ranResultsReply }]);
		mount(feedPage);

		const posted = (await screen.findByText(ranResult.content)).closest("article") as HTMLElement;
		fireEvent.click(within(posted).getByRole("button", { name: "Worked for 2m 0s" }));

		await within(posted).findByText("Checking this week's price list.");
	});

	it("reads the run it opens at once the window has focus", async () => {
		const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
		onTestFinished(() => hasFocus.mockRestore());
		serveFeed([ranResult]);
		mount(`${feedPage}?runChat=${runChatId}`);
		const posted = (await screen.findByText(ranResult.content)).closest("article");
		await waitFor(() => expect(document.activeElement).toBe(posted));
		expect(client.api.chats.markNestedChatRead).not.toHaveBeenCalled();

		hasFocus.mockReturnValue(true);
		fireEvent.focus(window);

		await waitFor(() =>
			expect(client.api.chats.markNestedChatRead).toHaveBeenCalledWith({
				params: { chatId: runChatId },
			}),
		);
	});

	it("does not read a run that is outside the viewport when the window regains focus", async () => {
		const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
		onTestFinished(() => hasFocus.mockRestore());
		serveFeed([ranResult]);
		mount(`${feedPage}?runChat=${runChatId}`);
		const posted = (await screen.findByText(ranResult.content)).closest("article");
		await waitFor(() => expect(document.activeElement).toBe(posted));
		if (!posted) throw new Error("The result is missing its message");
		const bounds = vi
			.spyOn(posted, "getBoundingClientRect")
			.mockReturnValue(new DOMRect(0, -200, 100, 50));
		onTestFinished(() => bounds.mockRestore());

		hasFocus.mockReturnValue(true);
		await act(async () => fireEvent.focus(window));

		expect(client.api.chats.markNestedChatRead).not.toHaveBeenCalled();
	});

	it("marks an older run read after focusing it, without reading the feed on the way there", async () => {
		const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
		onTestFinished(() => hasFocus.mockRestore());
		const focusedWhenRead: (Element | null)[] = [];
		const focusedWhenFeedRead: (Element | null)[] = [];
		client.api.chats.markNestedChatRead.mockImplementation(() => {
			focusedWhenRead.push(document.activeElement);
			return Effect.undefined;
		});
		client.api.chats.markRead.mockImplementation(() => {
			focusedWhenFeedRead.push(document.activeElement);
			return Effect.undefined;
		});
		serveFeed([earlierRunsResult], [ranResult]);
		mount(`${feedPage}?runChat=${runChatId}`);

		const posted = (await screen.findByText(ranResult.content)).closest("article");
		await waitFor(() => expect(client.api.chats.markNestedChatRead).toHaveBeenCalledOnce());
		expect(focusedWhenRead).toEqual([posted]);
		expect(focusedWhenFeedRead.every((focused) => focused === posted)).toBe(true);
	});

	it("leaves the previous run unread when an unfocused window follows a link to a missing run", async () => {
		const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
		onTestFinished(() => hasFocus.mockRestore());
		serveFeed([ranResult]);
		const { router } = mount(`${feedPage}?runChat=${runChatId}`);
		const first = (await screen.findByText(ranResult.content)).closest("article");
		await waitFor(() => expect(document.activeElement).toBe(first));

		const otherRunChatId = earlierRunsResult.automationResultOf?.chatId;
		await act(() => router.history.push(`${feedPage}?runChat=${otherRunChatId}`));
		await screen.findByText("Could not find this run in the feed.");
		hasFocus.mockReturnValue(true);
		await act(async () => fireEvent.focus(window));

		expect(client.api.chats.markNestedChatRead).not.toHaveBeenCalled();
	});

	it("stops loading older pages when a run is beyond the automatic search limit", async () => {
		const newerPages = Array.from({ length: 10 }, (_, page) => [
			{
				...result,
				chatId: feedId,
				id: `0199a3a0-0000-7000-8000-${String(page).padStart(12, "0")}`,
			},
		]);
		serveFeed(...newerPages, [ranResult]);
		mount(`${feedPage}?runChat=${runChatId}`);

		await screen.findByText("Could not find this run in the feed.");
		expect(screen.queryByText(ranResult.content)).toBeNull();
		const loadOlder = screen.getByRole("button", { name: "Load older messages" });
		fireEvent.click(loadOlder);
		await screen.findByText(ranResult.content);
	});

	it("leaves the feed unread if a run link exhausts the search before reaching the run", async () => {
		const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
		onTestFinished(() => hasFocus.mockRestore());
		serveFeed([earlierRunsResult]);
		mount(`${feedPage}?runChat=${runChatId}`);

		await screen.findByText("Could not find this run in the feed.");
		expect(client.api.chats.markRead).not.toHaveBeenCalled();
		expect(client.api.chats.markNestedChatRead).not.toHaveBeenCalled();
	});

	it("opens a run from the project's sidebar in its feed, at the run, marked as the one open", async () => {
		onWideScreen();
		client.api.automations.projectRuns.mockReturnValue(
			Effect.succeed({ items: [run], nextCursor: null }),
		);
		serveFeed([ranResult]);
		const { router } = mount(`/suga/projects/${project.slug}/${chatId}`);

		const runLinkName = new RegExp(run.automationName);
		const unopened = await screen.findByRole("link", { name: runLinkName });
		expect(unopened.classList.contains("bg-row-selected")).toBe(false);
		fireEvent.click(unopened);

		await waitFor(() =>
			expect(router.state.location.href).toBe(`${feedPage}?runChat=${runChatId}`),
		);
		const posted = (await screen.findByText(ranResult.content)).closest("article");
		await waitFor(() => expect(document.activeElement).toBe(posted));
		const opened = screen.getByRole("link", { name: runLinkName });
		expect(opened.getAttribute("aria-current")).toBe("page");
		expect(opened.classList.contains("bg-row-selected")).toBe(true);
	});

	it("sends a failed run in the feed to the project's connectors, not its lead bot's", async () => {
		serveFailedRun();
		mount(`${feedPage}?runChat=${runChatId}`);

		const fix = await screen.findByRole("link", { name: "Fix connector" });
		expect(fix.getAttribute("href")).toBe(`/suga/projects/${project.slug}/connectors`);
	});

	it("offers no Retry on a failed run to a viewer, who may not run it", async () => {
		apiAnswers({ role: "viewer" });
		serveFailedRun();
		mount(feedPage);

		await screen.findByRole("link", { name: "Fix connector" });
		expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
	});

	it("says why a retry of a failed run was refused", async () => {
		serveFailedRun();
		client.api.automations.run.mockReturnValue(
			Effect.fail(new Conflict({ message: userText`The automation is already running.` })),
		);
		mount(feedPage);

		fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

		expect((await screen.findByRole("alert")).textContent).toBe(
			"The automation is already running.",
		);
	});
});

/** The run's result, as its automation's feed shows it. */
const ranResult: Message = {
	...result,
	id: "0199a3a0-0000-7000-8000-0000000003f6",
	chatId: feedId,
	parts: [{ type: "text", text: "Prices are unchanged this week." }],
	content: "Prices are unchanged this week.",
	automationResultOf: {
		runId: run.id,
		chatId: runChatId,
		automationId,
		automationName: run.automationName,
	},
};

/** The reply in the run's own chat that posted `ranResult`, with what it did on the way. */
const ranResultsReply: Message = {
	...ranResult,
	id: "0199a3a0-0000-7000-8000-0000000003fa",
	chatId: runChatId,
	parts: [
		{ type: "text", text: "Checking this week's price list." },
		{
			type: "tool_call",
			id: "0199a3a0-0000-7000-8000-0000000003fb",
			tool: "web_search",
			input: { query: "competitor prices" },
			output: { results: [] },
			status: "completed",
			error: null,
			approval: null,
			atOffset: "Checking this week's price list.".length,
			startedAt: at,
			finishedAt: at,
		},
		{ type: "text", text: "Posted the week's prices." },
	],
	content: "Checking this week's price list.Posted the week's prices.",
	automationResultOf: undefined,
	createdAt: at,
	finishedAt: "2026-09-18T08:02:00.000Z",
};

/** An earlier run's result, newer in the feed than `ranResult` when served after it. */
const earlierRunsResult: Message = {
	...ranResult,
	id: "0199a3a0-0000-7000-8000-0000000003f7",
	parts: [{ type: "text", text: "Two competitors cut their prices." }],
	content: "Two competitors cut their prices.",
	createdAt: "2026-09-25T08:00:00.000Z",
	automationResultOf: {
		runId: "0199a3a0-0000-7000-8000-0000000003f8",
		chatId: "0199a3a0-0000-7000-8000-0000000003f9",
		automationId,
		automationName: run.automationName,
	},
};

/**
 * Serves the feed's items a page at a time, newest first: `pages[0]` first,
 * and each later page when the one before it is loaded past.
 */
function serveFeed(...pages: (ChatMessageItem | Message)[][]) {
	const items = pages.map((page) =>
		page.map(
			(item): ChatMessageItem => ("kind" in item ? item : { kind: "message", message: item }),
		),
	);
	const usual = client.api.chats.messages.getMockImplementation();
	client.api.chats.messages.mockImplementation(
		(request: { params: { chatId: string }; query?: { cursor?: string } }) => {
			if (request.params.chatId !== feedId) return usual?.(request);
			const index = request.query?.cursor ? Number(request.query.cursor) : 0;
			return Effect.succeed({
				items: items[index] ?? [],
				nextCursor: index + 1 < items.length ? String(index + 1) : null,
			});
		},
	);
}

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
	serveFeed([
		{
			kind: "run",
			id: failed.id,
			chatId: failed.chatId,
			automationName: failed.automationName,
			triggerKind: failed.trigger.kind,
			state: failed.state,
			error: failed.error,
			reply: null,
			createdAt: failed.acceptedAt,
		},
	]);
	// Retry and Fix connector are offered while the automation is failing.
	client.api.chats.get.mockImplementation(({ params }: { params: { chatId: string } }) => {
		const details = chats[params.chatId];
		return Effect.succeed(
			params.chatId === feedId && details?.automation
				? { ...details, automation: { ...details.automation, failed: true } }
				: details,
		);
	});
}
