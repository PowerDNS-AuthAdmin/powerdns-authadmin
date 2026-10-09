import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ValidationError } from "@/lib/errors";
import { parseSearchParams } from "./parse-query";

const schema = z.object({
  serverSlug: z.string().min(1).optional(),
  cascade: z.enum(["true", "false"]).optional(),
});

describe("parseSearchParams", () => {
  it("returns the parsed params", () => {
    expect(parseSearchParams(schema, new URL("http://x/?serverSlug=a&cascade=true"))).toEqual({
      serverSlug: "a",
      cascade: "true",
    });
  });

  it("maps a schema failure to ValidationError (400), not a bare ZodError (500)", () => {
    expect(() => parseSearchParams(schema, new URL("http://x/?cascade=maybe"))).toThrow(
      ValidationError,
    );
  });
});
