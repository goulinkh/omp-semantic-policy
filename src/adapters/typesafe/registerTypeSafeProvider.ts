import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export interface TypeSafeProviderRegistrationOptions {
  readonly validateApiKey?: (apiKey: string, signal?: AbortSignal) => Promise<void>;
}

/** Register environment and OMP-managed API-key authentication. */
export function registerTypeSafeProvider(
  pi: ExtensionAPI,
  options: TypeSafeProviderRegistrationOptions = {},
): void {
  const environmentKey = process.env.TYPESAFE_API_KEY?.trim();
  pi.registerProvider("typesafe-ai", {
    ...(environmentKey === undefined || environmentKey.length === 0
      ? {}
      : { apiKey: environmentKey }),
    oauth: {
      name: "TypeSafe API token",
      async login(callbacks) {
        const apiKey = (
          await callbacks.onPrompt({
            message: "Paste your TypeSafe API token",
            placeholder: "TypeSafe API token",
          })
        ).trim();
        if (apiKey.length === 0) {
          throw new Error("The TypeSafe API token is empty.");
        }
        callbacks.onProgress?.("Validating TypeSafe API token…");
        await (options.validateApiKey ?? validateKey)(apiKey, callbacks.signal);
        return apiKey;
      },
    },
  });
}

async function validateKey(apiKey: string, signal?: AbortSignal): Promise<void> {
  const client = new TypeSafeClient({ apiKey, logLevel: "off", retry: { maxRetries: 0 } });
  await client.models.list(signal === undefined ? {} : { signal });
}
