// api/acr.js
const express = require('express');
const acr = express.Router();
const axios = require('axios');
const xml2js = require('xml2js');
const sql = require('mssql');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const logger = require('../logger'); // daily-rotate logger

// ===== Helpers =====
function requiredEnv(name) {
  if (!process.env[name]) {
    const msg = `Missing required environment variable: ${name}`;
    logger.error('[ACR] ' + msg);
    throw new Error(msg);
  }
  return process.env[name];
}
const maskUcid = (u) => (u ? String(u).slice(0, 4) + '...' + String(u).slice(-4) : u);
const safeTrunc = (s, n = 500) => (s ? String(s).slice(0, n) : s);
const newReqId = () => `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;

const DB_PORT = process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : undefined;

// ===== DB CONFIG =====
const DB_CONFIG = {
  user: requiredEnv('DB_USER'),
  password: requiredEnv('DB_PASS'),
  server: requiredEnv('DB_SERVER'),
  port: Number.isFinite(DB_PORT) ? DB_PORT : undefined,
  database: requiredEnv('DB_NAME'),
  options: { encrypt: false, trustServerCertificate: true }
};
const ACR_TABLE_NAME = requiredEnv('ACR_TABLE_NAME');

// ===== ACR CONFIG =====
const ACR_SCHEME = requiredEnv('ACR_SCHEME');
const ACR_HOST   = requiredEnv('ACR_HOST');
const ACR_PORT   = requiredEnv('ACR_PORT');
const ACR_PATH   = requiredEnv('ACR_PATH');
const ACR_USER   = requiredEnv('ACR_USER');
const ACR_PASS   = requiredEnv('ACR_PASS');
const ACR_WINDOW_DAYS = parseInt(requiredEnv('ACR_WINDOW_DAYS'), 10);

// ===== MEDIA / FFMPEG =====
const MEDIA_ROOT = requiredEnv('MEDIA_ROOT');
const FFMPEG_BIN = requiredEnv('FFMPEG_BIN');
const USE_LOCAL_DEFAULT = /^true$/i.test(process.env.USE_LOCAL_DEFAULT || 'true');
const CACHE_TTL_HOURS = parseInt(process.env.CACHE_TTL_HOURS || '72', 10);

try {
  fs.mkdirSync(MEDIA_ROOT, { recursive: true });
  logger.info('[ACR] MEDIA_ROOT ensured', { MEDIA_ROOT });
} catch (e) {
  logger.error('[ACR] MEDIA_ROOT create failed', { MEDIA_ROOT, error: e.message });
}

// periodic cleanup of old cached artifacts
function cleanupOldMedia() {
  const cutoff = Date.now() - CACHE_TTL_HOURS * 3600 * 1000;
  let removed = 0;
  try {
    for (const name of fs.readdirSync(MEDIA_ROOT)) {
      if (!/\.(wav|json|raw\.bin)$/i.test(name)) continue;
      const p = path.join(MEDIA_ROOT, name);
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs < cutoff) {
          fs.unlinkSync(p);
          removed++;
        }
      } catch (e) {
        logger.warn('[ACR] cleanup stat/unlink error', { file: p, error: e.message });
      }
    }
    logger.info('[ACR] media cleanup complete', { removed, CACHE_TTL_HOURS });
  } catch (e) {
    logger.warn('[ACR] media cleanup failed', { error: e.message });
  }
}
setInterval(cleanupOldMedia, 60 * 60 * 1000).unref();
cleanupOldMedia();

// ===== Shared helpers =====
const HOP_BY_HOP = new Set([
  'transfer-encoding','connection','keep-alive','proxy-authenticate',
  'proxy-authorization','te','trailer','upgrade'
]);

function toDDMMYY(d) {
  const dt = new Date(d);
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yy = String(dt.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}

// strict YYYY-MM-DD
function parseYMD(ymd) {
  const s = String(ymd || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(n => parseInt(n, 10));
  if (y < 1970 || y > 2100) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > 31) return null;
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  if (dt.getFullYear() !== y || dt.getMonth() !== (m - 1) || dt.getDate() !== d) return null;
  return dt;
}

function acrBase() {
  return `${ACR_SCHEME}://${ACR_HOST}:${ACR_PORT}${ACR_PATH}`;
}

function buildReplayUrls(inum) {
  const raw = `${ACR_SCHEME}://${ACR_HOST}:${ACR_PORT}${ACR_PATH}?command=replay&id=${encodeURIComponent(inum)}`;
  const proxied = `/api/acr/replay/${encodeURIComponent(inum)}`;
  return { raw, proxied };
}

function mapResultFields(result) {
  const inum = result?.$?.inum || null;

  // normalize field names to lowercase so variants don't break us
  const fieldsObj = Object.fromEntries(
    (result?.field || []).map(f => [String(f?.$?.name || '').toLowerCase(), f?._])
  );

  return {
    inum,
    fields: fieldsObj,
    switchcallid: fieldsObj.switchcallid || null
  };
}


function computeRangeFromQuery(q) {
  const start = parseYMD(q.startdate);
  if (!start) throw new Error('Invalid startdate (expected YYYY-MM-DD)');

  let end;
  if (q.enddate) {
    end = parseYMD(q.enddate);
    if (!end) throw new Error('Invalid enddate (expected YYYY-MM-DD)');
  } else if (typeof q.windowDays !== 'undefined') {
    const wd = parseInt(q.windowDays, 10);
    if (!Number.isFinite(wd) || wd <= 0) throw new Error('Invalid windowDays (must be positive integer)');
    end = new Date(start);
    end.setDate(end.getDate() + wd);
  } else {
    end = new Date(start); // same day
  }

  return { start, end, p1: toDDMMYY(start), p3: toDDMMYY(end) };
}

// --- local media helpers ---
function safeName(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
}
function localPathsFor(inum) {
  const base = safeName(inum);
  return {
    raw: path.join(MEDIA_ROOT, `${base}.raw.bin`),
    wav: path.join(MEDIA_ROOT, `${base}.wav`),
    meta: path.join(MEDIA_ROOT, `${base}.json`)
  };
}
function streamFile(filePath, req, res, contentType = 'application/octet-stream') {
  const st = fs.statSync(filePath);
  const total = st.size;
  const range = req.headers.range;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);

  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : total - 1;
      logger.info('[ACR] partial stream', { filePath, start, end, total });
      res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', end - start + 1);
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }
  }
  logger.info('[ACR] full stream', { filePath, total });
  res.status(200).setHeader('Content-Length', total);
  fs.createReadStream(filePath).pipe(res);
}
async function downloadRawFromAcr(inum, outPath, ctx) {
  const url = `${ACR_SCHEME}://${ACR_HOST}:${ACR_PORT}${ACR_PATH}?command=replay&id=${encodeURIComponent(inum)}`;
  logger.info('[ACR] download start', { ...ctx, url: url.replace(/\/\/[^/]+/, '//<acr-host>'), outPath });
  const t0 = Date.now();
  const cfg = {
    method: 'GET',
    url,
    responseType: 'stream',
    timeout: 600000,
    auth: (ACR_USER || ACR_PASS) ? { username: ACR_USER, password: ACR_PASS } : undefined,
    validateStatus: () => true
  };
  const r = await axios(cfg);
  if (r.status < 200 || r.status >= 400) {
    logger.error('[ACR] download http error', { ...ctx, status: r.status });
    throw new Error(`ACR GET failed (${r.status})`);
  }
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(outPath);
    r.data.on('error', (e) => { logger.error('[ACR] download stream error', { ...ctx, error: e.message }); reject(e); });
    ws.on('error', (e) => { logger.error('[ACR] download write error', { ...ctx, error: e.message }); reject(e); });
    ws.on('finish', resolve);
    r.data.pipe(ws);
  });
  logger.info('[ACR] download done', { ...ctx, ms: Date.now() - t0, size: fs.existsSync(outPath) ? fs.statSync(outPath).size : 0 });
}
function transcodeToWav(inPath, outPath, ctx) {
  return new Promise((resolve, reject) => {
    const args = ['-y','-i', inPath,'-vn','-acodec','pcm_s16le','-ac','1','-ar','8000', outPath];
    logger.info('[ACR] ffmpeg start', { ...ctx, args: args.join(' ') });
    const t0 = Date.now();
    const proc = spawn(FFMPEG_BIN, args, { windowsHide: true });
    let errlog = '';
    proc.stderr.on('data', d => { errlog += d.toString(); });
    proc.on('error', (e) => { logger.error('[ACR] ffmpeg spawn error', { ...ctx, error: e.message }); reject(e); });
    proc.on('close', code => {
      if (code === 0) {
        logger.info('[ACR] ffmpeg done', { ...ctx, ms: Date.now() - t0, outSize: fs.existsSync(outPath) ? fs.statSync(outPath).size : 0 });
        resolve();
      } else {
        logger.error('[ACR] ffmpeg exit', { ...ctx, code, err: safeTrunc(errlog, 800) });
        reject(new Error(`ffmpeg exited ${code}`));
      }
    });
  });
}
async function ensureLocalWav(inum, ctx) {
  const { raw, wav, meta } = localPathsFor(inum);
  if (fs.existsSync(wav) && fs.statSync(wav).size > 0) {
    logger.info('[ACR] cache hit (wav)', { ...ctx, wav });
    return wav;
  }
  await downloadRawFromAcr(inum, raw, ctx);
  await transcodeToWav(raw, wav, ctx);
  try {
    fs.writeFileSync(meta, JSON.stringify({ inum, createdAt: new Date().toISOString() }, null, 2));
    logger.info('[ACR] meta written', { ...ctx, meta });
  } catch (e) {
    logger.warn('[ACR] meta write failed', { ...ctx, meta, error: e.message });
  }
  try { fs.unlinkSync(raw); logger.info('[ACR] raw deleted', { ...ctx, raw }); } catch (e) { logger.warn('[ACR] raw delete failed', { ...ctx, raw, error: e.message }); }
  return wav;
}

// Insert one row into dbo.AcrResults (best-effort)
async function insertAcrRow(payload, ctx) {
  let pool;
  const logCtx = { ...ctx, inum: payload.inum, ucidMasked: maskUcid(payload.ucid) };
  try {
    logger.info('[ACR] DB insert begin', logCtx);
    pool = await sql.connect(DB_CONFIG);
    await pool.request()
      .input('ucid',          sql.VarChar(40),  payload.ucid || null)
      .input('inum',          sql.VarChar(32),  payload.inum || null)
      .input('started_at',    sql.DateTime2,    payload.started_at ? new Date(payload.started_at) : null)
      .input('duration_sec',  sql.Int,          Number.isFinite(payload.duration_sec) ? payload.duration_sec : null)
      .input('agents',        sql.NVarChar(256),payload.agents || null)
      .input('other_parties', sql.NVarChar(512),payload.other_parties || null)
      .input('services',      sql.NVarChar(256),payload.services || null)
      .input('skills',        sql.NVarChar(256),payload.skills || null)
      .input('playback_url',  sql.NVarChar(512),payload.playback_url || null)
      .query(`
        INSERT INTO ${ACR_TABLE_NAME}
          (ucid, inum, started_at, duration_sec, agents, other_parties, services, skills, playback_url)
        VALUES
          (@ucid, @inum, @started_at, @duration_sec, @agents, @other_parties, @services, @skills, @playback_url)
      `);
    logger.info('[ACR] DB insert ok', logCtx);
  } catch (e) {
    logger.error('[ACR] DB insert error', { ...logCtx, error: e.message });
  } finally {
    try { if (pool) await pool.close(); } catch {}
  }
}

// ===== Routes =====

// GET /api/acr/find?ucid=...&startdate=YYYY-MM-DD[&enddate=YYYY-MM-DD|&windowDays=N]
acr.get('/find', async (req, res) => {
  const reqId = newReqId();
  const ucid = (req.query.ucid || '').trim();
  const startdate = (req.query.startdate || '').trim();
  const ctx = { route: '/acr/find', reqId, ucidMasked: maskUcid(ucid), ip: req.ip };

  logger.info('[ACR] /find request', { ...ctx, query: req.query });

  const missing = [];
  if (!ucid) missing.push('ucid');
  if (!startdate) missing.push('startdate');
  if (missing.length) {
    logger.warn('[ACR] /find missing params', { ...ctx, missing });
    return res.status(400).json({ ok: false, message: 'Missing required parameters', missing });
  }

  try {
    const { start, end, p1, p3 } = computeRangeFromQuery({ ...req.query, startdate });
    logger.info('[ACR] /find computed window', { ...ctx, p1, p3 });

    const params = {
      command: 'search',
      operator_startedat: 9,
      param1_startedat: p1,
      param3_startedat: p3,
      operator_switchcallid: 1,
      param1_switchcallid: ucid
    };

    const axiosCfg = { params, timeout: 30000 };
    if (ACR_USER && ACR_PASS) axiosCfg.auth = { username: ACR_USER, password: ACR_PASS };

    const t0 = Date.now();
    const r = await axios.get(acrBase(), axiosCfg);
    logger.info('[ACR] /find ACR resp', { ...ctx, status: r.status, ms: Date.now() - t0, xmlSample: safeTrunc(r.data, 400) });

    const parsed = await xml2js.parseStringPromise(r.data);
    const results = parsed?.results?.result || [];
    logger.info('[ACR] /find parsed', { ...ctx, count: results.length });

    if (!results.length) {
      return res.json({ ok: true, found: 0, items: [] });
    }

    const { inum, fields, switchcallid } = mapResultFields(results[0]);
    if (!inum) {
      logger.warn('[ACR] /find missing INUM', ctx);
      return res.status(502).json({ ok: false, message: 'ACR returned no INUM' });
    }

    const { raw, proxied } = buildReplayUrls(inum);

    const payload = {
      inum,
      started_at: fields.startedat || null,
      duration_sec: fields.duration ? parseInt(fields.duration, 10) : null,
      agents: fields.agents || null,
      other_parties: fields.otherparties || null,
      services: fields.services || null,
      skills: fields.skills || null,
      playback_url: proxied,
      raw_playback_url: raw
    };

    insertAcrRow(payload, ctx); // fire & forget
    logger.info('[ACR] /find success', { ...ctx, inum });

    return res.json({ ok: true, found: results.length, item: payload, window: { start, end } });
  } catch (e) {
    // If thrown by computeRangeFromQuery => 400; else 502
    const isInputErr = /^Invalid (startdate|enddate|windowDays)/.test(e.message);
    if (isInputErr) {
      logger.warn('[ACR] /find invalid input', { ...ctx, error: e.message });
      return res.status(400).json({
        ok: false,
        message: e.message,
        invalid: ['startdate', req.query.enddate ? 'enddate' : undefined].filter(Boolean)
      });
    }
    logger.error('[ACR] /find error', { ...ctx, error: e.message });
    return res.status(502).json({ ok: false, message: e.message });
  }
});

// Shared handler for GET/HEAD /replay/:inum
async function replayHandler(req, res) {
  const reqId = newReqId();
  const { inum } = req.params;
  const ctx = { route: '/acr/replay', reqId, inum };

  if (!inum) {
    logger.warn('[ACR] /replay missing inum', ctx);
    return res.status(400).send('missing inum');
  }

  const rawReplay = `${ACR_SCHEME}://${ACR_HOST}:${ACR_PORT}${ACR_PATH}?command=replay&id=${encodeURIComponent(inum)}`;
  const proxied = `/api/acr/replay/${encodeURIComponent(inum)}`;

  insertAcrRow({
    ucid: req.query.ucid || null,
    inum,
    started_at: null,
    duration_sec: null,
    agents: null,
    other_parties: null,
    services: null,
    skills: null,
    playback_url: proxied
  }, ctx);

  try {
    const headers = {};
    if (req.headers.range)  headers.Range  = req.headers.range;
    if (req.headers.accept) headers.Accept = req.headers.accept;

    logger.info('[ACR] /replay proxy → ACR', { ...ctx, method: req.method, hasRange: !!headers.Range });

    const t0 = Date.now();
    const r = await axios({
      method: req.method,
      url: rawReplay,
      responseType: req.method === 'HEAD' ? 'json' : 'stream',
      headers,
      timeout: 60000,
      auth: (ACR_USER || ACR_PASS) ? { username: ACR_USER, password: ACR_PASS } : undefined,
      validateStatus: () => true
    });
    logger.info('[ACR] /replay ACR resp', { ...ctx, status: r.status, ms: Date.now() - t0 });

    res.status(r.status);
    for (const [k, v] of Object.entries(r.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) res.setHeader(k, v);
    }
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'HEAD') {
      logger.info('[ACR] /replay HEAD done', ctx);
      return res.end();
    }
    r.data.on('error', (e) => {
      logger.warn('[ACR] /replay stream error', { ...ctx, error: e.message });
      try { res.destroy(e); } catch {}
    });
    r.data.pipe(res);
  } catch (e) {
    logger.error('[ACR] /replay error', { ...ctx, error: e.message });
    if (!res.headersSent) res.status(502).send('ACR replay error: ' + e.message);
  }
}

acr.get('/replay/:inum', replayHandler);

// GET /api/acr/replayByUcid?ucid=...&startdate=YYYY-MM-DD[&enddate=YYYY-MM-DD|&windowDays=N][&redirect=1][&local=1]
acr.get('/replayByUcid', async (req, res) => {
  const reqId = newReqId();
  const ucid = (req.query.ucid || '').trim();
  const startdate = (req.query.startdate || '').trim();
  const redirect = req.query.redirect;
  const local = req.query.local;
  const ctx = { route: '/acr/replayByUcid', reqId, ucidMasked: maskUcid(ucid), ip: req.ip };

  logger.info('[ACR] /replayByUcid request', { ...ctx, query: req.query });

  const missing = [];
  if (!ucid) missing.push('ucid');
  if (!startdate) missing.push('startdate');
  if (missing.length) {
    logger.warn('[ACR] /replayByUcid missing params', { ...ctx, missing });
    return res.status(400).send('Missing required parameters: ' + missing.join(', '));
  }

  try {
    const { p1, p3 } = computeRangeFromQuery({ ...req.query, startdate });
    logger.info('[ACR] /replayByUcid window', { ...ctx, p1, p3 });

    const searchParams = {
      command: 'search',
      operator_startedat: 9,
      param1_startedat: p1,
      param3_startedat: p3,
      operator_switchcallid: 1,
      param1_switchcallid: ucid
    };

    const cfg = { params: searchParams, timeout: 30000 };
    if (ACR_USER && ACR_PASS) cfg.auth = { username: ACR_USER, password: ACR_PASS };

    const t0 = Date.now();
    const sr = await axios.get(acrBase(), cfg);
    logger.info('[ACR] /replayByUcid ACR resp', { ...ctx, status: sr.status, ms: Date.now() - t0, xmlSample: safeTrunc(sr.data, 400) });

    const parsed = await xml2js.parseStringPromise(sr.data);
    const results = parsed?.results?.result || [];
    logger.info('[ACR] /replayByUcid parsed', { ...ctx, count: results.length });

    if (!results.length) {
      logger.warn('[ACR] /replayByUcid no result', ctx);
      return res.status(404).send('No recording found for that UCID/date');
    }

    const { inum, fields } = mapResultFields(results[0]);

    if (!inum) {
      logger.warn('[ACR] /replayByUcid missing INUM', ctx);
      return res.status(502).send('ACR returned no INUM');
    }

    const { raw, proxied } = buildReplayUrls(inum);

    insertAcrRow({
      ucid,
      inum,
      started_at: fields.startedat || null,
      duration_sec: fields.duration ? parseInt(fields.duration, 10) : null,
      agents: fields.agents || null,
      other_parties: fields.otherparties || null,
      services: fields.services || null,
      skills: fields.skills || null,
      playback_url: proxied
    }, ctx);

    if (redirect === '1' || redirect === 'true') {
      logger.info('[ACR] /replayByUcid redirect → raw', { ...ctx, inum });
      return res.redirect(raw);
    }

    const preferLocal = (typeof local !== 'undefined')
      ? /^1|true$/i.test(String(local))
      : USE_LOCAL_DEFAULT;

    if (preferLocal) {
      try {
        const wavCtx = { ...ctx, inum };
        const wavPath = await ensureLocalWav(inum, wavCtx);
        logger.info('[ACR] /replayByUcid serve local wav', { ...wavCtx, wavPath });
        return streamFile(wavPath, req, res, 'audio/wav');
      } catch (e) {
        logger.warn('[ACR] /replayByUcid local WAV failed, fallback', { ...ctx, inum, error: e.message });
      }
    }

    logger.info('[ACR] /replayByUcid proxy fallback', { ...ctx, inum });
    req.params.inum = inum;
    return replayHandler(req, res);
  } catch (e) {
    const isInputErr = /^Invalid (startdate|enddate|windowDays)/.test(e.message);
    if (isInputErr) {
      logger.warn('[ACR] /replayByUcid invalid input', { ...ctx, error: e.message });
      if (!res.headersSent) return res.status(400).send(e.message);
    }
    logger.error('[ACR] /replayByUcid error', { ...ctx, error: e.message });
    if (!res.headersSent) res.status(502).send('ACR replayByUcid error: ' + e.message);
  }
});

// GET /api/acr/searchByNumber?number=0791234567&startdate=YYYY-MM-DD[&limit=3]
acr.get('/searchByNumber', async (req, res) => {
  const reqId = newReqId();
  const number = (req.query.number || '').trim();
  const startdate = (req.query.startdate || '').trim();
  const ctx = { route: '/acr/searchByNumber', reqId, number, ip: req.ip };

  logger.info('[ACR] /searchByNumber request', { ...ctx, query: req.query });

  const missing = [];
  if (!number) missing.push('number');
  if (!startdate) missing.push('startdate');
  if (missing.length) {
    logger.warn('[ACR] /searchByNumber missing params', { ...ctx, missing });
    return res.status(400).json({ ok: false, message: 'Missing required parameters', missing });
  }

  try {
    const { start, end, p1, p3 } = computeRangeFromQuery({ ...req.query, startdate });
    const p2 = (req.query.starttime || '00:00:00').trim();
    const p4 = (req.query.endtime || '23:59:59').trim();

    // limit logic
    let limit = parseInt(req.query.limit || '0', 10);
    if (!Number.isFinite(limit) || limit < 0) limit = 0;

    logger.info('[ACR] /searchByNumber window', { ...ctx, p1, p2, p3, p4, limit });

    const params = {
      command: 'search',
      layout: 'AvayaSegment',
      operator_startedat: 9,
      param1_startedat: p1,
      param2_startedat: p2,
      param3_startedat: p3,
      param4_startedat: p4,
      operator_otherparties: 8,
      param1_otherparties: number
    };

    const axiosCfg = { params, timeout: 30000 };
    if (ACR_USER && ACR_PASS) axiosCfg.auth = { username: ACR_USER, password: ACR_PASS };

    const r = await axios.get(acrBase(), axiosCfg);
    const parsed = await xml2js.parseStringPromise(r.data);
    const results = parsed?.results?.result || [];

    if (!results.length) {
      return res.json({ ok: true, found: 0, items: [], window: { start, end, p2, p4 } });
    }

    // Map ACR results
    const items = results.map(r => {
      const { inum, fields, switchcallid } = mapResultFields(r);
      if (!inum) return null;
      const { raw, proxied } = buildReplayUrls(inum);
      return {
        ucid: switchcallid || null,
        number,
        inum,
        started_at: fields.startedat || null,
        duration_sec: fields.duration ? parseInt(fields.duration, 10) : null,
        agents: fields.agents || null,
        other_parties: fields.otherparties || null,
        services: fields.services || null,
        skills: fields.skills || null,
        playback_url: proxied,
        raw_playback_url: raw
      };
    }).filter(Boolean);

    // Sort newest → oldest
    items.sort((a, b) => new Date(b.started_at || 0) - new Date(a.started_at || 0));
    const total = items.length;

    // ---- behavior ----
    if (!limit || limit <= 0) {
      const first = items[0];
      insertAcrRow(first, ctx);
      logger.info('[ACR] /searchByNumber single result', { ...ctx, inum: first.inum });
      return res.json({ ok: true, found: total, item: first, window: { start, end, p2, p4 } });
    }

    const limited = items.slice(0, limit);
    limited.forEach(p => insertAcrRow(p, ctx));
    logger.info('[ACR] /searchByNumber multiple results', { ...ctx, returned: limited.length, total });

    return res.json({
      ok: true,
      found: total,
      items: limited,
      window: { start, end, p2, p4 },
      limit
    });
  } catch (e) {
    const isInputErr = /^Invalid (startdate|enddate|windowDays)/.test(e.message);
    if (isInputErr) {
      logger.warn('[ACR] /searchByNumber invalid input', { ...ctx, error: e.message });
      return res.status(400).json({
        ok: false,
        message: e.message,
        invalid: ['startdate', req.query.enddate ? 'enddate' : undefined].filter(Boolean)
      });
    }
    logger.error('[ACR] /searchByNumber error', { ...ctx, error: e.message });
    return res.status(502).json({ ok: false, message: e.message });
  }
});

module.exports = acr;
