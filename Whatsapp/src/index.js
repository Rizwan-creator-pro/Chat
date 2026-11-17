// ============================================
// WhatsApp APEX API - Main Entry Point
// ============================================
// A secure WhatsApp messaging server with anti-ban
// protection, designed for Oracle APEX integration
// ============================================

require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const senderManager = require('./sender_manager');
const routes = require('./routes');
const history = require('./history');

// ============================================
// Create logs directory
// ============================================
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// ============================================
// Express Server Setup
// ============================================
const app = express();
const PORT = process.env.PORT || 3000;

// Parse JSON bodies (up to 50MB for Base64 PDF attachments)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Request logging
app.use((req, res, next) => {
    if (req.path !== '/api/health') {  // Don't log health checks
        logger.info(`${req.method} ${req.path} from ${req.ip}`);
    }
    next();
});

// CORS (allow Oracle APEX to call from any origin)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Serve static files from public directory (Dashboard)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Root endpoint - API info (if JSON requested)
app.get('/api-info', (req, res) => {
    res.json({
        name: 'WhatsApp APEX API',
        version: '1.0.0',
        description: 'WhatsApp messaging server for Oracle APEX with anti-ban protection',
        endpoints: {
            'POST /api/send-message': 'Send a WhatsApp message (requires x-api-key header)',
            'POST /api/send-receipt': 'Send an order receipt (requires x-api-key header)',
            'GET  /api/status':       'Check WhatsApp connection status',
            'GET  /api/qr':           'Get latest QR code image',
            'GET  /api/history':      'View recent message history',
            'GET  /api/health':       'Health check'
        }
    });
});

// ============================================
// API Routes
// ============================================
app.use('/api', routes);

// ============================================
// Error handler
// ============================================
app.use((err, req, res, next) => {
    logger.error(`Unhandled error: ${err.message}`);
    res.status(500).json({
        success: false,
        error: 'Internal server error'
    });
});

// ============================================
// Global error handlers (prevent crashes)
// ============================================
process.on('unhandledRejection', (reason, promise) => {
    logger.error(`Unhandled Rejection: ${reason}`);
});

process.on('uncaughtException', (err) => {
    logger.error(`Uncaught Exception: ${err.message}`);
    // Don't exit — keep the server running
});

// ============================================
// Start everything
// ============================================
async function start() {
    logger.info('============================================');
    logger.info('  WhatsApp APEX API Server Starting...      ');
    logger.info('============================================');

    // Load message history
    history.loadHistory();

    // Start Multi-Sender Orchestrator (Parallel Senders Engine)
    await senderManager.init();

    // Start Express server
    app.listen(PORT, () => {
        logger.info(`🚀 Server running on http://localhost:${PORT}`);
        logger.info(`📋 API Docs: http://localhost:${PORT}/`);
        logger.info('');
        logger.info('Anti-Ban Settings:');
        logger.info(`  Max messages/hour: ${process.env.MAX_MESSAGES_PER_HOUR || 15}`);
        logger.info(`  Delay range: ${process.env.MIN_DELAY_MS || 10000}ms - ${process.env.MAX_DELAY_MS || 30000}ms`);
        logger.info(`  Typing simulation: ${process.env.ENABLE_TYPING !== 'false' ? 'ON' : 'OFF'}`);
        logger.info(`  Spintax variation: ${process.env.ENABLE_SPINTAX !== 'false' ? 'ON' : 'OFF'}`);
        logger.info('');
        logger.info('⏳ Waiting for WhatsApp QR code...');
        logger.info('   (Scan it with your phone to connect)');
    });
}

start();
