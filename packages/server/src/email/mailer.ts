export interface Email {
	to: string;
	subject: string;
	text: string;
}

export type Mailer = (email: Email) => Promise<void>;

/** Prints the email instead of sending it. For development only; production refuses it. */
export const consoleMailer: Mailer = async ({ to, subject, text }) => {
	console.log(`email to ${to}: ${subject}\n${text}`);
};

export function webhookMailer(url: string, token?: string, fetch = globalThis.fetch): Mailer {
	return async (email) => {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify(email),
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) {
			throw new Error(`Email webhook returned ${response.status} ${response.statusText}`);
		}
	};
}
