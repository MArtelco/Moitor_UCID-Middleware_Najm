// server.js
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const https = require('https');
const express = require('express');
const cors = require('cors');

const onexRoutes = require('./api/onex');
const acrRoutes  = require('./api/acr');
const lookupRoutes = require('./api/lookup');  

const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');

const app = express();

// ---------- Config ----------
const HOST = process.env.HOST;
const PORT = Number(process.env.PORT);
const SSL_KEY_PATH = process.env.SSL_KEY_PATH;
const SSL_CERT_PATH = process.env.SSL_CERT_PATH;

// For pkg or relative execution: always resolve paths from current working directory
const rpath = (p) => path.isAbsolute(p) ? p : path.join(process.cwd(), p);

// ---------- Middleware ----------
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// ---------- Swagger setup ----------
const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'Middleware API',
      version: '1.0.0',
      description: 'one-X Agent + ACR middleware',
    },
    servers: [{ url: `https://${HOST}:${PORT}` }],
  },
  apis: [path.join(__dirname, 'swagger-routes/*.js')],
});

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, { explorer: true }));
app.get('/docs.json', (_req, res) => res.json(swaggerSpec));

// ---------- Health ----------
app.get('/', (_req, res) => res.send('Middleware API is running. See /docs'));
app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------- Routes ----------
app.use('/api/onex', onexRoutes);
app.use('/api/acr', acrRoutes);
app.use('/api/lookup', lookupRoutes);          

// ---------- HTTPS server ----------
const httpsOptions = {
  key:  fs.readFileSync(rpath(SSL_KEY_PATH)),
  cert: fs.readFileSync(rpath(SSL_CERT_PATH)),
};

https.createServer(httpsOptions, app).listen(PORT, HOST, () => {
  console.log(`🔐 HTTPS server running at: https://${HOST}:${PORT}`);
  console.log(`📖 Swagger UI available at: https://${HOST}:${PORT}/docs`);
});
