import { botCrowd } from "@sugabots/avatars";
import { ArrowRightIcon, ArrowUpRightIcon } from "lucide-react";
import { motion } from "motion/react";
import { accentText } from "@/components/accent";
import { BotAvatar } from "@/components/bot-avatar";
import { EarlyAccessLink } from "@/components/early-access-link";
import { Emphasis } from "@/components/emphasis";
import { Reveal, RevealItem, riseIn } from "@/components/reveal";
import { buttonVariants } from "@/components/ui/button";
import { launched, siteLinks } from "@/site-links";
import { siteMeta } from "@/site-meta";

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
					className="text-5xl leading-13 font-black tracking-tight text-balance sm:text-6xl sm:leading-16"
				>
					<span className={accentText({ tone: "emerald" })}>{siteMeta.headline.accent}</span>{" "}
					{siteMeta.headline.rest}.
				</motion.h1>
				<motion.p
					variants={riseIn}
					className="max-w-2xl text-muted-foreground text-pretty sm:text-lg"
				>
					Sugabots is a place where <Emphasis>people</Emphasis> and <Emphasis>agents</Emphasis> can
					work together. Give each group its own agents, on the models you choose. It's also{" "}
					<Emphasis>open-source</Emphasis>.
				</motion.p>
				<RevealItem className="flex flex-wrap items-center gap-3">
					<a href={siteLinks.getStarted} className={buttonVariants({ size: "lg" })}>
						Start a pod
						<ArrowRightIcon data-icon="inline-end" />
					</a>
					{launched ? (
						<a
							href={siteLinks.github}
							className={buttonVariants({ variant: "outline", size: "lg" })}
						>
							View on GitHub
							<ArrowUpRightIcon data-icon="inline-end" />
						</a>
					) : (
						<EarlyAccessLink size="lg" variant="outline" />
					)}
				</RevealItem>
			</Reveal>
		</section>
	);
}
