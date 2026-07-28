// Top-up credit packs a tenant can buy. 1 credit = 1 handled conversation in a 24h
// window (see lib/credits.js + CREDITS_DESIGN.md) — so `credits` here is a count of
// handled conversations, not messages. Prices are the locked HeyIL numbers, in whole
// shekels. Keep ids stable — they're stored on CreditPurchase and used as the ledger
// `reason`.
export const CREDIT_PACKS = [
  { id: 'pack_250', credits: 250, amountIls: 150, label: '250 שיחות' },
  { id: 'pack_500', credits: 500, amountIls: 250, label: '500 שיחות', popular: true },
  { id: 'pack_1000', credits: 1000, amountIls: 450, label: '1,000 שיחות' },
];

export function getPack(id) {
  return CREDIT_PACKS.find((p) => p.id === id) || null;
}
