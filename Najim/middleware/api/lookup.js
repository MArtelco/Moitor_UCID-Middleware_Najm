const express = require('express');
const sql = require('mssql');
const router = express.Router();

const DB_PORT = process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : undefined;
const DB_CONFIG = {
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  server: process.env.DB_SERVER,
  port: Number.isFinite(DB_PORT) ? DB_PORT : undefined,
  database: process.env.DB_NAME,
  options: { encrypt: false, trustServerCertificate: true }
};

const RAW_TABLE = process.env.CALL_TABLE_NAME || 'Calls';
const CALL_TABLE_NAME = RAW_TABLE.match(/^[A-Za-z0-9_]+$/) ? RAW_TABLE : 'Calls';

router.get('/ucidByTicket', async (req, res) => {
  const ticket = (req.query.ticket || '').trim();

  if (!ticket) {
    return res.status(400).json({ ok: false, message: 'Missing required query param: ticket' });
  }

  let pool;
  try {
    pool = await sql.connect(DB_CONFIG);

    const queryText = `
      SELECT
        ticket_number,
        ucid,
        agent_user,
        log_date
      FROM [${CALL_TABLE_NAME}]
      WHERE ticket_number = @ticket
      ORDER BY id DESC;
    `;

    const result = await pool.request()
      .input('ticket', sql.VarChar(100), ticket)
      .query(queryText);

    const rows = result.recordset || [];

        return res.json({
        ok: true,
        found: rows.length,
        items: rows.map(r => ({
            ticket_number: r.ticket_number,
            ucid: r.ucid,
            agent_user: r.agent_user,
            log_date: r.log_date
        }))
        });
        
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || 'DB error' });
  } finally {
    try { if (pool) await pool.close(); } catch {}
  }
});

module.exports = router;
