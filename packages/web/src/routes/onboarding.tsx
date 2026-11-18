import type { Workspace } from "@sugabots/contracts";
import { createRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { type Session, useSession } from "@/lib/session.ts";
import {
	chooseWorkspace,
	useDeleteWorkspace,
	useWorkspace,
	useWorkspaceStanding,
	useWorkspaces,
} from "@/lib/workspace.ts";
import { LoadFailure } from "@/shell/LoadFailure.tsx";
import { lazyNamed } from "./lazy-screen.tsx";
import { requireUser, rootRoute } from "./root.tsx";

const Onboarding = lazyNamed(() => import("@/screens/Onboarding.tsx"), "Onboarding");

interface OnboardingSearch {
	/**
	 * The workspace being set up, by its address. Written before the workspace
	 * is saved, so a reload while it saves picks up where it got to.
	 */
	workspace?: string;
}

/**
 * Setting up a workspace, the first or another, all at this one path: every
 * top-level path hides the workspace whose address matches it.
 */
export const onboardingRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/onboarding",
	validateSearch: (search: Record<string, unknown>): OnboardingSearch => ({
		workspace: typeof search.workspace === "string" ? search.workspace : undefined,
	}),
	beforeLoad: requireUser,
	component: OnboardingRoute,
});

function OnboardingRoute() {
	const session = useSession();
	const { workspace: madeSlug } = onboardingRoute.useSearch();
	const { isPending, failure, refetch } = useWorkspace();
	const workspaces = useWorkspaces();

	if (failure) {
		return <LoadFailure title="Could not start setup" error={failure.error} retry={refetch} />;
	}
	if (isPending) return <div className="h-full bg-list" />;
	return (
		<WorkspaceSetup
			session={session}
			made={workspaces.data?.find((one) => one.slug === madeSlug)}
		/>
	);
}

/**
 * Cancel chooses the workspace setup was opened from, or another when that is
 * the one being set up, and goes back to the page it was opened on. Without
 * one there is nowhere to go back to, and no Cancel.
 *
 * Cancel deletes the workspace being set up while its setup is unfinished, if
 * the caller may delete it, as its owner may. One whose setup is finished stays.
 */
function WorkspaceSetup({ session, made }: { session: Session; made: Workspace | undefined }) {
	const router = useRouter();
	const openedFrom = useWorkspace().workspace;
	const workspaces = useWorkspaces().data;
	// Settled when setup opens, because making the workspace chooses it.
	const [returnTo] = useState(() =>
		openedFrom && openedFrom.id !== made?.id
			? openedFrom
			: workspaces?.find((one) => one.id !== made?.id),
	);
	const deleteWorkspace = useDeleteWorkspace();
	// Setup shows its steps only once the workspace being set up is chosen, so this is its standing.
	const standing = useWorkspaceStanding();

	async function cancel() {
		if (made?.setupCompletedAt === null && standing.data?.permissions.deleteWorkspace) {
			// One that cannot be deleted now stays; leaving still goes ahead.
			await deleteWorkspace.mutateAsync(made.id).catch(() => undefined);
		}
		if (returnTo) chooseWorkspace(returnTo.id);
		if (router.history.canGoBack()) router.history.back();
		else void router.navigate({ to: "/" });
	}

	return (
		<Onboarding
			session={session}
			workspace={made}
			onAddress={(slug) =>
				void router.navigate({ to: "/onboarding", search: { workspace: slug }, replace: true })
			}
			onCancel={returnTo ? () => void cancel() : undefined}
		/>
	);
}
