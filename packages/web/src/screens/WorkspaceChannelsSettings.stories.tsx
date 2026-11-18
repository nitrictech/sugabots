import type { ConnectionAccess } from "@sugabots/contracts";
import { listedConnection, type TestConnection } from "@sugabots/contracts/testing";
import { HttpResponse, http } from "msw";
import { expect, within } from "storybook/test";
import preview from "#storybook/preview";
import { growthDesk, revenue } from "@/shell/story-fixtures.ts";
import { appHandlers, StoryApp, storyChannels, storyUser, storyWorkspace } from "../story-app.tsx";

/*
 * A channel in settings, listed in the navigation with its pages: General, the
 * apps its bots share, its people, and its bots. On a phone a channel's page
 * opens full screen, with the way back to the list of settings.
 */

const API = import.meta.env.VITE_API_URL as string;
const channels = `/${storyWorkspace.slug}/settings/channels`;
const revenuePage = (page: "people" | "bots") => `${channels}/${revenue.slug}/${page}`;
const growthDeskConnections = `${channels}/${revenue.slug}/bots/${growthDesk.handle}/connections`;
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
		botId: "0199a3a0-0000-7000-8000-00000000b071",
		name,
		handle: name.toLowerCase(),
		url,
		kind: "mcp",
		auth: "oauth",
		signedIn: true,
		signInExpired: false,
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

/** The Revenue channel's people and apps, which the example workspace has none of by default. */
const revenueHandlers = [
	// The channel's people are the workspace's too, with the roles the channel's rows show.
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
	http.get(`${API}/channels/:channelId/members`, ({ params }) =>
		HttpResponse.json(params.channelId === revenue.id ? people : people.slice(0, 1)),
	),
	http.get(`${API}/bots/:botId/connections`, ({ params }) =>
		HttpResponse.json(params.botId === growthDesk.id ? connections.map(listedConnection) : []),
	),
];

const meta = preview.meta({
	title: "Views/Channels",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(...revenueHandlers, ...appHandlers());
	},
});

/** Every channel in the navigation, and the open one's pages under it. */
export const Navigation = meta.story({
	render: () => <StoryApp path={`${channels}/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		const nav = await canvas.findByRole("navigation", { name: "Settings" });
		await expect(await within(nav).findByRole("button", { name: "Revenue" })).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		await expect(await within(nav).findByRole("link", { name: /^Bots/ })).toBeInTheDocument();
		await expect(within(nav).getByRole("button", { name: "New channel" })).toBeInTheDocument();
	},
});

/** A channel's General: its name and colour, and deleting it. */
export const General = meta.story({
	render: () => <StoryApp path={`${channels}/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "Revenue" })).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Delete channel" })).toBeInTheDocument();
	},
});

/** The apps a bot is connected to, each with what its tools may do. */
export const Connections = meta.story({
	render: () => <StoryApp path={growthDeskConnections} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "Connections" })).toBeInTheDocument();
		await expect(await canvas.findByRole("article", { name: "HubSpot" })).toBeInTheDocument();
		await expect(canvas.getByRole("article", { name: "Gmail" })).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Add connection" })).toBeInTheDocument();
	},
});

/**
 * Who can see into the channel. Administrators are in every channel, so only
 * Mara, a member, can be taken out, and you cannot leave.
 */
export const People = meta.story({
	render: () => <StoryApp path={revenuePage("people")} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "People" })).toBeInTheDocument();
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

/** The channel's bots, each with what it does, and New bot. */
export const Bots = meta.story({
	render: () => <StoryApp path={revenuePage("bots")} />,
	play: async ({ canvas }) => {
		const page = await canvas.findByRole("main");
		await expect(await within(page).findByRole("heading", { name: "Bots" })).toBeInTheDocument();
		await expect(
			await within(page).findByRole("link", { name: /^Growth Desk/ }),
		).toBeInTheDocument();
		await expect(within(page).getByRole("button", { name: "New bot" })).toBeInTheDocument();
	},
});

/** A member reads the channel's people, without the controls only an administrator has, and can leave it. */
export const AsAMember = meta.story({
	beforeEach({ msw }) {
		// A channel carries what its viewer may do there; a member may not rename, delete or manage it.
		const asMember = storyChannels.map((channel) => ({
			...channel,
			permissions: {
				...channel.permissions,
				rename: false,
				manageMembers: false,
				manageBots: false,
				delete: false,
				leave: true,
			},
		}));
		msw.use(...revenueHandlers, ...appHandlers({ role: "member", channels: asMember }));
	},
	render: () => <StoryApp path={revenuePage("people")} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "People" })).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Add people" })).toBeNull();
		await expect(await canvas.findByRole("button", { name: "Leave Revenue" })).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Remove Mara Kent" })).toBeNull();
	},
});

/** A member's General for the same channel: nothing to rename and no Delete channel. */
export const GeneralAsAMember = meta.story({
	beforeEach: AsAMember.input.beforeEach,
	render: () => <StoryApp path={`${channels}/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "Revenue" })).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Delete channel" })).toBeNull();
		await expect(canvas.queryByRole("textbox", { name: "Name" })).toBeNull();
	},
});
/** On a phone a channel's page opens full screen, with the way back to the channel's page in You. */
/** On a phone a channel's page opens full screen, with the way back to the list of settings. */
export const Phone = meta.story({
	globals: PHONE,
	render: () => <StoryApp path={`${channels}/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("link", { name: revenue.name })).toHaveAttribute(
			"href",
			`/${storyWorkspace.slug}/you/channels/${revenue.slug}`,
		);
		await expect(await canvas.findByRole("heading", { name: "Revenue" })).toBeInTheDocument();
	},
});
