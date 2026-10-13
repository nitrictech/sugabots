import type { Artifact } from "@sugabots/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { Artifacts } from "../../../artifacts/artifacts.ts";
import { ARTIFACT_EDIT_TOOL, ARTIFACT_WRITE_TOOL, artifactTools } from "./tool.ts";

const by = { workspaceId: "workspace", podId: "pod", agentId: "agent", threadId: "thread" };

const page: Artifact = {
	id: "0199a3a0-0000-7000-8000-0000000000f2",
	podId: "pod",
	kind: "html",
	title: "Pipeline",
	version: 2,
	createdBy: null,
	createdAt: "2026-10-01T08:00:00.000Z",
	updatedAt: "2026-10-01T08:00:00.000Z",
	content: "<p>two</p>",
	shownVersion: { number: 2, author: null, createdAt: "2026-10-01T08:00:00.000Z" },
};

/** The artifact tools in a turn whose earlier calls returned `earlierOutputs`. */
function inTurn(earlierOutputs: unknown[] = []) {
	const authoring = {
		create: vi.fn(() => Effect.succeed({ ...page, version: 1 })),
		replace: vi.fn(() => Effect.succeed(page)),
		edit: vi.fn(() => Effect.succeed(page)),
	};
	const tools = artifactTools({
		by,
		turnId: "turn",
		calls: { completedOutputs: () => Effect.succeed(earlierOutputs as never[]) },
		authoring: authoring as unknown as Artifacts.AuthoringInterface,
		run: (effect) => Effect.runPromise(effect as Effect.Effect<never>),
	});
	const call = (name: string) => (input: Record<string, unknown>) => {
		const called = tools[name];
		const options = { toolCallId: "call", messages: [] } as unknown as Parameters<
			NonNullable<NonNullable<typeof called>["execute"]>
		>[1];
		return called?.execute?.(input, options);
	};
	return { authoring, write: call(ARTIFACT_WRITE_TOOL), edit: call(ARTIFACT_EDIT_TOOL) };
}

const writeTool = () => inTurn();

describe("artifact_write", () => {
	it("creates an artifact without an id, and writes a new version of one with its id", async () => {
		const { authoring, write } = writeTool();

		expect(await write({ kind: "html", title: "Pipeline", content: "<p>one</p>" })).toMatchObject({
			status: "written",
			version: 1,
		});
		expect(
			await write({ artifactId: page.id, baseVersion: 1, content: "<p>two</p>" }),
		).toMatchObject({ status: "written", version: 2 });
		expect(authoring.create).toHaveBeenCalledWith(by, {
			kind: "html",
			title: "Pipeline",
			content: "<p>one</p>",
		});
		expect(authoring.replace).toHaveBeenCalledWith(by, {
			artifactId: page.id,
			baseVersion: 1,
			content: "<p>two</p>",
			inPlace: false,
		});
	});

	it.each([
		{ case: "no id but a version", input: { baseVersion: 0 } },
		{ case: "an empty id", input: { artifactId: "", baseVersion: 0 } },
		{ case: "a placeholder id", input: { artifactId: "new", baseVersion: 1 } },
	])("creates an artifact given $case, as models that fill every field send", async ({ input }) => {
		const { authoring, write } = writeTool();

		await write({ kind: "html", title: "Pipeline", content: "<p>one</p>", ...input });

		expect(authoring.create).toHaveBeenCalled();
		expect(authoring.replace).not.toHaveBeenCalled();
	});

	it.each([
		{ case: "a new artifact without a kind", input: { title: "T" } },
		{ case: "a change without a version", input: { artifactId: page.id } },
	])("refuses $case, writing nothing", async ({ input }) => {
		const { authoring, write } = writeTool();

		expect(await write({ ...input, content: "x" })).toMatchObject({ status: "refused" });
		expect(authoring.create).not.toHaveBeenCalled();
		expect(authoring.replace).not.toHaveBeenCalled();
	});
});

describe("a reply's writes to one artifact", () => {
	const wroteVersion = (version: number) => ({
		status: "written",
		artifactId: page.id,
		kind: "html",
		title: "Pipeline",
		version,
	});

	it("go over the version the same reply wrote", async () => {
		const { authoring, write, edit } = inTurn([wroteVersion(2)]);

		await write({ artifactId: page.id, baseVersion: 2, content: "<p>three</p>" });
		await edit({ artifactId: page.id, baseVersion: 2, oldText: "three", newText: "four" });

		expect(authoring.replace).toHaveBeenCalledWith(by, expect.objectContaining({ inPlace: true }));
		expect(authoring.edit).toHaveBeenCalledWith(by, expect.objectContaining({ inPlace: true }));
	});

	it("add a version after one an earlier reply wrote", async () => {
		const { authoring, edit } = inTurn([wroteVersion(1)]);

		await edit({ artifactId: page.id, baseVersion: 2, oldText: "two", newText: "three" });

		expect(authoring.edit).toHaveBeenCalledWith(by, expect.objectContaining({ inPlace: false }));
	});
});
