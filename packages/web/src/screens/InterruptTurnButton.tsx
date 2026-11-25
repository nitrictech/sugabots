import { useInterruptTurn } from "@/lib/chat-query.ts";
import { Button } from "@/ui/button.tsx";

/** Interrupts the turn writing a reply, for a member who may: its asker, or someone who may manage it. */
export function InterruptTurnButton({ chatId, turnId }: { chatId: string; turnId: string }) {
	const interrupt = useInterruptTurn(chatId);
	return (
		<div className="flex px-5">
			<Button
				variant="quiet"
				size="text"
				disabled={interrupt.isPending || interrupt.isSuccess}
				onClick={() => interrupt.mutate(turnId)}
			>
				Interrupt
			</Button>
		</div>
	);
}
