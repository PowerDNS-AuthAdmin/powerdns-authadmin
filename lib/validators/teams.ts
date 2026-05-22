/**
 * lib/validators/teams.ts
 */

import "server-only";
import { z } from "zod";
import { emailSchema } from "./users";
import { slugSchema } from "./common";

export const createTeamSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  contact: z.string().max(120).optional(),
  mail: z.union([emailSchema, z.literal("")]).optional(),
});

export type CreateTeamInput = z.infer<typeof createTeamSchema>;

export const updateTeamSchema = createTeamSchema.partial();
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;

export const addTeamMemberSchema = z.object({
  email: emailSchema,
  teamRole: z.enum(["owner", "member"]).default("member"),
});

export type AddTeamMemberInput = z.infer<typeof addTeamMemberSchema>;
