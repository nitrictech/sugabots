import type { Connection, ConnectionAccess } from "@sugabots/contracts";
import { HttpResponse, http } from "msw";
import { expect, within } from "storybook/test";
import preview from "#storybook/preview";
import { revenue } from "@/shell/story-fixtures.ts";
import { appHandlers, StoryApp, storyPods, storyUser, storyWorkspace } from "../story-app.tsx";

/*
 * Pods in settings: every pod beside the open one, which shows its bots, its
 * people and the apps its bots share. On a phone the open pod covers the list,
 * with the way back to it.
 */

const API = import.meta.env.VITE_API_URL as string;
const pods = `/${storyWorkspace.slug}/settings/pods`;
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

function connection(n: number, name: string, url: string, access: ConnectionAccess): Connection {
	return {
		id: `0199a3a0-0000-7000-8000-0000000006${String(n).padStart(2, "0")}`,
		workspaceId: revenue.workspaceId,
		podId: revenue.id,
		name,
		handle: name.toLowerCase(),
		url,
		auth: "oauth",
		signedIn: true,
		secretHeader: null,
		hasSecret: false,
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
		HttpResponse.json(params.podId === revenue.id ? connections : []),
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

/** Every pod, before one is chosen. */
export const List = meta.story({
	render: () => <StoryApp path={pods} />,
	play: async ({ canvas }) => {
		const list = await canvas.findByRole(
			"navigation",
			{ name: "Workspace pods" },
			{ timeout: 10_000 },
		);
		await expect(await within(list).findByRole("link", { name: /Revenue/ })).toBeInTheDocument();
		await expect(within(list).getByRole("link", { name: /Personal/ })).toBeInTheDocument();
	},
});

/**
 * A shared pod: its bots, its people, the apps they share, and deleting it.
 * Administrators are in every shared pod, so only Mara, a member, can be taken
 * out, and you cannot leave.
 */
export const SharedPod = meta.story({
	render: () => <StoryApp path={`${pods}/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Revenue" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(await canvas.findByText("Jay Young")).toBeInTheDocument();
		await expect(await canvas.findByText("Admin")).toBeInTheDocument();
		await expect(
			await canvas.findByRole("button", { name: "Remove Mara Kent" }),
		).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Remove Jay Young" })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Leave Revenue" })).toBeNull();
		await expect(await canvas.findByText("HubSpot")).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Delete pod" })).toBeInTheDocument();
	},
});

/** Personal: only you, so no people to add and nothing to delete. */
export const PersonalPod = meta.story({
	render: () => <StoryApp path={`${pods}/personal`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByText("Only you can see this pod and its bots.", {}, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Delete pod" })).toBeNull();
	},
});

/** A member reads the same pod, without the controls only an administrator has, and can leave it. */
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
				deleteAgents: false,
				changeRouting: false,
				leave: pod.kind === "shared",
			},
		}));
		msw.use(...revenueHandlers, ...appHandlers({ role: "member", pods: asMember }));
	},
	render: () => <StoryApp path={`${pods}/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("heading", { name: "Revenue" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Delete pod" })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Add people" })).toBeNull();
		await expect(await canvas.findByRole("button", { name: "Leave Revenue" })).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Remove Mara Kent" })).toBeNull();
	},
});

/** On a phone the open pod covers the list, with the way back to it. */
export const Phone = meta.story({
	globals: PHONE,
	render: () => <StoryApp path={`${pods}/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		await expect(
			await canvas.findByRole("link", { name: "Pods" }, { timeout: 10_000 }),
		).toBeInTheDocument();
		await expect(await canvas.findByRole("heading", { name: "Revenue" })).toBeInTheDocument();
	},
});
