import { HttpResponse, http } from "msw";
import { expect, within } from "storybook/test";
import preview from "#storybook/preview";
import { revenue } from "@/shell/story-fixtures.ts";
import { appHandlers, StoryApp, storyProjects, storyUser, storyWorkspace } from "../story-app.tsx";

/*
 * A project in settings, listed in the navigation with its pages: General,
 * its people, its bots and its computer. On a phone a project's page
 * opens full screen, with the way back to the list of settings.
 */

const API = import.meta.env.VITE_API_URL as string;
const projects = `/${storyWorkspace.slug}/settings/projects`;
const revenuePage = (page: "people" | "bots") => `${projects}/${revenue.slug}/${page}`;
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
	// The first two are administrators, as the workspace roster below says.
	removable: index > 1,
}));

/** The Revenue project's people, which the example workspace has none of by default. */
const revenueHandlers = [
	// The project's people are the workspace's too, with the roles the project's rows show.
	http.get(`${API}/workspaces/:workspace/members`, () =>
		HttpResponse.json(
			people.map((person, index) => ({
				id: `0199a3a0-0000-7000-8000-0000000007${index}0`,
				role: index === 0 ? "admin" : index === 1 ? "admin" : "member",
				user: { id: person.userId, name: person.name, email: person.email, image: null },
				joinedAt: "2026-09-02T00:00:00.000Z",
			})),
		),
	),
	http.get(`${API}/projects/:projectId/members`, ({ params }) =>
		HttpResponse.json(params.projectId === revenue.id ? people : people.slice(0, 1)),
	),
];

/** The projects, with Revenue counting the people its members list answers with. */
const projectsWithPeople = storyProjects.map((project) =>
	project.id === revenue.id ? { ...project, memberCount: people.length } : project,
);

const meta = preview.meta({
	title: "Views/Projects",
	tags: ["ai-generated"],
	parameters: { layout: "fullscreen" },
	beforeEach({ msw }) {
		msw.use(...revenueHandlers, ...appHandlers({ projects: projectsWithPeople }));
	},
});

/** Every project in the navigation, and the open one's pages under it. */
export const Navigation = meta.story({
	render: () => <StoryApp path={`${projects}/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		const nav = await canvas.findByRole("navigation", { name: "Settings" });
		await expect(await within(nav).findByRole("button", { name: "Revenue" })).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		await expect(await within(nav).findByRole("link", { name: /^Bots/ })).toBeInTheDocument();
		await expect(within(nav).getByRole("button", { name: "New project" })).toBeInTheDocument();
	},
});

/** A project's General: its name and colour, and deleting it. */
export const General = meta.story({
	render: () => <StoryApp path={`${projects}/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "Revenue" })).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Delete project" })).toBeInTheDocument();
	},
});

/**
 * Who can see into the project. Administrators are in every project, so only
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

/** The project's bots, each with what it does, and Add bot. */
export const Bots = meta.story({
	render: () => <StoryApp path={revenuePage("bots")} />,
	play: async ({ canvas }) => {
		const page = await canvas.findByRole("main");
		await expect(await within(page).findByRole("heading", { name: "Bots" })).toBeInTheDocument();
		await expect(
			await within(page).findByRole("link", { name: /^Growth Desk/ }),
		).toBeInTheDocument();
		await expect(within(page).getByRole("button", { name: "Add bot" })).toBeInTheDocument();
	},
});

/** A member reads the project's people, without the controls only an administrator has, and can leave it. */
export const AsAMember = meta.story({
	beforeEach({ msw }) {
		// A project carries what its viewer may do there; a member may not rename, delete or manage it.
		const asMember = projectsWithPeople.map((project) => ({
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
		msw.use(...revenueHandlers, ...appHandlers({ role: "member", projects: asMember }));
	},
	render: () => <StoryApp path={revenuePage("people")} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "People" })).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Add people" })).toBeNull();
		await expect(await canvas.findByRole("button", { name: "Leave Revenue" })).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Remove Mara Kent" })).toBeNull();
	},
});

/** A member's General for the same project: nothing to rename and no Delete project. */
export const GeneralAsAMember = meta.story({
	beforeEach: AsAMember.input.beforeEach,
	render: () => <StoryApp path={`${projects}/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "Revenue" })).toBeInTheDocument();
		await expect(canvas.queryByRole("button", { name: "Delete project" })).toBeNull();
		await expect(canvas.queryByRole("textbox", { name: "Name" })).toBeNull();
	},
});

/** On a phone a project's page opens full screen, with the way back to Settings in You. */
export const Phone = meta.story({
	globals: PHONE,
	render: () => <StoryApp path={`${projects}/${revenue.slug}`} />,
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("link", { name: "Settings" })).toHaveAttribute(
			"href",
			`/${storyWorkspace.slug}/you`,
		);
		await expect(await canvas.findByRole("heading", { name: "Revenue" })).toBeInTheDocument();
	},
});
