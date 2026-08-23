// ╔══════════════════════════════════════════════════════════════╗
// ║  EKKU — Multi-User Frontend v2.0                            ║
// ╚══════════════════════════════════════════════════════════════╝

// ─── Globals ────────────────────────────────────────────────────
let currentUserId = null;   // Active user id (A-E)
let currentUserData = null;   // { id, name, color }
let voiceEnabled = true;
let MODAL_ACTION = null;
let selectedColor = '#af101a';
let currentAudio = null;
let chatMode = 'text'; // 'text' | 'voice'

// PIN state
let pinBuffer = '';
let pinMode = 'login';  // 'login' | 'setup'
let pendingUser = null;     // user data object before login completes
let setupBuffer = '';

// ─── Utility ────────────────────────────────────────────────────
function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

let mediaRecorder = null;
let audioChunks = [];
let voiceModeActive = false; // true if recording for voice tab, false if inline mic

function abortAllRecognition() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        audioChunks = []; // Clear chunks so it doesn't send to API
        mediaRecorder.stop();
    }
    setVoiceUIState('idle');
}

function switchChatMode(mode) {
    // Stop any active mic logic when switching tabs
    abortAllRecognition();

    chatMode = mode;
    const isVoice = mode === 'voice';

    // Desktop UI
    const dTextBtn = document.getElementById('desk-mode-text');
    const dVoiceBtn = document.getElementById('desk-mode-voice');
    const dTextVw = document.getElementById('desk-text-view');
    const dVoiceVw = document.getElementById('desk-voice-view');

    if (dTextBtn) {
        dTextBtn.className = isVoice ? 'px-4 py-1.5 text-xs font-semibold rounded-md text-on-surface-variant hover:text-on-surface transition-all' : 'px-4 py-1.5 text-xs font-semibold rounded-md bg-white shadow-sm text-on-surface transition-all';
        dVoiceBtn.className = isVoice ? 'px-4 py-1.5 text-xs font-semibold rounded-md bg-white shadow-sm text-on-surface transition-all' : 'px-4 py-1.5 text-xs font-semibold rounded-md text-on-surface-variant hover:text-on-surface transition-all';
        dTextVw.classList.toggle('hidden', isVoice);
        dVoiceVw.classList.toggle('hidden', !isVoice);
    }

    // Mobile UI
    const mTextBtn = document.getElementById('mob-mode-text');
    const mVoiceBtn = document.getElementById('mob-mode-voice');
    const mTextVw = document.getElementById('mob-text-view');
    const mVoiceVw = document.getElementById('mob-voice-view');

    if (mTextBtn) {
        mTextBtn.className = isVoice ? 'px-3 py-1 text-xs font-semibold rounded-md text-on-surface-variant transition-all' : 'px-3 py-1 text-xs font-semibold rounded-md bg-white shadow-sm text-on-surface transition-all';
        mVoiceBtn.className = isVoice ? 'px-3 py-1 text-xs font-semibold rounded-md bg-white shadow-sm text-on-surface transition-all' : 'px-3 py-1 text-xs font-semibold rounded-md text-on-surface-variant transition-all';
        mTextVw.classList.toggle('hidden', isVoice);
        mVoiceVw.classList.toggle('hidden', !isVoice);
    }

    // Refresh history when switching back to text
    if (!isVoice) {
        if (isDesktopDevice()) {
            loadDesktopChatHistory();
        } else {
            loadMobileChatHistory();
        }
    }
}

// Strip [YYYY-MM-DDTHH:MM] timestamp prefix that the backend injects for AI context
function stripTimestamp(content) {
    return String(content || '').replace(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}\]\s*/, '');
}

function isDesktopDevice() {
    return window.innerWidth >= 768;
}

// ─── API helper (injects X-User-ID header) ──────────────────────
async function api(url, method = 'GET', body = null) {
    const opts = { method, headers: {} };
    if (body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    if (currentUserId) {
        opts.headers['X-User-ID'] = currentUserId;
    }
    const res = await fetch(url, opts);
    return res.json();
}

// ════════════════════════════════════════════════════════════════
//  USER SELECT + PIN SYSTEM
// ════════════════════════════════════════════════════════════════
async function initUserSelect() {
    // Check session storage first
    const saved = localStorage.getItem('ekku_user_id');
    const savedData = localStorage.getItem('ekku_user_data');
    if (saved && savedData) {
        currentUserId = saved;
        currentUserData = JSON.parse(savedData);
        showApp();
        return;
    }
    document.getElementById('auth-screen').style.display = 'flex';
    document.getElementById('app-shell').classList.add('hidden');
    switchAuthTab('login');
}

function switchAuthTab(tab) {
    const isLog = tab === 'login';
    const tLog = document.getElementById('tab-login');
    const tCre = document.getElementById('tab-create');
    if (tLog && tCre) {
        tLog.className = isLog ? 'auth-tab-active auth-tab flex-1 py-2 rounded-lg text-sm font-semibold transition-all' : 'auth-tab-inactive auth-tab flex-1 py-2 rounded-lg text-sm font-semibold transition-all';
        tCre.className = !isLog ? 'auth-tab-active auth-tab flex-1 py-2 rounded-lg text-sm font-semibold transition-all' : 'auth-tab-inactive auth-tab flex-1 py-2 rounded-lg text-sm font-semibold transition-all';
    }
    document.getElementById('login-panel').classList.toggle('hidden', !isLog);
    document.getElementById('create-panel').classList.toggle('hidden', isLog);

    if (isLog) loadLoginUsers();
    else {
        // Reset create form
        document.getElementById('ca-name').value = '';
        document.getElementById('ca-code').value = '';
        document.getElementById('ca-error').classList.add('hidden');
        pinBuffer = '';
        updatePinDots('ca', pinBuffer);
    }
}

async function loadLoginUsers() {
    try {
        const users = await fetch('/api/users').then(r => r.json());
        const list = document.getElementById('user-login-list');
        const emptyMsg = document.getElementById('no-accounts-msg');
        if (users.length === 0) {
            list.innerHTML = '';
            emptyMsg.classList.remove('hidden');
        } else {
            emptyMsg.classList.add('hidden');
            list.innerHTML = users.map(u => `
                <div class="user-login-item flex items-center gap-3 p-3 rounded-xl mb-2" onclick="selectUser(${JSON.stringify(u).replace(/"/g, '&quot;')})">
                    <div class="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold shadow-md" style="background:${u.color}">${escapeHtml(u.name[0])}</div>
                    <div class="flex-1 text-left">
                        <p class="font-medium text-white text-sm leading-tight">${escapeHtml(u.name)}</p>
                        <p class="text-[10px] text-white/40 mt-0.5 flex items-center gap-1">
                            <span class="material-symbols-outlined text-[11px]">lock</span> Secured account
                        </p>
                    </div>
                    <span class="material-symbols-outlined text-white/30 text-[18px]">chevron_right</span>
                </div>
            `).join('');
        }
    } catch (e) {
        document.getElementById('user-login-list').innerHTML = '<div class="text-white/40 text-center py-4 text-sm">Failed to load accounts. Server offline?</div>';
    }
}

// ── Create Account Form ─────────────────────────────────────────
function caKey(digit) {
    if (pinBuffer.length >= 4) return;
    pinBuffer += digit;
    updatePinDots('ca', pinBuffer);
}

function caDel() {
    if (!pinBuffer.length) return;
    pinBuffer = pinBuffer.slice(0, -1);
    updatePinDots('ca', pinBuffer);
}

async function submitCreateAccount() {
    const name = document.getElementById('ca-name').value.trim();
    const code = document.getElementById('ca-code').value.trim();
    const err = document.getElementById('ca-error');

    if (!name) { err.textContent = 'Please enter a name.'; err.classList.remove('hidden'); return; }
    if (pinBuffer.length !== 4) { err.textContent = 'Please enter a 4-digit PIN.'; err.classList.remove('hidden'); return; }
    if (!code) { err.textContent = 'Invite code is required.'; err.classList.remove('hidden'); return; }

    err.classList.add('hidden');

    try {
        const res = await fetch('/api/create_account', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, pin: pinBuffer, invite_code: code })
        }).then(r => r.json());

        if (res.ok) {
            loginSuccess(res.id, res.name, res.color);
        } else {
            err.textContent = res.error || 'Failed to create account';
            err.classList.remove('hidden');
        }
    } catch (e) {
        err.textContent = 'Server error. Please try again.';
        err.classList.remove('hidden');
    }
}

// ── PIN Screen ──────────────────────────────────────────────────
function selectUser(user) {
    pendingUser = user;
    document.getElementById('auth-screen').style.display = 'none';
    showPinScreen(user);
}

function showAuthScreen() {
    document.getElementById('pin-screen').classList.add('hidden');
    document.getElementById('auth-screen').style.display = 'flex';
    pinBuffer = '';
}

function showPinScreen(user) {
    const scr = document.getElementById('pin-screen');
    scr.classList.remove('hidden');
    pinBuffer = '';

    const av = document.getElementById('pin-avatar');
    av.textContent = user.name[0];
    av.style.background = user.color;
    document.getElementById('pin-user-name').textContent = user.name;
    document.getElementById('pin-error').classList.add('hidden');

    updatePinDots('pd', pinBuffer);
}

function pinKey(digit) {
    if (pinBuffer.length >= 4) return;
    pinBuffer += digit;
    updatePinDots('pd', pinBuffer);
    if (pinBuffer.length === 4) {
        setTimeout(() => submitPin(), 80);
    }
}

function pinBackspace() {
    if (!pinBuffer.length) return;
    pinBuffer = pinBuffer.slice(0, -1);
    updatePinDots('pd', pinBuffer);
    document.getElementById('pin-error').classList.add('hidden');
}

async function submitPin() {
    if (!pendingUser || pinBuffer.length !== 4) return;
    try {
        const res = await fetch('/api/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: pendingUser.id, pin: pinBuffer })
        }).then(r => r.json());
        if (res.ok) {
            loginSuccess(pendingUser.id, res.name || pendingUser.name, pendingUser.color);
        } else {
            pinError();
        }
    } catch {
        pinError();
    }
}

function pinError() {
    const dotsRow = document.getElementById('pin-dots-row');
    dotsRow.classList.add('pin-shake');
    setTimeout(() => dotsRow.classList.remove('pin-shake'), 450);

    for (let i = 0; i < 4; i++) {
        const d = document.getElementById('pd' + i);
        if (d) { d.classList.add('error'); setTimeout(() => d.classList.remove('error'), 700); }
    }
    document.getElementById('pin-error').classList.remove('hidden');
    setTimeout(() => {
        pinBuffer = '';
        updatePinDots('pd', pinBuffer);
    }, 700);
}

// ── PIN dot helper ───────────────────────────────────────────────
function updatePinDots(prefix, buf) {
    for (let i = 0; i < 4; i++) {
        const d = document.getElementById(prefix + i);
        if (!d) continue;
        if (i < buf.length) {
            d.classList.add('filled');
        } else {
            d.classList.remove('filled', 'error');
        }
    }
}

// ── Desktop keyboard support ─────────────────────────────────────
document.addEventListener('keydown', (e) => {
    const authScr = document.getElementById('auth-screen');
    const pinScr = document.getElementById('pin-screen');

    // Auth screen open?
    if (authScr.style.display === 'flex' || authScr.style.display === '') {
        const createTab = !document.getElementById('create-panel').classList.contains('hidden');
        if (createTab) {
            // Check if typing in text inputs
            const act = document.activeElement;
            if (act.tagName === 'INPUT' && (act.id === 'ca-name' || act.id === 'ca-code')) return;

            if (e.key >= '0' && e.key <= '9') caKey(e.key);
            else if (e.key === 'Backspace') caDel();
        }
        return;
    }

    // PIN screen open?
    if (!pinScr.classList.contains('hidden')) {
        if (e.key >= '0' && e.key <= '9') pinKey(e.key);
        else if (e.key === 'Backspace') pinBackspace();
        return;
    }

    // Global app shortcuts
    if (!currentUserId) return;
    handleGlobalKeydown(e);
});

// ── Login success ────────────────────────────────────────────────
function loginSuccess(uid, name, color) {
    currentUserId = uid;
    currentUserData = { id: uid, name, color };
    localStorage.setItem('ekku_user_id', uid);
    localStorage.setItem('ekku_user_data', JSON.stringify(currentUserData));
    showApp();
}

function showApp() {
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('pin-screen').classList.add('hidden');
    document.getElementById('app-shell').classList.remove('hidden');

    updateUserUI();
    bootApp();
}

function switchUser() {
    currentUserId = null;
    currentUserData = null;
    localStorage.removeItem('ekku_user_id');
    localStorage.removeItem('ekku_user_data');
    pinBuffer = '';
    pendingUser = null;
    // Clear chat messages so next user doesn't see previous user's chat
    const chatCont = document.getElementById('chat-messages');
    if (chatCont) chatCont.innerHTML = '';
    const deskChat = document.getElementById('desk-chat-messages');
    if (deskChat) {
        deskChat.querySelectorAll('.chat-msg').forEach(el => el.remove());
        hideDesktopTyping();
    }
    initUserSelect();
}

function logOut() {
    switchUser();
}

function updateUserUI() {
    if (!currentUserData) return;
    const { name, color } = currentUserData;
    const initial = (name || 'U')[0];
    // Mobile header button
    const mb = document.getElementById('mobile-user-btn');
    if (mb) { mb.textContent = initial; mb.style.background = color; }
    // Desktop nav button
    const db = document.getElementById('desk-user-btn');
    if (db) { db.textContent = initial; db.style.background = color; }
    // Sidebar profile
    const sa = document.getElementById('desk-profile-avatar');
    if (sa) { sa.textContent = initial; sa.style.background = color; }
    const sn = document.getElementById('desk-profile-name');
    if (sn) sn.textContent = name;
    // Footer
    const fl = document.getElementById('footer-user-label');
    if (fl) fl.textContent = `User: ${name}`;
}

// ════════════════════════════════════════════════════════════════
//  APP BOOT
// ════════════════════════════════════════════════════════════════
function bootApp() {
    loadSummary();
    loadRoutine();
    loadAttendance();
    loadBudget();
    loadCGPA();
    loadPlans();
    loadTasks();
    if (isDesktopDevice()) {
        showView('chat');
        loadDesktopChatHistory();
        loadDesktopChatPanel();
    } else {
        showView('dashboard');
        // Pre-load mobile chat history in background
        loadMobileChatHistory();
    }
    loadSettingsUserList();
    initGreeting();
}

function initGreeting() {
    const h = new Date().getHours();
    const part = h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening';
    const el = document.getElementById('dash-greet-part');
    if (el) el.textContent = part;
}

// ════════════════════════════════════════════════════════════════
//  VIEW MANAGEMENT
// ════════════════════════════════════════════════════════════════
function showView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const target = document.getElementById('view-' + name);
    if (target) target.classList.add('active');

    // Nav highlighting
    document.querySelectorAll('.nav-item').forEach(el => {
        const isActive = el.dataset.view === name;
        el.classList.toggle('bg-primary-container', isActive);
        el.classList.toggle('text-primary', isActive);
        el.classList.toggle('text-on-surface-variant', !isActive);
    });
    document.querySelectorAll('#mobile-nav .nav-item').forEach(el => {
        el.classList.toggle('text-primary', el.dataset.view === name);
        el.classList.toggle('text-on-surface-variant', el.dataset.view !== name);
    });

    // View-specific initialisation
    if (name === 'chat') {
        if (isDesktopDevice()) {
            loadDesktopChatPanel();
            setTimeout(() => {
                const inp = document.getElementById('desk-chat-input');
                if (inp) inp.focus();
            }, 60);
        } else {
            // Mobile: load chat history when entering chat view
            loadMobileChatHistory();
        }
    }
    if (name === 'dashboard') {
        loadSummary();
    }
}

// ════════════════════════════════════════════════════════════════
//  TOAST
// ════════════════════════════════════════════════════════════════
function toast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const colorMap = { success: 'bg-emerald-success', error: 'bg-error', info: 'bg-secondary', warning: 'bg-warning-amber' };
    const iconMap = { success: 'check_circle', error: 'error', info: 'info', warning: 'warning' };
    const t = document.createElement('div');
    t.className = `flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg text-white text-body-sm font-label-md toast-in ${colorMap[type] || colorMap.info}`;
    t.innerHTML = `<span class="material-symbols-outlined text-[18px]">${iconMap[type] || 'info'}</span><span>${escapeHtml(msg)}</span>`;
    container.appendChild(t);
    setTimeout(() => { t.classList.replace('toast-in', 'toast-out'); setTimeout(() => t.remove(), 350); }, 3000);
}

// ════════════════════════════════════════════════════════════════
//  SUMMARY / DASHBOARD
// ════════════════════════════════════════════════════════════════
async function loadSummary() {
    try {
        const data = await api('/api/summary');
        const today = data.today || '?';
        const dateStr = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
        // Mobile
        const mobDate = document.getElementById('dash-date');
        if (mobDate) mobDate.textContent = dateStr;
        // Desktop
        const dtDate = document.getElementById('dash-date-dt');
        if (dtDate) dtDate.textContent = dateStr.toUpperCase();

        // Attendance
        const attPct = data.att_percent || 0;
        const attStatus = attPct >= 75 ? 'GOOD' : attPct >= 60 ? 'AT RISK' : 'DANGER';
        const attColor = attPct >= 75 ? 'bg-emerald-success/15 text-emerald-success' : attPct >= 60 ? 'bg-warning-amber/15 text-warning-amber' : 'bg-error-container text-on-error-container';
        ['dash-att', 'd-att-pct-dt', 'd-att-pct-ring-dt'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = attPct + '%';
        });
        const attBar = document.getElementById('dash-att-bar');
        if (attBar) attBar.style.width = Math.min(attPct, 100) + '%';
        const statusChip = document.getElementById('d-att-status-chip');
        if (statusChip) { statusChip.textContent = attStatus; statusChip.className = `text-[10px] px-2 py-0.5 rounded-full font-semibold ${attColor}`; }
        const statusDt = document.getElementById('d-att-status-dt');
        if (statusDt) statusDt.textContent = attPct >= 75 ? 'You are on track!' : attPct >= 60 ? 'Getting close to 75% limit' : 'Below 75% — danger zone!';

        // Attendance ring
        updateRing('d-att-ring', attPct, 213.6, attPct >= 75 ? '#10B981' : attPct >= 60 ? '#F59E0B' : '#ba1a1a');

        // CGPA
        const cgpa = data.cgpa || 0;
        ['dash-cgpa', 'd-cgpa-dt', 'd-cgpa-ring-dt'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = cgpa.toFixed(2);
        });
        const cgpaBar = document.getElementById('d-cgpa-bar-dt');
        if (cgpaBar) cgpaBar.style.width = (cgpa / 4 * 100) + '%';

        // Budget
        const balance = data.balance || 0;
        const totalIn = data.total_in || 0;
        const totalOut = data.total_out || 0;
        ['bud-balance', 'dash-balance', 'd-balance-dt', 'd-balance-ring-dt'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = '৳' + balance.toFixed(0);
        });
        const spentEl = document.getElementById('dash-spent');
        if (spentEl) spentEl.textContent = 'Spent: ৳' + totalOut.toFixed(0);
        const totalEl = document.getElementById('dash-total');
        if (totalEl) totalEl.textContent = 'Total: ৳' + totalIn.toFixed(0);
        const budPct = totalIn > 0 ? Math.min((totalOut / totalIn) * 100, 100) : 0;
        const budBar = document.getElementById('dash-budget-bar');
        if (budBar) budBar.style.width = budPct + '%';
        const dBudBar = document.getElementById('d-budget-bar-dt');
        if (dBudBar) { dBudBar.style.width = budPct + '%'; dBudBar.style.background = balance >= 0 ? '#10B981' : '#ba1a1a'; }
        const dBudSpent = document.getElementById('d-budget-spent-dt');
        if (dBudSpent) dBudSpent.textContent = '৳' + totalOut.toFixed(0);
        const dBudTotal = document.getElementById('d-budget-total-dt');
        if (dBudTotal) dBudTotal.textContent = '৳' + totalIn.toFixed(0);
        // Budget ring
        updateRing('d-budget-ring', budPct, 326.7, balance >= 0 ? '#10B981' : '#ba1a1a');

        // Tasks
        const pending = data.pending_tasks || 0;
        const pendingEl = document.getElementById('dash-done');
        if (pendingEl) pendingEl.textContent = pending;
        ['d-pending-dt'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = pending;
        });

        // Task badge on nav
        const badge = document.getElementById('nav-task-badge');
        if (badge) {
            badge.textContent = pending;
            badge.classList.toggle('hidden', pending === 0);
            badge.classList.toggle('inline-flex', pending > 0);
        }

        // Render today's schedule
        renderDashRoutine(data.today_routine || [], today, data);
        renderDashTasks();
        renderSmartInsights(data);
    } catch (e) {
        console.error('Summary load failed:', e);
    }
}

function updateRing(id, pct, circumference, color) {
    const ring = document.getElementById(id);
    if (!ring) return;
    const offset = circumference - (pct / 100) * circumference;
    ring.style.strokeDashoffset = offset;
    ring.style.stroke = color;
}

function renderDashRoutine(classes, today, data) {
    const mobEl = document.getElementById('dash-routine');
    const dtEl = document.getElementById('dash-routine-dt');

    if (!classes || classes.length === 0) {
        const emptyHtml = `<div class="flex flex-col items-center text-center py-6">
            <span class="material-symbols-outlined text-[28px] text-emerald-success">event_available</span>
            <p class="text-[13px] font-semibold text-on-surface mt-2">No classes today</p>
            <p class="text-[11px] text-on-surface-variant mt-1">Good day to catch up on tasks.</p>
        </div>`;
        if (mobEl) mobEl.innerHTML = emptyHtml;
        if (dtEl) dtEl.innerHTML = emptyHtml;
        return;
    }

    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    classes.forEach(c => {
        const m = String(c.time || '').match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
        let mins = 0;
        if (m) {
            let h = parseInt(m[1], 10);
            const ap = (m[3] || '').toUpperCase();
            if (ap === 'PM' && h < 12) h += 12;
            if (ap === 'AM' && h === 12) h = 0;
            mins = h * 60 + parseInt(m[2], 10);
        }
        c._mins = mins;
    });
    const sorted = [...classes].sort((a, b) => a._mins - b._mins);
    let nextIdx = -1;
    for (let i = 0; i < sorted.length; i++) { if (sorted[i]._mins >= nowMin) { nextIdx = i; break; } }

    const html = sorted.map((c, i) => {
        const isNext = i === nextIdx;
        const isPast = c._mins < nowMin;
        return `<div class="flex items-center gap-3 py-2 px-2 rounded-lg ${isNext ? 'bg-primary-fixed/50' : 'hover:bg-surface-container-low'} transition-colors">
            <div class="w-12 shrink-0 text-[11px] font-semibold text-on-surface-variant">${escapeHtml(c.time)}</div>
            <div class="w-1 h-8 rounded-full ${isNext ? 'bg-primary' : isPast ? 'bg-surface-variant' : 'bg-emerald-success/60'}"></div>
            <div class="flex-1 min-w-0">
                <p class="text-[12px] font-medium text-on-surface truncate ${isNext ? 'text-primary' : ''}">${escapeHtml(c.course)}</p>
                <p class="text-[10px] text-on-surface-variant">${escapeHtml(c.room || '')}</p>
            </div>
            ${isNext ? '<span class="text-[9px] px-1.5 py-0.5 rounded-full bg-primary text-on-primary shrink-0">NEXT</span>' : isPast ? '<span class="text-[9px] text-on-surface-variant shrink-0">done</span>' : ''}
        </div>`;
    }).join('');

    if (mobEl) mobEl.innerHTML = html;
    if (dtEl) dtEl.innerHTML = html;
}

async function renderDashTasks() {
    try {
        const tasks = await api('/api/tasks');
        const pending = tasks.filter(t => !t.done).slice(0, 5);
        const mobEl = document.getElementById('dash-tasks');
        const dtEl = document.getElementById('dash-tasks-dt');
        const html = pending.length === 0
            ? '<div class="text-[12px] text-on-surface-variant text-center py-4">All caught up! 🎉</div>'
            : pending.map(t => `
                <div class="flex items-center gap-2.5 py-2 px-2 rounded-lg hover:bg-surface-container-low transition-colors">
                    <button onclick="toggleTask(${t.id}, 1)" class="w-5 h-5 rounded-full border-2 flex items-center justify-center border-surface-variant text-transparent hover:border-primary transition-colors shrink-0">
                        <span class="material-symbols-outlined text-[14px]">check</span>
                    </button>
                    <div class="flex-1 min-w-0">
                        <p class="text-[13px] font-medium text-on-surface truncate">${escapeHtml(t.title)}</p>
                        <p class="text-[11px] text-on-surface-variant">${t.date}</p>
                    </div>
                    <span class="text-[10px] px-2 py-0.5 rounded-full ${t.priority === 'high' ? 'bg-error-container text-on-error-container' : t.priority === 'low' ? 'bg-emerald-success/20 text-emerald-success' : 'bg-warning-amber/20 text-warning-amber'}">${t.priority}</span>
                </div>`).join('');
        if (mobEl) mobEl.innerHTML = html;
        if (dtEl) dtEl.innerHTML = html;
    } catch (e) { }
}

function renderSmartInsights(data) {
    const container = document.getElementById('smart-insights');
    if (!container) return;
    const insights = [];
    if ((data.att_percent || 0) < 75) {
        insights.push({ icon: 'warning', color: 'bg-error-container text-on-error-container', msg: `Attendance at ${data.att_percent}% — below 75% threshold. Consider attending more classes.` });
    }
    if ((data.pending_tasks || 0) > 3) {
        insights.push({ icon: 'task_alt', color: 'bg-warning-amber/15 text-warning-amber', msg: `${data.pending_tasks} tasks pending. Let's tackle them today!` });
    }
    if ((data.balance || 0) < 0) {
        insights.push({ icon: 'savings', color: 'bg-error-container text-on-error-container', msg: 'Budget is in the red. Review your spending.' });
    }
    if (insights.length === 0) return;
    container.innerHTML = `<div class="flex flex-wrap gap-3 mb-4 animate-fade-in">
        ${insights.map(i => `
            <div class="flex items-center gap-2 px-4 py-2.5 rounded-xl ${i.color} text-[13px] font-medium">
                <span class="material-symbols-outlined text-[16px]">${i.icon}</span>${escapeHtml(i.msg)}
            </div>`).join('')}
    </div>`;
}

// ════════════════════════════════════════════════════════════════
//  ROUTINE
// ════════════════════════════════════════════════════════════════
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_COLORS = {
    '#af101a': 'bg-red-100 text-red-800 border-red-200',
    '#6366f1': 'bg-indigo-100 text-indigo-800 border-indigo-200',
    '#10B981': 'bg-emerald-100 text-emerald-800 border-emerald-200',
    '#F59E0B': 'bg-amber-100 text-amber-800 border-amber-200',
    '#0ea5e9': 'bg-sky-100 text-sky-800 border-sky-200',
    '#8b5cf6': 'bg-violet-100 text-violet-800 border-violet-200',
    '#ef4444': 'bg-red-100 text-red-800 border-red-200',
};

async function loadRoutine() {
    const data = await api('/api/routine');
    const grid = document.getElementById('routine-grid');
    if (!grid) return;
    const byDay = {};
    DAYS.forEach(d => byDay[d] = []);
    data.forEach(r => { if (byDay[r.day]) byDay[r.day].push(r); });

    const todayDay = DAYS[new Date().getDay()];
    grid.innerHTML = DAYS.map(day => {
        const classes = byDay[day];
        const isToday = day === todayDay;
        return `<div class="col-span-1 ${isToday ? 'ring-2 ring-primary ring-offset-1' : ''} bg-surface-container-lowest border ${isToday ? 'border-primary' : 'border-surface-variant'} rounded-xl p-3 min-h-[120px] flex flex-col hover:shadow-sm transition-all">
            <div class="flex items-center justify-between mb-2">
                <span class="text-[11px] font-semibold uppercase tracking-wide ${isToday ? 'text-primary' : 'text-on-surface-variant'}">${day}</span>
                ${isToday ? '<span class="text-[9px] px-1.5 py-0.5 rounded bg-primary text-on-primary font-semibold">TODAY</span>' : ''}
            </div>
            <div class="flex-1 space-y-1">
                ${classes.length === 0 ? '<p class="text-[11px] text-on-surface-variant/50 text-center py-3">No class</p>' :
                classes.map(c => {
                    const colorClass = DAY_COLORS[c.color] || 'bg-primary-fixed text-on-primary-fixed-variant border-primary-fixed-dim';
                    return `<div class="flex flex-col border rounded-lg p-2 ${colorClass} group">
                            <div class="flex justify-between items-start">
                                <span class="text-[11px] font-semibold leading-tight flex-1 pr-1 truncate">${escapeHtml(c.course)}</span>
                                <button onclick="deleteRoutine(${c.id})" class="opacity-0 group-hover:opacity-100 text-[10px] transition-opacity shrink-0">✕</button>
                            </div>
                            <span class="text-[10px] opacity-70 mt-0.5">${escapeHtml(c.time)}${c.room ? ' · ' + escapeHtml(c.room) : ''}</span>
                        </div>`;
                }).join('')}
            </div>
        </div>`;
    }).join('');
}

async function deleteRoutine(id) {
    await api('/api/routine', 'DELETE', { id });
    toast('Class removed', 'info');
    loadRoutine();
    loadSummary();
}

function openRoutineModal() {
    MODAL_ACTION = 'routine';
    document.getElementById('modal-title').textContent = 'Add Class';
    selectedColor = '#af101a';
    document.getElementById('modal-body').innerHTML = `
        <select id="f-day" class="w-full bg-surface border border-surface-variant rounded px-3 py-2">
            ${DAYS.map(d => `<option value="${d}">${d}</option>`).join('')}
        </select>
        <input id="f-time" type="time" value="09:00" class="w-full bg-surface border border-surface-variant rounded px-3 py-2"/>
        <input id="f-course" placeholder="Course name" class="w-full bg-surface border border-surface-variant rounded px-3 py-2"/>
        <input id="f-room" placeholder="Room (optional)" class="w-full bg-surface border border-surface-variant rounded px-3 py-2"/>
        <input id="f-prof" placeholder="Professor (optional)" class="w-full bg-surface border border-surface-variant rounded px-3 py-2"/>
        <div>
            <label class="text-label-sm text-on-surface-variant">Color</label>
            <div class="flex gap-2 mt-2">
                ${['#af101a', '#6366f1', '#10B981', '#F59E0B', '#0ea5e9', '#8b5cf6'].map(c =>
        `<button onclick="selectedColor='${c}'; document.querySelectorAll('.color-pick').forEach(b=>b.classList.remove('ring-2','ring-offset-1')); this.classList.add('ring-2','ring-offset-1');" class="color-pick w-7 h-7 rounded-full transition-all" style="background:${c}"></button>`
    ).join('')}
            </div>
        </div>`;
    document.getElementById('modal-overlay').classList.remove('hidden');
}

// ════════════════════════════════════════════════════════════════
//  ATTENDANCE
// ════════════════════════════════════════════════════════════════
async function loadAttendance() {
    const data = await api('/api/attendance');
    const list = document.getElementById('att-list');
    const overall = document.getElementById('att-overall');
    const overallBar = document.getElementById('att-overall-bar');

    if (!list) return;
    if (data.length === 0) {
        list.innerHTML = `<div class="text-on-surface-variant text-center py-10 bg-surface-container-lowest border border-surface-variant rounded-xl p-6">
            <span class="material-symbols-outlined text-[40px] mb-3 text-on-surface-variant/50">how_to_reg</span>
            <p class="font-semibold">No courses yet</p>
            <p class="text-[13px] mt-1">Add a course to start tracking attendance.</p>
        </div>`;
    } else {
        const totTotal = data.reduce((s, a) => s + a.total, 0);
        const totPresent = data.reduce((s, a) => s + a.present, 0);
        const overallPct = totTotal > 0 ? Math.round(totPresent / totTotal * 100) : 0;
        if (overall) overall.textContent = overallPct + '%';
        if (overallBar) overallBar.style.width = overallPct + '%';

        list.innerHTML = data.map(a => {
            const pct = a.percent || 0;
            const safe = Math.round((a.total * 0.75) - a.present);
            const canMiss = Math.max(0, Math.round(a.present / 0.75 - a.total));
            const statusColor = pct >= 75 ? 'text-emerald-success' : pct >= 60 ? 'text-warning-amber' : 'text-error';
            const barColor = pct >= 75 ? 'bg-emerald-success' : pct >= 60 ? 'bg-warning-amber' : 'bg-error';
            return `<div class="bg-surface-container-lowest border border-surface-variant rounded-xl p-card-padding shadow-sm">
                <div class="flex items-start justify-between mb-3">
                    <div>
                        <h3 class="font-label-md text-label-md text-on-surface">${escapeHtml(a.course)}</h3>
                        <p class="text-[12px] text-on-surface-variant mt-0.5">${a.present}/${a.total} classes attended</p>
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="font-headline-md text-headline-md ${statusColor}">${pct}%</span>
                        <button onclick="deleteAtt(${a.id})" class="text-on-surface-variant hover:text-primary"><span class="material-symbols-outlined text-[18px]">delete</span></button>
                    </div>
                </div>
                <div class="w-full bg-surface-container rounded-full h-2 overflow-hidden mb-3">
                    <div class="${barColor} h-2 rounded-full transition-all duration-700" style="width:${Math.min(pct, 100)}%"></div>
                </div>
                <div class="flex items-center justify-between">
                    <p class="text-[12px] text-on-surface-variant">
                        ${pct >= 75 ? `Can miss <b class="text-on-surface">${canMiss}</b> more` : `Need <b class="text-on-surface">${safe}</b> more to reach 75%`}
                    </p>
                    <div class="flex gap-2">
                        <button onclick="markAttendance(${a.id}, ${a.total}, ${a.present}, 1)" class="flex items-center gap-1 text-[11px] px-3 py-1.5 rounded-full bg-emerald-success/15 text-emerald-success hover:bg-emerald-success hover:text-white transition-colors font-semibold">
                            <span class="material-symbols-outlined text-[14px]">check</span> Present
                        </button>
                        <button onclick="markAttendance(${a.id}, ${a.total}, ${a.present}, 0)" class="flex items-center gap-1 text-[11px] px-3 py-1.5 rounded-full bg-error-container text-on-error-container hover:bg-error hover:text-white transition-colors font-semibold">
                            <span class="material-symbols-outlined text-[14px]">close</span> Absent
                        </button>
                    </div>
                </div>
            </div>`;
        }).join('');
    }
}

async function markAttendance(id, total, present, wasPresent) {
    await api('/api/attendance/update', 'POST', { id, total: total + 1, present: present + (wasPresent ? 1 : 0) });
    toast(wasPresent ? 'Marked present ✓' : 'Marked absent', wasPresent ? 'success' : 'info');
    loadAttendance();
    loadSummary();
}

async function deleteAtt(id) {
    await api('/api/attendance', 'DELETE', { id });
    toast('Course removed', 'info');
    loadAttendance();
    loadSummary();
}

function openAttModal() {
    MODAL_ACTION = 'attendance';
    document.getElementById('modal-title').textContent = 'Add Course';
    document.getElementById('modal-body').innerHTML = `
        <input id="f-course" placeholder="Course name" class="w-full bg-surface border border-surface-variant rounded px-3 py-2"/>
        <input id="f-total" type="number" placeholder="Total classes held" value="0" class="w-full bg-surface border border-surface-variant rounded px-3 py-2"/>
        <input id="f-present" type="number" placeholder="Classes attended" value="0" class="w-full bg-surface border border-surface-variant rounded px-3 py-2"/>`;
    document.getElementById('modal-overlay').classList.remove('hidden');
}

// ════════════════════════════════════════════════════════════════
//  BUDGET
// ════════════════════════════════════════════════════════════════
async function loadBudget() {
    const data = await api('/api/budget');
    const balEl = document.getElementById('bud-balance');
    const inEl = document.getElementById('bud-in');
    const outEl = document.getElementById('bud-out');
    const list = document.getElementById('bud-list');
    if (balEl) balEl.textContent = '৳' + (data.balance || 0).toFixed(2);
    if (inEl) inEl.textContent = '৳' + (data.total_in || 0).toFixed(2);
    if (outEl) outEl.textContent = '৳' + (data.total_out || 0).toFixed(2);
    if (!list) return;
    if (!data.items || data.items.length === 0) {
        list.innerHTML = '<div class="text-on-surface-variant text-center py-10">No entries yet.</div>';
    } else {
        list.innerHTML = data.items.map(it => `
            <div class="flex items-center justify-between p-4 bg-surface-container-lowest border border-surface-variant rounded-xl shadow-sm">
                <div class="flex items-center gap-3">
                    <div class="w-9 h-9 rounded-full flex items-center justify-center ${it.type === 'income' ? 'bg-emerald-success/15 text-emerald-success' : 'bg-error-container text-on-error-container'}">
                        <span class="material-symbols-outlined text-[18px]">${it.type === 'income' ? 'arrow_downward' : 'arrow_upward'}</span>
                    </div>
                    <div>
                        <p class="font-medium text-on-surface">${escapeHtml(it.desc)}</p>
                        <p class="text-[11px] text-on-surface-variant">${it.date}</p>
                    </div>
                </div>
                <div class="flex items-center gap-3">
                    <span class="font-semibold ${it.type === 'income' ? 'text-emerald-success' : 'text-error'}">
                        ${it.type === 'income' ? '+' : '-'}৳${(it.amount || 0).toFixed(2)}
                    </span>
                    <button onclick="deleteBudget(${it.id})" class="text-on-surface-variant hover:text-primary">
                        <span class="material-symbols-outlined text-[18px]">delete</span>
                    </button>
                </div>
            </div>`).join('');
    }
}

async function deleteBudget(id) {
    await api('/api/budget', 'DELETE', { id });
    toast('Entry deleted', 'info');
    loadBudget();
    loadSummary();
}

function openBudgetModal() {
    MODAL_ACTION = 'budget';
    document.getElementById('modal-title').textContent = 'Add Budget Entry';
    document.getElementById('modal-body').innerHTML = `
        <select id="f-type" class="w-full bg-surface border border-surface-variant rounded px-3 py-2">
            <option value="expense">Expense</option>
            <option value="income">Income</option>
        </select>
        <input id="f-desc" placeholder="Description" class="w-full bg-surface border border-surface-variant rounded px-3 py-2"/>
        <input id="f-amount" type="number" step="0.01" placeholder="Amount" class="w-full bg-surface border border-surface-variant rounded px-3 py-2"/>
        <input id="f-date" type="date" value="${new Date().toISOString().split('T')[0]}" class="w-full bg-surface border border-surface-variant rounded px-3 py-2"/>`;
    document.getElementById('modal-overlay').classList.remove('hidden');
}

// ════════════════════════════════════════════════════════════════
//  CGPA
// ════════════════════════════════════════════════════════════════
async function loadCGPA() {
    const data = await api('/api/cgpa');
    const cgpaEl = document.getElementById('cgpa-value');
    const creditEl = document.getElementById('cgpa-credit');
    if (cgpaEl) cgpaEl.textContent = (data.cgpa || 0).toFixed(2);
    if (creditEl) creditEl.textContent = (data.total_credit || 0).toFixed(1);
    const list = document.getElementById('grade-list');
    if (!list) return;
    if (!data.items || data.items.length === 0) {
        list.innerHTML = '<div class="text-on-surface-variant text-center py-10">No courses added yet.</div>';
    } else {
        list.innerHTML = data.items.map(g => `
            <div class="flex items-center justify-between p-4 bg-surface-container-lowest border border-surface-variant rounded-xl shadow-sm">
                <div>
                    <p class="font-medium text-on-surface">${escapeHtml(g.course)}</p>
                    <p class="text-[11px] text-on-surface-variant">${g.credit} credit</p>
                </div>
                <div class="flex items-center gap-3">
                    <span class="font-headline-md text-headline-md text-primary">${g.grade.toFixed(2)}</span>
                    <button onclick="deleteGrade(${g.id})" class="text-on-surface-variant hover:text-primary">
                        <span class="material-symbols-outlined text-[18px]">delete</span>
                    </button>
                </div>
            </div>`).join('');
    }
}

async function deleteGrade(id) {
    await api('/api/cgpa', 'DELETE', { id });
    toast('Course removed', 'info');
    loadCGPA();
    loadSummary();
}

function openGradeModal() {
    MODAL_ACTION = 'grade';
    document.getElementById('modal-title').textContent = 'Add Course';
    document.getElementById('modal-body').innerHTML = `
        <input id="f-course" placeholder="Course name" class="w-full bg-surface border border-surface-variant rounded px-3 py-2"/>
        <input id="f-credit" type="number" step="0.5" placeholder="Credit (e.g. 3)" value="3" class="w-full bg-surface border border-surface-variant rounded px-3 py-2"/>
        <select id="f-grade" class="w-full bg-surface border border-surface-variant rounded px-3 py-2">
            <option value="4.0">A+ (4.0)</option>
            <option value="3.75">A (3.75)</option>
            <option value="3.5">A- (3.5)</option>
            <option value="3.25">B+ (3.25)</option>
            <option value="3.0">B (3.0)</option>
            <option value="2.75">B- (2.75)</option>
            <option value="2.5">C+ (2.5)</option>
            <option value="2.0">C (2.0)</option>
            <option value="1.0">D (1.0)</option>
            <option value="0.0">F (0.0)</option>
        </select>`;
    document.getElementById('modal-overlay').classList.remove('hidden');
}

async function predictCGPA() {
    const target = parseFloat(document.getElementById('pred-target').value) || 0;
    const done = parseFloat(document.getElementById('pred-done').value) || 0;
    const rem = parseFloat(document.getElementById('pred-rem').value) || 0;
    const data = await api('/api/cgpa');
    const current = data.cgpa;
    const result = await api('/api/cgpa/predict', 'POST', {
        current_cgpa: current, credits_done: done, target_cgpa: target, remaining_credits: rem
    });
    document.getElementById('pred-result').innerHTML = `
        <div class="mt-3 p-3 bg-surface rounded-lg border border-surface-variant">
            <p class="text-on-surface-variant text-[12px]">To reach a target CGPA of ${target.toFixed(2)}, you need in remaining credits:</p>
            <p class="font-display-stat text-display-stat text-primary mt-1">${result.required_gpa.toFixed(2)} GPA</p>
            <p class="text-[12px] text-on-surface-variant mt-1">${escapeHtml(result.note)}</p>
        </div>`;
}

// ════════════════════════════════════════════════════════════════
//  PLANS
// ════════════════════════════════════════════════════════════════
async function loadPlans() {
    const data = await api('/api/plans');
    const list = document.getElementById('plans-list');
    if (!list) return;
    if (data.length === 0) {
        list.innerHTML = `<div class="text-center p-6 text-on-surface-variant/60 text-sm">No plans yet. Create one!</div>`;
        return;
    }
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const grouped = {};
    days.forEach(d => grouped[d] = []);
    data.forEach(p => {
        if (!grouped[p.day]) grouped[p.day] = [];
        grouped[p.day].push(p);
    });

    let html = '';
    days.forEach(day => {
        if (grouped[day].length > 0) {
            html += `<div class="mb-4">
                <h3 class="text-xs font-bold text-primary uppercase tracking-widest mb-2 px-1">${day}</h3>
                <div class="space-y-2">`;
            grouped[day].forEach(plan => {
                const checked = plan.status === 'completed' ? 'checked' : '';
                const titleClass = plan.status === 'completed' ? 'line-through opacity-60 text-on-surface-variant' : 'text-on-surface font-semibold';
                html += `
                <div class="flex items-start gap-3 p-3 rounded-xl bg-surface-container border border-surface-variant">
                    <input type="checkbox" class="mt-1 w-4 h-4 rounded border-outline-variant text-primary focus:ring-primary cursor-pointer" ${checked} onchange="togglePlanStatus(${plan.id}, this.checked)">
                    <div class="flex-1">
                        <div class="flex justify-between items-start gap-2">
                            <span class="text-sm ${titleClass}">${escapeHtml(plan.title)}</span>
                            <span class="text-[10px] font-bold px-2 py-0.5 rounded-md bg-secondary-container text-on-secondary-container whitespace-nowrap">${escapeHtml(plan.duration)}</span>
                        </div>
                    </div>
                    <button onclick="deletePlan(${plan.id})" class="text-on-surface-variant/50 hover:text-error transition-colors mt-0.5">
                        <span class="material-symbols-outlined text-[18px]">delete</span>
                    </button>
                </div>`;
            });
            html += `</div></div>`;
        }
    });
    list.innerHTML = html;
}

function openPlanModal() {
    MODAL_ACTION = 'plan';
    document.getElementById('modal-title').textContent = 'Add Plan';
    document.getElementById('modal-body').innerHTML = `
        <div>
            <label class="block text-[11px] uppercase tracking-wider font-semibold text-on-surface-variant mb-1">Day</label>
            <select id="f-day" class="w-full bg-surface-container border border-surface-variant rounded-lg px-3 py-2 text-sm text-on-surface focus:border-primary focus:ring-1 focus:ring-primary outline-none">
                <option value="Monday">Monday</option>
                <option value="Tuesday">Tuesday</option>
                <option value="Wednesday">Wednesday</option>
                <option value="Thursday">Thursday</option>
                <option value="Friday">Friday</option>
                <option value="Saturday">Saturday</option>
                <option value="Sunday">Sunday</option>
            </select>
        </div>
        <div>
            <label class="block text-[11px] uppercase tracking-wider font-semibold text-on-surface-variant mb-1">Duration</label>
            <input id="f-duration" type="text" placeholder="e.g. 2 hours" class="w-full bg-surface-container border border-surface-variant rounded-lg px-3 py-2 text-sm text-on-surface focus:border-primary focus:ring-1 focus:ring-primary outline-none">
        </div>
        <div>
            <label class="block text-[11px] uppercase tracking-wider font-semibold text-on-surface-variant mb-1">Task / Activity</label>
            <input id="f-title" type="text" class="w-full bg-surface-container border border-surface-variant rounded-lg px-3 py-2 text-sm text-on-surface focus:border-primary focus:ring-1 focus:ring-primary outline-none">
        </div>
    `;
    document.getElementById('modal-overlay').classList.remove('hidden');
}

async function togglePlanStatus(id, isDone) {
    await api('/api/plans/' + id, 'PUT', { status: isDone ? 'completed' : 'pending' });
    loadPlans();
}

async function deletePlan(id) {
    if (!confirm('Delete plan?')) return;
    await api('/api/plans/' + id, 'DELETE');
    loadPlans();
    toast('Plan deleted', 'error');
}

// ════════════════════════════════════════════════════════════════
//  TASKS
// ════════════════════════════════════════════════════════════════
async function loadTasks() {
    const data = await api('/api/tasks');
    const list = document.getElementById('task-list');
    if (!list) return;
    if (data.length === 0) {
        list.innerHTML = '<div class="text-on-surface-variant text-center py-10">No tasks yet.</div>';
    } else {
        list.innerHTML = data.map(t => `
            <div class="flex items-center justify-between p-4 bg-surface-container-lowest border border-surface-variant rounded-xl shadow-sm ${t.done ? 'opacity-60' : ''}">
                <div class="flex items-center gap-3 flex-1">
                    <button onclick="toggleTask(${t.id}, ${t.done ? 0 : 1})" class="w-5 h-5 rounded-full border-2 flex items-center justify-center ${t.done ? 'bg-emerald-success border-emerald-success text-white' : 'border-surface-variant text-transparent'}">
                        <span class="material-symbols-outlined text-[14px]">check</span>
                    </button>
                    <div>
                        <p class="text-on-surface font-medium ${t.done ? 'line-through' : ''}">${escapeHtml(t.title)}</p>
                        <p class="text-[11px] text-on-surface-variant">${t.date}${t.note ? ' • ' + escapeHtml(t.note) : ''}</p>
                    </div>
                </div>
                <div class="flex items-center gap-2">
                    <span class="text-[11px] px-2 py-0.5 rounded-full ${t.priority === 'high' ? 'bg-error-container text-on-error-container' : t.priority === 'low' ? 'bg-emerald-success/20 text-emerald-success' : 'bg-warning-amber/20 text-warning-amber'}">${t.priority}</span>
                    <button onclick="deleteTask(${t.id})" class="text-on-surface-variant hover:text-primary">
                        <span class="material-symbols-outlined text-[18px]">delete</span>
                    </button>
                </div>
            </div>`).join('');
    }
}

async function toggleTask(id, done) {
    await api('/api/tasks/toggle', 'POST', { id, done });
    toast(done ? 'Task completed ✓' : 'Task reopened', done ? 'success' : 'info');
    loadTasks();
    loadSummary();
}

async function deleteTask(id) {
    await api('/api/tasks', 'DELETE', { id });
    toast('Task deleted', 'info');
    loadTasks();
    loadSummary();
}

function openTaskModal() {
    MODAL_ACTION = 'task';
    document.getElementById('modal-title').textContent = 'Add Task';
    document.getElementById('modal-body').innerHTML = `
        <input id="f-title" placeholder="Task title" class="w-full bg-surface border border-surface-variant rounded px-3 py-2"/>
        <input id="f-note" placeholder="Note (optional)" class="w-full bg-surface border border-surface-variant rounded px-3 py-2"/>
        <select id="f-priority" class="w-full bg-surface border border-surface-variant rounded px-3 py-2">
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="low">Low</option>
        </select>
        <input id="f-date" type="date" value="${new Date().toISOString().split('T')[0]}" class="w-full bg-surface border border-surface-variant rounded px-3 py-2"/>`;
    document.getElementById('modal-overlay').classList.remove('hidden');
}

// ════════════════════════════════════════════════════════════════
//  CHAT
// ════════════════════════════════════════════════════════════════
function toggleVoice() {
    voiceEnabled = !voiceEnabled;
    const v = voiceEnabled ? 'volume_up' : 'volume_off';
    ['voice-icon', 'desk-voice-icon'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = v;
    });
    if (!voiceEnabled && currentAudio) currentAudio.pause();
}

// ── Mobile chat: render a message ──
function addChatMsg(text, sender, emotion = null) {
    const cont = document.getElementById('chat-messages');
    if (!cont) return;
    const div = document.createElement('div');
    div.className = sender === 'user' ? 'flex justify-end' : 'flex justify-start';
    if (sender === 'user') {
        div.innerHTML = `<div class="bg-primary-container text-on-primary rounded-2xl rounded-tr-sm px-4 py-3 max-w-[80%] shadow-sm">${escapeHtml(text)}</div>`;
    } else {
        const em = emotion ? `<span class="emotion-tag">${escapeHtml(emotion)}</span>` : '';
        div.innerHTML = `<div class="bg-surface-container-lowest border border-surface-variant text-on-surface rounded-2xl rounded-tl-sm px-4 py-3 max-w-[85%] shadow-sm"><p class="inline">${escapeHtml(text)}</p>${em}</div>`;
    }
    cont.appendChild(div);
    cont.scrollTop = cont.scrollHeight;
}

// ── Load 7-day chat history into mobile chat ──
async function loadMobileChatHistory() {
    const cont = document.getElementById('chat-messages');
    if (!cont) return;
    try {
        const history = await api('/api/chat/history');
        if (!history || history.length === 0) {
            // Show welcome if no history
            if (cont.children.length === 0) {
                addChatMsg("কি অবস্থা! ক্লাস ট্লাস করতেছো নাকি ফাকি মারতেছো? কোন হেল্প লাগলে বইলো। 😄", 'assistant', 'happy');
            }
            return;
        }
        // Clear and re-render, stripping backend timestamps from displayed content
        cont.innerHTML = '';
        history.forEach(h => addChatMsg(stripTimestamp(h.content), h.role, h.emotion));
    } catch (e) {
        console.error('Failed to load mobile chat history:', e);
        if (cont.children.length === 0) {
            addChatMsg("কি অবস্থা! ক্লাস ট্লাস করতেছো নাকি ফাকি মারতেছো? কোন হেল্প লাগলে বইলো। 😄", 'assistant', 'happy');
        }
    }
}

// ── Load 7-day chat history into desktop chat ──
async function loadDesktopChatHistory() {
    if (!isDesktopDevice()) return;
    try {
        const history = await api('/api/chat/history');
        if (!history || history.length === 0) return;
        // Remove the empty state card
        const empty = document.getElementById('desk-chat-empty');
        if (empty) empty.remove();
        // Strip backend timestamps before rendering
        history.forEach(h => addDesktopMsg(stripTimestamp(h.content), h.role, h.emotion));
    } catch (e) {
        console.error('Failed to load desktop chat history:', e);
    }
}

function getChatInput() {
    return isDesktopDevice()
        ? document.getElementById('desk-chat-input')
        : document.getElementById('chat-input');
}

// ── Staggered multi-bubble reply renderer ─────────────────────────
// Shows each message in the reply array one-by-one with a typing
// indicator in between, mimicking real texting behaviour.
async function renderStaggeredReply(messages, emotion, isDesktop, ttsText = null) {
    const msgs = Array.isArray(messages)
        ? messages.filter(m => m && String(m).trim())
        : [messages].filter(m => m && String(m).trim());

    if (msgs.length === 0) return;

    for (let i = 0; i < msgs.length; i++) {
        const msg = String(msgs[i]);

        if (i > 0) {
            // Show a typing indicator between bubbles
            if (isDesktop) {
                showDesktopTyping();
            } else {
                const cont = document.getElementById('chat-messages');
                const typDiv = document.createElement('div');
                typDiv.className = 'flex justify-start _mob-typing-temp';
                typDiv.innerHTML = `<div class="bg-surface-container-lowest border border-surface-variant text-secondary rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm flex items-center gap-2"><div class="typing-dots"><span></span><span></span><span></span></div></div>`;
                if (cont) { cont.appendChild(typDiv); cont.scrollTop = cont.scrollHeight; }
            }

            // Delay proportional to message length: 30ms per char, clamped 600–2500ms
            const delay = Math.min(Math.max(msg.length * 30, 600), 2500);
            await new Promise(r => setTimeout(r, delay));

            // Remove mobile typing indicator
            if (!isDesktop) {
                document.querySelectorAll('._mob-typing-temp').forEach(el => el.remove());
            }
        }

        // Render the bubble
        if (isDesktop) {
            hideDesktopTyping();
            addDesktopMsg(msg, 'assistant', emotion);
        } else {
            addChatMsg(msg, 'assistant', emotion);
        }
    }

    // Speak only if we are in Voice Mode
    if (chatMode === 'voice') {
        speakText(ttsText || msgs.join(' '), emotion);
    }

    // Refresh sidebar panel on desktop after all bubbles are done
    if (isDesktop) refreshDesktopPanel();
}

async function sendChat() {
    const input = getChatInput();
    const msg = (input ? input.value : '').trim();
    if (!msg) return;
    const desktop = isDesktopDevice();

    if (desktop) addDesktopMsg(msg, 'user');
    else addChatMsg(msg, 'user');
    if (input) input.value = '';
    if (desktop) autoGrowDeskInput();

    let loadDiv = null;
    if (desktop) {
        showDesktopTyping();
    } else {
        const cont = document.getElementById('chat-messages');
        loadDiv = document.createElement('div');
        loadDiv.className = 'flex justify-start';
        // Animated dots instead of spinner
        loadDiv.innerHTML = `<div class="bg-surface-container-lowest border border-surface-variant text-secondary rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm flex items-center gap-2">
            <div class="typing-dots"><span></span><span></span><span></span></div>
        </div>`;
        if (cont) { cont.appendChild(loadDiv); cont.scrollTop = cont.scrollHeight; }
    }

    try {
        const res = await fetch('/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-User-ID': currentUserId || 'A' },
            body: JSON.stringify({ message: msg })
        });
        const data = await res.json();

        if (data.debug_error) {
            alert("Backend Error: " + data.debug_error);
        }

        // Remove loading indicators before staggered render
        if (loadDiv) loadDiv.remove();
        if (desktop) hideDesktopTyping();
        // Render each reply bubble one-by-one with typing delays
        await renderStaggeredReply(data.reply, data.emotion, desktop, data.tts_text);
    } catch (e) {
        const errMsg = 'Network or server error. Try again in a moment.';
        if (desktop) {
            hideDesktopTyping();
            addDesktopMsg(errMsg, 'assistant');
        } else {
            if (loadDiv) loadDiv.remove();
            addChatMsg(errMsg, 'assistant');
        }
    }
}

function quickAsk(text) {
    const input = getChatInput();
    if (input) {
        input.value = text;
        if (isDesktopDevice()) autoGrowDeskInput();
    }
    sendChat();
}

function clearDesktopChat() {
    const cont = document.getElementById('desk-chat-messages');
    if (!cont) return;
    cont.querySelectorAll('.chat-msg').forEach(el => el.remove());
    hideDesktopTyping();
    // Re-add empty state
    const empty = document.createElement('div');
    empty.id = 'desk-chat-empty';
    empty.className = 'h-full flex flex-col items-center justify-center text-center py-8 animate-fade-in';
    empty.innerHTML = `<span class="material-symbols-outlined text-[40px] text-on-surface-variant/30 mb-3">forum</span>
        <p class="text-on-surface-variant text-[14px]">New conversation started</p>`;
    cont.appendChild(empty);
}

function autoGrowDeskInput() {
    const el = document.getElementById('desk-chat-input');
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}

function addDesktopMsg(text, sender, emotion = null) {
    const cont = document.getElementById('desk-chat-messages');
    if (!cont) return;
    const empty = document.getElementById('desk-chat-empty');
    if (empty) empty.remove();
    hideDesktopTyping();

    const wrap = document.createElement('div');
    wrap.className = 'chat-msg ' + (sender === 'user' ? 'flex justify-end animate-fade-up' : 'flex justify-start animate-fade-up');

    if (sender === 'user') {
        wrap.innerHTML = `<div class="max-w-[80%] bg-gradient-to-br from-primary to-primary-container text-on-primary rounded-2xl rounded-tr-sm px-4 py-3 shadow-md shadow-primary/15">
            <p class="whitespace-pre-wrap leading-relaxed">${escapeHtml(text)}</p>
        </div>`;
    } else {
        const em = emotion ? `<span class="emotion-tag">${escapeHtml(emotion)}</span>` : '';
        wrap.innerHTML = `<div class="max-w-[92%] bg-white border border-outline-variant/60 rounded-2xl rounded-tl-sm px-5 py-4 shadow-sm">
            <div class="flex items-center gap-2 mb-2">
                <span class="w-7 h-7 rounded-full bg-primary-fixed text-on-primary-fixed-variant flex items-center justify-center">
                    <span class="material-symbols-outlined text-[15px]">psychology</span>
                </span>
                <span class="font-label-caps text-label-caps text-on-surface-variant uppercase tracking-widest">EKKU AI</span>${em}
            </div>
            <div class="markdown-body text-body-sm text-on-surface">${renderMarkdown(text)}</div>
        </div>`;
    }
    cont.appendChild(wrap);
    cont.scrollTop = cont.scrollHeight;
}

function showDesktopTyping() {
    const cont = document.getElementById('desk-chat-messages');
    if (!cont || document.getElementById('desk-typing')) return;
    const empty = document.getElementById('desk-chat-empty');
    if (empty) empty.remove();
    const d = document.createElement('div');
    d.id = 'desk-typing';
    d.className = 'chat-msg flex justify-start animate-fade-in';
    d.innerHTML = `<div class="bg-white border border-outline-variant/60 rounded-2xl rounded-tl-sm px-5 py-4 shadow-sm flex items-center gap-3">
        <span class="w-7 h-7 rounded-full bg-primary-fixed text-on-primary-fixed-variant flex items-center justify-center">
            <span class="material-symbols-outlined text-[15px]">psychology</span>
        </span>
        <div class="typing-dots"><span></span><span></span><span></span></div>
        <span class="text-[12px] text-on-surface-variant">Thinking...</span>
    </div>`;
    cont.appendChild(d);
    cont.scrollTop = cont.scrollHeight;
}

function hideDesktopTyping() {
    const t = document.getElementById('desk-typing');
    if (t) t.remove();
}

// ── TTS ──────────────────────────────────────────────────────────
function browserTTSFallback(text) {
    if (!('speechSynthesis' in window)) {
        if (chatMode === 'voice') setVoiceUIState('idle');
        return;
    }
    // Cancel any ongoing speech
    window.speechSynthesis.cancel();

    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'bn-BD'; // Bengali
    utter.rate = 1.0;

    utter.onstart = () => {
        if (chatMode === 'voice') {
            const waves = isDesktopDevice() ? document.getElementById('desk-voice-waves') : document.getElementById('mob-voice-waves');
            if (waves) waves.style.opacity = '1';
        }
    };

    utter.onend = () => {
        if (chatMode === 'voice') setVoiceUIState('idle');
    };

    utter.onerror = (e) => {
        console.error("Browser TTS error:", e);
        if (chatMode === 'voice') setVoiceUIState('idle');
    };

    window.speechSynthesis.speak(utter);
}

async function speakText(text, emotion = "neutral") {
    if (!voiceEnabled) return;
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
    window.speechSynthesis.cancel(); // Stop any browser TTS playing

    try {
        const res = await fetch('/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, emotion })
        });
        const data = await res.json();
        if (data.audio) {
            currentAudio = new Audio('data:audio/mp3;base64,' + data.audio);

            // Animation handling for Voice Mode
            currentAudio.onplay = () => {
                if (chatMode === 'voice') {
                    const waves = isDesktopDevice() ? document.getElementById('desk-voice-waves') : document.getElementById('mob-voice-waves');
                    if (waves) waves.style.opacity = '1';
                }
            };
            currentAudio.onended = () => {
                if (chatMode === 'voice') {
                    setVoiceUIState('idle');
                }
            };

            // Mobile Chrome requires handling potential autoplay rejection
            const playPromise = currentAudio.play();
            if (playPromise !== undefined) {
                playPromise.catch(err => {
                    console.warn('Audio autoplay blocked (mobile):', err);
                    // Fall back to browser TTS which may work better on mobile
                    browserTTSFallback(text);
                    if (chatMode === 'voice') setVoiceUIState('idle');
                });
            }
        } else {
            console.warn("Server TTS failed (rate limit/blocked), falling back to browser TTS", data.error || '');
            browserTTSFallback(text);
        }
    } catch (e) {
        console.warn("Server TTS network error, falling back to browser TTS", e);
        browserTTSFallback(text);
    }
}

// ── Unified Mic Recorder (MediaRecorder -> Groq Whisper) ──
async function startRecording(mode) {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
        return;
    }
    
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        toast('Microphone not supported in this browser', 'error');
        return;
    }
    
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];
        voiceModeActive = (mode === 'voice');
        
        if (voiceModeActive) {
            setVoiceUIState('listening');
            if (currentAudio) { currentAudio.pause(); currentAudio = null; }
        } else {
            ['mic-icon','desk-mic-icon'].forEach(id => { const el = document.getElementById(id); if (el) { el.textContent = 'stop_circle'; el.classList.add('text-red-500'); } });
        }
        
        mediaRecorder.addEventListener("dataavailable", event => {
            if (event.data.size > 0) audioChunks.push(event.data);
        });
        
        mediaRecorder.addEventListener("stop", async () => {
            stream.getTracks().forEach(track => track.stop()); // release mic
            
            const isVoice = voiceModeActive;
            mediaRecorder = null;
            
            if (audioChunks.length === 0) {
                if (isVoice) setVoiceUIState('idle');
                else {
                    ['mic-icon','desk-mic-icon'].forEach(id => { const el = document.getElementById(id); if (el) { el.textContent = 'mic'; el.classList.remove('text-red-500'); } });
                }
                return;
            }
            
            if (isVoice) setVoiceUIState('thinking');
            else {
                ['mic-icon','desk-mic-icon'].forEach(id => { const el = document.getElementById(id); if (el) { el.textContent = 'mic'; el.classList.remove('text-red-500'); } });
                if (isDesktopDevice()) showDesktopTyping();
            }
            
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            const formData = new FormData();
            formData.append('audio', audioBlob, 'voice.webm');
            
            try {
                const response = await fetch('/voice', { method: 'POST', body: formData });
                const data = await response.json();
                
                if (!response.ok || data.error) throw new Error(data.error || 'API Error');
                
                if (data.text) {
                    if (isVoice) {
                        sendVoiceChat(data.text);
                    } else {
                        if (isDesktopDevice()) hideDesktopTyping();
                        const input = getChatInput();
                        if (input) { 
                            input.value = data.text; 
                            input.dispatchEvent(new Event('input')); 
                        }
                        if (isDesktopDevice()) autoGrowDeskInput();
                    }
                } else {
                    if (isVoice) setVoiceUIState('idle');
                }
            } catch (e) {
                console.warn('Voice API error:', e);
                toast('Could not understand audio.', 'error');
                if (isVoice) setVoiceUIState('idle');
                if (!isVoice && isDesktopDevice()) hideDesktopTyping();
            }
        });
        
        mediaRecorder.start();
        
    } catch (err) {
        console.warn("getUserMedia error:", err);
        toast(`Mic Error: ${err.name} - ${err.message}`, 'error');
    }
}

function toggleMic() {
    startRecording('text');
}

function startVoiceInteraction() {
    startRecording('voice');
}

function setVoiceUIState(state) {
    const isDesktop = isDesktopDevice();
    const btn = isDesktop ? document.getElementById('desk-voice-btn') : document.getElementById('mob-voice-btn');
    const status = isDesktop ? document.getElementById('desk-voice-status') : document.getElementById('mob-voice-status');
    const waves = isDesktop ? document.getElementById('desk-voice-waves') : document.getElementById('mob-voice-waves');

    if (!btn) return;

    if (state === 'idle') {
        btn.innerHTML = `<span class="material-symbols-outlined ${isDesktop ? 'text-[52px]' : 'text-[56px] drop-shadow-md'}">mic</span>`;
        btn.classList.remove('animate-pulse');
        status.textContent = "Tap to speak";
        if (waves) waves.style.opacity = '0';
    } else if (state === 'listening') {
        btn.innerHTML = `<span class="material-symbols-outlined ${isDesktop ? 'text-[52px]' : 'text-[56px] drop-shadow-md'}">mic</span>`;
        btn.classList.add('animate-pulse');
        status.textContent = "Listening...";
        if (waves) waves.style.opacity = '1'; // Show glow
    } else if (state === 'thinking') {
        btn.innerHTML = `<div class="typing-dots"><span class="bg-white"></span><span class="bg-white"></span><span class="bg-white"></span></div>`;
        btn.classList.remove('animate-pulse');
        status.textContent = "Thinking...";
        if (waves) waves.style.opacity = '1';
    } else if (state === 'speaking') {
        btn.innerHTML = `<span class="material-symbols-outlined ${isDesktop ? 'text-[52px]' : 'text-[56px] drop-shadow-md'}">smart_toy</span>`;
        btn.classList.remove('animate-pulse');
        status.textContent = "Ekku is speaking";
        // Waves opacity is handled in currentAudio.onplay
    }
}

let voiceModeRecognition = null;
let _voiceGotResult = false;
let _voiceSafetyTimer = null;

function _clearVoiceSafetyTimer() {
    if (_voiceSafetyTimer) { clearTimeout(_voiceSafetyTimer); _voiceSafetyTimer = null; }
}

function _abortVoice() {
    if (voiceModeRecognition) {
        try { voiceModeRecognition.abort(); } catch(e) {}
        voiceModeRecognition = null;
    }
}

function startVoiceInteraction() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast('Voice input not supported in this browser', 'error'); return; }

    // HTTPS check — microphone requires secure context (handles https://, localhost, 127.0.0.1, and Render)
    if (!window.isSecureContext) {
        toast('Microphone requires HTTPS', 'error'); return;
    }

    // Toggle: if already listening, STOP and force reset
    if (voiceModeRecognition) {
        _clearVoiceSafetyTimer();
        try { voiceModeRecognition.stop(); } catch(e) {}
        
        // Force reset UI immediately so it doesn't get stuck if the browser glitches
        if (voiceModeRecognition === rec) {
            try { rec.abort(); } catch(e) {}
            voiceModeRecognition = null;
        }
        _voiceGotResult = false;
        setVoiceUIState('idle');
        return;
    }

    _voiceGotResult = false;
    const rec = new SR();
    rec.lang = 'bn-BD';
    rec.interimResults = true; // KEY FIX: Mobile browsers need this to stay alive
    rec.continuous = false;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
        if (currentAudio) { currentAudio.pause(); currentAudio = null; }
        setVoiceUIState('listening');
        // Safety net: mobile Chrome sometimes never fires onend
        _voiceSafetyTimer = setTimeout(() => {
            if (voiceModeRecognition === rec) {
                console.warn('[Voice] Safety timeout — forcing stop to capture results');
                try { rec.stop(); } catch(e) {}
                
                // Fallback abort if stop() hangs
                setTimeout(() => {
                    if (voiceModeRecognition === rec) {
                         try { rec.abort(); } catch(e) {}
                         voiceModeRecognition = null;
                         setVoiceUIState('idle');
                    }
                }, 2000);
            }
        }, 9000);
    };

    rec.onspeechend = () => {
        try { rec.stop(); } catch(e) {}
    };

    rec.onresult = (event) => {
        let finalTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
                finalTranscript += event.results[i][0].transcript;
            }
        }
        
        if (!finalTranscript) return; // ignore interim text for now
        
        if (_voiceGotResult) return; 
        _voiceGotResult = true;
        _clearVoiceSafetyTimer();
        
        const transcript = finalTranscript.trim();
        
        if (voiceModeRecognition === rec) {
            try { rec.abort(); } catch(e) {}
            voiceModeRecognition = null;
        }
        
        if (transcript) {
            sendVoiceChat(transcript);
        } else {
            _voiceGotResult = false;
            setVoiceUIState('idle');
        }
    };

    rec.onerror = (e) => {
        if (_voiceGotResult) return;
        _clearVoiceSafetyTimer();
        if (voiceModeRecognition === rec) voiceModeRecognition = null;
        console.warn('[Voice] Recognition error:', e.error);
        
        if (e.error === 'not-allowed') toast('Microphone permission denied! Check browser settings.', 'error');
        else if (e.error === 'network') toast('Network error! Check connection.', 'error');
        else if (e.error !== 'no-speech' && e.error !== 'aborted') toast('Mic error: ' + e.error, 'error');
        
        _voiceGotResult = false;
        setVoiceUIState('idle');
    };

    rec.onend = () => {
        _clearVoiceSafetyTimer();
        if (voiceModeRecognition === rec) voiceModeRecognition = null;
        if (!_voiceGotResult) {
            setVoiceUIState('idle');
        }
        _voiceGotResult = false; 
    };

    voiceModeRecognition = rec;
    try {
        rec.start();
    } catch (err) {
        console.warn('[Voice] start() failed:', err);
        voiceModeRecognition = null;
        _voiceGotResult = false;
        setVoiceUIState('idle');
    }
}

async function sendVoiceChat(msg) {
    setVoiceUIState('thinking');
    try {
        const res = await fetch('/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-User-ID': currentUserId || 'A' },
            body: JSON.stringify({ message: msg })
        });
        const data = await res.json();

        // Ensure UI switches to speaking
        setVoiceUIState('speaking');

        // Speak the reply, preferring the optimized tts_text
        const msgs = Array.isArray(data.reply) ? data.reply : [data.reply];
        const fullText = msgs.filter(m => m && String(m).trim()).join(' ');

        speakText(data.tts_text || fullText, data.emotion);

        // Note: the backend automatically saves the conversation. 
        // When we switch back to Text mode, a reload/fetch will show it.
    } catch (e) {
        toast('Network error. Try again.', 'error');
        setVoiceUIState('idle');
    }
}

// ── Markdown ─────────────────────────────────────────────────────
function copyCode(btn) {
    const code = btn.closest('.code-block').querySelector('code').innerText;
    navigator.clipboard.writeText(code).then(() => {
        btn.innerHTML = `<span class="material-symbols-outlined text-[13px]">check</span> Copied`;
        setTimeout(() => { btn.innerHTML = `<span class="material-symbols-outlined text-[13px]">content_copy</span> Copy`; }, 1500);
    }).catch(() => { });
}

function renderMarkdown(src) {
    let text = escapeHtml(String(src || '')).replace(/\r\n/g, '\n');
    const blocks = [];
    text = text.replace(/```([\w+-]*)\n?([^`]*?)```/g, (m, lang, code) => {
        blocks.push(`<div class="code-block relative my-3 rounded-xl overflow-hidden">
            <div class="flex items-center justify-between px-4 py-2 bg-white/5 border-b border-white/10">
                <span class="text-[10px] font-semibold uppercase tracking-widest opacity-70">${lang || 'code'}</span>
                <button onclick="copyCode(this)" class="text-[10px] flex items-center gap-1 opacity-60 hover:opacity-100 transition-opacity" style="color:#f2f0f0">
                    <span class="material-symbols-outlined text-[13px]">content_copy</span> Copy
                </button>
            </div>
            <pre class="p-4 overflow-x-auto text-[13px] leading-relaxed"><code>${code}</code></pre>
        </div>`);
        return '\u0000BLOCK\u0000';
    });
    text = text.replace(/^\s*([-*_])\1{2,}\s*$/gm, '\u0000HR\u0000');

    const inline = s => s
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="text-primary underline">$1</a>');

    const lines = text.split('\n');
    let html = '', para = [], listType = null;
    const flushPara = () => { if (para.length) { html += '<p>' + inline(para.join(' ')) + '</p>'; para = []; } };
    const flushList = () => { if (listType) { html += '</' + listType + '>'; listType = null; } };

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) { flushPara(); flushList(); continue; }
        if (line === '\u0000BLOCK\u0000') { flushPara(); flushList(); html += blocks.shift(); continue; }
        if (line === '\u0000HR\u0000') { flushPara(); flushList(); html += '<hr/>'; continue; }
        const h = line.match(/^(#{1,4})\s+(.*)$/);
        if (h) {
            flushPara(); flushList();
            const lv = h[1].length;
            const cls = lv === 1 ? 'text-lg font-bold mt-4 mb-2' : lv === 2 ? 'text-base font-bold mt-3 mb-2' : 'text-sm font-semibold mt-2 mb-1';
            html += '<h' + lv + ' class="' + cls + ' text-on-surface">' + inline(h[2]) + '</h' + lv + '>';
            continue;
        }
        const bq = line.match(/^&gt;\s?(.*)$/);
        if (bq) { flushPara(); flushList(); html += '<blockquote>' + inline(bq[1]) + '</blockquote>'; continue; }
        const ul = line.match(/^[-*]\s+(.*)$/);
        if (ul) {
            flushPara();
            if (listType !== 'ul') { flushList(); listType = 'ul'; html += '<ul>'; }
            html += '<li>' + inline(ul[1]) + '</li>';
            continue;
        }
        const ol = line.match(/^\d+\.\s+(.*)$/);
        if (ol) {
            flushPara();
            if (listType !== 'ol') { flushList(); listType = 'ol'; html += '<ol>'; }
            html += '<li>' + inline(ol[1]) + '</li>';
            continue;
        }
        para.push(line);
    }
    flushPara(); flushList();
    return html || '<p>' + text + '</p>';
}

// ════════════════════════════════════════════════════════════════
//  DESKTOP CHAT PANEL
// ════════════════════════════════════════════════════════════════
async function loadDesktopChatPanel() {
    if (!isDesktopDevice()) return;
    try {
        const data = await api('/api/summary');
        renderPanelSchedule(data.today_routine || [], data.today);
        renderPanelSuggestions(data);
    } catch (e) { console.error('Panel failed', e); }
    try {
        const history = await api('/api/chat/history');
        renderPanelRecent(history);
    } catch (e) { }
}

function refreshDesktopPanel() { loadDesktopChatPanel(); }

function renderPanelSchedule(classes) {
    const cont = document.getElementById('desk-panel-schedule');
    if (!cont) return;
    if (!classes || classes.length === 0) {
        cont.innerHTML = `<div class="flex flex-col items-center text-center py-6">
            <span class="material-symbols-outlined text-[28px] text-emerald-success">event_available</span>
            <p class="text-[13px] font-semibold text-on-surface mt-2">No classes today</p>
            <p class="text-[11px] text-on-surface-variant mt-1">Good day to catch up on tasks.</p>
        </div>`;
        return;
    }
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    classes.forEach(c => {
        const m = String(c.time || '').match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
        let mins = 0;
        if (m) {
            let h = parseInt(m[1], 10);
            const ap = (m[3] || '').toUpperCase();
            if (ap === 'PM' && h < 12) h += 12;
            if (ap === 'AM' && h === 12) h = 0;
            mins = h * 60 + parseInt(m[2], 10);
        }
        c._mins = mins;
    });
    classes = classes.slice().sort((a, b) => a._mins - b._mins);
    let nextIdx = -1;
    for (let i = 0; i < classes.length; i++) { if (classes[i]._mins >= nowMin) { nextIdx = i; break; } }
    cont.innerHTML = classes.map((c, i) => {
        const isNext = i === nextIdx;
        const isPast = c._mins < nowMin;
        return `<div class="flex items-center gap-3 py-2 px-2 rounded-lg ${isNext ? 'bg-primary-fixed/50' : 'hover:bg-surface-container-low'} transition-colors">
            <div class="w-12 shrink-0 text-[11px] font-semibold text-on-surface-variant">${escapeHtml(c.time)}</div>
            <div class="w-1 h-8 rounded-full ${isNext ? 'bg-primary' : isPast ? 'bg-surface-variant' : 'bg-emerald-success/60'}"></div>
            <div class="flex-1 min-w-0">
                <p class="text-[12px] font-medium text-on-surface truncate ${isNext ? 'text-primary' : ''}">${escapeHtml(c.course)}</p>
                <p class="text-[10px] text-on-surface-variant">${escapeHtml(c.room || '')}</p>
            </div>
            ${isNext ? '<span class="text-[9px] px-1.5 py-0.5 rounded-full bg-primary text-on-primary shrink-0">NEXT</span>' : isPast ? '<span class="text-[9px] text-on-surface-variant shrink-0">done</span>' : ''}
        </div>`;
    }).join('');
}

function renderPanelSuggestions(data) {
    const cont = document.getElementById('desk-panel-suggestions');
    if (!cont) return;
    const items = [];
    if ((data.att_percent || 0) < 75) items.push({ icon: 'warning', label: 'Attendance below 75%', ask: 'My attendance is low. How do I improve it?' });
    if (data.pending_tasks > 0) items.push({ icon: 'task_alt', label: data.pending_tasks + ' task(s) pending', ask: 'Help me plan my pending tasks for today.' });
    if ((data.balance || 0) < 0) items.push({ icon: 'savings', label: 'Budget is in the red', ask: 'My budget is negative. Help me plan my spending.' });
    if ((data.today_routine || []).length === 0) items.push({ icon: 'today', label: 'No classes today', ask: 'I have a free day. Suggest a balanced plan to study and rest.' });
    items.push({ icon: 'school', label: 'Study tips & tricks', ask: 'Give me the best study techniques that actually work for university students.' });
    items.push({ icon: 'psychology', label: 'Manage exam stress', ask: 'I feel stressed about exams. How can I manage it?' });
    items.push({ icon: 'favorite', label: 'A little motivation', ask: 'I need some motivation to get things done. Give me a boost.' });
    cont.innerHTML = items.slice(0, 4).map((it, i) => `
        <button onclick="quickAsk('${it.ask.replace(/'/g, "\\'")}')\" class="w-full flex items-center gap-3 p-2.5 rounded-xl border border-outline-variant/60 bg-white text-left hover:border-primary hover:-translate-y-0.5 transition-all duration-200">
            <span class="w-8 h-8 rounded-lg ${i % 2 === 0 ? 'bg-primary-fixed text-on-primary-fixed-variant' : 'bg-emerald-success/15 text-emerald-success'} flex items-center justify-center shrink-0">
                <span class="material-symbols-outlined text-[16px]">${it.icon}</span>
            </span>
            <span class="text-[12px] font-medium text-on-surface leading-tight">${escapeHtml(it.label)}</span>
        </button>`).join('');
}

async function renderPanelRecent(history) {
    const cont = document.getElementById('desk-panel-recent');
    if (!cont) return;
    if (!history || history.length === 0) {
        cont.innerHTML = `<div class="text-[12px] text-on-surface-variant py-2 flex items-center gap-2">
            <span class="material-symbols-outlined text-[16px]">forum</span> No history yet. Start chatting!
        </div>`;
        return;
    }
    const recent = history.filter(h => h.role === 'user').slice(-6).reverse();
    cont.innerHTML = recent.map(h => {
        const ask = String(h.content || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;').slice(0, 120);
        return `<button onclick="quickAsk('${ask}')" class="w-full text-left p-2.5 rounded-xl hover:bg-surface-container-low transition-colors flex items-center gap-2">
            <span class="material-symbols-outlined text-[14px] text-on-surface-variant shrink-0">history</span>
            <span class="text-[12px] text-on-surface truncate">${escapeHtml(h.content).slice(0, 70)}</span>
        </button>`;
    }).join('');
}

// ── Desktop textarea auto-send on Enter ──────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const ta = document.getElementById('desk-chat-input');
    if (ta) {
        ta.addEventListener('input', autoGrowDeskInput);
        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendChat();
            }
        });
    }
    // Mobile chat-input: send on Enter
    const mi = document.getElementById('chat-input');
    if (mi) {
        mi.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
        });
    }
});

// ════════════════════════════════════════════════════════════════
//  SETTINGS - USER LIST
// ════════════════════════════════════════════════════════════════
async function loadSettingsUserList() {
    const cont = document.getElementById('settings-user-list');
    if (!cont) return;
    try {
        const users = await fetch('/api/users').then(r => r.json());
        cont.innerHTML = users.map(u => `
            <div class="flex items-center gap-3 p-3 rounded-xl border border-surface-variant bg-surface-container-low ${u.id === currentUserId ? 'border-primary bg-primary-fixed/20' : ''}">
                <div class="w-9 h-9 rounded-full flex items-center justify-center text-white font-bold" style="background:${u.color}">${u.name[0]}</div>
                <div class="flex-1">
                    <p class="font-medium text-on-surface text-sm">${escapeHtml(u.name)}</p>
                    <p class="text-[11px] text-on-surface-variant">${u.has_pin ? '🔒 Secured with PIN' : '⚠️ No PIN set'} ${u.id === currentUserId ? '· Currently active' : ''}</p>
                </div>
                <span class="text-[11px] px-2 py-0.5 rounded-full font-semibold ${u.id === currentUserId ? 'bg-primary text-on-primary' : 'bg-surface-variant text-on-surface-variant'}">User ${u.id}</span>
            </div>`).join('');
    } catch (e) { }
}

// ════════════════════════════════════════════════════════════════
//  MODAL
// ════════════════════════════════════════════════════════════════
function closeModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
    MODAL_ACTION = null;
}

async function modalSave() {
    const action = MODAL_ACTION;
    const g = id => (document.getElementById(id) || {}).value?.trim() || '';

    if (action === 'routine') {
        if (!g('f-course')) { alert('Course name required'); return; }
        const timeVal = g('f-time');
        let displayTime = timeVal;
        if (timeVal && timeVal.includes(':')) {
            const [hh, mm] = timeVal.split(':');
            let h = parseInt(hh, 10);
            const ampm = h >= 12 ? 'PM' : 'AM';
            if (h > 12) h -= 12;
            if (h === 0) h = 12;
            displayTime = `${h}:${mm} ${ampm}`;
        }
        await api('/api/routine', 'POST', {
            day: document.getElementById('f-day').value, time: displayTime,
            course: g('f-course'), room: g('f-room'), prof: g('f-prof'), color: selectedColor
        });
        loadRoutine();
    } else if (action === 'attendance') {
        if (!g('f-course')) { alert('Course name required'); return; }
        await api('/api/attendance', 'POST', {
            course: g('f-course'),
            total: parseInt(document.getElementById('f-total').value) || 0,
            present: parseInt(document.getElementById('f-present').value) || 0
        });
        loadAttendance();
    } else if (action === 'budget') {
        if (!g('f-desc')) { alert('Description required'); return; }
        await api('/api/budget', 'POST', {
            type: document.getElementById('f-type').value,
            desc: g('f-desc'),
            amount: parseFloat(document.getElementById('f-amount').value) || 0,
            date: document.getElementById('f-date').value
        });
        loadBudget();
    } else if (action === 'grade') {
        if (!g('f-course')) { alert('Course name required'); return; }
        await api('/api/cgpa', 'POST', {
            course: g('f-course'),
            credit: parseFloat(document.getElementById('f-credit').value) || 3,
            grade: parseFloat(document.getElementById('f-grade').value) || 0
        });
        loadCGPA();
    } else if (action === 'plan') {
        if (!g('f-title')) { alert('Task title required'); return; }
        await api('/api/plans', 'POST', {
            day: document.getElementById('f-day').value,
            duration: g('f-duration'),
            title: g('f-title')
        });
        loadPlans();
    } else if (action === 'task') {
        if (!g('f-title')) { alert('Task title required'); return; }
        await api('/api/tasks', 'POST', {
            title: g('f-title'), note: g('f-note'),
            priority: document.getElementById('f-priority').value,
            date: document.getElementById('f-date').value
        });
        loadTasks();
    }
    closeModal();
    loadSummary();
    toast('Saved successfully', 'success');
}

// ════════════════════════════════════════════════════════════════
//  COMMAND PALETTE
// ════════════════════════════════════════════════════════════════
let cmdIndex = 0;

const COMMANDS = [
    {
        group: 'Navigate', items: [
            { icon: 'dashboard', label: 'Dashboard', hint: 'Go to dashboard', run: () => showView('dashboard') },
            { icon: 'calendar_month', label: 'Routine', hint: 'Go to routine', run: () => showView('routine') },
            { icon: 'how_to_reg', label: 'Attendance', hint: 'Go to attendance', run: () => showView('attendance') },
            { icon: 'payments', label: 'Budget', hint: 'Go to budget', run: () => showView('budget') },
            { icon: 'school', label: 'CGPA', hint: 'Go to CGPA predictor', run: () => showView('cgpa') },
            { icon: 'task_alt', label: 'Tasks', hint: 'Go to tasks', run: () => showView('tasks') },
            { icon: 'smart_toy', label: 'AI Friend (Ekku)', hint: 'Chat with your friend', run: () => showView('chat') },
            { icon: 'settings', label: 'Settings', hint: 'Go to settings', run: () => showView('settings') },
        ]
    },
    {
        group: 'Quick actions', items: [
            { icon: 'add_task', label: 'Add a task', hint: 'Create a new task', run: () => openTaskModal() },
            { icon: 'event_note', label: 'Add a class', hint: 'Add to routine', run: () => openRoutineModal() },
            { icon: 'account_balance_wallet', label: 'Add budget entry', hint: 'Log income or expense', run: () => openBudgetModal() },
            { icon: 'school', label: 'Add course grade', hint: 'Track a grade for CGPA', run: () => openGradeModal() },
            { icon: 'how_to_reg', label: 'Add attendance course', hint: 'Start tracking a course', run: () => openAttModal() },
            { icon: 'delete_sweep', label: 'New AI conversation', hint: 'Clear current chat', run: () => clearDesktopChat() },
            { icon: 'sync', label: 'Refresh dashboard', hint: 'Reload all data', run: () => loadSummary() },
            { icon: 'volume_up', label: 'Toggle voice replies', hint: 'On / Off', run: () => toggleVoice() },
            { icon: 'swap_horiz', label: 'Switch user', hint: 'Log out and select another user', run: () => switchUser() },
        ]
    },
    {
        group: 'Ask Ekku', items: [
            { icon: 'today', label: 'Daily check-in', hint: 'How is your day going?', run: () => quickAsk('How is my day going? Give me a quick, honest check-in.') },
            { icon: 'event_available', label: 'Plan my day', hint: 'Sort routine & tasks', run: () => quickAsk('Help me plan my day based on my routine and tasks.') },
            { icon: 'favorite', label: 'Cheer me up', hint: 'Support for rough days', run: () => quickAsk('I am feeling a bit down today. Cheer me up and give me some support.') },
            { icon: 'flag', label: 'Keep me on track', hint: 'Attendance, tasks, budget', run: () => quickAsk('Help me stay on track with attendance, tasks and budget. What should I focus on?') },
            { icon: 'bolt', label: 'Motivate me', hint: 'Get things done', run: () => quickAsk('I need some motivation to get things done. Give me a boost.') },
        ]
    },
];

function openCommandPalette() {
    const overlay = document.getElementById('cmd-overlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    cmdIndex = 0;
    const input = document.getElementById('cmd-input');
    if (input) { input.value = ''; renderCommands(); setTimeout(() => input.focus(), 30); }
}

function closeCommandPalette() {
    const overlay = document.getElementById('cmd-overlay');
    if (overlay) overlay.classList.add('hidden');
}

function renderCommands() {
    const q = (document.getElementById('cmd-input') || {}).value || '';
    const list = document.getElementById('cmd-list');
    if (!list) return;
    const ql = q.toLowerCase().trim();
    const all = [];
    COMMANDS.forEach(g => {
        g.items.forEach(it => {
            if (!ql || (it.label + ' ' + it.hint).toLowerCase().includes(ql)) all.push({ ...it, group: g.group });
        });
    });
    cmdIndex = Math.min(cmdIndex, all.length - 1);
    if (all.length === 0) {
        list.innerHTML = `<div class="flex flex-col items-center py-10 text-center">
            <span class="material-symbols-outlined text-[32px] text-on-surface-variant">search_off</span>
            <p class="text-body-sm text-on-surface-variant mt-2">No commands found for "${escapeHtml(q)}"</p>
        </div>`;
        return;
    }
    let html = '', lastGroup = '';
    all.forEach((it, i) => {
        if (it.group !== lastGroup) {
            lastGroup = it.group;
            html += `<div class="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant">${it.group}</div>`;
        }
        html += `<button onclick="runCmd(${i}, this)" data-idx="${i}" class="cmd-item w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors ${i === cmdIndex ? 'bg-primary-fixed text-on-primary-fixed-variant' : 'text-on-surface hover:bg-surface-container-low'}">
            <span class="material-symbols-outlined text-[18px] ${i === cmdIndex ? 'text-primary' : 'text-on-surface-variant'}">${it.icon}</span>
            <span class="flex-1">
                <span class="block text-body-sm font-medium">${escapeHtml(it.label)}</span>
                ${it.hint ? `<span class="block text-[11px] text-on-surface-variant">${escapeHtml(it.hint)}</span>` : ''}
            </span>
            <span class="material-symbols-outlined text-[14px] ${i === cmdIndex ? 'opacity-60' : 'opacity-0'}">north_west</span>
        </button>`;
    });
    list.innerHTML = html;
}

function runCmd(i, el) {
    const list = document.getElementById('cmd-list');
    if (!list) return;
    const q = (document.getElementById('cmd-input') || {}).value || '';
    const ql = q.toLowerCase().trim();
    const all = [];
    COMMANDS.forEach(g => g.items.forEach(it => {
        if (!ql || (it.label + ' ' + it.hint).toLowerCase().includes(ql)) all.push({ ...it, group: g.group });
    }));
    const cmd = all[i];
    if (cmd) { closeCommandPalette(); cmd.run(); }
}

function cmdMove(delta) {
    const items = document.querySelectorAll('#cmd-list .cmd-item');
    if (items.length === 0) return;
    cmdIndex = (cmdIndex + delta + items.length) % items.length;
    items.forEach((el, i) => {
        el.classList.toggle('bg-primary-fixed', i === cmdIndex);
        el.classList.toggle('text-on-primary-fixed-variant', i === cmdIndex);
        el.classList.toggle('text-on-surface', i !== cmdIndex);
        el.querySelector('span.material-symbols-outlined')?.classList.toggle('text-primary', i === cmdIndex);
        el.querySelector('span.material-symbols-outlined')?.classList.toggle('text-on-surface-variant', i !== cmdIndex);
        const arrow = el.querySelector('span:last-child');
        if (arrow) arrow.classList.toggle('opacity-60', i === cmdIndex);
    });
    items[cmdIndex]?.scrollIntoView({ block: 'nearest' });
}

// Global keyboard shortcuts (only when app is visible)
function handleGlobalKeydown(e) {
    const cmdOverlay = document.getElementById('cmd-overlay');
    const cmdOpen = cmdOverlay && !cmdOverlay.classList.contains('hidden');

    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        if (cmdOpen) closeCommandPalette(); else openCommandPalette();
        return;
    }
    if (e.key === 'Escape') {
        if (cmdOpen) { closeCommandPalette(); return; }
        const modal = document.getElementById('modal-overlay');
        if (modal && !modal.classList.contains('hidden')) { closeModal(); return; }
    }
    if (cmdOpen) {
        const input = document.getElementById('cmd-input');
        if (e.key === 'ArrowDown') { e.preventDefault(); cmdMove(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); cmdMove(-1); }
        else if (e.key === 'Enter' && document.activeElement === input) {
            e.preventDefault();
            const items = document.querySelectorAll('#cmd-list .cmd-item');
            if (items.length > 0) runCmd(cmdIndex, items[cmdIndex]);
        }
        return;
    }
    if (e.ctrlKey && e.key >= '1' && e.key <= '8') {
        e.preventDefault();
        const views = ['dashboard', 'routine', 'attendance', 'budget', 'cgpa', 'tasks', 'chat', 'settings'];
        showView(views[parseInt(e.key) - 1]);
    }
}

// Click outside closes palette / modal
document.addEventListener('click', (e) => {
    const overlay = document.getElementById('cmd-overlay');
    if (overlay && !overlay.classList.contains('hidden') && e.target === overlay) closeCommandPalette();
});

const cmdInput = document.getElementById('cmd-input');
if (cmdInput) {
    cmdInput.addEventListener('input', () => { cmdIndex = 0; renderCommands(); });
}

// ════════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
    initUserSelect();
});
