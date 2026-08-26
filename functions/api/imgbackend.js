/**
 * imgbackend.js
 * High-performance, zero-memory-leak image processing & delivery backend.
 */

import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import sharp from 'sharp';
import multer from 'multer';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// --- CONFIGURATION & MEMORY SAFETY ---
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.resolve('storage/raw');
const CACHE_DIR = path.resolve('storage/cache');
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);

// Sharp memory & concurrency limits to prevent unbounded libvips thread/buffer growth
sharp.cache({ memory: 256, files: 50, items: 200 }); // Max 256MB RAM cache for libvips
sharp.concurrency(0); // Uses available CPU cores safely
sharp.simd(true);      // Enables SIMD hardware acceleration

await mkdir(UPLOAD_DIR, { recursive: true });
await mkdir(CACHE_DIR, { recursive: true });

const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(compression());

// --- ZERO-LEAK STORAGE ENGINE ---
// Writes directly to disk instead of holding file Buffers in V8 heap memory
const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const hash = crypto.randomBytes(16).toString('hex');
    cb(null, `${hash}${ext}`);
  }
});

const upload = multer({
  storage: diskStorage,
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('UNSUPPORTED_MEDIA_TYPE'));
    }
  }
});

// --- HELPER: SAFE INT PARSING ---
function parseParam(val, fallback, min, max) {
  const n = parseInt(val, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// --- ROUTES ---

/**
 * Upload single image stream directly to disk
 */
app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file provided' });
  }

  return res.status(201).json({
    id: req.file.filename,
    size: req.file.size,
    mimetype: req.file.mimetype
  });
});

/**
 * On-demand image processing with streaming pipeline & aggressive caching
 * Parameters: /api/images/:id?w=800&h=600&q=80&fmt=webp&fit=cover
 */
app.get('/api/images/:id', async (req, res) => {
  const { id } = req.params;

  // Sanitize path traversal
  const safeId = path.basename(id);
  const sourcePath = path.join(UPLOAD_DIR, safeId);

  if (!existsSync(sourcePath)) {
    return res.status(404).json({ error: 'Image not found' });
  }

  // Parse and normalize transform parameters
  const width = parseParam(req.query.w, null, 1, 4000);
  const height = parseParam(req.query.h, null, 1, 4000);
  const quality = parseParam(req.query.q, 80, 1, 100);
  const format = ['webp', 'jpeg', 'png', 'avif'].includes(req.query.fmt)
    ? req.query.fmt
    : 'webp';
  const fit = ['cover', 'contain', 'fill', 'inside', 'outside'].includes(req.query.fit)
    ? req.query.fit
    : 'cover';

  // Construct deterministic cache key
  const cacheKey = crypto
    .createHash('sha256')
    .update(`${safeId}_w${width}_h${height}_q${quality}_f${format}_fit${fit}`)
    .digest('hex');
  const cachePath = path.join(CACHE_DIR, `${cacheKey}.${format}`);

  // Set HTTP caching headers (1 Year Immutable)
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Content-Type', `image/${format}`);

  // Cache Hit: Stream existing transformed image directly
  if (existsSync(cachePath)) {
    const fileStats = await stat(cachePath);
    res.setHeader('Content-Length', fileStats.size);
    return pipeline(createReadStream(cachePath), res);
  }

  // Cache Miss: Transform via stream pipeline without buffering in V8 memory
  try {
    const transformer = sharp({ failOn: 'none', limitInputPixels: 268402689 })
      .resize({
        width: width || undefined,
        height: height || undefined,
        fit,
        withoutEnlargement: true
      })
      .toFormat(format, { quality, progressive: true, effort: 4 });

    // Stream directly from source file -> Sharp -> Cache File
    const readStream = createReadStream(sourcePath);
    const writeStream = createWriteStream(cachePath);

    await pipeline(readStream, transformer, writeStream);

    // Stream newly cached file directly to response
    const cachedStats = await stat(cachePath);
    res.setHeader('Content-Length', cachedStats.size);
    return pipeline(createReadStream(cachePath), res);
  } catch (err) {
    if (existsSync(cachePath)) {
      await unlink(cachePath).catch(() => {});
    }
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Image transformation failed' });
    }
    res.end();
  }
});

// --- ERROR & REJECTION HANDLING ---
app.use((err, req, res, next) => {
  if (err.message === 'UNSUPPORTED_MEDIA_TYPE') {
    return res.status(415).json({ error: 'Only JPEG, PNG, WebP, and AVIF are allowed' });
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Image exceeds size limit of 25MB' });
  }
  return res.status(500).json({ error: 'Internal Server Error' });
});

app.listen(PORT, () => {
  console.log(`Image backend running on http://localhost:${PORT}`);
});
