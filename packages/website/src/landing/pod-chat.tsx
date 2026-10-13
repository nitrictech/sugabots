import { AtSignIcon, PlusIcon, SendIcon, UsersRoundIcon } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { BotAvatar } from "@/components/bot-avatar";
import {
	type ApprovalDecision,
	ChatApproval,
	type ChatAuthor,
	ChatCollaboration,
	ChatDay,
	ChatMessage,
	ChatRoutineNote,
	ChatText,
	ChatToolLine,
} from "@/components/chat";
import { PodIcon } from "@/components/pod-icon";
import { MotionCard, Reveal, RevealItem, riseIn } from "@/components/reveal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { bots } from "@/landing/bots";
import { type PodName, pods } from "@/landing/pods";

const authors = {
	you: { kind: "person", name: "You", initials: "Y" },
	mum: { kind: "person", name: "Mum", initials: "MA" },
	dad: { kind: "person", name: "Dad", initials: "DA" },
	priya: { kind: "person", name: "Priya", initials: "PR" },
	alex: { kind: "person", name: "Alex", initials: "AL" },
	tom: { kind: "person", name: "Tom", initials: "TO" },
	jess: { kind: "person", name: "Jess", initials: "JE" },
	tripPlanner: { kind: "bot", name: "Trip Planner", look: bots.tripPlanner },
	analyst: { kind: "bot", name: "Analyst", look: bots.analyst },
	billSplitter: { kind: "bot", name: "Bill Splitter", look: bots.billSplitter },
	daybook: { kind: "bot", name: "Daybook", look: bots.daybook },
} as const satisfies Record<string, ChatAuthor>;

type BotAuthor = Extract<ChatAuthor, { kind: "bot" }>;

/**
 * The Family chat's booking approval. `PodChat` keeps it, because each chat
 * remounts when its pod is opened and the decision has to outlast that.
 */
interface BookingApproval {
	approval: ApprovalDecision;
	onDecide: (decision: Exclude<ApprovalDecision, "pending">) => void;
}

interface Conversation {
	/** The bot whose chat it is, named in the header. */
	bot: BotAuthor;
	/** What the bot is for, beside its name in the header. */
	description: string;
	/** Whether the pod has other people, so the composer can write to them alone. */
	sharedWithPeople: boolean;
	/** Its messages under their day markers, each a `RevealItem` so they play out in turn. */
	Messages: (props: BookingApproval) => ReactNode;
}

/** The chat open in each pod: something different the pod's people and bots get done. */
const conversations: Record<PodName, Conversation> = {
	Work: {
		bot: authors.analyst,
		description: "Leads, bugs and the Monday report",
		sharedWithPeople: true,
		Messages: WorkMessages,
	},
	Family: {
		bot: authors.tripPlanner,
		description: "Flights, stays and getting everyone there",
		sharedWithPeople: true,
		Messages: FamilyMessages,
	},
	"Unit 4B": {
		bot: authors.billSplitter,
		description: "Splits the bills and keeps the sheet",
		sharedWithPeople: true,
		Messages: FlatMessages,
	},
	Personal: {
		bot: authors.daybook,
		description: "Your inbox, calendar and reminders",
		sharedWithPeople: false,
		Messages: PersonalMessages,
	},
};

const FIRST_POD: PodName = "Family";

/** Seconds between one message of the first chat and the next as it plays out, and before the first. */
const FIRST_CHAT_STAGGER_S = 0.5;
const FIRST_CHAT_DELAY_S = 0.5;

const UNREAD_POD: PodName = "Work";
const UNREAD_COUNT = 3;

/** A routine's report, and a teammate digging into it with the bot that wrote it. */
function WorkMessages() {
	return (
		<>
			<ChatDay>Friday</ChatDay>
			<RevealItem>
				<ChatMessage author={authors.alex} time="4:48pm">
					<ChatText>Can the Monday report include webinar signups from now on?</ChatText>
				</ChatMessage>
			</RevealItem>
			<RevealItem>
				<ChatMessage author={authors.analyst} time="4:49pm">
					<ChatText>Done. They're in the report's instructions now.</ChatText>
				</ChatMessage>
			</RevealItem>
			<ChatDay>Today</ChatDay>
			<RevealItem>
				<ChatMessage author={authors.analyst} time="9:00am">
					<ChatToolLine>Used HubSpot and Linear for 6s</ChatToolLine>
					<ChatText>
						14 new leads last week, 3 of them from the webinar. Signups are up 12%. Two bugs were
						reopened since Friday, both in checkout.
					</ChatText>
					<ChatRoutineNote routine="Monday report" />
				</ChatMessage>
			</RevealItem>
			<RevealItem>
				<ChatMessage author={authors.priya} time="9:04am">
					<ChatText>Did those checkout bugs hit any of the webinar leads?</ChatText>
				</ChatMessage>
			</RevealItem>
			<RevealItem>
				<ChatMessage author={authors.analyst} time="9:05am">
					<ChatToolLine>Used Linear for 2s</ChatToolLine>
					<ChatText>
						Two of them hit the coupon error before signing up. Asking Researcher whether the fix is
						live.
					</ChatText>
					<ChatCollaboration
						from={bots.analyst}
						to={{ name: "Researcher", look: bots.researcher }}
						lastReply="9:06am"
						status="Done"
					/>
				</ChatMessage>
			</RevealItem>
			<RevealItem>
				<ChatMessage author={authors.analyst} time="9:06am">
					<ChatText>
						It's on staging, not live yet. I'd hold the follow-up email until Wednesday's release.
					</ChatText>
				</ChatMessage>
			</RevealItem>
		</>
	);
}

const outcomes = {
	allowed: "Allowed by you",
	denied: "Denied by you. Trip Planner won't go ahead.",
} as const;

const replyToDecision = {
	allowed: "Booked. Four seats on the 6:40pm, confirmation is in the family inbox.",
	denied:
		"No worries, I'll hold off. Prices usually move on Thursdays if you want me to check again.",
} as const;

/** A bot that asks before it books anything. */
function FamilyMessages({ approval, onDecide }: BookingApproval) {
	return (
		<>
			<ChatDay>Today</ChatDay>
			<RevealItem>
				<ChatMessage author={authors.mum} time="7:12pm">
					<ChatText>
						Can someone please sort the Melbourne flights before the prices jump again
					</ChatText>
				</ChatMessage>
			</RevealItem>
			<RevealItem>
				<ChatMessage author={authors.you} time="7:13pm">
					<ChatText>
						On it. Trip Planner, find us something Friday after 5, and check it fits the holiday pot
					</ChatText>
				</ChatMessage>
			</RevealItem>
			<RevealItem>
				<ChatMessage author={authors.tripPlanner} time="7:13pm">
					<ChatText>Found two. Checking them against the holiday pot.</ChatText>
					<ChatCollaboration
						from={bots.tripPlanner}
						to={{ name: "Budget Keeper", look: bots.budgetKeeper }}
						lastReply="7:14pm"
						status="Done"
					/>
				</ChatMessage>
			</RevealItem>
			<RevealItem>
				<ChatMessage author={authors.tripPlanner} time="7:14pm">
					<ChatText>
						Two options under $180 each, at 6:10am or 6:40pm. Budget Keeper says four seats still
						leave $220 in the pot.
					</ChatText>
				</ChatMessage>
			</RevealItem>
			<RevealItem>
				<ChatMessage author={authors.dad} time="7:15pm">
					<ChatText>The 6:40. Nobody is doing a 6am flight again.</ChatText>
				</ChatMessage>
			</RevealItem>
			<RevealItem>
				<ChatMessage author={authors.tripPlanner} time="7:15pm">
					<ChatText>6:40pm it is. It lands in time for dinner.</ChatText>
					<ChatApproval
						who="Trip Planner wants to use Flights"
						action="Book 4 seats on the 6:40pm"
						mark="F"
						decision={approval}
						outcomes={outcomes}
						onDecide={onDecide}
					/>
					<AnimatePresence initial={false}>
						{approval !== "pending" && (
							<RevealItem key={approval} initial="hidden" animate="visible" exit="hidden">
								<ChatText>{replyToDecision[approval]}</ChatText>
							</RevealItem>
						)}
					</AnimatePresence>
				</ChatMessage>
			</RevealItem>
		</>
	);
}

/** A bill split between housemates, then a message for people that the bot leaves alone. */
function FlatMessages() {
	return (
		<>
			<ChatDay>Yesterday</ChatDay>
			<RevealItem>
				<ChatMessage author={authors.tom} time="8:40am">
					<ChatText>Council moved the bins to Tuesdays btw</ChatText>
				</ChatMessage>
			</RevealItem>
			<RevealItem>
				<ChatMessage author={authors.jess} time="8:52am">
					<ChatText>Noted. Fridays were better</ChatText>
				</ChatMessage>
			</RevealItem>
			<RevealItem>
				<ChatMessage author={authors.billSplitter} time="9:00am">
					<ChatText>The internet's due Friday, $12 each. You and Tom have paid.</ChatText>
					<ChatRoutineNote routine="Bills due" />
				</ChatMessage>
			</RevealItem>
			<RevealItem>
				<ChatMessage author={authors.jess} time="9:20am">
					<ChatText>Payday's tomorrow, I'll sort it then</ChatText>
				</ChatMessage>
			</RevealItem>
			<ChatDay>Today</ChatDay>
			<RevealItem>
				<ChatMessage author={authors.tom} time="6:02pm">
					<ChatText>Power bill's in. $186 for the quarter</ChatText>
				</ChatMessage>
			</RevealItem>
			<RevealItem>
				<ChatMessage author={authors.billSplitter} time="6:02pm">
					<ChatToolLine>Used Sheets for 2s</ChatToolLine>
					<ChatText>
						That's $62 each. It's on the sheet, and Jess still owes $12 for the internet.
					</ChatText>
				</ChatMessage>
			</RevealItem>
			<RevealItem>
				<ChatMessage author={authors.jess} time="6:10pm">
					<ChatText>Paying both now. @tom it's your bins week, they go out tonight</ChatText>
				</ChatMessage>
			</RevealItem>
			<RevealItem>
				<ChatMessage author={authors.tom} time="6:11pm">
					<ChatText>On it</ChatText>
				</ChatMessage>
			</RevealItem>
		</>
	);
}

/** A private morning brief from a routine, and an errand handed back. */
function PersonalMessages() {
	return (
		<>
			<ChatDay>Yesterday</ChatDay>
			<RevealItem>
				<ChatMessage author={authors.you} time="6:05pm">
					<ChatText>What's on tomorrow?</ChatText>
				</ChatMessage>
			</RevealItem>
			<RevealItem>
				<ChatMessage author={authors.daybook} time="6:05pm">
					<ChatToolLine>Used Calendar for 1s</ChatToolLine>
					<ChatText>The dentist at 11, and Priya's farewell drinks at 5.</ChatText>
				</ChatMessage>
			</RevealItem>
			<RevealItem>
				<ChatMessage author={authors.you} time="9:12pm">
					<ChatText>Remind me to book the car service before the long weekend</ChatText>
				</ChatMessage>
			</RevealItem>
			<RevealItem>
				<ChatMessage author={authors.daybook} time="9:12pm">
					<ChatText>I'll remind you on Thursday at 9am.</ChatText>
				</ChatMessage>
			</RevealItem>
			<ChatDay>Today</ChatDay>
			<RevealItem>
				<ChatMessage author={authors.daybook} time="7:30am">
					<ChatToolLine>Used Gmail and Calendar for 4s</ChatToolLine>
					<ChatText>
						Three things today: the landlord wants a time for the boiler check, your passport
						renewal is due in two weeks, and it's Sam's birthday on Friday.
					</ChatText>
					<ChatRoutineNote routine="Morning brief" />
				</ChatMessage>
			</RevealItem>
			<RevealItem>
				<ChatMessage author={authors.you} time="7:41am">
					<ChatText>
						Tell the landlord Thursday morning works, and remind me about Sam's present tomorrow
					</ChatText>
				</ChatMessage>
			</RevealItem>
			<RevealItem>
				<ChatMessage author={authors.daybook} time="7:41am">
					<ChatToolLine>Used Gmail for 3s</ChatToolLine>
					<ChatText>Sent. I'll remind you about Sam's present at 9 tomorrow.</ChatText>
				</ChatMessage>
			</RevealItem>
		</>
	);
}

function PodRail({
	selected,
	unread,
	onSelect,
}: {
	selected: PodName;
	/** Whether the unread pod still has its unread messages. */
	unread: boolean;
	onSelect: (pod: PodName) => void;
}) {
	return (
		<nav
			aria-label="Pods"
			className="hidden w-17 shrink-0 flex-col items-center gap-3 border-r bg-background py-4 sm:flex"
		>
			{pods.map((pod) => (
				<div key={pod.name} className="relative flex items-center">
					{pod.name === selected && (
						<span className="absolute -left-3.5 h-6 w-1 rounded-r-full bg-foreground" />
					)}
					<button
						type="button"
						aria-label={pod.name}
						aria-current={pod.name === selected ? "page" : undefined}
						onClick={() => onSelect(pod.name)}
						className="rounded-xl transition-transform hover:scale-105 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
					>
						<PodIcon tint={pod.tint} bots={pod.bots} />
					</button>
					{pod.name === UNREAD_POD && unread && (
						<Badge
							variant="brand"
							className="pointer-events-none absolute -top-1.5 -right-1.5 ring-3 ring-background"
						>
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

/**
 * The app's message box, drawn empty: the demo only plays its scripted chats, so
 * there is nothing to type and nothing to send.
 */
function Composer({ bot, sharedWithPeople }: { bot: BotAuthor; sharedWithPeople: boolean }) {
	return (
		<div aria-hidden className="shrink-0 px-4 pb-4 sm:px-5">
			<div className="flex flex-col rounded-xl border bg-background">
				<p className="px-3 pt-3 pb-1.5 text-[15px] leading-[22px] text-muted-foreground">
					Message {bot.name}
				</p>
				<div className="flex items-center gap-0.5 px-1.5 pt-1 pb-1.5 text-muted-foreground">
					<span className="grid size-[30px] place-items-center">
						<AtSignIcon className="size-4" />
					</span>
					{sharedWithPeople && (
						<span className="grid size-[30px] place-items-center">
							<UsersRoundIcon className="size-4" />
						</span>
					)}
					<span className="flex-1" />
					<span className="pr-2 text-xs max-sm:hidden">Enter to send</span>
					<span className="grid size-[30px] place-items-center rounded-[8px] bg-muted">
						<SendIcon className="size-[15px]" />
					</span>
				</div>
			</div>
		</div>
	);
}

/** How close to its end a chat counts as read to the end, so what arrives next keeps it there. */
const AT_END_SLACK_PX = 24;

/**
 * A chat's messages in a scrolling window, opened at the latest of them and
 * kept there as more are added, like a reply after an approval, unless the
 * reader has scrolled up. A short chat sits at the foot of the window. The
 * window takes focus itself, so a keyboard can scroll a chat with no buttons.
 */
function ScrolledToEnd({ label, children }: { label: string; children: ReactNode }) {
	const scroller = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const scrollElement = scroller.current;
		const contentElement = content.current;
		if (!scrollElement || !contentElement) return;
		const scrollToEnd = () => {
			scrollElement.scrollTop = scrollElement.scrollHeight;
		};
		scrollToEnd();
		let atEnd = true;
		const noteWhetherAtEnd = () => {
			const below =
				scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight;
			atEnd = below < AT_END_SLACK_PX;
		};
		const followGrowth = new ResizeObserver(() => {
			if (atEnd) scrollToEnd();
		});
		scrollElement.addEventListener("scroll", noteWhetherAtEnd);
		followGrowth.observe(contentElement);
		return () => {
			scrollElement.removeEventListener("scroll", noteWhetherAtEnd);
			followGrowth.disconnect();
		};
	}, []);
	return (
		<div
			ref={scroller}
			role="log"
			aria-label={label}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region needs focus for keyboard scrolling.
			tabIndex={0}
			className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-width:thin] focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset"
		>
			<div ref={content} className="mt-auto">
				{children}
			</div>
		</div>
	);
}

/** A demo of the app with a chat open in each pod, chosen from the rail. */
export function PodChat() {
	const [selected, setSelected] = useState<PodName>(FIRST_POD);
	const [unreadSeen, setUnreadSeen] = useState(false);
	const [switched, setSwitched] = useState(false);
	const [approval, setApproval] = useState<ApprovalDecision>("pending");
	const { bot, description, sharedWithPeople, Messages } = conversations[selected];

	function select(pod: PodName) {
		setSelected(pod);
		setSwitched(true);
		if (pod === UNREAD_POD) setUnreadSeen(true);
	}

	return (
		<Reveal>
			<MotionCard
				variants={riseIn}
				className="flex-row gap-0 overflow-hidden rounded-3xl py-0 shadow-2xl sm:h-170"
			>
				<PodRail selected={selected} unread={!unreadSeen} onSelect={select} />
				<div className="flex min-w-0 flex-1 flex-col">
					<header className="flex h-14 shrink-0 items-center gap-3 border-b px-5">
						<BotAvatar size="sm" {...bot.look} />
						<span className="truncate font-semibold">{bot.name}</span>
						<span aria-hidden className="h-5 w-px shrink-0 bg-border max-sm:hidden" />
						<span className="min-w-0 truncate text-sm text-muted-foreground max-sm:hidden">
							{description}
						</span>
					</header>
					{/*
					 * The first conversation plays out once the window has settled into place. One opened
					 * from the rail is simply there, as a chat is when you switch to it.
					 */}
					<ScrolledToEnd key={selected} label={`Chat with ${bot.name}`}>
						<Reveal
							stagger={FIRST_CHAT_STAGGER_S}
							delay={FIRST_CHAT_DELAY_S}
							initial={switched ? "visible" : "hidden"}
							className="flex flex-col gap-4 px-4 py-5 sm:px-6"
						>
							<Messages approval={approval} onDecide={setApproval} />
						</Reveal>
					</ScrolledToEnd>
					<Composer bot={bot} sharedWithPeople={sharedWithPeople} />
				</div>
			</MotionCard>
		</Reveal>
	);
}
