import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { asyncHandler } from '../middleware/error.js';

const router = Router();

const FIELDS = [
  'businessDescription',
  'productInfo',
  'serviceInfo',
  'prices',
  'shippingInfo',
  'returnPolicy',
  'faq',
  'openingHours',
  'contactDetails',
  'limitations',
  'customInstructions',
];

// One knowledge-base record per tenant.
async function getOrCreate(tenantId) {
  let kb = await prisma.knowledgeBase.findUnique({ where: { tenantId } });
  if (!kb) kb = await prisma.knowledgeBase.create({ data: { tenantId } });
  return kb;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await getOrCreate(req.tenantId));
  })
);

router.put(
  '/',
  asyncHandler(async (req, res) => {
    const kb = await getOrCreate(req.tenantId);
    const data = {};
    for (const f of FIELDS) if (req.body?.[f] !== undefined) data[f] = req.body[f];
    // Structured schedule (validated shape) — drives the out-of-hours auto-reply.
    if (req.body?.businessHours !== undefined) {
      const bh = req.body.businessHours;
      if (bh === null) data.businessHours = null;
      else {
        const days = Array.isArray(bh.days) ? bh.days.map(Number).filter((d) => d >= 0 && d <= 6) : [];
        const time = (v, dflt) => (/^\d{2}:\d{2}$/.test(String(v || '')) ? v : dflt);
        data.businessHours = {
          enabled: bh.enabled === true,
          days: [...new Set(days)].sort(),
          open: time(bh.open, '09:00'),
          close: time(bh.close, '17:00'),
          awayMessage: String(bh.awayMessage || '').slice(0, 500),
        };
      }
    }
    const updated = await prisma.knowledgeBase.update({ where: { id: kb.id }, data });
    res.json(updated);
  })
);

export default router;
