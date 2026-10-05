import { isAbsolute } from "node:path";
import type { CognitiveAppHostOptions } from "./cognitive-app-host.js";
import { CognitiveAppServiceError } from "./cognitive-app-service.js";

/** Trusted launcher configuration only. Never parse a Client/model request or
 * read/create a private file here. The resolver owns file/secret/egress checks.
 * Project .env loading deliberately does not import this path or credentials.
 */
export function cognitiveAppLaunchConfig(
  environment: NodeJS.ProcessEnv = process.env,
): CognitiveAppHostOptions | undefined {
  const bindingsFile = environment.MORPHZ_APP_COGNITIVE_BINDINGS_FILE;
  if (bindingsFile === undefined || bindingsFile === "") return undefined;
  if (!isAbsolute(bindingsFile))
    throw new CognitiveAppServiceError("unavailable");
  return { bindingsFile };
}
