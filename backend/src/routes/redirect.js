import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { trackEvent, EVENTS } from '../services/analytics.js';

// Public, unauthenticated: /r/:linkId?c=:conversationId
const router = Router();

router.get(
  '/r/:linkId',
  asyncHandler(async (req, res) => {
    const link = await prisma.link.findUnique({ where: { id: req.params.linkId } });
    if (!link) return res.status(404).send('Link not found');

    const conversationId = req.query.c || null;
    await prisma.link.update({ where: { id: link.id }, data: { clicksCount: { increment: 1 } } });
    await trackEvent(EVENTS.LINK_CLICKED, {
      tenantId: link.tenantId,
      conversationId,
      flowId: link.relatedFlowId,
      metadata: { linkId: link.id, url: link.url },
    });

    res.redirect(302, link.url);
  })
);

export default router;
