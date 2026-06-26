// Verifies the HMAC-SHA256 signature Linear sends in the `Linear-Signature`
// header. The signature is the hex digest of the raw request body, keyed with
// the webhook secret you configured in Linear.

export async function verifyLinearSignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const macBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody),
  );

  const expected = bufferToHex(macBuffer);
  return timingSafeEqual(expected, signature);
}

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Constant-time string compare to avoid leaking timing information.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
