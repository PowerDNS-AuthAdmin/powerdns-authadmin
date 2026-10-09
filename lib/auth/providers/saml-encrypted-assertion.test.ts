import { describe, expect, it } from "vitest";
import { responseCarriesEncryptedAssertion } from "./saml";

const b64 = (xml: string) => Buffer.from(xml, "utf8").toString("base64");

describe("responseCarriesEncryptedAssertion", () => {
  it("detects an encrypted assertion under any namespace prefix", () => {
    expect(
      responseCarriesEncryptedAssertion(
        b64(
          "<samlp:Response><saml:EncryptedAssertion><xenc:EncryptedData/></saml:EncryptedAssertion></samlp:Response>",
        ),
      ),
    ).toBe(true);
    expect(
      responseCarriesEncryptedAssertion(
        b64("<Response><EncryptedAssertion></EncryptedAssertion></Response>"),
      ),
    ).toBe(true);
  });

  it("is false for a plaintext assertion and for garbage", () => {
    expect(
      responseCarriesEncryptedAssertion(
        b64('<samlp:Response><saml:Assertion ID="x"/></samlp:Response>'),
      ),
    ).toBe(false);
    expect(responseCarriesEncryptedAssertion("%%%not-base64%%%")).toBe(false);
  });
});
