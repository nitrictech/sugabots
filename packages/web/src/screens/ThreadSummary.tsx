import type { ThreadDetails, ThreadParticipant } from "@sugabots/contracts";
import { CalendarDays, ChevronDown, Clock3, Sparkles } from "lucide-react";
import { useThreadPanel } from "@/lib/thread-panel.tsx";
import { InsetCard, InsetCardHeading } from "@/ui/inset-card.tsx";
import { ScribeNotSetUp } from "./BuiltInAgentSetup.tsx";
import { UsageMeasurements, usageSummary } from "./ThreadUsage.tsx";

type AgentParticipant = Extract<ThreadParticipant, { kind: "agent" }>;

export function ThreadSummaryRail({
	details,
	host,
}: {
	details: ThreadDetails;
	host: AgentParticipant;
}) {
	const { summaryOpen } = useThreadPanel();
	if (!summaryOpen) {
		return null;
	}
	return (
		<aside
			aria-labelledby="chat-summary-heading"
			className="hidden w-[340px] shrink-0 flex-col overflow-y-auto border-border-subtle border-l px-[18px] py-5 xl:flex"
		>
			<div className="mb-4 flex min-h-9 items-center">
				<h2
					id="chat-summary-heading"
					className="font-semibold text-subtle-foreground text-xs uppercase tracking-[0.06em]"
				>
					Chat summary
				</h2>
			</div>
			<ThreadSummaryContent details={details} host={host} />
		</aside>
	);
}

export function ThreadSummaryDisclosure({
	details,
	host,
}: {
	details: ThreadDetails;
	host: AgentParticipant;
}) {
	const { summaryOpen, setSummaryOpen } = useThreadPanel();
	return (
		<details
			open={summaryOpen}
			onToggle={(event) => setSummaryOpen(event.currentTarget.open)}
			className="pod mb-7 rounded-[14px] border border-border-subtle bg-sunken xl:hidden"
		>
			<summary className="focus-ring sticky top-0 z-10 flex min-h-12 cursor-pointer list-none items-center gap-2 rounded-2xl bg-sunken px-4 font-semibold text-heading text-md [&::-webkit-details-marker]:hidden">
				<Sparkles aria-hidden size={15} className="text-primary" />
				<span className="flex-1">Chat summary</span>
				<span className="font-normal text-subtle-foreground text-xs group-open:hidden">
					{details.summary ? summaryFreshness(details) : usageSummary(details.usage)}
				</span>
				<ChevronDown
					aria-hidden
					size={14}
					className="text-subtle-foreground transition-transform group-open:rotate-180"
				/>
			</summary>
			<div className="border-border-subtle border-t p-3">
				<ThreadSummaryContent details={details} host={host} />
			</div>
		</details>
	);
}

function ThreadSummaryContent({
	details,
	host,
}: {
	details: ThreadDetails;
	host: AgentParticipant;
}) {
	return (
		<div className="flex flex-col gap-[11px]">
			<SummarySnapshot details={details} />
			<UsageMeasurements usage={details.usage} />
			<ThreadMetadata details={details} host={host} />
		</div>
	);
}

function SummarySnapshot({ details }: { details: ThreadDetails }) {
	return (
		<InsetCard className="px-4 py-4">
			<InsetCardHeading icon={<Sparkles aria-hidden size={14} className="text-primary" />}>
				Summary
			</InsetCardHeading>
			{/* `=== false`, not `!`: the field is optional, and an absent one means
			    the API did not say rather than that the Scribe is unset. */}
			{details.summaryEnabled === false ? (
				<ScribeNotSetUp />
			) : details.summary ? (
				<>
					<p className="m-0 pt-3 text-foreground text-base leading-relaxed">
						{details.summary.content}
					</p>
					<div className="flex items-center gap-1.5 pt-3 text-subtle-foreground text-xs">
						<Clock3 aria-hidden size={13} className="text-primary" />
						{summaryFreshness(details)}
					</div>
				</>
			) : (
				<p className="m-0 pt-3 text-muted-foreground text-base leading-relaxed">
					A summary will appear after the first agent reply.
				</p>
			)}
		</InsetCard>
	);
}

function ThreadMetadata({ details, host }: { details: ThreadDetails; host: AgentParticipant }) {
	return (
		<InsetCard className="px-4 py-4">
			<InsetCardHeading icon={<CalendarDays aria-hidden size={14} />}>Chat</InsetCardHeading>
			<dl className="m-0 grid grid-cols-[76px_minmax(0,1fr)] gap-x-3 gap-y-2 pt-3 text-md">
				<dt className="text-muted-foreground">Started</dt>
				<dd className="m-0 text-heading">{formatStarted(details.thread.createdAt)}</dd>
				<dt className="flex items-center gap-1.5 text-muted-foreground">
					<span>Messages</span>
				</dt>
				<dd className="m-0 text-heading tabular-nums">{details.messages.length}</dd>
				<dt className="text-muted-foreground">Host</dt>
				<dd className="m-0 truncate text-heading" title={host.name}>
					{host.name}
				</dd>
			</dl>
		</InsetCard>
	);
}

function summaryFreshness(details: ThreadDetails): string {
	const summary = details.summary;
	if (!summary) {
		return "Not generated yet";
	}
	const latestMessage = details.messages.at(-1);
	if (latestMessage && latestMessage.id !== summary.sourceMessageId) {
		return "Updating after new messages";
	}
	return `Updated ${new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(new Date(summary.updatedAt))}`;
}

function formatStarted(createdAt: string): string {
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(new Date(createdAt));
}
