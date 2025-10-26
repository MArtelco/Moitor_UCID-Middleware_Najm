// logger.js
const fs = require('fs');
const path = require('path');
const { createLogger, format, transports } = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

if (!global.__APP_LOGGER__) {
  const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
  const LOG_MAX_FILES = process.env.LOG_MAX_FILES || '14d'; // e.g. "14d" or "20"
  const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
  const LOG_TO_CONSOLE = /^true$/i.test(process.env.LOG_TO_CONSOLE || 'false');

  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

  // Reusable line formatter: timestamp + level + message + metadata (as JSON)
  const lineFormat = format.combine(
    format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
    format.errors({ stack: true }),
    format.splat(),
    format.printf(({ timestamp, level, message, stack, ...meta }) => {
      const base = { timestamp, level, message: stack || message };
      const extras = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      return JSON.stringify(base) + extras;
    })
  );

  const fileTransport = new DailyRotateFile({
    dirname: LOG_DIR,
    filename: 'app-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    zippedArchive: false,
    maxSize: null,
    maxFiles: LOG_MAX_FILES,
    // Explicit format for the transport so timestamp ALWAYS shows
    format: lineFormat
  });

  const loggerTransports = [fileTransport];

  if (LOG_TO_CONSOLE) {
    loggerTransports.push(
      new transports.Console({
        level: LOG_LEVEL,
        format: lineFormat
      })
    );
  }

  const logger = createLogger({
    level: LOG_LEVEL,
    // Keep a top-level format too (used by transports without an explicit format)
    format: lineFormat,
    transports: loggerTransports,
    exitOnError: false
  });

  global.__APP_LOGGER__ = logger;
}

module.exports = global.__APP_LOGGER__;
