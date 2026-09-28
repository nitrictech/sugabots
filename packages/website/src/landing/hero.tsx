import { ArrowRightIcon, ArrowUpRightIcon } from "lucide-react";
import { motion } from "motion/react";
import { trackCallToActionClick } from "@/analytics";
import { accentText } from "@/components/accent";
import { BotCrowd } from "@/components/bot-crowd";
import { Emphasis } from "@/components/emphasis";
import { JoinDiscordLink } from "@/components/join-discord-link";
import { Reveal, RevealItem, riseIn } from "@/components/reveal";
import { buttonVariants } from "@/components/ui/button";
import { launched, siteLinks } from "@/site-links";
import { siteMeta } from "@/site-meta";

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
				{launched ? (
					<RevealItem className="flex flex-wrap items-center gap-3">
						<a
							href={siteLinks.getStarted}
							onClick={() => trackCallToActionClick("get_started", "hero")}
							className={buttonVariants({ size: "lg" })}
						>
							Start a pod
							<ArrowRightIcon data-icon="inline-end" />
						</a>
						<a
							href={siteLinks.github}
							onClick={() => trackCallToActionClick("github", "hero")}
							className={buttonVariants({ variant: "outline", size: "lg" })}
						>
							View on GitHub
							<ArrowUpRightIcon data-icon="inline-end" />
						</a>
					</RevealItem>
				) : (
					<RevealItem className="flex flex-wrap items-center gap-x-4 gap-y-3">
						<JoinDiscordLink placement="hero" size="lg" />
						<span className="text-sm text-muted-foreground">Releasing soon.</span>
					</RevealItem>
				)}
			</Reveal>
		</section>
	);
}
