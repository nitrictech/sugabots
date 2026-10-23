import { cn } from "cn";
import type { PointerEvent, ReactNode } from "react";
import { type CallToAction, trackCallToActionClick } from "@/analytics";
import { callToAction } from "@/landing/call-to-action";
import { SectionHeading } from "@/landing/section-heading";
import { siteColumn } from "@/layout";
import { siteLinks } from "@/site-links";

/** "Run it yourself, or let us.": self-hosting today beside the hosted version to come. */
export function PlansSection() {
	return (
		<section id="plans" className={cn(siteColumn, "flex flex-col gap-12 pt-40 sm:pt-[260px]")}>
			<SectionHeading
				title="Run it yourself, or let us."
				lede="Same app either way. Start on your own machine today, or get on the list for the hosted version."
			/>
			<div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))] gap-5">
				<Plan
					name="Self-host"
					summary="Run it on your laptop or your own cloud with Docker. Free, with your own model keys."
				>
					<div>
						<PlanLink href={siteLinks.selfHost} cta="self_host" variant="primary">
							Self-host it
						</PlanLink>
					</div>
				</Plan>
				<Plan
					name="Hosted"
					summary="We run the servers and sandboxes, you bring your keys. Move over from self-hosted when it's ready."
					badge="Coming soon"
				>
					<div>
						<PlanLink href={siteLinks.waitlist} cta="waitlist" variant="secondary">
							Join the waitlist
						</PlanLink>
					</div>
				</Plan>
			</div>
		</section>
	);
}

interface PlanProps {
	name: string;
	/** What it is, in a sentence. */
	summary: string;
	/** A note beside the name, such as when it arrives. */
	badge?: string;
	/** What it leads to: its call to action. */
	children: ReactNode;
}

/** Keeps the card's glow under the pointer, as CSS variables, so following it never re-renders. */
function followPointer(event: PointerEvent<HTMLDivElement>) {
	const card = event.currentTarget;
	const { left, top } = card.getBoundingClientRect();
	card.style.setProperty("--pointer-x", `${event.clientX - left}px`);
	card.style.setProperty("--pointer-y", `${event.clientY - top}px`);
}

function Plan({ name, summary, badge, children }: PlanProps) {
	return (
		<div
			onPointerMove={followPointer}
			className="group relative isolate flex flex-col gap-6 overflow-hidden rounded-[20px] border border-landing-frame bg-landing-card p-8"
		>
			{/* A glow under the pointer, faded in while it's over the card. */}
			<span
				aria-hidden
				className="pointer-events-none absolute inset-0 -z-10 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
				style={{
					background:
						"radial-gradient(420px circle at var(--pointer-x, 50%) var(--pointer-y, 50%), color-mix(in oklch, var(--color-landing-accent) 22%, transparent), transparent 70%)",
				}}
			/>
			<div className="flex flex-col gap-2">
				<div className="flex items-start justify-between gap-4">
					<h3 className="text-[21px]/[1.25] font-semibold tracking-[-0.01em]">{name}</h3>
					{badge && (
						<span className="shrink-0 rounded-full border border-landing-accent/40 bg-landing-accent/15 px-2.5 py-0.5 text-xs font-semibold text-landing-link">
							{badge}
						</span>
					)}
				</div>
				<p className="max-w-md text-[15px]/[1.55] text-pretty text-landing-muted">{summary}</p>
			</div>
			<div className="mt-auto flex flex-col gap-5">{children}</div>
		</div>
	);
}

function PlanLink({
	href,
	cta,
	variant,
	children,
}: {
	href: string;
	cta: CallToAction;
	variant: "primary" | "secondary";
	children: ReactNode;
}) {
	return (
		<a
			href={href}
			onClick={() => trackCallToActionClick(cta, "plans")}
			className={callToAction({ variant })}
		>
			{children}
		</a>
	);
}
