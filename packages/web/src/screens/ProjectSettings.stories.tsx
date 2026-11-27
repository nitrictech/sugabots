import { HttpResponse, http } from "msw";
import { expect, within } from "storybook/test";
import preview from "#storybook/preview";
import { revenue } from "@/shell/story-fixtures.test-support.ts";
import {
	appHandlers,
	StoryApp,
	storyMember,
	storyProjects,
	storyWorkspace,
} from "../story-app.test-support.tsx";

/*
 * A project's settings, a page of its own beside its chats, with its members
 * and its bots each a page under it. On a phone each opens full screen, with
 * the way back to the project, or from its members or bots back to its settings.
 */

const API = import.meta.env.VITE_API_URL as string;
const revenueSettings = `/${storyWorkspace.slug}/projects/${revenue.slug}/settings`;
const revenuePage = (page: "members" | "bots") => `${revenueSettings}/${page}`;
const PHONE = { viewport: { value: "iphone12", isRotated: false } };

const members = [
	{ memberId: storyMember.id, name: storyMember.name, email: storyMember.email, image: null },
	{
		memberId: "0199a3a0-0000-7000-8000-000000000012",
		name: "Jay Young",
		email: "jay@nitric.io",
		image: null,
	},
	{
		memberId: "0199a3a0-0000-7000-8000-000000000013",
		name: "Mara Kent",
		email: "mara@nitric.io",
		image: null,
	},
].map((member, index) => ({
	...member,
	// The first two are administrators, as the workspace roster below says.
	removable: index > 1,
}));

/** The Revenue project's members, which the example workspace has none of by default. */
const revenueHandlers = [
	// The project's members are the workspace's too, with the roles the project's rows show.
	http.get(`${API}/workspaces/:workspace/memberships`, () =>
		HttpResponse.json(
			members.map((member, index) => ({
				id: `0199a3a0-0000-7000-8000-0000000007${index}0`,
				role: index === 0 ? "admin" : index === 1 ? "admin" : "editor",
				member: { id: member.memberId, name: member.name, email: member.email, image: null },
				joinedAt: "2026-09-02T00:00:00.000Z",
			})),
		),
	),
	http.get(`${API}/projects/:projectId/members`, ({ params }) =>
		HttpResponse.json(params.projectId === revenue.id ? members : members.slice(0, 1)),
	),
];

/** The projects, with Revenue counting the members its members list answers with. */
const projectsWithMembers = storyProjects.map((project) =>
	project.id === revenue.id ? { ...project, memberCount: members.length } : project,
);

const meta = preview.meta({
	title: "Views/Project settings",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(...revenueHandlers, ...appHandlers({ projects: projectsWithMembers }));
	},
});

/** A project's settings, picked out among its pages beside its chats: its name and colour, its members and bots, and deleting it. */
export const General = meta.story({
	render: () => <StoryApp path={revenueSettings} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "Revenue" })).toBeInTheDocument();
		const pages = await canvas.findByRole("navigation", { name: "Revenue's pages" });
		await expect(within(pages).getByRole("link", { name: "Settings" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		await expect(canvas.getByRole("link", { name: /^Members/ })).toHaveAttribute(
			"href",
			revenuePage("members"),
		);
		await expect(canvas.getByRole("button", { name: "Delete project" })).toBeInTheDocument();
	},
});

/**
 * Who can see into the project. Administrators are in every project, so only
 * Mara, an editor, can be taken out, and you cannot leave.
 */
export const Members = meta.story({
	render: () => <StoryApp path={revenuePage("members")} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "Members" })).toBeInTheDocument();
		await expect(await canvas.findByText("Jay Young")).toBeInTheDocument();
		await expect(await canvas.findByText("Admin")).toBeInTheDocument();
		await expect(
			await canvas.findByRole("button", { name: "Remove Mara Kent" }),
		).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Remove Jay Young" })).toBeNull();
		await expect(canvas.queryByRole("button", { name: "Leave Revenue" })).toBeNull();
		await expect(canvas.getByRole("button", { name: "Add members" })).toBeInTheDocument();
	},
});

/** The project's bots, each with what it does, and Add bot. */
export const Bots = meta.story({
	render: () => <StoryApp path={revenuePage("bots")} />,
	play: async ({ canvas }) => {
		const page = await canvas.findByRole("region", { name: `${revenue.name}'s bots` });
		await expect(within(page).getByRole("heading", { level: 1, name: "Bots" })).toBeVisible();
		await expect(
			await within(page).findByRole("link", { name: /^Growth Desk/ }),
		).toBeInTheDocument();
		await expect(within(page).getByRole("button", { name: "Add bot" })).toBeInTheDocument();
	},
});

/** An editor reads the project's members, without the controls only an administrator has, and can leave it. */
export const AsAnEditor = meta.story({
	beforeEach({ msw }) {
		// A project carries what its viewer may do there; an editor may not rename, delete or manage it.
		const asEditor = projectsWithMembers.map((project) => ({
			...project,
			permissions: {
				...project.permissions,
				rename: false,
				manageMembers: false,
				manageBots: false,
				delete: false,
				leave: true,
			},
		}));
		msw.use(...revenueHandlers, ...appHandlers({ role: "editor", projects: asEditor }));
	},
	render: () => <StoryApp path={revenuePage("members")} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "Members" })).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Add members" })).toBeNull();
		await expect(await canvas.findByRole("button", { name: "Leave Revenue" })).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Remove Mara Kent" })).toBeNull();
	},
});

/** An editor's General for the same project: nothing to rename and no Delete project. */
export const GeneralAsAnEditor = meta.story({
	beforeEach: AsAnEditor.input.beforeEach,
	render: () => <StoryApp path={revenueSettings} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "Revenue" })).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Delete project" })).toBeNull();
		await expect(canvas.queryByRole("textbox", { name: "Name" })).toBeNull();
	},
});

/** On a phone a project's settings open full screen, with the way back to the project. */
export const Phone = meta.story({
	globals: PHONE,
	render: () => <StoryApp path={revenueSettings} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("link", { name: "Back to Revenue" })).toHaveAttribute(
			"href",
			`/${storyWorkspace.slug}/projects/${revenue.slug}`,
		);
		await expect(await canvas.findByRole("heading", { name: "Revenue" })).toBeInTheDocument();
	},
});

/** On a phone a project's members, under its settings, have the way back to its settings. */
export const MembersOnAPhone = meta.story({
	globals: PHONE,
	render: () => <StoryApp path={revenuePage("members")} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("link", { name: "Back to Settings" })).toHaveAttribute(
			"href",
			revenueSettings,
		);
		await expect(await canvas.findByRole("heading", { name: "Members" })).toBeInTheDocument();
	},
});
