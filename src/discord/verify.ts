/**
 * Discord interaction signature verification.
 *
 * Discord signs every interaction with the application's Ed25519 keypair.
 * Verification MUST happen before any handling — an unverified request is
 * dropped with 401. Uses tweetnacl's detached signature verification.
 */
import nacl from "tweetnacl";

function hexToUint8Array(hex: string): Uint8Array {
  const matches = hex.match(/.{1,2}/g);
  if (!matches || matches.join("") !== hex) {
    throw new Error("Invalid hex string");
  }
  return new Uint8Array(matches.map((byte) => parseInt(byte, 16)));
}

/**
 * Verify a Discord interaction request.
 * @param publicKeyHex application public key (DISCORD_PUBLIC_KEY)
 * @param signatureHex X-Signature-Ed25519 header value
 * @param timestamp X-Signature-Timestamp header value
 * @param rawBody the exact request body string, unparsed
 */
export function verifyDiscordSignature(
  publicKeyHex: string,
  signatureHex: string | null,
  timestamp: string | null,
  rawBody: string,
): boolean {
  if (!signatureHex || !timestamp) return false;
  try {
    const signature = hexToUint8Array(signatureHex);
    const publicKey = hexToUint8Array(publicKeyHex);
    const message = new TextEncoder().encode(timestamp + rawBody);
    return nacl.sign.detached.verify(message, signature, publicKey);
  } catch {
    return false;
  }
}
