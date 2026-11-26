import { testMember } from "@sugabots/contracts/testing";
import { act, renderHook, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { juno, projects, sam } from "@/api.test-support.tsx";
import { client } from "@/client.test-support.ts";
import {
	useMembersReachingProject,
	usePlaceProjectMember,
	useProjectMembers,
} from "@/lib/projects.ts";
import { InRoute } from "@/lib/route.test-support.tsx";

vi.mock("@/api.ts", () => import("@/client.test-support.ts"));

const project = projects[0];
if (!project) throw new Error("The fixtures have no project");

const member = (someone: typeof sam) => ({
	memberId: someone.id,
	name: someone.name,
	email: someone.email,
	image: null,
	removable: true,
});

describe("a project's members and who reaches it", () => {
	it("keeps each list in its own shape, and refreshes both when someone joins", async () => {
		client.api.projects.listMembers.mockReturnValue(Effect.succeed([member(sam)]));
		const reaching = [testMember({ id: sam.id, name: sam.name })];
		client.api.projects.listMembersReaching.mockReturnValue(Effect.succeed(reaching));
		client.api.projects.addMember.mockReturnValue(Effect.void);
		const { result } = renderHook(
			() => ({
				members: useProjectMembers(project.id),
				reaching: useMembersReachingProject(project.id),
				place: usePlaceProjectMember(project.id),
			}),
			{ wrapper: InRoute },
		);

		await waitFor(() => expect(result.current.members.data).toEqual([member(sam)]));
		await waitFor(() => expect(result.current.reaching.data).toEqual(reaching));

		const reachingAfter = [...reaching, testMember({ id: juno.id, name: juno.name })];
		client.api.projects.listMembers.mockReturnValue(Effect.succeed([member(sam), member(juno)]));
		client.api.projects.listMembersReaching.mockReturnValue(Effect.succeed(reachingAfter));
		await act(() => result.current.place.mutateAsync({ memberId: juno.id, member: true }));

		await waitFor(() => expect(result.current.members.data).toEqual([member(sam), member(juno)]));
		await waitFor(() => expect(result.current.reaching.data).toEqual(reachingAfter));
	});
});
