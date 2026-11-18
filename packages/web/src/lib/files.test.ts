import type { ToolCallPart } from "@sugabots/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { refreshFilesAfter } from "./files.ts";

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

/** A cache holding a channel's list and one version of a file, both fresh. */
function cacheWithFiles() {
	const queries = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
	queries.setQueryData(["files", "channel"], []);
	queries.setQueryData(["files", "channel", "file", 2], {});
	const stale = () =>
		queries
			.getQueryCache()
			.findAll({ queryKey: ["files"] })
			.map((query) => query.isStale());
	return { queries, stale };
}

describe("refreshFilesAfter", () => {
	it("marks every file on screen stale once a write completes, versions included", () => {
		const { queries, stale } = cacheWithFiles();

		refreshFilesAfter(queries, call("file_edit", "completed"));

		expect(stale()).toEqual([true, true]);
	});

	it.each([
		{ case: "a write still running", toolCall: call("file_write", "running") },
		{ case: "a read", toolCall: call("file_read", "completed") },
	])("leaves them be after $case", ({ toolCall }) => {
		const { queries, stale } = cacheWithFiles();

		refreshFilesAfter(queries, toolCall);

		expect(stale()).toEqual([false, false]);
	});
});
