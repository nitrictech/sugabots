import "@fontsource-variable/rubik";
import "../page.css";
import logoUrl from "@sugabots/avatars/sugabots-logo.svg";
import { element } from "../element.ts";
import type { SetupBridge } from "./bridge.ts";

declare global {
	interface Window {
		readonly setup: SetupBridge;
	}
}

const form = element("#connect", HTMLFormElement);
const address = element("#address", HTMLInputElement);
const error = element("#error", HTMLParagraphElement);
const submit = element("#connect button", HTMLButtonElement);

element(".logo", HTMLImageElement).src = logoUrl;
// The window exists to take this one field.
address.focus();

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	submit.disabled = true;
	submit.textContent = "Connecting…";
	const result = await window.setup.connect(address.value);
	if (result.ok) return;
	error.textContent = result.message;
	address.setAttribute("aria-invalid", "true");
	submit.disabled = false;
	submit.textContent = "Connect";
	address.focus();
});

address.addEventListener("input", () => {
	error.textContent = "";
	address.removeAttribute("aria-invalid");
});
