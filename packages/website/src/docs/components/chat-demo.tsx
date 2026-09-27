import { RotateCcwIcon } from "lucide-react";
import { Children, type ReactNode, useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { ChatBubble, ChatMessage, ChatNote } from "@/components/chat";
import { MotionCard, Reveal, RevealItem, riseIn } from "@/components/reveal";
import { Avatar, AvatarFallback, AvatarGroup } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { type CastName, cast } from "@/docs/cast";

/** Seconds between one line of a demo chat and the next. */
const LINE_STAGGER_S = 0.55;

function SpeakerAvatar({ name }: { name: CastName }) {
	const member = cast[name];
	if (member.kind === "bot") return <BotAvatar {...member.look} />;
	if (member.kind === "self") return undefined;
	return (
		<Avatar>
			<AvatarFallback className="bg-secondary text-xs font-bold text-secondary-foreground">
				{member.initials}
			</AvatarFallback>
		</Avatar>
	);
}

/** One line of a `Chat`, said by a member of the docs' cast. */
export function Say({ from, children }: { from: CastName; children: ReactNode }) {
	const member = cast[from];
	const side = member.kind === "self" ? "end" : "start";
	const tone = member.kind === "bot" ? member.look.color : member.kind;
	return (
		<ChatMessage side={side} avatar={<SpeakerAvatar name={from} />}>
			{member.kind === "bot" && (
				<span className="px-1 text-xs font-semibold text-muted-foreground">{member.name}</span>
			)}
			<ChatBubble tone={tone} side={side}>
				{children}
			</ChatBubble>
		</ChatMessage>
	);
}

/** A line in a `Chat` about what went on between messages, like one bot asking another. */
export function Activity({ bots, children }: { bots?: readonly CastName[]; children: ReactNode }) {
	return (
		<div className="flex justify-center">
			<Badge variant="outline" size="lg" className="max-w-full text-muted-foreground">
				{bots && (
					<AvatarGroup className="-space-x-1.5">
						{bots.map((name) => {
							const member = cast[name];
							return member.kind === "bot" ? (
								<BotAvatar key={name} size="xs" {...member.look} />
							) : null;
						})}
					</AvatarGroup>
				)}
				<span className="truncate">{children}</span>
			</Badge>
		</div>
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
					<ChatNote className="flex-1 text-left text-sm text-foreground">{title}</ChatNote>
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
					className="flex flex-col gap-3 px-4 py-5 sm:px-6"
				>
					{Children.map(children, (line) => (
						<RevealItem>{line}</RevealItem>
					))}
				</Reveal>
			</MotionCard>
		</Reveal>
	);
}
