import {
	type ApprovalRequest,
	type ModelProvider,
	type ProviderModel,
	type Run,
	type SessionUser,
	streamEvent,
} from "@sugabots/contracts";
import { Conflict, Forbidden, InternalServerError } from "@sugabots/contracts/http";
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
	builtInBots,
	compaction,
	controlledEventStream,
	juno,
	linear,
	listedThread,
	MODELS,
	modelProviders,
	mount,
	onWideScreen,
	open,
	personalAssistant,
	projects,
	sam,
	TestApp,
	threadWith,
	triager,
	workspace,
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
		// of its own and the threads list the history. A link from then lands in
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
		setupCompletedAt: "2026-09-01T00:00:00.000Z",
	};

	it("keeps a workspace choice in memory when storage is unavailable", async () => {
		client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, other]));
		const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
			throw new Error("Storage disabled");
		});
		const router = mount(linearPage);
		await screen.findByRole("navigation", { name: "Sidebar" });

		chooseWorkspace(other.id);
		await router.navigate({ to: "/" });

		await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/nitric(\/|$)/));
		setItem.mockRestore();
	});

	it("follows workspace choices made in another tab", async () => {
		client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, other]));
		const router = mount(linearPage);
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
		const router = mount(linearPage);

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
		const router = mount(linearPage);

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
		const router = mount(linearPage);

		const name = await screen.findByLabelText("Workspace name");
		await waitFor(() => expect(router.state.location.pathname).toBe("/onboarding"));
		expect(screen.queryByRole("navigation", { name: "Workspace" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
		fireEvent.change(name, { target: { value: "Nitric" } });
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));

		expect(await screen.findByRole("heading", { name: "Connect a provider" })).toBeDefined();
		expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
	});

	it("takes somebody who may finish an unfinished workspace's setup back into it", async () => {
		client.api.workspaces.list.mockReturnValue(
			Effect.succeed([{ ...workspace, setupCompletedAt: null }]),
		);
		client.api.projects.list.mockReturnValue(Effect.succeed([]));
		client.api.bots.list.mockReturnValue(
			Effect.succeed([{ ...personalAssistant, model: "switched-off" }]),
		);
		const router = mount("/");

		expect(await screen.findByRole("heading", { name: "Connect a provider" })).toBeDefined();
		expect(router.state.location.pathname).toBe("/onboarding");
		expect(router.state.location.search).toEqual({ workspace: workspace.slug });
	});

	it("finishes an unfinished workspace's setup into its chat, not back into setup", async () => {
		client.api.workspaces.list.mockReturnValue(
			Effect.succeed([{ ...workspace, setupCompletedAt: null }]),
		);
		client.api.projects.list.mockReturnValue(Effect.succeed([]));
		client.api.bots.list.mockReturnValue(Effect.succeed([personalAssistant]));
		const made = firstBotMade("Chief");
		client.api.onboarding.complete.mockImplementation(() => {
			client.api.workspaces.list.mockReturnValue(
				Effect.succeed([{ ...workspace, setupCompletedAt: "2026-10-09T00:00:00.000Z" }]),
			);
			return Effect.void;
		});
		const router = mount("/");

		fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Chief" } });
		fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
		fireEvent.click(await screen.findByRole("button", { name: "Skip for now" }));
		fireEvent.click(await screen.findByRole("button", { name: "Start talking" }));

		expect(await screen.findByRole("navigation", { name: "Sidebar" })).toBeDefined();
		expect(router.state.location.pathname.startsWith(`/suga/bots/${made.handle}`)).toBe(true);
	});

	it("says so, rather than opening an unfinished workspace, when it cannot tell who may finish it", async () => {
		client.api.workspaces.list.mockReturnValue(
			Effect.succeed([{ ...workspace, setupCompletedAt: null }]),
		);
		client.api.workspaceAccess.mockReturnValueOnce(
			Effect.fail(new Forbidden({ message: userText`Unavailable` })),
		);
		client.api.projects.list.mockReturnValue(Effect.succeed([]));
		client.api.bots.list.mockReturnValue(
			Effect.succeed([{ ...personalAssistant, model: "switched-off" }]),
		);
		const router = mount(`/${workspace.slug}`);

		fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
		expect(screen.queryByRole("navigation", { name: "Sidebar" })).toBeNull();

		expect(await screen.findByRole("heading", { name: "Connect a provider" })).toBeDefined();
		expect(router.state.location.pathname).toBe("/onboarding");
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
			apiAnswers({ role: "member" });
			client.api.workspaces.list.mockReturnValue(
				Effect.succeed([...alongside, { ...unfinished, setupCompletedAt: null }]),
			);
			chooseWorkspace(unfinished.id);
			const router = mount(address);

			expect(await screen.findByRole("navigation", { name: "Sidebar" })).toBeDefined();
			await waitFor(() => expect(router.state.location.pathname.startsWith(landsAt)).toBe(true));
			expect(screen.queryByRole("heading", { name: "Connect a provider" })).toBeNull();
		},
	);

	it("cancels an unfinished workspace's setup into another workspace, keeping it for an admin, who may not delete it", async () => {
		const unfinished = { ...other, setupCompletedAt: null };
		client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, unfinished]));
		const router = mount(`/${unfinished.slug}`);

		fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

		await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/suga(\/|$)/));
		expect(client.api.workspaces.delete).not.toHaveBeenCalled();
	});

	it("opens a workspace that is set up from the root, rather than the one being set up", async () => {
		const unfinished = { ...other, setupCompletedAt: null };
		client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, unfinished]));
		chooseWorkspace(unfinished.id);
		const router = mount("/");

		expect(await screen.findByRole("navigation", { name: "Sidebar" })).toBeDefined();
		await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/suga(\/|$)/));
	});

	it("comes back to a workspace whose save a reload interrupted", async () => {
		// A new workspace's Personal Assistant has no model yet.
		client.api.bots.list.mockReturnValue(Effect.succeed([{ ...personalAssistant, model: null }]));
		client.api.workspaces.list.mockReturnValue(Effect.succeed([]));
		client.api.workspaces.create.mockReturnValue(Effect.never);
		const router = mount("/onboarding");
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
		mount("/onboarding?workspace=nitric");

		expect(await screen.findByRole("button", { name: "Cancel" })).toBeDefined();
		await waitFor(() => expect(localStorage.getItem("sugabots-workspace")).toBe(other.id));
		expect(screen.queryByRole("heading", { name: "Name your workspace" })).toBeNull();
		expect(client.api.workspaces.create).not.toHaveBeenCalled();
	});

	it("keeps a workspace whose setup is finished when its owner cancels setting it up", async () => {
		// Setup reached by its address, from a bookmark or Back, for a workspace set up since.
		apiAnswers({ role: "owner" });
		client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, other]));
		const router = mount("/onboarding?workspace=nitric");

		fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

		await waitFor(() => expect(router.state.location.pathname).not.toBe("/onboarding"));
		expect(client.api.workspaces.delete).not.toHaveBeenCalled();
	});

	it("asks before leaving a workspace made but not set up", async () => {
		client.api.workspaces.list.mockReturnValue(
			Effect.succeed([workspace, { ...other, setupCompletedAt: null }]),
		);
		const router = mount("/onboarding?workspace=nitric");
		await screen.findByRole("button", { name: "Cancel" });

		void router.navigate({ to: linearPage });
		const dialog = await screen.findByRole("dialog", { name: "Leave setup?" });
		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Leave setup?" })).toBeNull());
		expect(router.state.location.pathname).toBe("/onboarding");

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
		const router = mount(linearPage);

		await startNewWorkspace(router);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		await waitFor(() => expect(router.state.location.pathname).toBe(linearPage));
		expect(client.api.workspaces.create).not.toHaveBeenCalled();
	});

	it("deletes the workspace it made when its owner cancels, and goes back to where it came from", async () => {
		apiAnswers({ role: "owner" });
		const made = { ...other, setupCompletedAt: null };
		client.api.workspaces.create.mockImplementation(() => {
			client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, made]));
			return Effect.succeed(made);
		});
		client.api.workspaces.delete.mockReturnValue(Effect.void);
		const router = mount(linearPage);

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
			Effect.succeed([workspace, { ...other, setupCompletedAt: null }]),
		);
		client.api.workspaces.delete.mockReturnValue(Effect.void);
		const router = mount("/onboarding?workspace=nitric");

		await screen.findByRole("heading", { name: "Connect a provider" });
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		await waitFor(() => expect(router.state.location.pathname).not.toBe("/onboarding"));
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
		const router = mount("/suga/settings");

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
		const router = mount(linearPage);

		fireEvent.change(await startNewWorkspace(router), { target: { value: "Suga" } });
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));

		expect(await screen.findByText("That workspace address is already taken.")).toBeDefined();
		expect(screen.getByRole("heading", { name: "Name your workspace" })).toBeDefined();
		expect(router.state.location.search).toEqual({});
	});

	async function startNewWorkspace(router: ReturnType<typeof mount>) {
		await openWorkspaceMenu();
		fireEvent.click(await screen.findByRole("menuitem", { name: "New workspace" }));
		await waitFor(() => expect(router.state.location.pathname).toBe("/onboarding"));
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
		const queries = createQueryClient();
		const router = createAppRouter({
			history: createMemoryHistory({ initialEntries: [linearPage] }),
		});
		render(
			<TestApp
				router={router}
				queries={queries}
				session={{ user: sam, error: undefined, refresh: vi.fn() }}
			/>,
		);
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
		// One row each, as a bot has: their threads are in the project's own sidebar.
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
		client.api.chats.projectMarkers.mockReturnValue(
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

	it("gives an open bot a sidebar of its own, listing its threads", async () => {
		onWideScreen();
		mount(linearPage);

		const sidebar = await screen.findByRole("navigation", { name: "Sidebar" });
		expect(
			await within(sidebar).findByRole("navigation", { name: `${linear.name}'s pages` }),
		).toBeDefined();
		const work = await within(sidebar).findByRole("region", { name: "Threads" });
		expect(
			await within(work).findByRole("link", { name: new RegExp(threadWith(linear).title) }),
		).toBeDefined();
		expect(within(sidebar).queryByRole("group", { name: "Projects" })).toBeNull();
	});

	it("goes back to the projects and bots from a bot's sidebar", async () => {
		onWideScreen();
		const router = mount(linearPage);

		fireEvent.click(await screen.findByRole("link", { name: "All projects and bots" }));

		await waitFor(() => expect(router.state.location.pathname).toBe("/suga"));
		expect(await screen.findByRole("group", { name: "Bots" })).toBeDefined();
	});

	it("makes your Personal Assistant when you have none", async () => {
		client.api.bots.list.mockReturnValue(Effect.succeed(bots));
		mount(linearPage);

		await waitFor(() => expect(client.api.bots.ensureAssistant).toHaveBeenCalled());
	});

	it("narrows to a rail beside a project's own sidebar, and lists every project again away from it", async () => {
		const router = mount("/suga/projects/sales");

		const rail = await screen.findByRole("navigation", { name: "Projects and bots" });
		expect(
			(await within(rail).findByRole("link", { name: "Sales" })).getAttribute("aria-current"),
		).toBe("page");
		expect(await screen.findByRole("navigation", { name: "Sales's pages" })).toBeDefined();
		await router.navigate({ to: "/$workspace/inbox", params: { workspace: "suga" } });

		await waitFor(() => expect(router.state.location.pathname).toBe("/suga/inbox"));
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
		).toBe("/suga/settings/profile");
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

	it("shows that it exists, with its settings, but none of its threads", async () => {
		client.api.bots.list.mockReturnValue(Effect.succeed([linear, theirs, personalAssistant]));
		mount(`/suga/bots/${theirs.handle}`);

		expect(await screen.findByText(/someone else's private bot/)).toBeDefined();
		expect(screen.getByRole("link", { name: "Open its settings" }).getAttribute("href")).toBe(
			`/suga/settings/bots/${theirs.handle}`,
		);
		expect(client.api.chats.threads).not.toHaveBeenCalledWith({
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
			`/suga/settings/bots/${theirs.handle}`,
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
		expect(client.api.chats.threads).not.toHaveBeenCalledWith({
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

	it("keeps its settings closed", async () => {
		notIn();
		mount("/suga/settings/projects/sales");

		expect(await screen.findByText("You're not in this project")).toBeDefined();
	});
});

describe("a project's threads", () => {
	const sales = projects[1] as (typeof projects)[number];
	const threadIn = (id: string, title: string) =>
		listedThread({
			kind: "project_thread",
			id,
			workspaceId: workspace.id,
			projectId: sales.id,
			botId: null,
			title,
			archivedAt: null,
			doneAt: null,
			createdAt: "2026-09-18T06:00:00.000Z",
			updatedAt: "2026-09-18T06:00:00.000Z",
		});

	it("opens the project at its newest thread", async () => {
		onWideScreen();
		const newest = threadIn("0199a3a0-0000-7000-8000-0000000000f1", "Launch");
		client.api.chats.threads.mockReturnValue(
			Effect.succeed({
				threads: [newest, threadIn("0199a3a0-0000-7000-8000-0000000000f2", "Pricing")],
				automations: [],
			}),
		);
		const router = mount(`/suga/projects/${sales.slug}`);

		await waitFor(() =>
			expect(router.state.location.pathname).toBe(
				`/suga/projects/${sales.slug}/${newest.conversation.id}`,
			),
		);
	});

	it("lists a scheduled run that started and finished while the project was open", async () => {
		onWideScreen();
		const updates = controlledEventStream();
		client.events.workspace.mockReturnValue(updates.stream);
		client.api.chats.threads.mockReturnValue(
			Effect.succeed({
				threads: [threadIn("0199a3a0-0000-7000-8000-0000000000f1", "Launch")],
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
			conversationId: "0199a3a0-0000-7000-8000-0000000003e6",
			rootConversationId: "0199a3a0-0000-7000-8000-0000000003e7",
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
			streamEvent("conversation.item_changed", {
				rootConversationId: run.rootConversationId,
				conversationId: run.conversationId,
			}),
		);

		expect(await screen.findByText(run.automationName)).toBeDefined();
	});

	it("asks whoever may change a project with no lead bot yet to choose one", async () => {
		onWideScreen();
		const leaderless = { ...sales, leadBotId: null };
		client.api.projects.list.mockReturnValue(
			Effect.succeed(projects.map((one) => (one.id === sales.id ? leaderless : one))),
		);
		client.api.projects.update.mockReturnValue(Effect.succeed(sales));
		mount(`/suga/projects/${sales.slug}`);

		await screen.findByText(`Choose a lead bot for ${sales.name}`);
		fireEvent.click(screen.getByRole("button", { name: "Choose a lead bot" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Customer Research" }));

		await waitFor(() =>
			expect(client.api.projects.update).toHaveBeenCalledWith({
				params: { projectId: sales.id },
				payload: { leadBotId: "0199a3a0-0000-7000-8000-0000000000b1" },
			}),
		);
	});

	it("starts the first thread of a project with none from its first message, as a bot's page does", async () => {
		onWideScreen();
		const started = threadIn("0199a3a0-0000-7000-8000-0000000000f3", "Plan the kickoff");
		client.api.chats.startProjectThread.mockImplementation(
			({ payload }: { payload: { id: string; message: string } }) =>
				Effect.succeed({
					conversation: started.conversation,
					message: { id: payload.id, conversationId: started.conversation.id },
				}),
		);
		const router = mount(`/suga/projects/${sales.slug}`);

		expect(await screen.findByText("What do you need done?")).toBeDefined();
		const composer = await screen.findByLabelText(`Message ${sales.name}`);
		composer.textContent = "Plan the kickoff";
		fireEvent.input(composer);
		fireEvent.click(screen.getByRole("button", { name: "Start thread" }));

		await waitFor(() =>
			expect(client.api.chats.startProjectThread).toHaveBeenCalledWith({
				params: { projectId: sales.id },
				payload: { id: expect.any(String), message: "Plan the kickoff" },
			}),
		);
		await waitFor(() =>
			expect(router.state.location.pathname).toBe(
				`/suga/projects/${sales.slug}/${started.conversation.id}`,
			),
		);
	});
});

describe("the settings navigation", () => {
	/*
	 * The workspace's sections, then each project with its own pages, then you. The
	 * sections an administrator alone may open are left out for a member, so
	 * their list simply ends rather than showing gaps.
	 */

	it("lists a project's General, People, Bots and Computer, as a bot has its own", async () => {
		client.api.computerProviders.access.mockReturnValue(Effect.succeed({ enabled: true }));
		mount("/suga/settings/projects/suga-team");
		const rail = await screen.findByRole("navigation", { name: "Settings" });
		const projects = await within(rail).findByRole("group", { name: "Projects" });
		expect(await within(projects).findByRole("link", { name: /^Bots/ })).toBeDefined();
		expect(within(projects).getByRole("link", { name: "Computer" })).toBeDefined();
	});

	it("remembers a project closed, even while one of its pages is open", async () => {
		localStorage.clear();
		mount("/suga/settings/projects/suga-team");
		const rail = await screen.findByRole("navigation", { name: "Settings" });
		const project = await within(rail).findByRole("button", { name: "Suga-Team" });
		expect(project.getAttribute("aria-expanded")).toBe("true");

		fireEvent.click(project);
		expect(project.getAttribute("aria-expanded")).toBe("false");
		cleanup();

		mount("/suga/settings/projects/suga-team");
		const again = await screen.findByRole("navigation", { name: "Settings" });
		expect(
			(await within(again).findByRole("button", { name: "Suga-Team" })).getAttribute(
				"aria-expanded",
			),
		).toBe("false");
		localStorage.clear();
	});

	it("lists your settings first, then the workspace's sections and its projects", async () => {
		onWideScreen();
		const router = mount("/suga/settings");

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
		expect(await within(rail).findByRole("button", { name: "Suga-Team" })).toBeDefined();
		expect(within(rail).getByRole("button", { name: "Sales" })).toBeDefined();

		fireEvent.click(within(you).getByRole("link", { name: "General" }));

		await waitFor(() => expect(router.state.location.pathname).toBe("/suga/settings/profile"));
	});

	it("opens a project onto its pages, and keeps the open project's open", async () => {
		onWideScreen();
		const router = mount("/suga/settings");

		const rail = await screen.findByRole("navigation", { name: "Settings" });
		const project = await within(rail).findByRole("button", { name: "Suga-Team" });
		expect(project.getAttribute("aria-expanded")).toBe("false");

		fireEvent.click(project);
		fireEvent.click(await within(rail).findByRole("link", { name: "People" }));

		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/suga/settings/projects/suga-team/people"),
		);
		const opened = within(await settingsNavigation()).getByRole("button", { name: "Suga-Team" });
		expect(opened.getAttribute("aria-expanded")).toBe("true");
		expect(await screen.findByRole("heading", { name: "People" })).toBeDefined();
	});

	it("counts what each section and project page holds, beside its name", async () => {
		mount("/suga/settings/projects/suga-team");

		const rail = await screen.findByRole("navigation", { name: "Settings" });

		// The name carries the count, so it is read as a pair rather than "People2".
		expect(await within(rail).findByRole("link", { name: "People, 2" })).toBeDefined();
		// The project's bots only: the Summariser and Compaction belong to the workspace rather
		// than to a project, so they are not counted among its bots.
		expect(await within(rail).findByRole("link", { name: "Bots, 2" })).toBeDefined();
		// General holds nothing to count: yours, the workspace's or the project's.
		expect(within(rail).getAllByRole("link", { name: "General" })).toHaveLength(3);
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
		client.api.workspaces.members.mockReturnValue(
			Effect.succeed([
				{
					id: "0199a3a0-0000-7000-8000-0000000000d1",
					role: "admin",
					user: sam,
					joinedAt: "2026-09-09T00:00:00.000Z",
				},
			]),
		);
		mount("/suga/settings");

		// General counts the members too, so once it does the roster has answered.
		await screen.findByText("Workspace with 1 member and 2 projects");
		const rail = await screen.findByRole("navigation", { name: "Settings" });

		// The one member is you. "1" tells nobody anything they did not know.
		expect(within(rail).getByRole("link", { name: "People" })).toBeDefined();
	});

	it("withholds the administrative sections from a member", async () => {
		onWideScreen();
		apiAnswers({ role: "member" });
		mount("/suga/settings");

		const rail = await screen.findByRole("navigation", { name: "Settings" });
		// Waiting on a count waits on the answers the rail is drawn from, the
		// caller's role among them, so what follows is a settled list.
		await within(rail).findByRole("link", { name: "People, 2" });

		expect(within(rail).queryByRole("link", { name: "Models" })).toBeNull();
		expect(within(rail).queryByRole("link", { name: "Web search" })).toBeNull();
		expect(within(rail).queryByRole("link", { name: "Computers" })).toBeNull();
	});

	// Each settings page draws its own navigation, so it is looked up afresh after every move.
	const settingsNavigation = () => screen.findByRole("navigation", { name: "Settings" });

	/**
	 * The Back above the page. On a wide screen the trail does its work and the
	 * bar is hidden by style, which the test DOM does not apply, so it is there
	 * to find at every width.
	 */
	const pageBack = async (name: string) =>
		within(await screen.findByRole("main")).findByRole("link", { name });

	/** Opens Linear's settings from its project's Bots, as a person would. */
	async function openLinearFromItsProject() {
		const main = await screen.findByRole("main");
		fireEvent.click(await within(main).findByRole("link", { name: new RegExp(linear.name) }));
		await screen.findByRole("heading", { name: linear.name });
	}

	it("goes back, under the project's name, to the project's bots a bot was opened from", async () => {
		const router = mount("/suga/settings/projects/suga-team/bots");
		await openLinearFromItsProject();

		fireEvent.click(await pageBack("Suga-Team"));

		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/suga/settings/projects/suga-team/bots"),
		);
		expect(await screen.findByText("2 bots in Suga-Team")).toBeDefined();
	});

	it("names each page on the way down to an open bot, each a link up but the last", async () => {
		mount(`/suga/settings/bots/${linear.handle}`);

		const trail = await screen.findByRole("navigation", { name: "Breadcrumb" });
		expect(await within(trail).findByRole("link", { name: "Workspace settings" })).toBeDefined();
		expect(within(trail).getByRole("link", { name: "Bots" }).getAttribute("href")).toBe(
			"/suga/settings/bots",
		);
		expect(await within(trail).findByText(linear.name)).toBeDefined();
		expect(within(trail).queryByRole("link", { name: linear.name })).toBeNull();
	});

	it("starts over when a section is picked from the navigation", async () => {
		onWideScreen();
		const router = mount("/suga/settings/projects/suga-team/bots");
		await openLinearFromItsProject();

		fireEvent.click(within(await settingsNavigation()).getByRole("link", { name: "People, 2" }));

		await waitFor(() => expect(router.state.location.pathname).toBe("/suga/settings/members"));
		// Back goes to the list of sections, not to the bot it was opened after.
		expect(await pageBack("Settings")).toBeDefined();
		expect(screen.queryByRole("link", { name: "Bots" })).toBeNull();
	});

	it("starts over when a new project opens", async () => {
		onWideScreen();
		const made = { ...projects[0], id: "new", name: "Platform", slug: "platform" };
		client.api.projects.create.mockReturnValue(Effect.succeed(made));
		mount("/suga/settings/projects/suga-team/bots");
		await openLinearFromItsProject();

		fireEvent.click(
			await within(await settingsNavigation()).findByRole("button", { name: "New project" }),
		);
		const dialog = await screen.findByRole("dialog", { name: "New project" });
		fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Platform" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Choose a lead bot" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Customer Research" }));
		client.api.projects.list.mockReturnValue(Effect.succeed([...projects, made]));
		fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

		await screen.findByRole("heading", { name: "Platform" });
		expect(await pageBack("Settings")).toBeDefined();
	});

	it("tells a member who reaches the Models page by address that it is not theirs", async () => {
		apiAnswers({ role: "member" });
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
		const router = mount("/");

		await waitFor(() => expect(router.state.location.pathname).toBe("/suga"));
		const sidebar = await screen.findByRole("navigation", { name: "Sidebar" });
		const assistant = await within(sidebar).findByRole("link", {
			name: new RegExp(`^${personalAssistant.name}`),
		});
		expect(assistant.getAttribute("aria-current")).toBe("page");
	});

	it("sends somebody signed out to the login page, remembering where they were going", async () => {
		const destination = `${linearPage}?item=0199a3a0-0000-7000-8000-0000000000aa`;
		const router = mount(destination, null);

		expect(await screen.findByRole("heading", { name: "Welcome to Sugabots" })).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Continue with email" }));
		expect(await screen.findByRole("button", { name: "Log in" })).toBeDefined();
		await waitFor(() => {
			expect(router.state.location.pathname).toBe("/login");
		});
		expect(router.state.location.search).toEqual({ returnTo: destination });
	});

	it("returns a signed-in visit to the login page to where it was going, search and all", async () => {
		onWideScreen();
		const destination = `/suga/settings/bots/${linear.handle}?tab=automations`;
		const router = mount(`/login?returnTo=${encodeURIComponent(destination)}`);

		expect(await screen.findByRole("link", { name: /^Automations/ })).toBeDefined();
		expect(router.state.location.href).toBe(destination);
	});

	it("will not return from the login page to another site", async () => {
		const router = mount(`/login?returnTo=${encodeURIComponent("//evil.example/steal")}`);

		await waitFor(() => expect(router.state.location.pathname).toBe("/suga"));
	});

	it("walks a new workspace from its first bot to its chat", async () => {
		client.api.projects.list.mockReturnValue(Effect.succeed([]));
		client.api.bots.list.mockReturnValue(Effect.succeed([personalAssistant]));
		const made = firstBotMade("Chief");
		client.api.onboarding.complete.mockReturnValue(Effect.void);
		const router = mount(`/onboarding?workspace=${workspace.slug}`);

		expect(await screen.findByRole("heading", { name: "Make your first bot" })).toBeDefined();
		await waitFor(() => expect(router.state.location.pathname).toBe("/onboarding"));
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
					face: "pill",
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
			expect(client.api.onboarding.complete).toHaveBeenCalledWith({
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
		mount(`/onboarding?workspace=${workspace.slug}`);

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
					expect.objectContaining({ payload: expect.objectContaining({ email, role: "member" }) }),
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
		mount(`/onboarding?workspace=${workspace.slug}`);

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
			preset: "openrouter" as const,
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
		client.api.modelProviders.fetchModels.mockReturnValue(
			Effect.succeed({ added: 2, updated: 0, unchanged: 0 }),
		);
		client.api.modelProviders.updateModel.mockReturnValue(
			Effect.succeed({ ...(large as ProviderModel), enabled: true }),
		);
		client.api.bots.ensureAssistant.mockReturnValue(
			Effect.succeed({ ...personalAssistant, model: "mistral/large" }),
		);
		mount(`/onboarding?workspace=${workspace.slug}`);

		fireEvent.click(await screen.findByRole("button", { name: "Choose a provider" }));
		const picker = await screen.findByRole("dialog", { name: "Add provider" });
		fireEvent.click(within(picker).getByRole("button", { name: /^OpenRouter/ }));
		const step = await screen.findByRole("dialog", { name: "OpenRouter" });
		fireEvent.change(within(step).getByLabelText("API key"), { target: { value: "sk-or-test" } });
		fireEvent.click(within(step).getByRole("button", { name: "Add" }));

		expect(await screen.findByRole("heading", { name: "Choose a model" })).toBeDefined();
		expect(client.api.modelProviders.create).toHaveBeenCalledWith({
			params: { workspace: workspace.id },
			payload: { preset: "openrouter", apiKey: "sk-or-test" },
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
		expect(client.api.modelProviders.setModelsEnabled).not.toHaveBeenCalled();
		expect(await screen.findByRole("heading", { name: "Make your first bot" })).toBeDefined();
	});

	it("asks somebody with an invitation to log in first, keeping the invitation", async () => {
		const router = mount("/invite/an-invitation", null);

		expect(await screen.findByText(/invited to a workspace/)).toBeDefined();
		await waitFor(() => {
			expect(router.state.location.search).toEqual({ invite: "an-invitation" });
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
		client.auth.signUp.mockResolvedValue({ token: null, user: sam });
		mount("/invite/an-invitation", null);

		await createAccount("Sam", "sam@example.com");

		expect(await screen.findByText("Check your email")).toBeDefined();
		expect(client.auth.signUp).toHaveBeenCalledWith({
			name: "Sam",
			email: "sam@example.com",
			password: "correct-horse",
			callbackURL: `${window.location.origin}/invite/an-invitation`,
		});
	});

	it("shows why a sign-up was refused rather than asking for verification", async () => {
		client.auth.signUp.mockRejectedValue(
			failureForStatus(
				403,
				UserText.unchecked("Signups are invite only. Ask a member to invite you."),
				"SIGN_UP_CLOSED",
			),
		);
		mount("/", null);
		fireEvent.click(await screen.findByRole("button", { name: "Continue with email" }));

		await createAccount("Eve", "eve@example.com");

		expect(await screen.findByText(/invite only/)).toBeDefined();
		expect(screen.queryByText("Check your email")).toBeNull();
	});

	it("asks an unverified account to open its link when it logs in", async () => {
		client.auth.signIn.mockRejectedValue(
			failureForStatus(403, UserText.unchecked("Email not verified"), "EMAIL_NOT_VERIFIED"),
		);
		mount("/", null);
		fireEvent.click(await screen.findByRole("button", { name: "Continue with email" }));

		fireEvent.change(await screen.findByLabelText("Email"), {
			target: { value: "sam@example.com" },
		});
		fireEvent.change(screen.getByLabelText("Password"), {
			target: { value: "correct-horse" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Log in" }));

		expect(await screen.findByText("Check your email")).toBeDefined();
	});

	it("signs a new account in at once when no verification is needed", async () => {
		client.auth.signUp.mockResolvedValue({ token: "a-session", user: sam });
		const refresh = vi.fn().mockResolvedValue(undefined);
		mount("/invite/an-invitation", null, refresh);

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

		mount("/invite/an-invitation", sam);

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
				role: "member",
			}),
		);
		const refresh = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(new Error("Offline"))
			.mockResolvedValueOnce(undefined);
		const router = mount("/invite/an-invitation", sam, refresh);

		fireEvent.click(await screen.findByRole("button", { name: "Accept invite" }));

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
			setupCompletedAt: "2026-09-01T00:00:00.000Z",
		};
		client.api.workspaces.invitation.mockReturnValue(
			Effect.succeed({
				status: "pending",
				workspaceName: "Nitric",
				inviterName: "Sam",
				role: "member",
			}),
		);
		client.api.workspaces.acceptInvitation.mockImplementation(() => {
			client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, joined]));
			return Effect.succeed({ workspaceId: joined.id });
		});
		// As main.tsx starts a session: with the workspaces /me answered with.
		const queries = createQueryClient();
		queries.setQueryData(workspacesQuery.queryKey, [workspace]);
		const router = createAppRouter({
			history: createMemoryHistory({ initialEntries: ["/invite/an-invitation"] }),
		});
		render(
			<TestApp
				router={router}
				queries={queries}
				session={{ user: sam, error: undefined, refresh: vi.fn().mockResolvedValue(undefined) }}
			/>,
		);

		await screen.findByText("You have been invited to Nitric.");
		fireEvent.click(screen.getByRole("button", { name: "Accept invite" }));

		await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/nitric(\/|$)/));
	});

	it("leads back into the workspace from an invitation already accepted", async () => {
		client.api.workspaces.invitation.mockReturnValue(
			Effect.succeed({ status: "accepted", workspaceId: workspace.id }),
		);
		const refresh = vi.fn().mockResolvedValue(undefined);
		const router = mount("/invite/an-invitation", sam, refresh);

		await waitFor(() => expect(router.state.location.pathname).toBe("/suga"));
		expect(client.api.workspaces.acceptInvitation).not.toHaveBeenCalled();
		expect(refresh).toHaveBeenCalledOnce();
	});

	it("awaits login completion and reports its failure", async () => {
		client.auth.signIn.mockResolvedValue(undefined);
		const refresh = vi.fn().mockRejectedValue(new Error("Offline"));
		mount("/login", null, refresh);
		fireEvent.click(await screen.findByRole("button", { name: "Continue with email" }));
		fireEvent.change(await screen.findByLabelText("Email"), {
			target: { value: "sam@example.com" },
		});
		fireEvent.change(screen.getByLabelText("Password"), {
			target: { value: "password" },
		});

		fireEvent.click(screen.getByRole("button", { name: "Log in" }));

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
	/*
	 * NIT-1799. The API refuses a member either way, so what these are about is
	 * whether the control is *drawn*: a control that cannot work teaches people
	 * that things here sometimes do not.
	 */

	it("offers a viewer nothing", async () => {
		onWideScreen();
		apiAnswers({ role: "viewer" });
		mount("/suga/settings");

		// Waiting on the projects waits on the answers the controls beside them are drawn from.
		const rail = await screen.findByRole("navigation", { name: "Settings" });
		await within(rail).findByRole("button", { name: "Suga-Team" });

		expect(screen.queryByRole("button", { name: "New project" })).toBeNull();
	});

	/** Opens New project, beside Projects in the settings navigation. */
	async function openNewProject() {
		const rail = await screen.findByRole("navigation", { name: "Settings" });
		fireEvent.click(await within(rail).findByRole("button", { name: "New project" }));
	}

	/** Chooses Customer Research to lead the project the dialog makes. */
	async function chooseLead(dialog: HTMLElement) {
		fireEvent.click(within(dialog).getByRole("button", { name: "Choose a lead bot" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Customer Research" }));
		await within(dialog).findByRole("button", { name: "Lead bot: Customer Research" });
	}

	it("waits for a name and a lead bot before it can make a project", async () => {
		onWideScreen();
		mount("/suga/settings");
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

		mount("/suga/settings");
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
		expect(await screen.findByRole("heading", { name: "Platform" })).toBeDefined();
	});

	it("says so when the address is already taken, and keeps the form open", async () => {
		onWideScreen();
		client.api.projects.create.mockReturnValue(
			Effect.fail(new Conflict({ message: userText`already exists` })),
		);

		mount("/suga/settings");
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
	it("offers a member the same New bot action as an admin", async () => {
		mount("/suga/settings/bots");

		expect(await screen.findByRole("button", { name: "New bot" })).toBeDefined();
		cleanup();
		vi.clearAllMocks();

		apiAnswers({ role: "member" });
		mount("/suga/settings/bots");

		expect(await screen.findByRole("button", { name: "New bot" })).toBeDefined();
	});

	it("keeps deleting projects, and making them, to those allowed them", async () => {
		mount(`/suga/settings/projects/${projects[0]?.slug}`);

		const rail = await screen.findByRole("navigation", { name: "Settings" });
		expect(await within(rail).findByRole("button", { name: "New project" })).toBeDefined();
		expect(await screen.findByRole("button", { name: "Delete project" })).toBeDefined();
		cleanup();
		vi.clearAllMocks();

		apiAnswers({ role: "viewer" });
		mount(`/suga/settings/projects/${projects[0]?.slug}`);
		await screen.findByRole("heading", { name: projects[0]?.name });

		expect(screen.queryByRole("button", { name: "New project" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Delete project" })).toBeNull();
	});

	it("creates a bot in the look and colour chosen, and opens it", async () => {
		onWideScreen();
		const made = {
			...linear,
			id: "0199a3a0-0000-7000-8000-0000000000c9",
			name: "Release Coordinator",
			handle: "release-coordinator",
			model: MODELS[0] as string,
		};
		client.api.bots.create.mockReturnValue(Effect.succeed(made));
		const router = mount("/suga/settings/bots");
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
				// The looks on offer are drawn at random; the colour is the one chosen.
				payload: {
					name: made.name,
					model: made.model,
					visibility: "public",
					color: "orange",
					shape: expect.any(String),
					face: expect.any(String),
				},
			});
		});
		await waitFor(() =>
			expect(router.state.location.pathname.startsWith(`/suga/bots/${made.handle}`)).toBe(true),
		);
		expect(screen.queryByRole("dialog", { name: "New bot" })).toBeNull();
		expect((await screen.findAllByText(made.name)).length).toBeGreaterThan(0);
	});

	it("on a phone, chooses the look on a page of its own, from the bot's face", async () => {
		client.api.bots.create.mockReturnValue(Effect.succeed({ ...linear, name: "Scout" }));
		mount("/suga/settings/bots");
		(await screen.findByRole("button", { name: "New bot" })).click();

		const dialog = await screen.findByRole("dialog", { name: "New bot" });
		fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Scout" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Change the look" }));
		// The look's page has Back where the page had Close, and no Create.
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
		mount("/suga/settings/bots");
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
	it("opens the first project when none is chosen", async () => {
		mount("/suga/settings/projects");

		expect(await screen.findByRole("heading", { name: projects[0]?.name })).toBeDefined();
		expect(screen.queryByText("Choose a project")).toBeNull();
	});

	it("picks out the open project's page in the navigation", async () => {
		const project = projects[0] as (typeof projects)[number];
		mount(`/suga/settings/projects/${project.slug}`);

		const rail = await screen.findByRole("navigation", { name: "Settings" });
		expect(
			(await within(rail).findByRole("button", { name: project.name })).getAttribute(
				"aria-expanded",
			),
		).toBe("true");
		const current = within(rail)
			.getAllByRole("link")
			.filter((link) => link.getAttribute("aria-current") === "page");
		expect(current.map((link) => link.getAttribute("href"))).toEqual([
			`/suga/settings/projects/${project.slug}`,
		]);
	});

	const [openai, anthropic] = modelProviders as [ModelProvider, ModelProvider];
	const providerPage = (provider: { id: string }) => `/suga/settings/providers/${provider.id}`;

	it("lists a connected provider as Connected, and opens it", async () => {
		const router = mount("/suga/settings/providers");

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

	it("shows the system bots' model, and sets it for all of them at once", async () => {
		client.api.systemBots.update.mockReturnValue(Effect.succeed(builtInBots[0]));
		const router = mount("/suga/settings/providers");

		fireEvent.click(await screen.findByRole("link", { name: /Summaries/ }));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/suga/settings/providers/system"),
		);
		fireEvent.click(await screen.findByRole("button", { name: "gpt-5" }));

		await waitFor(() => {
			for (const key of ["summarise", "compact"]) {
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
		preset: "ollama" as const,
		name: "Ollama",
		baseUrl: "http://127.0.0.1:11434/v1",
		hasApiKey: false,
		status: "untested" as const,
		models: [],
		modelCount: 0,
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
			preset: null,
			name: "Local gateway",
			baseUrl: "http://localhost:11434/v1",
			hasApiKey: false,
			status: "missing_key" as const,
			models: [],
			modelCount: 0,
		};
		client.api.modelProviders.create.mockReturnValue(Effect.succeed(provider));
		const router = mount("/suga/settings/providers");

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

	it("offers the catalog, minus what is connected, and adds a preset by its key", async () => {
		const groq = {
			...openai,
			id: "0199a3a0-0000-7000-8000-0000000000d1",
			preset: "groq" as const,
			name: "Groq",
			baseUrl: "https://api.groq.com/openai/v1",
			models: [],
			modelCount: 0,
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
				payload: { preset: "groq", apiKey: "gsk-test" },
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
		const router = mount(providerPage(openai));

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

	it("replaces a key, and says where a connection test failed", async () => {
		client.api.modelProviders.test.mockReturnValue(
			Effect.fail(new InternalServerError({ message: userText`Provider unavailable` })),
		);
		mount(providerPage(openai));

		fireEvent.click(await screen.findByRole("button", { name: "Replace" }));
		expect(screen.getByLabelText("OpenAI API key")).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

		expect((await screen.findByRole("alert")).textContent).toContain("Provider unavailable");
		expect(screen.getByRole("button", { name: "Test connection" }).hasAttribute("disabled")).toBe(
			false,
		);
	});

	it("keeps a manual model form open when adding the model fails", async () => {
		const custom = {
			...openai,
			id: "0199a3a0-0000-7000-8000-0000000000cf",
			preset: null,
			name: "Local gateway",
			baseUrl: "http://localhost:11434/v1",
			models: [],
			modelCount: 0,
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

	/** Opens the invite panel, which is behind a button rather than always open. */
	const openInvitePanel = async () => {
		fireEvent.click(await screen.findByRole("button", { name: "Invite people" }));
		return screen.findByRole("dialog", { name: "Invite people" });
	};

	it("dims the page behind a dialog a screen opens", async () => {
		// The navigation drawer is a dialog too. While it wrapped the screens,
		// Base UI read every dialog they opened as nested and dropped its
		// backdrop, leaving the page behind undimmed and unblurred.
		mount("/suga/settings/members");
		const dialog = await openInvitePanel();

		expect(dialog.ownerDocument.querySelector('[data-slot="dialog-overlay"]')).not.toBeNull();
	});

	const junoPage = "/suga/settings/members/0199a3a0-0000-7000-8000-0000000000d2";
	const samPage = "/suga/settings/members/0199a3a0-0000-7000-8000-0000000000d1";

	it("invites every address typed, with the role chosen", async () => {
		client.api.workspaces.invite.mockReturnValue(Effect.succeed({ id: "an-invitation" }));
		mount("/suga/settings/members");
		const panel = await openInvitePanel();

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
		mount("/suga/settings/members");
		const panel = await openInvitePanel();
		const emails = within(panel).getByLabelText("Email addresses");
		fireEvent.change(emails, { target: { value: "juno@example.com kim@example.com" } });

		fireEvent.click(within(panel).getByRole("button", { name: "Send" }));

		expect((await within(panel).findByRole("alert")).textContent).toContain("kim@example.com");
		expect((emails as HTMLInputElement).value).toBe("kim@example.com");
	});

	it("lists each person with their role, and opens their page", async () => {
		const router = mount("/suga/settings/members");

		const row = await screen.findByRole("link", { name: new RegExp(juno.name) });
		expect(row.textContent).toContain("Member");
		expect(screen.getByRole("link", { name: new RegExp(sam.name) }).textContent).toContain("(you)");
		fireEvent.click(row);

		await waitFor(() => expect(router.state.location.pathname).toBe(junoPage));
		expect(await screen.findByRole("heading", { name: juno.name })).toBeDefined();
	});

	it("changes what somebody may do from their page", async () => {
		mount(junoPage);

		fireEvent.click(await screen.findByRole("radio", { name: "Viewer" }));

		await waitFor(() => {
			expect(client.api.workspaces.updateMember).toHaveBeenCalledWith({
				params: { workspace: workspace.id, memberId: "0199a3a0-0000-7000-8000-0000000000d2" },
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
				payload: { userId: juno.id },
			}),
		);
	});

	it("asks before removing somebody, says what goes with them, and returns to the list", async () => {
		const router = mount(junoPage);

		fireEvent.click(await screen.findByRole("button", { name: "Remove from workspace" }));

		expect(await screen.findByRole("heading", { name: `Remove ${juno.name}?` })).toBeDefined();
		expect(screen.getByText(/their Personal Assistant and its threads are deleted/)).toBeDefined();
		expect(client.api.workspaces.removeMember).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Remove" }));

		await waitFor(() => {
			expect(client.api.workspaces.removeMember).toHaveBeenCalledWith({
				params: { workspace: workspace.id, memberId: "0199a3a0-0000-7000-8000-0000000000d2" },
			});
		});
		await waitFor(() => expect(router.state.location.pathname).toBe("/suga/settings/members"));
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
		mount("/suga/settings/members");

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
		mount("/suga/settings/members");

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

	it("shows a member who holds what, and no way to change it", async () => {
		apiAnswers({ role: "member" });
		mount("/suga/settings/members");

		expect(
			(await screen.findByRole("link", { name: new RegExp(juno.name) })).textContent,
		).toContain("Member");
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
		const router = mount("/suga/settings");

		fireEvent.change(await screen.findByLabelText("Workspace name"), {
			target: { value: "Nitric" },
		});
		(await screen.findByRole("button", { name: "Continue" })).click();

		await waitFor(() => {
			expect(router.state.location.pathname).toBe("/onboarding");
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
		).toBe("/suga/settings/profile");
		expect(within(settings).getByRole("link", { name: "General" }).getAttribute("href")).toBe(
			"/suga/settings/general",
		);
		expect(
			within(settings)
				.getByRole("link", { name: /^People/ })
				.getAttribute("href"),
		).toBe("/suga/settings/members");
	});

	it("lists Notifications under your profile, and leads from it back there", async () => {
		mount("/suga/settings/profile");

		const profile = await screen.findByRole("main");
		expect(
			(await within(profile).findByRole("link", { name: "Notifications" })).getAttribute("href"),
		).toBe("/suga/settings/notifications");
		expect(within(profile).getByRole("link", { name: "Settings" }).getAttribute("href")).toBe(
			"/suga/you",
		);
		cleanup();

		mount("/suga/settings/notifications");
		const notifications = await screen.findByRole("main");
		expect(
			(await within(notifications).findByRole("link", { name: "You" })).getAttribute("href"),
		).toBe("/suga/settings/profile");
	});

	it("opens General by name, with the way back to Settings", async () => {
		mount("/suga/settings/general");

		expect(await screen.findByText("Time zone")).toBeDefined();
		const page = screen.getByRole("main");
		expect(within(page).getByRole("link", { name: "Settings" }).getAttribute("href")).toBe(
			"/suga/you",
		);
	});

	it("leads from one of a project's pages back to the project", async () => {
		mount(`/suga/settings/projects/${projects[0]?.slug}/people`);

		const page = await screen.findByRole("main");
		const back = await within(page).findByRole("link", { name: "Project" });
		expect(back.getAttribute("href")).toBe(`/suga/settings/projects/${projects[0]?.slug}`);
	});

	it("leads from a bot back to the workspace's Bots", async () => {
		mount(`/suga/settings/bots/${linear.handle}`);

		const page = await screen.findByRole("main");
		expect((await within(page).findByRole("link", { name: "Bots" })).getAttribute("href")).toBe(
			"/suga/settings/bots",
		);
	});
});

describe("the theme", () => {
	// Chosen under your profile, since it is yours rather than the workspace's.
	it("is dark until something is chosen", async () => {
		onWideScreen();
		mount("/suga/settings/profile");

		const theme = await screen.findByRole("group", { name: "Theme" });
		expect((within(theme).getByRole("radio", { name: "Dark" }) as HTMLInputElement).checked).toBe(
			true,
		);
		expect(document.documentElement.dataset.theme).toBeUndefined();
	});

	it("is chosen in settings, and remembered", async () => {
		onWideScreen();
		mount("/suga/settings/profile");

		fireEvent.click(await screen.findByRole("radio", { name: "Light" }));

		await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
		expect(localStorage.getItem("sugabots-theme")).toBe("light");
	});

	it("stores nothing when dark is chosen, because that is the default", async () => {
		onWideScreen();
		localStorage.setItem("sugabots-theme", "light");
		mount("/suga/settings/profile");

		fireEvent.click(await screen.findByRole("radio", { name: "Dark" }));

		await waitFor(() => expect(document.documentElement.dataset.theme).toBeUndefined());
		expect(localStorage.getItem("sugabots-theme")).toBeNull();
	});
});

describe("your profile", () => {
	it("signs out, and re-asks who you are", async () => {
		client.auth.signOut.mockResolvedValue(undefined);
		const refresh = vi.fn();
		mount("/suga/settings/profile", sam, refresh);

		fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

		await waitFor(() => expect(client.auth.signOut).toHaveBeenCalled());
		// Dropping the token is not enough on its own: the guard reads the
		// session, so it has to be asked again before the route can send
		// anybody to the login page.
		await waitFor(() => expect(refresh).toHaveBeenCalled());
	});

	it("changes your name when you leave the field, and re-asks who you are", async () => {
		client.auth.updateName.mockResolvedValue({ status: true });
		const refresh = vi.fn();
		mount("/suga/settings/profile", sam, refresh);

		const name = await screen.findByRole("textbox", { name: "Name" });
		fireEvent.change(name, { target: { value: "  Samantha " } });
		fireEvent.blur(name);

		await waitFor(() => expect(client.auth.updateName).toHaveBeenCalledWith({ name: "Samantha" }));
		await waitFor(() => expect(refresh).toHaveBeenCalled());
	});

	it("shows your new name once the session has it, without a navigation", async () => {
		const router = createAppRouter({
			history: createMemoryHistory({ initialEntries: ["/suga/settings/profile"] }),
		});
		const queries = createQueryClient();
		const signedInAs = (user: SessionUser) => (
			<TestApp
				router={router}
				queries={queries}
				session={{ user, error: undefined, refresh: vi.fn() }}
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
		mount("/suga/settings/profile", sam);

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
	const projectPage = `/suga/settings/projects/${suga.slug}`;
	const botsPage = `${projectPage}/bots`;
	const peoplePage = `${projectPage}/people`;
	const samInProject = {
		userId: sam.id,
		name: sam.name,
		email: sam.email,
		image: null,
		// Sam administers the workspace, so is in every project for good.
		removable: false,
	};
	const junoInProject = {
		...samInProject,
		userId: juno.id,
		name: juno.name,
		email: juno.email,
		removable: true,
	};
	it("lists only the project's own bots, with nothing to say about built-in bots", async () => {
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
				payload: { userId: sam.id },
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
				params: { projectId: suga.id, userId: juno.id },
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

	it("lets a member leave a project, and nothing more", async () => {
		apiAnswers({ role: "member" });
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
		const router = mount(projectPage);

		fireEvent.click(await screen.findByRole("button", { name: "Delete project" }));
		expect(client.api.projects.remove).not.toHaveBeenCalled();
		fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

		await waitFor(() =>
			expect(client.api.projects.remove).toHaveBeenCalledWith({
				params: { projectId: suga.id },
			}),
		);
		await waitFor(() => expect(router.state.location.pathname).toBe("/suga/settings/projects"));
	});

	it("says so when a project with threads cannot be deleted", async () => {
		client.api.projects.remove.mockReturnValue(
			Effect.fail(new Conflict({ message: userText`The project still has threads` })),
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
			mutating: true,
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
			face: linear.face,
			shape: "circle",
		},
		projectId: project.id,
		conversationId: "0199a3a0-0000-7000-8000-0000000004b1",
		rootConversationId: "0199a3a0-0000-7000-8000-0000000004b1",
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
				unreadInInbox: 0,
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
		client.api.chats.projectMarkers.mockReturnValue(
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
		updates.emit(
			streamEvent("conversation.changed", { conversationId: waitingApproval.conversationId }),
		);

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
