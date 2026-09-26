import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useWorkspacePermissions } from "@/lib/workspace.ts";
import { Button } from "@/ui/button.tsx";

/**
 * Saying that a built-in agent is not set up, and where to set it up.
 *
 * One place, because the same fact is stated on three screens that are nowhere
 * near each other — a thread's summary, a chat's summary and a pod's routing
 * options — and they have to agree about what is wrong and where to go.
 *
 * Everybody is told why the thing they are looking at is not working; only
 * somebody who can do something about it is offered the way there. Built-in
 * agents are configured for the whole workspace, so that is an administrator,
 * and a link nobody else can follow would be worse than the plain sentence.
 */

/** Who the reader has to ask, when they cannot choose the model themselves. */
const AN_ADMINISTRATOR_CHOOSES = "A workspace administrator chooses its model.";

/** Whether the reader may choose the models the built-in agents run on. */
function useCanConfigureBuiltInAgents(): boolean {
	return useWorkspacePermissions().configureBuiltInAgents;
}

/** A link to where the system bots' model is chosen, one for all of them. Administrators only. */
function SystemModelLink({ children }: { children: ReactNode }) {
	return (
		<Button
			size="bare"
			variant="link"
			render={<Link from="/$workspace" to="./settings/providers/system" />}
		>
			{children}
		</Button>
	);
}

/**
 * The summary panels' empty state when the workspace has chosen no model for
 * its Scribe. Says what is not happening, not merely that something is unset.
 */
export function ScribeNotSetUp() {
	const mayConfigure = useCanConfigureBuiltInAgents();
	return (
		<p className="m-0 pt-3 text-muted-foreground text-base leading-relaxed">
			The Scribe writes these, and it has no model yet.{" "}
			{mayConfigure ? (
				<>
					<SystemModelLink>Set up the Scribe</SystemModelLink>.
				</>
			) : (
				AN_ADMINISTRATOR_CHOOSES
			)}
		</p>
	);
}
