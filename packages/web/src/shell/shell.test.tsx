import {
	type ApprovalRequest,
	type ModelProvider,
	type ProviderModel,
	type Run,
	type SignedInPerson,
	streamEvent,
} from "@sugabots/contracts";
import { Conflict, Forbidden, InternalServerError } from "@sugabots/contracts/http";
import { listedChat } from "@sugabots/contracts/testing";
import { UserText, userText } from "@sugabots/errors";
import { failureForStatus } from "@sugabots/sdk";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createQueryClient } from "@/lib/query.ts";
import { chooseWorkspace, workspacesQuery } from "@/lib/workspace.ts";
import { createAppRouter } from "@/router.tsx";
import {
	apiAnswers,
	bots,
	chatWith,
	compaction,
	controlledEventStream,
	juno,
	linear,
	MODELS,
	modelProviders,
	mount,
	onWideScreen,
	open,
	pendingAnswer,
	personalAssistant,
	projects,
	sam,
	systemBots,
	TestApp,
	triager,
	workspace,
	writeDraft,
} from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const linearPage = `/suga/bots/${linear.handle}`;

beforeEach(() => {
	apiAnswers();
	document.documentElement.removeAttribute("data-theme");
	localStorage.clear();
	chooseWorkspace(workspace.id);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

/** Opens the workspace's menu from yours, at the foot of the sidebar. */
async function openWorkspaceMenu() {
	const sidebar = await screen.findByRole("navigation", { name: "Sidebar" });
	fireEvent.click(await within(sidebar).findByRole("button", { name: /^Account:/ }));
	fireEvent.click(await screen.findByRole("menuitem", { name: workspace.name }));
}

describe("the shell", () => {
	it("ignores a panel name it does not know rather than failing the route", async () => {
		// `bot` and `history` were panels until the design made a bot a page
		// of its own and the chats list the history. A link from then lands in
		// the app rather than in an error.
		mount(`${linearPage}?panel=bot`);

		expect(await screen.findByRole("main")).toBeDefined();
		expect(screen.queryByRole("complementary", { name: "Panel" })).toBeNull();
	});
});

describe("the workspace choice", () => {
	const other = {
		id: "0199a3a0-0000-7000-8000-0000000000f9",
		name: "Nitric",
		slug: "nitric",
		timeZone: "UTC",
		setUpAt: "2026-09-01T00:00:00.000Z",
	};

	it("keeps a workspace choice in memory when storage is unavailable", async () => {
		client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, other]));
		const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
			throw new Error("Storage disabled");
		});
		const { router } = mount(linearPage);
		await screen.findByRole("navigation", { name: "Sidebar" });

		chooseWorkspace(other.id);
		await router.navigate({ to: "/" });

		await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/nitric(\/|$)/));
		setItem.mockRestore();
	});

	it("follows workspace choices made in another tab", async () => {
		client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, other]));
		const { router } = mount(linearPage);
		await screen.findByRole("navigation", { name: "Sidebar" });
		localStorage.setItem("sugabots-workspace", other.id);

		window.dispatchEvent(
			new StorageEvent("storage", { key: "sugabots-workspace", newValue: other.id }),
		);
		await router.navigate({ to: "/" });

		await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/nitric(\/|$)/));
	});

	it("switches to another workspace from your menu and opens it next time", async () => {
		client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, other]));
		const { router } = mount(linearPage);

		await openWorkspaceMenu();
		fireEvent.click(await screen.findByRole("menuitem", { name: other.name }));

		await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/nitric(\/|$)/));
		expect(localStorage.getItem("sugabots-workspace")).toBe(other.id);
	});

	it("sets up a new workspace from your menu with the first run's steps", async () => {
		client.api.workspaces.create.mockImplementation(() => {
			client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, other]));
			return Effect.succeed(other);
		});
		const { router } = mount(linearPage);

		const name = await startNewWorkspace(router);
		expect((name as HTMLInputElement).value).toBe("");
		fireEvent.change(name, { target: { value: " Nitric " } });
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));

		expect(await screen.findByRole("heading", { name: "Connect a provider" })).toBeDefined();
		expect(client.api.workspaces.create).toHaveBeenCalledWith({
			payload: expect.objectContaining({ name: "Nitric", slug: "nitric" }),
		});
		expect(localStorage.getItem("sugabots-workspace")).toBe(other.id);
		expect(router.state.location.search).toEqual({ workspace: "nitric" });
	});

	it("keeps somebody with no workspace out of the shell, setting one up with nowhere to cancel to", async () => {
		client.api.workspaces.list.mockReturnValue(Effect.succeed([]));
		client.api.workspaces.create.mockImplementation(() => {
			client.api.workspaces.list.mockReturnValue(Effect.succeed([other]));
			return Effect.succeed(other);
		});
		const { router } = mount(linearPage);

		const name = await screen.findByLabelText("Workspace name");
		await waitFor(() => expect(router.state.location.pathname).toBe("/workspace-setup"));
		expect(screen.queryByRole("navigation", { name: "Workspace" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
		fireEvent.change(name, { target: { value: "Nitric" } });
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));

		expect(await screen.findByRole("heading", { name: "Connect a provider" })).toBeDefined();
		expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
	});

	it("takes somebody who may finish an unfinished workspace's setup back into it", async () => {
		client.api.workspaces.list.mockReturnValue(Effect.succeed([{ ...workspace, setUpAt: null }]));
		client.api.projects.list.mockReturnValue(Effect.succeed([]));
		client.api.bots.list.mockReturnValue(
			Effect.succeed([{ ...personalAssistant, model: "switched-off" }]),
		);
		const { router } = mount("/");

		expect(await screen.findByRole("heading", { name: "Connect a provider" })).toBeDefined();
		expect(router.state.location.pathname).toBe("/workspace-setup");
		expect(router.state.location.search).toEqual({ workspace: workspace.slug });
	});

	it("finishes an unfinished workspace's setup into its chat, not back into setup", async () => {
		client.api.workspaces.list.mockReturnValue(Effect.succeed([{ ...workspace, setUpAt: null }]));
		client.api.projects.list.mockReturnValue(Effect.succeed([]));
		client.api.bots.list.mockReturnValue(Effect.succeed([personalAssistant]));
		const made = firstBotMade("Chief");
		client.api.workspaceSetup.complete.mockImplementation(() => {
			client.api.workspaces.list.mockReturnValue(
				Effect.succeed([{ ...workspace, setUpAt: "2026-10-09T00:00:00.000Z" }]),
			);
			return Effect.void;
		});
		const { router } = mount("/");

		fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Chief" } });
		fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
		fireEvent.click(await screen.findByRole("button", { name: "Skip for now" }));
		fireEvent.click(await screen.findByRole("button", { name: "Start talking" }));

		expect(await screen.findByRole("navigation", { name: "Sidebar" })).toBeDefined();
		expect(router.state.location.pathname.startsWith(`/suga/bots/${made.handle}`)).toBe(true);
	});

	it("says so, rather than opening an unfinished workspace, when it cannot tell who may finish it", async () => {
		client.api.workspaces.list.mockReturnValue(Effect.succeed([{ ...workspace, setUpAt: null }]));
		client.api.workspaceAccess.mockReturnValueOnce(
			Effect.fail(new Forbidden({ message: userText`Unavailable` })),
		);
		client.api.projects.list.mockReturnValue(Effect.succeed([]));
		client.api.bots.list.mockReturnValue(
			Effect.succeed([{ ...personalAssistant, model: "switched-off" }]),
		);
		const { router } = mount(`/${workspace.slug}`);

		fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
		expect(screen.queryByRole("navigation", { name: "Sidebar" })).toBeNull();

		expect(await screen.findByRole("heading", { name: "Connect a provider" })).toBeDefined();
		expect(router.state.location.pathname).toBe("/workspace-setup");
	});

	it.each([
		{
			opened: "at one of its pages",
			address: linearPage,
			landsAt: linearPage,
			unfinished: workspace,
			alongside: [],
		},
		{
			opened: "from the root, beside their own",
			address: "/",
			landsAt: "/nitric",
			unfinished: other,
			alongside: [workspace],
		},
	])(
		"opens an unfinished workspace as it is $opened, for somebody invited part way",
		async ({ address, landsAt, unfinished, alongside }) => {
			apiAnswers({ role: "editor" });
			client.api.workspaces.list.mockReturnValue(
				Effect.succeed([...alongside, { ...unfinished, setUpAt: null }]),
			);
			chooseWorkspace(unfinished.id);
			const { router } = mount(address);

			expect(await screen.findByRole("navigation", { name: "Sidebar" })).toBeDefined();
			await waitFor(() => expect(router.state.location.pathname.startsWith(landsAt)).toBe(true));
			expect(screen.queryByRole("heading", { name: "Connect a provider" })).toBeNull();
		},
	);

	it("cancels an unfinished workspace's setup into another workspace, keeping it for an admin, who may not delete it", async () => {
		const unfinished = { ...other, setUpAt: null };
		client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, unfinished]));
		const { router } = mount(`/${unfinished.slug}`);

		fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

		await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/suga(\/|$)/));
		expect(client.api.workspaces.delete).not.toHaveBeenCalled();
	});

	it("opens a workspace that is set up from the root, rather than the one being set up", async () => {
		const unfinished = { ...other, setUpAt: null };
		client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, unfinished]));
		chooseWorkspace(unfinished.id);
		const { router } = mount("/");

		expect(await screen.findByRole("navigation", { name: "Sidebar" })).toBeDefined();
		await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/suga(\/|$)/));
	});

	it("comes back to a workspace whose save a reload interrupted", async () => {
		// A new workspace's Personal Assistant has no model yet.
		client.api.bots.list.mockReturnValue(Effect.succeed([{ ...personalAssistant, model: null }]));
		client.api.workspaces.list.mockReturnValue(Effect.succeed([]));
		client.api.workspaces.create.mockReturnValue(Effect.never);
		const { router } = mount("/workspace-setup");
		fireEvent.change(await screen.findByLabelText("Workspace name"), {
			target: { value: "Nitric" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		await waitFor(() => expect(router.state.location.search).toEqual({ workspace: "nitric" }));

		// The server saves it while the page reloads.
		cleanup();
		client.api.workspaces.list.mockReturnValue(Effect.succeed([other]));
		mount(router.state.location.href);

		expect(await screen.findByRole("heading", { name: "Connect a provider" })).toBeDefined();
		expect(client.api.workspaces.create).toHaveBeenCalledOnce();
	});

	it("picks setting up a new workspace back up after a reload", async () => {
		client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, other]));
		mount("/workspace-setup?workspace=nitric");

		expect(await screen.findByRole("button", { name: "Cancel" })).toBeDefined();
		await waitFor(() => expect(localStorage.getItem("sugabots-workspace")).toBe(other.id));
		expect(screen.queryByRole("heading", { name: "Name your workspace" })).toBeNull();
		expect(client.api.workspaces.create).not.toHaveBeenCalled();
	});

	it("keeps a workspace whose setup is finished when its owner cancels setting it up", async () => {
		// Setup reached by its address, from a bookmark or Back, for a workspace set up since.
		apiAnswers({ role: "owner" });
		client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, other]));
		const { router } = mount("/workspace-setup?workspace=nitric");

		fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

		await waitFor(() => expect(router.state.location.pathname).not.toBe("/workspace-setup"));
		expect(client.api.workspaces.delete).not.toHaveBeenCalled();
	});

	it("asks before leaving a workspace made but not set up", async () => {
		client.api.workspaces.list.mockReturnValue(
			Effect.succeed([workspace, { ...other, setUpAt: null }]),
		);
		const { router } = mount("/workspace-setup?workspace=nitric");
		await screen.findByRole("button", { name: "Cancel" });

		void router.navigate({ to: linearPage });
		const dialog = await screen.findByRole("dialog", { name: "Leave setup?" });
		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Leave setup?" })).toBeNull());
		expect(router.state.location.pathname).toBe("/workspace-setup");

		void router.navigate({ to: linearPage });
		fireEvent.click(
			within(await screen.findByRole("dialog", { name: "Leave setup?" })).getByRole("button", {
				name: "Leave",
			}),
		);
		await waitFor(() => expect(router.state.location.pathname).toBe(linearPage));
		expect(client.api.workspaces.delete).not.toHaveBeenCalled();
	});

	it("cancels back to the page it came from before making one", async () => {
		client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, other]));
		const { router } = mount(linearPage);

		await startNewWorkspace(router);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		await waitFor(() => expect(router.state.location.pathname).toBe(linearPage));
		expect(client.api.workspaces.create).not.toHaveBeenCalled();
	});

	it("deletes the workspace it made when its owner cancels, and goes back to where it came from", async () => {
		apiAnswers({ role: "owner" });
		const made = { ...other, setUpAt: null };
		client.api.workspaces.create.mockImplementation(() => {
			client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, made]));
			return Effect.succeed(made);
		});
		client.api.workspaces.delete.mockReturnValue(Effect.void);
		const { router } = mount(linearPage);

		fireEvent.change(await startNewWorkspace(router), { target: { value: "Nitric" } });
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		await screen.findByRole("heading", { name: "Connect a provider" });
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		await waitFor(() => expect(router.state.location.pathname).toBe(linearPage));
		expect(client.api.workspaces.delete).toHaveBeenCalledWith({ params: { workspace: other.id } });
		expect(localStorage.getItem("sugabots-workspace")).toBe(workspace.id);
	});

	it("deletes an unfinished workspace when its owner cancels setting it up after a reload", async () => {
		apiAnswers({ role: "owner" });
		client.api.bots.list.mockReturnValue(Effect.succeed([{ ...personalAssistant, model: null }]));
		client.api.workspaces.list.mockReturnValue(
			Effect.succeed([workspace, { ...other, setUpAt: null }]),
		);
		client.api.workspaces.delete.mockReturnValue(Effect.void);
		const { router } = mount("/workspace-setup?workspace=nitric");

		await screen.findByRole("heading", { name: "Connect a provider" });
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		await waitFor(() => expect(router.state.location.pathname).not.toBe("/workspace-setup"));
		expect(client.api.workspaces.delete).toHaveBeenCalledWith({ params: { workspace: other.id } });
	});

	it("lets the owner delete a workspace, then opens another", async () => {
		onWideScreen();
		apiAnswers({ role: "owner" });
		client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, other]));
		client.api.workspaces.delete.mockImplementation(() => {
			client.api.workspaces.list.mockReturnValue(Effect.succeed([other]));
			return Effect.void;
		});
		const { router } = mount("/suga/settings");

		fireEvent.click(await screen.findByRole("button", { name: "Delete workspace" }));
		const dialog = await screen.findByRole("dialog", { name: `Delete ${workspace.name}?` });
		fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

		await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/nitric(\/|$)/));
		expect(client.api.workspaces.delete).toHaveBeenCalledWith({
			params: { workspace: workspace.id },
		});
	});

	it("offers an admin no way to delete the workspace", async () => {
		onWideScreen();
		mount("/suga/settings");

		await screen.findByRole("heading", { name: "General" });
		expect(screen.queryByRole("button", { name: "Delete workspace" })).toBeNull();
	});

	it("says so when the address is already taken, and stays on the step without it", async () => {
		client.api.workspaces.create.mockReturnValue(
			Effect.fail(new Conflict({ message: userText`already exists` })),
		);
		const { router } = mount(linearPage);

		fireEvent.change(await startNewWorkspace(router), { target: { value: "Suga" } });
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));

		expect(await screen.findByText("That workspace address is already taken.")).toBeDefined();
		expect(screen.getByRole("heading", { name: "Name your workspace" })).toBeDefined();
		expect(router.state.location.search).toEqual({});
	});

	async function startNewWorkspace(router: ReturnType<typeof mount>["router"]) {
		await openWorkspaceMenu();
		fireEvent.click(await screen.findByRole("menuitem", { name: "New workspace" }));
		await waitFor(() => expect(router.state.location.pathname).toBe("/workspace-setup"));
		await screen.findByRole("heading", { name: "Name your workspace" });
		return screen.getByLabelText("Workspace name");
	}
});

describe("the workspace while the API is not answering", () => {
	/** What a request gets while a release restarts the API. */
	const notAnswering = () => Effect.die(new Error("Failed to fetch"));

	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		onTestFinished(() => {
			vi.useRealTimers();
		});
	});

	it("stays open when checking its workspaces again fails", async () => {
		const { queries } = mount(linearPage);
		await screen.findByRole("navigation", { name: "Sidebar" });

		client.api.workspaces.list.mockReturnValue(notAnswering());
		const refetched = queries.refetchQueries({ queryKey: workspacesQuery.queryKey });
		await vi.advanceTimersByTimeAsync(5_000);
		await refetched;

		expect(screen.getByRole("navigation", { name: "Sidebar" })).toBeDefined();
		expect(screen.queryByText("Could not load your workspace")).toBeNull();
	});

	it("says it is trying again for as long as it is, and opens once the API answers", async () => {
		client.api.workspaces.list.mockReturnValue(notAnswering());
		mount(linearPage);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(await screen.findByText("Could not reach the API")).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		await vi.advanceTimersByTimeAsync(500);
		expect(screen.getByRole("button", { name: "Trying again…" })).toHaveProperty("disabled", true);

		client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace]));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(await screen.findByRole("navigation", { name: "Sidebar" })).toBeDefined();
	});
});

describe("the sidebar", () => {
	it("lists your Personal Assistant first, then the projects you are in, then the bots you pinned", async () => {
		client.api.bots.list.mockReturnValue(
			Effect.succeed([
				{ ...linear, pinned: true },
				{ ...triager, pinned: false },
				personalAssistant,
			]),
		);
		mount("/suga/projects");

		const sidebar = await screen.findByRole("navigation", { name: "Sidebar" });
		const projects = within(sidebar).getByRole("group", { name: "Projects" });
		// One row each, as a bot has: their chats are in the project's own sidebar.
		const sales = await within(projects).findByRole("link", { name: "Sales" });
		const team = within(projects).getByRole("link", { name: "Suga-Team" });
		expect(team.compareDocumentPosition(sales) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(within(projects).queryByRole("group")).toBeNull();
		const assistant = await within(sidebar).findByRole("link", { name: personalAssistant.name });
		expect(
			assistant.compareDocumentPosition(projects) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		const bots = within(sidebar).getByRole("group", { name: "Bots" });
		const listed = within(within(bots).getByRole("list")).getAllByRole("link");
		expect(listed.map((link) => link.textContent)).toEqual([linear.name]);
	});

	it("says what waits in the Personal Assistant's row, as a bot's row does", async () => {
		client.api.bots.list.mockReturnValue(Effect.succeed([linear, personalAssistant]));
		client.api.chats.attentionMarks.mockReturnValue(
			Effect.succeed({
				projects: {
					[personalAssistant.defaultProjectId]: {
						unreadMessages: 2,
						needsApproval: true,
						failedAutomations: 0,
					},
				},
			}),
		);
		mount("/suga/projects");

		const sidebar = await screen.findByRole("navigation", { name: "Sidebar" });
		expect(
			await within(sidebar).findByRole("link", {
				// A browser reads the space after the comma, which jsdom drops.
				name: /^Personal Assistant,\s?2 unread messages, needs you$/,
			}),
		).toBeDefined();
	});

	it("gives an open bot a sidebar of its own, listing its chats", async () => {
		onWideScreen();
		mount(linearPage);

		const sidebar = await screen.findByRole("navigation", { name: "Sidebar" });
		expect(
			await within(sidebar).findByRole("navigation", { name: `${linear.name}'s pages` }),
		).toBeDefined();
		const work = await within(sidebar).findByRole("region", { name: "Chats" });
		expect(
			await within(work).findByRole("link", { name: new RegExp(chatWith(linear).title) }),
		).toBeDefined();
		expect(within(sidebar).queryByRole("group", { name: "Projects" })).toBeNull();
	});

	it("lists Automations among a Personal Assistant's pages, as for any bot", async () => {
		onWideScreen();
		mount(`/suga/bots/${personalAssistant.handle}`);

		const pages = await screen.findByRole("navigation", {
			name: `${personalAssistant.name}'s pages`,
		});
		expect(await within(pages).findByRole("link", { name: /Automations/ })).toBeDefined();
	});

	it("goes back to the projects and bots from a bot's sidebar", async () => {
		onWideScreen();
		const { router } = mount(linearPage);

		fireEvent.click(await screen.findByRole("link", { name: "All projects and bots" }));

		await waitFor(() => expect(router.state.location.pathname).toBe("/suga"));
		expect(await screen.findByRole("group", { name: "Bots" })).toBeDefined();
	});

	it("makes your Personal Assistant when you have none", async () => {
		client.api.bots.list.mockReturnValue(Effect.succeed(bots));
		mount(linearPage);

		await waitFor(() => expect(client.api.bots.ensureAssistant).toHaveBeenCalled());
	});

	it("asks once to make your Personal Assistant on the workspace's own page, which waits on it", async () => {
		onWideScreen();
		client.api.bots.list.mockReturnValue(Effect.succeed(bots));
		mount("/suga");

		await waitFor(() => expect(client.api.bots.ensureAssistant).toHaveBeenCalled());
		await screen.findByRole("group", { name: "Bots" });
		expect(client.api.bots.ensureAssistant).toHaveBeenCalledTimes(1);
	});

	it("says so on the workspace's own page when your Personal Assistant could not be made", async () => {
		client.api.bots.list.mockReturnValue(Effect.succeed(bots));
		client.api.bots.ensureAssistant.mockReturnValue(
			Effect.fail(new InternalServerError({ message: userText`Nope` })),
		);
		mount("/suga");

		expect(await screen.findByText("Could not open your Personal Assistant")).toBeDefined();
	});

	it("narrows to a rail beside a project's own sidebar, and lists every project again away from it", async () => {
		const { router } = mount("/suga/projects/sales");

		const rail = await screen.findByRole("navigation", { name: "Projects and bots" });
		expect(
			(await within(rail).findByRole("link", { name: "Sales" })).getAttribute("aria-current"),
		).toBe("page");
		expect(await screen.findByRole("navigation", { name: "Sales's pages" })).toBeDefined();
		await router.navigate({ to: "/$workspace/approvals", params: { workspace: "suga" } });

		await waitFor(() => expect(router.state.location.pathname).toBe("/suga/approvals"));
		const sidebar = await screen.findByRole("navigation", { name: "Sidebar" });
		expect(await within(sidebar).findByRole("link", { name: "Sales" })).toBeDefined();
		expect(screen.queryByRole("navigation", { name: "Projects and bots" })).toBeNull();
	});

	it("makes a new bot from the + beside Bots", async () => {
		mount("/suga/projects");

		const sidebar = await screen.findByRole("navigation", { name: "Sidebar" });
		fireEvent.click(await within(sidebar).findByRole("button", { name: "New bot" }));
		expect(await screen.findByRole("dialog", { name: "New bot" })).toBeDefined();
	});

	it("opens your preferences from your menu", async () => {
		mount(linearPage);

		const sidebar = await screen.findByRole("navigation", { name: "Sidebar" });
		fireEvent.click(await within(sidebar).findByRole("button", { name: /^Account:/ }));
		expect(
			(await screen.findByRole("menuitem", { name: "Preferences" })).getAttribute("href"),
		).toBe("/suga/settings/account");
	});
});

describe("someone else's private bot an administrator sees listed", () => {
	const theirs = {
		...triager,
		visibility: "private" as const,
		createdBy: { id: juno.id, name: juno.name, email: juno.email, image: null },
		permissions: {
			...triager.permissions,
			talk: false,
			resources: { ...triager.permissions.resources, readHistory: false },
		},
	};

	it("shows that it exists, with its settings, but none of its chats", async () => {
		client.api.bots.list.mockReturnValue(Effect.succeed([linear, theirs, personalAssistant]));
		mount(`/suga/bots/${theirs.handle}`);

		expect(await screen.findByText(/someone else's private bot/)).toBeDefined();
		expect(screen.getByRole("link", { name: "Open its settings" }).getAttribute("href")).toBe(
			`/suga/bots/${theirs.handle}/settings`,
		);
		expect(client.api.chats.projectChats).not.toHaveBeenCalledWith({
			params: { projectId: theirs.defaultProjectId },
		});
	});

	it("offers no pin for it in the directory, and puts no pin inside a link", async () => {
		client.api.bots.list.mockReturnValue(Effect.succeed([linear, theirs, personalAssistant]));
		mount("/suga/bots");

		const pin = await screen.findByRole("button", { name: `Unpin ${linear.name}` });
		expect(pin.closest("a")).toBeNull();
		expect(screen.queryByRole("button", { name: new RegExp(`Pin ${theirs.name}`) })).toBeNull();
		expect(screen.getByRole("link", { name: theirs.name }).getAttribute("href")).toBe(
			`/suga/bots/${theirs.handle}/settings`,
		);
	});
});

describe("a public project you're not in", () => {
	const notIn = () =>
		client.api.projects.list.mockReturnValue(
			Effect.succeed(
				projects.map((project) =>
					project.slug === "sales"
						? {
								...project,
								isMember: false,
								permissions: { ...project.permissions, join: true, leave: false },
							}
						: project,
				),
			),
		);

	it("shows what it is, with Join, rather than failing to open it", async () => {
		notIn();
		client.api.projects.join.mockReturnValue(Effect.succeed(projects[1]));
		mount("/suga/projects/sales");

		fireEvent.click(await screen.findByRole("button", { name: "Join Sales" }));

		await waitFor(() =>
			expect(client.api.projects.join).toHaveBeenCalledWith({
				params: { projectId: projects[1]?.id },
			}),
		);
		expect(client.api.chats.projectChats).not.toHaveBeenCalledWith({
			params: { projectId: projects[1]?.id },
		});
	});

	it("joins it from the directory by its name, and says why when joining fails", async () => {
		notIn();
		client.api.projects.join.mockReturnValue(
			Effect.fail(new InternalServerError({ message: userText`Could not join` })),
		);
		mount("/suga/projects");

		const group = await screen.findByRole("region", { name: "To join" });
		fireEvent.click(within(group).getByRole("button", { name: "Join Sales" }));

		expect(await screen.findByText("Could not join")).toBeDefined();
	});

	it("keeps its settings closed, offering Join in their place", async () => {
		notIn();
		mount("/suga/projects/sales/settings");

		expect(await screen.findByRole("button", { name: "Join Sales" })).toBeDefined();
		expect(screen.queryByRole("button", { name: "Delete project" })).toBeNull();
	});
});

describe("a project's chats", () => {
	const sales = projects[1] as (typeof projects)[number];
	const chatIn = (id: string, title: string) =>
		listedChat({
			kind: "project_chat",
			id,
			workspaceId: workspace.id,
			projectId: sales.id,
			botId: null,
			title,
			resolvedAt: null,
			createdAt: "2026-09-18T06:00:00.000Z",
			updatedAt: "2026-09-18T06:00:00.000Z",
		});

	it("opens the project at its newest chat", async () => {
		onWideScreen();
		const newest = chatIn("0199a3a0-0000-7000-8000-0000000000f1", "Launch");
		client.api.chats.projectChats.mockReturnValue(
			Effect.succeed({
				chats: [newest, chatIn("0199a3a0-0000-7000-8000-0000000000f2", "Pricing")],
				automations: [],
			}),
		);
		const { router } = mount(`/suga/projects/${sales.slug}`);

		await waitFor(() =>
			expect(router.state.location.pathname).toBe(`/suga/projects/${sales.slug}/${newest.chat.id}`),
		);
	});

	it("lists a scheduled run that started and finished while the project was open", async () => {
		onWideScreen();
		const updates = controlledEventStream();
		client.events.workspace.mockReturnValue(updates.stream);
		client.api.chats.projectChats.mockReturnValue(
			Effect.succeed({
				chats: [chatIn("0199a3a0-0000-7000-8000-0000000000f1", "Launch")],
				automations: [],
			}),
		);
		mount(`/suga/projects/${sales.slug}`);
		await screen.findByText("Launch");

		const at = "2026-09-18T09:00:00.000Z";
		const run: Run = {
			id: "0199a3a0-0000-7000-8000-0000000003e5",
			automationId: "0199a3a0-0000-7000-8000-0000000003e1",
			workspaceId: workspace.id,
			botId: "0199a3a0-0000-7000-8000-0000000000b1",
			chatId: "0199a3a0-0000-7000-8000-0000000003e6",
			rootChatId: "0199a3a0-0000-7000-8000-0000000003e7",
			automationName: "Morning pipeline review",
			instructions: "Review the pipeline.",
			trigger: { kind: "routine", scheduledAt: at, acceptedAt: at },
			state: "completed",
			error: null,
			posted: true,
			acceptedAt: at,
			startedAt: at,
			finishedAt: at,
		};
		client.api.automations.projectRuns.mockReturnValue(
			Effect.succeed({ items: [run], nextCursor: null }),
		);
		updates.emit(
			streamEvent("chat.item_changed", {
				rootChatId: run.rootChatId,
				chatId: run.chatId,
			}),
		);

		expect(await screen.findByText(run.automationName)).toBeDefined();
	});

	it("starts the first chat of a project with none from its first message, as a bot's page does", async () => {
		onWideScreen();
		const started = chatIn("0199a3a0-0000-7000-8000-0000000000f3", "Plan the kickoff");
		client.api.chats.startProjectChat.mockImplementation(
			({ payload }: { payload: { id: string; message: string } }) =>
				Effect.succeed({
					chat: started.chat,
					message: { id: payload.id, chatId: started.chat.id },
				}),
		);
		const { router } = mount(`/suga/projects/${sales.slug}`);

		expect(await screen.findByText("What do you need done?")).toBeDefined();
		const composer = await screen.findByLabelText(`Message ${sales.name}`);
		composer.textContent = "Plan the kickoff";
		fireEvent.input(composer);
		fireEvent.click(screen.getByRole("button", { name: "Start chat" }));

		await waitFor(() =>
			expect(client.api.chats.startProjectChat).toHaveBeenCalledWith({
				params: { projectId: sales.id },
				payload: { id: expect.any(String), message: "Plan the kickoff" },
			}),
		);
		await waitFor(() =>
			expect(router.state.location.pathname).toBe(
				`/suga/projects/${sales.slug}/${started.chat.id}`,
			),
		);
	});

	it("starts a chat again with the same message when its first answer was lost, so it starts once", async () => {
		onWideScreen();
		const started = chatIn("0199a3a0-0000-7000-8000-0000000000f3", "Plan the kickoff");
		client.api.chats.startProjectChat
			.mockReturnValueOnce(Effect.fail(new InternalServerError({ message: userText`Lost` })))
			.mockImplementation(({ payload }: { payload: { id: string; message: string } }) =>
				Effect.succeed({
					chat: started.chat,
					message: { id: payload.id, chatId: started.chat.id },
				}),
			);
		mount(`/suga/projects/${sales.slug}`);
		const composer = await screen.findByLabelText(`Message ${sales.name}`);
		composer.textContent = "Plan the kickoff";
		fireEvent.input(composer);
		fireEvent.click(screen.getByRole("button", { name: "Start chat" }));
		await waitFor(() => expect(client.api.chats.startProjectChat).toHaveBeenCalledTimes(1));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Start chat" }).hasAttribute("disabled")).toBe(
				false,
			),
		);

		fireEvent.click(screen.getByRole("button", { name: "Start chat" }));

		await waitFor(() => expect(client.api.chats.startProjectChat).toHaveBeenCalledTimes(2));
		const [first, second] = client.api.chats.startProjectChat.mock.calls.map(
			([request]) => (request as { payload: { id: string } }).payload.id,
		);
		expect(second).toBe(first);
	});
});

describe("a project's settings on a phone", () => {
	it("goes back from its People and its Bots to its Settings, which they sit under", async () => {
		for (const page of ["people", "bots"]) {
			mount(`/suga/projects/sales/settings/${page}`);

			const back = await screen.findByRole("link", { name: "Back to Settings" });
			expect(back.getAttribute("href")).toBe("/suga/projects/sales/settings");
			cleanup();
		}
	});

	it("goes back from its Settings to the project", async () => {
		mount("/suga/projects/sales/settings");

		const back = await screen.findByRole("link", { name: "Back to Sales" });
		expect(back.getAttribute("href")).toBe("/suga/projects/sales");
	});
});

describe("a bot on a phone", () => {
	it("opens to its chats and its pages, with + to start a chat", async () => {
		const { router } = mount(linearPage);

		const page = await screen.findByRole("region", { name: linear.name });
		expect(
			await within(page).findByRole("link", { name: new RegExp(chatWith(linear).title) }),
		).toBeDefined();
		expect(within(page).getByRole("link", { name: "Files" })).toBeDefined();
		fireEvent.click(within(page).getByRole("link", { name: `New chat with ${linear.name}` }));

		await waitFor(() => expect(router.state.location.pathname).toBe(`${linearPage}/new`));
		expect(await screen.findByLabelText(`Message ${linear.name}`)).toBeDefined();
	});

	it("goes back from a new chat opened first to the bot's chats, not to itself", async () => {
		const { router } = mount(`${linearPage}/new`);

		const back = await screen.findByRole("link", { name: `Back to ${linear.name}` });
		expect(back.getAttribute("href")).toBe(linearPage);
		fireEvent.click(back);

		await waitFor(() => expect(router.state.location.pathname).toBe(linearPage));
		expect(await screen.findByRole("region", { name: linear.name })).toBeDefined();
	});

	it("offers an administrator a model for a Personal Assistant without one, not its settings", async () => {
		client.api.bots.list.mockReturnValue(Effect.succeed([{ ...personalAssistant, model: null }]));
		mount(`/suga/bots/${personalAssistant.handle}/new`);

		const link = await screen.findByRole("link", { name: "Switch on a model" });
		expect(link.getAttribute("href")).toBe("/suga/settings/providers");
		expect(screen.queryByRole("link", { name: "Choose a model" })).toBeNull();
	});

	it("tells an editor who cannot switch a model on who can, for their Personal Assistant", async () => {
		apiAnswers({ role: "editor" });
		client.api.bots.list.mockReturnValue(Effect.succeed([{ ...personalAssistant, model: null }]));
		mount(`/suga/bots/${personalAssistant.handle}/new`);

		expect(
			await screen.findByText(/A workspace administrator switches on a model for it/),
		).toBeDefined();
		expect(screen.queryByRole("link", { name: "Choose a model" })).toBeNull();
	});
});

describe("starting a chat with a bot", () => {
	it("stays on the bot opened while the chat started, rather than going to the chat", async () => {
		onWideScreen();
		const starting = pendingAnswer();
		client.api.chats.startProjectChat.mockReturnValue(starting.effect);
		const { router } = mount(linearPage);
		const composer = await screen.findByLabelText(`Message ${linear.name}`);
		writeDraft(composer, "Plan the kickoff");
		fireEvent.click(screen.getByRole("button", { name: "Start chat" }));
		await waitFor(() => expect(client.api.chats.startProjectChat).toHaveBeenCalled());

		const triagerPage = `/suga/bots/${triager.handle}`;
		await router.navigate({ to: triagerPage });
		const started = listedChat(chatWith(linear));
		const chatsAsked = client.api.chats.projectChats.mock.calls.length;
		starting.answer(
			Effect.succeed({
				chat: started.chat,
				message: {
					id: "0199a3a0-0000-7000-8000-0000000000fb",
					chatId: started.chat.id,
				},
			}),
		);

		// The chat list is asked for again once the chat has started, wherever the person is.
		await waitFor(() =>
			expect(client.api.chats.projectChats.mock.calls.length).toBeGreaterThan(chatsAsked),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(router.state.location.pathname).toBe(triagerPage);
	});
});

describe("the settings navigation", () => {
	/*
	 * Your own sections, then the workspace's; a bot's and a project's settings
	 * are its own pages. The sections an administrator alone may open are left
	 * out for an editor, so their list simply ends rather than showing gaps.
	 */

	it("lists your settings first, then the workspace's sections, and no bots or projects", async () => {
		onWideScreen();
		const { router } = mount("/suga/settings");

		const rail = await screen.findByRole("navigation", { name: "Settings" });
		const groups = within(rail).getAllByRole("group");
		expect(groups[0]?.getAttribute("aria-labelledby")).toBeTruthy();
		const you = within(rail).getByRole("group", { name: "You" });
		const workspace = within(rail).getByRole("group", { name: "Workspace" });
		expect(groups[0]).toBe(you);

		expect(await within(workspace).findByRole("link", { name: "Models" })).toBeDefined();
		expect(within(workspace).getByRole("link", { name: "Computers" })).toBeDefined();
		expect(
			within(workspace).getByRole("link", { name: "General" }).getAttribute("aria-current"),
		).toBe("page");
		expect(within(rail).queryByRole("group", { name: "Projects" })).toBeNull();
		expect(within(rail).queryByRole("group", { name: "Bots" })).toBeNull();

		fireEvent.click(within(you).getByRole("link", { name: "General" }));

		await waitFor(() => expect(router.state.location.pathname).toBe("/suga/settings/account"));
	});

	it("shows the workspace's time zone under General", async () => {
		onWideScreen();
		client.api.workspaces.list.mockReturnValue(
			Effect.succeed([{ ...workspace, timeZone: "Australia/Sydney" }]),
		);
		mount("/suga/settings");

		expect(await screen.findByText("Time zone")).toBeDefined();
		expect(screen.getByText("Australia/Sydney")).toBeDefined();
	});

	it("leaves the roster uncounted while you are the only person in it", async () => {
		onWideScreen();
		client.api.workspaces.memberships.mockReturnValue(
			Effect.succeed([
				{
					id: "0199a3a0-0000-7000-8000-0000000000d1",
					role: "admin",
					person: sam,
					joinedAt: "2026-09-09T00:00:00.000Z",
				},
			]),
		);
		mount("/suga/settings");

		// General counts the people too, so once it does the roster has answered.
		await screen.findByText("Workspace with 1 person and 2 projects");
		const rail = await screen.findByRole("navigation", { name: "Settings" });

		// The one person is you. "1" tells nobody anything they did not know.
		expect(within(rail).getByRole("link", { name: "People" })).toBeDefined();
	});

	it("withholds the administrative sections from an editor", async () => {
		onWideScreen();
		apiAnswers({ role: "editor" });
		mount("/suga/settings");

		const rail = await screen.findByRole("navigation", { name: "Settings" });
		// Waiting on a count waits on the answers the rail is drawn from, the
		// caller's role among them, so what follows is a settled list.
		await within(rail).findByRole("link", { name: "People, 2" });

		expect(within(rail).queryByRole("link", { name: "Models" })).toBeNull();
		expect(within(rail).queryByRole("link", { name: "Web search" })).toBeNull();
		expect(within(rail).queryByRole("link", { name: "Computers" })).toBeNull();
	});

	it("tells an editor who reaches the Models page by address that it is not theirs", async () => {
		apiAnswers({ role: "editor" });
		mount("/suga/settings/providers/system");

		expect(
			await screen.findByText("Only workspace administrators can manage models."),
		).toBeDefined();
	});
});

/**
 * Answers making the workspace's first bot, `name`, with it, and lists it
 * with the Personal Assistant from then on.
 */
function firstBotMade(name: string) {
	const made = {
		...linear,
		id: "0199a3a0-0000-7000-8000-0000000000c8",
		name,
		handle: name.toLowerCase(),
	};
	client.api.bots.create.mockImplementation(() => {
		client.api.bots.list.mockReturnValue(Effect.succeed([personalAssistant, made]));
		return Effect.succeed(made);
	});
	return made;
}

describe("routes", () => {
	it("lands on your Personal Assistant's page, at the workspace's own address", async () => {
		onWideScreen();
		const { router } = mount("/");

		await waitFor(() => expect(router.state.location.pathname).toBe("/suga"));
		const sidebar = await screen.findByRole("navigation", { name: "Sidebar" });
		const assistant = await within(sidebar).findByRole("link", {
			name: new RegExp(`^${personalAssistant.name}`),
		});
		expect(assistant.getAttribute("aria-current")).toBe("page");
	});

	it("sends somebody signed out to the sign-in page, remembering where they were going", async () => {
		const destination = `${linearPage}?nestedChat=0199a3a0-0000-7000-8000-0000000000aa`;
		const { router } = mount(destination, { person: null });

		expect(await screen.findByRole("heading", { name: "Welcome to Sugabots" })).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Continue with email" }));
		expect(await screen.findByRole("button", { name: "Sign in" })).toBeDefined();
		await waitFor(() => {
			expect(router.state.location.pathname).toBe("/sign-in");
		});
		expect(router.state.location.search).toEqual({ returnTo: destination });
	});

	it("returns a signed-in visit to the sign-in page to where it was going, search and all", async () => {
		onWideScreen();
		const destination = `/suga/bots/${linear.handle}/settings?tab=automations`;
		const { router } = mount(`/sign-in?returnTo=${encodeURIComponent(destination)}`);

		expect(await screen.findByRole("link", { name: /^Automations/ })).toBeDefined();
		expect(router.state.location.href).toBe(destination);
	});

	it("will not return from the sign-in page to another site", async () => {
		const { router } = mount(`/sign-in?returnTo=${encodeURIComponent("//evil.example/steal")}`);

		await waitFor(() => expect(router.state.location.pathname).toBe("/suga"));
	});

	it("walks a new workspace from its first bot to its chat", async () => {
		client.api.projects.list.mockReturnValue(Effect.succeed([]));
		client.api.bots.list.mockReturnValue(Effect.succeed([personalAssistant]));
		const made = firstBotMade("Chief");
		client.api.workspaceSetup.complete.mockReturnValue(Effect.void);
		const { router } = mount(`/workspace-setup?workspace=${workspace.slug}`);

		expect(await screen.findByRole("heading", { name: "Make your first bot" })).toBeDefined();
		await waitFor(() => expect(router.state.location.pathname).toBe("/workspace-setup"));
		const create = screen.getByRole("button", { name: "Create bot" });
		expect(create.hasAttribute("disabled")).toBe(true);
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Chief" } });
		fireEvent.click(screen.getByRole("radio", { name: "purple" }));
		fireEvent.click(create);

		// A new public bot of the workspace's, on the Personal Assistant's model; the assistant stays as it is.
		await waitFor(() =>
			expect(client.api.bots.create).toHaveBeenCalledWith({
				params: { workspace: workspace.id },
				payload: {
					name: "Chief",
					model: personalAssistant.model,
					color: "purple",
					shape: "circle",
					eyes: "pill",
					visibility: "public",
				},
			}),
		);
		expect(client.api.bots.update).not.toHaveBeenCalled();
		expect(await screen.findByRole("heading", { name: "Bring your friends" })).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));

		expect(await screen.findByRole("heading", { name: "Chief is ready" })).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Start talking" }));

		await waitFor(() =>
			expect(client.api.workspaceSetup.complete).toHaveBeenCalledWith({
				payload: { workspaceId: workspace.id, botId: made.id },
			}),
		);
		await waitFor(() =>
			expect(router.state.location.pathname.startsWith(`/suga/bots/${made.handle}`)).toBe(true),
		);
	});

	it("invites the addresses typed, and says how many it will send", async () => {
		client.api.projects.list.mockReturnValue(Effect.succeed([]));
		client.api.bots.list.mockReturnValue(Effect.succeed([personalAssistant]));
		firstBotMade("Chief");
		client.api.workspaces.invite.mockReturnValue(Effect.succeed({ id: "an-invitation" }));
		mount(`/workspace-setup?workspace=${workspace.slug}`);

		fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Chief" } });
		fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
		const emails = await screen.findByLabelText("Email addresses");
		fireEvent.change(emails, { target: { value: "jay@nitric.io" } });
		fireEvent.keyDown(emails, { key: "Enter" });
		fireEvent.change(emails, { target: { value: "not an address" } });
		fireEvent.keyDown(emails, { key: "Enter" });
		fireEvent.change(emails, { target: { value: "mara@nitric.io," } });
		fireEvent.blur(emails);
		fireEvent.click(screen.getByRole("button", { name: "Send 2 invites" }));

		await waitFor(() => {
			for (const email of ["jay@nitric.io", "mara@nitric.io"]) {
				expect(client.api.workspaces.invite).toHaveBeenCalledWith(
					expect.objectContaining({ payload: expect.objectContaining({ email, role: "editor" }) }),
				);
			}
		});
		expect(await screen.findByRole("heading", { name: "Chief is ready" })).toBeDefined();
	});

	it("starts at the model step while the first bot has no model, and will not skip it", async () => {
		client.api.projects.list.mockReturnValue(Effect.succeed([]));
		client.api.bots.list.mockReturnValue(
			Effect.succeed([{ ...personalAssistant, model: "switched-off" }]),
		);
		mount(`/workspace-setup?workspace=${workspace.slug}`);

		expect(await screen.findByRole("heading", { name: "Connect a provider" })).toBeDefined();
		expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
	});

	it("adds the first provider from the Models picker, then switches on the model chosen for the first bot", async () => {
		client.api.projects.list.mockReturnValue(Effect.succeed([]));
		client.api.bots.list.mockReturnValue(Effect.succeed([personalAssistant]));
		client.api.modelProviders.listEnabledModels.mockReturnValue(
			Effect.succeed({ models: [], defaultModel: null }),
		);
		const openrouter = {
			...(modelProviders[0] as ModelProvider),
			id: "0199a3a0-0000-7000-8000-0000000000c9",
			builtIn: "openrouter" as const,
			name: "OpenRouter",
			models: ["meta/llama", "mistral/large"].map((modelId, index) => ({
				...(modelProviders[0]?.models[0] as ProviderModel),
				id: `0199a3a0-0000-7000-8000-0000000000e${index}`,
				enabled: false,
				modelId,
			})),
		};
		const [, large] = openrouter.models;
		let listed: ModelProvider[] = [];
		client.api.modelProviders.list.mockImplementation(() => Effect.sync(() => listed));
		client.api.modelProviders.create.mockReturnValue(
			Effect.sync(() => {
				listed = [openrouter];
				return openrouter;
			}),
		);
		client.api.modelProviders.discoverModels.mockReturnValue(
			Effect.succeed({ added: 2, updated: 0, unchanged: 0 }),
		);
		client.api.modelProviders.updateModel.mockReturnValue(
			Effect.succeed({ ...(large as ProviderModel), enabled: true }),
		);
		client.api.bots.ensureAssistant.mockReturnValue(
			Effect.succeed({ ...personalAssistant, model: "mistral/large" }),
		);
		mount(`/workspace-setup?workspace=${workspace.slug}`);

		fireEvent.click(await screen.findByRole("button", { name: "Choose a provider" }));
		const picker = await screen.findByRole("dialog", { name: "Add provider" });
		fireEvent.click(within(picker).getByRole("button", { name: /^OpenRouter/ }));
		const step = await screen.findByRole("dialog", { name: "OpenRouter" });
		fireEvent.change(within(step).getByLabelText("API key"), { target: { value: "sk-or-test" } });
		fireEvent.click(within(step).getByRole("button", { name: "Add" }));

		expect(await screen.findByRole("heading", { name: "Choose a model" })).toBeDefined();
		expect(client.api.modelProviders.create).toHaveBeenCalledWith({
			params: { workspace: workspace.id },
			payload: { builtIn: "openrouter", apiKey: "sk-or-test" },
		});
		const next = screen.getByRole("button", { name: "Continue" });
		expect(next.hasAttribute("disabled")).toBe(true);
		fireEvent.click(screen.getByRole("radio", { name: "mistral/large" }));
		fireEvent.click(next);

		await waitFor(() =>
			expect(client.api.bots.ensureAssistant).toHaveBeenCalledWith({
				params: { workspace: workspace.id },
				payload: { model: "mistral/large" },
			}),
		);
		// The Personal Assistant's model is Sugabots' to set, not a change to the bot.
		expect(client.api.bots.update).not.toHaveBeenCalled();
		expect(client.api.modelProviders.updateModel).toHaveBeenCalledWith({
			params: { workspace: workspace.id, providerId: openrouter.id, modelId: large?.id },
			payload: { enabled: true },
		});
		expect(await screen.findByRole("heading", { name: "Make your first bot" })).toBeDefined();
	});

	it("asks somebody with an invitation to sign in first, keeping the invitation", async () => {
		const { router } = mount("/invitations/an-invitation", { person: null });

		expect(await screen.findByText(/invited to a workspace/)).toBeDefined();
		await waitFor(() => {
			expect(router.state.location.search).toEqual({ invitation: "an-invitation" });
		});
	});

	async function createAccount(name: string, email: string) {
		fireEvent.click(await screen.findByRole("button", { name: "Create an account" }));
		fireEvent.change(await screen.findByLabelText("Name"), {
			target: { value: name },
		});
		fireEvent.change(screen.getByLabelText("Email"), {
			target: { value: email },
		});
		fireEvent.change(screen.getByLabelText("Password"), {
			target: { value: "correct-horse" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create account" }));
	}

	it("points an invitee's verification link back at the invitation", async () => {
		client.auth.signUp.mockResolvedValue({ token: null, person: sam });
		mount("/invitations/an-invitation", { person: null });

		await createAccount("Sam", "sam@example.com");

		expect(await screen.findByText("Check your email")).toBeDefined();
		expect(client.auth.signUp).toHaveBeenCalledWith({
			name: "Sam",
			email: "sam@example.com",
			password: "correct-horse",
			callbackURL: `${window.location.origin}/invitations/an-invitation`,
		});
	});

	it("shows why a sign-up was refused rather than asking for verification", async () => {
		client.auth.signUp.mockRejectedValue(
			failureForStatus(
				403,
				UserText.unchecked(
					"Sign-up is by invitation only. Ask someone in a workspace to invite you.",
				),
				"SIGN_UP_CLOSED",
			),
		);
		mount("/", { person: null });
		fireEvent.click(await screen.findByRole("button", { name: "Continue with email" }));

		await createAccount("Eve", "eve@example.com");

		expect(await screen.findByText(/invitation only/)).toBeDefined();
		expect(screen.queryByText("Check your email")).toBeNull();
	});

	it("asks an unverified account to open its link when it logs in", async () => {
		client.auth.signIn.mockRejectedValue(
			failureForStatus(403, UserText.unchecked("Email not verified"), "EMAIL_NOT_VERIFIED"),
		);
		mount("/", { person: null });
		fireEvent.click(await screen.findByRole("button", { name: "Continue with email" }));

		fireEvent.change(await screen.findByLabelText("Email"), {
			target: { value: "sam@example.com" },
		});
		fireEvent.change(screen.getByLabelText("Password"), {
			target: { value: "correct-horse" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

		expect(await screen.findByText("Check your email")).toBeDefined();
	});

	it("signs a new account in at once when no verification is needed", async () => {
		client.auth.signUp.mockResolvedValue({ token: "a-session", person: sam });
		const refresh = vi.fn().mockResolvedValue(undefined);
		mount("/invitations/an-invitation", { person: null, refresh });

		await createAccount("Sam", "sam@example.com");

		await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
		expect(screen.queryByText("Check your email")).toBeNull();
	});

	it("tells an invitee to verify rather than blaming the address", async () => {
		client.api.workspaces.invitation.mockReturnValue(
			Effect.fail(
				failureForStatus(
					403,
					UserText.unchecked(
						"Email verification required to view or list invitations for the session email",
					),
					"EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION",
				),
			),
		);

		mount("/invitations/an-invitation");

		expect((await screen.findByRole("alert")).textContent).toContain(
			"Verify your email address before accepting",
		);
	});

	it("does not retry an accepted invitation when continuing initially fails", async () => {
		client.api.workspaces.invitation.mockReturnValue(
			Effect.succeed({
				status: "pending",
				workspaceName: "Nitric",
				inviterName: "Sam",
				role: "editor",
			}),
		);
		const refresh = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(new Error("Offline"))
			.mockResolvedValueOnce(undefined);
		const { router } = mount("/invitations/an-invitation", { refresh });

		fireEvent.click(await screen.findByRole("button", { name: "Accept invitation" }));

		expect(await screen.findByText("Invitation accepted")).toBeDefined();
		expect((await screen.findByRole("alert")).textContent).toContain(
			"The invitation was accepted, but we could not continue",
		);
		expect(client.api.workspaces.acceptInvitation).toHaveBeenCalledOnce();
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));

		await waitFor(() => expect(router.state.location.pathname).toBe("/suga"));
		expect(client.api.workspaces.acceptInvitation).toHaveBeenCalledOnce();
		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it("opens the workspace just joined, though the list the session started with lacks it", async () => {
		const joined = {
			id: "0199a3a0-0000-7000-8000-0000000000f9",
			name: "Nitric",
			slug: "nitric",
			timeZone: "UTC",
			setUpAt: "2026-09-01T00:00:00.000Z",
		};
		client.api.workspaces.invitation.mockReturnValue(
			Effect.succeed({
				status: "pending",
				workspaceName: "Nitric",
				inviterName: "Sam",
				role: "editor",
			}),
		);
		client.api.workspaces.acceptInvitation.mockImplementation(() => {
			client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, joined]));
			return Effect.succeed({ workspaceId: joined.id });
		});
		// As main.tsx starts a session: with the workspaces /me answered with.
		const queries = createQueryClient();
		queries.setQueryData(workspacesQuery.queryKey, [workspace]);
		const { router } = mount("/invitations/an-invitation", {
			queries,
			refresh: vi.fn().mockResolvedValue(undefined),
		});

		await screen.findByText("You have been invited to Nitric.");
		fireEvent.click(screen.getByRole("button", { name: "Accept invitation" }));

		await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/nitric(\/|$)/));
	});

	it("leads back into the workspace from an invitation already accepted", async () => {
		client.api.workspaces.invitation.mockReturnValue(
			Effect.succeed({ status: "accepted", workspaceId: workspace.id }),
		);
		const refresh = vi.fn().mockResolvedValue(undefined);
		const { router } = mount("/invitations/an-invitation", { refresh });

		await waitFor(() => expect(router.state.location.pathname).toBe("/suga"));
		expect(client.api.workspaces.acceptInvitation).not.toHaveBeenCalled();
		expect(refresh).toHaveBeenCalledOnce();
	});

	it("awaits signing in and reports its failure", async () => {
		client.auth.signIn.mockResolvedValue(undefined);
		const refresh = vi.fn().mockRejectedValue(new Error("Offline"));
		mount("/sign-in", { person: null, refresh });
		fireEvent.click(await screen.findByRole("button", { name: "Continue with email" }));
		fireEvent.change(await screen.findByLabelText("Email"), {
			target: { value: "sam@example.com" },
		});
		fireEvent.change(screen.getByLabelText("Password"), {
			target: { value: "password" },
		});

		fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

		expect((await screen.findByRole("alert")).textContent).toContain("Could not reach the API");
		expect(refresh).toHaveBeenCalledOnce();
	});

	it("says so when the bot in the address is not there", async () => {
		mount("/suga/bots/missing");

		expect(await screen.findByText("No such bot here")).toBeDefined();
	});

	it("distinguishes a failed bot roster from an unknown bot", async () => {
		client.api.bots.list.mockReturnValue(
			Effect.fail(new Forbidden({ message: userText`Unavailable` })),
		);
		mount(linearPage);

		expect(await screen.findByText("Could not load this bot")).toBeDefined();
		expect(screen.queryByText("No such bot here")).toBeNull();
	});

	it("says so when the project in the address is not there", async () => {
		mount("/suga/projects/missing");

		expect(await screen.findByText("No such project here")).toBeDefined();
	});
});

describe("creating a project", () => {
	it("hides New project from a viewer", async () => {
		onWideScreen();
		apiAnswers({ role: "viewer" });
		mount("/suga/projects");

		// Waiting on the projects waits on the answers the controls beside them are drawn from.
		await screen.findAllByRole("link", { name: /Suga-Team/ });

		expect(screen.queryByRole("button", { name: "New project" })).toBeNull();
	});

	/** Opens New project, at the head of the projects. */
	async function openNewProject() {
		fireEvent.click(await screen.findByRole("button", { name: "New project" }));
	}

	/** Chooses Customer Research to lead the project the dialog makes. */
	async function chooseLead(dialog: HTMLElement) {
		fireEvent.click(within(dialog).getByRole("button", { name: "Choose a lead bot" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Customer Research" }));
		await within(dialog).findByRole("button", { name: "Lead bot: Customer Research" });
	}

	it("waits for a name and a lead bot before it can make a project", async () => {
		onWideScreen();
		mount("/suga/projects");
		await openNewProject();

		const dialog = await screen.findByRole("dialog", { name: "New project" });
		const create = within(dialog).getByRole("button", { name: "Create" });
		expect(create.hasAttribute("disabled")).toBe(true);
		fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Platform Team" } });
		expect(create.hasAttribute("disabled")).toBe(true);
		await chooseLead(dialog);
		expect(create.hasAttribute("disabled")).toBe(false);
	});

	it("creates one in a colour no other project has, and opens it", async () => {
		onWideScreen();
		const made = { ...projects[0], id: "new", name: "Platform", slug: "platform" };
		client.api.projects.create.mockReturnValue(Effect.succeed(made));

		const { router } = mount("/suga/projects");
		await openNewProject();

		const dialog = await screen.findByRole("dialog", { name: "New project" });
		fireEvent.change(within(dialog).getByLabelText("Name"), {
			target: { value: "Platform" },
		});
		await chooseLead(dialog);

		client.api.projects.list.mockReturnValue(Effect.succeed([...projects, made]));
		within(dialog).getByRole("button", { name: "Create" }).click();

		await waitFor(() => {
			expect(client.api.projects.create).toHaveBeenCalledWith({
				params: { workspace: workspace.id },
				// Its colour is the one the workspace's green and blue projects leave first.
				payload: {
					name: "Platform",
					color: "plum",
					visibility: "public",
					description: null,
					leadBotId: "0199a3a0-0000-7000-8000-0000000000b1",
				},
			});
		});
		await waitFor(() =>
			expect(router.state.location.pathname).toMatch(/^\/suga\/projects\/platform/),
		);
	});

	it("says so when the address is already taken, and keeps the form open", async () => {
		onWideScreen();
		client.api.projects.create.mockReturnValue(
			Effect.fail(new Conflict({ message: userText`already exists` })),
		);

		mount("/suga/projects");
		await openNewProject();

		const dialog = await screen.findByRole("dialog", { name: "New project" });
		fireEvent.change(within(dialog).getByLabelText("Name"), {
			target: { value: "Sales" },
		});
		await chooseLead(dialog);
		within(dialog).getByRole("button", { name: "Create" }).click();

		expect(await within(dialog).findByRole("alert")).toBeDefined();
		expect(screen.getByRole("dialog", { name: "New project" })).toBeDefined();
	});
});

describe("creating a bot", () => {
	it("offers an editor the same New bot action as an admin", async () => {
		mount("/suga/bots");

		expect(await screen.findByRole("button", { name: "New bot" })).toBeDefined();
		cleanup();
		vi.clearAllMocks();

		apiAnswers({ role: "editor" });
		mount("/suga/bots");

		expect(await screen.findByRole("button", { name: "New bot" })).toBeDefined();
	});

	it("keeps deleting projects to those allowed them", async () => {
		mount(`/suga/projects/${projects[0]?.slug}/settings`);

		expect(await screen.findByRole("button", { name: "Delete project" })).toBeDefined();
		cleanup();
		vi.clearAllMocks();

		apiAnswers({ role: "viewer" });
		mount(`/suga/projects/${projects[0]?.slug}/settings`);
		await screen.findByRole("heading", { name: projects[0]?.name });

		expect(screen.queryByRole("button", { name: "Delete project" })).toBeNull();
	});

	it("creates a bot with the avatar and colour chosen, and opens it", async () => {
		onWideScreen();
		const made = {
			...linear,
			id: "0199a3a0-0000-7000-8000-0000000000c9",
			name: "Release Coordinator",
			handle: "release-coordinator",
			model: MODELS[0] as string,
		};
		client.api.bots.create.mockReturnValue(Effect.succeed(made));
		const { router } = mount("/suga/bots");
		(await screen.findByRole("button", { name: "New bot" })).click();

		const dialog = await screen.findByRole("dialog", { name: "New bot" });
		fireEvent.change(within(dialog).getByLabelText("Name"), {
			target: { value: `  ${made.name}  ` },
		});
		fireEvent.click(within(dialog).getByRole("button", { name: "Colour, shape and eyes" }));
		fireEvent.click(within(dialog).getByRole("radio", { name: "orange" }));
		fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
		client.api.bots.list.mockReturnValue(Effect.succeed([...bots, made]));
		within(dialog).getByRole("button", { name: "Create" }).click();

		await waitFor(() => {
			expect(client.api.bots.create).toHaveBeenCalledWith({
				params: { workspace: workspace.id },
				// The avatars on offer are drawn at random; the colour is the one chosen.
				payload: {
					name: made.name,
					model: made.model,
					visibility: "public",
					color: "orange",
					shape: expect.any(String),
					eyes: expect.any(String),
				},
			});
		});
		await waitFor(() =>
			expect(router.state.location.pathname.startsWith(`/suga/bots/${made.handle}`)).toBe(true),
		);
		expect(screen.queryByRole("dialog", { name: "New bot" })).toBeNull();
		expect((await screen.findAllByText(made.name)).length).toBeGreaterThan(0);
	});

	it("on a phone, chooses the avatar on a page of its own, from the bot's face", async () => {
		client.api.bots.create.mockReturnValue(Effect.succeed({ ...linear, name: "Scout" }));
		mount("/suga/bots");
		(await screen.findByRole("button", { name: "New bot" })).click();

		const dialog = await screen.findByRole("dialog", { name: "New bot" });
		fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Scout" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Change the avatar" }));
		// The avatar's page has Back where the page had Close, and no Create.
		expect(within(dialog).queryByRole("button", { name: "Create" })).toBeNull();
		fireEvent.click(within(dialog).getByRole("radio", { name: "orange" }));
		fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
		within(dialog).getByRole("button", { name: "Create" }).click();

		await waitFor(() =>
			expect(client.api.bots.create).toHaveBeenCalledWith(
				expect.objectContaining({
					payload: expect.objectContaining({ name: "Scout", color: "orange" }),
				}),
			),
		);
	});

	it("keeps a duplicate-name error in the creation form", async () => {
		client.api.bots.create.mockReturnValue(
			Effect.fail(new Conflict({ message: userText`already exists` })),
		);
		mount("/suga/bots");
		(await screen.findByRole("button", { name: "New bot" })).click();

		const dialog = await screen.findByRole("dialog", { name: "New bot" });
		fireEvent.change(within(dialog).getByLabelText("Name"), {
			target: { value: linear.name },
		});
		within(dialog).getByRole("button", { name: "Create" }).click();

		expect((await within(dialog).findByRole("alert")).textContent).toContain(
			"A bot with that name already exists",
		);
		expect(screen.getByRole("dialog", { name: "New bot" })).toBeDefined();
	});
});

describe("workspace settings", () => {
	const [openai, anthropic] = modelProviders as [ModelProvider, ModelProvider];
	const providerPage = (provider: { id: string }) => `/suga/settings/providers/${provider.id}`;

	it("lists a connected provider as Connected, and opens it", async () => {
		const { router } = mount("/suga/settings/providers");

		const row = await screen.findByRole("link", { name: /Anthropic/ });
		expect(row.textContent).toContain("API key set");
		expect(row.textContent).toContain("Connected");
		fireEvent.click(row);

		await waitFor(() => expect(router.state.location.pathname).toBe(providerPage(anthropic)));
		expect(await screen.findByRole("heading", { name: "Anthropic" })).toBeDefined();
	});

	it("switches a model off without moving it", async () => {
		// One that neither new bots nor the system bots use, which would hold it on.
		const model = {
			...(anthropic.models[0] as ProviderModel),
			id: "0199a3a0-0000-7000-8000-0000000000d3",
			modelId: "claude-haiku-4-5",
		};
		client.api.modelProviders.list.mockReturnValue(
			Effect.succeed([openai, { ...anthropic, models: [...anthropic.models, model] }]),
		);
		client.api.modelProviders.updateModel.mockReturnValue(Effect.void);
		mount(providerPage(anthropic));

		const toggle = await screen.findByRole("switch", { name: `Bots can use ${model.modelId}` });
		await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
		fireEvent.click(toggle);

		await waitFor(() =>
			expect(client.api.modelProviders.updateModel).toHaveBeenCalledWith({
				params: { workspace: workspace.id, providerId: anthropic.id, modelId: model.id },
				payload: { enabled: false },
			}),
		);
	});

	it("asks for the bots again once a model is switched on, which may give Personal Assistants theirs", async () => {
		const model = {
			...(anthropic.models[0] as ProviderModel),
			id: "0199a3a0-0000-7000-8000-0000000000d3",
			modelId: "claude-haiku-4-5",
			enabled: false,
		};
		client.api.modelProviders.list.mockReturnValue(
			Effect.succeed([openai, { ...anthropic, models: [...anthropic.models, model] }]),
		);
		client.api.modelProviders.updateModel.mockReturnValue(Effect.void);
		mount(providerPage(anthropic));
		const toggle = await screen.findByRole("switch", { name: `Bots can use ${model.modelId}` });
		await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
		const botsAsked = client.api.bots.list.mock.calls.length;

		fireEvent.click(toggle);

		await waitFor(() => expect(client.api.modelProviders.updateModel).toHaveBeenCalled());
		await waitFor(() => expect(client.api.bots.list.mock.calls.length).toBeGreaterThan(botsAsked));
	});

	it("shows the system bots' model, and sets it for all of them at once", async () => {
		client.api.systemBots.update.mockReturnValue(Effect.succeed(systemBots[0]));
		const { router } = mount("/suga/settings/providers");

		fireEvent.click(await screen.findByRole("link", { name: /Compaction/ }));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/suga/settings/providers/system"),
		);
		fireEvent.click(await screen.findByRole("button", { name: "gpt-5" }));

		await waitFor(() => {
			for (const key of ["compact"]) {
				expect(client.api.systemBots.update).toHaveBeenCalledWith({
					params: { workspace: workspace.id, key },
					payload: { model: "gpt-5" },
				});
			}
		});
	});

	const ollama = {
		...openai,
		id: "0199a3a0-0000-7000-8000-0000000000da",
		builtIn: "ollama" as const,
		name: "Ollama",
		baseUrl: "http://127.0.0.1:11434/v1",
		hasApiKey: false,
		status: "untested" as const,
		models: [],
	};

	function mountOllama(provider: typeof ollama = ollama) {
		client.api.modelProviders.list.mockReturnValue(Effect.succeed([provider]));
		client.api.modelProviders.update.mockReturnValue(Effect.succeed(provider));
		mount(providerPage(provider));
	}

	const patched = () => client.api.modelProviders.update;

	it("shows a server you run by its address, with no key needed", async () => {
		mountOllama();

		expect(await screen.findByText(ollama.baseUrl)).toBeDefined();
		expect(screen.getByText("None")).toBeDefined();
		expect(screen.getByRole("button", { name: "Refresh list" }).hasAttribute("disabled")).toBe(
			false,
		);
	});

	it("saves the server somebody types, completing it into a base URL", async () => {
		mountOllama();

		fireEvent.click(await screen.findByRole("button", { name: "Change" }));
		const serverUrl = screen.getByLabelText("Server URL") as HTMLInputElement;
		expect(serverUrl.value).toBe(ollama.baseUrl);
		fireEvent.change(serverUrl, { target: { value: "studio.local:9000" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => {
			expect(patched()).toHaveBeenCalledWith({
				params: { workspace: workspace.id, providerId: ollama.id },
				payload: { baseUrl: "http://studio.local:9000/v1" },
			});
		});
	});

	it("refuses to save an address it cannot read, and says so", async () => {
		mountOllama();

		fireEvent.click(await screen.findByRole("button", { name: "Change" }));
		fireEvent.change(screen.getByLabelText("Server URL"), {
			target: { value: "my ollama server" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(await screen.findByText(/not a server address/)).toBeDefined();
		expect(patched()).not.toHaveBeenCalled();
	});

	it("removes a key that was set, rather than only replacing it", async () => {
		mountOllama({ ...ollama, hasApiKey: true });

		fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

		await waitFor(() => {
			expect(patched()).toHaveBeenCalledWith({
				params: { workspace: workspace.id, providerId: ollama.id },
				payload: { apiKey: null },
			});
		});
	});

	it("adds a custom provider, which needs no key", async () => {
		const provider = {
			...openai,
			id: "0199a3a0-0000-7000-8000-0000000000cf",
			builtIn: null,
			name: "Local gateway",
			baseUrl: "http://localhost:11434/v1",
			hasApiKey: false,
			status: "missing_key" as const,
			models: [],
		};
		client.api.modelProviders.create.mockReturnValue(Effect.succeed(provider));
		const { router } = mount("/suga/settings/providers");

		fireEvent.click(await screen.findByRole("button", { name: /^Add a provider/ }));
		const dialog = await screen.findByRole("dialog", { name: "Add provider" });
		fireEvent.click(within(dialog).getByRole("button", { name: /Custom provider/ }));
		const step = await screen.findByRole("dialog", { name: "Custom provider" });
		fireEvent.change(within(step).getByLabelText("Name"), { target: { value: provider.name } });
		fireEvent.change(within(step).getByLabelText("Server URL"), {
			target: { value: provider.baseUrl },
		});
		fireEvent.click(within(step).getByRole("radio", { name: "Anthropic" }));
		fireEvent.click(within(step).getByRole("button", { name: "Add" }));

		await waitFor(() => {
			expect(client.api.modelProviders.create).toHaveBeenCalledWith({
				params: { workspace: workspace.id },
				payload: {
					name: provider.name,
					baseUrl: provider.baseUrl,
					apiFormat: "anthropic",
					apiKey: undefined,
					customHeaders: [],
				},
			});
		});
		await waitFor(() => expect(router.state.location.pathname).toBe(providerPage(provider)));
	});

	it("offers the built-in providers, minus what is connected, and adds one by its key", async () => {
		const groq = {
			...openai,
			id: "0199a3a0-0000-7000-8000-0000000000d1",
			builtIn: "groq" as const,
			name: "Groq",
			baseUrl: "https://api.groq.com/openai/v1",
			models: [],
		};
		client.api.modelProviders.create.mockReturnValue(Effect.succeed(groq));
		mount("/suga/settings/providers");

		fireEvent.click(await screen.findByRole("button", { name: /^Add a provider/ }));
		const dialog = await screen.findByRole("dialog", { name: "Add provider" });
		expect(within(dialog).queryByRole("button", { name: /^OpenAI/ })).toBeNull();

		fireEvent.click(within(dialog).getByRole("button", { name: /^Groq/ }));
		const step = await screen.findByRole("dialog", { name: "Groq" });
		const add = within(step).getByRole("button", { name: "Add" });
		expect(add.hasAttribute("disabled")).toBe(true);
		fireEvent.change(within(step).getByLabelText("API key"), { target: { value: "gsk-test" } });
		fireEvent.click(add);

		await waitFor(() => {
			expect(client.api.modelProviders.create).toHaveBeenCalledWith({
				params: { workspace: workspace.id },
				payload: { builtIn: "groq", apiKey: "gsk-test" },
			});
		});
	});

	it("reconnects a starting provider that was disconnected, rather than making another", async () => {
		client.api.modelProviders.list.mockReturnValue(
			Effect.succeed([{ ...openai, active: false, hasApiKey: false }, anthropic]),
		);
		client.api.modelProviders.update.mockReturnValue(Effect.succeed(openai));
		mount("/suga/settings/providers");

		fireEvent.click(await screen.findByRole("button", { name: /^Add a provider/ }));
		const dialog = await screen.findByRole("dialog", { name: "Add provider" });
		fireEvent.click(within(dialog).getByRole("button", { name: /^OpenAI/ }));
		const step = await screen.findByRole("dialog", { name: "OpenAI" });
		fireEvent.change(within(step).getByLabelText("API key"), { target: { value: "sk-new" } });
		fireEvent.click(within(step).getByRole("button", { name: "Add" }));

		await waitFor(() =>
			expect(patched()).toHaveBeenCalledWith({
				params: { workspace: workspace.id, providerId: openai.id },
				payload: { active: true, apiKey: "sk-new" },
			}),
		);
		expect(client.api.modelProviders.create).not.toHaveBeenCalled();
	});

	it("always lists the popular providers, with Connect opening straight to the one's key", async () => {
		client.api.modelProviders.list.mockReturnValue(
			Effect.succeed([{ ...openai, active: false, hasApiKey: false }, anthropic]),
		);
		client.api.modelProviders.update.mockReturnValue(Effect.succeed(openai));
		mount("/suga/settings/providers");

		const providers = await screen.findByRole("region", { name: "Providers" });
		await within(providers).findByText("API key set");
		// OpenRouter and Gemini aren't in the workspace at all, and are listed anyway.
		for (const name of ["OpenRouter", "OpenAI", "Google Gemini"]) {
			expect(within(providers).getByText(name)).toBeDefined();
		}
		expect(within(providers).getAllByText("Not connected")).toHaveLength(3);
		const connects = within(providers).getAllByRole("button", { name: "Connect" });
		expect(connects).toHaveLength(3);
		// Connected first: Anthropic leads the ones still to connect, though it is second of the popular four.
		const anthropicRow = within(providers).getByRole("link", { name: /^Anthropic/ });
		expect(
			anthropicRow.compareDocumentPosition(connects[0] as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();

		// Then OpenRouter, OpenAI, Gemini, still to connect: the second Connect is OpenAI's.
		fireEvent.click(connects[1] as HTMLElement);
		const step = await screen.findByRole("dialog", { name: "OpenAI" });
		fireEvent.change(within(step).getByLabelText("API key"), { target: { value: "sk-new" } });
		fireEvent.click(within(step).getByRole("button", { name: "Add" }));

		await waitFor(() =>
			expect(patched()).toHaveBeenCalledWith({
				params: { workspace: workspace.id, providerId: openai.id },
				payload: { active: true, apiKey: "sk-new" },
			}),
		);
	});

	it("disconnects a starting provider by taking its key away, after asking", async () => {
		client.api.modelProviders.update.mockReturnValue(Effect.succeed(openai));
		const { router } = mount(providerPage(openai));

		fireEvent.click(await screen.findByRole("button", { name: "Disconnect OpenAI" }));
		expect(await screen.findByRole("heading", { name: "Disconnect OpenAI?" })).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

		await waitFor(() =>
			expect(patched()).toHaveBeenCalledWith({
				params: { workspace: workspace.id, providerId: openai.id },
				payload: { active: false, apiKey: null },
			}),
		);
		expect(client.api.modelProviders.remove).not.toHaveBeenCalled();
		await waitFor(() => expect(router.state.location.pathname).toBe("/suga/settings/providers"));
	});

	it("replaces a key, and says where a provider test failed", async () => {
		client.api.modelProviders.test.mockReturnValue(
			Effect.fail(new InternalServerError({ message: userText`Provider unavailable` })),
		);
		mount(providerPage(openai));

		fireEvent.click(await screen.findByRole("button", { name: "Replace" }));
		expect(screen.getByLabelText("OpenAI API key")).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		fireEvent.click(screen.getByRole("button", { name: "Test provider" }));

		expect((await screen.findByRole("alert")).textContent).toContain("Provider unavailable");
		expect(screen.getByRole("button", { name: "Test provider" }).hasAttribute("disabled")).toBe(
			false,
		);
	});

	it("keeps a manual model form open when adding the model fails", async () => {
		const custom = {
			...openai,
			id: "0199a3a0-0000-7000-8000-0000000000cf",
			builtIn: null,
			name: "Local gateway",
			baseUrl: "http://localhost:11434/v1",
			models: [],
		};
		client.api.modelProviders.list.mockReturnValue(Effect.succeed([custom]));
		client.api.modelProviders.addModel.mockReturnValue(
			Effect.fail(new InternalServerError({ message: userText`Could not add model` })),
		);
		mount(providerPage(custom));
		fireEvent.click(await screen.findByRole("button", { name: "Add model" }));
		fireEvent.change(screen.getByLabelText("Model ID"), {
			target: { value: "local-model" },
		});

		fireEvent.click(screen.getByRole("button", { name: "Add" }));

		expect((await screen.findByRole("alert")).textContent).toContain("Could not add model");
		expect((screen.getByLabelText("Model ID") as HTMLInputElement).value).toBe("local-model");
	});

	const openInvitePeoplePanel = async () => {
		fireEvent.click(await screen.findByRole("button", { name: "Invite people" }));
		return screen.findByRole("dialog", { name: "Invite people" });
	};

	it("dims the page behind a dialog a screen opens", async () => {
		// The navigation drawer is a dialog too. While it wrapped the screens,
		// Base UI read every dialog they opened as nested and dropped its
		// backdrop, leaving the page behind undimmed and unblurred.
		mount("/suga/settings/people");
		const dialog = await openInvitePeoplePanel();

		expect(dialog.ownerDocument.querySelector('[data-slot="dialog-overlay"]')).not.toBeNull();
	});

	const junoPage = "/suga/settings/people/0199a3a0-0000-7000-8000-0000000000d2";
	const samPage = "/suga/settings/people/0199a3a0-0000-7000-8000-0000000000d1";

	it("invites every address typed, with the role chosen", async () => {
		client.api.workspaces.invite.mockReturnValue(Effect.succeed({ id: "an-invitation" }));
		mount("/suga/settings/people");
		const panel = await openInvitePeoplePanel();

		fireEvent.change(within(panel).getByLabelText("Email addresses"), {
			target: { value: "juno@example.com, kim@example.com" },
		});
		expect(
			within(panel).getByText("Makes bots and projects, and works with the public bots."),
		).toBeDefined();
		fireEvent.click(within(panel).getByRole("radio", { name: "Viewer" }));
		expect(
			within(panel).getByText("Reads and takes part in projects and with public bots."),
		).toBeDefined();
		fireEvent.click(within(panel).getByRole("button", { name: "Send" }));

		await waitFor(() => {
			expect(client.api.workspaces.invite).toHaveBeenCalledWith({
				params: { workspace: workspace.id },
				payload: { email: "juno@example.com", role: "viewer", resend: undefined },
			});
			expect(client.api.workspaces.invite).toHaveBeenCalledWith(
				expect.objectContaining({
					payload: expect.objectContaining({ email: "kim@example.com", role: "viewer" }),
				}),
			);
		});
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Invite people" })).toBeNull());
	});

	it("keeps only the addresses that were refused, saying why", async () => {
		client.api.workspaces.invite.mockImplementation(
			({ payload }: { payload: { email: string } }) =>
				payload.email === "kim@example.com"
					? Effect.die(new Error("Offline"))
					: Effect.succeed({ id: "an-invitation" }),
		);
		mount("/suga/settings/people");
		const panel = await openInvitePeoplePanel();
		const emails = within(panel).getByLabelText("Email addresses");
		fireEvent.change(emails, { target: { value: "juno@example.com kim@example.com" } });

		fireEvent.click(within(panel).getByRole("button", { name: "Send" }));

		expect((await within(panel).findByRole("alert")).textContent).toContain("kim@example.com");
		expect((emails as HTMLInputElement).value).toBe("kim@example.com");
	});

	it("lists each person with their role, and opens their page", async () => {
		const { router } = mount("/suga/settings/people");

		const row = await screen.findByRole("link", { name: new RegExp(juno.name) });
		expect(row.textContent).toContain("Editor");
		expect(screen.getByRole("link", { name: new RegExp(sam.name) }).textContent).toContain("(you)");
		fireEvent.click(row);

		await waitFor(() => expect(router.state.location.pathname).toBe(junoPage));
		expect(await screen.findByRole("heading", { name: juno.name })).toBeDefined();
	});

	it("changes what somebody may do from their page", async () => {
		mount(junoPage);

		fireEvent.click(await screen.findByRole("radio", { name: "Viewer" }));

		await waitFor(() => {
			expect(client.api.workspaces.changeRole).toHaveBeenCalledWith({
				params: { workspace: workspace.id, membershipId: "0199a3a0-0000-7000-8000-0000000000d2" },
				payload: { role: "viewer" },
			});
		});
	});

	it("puts somebody in a project from their page", async () => {
		client.api.projects.addMember.mockReturnValue(Effect.void);
		mount(junoPage);

		const toggle = await screen.findByRole("switch", { name: `${juno.name} is in Suga-Team` });
		// Disabled until the project's people have loaded.
		await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
		fireEvent.click(toggle);

		await waitFor(() =>
			expect(client.api.projects.addMember).toHaveBeenCalledWith({
				params: { projectId: projects[0]?.id },
				payload: { personId: juno.id },
			}),
		);
	});

	it("asks before removing somebody, says what goes with them, and returns to the list", async () => {
		const { router } = mount(junoPage);

		fireEvent.click(await screen.findByRole("button", { name: "Remove from workspace" }));

		expect(await screen.findByRole("heading", { name: `Remove ${juno.name}?` })).toBeDefined();
		expect(screen.getByText(/their Personal Assistant and its chats are deleted/)).toBeDefined();
		expect(client.api.workspaces.removeMembership).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Remove" }));

		await waitFor(() => {
			expect(client.api.workspaces.removeMembership).toHaveBeenCalledWith({
				params: { workspace: workspace.id, membershipId: "0199a3a0-0000-7000-8000-0000000000d2" },
			});
		});
		await waitFor(() => expect(router.state.location.pathname).toBe("/suga/settings/people"));
	});

	it("offers leaving on your own page, and no way to change your own role", async () => {
		mount(samPage);

		expect(await screen.findByRole("heading", { name: sam.name })).toBeDefined();
		expect(screen.queryByRole("radio", { name: "Viewer" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Remove from workspace" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Leave workspace" }));

		expect(await screen.findByRole("heading", { name: "Leave this workspace?" })).toBeDefined();
		expect(screen.getByText(/somebody inviting you again/)).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Leave" }));

		await waitFor(() => {
			expect(client.api.workspaces.leave).toHaveBeenCalledWith({
				params: { workspace: workspace.id },
			});
		});
	});

	it("lists an invitation that has not been accepted, and can withdraw it", async () => {
		mount("/suga/settings/people");

		expect(await screen.findByText("dana@example.com")).toBeDefined();
		fireEvent.click(
			screen.getByRole("button", { name: "Revoke the invitation for dana@example.com" }),
		);

		await waitFor(() => {
			expect(client.api.workspaces.cancelInvitation).toHaveBeenCalledWith({
				params: { invitationId: "0199a3a0-0000-7000-8000-0000000000e1" },
			});
		});
	});

	it("sends an invitation again without retyping it", async () => {
		client.api.workspaces.invite.mockReturnValue(Effect.succeed({ id: "an-invitation" }));
		mount("/suga/settings/people");

		await screen.findByText("dana@example.com");
		fireEvent.click(screen.getByRole("button", { name: "Resend" }));

		await waitFor(() => {
			expect(client.api.workspaces.invite).toHaveBeenCalledWith({
				params: { workspace: workspace.id },
				payload: { email: "dana@example.com", role: "viewer", resend: true },
			});
		});
		expect(await screen.findByText("Sent again")).toBeDefined();
	});

	it("shows an editor who holds what, and no way to change it", async () => {
		apiAnswers({ role: "editor" });
		mount("/suga/settings/people");

		expect(
			(await screen.findByRole("link", { name: new RegExp(juno.name) })).textContent,
		).toContain("Editor");
		expect(screen.queryByRole("button", { name: "Invite people" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Resend" })).toBeNull();
		cleanup();

		mount(junoPage);
		expect(await screen.findByRole("heading", { name: juno.name })).toBeDefined();
		expect(screen.queryByRole("radio", { name: "Viewer" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Remove from workspace" })).toBeNull();
		expect(
			(await screen.findByRole("switch", { name: `${juno.name} is in Suga-Team` })).hasAttribute(
				"disabled",
			),
		).toBe(true);
	});

	it("lets somebody with no workspace start their first one, in their own time zone", async () => {
		onWideScreen();
		const browserOptions = new Intl.DateTimeFormat().resolvedOptions();
		const browser = vi
			.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
			.mockReturnValue({ ...browserOptions, timeZone: "Australia/Sydney" });
		onTestFinished(() => browser.mockRestore());
		client.api.workspaces.list.mockReturnValue(Effect.succeed([]));
		client.api.workspaces.create.mockReturnValue(
			Effect.succeed({
				id: "0199a3a0-0000-7000-8000-0000000000f9",
				name: "Nitric",
				slug: "nitric",
				timeZone: "Australia/Sydney",
			}),
		);
		const { router } = mount("/suga/settings");

		fireEvent.change(await screen.findByLabelText("Workspace name"), {
			target: { value: "Nitric" },
		});
		(await screen.findByRole("button", { name: "Continue" })).click();

		await waitFor(() => {
			expect(router.state.location.pathname).toBe("/workspace-setup");
			expect(client.api.workspaces.create).toHaveBeenCalledWith({
				payload: { name: "Nitric", slug: "nitric", timeZone: "Australia/Sydney" },
			});
		});
	});

	it("keeps a rejected workspace name and creation form open", async () => {
		onWideScreen();
		client.api.workspaces.list.mockReturnValue(Effect.succeed([]));
		client.api.workspaces.create.mockReturnValue(Effect.die(new Error("Offline")));
		mount("/suga/settings");
		const name = await screen.findByLabelText("Workspace name");
		fireEvent.change(name, { target: { value: "Nitric" } });

		fireEvent.click(screen.getByRole("button", { name: "Continue" }));

		expect((await screen.findByRole("alert")).textContent).toContain("Could not reach the API");
		expect((name as HTMLInputElement).value).toBe("Nitric");
		expect(screen.getByRole("button", { name: "Continue" })).toBeDefined();
	});
});

describe("settings on a phone", () => {
	it("opens the You tab's Settings: you first, then the workspace's sections", async () => {
		mount("/suga/settings");

		// The sidebar is drawn too, if hidden on a phone, so these look inside the tab's page.
		const settings = await screen.findByRole("region", { name: "Settings" });
		expect(
			(await within(settings).findByRole("link", { name: new RegExp(sam.name) })).getAttribute(
				"href",
			),
		).toBe("/suga/settings/account");
		expect(within(settings).getByRole("link", { name: "General" }).getAttribute("href")).toBe(
			"/suga/settings/general",
		);
		expect(
			within(settings)
				.getByRole("link", { name: /^People/ })
				.getAttribute("href"),
		).toBe("/suga/settings/people");
	});

	it("lists Notifications under your account, and leads from it back there", async () => {
		mount("/suga/settings/account");

		const account = await screen.findByRole("main");
		expect(
			(await within(account).findByRole("link", { name: "Notifications" })).getAttribute("href"),
		).toBe("/suga/settings/notifications");
		expect(within(account).getByRole("link", { name: "Settings" }).getAttribute("href")).toBe(
			"/suga/you",
		);
		cleanup();

		mount("/suga/settings/notifications");
		const notifications = await screen.findByRole("main");
		expect(
			(await within(notifications).findByRole("link", { name: "You" })).getAttribute("href"),
		).toBe("/suga/settings/account");
	});

	it("opens General by name, with the way back to Settings", async () => {
		mount("/suga/settings/general");

		expect(await screen.findByText("Time zone")).toBeDefined();
		const page = screen.getByRole("main");
		expect(within(page).getByRole("link", { name: "Settings" }).getAttribute("href")).toBe(
			"/suga/you",
		);
	});
});

describe("the theme", () => {
	// Chosen under your account, since it is yours rather than the workspace's.
	it("is dark until something is chosen", async () => {
		onWideScreen();
		mount("/suga/settings/account");

		const theme = await screen.findByRole("group", { name: "Theme" });
		expect((within(theme).getByRole("radio", { name: "Dark" }) as HTMLInputElement).checked).toBe(
			true,
		);
		expect(document.documentElement.dataset.theme).toBeUndefined();
	});

	it("is chosen in settings, and remembered", async () => {
		onWideScreen();
		mount("/suga/settings/account");

		fireEvent.click(await screen.findByRole("radio", { name: "Light" }));

		await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
		expect(localStorage.getItem("sugabots-theme")).toBe("light");
	});

	it("stores nothing when dark is chosen, because that is the default", async () => {
		onWideScreen();
		localStorage.setItem("sugabots-theme", "light");
		mount("/suga/settings/account");

		fireEvent.click(await screen.findByRole("radio", { name: "Dark" }));

		await waitFor(() => expect(document.documentElement.dataset.theme).toBeUndefined());
		expect(localStorage.getItem("sugabots-theme")).toBeNull();
	});
});

describe("your account", () => {
	it("signs out, and re-asks who you are", async () => {
		client.auth.signOut.mockResolvedValue(undefined);
		const refresh = vi.fn();
		mount("/suga/settings/account", { refresh });

		fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

		await waitFor(() => expect(client.auth.signOut).toHaveBeenCalled());
		// Dropping the token is not enough on its own: the guard reads the
		// session, so it has to be asked again before the route can send
		// anybody to the sign-in page.
		await waitFor(() => expect(refresh).toHaveBeenCalled());
	});

	it("changes your name when you leave the field, and re-asks who you are", async () => {
		client.auth.updateName.mockResolvedValue({ status: true });
		const refresh = vi.fn();
		mount("/suga/settings/account", { refresh });

		const name = await screen.findByRole("textbox", { name: "Name" });
		fireEvent.change(name, { target: { value: "  Samantha " } });
		fireEvent.blur(name);

		await waitFor(() => expect(client.auth.updateName).toHaveBeenCalledWith({ name: "Samantha" }));
		await waitFor(() => expect(refresh).toHaveBeenCalled());
	});

	it("shows your new name once the session has it, without a navigation", async () => {
		const router = createAppRouter({
			history: createMemoryHistory({ initialEntries: ["/suga/settings/account"] }),
		});
		const queries = createQueryClient();
		const signedInAs = (signedIn: SignedInPerson) => (
			<TestApp
				router={router}
				queries={queries}
				session={{ person: signedIn, error: undefined, refresh: vi.fn() }}
			/>
		);
		const { rerender } = render(signedInAs(sam));
		expect(await screen.findByRole("heading", { name: sam.name })).toBeDefined();

		rerender(signedInAs({ ...sam, name: "Samantha" }));

		expect(await screen.findByRole("heading", { name: "Samantha" })).toBeDefined();
	});

	it("puts your name back, and says why, when the change is refused", async () => {
		const refusal = "That name can't be used.";
		client.auth.updateName.mockRejectedValue(
			failureForStatus(400, UserText.unchecked(refusal), "INVALID_NAME"),
		);
		mount("/suga/settings/account");

		const name = await screen.findByRole("textbox", { name: "Name" });
		fireEvent.change(name, { target: { value: "Samantha" } });
		fireEvent.blur(name);

		expect(await screen.findByText(refusal)).toBeDefined();
		expect((name as HTMLInputElement).value).toBe(sam.name);
	});
});

describe("project settings", () => {
	const [suga] = projects;
	if (!suga) throw new Error("fixture");
	const projectPage = `/suga/projects/${suga.slug}/settings`;
	const botsPage = `${projectPage}/bots`;
	const peoplePage = `${projectPage}/people`;
	const samInProject = {
		personId: sam.id,
		name: sam.name,
		email: sam.email,
		image: null,
		// Sam administers the workspace, so is in every project for good.
		removable: false,
	};
	const junoInProject = {
		...samInProject,
		personId: juno.id,
		name: juno.name,
		email: juno.email,
		removable: true,
	};
	it("lists only the project's own bots, with nothing to say about system bots", async () => {
		mount(botsPage);

		// The sidebar names each bot too, by a link to its project.
		const settings = await screen.findByRole("main");
		// Each row reads as the bot's name, then what it does.
		expect(
			await within(settings).findByRole("link", { name: new RegExp(`^${linear.name}`) }),
		).toBeDefined();
		expect(screen.queryByText("User bots")).toBeNull();
		expect(screen.queryByText("System bots")).toBeNull();
		expect(screen.queryByRole("link", { name: new RegExp(compaction.name) })).toBeNull();
	});

	it("takes a bot out of the project with a button beside its name, not inside its link", async () => {
		client.api.projects.removeBot.mockReturnValue(Effect.void);
		mount(botsPage);

		const remove = await screen.findByRole("button", { name: `Remove ${linear.name}` });
		expect(remove.closest("a")).toBeNull();
		fireEvent.click(remove);

		await waitFor(() =>
			expect(client.api.projects.removeBot).toHaveBeenCalledWith({
				params: { projectId: suga.id, botId: linear.id },
			}),
		);
	});

	it("adds somebody from the workspace", async () => {
		client.api.projects.addMember.mockReturnValue(Effect.void);
		mount(peoplePage);

		open(await screen.findByRole("button", { name: "Add people" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: sam.name }));

		await waitFor(() =>
			expect(client.api.projects.addMember).toHaveBeenCalledWith({
				params: { projectId: suga.id },
				payload: { personId: sam.id },
			}),
		);
	});

	it("asks before removing somebody from the project", async () => {
		client.api.projects.listMembers.mockImplementation(() =>
			Effect.succeed([samInProject, junoInProject]),
		);
		client.api.projects.removeMember.mockReturnValue(Effect.void);
		mount(peoplePage);

		fireEvent.click(await screen.findByRole("button", { name: `Remove ${juno.name}` }));

		expect(
			await screen.findByRole("dialog", { name: `Remove ${juno.name} from ${suga.name}?` }),
		).toBeDefined();
		expect(client.api.projects.removeMember).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Remove" }));

		await waitFor(() =>
			expect(client.api.projects.removeMember).toHaveBeenCalledWith({
				params: { projectId: suga.id, personId: juno.id },
			}),
		);
	});

	// Sam is signed in, and an administrator unless a case says otherwise.
	it("gives an administrator no way off a project", async () => {
		client.api.projects.listMembers.mockImplementation(() =>
			Effect.succeed([samInProject, junoInProject]),
		);
		mount(peoplePage);

		expect(await screen.findByRole("button", { name: `Remove ${juno.name}` })).toBeDefined();
		expect(screen.queryByRole("button", { name: `Leave ${suga.name}` })).toBeNull();
		expect(screen.queryByRole("button", { name: `Remove ${sam.name}` })).toBeNull();
	});

	it("lets an editor leave a project, and nothing more", async () => {
		apiAnswers({ role: "editor" });
		client.api.projects.listMembers.mockImplementation(() =>
			Effect.succeed([samInProject, junoInProject]),
		);
		client.api.projects.leave.mockReturnValue(Effect.void);
		mount(peoplePage);

		fireEvent.click(await screen.findByRole("button", { name: `Leave ${suga.name}` }));
		expect(screen.queryByRole("button", { name: `Remove ${juno.name}` })).toBeNull();

		expect(await screen.findByRole("dialog", { name: `Leave ${suga.name}?` })).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Leave" }));

		await waitFor(() =>
			expect(client.api.projects.leave).toHaveBeenCalledWith({ params: { projectId: suga.id } }),
		);
	});

	it("says when everyone in the workspace is already in", async () => {
		client.api.projects.listMembers.mockImplementation(() =>
			Effect.succeed([samInProject, junoInProject]),
		);
		mount(peoplePage);

		open(await screen.findByRole("button", { name: "Add people" }));

		expect(
			await screen.findByRole("menuitem", {
				name: "Everyone in the workspace is here.",
			}),
		).toBeDefined();
	});

	it("offers a viewer the lists and none of the controls", async () => {
		apiAnswers({ role: "viewer" });
		client.api.projects.listMembers.mockImplementation(() => Effect.succeed([samInProject]));
		mount(botsPage);
		expect(await within(await screen.findByRole("main")).findByText(linear.name)).toBeDefined();
		cleanup();

		mount(peoplePage);
		expect(await within(await screen.findByRole("main")).findByText(sam.name)).toBeDefined();
		expect(screen.queryByRole("button", { name: "Add people" })).toBeNull();
		expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
		cleanup();

		mount(projectPage);
		await screen.findByRole("heading", { name: suga.name });
		expect(screen.queryByRole("button", { name: "Delete project" })).toBeNull();
		expect(screen.queryByLabelText("Name")).toBeNull();
	});

	it("deletes the project after asking, and returns to the list", async () => {
		client.api.projects.remove.mockReturnValue(Effect.void);
		const { router } = mount(projectPage);

		fireEvent.click(await screen.findByRole("button", { name: "Delete project" }));
		expect(client.api.projects.remove).not.toHaveBeenCalled();
		fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

		await waitFor(() =>
			expect(client.api.projects.remove).toHaveBeenCalledWith({
				params: { projectId: suga.id },
			}),
		);
		await waitFor(() => expect(router.state.location.pathname).toBe("/suga/projects"));
	});

	it("says so when a project with chats cannot be deleted", async () => {
		client.api.projects.remove.mockReturnValue(
			Effect.fail(new Conflict({ message: userText`The project still has chats` })),
		);
		mount(projectPage);

		fireEvent.click(await screen.findByRole("button", { name: "Delete project" }));
		fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

		expect(await screen.findByRole("alert")).toBeDefined();
	});
});

describe("the app's badge", () => {
	const project = projects[0] as (typeof projects)[number];
	const waitingApproval: ApprovalRequest = {
		call: {
			type: "tool_call",
			id: "0199a3a0-0000-7000-8000-0000000004c1",
			tool: "linear__update_issue",
			input: { team: "Platform" },
			output: null,
			status: "awaiting_approval",
			error: null,
			writeOrDelete: true,
			atOffset: 0,
			startedAt: "2026-09-18T09:00:00.000Z",
			finishedAt: null,
			approval: { status: "pending", decidedByName: null, decidedAt: null },
		},
		bot: {
			kind: "bot",
			id: linear.id,
			name: linear.name,
			handle: linear.handle,
			color: linear.color,
			eyes: linear.eyes,
			shape: "circle",
		},
		projectId: project.id,
		chatId: "0199a3a0-0000-7000-8000-0000000004b1",
		rootChatId: "0199a3a0-0000-7000-8000-0000000004b1",
	};

	/** The Badging API, which only Chromium browsers have. */
	function badging() {
		const setAppBadge = vi.fn(() => Promise.resolve());
		const clearAppBadge = vi.fn(() => Promise.resolve());
		Object.defineProperties(navigator, {
			setAppBadge: { configurable: true, value: setAppBadge },
			clearAppBadge: { configurable: true, value: clearAppBadge },
		});
		onTestFinished(() => {
			Reflect.deleteProperty(navigator, "setAppBadge");
			Reflect.deleteProperty(navigator, "clearAppBadge");
		});
		return { setAppBadge, clearAppBadge };
	}

	/** The title `index.html` gives the page. */
	function pageTitle() {
		const before = document.title;
		document.title = "Sugabots";
		onTestFinished(() => {
			document.title = before;
		});
	}

	/** Running as an installed app, which Chrome and Edge report as standalone display. */
	function installedApp() {
		const matchMedia = window.matchMedia;
		vi.stubGlobal("matchMedia", (query: string) => ({
			...matchMedia(query),
			matches: query === "(display-mode: standalone)",
		}));
		onTestFinished(() => {
			vi.unstubAllGlobals();
		});
	}

	/** `count` approvals wait on the person, as the API counts them. */
	function approvalsWaiting(count: number) {
		client.api.chats.attention.mockReturnValue(
			Effect.succeed({
				waitingApprovals: count,
				unreadForYou: 0,
			}),
		);
	}

	it("counts approvals waiting on you on the app's icon and in the title", async () => {
		const { setAppBadge } = badging();
		pageTitle();
		approvalsWaiting(1);
		mount(linearPage);

		await waitFor(() => expect(document.title).toBe("(1) Sugabots | Suga Workspace"));
		expect(setAppBadge).toHaveBeenCalledWith(1);
	});

	it("puts the count after the app's name in an installed window, which would otherwise repeat the name", async () => {
		installedApp();
		pageTitle();
		approvalsWaiting(1);
		mount(linearPage);

		await waitFor(() => expect(document.title).toBe("Sugabots | Suga Workspace (1)"));
	});

	it("leaves the icon and the title alone for unread messages that are not for you", async () => {
		const { setAppBadge } = badging();
		pageTitle();
		client.api.chats.attentionMarks.mockReturnValue(
			Effect.succeed({
				projects: {
					[project.id]: { unreadMessages: 2, needsApproval: false, failedAutomations: 0 },
				},
			}),
		);
		mount("/suga/projects");

		const sidebar = await screen.findByRole("navigation", { name: "Sidebar" });
		const projects = within(sidebar).getByRole("group", { name: "Projects" });
		await within(projects).findByText(/2 unread messages/);
		expect(document.title).toBe("Sugabots | Suga Workspace");
		expect(setAppBadge).not.toHaveBeenCalled();
	});

	it("clears the icon and the title once nothing is waiting", async () => {
		const { clearAppBadge } = badging();
		pageTitle();
		const updates = controlledEventStream();
		client.events.workspace.mockReturnValue(updates.stream);
		approvalsWaiting(1);
		mount(linearPage);
		await waitFor(() => expect(document.title).toBe("(1) Sugabots | Suga Workspace"));
		clearAppBadge.mockClear();

		approvalsWaiting(0);
		updates.emit(streamEvent("chat.changed", { chatId: waitingApproval.chatId }));

		await waitFor(() => expect(document.title).toBe("Sugabots | Suga Workspace"));
		expect(clearAppBadge).toHaveBeenCalled();
	});

	it("counts again what is waiting when the workspace's events start over", async () => {
		pageTitle();
		const updates = controlledEventStream();
		client.events.workspace.mockReturnValue(updates.stream);
		approvalsWaiting(1);
		mount(linearPage);
		await waitFor(() => expect(document.title).toBe("(1) Sugabots | Suga Workspace"));

		approvalsWaiting(0);
		updates.emit(streamEvent("reset"));

		await waitFor(() => expect(document.title).toBe("Sugabots | Suga Workspace"));
	});
});
