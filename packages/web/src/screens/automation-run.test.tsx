import type { BotParticipant, Run } from "@sugabots/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createQueryClient } from "@/lib/query.ts";
import { apiAnswers, bots, projects } from "@/test-api.tsx";
import { client } from "@/test-client.ts";
import { TooltipProvider } from "@/ui/tooltip.tsx";
import { FailedRunMessage } from "./AutomationRun.tsx";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const project = projects[1];
const lead = bots.find((bot) => bot.id === project?.leadBotId);
if (!project || !lead) throw new Error("fixture");
const { id: projectId, slug: projectSlug } = project;

const host: BotParticipant = {
	kind: "bot",
	id: lead.id,
	name: lead.name,
	handle: lead.handle,
	color: lead.color,
	face: lead.face,
	shape: lead.shape,
};

/** A failed run of an automation of `project`, which its lead bot ran. */
const failedRun: Run = {
	id: "0199a3a0-0000-7000-8000-0000000000e5",
	automationId: "0199a3a0-0000-7000-8000-0000000000e6",
	workspaceId: project.workspaceId,
	botId: lead.id,
	conversationId: "0199a3a0-0000-7000-8000-0000000000e7",
	rootConversationId: "0199a3a0-0000-7000-8000-0000000000e8",
	automationName: "Pipeline check",
	instructions: "Check the pipeline.",
	trigger: {
		kind: "routine",
		scheduledAt: "2026-09-18T08:00:00.000Z",
		acceptedAt: "2026-09-18T08:00:00.000Z",
	},
	state: "failed",
	error: "The connection refused the request.",
	posted: false,
	acceptedAt: "2026-09-18T08:00:00.000Z",
	startedAt: "2026-09-18T08:00:01.000Z",
	finishedAt: "2026-09-18T08:00:30.000Z",
};

beforeEach(() => {
	apiAnswers();
	client.api.automations.runs.mockReturnValue(
		Effect.succeed({ items: [failedRun], nextCursor: null }),
	);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

/** `FailedRunMessage` for `failedRun`, alone in the workspace's pages. */
function mountFailedRun() {
	const root = createRootRoute();
	const workspacePage = createRoute({
		getParentRoute: () => root,
		path: "/$workspace",
		component: () => <FailedRunMessage run={failedRun} projectId={projectId} bot={host} />,
	});
	const router = createRouter({
		routeTree: root.addChildren([workspacePage]),
		history: createMemoryHistory({ initialEntries: ["/suga"] }),
	});
	render(
		<QueryClientProvider client={createQueryClient()}>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</QueryClientProvider>,
	);
}

it("sends a project's failed run to the project's connections, not its lead bot's", async () => {
	mountFailedRun();

	const fix = await screen.findByRole("link", { name: "Fix connection" });
	expect(fix.getAttribute("href")).toBe(`/suga/settings/projects/${projectSlug}/connections`);
});
