import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { useWorkspacePermissions } from "@/lib/workspace.ts";
import { buttonStyles } from "@/ui/button.tsx";

/**
 * Saying that the system bots are not set up, and where to set them up.
 * Everybody is told why what they are looking at is not working; only an
 * administrator, who chooses the system bots' model, is offered the way there.
 */

/** Who the reader has to ask, when they cannot choose the model themselves. */
const AN_ADMINISTRATOR_CHOOSES = "A workspace administrator chooses their model.";

/** A link to where the system bots' model is chosen, one for all of them. Administrators only. */
function SystemModelLink({ children }: { children: ReactNode }) {
	const backToThread = useBackToHere("Thread");
	return (
		<Link
			from="/$workspace"
			to="./settings/providers/system"
			state={backToThread}
			className={buttonStyles({ variant: "link", size: "bare" })}
		>
			{children}
		</Link>
	);
}

/**
 * The summary panels' empty state when the workspace has chosen no model for
 * its system bots. Says what is not happening, not merely that something is unset.
 */
export function SystemBotsNotSetUp() {
	const mayConfigure = useWorkspacePermissions().configureBuiltInBots;
	return (
		<p className="m-0 pt-3 text-muted-foreground text-sm leading-relaxed">
			The system bots write these, and they have no model yet.{" "}
			{mayConfigure ? (
				<>
					<SystemModelLink>Choose their model</SystemModelLink>.
				</>
			) : (
				AN_ADMINISTRATOR_CHOOSES
			)}
		</p>
	);
}
