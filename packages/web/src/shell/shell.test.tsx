import {
	type ApprovalRequest,
	type ModelProvider,
	type ProviderModel,
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
	agents,
	apiAnswers,
	builtInAgents,
	channelWith,
	compaction,
	controlledEventStream,
	jye,
	linear,
	MODELS,
	modelProviders,
	mount,
	onWideScreen,
	open,
	personalAssistant,
	personalPod,
	pods,
	sam,
	TestApp,
	threadWith,
	triager,
	VIEWER_IN_POD,
	workspace,
} from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const linearPage = `/suga/pods/suga-team/agents/${linear.handle}`;
/** Where `linearPage` lands: the bot's channel, at its own address. */
const linearConversationPage = `/suga/pods/suga-team/threads/${channelWith(linear).id}`;

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
		// `agent` and `history` were panels until the design made an agent a page
		// of its own and the Threads list the history. A link from then lands in
		// the app rather than in an error.
		mount(`${linearPage}?panel=agent`);

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

		await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/nitric\//));
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

		await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/nitric\//));
	});

	it("switches to another workspace from your menu and opens it next time", async () => {
		client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, other]));
		const router = mount(linearPage);

		await openWorkspaceMenu();
		fireEvent.click(await screen.findByRole("menuitem", { name: other.name }));

		await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/nitric\//));
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
		client.api.pods.list.mockReturnValue(Effect.succeed([personalPod]));
		client.api.agents.list.mockReturnValue(
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
		client.api.pods.list.mockReturnValue(Effect.succeed([personalPod]));
		client.api.agents.list.mockReturnValue(Effect.succeed([personalAssistant]));
		const named = { ...personalAssistant, name: "Chief", handle: "chief" };
		client.api.agents.update.mockImplementation(() => {
			client.api.agents.list.mockReturnValue(Effect.succeed([named]));
			return Effect.succeed(named);
		});
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
		fireEvent.click(await screen.findByRole("button", { name: "Start chatting" }));

		expect(await screen.findByRole("navigation", { name: "Sidebar" })).toBeDefined();
		expect(router.state.location.pathname).toBe("/suga/pods/personal/agents/chief");
	});

	it("says so, rather than opening an unfinished workspace, when it cannot tell who may finish it", async () => {
		client.api.workspaces.list.mockReturnValue(
			Effect.succeed([{ ...workspace, setupCompletedAt: null }]),
		);
		client.api.workspaceAccess.mockReturnValueOnce(
			Effect.fail(new Forbidden({ message: userText`Unavailable` })),
		);
		client.api.pods.list.mockReturnValue(Effect.succeed([personalPod]));
		client.api.agents.list.mockReturnValue(
			Effect.succeed([{ ...personalAssistant, model: "switched-off" }]),
		);
		const router = mount(`/${workspace.slug}/agents`);

		fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
		expect(screen.queryByRole("navigation", { name: "Sidebar" })).toBeNull();

		expect(await screen.findByRole("heading", { name: "Connect a provider" })).toBeDefined();
		expect(router.state.location.pathname).toBe("/onboarding");
	});

	it("opens an unfinished workspace as it is for somebody invited part way", async () => {
		apiAnswers({ role: "member" });
		client.api.workspaces.list.mockReturnValue(
			Effect.succeed([{ ...workspace, setupCompletedAt: null }]),
		);
		const router = mount(linearPage);

		expect(await screen.findByRole("navigation", { name: "Sidebar" })).toBeDefined();
		expect(router.state.location.pathname).toBe(linearPage);
	});

	it("cancels an unfinished workspace's setup into another workspace, keeping it for an admin, who may not delete it", async () => {
		const unfinished = { ...other, setupCompletedAt: null };
		client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, unfinished]));
		const router = mount(`/${unfinished.slug}/agents`);

		fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

		await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/suga\//));
		expect(client.api.workspaces.delete).not.toHaveBeenCalled();
	});

	it("opens a workspace that is set up from the root, rather than the one being set up", async () => {
		const unfinished = { ...other, setupCompletedAt: null };
		client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, unfinished]));
		chooseWorkspace(unfinished.id);
		const router = mount("/");

		expect(await screen.findByRole("navigation", { name: "Sidebar" })).toBeDefined();
		expect(router.state.location.pathname).toMatch(/^\/suga\//);
	});

	it("opens an unfinished workspace from the root for somebody invited part way, who has their own", async () => {
		apiAnswers({ role: "member" });
		const joined = { ...other, setupCompletedAt: null };
		client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, joined]));
		chooseWorkspace(joined.id);
		const router = mount("/");

		await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/nitric\//));
		expect(screen.queryByRole("heading", { name: "Connect a provider" })).toBeNull();
	});

	it("comes back to a workspace whose save a reload interrupted", async () => {
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
		await waitFor(() => expect(router.state.location.pathname).toBe(linearConversationPage));
		expect(client.api.workspaces.delete).not.toHaveBeenCalled();
	});

	it("cancels back to the page it came from before making one", async () => {
		client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, other]));
		const router = mount(linearPage);

		await startNewWorkspace(router);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		await waitFor(() => expect(router.state.location.pathname).toBe(linearConversationPage));
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

		await waitFor(() => expect(router.state.location.pathname).toBe(linearConversationPage));
		expect(client.api.workspaces.delete).toHaveBeenCalledWith({ params: { workspace: other.id } });
		expect(localStorage.getItem("sugabots-workspace")).toBe(workspace.id);
	});

	it("deletes an unfinished workspace when its owner cancels setting it up after a reload", async () => {
		apiAnswers({ role: "owner" });
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

		await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/nitric\//));
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

describe("the sidebar", () => {
	it("lists each shared pod, then Personal, one after another", async () => {
		client.api.pods.list.mockReturnValue(Effect.succeed([personalPod, ...pods]));
		mount(linearPage);

		const sidebar = await screen.findByRole("navigation", { name: "Sidebar" });
		await within(sidebar).findByRole("group", { name: "Personal" });
		expect(
			within(sidebar)
				.getAllByRole("group")
				.map((pod) => pod.getAttribute("aria-label")),
		).toEqual(["Suga-Team", "Sales", "Personal"]);
	});

	it("keeps listing every pod while you are away from them", async () => {
		const router = mount("/suga/pods/sales");

		const sidebar = await screen.findByRole("navigation", { name: "Sidebar" });
		await within(sidebar).findByRole("group", { name: "Sales" });
		await router.navigate({ to: "/$workspace/activity", params: { workspace: "suga" } });

		await waitFor(() => expect(router.state.location.pathname).toBe("/suga/activity"));
		expect(within(sidebar).getByRole("group", { name: "Sales" })).toBeDefined();
		expect(within(sidebar).getByRole("link", { name: "Inbox" }).getAttribute("aria-current")).toBe(
			"page",
		);
	});

	it("makes a new bot in the pod shown from its + beside Bots", async () => {
		mount(linearPage);

		const sidebar = await screen.findByRole("navigation", { name: "Sidebar" });
		fireEvent.click(await within(sidebar).findByRole("button", { name: "New bot in Suga-Team" }));
		const dialog = await screen.findByRole("dialog", { name: "New bot" });
		expect(within(dialog).queryByRole("button", { name: /^Pod:/ })).toBeNull();
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

describe("the pod's conversations", () => {
	it("lists a pod's chat, then its bots, each opening its channel with its threads folded under it", async () => {
		onWideScreen();
		const channelOf = (agent: typeof linear) => ({
			agent,
			conversation: channelWith(agent),
			unreadMessages: 0,
			needsApproval: false,
			mentionsYou: false,
		});
		client.api.chats.list.mockReturnValue(
			Effect.succeed({
				chats: [],
				routines: [],
				channels: [channelOf(linear), channelOf(triager)],
				threads: [
					{
						agent: linear,
						conversation: threadWith(linear),
						lastMessage: {
							preview: "File the timeout as a bug",
							authorUserId: sam.id,
							at: new Date().toISOString(),
						},
					},
				],
			}),
		);
		mount(linearPage);

		const sidebar = await screen.findByRole("group", { name: "Suga-Team" });
		const channel = await within(sidebar).findByRole("link", { name: linear.name });
		// Open on the bot while its channel is found, then on the channel once it has its address.
		await waitFor(() => expect(channel.getAttribute("aria-current")).toBe("page"));
		expect(within(sidebar).getByRole("link", { name: "General" })).toBeDefined();
		// The open channel's bot shows its threads; the others keep theirs folded away.
		expect(within(sidebar).getByRole("link", { name: threadWith(linear).title })).toBeDefined();
		expect(within(sidebar).getAllByRole("link", { name: "Routines" })).toHaveLength(1);
		expect(client.api.chats.list).toHaveBeenCalledWith({
			params: { workspace: workspace.id },
			query: { pod: pods[0]?.slug },
		});
	});

	it("keeps a bot's threads folded away while nothing of the bot's is open", async () => {
		onWideScreen();
		client.api.chats.list.mockReturnValue(
			Effect.succeed({
				chats: [],
				routines: [],
				threads: [{ agent: linear, conversation: threadWith(linear), lastMessage: null }],
			}),
		);
		mount("/suga/pods/suga-team");

		const sidebar = await screen.findByRole("group", { name: "Suga-Team" });
		expect(await within(sidebar).findByRole("link", { name: linear.name })).toBeDefined();
		expect(within(sidebar).queryByRole("link", { name: threadWith(linear).title })).toBeNull();
	});

	it("loads a thread while the pointer is on its row", async () => {
		const linearChat = {
			kind: "thread" as const,
			id: "0199a3a0-0000-7000-8000-0000000000c1",
			workspaceId: workspace.id,
			podId: linear.podId,
			hostAgentId: linear.id,
			title: `Conversation with ${linear.name}`,
			doneAt: null,
			createdAt: "2026-09-18T08:00:00.000Z",
			updatedAt: "2026-09-18T08:00:00.000Z",
		};
		const unread = { lastMessage: null, waitingOn: null, unreadMessages: 0, needsApproval: false };
		client.api.chats.list.mockReturnValue(
			Effect.succeed({
				chats: [],
				routines: [],
				channels: [
					{
						agent: linear,
						conversation: channelWith(linear),
						unreadMessages: 0,
						needsApproval: false,
						mentionsYou: false,
					},
				],
				threads: [{ agent: linear, conversation: linearChat, ...unread }],
			}),
		);
		// The bot's channel open, so its threads show under it.
		mount(linearPage);
		const sidebar = await screen.findByRole("group", { name: "Suga-Team" });

		fireEvent.mouseEnter(await within(sidebar).findByRole("link", { name: linearChat.title }));

		await waitFor(() =>
			expect(client.api.chats.messages).toHaveBeenCalledWith(
				expect.objectContaining({ params: { conversationId: linearChat.id } }),
			),
		);
		expect(client.api.threads.get).toHaveBeenCalledWith(
			expect.objectContaining({ params: { threadId: linearChat.id } }),
		);
		expect(client.api.chats.openBotChannel).not.toHaveBeenCalled();
	});

	it("offers a pod's first bot while it has none", async () => {
		client.api.chats.list.mockReturnValue(
			Effect.succeed({ chats: [], channels: [], threads: [], routines: [] }),
		);
		client.api.agents.list.mockReturnValue(
			Effect.succeed(agents.filter((agent) => agent.podId !== pods[1]?.id)),
		);
		mount("/suga/pods/sales");

		const sales = await screen.findByRole("group", { name: "Sales" });
		fireEvent.click(await within(sales).findByRole("button", { name: "Add a bot" }));
		expect(await screen.findByRole("dialog", { name: "New bot" })).toBeDefined();
	});

	it("offers no New bot to somebody who may not make one", async () => {
		client.api.pods.list.mockReturnValue(
			Effect.succeed(pods.map((pod) => ({ ...pod, permissions: VIEWER_IN_POD }))),
		);
		mount("/suga/pods/suga-team");

		const sidebar = await screen.findByRole("group", { name: "Suga-Team" });
		await within(sidebar).findByRole("heading", { name: "Bots" });
		expect(within(sidebar).queryByRole("button", { name: /^New bot/ })).toBeNull();
	});
});

describe("the settings navigation", () => {
	/*
	 * The workspace's sections, then each pod with its own pages, then you. The
	 * sections an administrator alone may open are left out for a member, so
	 * their list simply ends rather than showing gaps.
	 */

	it("lists a pod's Computer page only while the workspace has computers", async () => {
		mount("/suga/settings/pods/suga-team");
		const rail = await screen.findByRole("navigation", { name: "Settings" });
		const pods = await within(rail).findByRole("group", { name: "Pods" });
		expect(await within(pods).findByRole("link", { name: /^Bots/ })).toBeDefined();
		expect(within(pods).queryByRole("link", { name: "Computer" })).toBeNull();
		cleanup();

		client.api.sandboxProviders.access.mockReturnValue(Effect.succeed({ enabled: true }));
		mount("/suga/settings/pods/suga-team");
		const withComputers = await screen.findByRole("navigation", { name: "Settings" });
		expect(await within(withComputers).findByRole("link", { name: "Computer" })).toBeDefined();
	});

	it("remembers a pod closed, even while one of its pages is open", async () => {
		localStorage.clear();
		mount("/suga/settings/pods/suga-team");
		const rail = await screen.findByRole("navigation", { name: "Settings" });
		const pod = await within(rail).findByRole("button", { name: "Suga-Team" });
		expect(pod.getAttribute("aria-expanded")).toBe("true");

		fireEvent.click(pod);
		expect(pod.getAttribute("aria-expanded")).toBe("false");
		cleanup();

		mount("/suga/settings/pods/suga-team");
		const again = await screen.findByRole("navigation", { name: "Settings" });
		expect(
			(await within(again).findByRole("button", { name: "Suga-Team" })).getAttribute(
				"aria-expanded",
			),
		).toBe("false");
		localStorage.clear();
	});

	it("lists your settings first, then the workspace's sections and its pods", async () => {
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

	it("opens a pod onto its pages, and keeps the open pod's open", async () => {
		onWideScreen();
		const router = mount("/suga/settings");

		const rail = await screen.findByRole("navigation", { name: "Settings" });
		const pod = await within(rail).findByRole("button", { name: "Suga-Team" });
		expect(pod.getAttribute("aria-expanded")).toBe("false");

		fireEvent.click(pod);
		fireEvent.click(await within(rail).findByRole("link", { name: "People" }));

		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/suga/settings/pods/suga-team/people"),
		);
		const opened = within(await settingsNavigation()).getByRole("button", { name: "Suga-Team" });
		expect(opened.getAttribute("aria-expanded")).toBe("true");
		expect(await screen.findByRole("heading", { name: "People" })).toBeDefined();
	});

	it("counts what each section and pod page holds, beside its name", async () => {
		mount("/suga/settings/pods/suga-team");

		const rail = await screen.findByRole("navigation", { name: "Settings" });

		// The name carries the count, so it is read as a pair rather than "People2".
		expect(await within(rail).findByRole("link", { name: "People, 2" })).toBeDefined();
		// Crew only: the Scribe and Compaction belong to the workspace rather
		// than to a pod, so they are not counted among its bots.
		expect(await within(rail).findByRole("link", { name: "Bots, 2" })).toBeDefined();
		// General holds nothing to count: yours, the workspace's or the pod's.
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
		await screen.findByText("Workspace with 1 member and 2 pods");
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

	/** Opens Linear's settings from its pod's Bots, as a person would. */
	async function openLinearFromItsPod() {
		const main = await screen.findByRole("main");
		fireEvent.click(await within(main).findByRole("link", { name: new RegExp(linear.name) }));
		await screen.findByRole("heading", { name: linear.name });
	}

	it("goes back to the pod's Bots a bot was opened from", async () => {
		const router = mount("/suga/settings/pods/suga-team/bots");
		await openLinearFromItsPod();

		fireEvent.click(await pageBack("Bots"));

		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/suga/settings/pods/suga-team/bots"),
		);
		expect(await screen.findByText("2 bots in Suga-Team")).toBeDefined();
	});

	it("names each page on the way down to an open bot, each a link up but the last", async () => {
		mount(`/suga/settings/pods/suga-team/agents/${linear.handle}`);

		const trail = await screen.findByRole("navigation", { name: "Breadcrumb" });
		expect(await within(trail).findByRole("link", { name: "Suga-Team settings" })).toBeDefined();
		expect(within(trail).getByRole("link", { name: "Bots" }).getAttribute("href")).toBe(
			"/suga/settings/pods/suga-team/bots",
		);
		expect(await within(trail).findByText(linear.name)).toBeDefined();
		expect(within(trail).queryByRole("link", { name: linear.name })).toBeNull();
	});

	it("starts over when a section is picked from the navigation", async () => {
		onWideScreen();
		const router = mount("/suga/settings/pods/suga-team/bots");
		await openLinearFromItsPod();

		fireEvent.click(within(await settingsNavigation()).getByRole("link", { name: "People, 2" }));

		await waitFor(() => expect(router.state.location.pathname).toBe("/suga/settings/members"));
		// Back goes to the list of sections, not to the bot it was opened after.
		expect(await pageBack("Settings")).toBeDefined();
		expect(screen.queryByRole("link", { name: "Bots" })).toBeNull();
	});

	it("starts over when a new pod opens", async () => {
		onWideScreen();
		const made = { ...pods[0], id: "new", name: "Platform", slug: "platform" };
		client.api.pods.create.mockReturnValue(Effect.succeed(made));
		mount("/suga/settings/pods/suga-team/bots");
		await openLinearFromItsPod();

		fireEvent.click(
			await within(await settingsNavigation()).findByRole("button", { name: "New pod" }),
		);
		const dialog = await screen.findByRole("dialog", { name: "New pod" });
		fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Platform" } });
		client.api.pods.list.mockReturnValue(Effect.succeed([...pods, made]));
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

describe("routes", () => {
	it("lands on the first shared pod", async () => {
		const router = mount("/");

		await waitFor(() =>
			expect(router.state.location.pathname.startsWith("/suga/pods/suga-team")).toBe(true),
		);
	});

	it("lands on Personal for somebody in no shared pod", async () => {
		client.api.pods.list.mockReturnValue(Effect.succeed([personalPod]));
		const router = mount("/");

		await waitFor(() => expect(router.state.location.pathname).toBe("/suga/pods/personal"));
	});

	it("sends somebody signed out to the login page, remembering where they were going", async () => {
		const destination = `${linearPage}?thread=0199a3a0-0000-7000-8000-0000000000aa`;
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
		const destination = `/suga/settings/pods/suga-team/agents/${linear.handle}?tab=routines`;
		const router = mount(`/login?returnTo=${encodeURIComponent(destination)}`);

		expect(await screen.findByRole("link", { name: /^Routines/ })).toBeDefined();
		expect(router.state.location.href).toBe(destination);
	});

	it("will not return from the login page to another site", async () => {
		const router = mount(`/login?returnTo=${encodeURIComponent("//evil.example/steal")}`);

		await waitFor(() => expect(router.state.location.pathname).toBe("/suga/agents"));
	});

	it("walks a new workspace from its first bot to its chat", async () => {
		client.api.pods.list.mockReturnValue(Effect.succeed([personalPod]));
		client.api.agents.list.mockReturnValue(Effect.succeed([personalAssistant]));
		const named = {
			...personalAssistant,
			name: "Chief",
			handle: "chief",
			color: "purple" as const,
		};
		client.api.agents.update.mockImplementation(() => {
			client.api.agents.list.mockReturnValue(Effect.succeed([named]));
			return Effect.succeed(named);
		});
		client.api.onboarding.complete.mockReturnValue(Effect.void);
		const router = mount(`/onboarding?workspace=${workspace.slug}`);

		expect(await screen.findByRole("heading", { name: "Make your first bot" })).toBeDefined();
		await waitFor(() => expect(router.state.location.pathname).toBe("/onboarding"));
		const create = screen.getByRole("button", { name: "Create bot" });
		expect(create.hasAttribute("disabled")).toBe(true);
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Chief" } });
		fireEvent.click(screen.getByRole("radio", { name: "purple" }));
		fireEvent.click(create);

		await waitFor(() =>
			expect(client.api.agents.update).toHaveBeenCalledWith({
				params: { agentId: personalAssistant.id },
				payload: {
					name: "Chief",
					color: "purple",
					shape: "circle",
					face: "pill",
				},
			}),
		);
		expect(await screen.findByRole("heading", { name: "Bring your friends" })).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));

		expect(await screen.findByRole("heading", { name: "Chief is ready" })).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Start chatting" }));

		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/suga/pods/personal/agents/chief"),
		);
	});

	it("invites the addresses typed, and says how many it will send", async () => {
		client.api.pods.list.mockReturnValue(Effect.succeed([personalPod]));
		client.api.agents.list.mockReturnValue(
			Effect.succeed([{ ...personalAssistant, name: "Chief" }]),
		);
		client.api.agents.update.mockReturnValue(Effect.succeed(personalAssistant));
		client.api.workspaces.invite.mockReturnValue(Effect.succeed({ id: "an-invitation" }));
		mount(`/onboarding?workspace=${workspace.slug}`);

		fireEvent.click(await screen.findByRole("button", { name: "Create bot" }));
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
		client.api.pods.list.mockReturnValue(Effect.succeed([personalPod]));
		client.api.agents.list.mockReturnValue(
			Effect.succeed([{ ...personalAssistant, model: "switched-off" }]),
		);
		mount(`/onboarding?workspace=${workspace.slug}`);

		expect(await screen.findByRole("heading", { name: "Connect a provider" })).toBeDefined();
		expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
	});

	it("adds the first provider from the Models picker, then switches on the model chosen for the first bot", async () => {
		client.api.pods.list.mockReturnValue(Effect.succeed([personalPod]));
		client.api.agents.list.mockReturnValue(Effect.succeed([personalAssistant]));
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
		client.api.agents.update.mockReturnValue(
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
			expect(client.api.agents.update).toHaveBeenCalledWith({
				params: { agentId: personalAssistant.id },
				payload: { model: "mistral/large" },
			}),
		);
		expect(client.api.modelProviders.updateModel).toHaveBeenCalledWith({
			params: { workspace: workspace.id, providerId: openrouter.id, modelId: large?.id },
			payload: { enabled: true },
		});
		expect(client.api.modelProviders.setModelsEnabled).not.toHaveBeenCalled();
		expect(await screen.findByRole("heading", { name: "Make your first bot" })).toBeDefined();
	});

	it("still honours the older ?invite= link shape", async () => {
		client.api.workspaces.invitation.mockReturnValue(
			Effect.succeed({ status: "pending", workspaceName: "Nitric", inviterName: "Sam" }),
		);

		const router = mount("/?invite=an-invitation");

		await waitFor(() => {
			expect(router.state.location.pathname).toBe("/invite/an-invitation");
		});
		expect(await screen.findByText("You have been invited to Nitric.")).toBeDefined();
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
			Effect.succeed({ status: "pending", workspaceName: "Nitric", inviterName: "Sam" }),
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

		await waitFor(() => expect(router.state.location.pathname).toBe("/suga/agents"));
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
			Effect.succeed({ status: "pending", workspaceName: "Nitric", inviterName: "Sam" }),
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

		await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/nitric\//));
	});

	it("leads back into the workspace from an invitation already accepted", async () => {
		client.api.workspaces.invitation.mockReturnValue(
			Effect.succeed({ status: "accepted", workspaceId: workspace.id }),
		);
		const refresh = vi.fn().mockResolvedValue(undefined);
		const router = mount("/invite/an-invitation", sam, refresh);

		await waitFor(() => expect(router.state.location.pathname).toBe("/suga/agents"));
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

	it("says so when the agent in the address is not there", async () => {
		mount("/suga/pods/suga-team/agents/missing");

		expect(await screen.findByText("No such agent here")).toBeDefined();
	});

	it("distinguishes a failed agent roster from an unknown agent", async () => {
		client.api.agents.list.mockReturnValue(
			Effect.fail(new Forbidden({ message: userText`Unavailable` })),
		);
		mount(linearPage);

		expect(await screen.findByText("Could not load this agent")).toBeDefined();
		expect(screen.queryByText("No such agent here")).toBeNull();
	});

	it("says so when the pod in the address is not there", async () => {
		mount("/suga/pods/missing");

		expect(await screen.findByText("No such pod here")).toBeDefined();
	});
});

describe("creating a pod", () => {
	/*
	 * NIT-1799. The API refuses a member either way, so what these are about is
	 * whether the control is *drawn*: a control that cannot work teaches people
	 * that things here sometimes do not.
	 */

	it("offers a member nothing", async () => {
		onWideScreen();
		apiAnswers({ role: "member" });
		mount("/suga/settings");

		// Waiting on the pods waits on the answers the controls beside them are drawn from.
		const rail = await screen.findByRole("navigation", { name: "Settings" });
		await within(rail).findByRole("button", { name: "Suga-Team" });

		expect(screen.queryByRole("button", { name: "New pod" })).toBeNull();
	});

	/** Opens New pod, beside Pods in the settings navigation. */
	async function openNewPod() {
		const rail = await screen.findByRole("navigation", { name: "Settings" });
		fireEvent.click(await within(rail).findByRole("button", { name: "New pod" }));
	}

	it("waits for a name before it can make a pod", async () => {
		onWideScreen();
		mount("/suga/settings");
		await openNewPod();

		const dialog = await screen.findByRole("dialog", { name: "New pod" });
		const create = within(dialog).getByRole("button", { name: "Create" });
		expect(create.hasAttribute("disabled")).toBe(true);
		fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Platform Team" } });
		expect(create.hasAttribute("disabled")).toBe(false);
	});

	it("creates one in a colour no other pod has, and opens it", async () => {
		onWideScreen();
		const made = { ...pods[0], id: "new", name: "Platform", slug: "platform" };
		client.api.pods.create.mockReturnValue(Effect.succeed(made));

		mount("/suga/settings");
		await openNewPod();

		const dialog = await screen.findByRole("dialog", { name: "New pod" });
		fireEvent.change(within(dialog).getByLabelText("Name"), {
			target: { value: "Platform" },
		});

		client.api.pods.list.mockReturnValue(Effect.succeed([...pods, made]));
		within(dialog).getByRole("button", { name: "Create" }).click();

		await waitFor(() => {
			expect(client.api.pods.create).toHaveBeenCalledWith({
				params: { workspace: workspace.id },
				// Its colour is the one the workspace's green and blue pods leave first.
				payload: { name: "Platform", color: "plum" },
			});
		});
		expect(await screen.findByRole("heading", { name: "Platform" })).toBeDefined();
	});

	it("says so when the address is already taken, and keeps the form open", async () => {
		onWideScreen();
		client.api.pods.create.mockReturnValue(
			Effect.fail(new Conflict({ message: userText`already exists` })),
		);

		mount("/suga/settings");
		await openNewPod();

		const dialog = await screen.findByRole("dialog", { name: "New pod" });
		fireEvent.change(within(dialog).getByLabelText("Name"), {
			target: { value: "Sales" },
		});
		within(dialog).getByRole("button", { name: "Create" }).click();

		expect(await within(dialog).findByRole("alert")).toBeDefined();
		expect(screen.getByRole("dialog", { name: "New pod" })).toBeDefined();
	});
});

describe("Personal pod settings", () => {
	it("opens on its Connections, with no General or People, so nothing to rename or delete", async () => {
		client.api.pods.list.mockReturnValue(Effect.succeed([personalPod, ...pods]));

		const router = mount(`/suga/settings/pods/${personalPod.slug}`);

		await waitFor(() =>
			expect(router.state.location.pathname).toBe(
				`/suga/settings/pods/${personalPod.slug}/connections`,
			),
		);
		expect(await screen.findByRole("heading", { name: "Connections", level: 2 })).toBeDefined();
		const rail = await screen.findByRole("navigation", { name: "Settings" });
		// Apart from the shared pods, in a group of its own, with only the pages it has.
		const personal = within(rail).getByRole("group", { name: "Personal pods" });
		expect(within(personal).getByRole("button", { name: "Personal" })).toBeDefined();
		expect(within(personal).getByRole("link", { name: /^Connections/ })).toBeDefined();
		expect(within(personal).getByRole("link", { name: /^Bots/ })).toBeDefined();
		expect(within(personal).queryByRole("link", { name: "General" })).toBeNull();
		expect(within(personal).queryByRole("link", { name: /^People/ })).toBeNull();
		expect(screen.queryByRole("button", { name: "Delete pod" })).toBeNull();
	});

	it("sends its People page to its Connections", async () => {
		client.api.pods.list.mockReturnValue(Effect.succeed([personalPod, ...pods]));

		const router = mount(`/suga/settings/pods/${personalPod.slug}/people`);

		await waitFor(() =>
			expect(router.state.location.pathname).toBe(
				`/suga/settings/pods/${personalPod.slug}/connections`,
			),
		);
	});
});

describe("creating an agent", () => {
	it("offers a member of the pod the same New bot action as an admin", async () => {
		mount(`/suga/settings/pods/${pods[0]?.slug}/bots`);

		expect(await screen.findByRole("button", { name: "New bot" })).toBeDefined();
		cleanup();
		vi.clearAllMocks();

		apiAnswers({ role: "member" });
		mount(`/suga/settings/pods/${pods[0]?.slug}/bots`);

		expect(await screen.findByRole("button", { name: "New bot" })).toBeDefined();
	});

	it("keeps deleting pods, and making them, to those allowed them", async () => {
		mount(`/suga/settings/pods/${pods[0]?.slug}`);

		const rail = await screen.findByRole("navigation", { name: "Settings" });
		expect(await within(rail).findByRole("button", { name: "New pod" })).toBeDefined();
		expect(await screen.findByRole("button", { name: "Delete pod" })).toBeDefined();
		cleanup();
		vi.clearAllMocks();

		apiAnswers({ role: "member" });
		mount(`/suga/settings/pods/${pods[0]?.slug}`);
		await screen.findByRole("heading", { name: pods[0]?.name });

		expect(screen.queryByRole("button", { name: "New pod" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Delete pod" })).toBeNull();
	});

	it("creates a bot in the look and colour chosen, in its pod, and opens its settings", async () => {
		onWideScreen();
		const made = {
			...linear,
			id: "0199a3a0-0000-7000-8000-0000000000c9",
			name: "Release Coordinator",
			handle: "release-coordinator",
			model: MODELS[0] as string,
			podId: pods[0]?.id as string,
		};
		client.api.agents.create.mockReturnValue(Effect.succeed(made));
		const router = mount(`/suga/settings/pods/${pods[0]?.slug}/bots`);
		(await screen.findByRole("button", { name: "New bot" })).click();

		const dialog = await screen.findByRole("dialog", { name: "New bot" });
		fireEvent.change(within(dialog).getByLabelText("Name"), {
			target: { value: `  ${made.name}  ` },
		});
		fireEvent.click(within(dialog).getByRole("button", { name: "Colour, shape and eyes" }));
		fireEvent.click(within(dialog).getByRole("radio", { name: "orange" }));
		fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
		client.api.agents.list.mockReturnValue(Effect.succeed([...agents, made]));
		within(dialog).getByRole("button", { name: "Create" }).click();

		await waitFor(() => {
			expect(client.api.agents.create).toHaveBeenCalledWith({
				params: { podId: made.podId },
				// The looks on offer are drawn at random; the colour is the one chosen.
				payload: {
					name: made.name,
					model: made.model,
					color: "orange",
					shape: expect.any(String),
					face: expect.any(String),
				},
			});
		});
		await waitFor(() =>
			expect(router.state.location.pathname).toBe(
				`/suga/settings/pods/${pods[0]?.slug}/agents/${made.handle}`,
			),
		);
		expect(screen.queryByRole("dialog", { name: "New bot" })).toBeNull();
		expect((await screen.findAllByText(made.name)).length).toBeGreaterThan(0);
	});

	it("on a phone, chooses the look on a page of its own, from the bot's face", async () => {
		client.api.agents.create.mockReturnValue(Effect.succeed({ ...linear, name: "Scout" }));
		mount(`/suga/settings/pods/${pods[0]?.slug}/bots`);
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
			expect(client.api.agents.create).toHaveBeenCalledWith(
				expect.objectContaining({
					payload: expect.objectContaining({ name: "Scout", color: "orange" }),
				}),
			),
		);
	});

	it("keeps a duplicate-name error in the creation form", async () => {
		client.api.agents.create.mockReturnValue(
			Effect.fail(new Conflict({ message: userText`already exists` })),
		);
		mount(`/suga/settings/pods/${pods[0]?.slug}/bots`);
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
	it("opens the first pod when none is chosen", async () => {
		mount("/suga/settings/pods");

		expect(await screen.findByRole("heading", { name: pods[0]?.name })).toBeDefined();
		expect(screen.queryByText("Choose a pod")).toBeNull();
	});

	it("picks out the open pod's page in the navigation", async () => {
		const pod = pods[0] as (typeof pods)[number];
		mount(`/suga/settings/pods/${pod.slug}`);

		const rail = await screen.findByRole("navigation", { name: "Settings" });
		expect(
			(await within(rail).findByRole("button", { name: pod.name })).getAttribute("aria-expanded"),
		).toBe("true");
		const current = within(rail)
			.getAllByRole("link")
			.filter((link) => link.getAttribute("aria-current") === "page");
		expect(current.map((link) => link.getAttribute("href"))).toEqual([
			`/suga/settings/pods/${pod.slug}`,
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
		client.api.systemAgents.update.mockReturnValue(Effect.succeed(builtInAgents[0]));
		const router = mount("/suga/settings/providers");

		fireEvent.click(await screen.findByRole("link", { name: /Summaries/ }));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/suga/settings/providers/system"),
		);
		fireEvent.click(await screen.findByRole("button", { name: "gpt-5" }));

		await waitFor(() => {
			for (const key of ["summarise", "compact"]) {
				expect(client.api.systemAgents.update).toHaveBeenCalledWith({
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
		enabledModelCount: 0,
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
			enabledModelCount: 0,
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
			enabledModelCount: 0,
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
			enabledModelCount: 0,
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

	const jyePage = "/suga/settings/members/0199a3a0-0000-7000-8000-0000000000d2";
	const samPage = "/suga/settings/members/0199a3a0-0000-7000-8000-0000000000d1";

	it("invites every address typed, with the role chosen", async () => {
		client.api.workspaces.invite.mockReturnValue(Effect.succeed({ id: "an-invitation" }));
		mount("/suga/settings/members");
		const panel = await openInvitePanel();

		fireEvent.change(within(panel).getByLabelText("Email addresses"), {
			target: { value: "jye@example.com, kim@example.com" },
		});
		expect(within(panel).getByText("Builds agents in the pods they are added to.")).toBeDefined();
		fireEvent.click(within(panel).getByRole("radio", { name: "Viewer" }));
		expect(
			within(panel).getByText("Reads and takes part in the pods they are added to."),
		).toBeDefined();
		fireEvent.click(within(panel).getByRole("button", { name: "Send" }));

		await waitFor(() => {
			expect(client.api.workspaces.invite).toHaveBeenCalledWith({
				params: { workspace: workspace.id },
				payload: { email: "jye@example.com", role: "viewer", resend: undefined },
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
		fireEvent.change(emails, { target: { value: "jye@example.com kim@example.com" } });

		fireEvent.click(within(panel).getByRole("button", { name: "Send" }));

		expect((await within(panel).findByRole("alert")).textContent).toContain("kim@example.com");
		expect((emails as HTMLInputElement).value).toBe("kim@example.com");
	});

	it("lists each person with their role, and opens their page", async () => {
		const router = mount("/suga/settings/members");

		const row = await screen.findByRole("link", { name: new RegExp(jye.name) });
		expect(row.textContent).toContain("Member");
		expect(screen.getByRole("link", { name: new RegExp(sam.name) }).textContent).toContain("(you)");
		fireEvent.click(row);

		await waitFor(() => expect(router.state.location.pathname).toBe(jyePage));
		expect(await screen.findByRole("heading", { name: jye.name })).toBeDefined();
	});

	it("changes what somebody may do from their page", async () => {
		mount(jyePage);

		fireEvent.click(await screen.findByRole("radio", { name: "Viewer" }));

		await waitFor(() => {
			expect(client.api.workspaces.updateMember).toHaveBeenCalledWith({
				params: { workspace: workspace.id, memberId: "0199a3a0-0000-7000-8000-0000000000d2" },
				payload: { role: "viewer" },
			});
		});
	});

	it("puts somebody in a pod from their page", async () => {
		client.api.pods.addMember.mockReturnValue(Effect.void);
		mount(jyePage);

		const toggle = await screen.findByRole("switch", { name: `${jye.name} is in Suga-Team` });
		// Disabled until the pod's people have loaded.
		await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
		fireEvent.click(toggle);

		await waitFor(() =>
			expect(client.api.pods.addMember).toHaveBeenCalledWith({
				params: { podId: pods[0]?.id },
				payload: { userId: jye.id },
			}),
		);
	});

	it("asks before removing somebody, says what goes with them, and returns to the list", async () => {
		const router = mount(jyePage);

		fireEvent.click(await screen.findByRole("button", { name: "Remove from workspace" }));

		expect(await screen.findByRole("heading", { name: `Remove ${jye.name}?` })).toBeDefined();
		expect(screen.getByText(/their Personal pod and its conversations are deleted/)).toBeDefined();
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

		expect((await screen.findByRole("link", { name: new RegExp(jye.name) })).textContent).toContain(
			"Member",
		);
		expect(screen.queryByRole("button", { name: "Invite people" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Resend" })).toBeNull();
		cleanup();

		mount(jyePage);
		expect(await screen.findByRole("heading", { name: jye.name })).toBeDefined();
		expect(screen.queryByRole("radio", { name: "Viewer" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Remove from workspace" })).toBeNull();
		expect(
			(await screen.findByRole("switch", { name: `${jye.name} is in Suga-Team` })).hasAttribute(
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

	it("opens a pod on a page of its parts, each a page of its own", async () => {
		mount("/suga/you");

		const settings = await screen.findByRole("region", { name: "Settings" });
		fireEvent.click(await within(settings).findByRole("link", { name: pods[0]?.name }));
		const pod = await screen.findByRole("region", { name: pods[0]?.name });
		// Opened from Settings, so plainly Back, which returns there.
		expect(within(pod).getByRole("link", { name: "Back" }).getAttribute("href")).toBe("/suga/you");
		expect(within(pod).getByRole("link", { name: /^Bots/ }).getAttribute("href")).toBe(
			`/suga/settings/pods/${pods[0]?.slug}/bots`,
		);
	});

	it("opens General by name, with the way back to Settings", async () => {
		mount("/suga/settings/general");

		expect(await screen.findByText("Time zone")).toBeDefined();
		const page = screen.getByRole("main");
		expect(within(page).getByRole("link", { name: "Settings" }).getAttribute("href")).toBe(
			"/suga/you",
		);
	});

	it("leads from one of a pod's pages back to the pod's page in You", async () => {
		mount(`/suga/settings/pods/${pods[0]?.slug}/people`);

		const page = await screen.findByRole("main");
		const back = await within(page).findByRole("link", { name: pods[0]?.name });
		expect(back.getAttribute("href")).toBe(`/suga/you/pods/${pods[0]?.slug}`);
	});

	it("leads from a bot back to its pod's Bots", async () => {
		mount(`/suga/settings/pods/${pods[0]?.slug}/agents/${linear.handle}`);

		const page = await screen.findByRole("main");
		expect((await within(page).findByRole("link", { name: "Bots" })).getAttribute("href")).toBe(
			`/suga/settings/pods/${pods[0]?.slug}/bots`,
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

describe("pod settings", () => {
	const [suga] = pods;
	if (!suga) throw new Error("fixture");
	const podPage = `/suga/settings/pods/${suga.slug}`;
	const botsPage = `${podPage}/bots`;
	const peoplePage = `${podPage}/people`;
	const samInPod = {
		userId: sam.id,
		name: sam.name,
		email: sam.email,
		image: null,
		addedAt: "2026-09-09T00:00:00.000Z",
		// Sam administers the workspace, so is in every shared pod for good.
		removable: false,
	};
	const jyeInPod = {
		...samInPod,
		userId: jye.id,
		name: jye.name,
		email: jye.email,
		removable: true,
	};
	it("lists only crew in a pod, with nothing to say about built-in agents", async () => {
		mount(botsPage);

		// The sidebar names each bot too, by a link to its channel.
		const settings = await screen.findByRole("main");
		// Each row reads as the bot's name, then what it does.
		expect(
			await within(settings).findByRole("link", { name: new RegExp(`^${linear.name}`) }),
		).toBeDefined();
		expect(screen.queryByText("User agents")).toBeNull();
		expect(screen.queryByText("System agents")).toBeNull();
		expect(screen.queryByRole("link", { name: new RegExp(compaction.name) })).toBeNull();
	});

	it("adds somebody from the workspace", async () => {
		client.api.pods.addMember.mockReturnValue(Effect.void);
		mount(peoplePage);

		open(await screen.findByRole("button", { name: "Add people" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: sam.name }));

		await waitFor(() =>
			expect(client.api.pods.addMember).toHaveBeenCalledWith({
				params: { podId: suga.id },
				payload: { userId: sam.id },
			}),
		);
	});

	it("asks before removing somebody from the pod", async () => {
		client.api.pods.listMembers.mockImplementation(() => Effect.succeed([samInPod, jyeInPod]));
		client.api.pods.removeMember.mockReturnValue(Effect.void);
		mount(peoplePage);

		fireEvent.click(await screen.findByRole("button", { name: `Remove ${jye.name}` }));

		expect(
			await screen.findByRole("dialog", { name: `Remove ${jye.name} from ${suga.name}?` }),
		).toBeDefined();
		expect(client.api.pods.removeMember).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Remove" }));

		await waitFor(() =>
			expect(client.api.pods.removeMember).toHaveBeenCalledWith({
				params: { podId: suga.id, userId: jye.id },
			}),
		);
	});

	// Sam is signed in, and an administrator unless a case says otherwise.
	it("gives an administrator no way off a shared pod", async () => {
		client.api.pods.listMembers.mockImplementation(() => Effect.succeed([samInPod, jyeInPod]));
		mount(peoplePage);

		expect(await screen.findByRole("button", { name: `Remove ${jye.name}` })).toBeDefined();
		expect(screen.queryByRole("button", { name: `Leave ${suga.name}` })).toBeNull();
		expect(screen.queryByRole("button", { name: `Remove ${sam.name}` })).toBeNull();
	});

	it("lets a member leave a pod, and nothing more", async () => {
		apiAnswers({ role: "member" });
		client.api.pods.listMembers.mockImplementation(() => Effect.succeed([samInPod, jyeInPod]));
		client.api.pods.leave.mockReturnValue(Effect.void);
		mount(peoplePage);

		fireEvent.click(await screen.findByRole("button", { name: `Leave ${suga.name}` }));
		expect(screen.queryByRole("button", { name: `Remove ${jye.name}` })).toBeNull();

		expect(await screen.findByRole("dialog", { name: `Leave ${suga.name}?` })).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Leave" }));

		await waitFor(() =>
			expect(client.api.pods.leave).toHaveBeenCalledWith({ params: { podId: suga.id } }),
		);
	});

	it("says when everyone in the workspace is already in", async () => {
		client.api.pods.listMembers.mockImplementation(() => Effect.succeed([samInPod, jyeInPod]));
		mount(peoplePage);

		open(await screen.findByRole("button", { name: "Add people" }));

		expect(
			await screen.findByRole("menuitem", {
				name: "Everyone in the workspace is here.",
			}),
		).toBeDefined();
	});

	it("offers a member the lists and none of the controls", async () => {
		apiAnswers({ role: "member" });
		client.api.pods.listMembers.mockImplementation(() => Effect.succeed([samInPod]));
		mount(botsPage);
		expect(await within(await screen.findByRole("main")).findByText(linear.name)).toBeDefined();
		cleanup();

		mount(peoplePage);
		expect(await within(await screen.findByRole("main")).findByText(sam.name)).toBeDefined();
		expect(screen.queryByRole("button", { name: "Add people" })).toBeNull();
		expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
		cleanup();

		mount(podPage);
		await screen.findByRole("heading", { name: suga.name });
		expect(screen.queryByRole("button", { name: "Delete pod" })).toBeNull();
		expect(screen.queryByLabelText("Name")).toBeNull();
	});

	it("deletes the pod after asking, and returns to the list", async () => {
		client.api.pods.remove.mockReturnValue(Effect.void);
		const router = mount(podPage);

		fireEvent.click(await screen.findByRole("button", { name: "Delete pod" }));
		expect(client.api.pods.remove).not.toHaveBeenCalled();
		fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

		await waitFor(() =>
			expect(client.api.pods.remove).toHaveBeenCalledWith({
				params: { podId: suga.id },
			}),
		);
		await waitFor(() => expect(router.state.location.pathname).toBe("/suga/settings/pods"));
	});

	it("says so when a pod with threads cannot be deleted", async () => {
		client.api.pods.remove.mockReturnValue(
			Effect.fail(new Conflict({ message: userText`The pod still has threads` })),
		);
		mount(podPage);

		fireEvent.click(await screen.findByRole("button", { name: "Delete pod" }));
		fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

		expect(await screen.findByRole("alert")).toBeDefined();
	});
});

describe("the app's badge", () => {
	const pod = pods[0] as (typeof pods)[number];
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
		agent: {
			kind: "agent",
			id: linear.id,
			name: linear.name,
			handle: linear.handle,
			color: linear.color,
			face: linear.face,
			shape: "circle",
		},
		podId: pod.id,
		threadId: "0199a3a0-0000-7000-8000-0000000004b1",
		conversationId: "0199a3a0-0000-7000-8000-0000000004b1",
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

	it("counts approvals waiting on you on the app's icon and in the title", async () => {
		const { setAppBadge } = badging();
		pageTitle();
		client.api.chats.approvals.mockReturnValue(
			Effect.succeed({ waiting: [waitingApproval], answered: [] }),
		);
		mount(linearPage);

		await waitFor(() => expect(document.title).toBe("(1) Sugabots"));
		expect(setAppBadge).toHaveBeenCalledWith(1);
	});

	it("puts the count after the app's name in an installed window, which would otherwise repeat the name", async () => {
		installedApp();
		pageTitle();
		client.api.chats.approvals.mockReturnValue(
			Effect.succeed({ waiting: [waitingApproval], answered: [] }),
		);
		mount(linearPage);

		await waitFor(() => expect(document.title).toBe("Sugabots (1)"));
	});

	it("leaves the icon and the title alone for unread messages that are not for you", async () => {
		const { setAppBadge } = badging();
		pageTitle();
		client.api.chats.podMarkers.mockReturnValue(
			Effect.succeed({ pods: { [pod.id]: { unreadMessages: 2, needsApproval: false } } }),
		);
		mount(linearPage);

		fireEvent.click(await screen.findByRole("button", { name: "Suga-Team" }));
		await within(screen.getByRole("group", { name: "Suga-Team" })).findByText(/2 unread messages/);
		expect(document.title).toBe("Sugabots");
		expect(setAppBadge).not.toHaveBeenCalled();
	});

	it("clears the icon and the title once nothing is waiting", async () => {
		const { clearAppBadge } = badging();
		pageTitle();
		const updates = controlledEventStream();
		client.events.workspace.mockReturnValue(updates.stream);
		client.api.chats.approvals.mockReturnValue(
			Effect.succeed({ waiting: [waitingApproval], answered: [] }),
		);
		mount(linearPage);
		await waitFor(() => expect(document.title).toBe("(1) Sugabots"));
		clearAppBadge.mockClear();

		client.api.chats.approvals.mockReturnValue(Effect.succeed({ waiting: [], answered: [] }));
		updates.emit(streamEvent("thread.changed", { threadId: waitingApproval.threadId }));

		await waitFor(() => expect(document.title).toBe("Sugabots"));
		expect(clearAppBadge).toHaveBeenCalled();
	});
});
