import type { Pod } from "@sugabots/contracts";
import { ApiError } from "@sugabots/sdk";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
	OWN_PERSONAL_POD,
	open,
	pods,
	sam,
	triager,
	VIEWER_IN_POD,
	workspace,
} from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const linearPage = `/agents/${linear.id}`;
const writeClipboardText = vi.fn();

beforeEach(() => {
	apiAnswers();
	document.documentElement.removeAttribute("data-theme");
	localStorage.clear();
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText: writeClipboardText },
	});
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

describe("the top bar", () => {
	it("offers the workspaces you are in, and the way to their settings", async () => {
		client.auth.workspaces.list.mockResolvedValue([
			workspace,
			{
				id: "0199a3a0-0000-7000-8000-0000000000f9",
				name: "Nitric",
				slug: "nitric",
			},
		]);
		mount(linearPage);

		open(await screen.findByRole("button", { name: /Suga Workspace/ }));

		const menu = await screen.findByRole("menu");
		expect(within(menu).getByRole("menuitem", { name: /Nitric/ })).toBeDefined();
		expect(
			within(menu).getByRole("menuitem", { name: "Workspace settings" }).getAttribute("href"),
		).toBe("/settings");
	});

	// Settings opens over the app and covers this menu, so "already open" is no
	// longer a state the menu can be opened in. What the menu still owes is to
	// close behind the window it opened.
	it("closes the workspace menu behind the settings window it opens", async () => {
		mount(linearPage);

		open(await screen.findByRole("button", { name: /Suga Workspace/ }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Workspace settings" }));

		expect(await screen.findByRole("dialog", { name: "Workspace settings" })).toBeDefined();
		await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
	});

	it("keeps a workspace choice in memory when storage is unavailable", async () => {
		const other = {
			id: "0199a3a0-0000-7000-8000-0000000000f9",
			name: "Nitric",
			slug: "nitric",
		};
		client.auth.workspaces.list.mockResolvedValue([workspace, other]);
		const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
			throw new Error("Storage disabled");
		});
		mount(linearPage);
		await screen.findByRole("button", { name: /Suga Workspace/ });

		chooseWorkspace(other.id);

		expect(await screen.findByRole("button", { name: /Nitric/ })).toBeDefined();
		setItem.mockRestore();
	});

	it("follows workspace choices made in another tab", async () => {
		const other = {
			id: "0199a3a0-0000-7000-8000-0000000000f9",
			name: "Nitric",
			slug: "nitric",
		};
		client.auth.workspaces.list.mockResolvedValue([workspace, other]);
		mount(linearPage);
		await screen.findByRole("button", { name: /Suga Workspace/ });
		localStorage.setItem("sugabots-workspace", other.id);

		window.dispatchEvent(
			new StorageEvent("storage", {
				key: "sugabots-workspace",
				newValue: other.id,
			}),
		);

		expect(await screen.findByRole("button", { name: /Nitric/ })).toBeDefined();
	});

	it("signs out from the user menu, and re-asks who you are", async () => {
		client.auth.signOut.mockResolvedValue(undefined);
		const refresh = vi.fn();
		mount(linearPage, sam, refresh);

		open(await screen.findByRole("button", { name: /Sam/ }));
		(await screen.findByRole("menuitem", { name: "Sign out" })).click();

		await waitFor(() => {
			expect(client.auth.signOut).toHaveBeenCalled();
		});
		// Dropping the token is not enough on its own: the guard reads the
		// session, so it has to be asked again before the route can send
		// anybody to the login page.
		await waitFor(() => {
			expect(refresh).toHaveBeenCalled();
		});
	});
});

describe("pod-first navigation", () => {
	it("marks the current agent as the selected page", async () => {
		mount(linearPage);
		const rail = await screen.findByRole("navigation", { name: "Workspace" });
		expect(
			(await within(rail).findByRole("link", { name: /Linear Handler/ })).getAttribute(
				"aria-current",
			),
		).toBe("page");
	});
	it("marks only the owning-pod copy of an agent as the current page", async () => {
		mount(linearPage);
		const rail = await screen.findByRole("navigation", { name: "Workspace" });
		await within(rail).findByRole("link", { name: /Linear Handler/ });

		expect(within(rail).getAllByRole("link", { current: "page" })).toHaveLength(1);
	});
	it("closes the navigation drawer after choosing an agent", async () => {
		const router = mount(linearPage);
		fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
		const drawer = await screen.findByRole("dialog", {
			name: "Your workspace",
		});
		fireEvent.click(
			await within(drawer).findByRole("link", {
				name: new RegExp(triager.name),
			}),
		);
		await waitFor(() => expect(router.state.location.pathname).toBe(`/agents/${triager.id}`));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});
	it("closes the drawer with Escape and returns focus to its trigger", async () => {
		mount(linearPage);
		const trigger = await screen.findByRole("button", {
			name: "Open navigation",
		});
		trigger.focus();
		fireEvent.click(trigger);
		const drawer = await screen.findByRole("dialog", {
			name: "Your workspace",
		});
		fireEvent.keyDown(drawer, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(trigger));
	});
});

describe("the roster", () => {
	it("lists each agent under every pod it has been placed into", async () => {
		mount(linearPage);

		const rail = await screen.findByRole("navigation", { name: "Workspace" });
		await within(rail).findByRole("heading", { name: "Suga-Team" });

		expect(
			within(rail)
				.getByRole("link", { name: /Linear Handler/ })
				.getAttribute("href"),
		).toBe(`${linearPage}?pod=${pods[0]?.id}`);
		expect(within(rail).getByRole("heading", { name: "Sales" })).toBeDefined();
		expect(within(rail).getByRole("link", { name: /Customer Research/ })).toBeDefined();
	});

	it("lists an agent only under its owning pod", async () => {
		mount(linearPage);

		const rail = await screen.findByRole("navigation", { name: "Workspace" });
		expect(await within(rail).findByRole("link", { name: /Linear Handler/ })).toBeDefined();
		expect(within(rail).queryByRole("heading", { name: "In no pod" })).toBeNull();
	});

	it("pins the private Personal space above the rest", async () => {
		const personalPod = {
			...pods[0],
			id: "0199a3a0-0000-7000-8000-0000000000af",
			kind: "personal" as const,
			name: "Personal",
			slug: "personal-test",
			permissions: OWN_PERSONAL_POD,
		};
		client.api.workspaces[":workspaceId"].pods.$get.mockResolvedValue(
			Response.json([...pods, personalPod]),
		);
		client.api.workspaces[":workspaceId"].agents.$get.mockResolvedValue(
			Response.json([
				...agents,
				{
					...agents[0],
					id: "0199a3a0-0000-7000-8000-0000000000bf",
					podId: personalPod.id,
					name: "Personal Assistant",
					handle: "personal-assistant",
				},
			]),
		);
		mount(linearPage);

		const rail = await screen.findByRole("navigation", { name: "Workspace" });
		await within(rail).findByRole("heading", { name: "Personal" });
		const headings = within(rail)
			.getAllByRole("heading")
			.map((heading) => heading.textContent);
		expect(headings).toEqual(["Suga-Team", "Sales", "Personal"]);
		// The eyebrow existed to fence Personal off from the pods below it.
		// Personal sits last now, so it has nothing left to separate.
		expect(within(rail).queryByText("Pods")).toBeNull();

		// Nobody to invite and nothing to rename, so Personal carries the one
		// action it has and no menu at all.
		expect(within(rail).getByRole("button", { name: "New agent in Personal" })).toBeDefined();
		expect(within(rail).queryByRole("button", { name: "Personal actions" })).toBeNull();
	});

	it("folds a pod away, and says how much went with it", async () => {
		mount(linearPage);

		const rail = await screen.findByRole("navigation", { name: "Workspace" });
		const heading = await within(rail).findByRole("button", { name: "Suga-Team" });
		expect(within(rail).getByRole("link", { name: /Linear Handler/ })).toBeDefined();

		fireEvent.click(heading);

		expect(within(rail).queryByRole("link", { name: /Linear Handler/ })).toBeNull();
		// The count sits a gap away from the name on screen, which a name taken
		// from the contents does not hear: "Suga-Team2".
		// The roster leaves out the workspace's own system agents, so the count
		// on the heading is what was on screen, not what the pod holds.
		const inSuga = agents.filter(
			(agent) => agent.podId === pods[0]?.id && agent.systemAgentKey === null,
		).length;
		await within(rail).findByRole("button", { name: `Suga-Team, ${inSuga}` });
	});

	it("keeps a pod folded while you go elsewhere and come back", async () => {
		const router = mount(linearPage);

		const rail = await screen.findByRole("navigation", { name: "Workspace" });
		fireEvent.click(await within(rail).findByRole("button", { name: "Sales" }));
		expect(within(rail).queryByRole("link", { name: /Customer Research/ })).toBeNull();

		// Settings replaces the roster, so coming back builds it again from
		// whatever the last visit left behind.
		await router.navigate({ to: "/settings" });
		await screen.findByRole("navigation", { name: "Workspace settings" });
		await router.navigate({ to: "/agents/$agent", params: { agent: linear.id } });

		const roster = await screen.findByRole("navigation", { name: "Workspace" });
		await within(roster).findByRole("heading", { name: "Sales" });
		expect(within(roster).queryByRole("link", { name: /Customer Research/ })).toBeNull();
	});

	/*
	 * Folding the pod you are reading is a thing people do — it is how you get
	 * the rest of the rail back while you work. The unfold that opens a pod you
	 * follow a link into must not undo that.
	 */
	it("leaves the pod you are in folded once you fold it", async () => {
		mount(linearPage);

		const rail = await screen.findByRole("navigation", { name: "Workspace" });
		fireEvent.click(await within(rail).findByRole("button", { name: "Suga-Team" }));

		await waitFor(() =>
			expect(within(rail).queryByRole("link", { name: /Linear Handler/ })).toBeNull(),
		);
	});

	/*
	 * Opening it is the test: a menu that renders a label outside a group throws
	 * only once somebody clicks, which is exactly what shipped.
	 */
	it("opens a pod's menu from its heading", async () => {
		mount(linearPage);

		const rail = await screen.findByRole("navigation", { name: "Workspace" });
		open(await within(rail).findByRole("button", { name: "Suga-Team actions" }));

		const menu = await screen.findByRole("menu");
		expect(within(menu).getByRole("menuitem", { name: "New agent" })).toBeDefined();
		expect(within(menu).getByRole("menuitem", { name: "Pod settings" })).toBeDefined();
		// The menu names the pod it belongs to, the way a section menu does.
		expect(within(menu).getByText("Suga-Team")).toBeDefined();
	});

	/*
	 * A pod with nothing in it is where somebody is looking for the way to put
	 * something in it, so the row is the offer rather than empty space under a
	 * heading with a plus on it.
	 */
	it("offers the new agent row in a pod with no agents", async () => {
		const empty = {
			...(pods[0] as Pod),
			id: "0199a3a0-0000-7000-8000-0000000000a3",
			name: "Support",
			slug: "support",
		};
		client.api.workspaces[":workspaceId"].pods.$get.mockResolvedValue(
			Response.json([...pods, empty]),
		);
		mount(linearPage);

		const rail = await screen.findByRole("navigation", { name: "Workspace" });
		await within(rail).findByRole("heading", { name: "Support" });
		fireEvent.click(within(rail).getByRole("button", { name: "New agent" }));

		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByLabelText("Name")).toBeDefined();
	});

	it("says a pod is empty rather than offering a row nobody may use", async () => {
		const empty = {
			...(pods[0] as Pod),
			id: "0199a3a0-0000-7000-8000-0000000000a3",
			name: "Support",
			slug: "support",
			permissions: VIEWER_IN_POD,
		};
		client.api.workspaces[":workspaceId"].pods.$get.mockResolvedValue(
			Response.json([...pods, empty]),
		);
		mount(linearPage);

		const rail = await screen.findByRole("navigation", { name: "Workspace" });
		await within(rail).findByRole("heading", { name: "Support" });
		expect(within(rail).getByText("No agents yet.")).toBeDefined();
		expect(within(rail).queryByRole("button", { name: "New agent" })).toBeNull();
		expect(within(rail).queryByRole("button", { name: "New agent in Support" })).toBeNull();
	});

	it("opens the new agent form from a pod's heading", async () => {
		mount(linearPage);

		const rail = await screen.findByRole("navigation", { name: "Workspace" });
		fireEvent.click(await within(rail).findByRole("button", { name: "New agent in Suga-Team" }));

		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByLabelText("Name")).toBeDefined();
	});
});

describe("the settings navigation", () => {
	/*
	 * The sections are one list, and the two an administrator alone may open sit
	 * last under a rule. What that buys is this: a member sees a list that simply
	 * ends, rather than one with gaps where the sections they cannot reach were.
	 */

	it("lists every section for an administrator, and the way back out", async () => {
		const router = mount("/settings");

		const rail = await screen.findByRole("navigation", { name: "Workspace settings" });

		expect(await within(rail).findByRole("link", { name: "Model providers" })).toBeDefined();
		expect(within(rail).getByRole("link", { name: "General" }).getAttribute("aria-current")).toBe(
			"page",
		);

		// Settings is a window over the app, so the way out is the cross that
		// closes it rather than a link among the sections.
		fireEvent.click(screen.getByRole("button", { name: "Close settings" }));

		await waitFor(() => expect(router.state.location.pathname.startsWith("/agents")).toBe(true));
	});

	it("counts what each section holds, beside its name", async () => {
		mount("/settings");

		const rail = await screen.findByRole("navigation", { name: "Workspace settings" });

		// The name carries the count, so it is read as a pair rather than "Pods2".
		expect(await within(rail).findByRole("link", { name: "Members, 2" })).toBeDefined();
		expect(within(rail).getByRole("link", { name: "Pods, 2" })).toBeDefined();
		// Crew only: the Scribe and the Facilitator belong to the workspace rather
		// than to a pod, and are counted in their own section, not this one.
		expect(within(rail).getByRole("link", { name: "Agents, 3" })).toBeDefined();
		// General holds nothing to count.
		expect(within(rail).getByRole("link", { name: "General" })).toBeDefined();
	});

	it("leaves the roster uncounted while you are the only person in it", async () => {
		client.auth.workspaces.members.mockResolvedValue([
			{
				id: "0199a3a0-0000-7000-8000-0000000000d1",
				organizationId: workspace.id,
				userId: sam.id,
				role: "admin",
				createdAt: new Date("2026-09-09T00:00:00.000Z"),
				user: sam,
			},
		]);
		mount("/settings");

		const rail = await screen.findByRole("navigation", { name: "Workspace settings" });
		await within(rail).findByRole("link", { name: "Pods, 2" });

		// The one member is you. "1" tells nobody anything they did not know.
		expect(within(rail).getByRole("link", { name: "Members" })).toBeDefined();
	});

	it("withholds the administrative sections from a member", async () => {
		apiAnswers({ role: "member" });
		mount("/settings");

		const rail = await screen.findByRole("navigation", { name: "Workspace settings" });
		// Waiting on a count waits on the answers the rail is drawn from, the
		// caller's role among them, so what follows is a settled list.
		await within(rail).findByRole("link", { name: "Pods, 2" });

		expect(within(rail).queryByRole("link", { name: "Model providers" })).toBeNull();
		expect(within(rail).queryByRole("link", { name: "Web search" })).toBeNull();
		expect(within(rail).queryByRole("link", { name: "Built-in agents" })).toBeNull();
	});

	it("tells a member who reaches the built-in agents by address that it is not theirs", async () => {
		apiAnswers({ role: "member" });
		mount("/settings/built-in-agents");

		expect(
			await screen.findByText("Only workspace administrators can configure the built-in agents."),
		).toBeDefined();
		expect(screen.queryByRole("combobox", { name: "Model" })).toBeNull();
	});
});

describe("routes", () => {
	it("keeps old setup links working through workspace settings", async () => {
		const router = mount("/setup");

		await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
	});

	it("lands on a crew agent, never on a built-in one nobody talks to", async () => {
		const router = mount("/");

		await waitFor(() => {
			expect(router.state.location.pathname).toBe(`/agents/${agents[0]?.id}`);
		});
	});

	it("reaches a built-in agent's settings by its key, not by an id", async () => {
		const router = mount("/settings/built-in-agents/facilitate");

		expect(await screen.findByRole("heading", { name: facilitator.name })).toBeDefined();
		expect(router.state.location.pathname).toBe("/settings/built-in-agents/facilitate");
		expect(screen.queryByPlaceholderText(/^Message /)).toBeNull();
	});

	it("sends an unknown built-in agent key back to the section", async () => {
		const router = mount("/settings/built-in-agents/invent");

		await waitFor(() => {
			expect(router.state.location.pathname).toBe("/settings/built-in-agents");
		});
	});

	it("sends somebody signed out to the login page", async () => {
		const router = mount(linearPage, null);

		expect(await screen.findByRole("button", { name: "Log in" })).toBeDefined();
		await waitFor(() => {
			expect(router.state.location.pathname).toBe("/login");
		});
	});

	it("keeps a signed-in user without a workspace out of the shell", async () => {
		client.auth.workspaces.list.mockResolvedValue([]);
		client.api.onboarding.$get.mockResolvedValue(Response.json({ completed: false }));
		const router = mount(linearPage);

		expect(
			await screen.findByRole("heading", {
				name: "Name the place where work happens.",
			}),
		).toBeDefined();
		await waitFor(() => expect(router.state.location.pathname).toBe("/onboarding"));
		expect(screen.queryByRole("navigation", { name: "Workspace" })).toBeNull();
	});

	it("keeps an incomplete workspace in onboarding across direct links", async () => {
		client.api.onboarding.$get.mockResolvedValue(Response.json({ completed: false }));
		const personalPod = {
			...pods[0],
			id: "0199a3a0-0000-7000-8000-0000000000af",
			ownerId: sam.id,
			kind: "personal" as const,
			name: "Personal",
			slug: "personal-test",
		};
		client.api.workspaces[":workspaceId"].pods.$get.mockResolvedValue(Response.json([personalPod]));
		client.api.workspaces[":workspaceId"].agents.$get.mockResolvedValue(
			Response.json([
				{
					...agents[0],
					id: "0199a3a0-0000-7000-8000-0000000000bf",
					podId: personalPod.id,
					name: "Personal Assistant",
					handle: "personal-assistant",
				},
			]),
		);
		const router = mount(linearPage);

		expect(
			await screen.findByRole("heading", {
				name: "Your Personal pod is ready.",
			}),
		).toBeDefined();
		await waitFor(() => expect(router.state.location.pathname).toBe("/onboarding"));
	});

	it("still honours the older ?invite= link shape", async () => {
		client.auth.workspaces.invitation.mockResolvedValue({
			organizationName: "Nitric",
		});

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
		fireEvent.change(screen.getByLabelText("Work email"), {
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
			new ApiError(
				"forbidden",
				"Signups are invite only. Ask a member to invite you.",
				403,
				"SIGN_UP_CLOSED",
			),
		);
		mount("/", null);

		await createAccount("Eve", "eve@example.com");

		expect(await screen.findByText(/invite only/)).toBeDefined();
		expect(screen.queryByText("Check your email")).toBeNull();
	});

	it("asks an unverified account to open its link when it logs in", async () => {
		client.auth.signIn.mockRejectedValue(
			new ApiError("forbidden", "Email not verified", 403, "EMAIL_NOT_VERIFIED"),
		);
		mount("/", null);

		fireEvent.change(await screen.findByLabelText("Work email"), {
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
		client.auth.workspaces.invitation.mockRejectedValue(
			new ApiError(
				"forbidden",
				"Email verification required to view or list invitations for the session email",
				403,
				"EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION",
			),
		);

		mount("/invite/an-invitation", sam);

		expect((await screen.findByRole("alert")).textContent).toContain(
			"Verify your email address before accepting",
		);
	});

	it("does not retry an accepted invitation when continuing initially fails", async () => {
		client.auth.workspaces.invitation.mockResolvedValue({
			organizationName: "Nitric",
		});
		client.auth.workspaces.acceptInvite.mockResolvedValue(undefined);
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
		expect(client.auth.workspaces.acceptInvite).toHaveBeenCalledOnce();
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));

		await waitFor(() => expect(router.state.location.pathname).toBe("/agents"));
		expect(client.auth.workspaces.acceptInvite).toHaveBeenCalledOnce();
		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it("resumes an accepted invitation after the page was reloaded", async () => {
		client.api.onboarding["complete-invite"].$post.mockResolvedValue(
			Response.json({ workspaceId: workspace.id }),
		);
		const refresh = vi.fn().mockResolvedValue(undefined);
		const router = mount("/invite/an-invitation", sam, refresh);

		await waitFor(() => expect(router.state.location.pathname).toBe("/agents"));
		expect(client.auth.workspaces.acceptInvite).not.toHaveBeenCalled();
		expect(refresh).toHaveBeenCalledOnce();
	});

	it("awaits login completion and reports its failure", async () => {
		client.auth.signIn.mockResolvedValue(undefined);
		const refresh = vi.fn().mockRejectedValue(new Error("Offline"));
		mount("/login", null, refresh);
		fireEvent.change(await screen.findByLabelText("Work email"), {
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
		mount("/agents/0199a3a0-0000-7000-8000-00000000dead");

		expect(await screen.findByText("No such agent here")).toBeDefined();
	});

	it("distinguishes a failed agent roster from an unknown agent", async () => {
		client.api.workspaces[":workspaceId"].agents.$get.mockResolvedValue(
			Response.json({ error: { code: "forbidden", message: "Unavailable" } }, { status: 403 }),
		);
		mount(linearPage);

		expect(await screen.findByText("Could not load this agent")).toBeDefined();
		expect(screen.queryByText("No such agent here")).toBeNull();
	});

	it("says a thread is not there, and when threads arrive", async () => {
		mount("/threads/anything");

		expect(await screen.findByText("No such thread here")).toBeDefined();
		expect(await screen.findByText(/This thread is unavailable/)).toBeDefined();
	});

	it("says so when the workspace has no agents in it yet", async () => {
		client.api.workspaces[":workspaceId"].agents.$get.mockResolvedValue(Response.json([]));
		mount("/agents");

		expect(await screen.findByText("No agents yet")).toBeDefined();
	});

	it("waits for pods before deciding the workspace has no agents", async () => {
		let answerPods: (response: Response) => void = () => {};
		client.api.workspaces[":workspaceId"].pods.$get.mockReturnValue(
			new Promise<Response>((resolve) => {
				answerPods = resolve;
			}),
		);
		client.api.workspaces[":workspaceId"].agents.$get.mockResolvedValue(Response.json([]));
		mount("/agents");

		await waitFor(() => expect(client.api.workspaces[":workspaceId"].pods.$get).toHaveBeenCalled());
		expect(screen.queryByText("No agents yet")).toBeNull();

		answerPods(Response.json(pods));
		expect(await screen.findByText("No agents yet")).toBeDefined();
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
		mount("/settings/pods");

		// The rail is the section's own heading now, and waiting on it waits on
		// the answers the controls under it are drawn from.
		await screen.findByRole("navigation", { name: "Workspace pods" });

		expect(screen.queryByRole("button", { name: "New pod" })).toBeNull();
	});

	it("shows the address it will get, derived from the name", async () => {
		mount("/settings/pods");
		(await screen.findByRole("button", { name: "New pod" })).click();

		const dialog = await screen.findByRole("dialog", { name: "New pod" });
		fireEvent.change(within(dialog).getByLabelText("Name"), {
			target: { value: "Platform Team" },
		});

		expect(within(dialog).getByText("platform-team")).toBeDefined();
	});

	it("creates one and puts it in the rail", async () => {
		const made = { ...pods[0], id: "new", name: "Platform", slug: "platform" };
		client.api.workspaces[":workspaceId"].pods.$post.mockResolvedValue(Response.json(made));

		mount("/settings/pods");
		(await screen.findByRole("button", { name: "New pod" })).click();

		const dialog = await screen.findByRole("dialog", { name: "New pod" });
		fireEvent.change(within(dialog).getByLabelText("Name"), {
			target: { value: "Platform" },
		});

		client.api.workspaces[":workspaceId"].pods.$get.mockResolvedValue(
			Response.json([...pods, made]),
		);
		within(dialog).getByRole("button", { name: "Create pod" }).click();

		await waitFor(() => {
			expect(client.api.workspaces[":workspaceId"].pods.$post).toHaveBeenCalledWith({
				param: { workspaceId: workspace.id },
				json: { name: "Platform" },
			});
		});
		expect(await screen.findByRole("heading", { name: "Platform" })).toBeDefined();
	});

	it("says so when the address is already taken, and keeps the form open", async () => {
		client.api.workspaces[":workspaceId"].pods.$post.mockResolvedValue(
			Response.json({ error: { code: "conflict", message: "already exists" } }, { status: 409 }),
		);

		mount("/settings/pods");
		(await screen.findByRole("button", { name: "New pod" })).click();

		const dialog = await screen.findByRole("dialog", { name: "New pod" });
		fireEvent.change(within(dialog).getByLabelText("Name"), {
			target: { value: "Sales" },
		});
		within(dialog).getByRole("button", { name: "Create pod" }).click();

		expect(await within(dialog).findByRole("alert")).toBeDefined();
		expect(screen.getByRole("dialog", { name: "New pod" })).toBeDefined();
	});
});

describe("Personal pod settings", () => {
	it("groups the private pod separately and offers no rename action", async () => {
		const personalPod = {
			...pods[0],
			id: "0199a3a0-0000-7000-8000-0000000000af",
			kind: "personal" as const,
			name: "Personal",
			slug: "personal-test",
			permissions: OWN_PERSONAL_POD,
		};
		client.api.workspaces[":workspaceId"].pods.$get.mockResolvedValue(
			Response.json([personalPod, ...pods]),
		);

		mount(`/settings/pods/${personalPod.id}`);

		const rail = await screen.findByRole("navigation", {
			name: "Workspace pods",
		});
		expect(await within(rail).findByText("Personal", { selector: "p" })).toBeDefined();
		expect(within(rail).getByText("Pods")).toBeDefined();
		expect(screen.queryByRole("button", { name: "Personal options" })).toBeNull();
	});
});

describe("creating an agent", () => {
	it("offers a member of the pod the same New agent action as an admin", async () => {
		mount(`/settings/pods/${pods[0]?.id}`);

		expect(await screen.findByRole("button", { name: "New agent" })).toBeDefined();
		cleanup();
		vi.clearAllMocks();

		apiAnswers({ role: "member" });
		mount(`/settings/pods/${pods[0]?.id}`);
		await screen.findByRole("heading", { name: pods[0]?.name });

		expect(screen.getByRole("button", { name: "New agent" })).toBeDefined();
	});

	it("keeps deleting agents, and making pods, to those allowed them", async () => {
		mount(`/settings/pods/${pods[0]?.id}`);

		expect(await screen.findByRole("button", { name: "New pod" })).toBeDefined();
		expect(screen.getAllByRole("button", { name: "Delete" }).length).toBeGreaterThan(0);
		cleanup();
		vi.clearAllMocks();

		apiAnswers({ role: "member" });
		mount(`/settings/pods/${pods[0]?.id}`);
		await screen.findByRole("heading", { name: pods[0]?.name });

		expect(screen.queryByRole("button", { name: "New pod" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
	});

	it("creates a shared agent in its pod and opens its settings", async () => {
		const made = {
			...linear,
			id: "0199a3a0-0000-7000-8000-0000000000c9",
			name: "Release Coordinator",
			model: MODELS[0] as string,
			podId: pods[0]?.id as string,
		};
		client.api.pods[":podId"].agents.$post.mockResolvedValue(Response.json(made, { status: 201 }));
		const router = mount(`/settings/pods/${pods[0]?.id}`);
		(await screen.findByRole("button", { name: "New agent" })).click();

		const dialog = await screen.findByRole("dialog", { name: "New agent" });
		fireEvent.change(within(dialog).getByLabelText("Name"), {
			target: { value: `  ${made.name}  ` },
		});
		client.api.workspaces[":workspaceId"].agents.$get.mockResolvedValue(
			Response.json([...agents, made]),
		);
		within(dialog).getByRole("button", { name: "Create agent" }).click();

		await waitFor(() => {
			expect(client.api.pods[":podId"].agents.$post).toHaveBeenCalledWith({
				param: { podId: made.podId },
				json: {
					name: made.name,
					model: made.model,
				},
			});
		});
		await waitFor(() =>
			expect(router.state.location.pathname).toBe(`/settings/pods/${made.podId}/agents/${made.id}`),
		);
		expect(screen.queryByRole("dialog", { name: "New agent" })).toBeNull();
		expect((await screen.findAllByText(made.name)).length).toBeGreaterThan(0);
	});

	it("keeps a duplicate-name error in the creation form", async () => {
		client.api.pods[":podId"].agents.$post.mockResolvedValue(
			Response.json({ error: { code: "conflict", message: "already exists" } }, { status: 409 }),
		);
		mount(`/settings/pods/${pods[0]?.id}`);
		(await screen.findByRole("button", { name: "New agent" })).click();

		const dialog = await screen.findByRole("dialog", { name: "New agent" });
		fireEvent.change(within(dialog).getByLabelText("Name"), {
			target: { value: linear.name },
		});
		within(dialog).getByRole("button", { name: "Create agent" }).click();

		expect((await within(dialog).findByRole("alert")).textContent).toContain(
			"An agent with that name already exists",
		);
		expect(screen.getByRole("dialog", { name: "New agent" })).toBeDefined();
	});
});

describe("workspace settings", () => {
	it("shows the selected pod name in the agent filter", async () => {
		mount("/settings/agents");

		const filter = await screen.findByRole("combobox", {
			name: "Filter by pod",
		});
		open(filter);
		(await screen.findByRole("option", { name: pods[0]?.name })).click();

		await waitFor(() => {
			const selected = screen.getByRole("combobox", { name: "Filter by pod" });
			expect(selected.textContent).toContain(pods[0]?.name);
			expect(selected.textContent).not.toContain(pods[0]?.id);
		});
	});

	it("keeps the built-in agents out of the agent table, since they are in no pod", async () => {
		mount("/settings/agents");

		// The roster is still behind the settings window, and it names agents
		// too, so the table is asked rather than the page.
		const settings = await screen.findByRole("dialog", { name: "Workspace settings" });
		await within(settings).findByText(linear.name);
		expect(within(settings).queryByText(facilitator.name)).toBeNull();
	});

	it("selects a pod from its settings rail", async () => {
		const pod = pods[0] as (typeof pods)[number];
		mount(`/settings/pods/${pod.id}`);

		const rail = await screen.findByRole("navigation", {
			name: "Workspace pods",
		});
		const selected = await within(rail).findByRole("link", {
			name: /Suga-Team/,
		});
		expect(selected.getAttribute("aria-current")).toBe("page");
	});

	it("selects a provider from the provider rail and searches its models", async () => {
		mount("/settings/providers");

		const providers = await screen.findByRole("navigation", {
			name: "Model providers",
		});
		fireEvent.click(within(providers).getByRole("button", { name: /Anthropic/ }));

		await screen.findByRole("region", { name: "Anthropic models" });
		const search = screen.getByLabelText("Search models");
		fireEvent.change(search, { target: { value: "opus" } });
		expect(screen.getByText("claude-opus-4-1-20250805")).toBeDefined();
		fireEvent.change(search, { target: { value: "gpt" } });
		expect(screen.queryByText("claude-opus-4-1-20250805")).toBeNull();
	});

	const ollama = {
		...modelProviders[0],
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
		client.api.workspaces[":workspaceId"]["model-providers"].$get.mockResolvedValue(
			Response.json([provider]),
		);
		client.api.workspaces[":workspaceId"]["model-providers"][
			":providerId"
		].$patch.mockResolvedValue(Response.json(provider));
		mount("/settings/providers");
	}

	const patched = () =>
		client.api.workspaces[":workspaceId"]["model-providers"][":providerId"].$patch;

	it("shows the Ollama connection locked in, and needs no key to list models", async () => {
		mountOllama();

		expect(await screen.findByText(ollama.baseUrl)).toBeDefined();
		expect(screen.getByText("None")).toBeDefined();
		expect(screen.queryByLabelText("Server URL")).toBeNull();
		expect(screen.getByRole("button", { name: "Refresh" }).hasAttribute("disabled")).toBe(false);
	});

	it("saves the server somebody types, completing it into a base URL", async () => {
		mountOllama();

		fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
		const serverUrl = screen.getByLabelText("Server URL") as HTMLInputElement;
		expect(serverUrl.value).toBe(ollama.baseUrl);
		fireEvent.change(serverUrl, { target: { value: "studio.local:9000" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => {
			expect(patched()).toHaveBeenCalledWith({
				param: { workspaceId: workspace.id, providerId: ollama.id },
				json: { baseUrl: "http://studio.local:9000/v1" },
			});
		});
	});

	it("refuses to save an address it cannot read, and says so", async () => {
		mountOllama();

		fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
		fireEvent.change(screen.getByLabelText("Server URL"), {
			target: { value: "my ollama server" },
		});

		expect(screen.getByText(/not a server address/)).toBeDefined();
		expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
		expect(patched()).not.toHaveBeenCalled();
	});

	it("puts the fields back to a stock local install", async () => {
		mountOllama({ ...ollama, baseUrl: "http://studio.local:9000/v1" });

		fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
		fireEvent.click(screen.getByRole("button", { name: /Reset to default/ }));
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => {
			expect(patched()).toHaveBeenCalledWith({
				param: { workspaceId: workspace.id, providerId: ollama.id },
				json: { baseUrl: "http://127.0.0.1:11434/v1" },
			});
		});
	});

	it("removes a key that was set, rather than only replacing it", async () => {
		mountOllama({ ...ollama, hasApiKey: true, apiKeyHint: "1234" });

		fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
		fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => {
			expect(patched()).toHaveBeenCalledWith({
				param: { workspaceId: workspace.id, providerId: ollama.id },
				json: { baseUrl: ollama.baseUrl, apiKey: null },
			});
		});
	});

	it("creates a provider without requiring an API key", async () => {
		const provider = {
			...modelProviders[0],
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
		client.api.workspaces[":workspaceId"]["model-providers"].$post.mockResolvedValue(
			Response.json(provider),
		);
		mount("/settings/providers");

		fireEvent.click(await screen.findByRole("button", { name: "Add provider" }));
		fireEvent.click(screen.getByRole("button", { name: /Custom endpoint/ }));
		fireEvent.change(screen.getByLabelText("Name"), {
			target: { value: provider.name },
		});
		fireEvent.change(screen.getByLabelText("Base URL"), {
			target: { value: provider.baseUrl },
		});
		fireEvent.click(screen.getAllByRole("button", { name: "Add provider" }).at(-1) as HTMLElement);

		await waitFor(() => {
			expect(client.api.workspaces[":workspaceId"]["model-providers"].$post).toHaveBeenCalledWith({
				param: { workspaceId: workspace.id },
				json: {
					name: provider.name,
					baseUrl: provider.baseUrl,
					apiFormat: "openai",
					apiKey: undefined,
					customHeaders: [],
				},
			});
		});
	});

	it("offers the catalog, minus what the workspace already has, and adds a preset by its key", async () => {
		const groq = {
			...modelProviders[0],
			id: "0199a3a0-0000-7000-8000-0000000000d1",
			preset: "groq" as const,
			name: "Groq",
			baseUrl: "https://api.groq.com/openai/v1",
			models: [],
			modelCount: 0,
			enabledModelCount: 0,
		};
		client.api.workspaces[":workspaceId"]["model-providers"].$post.mockResolvedValue(
			Response.json(groq),
		);
		mount("/settings/providers");

		fireEvent.click(await screen.findByRole("button", { name: "Add provider" }));
		const hosted = screen.getByRole("region", { name: "Hosted services" });
		expect(within(hosted).queryByRole("button", { name: /^OpenAI /i })).toBeNull();

		fireEvent.click(within(hosted).getByRole("button", { name: /Groq/ }));
		expect(screen.getByRole("button", { name: "Add Groq" }).hasAttribute("disabled")).toBe(true);
		fireEvent.change(screen.getByLabelText("Groq API key"), {
			target: { value: "gsk-test" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add Groq" }));

		await waitFor(() => {
			expect(client.api.workspaces[":workspaceId"]["model-providers"].$post).toHaveBeenCalledWith({
				param: { workspaceId: workspace.id },
				json: { preset: "groq", apiKey: "gsk-test" },
			});
		});
	});

	it("labels provider credentials and reports connection failures where they happen", async () => {
		client.api.workspaces[":workspaceId"]["model-providers"][
			":providerId"
		].test.$post.mockResolvedValue(
			Response.json(
				{ error: { code: "internal", message: "Provider unavailable" } },
				{ status: 500 },
			),
		);
		mount("/settings/providers");

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
			...modelProviders[0],
			id: "0199a3a0-0000-7000-8000-0000000000cf",
			preset: null,
			name: "Local gateway",
			baseUrl: "http://localhost:11434/v1",
			models: [],
			modelCount: 0,
			enabledModelCount: 0,
		};
		client.api.workspaces[":workspaceId"]["model-providers"].$get.mockResolvedValue(
			Response.json([custom]),
		);
		client.api.workspaces[":workspaceId"]["model-providers"][
			":providerId"
		].models.$post.mockResolvedValue(
			Response.json(
				{ error: { code: "internal", message: "Could not add model" } },
				{ status: 500 },
			),
		);
		mount("/settings/providers");
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
		mount("/settings/members");
		const dialog = await openInvitePanel();

		expect(dialog.ownerDocument.querySelector('[data-slot="dialog-overlay"]')).not.toBeNull();
	});

	it("copies an invitation link for the selected workspace", async () => {
		client.auth.workspaces.invite.mockResolvedValue({ id: "an-invitation" });
		mount("/settings/members");
		await openInvitePanel();

		fireEvent.change(await screen.findByLabelText("Email address"), {
			target: { value: "jye@example.com" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Copy invitation link" }));

		await waitFor(() => {
			expect(client.auth.workspaces.invite).toHaveBeenCalledWith({
				email: "jye@example.com",
				role: "member",
				workspaceId: workspace.id,
				resend: undefined,
			});
		});
		expect(writeClipboardText).toHaveBeenCalledWith(
			`${window.location.origin}/invite/an-invitation`,
		);
	});

	it("invites somebody as a viewer, with each role described where it is chosen", async () => {
		client.auth.workspaces.invite.mockResolvedValue({ id: "an-invitation" });
		mount("/settings/members");
		const panel = await openInvitePanel();

		fireEvent.change(await screen.findByLabelText("Email address"), {
			target: { value: "jye@example.com" },
		});
		expect(
			within(panel).getByText("Reads and takes part in the pods they are added to."),
		).toBeDefined();
		fireEvent.click(within(panel).getByRole("radio", { name: /Viewer/ }));
		fireEvent.click(screen.getByRole("button", { name: "Copy invitation link" }));

		await waitFor(() => {
			expect(client.auth.workspaces.invite).toHaveBeenCalledWith(
				expect.objectContaining({ email: "jye@example.com", role: "viewer" }),
			);
		});
	});

	it("changes what somebody may do", async () => {
		mount("/settings/members");

		open(await screen.findByRole("combobox", { name: `Access for ${jye.name}` }));
		(await screen.findByRole("option", { name: /Viewer/ })).click();

		await waitFor(() => {
			expect(client.auth.workspaces.updateRole).toHaveBeenCalledWith({
				workspaceId: workspace.id,
				memberId: "0199a3a0-0000-7000-8000-0000000000d2",
				role: "viewer",
			});
		});
	});

	it("asks before removing somebody, and says what goes with them", async () => {
		mount("/settings/members");

		open(await screen.findByRole("button", { name: `${jye.name} options` }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Remove from workspace" }));

		expect(await screen.findByRole("heading", { name: `Remove ${jye.name}?` })).toBeDefined();
		expect(screen.getByText(/their Personal pod and its conversations are deleted/)).toBeDefined();
		expect(client.auth.workspaces.removeMember).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));

		await waitFor(() => {
			expect(client.auth.workspaces.removeMember).toHaveBeenCalledWith({
				workspaceId: workspace.id,
				memberId: "0199a3a0-0000-7000-8000-0000000000d2",
			});
		});
	});

	it("offers leaving on your own row, and no way to change your own access", async () => {
		mount("/settings/members");

		// Somebody else's row can be re-roled; your own cannot, because demoting
		// yourself takes away the means to undo it. Leaving is still yours.
		expect(await screen.findByRole("combobox", { name: `Access for ${jye.name}` })).toBeDefined();
		expect(screen.queryByRole("combobox", { name: `Access for ${sam.name}` })).toBeNull();

		open(screen.getByRole("button", { name: `${sam.name} options` }));
		expect(await screen.findByRole("menuitem", { name: "Leave workspace" })).toBeDefined();
		expect(screen.queryByRole("menuitem", { name: "Remove from workspace" })).toBeNull();
	});

	it("warns what leaving costs before doing it", async () => {
		mount("/settings/members");

		open(await screen.findByRole("button", { name: `${sam.name} options` }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Leave workspace" }));

		expect(await screen.findByRole("heading", { name: "Leave this workspace?" })).toBeDefined();
		expect(screen.getByText(/somebody inviting you again/)).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));

		await waitFor(() => {
			expect(client.auth.workspaces.leave).toHaveBeenCalledWith(workspace.id);
		});
	});

	it("lists an invitation as somebody who has not arrived, and can withdraw it", async () => {
		mount("/settings/members");

		expect(await screen.findByText("dana@example.com")).toBeDefined();
		expect(screen.getByText("Invited, not yet accepted")).toBeDefined();

		open(
			screen.getByRole("button", {
				name: "Invitation for dana@example.com options",
			}),
		);
		fireEvent.click(await screen.findByRole("menuitem", { name: "Revoke invitation" }));

		await waitFor(() => {
			expect(client.auth.workspaces.cancelInvite).toHaveBeenCalledWith(
				"0199a3a0-0000-7000-8000-0000000000e1",
			);
		});
	});

	it("sends an invitation again without retyping it", async () => {
		mount("/settings/members");

		open(
			await screen.findByRole("button", {
				name: "Invitation for dana@example.com options",
			}),
		);
		fireEvent.click(await screen.findByRole("menuitem", { name: "Send it again" }));

		await waitFor(() => {
			expect(client.auth.workspaces.invite).toHaveBeenCalledWith({
				email: "dana@example.com",
				role: "viewer",
				workspaceId: workspace.id,
				resend: true,
			});
		});
	});

	it("shows a member who holds what, and no way to change it", async () => {
		apiAnswers({ role: "member" });
		mount("/settings/members");

		expect(await screen.findByText("Administrator")).toBeDefined();
		expect(screen.getByText("Member")).toBeDefined();
		expect(screen.queryByRole("combobox", { name: `Access for ${jye.name}` })).toBeNull();
		expect(screen.queryByRole("button", { name: "Invite people" })).toBeNull();
	});

	it("keeps a rejected invitation address available for retry", async () => {
		client.auth.workspaces.invite.mockRejectedValue(new Error("Offline"));
		mount("/settings/members");
		await openInvitePanel();
		const email = await screen.findByLabelText("Email address");
		fireEvent.change(email, { target: { value: "jye@example.com" } });

		fireEvent.click(screen.getByRole("button", { name: "Copy invitation link" }));

		expect((await screen.findAllByRole("alert")).length).toBeGreaterThan(0);
		expect((email as HTMLInputElement).value).toBe("jye@example.com");
	});

	it("lets somebody with no workspace start their first one", async () => {
		client.auth.workspaces.list.mockResolvedValue([]);
		client.api.onboarding.$get.mockResolvedValue(Response.json({ completed: false }));
		client.auth.workspaces.create.mockResolvedValue({
			id: "0199a3a0-0000-7000-8000-0000000000f9",
			name: "Nitric",
			slug: "nitric",
		});
		const router = mount("/settings");

		fireEvent.change(await screen.findByLabelText("Workspace name"), {
			target: { value: "Nitric" },
		});
		(await screen.findByRole("button", { name: "Continue" })).click();

		await waitFor(() => {
			expect(router.state.location.pathname).toBe("/onboarding");
			expect(client.auth.workspaces.create).toHaveBeenCalledWith({
				name: "Nitric",
				slug: "nitric",
			});
		});
	});

	it("keeps a rejected workspace name and creation form open", async () => {
		client.auth.workspaces.list.mockResolvedValue([]);
		client.api.onboarding.$get.mockResolvedValue(Response.json({ completed: false }));
		client.auth.workspaces.create.mockRejectedValue(new Error("Offline"));
		mount("/settings");
		const name = await screen.findByLabelText("Workspace name");
		fireEvent.change(name, { target: { value: "Nitric" } });

		fireEvent.click(screen.getByRole("button", { name: "Continue" }));

		expect((await screen.findByRole("alert")).textContent).toContain("Could not reach the API");
		expect((name as HTMLInputElement).value).toBe("Nitric");
		expect(screen.getByRole("button", { name: "Continue" })).toBeDefined();
	});
});

describe("the theme", () => {
	it("follows the system until something is chosen", async () => {
		mount(linearPage);

		await screen.findByRole("navigation", { name: "Workspace" });

		expect(document.documentElement.dataset.theme).toBeUndefined();
	});

	it("is chosen from the user menu, and remembered", async () => {
		mount(linearPage);

		open(await screen.findByRole("button", { name: /Sam/ }));
		(await screen.findByRole("menuitemradio", { name: "Dark" })).click();

		await waitFor(() => {
			expect(document.documentElement.dataset.theme).toBe("dark");
		});
		expect(localStorage.getItem("sugabots-theme")).toBe("dark");
	});

	it("stores nothing when told to follow the system, because that is what it is", async () => {
		localStorage.setItem("sugabots-theme", "dark");
		mount(linearPage);

		open(await screen.findByRole("button", { name: /Sam/ }));
		(await screen.findByRole("menuitemradio", { name: "Follow the system" })).click();

		await waitFor(() => {
			expect(document.documentElement.dataset.theme).toBeUndefined();
		});
		expect(localStorage.getItem("sugabots-theme")).toBeNull();
	});
});

describe("pod settings", () => {
	const [suga] = pods;
	if (!suga) throw new Error("fixture");
	const podPage = `/settings/pods/${suga.id}`;
	const samInPod = {
		userId: sam.id,
		name: sam.name,
		email: sam.email,
		image: null,
		addedAt: "2026-09-09T00:00:00.000Z",
	};
	const jyeInPod = {
		...samInPod,
		userId: jye.id,
		name: jye.name,
		email: jye.email,
	};
	const openRouting = async () => {
		fireEvent.click(await screen.findByRole("tab", { name: "Routing" }));
	};

	it("offers facilitator routing for automated threads", async () => {
		client.api.pods[":podId"].$patch.mockResolvedValue(
			Response.json({ ...suga, routing: { facilitator: true } }),
		);
		mount(podPage);
		await openRouting();

		const nobody = await screen.findByRole("radio", { name: "Nobody" });
		expect((nobody as HTMLInputElement).checked).toBe(true);
		const decides = screen.getByRole("radio", {
			name: "The Facilitator decides",
		});
		expect((decides as HTMLInputElement).checked).toBe(false);
		fireEvent.click(decides);

		await waitFor(() =>
			expect(client.api.pods[":podId"].$patch).toHaveBeenCalledWith({
				param: { podId: suga.id },
				json: { routing: { facilitator: true } },
			}),
		);
	});

	it("turns facilitator routing off for the quiet option", async () => {
		client.api.workspaces[":workspaceId"].pods.$get.mockResolvedValue(
			Response.json(
				pods.map((pod) => (pod.id === suga.id ? { ...pod, routing: { facilitator: true } } : pod)),
			),
		);
		client.api.pods[":podId"].$patch.mockResolvedValue(
			Response.json({ ...suga, routing: { facilitator: false } }),
		);
		mount(podPage);
		await openRouting();

		fireEvent.click(await screen.findByRole("radio", { name: "Nobody" }));

		await waitFor(() =>
			expect(client.api.pods[":podId"].$patch).toHaveBeenCalledWith({
				param: { podId: suga.id },
				json: { routing: { facilitator: false } },
			}),
		);
	});

	it("names the Facilitator's model beside its option, with a way to change it", async () => {
		mount(podPage);
		await openRouting();

		expect(await screen.findByText(facilitator.model as string)).toBeDefined();
		expect(screen.getByRole("link", { name: "change" }).getAttribute("href")).toBe(
			"/settings/built-in-agents/facilitate",
		);
	});

	it("tells a member the Facilitator is unset without offering a link they cannot follow", async () => {
		apiAnswers({ role: "member" });
		client.api.workspaces[":workspaceId"]["system-agents"].$get.mockResolvedValue(
			Response.json(builtInAgents.map((one) => ({ ...one, model: null }))),
		);
		mount(podPage);
		await openRouting();

		expect(await screen.findByText(/A workspace administrator chooses its model/)).toBeDefined();
		expect(screen.queryByRole("link", { name: "set it up" })).toBeNull();
	});

	it("cannot hand the floor to a Facilitator with no model, and says where to set it up", async () => {
		client.api.workspaces[":workspaceId"]["system-agents"].$get.mockResolvedValue(
			Response.json(builtInAgents.map((one) => ({ ...one, model: null }))),
		);
		mount(podPage);
		await openRouting();

		const option = await screen.findByRole("radio", { name: "The Facilitator decides" });
		expect(option.hasAttribute("disabled")).toBe(true);
		expect(screen.getByRole("link", { name: "set it up" }).getAttribute("href")).toBe(
			"/settings/built-in-agents/facilitate",
		);
		fireEvent.click(option);
		expect(client.api.pods[":podId"].$patch).not.toHaveBeenCalled();
	});

	it("lists only crew in a pod, with nothing to say about built-in agents", async () => {
		mount(podPage);

		expect(await screen.findByRole("link", { name: linear.name })).toBeDefined();
		expect(screen.queryByText("User agents")).toBeNull();
		expect(screen.queryByText("System agents")).toBeNull();
		expect(screen.queryByRole("link", { name: facilitator.name })).toBeNull();
	});

	it("confirms agent deletion in a dialog", async () => {
		client.api.agents[":agentId"].$delete.mockResolvedValue(new Response(null, { status: 204 }));
		mount(podPage);

		const agentLink = await screen.findByRole("link", { name: linear.name });
		const row = agentLink.closest("li");
		if (!row) throw new Error("Agent row not found");
		fireEvent.click(within(row).getByRole("button", { name: "Delete" }));

		expect(await screen.findByRole("dialog", { name: `Delete ${linear.name}?` })).toBeDefined();
		expect(client.api.agents[":agentId"].$delete).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));

		await waitFor(() =>
			expect(client.api.agents[":agentId"].$delete).toHaveBeenCalledWith({
				param: { agentId: linear.id },
			}),
		);
	});

	it("adds somebody from the workspace", async () => {
		client.api.pods[":podId"].members.$post.mockResolvedValue(new Response(null, { status: 204 }));
		mount(podPage);

		open(await screen.findByRole("button", { name: "Invite" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: sam.name }));

		await waitFor(() =>
			expect(client.api.pods[":podId"].members.$post).toHaveBeenCalledWith({
				param: { podId: suga.id },
				json: { userId: sam.id },
			}),
		);
	});

	it("says when everyone in the workspace is already in", async () => {
		client.api.pods[":podId"].members.$get.mockImplementation(async () =>
			Response.json([samInPod, jyeInPod]),
		);
		mount(podPage);

		open(await screen.findByRole("button", { name: "Invite" }));

		expect(
			await screen.findByRole("menuitem", {
				name: "Everyone in the workspace is here.",
			}),
		).toBeDefined();
	});

	it("offers a member the lists and none of the controls", async () => {
		apiAnswers({ role: "member" });
		client.api.pods[":podId"].members.$get.mockImplementation(async () =>
			Response.json([samInPod]),
		);
		mount(podPage);

		// The roster behind the settings window names agents too.
		const settings = await screen.findByRole("dialog", { name: "Workspace settings" });
		expect(await within(settings).findByText(linear.name)).toBeDefined();
		expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
		expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
		expect(screen.queryByRole("button", { name: `${suga.name} options` })).toBeNull();
		await openRouting();
		expect((screen.getByRole("radio", { name: "Nobody" }) as HTMLInputElement).disabled).toBe(true);
		fireEvent.click(screen.getByRole("tab", { name: "Routing" }));
		expect(
			(
				(await screen.findByRole("radio", {
					name: "Nobody",
				})) as HTMLInputElement
			).disabled,
		).toBe(true);
	});

	it("deletes the pod after asking, and returns to the list", async () => {
		client.api.pods[":podId"].$delete.mockResolvedValue(new Response(null, { status: 204 }));
		const router = mount(podPage);

		open(await screen.findByRole("button", { name: `${suga.name} options` }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Delete pod" }));
		expect(client.api.pods[":podId"].$delete).not.toHaveBeenCalled();
		fireEvent.click(await screen.findByRole("button", { name: "Yes, delete" }));

		await waitFor(() =>
			expect(client.api.pods[":podId"].$delete).toHaveBeenCalledWith({
				param: { podId: suga.id },
			}),
		);
		await waitFor(() => expect(router.state.location.pathname).toBe("/settings/pods"));
	});

	it("says so when a pod with threads cannot be deleted", async () => {
		client.api.pods[":podId"].$delete.mockResolvedValue(
			Response.json(
				{ error: { code: "conflict", message: "The pod still has threads" } },
				{ status: 409 },
			),
		);
		mount(podPage);

		open(await screen.findByRole("button", { name: `${suga.name} options` }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Delete pod" }));
		fireEvent.click(await screen.findByRole("button", { name: "Yes, delete" }));

		expect(await screen.findByRole("alert")).toBeDefined();
	});
});
