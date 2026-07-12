import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { asyncHandler } from '../middleware/error.js';

const router = Router();

// Only http(s) links are storable — blocks javascript:/data: schemes that would
// turn a stored link into stored XSS on the public bio page (audit finding #12).
function isSafeUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const links = await prisma.link.findMany({
      where: { tenantId: req.tenantId },
      include: { relatedFlow: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(links);
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { name, url, description, relatedFlowId, isActive, trackClicks, showOnBio } = req.body || {};
    if (!name || !url) return res.status(400).json({ error: 'name and url are required' });
    if (!isSafeUrl(url)) return res.status(400).json({ error: 'URL must start with http:// or https://' });
    const link = await prisma.link.create({
      data: {
        tenantId: req.tenantId,
        name,
        url,
        description: description || null,
        relatedFlowId: relatedFlowId || null,
        isActive: isActive ?? true,
        trackClicks: trackClicks ?? true,
        showOnBio: showOnBio ?? false,
      },
    });
    res.status(201).json(link);
  })
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const { name, url, description, relatedFlowId, isActive, trackClicks, showOnBio } = req.body || {};
    if (url !== undefined && !isSafeUrl(url)) return res.status(400).json({ error: 'URL must start with http:// or https://' });
    const owned = await prisma.link.findFirst({ where: { id: req.params.id, tenantId: req.tenantId }, select: { id: true } });
    if (!owned) return res.status(404).json({ error: 'Link not found' });
    const data = {};
    if (name !== undefined) data.name = name;
    if (url !== undefined) data.url = url;
    if (description !== undefined) data.description = description;
    if (relatedFlowId !== undefined) data.relatedFlowId = relatedFlowId || null;
    if (isActive !== undefined) data.isActive = isActive;
    if (trackClicks !== undefined) data.trackClicks = trackClicks;
    if (showOnBio !== undefined) data.showOnBio = showOnBio;
    const link = await prisma.link.update({ where: { id: req.params.id }, data });
    res.json(link);
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { count } = await prisma.link.deleteMany({ where: { id: req.params.id, tenantId: req.tenantId } });
    if (!count) return res.status(404).json({ error: 'Link not found' });
    res.status(204).end();
  })
);

export default router;
