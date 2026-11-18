import "@fontsource-variable/rubik";
import "../page.css";
import logoUrl from "@sugabots/avatars/sugabots-logo.svg";
import { element } from "../element.ts";
import type { UnreachableBridge } from "./bridge.ts";

declare global {
	interface Window {
		readonly unreachable: UnreachableBridge;
	}
}

const retry = element("#retry", HTMLButtonElement);
const status = element("#status", HTMLParagraphElement);
const query = new URLSearchParams(location.search);

element(".logo", HTMLImageElement).src = logoUrl;
element("#host", HTMLSpanElement).textContent = query.get("host") ?? "the server";
element("#error", HTMLParagraphElement).textContent = query.get("error") ?? "";

retry.addEventListener("click", async () => {
	retry.disabled = true;
	retry.textContent = "Trying…";
	status.textContent = "";
	if (await window.unreachable.retry()) return;
	retry.disabled = false;
	retry.textContent = "Try again";
	status.textContent = "Still can't reach it.";
});

element("#switch", HTMLButtonElement).addEventListener("click", () => {
	void window.unreachable.switchServer();
});
