import { PlayIcon } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { trackVideoPlay } from "@/analytics";
import { demoVideo } from "@/landing/media";
import { captureFor, ForVisitorOs, type VisitorOs, visitorOs } from "@/landing/visitor-os";

const TITLE = "Sugabots demo";

/**
 * The demo video under the hero, playing on a loop as the page opens, except
 * for visitors who ask for reduced motion; until there is one, its poster
 * frame with a note of how long it runs.
 */
export function DemoVideo() {
	const reduceMotion = useReducedMotion();
	// Which system's recording to play is only known in the browser; until then, its poster shows.
	const [os, setOs] = useState<VisitorOs>();
	useEffect(() => setOs(visitorOs()), []);
	return (
		<div
			id="demo"
			className="overflow-hidden rounded-[18px] border border-landing-frame bg-landing-card shadow-[0_30px_90px_rgba(0,0,0,0.55)]"
		>
			{demoVideo.src !== undefined && os !== undefined ? (
				<video
					src={captureFor(demoVideo.src, os)}
					poster={demoVideo.poster && captureFor(demoVideo.poster, os)}
					title={TITLE}
					controls
					disablePictureInPicture
					autoPlay={!reduceMotion}
					loop
					muted
					playsInline
					preload={reduceMotion ? "metadata" : "auto"}
					onPlay={trackVideoPlay}
					className="block aspect-video w-full bg-black"
				/>
			) : demoVideo.src !== undefined ? (
				<Poster />
			) : (
				<PosterFrame />
			)}
		</div>
	);
}

/** The visitor's system's poster, at the video's size, while the page works out which recording to play. */
function Poster() {
	const { poster } = demoVideo;
	return (
		<div className="aspect-video bg-black">
			{poster && (
				<ForVisitorOs>
					{(os) => (
						<img
							src={captureFor(poster, os)}
							alt=""
							width={1920}
							height={1080}
							loading="lazy"
							className="block size-full object-cover"
						/>
					)}
				</ForVisitorOs>
			)}
		</div>
	);
}

function PosterFrame() {
	return (
		<div className="relative aspect-video">
			{demoVideo.poster && (
				<img
					src={demoVideo.poster}
					alt=""
					width={1920}
					height={1080}
					className="size-full object-cover"
				/>
			)}
			<div className="pointer-events-none absolute bottom-3.5 left-4 flex items-center gap-2.5">
				<span className="grid size-12 place-items-center rounded-full border border-white/14 bg-landing-page/72 backdrop-blur-sm">
					<PlayIcon className="size-[18px] fill-white text-white" />
				</span>
				<span className="rounded-md bg-landing-page/72 px-2.5 py-[5px] text-sm font-medium text-landing-text">
					Watch the demo
				</span>
			</div>
			<span className="pointer-events-none absolute right-4 bottom-3.5 rounded-md bg-landing-page/72 px-2 py-1 font-mono text-xs font-medium text-landing-button-text">
				{demoVideo.duration}
			</span>
		</div>
	);
}
