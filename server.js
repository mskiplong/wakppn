const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cron = require('node-cron');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// 🚨 GLOBAL PENGAMAN MUTLAK (ABSOLUTE 24/7 UPTIME SHIELD) 🚨
// Meredam seluruh error asynchronous tak terduga (seperti auth timeout dari internal Puppeteer)
// sehingga aplikasi Node.js tidak akan pernah lagi crash atau berhenti (Server stopped).
process.on('unhandledRejection', (reason, promise) => {
    console.warn('⚠️ [GLOBAL SHIELD] Unhandled Promise Rejection berhasil diredam secara otomatis:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('⚠️ [GLOBAL SHIELD] Uncaught Exception berhasil diredam secara otomatis:', err.message);
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

// Rate Limit Settings
let RATE_LIMIT = {
    batchSize: 8,
    delaySeconds: 45
};

// ================== PERSISTENT DATA DIRECTORY ==================
const DATA_DIR = path.join(__dirname, 'data');
const KONTAK_FILE = path.join(DATA_DIR, 'kontak.json');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const REMINDERS_FILE = path.join(DATA_DIR, 'reminders.json');
const KONSEPS_FILE = path.join(DATA_DIR, 'konseps.json');
const SCHEDULES_FILE = path.join(DATA_DIR, 'schedules.json');

// Memory storage
let contacts = [];
let groups = {
    "Group 1": [],
    "Group 2": [],
    "Group 3": []
};
let reminderList = [];
let konsepList = [];
let scheduledJobs = [];
let messageLogs = [];
let blastMode = false;

// Pengecekan Kritis Versi Library di Awal
try {
    const wwebjsPkg = require('whatsapp-web.js/package.json');
    console.log(`\n📦 Versi whatsapp-web.js terinstal: v${wwebjsPkg.version}`);
    if (wwebjsPkg.version.startsWith('1.23')) {
        console.log('\n' + '='.repeat(84));
        console.log('🚨 PERHATIAN MUTLAK: VERSI LIBRARY USANG TERDETEKSI (CRITICAL UPDATE REQUIRED) 🚨');
        console.log('='.repeat(84));
        console.log('Sistem mendeteksi kamu masih menggunakan whatsapp-web.js versi lama (v1.23.0).');
        console.log('Ini adalah kendala potensial pada struktur Webpack baru WhatsApp/Meta.');
        console.log('Untuk memperbaruinya secara permanen sampai standar Production, silakan:');
        console.log('  1. Matikan jendela terminal server (start.bat) ini.');
        console.log('  2. Jalankan file "install.bat" (atau ketik CMD: npm install whatsapp-web.js@latest).');
        console.log('  3. Setelah proses update tuntas, jalankan lagi "start.bat".');
        console.log('='.repeat(84) + '\n');
    }
} catch (err) {}

// Pastikan folder data dan file default terinisialisasi
function initDefaultFiles() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(KONTAK_FILE)) fs.writeFileSync(KONTAK_FILE, JSON.stringify([], null, 2));
    if (!fs.existsSync(GROUPS_FILE)) fs.writeFileSync(GROUPS_FILE, JSON.stringify({ "Group 1": [], "Group 2": [], "Group 3": [] }, null, 2));
    if (!fs.existsSync(REMINDERS_FILE)) fs.writeFileSync(REMINDERS_FILE, JSON.stringify([], null, 2));
    if (!fs.existsSync(KONSEPS_FILE)) fs.writeFileSync(KONSEPS_FILE, JSON.stringify([], null, 2));
    if (!fs.existsSync(SCHEDULES_FILE)) fs.writeFileSync(SCHEDULES_FILE, JSON.stringify([], null, 2));
}

initDefaultFiles();

// Load utilitas sinkronisasi grup dari contacts
function syncGroupsFromContacts() {
    const existingGroupNames = Object.keys(groups);
    let newGroups = {};
    existingGroupNames.forEach(g => newGroups[g] = []);

    contacts.forEach(c => {
        const groupName = c.group || "Group 1";
        if (!newGroups[groupName]) {
            newGroups[groupName] = [];
        }
        newGroups[groupName].push(c);
    });

    groups = newGroups;
    saveGroups();
}

// ================== LOADER & SAVER FUNCTIONS ==================
function loadKontak() {
    try {
        if (fs.existsSync(KONTAK_FILE)) {
            contacts = JSON.parse(fs.readFileSync(KONTAK_FILE, 'utf8'));
            console.log(`✅ Loaded ${contacts.length} kontak from file`);
        }
    } catch (err) {
        console.error('Error loading kontak:', err);
        contacts = [];
    }
}

function saveKontak() {
    try {
        fs.writeFileSync(KONTAK_FILE, JSON.stringify(contacts, null, 2));
    } catch (err) {
        console.error('Error saving kontak:', err);
    }
}

function loadGroups() {
    try {
        if (fs.existsSync(GROUPS_FILE)) {
            groups = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
            console.log(`✅ Loaded ${Object.keys(groups).length} groups from file`);
        }
    } catch (err) {
        console.error('Error loading groups:', err);
    }
}

function saveGroups() {
    try {
        fs.writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2));
    } catch (err) {
        console.error('Error saving groups:', err);
    }
}

function loadReminders() {
    try {
        if (fs.existsSync(REMINDERS_FILE)) {
            reminderList = JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8'));
            console.log(`✅ Loaded ${reminderList.length} reminders from file`);
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

function loadKonseps() {
    try {
        if (fs.existsSync(KONSEPS_FILE)) {
            konsepList = JSON.parse(fs.readFileSync(KONSEPS_FILE, 'utf8'));
            console.log(`✅ Loaded ${konsepList.length} konseps from file`);
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

function loadSchedules() {
    try {
        if (fs.existsSync(SCHEDULES_FILE)) {
            const rawSchedules = JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8'));
            console.log(`✅ Loaded ${rawSchedules.length} schedules from file`);
            
            rawSchedules.forEach(s => {
                registerCronJob(s);
            });
        }
    } catch (err) {
        console.error('Error loading schedules:', err);
        scheduledJobs = [];
    }
}

function saveSchedules() {
    try {
        const pureSchedules = scheduledJobs.map(j => ({
            id: j.id,
            groupName: j.groupName,
            time: j.time,
            repeat: j.repeat,
            template: j.template,
            active: j.active
        }));
        fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(pureSchedules, null, 2));
    } catch (err) {
        console.error('Error saving schedules:', err);
    }
}

function registerCronJob(sObj) {
    if (!sObj.time) return;
    const [hour, minute] = sObj.time.split(':');
    const cronExpression = sObj.repeat === 'daily' 
        ? `${minute} ${hour} * * *` 
        : `${minute} ${hour} * * 1`; // Senin

    const job = cron.schedule(cronExpression, async () => {
        if (!sObj.active) return;
        console.log(`🕒 Running scheduled job for ${sObj.groupName}`);
        const targetContacts = groups[sObj.groupName] || [];
        if (targetContacts.length > 0) {
            await sendBlast(targetContacts, sObj.template, sObj.groupName);
        } else {
            console.log(`⚠️ Target group "${sObj.groupName}" is empty.`);
        }
    });

    scheduledJobs.push({
        id: sObj.id,
        groupName: sObj.groupName,
        template: sObj.template,
        time: sObj.time,
        repeat: sObj.repeat,
        active: sObj.active !== undefined ? sObj.active : true,
        job
    });
}

// Format / Bersihkan nomor telepon (Hapus +, -, spasi, ubah 08 jadi 628)
function formatWhatsAppNumber(nomor) {
    if (!nomor) return null;
    let cleaned = nomor.toString().replace(/[^0-9]/g, '');
    if (cleaned.startsWith('0')) {
        cleaned = '62' + cleaned.slice(1);
    }
    return cleaned;
}

// ================== LOG MESSAGE ==================
function logMessage(type, contact, message, status, group = null) {
    const log = {
        id: Date.now(),
        timestamp: new Date().toISOString(),
        type, // 'out' atau 'in'
        contact: contact.nama || contact.nomor || contact.name || 'Unknown',
        nomor: contact.nomor || '',
        message: message || '',
        status, // 'sent', 'failed', 'received'
        group
    };
    messageLogs.unshift(log);

    // Keep only last 300 logs
    if (messageLogs.length > 300) messageLogs.pop();
}

// ================== WATCHDOG DETEKSI MANDIRI ==================
function startLoginWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    
    console.log('⚡ Mengaktifkan Watchdog Otentikasi Mandiri Chromium...');
    watchdogTimer = setInterval(async () => {
        if (!client || !client.pupPage || isDisconnecting) {
            return;
        }

        try {
            if (client.pupPage.isClosed()) {
                return;
            }

            const status = await client.pupPage.evaluate(() => {
                const paneSide = document.querySelector('#pane-side');
                const chatList = document.querySelector('[data-testid="chat-list"]');
                const twoPaneLayout = document.querySelector('.two');
                const chatIcon = document.querySelector('[data-icon="chat"]');
                
                if (paneSide || chatList || twoPaneLayout || chatIcon) {
                    return 'LOGGED_IN';
                }
                return 'STANDBY';
            });

            if (status === 'LOGGED_IN' && !isConnected) {
                console.log('⚡ [WATCHDOG] Deteksi Mandiri Berhasil: WhatsApp Web tervalidasi Login & Siap Operasi di browser!');
                isConnected = true;
                qrCodeData = null;
            }
        } catch (err) {
        }
    }, 1500);
}

// ================== WHATSAPP CLIENT ==================
function initWhatsApp() {
    try {
        if (client) {
            client.destroy().catch(() => {});
        }
    } catch(e) {}

    console.log('🔄 Menginisialisasi sistem WhatsApp Client (Membuka browser Chromium)...');
    isDisconnecting = false;
    isConnected = false;
    qrCodeData = null;

    client = new Client({
        authStrategy: new LocalAuth(),
        authTimeoutMs: 0, // 🚨 MATIKAN AUTH TIMEOUT SECARA ABSOLUT AGAR TIDAK PERNAH REJECT
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
        webVersionCache: {
            type: 'none'
        }
    });

    client.on('loading_screen', (percent, message) => {
        console.log(`⏳ Memuat WhatsApp Web: ${percent}% - ${message || 'Loading...'}`);
    });

    client.on('qr', (qr) => {
        console.log('📱 QR Code received dari Meta (Siap di-scan di halaman web Frontend)');
        qrcode.toDataURL(qr).then(url => {
            qrCodeData = url;
            isConnected = false;
        }).catch(err => {
            console.error('Failed to generate QR Code URL:', err);
        });
    });

    client.on('authenticated', () => {
        console.log('🔐 WhatsApp Authenticated successfully! (Sukses dipindai HP Target)');
        isConnected = true;
        qrCodeData = null;
    });

    client.on('ready', () => {
        console.log('✅ WhatsApp Ready & Fully Connected!');
        isConnected = true;
        qrCodeData = null;
    });

    client.on('disconnected', (reason) => {
        console.log('❌ WhatsApp Disconnected:', reason);
        isConnected = false;
        qrCodeData = null;
    });

    client.on('message', async msg => {
        try {
            const contact = await msg.getContact();
            const senderName = contact.pushname || contact.name || msg.from;
            const senderNumber = formatWhatsAppNumber(msg.from.replace('@c.us', ''));
            logMessage('in', { nama: senderName, nomor: senderNumber }, msg.body, 'received');
        } catch (err) {
            console.error('Error logging incoming message:', err);
        }
    });

    startLoginWatchdog();

    client.initialize().catch(err => {
        if (isDisconnecting || err.message.includes('Target closed') || err.message.includes('Session closed')) {
            console.log('🛑 Inisialisasi WhatsApp dihentikan dengan mulus (Sesuai instruksi Disconnect).');
        } else {
            console.error('❌ Error inisialisasi WhatsApp client:', err.message);
        }
        isConnected = false;
        qrCodeData = null;
    });
}

// ================== SEND MESSAGE WITH RATE LIMIT & PENGAMAN STORE ==================
async function sendBlast(targetContacts, template, groupName = null, batchSizeCustom = null, delayCustom = null) {
    if (!isConnected || !client) {
        throw new Error('WhatsApp belum terhubung (Silakan terhubung / scan QR terlebih dahulu di menu Koneksi WhatsApp)');
    }

    const selectedContacts = targetContacts.filter(c => c.selected !== false);
    let sent = 0;
    let failed = 0;

    const actualBatchSize = batchSizeCustom || RATE_LIMIT.batchSize;
    const actualDelay = delayCustom !== null ? delayCustom : RATE_LIMIT.delaySeconds;

    // Proteksi mandiri patch WidFactory jika di halaman masih usang
    try {
        await client.pupPage.evaluate(() => {
            if (!window.Store) window.Store = {};
            if (!window.Store.WidFactory) {
                window.Store.WidFactory = {
                    createWid: (widStr) => {
                        return {
                            server: widStr.split('@')[1] || "c.us",
                            user: widStr.split('@')[0],
                            _serialized: widStr,
                            toString: () => widStr
                        };
                    },
                    createWidFromWidStr: (widStr) => {
                        return {
                            server: widStr.split('@')[1] || "c.us",
                            user: widStr.split('@')[0],
                            _serialized: widStr,
                            toString: () => widStr
                        };
                    }
                };
            }
        });
    } catch(err) {}

    for (let i = 0; i < selectedContacts.length; i++) {
        const contact = selectedContacts[i];

        try {
            const rawNomor = contact.x1 || contact.nomor;
            const nomorFormatted = formatWhatsAppNumber(rawNomor);

            if (!nomorFormatted) {
                throw new Error('Nomor WhatsApp tidak valid atau kosong');
            }

            const getStr = (val) => (val !== undefined && val !== null) ? String(val) : '';

            let message = template
                .replace(/{x1}/g, getStr(contact.x1 || contact.nomor))
                .replace(/{x2}/g, getStr(contact.x2 || contact.nama))
                .replace(/{x3}/g, getStr(contact.x3 || contact.jabatan))
                .replace(/{x4}/g, getStr(contact.x4))
                .replace(/{x5}/g, getStr(contact.x5))
                .replace(/{x6}/g, getStr(contact.x6))
                .replace(/{x7}/g, getStr(contact.x7))
                .replace(/{x8}/g, getStr(contact.x8))
                .replace(/{x9}/g, getStr(contact.x9))
                .replace(/{x10}/g, getStr(contact.x10));

            const nama = getStr(contact.x2 || contact.nama || 'Unknown');
            const chatId = `${nomorFormatted}@c.us`;

            await client.sendMessage(chatId, message);

            sent++;
            logMessage('out', { nama: nama, nomor: nomorFormatted }, message, 'sent', groupName);
            console.log(`✅ Sent to ${nama} (${nomorFormatted})`);

            if ((i + 1) % actualBatchSize === 0 && i + 1 < selectedContacts.length) {
                console.log(`⏳ Menunggu delay ${actualDelay} detik sebelum batch berikutnya...`);
                await new Promise(resolve => setTimeout(resolve, actualDelay * 1000));
            }
        } catch (err) {
            console.error(`❌ Gagal kirim ke ${contact.x2 || contact.nama || contact.nomor || 'Unknown'}:`, err.message);
            logMessage('out', contact, template, 'failed', groupName);
            failed++;
        }
    }

    return { sent, failed, total: selectedContacts.length };
}

// ================== API ENDPOINTS ==================

app.get('/api/qr', (req, res) => {
    res.json({
        connected: isConnected,
        qr: qrCodeData
    });
});

app.post('/api/connect', (req, res) => {
    if (!client) {
        initWhatsApp();
        res.json({ success: true, message: 'Memulai peluncuran WhatsApp Client...' });
    } else if (isConnected) {
        res.json({ success: true, message: 'WhatsApp sudah terhubung' });
    } else if (qrCodeData) {
        res.json({ success: true, message: 'QR Code sudah siap' });
    } else {
        res.json({ success: true, message: 'Sedang memuat sistem WhatsApp Web, silakan tunggu beberapa detik...' });
    }
});

app.post('/api/disconnect', async (req, res) => {
    try {
        console.log('🔌 Memulai proses Disconnect & Logout total...');
        isDisconnecting = true;
        if (watchdogTimer) clearInterval(watchdogTimer);

        if (client) {
            if (isConnected) {
                try { await client.logout(); } catch (logoutErr) {}
            }
            try { await client.destroy(); } catch (destroyErr) {}
            client = null;
        }

        isConnected = false;
        qrCodeData = null;

        const authDir = path.join(__dirname, '.wwebjs_auth');
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
            console.log('🗑️ Cache otentikasi (.wwebjs_auth) berhasil dihapus total secara permanen.');
        }

        setTimeout(() => { isDisconnecting = false; }, 3000);

        res.json({ success: true, message: 'Berhasil memutuskan dan mereset sesi WhatsApp.' });
    } catch (error) {
        console.error('❌ Error saat Disconnect:', error);
        isDisconnecting = false;
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/blast', async (req, res) => {
    try {
        const { contacts: reqContacts, template, group, batch, delay } = req.body;

        if (!reqContacts || !template) {
            return res.status(400).json({ error: 'Data kontak atau template pesan tidak lengkap' });
        }

        const result = await sendBlast(reqContacts, template, group, batch, delay);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/settings/rate-limit', (req, res) => {
    const { batchSize, delaySeconds } = req.body;
    if (batchSize) RATE_LIMIT.batchSize = parseInt(batchSize);
    if (delaySeconds) RATE_LIMIT.delaySeconds = parseInt(delaySeconds);
    res.json({ success: true, settings: RATE_LIMIT });
});

// ================== KONTAK & GRUP API ==================
app.get('/api/kontak', (req, res) => {
    res.json(contacts);
});

app.post('/api/kontak', (req, res) => {
    const newContacts = req.body;
    if (Array.isArray(newContacts)) {
        contacts = newContacts;
        saveKontak();
        syncGroupsFromContacts();
        res.json({ success: true, message: `${contacts.length} kontak tersimpan` });
    } else {
        res.status(400).json({ success: false, message: 'Data harus berupa array' });
    }
});

app.put('/api/kontak', (req, res) => {
    const updatedContacts = req.body;
    if (Array.isArray(updatedContacts)) {
        contacts = updatedContacts;
        saveKontak();
        syncGroupsFromContacts();
        res.json({ success: true, message: 'Kontak berhasil diperbarui' });
    } else {
        res.status(400).json({ success: false, message: 'Data harus berupa array' });
    }
});

app.get('/api/groups', (req, res) => {
    res.json(groups);
});

app.post('/api/groups', (req, res) => {
    const newGroups = req.body;
    if (typeof newGroups === 'object') {
        groups = newGroups;
        saveGroups();
        res.json({ success: true, message: 'Grup berhasil disimpan' });
    } else {
        res.status(400).json({ success: false, message: 'Data grup tidak valid' });
    }
});

app.post('/api/groups/:groupName', (req, res) => {
    const { groupName } = req.params;
    const contact = req.body;

    if (!groups[groupName]) {
        groups[groupName] = [];
    }
    const exists = groups[groupName].some(c => (c.x1 && c.x1 === contact.x1) || (c.nomor && c.nomor === contact.nomor));
    if (!exists) {
        groups[groupName].push(contact);
        saveGroups();
    }
    res.json({ success: true });
});

// ================== KONSEPS (DRAFT) API ==================
app.get('/api/konseps', (req, res) => {
    res.json(konsepList);
});

app.post('/api/konseps', (req, res) => {
    const data = req.body;
    if (Array.isArray(data)) {
        konsepList = data;
        saveKonseps();
        res.json({ success: true, message: 'Konsep berhasil disimpan', konseps: konsepList });
    } else if (typeof data === 'object') {
        const existingIdx = konsepList.findIndex(k => k.id === data.id);
        if (existingIdx !== -1) {
            konsepList[existingIdx] = data;
        } else {
            konsepList.push(data);
        }
        saveKonseps();
        res.json({ success: true, message: 'Konsep berhasil disimpan', konseps: konsepList });
    } else {
        res.status(400).json({ success: false, message: 'Format data konsep tidak valid' });
    }
});

app.delete('/api/konseps/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const initialLen = konsepList.length;
    konsepList = konsepList.filter(k => k.id !== id);
    if (konsepList.length < initialLen) {
        saveKonseps();
        res.json({ success: true, message: 'Konsep berhasil dihapus' });
    } else {
        res.status(404).json({ success: false, message: 'Konsep tidak ditemukan' });
    }
});

// ================== SCHEDULE API ==================
app.get('/api/schedules', (req, res) => {
    res.json(scheduledJobs.map(j => ({
        id: j.id,
        groupName: j.groupName,
        time: j.time,
        repeat: j.repeat,
        template: j.template,
        active: j.active
    })));
});

app.post('/api/schedule', (req, res) => {
    const { groupName, template, time, repeat } = req.body;

    if (!groupName || !template || !time) {
        return res.status(400).json({ error: 'Data tidak lengkap' });
    }

    const newSched = {
        id: Date.now(),
        groupName,
        template,
        time,
        repeat,
        active: true
    };

    registerCronJob(newSched);
    saveSchedules();
    res.json({ success: true, message: 'Jadwal berhasil dibuat' });
});

app.delete('/api/schedule/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const index = scheduledJobs.findIndex(j => j.id === id);

    if (index !== -1) {
        if (scheduledJobs[index].job) {
            scheduledJobs[index].job.stop();
        }
        scheduledJobs.splice(index, 1);
        saveSchedules();
        res.json({ success: true, message: 'Jadwal berhasil dihapus' });
    } else {
        res.status(404).json({ success: false, message: 'Jadwal tidak ditemukan' });
    }
});

// ================== REMINDERS API ==================
app.get('/api/reminders', (req, res) => {
    res.json(reminderList);
});

app.post('/api/reminders', (req, res) => {
    const data = req.body;
    if (Array.isArray(data)) {
        reminderList = data;
        saveReminders();
        res.json({ success: true, message: 'Pengingat berhasil diperbarui' });
    } else {
        const newReminder = {
            id: Date.now(),
            name: data.name || 'Untitled Reminder',
            grup: data.grup || '',
            template: data.template || '',
            time: data.time || '09:00',
            day: data.day || 'daily',
            active: true,
            lastProcessed: null
        };
        reminderList.push(newReminder);
        saveReminders();
        res.json({ success: true, message: 'Pengingat berhasil dibuat', reminder: newReminder });
    }
});

app.delete('/api/reminders/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const index = reminderList.findIndex(r => r.id === id);
    if (index !== -1) {
        reminderList.splice(index, 1);
        saveReminders();
        res.json({ success: true, message: 'Pengingat berhasil dihapus' });
    } else {
        res.status(404).json({ success: false, message: 'Pengingat tidak ditemukan' });
    }
});

app.get('/api/logs', (req, res) => {
    res.json(messageLogs);
});

// ================== AUTO EXECUTE REMINDERS ==================
function executeReminders() {
    const now = new Date();
    const currentTime = now.getHours() * 60 + now.getMinutes();
    const currentDay = now.getDay();

    reminderList.forEach(reminder => {
        if (!reminder.active) return;

        let isDayMatch = false;
        if (reminder.day === 'daily') isDayMatch = true;
        if (reminder.day === 'monday-friday' && currentDay >= 1 && currentDay <= 5) isDayMatch = true;
        if (reminder.day === 'monday' && currentDay === 1) isDayMatch = true;
        if (reminder.day === 'friday' && currentDay === 5) isDayMatch = true;

        if (!isDayMatch) return;
        if (!reminder.time) return;
        const [hour, minute] = reminder.time.split(':').map(Number);
        const reminderTime = hour * 60 + minute;

        if (currentTime >= reminderTime && currentTime <= reminderTime + 3) {
            const today = now.toISOString().split('T')[0];
            if (reminder.lastProcessed === today) return;

            console.log(`🔔 Executing reminder: ${reminder.name}`);
            const targetContacts = groups[reminder.grup] || [];

            if (targetContacts.length > 0) {
                sendBlast(targetContacts, reminder.template, reminder.grup)
                    .then(result => {
                        console.log(`✅ Reminder "${reminder.name}" completed: ${result.sent} sent`);
                        reminder.lastProcessed = today;
                        saveReminders();
                    })
                    .catch(err => {
                        console.error(`❌ Reminder "${reminder.name}" failed:`, err.message);
                    });
            } else {
                console.log(`⚠️ Reminder target group "${reminder.grup}" is empty.`);
            }
        }
    });
}

setInterval(() => { executeReminders(); }, 60000);

loadKontak();
loadGroups();
loadReminders();
loadKonseps();
loadSchedules();

// ================== START SERVER ==================
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
    console.log('Silakan buka browser dan akses http://localhost:3000');
});

setTimeout(() => {
    const hasAuth = fs.existsSync(path.join(__dirname, '.wwebjs_auth'));
    if (hasAuth && !client) {
        console.log('⚡ Ditemukan cache sesi login, memicu koneksi otomatis ke WhatsApp...');
        initWhatsApp();
    }
}, 1500);
