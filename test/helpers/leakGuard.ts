/**
 * Suite-wide secret-leak detection (docs/09-testing.md §9.5).
 * Console output is captured; helpers register every secret they see issued.
 */

export const TEST_CARD_NUMBERS = [
  '4242424242424242',
  '5555555555554444',
  '4000000000000002',
  '4000000000009995',
  '4000000000000069',
  '4000000000000127',
  '4000000000000119',
  '378282246310005',
];

const issuedSecrets = new Set<string>();
export const captured: string[] = [];

export function registerSecret(value: string | undefined | null): void {
  if (value) issuedSecrets.add(value);
}

/** Returns a description of each leak found in `text` (never the secret itself). */
export function findLeaks(text: string): string[] {
  const leaks: string[] = [];
  const digitsOnly = text.replace(/[ -]/g, '');
  for (const pan of TEST_CARD_NUMBERS) {
    if (digitsOnly.includes(pan)) leaks.push(`test card ending ${pan.slice(-4)}`);
  }
  for (const secret of issuedSecrets) {
    // base64url can contain '_', so take the random part by fixed position.
    const secretPart = secret.startsWith('whsec_') ? secret.slice(6) : secret.slice('sk_test_'.length + 17);
    if (text.includes(secret) || text.includes(secretPart)) {
      leaks.push(`issued secret ${secret.slice(0, 8)}…`);
    }
  }
  if (/"cvc"\s*:\s*"\d{3,4}"/.test(text)) leaks.push('a CVC value');
  return leaks;
}
