import type { ProjectChat } from "@sugabots/contracts";
import { listedChat } from "@sugabots/contracts/testing";
import { fireEvent, screen, within } from "@testing-library/react";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiAnswers, mount, onWideScreen, projects, workspace } from "@/api.test-support.tsx";
import { client } from "@/client.test-support.ts";
import { chooseWorkspace } from "@/lib/workspace.ts";

vi.mock("@/api.ts", () => import("@/client.test-support.ts"));

beforeEach(() => {
	apiAnswers();
	localStorage.clear();
	chooseWorkspace(workspace.id);
});

describe("a project's own sidebar", () => {
	const project = projects[0] as (typeof projects)[number];
	const chat: ProjectChat = {
		kind: "project_chat",
		id: "0199a3a0-0000-7000-8000-0000000000e1",
		workspaceId: workspace.id,
		projectId: project.id,
		botId: null,
		title: "Pricing page",
		resolvedAt: null,
		createdAt: "2026-09-18T08:00:00.000Z",
		updatedAt: "2026-09-18T08:00:00.000Z",
	};

	it("moves a chat marked resolved under Resolved, which opens to show it", async () => {
		onWideScreen();
		let resolvedAt: string | null = null;
		client.api.chats.projectChats.mockImplementation(() =>
			Effect.succeed({ chats: [listedChat({ ...chat, resolvedAt })], automations: [] }),
		);
		client.api.chats.setResolved.mockImplementation(() => {
			resolvedAt = "2026-09-19T08:00:00.000Z";
			return Effect.succeed(undefined);
		});
		mount(`/suga/projects/${project.slug}/files`);

		const work = await screen.findByRole("region", { name: "Chats" });
		fireEvent.click(await within(work).findByRole("button", { name: `Resolve: ${chat.title}` }));

		fireEvent.click(await screen.findByRole("button", { name: /^Resolved\s*1$/, expanded: false }));
		const resolved = await screen.findByRole("region", { name: "Resolved" });
		within(resolved).getByRole("button", { name: `Reopen: ${chat.title}` });
		// Chats holds only what is still open, so with none it is gone.
		const chats = screen.queryByRole("region", { name: "Chats" });
		expect(
			chats && within(chats).queryByRole("link", { name: new RegExp(chat.title) }),
		).toBeFalsy();
	});

	it("says what each chat's bots are doing: working, waiting on an approval, needing you, or replied unread", async () => {
		onWideScreen();
		const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
		const titled = (title: string, suffix: string) => ({
			...chat,
			id: `0199a3a0-0000-7000-8000-0000000000${suffix}`,
			title,
		});
		client.api.chats.projectChats.mockImplementation(() =>
			Effect.succeed({
				chats: [
					listedChat(titled("Deploy", "f1"), {
						status: { kind: "working", since: minutesAgo(20) },
					}),
					listedChat(titled("Refund", "f2"), {
						status: { kind: "waiting", since: minutesAgo(2) },
					}),
					listedChat(titled("Report", "f3"), {
						status: { kind: "replied", at: minutesAgo(1) },
					}),
					listedChat(titled("Invoice", "f5"), {
						needsApproval: true,
						status: { kind: "waiting", since: minutesAgo(3) },
					}),
					listedChat(titled("Launch", "f6"), {
						mentionsYou: true,
						status: { kind: "working", since: minutesAgo(1) },
					}),
					listedChat(titled("Lunch", "f4")),
				],
				automations: [],
			}),
		);
		mount(`/suga/projects/${project.slug}/files`);

		const work = await screen.findByRole("region", { name: "Chats" });
		const row = async (title: string) =>
			within(work).findByRole("link", { name: new RegExp(`^${title}`) });
		expect((await row("Deploy")).textContent).toContain("Working 20m");
		expect((await row("Refund")).textContent).toContain("Waiting 2m");
		expect((await row("Report")).textContent).toContain("Replied");
		// Waiting on the viewer, a chat stays among the rest and says so in Working's place.
		expect((await row("Invoice")).textContent).toContain("Needs you to approve");
		expect((await row("Invoice")).textContent).not.toContain("Waiting");
		expect((await row("Launch")).textContent).toContain("Needs you to reply");
		expect((await row("Launch")).textContent).not.toContain("Working");
		const quiet = (await row("Lunch")).textContent;
		expect(quiet).not.toMatch(/Working|Waiting|Replied/);
	});
});
