/**
 * Lightweight lead scoring (0-100). Combines intent strength, how much of the
 * flow the customer completed, and whether a link was sent.
 */
const INTENT_WEIGHT = {
  booking_request: 35,
  payment_request: 40,
  pricing_question: 25,
  product_question: 20,
  service_question: 20,
  predefined_flow_start: 25,
  shipping_question: 15,
  general_question: 8,
  support_request: 10,
  human_agent_request: 15,
  unknown: 3,
};

export function computeLeadScore({ intent, answersCount = 0, requiredCount = 0, linkSent = false, status }) {
  let score = INTENT_WEIGHT[intent] ?? 5;

  if (requiredCount > 0) {
    score += Math.round((answersCount / requiredCount) * 35);
  } else {
    score += Math.min(answersCount * 7, 35);
  }

  if (linkSent) score += 10;
  if (status === 'completed') score += 20;
  if (status === 'abandoned') score -= 10;

  return Math.max(1, Math.min(100, score));
}
