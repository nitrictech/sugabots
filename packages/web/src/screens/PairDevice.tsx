import { isApiFailure } from "@sugabots/sdk";
import { useApprovePairing, usePendingPairing } from "@/lib/devices.ts";
import { failureMessage } from "@/lib/failure.ts";
import { AuthLayout } from "@/screens/AuthLayout.tsx";
import { Alert, Success } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";
import { Note } from "@/ui/note.tsx";

/**
 * Where the desktop app sends somebody to pair it: the browser it opens is
 * signed in, and approving the code the desktop shows pairs that computer to
 * them. A code somebody else sent would pair their computer instead, so the
 * page warns against approving one you didn't start.
 */
export function PairDevice({ code, onCancel }: { code: string; onCancel: () => void }) {
	const pairing = usePendingPairing(code);
	const approve = useApprovePairing(code);

	if (approve.isSuccess) {
		return (
			<AuthLayout title={`${approve.data.name} is paired`}>
				<Success className="justify-center">Paired. You can go back to the desktop app.</Success>
			</AuthLayout>
		);
	}

	if (pairing.isPending) {
		return <AuthLayout title="Reading the pairing code…">{null}</AuthLayout>;
	}

	if (pairing.isError) {
		const expired = isApiFailure(pairing.error) && pairing.error._tag === "NotFound";
		return (
			<AuthLayout
				title={expired ? "This pairing code has expired" : "This pairing code did not work"}
				subtitle={
					expired
						? "Codes last ten minutes. Choose Pair this computer in the desktop app's tray menu to get a new one."
						: undefined
				}
			>
				{!expired && <Alert>{failureMessage(pairing.error)}</Alert>}
				<Button variant="outline" size="lg" onClick={onCancel} className="w-full">
					Carry on without it
				</Button>
			</AuthLayout>
		);
	}

	return (
		<AuthLayout
			title={`Pair ${pairing.data.name}?`}
			subtitle="Pairing lets this computer lend the agents running on it to bots you set up."
		>
			<p className="m-0 text-center font-mono text-[22px] text-foreground tracking-[0.12em]">
				{pairing.data.code}
			</p>
			<Note>
				Only approve if you started pairing on your own computer just now, and the desktop app shows
				this same code.
			</Note>
			{approve.isError && (
				<Alert>
					{failureMessage(approve.error, {
						NotFound: "This pairing code has expired. Pair the desktop app again.",
					})}
				</Alert>
			)}
			<div className="flex gap-2.5">
				<Button
					variant="outline"
					size="lg"
					onClick={onCancel}
					disabled={approve.isPending}
					className="flex-1"
				>
					Cancel
				</Button>
				<Button
					size="lg"
					onClick={() => approve.mutate()}
					disabled={approve.isPending}
					className="flex-1"
				>
					{approve.isPending ? "Pairing…" : "Approve"}
				</Button>
			</div>
		</AuthLayout>
	);
}
