// api/onex.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const xml2js = require('xml2js');
const sql = require('mssql');
const logger = require('../logger'); // daily-rotate logger

// ===== DB CONFIG =====
const DB_PORT = process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : undefined;
const DB_CONFIG = {
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  server: process.env.DB_SERVER,
  port: Number.isFinite(DB_PORT) ? DB_PORT : undefined, // e.g. 1428
  database: process.env.DB_NAME,
  options: { encrypt: false, trustServerCertificate: true }
};

// Table names (explicit)
const CALL_TABLE_NAME   = process.env.CALL_TABLE_NAME ;
const ACTION_TABLE_NAME = process.env.ACTION_TABLE_NAME;
const DEVICE_MAP_TABLE_NAME = process.env.DEVICE_MAP_TABLE_NAME;

// ===== Polling config (strict: env only) =====
const UCID_POLL_INTERVAL_MS   = parseInt(process.env.UCID_POLL_INTERVAL_MS, 10);
const UCID_POLL_MAX_ATTEMPTS  = parseInt(process.env.UCID_POLL_MAX, 10);

// ===== One-X config (strict: env only) =====
const ONEX_SCHEME   = process.env.ONEX_SCHEME;   // http or https
const ONEX_PORT     = process.env.ONEX_PORT;     // e.g. 60000
const ONEX_API_PATH = process.env.ONEX_API_PATH; // e.g. /onexagent/api

// Optional dial prefix (e.g., "9" or "+962")
const CALL_PREFIX = process.env.CALL_PREFIX || '';

// ===== Utils =====
const parseXml = async (xml) => await xml2js.parseStringPromise(xml);
const maskPhone = (p) => (p ? String(p).replace(/.(?=.{4})/g, '*') : p);
function withPrefix(phone) {
  const p = String(phone || '');
  if (!CALL_PREFIX) return p;
  return p.startsWith(CALL_PREFIX) ? p : `${CALL_PREFIX}${p}`;
}
function assertEnv() {
  const missing = [];

  // DB (required)
  if (!DB_CONFIG.user)     missing.push('DB_USER');
  if (!DB_CONFIG.password) missing.push('DB_PASS');
  if (!DB_CONFIG.server)   missing.push('DB_SERVER');
  if (!DB_CONFIG.database) missing.push('DB_NAME');

  // Tables (required)
  if (!CALL_TABLE_NAME)        missing.push('CALL_TABLE_NAME');
  if (!ACTION_TABLE_NAME)      missing.push('ACTION_TABLE_NAME');
  if (!DEVICE_MAP_TABLE_NAME)  missing.push('DEVICE_MAP_TABLE_NAME');

  // Polling (required)
  if (!Number.isFinite(UCID_POLL_INTERVAL_MS))   missing.push('UCID_POLL_INTERVAL_MS');
  if (!Number.isFinite(UCID_POLL_MAX_ATTEMPTS))  missing.push('UCID_POLL_MAX');

  // One-X API (required)
  if (!ONEX_SCHEME)    missing.push('ONEX_SCHEME');
  if (!ONEX_PORT)      missing.push('ONEX_PORT');
  if (!ONEX_API_PATH)  missing.push('ONEX_API_PATH');

  // Fail if any hard requirements are missing
  if (missing.length) {
    const msg = `Missing required environment variables: ${missing.join(', ')}`;
    logger.error(msg);
    throw new Error(msg);
  }

  // Java UCID monitor (optional but recommended)
  if (!process.env.JAVA_UCID_BASEURL) {
    logger.warn('JAVA_UCID_BASEURL is not set — UCID will rely on One-X only (no AES monitor).');
  }
  // UCID_MONITOR_TIMEOUT_MS has a default; warn if unset but do not fail
  if (!process.env.UCID_MONITOR_TIMEOUT_MS) {
    logger.warn('UCID_MONITOR_TIMEOUT_MS not set; using default value in code.');
  }
}
assertEnv();

function buildBaseUrl(deviceIp) {
  if (typeof deviceIp === 'string' && /^https?:\/\//i.test(deviceIp)) {
    const url = new URL(deviceIp);
    if (ONEX_API_PATH && !url.pathname.endsWith(ONEX_API_PATH)) {
      url.pathname = (url.pathname.replace(/\/+$/, '') || '') + ONEX_API_PATH;
    }
    return url.toString();
  }
  const host = (deviceIp || '').trim();
  if (!host) throw new Error('Missing required deviceIp');
  if (!/^[a-zA-Z0-9.\-:]+$/.test(host)) throw new Error('Invalid device IP/host');
  const needsPort = !host.includes(':');
  const portPart = needsPort ? `:${ONEX_PORT}` : '';
  return `${ONEX_SCHEME}://${host}${portPart}${ONEX_API_PATH}`;
}

// ===== One-X helpers =====
async function registerClient(name, baseUrl, ctx) {
  logger.info('Registering One-X client', { ...ctx, clientName: name });
  const r = await axios.get(`${baseUrl}/registerclient`, { params: { name }, timeout: 10000 });
  const parsed = await parseXml(String(r.data || ''));
  const attrs = parsed?.RegisterClientResponse?.$ || {};
  logger.info('registerclient parsed', { ...ctx, attrs });
  return attrs; // { ResponseCode, ClientId? }
}
async function unregisterClient(clientid, baseUrl, ctx) {
  try {
    logger.info('Unregistering One-X client', { ...ctx, clientId: clientid });
    await axios.get(`${baseUrl}/unregisterclient`, { params: { clientid }, timeout: 10000 });
    logger.info('Unregistered One-X client', { ...ctx, clientId: clientid });
  } catch (err) {
    logger.warn('unregisterClient error', { ...ctx, error: err.message });
  }
}
async function ensureClient(baseUrl, preferredName, providedClientId, ctx) {
  if (providedClientId) return { clientId: providedClientId, created: false };
  const reg = await registerClient(preferredName, baseUrl, ctx);
  const clientId = reg.ClientId || reg.clientId;
  if (!clientId) throw new Error('Failed to register One-X client');
  return { clientId, created: true };
}
async function oneXVoiceAction(baseUrl, action, params, ctx) {
  const r = await axios.get(`${baseUrl}/voice/${action}`, { params, timeout: 15000 });
  const parsed = await parseXml(String(r.data || ''));
  const rootKey = Object.keys(parsed)[0] || '';
  const attrs = parsed?.[rootKey]?.$ || {};
  logger.info(`One-X ${action} response`, { ...ctx, status: r.status, attrs });
  return { status: r.status, attrs };
}

// ===== DB logging =====

// Insert into dbo.OnexCallLogs (requires NOT NULL fields)
// INSERT ONLY when we have ucid, interactionId, clientId (to satisfy NOT NULL)
async function insertOnexCallLog({
  ucid,
  ticketNumber,
  clientPhone,
  deviceIp,
  clientId,
  interactionId,
  agentUser
}) {
  if (!interactionId || !clientId) {
    logger.warn('[DB] Skipping OnexCallLogs insert: missing interactionId or clientId', {
      ucid: !!ucid, interactionId: !!interactionId, clientId: !!clientId
    });
    return;
  }
  let pool;
  try {
    pool = await sql.connect(DB_CONFIG);
      await pool.request()
        .input('ucid',            sql.VarChar(sql.MAX), ucid)
        .input('ticket_number',   sql.VarChar(100), ticketNumber || '')
        .input('client_phone',    sql.VarChar(50),  clientPhone || '')
        .input('device_ip',       sql.VarChar(50),  deviceIp || '')
        .input('client_id',       sql.VarChar(75),  clientId)
        .input('interaction_id',  sql.VarChar(100), interactionId)
        .input('agent_user',      sql.VarChar(100), agentUser || null)
        .query(`
          INSERT INTO ${CALL_TABLE_NAME}
            ( ucid, ticket_number, client_phone, device_ip, client_id, interaction_id, agent_user)
          VALUES
            (@ucid, @ticket_number, @client_phone, @device_ip, @client_id, @interaction_id, @agent_user)
        `);
    logger.info('[DB] OnexCallLogs insert OK');
  } catch (e) {
    logger.error('[DB] OnexCallLogs insert failed', { error: e.message });
  } finally {
    try { if (pool) await pool.close(); } catch {}
  }
}

// ===== Device ↔ Station map helpers =====
async function getStationByIp(deviceIp) {
  let pool;
  try {
    pool = await sql.connect(DB_CONFIG);
    const r = await pool.request()
      .input('device_ip', sql.VarChar(50), deviceIp)
      .query(`SELECT station FROM ${DEVICE_MAP_TABLE_NAME} WHERE device_ip = @device_ip`);
    return r.recordset[0]?.station || null;
  } catch (e) {
    logger.error('[DB] getStationByIp failed', { error: e.message, deviceIp });
    return null;
  } finally {
    try { if (pool) await pool.close(); } catch {}
  }
}

// ===== Java UCID monitor call =====
const JAVA_UCID_BASEURL = process.env.JAVA_UCID_BASEURL; // e.g. http://localhost:8081
const UCID_MONITOR_TIMEOUT_MS = parseInt(process.env.UCID_MONITOR_TIMEOUT_MS, 10);

async function getUcidFromJava(station, timeoutMs = UCID_MONITOR_TIMEOUT_MS, ctx = {}) {
  if (!JAVA_UCID_BASEURL) {
    logger.warn('JAVA_UCID_BASEURL not set; skipping AES UCID monitor', ctx);
    return null;
  }
  try {
    const url = `${JAVA_UCID_BASEURL.replace(/\/+$/, '')}/monitor`;
    const r = await axios.get(url, { params: { station, timeout: timeoutMs }, timeout: timeoutMs + 2000 });
    // Java responds: { ok, station, ucid } (200) or { ok:false, error:"timeout" } (202)
    const data = r.data || {};
    if (data.ok && data.ucid) {
      logger.info('Java UCID monitor returned', { ...ctx, station, ucid: data.ucid });
      return data.ucid;
    }
    logger.warn('Java UCID monitor no-ucid', { ...ctx, station, status: r.status, data });
    return null;
  } catch (e) {
    logger.warn('Java UCID monitor error', { ...ctx, station, error: e.message });
    return null;
  }
}

// Insert into dbo.OnexActionLogs (always log; success -> BIT)
async function insertOnexActionLog({
  action,
  deviceIp,
  interactionId,
  success,
  agentUser
}) {
  // Your table requires interaction_id NOT NULL. If action is by device only (no interaction),
  // store a placeholder so the row is valid. Change this behavior if you prefer another policy.
  const safeInteractionId = interactionId || '(by-ip)';
  let pool;
  try {
    pool = await sql.connect(DB_CONFIG);
    await pool.request()
      .input('action',        sql.VarChar(50),  action || '')
      .input('device_ip',     sql.VarChar(50),  deviceIp || '')
      .input('interaction_id',sql.VarChar(100), safeInteractionId)
      .input('success',       sql.Bit,          success ? 1 : 0)
      .input('agent_user',    sql.VarChar(100), agentUser || null)
      .query(`
        INSERT INTO ${ACTION_TABLE_NAME}
          (action, device_ip, interaction_id, success, agent_user)
        VALUES
          (@action, @device_ip, @interaction_id, @success, @agent_user)
      `);
    logger.info('[DB] OnexActionLogs insert OK', { action, success });
  } catch (e) {
    logger.error('[DB] OnexActionLogs insert failed', { error: e.message, action });
  } finally {
    try { if (pool) await pool.close(); } catch {}
  }
}

// ===== Server time helpers (no TZ conversion) =====
function nowServerDateTime() {
  const now = new Date(); // server clock
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return { date, time };
}

function sendJson(res, status, body) {
  const { date, time } = nowServerDateTime();
  return res.status(status).json({ ...body, date, time });
}
// ====== ROUTES ======

// === STARTCALL ===
// GET /api/onex/startcall?ticketNumber&clientPhone&deviceIp[&agentUser][&clientid]
router.get('/startcall', async (req, res) => {
  const { ticketNumber, clientPhone, deviceIp, agentUser } = req.query;
  let { clientid } = req.query;

  const dialNumber = withPrefix(clientPhone);
  const ctx = {
    ticketNumber,
    agentUser: agentUser || '',
    deviceIp,
    clientPhoneMasked: maskPhone(clientPhone),
    dialNumberMasked: maskPhone(dialNumber),
    callPrefixUsed: CALL_PREFIX || null,
    reqId: `${Date.now()}_${Math.random().toString(36).slice(2,8)}`
  };

  logger.info('startcall received', ctx);

  const missing = [];
  if (!ticketNumber) missing.push('ticketNumber');
  if (!clientPhone)  missing.push('clientPhone');
  if (!deviceIp)     missing.push('deviceIp');
  if (missing.length) {
    logger.warn('startcall missing parameters', { ...ctx, missing });
    return sendJson(res, 400, { success: false, missing, message: 'Missing required parameters' });
  }
  if (!Number.isFinite(UCID_POLL_INTERVAL_MS) || !Number.isFinite(UCID_POLL_MAX_ATTEMPTS)) {
    const msg = 'Polling variables not configured (UCID_POLL_INTERVAL_MS / UCID_POLL_MAX)';
    logger.error(msg, ctx);
    return sendJson(res, 500, { success: false, message: msg });
  }

  let baseUrl;
  try {
    baseUrl = buildBaseUrl(deviceIp);
  } catch (e) {
    logger.warn('buildBaseUrl failed', { ...ctx, error: e.message });
    return sendJson(res, 400, { success: false, message: e.message });
  }

  // 🔎 1) Resolve station from device IP
  let station = null;
  try {
    station = await getStationByIp(deviceIp);
    if (station) logger.info('Resolved station from map', { ...ctx, station });
    else logger.warn('No station mapping for deviceIp', { ...ctx });
  } catch (e) {
    logger.warn('getStationByIp error', { ...ctx, error: e.message });
  }

  const clientName = `CRM_${(agentUser || 'anon')}_${ticketNumber}_${Date.now()}`;
  let createdTemp = false;
  let interactionId = null;

  // Will hold UCIDs from both sources
  let ucidFromJava = null;
  let ucidFromOnex = null;

  try {
    const ensured = await ensureClient(baseUrl, clientName, clientid, ctx);
    clientid = ensured.clientId;
    createdTemp = ensured.created;

    // ⏱ 2) If we have a station, start Java UCID monitor in parallel
    const javaUcidPromise = station
      ? getUcidFromJava(station, UCID_MONITOR_TIMEOUT_MS, ctx)
      : Promise.resolve(null);

    // 3) Make the call
    await axios.get(`${baseUrl}/voice/makecall`, {
      params: { clientid, number: dialNumber, device: deviceIp },
      timeout: 15000
    });

    // 4) Poll One-X notifications for VoiceInteractionCreated (for interactionId and possibly UCID)
    let attempts = 0;
    while (attempts < UCID_POLL_MAX_ATTEMPTS && (!interactionId || !ucidFromOnex)) {
      attempts++;
      try {
        const notifyRes = await axios.get(`${baseUrl}/nextnotification`, {
          params: { clientid },
          timeout: 15000
        });
        const parsedNotify = await parseXml(String(notifyRes.data || ''));
        const voice = parsedNotify?.NextNotificationResponse?.VoiceInteractionCreated?.[0]?.$;
        if (voice) {
          interactionId = voice.ObjectId || interactionId;
          ucidFromOnex = voice.UCID || ucidFromOnex;
          break;
        }
      } catch (pollErr) {
        logger.warn('nextnotification poll error', { ...ctx, attempt: attempts, error: pollErr.message });
      }
      await new Promise((r) => setTimeout(r, UCID_POLL_INTERVAL_MS));
    }

    // 5) Await Java UCID (if we started it) without blocking forever
    try { ucidFromJava = await javaUcidPromise; } catch {}

    // Prefer UCID from Java AES monitor; fall back to One-X
    const ucid = ucidFromJava || ucidFromOnex || null;

    // 6) Insert call log ONLY if we have NOT NULLs required by your table
    await insertOnexCallLog({
      ucid,
      ticketNumber,
      clientPhone,
      deviceIp,
      clientId: clientid,
      interactionId,
      agentUser: agentUser || ''
    });

    return sendJson(res, 200, {
      success: !!interactionId,
      ucid,                        
      interactionId: interactionId || null,
      clientId: clientid,
      dialed: clientPhone,
      station: station || null
    });

  } catch (err) {
    logger.error('/startcall error', { ...ctx, error: err.message });
    return sendJson(res, 500, { success: false, message: err.message || 'internal error' });
  } finally {
    if (createdTemp) { try { await unregisterClient(clientid, baseUrl, ctx); } catch {} }
  }
});


// ==== RELEASE (end call) ====
// GET /api/onex/release?deviceIp=IP&interactionid=VI[:GUID][&agentUser][&ticketNumber][&clientPhone]
router.get('/release', async (req, res) => {
  const { deviceIp, interactionid, agentUser, ticketNumber, clientPhone } = req.query;
  let { clientid } = req.query;
  const ctx = { op: 'release', agentUser: agentUser || '', interactionid };

  if (!deviceIp || !interactionid) {
    return sendJson(res, 400, { success: false, message: 'deviceIp and interactionid are required' });
  }

  let baseUrl, createdTemp = false;
  try {
    baseUrl = buildBaseUrl(deviceIp);
    const ensured = await ensureClient(baseUrl, `CRM_${agentUser || 'anon'}_RELEASE_${Date.now()}`, clientid, ctx);
    clientid = ensured.clientId;
    createdTemp = ensured.created;

    const { attrs } = await oneXVoiceAction(baseUrl, 'release', { clientid, interactionid }, ctx);
    const ok = attrs.ResponseCode === '0';

    // Log action into OnexActionLogs
    await insertOnexActionLog({
      action: 'RELEASE',
      deviceIp,
      interactionId: interactionid,
      success: ok,
      agentUser: agentUser || ''
    });

    if (!ok) {
      return sendJson(res, 502, { success: false, code: attrs.ResponseCode, clientId: clientid, interactionId: interactionid });
    }

    // SUCCESS → include date/time via sendJson helper
    return sendJson(res, 200, {
      success: true,
      code: attrs.ResponseCode,
      clientId: clientid,
      interactionId: interactionid
    });

  } catch (e) {
    logger.error('release error', { ...ctx, error: e.message });

    // Log failed action as well
    await insertOnexActionLog({
      action: 'RELEASE',
      deviceIp,
      interactionId: interactionid,
      success: false,
      agentUser: agentUser || ''
    });

    return sendJson(res, 500, { success: false, message: e.message });
  } finally {
    if (createdTemp) {
      try { await unregisterClient(clientid, baseUrl, ctx); } catch {}
    }
  }
});

// ==== HOLD ====
// GET /api/onex/hold?deviceIp=IP&interactionid=VI[:GUID][&clientid][&agentUser]
router.get('/hold', async (req, res) => {
  const { deviceIp, interactionid, agentUser } = req.query;
  let { clientid } = req.query;
  const ctx = { op: 'HOLD', agentUser: agentUser || '', interactionid };

  if (!deviceIp || !interactionid) {
    return res.status(400).json({ success: false, message: 'deviceIp and interactionid are required' });
  }

  let baseUrl, createdTemp = false;
  let ok = false;
  try {
    baseUrl = buildBaseUrl(deviceIp);
    const ensured = await ensureClient(baseUrl, `CRM_${agentUser || 'anon'}_HOLD_${Date.now()}`, clientid, ctx);
    clientid = ensured.clientId;
    createdTemp = ensured.created;

    const { attrs } = await oneXVoiceAction(baseUrl, 'hold', { clientid, interactionid }, ctx);
    ok = attrs.ResponseCode === '0';

    // Log action
    await insertOnexActionLog({
      action: 'HOLD',
      deviceIp,
      interactionId: interactionid,
      success: ok,
      agentUser: agentUser || ''
    });

    if (!ok) return res.status(502).json({ success: false, code: attrs.ResponseCode, clientId: clientid });
    res.json({ success: true, code: attrs.ResponseCode});
  } catch (e) {
    logger.error('hold error', { ...ctx, error: e.message });
    await insertOnexActionLog({
      action: 'HOLD',
      deviceIp,
      interactionId: interactionid,
      success: false,
      agentUser: agentUser || ''
    });
    res.status(500).json({ success: false, message: e.message });
  } finally {
    if (createdTemp) {
      try { await unregisterClient(clientid, baseUrl, ctx); } catch {}
    }
  }
});

// ==== UNHOLD ====
// GET /api/onex/unhold?deviceIp=IP&interactionid=...&[clientid][&agentUser]
router.get('/unhold', async (req, res) => {
  const { deviceIp, interactionid, agentUser } = req.query;
  let { clientid } = req.query;
  const ctx = { op: 'UNHOLD', agentUser: agentUser || '', interactionid };

  if (!deviceIp || !interactionid) {
    return res.status(400).json({ success: false, message: 'deviceIp and interactionid are required' });
  }

  let baseUrl, createdTemp = false;
  let ok = false;
  try {
    baseUrl = buildBaseUrl(deviceIp);
    const ensured = await ensureClient(baseUrl, `CRM_${agentUser || 'anon'}_UNHOLD_${Date.now()}`, clientid, ctx);
    clientid = ensured.clientId;
    createdTemp = ensured.created;

    const { attrs } = await oneXVoiceAction(baseUrl, 'unhold', { clientid, interactionid }, ctx);
    ok = attrs.ResponseCode === '0';

    await insertOnexActionLog({
      action: 'UNHOLD',
      deviceIp,
      interactionId: interactionid,
      success: ok,
      agentUser: agentUser || ''
    });

    if (!ok) return res.status(502).json({ success: false, code: attrs.ResponseCode, clientId: clientid });
    res.json({ success: true, code: attrs.ResponseCode });
  } catch (e) {
    logger.error('unhold error', { ...ctx, error: e.message });
    await insertOnexActionLog({
      action: 'UNHOLD',
      deviceIp,
      interactionId: interactionid,
      success: false,
      agentUser: agentUser || ''
    });
    res.status(500).json({ success: false, message: e.message });
  } finally {
    if (createdTemp) {
      try { await unregisterClient(clientid, baseUrl, ctx); } catch {}
    }
  }
});

// ==== MUTE ====
// GET /api/onex/mute?deviceIp=IP[&interactionid][&agentUser]
router.get('/mute', async (req, res) => {
  const { deviceIp, agentUser, interactionid } = req.query; // <-- added interactionid (optional)
  let { clientid } = req.query;
  const ctx = { op: 'MUTE', agentUser: agentUser || '', interactionid: interactionid || null };

  if (!deviceIp) return res.status(400).json({ success: false, message: 'deviceIp is required' });

  let baseUrl, createdTemp = false;
  let ok = false;
  try {
    baseUrl = buildBaseUrl(deviceIp);
    const ensured = await ensureClient(baseUrl, `CRM_${agentUser || 'anon'}_MUTE_${Date.now()}`, clientid, ctx);
    clientid = ensured.clientId;
    createdTemp = ensured.created;

    const { attrs } = await oneXVoiceAction(baseUrl, 'mute', { clientid }, ctx); // One-X mute does not use interactionid
    ok = attrs.ResponseCode === '0';

    // If interactionid was provided, store it; otherwise insertOnexActionLog will save placeholder "(by-ip)"
    await insertOnexActionLog({
      action: 'MUTE',
      deviceIp,
      interactionId: interactionid || null,
      success: ok,
      agentUser: agentUser || ''
    });

    if (!ok) return res.status(502).json({ success: false, code: attrs.ResponseCode });
    res.json({ success: true, code: attrs.ResponseCode });
  } catch (e) {
    logger.error('mute error', { ...ctx, error: e.message });
    await insertOnexActionLog({
      action: 'MUTE',
      deviceIp,
      interactionId: interactionid || null,
      success: false,
      agentUser: agentUser || ''
    });
    res.status(500).json({ success: false, message: e.message });
  } finally {
    if (createdTemp) {
      try { await unregisterClient(clientid, baseUrl, ctx); } catch {}
    }
  }
});

// ==== UNMUTE ====
// GET /api/onex/unmute?deviceIp=IP[&interactionid][&agentUser]
router.get('/unmute', async (req, res) => {
  const { deviceIp, agentUser, interactionid } = req.query; // <-- added interactionid (optional)
  let { clientid } = req.query;
  const ctx = { op: 'UNMUTE', agentUser: agentUser || '', interactionid: interactionid || null };

  if (!deviceIp) return res.status(400).json({ success: false, message: 'deviceIp is required' });

  let baseUrl, createdTemp = false;
  let ok = false;
  try {
    baseUrl = buildBaseUrl(deviceIp);
    const ensured = await ensureClient(baseUrl, `CRM_${agentUser || 'anon'}_UNMUTE_${Date.now()}`, clientid, ctx);
    clientid = ensured.clientId;
    createdTemp = ensured.created;

    const { attrs } = await oneXVoiceAction(baseUrl, 'unmute', { clientid }, ctx); // One-X unmute does not use interactionid
    ok = attrs.ResponseCode === '0';

    await insertOnexActionLog({
      action: 'UNMUTE',
      deviceIp,
      interactionId: interactionid || null,
      success: ok,
      agentUser: agentUser || ''
    });

    if (!ok) return res.status(502).json({ success: false, code: attrs.ResponseCode });
    res.json({ success: true, code: attrs.ResponseCode });
  } catch (e) {
    logger.error('unmute error', { ...ctx, error: e.message });
    await insertOnexActionLog({
      action: 'UNMUTE',
      deviceIp,
      interactionId: interactionid || null,
      success: false,
      agentUser: agentUser || ''
    });
    res.status(500).json({ success: false, message: e.message });
  } finally {
    if (createdTemp) {
      try { await unregisterClient(clientid, baseUrl, ctx); } catch {}
    }
  }
});


module.exports = router;
