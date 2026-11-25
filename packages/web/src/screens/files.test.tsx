import type { WrittenFile } from "@sugabots/contracts";
import { fireEvent, screen } from "@testing-library/react";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiAnswers, mount, projects } from "@/api.test-support.tsx";
import { client } from "@/client.test-support.ts";

vi.mock("@/api.ts", () => import("@/client.test-support.ts"));

const [teamProject, salesProject] = projects as [
	(typeof projects)[number],
	(typeof projects)[number],
];
const at = "2026-09-18T08:00:00.000Z";
/** A file Sales keeps, which the member may read. */
const salesPlan: WrittenFile = {
	id: "0199a3a0-0000-7000-8000-000000000f01",
	chatId: "0199a3a0-0000-7000-8000-000000000f02",
	kind: "markdown",
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

describe("a file opened by its address", () => {
	it("shows a file among its own project's files", async () => {
		mount(`/suga/projects/${salesProject.slug}/files/${salesPlan.id}`);

		await screen.findByRole("heading", { name: salesPlan.title });
	});

	it("loads the HTML from a webhook run only on request", async () => {
		const page: WrittenFile = {
			...salesPlan,
			kind: "html",
			outsideRun: "webhook",
			content: "<p>Sales figures</p>",
		};
		client.api.files.get.mockReturnValue(Effect.succeed(page));
		mount(`/suga/projects/${salesProject.slug}/files/${page.id}`);

		await screen.findByText("Written by a run started by a webhook.");
		expect(screen.queryByTitle(page.title)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Load page" }));
		expect(await screen.findByTitle(page.title)).toHaveProperty("tagName", "IFRAME");
		expect(screen.getByText("Written by a run started by a webhook.")).toBeTruthy();
	});

	it("is not shown under another project, whose link and Delete it is not", async () => {
		mount(`/suga/projects/${teamProject.slug}/files/${salesPlan.id}`);

		await screen.findByText("No such file here");
		expect(screen.queryByRole("heading", { name: salesPlan.title })).toBeNull();
	});
});
