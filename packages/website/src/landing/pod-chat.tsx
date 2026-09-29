import { PlusIcon } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import { ChatBubble, ChatMessage, ChatNote } from "@/components/chat";
import { PodIcon } from "@/components/pod-icon";
import { MotionCard, Reveal, RevealItem, riseIn } from "@/components/reveal";
import { Avatar, AvatarFallback, AvatarGroup } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemMedia,
	ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { bots } from "@/landing/bots";
import { pods } from "@/landing/pods";

type Approval = "pending" | "approved" | "denied";

const replyToDecision = {
	approved: "Booked. Four seats on the 18:40, confirmation is in the family inbox.",
	denied:
		"No worries, I'll hold off. Prices usually move on Thursdays if you want me to check again.",
} as const;

const SELECTED_POD = "Family";
const UNREAD_POD = "Work";
const UNREAD_COUNT = 3;

function PodRail() {
	return (
		<nav
			aria-label="Pods"
			className="hidden w-17 shrink-0 flex-col items-center gap-3 border-r bg-background py-4 sm:flex"
		>
			{pods.map((pod) => (
				<div key={pod.name} className="relative flex items-center">
					{pod.name === SELECTED_POD && (
						<span className="absolute -left-3.5 h-6 w-1 rounded-r-full bg-foreground" />
					)}
					<PodIcon tint={pod.tint} bots={pod.bots} />
					{pod.name === UNREAD_POD && (
						<Badge variant="brand" className="absolute -top-1.5 -right-1.5 ring-3 ring-background">
							{UNREAD_COUNT}
						</Badge>
					)}
				</div>
			))}
			<Button
				variant="ghost"
				size="icon-lg"
				aria-label="New pod"
				className="rounded-xl border-2 border-dashed border-input text-muted-foreground"
			>
				<PlusIcon />
			</Button>
		</nav>
	);
}

function PersonAvatar({ initials }: { initials: string }) {
	return (
		<Avatar>
			<AvatarFallback className="bg-secondary text-xs font-bold text-secondary-foreground">
				{initials}
			</AvatarFallback>
		</Avatar>
	);
}

function ApprovalRequest({
	onDecide,
}: {
	onDecide: (decision: Exclude<Approval, "pending">) => void;
}) {
	return (
		<Item variant="muted" size="xs" className="w-auto max-w-full rounded-3xl rounded-tl-md">
			<ItemMedia>
				<Avatar size="xs" className="rounded-md after:rounded-md">
					<AvatarFallback className="rounded-md bg-secondary font-bold text-secondary-foreground">
						F
					</AvatarFallback>
				</Avatar>
			</ItemMedia>
			<ItemContent>
				<ItemTitle>
					Book 4 seats <span className="font-normal text-muted-foreground">· Flights</span>
				</ItemTitle>
			</ItemContent>
			<ItemActions className="gap-1">
				<Button variant="ghost" size="sm" onClick={() => onDecide("denied")}>
					Deny
				</Button>
				<Button variant="brand" size="sm" onClick={() => onDecide("approved")}>
					Approve
				</Button>
			</ItemActions>
		</Item>
	);
}

/** A demo pod chat in which a bot asks for approval before booking. */
export function PodChat() {
	const [approval, setApproval] = useState<Approval>("pending");

	return (
		<Reveal delay={0.4}>
			<MotionCard variants={riseIn} className="flex-row gap-0 rounded-3xl py-0 shadow-2xl">
				<PodRail />
				<div className="flex min-w-0 flex-1 flex-col">
					<Item className="rounded-none px-5 py-3.5">
						<ItemMedia>
							<BotAvatar size="lg" {...bots.tripPlanner} />
						</ItemMedia>
						<ItemContent className="gap-0">
							<ItemTitle className="text-base font-bold">Trip Planner</ItemTitle>
							<ItemDescription className="text-xs">Family · you, Mum, Dad, Sam</ItemDescription>
						</ItemContent>
					</Item>
					<Separator />
					{/* The conversation plays out once the window has settled into place. */}
					<Reveal stagger={0.5} delay={1} className="flex flex-col gap-3 px-4 py-5 sm:px-8">
						<ChatNote className="pb-1">
							<span className="text-foreground">Today</span> 19:12
						</ChatNote>
						<RevealItem>
							<ChatMessage side="start" avatar={<PersonAvatar initials="MA" />}>
								<ChatBubble tone="person" side="start">
									Can someone please sort the Lisbon flights before the prices jump again
								</ChatBubble>
							</ChatMessage>
						</RevealItem>
						<RevealItem>
							<ChatMessage side="end">
								<ChatBubble tone="self" side="end">
									On it. Trip Planner, find us something Friday after 5, and check it fits the
									holiday pot
								</ChatBubble>
							</ChatMessage>
						</RevealItem>
						<RevealItem className="flex justify-center">
							<Badge variant="outline" size="lg" className="max-w-full text-muted-foreground">
								<AvatarGroup className="-space-x-1.5">
									<BotAvatar size="xs" {...bots.tripPlanner} />
									<BotAvatar size="xs" {...bots.budgetKeeper} />
								</AvatarGroup>
								<span className="truncate">
									Trip Planner collaborated with Budget Keeper · 6 steps
								</span>
							</Badge>
						</RevealItem>
						<RevealItem>
							<ChatMessage side="start" avatar={<BotAvatar {...bots.tripPlanner} />}>
								<ChatBubble tone={bots.tripPlanner.color} side="start">
									Two options under €180 each. The 18:40 lands in time for dinner, and Budget Keeper
									says four seats still leave €220 in the pot.
								</ChatBubble>
								<AnimatePresence mode="wait" initial={false}>
									<RevealItem key={approval} initial="hidden" animate="visible" exit="hidden">
										{approval === "pending" ? (
											<ApprovalRequest onDecide={setApproval} />
										) : (
											<ChatBubble tone={bots.tripPlanner.color} side="start">
												{replyToDecision[approval]}
											</ChatBubble>
										)}
									</RevealItem>
								</AnimatePresence>
							</ChatMessage>
						</RevealItem>
						<RevealItem>
							<ChatMessage side="start" avatar={<PersonAvatar initials="DA" />}>
								<ChatBubble tone="person" side="start">
									18:40. Nobody is doing a 6am flight again.
								</ChatBubble>
							</ChatMessage>
						</RevealItem>
					</Reveal>
				</div>
			</MotionCard>
		</Reveal>
	);
}
