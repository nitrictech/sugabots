import type { ToolCallPart } from "@sugabots/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { refreshArtifactsAfter } from "./artifacts.ts";

const call = (tool: string, status: ToolCallPart["status"]): ToolCallPart => ({
	type: "tool_call",
	id: "0199a3a0-0000-7000-8000-000000000301",
	tool,
	input: {},
	output: null,
	status,
	error: null,
	mutating: true,
	atOffset: 0,
	startedAt: "2026-10-01T08:10:00.000Z",
	finishedAt: null,
});

/** A cache holding a pod's list and one version of an artifact, both fresh. */
function cacheWithArtifacts() {
	const queries = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
	queries.setQueryData(["artifacts", "pod"], []);
	queries.setQueryData(["artifacts", "pod", "artifact", 2], {});
	const stale = () =>
		queries
			.getQueryCache()
			.findAll({ queryKey: ["artifacts"] })
			.map((query) => query.isStale());
	return { queries, stale };
}

describe("refreshArtifactsAfter", () => {
	it("marks every artifact on screen stale once a write completes, versions included", () => {
		const { queries, stale } = cacheWithArtifacts();

		refreshArtifactsAfter(queries, call("artifact_edit", "completed"));

		expect(stale()).toEqual([true, true]);
	});

	it.each([
		{ case: "a write still running", toolCall: call("artifact_write", "running") },
		{ case: "a read", toolCall: call("artifact_read", "completed") },
	])("leaves them be after $case", ({ toolCall }) => {
		const { queries, stale } = cacheWithArtifacts();

		refreshArtifactsAfter(queries, toolCall);

		expect(stale()).toEqual([false, false]);
	});
});
