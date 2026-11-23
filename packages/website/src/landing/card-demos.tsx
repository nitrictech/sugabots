import { StillBotFace } from "@sugabots/avatars";
import type { BuiltInProviderId } from "@sugabots/contracts";
import { providerLogos } from "@sugabots/provider-logos";
import { cn } from "cn";
import { CheckIcon, XIcon } from "lucide-react";
import { useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { cast } from "@/cast";
import { StripeIcon } from "@/components/brand-icons";
import type { ChatBot } from "@/components/chat";
import { arrive, MessageRow } from "@/landing/chat-parts";

const demoArea =
	// A little taller on phones, where the messages wrap onto more lines.
	"relative flex h-68 flex-col rounded-xl border border-landing-line bg-landing-page sm:h-64";

/** Gary asks, Growth Desk drafts, and Lorraine replies; the visitor can add their own 👍 to the draft. */
export function ChatDemo() {
	const [reacted, setReacted] = useState(false);

	return (
		// As tall as its three messages, so there's no gap above Gary's.
		<div className={cn(demoArea, "h-auto gap-3 overflow-hidden p-4 sm:h-auto sm:px-5")}>
			<MessageRow
				author={cast.gary}
				time="6:02"
				text="Fernhill replied about pricing. Can someone draft the answer?"
			/>
			<MessageRow
				author={cast.growthDesk}
				time="6:03"
				text="Drafted. It’s in the chat with their usage numbers."
			>
				<button
					type="button"
					aria-pressed={reacted}
					aria-label={reacted ? "Remove your 👍" : "React with 👍"}
					onClick={() => setReacted((was) => !was)}
					className={cn(
						"mt-1 flex h-6 items-center gap-1.25 self-start rounded-lg border px-2 text-xs font-medium tabular-nums transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-landing-accent",
						reacted
							? "border-landing-text bg-landing-button text-landing-text"
							: "border-transparent bg-landing-chip text-landing-secondary hover:border-landing-control",
					)}
				>
					👍 {reacted ? 3 : 2}
				</button>
			</MessageRow>
			<MessageRow
				author={cast.lorraine}
				time="6:04"
				text="Hold it until I’ve spoken to their team tomorrow."
			/>
		</div>
	);
}

type Answer = "waiting" | "allowed" | "denied";

/** The app's approval request: Ticket Desk asks to refund a payment, and the visitor answers it. */
export function ApprovalDemo() {
	const [answer, setAnswer] = useState<Answer>("waiting");

	return (
		<div className={cn(demoArea, "justify-center p-4 sm:p-6")}>
			<div className="flex min-w-0 flex-col gap-2.5 rounded-3xl bg-landing-bubble py-2.5 pr-3 pb-3 pl-2.5 text-landing-text">
				<div className="flex min-w-0 items-start gap-2.5">
					<span className="mt-px grid size-6 shrink-0 place-items-center rounded-md bg-landing-stripe text-landing-text-strong">
						<StripeIcon className="size-3.25" />
					</span>
					<div className="flex min-w-0 flex-col gap-0.5">
						<span className="text-xs/snug text-landing-muted">
							{cast.ticketDesk.name} wants to use Stripe
						</span>
						<span className="text-sm/snug font-medium">Refund payment</span>
					</div>
				</div>
				<dl className="ml-8.5 grid min-w-0 grid-cols-capped-label items-baseline gap-x-4 gap-y-0.5 border-l-2 border-landing-rule pl-2.5 text-sm/snug">
					<dt className="min-w-18 py-0.5 text-landing-muted">Customer</dt>
					<dd className="py-0.5">Kestrel Freight</dd>
					<dt className="min-w-18 py-0.5 text-landing-muted">Amount</dt>
					<dd className="py-0.5">$1,280</dd>
					<dt className="min-w-18 py-0.5 text-landing-muted">Reason</dt>
					<dd className="py-0.5">Charged twice on 3 Oct</dd>
				</dl>
				<div className="ml-8.5 flex min-h-8 items-center">
					{answer === "waiting" ? (
						<fieldset className="flex flex-wrap items-center gap-2 text-xs font-semibold">
							<legend className="sr-only">Answer {cast.ticketDesk.name}’s request</legend>
							<button
								type="button"
								onClick={() => setAnswer("allowed")}
								className="h-7.75 rounded-md bg-landing-pill px-4 text-landing-page transition-colors hover:bg-landing-pill-hover focus-visible:ring-2 focus-visible:ring-landing-accent outline-none"
							>
								Allow
							</button>
							<button
								type="button"
								onClick={() => setAnswer("denied")}
								className="h-7.75 rounded-md bg-landing-button px-4 transition-colors hover:bg-landing-control focus-visible:ring-2 focus-visible:ring-landing-accent outline-none"
							>
								Deny
							</button>
						</fieldset>
					) : (
						<p
							role="status"
							className={cn("flex items-center gap-1.5 text-xs/normal text-landing-muted", arrive)}
						>
							{answer === "allowed" ? (
								<CheckIcon className="size-3 shrink-0" strokeWidth={2.8} />
							) : (
								<XIcon className="size-3 shrink-0" strokeWidth={2.8} />
							)}
							{answer === "allowed" ? "Allowed by you" : "Denied by you"}
							<button
								type="button"
								onClick={() => setAnswer("waiting")}
								className="ml-1.5 font-medium text-landing-app-link underline-offset-2 hover:underline outline-none focus-visible:underline"
							>
								Ask again
							</button>
						</p>
					)}
				</div>
			</div>
		</div>
	);
}

/** The bots' exchange. */
const handoffMessages: readonly { from: ChatBot; time: string; text: string }[] = [
	{
		from: cast.growthDesk,
		time: "6:08",
		text: "Can Brightwater have 25% off the annual tier and still clear our margin?",
	},
	{
		from: cast.pricingAnalyst,
		time: "6:09",
		text: "Yes: $36 a seat is a 72% margin. I’ve drafted quote Q-1182.",
	},
	{ from: cast.growthDesk, time: "6:09", text: "Thanks. Taking it back to Gary." },
];

/** Growth Desk and Pricing Analyst's own exchange, as the app shows a collaboration. */
export function HandoffDemo() {
	return (
		<div className={cn(demoArea, "overflow-hidden")}>
			<div className="flex items-center gap-2 border-b border-landing-line px-4 py-2.5 sm:px-5">
				<span aria-hidden className="flex shrink-0">
					{[cast.growthDesk, cast.pricingAnalyst].map((bot) => (
						<span key={bot.name} className="-mr-1.75">
							<StillBotFace
								{...bot.look}
								ring={{ color: "var(--color-landing-page)", width: 2 }}
								className="block size-5"
							/>
						</span>
					))}
				</span>
				<span className="truncate pl-2 text-xs font-semibold text-landing-text">
					Collaboration with {cast.pricingAnalyst.name}
				</span>
			</div>
			<div className="flex min-h-0 flex-1 flex-col justify-end gap-3 p-4 sm:px-5">
				{handoffMessages.map((message) => (
					<MessageRow
						key={message.text}
						author={message.from}
						time={message.time}
						text={message.text}
					/>
				))}
			</div>
		</div>
	);
}

interface ModelChoice {
	bot: ChatBot;
	job: string;
	model: string;
	provider: string;
	builtIn: BuiltInProviderId;
}

const modelChoices: readonly ModelChoice[] = [
	{
		bot: cast.copywriter,
		job: "Drafts replies, posts and invites",
		model: "ChatGPT",
		provider: "OpenAI",
		builtIn: "chatgpt",
	},
	{
		bot: cast.researcher,
		job: "Reads the long stuff so you don’t have to",
		model: "Claude",
		provider: "Anthropic",
		builtIn: "anthropic",
	},
	{
		bot: cast.inboxSorter,
		job: "Triage, reminders and quick jobs",
		model: "Gemini Flash",
		provider: "Google",
		builtIn: "gemini",
	},
	{
		bot: cast.journal,
		job: "Private notes that stay private",
		model: "Llama",
		provider: "Ollama, local",
		builtIn: "ollama",
	},
];

const HIGHLIGHT_MILLISECONDS = 1800;

/**
 * Four bots on four providers, with the highlight moving down a row at a time
 * while the card is on screen. Hovering a row moves the highlight to it and
 * holds it there; it carries on from that row once the pointer leaves. It
 * stays still for visitors who ask for reduced motion.
 */
export function ModelsDemo() {
	const area = useRef<HTMLDivElement>(null);
	const onScreen = useInView(area);
	const reduceMotion = useReducedMotion();
	const [highlighted, setHighlighted] = useState(0);
	const [hovering, setHovering] = useState(false);

	useEffect(() => {
		if (!onScreen || hovering || reduceMotion) return;
		const interval = setInterval(
			() => setHighlighted((row) => (row + 1) % modelChoices.length),
			HIGHLIGHT_MILLISECONDS,
		);
		return () => clearInterval(interval);
	}, [onScreen, hovering, reduceMotion]);

	return (
		<div
			ref={area}
			onPointerLeave={() => setHovering(false)}
			className={cn(demoArea, "justify-center gap-1 overflow-hidden p-2.5 sm:p-4")}
		>
			{modelChoices.map((choice, index) => (
				<div
					key={choice.bot.name}
					onPointerEnter={() => {
						setHovering(true);
						setHighlighted(index);
					}}
					className={cn(
						"flex items-center gap-3 rounded-xl border px-3 py-1.5 transition-colors duration-260 ease-landing",
						index === highlighted
							? "border-landing-control bg-landing-raised"
							: "border-transparent bg-transparent",
					)}
				>
					<StillBotFace {...choice.bot.look} className="size-7.5" />
					<span className="flex min-w-0 flex-1 flex-col gap-px">
						<span className="truncate text-sm font-semibold text-landing-text">
							{choice.bot.name}
						</span>
						<span className="truncate text-xs text-landing-faint">{choice.job}</span>
					</span>
					{/* One width for every model, wide enough for the longest, so they line up down the card. */}
					<span className="flex w-34 shrink-0 items-center gap-2 rounded-lg border border-landing-frame bg-landing-raised px-2.5 py-1.5">
						<ProviderMark builtIn={choice.builtIn} />
						<span className="flex min-w-0 flex-col leading-tight">
							<span className="truncate text-xs font-medium text-landing-text">{choice.model}</span>
							<span className="truncate text-xs text-landing-faint">{choice.provider}</span>
						</span>
					</span>
				</div>
			))}
		</div>
	);
}

/** A provider's logo in its version for dark backgrounds, since the landing page is always dark. */
function ProviderMark({ builtIn }: { builtIn: BuiltInProviderId }) {
	const logo = providerLogos[builtIn];
	return (
		<img
			src={logo.dark ?? logo.light}
			alt=""
			width={15}
			height={15}
			className={cn("size-3.75 shrink-0 object-contain", logo.scale)}
		/>
	);
}
