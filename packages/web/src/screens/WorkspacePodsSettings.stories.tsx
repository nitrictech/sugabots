import type { ConnectionAccess } from "@sugabots/contracts";
import { listedConnection, type TestConnection } from "@sugabots/contracts/testing";
import { HttpResponse, http } from "msw";
import { expect, within } from "storybook/test";
import preview from "#storybook/preview";
import { revenue } from "@/shell/story-fixtures.ts";
import { appHandlers, StoryApp, storyPods, storyUser, storyWorkspace } from "../story-app.tsx";

/*
 * A pod in settings, listed in the navigation with its pages: General, the
 * apps its bots share, its people, and its bots. On a phone a pod's page
 * opens full screen, with the way back to the list of settings.
 */

const API = import.meta.env.VITE_API_URL as string;
const pods = `/${storyWorkspace.slug}/settings/pods`;
const revenuePage = (page: "connections" | "people" | "bots") => `${pods}/${revenue.slug}/${page}`;
const PHONE = { viewport: { value: "iphone12", isRotated: false } };

const people = [
	{ userId: storyUser.id, name: storyUser.name, email: storyUser.email, image: null },
	{
		userId: "0199a3a0-0000-7000-8000-000000000012",
		name: "Jay Young",
		email: "jay@nitric.io",
		image: null,
	},
	{
		userId: "0199a3a0-0000-7000-8000-000000000013",
		name: "Mara Kent",
		email: "mara@nitric.io",
		image: null,
	},
].map((person, index) => ({
	...person,
	addedAt: "2026-09-02T00:00:00.000Z",
	// The first two are administrators, as the workspace roster below says.
	removable: index > 1,
}));

function connection(
	n: number,
	name: string,
	url: string,
	access: ConnectionAccess,
): TestConnection {
	return {
		id: `0199a3a0-0000-7000-8000-0000000006${String(n).padStart(2, "0")}`,
		workspaceId: revenue.workspaceId,
		podId: revenue.id,
		name,
		handle: name.toLowerCase(),
		url,
		kind: "mcp",
		auth: "oauth",
		signedIn: true,
		secretHeader: null,
		hasSecret: false,
		appSettingsUrl: null,
		status: "connected",
		tools: [{ name: "search", description: "Search", readOnly: true, destructive: false, access }],
		lastTestedAt: "2026-09-18T06:00:00.000Z",
		lastTestError: null,
		connectedBy: null,
		createdAt: "2026-09-10T00:00:00.000Z",
	};
}

const connections = [
	connection(1, "HubSpot", "https://mcp.hubspot.com/mcp", "allow"),
	connection(2, "Gmail", "https://mcp.gmail.example/mcp", "ask"),
];

/** The Revenue pod's people and apps, which the example workspace has none of by default. */
const revenueHandlers = [
	// The pod's people are the workspace's too, with the roles the pod's rows show.
	http.get(`${API}/workspaces/:workspace/members`, () =>
		HttpResponse.json(
			people.map((person, index) => ({
				id: `0199a3a0-0000-7000-8000-0000000007${index}0`,
				role: index === 0 ? "admin" : index === 1 ? "admin" : "member",
				user: { id: person.userId, name: person.name, email: person.email, image: null },
				joinedAt: person.addedAt,
			})),
		),
	),
	http.get(`${API}/pods/:podId/members`, ({ params }) =>
		HttpResponse.json(params.podId === revenue.id ? people : people.slice(0, 1)),
	),
	http.get(`${API}/pods/:podId/connections`, ({ params }) =>
		HttpResponse.json(params.podId === revenue.id ? connections.map(listedConnection) : []),
	),
];

const meta = preview.meta({
	title: "Views/Pods",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(...revenueHandlers, ...appHandlers());
	},
});

/** Every pod in the navigation, shared ones apart from yours, and the open one's pages under it. */
export const Navigation = meta.story({
	render: () => <StoryApp path={`${pods}/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		const nav = await canvas.findByRole("navigation", { name: "Settings" }, { timeout: 10_000 });
		await expect(await within(nav).findByRole("button", { name: "Revenue" })).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		await expect(within(nav).getByRole("heading", { name: "Personal pods" })).toBeInTheDocument();
		await expect(
			await within(nav).findByRole("link", { name: "Connections, 2" }),
		).toBeInTheDocument();
		await expect(within(nav).getByRole("button", { name: "New pod" })).toBeInTheDocument();
	},
});

/** A shared pod's General: its name and colour, its computer, and deleting it. */
export const SharedPod = meta.story({
	render: () => <StoryApp path={`${pods}/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Revenue" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Delete pod" })).toBeInTheDocument();
	},
});

/** The apps every bot in the pod shares, each with what its tools may do. */
export const Connections = meta.story({
	render: () => <StoryApp path={revenuePage("connections")} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Connections" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(await canvas.findByRole("article", { name: "HubSpot" })).toBeInTheDocument();
		await expect(canvas.getByRole("article", { name: "Gmail" })).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Add connection" })).toBeInTheDocument();
	},
});

/**
 * Who can see into the pod. Administrators are in every shared pod, so only
 * Mara, a member, can be taken out, and you cannot leave.
 */
export const People = meta.story({
	render: () => <StoryApp path={revenuePage("people")} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "People" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(await canvas.findByText("Jay Young")).toBeInTheDocument();
		await expect(await canvas.findByText("Admin")).toBeInTheDocument();
		await expect(
			await canvas.findByRole("button", { name: "Remove Mara Kent" }),
		).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Remove Jay Young" })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Leave Revenue" })).toBeNull();
		await expect(canvas.getByRole("button", { name: "Add people" })).toBeInTheDocument();
	},
});

/** The pod's bots, each with what it does, and New bot. */
export const Bots = meta.story({
	render: () => <StoryApp path={revenuePage("bots")} />,
	play: async ({ canvas }) => {
		const page = await canvas.findByRole("main", {}, { timeout: 10_000 });
		await expect(
			await within(page).findByRole("heading", { name: "Bots" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(
			await within(page).findByRole("link", { name: /^Growth Desk/ }),
		).toBeInTheDocument();
		await expect(within(page).getByRole("button", { name: "New bot" })).toBeInTheDocument();
	},
});

/**
 * Personal: only you, so it has no People, and nothing to rename or delete,
 * so no General. Its settings open on its Connections.
 */
export const PersonalPod = meta.story({
	render: () => <StoryApp path={`${pods}/personal`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Connections", level: 2 }, { timeout: 10_000 }),
		).toBeInTheDocument();
		const personal = canvas.getByRole("group", { name: "Personal pods" });
		await expect(within(personal).queryByRole("link", { name: "General" })).toBeNull();
		await expect(within(personal).queryByRole("link", { name: /^People/ })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Delete pod" })).toBeNull();
	},
});

/** A member reads the pod's people, without the controls only an administrator has, and can leave it. */
export const AsAMember = meta.story({
	beforeEach({ msw }) {
		// A pod carries what its viewer may do there; a member may not rename, delete or manage it.
		const asMember = storyPods.map((pod) => ({
			...pod,
			permissions: {
				...pod.permissions,
				rename: false,
				manageMembers: false,
				manageConnections: false,
				manageSandbox: false,
				deleteAgents: false,
				leave: pod.kind === "shared",
			},
		}));
		msw.use(...revenueHandlers, ...appHandlers({ role: "member", pods: asMember }));
	},
	render: () => <StoryApp path={revenuePage("people")} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "People" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Add people" })).toBeNull();
		await expect(await canvas.findByRole("button", { name: "Leave Revenue" })).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Remove Mara Kent" })).toBeNull();
	},
});

/** A member's General for the same pod: nothing to rename and no Delete pod. */
export const GeneralAsAMember = meta.story({
	beforeEach: AsAMember.input.beforeEach,
	render: () => <StoryApp path={`${pods}/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Revenue" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Delete pod" })).toBeNull();
		await expect(canvas.queryByRole("textbox", { name: "Name" })).toBeNull();
	},
});
/** On a phone a pod's page opens full screen, with the way back to the pod's page in You. */
/** On a phone a pod's page opens full screen, with the way back to the list of settings. */
export const Phone = meta.story({
	globals: PHONE,
	render: () => <StoryApp path={`${pods}/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("link", { name: revenue.name }, { timeout: 10_000 }),
		).toHaveAttribute("href", `/${storyWorkspace.slug}/you/pods/${revenue.slug}`);
		await expect(await canvas.findByRole("heading", { name: "Revenue" })).toBeInTheDocument();
	},
});
