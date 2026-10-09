import { describe, expect, it } from "vitest";
import { rejectCrossSiteJson } from "./pre-auth-guard";

function req(headers: Record<string, string>): Request {
  return new Request("http://localhost:3000/api/auth/login", { method: "POST", headers });
}

describe("rejectCrossSiteJson", () => {
  it("lets a same-origin JSON request through", () => {
    expect(
      rejectCrossSiteJson(
        req({
          "content-type": "application/json",
          origin: "http://localhost:3000",
          "sec-fetch-site": "same-origin",
        }),
      ),
    ).toBeNull();
    // No Origin / Sec-Fetch-Site at all (curl, older clients) is fine too.
    expect(
      rejectCrossSiteJson(req({ "content-type": "application/json; charset=utf-8" })),
    ).toBeNull();
  });

  it("refuses the HTML-form content types a cross-site page can send", () => {
    const res = rejectCrossSiteJson(req({ "content-type": "text/plain" }));
    expect(res?.status).toBe(415);
    expect(
      rejectCrossSiteJson(req({ "content-type": "application/x-www-form-urlencoded" }))?.status,
    ).toBe(415);
    expect(rejectCrossSiteJson(req({}))?.status).toBe(415);
  });

  it("refuses a foreign Origin", () => {
    const res = rejectCrossSiteJson(
      req({ "content-type": "application/json", origin: "https://evil.example" }),
    );
    expect(res?.status).toBe(403);
  });

  it("refuses cross-site fetch metadata", () => {
    expect(
      rejectCrossSiteJson(
        req({ "content-type": "application/json", "sec-fetch-site": "cross-site" }),
      )?.status,
    ).toBe(403);
    expect(
      rejectCrossSiteJson(
        req({ "content-type": "application/json", "sec-fetch-site": "same-site" }),
      )?.status,
    ).toBe(403);
    expect(
      rejectCrossSiteJson(req({ "content-type": "application/json", "sec-fetch-site": "none" })),
    ).toBeNull();
  });
});
