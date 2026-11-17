// ============================================
// API Routes - REST endpoints for Oracle APEX
// ============================================

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const logger = require('./logger');
const senderManager = require('./sender_manager');
const history = require('./history');
const config = require('./config');
const { processSpintax } = require('./antiban');

// ============================================
// Security: Safe File Upload Configuration
// ============================================
const BLOCKED_EXTENSIONS = new Set([
    '.exe', '.bat', '.cmd', '.sh', '.ps1', '.vbs', '.js', '.msi', '.dll', '.com', '.scr', '.pif'
]);

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 35 * 1024 * 1024 // 35 MB max
    },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (BLOCKED_EXTENSIONS.has(ext)) {
            return cb(new Error(`Executable or script files (${ext}) are not allowed for security reasons.`));
        }
        cb(null, true);
    }
});

// Load settings on startup
config.loadSettings();

// ============================================
// API Key Authentication Middleware
// ============================================
function authenticate(req, res, next) {
    const apiKey = req.headers['x-api-key'] || req.query.apiKey || req.body?.apiKey;
    const configuredKey = process.env.API_KEY || 'your-secret-api-key-change-this-12345';
    
    if (!apiKey || apiKey !== configuredKey) {
        logger.warn(`Unauthorized API request from ${req.ip}`);
        return res.status(401).json({
            success: false,
            error: 'Unauthorized - Invalid or missing API key',
            hint: 'Pass your API key in the x-api-key header or apiKey field'
        });
    }
    next();
}

// ============================================
// Helper: Extract Media from Request (Multer or Base64)
// ============================================
function extractMedia(req) {
    // 1. File uploaded via multipart/form-data
    if (req.file) {
        return {
            buffer: req.file.buffer,
            mimetype: req.file.mimetype,
            fileName: path.basename(req.file.originalname),
            caption: req.body.caption || ''
        };
    }

    // 2. Base64 file passed in JSON (Oracle APEX format)
    if (req.body.fileBase64) {
        const cleanBase64 = req.body.fileBase64.replace(/^data:[^;]+;base64,/, '');
        const buffer = Buffer.from(cleanBase64, 'base64');
        const rawFileName = req.body.fileName || 'document.pdf';
        const sanitizedFileName = path.basename(rawFileName);
        
        const ext = path.extname(sanitizedFileName).toLowerCase();
        if (BLOCKED_EXTENSIONS.has(ext)) {
            throw new Error(`Executable files (${ext}) are prohibited.`);
        }

        return {
            buffer,
            mimetype: req.body.mimeType || req.body.mimetype || 'application/pdf',
            fileName: sanitizedFileName,
            caption: req.body.caption || ''
        };
    }

    return null;
}

// ============================================
// POST /api/send-message
// Send text or media to single OR multiple recipients
// Supports sender selection ("auto" or specific senderId)
// ============================================
router.post('/send-message', upload.single('file'), authenticate, async (req, res) => {
    try {
        const { phone, phones, message, senderId, delaySeconds } = req.body;
        const recipients = phones || phone;

        if (!recipients) {
            return res.status(400).json({
                success: false,
                error: 'Recipient phone number(s) required (provide phone or phones)'
            });
        }

        const media = extractMedia(req);

        if (!message && !media) {
            return res.status(400).json({
                success: false,
                error: 'Either a text message or a file attachment is required'
            });
        }

        // Apply Spintax variation to message template if enabled
        const settings = config.getSettings();
        let processedMessage = message || '';
        if (processedMessage && settings.enableSpintax !== false) {
            processedMessage = processSpintax(processedMessage);
        }

        // Dispatch via Multi-Sender Orchestrator (handles single, bulk, and parallel)
        const dispatchResult = await senderManager.dispatch({
            senderId: senderId || 'auto',
            phones: recipients,
            message: processedMessage,
            media,
            delaySeconds
        });

        res.json({
            success: true,
            message: `Dispatched to ${dispatchResult.totalRecipients} recipient(s) across ${dispatchResult.parallelLinesActive} line(s)`,
            hasAttachment: !!media,
            fileName: media ? media.fileName : null,
            details: dispatchResult
        });

    } catch (err) {
        logger.error(`Send message error: ${err.message}`);
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// ============================================
// POST /api/send-receipt
// Convenience endpoint for order receipts with optional PDF/image invoice
// ============================================
router.post('/send-receipt', upload.single('file'), authenticate, async (req, res) => {
    try {
        const { 
            phone,
            phones,
            customerName, 
            orderNumber, 
            totalAmount, 
            orderDate,
            items,
            senderId,
            delaySeconds
        } = req.body;

        const recipients = phones || phone;

        if (!recipients || !customerName || !orderNumber || !totalAmount) {
            return res.status(400).json({
                success: false,
                error: 'Missing required receipt fields: phone/phones, customerName, orderNumber, totalAmount'
            });
        }

        let itemsList = '';
        if (items && Array.isArray(items) && items.length > 0) {
            itemsList = '\n📦 Items:\n' + items.map(i => `  • ${i}`).join('\n') + '\n';
        }

        const receiptTemplate = 
            `{Hello|Hi|Salam|Dear} ${customerName}! 🧾\n\n` +
            `{Thank you for your purchase|Thanks for shopping with us|We appreciate your business}!\n\n` +
            `🛒 Order: #${orderNumber}\n` +
            `💰 {Total|Amount|Grand Total}: Rs. ${totalAmount}\n` +
            `📅 Date: ${orderDate || new Date().toLocaleDateString()}\n` +
            itemsList + '\n' +
            `{Thank you|Thanks|Shukriya}! {Have a great day|See you again soon}! 😊`;

        const media = extractMedia(req);

        const dispatchResult = await senderManager.dispatch({
            senderId: senderId || 'auto',
            phones: recipients,
            message: receiptTemplate,
            media,
            delaySeconds
        });

        res.json({
            success: true,
            message: `Receipt queued for ${dispatchResult.totalRecipients} recipient(s)`,
            hasAttachment: !!media,
            fileName: media ? media.fileName : null,
            details: dispatchResult
        });

    } catch (err) {
        logger.error(`Send receipt error: ${err.message}`);
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// ============================================
// POST /api/send-file
// Convenience endpoint to send ONLY a file/image (with optional caption)
// Supports multipart/form-data upload or Base64 in JSON payload
// ============================================
router.post('/send-file', upload.single('file'), authenticate, async (req, res) => {
    try {
        const { phone, phones, caption, message, senderId, delaySeconds } = req.body;
        const recipients = phones || phone;

        if (!recipients) {
            return res.status(400).json({
                success: false,
                error: 'Recipient phone number(s) required (provide phone or phones)'
            });
        }

        const media = extractMedia(req);
        if (!media) {
            return res.status(400).json({
                success: false,
                error: 'A file attachment is required (upload file or pass fileBase64)'
            });
        }

        let finalCaption = caption || message || '';
        const settings = config.getSettings();
        if (finalCaption && settings.enableSpintax !== false) {
            finalCaption = processSpintax(finalCaption);
        }

        const dispatchResult = await senderManager.dispatch({
            senderId: senderId || 'auto',
            phones: recipients,
            message: finalCaption,
            media,
            delaySeconds
        });

        res.json({
            success: true,
            message: `File dispatched to ${dispatchResult.totalRecipients} recipient(s) across ${dispatchResult.parallelLinesActive} line(s)`,
            fileName: media.fileName,
            mimetype: media.mimetype,
            hasCaption: !!finalCaption,
            details: dispatchResult
        });

    } catch (err) {
        logger.error(`Send file error: ${err.message}`);
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// ============================================
// GET /api/senders
// List all configured senders and their live state
// ============================================
router.get('/senders', (req, res) => {
    res.json({
        success: true,
        senders: senderManager.getAllStatus(),
        aggregate: senderManager.getAggregateStats()
    });
});

// ============================================
// POST /api/senders
// Register and start a new WhatsApp sender line
// ============================================
router.post('/senders', async (req, res) => {
    try {
        const { name } = req.body;
        const session = await senderManager.addSender(name);
        res.json({
            success: true,
            message: `Sender line '${session.name}' created`,
            sender: session.getStatus()
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================
// DELETE /api/senders/:id
// Remove an extra sender line
// ============================================
router.delete('/senders/:id', async (req, res) => {
    try {
        const success = await senderManager.removeSender(req.params.id);
        res.json({ success, message: `Sender ${req.params.id} deleted` });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// ============================================
// GET /api/senders/:id/qr
// Get QR code for a specific sender (JSON data URL or Direct Image)
// ============================================
router.get('/senders/:id/qr', async (req, res) => {
    const session = senderManager.getSender(req.params.id);
    if (!session) {
        return res.status(404).json({ success: false, error: 'Sender not found' });
    }

    // Direct Image delivery for <img> tags
    const wantsImage = req.query.format === 'image' || req.headers.accept?.startsWith('image/');
    if (wantsImage) {
        if (!session.currentQR) {
            res.setHeader('Content-Type', 'image/svg+xml');
            return res.send('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><rect width="200" height="200" fill="#FCFAF6" rx="10"/><text x="100" y="95" font-family="sans-serif" font-size="12" text-anchor="middle" fill="#889174">Generating QR...</text><text x="100" y="115" font-family="sans-serif" font-size="11" text-anchor="middle" fill="#B8892D">Please wait 2-3 sec</text></svg>');
        }
        const buffer = await session.getQRBuffer();
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        return res.send(buffer);
    }

    const qr = await session.getQRDataURL();
    res.json({
        success: true,
        id: session.id,
        name: session.name,
        ready: session.isConnected,
        hasQR: qr !== null,
        qr
    });
});

// Dedicated direct PNG endpoint
router.get('/senders/:id/qr.png', async (req, res) => {
    const session = senderManager.getSender(req.params.id);
    if (!session || !session.currentQR) {
        res.setHeader('Content-Type', 'image/svg+xml');
        return res.send('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><rect width="200" height="200" fill="#FCFAF6" rx="10"/><text x="100" y="95" font-family="sans-serif" font-size="12" text-anchor="middle" fill="#889174">Generating QR...</text><text x="100" y="115" font-family="sans-serif" font-size="11" text-anchor="middle" fill="#B8892D">Please wait 2-3 sec</text></svg>');
    }
    const buffer = await session.getQRBuffer();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.send(buffer);
});

// ============================================
// POST /api/senders/:id/pairing-code
// Request 8-character Pairing Code for phone number
// ============================================
router.post('/senders/:id/pairing-code', async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) {
            return res.status(400).json({ success: false, error: 'Phone number is required' });
        }
        const session = senderManager.getSender(req.params.id);
        if (!session) {
            return res.status(404).json({ success: false, error: 'Sender line not found' });
        }
        const code = await session.requestPairingCode(phone);
        res.json({
            success: true,
            id: session.id,
            name: session.name,
            pairingCode: code
        });
    } catch (err) {
        logger.error(`Pairing code error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================
// GET /api/qr (Default QR for primary sender)
// ============================================
router.get('/qr', async (req, res) => {
    const primary = senderManager.getSender('sender_1');
    if (!primary) {
        return res.json({ success: false, hasQR: false, qr: null, ready: false });
    }

    const wantsImage = req.query.format === 'image' || req.headers.accept?.startsWith('image/');
    if (wantsImage) {
        if (!primary.currentQR) {
            res.setHeader('Content-Type', 'image/svg+xml');
            return res.send('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><rect width="200" height="200" fill="#FCFAF6" rx="10"/><text x="100" y="100" font-family="sans-serif" font-size="12" text-anchor="middle" fill="#889174">Waiting for QR Code...</text></svg>');
        }
        const buffer = await primary.getQRBuffer();
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        return res.send(buffer);
    }

    const qr = await primary.getQRDataURL();
    res.json({
        success: true,
        ready: primary.isConnected,
        hasQR: qr !== null,
        qr
    });
});

router.get('/qr.png', async (req, res) => {
    const primary = senderManager.getSender('sender_1');
    if (!primary || !primary.currentQR) {
        res.setHeader('Content-Type', 'image/svg+xml');
        return res.send('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><rect width="200" height="200" fill="#FCFAF6" rx="10"/><text x="100" y="100" font-family="sans-serif" font-size="12" text-anchor="middle" fill="#889174">Waiting for QR Code...</text></svg>');
    }
    const buffer = await primary.getQRBuffer();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.send(buffer);
});

// ============================================
// GET /api/status
// Full aggregate platform status
// ============================================
router.get('/status', (req, res) => {
    const primary = senderManager.getSender('sender_1');
    const senders = senderManager.getAllStatus();
    const aggregate = senderManager.getAggregateStats();

    res.json({
        success: true,
        whatsapp: primary ? primary.getStatus() : { status: 'disconnected', ready: false },
        senders,
        aggregate,
        settings: config.getSettings(),
        messages: history.getStats()
    });
});

// ============================================
// GET & POST /api/settings
// ============================================
router.get('/settings', (req, res) => {
    res.json({ success: true, settings: config.getSettings() });
});

router.post('/settings', (req, res) => {
    try {
        const updated = config.saveSettings(req.body);
        res.json({ success: true, message: 'Settings updated', settings: updated });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================
// GET /api/history
// ============================================
router.get('/history', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json({
        success: true,
        count: history.getRecent(limit).length,
        messages: history.getRecent(limit)
    });
});

// ============================================
// GET /api/health
// ============================================
router.get('/health', (req, res) => {
    res.json({
        success: true,
        uptime: process.uptime(),
        activeSenders: senderManager.getAggregateStats().activeSenders,
        timestamp: new Date().toISOString()
    });
});

module.exports = router;
