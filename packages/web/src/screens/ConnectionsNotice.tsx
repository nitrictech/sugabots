import type { Connection, Pod } from "@sugabots/contracts";
import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useState } from "react";
import { useConnectionActions, useConnections } from "@/lib/connections.ts";
import { podSettingsPageLink } from "@/lib/links.ts";
import { useBackToHere } from "@/lib/settings-back.tsx";
import { Button, buttonStyles } from "@/ui/button.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { WarningText } from "@/ui/warning-text.tsx";

/**
 * Over the draft, as a strip like the one for a reply, the pod's connections
 * whose sign-in expired, which `botName` can't use until someone signs in
 * again. Someone who manages the pod's connections signs one in again from
 * here, or opens the list for several; anyone else is only told. Closing it
 * hides it until the chat is next opened. Nothing while every sign-in holds.
 */
export function ConnectionsNotice({ pod, botName }: { pod: Pod; botName?: string }) {
	const [dismissed, setDismissed] = useState(false);
	const expired = useConnections(pod.id).data?.filter((connection) => connection.signInExpired);
	if (dismissed || !expired || expired.length === 0) return null;
	const canSignIn = pod.permissions.manageConnections;
	const who = canSignIn ? "you sign" : "someone in the pod signs";
	const [only] = expired;
	return (
		<div className="flex items-center gap-2 border-border border-b py-1.5 pr-1.5 pl-3 text-xs">
			<WarningText className="flex-1 text-muted-foreground">
				{only && expired.length === 1 ? (
					<>
						<span className="max-md:hidden">
							{botName ?? "Bots"} can't use {only.name} until {who} in again.
						</span>
						{/* A phone's row has room for one line beside the button, so it only says what happened. */}
						<span className="md:hidden">{only.name}'s sign-in expired.</span>
					</>
				) : (
					// Names past a couple read as a list to scan, which the connections page already is.
					`${expired.length} connections' sign-ins expired.`
				)}
			</WarningText>
			{canSignIn && <SignInAgain pod={pod} expired={expired} />}
			<IconButton label="Dismiss" side="top" onClick={() => setDismissed(true)}>
				<X aria-hidden />
			</IconButton>
		</div>
	);
}

/** One connection goes straight to its sign-in; several open the pod's connections, each with its own. */
function SignInAgain({ pod, expired }: { pod: Pod; expired: readonly Connection[] }) {
	const backToChat = useBackToHere("Chat");
	const actions = useConnectionActions(pod.id);
	const [only] = expired;
	if (only && expired.length === 1) {
		return (
			<Button
				variant="secondary"
				size="sm"
				className="shrink-0"
				aria-label={`Sign in to ${only.name}`}
				disabled={actions.signIn.isPending}
				onClick={() => actions.signIn.mutate({ connectionId: only.id })}
			>
				<span className="max-md:hidden">Sign in to {only.name}</span>
				<span className="md:hidden">Sign in</span>
			</Button>
		);
	}
	return (
		<Link
			{...podSettingsPageLink(pod, "connections")}
			state={backToChat}
			aria-label="Open connections"
			className={buttonStyles({ variant: "secondary", size: "sm", className: "shrink-0" })}
		>
			<span className="max-md:hidden">Open connections</span>
			<span className="md:hidden">Open</span>
		</Link>
	);
}
