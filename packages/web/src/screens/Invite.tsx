import { isEmailUnverified, unwrap } from "@sugabots/sdk";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useState } from "react";
import { client } from "@/api.ts";
import { failureMessage } from "@/lib/failure.ts";
import { chooseWorkspace } from "@/lib/workspace.ts";
import { AuthLayout } from "@/screens/AuthLayout.tsx";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";

/**
 * The other end of an invitation.
 *
 * The link carries the invitation id, which is a secret: holding it, and being
 * signed in as the address it was sent to, is what admits you to the workspace.
 * So the commonest failure is not a bad link but the wrong account, and that is
 * what `wrongAccount` says.
 *
 * An installation that requires a proved address refuses with the same status,
 * though, and telling somebody their own address is somebody else's would send
 * them looking in the wrong place. `isEmailUnverified` separates the two.
 */
const wrongAccount = " — this invitation was sent to a different address.";

function invitationFailureMessage(failure: unknown): string {
	if (isEmailUnverified(failure)) {
		return "Verify your email address before accepting. We sent a link when you signed up, and signing in again sends another.";
	}
	return failureMessage(failure, {
		forbidden: `Not yours to accept${wrongAccount}`,
		bad_request: `This invitation cannot be accepted${wrongAccount}`,
	});
}

export function Invite({ id, onDone }: { id: string; onDone: () => Promise<void> }) {
	const queries = useQueryClient();
	const [workspace, setWorkspace] = useState<string>();
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [accepted, setAccepted] = useState(false);
	const resumeAcceptance = useEffectEvent(() => finishAcceptance(false));

	useEffect(() => {
		let current = true;

		void (async () => {
			if (await resumeAcceptance()) return;
			client.auth.workspaces.invitation(id).then(
				(invitation) => {
					if (current) setWorkspace(invitation.organizationName);
				},
				(failure: unknown) => {
					if (current) setError(invitationFailureMessage(failure));
				},
			);
		})();

		return () => {
			current = false;
		};
	}, [id]);

	async function accept() {
		setBusy(true);
		setError(undefined);
		try {
			await client.auth.workspaces.acceptInvite(id);
		} catch (failure) {
			setError(invitationFailureMessage(failure));
			setBusy(false);
			return;
		}

		setAccepted(true);
		await finishAcceptance();
	}

	async function finishAcceptance(reportFailure = true): Promise<boolean> {
		let confirmed = false;
		try {
			const result = await unwrap(
				client.api.onboarding["complete-invite"].$post({ json: { invitationId: id } }),
			);
			confirmed = true;
			setAccepted(true);
			chooseWorkspace(result.workspaceId);
			await queries.invalidateQueries({ queryKey: ["workspaces"] });
			await queries.invalidateQueries({ queryKey: ["onboarding"] });
			await onDone();
			return true;
		} catch (failure) {
			if (reportFailure || confirmed) {
				setError(
					`The invitation was accepted, but we could not continue. ${failureMessage(failure)}`,
				);
			}
			setBusy(false);
			return confirmed;
		}
	}

	async function leave() {
		setBusy(true);
		try {
			if (accepted) {
				await finishAcceptance();
			} else {
				await onDone();
			}
		} catch (failure) {
			setError(failureMessage(failure));
			setBusy(false);
		}
	}

	if (error !== undefined) {
		return (
			<AuthLayout title={accepted ? "Invitation accepted" : "This invitation did not work"}>
				<Alert>{error}</Alert>
				<Button
					variant="outline"
					size="lg"
					onClick={() => void leave()}
					disabled={busy}
					className="w-full"
				>
					{accepted ? "Continue" : "Carry on without it"}
				</Button>
			</AuthLayout>
		);
	}

	return (
		<AuthLayout
			title={workspace ? `You have been invited to ${workspace}.` : "Reading the invitation…"}
			subtitle="You will join as a member. Threads in a pod are visible to everyone in it."
		>
			<Button size="lg" onClick={accept} disabled={busy || !workspace} className="w-full">
				Accept invite
			</Button>
		</AuthLayout>
	);
}
