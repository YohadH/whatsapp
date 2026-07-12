// Normalize a phone number to WhatsApp's format: digits only, with country code,
// no leading "+". Defaults bare/local numbers to Israel (972). Handles common
// spreadsheet inputs: "050-123-4567", "+972 50 …", "972…", or an Excel number.
export function normalizePhone(raw, defaultCountry = '972') {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // Scientific notation (e.g. "9.72544E+11" from an Excel export) means the
  // real digits were already lost — reject rather than message a wrong number.
  if (/^-?\d+(?:\.\d+)?[eE][+-]?\d+$/.test(s)) return null;

  const hadPlus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (!digits) return null;

  if (hadPlus) return digits; // already international, e.g. +14155551234
  if (digits.startsWith('00')) return digits.slice(2); // 00 intl prefix
  if (digits.startsWith(defaultCountry)) return digits; // already 972…
  if (digits.startsWith('0')) return defaultCountry + digits.slice(1); // 05… → 9725…
  if (digits.length >= 8 && digits.length <= 10) return defaultCountry + digits; // bare local
  return digits;
}

// Loose sanity check on a normalized number (WhatsApp needs 8–15 digits).
export function isValidPhone(normalized) {
  return !!normalized && /^\d{8,15}$/.test(normalized);
}
