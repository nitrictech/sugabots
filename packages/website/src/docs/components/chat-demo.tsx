import { RotateCcwIcon } from "lucide-react";
import { Children, type ReactNode, useState } from "react";
import { type CastName, cast } from "@/cast";
import { ChatMessage, ChatText } from "@/components/chat";
import { MotionDemoCard, Reveal, RevealItem, riseIn } from "@/components/reveal";
import { Button } from "@/components/ui/button";

/** Seconds between one line of a demo chat and the next. */
const LINE_STAGGER_S = 0.55;

interface SayProps {
	from: CastName;
	children: ReactNode;
}

/** One message in a `Chat`, said by a member of the docs' cast. */
export function Say({ from, children }: SayProps) {
	return (
		<ChatMessage author={cast[from]}>
			<ChatText>{children}</ChatText>
		</ChatMessage>
	);
}

interface ChatProps {
	/** Where the chat happens, e.g. "Lisbon trip". */
	title: string;
	children: ReactNode;
}

/** A pretend chat that plays out line by line when it scrolls into view, and again on request. */
export function Chat({ title, children }: ChatProps) {
	const [playCount, setPlayCount] = useState(0);
	return (
		<Reveal>
			<MotionDemoCard variants={riseIn}>
				<div className="flex items-center gap-3 border-b px-5 py-3">
					<p className="flex-1 text-sm font-semibold">{title}</p>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => setPlayCount((count) => count + 1)}
						className="text-muted-foreground"
					>
						<RotateCcwIcon data-icon="inline-start" />
						Replay
					</Button>
				</div>
				<Reveal
					key={playCount}
					stagger={LINE_STAGGER_S}
					delay={0.3}
					className="flex flex-col gap-4 px-4 py-5 sm:px-6"
				>
					{Children.map(children, (line) => (
						<RevealItem>{line}</RevealItem>
					))}
				</Reveal>
			</MotionDemoCard>
		</Reveal>
	);
}
