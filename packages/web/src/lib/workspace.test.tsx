import { testPerson } from "@sugabots/contracts/testing";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePeopleReachingProject } from "@/lib/projects.ts";
import { createQueryClient } from "@/lib/query.ts";
import { useChangeRole } from "@/lib/workspace.ts";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

const workspaceId = "0199a3a0-0000-7000-8000-0000000009a1";
const projectId = "0199a3a0-0000-7000-8000-0000000009a2";
const juno = testPerson({ id: "0199a3a0-0000-7000-8000-0000000009a3", name: "Juno Park" });

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("changing what somebody may do", () => {
	it("refreshes who reaches a project after a workspace role change", async () => {
		client.api.projects.listPeople.mockReturnValue(Effect.succeed([]));
		client.api.workspaces.changeRole.mockReturnValue(Effect.succeed(undefined));
		const queries = createQueryClient();
		const { result } = renderHook(
			() => ({
				people: usePeopleReachingProject(projectId),
				changeRole: useChangeRole(workspaceId),
			}),
			{
				wrapper: ({ children }: { children: ReactNode }) => (
					<QueryClientProvider client={queries}>{children}</QueryClientProvider>
				),
			},
		);
		await waitFor(() => expect(result.current.people.isSuccess).toBe(true));
		client.api.projects.listPeople.mockReturnValue(Effect.succeed([juno]));

		await act(() =>
			result.current.changeRole.mutateAsync({ membershipId: juno.id, role: "admin" }),
		);

		await waitFor(() => expect(result.current.people.data).toEqual([juno]));
	});
});
