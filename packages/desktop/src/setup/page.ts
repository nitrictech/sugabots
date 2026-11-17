import "@fontsource-variable/rubik";
import "./page.css";
import logoUrl from "@sugabots/avatars/sugabots-logo.svg";
import type { SetupBridge } from "./bridge.ts";

declare global {
	interface Window {
		readonly setup: SetupBridge;
	}
}

const logo = element(".logo", HTMLImageElement);
const form = element("#connect", HTMLFormElement);
const address = element("#address", HTMLInputElement);
const error = element("#error", HTMLParagraphElement);
const submit = element("#connect button", HTMLButtonElement);

logo.src = logoUrl;

window.setup.currentServer().then((server) => {
	address.value = server ?? "";
	address.select();
});

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

function element<T extends Element>(selector: string, type: new () => T): T {
	const found = document.querySelector(selector);
	if (!(found instanceof type)) throw new Error(`page.html has no ${selector}`);
	return found;
}
