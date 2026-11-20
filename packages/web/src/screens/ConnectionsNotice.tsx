import type { Connection } from "@sugabots/contracts";
import { X } from "lucide-react";
import { useState } from "react";
import { useConnectionActions, useConnections } from "@/lib/connections.ts";
import {
	OwnerLink,
	ownerName,
	type ResourceOwner,
	resourcePermissions,
	resourceProjectId,
	useLeadBot,
} from "@/lib/resource-owner.tsx";
import { Button, buttonStyles } from "@/ui/button.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { WarningText } from "@/ui/warning-text.tsx";
import { ComposerStrip } from "./ChatComposer.tsx";

/**
 * Over the draft, as strips like the one for a reply, the connections whose
 * sign-in expired, which the bots working here can't use until someone signs
 * in again. A bot in a project's thread uses the project's connections and
 * its own, so a project's thread warns of the project's and of its lead bot's
 * own, each in its own strip; a bot's thread of the bot's. Nothing while every
 * sign-in holds.
 */
export function ConnectionsNotice({ owner }: { owner: ResourceOwner }) {
	const lead = useLeadBot(owner);
	if ("bot" in owner) return <ExpiredConnections owner={owner} users={owner.bot.name} />;
	return (
		<>
			<ExpiredConnections owner={owner} users="Bots here" namesOwner />
			{/* Keyed by the lead's default project, so closing one lead's strip doesn't hide the next lead's. */}
			{lead && (
				<ExpiredConnections
					key={lead.defaultProjectId}
					owner={{ bot: lead }}
					users={lead.name}
					namesOwner
				/>
			)}
		</>
	);
}

/**
 * The owner's connections whose sign-in expired, saying that `users` can't use
 * them. Someone who manages them signs one in again from here, or opens the
 * list for several; anyone else is only told. Closing it hides it until the
 * thread is next opened. With `namesOwner`, the phone's line and the action's
 * accessible name say whose connections they are, for a thread that warns of
 * two owners' connections, where both could have one of the same name.
 */
function ExpiredConnections({
	owner,
	users,
	namesOwner = false,
}: {
	owner: ResourceOwner;
	users: string;
	namesOwner?: boolean;
}) {
	const [dismissed, setDismissed] = useState(false);
	const expired = useConnections(resourceProjectId(owner)).data?.filter(
		(connection) => connection.signInExpired,
	);
	if (dismissed || !expired || expired.length === 0) return null;
	const canSignIn = resourcePermissions(owner).manageConnections;
	const [only] = expired;
	// Names past a couple read as a list to scan, which the connections page already is.
	const what = only && expired.length === 1 ? only.name : `${expired.length} connections`;
	const who = canSignIn
		? "you sign"
		: `someone who manages ${expired.length === 1 ? "it" : "them"} signs`;
	const whose = namesOwner ? ownerName(owner) : undefined;
	return (
		<ComposerStrip className="pr-1.5">
			<WarningText className="flex-1">
				<span className="max-md:hidden">
					{users} can't use {what} until {who} in again.
				</span>
				{/* A phone's row has room for one line beside the button, so it only says what happened. */}
				<span className="md:hidden">{compactSummary(expired, whose)}</span>
			</WarningText>
			{canSignIn && <SignInAgain owner={owner} expired={expired} whose={whose} />}
			<IconButton label="Dismiss" side="top" onClick={() => setDismissed(true)}>
				<X aria-hidden />
			</IconButton>
		</ComposerStrip>
	);
}

/** What a phone's strip says expired, after `whose` connections they are when given. */
function compactSummary(expired: readonly Connection[], whose: string | undefined): string {
	const [only] = expired;
	if (only && expired.length === 1) {
		return whose ? `${whose}'s ${only.name} sign-in expired.` : `${only.name}'s sign-in expired.`;
	}
	return whose
		? `${expired.length} of ${whose}'s sign-ins expired.`
		: `${expired.length} connections' sign-ins expired.`;
}

/**
 * One connection goes straight to its sign-in; several open the owner's
 * connections, each with its own. `whose`, when given, ends the accessible name.
 */
function SignInAgain({
	owner,
	expired,
	whose,
}: {
	owner: ResourceOwner;
	expired: readonly Connection[];
	whose: string | undefined;
}) {
	const actions = useConnectionActions(resourceProjectId(owner));
	const forWhom = whose ? ` for ${whose}` : "";
	const [only] = expired;
	if (only && expired.length === 1) {
		return (
			<Button
				variant="secondary"
				size="sm"
				className="shrink-0"
				aria-label={`Sign in to ${only.name}${forWhom}`}
				disabled={actions.signIn.isPending}
				onClick={() => actions.signIn.mutate({ connectionId: only.id })}
			>
				<span className="max-md:hidden">Sign in to {only.name}</span>
				<span className="md:hidden">Sign in</span>
			</Button>
		);
	}
	return (
		<OwnerLink
			owner={owner}
			to={{ page: "connections" }}
			aria-label={`Open connections${forWhom}`}
			className={buttonStyles({ variant: "secondary", size: "sm", className: "shrink-0" })}
		>
			<span className="max-md:hidden">Open connections</span>
			<span className="md:hidden">Open</span>
		</OwnerLink>
	);
}
