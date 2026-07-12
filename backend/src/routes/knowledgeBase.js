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
    const updated = await prisma.knowledgeBase.update({ where: { id: kb.id }, data });
    res.json(updated);
  })
);

export default router;
