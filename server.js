const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cron = require('node-cron');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ================== GLOBAL ERROR HANDLER ==================
process.on('unhandledRejection', (reason, promise) => {
    console.warn('⚠️ Unhandled Promise Rejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('⚠️ Uncaught Exception:', err.message);
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

// ================== CONFIG ==================
let client = null;
let isConnected = false;
let qrCodeData = null;
let isDisconnecting = false;
let watchdogTimer = null;

let RATE_LIMIT = {
    batchSize: null,
    delaySeconds: null,
    messageDelaySeconds: null
};

// ================== SETTINGS ==================
let SETTINGS = {
    blastOnly: false // true = hanya bisa blast, tidak terima pesan masuk
};

const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');

function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            SETTINGS = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
            console.log(`✅ Settings loaded: blastOnly=${SETTINGS.blastOnly}`);
        }
    } catch (err) {
        console.error('Error loading settings:', err);
        SETTINGS = { blastOnly: false };
    }
}

function saveSettings() {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(SETTINGS, null, 2));
    } catch (err) {
        console.error('Error saving settings:', err);
    }
}

// ================== DATA DIRECTORIES ==================
const DATA_DIR = path.join(__dirname, 'data');

// Files
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const KONSEPS_FILE = path.join(DATA_DIR, 'konseps.json');
const REMINDERS_FILE = path.join(DATA_DIR, 'reminders.json');
const LOGS_FILE = path.join(DATA_DIR, 'logs.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const ACTIVITY_LOGS_FILE = path.join(DATA_DIR, 'activityLogs.json');

// Memory storage
let contacts = [];
let groups = [];
let konsepList = [];
let reminderList = [];
let messageLogs = [];
let users = [];
let activityLogs = [];
const sessions = new Map();

// ================== AUTH & ACTIVITY HELPERS ==================
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.pbkdf2Sync(String(password), salt, 100000, 64, 'sha512').toString('hex');
    return { salt, hash };
}

function verifyPassword(password, user) {
    if (!user || !user.passwordHash || !user.salt) return false;
    const { hash } = hashPassword(password, user.salt);
    const candidate = Buffer.from(hash, 'hex');
    const stored = Buffer.from(user.passwordHash, 'hex');
    if (candidate.length !== stored.length) return false;
    return crypto.timingSafeEqual(candidate, stored);
}

function createDefaultAdminUser() {
    const { salt, hash } = hashPassword(process.env.ADMIN_PASSWORD || 'kppnbahagia');
    return {
        id: 'admin',
        username: 'admin',
        passwordHash: hash,
        salt,
        role: 'admin',
        createdAt: new Date().toISOString(),
        createdBy: 'system'
    };
}

function sanitizeUser(user) {
    if (!user) return null;
    const { passwordHash, salt, ...safeUser } = user;
    return safeUser;
}

function clientIp(req) {
    return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
}


// Initialize data files
function initDefaultFiles() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(CONTACTS_FILE)) fs.writeFileSync(CONTACTS_FILE, JSON.stringify([], null, 2));
    if (!fs.existsSync(GROUPS_FILE)) fs.writeFileSync(GROUPS_FILE, JSON.stringify(["Default"], null, 2));
    if (!fs.existsSync(KONSEPS_FILE)) fs.writeFileSync(KONSEPS_FILE, JSON.stringify([], null, 2));
    if (!fs.existsSync(REMINDERS_FILE)) fs.writeFileSync(REMINDERS_FILE, JSON.stringify([], null, 2));
    if (!fs.existsSync(LOGS_FILE)) fs.writeFileSync(LOGS_FILE, JSON.stringify([], null, 2));
    if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([createDefaultAdminUser()], null, 2));
    if (!fs.existsSync(ACTIVITY_LOGS_FILE)) fs.writeFileSync(ACTIVITY_LOGS_FILE, JSON.stringify([], null, 2));
}

initDefaultFiles();

// ================== LOADER FUNCTIONS ==================
function loadContacts() {
    try {
        if (fs.existsSync(CONTACTS_FILE)) {
            contacts = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
            console.log(`✅ Loaded ${contacts.length} contacts`);
        }
    } catch (err) {
        console.error('Error loading contacts:', err);
        contacts = [];
    }
}

function saveContacts() {
    try {
        fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2));
    } catch (err) {
        console.error('Error saving contacts:', err);
    }
}

function loadGroups() {
    try {
        if (fs.existsSync(GROUPS_FILE)) {
            groups = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
            if (!groups || groups.length === 0) {
                groups = ['Default'];
                saveGroups();
            }
            console.log(`✅ Loaded ${groups.length} groups`);
        }
    } catch (err) {
        console.error('Error loading groups:', err);
        groups = ['Default'];
    }
}

function saveGroups() {
    try {
        fs.writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2));
    } catch (err) {
        console.error('Error saving groups:', err);
    }
}

function loadKonseps() {
    try {
        if (fs.existsSync(KONSEPS_FILE)) {
            konsepList = JSON.parse(fs.readFileSync(KONSEPS_FILE, 'utf8'));
            console.log(`✅ Loaded ${konsepList.length} concepts`);
        }
    } catch (err) {
        console.error('Error loading konseps:', err);
        konsepList = [];
    }
}

function saveKonseps() {
    try {
        fs.writeFileSync(KONSEPS_FILE, JSON.stringify(konsepList, null, 2));
    } catch (err) {
        console.error('Error saving konseps:', err);
    }
}

function loadReminders() {
    try {
        if (fs.existsSync(REMINDERS_FILE)) {
            reminderList = JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8'));
            console.log(`✅ Loaded ${reminderList.length} reminders`);
        }
    } catch (err) {
        console.error('Error loading reminders:', err);
        reminderList = [];
    }
}

function saveReminders() {
    try {
        fs.writeFileSync(REMINDERS_FILE, JSON.stringify(reminderList, null, 2));
    } catch (err) {
        console.error('Error saving reminders:', err);
    }
}

function loadLogs() {
    try {
        if (fs.existsSync(LOGS_FILE)) {
            messageLogs = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'));
            console.log(`✅ Loaded ${messageLogs.length} logs`);
        }
    } catch (err) {
        console.error('Error loading logs:', err);
        messageLogs = [];
    }
}

function saveLogs() {
    try {
        fs.writeFileSync(LOGS_FILE, JSON.stringify(messageLogs, null, 2));
    } catch (err) {
        console.error('Error saving logs:', err);
    }
}

function loadUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
            if (!Array.isArray(users)) users = [];
        }

        // Pastikan akun admin bawaan selalu tersedia dan password-nya sesuai konfigurasi.
        // Ini mencegah login gagal jika data/users.json lama/corrupt/hasil copy dari versi lain.
        const defaultAdmin = createDefaultAdminUser();
        const adminIndex = users.findIndex(u =>
            u && (u.id === 'admin' || String(u.username || '').toLowerCase() === 'admin')
        );

        if (adminIndex === -1) {
            users.unshift(defaultAdmin);
            saveUsers();
        } else {
            users[adminIndex] = {
                ...users[adminIndex],
                id: 'admin',
                username: 'admin',
                passwordHash: defaultAdmin.passwordHash,
                salt: defaultAdmin.salt,
                role: 'admin',
                createdAt: users[adminIndex].createdAt || defaultAdmin.createdAt,
                createdBy: users[adminIndex].createdBy || 'system'
            };
            saveUsers();
        }

        console.log(`✅ Loaded ${users.length} users`);
    } catch (err) {
        console.error('Error loading users:', err);
        users = [createDefaultAdminUser()];
        saveUsers();
    }
}

function saveUsers() {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    } catch (err) {
        console.error('Error saving users:', err);
    }
}

function loadActivityLogs() {
    try {
        if (fs.existsSync(ACTIVITY_LOGS_FILE)) {
            activityLogs = JSON.parse(fs.readFileSync(ACTIVITY_LOGS_FILE, 'utf8'));
            if (!Array.isArray(activityLogs)) activityLogs = [];
            console.log(`✅ Loaded ${activityLogs.length} activity logs`);
        }
    } catch (err) {
        console.error('Error loading activity logs:', err);
        activityLogs = [];
    }
}

function saveActivityLogs() {
    try {
        fs.writeFileSync(ACTIVITY_LOGS_FILE, JSON.stringify(activityLogs, null, 2));
    } catch (err) {
        console.error('Error saving activity logs:', err);
    }
}

function addActivityLog(user, action, detail = {}, req = null) {
    const safeUser = sanitizeUser(user) || { id: 'system', username: 'system', role: 'system' };
    const log = {
        id: `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
        timestamp: new Date().toISOString(),
        userId: safeUser.id,
        username: safeUser.username,
        role: safeUser.role,
        action,
        detail,
        ip: req ? clientIp(req) : '',
        userAgent: req ? (req.headers['user-agent'] || '') : ''
    };
    activityLogs.unshift(log);
    if (activityLogs.length > 1000) activityLogs.pop();
    saveActivityLogs();
    io.to('admins').emit('activityLog', log);
}

function authMiddleware(req, res, next) {
    const header = req.headers.authorization || '';
    const bearerToken = header.startsWith('Bearer ') ? header.slice(7) : null;
    const token = bearerToken || req.headers['x-auth-token'];
    const session = token ? sessions.get(token) : null;

    if (!session) {
        return res.status(401).json({ success: false, message: 'Sesi tidak valid. Silakan login kembali.' });
    }

    const user = users.find(u => u.id === session.userId);
    if (!user) {
        sessions.delete(token);
        return res.status(401).json({ success: false, message: 'User tidak ditemukan. Silakan login kembali.' });
    }

    req.user = sanitizeUser(user);
    req.authToken = token;

    const shouldLog = ['POST', 'PUT', 'DELETE'].includes(req.method) ||
        req.originalUrl.startsWith('/api/connect') ||
        req.originalUrl.startsWith('/api/disconnect');

    if (shouldLog && !req.originalUrl.startsWith('/api/auth/logout')) {
        res.on('finish', () => {
            addActivityLog(req.user, `${req.method} ${req.originalUrl.split('?')[0]}`, {
                statusCode: res.statusCode,
                success: res.statusCode < 400
            }, req);
        });
    }

    next();
}

function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Akses hanya untuk admin.' });
    }
    next();
}

// ================== FORMAT PHONE ==================
function formatWhatsAppNumber(nomor) {
    if (!nomor) return null;
    let cleaned = nomor.toString().replace(/[^0-9]/g, '');
    if (cleaned.startsWith('0')) {
        cleaned = '62' + cleaned.slice(1);
    }
    return cleaned;
}

function getMessageSenderNumber(msg, contact) {
    const candidates = [];

    // contact.number adalah nomor telepon WA yang benar. Ini lebih aman daripada msg.from
    // karena pada beberapa WhatsApp terbaru msg.from bisa berisi @lid, bukan nomor HP.
    if (contact && contact.number) candidates.push(contact.number);
    if (contact && contact.id && contact.id.server === 'c.us' && contact.id.user) candidates.push(contact.id.user);
    if (msg && msg.from && msg.from.includes('@c.us')) candidates.push(msg.from.split('@')[0]);
    if (msg && msg.author && msg.author.includes('@c.us')) candidates.push(msg.author.split('@')[0]);

    for (const candidate of candidates) {
        const formatted = formatWhatsAppNumber(candidate);
        if (formatted && formatted.length >= 8 && formatted.length <= 16) return formatted;
    }

    return '';
}

// ================== LOG MESSAGE ==================
function logMessage(type, contactName, nomor, message, status, group = null, extra = {}) {
    const log = {
        id: Date.now().toString(),
        timestamp: new Date().toISOString(),
        type,
        contactName: contactName || 'Unknown',
        nomor: nomor || '',
        message: message || '',
        status,
        group,
        ...extra
    };
    messageLogs.unshift(log);
    if (messageLogs.length > 500) messageLogs.pop();
    saveLogs();
    // Emit to connected clients via SSE
    io.emit('newLog', log);
}

// ================== WATCHDOG ==================
function startLoginWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    
    console.log('⚡ Starting WhatsApp Auth Watchdog...');
    watchdogTimer = setInterval(async () => {
        if (!client || !client.pupPage || isDisconnecting) return;

        try {
            if (client.pupPage.isClosed()) return;

            const status = await client.pupPage.evaluate(() => {
                const paneSide = document.querySelector('#pane-side');
                const chatList = document.querySelector('[data-testid="chat-list"]');
                if (paneSide || chatList) return 'LOGGED_IN';
                return 'STANDBY';
            });

            if (status === 'LOGGED_IN' && !isConnected) {
                console.log('⚡ WhatsApp Web validated as Logged In!');
                isConnected = true;
                qrCodeData = null;
                io.emit('statusChange', { connected: true });
            }
        } catch (err) {}
    }, 2000);
}

// ================== WHATSAPP CLIENT ==================
function initWhatsApp() {
    try {
        if (client) client.destroy().catch(() => {});
    } catch(e) {}

    console.log('🔄 Initializing WhatsApp Client...');
    isDisconnecting = false;
    isConnected = false;
    qrCodeData = null;

    client = new Client({
        authStrategy: new LocalAuth(),
        authTimeoutMs: 0,
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu'
            ]
        },
        webVersionCache: { type: 'none' }
    });

    client.on('loading_screen', (percent, message) => {
        console.log(`⏳ Loading WhatsApp Web: ${percent}%`);
    });

    client.on('qr', (qr) => {
        console.log('📱 QR Code received from Meta');
        qrcode.toDataURL(qr).then(url => {
            qrCodeData = url;
            isConnected = false;
            console.log('✅ QR Code generated and ready');
            io.emit('qr', { qr: url });
        }).catch(err => {
            console.error('Failed to generate QR Code:', err);
        });
    });

    client.on('authenticated', () => {
        console.log('🔐 WhatsApp Authenticated successfully!');
        isConnected = true;
        qrCodeData = null;
        io.emit('statusChange', { connected: true });
    });

    client.on('ready', () => {
        console.log('✅ WhatsApp Ready & Fully Connected!');
        isConnected = true;
        qrCodeData = null;
        io.emit('statusChange', { connected: true });
    });

    client.on('disconnected', (reason) => {
        console.log('❌ WhatsApp Disconnected:', reason);
        isConnected = false;
        qrCodeData = null;
        io.emit('statusChange', { connected: false });
    });

    // ================== INCOMING MESSAGE HANDLER ==================
    client.on('message', async msg => {
        try {
            // Check if blastOnly mode is enabled
            if (SETTINGS.blastOnly) {
                console.log(`🚫 Message from ${msg.from} ignored (Blast Only Mode)`);
                return;
            }

            // Ignore group messages
            if (msg.from.includes('@g.us')) {
                console.log('📢 Group message ignored');
                return;
            }

            // Ignore status broadcasts
            if (msg.to === 'status@broadcast') {
                return;
            }

            const contact = await msg.getContact();
            const senderName = contact.pushname || contact.name || contact.shortName || 'Unknown';
            const senderNumber = getMessageSenderNumber(msg, contact);
            const senderWaId = (contact && contact.id && contact.id._serialized) || msg.from;
            
            // Pesan masuk hanya dicatat di log.
            // Tidak otomatis ditambahkan ke kontak agar ID internal WhatsApp (@lid) tidak masuk sebagai nomor kontak.

            logMessage('in', senderName, senderNumber, msg.body, 'received', null, {
                waId: senderWaId,
                rawFrom: msg.from
            });
            console.log(`📩 Message received from ${senderName} (${senderNumber || senderWaId}): ${msg.body.substring(0, 50)}...`);
            
            io.emit('newMessage', { 
                from: senderName, 
                number: senderNumber,
                waId: senderWaId,
                message: msg.body,
                timestamp: new Date().toISOString()
            });
        } catch (err) {
            console.error('Error logging message:', err);
        }
    });

    startLoginWatchdog();

    client.initialize().catch(err => {
        if (isDisconnecting || err.message.includes('Target closed')) {
            console.log('🛑 WhatsApp initialization stopped.');
        } else {
            console.error('❌ WhatsApp initialization error:', err.message);
        }
        isConnected = false;
        qrCodeData = null;
    });
}

// ================== SEND MESSAGE ==================
function toPositiveNumber(value, integer = false) {
    if (value === null || value === undefined || value === '') return null;
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue) || numberValue <= 0) return null;
    return integer ? Math.floor(numberValue) : numberValue;
}

async function waitSeconds(seconds) {
    const safeSeconds = toPositiveNumber(seconds);
    if (!safeSeconds) return;
    await new Promise(resolve => setTimeout(resolve, safeSeconds * 1000));
}

let isSending = false;
let currentSendJob = null;
let sendQueue = [];

function publicQueueJob(job) {
    if (!job) return null;
    return {
        id: job.id,
        type: job.type,
        label: job.label,
        group: job.group || null,
        total: job.total || 0,
        createdAt: job.createdAt,
        startedAt: job.startedAt || null
    };
}

function getSendQueueStatus() {
    return {
        active: isSending,
        current: publicQueueJob(currentSendJob),
        waiting: sendQueue.length,
        queue: sendQueue.map(publicQueueJob)
    };
}

function emitSendQueueStatus() {
    io.emit('sendQueueUpdate', getSendQueueStatus());
}

function processSendQueue() {
    if (isSending) return;

    const job = sendQueue.shift();
    if (!job) {
        currentSendJob = null;
        emitSendQueueStatus();
        return;
    }

    isSending = true;
    currentSendJob = { ...job, startedAt: new Date().toISOString() };
    emitSendQueueStatus();

    Promise.resolve()
        .then(job.run)
        .then(result => {
            job.resolve({
                ...result,
                queued: job.queuedBefore,
                queuePosition: job.queuePosition
            });
        })
        .catch(job.reject)
        .finally(() => {
            isSending = false;
            currentSendJob = null;
            emitSendQueueStatus();
            processSendQueue();
        });
}

function enqueueSendBlast({ contacts, template, group = null, batch = null, delay = null, perMessageDelay = null, type = 'blast', label = null }) {
    const queuedBefore = isSending || sendQueue.length > 0;
    const queuePosition = sendQueue.length + (isSending ? 1 : 0);

    return new Promise((resolve, reject) => {
        const job = {
            id: `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
            type,
            label: label || (type === 'reminder' ? `Reminder ${group || '-'}` : `Pengiriman ${group || '-'}`),
            group,
            total: Array.isArray(contacts) ? contacts.filter(c => c.selected !== false).length : 0,
            createdAt: new Date().toISOString(),
            queuedBefore,
            queuePosition,
            run: () => sendBlast(contacts, template, group, batch, delay, perMessageDelay),
            resolve,
            reject
        };

        sendQueue.push(job);
        emitSendQueueStatus();
        processSendQueue();
    });
}

async function sendBlast(targetContacts, template, groupName = null, batchSizeCustom = null, delayCustom = null, messageDelayCustom = null) {
    if (!isConnected || !client) {
        throw new Error('WhatsApp belum terhubung. Silakan scan QR terlebih dahulu.');
    }

    const selectedContacts = targetContacts.filter(c => c.selected !== false);
    let sent = 0;
    let failed = 0;

    const actualBatchSize = toPositiveNumber(batchSizeCustom ?? RATE_LIMIT.batchSize, true);
    const actualBatchDelay = toPositiveNumber(delayCustom ?? RATE_LIMIT.delaySeconds);
    const actualMessageDelay = toPositiveNumber(messageDelayCustom ?? RATE_LIMIT.messageDelaySeconds);

    // Patch WidFactory if needed
    try {
        await client.pupPage.evaluate(() => {
            if (window.WWebJS && window.WWebJS.Chat && window.WDFlag === undefined) {
                window.WDFlag = true;
            }
        });
    } catch(e) {}

    for (let i = 0; i < selectedContacts.length; i++) {
        const contact = selectedContacts[i];
        const nomor = formatWhatsAppNumber(contact.x1);
        const directWaId = contact.waId || contact.chatId || null;
        
        if (!nomor && !directWaId) {
            failed++;
            logMessage('out', contact.x3 || 'Unknown', contact.x1, template, 'failed', groupName);
            continue;
        }

        let messageText = template;
        Object.keys(contact).forEach(key => {
            if (key.startsWith('x') && contact[key]) {
                messageText = messageText.replace(new RegExp(`{${key}}`, 'gi'), contact[key]);
            }
        });

        const chatId = directWaId || (nomor + '@c.us');
        const logNumber = nomor || directWaId;
        
        try {
            await client.sendMessage(chatId, messageText);
            sent++;
            logMessage('out', contact.x3 || 'Unknown', logNumber, messageText, 'sent', groupName, directWaId ? { waId: directWaId } : {});
            console.log(`✅ Sent to ${contact.x3 || logNumber}: ${messageText.substring(0, 30)}...`);
            io.emit('blastProgress', { sent, failed, total: selectedContacts.length });
        } catch (err) {
            failed++;
            logMessage('out', contact.x3 || 'Unknown', logNumber, messageText, 'failed', groupName, directWaId ? { waId: directWaId } : {});
            console.log(`❌ Failed to ${contact.x3 || logNumber}: ${err.message}`);
        }

        const hasNextContact = i < selectedContacts.length - 1;
        const isBatchBoundary = actualBatchSize && actualBatchDelay && ((i + 1) % actualBatchSize === 0);

        if (hasNextContact && isBatchBoundary) {
            console.log(`⏳ Keamanan 2: batch ${actualBatchSize} pesan selesai. Menunggu ${actualBatchDelay}s...`);
            await waitSeconds(actualBatchDelay);
        } else if (hasNextContact && actualMessageDelay) {
            console.log(`⏳ Keamanan 1: menunggu ${actualMessageDelay}s sebelum pesan berikutnya...`);
            await waitSeconds(actualMessageDelay);
        }
    }

    return { sent, failed, total: selectedContacts.length };
}

// ================== HTTP SERVER WITH SOCKET.IO ==================
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');

const io = new Server(server, {
    cors: { origin: "*" }
});

io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    const session = token ? sessions.get(token) : null;
    const user = session ? users.find(u => u.id === session.userId) : null;
    if (!session || !user) return next(new Error('Unauthorized'));
    socket.user = sanitizeUser(user);
    next();
});

io.on('connection', (socket) => {
    console.log('🔌 Client connected:', socket.id, socket.user ? `(${socket.user.username})` : '');
    if (socket.user && socket.user.role === 'admin') socket.join('admins');
    
    // Send current status
    socket.emit('statusChange', { connected: isConnected });
    
    // Send settings
    socket.emit('settingsUpdate', SETTINGS);

    // Send queue status
    socket.emit('sendQueueUpdate', getSendQueueStatus());
    
    socket.on('disconnect', () => {
        console.log('🔌 Client disconnected:', socket.id);
    });
});


// ================== AUTH API ==================
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    const normalizedUsername = String(username || '').trim().toLowerCase();
    const user = users.find(u => u.username.toLowerCase() === normalizedUsername);

    if (!user || !verifyPassword(password || '', user)) {
        addActivityLog(
            user ? sanitizeUser(user) : { id: 'unknown', username: normalizedUsername || 'unknown', role: 'unknown' },
            'LOGIN_FAILED',
            { reason: user ? 'invalid_password' : 'unknown_user' },
            req
        );
        return res.status(401).json({ success: false, message: 'Username atau password salah.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, {
        userId: user.id,
        createdAt: Date.now(),
        lastSeen: Date.now()
    });

    addActivityLog(sanitizeUser(user), 'LOGIN_SUCCESS', {}, req);
    res.json({ success: true, token, user: sanitizeUser(user) });
});

// Semua endpoint /api di bawah ini wajib login.
app.use('/api', authMiddleware);

app.get('/api/auth/me', (req, res) => {
    res.json({ success: true, user: req.user });
});

app.post('/api/auth/logout', (req, res) => {
    sessions.delete(req.authToken);
    addActivityLog(req.user, 'LOGOUT', {}, req);
    res.json({ success: true, message: 'Logout berhasil' });
});

// ================== USER MANAGEMENT API (ADMIN) ==================
app.get('/api/users', requireAdmin, (req, res) => {
    res.json(users.map(sanitizeUser));
});

app.post('/api/users', requireAdmin, (req, res) => {
    const { username, password, role } = req.body || {};
    const cleanUsername = String(username || '').trim();
    const cleanRole = role === 'admin' ? 'admin' : 'user';

    if (!cleanUsername || cleanUsername.length < 3) {
        return res.status(400).json({ success: false, message: 'Username minimal 3 karakter.' });
    }
    if (!password || String(password).length < 6) {
        return res.status(400).json({ success: false, message: 'Password minimal 6 karakter.' });
    }
    if (users.some(u => u.username.toLowerCase() === cleanUsername.toLowerCase())) {
        return res.status(400).json({ success: false, message: 'Username sudah digunakan.' });
    }

    const { salt, hash } = hashPassword(password);
    const newUser = {
        id: `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
        username: cleanUsername,
        passwordHash: hash,
        salt,
        role: cleanRole,
        createdAt: new Date().toISOString(),
        createdBy: req.user.username
    };

    users.push(newUser);
    saveUsers();
    addActivityLog(req.user, 'USER_CREATED', { username: cleanUsername, role: cleanRole }, req);
    res.json({ success: true, user: sanitizeUser(newUser), users: users.map(sanitizeUser) });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    const target = users.find(u => u.id === id);
    if (!target) return res.status(404).json({ success: false, message: 'User tidak ditemukan.' });
    if (target.id === 'admin' || target.id === req.user.id) {
        return res.status(400).json({ success: false, message: 'User ini tidak dapat dihapus.' });
    }

    users = users.filter(u => u.id !== id);
    for (const [token, session] of sessions.entries()) {
        if (session.userId === id) sessions.delete(token);
    }
    saveUsers();
    addActivityLog(req.user, 'USER_DELETED', { username: target.username, role: target.role }, req);
    res.json({ success: true, message: 'User berhasil dihapus.', users: users.map(sanitizeUser) });
});

// ================== ACTIVITY LOG API (ADMIN) ==================
app.get('/api/activity-logs', requireAdmin, (req, res) => {
    res.json(activityLogs);
});

app.delete('/api/activity-logs', requireAdmin, (req, res) => {
    activityLogs = [];
    saveActivityLogs();
    addActivityLog(req.user, 'ACTIVITY_LOGS_CLEARED', {}, req);
    res.json({ success: true, message: 'Log aktivitas berhasil dihapus.' });
});

// ================== WHATSAPP CONNECTION API ==================
app.get('/api/qr', (req, res) => {
    if (isConnected) {
        res.json({ connected: true, qr: null });
    } else {
        res.json({ connected: false, qr: qrCodeData });
    }
});

app.get('/api/status', (req, res) => {
    res.json({ 
        connected: isConnected, 
        blastOnly: SETTINGS.blastOnly,
        sendQueue: getSendQueueStatus()
    });
});

app.get('/api/connect', (req, res) => {
    initWhatsApp();
    res.json({ message: 'Connecting to WhatsApp...' });
});

app.get('/api/disconnect', (req, res) => {
    isDisconnecting = true;
    if (client) {
        client.destroy();
        client = null;
    }
    isConnected = false;
    qrCodeData = null;
    res.json({ message: 'Disconnected from WhatsApp' });
});

// ================== SETTINGS API ==================
app.get('/api/settings', (req, res) => {
    res.json(SETTINGS);
});

app.post('/api/settings', (req, res) => {
    const { blastOnly } = req.body;
    if (typeof blastOnly === 'boolean') {
        SETTINGS.blastOnly = blastOnly;
        saveSettings();
        io.emit('settingsUpdate', SETTINGS);
        console.log(`🔧 Blast Only Mode: ${SETTINGS.blastOnly ? 'ENABLED' : 'DISABLED'}`);
        res.json({ success: true, settings: SETTINGS });
    } else {
        res.status(400).json({ success: false, message: 'Invalid settings' });
    }
});

// Rate Limit
app.post('/api/settings/rate-limit', (req, res) => {
    const { batchSize, delaySeconds, messageDelaySeconds } = req.body;
    RATE_LIMIT.batchSize = toPositiveNumber(batchSize, true);
    RATE_LIMIT.delaySeconds = toPositiveNumber(delaySeconds);
    RATE_LIMIT.messageDelaySeconds = toPositiveNumber(messageDelaySeconds);
    res.json({ success: true, settings: RATE_LIMIT });
});

// ================== CONTACTS API ==================
app.get('/api/contacts', (req, res) => {
    res.json(contacts);
});

app.post('/api/contacts', (req, res) => {
    const newContacts = req.body;
    if (Array.isArray(newContacts)) {
        // Merge with existing contacts (no duplicates by x1)
        newContacts.forEach(newC => {
            const exists = contacts.find(c => c.x1 === newC.x1);
            if (!exists) {
                contacts.push(newC);
                // Auto-create group if not exists
                if (newC.x2 && !groups.includes(newC.x2)) {
                    groups.push(newC.x2);
                    saveGroups();
                }
            }
        });
        saveContacts();
        res.json({ success: true, message: `${contacts.length} kontak tersimpan`, contacts });
    } else {
        res.status(400).json({ success: false, message: 'Data harus berupa array' });
    }
});

// Bulk add contacts from upload (blast/reminder)
app.post('/api/contacts/bulk', (req, res) => {
    const newContacts = req.body;
    if (!Array.isArray(newContacts)) {
        return res.status(400).json({ success: false, message: 'Data harus berupa array' });
    }
    
    let added = 0;
    let skipped = 0;
    
    newContacts.forEach(newC => {
        if (!newC.x1 || !newC.x1.trim()) {
            skipped++;
            return;
        }
        
        // Gabungkan semua field x dari data baru
        const mergedContact = { x1: newC.x1 };
        Object.keys(newC).forEach(key => {
            if (key.startsWith('x') && newC[key] && newC[key].toString().trim()) {
                mergedContact[key] = newC[key].toString().trim();
            }
        });
        
        // Cek apakah SUDAH ADA kontak dengan nomor DAN grup yang SAMA PERSIS
        const exactDuplicate = contacts.find(c => 
            c.x1 === mergedContact.x1 && c.x2 === mergedContact.x2
        );
        
        if (exactDuplicate) {
            // SKIP: nomor dan grup sama persis = duplicate identik
            skipped++;
            return;
        }
        
        // ADD: nomor sama tapi grup beda, atau nomor beda = MASUKKAN
        contacts.push(mergedContact);
        added++;
        
        // Auto-create group if not exists
        if (mergedContact.x2 && !groups.includes(mergedContact.x2)) {
            groups.push(mergedContact.x2);
        }
    });
    
    saveContacts();
    saveGroups(); // Save groups in case new ones were added
    
    res.json({ 
        success: true, 
        message: `${added} kontak ditambahkan, ${skipped} duplicate identik dilewati`,
        total: contacts.length,
        added,
        skipped
    });
});

app.put('/api/contacts', (req, res) => {
    const updatedContacts = req.body;
    if (Array.isArray(updatedContacts)) {
        contacts = updatedContacts;
        saveContacts();
        res.json({ success: true, message: 'Kontak berhasil diperbarui', contacts });
    } else {
        res.status(400).json({ success: false, message: 'Data harus berupa array' });
    }
});

app.delete('/api/contacts', (req, res) => {
    contacts = [];
    saveContacts();
    res.json({ success: true, message: 'Semua kontak berhasil dihapus', contacts });
});

app.delete('/api/contacts/:x1', (req, res) => {
    const { x1 } = req.params;
    const decodedX1 = decodeURIComponent(x1);
    const hasGroupFilter = Object.prototype.hasOwnProperty.call(req.query, 'group');
    const decodedGroup = hasGroupFilter ? String(req.query.group || '') : null;

    if (hasGroupFilter) {
        // Hapus hanya satu baris kontak yang nomor DAN grup-nya sama.
        // Ini penting karena aplikasi mengizinkan nomor sama di grup berbeda.
        const idx = contacts.findIndex(c => c.x1 === decodedX1 && (c.x2 || '') === decodedGroup);
        if (idx === -1) return res.status(404).json({ success: false, message: 'Kontak tidak ditemukan' });
        contacts.splice(idx, 1);
        saveContacts();
        return res.json({ success: true, message: 'Kontak berhasil dihapus' });
    }

    const initialLen = contacts.length;
    contacts = contacts.filter(c => c.x1 !== decodedX1);
    if (contacts.length < initialLen) {
        saveContacts();
        res.json({ success: true, message: 'Kontak berhasil dihapus' });
    } else {
        res.status(404).json({ success: false, message: 'Kontak tidak ditemukan' });
    }
});

// ================== GROUPS API ==================
app.get('/api/groups', (req, res) => {
    res.json(groups);
});

app.post('/api/groups', (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Nama grup diperlukan' });
    if (groups.includes(name)) {
        return res.status(400).json({ success: false, message: 'Grup sudah ada' });
    }
    groups.push(name);
    saveGroups();
    res.json({ success: true, message: `Grup "${name}" berhasil dibuat`, groups });
});

app.put('/api/groups', (req, res) => {
    const updatedGroups = req.body;
    if (!Array.isArray(updatedGroups)) {
        return res.status(400).json({ success: false, message: 'Data grup harus berupa array' });
    }
    groups = [...new Set(updatedGroups.map(g => String(g || '').trim()).filter(Boolean))];
    if (groups.length === 0) groups = ['Default'];
    saveGroups();
    res.json({ success: true, message: 'Grup berhasil diperbarui', groups });
});

app.delete('/api/groups', (req, res) => {
    groups = ['Default'];
    saveGroups();
    res.json({ success: true, message: 'Semua grup berhasil dihapus dan Default dibuat ulang', groups });
});

app.delete('/api/groups/:name', (req, res) => {
    const { name } = req.params;
    const decodedName = decodeURIComponent(name);
    const index = groups.indexOf(decodedName);
    if (index !== -1) {
        groups.splice(index, 1);
        saveGroups();
        res.json({ success: true, message: `Grup "${decodedName}" berhasil dihapus` });
    } else {
        res.status(404).json({ success: false, message: 'Grup tidak ditemukan' });
    }
});

// ================== CONCEPTS API ==================
app.get('/api/konseps', (req, res) => {
    res.json(konsepList);
});

app.post('/api/konseps', (req, res) => {
    const data = req.body;
    
    // Handle array reset
    if (Array.isArray(data)) {
        konsepList = data;
        saveKonseps();
        return res.json({ success: true, message: `${konsepList.length} konsep tersimpan` });
    }
    
    if (typeof data === 'object' && data !== null) {
        if (data.id) {
            const existingIdx = konsepList.findIndex(k => k.id === data.id);
            if (existingIdx !== -1) {
                konsepList[existingIdx] = data;
            } else {
                konsepList.push(data);
            }
        } else {
            data.id = Date.now().toString();
            konsepList.push(data);
        }
        saveKonseps();
        res.json({ success: true, message: 'Konsep berhasil disimpan', konseps: konsepList });
    } else {
        res.status(400).json({ success: false, message: 'Format tidak valid' });
    }
});

app.delete('/api/konseps/:id', (req, res) => {
    const { id } = req.params;
    const initialLen = konsepList.length;
    konsepList = konsepList.filter(k => k.id !== id);
    if (konsepList.length < initialLen) {
        saveKonseps();
        res.json({ success: true, message: 'Konsep berhasil dihapus' });
    } else {
        res.status(404).json({ success: false, message: 'Konsep tidak ditemukan' });
    }
});

// ================== BLAST API ==================
app.post('/api/blast', async (req, res) => {
    try {
        const { contacts: reqContacts, template, group, batch, delay, perMessageDelay, messageDelay } = req.body;

        if (!reqContacts || !template) {
            return res.status(400).json({ error: 'Data kontak atau template tidak lengkap' });
        }

        const result = await enqueueSendBlast({
            contacts: reqContacts,
            template,
            group,
            batch,
            delay,
            perMessageDelay: perMessageDelay ?? messageDelay,
            type: reqContacts.length === 1 && !group ? 'single' : 'blast',
            label: reqContacts.length === 1 && !group ? 'Kirim Single' : `Blast ${group || '-'}`
        });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ================== REMINDERS API ==================
app.get('/api/reminders', (req, res) => {
    res.json(reminderList);
});

app.post('/api/reminders', (req, res) => {
    const data = req.body;
    
    // Handle array reset
    if (Array.isArray(data)) {
        reminderList = data;
        saveReminders();
        return res.json({ success: true, message: `${reminderList.length} reminder tersimpan` });
    }
    
    if (typeof data === 'object' && data !== null) {
        if (data.id) {
            const existingIdx = reminderList.findIndex(r => r.id === data.id);
            if (existingIdx !== -1) {
                reminderList[existingIdx] = data;
            } else {
                reminderList.push(data);
            }
        } else {
            data.id = Date.now().toString();
            reminderList.push(data);
        }
        saveReminders();
        res.json({ success: true, message: 'Reminder berhasil disimpan', reminders: reminderList });
    } else {
        res.status(400).json({ success: false, message: 'Format tidak valid' });
    }
});

app.delete('/api/reminders/:id', (req, res) => {
    const { id } = req.params;
    const initialLen = reminderList.length;
    reminderList = reminderList.filter(r => r.id !== id);
    if (reminderList.length < initialLen) {
        saveReminders();
        res.json({ success: true, message: 'Reminder berhasil dihapus' });
    } else {
        res.status(404).json({ success: false, message: 'Reminder tidak ditemukan' });
    }
});

// ================== LOGS API ==================
app.get('/api/logs', (req, res) => {
    res.json(messageLogs);
});

app.delete('/api/logs', (req, res) => {
    messageLogs = [];
    saveLogs();
    res.json({ success: true, message: 'Semua log berhasil dihapus' });
});

app.delete('/api/logs/:type', (req, res) => {
    const { type } = req.params;
    const initialLen = messageLogs.length;

    if (type === 'sent') {
        messageLogs = messageLogs.filter(l => l.status !== 'sent');
    } else if (type === 'received') {
        messageLogs = messageLogs.filter(l => l.type !== 'in');
    } else if (type === 'failed') {
        messageLogs = messageLogs.filter(l => l.status !== 'failed');
    } else {
        return res.status(400).json({ success: false, message: 'Tipe log tidak valid' });
    }

    saveLogs();
    res.json({ success: true, message: `Log ${type} berhasil dihapus`, removed: initialLen - messageLogs.length });
});

// ================== AUTO EXECUTE REMINDERS ==================
function executeReminders() {
    const now = new Date();
    const currentTime = now.getHours() * 60 + now.getMinutes();
    const currentDay = now.getDay();
    const currentDate = now.getDate();
    const currentMonth = now.getMonth() + 1;

    reminderList.forEach(reminder => {
        if (!reminder.active) return;

        let isTimeMatch = false;
        if (reminder.time) {
            const [hour, minute] = reminder.time.split(':').map(Number);
            const reminderTime = hour * 60 + minute;
            isTimeMatch = currentTime >= reminderTime && currentTime <= reminderTime + 2;
        }

        if (!isTimeMatch) return;

        let isDayMatch = false;
        switch(reminder.repeat) {
            case 'daily':
                isDayMatch = true;
                break;
            case 'weekdays':
                isDayMatch = currentDay >= 1 && currentDay <= 5;
                break;
            case 'monday':
                isDayMatch = currentDay === 1;
                break;
            case 'friday':
                isDayMatch = currentDay === 5;
                break;
            case 'monthly':
                isDayMatch = currentDate === parseInt(reminder.dayOfMonth || 1);
                break;
            case 'custom':
                isDayMatch = currentDate === parseInt(reminder.dayOfMonth || 1) && 
                            currentMonth === parseInt(reminder.month || 1);
                break;
        }

        if (!isDayMatch) return;

        const today = now.toISOString().split('T')[0];
        if (reminder.lastProcessed === today) return;
        // Jika server pernah mati saat isProcessing=true di hari sebelumnya, jangan kunci selamanya.
        if (reminder.isProcessing && reminder.lastProcessed !== today) reminder.isProcessing = false;

        console.log(`🔔 Executing reminder: ${reminder.name}`);
        const targetContacts = contacts.filter(c => c.x2 === reminder.group);

        if (targetContacts.length > 0) {
            // Tandai sebelum pengiriman untuk mencegah reminder terpanggil berulang
            // saat proses kirim masih berjalan lama.
            reminder.lastProcessed = today;
            reminder.isProcessing = true;
            saveReminders();

            enqueueSendBlast({
                contacts: targetContacts,
                template: reminder.template,
                group: reminder.group,
                batch: reminder.batch,
                delay: reminder.delay,
                perMessageDelay: reminder.perMessageDelay ?? reminder.messageDelay,
                type: 'reminder',
                label: `Reminder ${reminder.name || reminder.group || '-'}`
            })
                .then(result => {
                    console.log(`✅ Reminder "${reminder.name}" completed: ${result.sent} sent`);
                    reminder.isProcessing = false;
                    saveReminders();
                })
                .catch(err => {
                    reminder.isProcessing = false;
                    saveReminders();
                    console.error(`❌ Reminder "${reminder.name}" failed:`, err.message);
                });
        } else {
            console.log(`⚠️ Reminder target group "${reminder.group}" is empty`);
        }
    });
}

setInterval(() => { executeReminders(); }, 60000);

// ================== LOAD ALL DATA ==================
loadSettings();
loadContacts();
loadGroups();
loadKonseps();
loadReminders();
loadLogs();
loadUsers();
loadActivityLogs();

// ================== START SERVER ==================
const PORT = 3000;
server.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║     🚀 WA Blaster Pro - KPPN Pekalongan      ║');
    console.log('╠══════════════════════════════════════════════╣');
    console.log(`║  🌐 Server: http://localhost:${PORT}           ║`);
    console.log(`║  🔧 Blast Only Mode: ${SETTINGS.blastOnly ? 'ON' : 'OFF'}                   ║`);
    console.log('║  📱 Buka browser dan scan QR Code            ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
});

setTimeout(() => {
    const hasAuth = fs.existsSync(path.join(__dirname, '.wwebjs_auth'));
    if (hasAuth && !client) {
        console.log('⚡ Found auth session, auto-connecting to WhatsApp...');
        initWhatsApp();
    }
}, 2000);