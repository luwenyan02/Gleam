/** Fixed-length mask keeps short secrets and their lengths private. */
export const SECRET_MASK = '••••••';

/** A saved secret is display-only: never use this summary as an editable value. */
export function maskSecret(value: string | null | undefined): string {
  if (!value) return '';
  const characters = Array.from(value);
  if (characters.length <= 15) return SECRET_MASK;
  return `${characters.slice(0, 5).join('')}${SECRET_MASK}${characters.slice(-5).join('')}`;
}
