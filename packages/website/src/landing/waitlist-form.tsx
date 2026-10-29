import { useEffect, useRef } from "react";
import { trackWaitlistSignUp } from "@/analytics";

const PARLEY_EMBED_URL = "https://app.parley.page/embed.js";
/** The "Sugabots Waitlist" form in Parley, where its fields and colours are set. */
const WAITLIST_FORM_ID = "752cbec5-c537-4278-a201-d72912b52fd5";

/** What Parley's embed script puts on `window` once it has loaded. */
interface Parley {
	form(
		target: Element,
		options: { form: string; title?: string; onSubmit?: () => void },
	): HTMLIFrameElement;
}

declare global {
	interface Window {
		Parley?: Parley;
	}
}

let parleyLoading: Promise<Parley> | undefined;

/** Loads Parley's embed script once per page, however many times it's asked for. */
function loadParley(): Promise<Parley> {
	parleyLoading ??= new Promise((resolve, reject) => {
		const script = document.createElement("script");
		script.src = PARLEY_EMBED_URL;
		script.async = true;
		script.onload = () => (window.Parley ? resolve(window.Parley) : reject());
		script.onerror = reject;
		document.head.append(script);
	});
	return parleyLoading;
}

/** The hosted version's waitlist sign-up, drawn by Parley in an iframe that sizes itself to the form. */
export function WaitlistForm({ onSubmit }: { onSubmit?: () => void }) {
	const container = useRef<HTMLDivElement>(null);
	// Read when the form is sent, so the form isn't remounted each time the caller passes a new function.
	const latestOnSubmit = useRef(onSubmit);
	latestOnSubmit.current = onSubmit;

	useEffect(() => {
		let frame: HTMLIFrameElement | undefined;
		let unmounted = false;
		loadParley().then(
			(parley) => {
				if (unmounted || !container.current) return;
				frame = parley.form(container.current, {
					form: WAITLIST_FORM_ID,
					title: "Join the waitlist",
					onSubmit: () => {
						trackWaitlistSignUp();
						latestOnSubmit.current?.();
					},
				});
				// Parley's form page declares no colour scheme, so it's light. A frame whose scheme
				// differs from its page is painted on an opaque backdrop, which hides see-through forms.
				frame.style.colorScheme = "light";
			},
			() => {
				// Blocked by the visitor or failed to load: leave the card without a form, and try again next mount.
				parleyLoading = undefined;
			},
		);
		return () => {
			unmounted = true;
			frame?.remove();
		};
	}, []);

	return <div ref={container} />;
}
