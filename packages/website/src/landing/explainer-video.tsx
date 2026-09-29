import { PlayIcon } from "lucide-react";
import { useState } from "react";
import { MotionCard, Reveal, riseIn } from "@/components/reveal";

const YOUTUBE_VIDEO_ID = "faNgsMcrnnU";
const TITLE = "Meet Sugabots, the multiplayer AI harness";

/**
 * The 90-second film, on YouTube. Until someone presses play it is only our
 * poster, so the page loads nothing from YouTube and stays cookie-free; the
 * player, from YouTube's no-cookie domain, replaces it and starts playing.
 */
export function ExplainerVideo() {
	const [playing, setPlaying] = useState(false);

	return (
		// Arrives after the hero's headline and lede, which start 0.2s in.
		<Reveal delay={0.4}>
			<MotionCard
				variants={riseIn}
				className="relative aspect-video overflow-hidden rounded-3xl bg-black py-0 shadow-2xl"
			>
				{playing ? (
					<iframe
						src={`https://www.youtube-nocookie.com/embed/${YOUTUBE_VIDEO_ID}?autoplay=1&rel=0`}
						title={TITLE}
						allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
						referrerPolicy="strict-origin-when-cross-origin"
						ref={focusPlayer}
						className="absolute inset-0 size-full"
					/>
				) : (
					<button
						type="button"
						onClick={() => setPlaying(true)}
						aria-label={`Watch video: ${TITLE}`}
						className="group absolute inset-0 cursor-pointer outline-none"
					>
						<picture className="block size-full">
							<source srcSet="/sugabots-film-poster.avif" type="image/avif" />
							<img
								src="/sugabots-film-poster.jpg"
								alt=""
								width={1280}
								height={720}
								className="size-full object-cover"
							/>
						</picture>
						{/* In a corner, clear of the logo and tagline in the middle of the poster. */}
						<span className="absolute bottom-3 left-3 flex items-center gap-2 rounded-full bg-white/90 py-2 pr-4 pl-3 text-sm font-semibold text-black shadow-xl transition-transform group-hover:scale-105 group-focus-visible:ring-4 group-focus-visible:ring-ring sm:bottom-6 sm:left-6">
							<PlayIcon className="size-4 fill-current" />
							Watch video
						</span>
					</button>
				)}
			</MotionCard>
		</Reveal>
	);
}

/**
 * Moves focus from the play button, which the player replaces, to the player,
 * so keyboard and screen-reader users stay where they were on the page.
 */
function focusPlayer(player: HTMLIFrameElement | null) {
	player?.focus();
}
