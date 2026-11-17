// ============================================
// WhatsApp Client Manager
// ============================================
// Handles WhatsApp connection, QR code, session persistence

const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const logger = require('./logger');

let client = null;
let clientReady = false;
let lastQR = null;

/**
 * Auto-detect system Chrome/Edge executable
 */
function getChromePath() {
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
        return process.env.CHROME_PATH;
    }
    const candidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium'
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return undefined;
}

/**
 * Initialize and return the WhatsApp client
 */
function createClient() {
    logger.info('Initializing WhatsApp client...');

    const chromePath = getChromePath();
    if (chromePath) {
        logger.info(`Using Chrome binary: ${chromePath}`);
    } else {
        logger.warn('No system Chrome found, falling back to Puppeteer default.');
    }

    client = new Client({
        authStrategy: new LocalAuth({
            clientId: process.env.SESSION_NAME || 'apex-session'
        }),
        webVersionCache: {
            type: 'none'
        },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        puppeteer: {
            executablePath: chromePath,
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--disable-gpu',
                '--no-zygote',
                '--disable-blink-features=AutomationControlled'
            ]
        }
    });

    // ---- Event Handlers ----

    // QR Code - scan this with your WhatsApp phone
    client.on('qr', (qr) => {
        lastQR = qr;
        logger.info('========================================');
        logger.info('  SCAN THIS QR CODE WITH YOUR WHATSAPP  ');
        logger.info('========================================');
        qrcodeTerminal.generate(qr, { small: true });
        logger.info('Waiting for QR scan... (or view in browser at http://localhost:3000)');
    });

    // Authenticated successfully
    client.on('authenticated', () => {
        logger.info('✅ WhatsApp authenticated successfully!');
        lastQR = null;
    });

    // Authentication failure
    client.on('auth_failure', (msg) => {
        logger.error(`❌ Authentication failed: ${msg}`);
        clientReady = false;
    });

    // Client is ready to send/receive messages
    client.on('ready', () => {
        clientReady = true;
        logger.info('✅ WhatsApp client is READY!');
        logger.info('You can now send messages via the API.');
    });

    // Disconnected
    client.on('disconnected', (reason) => {
        clientReady = false;
        logger.warn(`⚠️ WhatsApp disconnected: ${reason}`);
        logger.info('Attempting to reconnect...');
        // Auto-reconnect after 5 seconds
        setTimeout(() => {
            client.initialize().catch(err => {
                logger.error(`Reconnection failed: ${err.message}`);
            });
        }, 5000);
    });

    // Incoming message (for logging / future use)
    client.on('message', (msg) => {
        logger.info(`📩 Incoming message from ${msg.from}: ${msg.body.substring(0, 50)}...`);
    });

    // Start the client
    client.initialize().catch(err => {
        logger.error(`Failed to initialize client: ${err.message}`);
    });

    return client;
}

/**
 * Get the current client instance
 */
function getClient() {
    return client;
}

/**
 * Check if client is ready to send messages
 */
function isReady() {
    return clientReady;
}

/**
 * Get the last QR code (for web-based scanning)
 */
function getLastQR() {
    return lastQR;
}

/**
 * Get client status info
 */
async function getStatus() {
    if (!client) {
        return { status: 'not_initialized', ready: false };
    }

    const info = client.info || {};
    
    return {
        status: clientReady ? 'connected' : 'disconnected',
        ready: clientReady,
        needsQR: lastQR !== null,
        phone: info.wid ? info.wid.user : null,
        platform: info.platform || null,
        name: info.pushname || null
    };
}

/**
 * Get the last QR code as a base64 Data URL for web display
 */
async function getQRDataURL() {
    if (!lastQR) return null;
    try {
        return await QRCode.toDataURL(lastQR, { width: 300, margin: 2 });
    } catch (err) {
        logger.error(`Error generating QR data URL: ${err.message}`);
        return null;
    }
}

module.exports = {
    createClient,
    getClient,
    isReady,
    getLastQR,
    getQRDataURL,
    getStatus
};
