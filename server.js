const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cron = require('node-cron');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

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
    batchSize: 8,
    delaySeconds: 45
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

// Memory storage
let contacts = [];
let groups = [];
let konsepList = [];
let reminderList = [];
let messageLogs = [];

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

// ================== FORMAT PHONE ==================
function formatWhatsAppNumber(nomor) {
    if (!nomor) return null;
    let cleaned = nomor.toString().replace(/[^0-9]/g, '');
    if (cleaned.startsWith('0')) {
        cleaned = '62' + cleaned.slice(1);
    }
    return cleaned;
}

// ================== LOG MESSAGE ==================
function logMessage(type, contactName, nomor, message, status, group = null) {
    const log = {
        id: Date.now().toString(),
        timestamp: new Date().toISOString(),
        type,
        contactName: contactName || 'Unknown',
        nomor: nomor || '',
        message: message || '',
        status,
        group
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
            const senderName = contact.pushname || contact.name || 'Unknown';
            const senderNumber = formatWhatsAppNumber(msg.from.replace('@c.us', ''));
            
            // Auto-save to contacts if not exists
            const existingContact = contacts.find(c => c.x1 === senderNumber);
            if (!existingContact && senderNumber) {
                const newContact = {
                    x1: senderNumber,
                    x2: 'Pesan Masuk',
                    x3: senderName,
                    x4: 'Auto-added from message'
                };
                contacts.push(newContact);
                saveContacts();
                console.log(`📝 Auto-added contact: ${senderName} (${senderNumber})`);
                
                // Auto-create group if not exists
                if (!groups.includes('Pesan Masuk')) {
                    groups.push('Pesan Masuk');
                    saveGroups();
                }
            }

            logMessage('in', senderName, senderNumber, msg.body, 'received');
            console.log(`📩 Message received from ${senderName}: ${msg.body.substring(0, 50)}...`);
            
            io.emit('newMessage', { 
                from: senderName, 
                number: senderNumber, 
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
async function sendBlast(targetContacts, template, groupName = null, batchSizeCustom = null, delayCustom = null) {
    if (!isConnected || !client) {
        throw new Error('WhatsApp belum terhubung. Silakan scan QR terlebih dahulu.');
    }

    const selectedContacts = targetContacts.filter(c => c.selected !== false);
    let sent = 0;
    let failed = 0;

    const actualBatchSize = batchSizeCustom || RATE_LIMIT.batchSize;
    const actualDelay = delayCustom !== null ? delayCustom : RATE_LIMIT.delaySeconds;

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
        
        if (!nomor) {
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

        const chatId = nomor + '@c.us';
        
        try {
            await client.sendMessage(chatId, messageText);
            sent++;
            logMessage('out', contact.x3 || 'Unknown', nomor, messageText, 'sent', groupName);
            console.log(`✅ Sent to ${contact.x3 || nomor}: ${messageText.substring(0, 30)}...`);
            io.emit('blastProgress', { sent, failed, total: selectedContacts.length });
        } catch (err) {
            failed++;
            logMessage('out', contact.x3 || 'Unknown', nomor, messageText, 'failed', groupName);
            console.log(`❌ Failed to ${contact.x3 || nomor}: ${err.message}`);
        }

        if ((i + 1) % actualBatchSize === 0 && i < selectedContacts.length - 1) {
            console.log(`⏳ Batch complete. Waiting ${actualDelay}s...`);
            await new Promise(resolve => setTimeout(resolve, actualDelay * 1000));
        } else if (i < selectedContacts.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1500));
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

io.on('connection', (socket) => {
    console.log('🔌 Client connected:', socket.id);
    
    // Send current status
    socket.emit('statusChange', { connected: isConnected });
    
    // Send settings
    socket.emit('settingsUpdate', SETTINGS);
    
    socket.on('disconnect', () => {
        console.log('🔌 Client disconnected:', socket.id);
    });
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
        blastOnly: SETTINGS.blastOnly 
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
    const { batchSize, delaySeconds } = req.body;
    if (batchSize) RATE_LIMIT.batchSize = parseInt(batchSize);
    if (delaySeconds) RATE_LIMIT.delaySeconds = parseInt(delaySeconds);
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
        res.json({ success: true, message: 'Kontak berhasil diperbarui' });
    } else {
        res.status(400).json({ success: false, message: 'Data harus berupa array' });
    }
});

app.delete('/api/contacts/:x1', (req, res) => {
    const { x1 } = req.params;
    const decodedX1 = decodeURIComponent(x1);
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
    res.json({ success: true, message: `Grup "${name}" berhasil dibuat` });
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
        const { contacts: reqContacts, template, group, batch, delay } = req.body;

        if (!reqContacts || !template) {
            return res.status(400).json({ error: 'Data kontak atau template tidak lengkap' });
        }

        const result = await sendBlast(reqContacts, template, group, batch, delay);
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
        if (reminder.lastProcessed === today && reminder.repeat !== 'custom') return;

        console.log(`🔔 Executing reminder: ${reminder.name}`);
        const targetContacts = contacts.filter(c => c.x2 === reminder.group);

        if (targetContacts.length > 0) {
            sendBlast(targetContacts, reminder.template, reminder.group)
                .then(result => {
                    console.log(`✅ Reminder "${reminder.name}" completed: ${result.sent} sent`);
                    reminder.lastProcessed = today;
                    saveReminders();
                })
                .catch(err => {
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