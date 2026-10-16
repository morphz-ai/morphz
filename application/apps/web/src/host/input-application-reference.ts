import type { Operation } from "../../../../packages/core/src/model.js";

type Input = Extract<Operation, { type: "record-input" }>;
export type InputApplicationInstance = {
  applicationId: string;
  applicationVersion: string;
  state?: Record<string, unknown>;
};

/** The exact built-in reference shared by composer presentation and sending.
 * No screen/body content or mutable instance pointer enters the request. */
export function inputApplicationReference(
  instance: InputApplicationInstance | undefined,
  cognitive: boolean,
): Input["application"] {
  if (!instance || cognitive) return undefined;
  return {
    id: instance.applicationId,
    version: instance.applicationVersion,
    ...(instance.applicationId === "morphz.terminal"
      ? {
          terminalId:
            typeof instance.state?.terminalId === "string"
              ? instance.state.terminalId
              : null,
        }
      : {}),
  };
}
