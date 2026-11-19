import type { ProjectThread } from "@sugabots/contracts";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseWorkspace } from "@/lib/workspace.ts";
import {
	apiAnswers,
	listedThread,
	mount,
	onWideScreen,
	projects,
	sam,
	workspace,
} from "@/test-api.tsx";
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
		client.api.chats.list.mockImplementation(() =>
			Effect.succeed({ chats: [listedThread({ ...thread, doneAt })] }),
		);
		client.api.chats.markDone.mockImplementation(() => {
			doneAt = "2026-09-19T08:00:00.000Z";
			return Effect.succeed(undefined);
		});
		mount(`/suga/projects/${project.slug}/files`, sam);

		const work = await screen.findByRole("list", { name: `${project.name}'s work` });
		fireEvent.click(await within(work).findByRole("button", { name: `Done: ${thread.title}` }));

		expect(await screen.findByRole("button", { name: `Reopen: ${thread.title}` })).toBeDefined();
		expect(within(work).queryByRole("link", { name: new RegExp(thread.title) })).toBeNull();
	});
});
