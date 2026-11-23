import type { ProjectChat } from "@sugabots/contracts";
import { listedChat } from "@sugabots/contracts/testing";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseWorkspace } from "@/lib/workspace.ts";
import { apiAnswers, mount, onWideScreen, projects, workspace } from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

beforeEach(() => {
	apiAnswers();
	localStorage.clear();
	chooseWorkspace(workspace.id);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
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
		client.api.chats.markResolved.mockImplementation(() => {
			resolvedAt = "2026-09-19T08:00:00.000Z";
			return Effect.succeed(undefined);
		});
		mount(`/suga/projects/${project.slug}/files`);

		const work = await screen.findByRole("region", { name: "Chats" });
		fireEvent.click(await within(work).findByRole("button", { name: `Resolve: ${chat.title}` }));

		fireEvent.click(await screen.findByRole("button", { name: /^Resolved\s*1$/, expanded: false }));
		const resolved = await screen.findByRole("region", { name: "Resolved" });
		expect(within(resolved).getByRole("button", { name: `Reopen: ${chat.title}` })).toBeDefined();
		// Chats holds only what is still open, so with none it is gone.
		const chats = screen.queryByRole("region", { name: "Chats" });
		expect(
			chats && within(chats).queryByRole("link", { name: new RegExp(chat.title) }),
		).toBeFalsy();
	});

	it("says what each chat's bots are doing: working, waiting on an approval, or replied unread", async () => {
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
		const quiet = (await row("Lunch")).textContent;
		expect(quiet).not.toMatch(/Working|Waiting|Replied/);
	});
});
