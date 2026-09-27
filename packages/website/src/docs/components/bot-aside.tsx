import { type BotLook, botColorVariables } from "@sugabots/avatars";
import type { ReactNode } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { RevealItem } from "@/components/reveal";

interface BotAsideProps {
	bot: BotLook;
	label: string;
	children: ReactNode;
}

/** A side note, said by a bot in its own speech bubble. */
function BotAside({ bot, label, children }: BotAsideProps) {
	return (
		<aside className="my-6 flex items-start gap-3">
			<RevealItem variant="pop" initial="hidden" whileInView="visible" viewport={{ once: true }}>
				<BotAvatar {...bot} className="mt-1" />
			</RevealItem>
			<div
				style={botColorVariables(bot.color)}
				className="min-w-0 flex-1 rounded-3xl rounded-tl-md bg-(--bot-tint) px-5 py-3 text-(--bot-text) [&_code]:bg-(--bot-text)/10 [&>p]:my-2 [&>p]:text-inherit"
			>
				<p className="text-xs font-bold tracking-wide uppercase opacity-70">{label}</p>
				{children}
			</div>
		</aside>
	);
}

/** Something helpful to know. */
export function Tip({ children, title = "Tip" }: { children: ReactNode; title?: string }) {
	return (
		<BotAside bot={{ color: "green", face: "wink" }} label={title}>
			{children}
		</BotAside>
	);
}

/** Something that loses data or locks people out if it's missed. */
export function Careful({ children, title = "Careful" }: { children: ReactNode; title?: string }) {
	return (
		<BotAside bot={{ color: "rose", face: "square" }} label={title}>
			{children}
		</BotAside>
	);
}
