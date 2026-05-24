/**
 * lib/validators/pdns-clusters.ts
 *
 * Zod schemas for the cluster admin routes.
 */

import "server-only";
import { z } from "zod";

export const WRITE_STRATEGIES = ["round_robin", "lowest_latency", "random", "least_load"] as const;

const slug = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z][a-z0-9-]*$/,
    "Slug must start with a letter; lowercase letters/digits/hyphens only.",
  );

export const createClusterSchema = z
  .object({
    slug,
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    writeStrategy: z.enum(WRITE_STRATEGIES).default("round_robin"),
    // Optional initial members — backend ids assigned to the new group in the
    // same transaction. Capped to keep the create request bounded.
    memberServerIds: z.array(z.string().uuid()).max(100).optional(),
  })
  .strict();

export type CreateClusterInput = z.infer<typeof createClusterSchema>;

export const updateClusterSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.union([z.string().max(2000), z.null()]).optional(),
    writeStrategy: z.enum(WRITE_STRATEGIES).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field is required." });

export type UpdateClusterInput = z.infer<typeof updateClusterSchema>;
