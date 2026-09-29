import type { ModelProvider, ProviderModel } from "@sugabots/contracts";
import { Conflict, Forbidden, InternalServerError } from "@sugabots/contracts/http";
import { failureForStatus } from "@sugabots/sdk";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { chooseWorkspace } from "@/lib/workspace.ts";
import {
	agents,
	apiAnswers,
	builtInAgents,
	facilitator,
	jye,
	linear,
	MODELS,
	modelProviders,
	mount,
	open,
	personalAssistant,
	personalPod,
	pods,
	sam,
	triager,
	VIEWER_IN_POD,
	workspace,
} from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const linearPage = `/suga/pods/suga-team/agents/${linear.handle}`;

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
	};

	it("keeps a workspace choice in memory when storage is unavailable", async () => {
		client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, other]));
		const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
			throw new Error("Storage disabled");
		});
		const router = mount(linearPage);
		await screen.findByRole("navigation", { name: "Pods" });

		chooseWorkspace(other.id);
		await router.navigate({ to: "/" });

		await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/nitric\//));
		setItem.mockRestore();
	});

	it("follows workspace choices made in another tab", async () => {
		client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, other]));
		const router = mount(linearPage);
		await screen.findByRole("navigation", { name: "Pods" });
		localStorage.setItem("sugabots-workspace", other.id);

		window.dispatchEvent(
			new StorageEvent("storage", { key: "sugabots-workspace", newValue: other.id }),
		);
		await router.navigate({ to: "/" });

		await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/nitric\//));
	});

	it("switches to another workspace from the rail and opens it next time", async () => {
		client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, other]));
		const router = mount(linearPage);

		const rail = await screen.findByRole("navigation", { name: "Pods" });
		fireEvent.click(
			await within(rail).findByRole("button", { name: `Workspace: ${workspace.name}` }),
		);
		fireEvent.click(await screen.findByRole("menuitem", { name: other.name }));

		await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/nitric\//));
		expect(localStorage.getItem("sugabots-workspace")).toBe(other.id);
	});

	it("sets up a new workspace from the rail with the first run's steps", async () => {
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

	it("sets up every step of a workspace for somebody who deleted all of theirs", async () => {
		client.api.workspaces.list.mockReturnValue(Effect.succeed([]));
		client.api.workspaces.create.mockImplementation(() => {
			client.api.workspaces.list.mockReturnValue(Effect.succeed([other]));
			return Effect.succeed(other);
		});
		const router = mount(linearPage);

		const name = await screen.findByLabelText("Workspace name");
		await waitFor(() => expect(router.state.location.pathname).toBe("/onboarding/new"));
		// There is no workspace to go back to.
		expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
		fireEvent.change(name, { target: { value: "Nitric" } });
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));

		expect(await screen.findByRole("heading", { name: "Connect a provider" })).toBeDefined();
		expect(router.state.location.pathname).toBe("/onboarding/new");
		expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
	});

	it("picks setting up a new workspace back up after a reload", async () => {
		client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, other]));
		mount("/onboarding/new?workspace=nitric");

		expect(await screen.findByRole("button", { name: "Cancel" })).toBeDefined();
		await waitFor(() => expect(localStorage.getItem("sugabots-workspace")).toBe(other.id));
		expect(screen.queryByRole("heading", { name: "Name your workspace" })).toBeNull();
		expect(client.api.workspaces.create).not.toHaveBeenCalled();
	});

	it("keeps a workspace it did not make itself when cancelled", async () => {
		// Setup reached again by its address may be for a workspace finished and shared since.
		client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, other]));
		const router = mount("/onboarding/new?workspace=nitric");

		fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

		await waitFor(() => expect(router.state.location.pathname).not.toBe("/onboarding/new"));
		expect(client.api.workspaces.delete).not.toHaveBeenCalled();
	});

	it("asks before leaving a workspace made but not set up", async () => {
		client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, other]));
		const router = mount("/onboarding/new?workspace=nitric");
		await screen.findByRole("button", { name: "Cancel" });

		void router.navigate({ to: linearPage });
		const dialog = await screen.findByRole("dialog", { name: "Leave setup?" });
		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Leave setup?" })).toBeNull());
		expect(router.state.location.pathname).toBe("/onboarding/new");

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

	it("deletes the workspace it made when cancelled, and goes back to where it came from", async () => {
		client.api.workspaces.create.mockImplementation(() => {
			client.api.workspaces.list.mockReturnValue(Effect.succeed([workspace, other]));
			return Effect.succeed(other);
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

	it("lets the owner delete a workspace, then opens another", async () => {
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
		mount("/suga/settings");

		await screen.findByRole("heading", { name: workspace.name });
		expect(screen.queryByRole("button", { name: "Delete workspace" })).toBeNull();
	});

	it("says so when the address is already taken, and stays on the step", async () => {
		client.api.workspaces.create.mockReturnValue(
			Effect.fail(new Conflict({ message: "already exists" })),
		);
		const router = mount(linearPage);

		fireEvent.change(await startNewWorkspace(router), { target: { value: "Suga" } });
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));

		expect(await screen.findByText("That workspace address is already taken.")).toBeDefined();
		expect(screen.getByRole("heading", { name: "Name your workspace" })).toBeDefined();
	});

	async function startNewWorkspace(router: ReturnType<typeof mount>) {
		const rail = await screen.findByRole("navigation", { name: "Pods" });
		fireEvent.click(
			await within(rail).findByRole("button", { name: `Workspace: ${workspace.name}` }),
		);
		fireEvent.click(await screen.findByRole("menuitem", { name: "New workspace" }));
		await waitFor(() => expect(router.state.location.pathname).toBe("/onboarding/new"));
		await screen.findByRole("heading", { name: "Name your workspace" });
		return screen.getByLabelText("Workspace name");
	}
});

describe("the rail", () => {
	it("lists each shared pod and Personal, and marks the pod you are in", async () => {
		client.api.pods.list.mockReturnValue(Effect.succeed([...pods, personalPod]));
		mount(linearPage);

		const rail = await screen.findByRole("navigation", { name: "Pods" });
		await within(rail).findByRole("link", { name: "Personal" });
		const names = within(rail)
			.getAllByRole("link")
			.map((link) => link.getAttribute("aria-label"));
		expect(names).toEqual(["Suga-Team", "Sales", "Personal", "Settings"]);
		expect(within(rail).getByRole("link", { name: "Suga-Team" }).getAttribute("aria-current")).toBe(
			"page",
		);
	});

	it("opens a pod's settings from its menu and leads back to the Chat", async () => {
		const router = mount(linearPage);

		const rail = await screen.findByRole("navigation", { name: "Pods" });
		fireEvent.contextMenu(await within(rail).findByRole("link", { name: "Sales" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Pod settings" }));
		await waitFor(() => expect(router.state.location.pathname).toBe("/suga/settings/pods/sales"));
		fireEvent.click(await screen.findByRole("link", { name: "Back to Chat" }));

		await waitFor(() => expect(router.state.location.pathname).toBe(linearPage));
	});

	it("makes a new bot in the pod whose menu it is chosen from", async () => {
		mount(linearPage);

		const rail = await screen.findByRole("navigation", { name: "Pods" });
		fireEvent.contextMenu(await within(rail).findByRole("link", { name: "Sales" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "New bot" }));
		const dialog = await screen.findByRole("dialog", { name: "New bot" });
		expect(within(dialog).queryByRole("button", { name: /^Pod:/ })).toBeNull();
	});

	it("opens settings from your avatar", async () => {
		mount(linearPage);

		const rail = await screen.findByRole("navigation", { name: "Pods" });
		expect(within(rail).getByRole("link", { name: "Settings" }).getAttribute("href")).toBe(
			"/suga/settings",
		);
	});
});

describe("the conversation list", () => {
	it("lists a pod's bots newest first, marking the open chat and what you last said", async () => {
		client.api.chats.list.mockReturnValue(
			Effect.succeed({
				items: [
					{
						agent: linear,
						chatId: "0199a3a0-0000-7000-8000-0000000000c1",
						lastMessage: {
							preview: "File the timeout as a bug",
							authorUserId: sam.id,
							at: new Date().toISOString(),
						},
					},
					{ agent: triager, chatId: null, lastMessage: null },
				],
			}),
		);
		mount(linearPage);

		const list = await screen.findByRole("region", { name: "Suga-Team" });
		const rows = await within(await within(list).findByRole("list")).findAllByRole("link");
		expect(rows.map((row) => row.textContent)).toEqual([
			expect.stringContaining("You: File the timeout as a bug"),
			expect.stringContaining("Issue Triager"),
		]);
		expect(rows[0]?.getAttribute("aria-current")).toBe("page");
		expect(client.api.chats.list).toHaveBeenCalledWith({
			params: { workspace: workspace.id },
			query: { pod: pods[0]?.id },
		});
	});

	it("finds a bot by name", async () => {
		mount("/suga/pods/suga-team");

		const list = await screen.findByRole("region", { name: "Suga-Team" });
		await within(list).findByRole("link", { name: /Linear Handler/ });
		fireEvent.change(within(list).getByRole("searchbox", { name: "Search Suga-Team" }), {
			target: { value: "tri" },
		});

		expect(
			within(within(list).getByRole("list"))
				.getAllByRole("link")
				.map((row) => row.textContent),
		).toEqual([expect.stringContaining("Issue Triager")]);
	});

	it("opens its pod's settings and leads back to the Chat", async () => {
		const chat = `/suga/pods/suga-team/agents/${linear.handle}`;
		const router = mount(chat);

		const list = await screen.findByRole("region", { name: "Suga-Team" });
		fireEvent.click(within(list).getByRole("link", { name: "Pod settings" }));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/suga/settings/pods/suga-team"),
		);
		fireEvent.click(await screen.findByRole("link", { name: "Back to Chat" }));

		await waitFor(() => expect(router.state.location.pathname).toBe(chat));
	});

	it("says a pod has no bots yet, and offers the first", async () => {
		client.api.chats.list.mockReturnValue(Effect.succeed({ items: [] }));
		mount("/suga/pods/sales");

		expect(await screen.findByText("No bots in Sales yet")).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "New bot" }));
		expect(await screen.findByRole("dialog", { name: "New bot" })).toBeDefined();
	});

	it("offers no New bot to somebody who may not make one", async () => {
		client.api.pods.list.mockReturnValue(
			Effect.succeed(pods.map((pod) => ({ ...pod, permissions: VIEWER_IN_POD }))),
		);
		mount("/suga/pods/suga-team");

		await screen.findByRole("region", { name: "Suga-Team" });
		expect(screen.queryByRole("button", { name: "New bot" })).toBeNull();
	});
});

describe("the settings navigation", () => {
	/*
	 * The sections are one list, and the two an administrator alone may open sit
	 * last under a rule. What that buys is this: a member sees a list that simply
	 * ends, rather than one with gaps where the sections they cannot reach were.
	 */

	it("lists every section for an administrator, and the way back out", async () => {
		const router = mount("/suga/settings");

		const rail = await screen.findByRole("navigation", { name: "Settings" });

		expect(await within(rail).findByRole("link", { name: "Models" })).toBeDefined();
		expect(within(rail).getByRole("link", { name: "General" }).getAttribute("aria-current")).toBe(
			"page",
		);

		fireEvent.click(screen.getByRole("link", { name: "Close settings" }));

		await waitFor(() =>
			expect(router.state.location.pathname.startsWith("/suga/agents")).toBe(true),
		);
	});

	it("counts what each section holds, beside its name", async () => {
		mount("/suga/settings");

		const rail = await screen.findByRole("navigation", { name: "Settings" });

		// The name carries the count, so it is read as a pair rather than "Pods2".
		expect(await within(rail).findByRole("link", { name: "Members, 2" })).toBeDefined();
		expect(within(rail).getByRole("link", { name: "Pods, 2" })).toBeDefined();
		// Crew only: the Scribe and the Facilitator belong to the workspace rather
		// than to a pod, and are counted in their own section, not this one.
		expect(within(rail).getByRole("link", { name: "Bots, 3" })).toBeDefined();
		// General holds nothing to count.
		expect(within(rail).getByRole("link", { name: "General" })).toBeDefined();
	});

	it("shows the workspace's time zone under General", async () => {
		client.api.workspaces.list.mockReturnValue(
			Effect.succeed([{ ...workspace, timeZone: "Australia/Sydney" }]),
		);
		mount("/suga/settings");

		expect(await screen.findByText("Time zone")).toBeDefined();
		expect(screen.getByText("Australia/Sydney")).toBeDefined();
	});

	it("leaves the roster uncounted while you are the only person in it", async () => {
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

		const rail = await screen.findByRole("navigation", { name: "Settings" });
		await within(rail).findByRole("link", { name: "Pods, 2" });

		// The one member is you. "1" tells nobody anything they did not know.
		expect(within(rail).getByRole("link", { name: "Members" })).toBeDefined();
	});

	it("withholds the administrative sections from a member", async () => {
		apiAnswers({ role: "member" });
		mount("/suga/settings");

		const rail = await screen.findByRole("navigation", { name: "Settings" });
		// Waiting on a count waits on the answers the rail is drawn from, the
		// caller's role among them, so what follows is a settled list.
		await within(rail).findByRole("link", { name: "Pods, 2" });

		expect(within(rail).queryByRole("link", { name: "Models" })).toBeNull();
		expect(within(rail).queryByRole("link", { name: "Web search" })).toBeNull();
	});

	// Each settings page draws its own navigation, so it is looked up afresh after every move.
	const settingsNavigation = () => screen.findByRole("navigation", { name: "Settings" });

	/** Opens Linear's settings from its pod's list of bots, as a person would. */
	async function openLinearFromItsPod() {
		const podBots = await screen.findByRole("region", { name: "Bots" });
		fireEvent.click(within(podBots).getByRole("link", { name: new RegExp(linear.name) }));
		await screen.findByRole("heading", { name: linear.name });
		return screen.getByRole("link", { name: "Back to Suga-Team pod" });
	}

	it("goes back to the pod a bot was opened from, naming it", async () => {
		const router = mount("/suga/settings/pods/suga-team");
		await screen.findByRole("heading", { name: "Suga-Team" });
		// Arriving by address leaves nowhere to go back to.
		expect(screen.queryByRole("link", { name: /^Back to/ })).toBeNull();

		fireEvent.click(await openLinearFromItsPod());

		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/suga/settings/pods/suga-team"),
		);
		await screen.findByRole("heading", { name: "Suga-Team" });
		expect(screen.queryByRole("link", { name: /^Back to/ })).toBeNull();
	});

	it("starts over when a section is picked from the navigation", async () => {
		const router = mount("/suga/settings/pods/suga-team");
		await openLinearFromItsPod();

		fireEvent.click(within(await settingsNavigation()).getByRole("link", { name: "Bots, 3" }));

		await waitFor(() => expect(router.state.location.pathname).toBe("/suga/settings/agents"));
		expect(screen.queryByRole("link", { name: /^Back to/ })).toBeNull();
	});

	it("starts over when another bot is picked from the list of bots", async () => {
		mount("/suga/settings/pods/suga-team");
		await openLinearFromItsPod();

		const bots = screen.getByRole("navigation", { name: "Workspace bots" });
		fireEvent.click(within(bots).getByRole("link", { name: /^Issue Triager/ }));

		await screen.findByRole("heading", { name: "Issue Triager" });
		expect(screen.queryByRole("link", { name: /^Back to/ })).toBeNull();
	});

	it("starts over when a new pod opens beside the one that was open", async () => {
		const made = { ...pods[0], id: "new", name: "Platform", slug: "platform" };
		client.api.pods.create.mockReturnValue(Effect.succeed(made));
		mount("/suga/settings/pods/suga-team");
		await screen.findByRole("heading", { name: "Suga-Team" });

		fireEvent.click(
			await within(await screen.findByRole("main")).findByRole("button", { name: "New pod" }),
		);
		const dialog = await screen.findByRole("dialog", { name: "New pod" });
		fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Platform" } });
		client.api.pods.list.mockReturnValue(Effect.succeed([...pods, made]));
		fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

		await screen.findByRole("heading", { name: "Platform" });
		expect(screen.queryByRole("link", { name: /^Back to/ })).toBeNull();
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
		const destination = `/suga/settings/pods/suga-team/agents/${linear.handle}?tab=routines`;
		const router = mount(`/login?returnTo=${encodeURIComponent(destination)}`);

		expect(await screen.findByRole("button", { name: "New routine" })).toBeDefined();
		expect(router.state.location.href).toBe(destination);
	});

	it("will not return from the login page to another site", async () => {
		const router = mount(`/login?returnTo=${encodeURIComponent("//evil.example/steal")}`);

		await waitFor(() => expect(router.state.location.pathname).toBe("/suga/agents"));
	});

	it("keeps a signed-in user without a workspace out of the shell", async () => {
		client.api.workspaces.list.mockReturnValue(Effect.succeed([]));
		client.api.onboarding.status.mockReturnValue(Effect.succeed({ completed: false }));
		const router = mount(linearPage);

		expect(await screen.findByRole("heading", { name: "Name your workspace" })).toBeDefined();
		await waitFor(() => expect(router.state.location.pathname).toBe("/onboarding"));
		expect(screen.queryByRole("navigation", { name: "Workspace" })).toBeNull();
	});

	it("walks a new workspace from its first bot to its chat", async () => {
		client.api.onboarding.status.mockReturnValue(Effect.succeed({ completed: false }));
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
		client.api.onboarding.complete.mockReturnValue(Effect.succeed({ completed: true }));
		const router = mount(linearPage);

		expect(await screen.findByRole("heading", { name: "Make your first bot" })).toBeDefined();
		await waitFor(() => expect(router.state.location.pathname).toBe("/onboarding"));
		const create = screen.getByRole("button", { name: "Create bot" });
		expect(create.hasAttribute("disabled")).toBe(true);
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Chief" } });
		fireEvent.click(screen.getByRole("radio", { name: "purple" }));
		fireEvent.click(screen.getByRole("radio", { name: "Inbox" }));
		fireEvent.click(create);

		await waitFor(() =>
			expect(client.api.agents.update).toHaveBeenCalledWith({
				params: { agentId: personalAssistant.id },
				payload: {
					name: "Chief",
					color: "purple",
					face: "pill",
					description: "Sorts your email and flags what needs you.",
				},
			}),
		);
		expect(await screen.findByRole("heading", { name: "Bring your friends" })).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));

		expect(await screen.findByRole("heading", { name: "Chief is ready" })).toBeDefined();
		client.api.onboarding.status.mockReturnValue(Effect.succeed({ completed: true }));
		fireEvent.click(screen.getByRole("button", { name: "Start chatting" }));

		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/suga/pods/personal/agents/chief"),
		);
	});

	it("invites the addresses typed, and says how many it will send", async () => {
		client.api.onboarding.status.mockReturnValue(Effect.succeed({ completed: false }));
		client.api.pods.list.mockReturnValue(Effect.succeed([personalPod]));
		client.api.agents.list.mockReturnValue(
			Effect.succeed([{ ...personalAssistant, name: "Chief" }]),
		);
		client.api.agents.update.mockReturnValue(Effect.succeed(personalAssistant));
		client.api.workspaces.invite.mockReturnValue(Effect.succeed({ id: "an-invitation" }));
		mount(linearPage);

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
		client.api.onboarding.status.mockReturnValue(Effect.succeed({ completed: false }));
		client.api.pods.list.mockReturnValue(Effect.succeed([personalPod]));
		client.api.agents.list.mockReturnValue(
			Effect.succeed([{ ...personalAssistant, model: "switched-off" }]),
		);
		mount(linearPage);

		expect(await screen.findByRole("heading", { name: "Connect a provider" })).toBeDefined();
		expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
	});

	it("adds the first provider from the Models picker, then switches on the model chosen for the first bot", async () => {
		client.api.onboarding.status.mockReturnValue(Effect.succeed({ completed: false }));
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
		mount(linearPage);

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
			Effect.succeed({
				workspaceName: "Nitric",
				inviterName: "Sam",
			}),
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
				"Signups are invite only. Ask a member to invite you.",
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
			failureForStatus(403, "Email not verified", "EMAIL_NOT_VERIFIED"),
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
					"Email verification required to view or list invitations for the session email",
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
				workspaceName: "Nitric",
				inviterName: "Sam",
			}),
		);
		client.api.workspaces.acceptInvitation.mockReturnValue(Effect.succeed(undefined));
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

	it("resumes an accepted invitation after the page was reloaded", async () => {
		client.api.onboarding.completeInvite.mockReturnValue(
			Effect.succeed({ workspaceId: workspace.id }),
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
		client.api.agents.list.mockReturnValue(Effect.fail(new Forbidden({ message: "Unavailable" })));
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
		apiAnswers({ role: "member" });
		mount("/suga/settings/pods");

		// The rail is the section's own heading now, and waiting on it waits on
		// the answers the controls under it are drawn from.
		await screen.findByRole("navigation", { name: "Workspace pods" });

		expect(screen.queryByRole("button", { name: "New pod" })).toBeNull();
	});

	it("waits for a name before it can make a pod", async () => {
		mount("/suga/settings/pods");
		(
			await within(await screen.findByRole("main")).findByRole("button", { name: "New pod" })
		).click();

		const dialog = await screen.findByRole("dialog", { name: "New pod" });
		const create = within(dialog).getByRole("button", { name: "Create" });
		expect(create.hasAttribute("disabled")).toBe(true);
		fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Platform Team" } });
		expect(create.hasAttribute("disabled")).toBe(false);
	});

	it("creates one in a colour no other pod has, and puts it in the rail", async () => {
		const made = { ...pods[0], id: "new", name: "Platform", slug: "platform" };
		client.api.pods.create.mockReturnValue(Effect.succeed(made));

		mount("/suga/settings/pods");
		(
			await within(await screen.findByRole("main")).findByRole("button", { name: "New pod" })
		).click();

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
		client.api.pods.create.mockReturnValue(
			Effect.fail(new Conflict({ message: "already exists" })),
		);

		mount("/suga/settings/pods");
		(
			await within(await screen.findByRole("main")).findByRole("button", { name: "New pod" })
		).click();

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
	it("offers no rename or delete for the private pod", async () => {
		client.api.pods.list.mockReturnValue(Effect.succeed([personalPod, ...pods]));

		mount(`/suga/settings/pods/${personalPod.slug}`);

		const rail = await screen.findByRole("navigation", {
			name: "Workspace pods",
		});
		expect(await within(rail).findByRole("link", { name: /Personal/ })).toBeDefined();
		expect(await screen.findByText("Only you can see this pod and its bots.")).toBeDefined();
		expect(screen.queryByLabelText("Name")).toBeNull();
		expect(screen.queryByRole("button", { name: "Delete pod" })).toBeNull();
	});
});

describe("creating an agent", () => {
	it("offers a member of the pod the same New bot action as an admin", async () => {
		mount(`/suga/settings/pods/${pods[0]?.slug}`);

		expect(await screen.findByRole("button", { name: "New bot" })).toBeDefined();
		cleanup();
		vi.clearAllMocks();

		apiAnswers({ role: "member" });
		mount(`/suga/settings/pods/${pods[0]?.slug}`);
		await screen.findByRole("heading", { name: pods[0]?.name });

		expect(screen.getByRole("button", { name: "New bot" })).toBeDefined();
	});

	it("keeps deleting pods, and making them, to those allowed them", async () => {
		mount(`/suga/settings/pods/${pods[0]?.slug}`);

		const settings = await screen.findByRole("main");
		expect(await within(settings).findByRole("button", { name: "New pod" })).toBeDefined();
		expect(screen.getByRole("button", { name: "Delete pod" })).toBeDefined();
		cleanup();
		vi.clearAllMocks();

		apiAnswers({ role: "member" });
		mount(`/suga/settings/pods/${pods[0]?.slug}`);
		await screen.findByRole("heading", { name: pods[0]?.name });

		expect(screen.queryByRole("button", { name: "New pod" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Delete pod" })).toBeNull();
	});

	it("creates a bot with the face chosen, in its pod, and opens its settings", async () => {
		const made = {
			...linear,
			id: "0199a3a0-0000-7000-8000-0000000000c9",
			name: "Release Coordinator",
			handle: "release-coordinator",
			model: MODELS[0] as string,
			podId: pods[0]?.id as string,
		};
		client.api.agents.create.mockReturnValue(Effect.succeed(made));
		const router = mount(`/suga/settings/pods/${pods[0]?.slug}`);
		(await screen.findByRole("button", { name: "New bot" })).click();

		const dialog = await screen.findByRole("dialog", { name: "New bot" });
		fireEvent.change(within(dialog).getByLabelText("Name"), {
			target: { value: `  ${made.name}  ` },
		});
		fireEvent.click(within(dialog).getByRole("radio", { name: "orange" }));
		fireEvent.click(within(dialog).getByRole("radio", { name: "arc" }));
		client.api.agents.list.mockReturnValue(Effect.succeed([...agents, made]));
		within(dialog).getByRole("button", { name: "Create" }).click();

		await waitFor(() => {
			expect(client.api.agents.create).toHaveBeenCalledWith({
				params: { podId: made.podId },
				payload: {
					name: made.name,
					model: made.model,
					color: "orange",
					face: "arc",
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

	it("keeps a duplicate-name error in the creation form", async () => {
		client.api.agents.create.mockReturnValue(
			Effect.fail(new Conflict({ message: "already exists" })),
		);
		mount(`/suga/settings/pods/${pods[0]?.slug}`);
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
	it("makes a bot in the pod chosen when the dialog is not opened from one", async () => {
		const [first, second] = pods as [(typeof pods)[number], (typeof pods)[number]];
		client.api.agents.create.mockReturnValue(Effect.succeed({ ...linear, podId: second.id }));
		mount("/suga/settings/agents");

		fireEvent.click(await screen.findByRole("button", { name: "New bot" }));
		const dialog = await screen.findByRole("dialog", { name: "New bot" });
		fireEvent.click(within(dialog).getByRole("button", { name: `Pod: ${first.name}` }));
		fireEvent.click(within(dialog).getByRole("button", { name: new RegExp(second.name) }));
		fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Scout" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

		await waitFor(() =>
			expect(client.api.agents.create).toHaveBeenCalledWith(
				expect.objectContaining({ params: { podId: second.id } }),
			),
		);
	});

	it("opens the first pod when none is chosen", async () => {
		mount("/suga/settings/pods");

		expect(await screen.findByRole("heading", { name: pods[0]?.name })).toBeDefined();
		expect(screen.queryByText("Choose a pod")).toBeNull();
	});

	it("opens the first bot when none is chosen", async () => {
		mount("/suga/settings/agents");

		const first = agents.find((agent) => agent.systemAgentKey === null);
		expect(await screen.findByRole("heading", { name: first?.name })).toBeDefined();
	});

	it("finds a bot by name in the list of bots", async () => {
		mount("/suga/settings/agents");

		const settings = await screen.findByRole("main");
		await within(settings).findByRole("link", { name: new RegExp(linear.name) });
		fireEvent.change(within(settings).getByRole("searchbox", { name: "Search bots" }), {
			target: { value: "triag" },
		});

		expect(within(settings).queryByRole("link", { name: new RegExp(linear.name) })).toBeNull();
		expect(within(settings).getByRole("link", { name: new RegExp(triager.name) })).toBeDefined();
	});

	it("keeps the system bots out of the list of bots, since they are in no pod", async () => {
		mount("/suga/settings/agents");

		const settings = await screen.findByRole("main");
		await within(settings).findByText(linear.name);
		expect(within(settings).queryByText(facilitator.name)).toBeNull();
	});

	it("selects a pod from its settings rail", async () => {
		const pod = pods[0] as (typeof pods)[number];
		mount(`/suga/settings/pods/${pod.slug}`);

		const rail = await screen.findByRole("navigation", {
			name: "Workspace pods",
		});
		const selected = await within(rail).findByRole("link", {
			name: /Suga-Team/,
		});
		expect(selected.getAttribute("aria-current")).toBe("page");
	});

	const [openai, anthropic] = modelProviders as [ModelProvider, ModelProvider];
	const providerPage = (provider: { id: string }) => `/suga/settings/providers/${provider.id}`;

	it("lists each connected provider with how many of its models are on, and opens it", async () => {
		const router = mount("/suga/settings/providers");

		const row = await screen.findByRole("link", { name: /Anthropic/ });
		expect(row.textContent).toContain(
			`${anthropic.enabledModelCount} of ${anthropic.modelCount} models on`,
		);
		fireEvent.click(row);

		await waitFor(() => expect(router.state.location.pathname).toBe(providerPage(anthropic)));
		expect(await screen.findByRole("heading", { name: "Anthropic" })).toBeDefined();
	});

	it("switches a model off without moving it", async () => {
		client.api.modelProviders.updateModel.mockReturnValue(Effect.void);
		mount(providerPage(anthropic));

		const model = anthropic.models[0] as ProviderModel;
		fireEvent.click(
			await screen.findByRole("switch", {
				name: `Bots can use ${model.displayName ?? model.modelId}`,
			}),
		);

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

		fireEvent.click(await screen.findByRole("link", { name: /System agents use/ }));
		await waitFor(() =>
			expect(router.state.location.pathname).toBe("/suga/settings/providers/system"),
		);
		fireEvent.click(await screen.findByRole("button", { name: "gpt-5" }));

		await waitFor(() => {
			for (const key of ["summarise", "facilitate"]) {
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
		apiKeyHint: null as string | null,
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
		mountOllama({ ...ollama, hasApiKey: true, apiKeyHint: "1234" });

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
			apiKeyHint: null,
			status: "missing_key" as const,
			models: [],
			modelCount: 0,
			enabledModelCount: 0,
		};
		client.api.modelProviders.create.mockReturnValue(Effect.succeed(provider));
		const router = mount("/suga/settings/providers");

		fireEvent.click(await screen.findByRole("button", { name: "Add provider" }));
		const dialog = await screen.findByRole("dialog", { name: "Add provider" });
		fireEvent.click(within(dialog).getByRole("button", { name: /Custom provider/ }));
		const step = await screen.findByRole("dialog", { name: "Custom provider" });
		fireEvent.change(within(step).getByLabelText("Name"), { target: { value: provider.name } });
		fireEvent.change(within(step).getByLabelText("Address"), {
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

		fireEvent.click(await screen.findByRole("button", { name: "Add provider" }));
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
			Effect.succeed([{ ...openai, active: false, hasApiKey: false, apiKeyHint: null }, anthropic]),
		);
		client.api.modelProviders.update.mockReturnValue(Effect.succeed(openai));
		mount("/suga/settings/providers");

		fireEvent.click(await screen.findByRole("button", { name: "Add provider" }));
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
			Effect.fail(new InternalServerError({ message: "Provider unavailable" })),
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
			Effect.fail(new InternalServerError({ message: "Could not add model" })),
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
		expect(screen.getByRole("link", { name: new RegExp(sam.name) }).textContent).toContain("You");
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
		const browserOptions = new Intl.DateTimeFormat().resolvedOptions();
		const browser = vi
			.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
			.mockReturnValue({ ...browserOptions, timeZone: "Australia/Sydney" });
		onTestFinished(() => browser.mockRestore());
		client.api.workspaces.list.mockReturnValue(Effect.succeed([]));
		client.api.onboarding.status.mockReturnValue(Effect.succeed({ completed: false }));
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
		client.api.workspaces.list.mockReturnValue(Effect.succeed([]));
		client.api.onboarding.status.mockReturnValue(Effect.succeed({ completed: false }));
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
	it("lists every section, you first, with a way out", async () => {
		mount("/suga/settings");

		const list = await screen.findByRole("navigation", { name: "Settings sections" });
		expect(within(list).getByRole("link", { name: /Done/ }).getAttribute("href")).toBe(
			"/suga/agents",
		);
		expect(
			within(list)
				.getByRole("link", { name: new RegExp(sam.name) })
				.getAttribute("href"),
		).toBe("/suga/settings/profile");
		expect((await within(list).findByRole("link", { name: /General/ })).getAttribute("href")).toBe(
			"/suga/settings/general",
		);
	});

	it("opens General by name, with the way back to the list", async () => {
		mount("/suga/settings/general");

		expect(await screen.findByRole("group", { name: "Theme" })).toBeDefined();
		const page = screen.getByRole("main");
		expect(within(page).getByRole("link", { name: "Settings" }).getAttribute("href")).toBe(
			"/suga/settings",
		);
	});

	it("leads from an open pod back to the list of pods", async () => {
		mount(`/suga/settings/pods/${pods[0]?.slug}`);

		expect((await screen.findByRole("link", { name: "Pods" })).getAttribute("href")).toBe(
			"/suga/settings/pods",
		);
	});
});

describe("the theme", () => {
	it("is dark until something is chosen", async () => {
		mount("/suga/settings");

		const theme = await screen.findByRole("group", { name: "Theme" });
		expect((within(theme).getByRole("radio", { name: "Dark" }) as HTMLInputElement).checked).toBe(
			true,
		);
		expect(document.documentElement.dataset.theme).toBeUndefined();
	});

	it("is chosen in settings, and remembered", async () => {
		mount("/suga/settings");

		fireEvent.click(await screen.findByRole("radio", { name: "Light" }));

		await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
		expect(localStorage.getItem("sugabots-theme")).toBe("light");
	});

	it("stores nothing when dark is chosen, because that is the default", async () => {
		localStorage.setItem("sugabots-theme", "light");
		mount("/suga/settings");

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
});

describe("pod settings", () => {
	const [suga] = pods;
	if (!suga) throw new Error("fixture");
	const podPage = `/suga/settings/pods/${suga.slug}`;
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
		mount(podPage);

		expect(await screen.findByRole("link", { name: linear.name })).toBeDefined();
		expect(screen.queryByText("User agents")).toBeNull();
		expect(screen.queryByText("System agents")).toBeNull();
		expect(screen.queryByRole("link", { name: facilitator.name })).toBeNull();
	});

	it("adds somebody from the workspace", async () => {
		client.api.pods.addMember.mockReturnValue(Effect.void);
		mount(podPage);

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
		mount(podPage);

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
		mount(podPage);

		expect(await screen.findByRole("button", { name: `Remove ${jye.name}` })).toBeDefined();
		expect(screen.queryByRole("button", { name: `Leave ${suga.name}` })).toBeNull();
		expect(screen.queryByRole("button", { name: `Remove ${sam.name}` })).toBeNull();
	});

	it("lets a member leave a pod, and nothing more", async () => {
		apiAnswers({ role: "member" });
		client.api.pods.listMembers.mockImplementation(() => Effect.succeed([samInPod, jyeInPod]));
		client.api.pods.leave.mockReturnValue(Effect.void);
		mount(podPage);

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
		mount(podPage);

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
		mount(podPage);

		const settings = await screen.findByRole("main");
		expect(await within(settings).findByText(linear.name)).toBeDefined();
		expect(screen.queryByRole("button", { name: "Add people" })).toBeNull();
		expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
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
			Effect.fail(new Conflict({ message: "The pod still has threads" })),
		);
		mount(podPage);

		fireEvent.click(await screen.findByRole("button", { name: "Delete pod" }));
		fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

		expect(await screen.findByRole("alert")).toBeDefined();
	});
});
