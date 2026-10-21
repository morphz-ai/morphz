import { z } from "zod";

/** Observed Runtime phases. Neither elapsed time nor private reasoning is a
 * source for this presentation metadata; terminal events withdraw it. */
export const modelActivitySchema = z.enum([
  "queued",
  "streaming",
  "reasoning",
  "waiting_final_output",
  "streaming_text",
  "generating_tool_call",
  "settling",
]);
