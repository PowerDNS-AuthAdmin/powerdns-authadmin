/**
 * lib/auth/providers/saml.test-fixtures.ts
 *
 * Hand-rolled SAML provider fixture for the unit suite. Generates a fresh
 * RSA-2048 keypair on first import so the tests don't need a checked-in
 * private key (avoids "looks like a secret" CI scanner false positives).
 *
 * For X.509 cert material we use a stable fake - `@node-saml/node-saml`
 * accepts a `BEGIN CERTIFICATE` PEM containing any base64 body when the
 * library is only generating outbound material; it parses the cert only
 * when verifying inbound signatures, which isn't exercised by the AuthnRequest
 * + metadata tests.
 */

import { generateKeyPairSync } from "node:crypto";
import type { ResolvedSamlProvider } from "./saml";

// Fake X.509 cert - accepted by node-saml for the outbound-only paths the
// fixture exercises. Real signature verification needs a real keypair-derived
// cert (the integration suite does that via Keycloak's IdP-issued cert).
const FAKE_CERT_PEM = [
  "-----BEGIN CERTIFICATE-----",
  "MIIDazCCAlOgAwIBAgIUFakeFixtureCertForUnitTestsOnly00000wDQYJKoZI",
  "hvcNAQELBQAwRTELMAkGA1UEBhMCVVMxEzARBgNVBAgMClNvbWUtU3RhdGUxITAf",
  "BgNVBAoMGEludGVybmV0IFdpZGdpdHMgUHR5IEx0ZDAeFw0yNTA1MjcwMDAwMDBa",
  "Fw00NTA1MjIwMDAwMDBaMEUxCzAJBgNVBAYTAlVTMRMwEQYDVQQIDApTb21lLVN0",
  "YXRlMSEwHwYDVQQKDBhJbnRlcm5ldCBXaWRnaXRzIFB0eSBMdGQwggEiMA0GCSqG",
  "-----END CERTIFICATE-----",
].join("\n");

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const SP_SIGNING_KEY_PEM = privateKey;

export function makeTestProvider(
  overrides: { withEncryption?: boolean } = {},
): ResolvedSamlProvider {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "test",
    name: "Test IdP",
    idpEntityId: "https://idp.example.test/saml",
    idpSsoUrl: "https://idp.example.test/saml/sso",
    idpSloUrl: "https://idp.example.test/saml/slo",
    idpSigningCert: FAKE_CERT_PEM,
    spSigningKey: SP_SIGNING_KEY_PEM,
    spSigningCert: FAKE_CERT_PEM,
    spEncryptionKey: overrides.withEncryption ? SP_SIGNING_KEY_PEM : null,
    spEncryptionCert: overrides.withEncryption ? FAKE_CERT_PEM : null,
    requireSignedResponse: true,
    requireEncryptedAssertion: false,
    signatureAlgorithm: "sha256",
    nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    claimEmail: "email",
    claimName: "name",
    claimGroups: "groups",
    allowedEmailDomains: null,
    groupMappings: null,
  };
}
