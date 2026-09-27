import { cn } from "cn";
import { useEffect, useState } from "react";
import type { Heading } from "@/docs/pages";

/** How far below the viewport's top a heading counts as the one being read, under the sticky header. */
const READING_LINE_PX = 120;

/** The id of the last heading scrolled past the reading line. */
function useCurrentHeading(headings: readonly Heading[]) {
	const [current, setCurrent] = useState(headings[0]?.id);

	useEffect(() => {
		function update() {
			let passed = headings[0]?.id;
			for (const { id } of headings) {
				const element = document.getElementById(id);
				if (element && element.getBoundingClientRect().top <= READING_LINE_PX) passed = id;
			}
			setCurrent(passed);
		}
		update();
		window.addEventListener("scroll", update, { passive: true });
		return () => window.removeEventListener("scroll", update);
	}, [headings]);

	return current;
}

/** The page's sections, with the one being read marked. */
export function OnThisPage({ headings }: { headings: readonly Heading[] }) {
	const current = useCurrentHeading(headings);
	if (headings.length === 0) return null;

	return (
		<nav aria-label="On this page">
			<p className="pb-3 text-sm font-semibold">On this page</p>
			<ul className="flex flex-col border-l">
				{headings.map(({ id, text }) => (
					<li key={id}>
						<a
							href={`#${id}`}
							aria-current={id === current ? "location" : undefined}
							className={cn(
								"-ml-px block border-l-2 border-transparent py-1 pl-3 text-sm text-muted-foreground transition-colors hover:text-foreground",
								id === current && "border-brand font-medium text-foreground",
							)}
						>
							{text}
						</a>
					</li>
				))}
			</ul>
		</nav>
	);
}
