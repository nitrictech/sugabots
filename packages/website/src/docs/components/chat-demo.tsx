import { RotateCcwIcon } from "lucide-react";
import { Children, type ReactNode, useState } from "react";
import { ChatCollaboration, ChatMessage, ChatText } from "@/components/chat";
import { MotionCard, Reveal, RevealItem, riseIn } from "@/components/reveal";
import { Button } from "@/components/ui/button";
import { type CastName, cast } from "@/docs/cast";

/** Seconds between one line of a demo chat and the next. */
const LINE_STAGGER_S = 0.55;

interface SayProps {
	from: CastName;
	/** Another bot this bot's message asked, shown as the collaboration line under its words. */
	collaboratesWith?: CastName;
	children: ReactNode;
}

/** One message in a `Chat`, said by a member of the docs' cast. */
export function Say({ from, collaboratesWith, children }: SayProps) {
	const author = cast[from];
	const collaborator = collaboratesWith ? cast[collaboratesWith] : undefined;
	return (
		<ChatMessage author={author}>
			<ChatText>{children}</ChatText>
			{author.kind === "bot" && collaborator?.kind === "bot" && (
				<ChatCollaboration from={author.look} to={collaborator} status="Done" />
			)}
		</ChatMessage>
	);
}

interface ChatProps {
	/** Where the chat happens, e.g. "Family · Trip Planner". */
	title: string;
	children: ReactNode;
}

/** A pretend conversation that plays out line by line when it scrolls into view, and again on request. */
export function Chat({ title, children }: ChatProps) {
	const [playCount, setPlayCount] = useState(0);
	return (
		<Reveal className="my-8">
			<MotionCard variants={riseIn} className="gap-0 rounded-3xl py-0 shadow-xl">
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
			</MotionCard>
		</Reveal>
	);
}
