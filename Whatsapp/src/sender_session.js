// ============================================
// Single Sender Session Class (Baileys)
// ============================================
// Manages an independent WhatsApp line, WebSocket,
// dedicated queue, rate limiter, and file sending.

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const logger = require('./logger');
const config = require('./config');
const history = require('./history');
const { RateLimiter, MessageQueue, processSpintax, addAntiDuplicateEntropy, sanitizePhoneNumber, sleep } = require('./antiban');

class SenderSession {
    constructor(id, name, authDir) {
        this.id = id;
        this.name = name || `Sender ${id}`;
        this.authDir = authDir;
        this.sock = null;
        this.isConnected = false;
        this.currentQR = null;
        this.currentPairingCode = null;
        this.clientInfo = null;

        // Dedicated independent rate limiter and queue for parallel processing
        this.rateLimiter = new RateLimiter();
        this.queue = new MessageQueue();

        // Bind queue processor
        this.queue.onProcess(async (job) => {
            return await this._processJob(job);
        });
    }

    async init() {
        logger.info(`[${this.id}] Initializing session '${this.name}' at: ${this.authDir}`);

        if (!fs.existsSync(this.authDir)) {
            fs.mkdirSync(this.authDir, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
        const { version } = await fetchLatestBaileysVersion();

        this.sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: ['ApexSender (Windows)', 'Desktop', '2.0.0'],
            syncFullHistory: false,
            generateHighQualityLinkPreview: false
        });

        this.sock.ev.on('creds.update', saveCreds);

        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                this.currentQR = qr;
                logger.info(`[${this.id}] QR Code generated for '${this.name}'`);
                qrcodeTerminal.generate(qr, { small: true });
            }

            if (connection === 'close') {
                this.isConnected = false;
                this.currentQR = null;
                const statusCode = (lastDisconnect?.error instanceof Boom)
                    ? lastDisconnect.error.output?.statusCode
                    : null;

                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                logger.warn(`[${this.id}] Connection closed: ${lastDisconnect?.error?.message || 'Unknown'}, code: ${statusCode}`);

                if (shouldReconnect) {
                    logger.info(`[${this.id}] Reconnecting in 5 seconds...`);
                    setTimeout(() => {
                        this.init().catch(err => logger.error(`[${this.id}] Reconnect failed: ${err.message}`));
                    }, 5000);
                } else {
                    logger.error(`[${this.id}] Device logged out. Clearing credentials...`);
                    try {
                        fs.rmSync(this.authDir, { recursive: true, force: true });
                    } catch (e) {}
                    setTimeout(() => {
                        this.init().catch(err => logger.error(`[${this.id}] Restart failed: ${err.message}`));
                    }, 2000);
                }
            } else if (connection === 'open') {
                this.isConnected = true;
                this.currentQR = null;

                const user = this.sock.user || {};
                this.clientInfo = {
                    phone: user.id ? user.id.split(':')[0] : 'Connected',
                    name: user.name || this.name
                };

                logger.info(`========================================`);
                logger.info(`✅ [${this.id}] CONNECTED! Phone: ${this.clientInfo.phone} (${this.name})`);
                logger.info(`========================================`);
            }
        });

        return this;
    }

    /**
     * Internal processor for this sender's queue
     */
    async _processJob(job) {
        const { phone, message, originalMessage, media, recipientIndex = 0 } = job;
        
        const cleanNumber = sanitizePhoneNumber(phone);
        if (!cleanNumber) {
            throw new Error(`Invalid phone number format: '${phone}'. Must be 10-15 digits.`);
        }

        const jid = cleanNumber + '@s.whatsapp.net';

        // Apply anti-duplicate invisible entropy to message text/caption
        let finalMessage = message || '';
        if (finalMessage) {
            finalMessage = addAntiDuplicateEntropy(finalMessage, recipientIndex);
        }

        // Send safely with typing simulation
        const result = await this.sendMessageSafe(
            jid,
            { text: finalMessage, media },
            process.env.ENABLE_TYPING !== 'false'
        );

        this.rateLimiter.record();

        history.addRecord({
            phone: cleanNumber,
            senderId: this.id,
            senderName: this.name,
            chatId: jid,
            originalMessage: originalMessage || message,
            sentMessage: finalMessage,
            hasAttachment: !!media,
            fileName: media ? media.fileName : null,
            status: 'sent',
            messageId: result?.key?.id || null
        });

        logger.info(`[${this.id}] ✅ Message delivered to ${cleanNumber} (${this.name})`);
        return { success: true, messageId: result?.key?.id || null, phone: cleanNumber };
    }

    /**
     * Send message supporting ALL media formats:
     * - PDF invoices & documents
     * - Images (JPG, PNG, WEBP, GIF)
     * - Audio files & Voice notes (MP3, OGG, WAV, M4A)
     * - Video clips (MP4, MOV)
     * - Office files (Word .docx, Excel .xlsx, CSV, TXT, ZIP)
     */
    async sendMessageSafe(jid, content, simulateTyping = true) {
        if (!this.sock || !this.isConnected) {
            throw new Error(`Sender '${this.name}' (${this.id}) is not connected to WhatsApp.`);
        }

        const settings = config.getSettings();

        // 1. Simulate human typing presence
        if (simulateTyping && settings.enableTyping !== false) {
            try {
                await this.sock.sendPresenceUpdate('composing', jid);
                const typingMs = Math.round((settings.typingSeconds || 2) * 1000);
                await sleep(typingMs);
                await this.sock.sendPresenceUpdate('paused', jid);
                await sleep(300);
            } catch (e) {
                logger.warn(`[${this.id}] Typing presence simulation failed: ${e.message}`);
            }
        }

        // 2. Prepare Baileys message payload
        let messagePayload = {};

        if (content.media && content.media.buffer) {
            const { buffer, mimetype, fileName, caption } = content.media;
            const textCaption = caption || content.text || '';
            const mime = (mimetype || '').toLowerCase();

            if (mime.startsWith('image/')) {
                messagePayload = {
                    image: buffer,
                    caption: textCaption,
                    mimetype: mime
                };
            } else if (mime.startsWith('video/')) {
                messagePayload = {
                    video: buffer,
                    caption: textCaption,
                    mimetype: mime
                };
            } else if (mime.startsWith('audio/')) {
                messagePayload = {
                    audio: buffer,
                    mimetype: mime || 'audio/mp4',
                    ptt: false
                };
            } else {
                // Documents: PDF, Excel, Word, Text, Zip, etc.
                messagePayload = {
                    document: buffer,
                    mimetype: mime || 'application/octet-stream',
                    fileName: fileName || 'document.pdf',
                    caption: textCaption
                };
            }
        } else {
            messagePayload = { text: content.text || '' };
        }

        // 3. Dispatch via Baileys socket
        return await this.sock.sendMessage(jid, messagePayload);
    }

    async getQRDataURL() {
        if (!this.currentQR) return null;
        try {
            return await QRCode.toDataURL(this.currentQR, { width: 300, margin: 2 });
        } catch (err) {
            return null;
        }
    }

    async getQRBuffer() {
        if (!this.currentQR) return null;
        try {
            return await QRCode.toBuffer(this.currentQR, { width: 300, margin: 2 });
        } catch (err) {
            return null;
        }
    }

    async requestPairingCode(phoneNumber) {
        if (!this.sock) {
            throw new Error(`Socket for '${this.name}' is not initialized`);
        }
        if (this.isConnected) {
            throw new Error(`Sender '${this.name}' is already connected`);
        }
        let cleanPhone = phoneNumber.toString().replace(/\D/g, '');
        if (cleanPhone.startsWith('0') && cleanPhone.length === 11) {
            cleanPhone = '92' + cleanPhone.substring(1);
        }
        logger.info(`[${this.id}] Requesting Pairing Code for phone: ${cleanPhone}...`);
        const code = await this.sock.requestPairingCode(cleanPhone);
        this.currentPairingCode = code;
        logger.info(`[${this.id}] 🔑 Pairing Code received: ${code}`);
        return code;
    }

    getStatus() {
        return {
            id: this.id,
            name: this.name,
            status: this.isConnected ? 'connected' : 'disconnected',
            ready: this.isConnected,
            phone: this.clientInfo ? this.clientInfo.phone : null,
            hasQR: this.currentQR !== null,
            pairingCode: this.currentPairingCode || null,
            rateLimit: this.rateLimiter.getStats(),
            queue: this.queue.getStatus()
        };
    }
}

module.exports = SenderSession;
