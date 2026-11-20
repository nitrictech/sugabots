import type { WrittenFile } from "@sugabots/contracts";
import { cleanup, screen } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiAnswers, mount, projects } from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const [teamProject, salesProject] = projects as [
	(typeof projects)[number],
	(typeof projects)[number],
];
const at = "2026-09-18T08:00:00.000Z";
/** A file Sales keeps, which the person may read. */
const salesPlan: WrittenFile = {
	id: "0199a3a0-0000-7000-8000-000000000f01",
	conversationId: "0199a3a0-0000-7000-8000-000000000f02",
	kind: "document",
	title: "Sales plan",
	version: 1,
	createdBy: null,
	createdAt: at,
	updatedAt: at,
	content: "# Plan",
	shownVersion: { number: 1, author: null, createdAt: at },
};

beforeEach(() => {
	apiAnswers();
	client.api.files.listInProject.mockImplementation(
		({ params }: { params: { projectId: string } }) =>
			Effect.succeed(params.projectId === salesProject.id ? [salesPlan] : []),
	);
	client.api.files.get.mockReturnValue(Effect.succeed(salesPlan));
	client.api.files.versions.mockReturnValue(Effect.succeed([salesPlan.shownVersion]));
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("a file opened by its address", () => {
	it("shows a file among its own project's files", async () => {
		mount(`/suga/projects/${salesProject.slug}/files/${salesPlan.id}`);

		expect(await screen.findByRole("heading", { name: salesPlan.title })).toBeDefined();
	});

	it("is not shown under another project, whose link and Delete it is not", async () => {
		mount(`/suga/projects/${teamProject.slug}/files/${salesPlan.id}`);

		expect(await screen.findByText("No such file here")).toBeDefined();
		expect(screen.queryByRole("heading", { name: salesPlan.title })).toBeNull();
	});
});
