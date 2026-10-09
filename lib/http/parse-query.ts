/**
 * lib/http/parse-query.ts
 *
 * Parse a URL's search params with a Zod schema, turning a schema failure
 * into the app's `ValidationError` (HTTP 400) instead of letting the raw
 * `ZodError` escape to `errorResponse`, which maps unknown errors to 500.
 */

import type { z } from "zod";
import { ZodError } from "zod";
import { ValidationError } from "@/lib/errors";

export function parseSearchParams<T extends z.ZodTypeAny>(schema: T, url: URL): z.infer<T> {
  try {
    return schema.parse(Object.fromEntries(url.searchParams));
  } catch (err) {
    if (err instanceof ZodError) {
      throw new ValidationError("Invalid query parameters.", {
        fieldErrors: err.flatten().fieldErrors,
      });
    }
    throw err;
  }
}
