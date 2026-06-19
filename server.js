const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cron = require('node-cron');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ================== CONFIG ==================
let client;
let isConnected = false;
let qrCodeData = null;

// Rate Limit Settings (Default Aman)
let RATE_LIMIT = {
    batchSize: 8,
    delaySeconds: 45
};

// ================== PERSISTENT DATA ==================
// File paths
const DATA_DIR = path.join(__dirname, 'data');
const KONTAK_FILE = path.join(DATA_DIR, 'kontak.json');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');

// Load data from files
let contacts = [];
let groups = {
    "Group 1": [],
    "Group 2": [],
    "Group 3": []
};

// Load kontak dari file
function loadKontak() {
    try {
        if (fs.existsSync(KONTAK_FILE)) {
            const data = fs.readFileSync(KONTAK_FILE, 'utf8');
            contacts = JSON.parse(data);
            console.log(`✅ Loaded ${contacts.length} kontak from file`);
        }
    } catch (error) {
        console.error('Error loading kontak:', error);
        contacts = [];
    }
}

// Load groups dari file
function loadGroups() {
    try {
        if (fs.existsSync(GROUPS_FILE)) {
            const data = fs.readFileSync(GROUPS_FILE, 'utf8');
            groups = JSON.parse(data);
            console.log(`✅ Loaded ${Object.keys(groups).length} groups from file`);
        }
    } catch (error) {
        console.error('Error loading groups:', error);
        groups = {
            "Group 1": [],
            "Group 2": [],
            "Group 3": []
        };
    }
}

// Save kontak ke file
function saveKontak() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        fs.writeFileSync(KONTAK_FILE, JSON.stringify(contacts, null, 2));
    } catch (error) {
        console.error('Error saving kontak:', error);
    }
}

// Save groups ke file
function saveGroups() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        fs.writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2));
    } catch (error) {
        console.error('Error saving groups:', error);
    }
}

// Load data saat start
loadKontak();
loadGroups();

// ================== SCHEDULED JOBS ==================
let scheduledJobs = [];

// Message Log (Kotak Keluar & Masuk)
let messageLogs = [];

// Blast Mode
let blastMode = false;



// ================== LOG MESSAGE ==================
function logMessage(type, contact, message, status, group = null) {
    const log = {
        id: Date.now(),
        timestamp: new Date().toISOString(),
        type,                    // 'out' atau 'in'
        contact: contact.nama || contact.nomor,
        nomor: contact.nomor,
        message,
        status,                  // 'sent', 'failed', 'received'
        group
    };
    messageLogs.unshift(log);
    
    // Keep only last 200 logs
    if (messageLogs.length > 200) messageLogs.pop();
}

// ================== WHATSAPP CLIENT ==================
function initWhatsApp() {
    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    client.on('qr', (qr) => {
        console.log('📱 QR Code received');
        qrcode.toDataURL(qr).then(url => {
            qrCodeData = url;
        });
    });

    client.on('ready', () => {
        console.log('✅ WhatsApp Connected!');
        isConnected = true;
        qrCodeData = null;
    });

    client.on('disconnected', () => {
        console.log('❌ WhatsApp Disconnected');
        isConnected = false;
    });

    client.initialize();
}

// ================== SEND MESSAGE WITH RATE LIMIT (FIXED) ==================
async function sendBlast(contacts, template, groupName = null) {
    if (!isConnected) {
        throw new Error('WhatsApp belum terhubung');
    }

    const selectedContacts = contacts.filter(c => c.selected !== false);
    let sent = 0;
    let failed = 0;

    for (let i = 0; i < selectedContacts.length; i++) {
        const contact = selectedContacts[i];
        
        try {
            // Support both old format and new x1-x10 format
            let message = template
                .replace(/{x1}/g, contact.x1 || contact.nomor || '')
                .replace(/{x2}/g, contact.x2 || contact.nama || '')
                .replace(/{x3}/g, contact.x3 || contact.jabatan || '')
                .replace(/{x4}/g, contact.x4 || '')
                .replace(/{x5}/g, contact.x5 || '')
                .replace(/{x6}/g, contact.x6 || '')
                .replace(/{x7}/g, contact.x7 || '')
                .replace(/{x8}/g, contact.x8 || '')
                .replace(/{x9}/g, contact.x9 || '')
                .replace(/{x10}/g, contact.x10 || '');

            const nomor = contact.x1 || contact.nomor;
            const nama = contact.x2 || contact.nama || 'Unknown';

            const chatId = `${nomor}@c.us`;
            await client.sendMessage(chatId, message);
            
            sent++;
            logMessage('out', { nama: nama, nomor: nomor }, message, 'sent', groupName);
            console.log(`✅ Sent to ${nama} (${nomor})`);

            // Rate Limit Logic
            if ((i + 1) % RATE_LIMIT.batchSize === 0 && i + 1 < selectedContacts.length) {
                console.log(`⏳ Menunggu ${RATE_LIMIT.delaySeconds} detik...`);
                await new Promise(resolve => setTimeout(resolve, RATE_LIMIT.delaySeconds * 1000));
            }
        } catch (err) {
            console.error(`❌ Gagal kirim ke ${contact.x2 || contact.nama}:`, err.message);
            logMessage('out', contact, template, 'failed', groupName);
            failed++;
        }
    }

    return { sent, failed, total: selectedContacts.length };
}

// ================== API ENDPOINTS ==================

// Get QR Code
app.get('/api/qr', (req, res) => {
    if (qrCodeData) {
        res.json({ qr: qrCodeData, connected: false });
    } else if (isConnected) {
        res.json({ connected: true });
    } else {
        res.json({ qr: null, connected: false });
    }
});

// Connect WhatsApp
app.post('/api/connect', (req, res) => {
    if (!client) {
        initWhatsApp();
    }
    res.json({ success: true, message: 'Connecting...' });
});

// Disconnect
app.post('/api/disconnect', async (req, res) => {
    if (client) {
        await client.destroy();
        isConnected = false;
        qrCodeData = null;
    }
    res.json({ success: true });
});

// Send Blast
app.post('/api/blast', async (req, res) => {
    try {
        const { contacts, template, group } = req.body;
        
        if (!contacts || !template) {
            return res.status(400).json({ error: 'Data tidak lengkap' });
        }

        const result = await sendBlast(contacts, template, group);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update Rate Limit
app.post('/api/settings/rate-limit', (req, res) => {
    const { batchSize, delaySeconds } = req.body;
    
    if (batchSize) RATE_LIMIT.batchSize = batchSize;
    if (delaySeconds) RATE_LIMIT.delaySeconds = delaySeconds;
    
    res.json({ success: true, settings: RATE_LIMIT });
});

// Get Groups
app.get('/api/groups', (req, res) => {
    res.json(groups);
});

// Add Contact to Group
app.post('/api/groups/:groupName', (req, res) => {
    const { groupName } = req.params;
    const contact = req.body;
    
    if (!groups[groupName]) {
        groups[groupName] = [];
    }
    
    groups[groupName].push(contact);
    res.json({ success: true });
});

// Schedule Message
app.post('/api/schedule', (req, res) => {
    const { groupName, template, time, repeat } = req.body; // time = "08:00", repeat = "daily"

    if (!groupName || !template || !time) {
        return res.status(400).json({ error: 'Data tidak lengkap' });
    }

    const [hour, minute] = time.split(':');
    const cronExpression = repeat === 'daily' 
        ? `${minute} ${hour} * * *` 
        : `${minute} ${hour} * * 1`; // every Monday example

    const job = cron.schedule(cronExpression, async () => {
        console.log(`🕒 Running scheduled job for ${groupName}`);
        const contacts = groups[groupName] || [];
        if (contacts.length > 0) {
            await sendBlast(contacts, template, groupName);
        }
    });

    scheduledJobs.push({
        id: Date.now(),
        groupName,
        template,
        time,
        repeat,
        job
    });

    res.json({ success: true, message: 'Jadwal berhasil dibuat' });
});

// Get all scheduled jobs
app.get('/api/schedules', (req, res) => {
    res.json(scheduledJobs.map(j => ({
        id: j.id,
        groupName: j.groupName,
        time: j.time,
        repeat: j.repeat,
        template: j.template
    })));
});

// Delete scheduled job
app.delete('/api/schedule/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const index = scheduledJobs.findIndex(j => j.id === id);
    
    if (index !== -1) {
        // Stop the cron job
        if (scheduledJobs[index].job) {
            scheduledJobs[index].job.stop();
        }
        scheduledJobs.splice(index, 1);
        res.json({ success: true, message: 'Jadwal berhasil dihapus' });
    } else {
        res.status(404).json({ success: false, message: 'Jadwal tidak ditemukan' });
    }
});

// Get Message Logs (Kotak Masuk & Keluar)
app.get('/api/logs', (req, res) => {
    res.json(messageLogs);
});

// Toggle Blast Mode
app.post('/api/blast-mode', (req, res) => {
    const { enabled } = req.body;
    blastMode = enabled;
    console.log(`🔄 Blast Mode: ${blastMode ? 'ON' : 'OFF'}`);
    res.json({ success: true, blastMode });
});

// Get Blast Mode Status
app.get('/api/blast-mode', (req, res) => {
    res.json({ blastMode });
});

// ================== KONTAK & GRUP API ==================

// Get semua kontak
app.get('/api/kontak', (req, res) => {
    res.json(contacts);
});

// Save kontak (upload)
app.post('/api/kontak', (req, res) => {
    const newContacts = req.body;
    if (Array.isArray(newContacts)) {
        contacts = newContacts;
        saveKontak();
        res.json({ success: true, message: `${contacts.length} kontak tersimpan` });
    } else {
        res.status(400).json({ success: false, message: 'Data harus berupa array' });
    }
});

// Update kontak (untuk perubahan grup)
app.put('/api/kontak', (req, res) => {
    const updatedContacts = req.body;
    if (Array.isArray(updatedContacts)) {
        contacts = updatedContacts;
        saveKontak();
        res.json({ success: true, message: 'Kontak berhasil diperbarui' });
    } else {
        res.status(400).json({ success: false, message: 'Data harus berupa array' });
    }
});

// Get semua groups
app.get('/api/groups', (req, res) => {
    res.json(groups);
});

// Update groups
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

// Update grup kontak (saat pindah kontak antar grup)
app.put('/api/groups', (req, res) => {
    const newGroups = req.body;
    if (typeof newGroups === 'object') {
        groups = newGroups;
        saveGroups();
        res.json({ success: true, message: 'Grup berhasil diperbarui' });
    } else {
        res.status(400).json({ success: false, message: 'Data grup tidak valid' });
    }
});

// Add kontak ke grup
app.post('/api/groups/:groupName', (req, res) => {
    const { groupName } = req.params;
    const contact = req.body;
    
    if (!groups[groupName]) {
        groups[groupName] = [];
    }
    
    // Cek apakah kontak sudah ada
    const exists = groups[groupName].some(c => c.x1 === contact.x1);
    if (!exists) {
        groups[groupName].push(contact);
        saveGroups();
    }
    
    res.json({ success: true });
});

// ================== START SERVER ==================
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
    console.log('Silakan buka browser dan akses http://localhost:3000');
});

// Auto init WhatsApp on start (optional)
setTimeout(() => {
    if (!client) initWhatsApp();
}, 2000);

// ================== AUTO EXECUTE SCHEDULE & REMINDER ==================
let scheduleJobs = [];

// Fungsi untuk menjalankan jadwal
function executeScheduledJobs() {
    const now = new Date();
    const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
    const currentDay = now.getDay(); // 0=Minggu, 1=Senin, ..., 5=Jumat

    scheduledJobs.forEach(job => {
        if (!job.active) return;

        let shouldRun = false;

        // Cek apakah waktu dan hari sesuai
        if (job.time === currentTime) {
            if (job.repeat === 'daily') {
                shouldRun = true;
            } else if (job.repeat === 'weekly' && currentDay === 1) { // Senin
                shouldRun = true;
            }
        }

        if (shouldRun) {
            console.log(`🕒 Executing scheduled job: ${job.groupName}`);
            
            // Cari kontak di grup yang sesuai
            const targetContacts = contacts.filter(c => c.group === job.groupName);
            
            if (targetContacts.length > 0) {
                sendBlast(targetContacts, job.template, job.groupName)
                    .then(result => {
                        console.log(`✅ Scheduled job completed: ${result.sent} sent, ${result.failed} failed`);
                    })
                    .catch(err => {
                        console.error(`❌ Scheduled job failed:`, err.message);
                    });
            }
        }
    });
}

// Fungsi untuk menjalankan pengingat
function executeReminders() {
    const now = new Date();
    const currentTime = now.getHours() * 60 + now.getMinutes(); // dalam menit
    const currentDay = now.getDay(); // 0=Minggu, 1=Senin, ..., 5=Jumat

    reminderList.forEach(reminder => {
        if (!reminder.active) return;

        // Cek apakah hari sesuai
        let isDayMatch = false;
        if (reminder.day === 'daily') isDayMatch = true;
        if (reminder.day === 'monday-friday' && currentDay >= 1 && currentDay <= 5) isDayMatch = true;
        if (reminder.day === 'monday' && currentDay === 1) isDayMatch = true;
        if (reminder.day === 'tuesday' && currentDay === 2) isDayMatch = true;
        if (reminder.day === 'wednesday' && currentDay === 3) isDayMatch = true;
        if (reminder.day === 'thursday' && currentDay === 4) isDayMatch = true;
        if (reminder.day === 'friday' && currentDay === 5) isDayMatch = true;

        if (!isDayMatch) return;

        // Parse jam pengiriman
        const [hour, minute] = reminder.time.split(':').map(Number);
        const reminderTime = hour * 60 + minute;

        // Jika sekarang 30 menit sebelum waktu pengiriman
        if (currentTime >= reminderTime - 30 && currentTime < reminderTime) {
            
            // Cek apakah sudah diproses hari ini
            const today = now.toISOString().split('T')[0];
            if (reminder.lastProcessed === today) return;

            console.log(`🔔 Executing reminder: ${reminder.name}`);

            // Cari kontak di grup yang sesuai
            const targetContacts = contacts.filter(c => c.group === reminder.grup);
            
            if (targetContacts.length > 0) {
                sendBlast(targetContacts, reminder.template, reminder.grup)
                    .then(result => {
                        console.log(`✅ Reminder "${reminder.name}" completed: ${result.sent} sent`);
                        
                        // Tandai sudah diproses
                        reminder.lastProcessed = today;
                        // Simpan ke file jika ada
                        if (typeof saveReminders === 'function') {
                            saveReminders();
                        }
                    })
                    .catch(err => {
                        console.error(`❌ Reminder "${reminder.name}" failed:`, err.message);
                    });
            }
        }
    });
}

// Jalankan pengecekan setiap 1 menit
setInterval(() => {
    executeScheduledJobs();
    executeReminders();
}, 60000); // 60 detik

console.log('✅ Auto-execute scheduler started (check every 1 minute)');