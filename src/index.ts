import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerOmpPolicyRuntime } from "./adapters/omp/runtime/registerOmpPolicyRuntime.js";

export default function ompSemanticPolicy(pi: ExtensionAPI): void {
  registerOmpPolicyRuntime(pi);
}
