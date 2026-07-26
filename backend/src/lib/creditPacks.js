// Credit packs a tenant can buy. 1 credit = 1 AI-answered message. Prices in whole
// shekels (premium tier). Keep ids stable — they're stored on CreditPurchase and used
// as the ledger `reason`. See CREDITS_DESIGN.md.
export const CREDIT_PACKS = [
  { id: 'pack_1000', credits: 1000, amountIls: 59, label: '1,000 קרדיטים' },
  { id: 'pack_5000', credits: 5000, amountIls: 249, label: '5,000 קרדיטים', popular: true },
  { id: 'pack_20000', credits: 20000, amountIls: 799, label: '20,000 קרדיטים' },
];

export function getPack(id) {
  return CREDIT_PACKS.find((p) => p.id === id) || null;
}
