import { z } from "zod";
import { executionScopeSchema } from "./execution.js";

export const terminalRecordSchema = z.object({
  id: z.string().min(1).max(500),
  session_id: z.string(),
  context_id: z.string(),
  principal_id: z.string(),
  root_turn_id: z.string(),
  source_job_id: z.string(),
  target_id: z.string(),
  revision: z.number().int().positive(),
  status: z.enum(["starting", "open", "exited", "closed", "lost"]),
  title: z.string().max(320),
  shell: z.string(),
  cwd: z.string(),
  rows: z.number().int().min(4).max(60),
  cols: z.number().int().min(20).max(160),
  sandbox_status: z.string(),
  network_enabled: z.boolean(),
  last_input_status: z.enum(["uncertain", "submitted"]).nullable().optional(),
  exit_code: z.number().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
const color = z.string().regex(/^#[0-9a-f]{6}$/);
export const terminalScreenSchema = z.object({
  sequence: z.number().int().nonnegative(),
  rows: z.number().int().max(60),
  cols: z.number().int().max(160),
  lines: z
    .array(
      z
        .array(
          z.object({
            text: z.string().max(24000),
            fg: color.optional(),
            bg: color.optional(),
            fg_index: z.number().int().min(0).max(255).optional(),
            bg_index: z.number().int().min(0).max(255).optional(),
            bold: z.boolean(),
            italic: z.boolean(),
            underline: z.boolean(),
            inverse: z.boolean(),
          }),
        )
        .max(160),
    )
    .max(60),
  text: z.string().max(240000),
  cursor: z.tuple([z.number(), z.number()]),
  cursor_visible: z.boolean(),
  alternate_screen: z.boolean(),
  scrollback: z.number().int().nonnegative().max(500),
  previous_available: z.boolean(),
  styles_simplified: z.boolean().default(false),
});
export const terminalViewSchema = z.object({
  terminal: terminalRecordSchema,
  connected: z.boolean(),
  screen: terminalScreenSchema.nullable(),
  checkpoint: z.boolean(),
});
export const terminalCatalogSchema = z.object({
  terminals: z.array(terminalRecordSchema).max(50),
  has_more: z.boolean(),
  limit: z.number().int().positive().max(50),
});
export const terminalReadSchema = z
  .object({
    scope: executionScopeSchema,
    terminalId: z.string().min(1).max(500),
    scrollback: z.number().int().min(0).max(500).default(0),
  })
  .strict();
export type TerminalRecord = z.infer<typeof terminalRecordSchema>;
export type TerminalScreen = z.infer<typeof terminalScreenSchema>;
export type TerminalView = z.infer<typeof terminalViewSchema>;
