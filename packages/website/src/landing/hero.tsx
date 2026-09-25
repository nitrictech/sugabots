import { botCrowd } from "@sugabots/avatars";
import { ArrowRightIcon, ArrowUpRightIcon } from "lucide-react";
import { motion } from "motion/react";
import { accentText } from "@/components/accent";
import { BotAvatar } from "@/components/bot-avatar";
import { EarlyAccessButton } from "@/components/early-access-button";
import { Emphasis } from "@/components/emphasis";
import { Reveal, RevealItem, riseIn } from "@/components/reveal";
import { Button } from "@/components/ui/button";
import { launched, siteLinks } from "@/site-links";

/** The bot crowd, drawn inline so each face can pop in. Poses assume a 40px face. */
function BotCrowd() {
	return (
		<Reveal stagger={0.05} className="flex flex-wrap items-center gap-2 py-2.5" aria-hidden>
			{botCrowd.map(({ rotate, lift, ...look }) => (
				<RevealItem key={look.color} variant="pop" style={{ rotate, y: -lift }}>
					<BotAvatar size="lg" {...look} />
				</RevealItem>
			))}
		</Reveal>
	);
}

export function Hero() {
	return (
		<section className="pt-12 pb-10">
			<Reveal delay={0.2} className="flex flex-col gap-5">
				<BotCrowd />
				<motion.h1
					variants={riseIn}
					className="text-5xl font-black leading-none tracking-tighter text-balance sm:text-6xl"
				>
					Agents, now <span className={accentText({ tone: "emerald" })}>multiplayer.</span>
				</motion.h1>
				<motion.p
					variants={riseIn}
					className="max-w-2xl text-muted-foreground text-pretty sm:text-lg"
				>
					Sugabots is an open-source harness where <Emphasis>people</Emphasis> and{" "}
					<Emphasis>agents</Emphasis> work together. Give each group its own agents, on the models
					you choose.
				</motion.p>
				<RevealItem className="flex flex-wrap items-center gap-3">
					<Button size="lg" nativeButton={false} render={<a href={siteLinks.getStarted} />}>
						Start a pod
						<ArrowRightIcon data-icon="inline-end" />
					</Button>
					{launched ? (
						<Button
							size="lg"
							variant="outline"
							nativeButton={false}
							render={<a href={siteLinks.github} />}
						>
							View on GitHub
							<ArrowUpRightIcon data-icon="inline-end" />
						</Button>
					) : (
						<EarlyAccessButton size="lg" variant="outline" />
					)}
				</RevealItem>
			</Reveal>
		</section>
	);
}
