import type { Layer } from "effect";
import type { EmailService } from "./email.ts";
import { type ConsoleEmailConfig, consoleEmailLayer } from "./providers/console.ts";
import { type WebhookEmailConfig, webhookEmailLayer } from "./providers/webhook.ts";

/** Which provider sends email, and its settings. `provider` names one in `providers/`. */
export type EmailConfig = ConsoleEmailConfig | WebhookEmailConfig;

/** Returns the `EmailService` layer for the provider `config` names. */
export function emailLayer(config: EmailConfig): Layer.Layer<EmailService> {
	switch (config.provider) {
		case "console":
			return consoleEmailLayer;
		case "webhook":
			return webhookEmailLayer(config);
	}
}
