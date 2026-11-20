import type { ProjectThread } from "@sugabots/contracts";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseWorkspace } from "@/lib/workspace.ts";
import { apiAnswers, listedThread, mount, onWideScreen, projects, workspace } from "@/test-api.tsx";
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
	const thread: ProjectThread = {
		kind: "project_thread",
		id: "0199a3a0-0000-7000-8000-0000000000e1",
		workspaceId: workspace.id,
		projectId: project.id,
		botId: null,
		title: "Pricing page",
		archivedAt: null,
		doneAt: null,
		createdAt: "2026-09-18T08:00:00.000Z",
		updatedAt: "2026-09-18T08:00:00.000Z",
	};

	it("moves a thread marked done under Done", async () => {
		onWideScreen();
		let doneAt: string | null = null;
		client.api.chats.threads.mockImplementation(() =>
			Effect.succeed({ threads: [listedThread({ ...thread, doneAt })], automations: [] }),
		);
		client.api.chats.markDone.mockImplementation(() => {
			doneAt = "2026-09-19T08:00:00.000Z";
			return Effect.succeed(undefined);
		});
		mount(`/suga/projects/${project.slug}/files`);

		const work = await screen.findByRole("region", { name: "Threads" });
		fireEvent.click(await within(work).findByRole("button", { name: `Done: ${thread.title}` }));

		const done = await screen.findByRole("region", { name: "Done" });
		expect(within(done).getByRole("button", { name: `Reopen: ${thread.title}` })).toBeDefined();
		// Threads holds only what is still open, so with none it is gone.
		const threads = screen.queryByRole("region", { name: "Threads" });
		expect(
			threads && within(threads).queryByRole("link", { name: new RegExp(thread.title) }),
		).toBeFalsy();
	});

	it("says what each thread's bots are doing: working, waiting on an approval, or done unread", async () => {
		onWideScreen();
		const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
		const titled = (title: string, suffix: string) => ({
			...thread,
			id: `0199a3a0-0000-7000-8000-0000000000${suffix}`,
			title,
		});
		client.api.chats.threads.mockImplementation(() =>
			Effect.succeed({
				threads: [
					listedThread(titled("Deploy", "f1"), {
						activity: { kind: "working", since: minutesAgo(20) },
					}),
					listedThread(titled("Refund", "f2"), {
						activity: { kind: "waiting", since: minutesAgo(2) },
					}),
					listedThread(titled("Report", "f3"), {
						activity: { kind: "finished", at: minutesAgo(1) },
					}),
					listedThread(titled("Lunch", "f4")),
				],
				automations: [],
			}),
		);
		mount(`/suga/projects/${project.slug}/files`);

		const work = await screen.findByRole("region", { name: "Threads" });
		const row = async (title: string) =>
			within(work).findByRole("link", { name: new RegExp(`^${title}`) });
		expect((await row("Deploy")).textContent).toContain("Working 20m");
		expect((await row("Refund")).textContent).toContain("Waiting 2m");
		expect((await row("Report")).textContent).toContain("Done");
		const quiet = (await row("Lunch")).textContent;
		expect(quiet).not.toMatch(/Working|Waiting|Done/);
	});
});
