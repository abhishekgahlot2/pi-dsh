import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { StreamFn } from "../vendor/pi/types.ts";
import type { HarnessConfig } from "./config.ts";

// Provider credentials are applied only at the live request boundary.

export function createStreamFn(config: Pick<HarnessConfig, "apiKey">): StreamFn {
	return (model, context, options) =>
		streamSimple(model as Parameters<typeof streamSimple>[0], context, {
			...options,
			apiKey: config.apiKey,
			maxRetries: 0,
		});
}
