// ============================================
// Multi-Sender & Parallel Orchestrator
// ============================================
// Manages multiple independent WhatsApp sender accounts,
// parallel message queuing, and round-robin load balancing.

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const SenderSession = require('./sender_session');
const { sanitizePhoneNumber } = require('./antiban');

const REGISTRY_FILE = path.join(__dirname, '..', 'senders_registry.json');
const BASE_AUTH_DIR = path.join(__dirname, '..', 'baileys_auth');

class SenderManager {
    constructor() {
        this.senders = new Map(); // id -> SenderSession
        this.roundRobinIndex = 0;
    }

    async init() {
        logger.info('Initializing Multi-Sender Orchestrator...');

        let registry = this.loadRegistry();

        // Ensure at least one default primary sender exists
        if (registry.length === 0) {
            registry = [{ id: 'sender_1', name: 'Primary POS Counter' }];
            this.saveRegistry(registry);
        }

        // Initialize each configured sender in parallel
        for (const entry of registry) {
            const authPath = (entry.id === 'sender_1')
                ? BASE_AUTH_DIR
                : path.join(BASE_AUTH_DIR, 'sessions', entry.id);

            const session = new SenderSession(entry.id, entry.name, authPath);
            this.senders.set(entry.id, session);
            
            // Start session in background
            session.init().catch(err => {
                logger.error(`Error starting session ${entry.id}: ${err.message}`);
            });
        }

        logger.info(`Initialized ${this.senders.size} sender session(s)`);
    }

    loadRegistry() {
        try {
            if (fs.existsSync(REGISTRY_FILE)) {
                return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
            }
        } catch (e) {
            logger.warn(`Could not load senders registry: ${e.message}`);
        }
        return [];
    }

    saveRegistry(registry) {
        try {
            fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
        } catch (e) {
            logger.error(`Error saving senders registry: ${e.message}`);
        }
    }

    getSender(id) {
        if (!id || id === 'auto' || id === 'default') {
            return this.getNextConnectedSender() || this.senders.get('sender_1');
        }
        return this.senders.get(id);
    }

    /**
     * Get next connected sender for round-robin load balancing.
     * Distributes jobs across all active lines so they work in parallel!
     */
    getNextConnectedSender() {
        const connected = Array.from(this.senders.values()).filter(s => s.isConnected);
        if (connected.length === 0) {
            // Fallback to first sender even if disconnected
            return this.senders.values().next().value;
        }

        const sender = connected[this.roundRobinIndex % connected.length];
        this.roundRobinIndex++;
        return sender;
    }

    /**
     * Add a new independent WhatsApp line
     */
    async addSender(name) {
        const id = `sender_${Date.now().toString(36)}`;
        const authPath = path.join(BASE_AUTH_DIR, 'sessions', id);

        const session = new SenderSession(id, name || `Counter ${this.senders.size + 1}`, authPath);
        this.senders.set(id, session);

        // Update registry
        const registry = this.loadRegistry();
        registry.push({ id, name: session.name });
        this.saveRegistry(registry);

        await session.init();
        logger.info(`Added new sender session: ${id} (${session.name})`);
        return session;
    }

    /**
     * Remove an extra sender line
     */
    async removeSender(id) {
        if (id === 'sender_1') {
            throw new Error('Cannot delete the primary sender. You can disconnect or re-link it instead.');
        }

        const session = this.senders.get(id);
        if (!session) return false;

        try {
            if (session.sock) {
                session.sock.end();
            }
            if (fs.existsSync(session.authDir)) {
                fs.rmSync(session.authDir, { recursive: true, force: true });
            }
        } catch (e) {}

        this.senders.delete(id);

        const registry = this.loadRegistry().filter(item => item.id !== id);
        this.saveRegistry(registry);
        logger.info(`Removed sender session: ${id}`);
        return true;
    }

    /**
     * High-Level Dispatcher supporting:
     * - Single or Multiple Recipients (Bulk Sending)
     * - Targeted Sender OR Auto Parallel Round-Robin
     * - File/Media Attachments of all formats
     * - Spintax and Unique Invisible Hash Entropy per recipient
     */
    async dispatch({ senderId, phones, message, media, delaySeconds }) {
        // Parse & sanitize recipients list
        let rawList = [];
        if (Array.isArray(phones)) {
            rawList = phones;
        } else if (typeof phones === 'string') {
            rawList = phones.split(/[\r\n,;]+/).map(p => p.trim()).filter(Boolean);
        }

        if (rawList.length === 0) {
            throw new Error('At least one recipient phone number is required');
        }

        // Validate and sanitize phone numbers
        const phoneList = [];
        const invalidPhones = [];
        for (const raw of rawList) {
            const cleaned = sanitizePhoneNumber(raw);
            if (cleaned) {
                phoneList.push(cleaned);
            } else {
                invalidPhones.push(raw);
            }
        }

        if (phoneList.length === 0) {
            throw new Error(`No valid phone numbers found. Invalid entries: ${invalidPhones.join(', ')}`);
        }

        const results = [];
        const connectedSenders = Array.from(this.senders.values()).filter(s => s.isConnected);
        const parallelFactor = (senderId === 'auto' || !senderId) ? Math.max(1, connectedSenders.length) : 1;

        let index = 0;
        for (const phone of phoneList) {
            // Select sender: explicit line OR auto parallel round-robin
            const selectedSender = (senderId && senderId !== 'auto')
                ? (this.senders.get(senderId) || this.getNextConnectedSender())
                : this.getNextConnectedSender();

            if (!selectedSender) {
                throw new Error('No WhatsApp sender lines are initialized.');
            }

            // Check hourly rate limit on the assigned line
            const rateCheck = selectedSender.rateLimiter.check();
            if (!rateCheck.allowed) {
                throw new Error(`Sender '${selectedSender.name}' reached its hourly rate limit (${rateCheck.maxPerHour}/hr)`);
            }

            const queuePosition = selectedSender.queue.getStatus().pending + 1;

            // Enqueue asynchronously to this line's dedicated worker
            selectedSender.queue.add({
                phone,
                message,
                originalMessage: message,
                media,
                delaySeconds,
                recipientIndex: index
            }).catch(err => {
                logger.error(`[${selectedSender.id}] Error delivering to ${phone}: ${err.message}`);
            });

            results.push({
                phone,
                senderId: selectedSender.id,
                senderName: selectedSender.name,
                senderStatus: selectedSender.isConnected ? 'online' : 'connecting',
                queuePosition,
                estimatedDelaySec: delaySeconds || 6
            });

            index++;
        }

        return {
            totalRecipients: phoneList.length,
            invalidRecipients: invalidPhones,
            parallelLinesActive: parallelFactor,
            mode: (senderId && senderId !== 'auto') ? `Direct to ${senderId}` : `Parallel Round-Robin across ${parallelFactor} line(s)`,
            dispatched: results
        };
    }

    getAllStatus() {
        return Array.from(this.senders.values()).map(s => s.getStatus());
    }

    getAggregateStats() {
        let totalQueue = 0;
        let totalSentHour = 0;
        let activeSenders = 0;

        for (const s of this.senders.values()) {
            if (s.isConnected) activeSenders++;
            totalQueue += s.queue.getStatus().pending;
            totalSentHour += s.rateLimiter.getStats().sentLastHour;
        }

        return {
            totalSenders: this.senders.size,
            activeSenders,
            totalQueue,
            totalSentHour
        };
    }
}

module.exports = new SenderManager();
