/**
 * Tax utility for calculating sales tax based on zip code
 * Centralized tax rate logic used across the application
 */

// Static tax rates by zip code
export const POSTAL_TAX_RATES: Record<string, number> = {
  '98391': 0.093,
  '98092': 0.101,
  '98372': 0.103,
  '98374': 0.103,
  '98001': 0.101,
  '98002': 0.101,
  '98003': 0.101,
  '98023': 0.101,
  '98030': 0.102,
  '98031': 0.102,
  '98032': 0.102,
  '98042': 0.102,
  '98371': 0.103,
  '98373': 0.103,
  '98375': 0.101,
  '98402': 0.103,
  '98403': 0.103,
  '98404': 0.103,
  '98405': 0.103,
  '98406': 0.103,
  '98407': 0.103,
  '98408': 0.103,
  '98409': 0.103,
  '98418': 0.103,
  '98101': 0.1035,
  '98102': 0.1035,
  '98103': 0.1035,
  '98104': 0.1035,
  '98105': 0.1035,
};

// Default tax rate if zip code is not found
export const DEFAULT_TAX_RATE = 0.085;

/**
 * Get the tax rate for a given zip code
 * @param zipCode - The zip code to look up
 * @returns The tax rate as a decimal (e.g., 0.093 for 9.3%)
 */
export function getTaxRate(zipCode: string): number {
  if (!zipCode) {
    return DEFAULT_TAX_RATE;
  }

  // Extract 5-digit zip code if longer format provided
  const zipMatch = String(zipCode).match(/\d{5}/);
  const normalizedZip = zipMatch ? zipMatch[0] : zipCode;

  return POSTAL_TAX_RATES[normalizedZip] || DEFAULT_TAX_RATE;
}

/**
 * Calculate tax amount for a given subtotal and zip code
 * @param subtotal - The subtotal amount before tax
 * @param zipCode - The zip code for tax rate lookup
 * @returns The calculated tax amount
 */
export function calculateTax(subtotal: number, zipCode: string): number {
  const numericSubtotal = Number.isFinite(Number(subtotal)) ? Number(subtotal) : 0;
  const taxRate = getTaxRate(zipCode);
  return numericSubtotal * taxRate;
}
