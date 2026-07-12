import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import config from '../config/index.js';
import { supabase } from '../lib/supabase.js';

// Local-disk fallback dir, served publicly at /uploads/* (see app.js). Used only
// when Supabase Storage isn't configured (e.g. local dev without a service key).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const uploadsDir = path.resolve(__dirname, '../../uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

function uploader(mimePrefix, maxMb) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxMb * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if ((file.mimetype || '').startsWith(mimePrefix)) cb(null, true);
      else cb(new Error(`Only ${mimePrefix}* files are allowed`));
    },
  });
}

const audioUpload = uploader('audio/', 16); // WhatsApp audio cap is 16 MB
const imageUpload = uploader('image/', 5); // WhatsApp image cap is 5 MB

// Store the uploaded buffer (Supabase Storage if configured, else local disk)
// and return its public URL.
async function storeAndRespond(req, res, next, prefix, defaultExt) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ext = (path.extname(req.file.originalname || '').toLowerCase() || defaultExt).replace(/[^.a-z0-9]/g, '');
    const filename = `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;

    if (supabase) {
      const { error } = await supabase.storage
        .from(config.supabase.storageBucket)
        .upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
      if (error) throw error;
      const { data } = supabase.storage.from(config.supabase.storageBucket).getPublicUrl(filename);
      return res.status(201).json({ url: data.publicUrl, filename });
    }

    fs.writeFileSync(path.join(uploadsDir, filename), req.file.buffer);
    return res.status(201).json({ url: `${config.publicBaseUrl}/uploads/${filename}`, filename });
  } catch (err) {
    next(err);
  }
}

const router = Router();

// POST /api/uploads/audio  (multipart "file") → { url, filename }
router.post('/audio', audioUpload.single('file'), (req, res, next) =>
  storeAndRespond(req, res, next, 'voice', '.ogg')
);

// POST /api/uploads/image  (multipart "file") → { url, filename }
router.post('/image', imageUpload.single('file'), (req, res, next) =>
  storeAndRespond(req, res, next, 'img', '.jpg')
);

export default router;
