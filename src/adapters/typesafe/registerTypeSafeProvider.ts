import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** Register environment and file-based API-key authentication with OMP. */
export function registerTypeSafeProvider(pi: ExtensionAPI): void {
  pi.registerProvider("typesafe-ai", {
    apiKey: "TYPESAFE_API_KEY",
    oauth: {
      name: "TypeSafe API key",
      async login(callbacks) {
        const environmentKey = process.env.TYPESAFE_API_KEY?.trim();
        if (environmentKey !== undefined && environmentKey.length > 0) {
          await validateKey(environmentKey, callbacks.signal);
          return environmentKey;
        }

        const configuredPath = await callbacks.onPrompt({
          message:
            "Path to a file containing the TypeSafe API key (the OMP prompt is not secret-masked)",
          placeholder: "~/.config/typesafe/api-key",
        });
        const keyPath = configuredPath.startsWith("~/")
          ? resolve(homedir(), configuredPath.slice(2))
          : resolve(configuredPath);
        const apiKey = (await readFile(keyPath, "utf8")).trim();
        if (apiKey.length === 0) {
          throw new Error("The TypeSafe API key file is empty.");
        }
        await validateKey(apiKey, callbacks.signal);
        return apiKey;
      },
    },
  });
}

async function validateKey(apiKey: string, signal?: AbortSignal): Promise<void> {
  const client = new TypeSafeClient({ apiKey, logLevel: "off", retry: { maxRetries: 0 } });
  await client.models.list(signal === undefined ? {} : { signal });
}
