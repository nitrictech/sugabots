import { useInterruptTurn } from "@/lib/chat-query.ts";
import { failureMessage } from "@/lib/failure.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";

/** Interrupts the turn writing a reply, for a member who may: its asker, or someone who may manage it. */
export function InterruptTurnButton({
	chatId,
	turnId,
	botName,
}: {
	chatId: string;
	turnId: string;
	botName: string;
}) {
	const interrupt = useInterruptTurn(chatId);
	return (
		<div className="flex flex-col items-start gap-1 px-5">
			<Button
				aria-label={`Interrupt ${botName}’s reply`}
				variant="quiet"
				size="text"
				disabled={interrupt.isPending || interrupt.isSuccess}
				onClick={() => interrupt.mutate(turnId)}
			>
				Interrupt
			</Button>
			{interrupt.isError && <Alert>{failureMessage(interrupt.error)}</Alert>}
			{interrupt.isSuccess && (
				<p role="status" className="text-subtle-foreground text-xs">
					Interrupting…
				</p>
			)}
		</div>
	);
}
