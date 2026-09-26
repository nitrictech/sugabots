import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpResponse, http } from "msw";
import { type ReactNode, useEffect, useState } from "react";
// A dialog is portalled to the body, so reaching it means `screen` rather
// than the story's own canvas.
import { expect, screen, within } from "storybook/test";
import preview from "#storybook/preview";
import {
	accountManager,
	engineering,
	growthDesk,
	leadResearcher,
	linearHandler,
	oncall,
	personal,
	revenue,
} from "@/shell/story-fixtures.ts";
import { WorkspaceMembersSettings } from "./WorkspaceMembersSettings.tsx";

const workspace = {
	id: "0199a3a0-0000-7000-8000-000000000001",
	name: "Nitric",
	slug: "nitric",
	createdAt: "2026-09-01T00:00:00.000Z",
};

function person(n: number, name: string, email: string, role: string) {
	const userId = `0199a3a0-0000-7000-8000-0000000000${String(n).padStart(2, "0")}`;
	return {
		id: `0199a3a0-0000-7000-8000-0000000000d${n}`,
		organizationId: workspace.id,
		userId,
		role,
		createdAt: `2026-09-0${n}T00:00:00.000Z`,
		user: { id: userId, name, email },
	};
}

const ryan = person(1, "Ryan Eyes", "ryan@nitric.io", "admin");
const jay = person(2, "Jay Young", "jay@nitric.io", "admin");
const mara = person(3, "Mara Kent", "mara@nitric.io", "member");
const sam = person(4, "Sam Park", "sam@nitric.io", "viewer");

const inPod = (member: typeof ryan) => ({
	userId: member.userId,
	name: member.user.name,
	email: member.user.email,
	image: null,
	addedAt: member.createdAt,
});

/** Somebody asked and not yet arrived. Half a day from now, so the copy reads the same whenever it runs. */
const alex = {
	id: "0199a3a0-0000-7000-8000-0000000000e1",
	email: "alex@nitric.io",
	role: "member",
	status: "pending",
	organizationId: workspace.id,
	inviterId: ryan.userId,
	expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
};

const auth = `${import.meta.env.VITE_API_URL}/auth/organization`;

/** better-auth's refusal shape, which the SDK turns into this product's words. */
const refuses = (code: string, message: string) =>
	HttpResponse.json({ code, message }, { status: 400 });

function SettingsPreview({ children }: { children: ReactNode }) {
	const [queryClient] = useState(() => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		// What a member's page reads besides the roster: the pods, their bots and who is in each.
		client.setQueryData(["workspaces"], [workspace]);
		client.setQueryData(["pods", workspace.id], [revenue, engineering, personal]);
		client.setQueryData(
			["agents", workspace.id],
			[growthDesk, accountManager, leadResearcher, linearHandler, oncall],
		);
		client.setQueryData(["pod-members", revenue.id], [inPod(ryan), inPod(jay), inPod(mara)]);
		client.setQueryData(["pod-members", engineering.id], [inPod(ryan), inPod(sam)]);
		return client;
	});
	useEffect(() => () => queryClient.clear(), [queryClient]);
	return (
		<QueryClientProvider client={queryClient}>
			<div className="flex min-h-screen flex-col bg-background">{children}</div>
		</QueryClientProvider>
	);
}

const meta = preview.meta({
	title: "Views/WorkspaceMembersSettings",
	component: WorkspaceMembersSettings,
	tags: ["ai-generated"],
	args: { workspaceId: workspace.id, canManage: true, currentUserId: ryan.userId },
	parameters: {
		layout: "fullscreen",
		// Inline docs examples share MSW handlers; separate frames keep their responses independent.
		docs: { story: { inline: false, height: "720px" } },
	},
	decorators: [
		(Story, context) => (
			<SettingsPreview key={context.id}>
				<Story />
			</SettingsPreview>
		),
	],
	beforeEach({ msw }) {
		msw.use(
			http.get(`${auth}/list-members`, () =>
				HttpResponse.json({ members: [ryan, jay, mara, sam], total: 4 }),
			),
			http.get(`${auth}/list-invitations`, () => HttpResponse.json([alex])),
			http.post(`${auth}/update-member-role`, () =>
				refuses("PREVIEW", "This preview does not save role changes."),
			),
			http.post(`${auth}/remove-member`, () =>
				refuses("PREVIEW", "This preview does not remove anybody."),
			),
			http.post(`${auth}/invite-member`, () =>
				refuses("PREVIEW", "This preview does not send invitations."),
			),
		);
	},
});

/** Everybody with their role, you as You, and the invitation still out below them. */
export const Managing = meta.story({
	play: async ({ canvas }) => {
		const mara = await canvas.findByRole("link", { name: /Mara Kent/ });
		await expect(mara).toHaveTextContent("Member");
		await expect(canvas.getByRole("link", { name: /Ryan Eyes/ })).toHaveTextContent("You");
		// People and invitations are two requests, so the invitation is awaited.
		await expect(await canvas.findByText("alex@nitric.io")).toBeInTheDocument();
		await expect(canvas.getByText("Expires within a day")).toBeInTheDocument();
		await expect(canvas.getByRole("button", { name: "Resend" })).toBeInTheDocument();
	},
});

/** Addresses in one field, and the role described as it is picked. */
export const Inviting = meta.story({
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Invite people" }));
		const dialog = await screen.findByRole("dialog", { name: "Invite people" });

		await expect(within(dialog).getByLabelText("Email addresses")).toBeInTheDocument();
		await expect(
			within(dialog).getByText("Builds agents in the pods they are added to."),
		).toBeInTheDocument();
		await expect(within(dialog).getByRole("button", { name: "Send" })).toBeDisabled();
	},
});

/** Somebody else's page: their role, the pods they are in, when they joined, and removing them. */
export const Person = meta.story({
	args: { selectedMemberId: mara.id },
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "Mara Kent" })).toBeInTheDocument();
		await expect(canvas.getByRole("radio", { name: "Member" })).toBeChecked();
		await expect(canvas.getByRole("switch", { name: "Mara Kent is in Revenue" })).toHaveAttribute(
			"aria-checked",
			"true",
		);
		await expect(
			canvas.getByRole("switch", { name: "Mara Kent is in Engineering" }),
		).toHaveAttribute("aria-checked", "false");
		await expect(canvas.getByRole("button", { name: "Remove from workspace" })).toBeInTheDocument();
	},
});

/** Your own page: your role stated rather than chosen, and leaving in place of removing. */
export const You = meta.story({
	args: { selectedMemberId: ryan.id },
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "Ryan Eyes" })).toBeInTheDocument();
		await expect(canvas.queryByRole("radio", { name: "Member" })).toBeNull();
		await expect(canvas.getByRole("button", { name: "Leave workspace" })).toBeInTheDocument();
	},
});

/** Leaving says what it costs before it happens. */
export const Leaving = meta.story({
	args: { selectedMemberId: ryan.id },
	play: async ({ canvas, userEvent }) => {
		await userEvent.click(await canvas.findByRole("button", { name: "Leave workspace" }));

		const dialog = await screen.findByRole("dialog");
		await expect(dialog).toHaveTextContent("somebody inviting you again");
	},
});

/** Reading is everybody else: the same pages, stated rather than editable. */
export const Reading = meta.story({
	args: { canManage: false, currentUserId: mara.userId, selectedMemberId: sam.id },
	play: async ({ canvas }) => {
		await expect(await canvas.findByRole("heading", { name: "Sam Park" })).toBeInTheDocument();
		await expect(canvas.getByText("Viewer")).toBeInTheDocument();
		await expect(canvas.queryByRole("radio", { name: "Viewer" })).toBeNull();
		await expect(canvas.getByRole("switch", { name: "Sam Park is in Engineering" })).toBeDisabled();
		await expect(canvas.queryByRole("button", { name: "Remove from workspace" })).toBeNull();
	},
});
