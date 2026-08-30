// ╔══════════════════════════════════════════════════════════════╗
// ║  EKKHU — Smart Academic OS (Mobile Luxe & Next-Gen Engine)   ║
// ╚══════════════════════════════════════════════════════════════╝

// ─── Global State ────────────────────────────────────────────────
let currentUserId = null;       // Active user id (e.g. A-E)
let currentUserData = null;     // { id, name, color }
let voiceEnabled = true;
let MODAL_ACTION = null;
let selectedColor = '#e11d48';
let currentAudio = null;
let chatMode = 'text';          // 'text' | 'voice'
let currentTheme = 'light';     // 'light' | 'dark'
let currentPalette = 'crimson'; // 'crimson' | 'sakura' | 'cyan' | 'matcha'

// PIN System State
let pinBuffer = '';
let pinMode = 'login';          // 'login' | 'setup'
let pendingUser = null;

// Routine Day Filter State
let activeRoutineDay = 'TODAY'; // 'TODAY' | 'Sun' | 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'ALL'

// Voice & Mic State
let mediaRecorder = null;
let audioChunks = [];
let voiceModeActive = false;
let recordingStartTime = 0;

// ─── Pomodoro Focus Engine State ────────────────────────────────
let pomoTimer = null;
let pomoMode = 'focus';         // 'focus' (25m) | 'custom' | 'stopwatch' | 'short' (5m) | 'long' (15m)
let pomoSecondsLeft = 25 * 60;
let pomoStopwatchSeconds = 0;   // Count-up seconds for stopwatch mode
let pomoCustomMinutes = 30;     // Custom timer minutes
let pomoIsRunning = false;
// Multi-cycle extras
let pomoCycles = 1;             // 1 | 2 | 3
let pomoCyclesDone = 0;         // cycles completed this session
let pomoTaskLabel = '';         // what user is working on
let pomoSessionStart = null;    // Date when session started

// Soft Repeating Alarm State
let softAlarmInterval = null;
let isSoftAlarmActive = false;

// Web Audio Ambient Synthesizer
let audioCtx = null;
let ambientSource = null;
let ambientGain = null;
let currentAmbientType = 'off'; // 'rain' | 'whitenoise' | 'off'

// Dynamic Island State
let isIslandExpanded = false;

// ─── Utility Helpers ─────────────────────────────────────────────
function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function sanitizeChatMessage(content) {
    if (!content) return '';
    let str = String(content).trim();
    // If raw JSON string was passed e.g. {"reply": [...], "emotion": ...}
    if (str.startsWith('{') && str.includes('"reply"')) {
        try {
            const parsed = JSON.parse(str);
            if (parsed.reply) {
                str = Array.isArray(parsed.reply) ? parsed.reply.join(' ') : String(parsed.reply);
            }
        } catch(e) {
            const m = str.match(/"reply"\s*:\s*\[([^\]]*)\]/);
            if (m) {
                const items = m[1].match(/"([^"\\]*(?:\\.[^"\\]*)*)"/g);
                if (items) {
                    str = items.map(s => s.replace(/^"|"$/g, '')).join(' ');
                }
            }
        }
    }
    // Unescape raw unicode literals like \u09a1 -> ডা
    if (str.includes('\\u')) {
        try {
            str = str.replace(/\\u([0-9a-fA-F]{4})/g, (m, c) => String.fromCharCode(parseInt(c, 16)));
        } catch(e) {}
    }
    // Strip all stacked timestamps
    str = str.replace(/^(\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*)+/g, '').trim();
    return str;
}

function stripTimestamp(content) {
    return sanitizeChatMessage(content);
}

function isDesktopDevice() {
    return window.innerWidth >= 768;
}

// ─── Web Audio Micro-Haptic Click Generator ──────────────────────
function playHaptic(type = 'tap') {
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();

        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();

        if (type === 'tap') {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(440, audioCtx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(120, audioCtx.currentTime + 0.04);
            gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.04);
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start();
            osc.stop(audioCtx.currentTime + 0.04);
        } else if (type === 'pop') {
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(600, audioCtx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(900, audioCtx.currentTime + 0.06);
            gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.06);
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start();
            osc.stop(audioCtx.currentTime + 0.06);
        } else if (type === 'success') {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(523.25, audioCtx.currentTime);
            osc.frequency.setValueAtTime(659.25, audioCtx.currentTime + 0.08);
            gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2);
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start();
            osc.stop(audioCtx.currentTime + 0.2);
        }
    } catch (e) { }

    if (navigator.vibrate) {
        if (type === 'tap') navigator.vibrate(10);
        else if (type === 'pop') navigator.vibrate(20);
        else if (type === 'success') navigator.vibrate([15, 30, 20]);
    }
}

// ─── API Helper (Auto-injects Session Token) ──────────────────────
let sessionToken = localStorage.getItem('ekkhu_session_token') || null;

async function api(url, method = 'GET', body = null) {
    const opts = { method, headers: {} };
    if (body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    if (sessionToken) {
        opts.headers['X-Session-Token'] = sessionToken;
        opts.headers['Authorization'] = 'Bearer ' + sessionToken;
    }
    try {
        const res = await fetch(url, opts);
        if (res.status === 401) {
            handleSessionExpired();
            return { ok: false, error: 'Authentication required' };
        }
        return await res.json();
    } catch(e) {
        return { ok: false, error: e.message };
    }
}

function handleSessionExpired() {
    sessionToken = null;
    currentUserId = null;
    currentUserData = null;
    localStorage.removeItem('ekkhu_session_token');
    localStorage.removeItem('ekku_user_id');
    localStorage.removeItem('ekku_user_data');
    const authScr = document.getElementById('auth-screen');
    const appSh = document.getElementById('app-shell');
    if (authScr) authScr.style.display = 'flex';
    if (appSh) appSh.classList.add('hidden');
    toast('Session expired or required. Please sign in.', 'error');
}

// ════════════════════════════════════════════════════════════════
//  THEME & SWEET PALETTE ENGINE
// ════════════════════════════════════════════════════════════════
function initTheme() {
    const savedTheme = localStorage.getItem('ekkhu_theme') || 'light';
    const savedPalette = localStorage.getItem('ekkhu_palette') || 'crimson';
    setTheme(savedTheme);
    setPalette(savedPalette, false);
}

function setTheme(theme) {
    currentTheme = theme;
    localStorage.setItem('ekkhu_theme', theme);
    const html = document.documentElement;
    if (theme === 'light') {
        html.classList.remove('dark');
        html.classList.add('light');
    } else {
        html.classList.remove('light');
        html.classList.add('dark');
    }

    const icon = theme === 'light' ? 'dark_mode' : 'light_mode';
    ['desk-theme-icon', 'mob-theme-icon'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = icon;
    });
}

function toggleTheme() {
    playHaptic('tap');
    const next = currentTheme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    toast(`Switched to ${next === 'light' ? 'Light Porcelain' : 'Dark Slate'} mode`, 'info');
}

const PALETTE_NAMES = {
    crimson: 'Crimson Luxe',
    sakura: 'Sweet Sakura 🌸',
    cyan: 'Cyber Cyan 🌊',
    matcha: 'Matcha Sage 🍃'
};

function setPalette(palette, notify = true) {
    currentPalette = palette;
    localStorage.setItem('ekkhu_palette', palette);
    document.documentElement.setAttribute('data-palette', palette);

    if (notify) {
        playHaptic('pop');
        toast(`Activated ${PALETTE_NAMES[palette] || palette} theme!`, 'success');
        playRobotChirp();
    }
}

function cycleSweetPalette() {
    playHaptic('tap');
    const list = ['crimson', 'sakura', 'cyan', 'matcha'];
    const idx = list.indexOf(currentPalette);
    const next = list[(idx + 1) % list.length];
    setPalette(next, true);
}

// ════════════════════════════════════════════════════════════════
//  USERNAME + 6-DIGIT PIN AUTHENTICATION ENGINE
// ════════════════════════════════════════════════════════════════
let loginPinBuffer = '';
let caPinBuffer = '';

async function initUserSelect() {
    initTheme();
    const savedToken = localStorage.getItem('ekkhu_session_token');
    const savedUser = localStorage.getItem('ekku_user_data');
    
    if (savedToken) {
        sessionToken = savedToken;
        try {
            const res = await fetch('/api/auth/me', {
                headers: { 'X-Session-Token': savedToken, 'Authorization': 'Bearer ' + savedToken }
            }).then(r => r.json());
            if (res.ok && res.user) {
                currentUserId = res.user.id;
                currentUserData = res.user;
                showApp();
                return;
            }
        } catch(e) {
            console.error('Session verify failed:', e);
        }
    }

    // Show login screen
    sessionToken = null;
    currentUserId = null;
    currentUserData = null;
    document.getElementById('auth-screen').style.display = 'flex';
    document.getElementById('app-shell').classList.add('hidden');
    
    const savedUsername = localStorage.getItem('ekkhu_last_username') || '';
    const uInp = document.getElementById('login-username');
    if (uInp && savedUsername) uInp.value = savedUsername;
    
    switchAuthTab('login');
}

function switchAuthTab(tab) {
    playHaptic('tap');
    const isLog = tab === 'login';
    const tLog = document.getElementById('tab-login');
    const tCre = document.getElementById('tab-create');
    if (tLog && tCre) {
        tLog.className = isLog ? 'auth-tab-active auth-tab flex-1 py-2 rounded-lg text-xs font-bold transition-all' : 'auth-tab-inactive auth-tab flex-1 py-2 rounded-lg text-xs font-bold transition-all';
        tCre.className = !isLog ? 'auth-tab-active auth-tab flex-1 py-2 rounded-lg text-xs font-bold transition-all' : 'auth-tab-inactive auth-tab flex-1 py-2 rounded-lg text-xs font-bold transition-all';
    }
    document.getElementById('login-panel').classList.toggle('hidden', !isLog);
    document.getElementById('create-panel').classList.toggle('hidden', isLog);

    loginPinBuffer = '';
    caPinBuffer = '';
    updateLoginDots();
    updateCaDots();
    const lErr = document.getElementById('login-error');
    const cErr = document.getElementById('ca-error');
    if (lErr) lErr.classList.add('hidden');
    if (cErr) cErr.classList.add('hidden');
}

// ── Login 6-Digit PIN Numpad Handlers ───────────────────────────
function loginKey(digit) {
    playHaptic('tap');
    if (loginPinBuffer.length >= 6) return;
    loginPinBuffer += digit;
    updateLoginDots();
    if (loginPinBuffer.length === 6) {
        setTimeout(() => submitLogin(), 100);
    }
}

function loginDel() {
    playHaptic('tap');
    if (!loginPinBuffer.length) return;
    loginPinBuffer = loginPinBuffer.slice(0, -1);
    updateLoginDots();
    const err = document.getElementById('login-error');
    if (err) err.classList.add('hidden');
}

function updateLoginDots() {
    for (let i = 0; i < 6; i++) {
        const d = document.getElementById('ld' + i);
        if (!d) continue;
        if (i < loginPinBuffer.length) {
            d.classList.add('filled');
            d.classList.remove('error');
        } else {
            d.classList.remove('filled', 'error');
        }
    }
}

async function submitLogin() {
    const uInp = document.getElementById('login-username');
    const username = (uInp ? uInp.value : '').trim();
    const err = document.getElementById('login-error');
    const btn = document.getElementById('btn-login-submit');

    if (!username) {
        if (err) { err.textContent = 'Please enter your username / name.'; err.classList.remove('hidden'); }
        if (uInp) uInp.focus();
        return;
    }
    if (loginPinBuffer.length < 4) {
        if (err) { err.textContent = 'Please enter your PIN.'; err.classList.remove('hidden'); }
        shakeLoginDots();
        return;
    }

    if (err) err.classList.add('hidden');
    if (btn) { btn.disabled = true; btn.innerHTML = `<span class="material-symbols-outlined text-[16px] animate-spin">refresh</span> Verifying Security PIN...`; }

    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, pin: loginPinBuffer })
        }).then(r => r.json());

        if (res.ok && res.token) {
            playHaptic('success');
            localStorage.setItem('ekkhu_last_username', username);
            loginSuccess(res.token, res.user.id, res.user.name, res.user.color);
        } else {
            if (err) {
                err.textContent = res.error || 'Invalid username or PIN';
                err.classList.remove('hidden');
            }
            shakeLoginDots();
        }
    } catch(e) {
        if (err) {
            err.textContent = 'Connection error. Please check backend server.';
            err.classList.remove('hidden');
        }
        shakeLoginDots();
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = `<span class="material-symbols-outlined text-[16px]">lock_open</span> Sign In`; }
    }
}

function shakeLoginDots() {
    playHaptic('pop');
    const row = document.getElementById('login-dots-row');
    if (row) {
        row.classList.add('pin-shake');
        setTimeout(() => row.classList.remove('pin-shake'), 450);
    }
    for (let i = 0; i < 6; i++) {
        const d = document.getElementById('ld' + i);
        if (d) { d.classList.add('error'); setTimeout(() => d.classList.remove('error'), 700); }
    }
    setTimeout(() => {
        loginPinBuffer = '';
        updateLoginDots();
    }, 700);
}

// ── Create Profile 6-Digit PIN Numpad Handlers ──────────────────
function caKey(digit) {
    playHaptic('tap');
    if (caPinBuffer.length >= 6) return;
    caPinBuffer += digit;
    updateCaDots();
}

function caDel() {
    playHaptic('tap');
    if (!caPinBuffer.length) return;
    caPinBuffer = caPinBuffer.slice(0, -1);
    updateCaDots();
    const err = document.getElementById('ca-error');
    if (err) err.classList.add('hidden');
}

function updateCaDots() {
    for (let i = 0; i < 6; i++) {
        const d = document.getElementById('ca-d' + i);
        if (!d) continue;
        if (i < caPinBuffer.length) {
            d.classList.add('filled');
            d.classList.remove('error');
        } else {
            d.classList.remove('filled', 'error');
        }
    }
}

async function submitCreateAccount() {
    const name = (document.getElementById('ca-name') || {}).value?.trim() || '';
    const code = (document.getElementById('ca-code') || {}).value?.trim() || '';
    const err = document.getElementById('ca-error');
    const btn = document.getElementById('btn-create-submit');

    if (!name || name.length < 2) {
        if (err) { err.textContent = 'Please enter a name / username (min 2 chars).'; err.classList.remove('hidden'); }
        return;
    }
    if (caPinBuffer.length !== 6) {
        if (err) { err.textContent = 'Please create a complete 6-digit PIN.'; err.classList.remove('hidden'); }
        return;
    }
    if (!code) {
        if (err) { err.textContent = 'Invite code is required to register.'; err.classList.remove('hidden'); }
        return;
    }

    if (err) err.classList.add('hidden');
    if (btn) { btn.disabled = true; btn.innerHTML = `<span class="material-symbols-outlined text-[16px] animate-spin">refresh</span> Creating Profile...`; }

    try {
        const res = await fetch('/api/create_account', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, pin: caPinBuffer, invite_code: code })
        }).then(r => r.json());

        if (res.ok && res.token) {
            playHaptic('success');
            localStorage.setItem('ekkhu_last_username', name);
            loginSuccess(res.token, res.id, res.name, res.color);
        } else {
            if (err) {
                err.textContent = res.error || 'Failed to create profile';
                err.classList.remove('hidden');
            }
        }
    } catch(e) {
        if (err) {
            err.textContent = 'Server error. Please try again.';
            err.classList.remove('hidden');
        }
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = `<span class="material-symbols-outlined text-[16px]">how_to_reg</span> Create Profile &amp; Enter`; }
    }
}

function loginSuccess(token, uid, name, color) {
    sessionToken = token;
    currentUserId = uid;
    currentUserData = { id: uid, name, color };
    localStorage.setItem('ekkhu_session_token', token);
    localStorage.setItem('ekku_user_id', uid);
    localStorage.setItem('ekku_user_data', JSON.stringify(currentUserData));
    showApp();
}

function showApp() {
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('app-shell').classList.remove('hidden');

    updateUserUI();
    bootApp();
}

async function switchUser() {
    playHaptic('tap');
    if (sessionToken) {
        try {
            await fetch('/api/auth/logout', {
                method: 'POST',
                headers: { 'X-Session-Token': sessionToken }
            });
        } catch(e) {}
    }
    
    sessionToken = null;
    currentUserId = null;
    currentUserData = null;
    localStorage.removeItem('ekkhu_session_token');
    localStorage.removeItem('ekku_user_id');
    localStorage.removeItem('ekku_user_data');
    loginPinBuffer = '';
    caPinBuffer = '';

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

    const mb = document.getElementById('mobile-user-btn');
    if (mb) { mb.textContent = initial; mb.style.background = color || 'var(--primary)'; }

    const db = document.getElementById('desk-user-btn');
    if (db) { db.textContent = initial; db.style.background = color || 'var(--primary)'; }

    const sa = document.getElementById('desk-profile-avatar');
    if (sa) { sa.textContent = initial; sa.style.background = color || 'var(--primary)'; }

    const sn = document.getElementById('desk-profile-name');
    if (sn) sn.textContent = name;

    const ma = document.getElementById('mob-drawer-avatar');
    if (ma) { ma.textContent = initial; ma.style.background = color || 'var(--primary)'; }

    const mn = document.getElementById('mob-drawer-name');
    if (mn) mn.textContent = name;

    const fl = document.getElementById('footer-user-label');
    if (fl) fl.innerHTML = `<span class="material-symbols-outlined text-[13px]">person</span> ${escapeHtml(name)}`;

    const gn = document.getElementById('dash-greet-name');
    if (gn) gn.textContent = name;
}

// ════════════════════════════════════════════════════════════════
//  APP BOOT & NAVIGATION
// ════════════════════════════════════════════════════════════════
function bootApp() {
    initGreeting();
    loadSummary();
    loadRoutine();
    loadAttendance();
    loadBudget();
    loadCGPA();
    loadPlans();
    loadTasks();
    initRobotInteractivePhysics();
    initPullToRefresh();
    initNotificationPermission();
    checkProactiveNudge();
    loadProactiveSettings();

    if (isDesktopDevice()) {
        showView('dashboard');
        loadDesktopChatHistory();
        loadDesktopChatPanel();
    } else {
        showView('dashboard');
        loadMobileChatHistory();
    }
    loadSettingsUserList();
    initPomodoroDisplay();

    setInterval(() => {
        if (currentUserId) updateNextClassCountdown();
    }, 30000);

    // Periodic proactive assistant poll every 3 minutes
    if (!proactivePollTimer) {
        proactivePollTimer = setInterval(() => {
            if (currentUserId && sessionToken) checkProactiveNudge();
        }, 180000);
    }
}

function initGreeting() {
    const h = new Date().getHours();
    const part = h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening';
    const el = document.getElementById('dash-greet-part');
    if (el) el.textContent = part;
}

function showView(name) {
    playHaptic('tap');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const target = document.getElementById('view-' + name);
    if (target) target.classList.add('active');

    document.body.classList.toggle('view-chat-active', name === 'chat');

    // Sidebar Nav Highlight (Desktop)
    document.querySelectorAll('.nav-item').forEach(el => {
        const isActive = el.dataset.view === name;
        el.classList.toggle('bg-primary/10', isActive);
        el.classList.toggle('text-primary', isActive);
        el.classList.toggle('font-bold', isActive);
        el.classList.toggle('text-muted', !isActive);
    });

    // Mobile Floating Dock Highlight
    document.querySelectorAll('.dock-tab').forEach(el => {
        const isActive = el.dataset.view === name;
        el.classList.toggle('active', isActive);
    });

    if (name === 'chat') {
        if (isDesktopDevice()) {
            loadDesktopChatPanel();
            setTimeout(() => {
                const inp = document.getElementById('desk-chat-input');
                if (inp) inp.focus();
            }, 60);
        } else {
            loadMobileChatHistory();
            setTimeout(() => {
                const cont = document.getElementById('chat-messages');
                if (cont) cont.scrollTop = cont.scrollHeight;
            }, 80);
        }
    }
    if (name === 'dashboard') {
        loadSummary();
    }
}

function openMobileMenu() {
    playHaptic('tap');
    const drawer = document.getElementById('mobile-menu-drawer');
    if (drawer) {
        drawer.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    }
}

function closeMobileMenu() {
    playHaptic('tap');
    const drawer = document.getElementById('mobile-menu-drawer');
    if (drawer) {
        drawer.classList.add('hidden');
        document.body.style.overflow = '';
    }
}

function toggleMobileMenu() {
    const drawer = document.getElementById('mobile-menu-drawer');
    if (drawer && !drawer.classList.contains('hidden')) {
        closeMobileMenu();
    } else {
        openMobileMenu();
    }
}

function handleMobileMenuBackdrop(event) {
    if (event.target && event.target.id === 'mobile-menu-drawer') {
        closeMobileMenu();
    }
}

// ─── Toast System ────────────────────────────────────────────────
function toast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const colorMap = {
        success: 'bg-emerald-600 text-white',
        error: 'bg-rose-600 text-white',
        info: 'bg-slate-900 text-white dark:bg-slate-800',
        warning: 'bg-amber-600 text-white'
    };
    const iconMap = { success: 'check_circle', error: 'error', info: 'info', warning: 'warning' };
    const t = document.createElement('div');
    t.className = `flex items-center gap-3 px-4 py-3 rounded-2xl shadow-2xl text-xs font-bold toast-in pointer-events-auto border border-white/20 ${colorMap[type] || colorMap.info}`;
    t.innerHTML = `<span class="material-symbols-outlined text-[18px] shrink-0">${iconMap[type] || 'info'}</span><span class="flex-1">${escapeHtml(msg)}</span>`;
    container.appendChild(t);
    setTimeout(() => {
        t.classList.replace('toast-in', 'toast-out');
        setTimeout(() => t.remove(), 350);
    }, 3200);
}

// ════════════════════════════════════════════════════════════════
//  🏝️ MOBILE "DYNAMIC ISLAND" LIVE CAPSULE HUD ENGINE
// ════════════════════════════════════════════════════════════════
function toggleDynamicIsland(e, forceClose = false) {
    if (e) e.stopPropagation();
    const island = document.getElementById('mob-dynamic-island');
    const compact = document.getElementById('island-compact-view');
    const expanded = document.getElementById('island-expanded-view');
    if (!island) return;

    if (forceClose || isIslandExpanded) {
        isIslandExpanded = false;
        island.classList.remove('expanded');
        island.classList.add('compact');
        if (compact) compact.classList.remove('hidden');
        if (expanded) expanded.classList.add('hidden');
        playHaptic('tap');
    } else {
        isIslandExpanded = true;
        island.classList.remove('compact');
        island.classList.add('expanded');
        if (compact) compact.classList.add('hidden');
        if (expanded) expanded.classList.remove('hidden');
        playHaptic('pop');
    }
}

function updateDynamicIslandUI(badgeText, title, timeStr, isLive = false) {
    const compactTitle = document.getElementById('island-compact-title');
    const compactStat = document.getElementById('island-compact-stat');
    const dot = document.getElementById('island-dot');

    if (compactTitle) compactTitle.textContent = title || 'Ekkhu Active';
    if (compactStat) compactStat.textContent = timeStr || 'LIVE';
    if (dot) dot.className = `w-2 h-2 rounded-full ${isLive ? 'bg-primary animate-ping' : 'bg-emerald-500 animate-pulse'}`;

    const expStatus = document.getElementById('island-expanded-status');
    const expClass = document.getElementById('island-class-name');
    const expTimer = document.getElementById('island-class-timer');

    if (expStatus) expStatus.textContent = badgeText || 'Academic Telemetry Active';
    if (expClass) expClass.textContent = title || 'No routine classes right now';
    if (expTimer) expTimer.textContent = timeStr ? `${badgeText}: ${timeStr}` : 'Schedule Clear';
}

// ════════════════════════════════════════════════════════════════
//  🫧 FLOATING AI COMPANION BUBBLE & BOTTOM SHEET
// ════════════════════════════════════════════════════════════════
function openCompanionQuickActions() {
    playRobotChirp();
    playHaptic('pop');

    const html = `
        <div class="space-y-4">
            <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-2xl flex items-center justify-center text-white shadow-md" style="background:var(--gradient-btn)">
                    <span class="material-symbols-outlined text-[20px]">smart_toy</span>
                </div>
                <div>
                    <h3 class="font-extrabold text-sm text-main">Ekkhu Neural Companion</h3>
                    <p class="text-[11px] text-muted font-medium">Fast action hub &amp; voice assistant</p>
                </div>
            </div>

            <div class="grid grid-cols-2 gap-2.5 pt-1">
                <button onclick="closeBottomSheet(); showView('chat'); switchChatMode('voice');" class="p-3 rounded-2xl cyber-glow-btn text-white text-left shadow-lg">
                    <span class="material-symbols-outlined text-[20px] mb-1">mic</span>
                    <p class="text-xs font-bold">Start Voice Chat</p>
                    <p class="text-[10px] text-white/80">Speak in Bangla/English</p>
                </button>
                <button onclick="closeBottomSheet(); showView('chat'); switchChatMode('text');" class="p-3 rounded-2xl cyber-pill text-main text-left border hover:border-primary">
                    <span class="material-symbols-outlined text-[20px] text-primary mb-1">chat</span>
                    <p class="text-xs font-bold">Text Chat</p>
                    <p class="text-[10px] text-muted">Ask questions &amp; plan</p>
                </button>
                <button onclick="closeBottomSheet(); openPomodoroModal();" class="p-3 rounded-2xl cyber-pill text-main text-left border hover:border-primary">
                    <span class="material-symbols-outlined text-[20px] text-emerald-500 mb-1">timer</span>
                    <p class="text-xs font-bold">Focus Timer</p>
                    <p class="text-[10px] text-muted">25m Pomodoro sprint</p>
                </button>
                <button onclick="closeBottomSheet(); openTaskModal();" class="p-3 rounded-2xl cyber-pill text-main text-left border hover:border-primary">
                    <span class="material-symbols-outlined text-[20px] text-amber-500 mb-1">add_task</span>
                    <p class="text-xs font-bold">Add Action Item</p>
                    <p class="text-[10px] text-muted">Log new study task</p>
                </button>
            </div>
        </div>
    `;
    openBottomSheet(html);
}

function openBottomSheet(content) {
    const sheet = document.getElementById('mob-bottom-sheet');
    const body = document.getElementById('mob-bottom-sheet-body');
    if (!sheet || !body) return;
    body.innerHTML = content;
    sheet.classList.remove('hidden');
    sheet.classList.add('open');
}

function closeBottomSheet() {
    playHaptic('tap');
    const sheet = document.getElementById('mob-bottom-sheet');
    if (!sheet) return;
    sheet.classList.remove('open');
    setTimeout(() => sheet.classList.add('hidden'), 320);
}

function handleBottomSheetBackdrop(e) {
    if (e.target.id === 'mob-bottom-sheet') {
        closeBottomSheet();
    }
}

// ════════════════════════════════════════════════════════════════
//  🔄 PULL-TO-REFRESH FOR MOBILE
// ════════════════════════════════════════════════════════════════
function initPullToRefresh() {
    const scrollEl = document.getElementById('app-main-scroll');
    const ind = document.getElementById('pull-refresh-indicator');
    if (!scrollEl || !ind) return;

    let startY = 0;
    let isPulling = false;

    scrollEl.addEventListener('touchstart', (e) => {
        if (scrollEl.scrollTop <= 0) {
            startY = e.touches[0].pageY;
            isPulling = true;
        }
    }, { passive: true });

    scrollEl.addEventListener('touchmove', (e) => {
        if (!isPulling) return;
        const currentY = e.touches[0].pageY;
        const diff = currentY - startY;

        if (diff > 25 && scrollEl.scrollTop <= 0) {
            ind.classList.add('visible');
            const rot = Math.min(diff * 3, 360);
            ind.style.transform = `translateX(-50%) translateY(${Math.min(diff * 0.4, 45)}px) rotate(${rot}deg)`;
        }
    }, { passive: true });

    scrollEl.addEventListener('touchend', async (e) => {
        if (!isPulling) return;
        isPulling = false;
        const diff = (e.changedTouches[0]?.pageY || 0) - startY;

        if (diff > 75 && scrollEl.scrollTop <= 0) {
            ind.classList.add('spinning');
            playHaptic('pop');
            await loadSummary();
            toast('Academic telemetry updated ✓', 'success');
            setTimeout(() => {
                ind.classList.remove('spinning', 'visible');
                ind.style.transform = '';
            }, 600);
        } else {
            ind.classList.remove('visible');
            ind.style.transform = '';
        }
    });
}

// ════════════════════════════════════════════════════════════════
//  DASHBOARD & ACADEMIC INTELLIGENCE COMPUTATIONS
// ════════════════════════════════════════════════════════════════
let cachedTodayClasses = [];

async function loadSummary() {
    try {
        const data = await api('/api/summary');
        const today = data.today || '?';
        const dateStr = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

        const dtDate = document.getElementById('dash-date-dt');
        if (dtDate) dtDate.textContent = dateStr.toUpperCase();

        // 1. Attendance & Safe-Skip Intelligence
        const attPct = data.att_percent || 0;
        const attStatus = attPct >= 75 ? 'OPTIMAL' : attPct >= 60 ? 'WARNING' : 'CRITICAL';
        const attColor = attPct >= 75 ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : attPct >= 60 ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400' : 'bg-rose-500/15 text-rose-600 dark:text-rose-400';

        const attDt = document.getElementById('d-att-pct-dt');
        if (attDt) attDt.textContent = attPct + '%';

        const statusChip = document.getElementById('d-att-status-chip');
        if (statusChip) {
            statusChip.textContent = attStatus;
            statusChip.className = `text-[9px] px-2 py-0.5 rounded-full font-bold ${attColor}`;
        }

        // 2. CGPA
        const cgpa = data.cgpa || 0;
        const cgpaDt = document.getElementById('d-cgpa-dt');
        if (cgpaDt) cgpaDt.textContent = cgpa.toFixed(2);

        // 3. Budget & Daily Spending Allowance
        const balance = data.balance || 0;
        const balDt = document.getElementById('d-balance-dt');
        if (balDt) balDt.textContent = '৳' + balance.toFixed(0);

        const now = new Date();
        const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const daysLeft = Math.max(1, daysInMonth - now.getDate() + 1);
        const dailyAllowance = balance > 0 ? Math.floor(balance / daysLeft) : 0;

        const allowEl = document.getElementById('d-daily-allowance');
        if (allowEl) {
            allowEl.innerHTML = `<span class="font-bold text-main">৳${dailyAllowance}</span> / day (${daysLeft}d)`;
        }

        // 4. Tasks
        const pending = data.pending_tasks || 0;
        const penDt = document.getElementById('d-pending-dt');
        if (penDt) penDt.textContent = pending;

        const navBadge = document.getElementById('nav-task-badge');
        if (navBadge) {
            navBadge.textContent = pending;
            navBadge.classList.toggle('hidden', pending === 0);
            navBadge.classList.toggle('inline-flex', pending > 0);
        }

        // 5. Composite Academic Health Index Computation (5-Factor Model)
        computeAcademicHealthIndex(attPct, cgpa, pending, balance, data.today_focus_mins || 0);

        // 6. Academic Lifecycle & Dynamic Routine
        currentAcademicState = data.academic_state || null;
        scheduleExceptionsToday = data.schedule_exceptions_today || [];
        renderAcademicStateBanner(currentAcademicState);

        cachedTodayClasses = data.today_routine || [];
        renderDashRoutine(cachedTodayClasses, today, data);
        updateNextClassCountdown();

        // 7. Today Tasks & Insights
        renderDashTasks();
        renderSmartInsights(data);

        // 8. Executive PA Briefing & Exams Hub
        loadExecutiveBriefing();
        loadExams();

    } catch (e) {
        console.error('Summary load failed:', e);
    }
}

// ── Composite Academic Health Score Algorithm (5-Factor Model) ────
let healthAuditData = {
    compositeScore: 92,
    attScore: 30, attMax: 30, attPct: 85,
    cgpaScore: 18.5, cgpaMax: 20, cgpaVal: 3.70,
    taskScore: 20, taskMax: 20, pendingTasks: 0,
    focusScore: 15, focusMax: 15, focusMins: 50,
    budScore: 15, budMax: 15, balance: 1500,
    burnoutStatus: 'Balanced & Optimal',
    burnoutDesc: 'Circadian rhythms and focus session intervals are balanced. No burnout indicators detected.'
};

function computeAcademicHealthIndex(attPct, cgpa, pendingTasks, balance, todayFocusMins) {
    todayFocusMins = todayFocusMins || 0;
    
    // 1. Attendance (30 pts max)
    const attScore = Math.min(30, (attPct / 75) * 30);
    // 2. CGPA (20 pts max)
    const cgpaScore = Math.min(20, (cgpa / 4.0) * 20);
    // 3. Task Velocity (20 pts max)
    const taskScore = Math.max(5, 20 - (pendingTasks * 3));
    // 4. Study Focus Velocity (15 pts max - 50m gives full 15 pts)
    const focusScore = Math.min(15, (todayFocusMins / 50) * 15);
    // 5. Budget Runway (15 pts max)
    const budScore = balance >= 0 ? 15 : Math.max(0, 15 - Math.abs(balance) / 500);

    const compositeScore = Math.round(Math.min(100, Math.max(10, attScore + cgpaScore + taskScore + focusScore + budScore)));

    // Circadian & Burnout analysis
    const nowHour = new Date().getHours();
    let burnoutStatus = 'Balanced & Optimal';
    let burnoutDesc = 'Circadian rhythms and focus intervals are balanced. No burnout indicators detected.';
    if (nowHour >= 1 && nowHour <= 5) {
        burnoutStatus = 'Late-Night Fatigue Alert ⚠️';
        burnoutDesc = `Active late at night (${nowHour}:00 AM). Sleep deprivation significantly impacts memory retention and focus. Rest is advised.`;
    } else if (todayFocusMins > 180) {
        burnoutStatus = 'High Cognitive Load';
        burnoutDesc = `Over 3 hours (${todayFocusMins}m) of focus logged today! Ensure adequate hydration and 15-minute relaxation breaks.`;
    }

    healthAuditData = {
        compositeScore,
        attScore: Math.round(attScore * 10) / 10,
        attMax: 30,
        attPct,
        cgpaScore: Math.round(cgpaScore * 10) / 10,
        cgpaMax: 20,
        cgpaVal: cgpa,
        taskScore: Math.round(taskScore * 10) / 10,
        taskMax: 20,
        pendingTasks,
        focusScore: Math.round(focusScore * 10) / 10,
        focusMax: 15,
        focusMins: todayFocusMins,
        budScore: Math.round(budScore * 10) / 10,
        budMax: 15,
        balance,
        burnoutStatus,
        burnoutDesc
    };

    const valEl = document.getElementById('health-index-val');
    if (valEl) valEl.textContent = compositeScore + '%';

    const ring = document.getElementById('health-ring-circle');
    if (ring) {
        const offset = 251.2 - (compositeScore / 100) * 251.2;
        ring.style.strokeDashoffset = offset;
    }

    const badge = document.getElementById('health-index-badge');
    const desc = document.getElementById('health-index-desc');
    if (badge && desc) {
        if (compositeScore >= 85) {
            badge.textContent = 'OPTIMAL';
            badge.className = 'text-[9px] px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-bold';
            desc.textContent = 'Academic standing is solid • Click for audit';
        } else if (compositeScore >= 70) {
            badge.textContent = 'STABLE';
            badge.className = 'text-[9px] px-2.5 py-0.5 rounded-full bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 font-bold';
            desc.textContent = 'Good momentum, keep tasks on schedule • Click for audit';
        } else {
            badge.textContent = 'ATTENTION';
            badge.className = 'text-[9px] px-2.5 py-0.5 rounded-full bg-rose-500/15 text-rose-600 dark:text-rose-400 font-bold';
            desc.textContent = 'Attendance or pending tasks need review • Click for audit';
        }
    }
}

function openHealthAuditModal() {
    playHaptic('tap');
    const modal = document.getElementById('health-audit-modal');
    if (!modal) return;

    const d = healthAuditData;
    const scoreEl = document.getElementById('audit-composite-score');
    const badgeEl = document.getElementById('audit-composite-badge');
    const titleEl = document.getElementById('audit-status-title');
    const descEl = document.getElementById('audit-status-desc');

    if (scoreEl) scoreEl.textContent = d.compositeScore + '%';
    if (badgeEl) {
        badgeEl.textContent = d.compositeScore >= 85 ? 'OPTIMAL' : d.compositeScore >= 70 ? 'STABLE' : 'ATTENTION';
        badgeEl.className = d.compositeScore >= 85
            ? 'block mt-1 text-[9px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
            : d.compositeScore >= 70
            ? 'block mt-1 text-[9px] font-bold px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-600 dark:text-cyan-400'
            : 'block mt-1 text-[9px] font-bold px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-600 dark:text-rose-400';
    }

    if (titleEl) titleEl.textContent = d.compositeScore >= 85 ? 'Peak Academic Momentum' : d.compositeScore >= 70 ? 'Stable Performance Track' : 'Optimization Required';
    if (descEl) descEl.textContent = d.compositeScore >= 85 ? 'All five core telemetry streams are operating within optimal thresholds.' : 'Key areas need attention to maximize semester performance.';

    // 1. Att
    const attStatus = document.getElementById('audit-att-status');
    const attBar = document.getElementById('audit-att-bar');
    const attSub = document.getElementById('audit-att-sub');
    if (attStatus) attStatus.textContent = d.attPct >= 75 ? `Optimal (${d.attPct}%)` : `Needs Attention (${d.attPct}%)`;
    if (attBar) attBar.style.width = `${Math.min(100, (d.attPct / 75) * 100)}%`;
    if (attSub) attSub.textContent = `Attendance rate: ${d.attPct}% (Requirement: 75%)`;

    // 2. CGPA
    const cgpaStatus = document.getElementById('audit-cgpa-status');
    const cgpaBar = document.getElementById('audit-cgpa-bar');
    const cgpaSub = document.getElementById('audit-cgpa-sub');
    if (cgpaStatus) cgpaStatus.textContent = `${Number(d.cgpaVal).toFixed(2)} / 4.00`;
    if (cgpaBar) cgpaBar.style.width = `${Math.min(100, (d.cgpaVal / 4.0) * 100)}%`;
    if (cgpaSub) cgpaSub.textContent = d.cgpaVal >= 3.75 ? `Current CGPA: ${Number(d.cgpaVal).toFixed(2)} (High Honor)` : d.cgpaVal >= 3.5 ? `Current CGPA: ${Number(d.cgpaVal).toFixed(2)} (Honor Standing)` : `Current CGPA: ${Number(d.cgpaVal).toFixed(2)} (Target: 3.50+)`;

    // 3. Tasks
    const taskStatus = document.getElementById('audit-task-status');
    const taskBar = document.getElementById('audit-task-bar');
    const taskSub = document.getElementById('audit-task-sub');
    if (taskStatus) taskStatus.textContent = d.pendingTasks === 0 ? 'Clean Backlog ✓' : `${d.pendingTasks} Pending`;
    if (taskBar) taskBar.style.width = `${Math.max(10, 100 - d.pendingTasks * 15)}%`;
    if (taskSub) taskSub.textContent = d.pendingTasks === 0 ? 'All action items completed' : `${d.pendingTasks} priority task(s) in progress`;

    // 4. Focus
    const focusStatus = document.getElementById('audit-focus-status');
    const focusBar = document.getElementById('audit-focus-bar');
    const focusSub = document.getElementById('audit-focus-sub');
    if (focusStatus) focusStatus.textContent = `${d.focusMins}m Logged Today`;
    if (focusBar) focusBar.style.width = `${Math.min(100, (d.focusMins / 50) * 100)}%`;
    if (focusSub) focusSub.textContent = `${d.focusMins}m deep work logged today (Goal: 50m+)`;

    // 5. Budget
    const budStatus = document.getElementById('audit-bud-status');
    const budBar = document.getElementById('audit-bud-bar');
    const budSub = document.getElementById('audit-bud-sub');
    if (budStatus) budStatus.textContent = d.balance >= 0 ? `৳${Number(d.balance).toFixed(0)} Solvent` : `৳${Number(d.balance).toFixed(0)} Deficit`;
    if (budBar) budBar.style.width = `${d.balance >= 0 ? Math.min(100, Math.max(30, (d.balance / 3000) * 100)) : 15}%`;
    if (budSub) budSub.textContent = `Available runway balance: ৳${Number(d.balance).toFixed(0)}`;

    // Burnout
    const bTitle = document.getElementById('audit-burnout-title');
    const bDesc = document.getElementById('audit-burnout-desc');
    if (bTitle) bTitle.textContent = d.burnoutStatus;
    if (bDesc) bDesc.textContent = d.burnoutDesc;

    modal.classList.remove('hidden');
}

function closeHealthAuditModal() {
    const modal = document.getElementById('health-audit-modal');
    if (modal) modal.classList.add('hidden');
}

// ── Next Class Live Countdown Banner & Dynamic Island ────────────
function updateNextClassCountdown() {
    const titleEl = document.getElementById('next-class-title');
    const metaEl = document.getElementById('next-class-meta');
    const badgeEl = document.getElementById('next-class-badge');
    const timeLabel = document.getElementById('next-class-time-label');
    const countEl = document.getElementById('next-class-countdown');

    const banner = document.getElementById('dash-next-class-banner');

    // 1. Academic Break & Exam Mode Override
    if (currentAcademicState && currentAcademicState.is_active_break) {
        if (banner) banner.classList.remove('hidden');
        const mode = currentAcademicState.mode;
        const days = currentAcademicState.days_remaining || 0;
        if (mode === 'prep_leave') {
            if (titleEl) titleEl.textContent = 'Preparatory Leave (PL) Active 📖';
            if (metaEl) metaEl.textContent = `${days} day(s) until finals. Normal classes are paused for study sprint.`;
            if (badgeEl) { badgeEl.textContent = 'PL SPRINT'; badgeEl.className = 'text-[9px] font-bold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-500 border border-amber-500/30 animate-pulse'; }
            if (timeLabel) timeLabel.textContent = 'FINALS IN';
            if (countEl) {
                countEl.textContent = `${days}d`;
                countEl.className = 'text-base md:text-2xl font-mono font-black text-amber-500';
            }
        } else if (mode === 'exam_week') {
            if (titleEl) titleEl.textContent = 'Exam Season / Finals 🎯';
            if (metaEl) metaEl.textContent = 'Check upcoming exam schedule & 72-Hour Survival protocols.';
            if (badgeEl) { badgeEl.textContent = 'EXAMS ACTIVE'; badgeEl.className = 'text-[9px] font-bold px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-500 border border-rose-500/30 animate-pulse'; }
            if (timeLabel) timeLabel.textContent = 'STATUS';
            if (countEl) {
                countEl.textContent = 'EXAMS';
                countEl.className = 'text-base md:text-2xl font-mono font-black text-rose-500';
            }
        } else if (mode === 'semester_break') {
            if (titleEl) titleEl.textContent = 'Semester Break / Vacation 🌴';
            if (metaEl) metaEl.textContent = 'Academic obligations paused. Recharge & relax!';
            if (badgeEl) { badgeEl.textContent = 'VACATION'; badgeEl.className = 'text-[9px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-500 border border-emerald-500/30'; }
            if (timeLabel) timeLabel.textContent = 'STATUS';
            if (countEl) {
                countEl.textContent = 'CHILL';
                countEl.className = 'text-base md:text-2xl font-mono font-black text-emerald-500';
            }
        } else if (mode === 'holiday') {
            if (titleEl) titleEl.textContent = 'University Holiday / Off 🏖️';
            if (metaEl) metaEl.textContent = currentAcademicState.note || 'Campus closed today.';
            if (badgeEl) { badgeEl.textContent = 'HOLIDAY'; badgeEl.className = 'text-[9px] font-bold px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-500 border border-sky-500/30'; }
            if (timeLabel) timeLabel.textContent = 'STATUS';
            if (countEl) {
                countEl.textContent = 'OFF';
                countEl.className = 'text-base md:text-2xl font-mono font-black text-sky-500';
            }
        }
        return;
    }

    if (!cachedTodayClasses || cachedTodayClasses.length === 0) {
        if (banner) banner.classList.add('hidden');
        return;
    }

    if (banner) banner.classList.remove('hidden');

    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();

    const parsedClasses = cachedTodayClasses.map(c => {
        let mins = 0;
        const m = String(c.time || '').match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
        if (m) {
            let h = parseInt(m[1], 10);
            const ap = (m[3] || '').toUpperCase();
            if (ap === 'PM' && h < 12) h += 12;
            if (ap === 'AM' && h === 12) h = 0;
            mins = h * 60 + parseInt(m[2], 10);
        }
        return { ...c, _mins: mins, _endMins: mins + 50 };
    }).sort((a, b) => a._mins - b._mins);

    let ongoing = null;
    let nextClass = null;

    for (const c of parsedClasses) {
        if (nowMins >= c._mins && nowMins <= c._endMins) {
            ongoing = c;
            break;
        } else if (c._mins > nowMins && !nextClass) {
            nextClass = c;
        }
    }

    if (ongoing) {
        const left = ongoing._endMins - nowMins;
        if (badgeEl) { badgeEl.textContent = 'ONGOING NOW'; badgeEl.className = 'text-[9px] font-bold px-2 py-0.5 rounded-full bg-primary text-white shadow-sm animate-pulse'; }
        if (titleEl) titleEl.textContent = ongoing.course;
        if (metaEl) metaEl.textContent = `Room ${ongoing.room || 'TBD'} • Prof. ${ongoing.prof || 'Faculty'}`;
        if (timeLabel) timeLabel.textContent = 'ENDS IN';
        if (countEl) {
            countEl.textContent = `${left}m`;
            countEl.className = 'text-base md:text-2xl font-mono font-black text-primary';
        }
        updateDynamicIslandUI('ONGOING', ongoing.course, `${left}m left`, true);
    } else if (nextClass) {
        const diff = nextClass._mins - nowMins;
        const hours = Math.floor(diff / 60);
        const mins = diff % 60;
        const timeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

        if (badgeEl) { badgeEl.textContent = 'NEXT CLASS'; badgeEl.className = 'text-[9px] font-bold px-2 py-0.5 rounded-full bg-primary text-white shadow-sm'; }
        if (titleEl) titleEl.textContent = nextClass.course;
        if (metaEl) metaEl.textContent = `${nextClass.time} • Room ${nextClass.room || 'TBD'}`;
        if (timeLabel) timeLabel.textContent = 'STARTS IN';
        if (countEl) {
            countEl.textContent = timeStr;
            countEl.className = 'text-base md:text-2xl font-mono font-black text-primary';
        }
        updateDynamicIslandUI('UPCOMING', nextClass.course, `in ${timeStr}`, false);
    } else {
        if (badgeEl) { badgeEl.textContent = 'COMPLETED'; badgeEl.className = 'text-[9px] font-bold px-2 py-0.5 rounded-full bg-slate-500/15 text-slate-400'; }
        if (titleEl) titleEl.textContent = 'All classes done for today!';
        if (metaEl) metaEl.textContent = 'Great discipline. Review pending tasks or start a study focus sprint.';
        if (timeLabel) timeLabel.textContent = 'STATUS';
        if (countEl) {
            countEl.textContent = 'DONE';
            countEl.className = 'text-base md:text-2xl font-mono font-black text-emerald-500 dark:text-emerald-400';
        }
        updateDynamicIslandUI('COMPLETED', 'All Classes Done', 'DONE', false);
    }
}

function renderDashRoutine(classes, today, data) {
    const dtEl = document.getElementById('dash-routine-dt');
    if (!dtEl) return;

    if (!classes || classes.length === 0) {
        dtEl.innerHTML = `<div class="flex flex-col items-center text-center py-6">
            <span class="material-symbols-outlined text-[28px] text-emerald-500">event_available</span>
            <p class="text-xs font-bold text-main mt-1.5">No Classes Today</p>
            <p class="text-[10px] text-muted mt-0.5 font-medium">Your schedule is open today for study sprints or assignments.</p>
        </div>`;
        return;
    }

    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();

    const sorted = [...classes].map(c => {
        let mins = 0;
        const m = String(c.time || '').match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
        if (m) {
            let h = parseInt(m[1], 10);
            const ap = (m[3] || '').toUpperCase();
            if (ap === 'PM' && h < 12) h += 12;
            if (ap === 'AM' && h === 12) h = 0;
            mins = h * 60 + parseInt(m[2], 10);
        }
        return { ...c, _mins: mins, _endMins: mins + 50 };
    }).sort((a, b) => a._mins - b._mins);

    dtEl.innerHTML = sorted.map(c => {
        const isOngoing = nowMin >= c._mins && nowMin <= c._endMins;
        const isPast = nowMin > c._endMins;

        return `
            <div class="flex items-center gap-3 p-3 rounded-2xl cyber-pill ${isOngoing ? 'border-primary bg-primary/5' : ''}">
                <div class="w-12 md:w-14 shrink-0 text-[11px] md:text-xs font-mono font-bold ${isOngoing ? 'text-primary' : 'text-muted'}">${escapeHtml(c.time)}</div>
                <div class="w-1.5 h-8 rounded-full ${isOngoing ? 'bg-primary animate-pulse' : isPast ? 'bg-muted/30' : 'bg-primary/60'}"></div>
                <div class="flex-1 min-w-0">
                    <p class="text-xs font-bold text-main truncate ${isOngoing ? 'text-primary' : ''}">${escapeHtml(c.course)}</p>
                    <p class="text-[10px] md:text-[11px] text-muted mt-0.5 font-medium">${c.room ? 'Room ' + escapeHtml(c.room) : 'Room TBD'} ${c.prof ? '• ' + escapeHtml(c.prof) : ''}</p>
                </div>
                ${isOngoing ? '<span class="text-[9px] font-bold px-2 py-0.5 rounded-full bg-primary text-white shrink-0 animate-pulse">LIVE</span>' : isPast ? '<span class="text-[9px] font-bold text-muted shrink-0 font-mono">done</span>' : '<span class="text-[9px] font-bold text-primary shrink-0 font-mono">next</span>'}
            </div>
        `;
    }).join('');
}

function getTaskDeadlineBadge(t) {
    if (t.done) return { text: 'DONE ✓', cls: 'bg-slate-500/15 text-muted' };
    if (!t.date) return { text: 'NO DATE', cls: 'bg-slate-500/10 text-muted' };
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tDate = new Date(t.date + 'T00:00:00');
    const diffDays = Math.round((tDate - today) / (1000 * 60 * 60 * 24));
    
    if (diffDays < 0) {
        return { text: 'OVERDUE ⚠️', cls: 'bg-rose-500/20 text-rose-600 dark:text-rose-400 font-bold animate-pulse' };
    } else if (diffDays === 0) {
        return { text: 'DUE TODAY 🔥', cls: 'bg-amber-500/20 text-amber-600 dark:text-amber-400 font-bold' };
    } else if (diffDays === 1) {
        return { text: 'DUE TOMORROW ⚡', cls: 'bg-cyan-500/20 text-cyan-600 dark:text-cyan-400 font-bold' };
    } else {
        return { text: `In ${diffDays}d`, cls: 'cyber-pill text-muted font-bold' };
    }
}

async function renderDashTasks() {
    try {
        const tasks = await api('/api/tasks');
        const pending = tasks.filter(t => !t.done).slice(0, 5);
        const dtEl = document.getElementById('dash-tasks-dt');
        if (!dtEl) return;

        if (pending.length === 0) {
            dtEl.innerHTML = `<div class="text-xs text-muted text-center py-5 font-semibold">All tasks cleared! Great discipline 🎉</div>`;
            return;
        }

        dtEl.innerHTML = pending.map(t => {
            const dl = getTaskDeadlineBadge(t);
            const prioColor = t.priority === 'urgent' ? 'text-rose-500 font-bold' : t.priority === 'high' ? 'text-amber-500 font-bold' : 'text-muted';
            return `
                <div class="flex items-center gap-2.5 p-2.5 md:p-3 rounded-2xl cyber-pill hover:border-primary/40 transition-all">
                    <button onclick="toggleTask(${t.id}, 1)" class="w-5 h-5 rounded-lg border-2 flex items-center justify-center border-muted/40 hover:border-primary text-transparent hover:text-primary transition-all shrink-0">
                        <span class="material-symbols-outlined text-[13px]">check</span>
                    </button>
                    <div class="flex-1 min-w-0">
                        <p class="text-xs font-bold text-main truncate">${escapeHtml(t.title)}</p>
                        <p class="text-[9px] md:text-[10px] text-muted font-mono">${t.date || 'Today'} ${t.due_time ? '• ' + escapeHtml(t.due_time) : ''}</p>
                    </div>
                    <span class="text-[9px] px-2 py-0.5 rounded-full font-mono shrink-0 ${dl.cls}">${dl.text}</span>
                </div>
            `;
        }).join('');
    } catch (e) { }
}

function renderSmartInsights(data) {
    const container = document.getElementById('smart-insights');
    if (!container) return;

    const insights = [];
    if ((data.att_percent || 0) < 75) {
        insights.push({
            icon: 'warning',
            title: 'Attendance Alert',
            msg: `Attendance is at ${data.att_percent}% (goal 75%). Prioritize your next lectures.`,
            action: "showView('attendance')",
            btnText: 'Review'
        });
    }
    if ((data.pending_tasks || 0) >= 3) {
        insights.push({
            icon: 'bolt',
            title: 'Task Momentum',
            msg: `You have ${data.pending_tasks} pending action items. Start a 25-min Pomodoro sprint.`,
            action: "openPomodoroModal()",
            btnText: 'Focus'
        });
    }

    if (insights.length === 0) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = `
        <div class="grid grid-cols-1 md:grid-cols-${insights.length > 1 ? '2' : '1'} gap-2.5 animate-fade-in">
            ${insights.map(i => `
                <div class="glass-card rounded-2xl p-3.5 border-l-4 border-l-primary flex items-center justify-between gap-3 shadow-sm">
                    <div class="flex items-center gap-2.5 min-w-0">
                        <span class="w-8 h-8 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0 border border-primary/20">
                            <span class="material-symbols-outlined text-[18px]">${i.icon}</span>
                        </span>
                        <div class="min-w-0">
                            <p class="text-xs font-bold text-main leading-tight">${escapeHtml(i.title)}</p>
                            <p class="text-[10px] md:text-[11px] text-muted font-medium mt-0.5 truncate">${escapeHtml(i.msg)}</p>
                        </div>
                    </div>
                    <button onclick="${i.action}" class="cyber-glow-btn text-white px-3 py-1.5 rounded-xl text-[11px] font-bold shrink-0 shadow-md">${i.btnText}</button>
                </div>
            `).join('')}
        </div>
    `;
}

// ════════════════════════════════════════════════════════════════
//  🎓 ACADEMIC LIFECYCLE & STATE MACHINE ENGINE
// ════════════════════════════════════════════════════════════════
let currentAcademicState = null;
let scheduleExceptionsToday = [];
let pendingCancelSlotData = null;

function renderAcademicStateBanner(acadState) {
    if (!acadState) return;
    currentAcademicState = acadState;
    const banner = document.getElementById('academic-mode-banner');
    const title = document.getElementById('acad-mode-title');
    const badge = document.getElementById('acad-mode-badge');
    const sub = document.getElementById('acad-mode-subtitle');
    const icon = document.getElementById('acad-mode-icon');
    const box = document.getElementById('acad-mode-icon-box');

    if (!banner || !title) return;

    const mode = acadState.mode || 'regular';
    const daysRem = acadState.days_remaining || 0;

    if (mode === 'prep_leave') {
        title.textContent = 'Preparatory Leave (PL)';
        badge.textContent = `${daysRem} DAYS LEFT`;
        badge.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-500 border border-amber-500/30 animate-pulse';
        sub.textContent = acadState.note || 'Classes suspended • Final exam sprint & syllabus lock-in active';
        if (icon) icon.textContent = 'auto_stories';
        if (box) box.style.background = 'linear-gradient(135deg, #f59e0b, #d97706)';
    } else if (mode === 'exam_week') {
        title.textContent = 'Exam Season / Finals';
        badge.textContent = 'ACTIVE EXAMS';
        badge.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/15 text-rose-500 border border-rose-500/30 animate-pulse';
        sub.textContent = acadState.note || 'Regular classes paused • 72-Hour Exam Survival & Formula recall active';
        if (icon) icon.textContent = 'local_fire_department';
        if (box) box.style.background = 'linear-gradient(135deg, #e11d48, #be123c)';
    } else if (mode === 'semester_break') {
        title.textContent = 'Semester Break / Vacation';
        badge.textContent = 'CHILL & RECHARGE';
        badge.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-500 border border-emerald-500/30';
        sub.textContent = acadState.note || 'All academic obligations paused • Free time to relax and build side projects';
        if (icon) icon.textContent = 'beach_access';
        if (box) box.style.background = 'linear-gradient(135deg, #10b981, #059669)';
    } else if (mode === 'holiday') {
        title.textContent = 'University Holiday / Off';
        badge.textContent = 'CAMPUS CLOSED';
        badge.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-sky-500/15 text-sky-500 border border-sky-500/30';
        sub.textContent = acadState.note || 'Temporary break • Class routine paused';
        if (icon) icon.textContent = 'event_available';
        if (box) box.style.background = 'linear-gradient(135deg, #0284c7, #0369a1)';
    } else {
        title.textContent = 'Regular Classes';
        badge.textContent = 'SEMESTER ACTIVE';
        badge.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-500 border border-emerald-500/20';
        sub.textContent = 'Normal weekly timetable active • Attendance tracking & safe-bunk shield enabled';
        if (icon) icon.textContent = 'school';
        if (box) box.style.background = 'var(--gradient-btn)';
    }
}

async function openAcademicModeModal() {
    playHaptic('tap');
    const modal = document.getElementById('academic-mode-modal');
    if (!modal) return;

    try {
        const state = await api('/api/academic_state');
        currentAcademicState = state;
        const sel = document.getElementById('acad-mode-select');
        const sDate = document.getElementById('acad-start-date');
        const eDate = document.getElementById('acad-end-date');
        const noteInp = document.getElementById('acad-note');

        if (sel) sel.value = state.mode || 'regular';
        if (sDate) sDate.value = state.start_date || new Date().toISOString().split('T')[0];
        if (eDate) eDate.value = state.end_date || state.resume_date || '';
        if (noteInp) noteInp.value = state.note || '';
        onAcadModeChange();
    } catch(e) {}

    modal.classList.remove('hidden');
}

function closeAcademicModeModal() {
    const modal = document.getElementById('academic-mode-modal');
    if (modal) modal.classList.add('hidden');
}

function onAcadModeChange() {
    const sel = document.getElementById('acad-mode-select');
    const val = sel ? sel.value : 'regular';
    const rangeRow = document.getElementById('acad-date-range-row');
    const help = document.getElementById('acad-mode-help-text');

    if (rangeRow) {
        rangeRow.classList.toggle('hidden', val === 'regular');
    }

    if (help) {
        if (val === 'prep_leave') {
            help.textContent = '📖 Preparatory Leave (PL): Ekkhu pauses daily routine alarms and attendance counting, focusing your dynamic island and voice briefings on final exam study sprints.';
        } else if (val === 'exam_week') {
            help.textContent = '🎯 Exam Season: Routine is silenced and replaced with upcoming exam countdowns and 72-hour survival tactical plans.';
        } else if (val === 'semester_break') {
            help.textContent = '🌴 Semester Break: All academic demands paused. Ekkhu switches to chill companion mode with zero attendance penalties.';
        } else if (val === 'holiday') {
            help.textContent = '🏖️ University Holiday: Temporary multi-day closure. Classes are paused for selected dates.';
        } else {
            help.textContent = '🟢 Regular Classes: Normal routine and daily attendance tracking active.';
        }
    }
}

async function saveAcademicState() {
    const sel = document.getElementById('acad-mode-select');
    const sDate = document.getElementById('acad-start-date');
    const eDate = document.getElementById('acad-end-date');
    const noteInp = document.getElementById('acad-note');

    const mode = sel ? sel.value : 'regular';
    const startDate = sDate ? sDate.value : '';
    const endDate = eDate ? eDate.value : '';
    const note = noteInp ? noteInp.value.trim() : '';

    try {
        playHaptic('success');
        const res = await api('/api/academic_state', 'POST', {
            mode,
            start_date: startDate,
            end_date: endDate,
            resume_date: endDate,
            note
        });

        toast(`Academic Phase updated: ${res.academic_state.phase_label}`, 'success');
        closeAcademicModeModal();
        renderAcademicStateBanner(res.academic_state);
        loadSummary();
        loadRoutine();
    } catch(e) {
        toast('Failed to update academic state', 'error');
    }
}

function openCancelSlotModal(course, dateStr, timeStr) {
    playHaptic('tap');
    pendingCancelSlotData = { course, dateStr, timeStr };
    const modal = document.getElementById('cancel-slot-modal');
    if (!modal) return;

    const cInp = document.getElementById('cancel-slot-course');
    const dInp = document.getElementById('cancel-slot-date');
    const tInp = document.getElementById('cancel-slot-time');
    const rInp = document.getElementById('cancel-slot-reason');

    if (cInp) cInp.value = course;
    if (dInp) dInp.value = dateStr || new Date().toISOString().split('T')[0];
    if (tInp) tInp.value = timeStr || '';
    if (rInp) rInp.value = 'Teacher absent / class cancelled';

    modal.classList.remove('hidden');
}

function closeCancelSlotModal() {
    const modal = document.getElementById('cancel-slot-modal');
    if (modal) modal.classList.add('hidden');
    pendingCancelSlotData = null;
}

async function confirmCancelSlot() {
    if (!pendingCancelSlotData) return;
    const cInp = document.getElementById('cancel-slot-course');
    const dInp = document.getElementById('cancel-slot-date');
    const tInp = document.getElementById('cancel-slot-time');
    const rInp = document.getElementById('cancel-slot-reason');

    const course = cInp ? cInp.value : pendingCancelSlotData.course;
    const dateStr = dInp ? dInp.value : pendingCancelSlotData.dateStr;
    const slotTime = tInp ? tInp.value : pendingCancelSlotData.timeStr;
    const reason = rInp ? rInp.value.trim() : 'Cancelled';

    try {
        playHaptic('success');
        await api('/api/schedule_exceptions', 'POST', {
            course,
            date: dateStr,
            slot_time: slotTime,
            type: 'class_cancelled',
            reason
        });

        toast(`Marked ${course} cancelled for today ✓`, 'success');
        closeCancelSlotModal();
        loadRoutine();
        loadSummary();
    } catch(e) {
        toast('Failed to cancel slot', 'error');
    }
}

async function undoCancelSlot(excId) {
    playHaptic('tap');
    try {
        await api(`/api/schedule_exceptions/${excId}`, 'DELETE');
        toast('Restored class slot ✓', 'info');
        loadRoutine();
        loadSummary();
    } catch(e) {
        toast('Failed to undo cancellation', 'error');
    }
}

// ════════════════════════════════════════════════════════════════
//  ROUTINE (Schedule & Timetable)
// ════════════════════════════════════════════════════════════════
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

async function loadRoutine() {
    const data = await api('/api/routine');
    const grid = document.getElementById('routine-grid');
    const pillsCont = document.getElementById('routine-day-pills');
    if (!grid) return;

    const todayIso = new Date().toISOString().split('T')[0];
    let exceptions = [];
    try {
        exceptions = await api(`/api/schedule_exceptions?date=${todayIso}`) || [];
    } catch(e) {}
    const cancelledMap = {};
    if (Array.isArray(exceptions)) {
        exceptions.forEach(ex => {
            if (ex.course) cancelledMap[ex.course.toLowerCase().trim()] = ex;
        });
    }

    const todayDay = DAYS[new Date().getDay()];

    if (pillsCont) {
        pillsCont.innerHTML = `
            <button onclick="filterRoutineDay('ALL')" class="cyber-pill px-3 py-1.5 rounded-xl text-xs font-bold shrink-0 ${activeRoutineDay === 'ALL' ? 'bg-primary text-white border-primary shadow-sm' : 'text-muted hover:text-main'}">All Days</button>
            <button onclick="filterRoutineDay('TODAY')" class="cyber-pill px-3 py-1.5 rounded-xl text-xs font-bold shrink-0 ${activeRoutineDay === 'TODAY' ? 'bg-primary text-white border-primary shadow-sm' : 'text-muted hover:text-main'}">Today (${todayDay})</button>
            ${DAYS.map(d => `
                <button onclick="filterRoutineDay('${d}')" class="cyber-pill px-3 py-1.5 rounded-xl text-xs font-bold shrink-0 ${activeRoutineDay === d ? 'bg-primary text-white border-primary shadow-sm' : 'text-muted hover:text-main'}">${d}</button>
            `).join('')}
        `;
    }

    const byDay = {};
    DAYS.forEach(d => byDay[d] = []);
    data.forEach(r => { if (byDay[r.day]) byDay[r.day].push(r); });

    const displayedDays = (activeRoutineDay === 'ALL')
        ? DAYS
        : (activeRoutineDay === 'TODAY')
            ? [todayDay]
            : [activeRoutineDay];

    grid.innerHTML = displayedDays.map(day => {
        const classes = byDay[day] || [];
        const isToday = day === todayDay;

        return `
            <div class="glass-card rounded-2xl p-4 flex flex-col ${isToday ? 'border-primary/50 shadow-md' : ''}">
                <div class="flex items-center justify-between mb-3 pb-2 border-b" style="border-color:var(--border-subtle)">
                    <span class="text-xs font-bold uppercase tracking-wider ${isToday ? 'text-primary' : 'text-main'} font-mono">${day}</span>
                    ${isToday ? '<span class="text-[9px] px-2 py-0.5 rounded-full bg-primary text-white font-bold">TODAY</span>' : ''}
                </div>
                <div class="space-y-2 flex-1">
                    ${classes.length === 0 ? '<p class="text-[11px] text-muted text-center py-6">No classes</p>' :
                    classes.map(c => {
                        const isCancelled = isToday && cancelledMap[c.course.toLowerCase().trim()];
                        const exc = isCancelled ? cancelledMap[c.course.toLowerCase().trim()] : null;

                        if (isCancelled) {
                            return `
                                <div class="p-2.5 rounded-xl cyber-pill opacity-80 border border-rose-500/30 bg-rose-500/5">
                                    <div class="flex justify-between items-start">
                                        <span class="text-xs font-bold text-main line-through truncate pr-1">${escapeHtml(c.course)}</span>
                                        <span class="text-[9px] px-1.5 py-0.5 rounded-full bg-rose-500/20 text-rose-500 font-bold font-mono">OFF TODAY</span>
                                    </div>
                                    <div class="flex items-center justify-between text-[10px] text-muted mt-1 font-mono">
                                        <span>${escapeHtml(c.time)} • ${escapeHtml(exc.reason || 'Cancelled')}</span>
                                        <button onclick="undoCancelSlot(${exc.id})" class="text-[10px] text-primary font-bold hover:underline">Undo</button>
                                    </div>
                                </div>
                            `;
                        }

                        return `
                            <div class="p-2.5 rounded-xl cyber-pill group hover:border-primary transition-all">
                                <div class="flex justify-between items-start">
                                    <span class="text-xs font-bold text-main leading-tight truncate pr-1">${escapeHtml(c.course)}</span>
                                    <div class="flex items-center gap-1">
                                        ${isToday ? `<button onclick="openCancelSlotModal('${escapeHtml(c.course)}', '${todayIso}', '${escapeHtml(c.time)}')" class="text-[10px] text-muted hover:text-rose-500 font-bold px-1.5 py-0.5 rounded hover:bg-rose-500/10 transition-colors" title="Cancel this class slot today">🚫 Off</button>` : ''}
                                        <button onclick="deleteRoutine(${c.id})" class="text-muted hover:text-rose-500 text-xs transition-opacity shrink-0" title="Delete class">✕</button>
                                    </div>
                                </div>
                                <div class="flex items-center justify-between text-[10px] text-muted mt-1 font-mono font-semibold">
                                    <span>${escapeHtml(c.time)}</span>
                                    <span class="font-sans font-bold text-primary">${escapeHtml(c.room || '')}</span>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    }).join('');
}

function filterRoutineDay(day) {
    playHaptic('tap');
    activeRoutineDay = day;
    loadRoutine();
}

async function deleteRoutine(id) {
    playHaptic('tap');
    await api('/api/routine', 'DELETE', { id });
    toast('Class removed from routine', 'info');
    loadRoutine();
    loadSummary();
}

function openRoutineModal() {
    playHaptic('tap');
    MODAL_ACTION = 'routine';
    document.getElementById('modal-title').textContent = 'Add Class to Routine';
    selectedColor = '#e11d48';
    document.getElementById('modal-body').innerHTML = `
        <div>
            <label class="block text-[11px] font-bold uppercase text-muted mb-1">Day of Week</label>
            <select id="f-day" class="light-input text-xs font-bold">
                ${DAYS.map(d => `<option value="${d}">${d}</option>`).join('')}
            </select>
        </div>
        <div>
            <label class="block text-[11px] font-bold uppercase text-muted mb-1">Class Time</label>
            <input id="f-time" type="time" value="09:00" class="light-input text-xs font-mono font-bold"/>
        </div>
        <div>
            <label class="block text-[11px] font-bold uppercase text-muted mb-1">Course Title</label>
            <input id="f-course" placeholder="e.g. Operating Systems" class="light-input text-xs"/>
        </div>
        <div>
            <label class="block text-[11px] font-bold uppercase text-muted mb-1">Room / Lab (Optional)</label>
            <input id="f-room" placeholder="e.g. Room 402" class="light-input text-xs"/>
        </div>
        <div>
            <label class="block text-[11px] font-bold uppercase text-muted mb-1">Professor (Optional)</label>
            <input id="f-prof" placeholder="e.g. Dr. Hossain" class="light-input text-xs"/>
        </div>
    `;
    document.getElementById('modal-overlay').classList.remove('hidden');
}

// ════════════════════════════════════════════════════════════════
//  ATTENDANCE & SAFE-SKIP ALGORITHM
// ════════════════════════════════════════════════════════════════
async function loadAttendance() {
    const data = await api('/api/attendance');
    const list = document.getElementById('att-list');
    const overall = document.getElementById('att-overall');
    const overallBar = document.getElementById('att-overall-bar');
    const dashSafePill = document.getElementById('dash-att-safe-skips') || document.getElementById('d-att-safe-pill');

    if (!list) return;

    if (!data || data.length === 0) {
        list.innerHTML = `
            <div class="glass-card rounded-3xl p-8 text-center text-muted">
                <span class="material-symbols-outlined text-[36px] text-primary/40 mb-2">how_to_reg</span>
                <p class="font-bold text-sm text-main">No courses registered yet</p>
                <p class="text-xs mt-1">Add your academic courses to track attendance &amp; safe bunks.</p>
            </div>
        `;
        if (overall) overall.textContent = '0%';
        if (overallBar) overallBar.style.width = '0%';
        if (dashSafePill) dashSafePill.textContent = 'No courses active';
        return;
    }

    let tot = 0, pres = 0;
    data.forEach(a => { tot += (a.total || 0); pres += (a.present || 0); });
    const overallPct = tot ? Math.round((pres / tot) * 100) : 0;

    if (overall) overall.textContent = overallPct + '%';
    if (overallBar) {
        overallBar.style.width = overallPct + '%';
        overallBar.className = overallPct >= 75 ? 'bg-primary h-2 rounded-full transition-all duration-700' : 'bg-rose-500 h-2 rounded-full transition-all duration-700';
    }

    let totalSafeSkips = 0;
    data.forEach(a => {
        const canMiss = a.safe_bunks !== undefined ? a.safe_bunks : Math.max(0, Math.floor(a.present / 0.75 - a.total));
        totalSafeSkips += canMiss;
    });

    if (dashSafePill) {
        dashSafePill.innerHTML = overallPct >= 75
            ? `<span class="text-emerald-500 font-bold">Safe:</span> ~${totalSafeSkips} skips`
            : `<span class="text-rose-500 font-bold">&lt; 75% target</span>`;
    }

    list.innerHTML = data.map(a => {
        const pct = a.percent || 0;
        const statusColor = pct >= 75 ? 'text-emerald-500' : pct >= 65 ? 'text-amber-500' : 'text-rose-500';
        const barColor = pct >= 75 ? 'bg-emerald-500' : pct >= 65 ? 'bg-amber-500' : 'bg-rose-500';
        
        let shieldBadge = '';
        if (a.status === 'ZERO_BUFFER') {
            shieldBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-mono font-black bg-rose-500/20 text-rose-600 dark:text-rose-400 border border-rose-500/30 animate-pulse">🚨 ZERO BUFFER (Critical!)</span>`;
        } else if (a.status === 'WARNING_1') {
            shieldBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-amber-500/20 text-amber-600 dark:text-amber-400 border border-amber-500/30">⚠️ 1 Safe Bunk Left</span>`;
        } else if (a.status === 'SAFE') {
            shieldBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">🛡️ ${a.safe_bunks} Safe Bunks</span>`;
        } else if (a.status === 'DEFICIT') {
            shieldBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-rose-500/15 text-rose-600 dark:text-rose-400 border border-rose-500/30">🩹 Need ${a.recovery_needed} to Recover 75%</span>`;
        } else {
            shieldBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-mono text-muted cyber-pill">Fresh Course</span>`;
        }

        return `
            <div class="glass-card rounded-3xl p-4 md:p-5 shadow-sm space-y-3">
                <div class="flex items-start justify-between">
                    <div>
                        <div class="flex items-center gap-2 mb-1 flex-wrap">
                            <h3 class="font-bold text-xs md:text-base text-main">${escapeHtml(a.course)}</h3>
                            ${shieldBadge}
                        </div>
                        <p class="text-[11px] text-muted font-mono">${a.present} / ${a.total} classes attended (${a.total - a.present} missed)</p>
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="text-xl md:text-2xl font-black font-mono ${statusColor}">${pct}%</span>
                        <button onclick="deleteAtt(${a.id})" class="text-muted hover:text-rose-500 p-1" title="Delete course">
                            <span class="material-symbols-outlined text-[17px]">delete</span>
                        </button>
                    </div>
                </div>

                <div class="w-full bg-black/10 dark:bg-white/10 rounded-full h-2 overflow-hidden p-0.5">
                    <div class="${barColor} h-1 rounded-full transition-all duration-700" style="width:${Math.min(pct, 100)}%"></div>
                </div>

                <div class="flex flex-wrap items-center justify-between gap-2.5 pt-2 border-t" style="border-color:var(--border-subtle)">
                    <p class="text-[11px] font-medium text-muted">
                        ${a.status_text || (pct >= 75 ? `🛡️ Safe to skip ${a.safe_bunks || 0} classes` : `⚠️ Attend ${a.recovery_needed || 1} classes to reach 75%`)}
                    </p>
                    <div class="flex gap-1.5">
                        <button onclick="markAttendance(${a.id}, ${a.total}, ${a.present}, 1)" class="flex items-center gap-1 text-[10px] px-3 py-1 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500 hover:text-white transition-all font-bold">
                            <span class="material-symbols-outlined text-[14px]">check</span> Present (+1)
                        </button>
                        <button onclick="markAttendance(${a.id}, ${a.total}, ${a.present}, 0)" class="flex items-center gap-1 text-[10px] px-3 py-1 rounded-full bg-rose-500/15 text-rose-600 dark:text-rose-400 hover:bg-rose-500 hover:text-white transition-all font-bold">
                            <span class="material-symbols-outlined text-[14px]">close</span> Absent (+0)
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

async function markAttendance(id, total, present, wasPresent) {
    playHaptic(wasPresent ? 'success' : 'tap');
    await api('/api/attendance/update', 'POST', { id, total: total + 1, present: present + (wasPresent ? 1 : 0) });
    toast(wasPresent ? 'Marked class present ✓' : 'Marked class absent', wasPresent ? 'success' : 'info');
    loadAttendance();
    loadSummary();
}

async function deleteAtt(id) {
    playHaptic('tap');
    await api('/api/attendance', 'DELETE', { id });
    toast('Course removed from tracker', 'info');
    loadAttendance();
    loadSummary();
}

function openAttModal() {
    playHaptic('tap');
    MODAL_ACTION = 'attendance';
    document.getElementById('modal-title').textContent = 'Add Course to Attendance';
    document.getElementById('modal-body').innerHTML = `
        <div>
            <label class="block text-[11px] font-bold uppercase text-muted mb-1">Course Title</label>
            <input id="f-course" placeholder="e.g. Artificial Intelligence" class="light-input text-xs"/>
        </div>
        <div>
            <label class="block text-[11px] font-bold uppercase text-muted mb-1">Total Classes Held</label>
            <input id="f-total" type="number" value="10" class="light-input text-xs font-mono font-bold"/>
        </div>
        <div>
            <label class="block text-[11px] font-bold uppercase text-muted mb-1">Classes Attended</label>
            <input id="f-present" type="number" value="8" class="light-input text-xs font-mono font-bold"/>
        </div>
    `;
    document.getElementById('modal-overlay').classList.remove('hidden');
}

// ════════════════════════════════════════════════════════════════
//  CGPA ENGINE & PREDICTOR
// ════════════════════════════════════════════════════════════════
async function loadCGPA() {
    const data = await api('/api/cgpa');
    const cgpaVal = document.getElementById('cgpa-value');
    const creditVal = document.getElementById('cgpa-credit');
    const list = document.getElementById('grade-list');
    const pill = document.getElementById('d-cgpa-credit-pill');
    const semBadge = document.getElementById('cgpa-semester-badge');
    const baseInfo = document.getElementById('cgpa-baseline-info');
    const predDone = document.getElementById('pred-done');

    const cgpa = data.cgpa || 0;
    const credits = data.total_credit || 0;
    const sem = data.current_semester || '6th Semester';
    const baseCGPA = data.baseline_cgpa || 0;
    const baseCreds = data.baseline_credits || 0;

    if (cgpaVal) cgpaVal.textContent = cgpa.toFixed(2);
    if (creditVal) creditVal.textContent = credits.toFixed(1);
    if (pill) pill.textContent = `${credits.toFixed(1)} credits`;
    if (semBadge) semBadge.textContent = sem;
    if (baseInfo) baseInfo.textContent = `Baseline: ${baseCGPA.toFixed(2)} (${baseCreds.toFixed(1)} cr)`;
    if (predDone && (!predDone.value || predDone.value === '0')) {
        predDone.value = credits > 0 ? credits.toFixed(1) : (baseCreds > 0 ? baseCreds.toFixed(1) : '81.0');
    }

    if (!list) return;
    if (!data.items || data.items.length === 0) {
        list.innerHTML = `
            <div class="glass-card rounded-3xl p-6 text-center text-muted font-medium space-y-2">
                <p>No active semester courses added yet.</p>
                <p class="text-xs text-muted">Your accumulated CGPA (${cgpa.toFixed(2)}) is calculated from your <b>${escapeHtml(sem)}</b> baseline (${baseCreds} credits).</p>
                <button onclick="openGradeModal()" class="cyber-pill px-4 py-1.5 rounded-xl text-primary font-bold text-xs hover:bg-primary hover:text-white transition-all mt-1">+ Add Current Semester Course</button>
            </div>
        `;
    } else {
        list.innerHTML = data.items.map(g => `
            <div class="glass-card rounded-2xl p-3.5 flex items-center justify-between">
                <div>
                    <p class="font-bold text-xs md:text-sm text-main">${escapeHtml(g.course)}</p>
                    <p class="text-[10px] text-muted font-mono font-semibold">${g.credit} Credit(s)</p>
                </div>
                <div class="flex items-center gap-2.5">
                    <span class="text-base font-black font-mono text-primary">${g.grade.toFixed(2)}</span>
                    <button onclick="deleteGrade(${g.id})" class="text-muted hover:text-rose-500 p-1">
                        <span class="material-symbols-outlined text-[17px]">delete</span>
                    </button>
                </div>
            </div>
        `).join('');
    }
}

async function openBaselineModal() {
    playHaptic('tap');
    const modal = document.getElementById('baseline-cgpa-modal');
    if (!modal) return;
    try {
        const data = await api('/api/cgpa/baseline');
        const sInp = document.getElementById('base-semester-input');
        const cInp = document.getElementById('base-cgpa-input');
        const rInp = document.getElementById('base-credits-input');

        if (sInp) sInp.value = data.current_semester || '6th Semester';
        if (cInp) cInp.value = data.baseline_cgpa > 0 ? data.baseline_cgpa.toFixed(2) : '';
        if (rInp) rInp.value = data.baseline_credits > 0 ? data.baseline_credits.toFixed(1) : '';
    } catch(e) {}
    modal.classList.remove('hidden');
}

function closeBaselineModal() {
    const modal = document.getElementById('baseline-cgpa-modal');
    if (modal) modal.classList.add('hidden');
}

async function saveBaselineProfile() {
    const sem = (document.getElementById('base-semester-input') || {}).value || '6th Semester';
    const baseCgpa = parseFloat((document.getElementById('base-cgpa-input') || {}).value) || 0.0;
    const baseCredits = parseFloat((document.getElementById('base-credits-input') || {}).value) || 0.0;

    if (baseCgpa < 0 || baseCgpa > 4.0) {
        toast('Baseline CGPA must be between 0.00 and 4.00', 'error');
        return;
    }

    try {
        playHaptic('success');
        await api('/api/cgpa/baseline', 'POST', {
            current_semester: sem,
            baseline_cgpa: baseCgpa,
            baseline_credits: baseCredits
        });
        toast(`Updated standing: ${sem} (CGPA: ${baseCgpa.toFixed(2)})`, 'success');
        closeBaselineModal();
        loadCGPA();
        loadSummary();
    } catch(e) {
        toast('Failed to save baseline standing', 'error');
    }
}

async function deleteGrade(id) {
    playHaptic('tap');
    await api('/api/cgpa', 'DELETE', { id });
    toast('Course grade removed', 'info');
    loadCGPA();
    loadSummary();
}

function openGradeModal() {
    playHaptic('tap');
    MODAL_ACTION = 'grade';
    document.getElementById('modal-title').textContent = 'Add Course Grade';
    document.getElementById('modal-body').innerHTML = `
        <div>
            <label class="block text-[11px] font-bold uppercase text-muted mb-1">Course Title</label>
            <input id="f-course" placeholder="e.g. Algorithms" class="light-input text-xs"/>
        </div>
        <div>
            <label class="block text-[11px] font-bold uppercase text-muted mb-1">Course Credits</label>
            <input id="f-credit" type="number" step="0.5" value="3.0" class="light-input text-xs font-mono font-bold"/>
        </div>
        <div>
            <label class="block text-[11px] font-bold uppercase text-muted mb-1">Obtained Letter Grade</label>
            <select id="f-grade" class="light-input text-xs font-bold">
                <option value="4.0">A+ (4.00)</option>
                <option value="3.75">A (3.75)</option>
                <option value="3.50">A- (3.50)</option>
                <option value="3.25">B+ (3.25)</option>
                <option value="3.00">B (3.00)</option>
                <option value="2.75">B- (2.75)</option>
                <option value="2.50">C+ (2.50)</option>
                <option value="2.00">C (2.00)</option>
                <option value="0.00">F (0.00)</option>
            </select>
        </div>
    `;
    document.getElementById('modal-overlay').classList.remove('hidden');
}

async function predictCGPA() {
    playHaptic('pop');
    const target = parseFloat(document.getElementById('pred-target').value) || 3.90;
    const done = parseFloat(document.getElementById('pred-done').value) || 0;
    const rem = parseFloat(document.getElementById('pred-rem').value) || 15;
    const data = await api('/api/cgpa');
    const curVal = data.cgpa || 0;
    const curCreds = data.total_credit || done;

    const actualDone = curCreds > 0 ? curCreds : done;
    const totalCredits = actualDone + rem;
    const requiredPoints = (target * totalCredits) - (curVal * actualDone);
    const requiredGPA = rem > 0 ? requiredPoints / rem : 0;

    const resEl = document.getElementById('pred-result');
    if (!resEl) return;

    if (requiredGPA > 4.0) {
        resEl.innerHTML = `
            <div class="p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 text-xs mt-3 space-y-1">
                <p class="font-bold">Mathematically Challenging</p>
                <p>To hit ${target.toFixed(2)} CGPA, you would need an average GPA of <strong>${requiredGPA.toFixed(2)}</strong> across the remaining ${rem} credits (exceeds max 4.00 scale).</p>
            </div>
        `;
    } else if (requiredGPA <= 0) {
        resEl.innerHTML = `
            <div class="p-3.5 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-xs mt-3 space-y-1">
                <p class="font-bold">Goal Secured! 🏆</p>
                <p>Your current accumulated credits already safely guarantee your target CGPA of ${target.toFixed(2)}.</p>
            </div>
        `;
    } else {
        const coursesCount = Math.max(1, Math.round(rem / 3));
        let gradeDesc = '';
        if (requiredGPA >= 3.9) {
            gradeDesc = `Needs mostly <strong>A+ / A (4.00)</strong> across all ${coursesCount} remaining course(s).`;
        } else if (requiredGPA >= 3.7) {
            gradeDesc = `Target combination: <strong>A / A- (3.7 - 4.0)</strong> across ${coursesCount} course(s).`;
        } else if (requiredGPA >= 3.3) {
            gradeDesc = `Target combination: <strong>B+ to A- (3.3 - 3.7)</strong> across ${coursesCount} course(s).`;
        } else {
            gradeDesc = `Target combination: <strong>B / B+ (3.0 - 3.3)</strong> across ${coursesCount} course(s).`;
        }

        resEl.innerHTML = `
            <div class="p-3.5 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-xs mt-3 space-y-2">
                <div class="flex justify-between items-center">
                    <span class="font-bold text-main">Required Remaining GPA</span>
                    <span class="text-base font-black font-mono text-emerald-600 dark:text-emerald-400">${requiredGPA.toFixed(2)}</span>
                </div>
                <div class="w-full bg-slate-200 dark:bg-slate-700 h-1.5 rounded-full overflow-hidden">
                    <div class="bg-emerald-500 h-full rounded-full" style="width:${Math.min(100, (requiredGPA / 4.0) * 100)}%"></div>
                </div>
                <p class="text-[11px] text-muted leading-relaxed">${gradeDesc}</p>
            </div>
        `;
    }
}

// ════════════════════════════════════════════════════════════════
//  BUDGET TRACKER
// ════════════════════════════════════════════════════════════════
async function loadBudget() {
    const data = await api('/api/budget');
    const balEl = document.getElementById('bud-balance');
    const inEl = document.getElementById('bud-in');
    const outEl = document.getElementById('bud-out');
    const list = document.getElementById('bud-list');

    if (balEl) balEl.textContent = '৳' + (data.balance || 0).toFixed(0);
    if (inEl) inEl.textContent = '৳' + (data.total_in || 0).toFixed(0);
    if (outEl) outEl.textContent = '৳' + (data.total_out || 0).toFixed(0);

    if (!list) return;
    if (!data.items || data.items.length === 0) {
        list.innerHTML = '<div class="glass-card rounded-3xl p-6 text-center text-muted font-medium">No budget transactions logged yet.</div>';
    } else {
        list.innerHTML = data.items.map(it => `
            <div class="glass-card rounded-2xl p-3.5 flex items-center justify-between">
                <div class="flex items-center gap-3">
                    <div class="w-8 h-8 rounded-xl flex items-center justify-center ${it.type === 'income' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-rose-500/15 text-rose-500'}">
                        <span class="material-symbols-outlined text-[16px]">${it.type === 'income' ? 'arrow_downward' : 'arrow_upward'}</span>
                    </div>
                    <div>
                        <p class="font-bold text-xs md:text-sm text-main">${escapeHtml(it.desc)}</p>
                        <p class="text-[9px] text-muted font-mono font-medium">${it.date}</p>
                    </div>
                </div>
                <div class="flex items-center gap-2.5">
                    <span class="font-mono font-black text-xs md:text-sm ${it.type === 'income' ? 'text-emerald-500' : 'text-rose-500'}">
                        ${it.type === 'income' ? '+' : '-'}৳${(it.amount || 0).toFixed(0)}
                    </span>
                    <button onclick="deleteBudget(${it.id})" class="text-muted hover:text-rose-500 p-1">
                        <span class="material-symbols-outlined text-[16px]">delete</span>
                    </button>
                </div>
            </div>
        `).join('');
    }
}

async function deleteBudget(id) {
    playHaptic('tap');
    await api('/api/budget', 'DELETE', { id });
    toast('Budget entry deleted', 'info');
    loadBudget();
    loadSummary();
}

function openBudgetModal() {
    playHaptic('tap');
    MODAL_ACTION = 'budget';
    document.getElementById('modal-title').textContent = 'Add Budget Entry';
    document.getElementById('modal-body').innerHTML = `
        <div>
            <label class="block text-[11px] font-bold uppercase text-muted mb-1">Transaction Type</label>
            <select id="f-type" class="light-input text-xs font-bold">
                <option value="expense">Expense (-)</option>
                <option value="income">Income (+)</option>
            </select>
        </div>
        <div>
            <label class="block text-[11px] font-bold uppercase text-muted mb-1">Description</label>
            <input id="f-desc" placeholder="e.g. Food, Travel, Books" class="light-input text-xs"/>
        </div>
        <div>
            <label class="block text-[11px] font-bold uppercase text-muted mb-1">Amount (৳)</label>
            <input id="f-amount" type="number" step="10" placeholder="500" class="light-input text-xs font-mono font-bold"/>
        </div>
        <div>
            <label class="block text-[11px] font-bold uppercase text-muted mb-1">Date</label>
            <input id="f-date" type="date" value="${new Date().toISOString().split('T')[0]}" class="light-input text-xs font-mono font-bold"/>
        </div>
    `;
    document.getElementById('modal-overlay').classList.remove('hidden');
}

// ════════════════════════════════════════════════════════════════
//  WEEKLY PLANS & DAILY TASKS
// ════════════════════════════════════════════════════════════════
async function loadPlans() {
    const data = await api('/api/plans');
    const list = document.getElementById('plans-list');
    if (!list) return;

    if (data.length === 0) {
        list.innerHTML = `<div class="glass-card rounded-3xl p-6 text-center text-muted font-medium">No plans scheduled for this week. Create one!</div>`;
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
            html += `
                <div class="glass-card rounded-2xl p-4 mb-3">
                    <h3 class="text-xs font-extrabold text-primary uppercase tracking-widest mb-2.5 font-mono">${day}</h3>
                    <div class="space-y-2">
                        ${grouped[day].map(plan => {
                            const isDone = plan.status === 'completed';
                            return `
                                <div class="flex items-center gap-2.5 p-2.5 rounded-xl cyber-pill ${isDone ? 'opacity-50' : ''}">
                                    <input type="checkbox" ${isDone ? 'checked' : ''} onchange="togglePlanStatus(${plan.id}, this.checked)" class="w-4 h-4 rounded border-muted text-primary focus:ring-primary cursor-pointer"/>
                                    <div class="flex-1 min-w-0">
                                        <p class="text-xs font-bold text-main ${isDone ? 'line-through' : ''}">${escapeHtml(plan.title)}</p>
                                    </div>
                                    <span class="text-[9px] font-mono font-bold px-2 py-0.5 rounded-md cyber-pill text-primary">${escapeHtml(plan.duration || '')}</span>
                                    <button onclick="deletePlan(${plan.id})" class="text-muted hover:text-rose-500 p-1">
                                        <span class="material-symbols-outlined text-[15px]">delete</span>
                                    </button>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            `;
        }
    });

    list.innerHTML = html;
}

function openPlanModal() {
    playHaptic('tap');
    MODAL_ACTION = 'plan';
    document.getElementById('modal-title').textContent = 'Add Weekly Plan';
    document.getElementById('modal-body').innerHTML = `
        <div>
            <label class="block text-[11px] font-bold uppercase text-muted mb-1">Day of Week</label>
            <select id="f-day" class="light-input text-xs font-bold">
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
            <label class="block text-[11px] font-bold uppercase text-muted mb-1">Target Duration</label>
            <input id="f-duration" type="text" placeholder="e.g. 2 hours" class="light-input text-xs"/>
        </div>
        <div>
            <label class="block text-[11px] font-bold uppercase text-muted mb-1">Activity / Focus</label>
            <input id="f-title" type="text" placeholder="e.g. Research Paper" class="light-input text-xs"/>
        </div>
    `;
    document.getElementById('modal-overlay').classList.remove('hidden');
}

async function togglePlanStatus(id, isDone) {
    playHaptic('tap');
    await api('/api/plans/' + id, 'PUT', { status: isDone ? 'completed' : 'pending' });
    loadPlans();
}

async function deletePlan(id) {
    playHaptic('tap');
    await api('/api/plans/' + id, 'DELETE');
    loadPlans();
    toast('Plan deleted', 'info');
}

async function loadTasks() {
    const data = await api('/api/tasks');
    const list = document.getElementById('task-list');
    if (!list) return;

    if (data.length === 0) {
        list.innerHTML = '<div class="glass-card rounded-3xl p-6 text-center text-muted font-medium">No tasks logged. Add your priorities!</div>';
        return;
    }

    list.innerHTML = data.map(t => {
        const dl = getTaskDeadlineBadge(t);
        const prioTag = t.priority === 'urgent' ? 'bg-rose-500/15 text-rose-600 dark:text-rose-400' : t.priority === 'high' ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400' : t.priority === 'low' ? 'bg-slate-500/10 text-muted' : 'bg-primary/10 text-primary';
        return `
            <div class="glass-card rounded-2xl p-3.5 flex items-center justify-between gap-3 ${t.done ? 'opacity-50' : ''}">
                <div class="flex items-center gap-3 flex-1 min-w-0">
                    <button onclick="toggleTask(${t.id}, ${t.done ? 0 : 1})" class="w-5 h-5 rounded-lg border-2 flex items-center justify-center ${t.done ? 'bg-primary border-primary text-white' : 'border-muted text-transparent hover:border-primary'} transition-colors shrink-0">
                        <span class="material-symbols-outlined text-[13px]">check</span>
                    </button>
                    <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2 mb-0.5 flex-wrap">
                            <span class="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md font-mono ${prioTag}">${t.priority || 'medium'}</span>
                            <span class="text-[9px] px-2 py-0.5 rounded-full font-mono ${dl.cls}">${dl.text}</span>
                        </div>
                        <p class="text-xs md:text-sm font-bold text-main ${t.done ? 'line-through' : ''}">${escapeHtml(t.title)}</p>
                        <p class="text-[9px] text-muted font-mono mt-0.5">${t.date || 'Today'} ${t.due_time ? '• ' + escapeHtml(t.due_time) : ''}${t.note ? ' • ' + escapeHtml(t.note) : ''}</p>
                    </div>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                    <button onclick="deleteTask(${t.id})" class="text-muted hover:text-rose-500 p-1.5 rounded-xl transition-colors">
                        <span class="material-symbols-outlined text-[16px]">delete</span>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

async function toggleTask(id, done) {
    playHaptic(done ? 'success' : 'tap');
    await api('/api/tasks/toggle', 'POST', { id, done });
    toast(done ? 'Task marked complete ✓' : 'Task reopened', done ? 'success' : 'info');
    loadTasks();
    loadSummary();
}

async function deleteTask(id) {
    playHaptic('tap');
    await api('/api/tasks', 'DELETE', { id });
    toast('Task deleted', 'info');
    loadTasks();
    loadSummary();
}

function openTaskModal() {
    playHaptic('tap');
    MODAL_ACTION = 'task';
    document.getElementById('modal-title').textContent = 'Add Priority Task & Deadline';
    document.getElementById('modal-body').innerHTML = `
        <div>
            <label class="block text-[11px] font-bold uppercase text-muted mb-1">Task Title</label>
            <input id="f-title" placeholder="e.g. Complete CSE 220 Lab Report" class="light-input text-xs"/>
        </div>
        <div class="grid grid-cols-2 gap-2.5">
            <div>
                <label class="block text-[11px] font-bold uppercase text-muted mb-1">Priority</label>
                <select id="f-priority" class="light-input text-xs font-bold">
                    <option value="urgent">🚨 Urgent (Due ASAP)</option>
                    <option value="high">🔥 High Priority</option>
                    <option value="medium" selected>⚡ Medium Priority</option>
                    <option value="low">☕ Low Priority</option>
                </select>
            </div>
            <div>
                <label class="block text-[11px] font-bold uppercase text-muted mb-1">Due Date</label>
                <input id="f-date" type="date" value="${new Date().toISOString().split('T')[0]}" class="light-input text-xs font-mono font-bold"/>
            </div>
        </div>
        <div>
            <label class="block text-[11px] font-bold uppercase text-muted mb-1">Due Time (Deadline)</label>
            <input id="f-due-time" type="text" value="11:59 PM" placeholder="e.g. 11:59 PM or 05:00 PM" class="light-input text-xs font-mono font-bold"/>
        </div>
        <div>
            <label class="block text-[11px] font-bold uppercase text-muted mb-1">Notes / Instructions (Optional)</label>
            <input id="f-note" placeholder="Chapters, assignment links or extra details" class="light-input text-xs"/>
        </div>
    `;
    document.getElementById('modal-overlay').classList.remove('hidden');
}

// ════════════════════════════════════════════════════════════════
//  EKKHU AI PERSONAL ASSISTANT & SMART FOCUS ENGINE
// ════════════════════════════════════════════════════════════════
let latestPABriefing = null;

// ── Real-Time Timestamp Persistence Engine ────────────────────────
function saveTimerPersistence() {
    if (!pomoIsRunning) {
        localStorage.removeItem('ekkhu_active_timer');
        return;
    }
    const state = {
        mode: pomoMode,
        task: pomoTaskLabel,
        customMins: pomoCustomMinutes,
        cycles: pomoCycles,
        cyclesDone: pomoCyclesDone,
        targetEndTime: pomoMode === 'stopwatch' ? null : (Date.now() + (pomoSecondsLeft * 1000)),
        stopwatchStartTime: pomoMode === 'stopwatch' ? (Date.now() - (pomoStopwatchSeconds * 1000)) : null,
        sessionStartIso: pomoSessionStart ? pomoSessionStart.toISOString() : new Date().toISOString()
    };
    try {
        localStorage.setItem('ekkhu_active_timer', JSON.stringify(state));
    } catch(e) {}
}

function clearTimerPersistence() {
    try {
        localStorage.removeItem('ekkhu_active_timer');
    } catch(e) {}
}

function restoreTimerPersistence() {
    try {
        const raw = localStorage.getItem('ekkhu_active_timer');
        if (!raw) return;
        const state = JSON.parse(raw);
        if (!state) return;

        pomoMode = state.mode || 'focus';
        pomoTaskLabel = state.task || 'Academic Deep Work';
        pomoCustomMinutes = state.customMins || 25;
        pomoCycles = state.cycles || 1;
        pomoCyclesDone = state.cyclesDone || 0;
        pomoSessionStart = state.sessionStartIso ? new Date(state.sessionStartIso) : new Date();

        const mInp = document.getElementById('pomo-task-label');
        const cInp = document.getElementById('pomo-task-label-card');
        if (mInp) mInp.value = pomoTaskLabel;
        if (cInp) cInp.value = pomoTaskLabel;

        if (pomoMode === 'stopwatch') {
            const elapsed = Math.max(0, Math.round((Date.now() - (state.stopwatchStartTime || Date.now())) / 1000));
            pomoStopwatchSeconds = elapsed;
            setPomodoroMode('stopwatch');
            startPomodoroTimer(false);
        } else {
            const remaining = Math.round(((state.targetEndTime || Date.now()) - Date.now()) / 1000);
            if (remaining > 0) {
                pomoSecondsLeft = remaining;
                if (pomoMode === 'custom') {
                    setPomodoroMode('custom');
                    setCustomMinutes(pomoCustomMinutes);
                    pomoSecondsLeft = remaining;
                } else {
                    setPomodoroMode(pomoMode);
                    pomoSecondsLeft = remaining;
                }
                startPomodoroTimer(false);
            } else {
                clearTimerPersistence();
                pomoSecondsLeft = 0;
                startSoftAlarm();
                updatePomodoroDisplay();
            }
        }
    } catch(e) {
        console.warn('[Timer] Could not restore timer:', e);
    }
}

function initPomodoroDisplay() {
    updatePomodoroDisplay();
    updateCycleProgressDots();
    restoreTimerPersistence();
    // Fetch initial PA suggestion briefing
    setTimeout(() => {
        if (!latestPABriefing) requestPABriefing('idle');
    }, 600);
}

function openPomodoroModal() {
    playHaptic('tap');
    const modal = document.getElementById('pomodoro-modal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.style.display = 'flex';
    }
    // Sync task label from card to modal
    const cardInput = document.getElementById('pomo-task-label-card');
    const modalInput = document.getElementById('pomo-task-label');
    if (cardInput && modalInput && cardInput.value && !modalInput.value) {
        modalInput.value = cardInput.value;
    }
    updatePomodoroDisplay();
    loadFocusStats();
    if (!latestPABriefing) {
        requestPABriefing('idle');
    }
}

function closePomodoroModal() {
    playHaptic('tap');
    const modal = document.getElementById('pomodoro-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
    }
    // Sync task label back to card
    const cardInput = document.getElementById('pomo-task-label-card');
    const modalInput = document.getElementById('pomo-task-label');
    if (cardInput && modalInput && modalInput.value) {
        cardInput.value = modalInput.value;
    }
}

// ════════════════════════════════════════════════════════════════
//  SOFT REPEATING MELODIC ALARM SYNTHESIZER (Web Audio API)
// ════════════════════════════════════════════════════════════════
function startSoftAlarm() {
    stopSoftAlarm();
    isSoftAlarmActive = true;

    const banner = document.getElementById('pomo-alarm-banner');
    if (banner) banner.classList.remove('hidden');

    const playHarmonicChime = () => {
        if (!isSoftAlarmActive) return;
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            // Gentle acoustic bell notes: C5 (523.25Hz), E5 (659.25Hz), G5 (783.99Hz), B5 (987.77Hz)
            const notes = [523.25, 659.25, 783.99, 987.77];
            notes.forEach((freq, index) => {
                const startTime = ctx.currentTime + (index * 0.16);
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();

                osc.type = 'sine';
                osc.frequency.setValueAtTime(freq, startTime);

                // Very smooth acoustic gain envelope
                gain.gain.setValueAtTime(0.0001, startTime);
                gain.gain.exponentialRampToValueAtTime(0.18, startTime + 0.05);
                gain.gain.exponentialRampToValueAtTime(0.0001, startTime + 1.2);

                osc.connect(gain);
                gain.connect(ctx.destination);

                osc.start(startTime);
                osc.stop(startTime + 1.2);
            });
        } catch (e) {
            console.debug('Soft alarm chime error:', e);
        }
    };

    playHarmonicChime();
    softAlarmInterval = setInterval(playHarmonicChime, 2500);
}

function stopSoftAlarm() {
    playHaptic('tap');
    isSoftAlarmActive = false;
    if (softAlarmInterval) {
        clearInterval(softAlarmInterval);
        softAlarmInterval = null;
    }
    const banner = document.getElementById('pomo-alarm-banner');
    if (banner) banner.classList.add('hidden');
}

function setPomodoroMode(mode) {
    playHaptic('tap');
    stopSoftAlarm();
    pomoMode = mode;
    pomoIsRunning = false;
    clearInterval(pomoTimer);

    const breakGuide = document.getElementById('pomo-break-guide');
    const customSel = document.getElementById('pomo-custom-selector');
    const cycleCont = document.getElementById('pomo-cycle-container');

    if (customSel) customSel.classList.toggle('hidden', mode !== 'custom');
    if (cycleCont) cycleCont.classList.toggle('hidden', mode !== 'focus');

    if (mode === 'focus') {
        pomoSecondsLeft = 25 * 60;
        if (breakGuide) breakGuide.classList.add('hidden');
    } else if (mode === 'custom') {
        pomoSecondsLeft = pomoCustomMinutes * 60;
        if (breakGuide) breakGuide.classList.add('hidden');
    } else if (mode === 'stopwatch') {
        pomoStopwatchSeconds = 0;
        if (breakGuide) breakGuide.classList.add('hidden');
    } else if (mode === 'short') {
        pomoSecondsLeft = 5 * 60;
        if (breakGuide) breakGuide.classList.remove('hidden');
        requestPABriefing('break_needed');
    } else if (mode === 'long') {
        pomoSecondsLeft = 15 * 60;
        if (breakGuide) breakGuide.classList.remove('hidden');
        requestPABriefing('break_needed');
    }

    pomoCyclesDone = 0;

    ['pomo-tab-focus', 'pomo-tab-custom', 'pomo-tab-stopwatch', 'pomo-tab-short', 'pomo-tab-long'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            const isAct = id === `pomo-tab-${mode}`;
            el.className = isAct 
                ? 'flex-1 min-w-[70px] py-1.5 rounded-lg text-xs font-bold bg-primary text-white transition-all shadow-sm' 
                : 'flex-1 min-w-[70px] py-1.5 rounded-lg text-xs font-bold text-muted transition-all';
        }
    });

    const badge = document.getElementById('pomo-mode-badge');
    if (badge) {
        badge.textContent = mode === 'focus' ? `${pomoCycles}× Focus` 
            : mode === 'custom' ? `${pomoCustomMinutes}m Custom` 
            : mode === 'stopwatch' ? `⏱️ Stopwatch` 
            : mode === 'short' ? '5m Break' : '15m Deep Rest';
    }

    updatePomodoroDisplay();
}

function setCustomMinutes(mins) {
    const val = parseInt(mins, 10);
    if (!val || isNaN(val) || val <= 0) return;
    playHaptic('tap');
    pomoCustomMinutes = Math.min(Math.max(val, 1), 360);
    pomoSecondsLeft = pomoCustomMinutes * 60;

    const lbl = document.getElementById('pomo-custom-duration-label');
    if (lbl) lbl.textContent = `${pomoCustomMinutes} Minutes`;
    const inp = document.getElementById('pomo-custom-min-input');
    if (inp) inp.value = pomoCustomMinutes;

    const badge = document.getElementById('pomo-mode-badge');
    if (badge && pomoMode === 'custom') badge.textContent = `${pomoCustomMinutes}m Custom`;
    const badgeCard = document.getElementById('pomo-card-duration');
    if (badgeCard && pomoMode === 'custom') badgeCard.textContent = `${pomoCustomMinutes}m custom`;

    updatePomodoroDisplay();
}

function setPomoCycles(n) {
    playHaptic('tap');
    pomoCycles = n;
    pomoCyclesDone = 0;
    pomoSecondsLeft = 25 * 60;
    pomoIsRunning = false;
    clearInterval(pomoTimer);

    // Update cycle selector buttons
    [1,2,3].forEach(i => {
        const el = document.getElementById(`pomo-cycle-${i}`);
        if (el) {
            el.className = i === n
                ? 'flex-1 py-1.5 rounded-lg text-xs font-bold bg-primary text-white transition-all shadow-sm'
                : 'flex-1 py-1.5 rounded-lg text-xs font-bold text-muted transition-all';
        }
    });

    const badge = document.getElementById('pomo-mode-badge');
    if (badge) badge.textContent = `${n}× Focus`;
    const badgeCard = document.getElementById('pomo-card-duration');
    if (badgeCard) badgeCard.textContent = `${n * 25}m total`;
    const modalSummary = document.getElementById('pomo-modal-cycle-summary');
    if (modalSummary) modalSummary.textContent = `${n} Cycle${n>1?'s':''} = ${n * 25}m Focus`;

    updatePomodoroDisplay();
    toast(`${n} cycle${n>1?'s':''} set — ${n*25} minutes total`, 'info');
}

function togglePomodoroTimer() {
    playHaptic('pop');
    stopSoftAlarm();
    if (pomoIsRunning) {
        pausePomodoroTimer();
    } else {
        startPomodoroTimer();
    }
}

function startPomodoroTimer(isFresh = true) {
    stopSoftAlarm();
    // Capture task label from input
    const modalInput = document.getElementById('pomo-task-label');
    const cardInput = document.getElementById('pomo-task-label-card');
    
    if (modalInput && modalInput.value.trim()) {
        pomoTaskLabel = modalInput.value.trim();
        if (cardInput) cardInput.value = pomoTaskLabel;
    } else if (cardInput && cardInput.value.trim()) {
        pomoTaskLabel = cardInput.value.trim();
        if (modalInput) modalInput.value = pomoTaskLabel;
    } else if (!pomoTaskLabel) {
        pomoTaskLabel = pomoMode === 'stopwatch' ? 'Open-ended Coding/Study' : 'Academic Deep Work';
    }

    if (isFresh && !pomoSessionStart) pomoSessionStart = new Date();

    pomoIsRunning = true;
    clearInterval(pomoTimer);
    saveTimerPersistence();

    // Trigger Ekkhu PA Kickoff Briefing
    if (isFresh && pomoMode === 'focus' && pomoCyclesDone === 0 && pomoSecondsLeft === 25 * 60) {
        requestPABriefing('start');
    }

    pomoTimer = setInterval(() => {
        if (pomoMode === 'stopwatch') {
            // Count up in stopwatch mode
            pomoStopwatchSeconds++;
            saveTimerPersistence();
            updatePomodoroDisplay();
        } else {
            // Count down in focus / custom / break modes
            if (pomoSecondsLeft > 0) {
                pomoSecondsLeft--;
                saveTimerPersistence();
                updatePomodoroDisplay();
            } else {
                clearInterval(pomoTimer);
                pomoIsRunning = false;
                clearTimerPersistence();
                startSoftAlarm();
                updateCycleProgressDots();

                if (pomoMode === 'focus') {
                    pomoCyclesDone++;
                    if (pomoCyclesDone < pomoCycles) {
                        pomoSecondsLeft = 25 * 60;
                        toast(`✅ Cycle ${pomoCyclesDone} done! Starting cycle ${pomoCyclesDone + 1}…`, 'success');
                        requestPABriefing('cycle_done');
                        setTimeout(() => startPomodoroTimer(true), 3000);
                    } else {
                        const totalMins = pomoCyclesDone * 25;
                        toast(`🎉 All ${pomoCycles} cycle${pomoCycles>1?'s':''} complete! ${totalMins} minutes of deep focus!`, 'success');
                        logFocusSession();
                        requestPABriefing('session_complete');
                        pomoSessionStart = null;
                        pomoCyclesDone = 0;
                        pomoSecondsLeft = 25 * 60;
                        updatePomodoroDisplay();
                        updateCycleProgressDots();
                        setTimeout(() => loadFocusStats(), 800);
                    }
                } else if (pomoMode === 'custom') {
                    toast(`🎯 Custom timer finished! ${pomoCustomMinutes} minutes logged.`, 'success');
                    logFocusSession(pomoCustomMinutes);
                    requestPABriefing('session_complete');
                    pomoSessionStart = null;
                    pomoSecondsLeft = pomoCustomMinutes * 60;
                    updatePomodoroDisplay();
                    setTimeout(() => loadFocusStats(), 800);
                } else {
                    toast(`⏰ Break time finished! Ready to focus?`, 'info');
                    requestPABriefing('start');
                    updatePomodoroDisplay();
                }
            }
        }
    }, 1000);

    updatePomodoroDisplay();
    updateCycleProgressDots();
}

function pausePomodoroTimer() {
    pomoIsRunning = false;
    clearInterval(pomoTimer);
    clearTimerPersistence();
    stopSoftAlarm();
    updatePomodoroDisplay();
}

function resetPomodoroTimer() {
    playHaptic('tap');
    stopSoftAlarm();
    pomoIsRunning = false;
    clearInterval(pomoTimer);
    clearTimerPersistence();
    if (pomoMode === 'focus') {
        pomoSecondsLeft = 25 * 60;
    } else if (pomoMode === 'custom') {
        pomoSecondsLeft = pomoCustomMinutes * 60;
    } else if (pomoMode === 'stopwatch') {
        pomoStopwatchSeconds = 0;
    }
    pomoCyclesDone = 0;
    pomoSessionStart = null;
    const breakGuide = document.getElementById('pomo-break-guide');
    if (breakGuide) breakGuide.classList.add('hidden');
    updatePomodoroDisplay();
    updateCycleProgressDots();
}

function updateCycleProgressDots() {
    const container = document.getElementById('pomo-cycle-dots');
    const cardContainer = document.getElementById('pomo-cycle-dots-card');
    [container, cardContainer].forEach(c => {
        if (!c) return;
        c.innerHTML = '';
        for (let i = 0; i < pomoCycles; i++) {
            const dot = document.createElement('div');
            const isDone = i < pomoCyclesDone;
            const isCurrent = i === pomoCyclesDone && pomoIsRunning;
            dot.className = isDone
                ? 'w-2.5 h-2.5 rounded-full bg-primary transition-all duration-500'
                : isCurrent
                    ? 'w-2.5 h-2.5 rounded-full bg-primary/50 animate-pulse transition-all duration-500'
                    : 'w-2.5 h-2.5 rounded-full border-2 border-primary/30 transition-all duration-500';
            c.appendChild(dot);
        }
    });
}

function updatePomodoroDisplay() {
    let timeStr = '25:00';
    if (pomoMode === 'stopwatch') {
        const sMins = Math.floor(pomoStopwatchSeconds / 60);
        const sSecs = pomoStopwatchSeconds % 60;
        timeStr = `${String(sMins).padStart(2, '0')}:${String(sSecs).padStart(2, '0')}`;
    } else {
        const mins = Math.floor(pomoSecondsLeft / 60);
        const secs = pomoSecondsLeft % 60;
        timeStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    ['pomo-display-time', 'pomo-modal-time', 'nav-pomo-time', 'island-pomo-timer'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = timeStr;
    });

    const quoteEl = document.getElementById('pomo-modal-quote');
    if (quoteEl) {
        if (pomoMode === 'stopwatch') {
            quoteEl.textContent = pomoIsRunning ? '⏱️ Stopwatch Active • Counting deep work time' : 'Ready to count open-ended sprint';
        } else if (pomoMode === 'custom') {
            quoteEl.textContent = `${pomoCustomMinutes}m Custom Sprint • Full dedication`;
        } else {
            quoteEl.textContent = 'Dedicate full attention to one single goal.';
        }
    }

    const pomoDot = document.getElementById('pomo-dot');
    if (pomoDot) {
        pomoDot.className = `w-2 h-2 rounded-full ${pomoIsRunning ? 'bg-primary animate-ping' : 'bg-emerald-500'}`;
    }

    const stateEl = document.getElementById('nav-pomo-state');
    if (stateEl) stateEl.textContent = pomoIsRunning ? (pomoMode === 'stopwatch' ? 'Counting' : 'Active') : 'Focus';

    const islandPomoStatus = document.getElementById('island-pomo-status');
    if (islandPomoStatus) islandPomoStatus.textContent = pomoIsRunning ? (pomoMode === 'stopwatch' ? 'Stopwatch On' : 'Focusing...') : 'Focus Ready';

    const modalIcon = document.getElementById('pomo-modal-icon');
    const modalText = document.getElementById('pomo-modal-text');
    const mainIcon = document.getElementById('pomo-btn-icon');

    if (modalIcon) modalIcon.textContent = pomoIsRunning ? 'pause' : 'play_arrow';
    if (modalText) modalText.textContent = pomoIsRunning ? 'Pause Session' : (pomoMode === 'stopwatch' ? (pomoStopwatchSeconds > 0 ? 'Resume Stopwatch' : 'Start Stopwatch') : (pomoCyclesDone > 0 ? `Resume Cycle ${pomoCyclesDone+1}` : 'Start Focus'));
    if (mainIcon) mainIcon.textContent = pomoIsRunning ? 'pause' : 'play_arrow';

    // Update cycle indicator in card
    const cycleInfo = document.getElementById('pomo-cycle-info');
    if (cycleInfo) {
        if (pomoMode === 'stopwatch') {
            cycleInfo.textContent = pomoIsRunning ? '⏱️ Stopwatch running' : 'Stopwatch mode';
        } else if (pomoMode === 'custom') {
            cycleInfo.textContent = `${pomoCustomMinutes}m Custom Timer`;
        } else if (pomoIsRunning || pomoCyclesDone > 0) {
            cycleInfo.textContent = `Cycle ${pomoCyclesDone + (pomoIsRunning ? 1 : 0)} of ${pomoCycles}`;
        } else {
            cycleInfo.textContent = `${pomoCycles} × 25min = ${pomoCycles * 25}min`;
        }
    }
}

// ════════════════════════════════════════════════════════════════
//  EKKHU JARVIS AI CLIENT ACTION EXECUTOR
// ════════════════════════════════════════════════════════════════
function executeClientActions(actions) {
    if (!Array.isArray(actions) || actions.length === 0) return;
    
    actions.forEach(action => {
        if (!action || typeof action !== 'object') return;
        const atype = action.type;

        if (atype === 'start_timer') {
            const mins = parseInt(action.minutes, 10) || 25;
            const cycles = parseInt(action.cycles, 10) || 1;
            const task = action.task || action.title || 'Focus Sprint';
            const mode = action.mode || (mins === 25 ? 'focus' : 'custom');

            pomoTaskLabel = task;
            const mInp = document.getElementById('pomo-task-label');
            const cInp = document.getElementById('pomo-task-label-card');
            if (mInp) mInp.value = task;
            if (cInp) cInp.value = task;

            if (mode === 'custom' || (mins !== 25 && cycles === 1)) {
                setPomodoroMode('custom');
                setCustomMinutes(mins);
            } else {
                setPomodoroMode('focus');
                setPomoCycles(cycles);
            }

            openPomodoroModal();
            startPomodoroTimer();
            toast(`🎯 Ekkhu started ${mins}m timer for "${task}"!`, 'success');
            playHaptic('pop');

        } else if (atype === 'start_stopwatch') {
            const task = action.task || action.title || 'Coding Sprint';
            pomoTaskLabel = task;
            const mInp = document.getElementById('pomo-task-label');
            const cInp = document.getElementById('pomo-task-label-card');
            if (mInp) mInp.value = task;
            if (cInp) cInp.value = task;

            setPomodoroMode('stopwatch');
            openPomodoroModal();
            startPomodoroTimer();
            toast(`⏱️ Ekkhu started stopwatch for "${task}"!`, 'success');
            playHaptic('pop');

        } else if (atype === 'stop_timer') {
            const task = action.task || pomoTaskLabel || 'Sprint';
            stopSoftAlarm();
            if (pomoIsRunning) {
                let loggedMins = 0;
                if (pomoMode === 'stopwatch') {
                    loggedMins = Math.max(1, Math.round(pomoStopwatchSeconds / 60));
                } else if (pomoMode === 'custom') {
                    loggedMins = pomoCustomMinutes;
                } else {
                    loggedMins = (pomoCyclesDone + 1) * 25;
                }
                logFocusSession(loggedMins);
                pausePomodoroTimer();
                toast(`🏁 Ekkhu stopped timer. ${loggedMins} minutes recorded for "${task}"!`, 'success');
            } else {
                toast(`Timer is not running`, 'info');
            }
            playHaptic('pop');
        }
    });
}

// ─── Ekkhu PA Assistant Focus Engine Handlers ────────────────────
async function requestPABriefing(stage = 'idle', userQuery = '') {
    const modalInput = document.getElementById('pomo-task-label');
    const cardInput = document.getElementById('pomo-task-label-card');
    const taskLabel = (modalInput && modalInput.value.trim()) || (cardInput && cardInput.value.trim()) || pomoTaskLabel || 'General Focus Session';

    const modalMsg = document.getElementById('pomo-pa-briefing-text');
    const cardMsg = document.getElementById('dash-pa-focus-text');

    if (userQuery) {
        if (modalMsg) modalMsg.innerHTML = '<span class="text-primary animate-pulse font-mono text-[11px]">এক্কু চিন্তা করছে...</span>';
        if (cardMsg) cardMsg.innerHTML = '<span class="text-primary animate-pulse font-mono text-[11px]">এক্কু চিন্তা করছে...</span>';
    }

    try {
        const payload = {
            stage: stage,
            task_label: taskLabel,
            cycles_done: pomoCyclesDone,
            cycles_planned: pomoCycles,
            elapsed_minutes: pomoCyclesDone * 25 + Math.floor((25 * 60 - pomoSecondsLeft) / 60),
            query: userQuery
        };

        const res = await fetch('/api/focus/pa_briefing', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken || '' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        latestPABriefing = data;

        if (modalMsg && data.message) modalMsg.textContent = data.message;
        if (cardMsg && data.message) cardMsg.textContent = data.message;

        // Render dynamic chips
        renderPAChips(data.pa_suggestions || []);

        // Break guide visibility
        const breakGuide = document.getElementById('pomo-break-guide');
        if (breakGuide) {
            if (stage === 'break_needed' || stage === 'cycle_done' || data.action_hint === 'break') {
                breakGuide.classList.remove('hidden');
            } else if (stage === 'start' || stage === 'in_progress') {
                breakGuide.classList.add('hidden');
            }
        }

        // Automatic voice briefing for active milestone events
        if (['start', 'break_needed', 'cycle_done', 'session_complete'].includes(stage)) {
            speakText(data.tts_text || data.message, data.emotion || 'neutral');
        }

    } catch (e) {
        console.warn('[Focus PA] Could not fetch briefing:', e);
    }
}

function renderPAChips(suggestions) {
    const containers = [
        document.getElementById('pomo-pa-chips-container'),
        document.getElementById('dash-pa-chips')
    ];

    if (!suggestions || suggestions.length === 0) return;

    containers.forEach(container => {
        if (!container) return;
        container.innerHTML = suggestions.map((chip, idx) => {
            const cleanChip = escapeHtml(chip);
            return `
                <button onclick="handlePAChipClick('${escapeHtml(chip).replace(/'/g, "\\'")}')" 
                    class="text-[10px] px-2.5 py-1 rounded-lg cyber-pill font-bold text-muted hover:text-primary hover:border-primary transition-all flex items-center gap-1">
                    <span class="material-symbols-outlined text-[12px] text-primary">arrow_right_alt</span> ${cleanChip}
                </button>
            `;
        }).join('');
    });
}

function handlePAChipClick(chipText) {
    playHaptic('tap');
    if (chipText.toLowerCase().includes('ব্রেক') || chipText.toLowerCase().includes('break') || chipText.toLowerCase().includes('পানি')) {
        askFocusPABreak();
    } else if (chipText.toLowerCase().includes('টাস্ক') || chipText.toLowerCase().includes('task') || chipText.toLowerCase().includes('রিভিশন')) {
        const modalInput = document.getElementById('pomo-task-label');
        const cardInput = document.getElementById('pomo-task-label-card');
        const cleanTitle = chipText.replace(/^[💧🎯📝⚡📋\s]+/, '').trim();
        if (modalInput) modalInput.value = cleanTitle;
        if (cardInput) cardInput.value = cleanTitle;
        pomoTaskLabel = cleanTitle;
        toast(`Task updated to "${cleanTitle}"`, 'info');
        requestPABriefing('query', `আমি "${cleanTitle}" শুরু করতে যাচ্ছি, আমাকে ২ লাইনে গাইড করো।`);
    } else {
        requestPABriefing('query', chipText);
    }
}

async function askFocusPAActivity() {
    playHaptic('pop');
    toast('Ekkhu PA analyzing schedule & priorities...', 'info');
    
    const modalMsg = document.getElementById('pomo-pa-briefing-text');
    const cardMsg = document.getElementById('dash-pa-focus-text');
    if (modalMsg) modalMsg.innerHTML = '<span class="text-primary animate-pulse font-mono text-[11px]">এক্কু শিডিউল ও টাস্ক অ্যানালাইজ করছে...</span>';
    if (cardMsg) cardMsg.innerHTML = '<span class="text-primary animate-pulse font-mono text-[11px]">এক্কু শিডিউল ও টাস্ক অ্যানালাইজ করছে...</span>';

    try {
        const res = await fetch('/api/focus/ai_suggest', {
            headers: { 'X-Session-Token': sessionToken || '' }
        });
        const data = await res.json();

        if (data.suggestions && data.suggestions.length > 0) {
            const top = data.suggestions[0];
            const modalInput = document.getElementById('pomo-task-label');
            const cardInput = document.getElementById('pomo-task-label-card');
            if (modalInput) modalInput.value = top.title;
            if (cardInput) cardInput.value = top.title;
            pomoTaskLabel = top.title;
            setPomoCycles(top.cycles || 1);

            const msgText = `🎯 Ekkhu PA Suggestion: "${top.title}" (${top.duration_label}) — ${top.reason}`;
            if (modalMsg) modalMsg.textContent = msgText;
            if (cardMsg) cardMsg.textContent = msgText;

            latestPABriefing = { message: msgText, tts_text: msgText, emotion: 'hopeful' };
            speakText(msgText, 'hopeful');

            const chips = data.suggestions.map(s => `${s.badge ? s.badge + ': ' : ''}${s.title}`);
            renderPAChips(chips);
            toast(`Top Focus Target: ${top.title}`, 'success');
        }
    } catch (e) {
        requestPABriefing('query', 'আজকের রুটিন অনুযায়ী আমার এখন কি পড়া উচিত?');
    }
}

function askFocusPABreak() {
    playHaptic('tap');
    requestPABriefing('break_needed', 'আমার কি এখন ব্রেক নেওয়া উচিত? কিভাবে সেরা রিফ্রেশমেন্ট ব্রেক নিব?');
    const breakGuide = document.getElementById('pomo-break-guide');
    if (breakGuide) breakGuide.classList.remove('hidden');
}

function askFocusPATask() {
    playHaptic('tap');
    const modalInput = document.getElementById('pomo-task-label');
    const cardInput = document.getElementById('pomo-task-label-card');
    const t = (modalInput && modalInput.value.trim()) || (cardInput && cardInput.value.trim()) || 'Current Task';
    requestPABriefing('query', `"${t}" এই টাস্কটা আমি কিভাবে সবচেয়ে সহজে ও দ্রুত শেষ করতে পারি?`);
}

function sendFocusPAChat() {
    playHaptic('pop');
    const input = document.getElementById('pomo-pa-quick-input');
    if (!input || !input.value.trim()) return;
    const q = input.value.trim();
    input.value = '';
    requestPABriefing('query', q);
}

function speakPABriefing() {
    playHaptic('tap');
    if (latestPABriefing) {
        speakText(latestPABriefing.tts_text || latestPABriefing.message, latestPABriefing.emotion || 'neutral');
        toast('Ekkhu PA speaking...', 'info');
    } else {
        requestPABriefing('idle');
    }
}

// ════════════════════════════════════════════════════════════════
//  EXECUTIVE DAILY BRIEFING ENGINE (Morning / Night / Midday)
// ════════════════════════════════════════════════════════════════
let currentExecutiveBriefingTTS = '';

async function loadExecutiveBriefing(forceRefresh) {
    try {
        const data = await api('/api/pa/daily_briefing');
        if (!data || !data.ok) return;

        const iconEl = document.getElementById('briefing-icon');
        const badgeEl = document.getElementById('briefing-badge');
        const timeTag = document.getElementById('briefing-time-tag');
        const msgEl = document.getElementById('briefing-message');
        const highEl = document.getElementById('briefing-highlights');

        if (iconEl) {
            const icons = { morning: 'wb_sunny', afternoon: 'light_mode', evening: 'wb_twilight', night: 'nights_stay' };
            iconEl.textContent = icons[data.period] || 'wb_sunny';
        }
        if (badgeEl) badgeEl.textContent = data.title || 'Executive Briefing';
        if (timeTag) {
            const now = new Date();
            timeTag.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        if (msgEl) msgEl.textContent = data.message;
        currentExecutiveBriefingTTS = data.tts_text || data.message;

        if (highEl && data.highlights) {
            highEl.innerHTML = data.highlights.map(h => `
                <span class="text-[10px] px-2.5 py-0.5 rounded-full cyber-pill font-mono font-bold text-muted">${escapeHtml(h)}</span>
            `).join('');
        }
    } catch (e) {
        console.error('Executive briefing load failed:', e);
    }
}

async function speakExecutiveBriefing() {
    if (!currentExecutiveBriefingTTS) {
        toast('No briefing audio available', 'info');
        return;
    }
    const icon = document.getElementById('briefing-speaker-icon');
    if (icon) icon.classList.add('animate-pulse', 'text-primary');
    try {
        playHaptic('tap');
        const res = await api('/tts', 'POST', { text: currentExecutiveBriefingTTS, emotion: 'hopeful' });
        if (res && res.audio) {
            const snd = new Audio(res.audio);
            snd.onended = () => { if (icon) icon.classList.remove('animate-pulse', 'text-primary'); };
            await snd.play();
        }
    } catch (e) {
        if (icon) icon.classList.remove('animate-pulse', 'text-primary');
        toast('Voice playback failed', 'error');
    }
}

// ════════════════════════════════════════════════════════════════
//  EXAMS & DEADLINES COUNTDOWN ENGINE
// ════════════════════════════════════════════════════════════════
async function loadExams() {
    try {
        const exams = await api('/api/exams');
        const list = document.getElementById('dash-exams-list');
        if (!list) return;

        if (!exams || exams.length === 0) {
            list.innerHTML = `
                <div class="p-4 rounded-2xl cyber-pill text-center text-muted text-xs font-medium">
                    No upcoming exams or quizzes scheduled. Click "+ Add Exam/Quiz" to track your next deadline.
                </div>
            `;
            return;
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        list.innerHTML = exams.map(e => {
            const eDate = new Date(e.date + 'T00:00:00');
            const diffDays = Math.round((eDate - today) / (1000 * 60 * 60 * 24));
            let badgeText = '';
            let badgeClass = '';

            if (diffDays < 0) {
                badgeText = 'Completed';
                badgeClass = 'bg-slate-500/15 text-muted';
            } else if (diffDays === 0) {
                badgeText = 'TODAY! 🔥';
                badgeClass = 'bg-rose-500/20 text-rose-600 dark:text-rose-400 animate-pulse';
            } else if (diffDays === 1) {
                badgeText = 'TOMORROW ⚡';
                badgeClass = 'bg-amber-500/20 text-amber-600 dark:text-amber-400';
            } else {
                badgeText = `In ${diffDays} days`;
                badgeClass = 'bg-primary/15 text-primary';
            }

            const typeColors = {
                'Midterm': 'text-purple-500 bg-purple-500/10 border-purple-500/20',
                'Final': 'text-rose-500 bg-rose-500/10 border-rose-500/20',
                'Quiz': 'text-amber-500 bg-amber-500/10 border-amber-500/20',
                'Class Test': 'text-cyan-500 bg-cyan-500/10 border-cyan-500/20',
                'Lab Exam': 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20',
                'Presentation': 'text-sky-500 bg-sky-500/10 border-sky-500/20'
            };
            const tColor = typeColors[e.type] || 'text-primary bg-primary/10 border-primary/20';

            return `
                <div class="glass-card rounded-2xl p-3.5 flex items-center justify-between gap-3 group hover:border-primary transition-all">
                    <div class="min-w-0">
                        <div class="flex items-center gap-2 mb-1 flex-wrap">
                            <span class="text-[9px] font-bold px-2 py-0.5 rounded-md border font-mono ${tColor}">${escapeHtml(e.type || 'Quiz')}</span>
                            <span class="text-xs font-black text-main font-mono">${escapeHtml(e.course || '')}</span>
                            <span class="text-[9px] font-bold px-2 py-0.5 rounded-full font-mono ${badgeClass}">${badgeText}</span>
                        </div>
                        <h4 class="text-xs font-bold text-main truncate">${escapeHtml(e.title)}</h4>
                        <p class="text-[10px] text-muted font-medium mt-0.5 truncate">${e.date} • ${escapeHtml(e.time || '10:00 AM')} ${e.notes ? '• ' + escapeHtml(e.notes) : ''}</p>
                    </div>
                    <div class="flex items-center gap-1 shrink-0">
                        <button onclick="openExamSurvivalModal(${e.id}, '${escapeHtml(e.course || '')}', '${escapeHtml(e.title || '')}', '${e.date}', '${escapeHtml(e.time || '10:00 AM')}')" class="cyber-pill px-2 py-1.5 rounded-xl text-[10px] font-bold text-rose-500 hover:bg-rose-500 hover:text-white transition-all flex items-center gap-1 border border-rose-500/30 shadow-sm" title="Launch 72-Hour Exam Survival Battle-station">
                            <span class="material-symbols-outlined text-[13px]">local_fire_department</span> 72h Survival
                        </button>
                        <button onclick="startFocusForExam('${escapeHtml(e.course || '')} ${escapeHtml(e.title || '')}')" class="cyber-pill px-2.5 py-1.5 rounded-xl text-[10px] font-bold text-primary hover:bg-primary hover:text-white transition-all flex items-center gap-1" title="Start focus session for this exam">
                            <span class="material-symbols-outlined text-[13px]">timer</span> Prep
                        </button>
                        <button onclick="deleteExam(${e.id})" class="text-muted hover:text-rose-500 p-1.5 rounded-xl transition-colors" title="Delete exam">
                            <span class="material-symbols-outlined text-[15px]">delete</span>
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    } catch (e) {
        console.error('Load exams error:', e);
    }
}

let currentSurvivalExam = null;

async function openExamSurvivalModal(id, course, title, dateStr, timeStr) {
    playHaptic('tap');
    const modal = document.getElementById('exam-survival-modal');
    if (!modal) return;

    currentSurvivalExam = { id, course, title, date: dateStr, time: timeStr };
    
    document.getElementById('survival-target-exam').textContent = `${course}: ${title} (${dateStr} at ${timeStr || '10:00 AM'})`;
    
    // Calculate hours remaining
    const examDate = new Date(`${dateStr}T${timeStr ? convert12To24(timeStr) : '10:00:00'}`);
    const now = new Date();
    const diffMs = examDate - now;
    const diffHours = Math.max(1, Math.round(diffMs / (1000 * 60 * 60)));
    const diffDays = Math.floor(diffHours / 24);
    const remHours = diffHours % 24;

    const clockEl = document.getElementById('survival-countdown-clock');
    if (clockEl) {
        clockEl.textContent = diffMs > 0 ? `T-Minus ${diffDays > 0 ? diffDays + 'd ' : ''}${remHours}h` : 'EXAM DAY / ACTIVE NOW!';
    }

    // Default loading state
    const p1Tasks = document.getElementById('p1-tasks');
    const p2Tasks = document.getElementById('p2-tasks');
    const p3Tasks = document.getElementById('p3-tasks');
    if (p1Tasks) p1Tasks.innerHTML = '<p class="text-xs text-muted font-mono animate-pulse">Strategizing tactical roadmap with AI...</p>';
    if (p2Tasks) p2Tasks.innerHTML = '<p class="text-xs text-muted font-mono animate-pulse">Calculating past paper drill times...</p>';
    if (p3Tasks) p3Tasks.innerHTML = '<p class="text-xs text-muted font-mono animate-pulse">Structuring active recall lock-in...</p>';

    modal.classList.remove('hidden');

    try {
        const plan = await api('/api/exam/survival_plan', 'POST', {
            course,
            title,
            hours_left: diffHours
        });

        const stratEl = document.getElementById('survival-strategy-summary');
        if (stratEl && plan.strategy_summary) {
            stratEl.innerHTML = `🎯 <strong>${escapeHtml(plan.headline || 'Strategy')}:</strong> ${escapeHtml(plan.strategy_summary)}`;
        }

        if (p1Tasks && plan.phase_1) {
            document.getElementById('p1-time').textContent = `${plan.phase_1.duration_hours || Math.round(diffHours * 0.5)}h Allocated`;
            p1Tasks.innerHTML = (plan.phase_1.tasks || []).map(t => `<p class="flex items-center gap-1.5"><span class="material-symbols-outlined text-[13px] text-primary">check_circle</span> ${escapeHtml(t)}</p>`).join('');
        }

        if (p2Tasks && plan.phase_2) {
            document.getElementById('p2-time').textContent = `${plan.phase_2.duration_hours || Math.round(diffHours * 0.35)}h Allocated`;
            p2Tasks.innerHTML = (plan.phase_2.tasks || []).map(t => `<p class="flex items-center gap-1.5"><span class="material-symbols-outlined text-[13px] text-amber-500">check_circle</span> ${escapeHtml(t)}</p>`).join('');
        }

        if (p3Tasks && plan.phase_3) {
            document.getElementById('p3-time').textContent = `${plan.phase_3.duration_hours || Math.round(diffHours * 0.15)}h Allocated`;
            p3Tasks.innerHTML = (plan.phase_3.tasks || []).map(t => `<p class="flex items-center gap-1.5"><span class="material-symbols-outlined text-[13px] text-emerald-500">check_circle</span> ${escapeHtml(t)}</p>`).join('');
        }
    } catch(e) {
        console.error('Survival plan error:', e);
    }
}

function closeExamSurvivalModal() {
    const modal = document.getElementById('exam-survival-modal');
    if (modal) modal.classList.add('hidden');
}

function launchSurvivalSprint(mins) {
    closeExamSurvivalModal();
    openPomodoroModal();
    const label = currentSurvivalExam ? `${currentSurvivalExam.course} Exam Survival Sprint` : 'Exam Survival Sprint';
    const inp = document.getElementById('pomo-task-label');
    if (inp) inp.value = label;
    setPomoCycles(mins >= 50 ? 2 : 1);
    startPomodoroTimer();
    toast(`Launched ${mins}m Tactical Exam Survival Sprint! 🔥`, 'success');
}

function convert12To24(timeStr) {
    const m = String(timeStr || '').match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
    if (!m) return '10:00:00';
    let h = parseInt(m[1], 10);
    const mins = m[2];
    const ap = (m[3] || '').toUpperCase();
    if (ap === 'PM' && h < 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${mins}:00`;
}

// ════════════════════════════════════════════════════════════════
//  📸 1-SNAP ROUTINE & TIMETABLE AI PARSER ENGINE
// ════════════════════════════════════════════════════════════════
let selectedRoutineFile = null;
let parsedRoutineClasses = [];

function openRoutineParserModal() {
    playHaptic('tap');
    const modal = document.getElementById('routine-parser-modal');
    if (!modal) return;
    selectedRoutineFile = null;
    parsedRoutineClasses = [];
    const prev = document.getElementById('routine-file-preview');
    if (prev) prev.classList.add('hidden');
    const resBox = document.getElementById('routine-parsed-results');
    if (resBox) resBox.classList.add('hidden');
    const txtInp = document.getElementById('routine-text-input');
    if (txtInp) txtInp.value = '';
    modal.classList.remove('hidden');
}

function closeRoutineParserModal() {
    const modal = document.getElementById('routine-parser-modal');
    if (modal) modal.classList.add('hidden');
}

function switchRoutineInputTab(tab) {
    playHaptic('tap');
    const imgTab = document.getElementById('r-tab-img');
    const txtTab = document.getElementById('r-tab-txt');
    const pImg = document.getElementById('r-panel-image');
    const pTxt = document.getElementById('r-panel-text');

    if (tab === 'image') {
        imgTab.className = 'flex-1 py-1.5 rounded-lg text-xs font-bold bg-primary text-white transition-all shadow-sm flex items-center justify-center gap-1.5';
        txtTab.className = 'flex-1 py-1.5 rounded-lg text-xs font-bold text-muted transition-all flex items-center justify-center gap-1.5';
        pImg.classList.remove('hidden');
        pTxt.classList.add('hidden');
    } else {
        txtTab.className = 'flex-1 py-1.5 rounded-lg text-xs font-bold bg-primary text-white transition-all shadow-sm flex items-center justify-center gap-1.5';
        imgTab.className = 'flex-1 py-1.5 rounded-lg text-xs font-bold text-muted transition-all flex items-center justify-center gap-1.5';
        pTxt.classList.remove('hidden');
        pImg.classList.add('hidden');
    }
}

function handleRoutineFileSelected(event) {
    const file = event.target.files[0];
    if (!file) return;
    selectedRoutineFile = file;
    const prev = document.getElementById('routine-file-preview');
    if (prev) {
        prev.textContent = `Selected: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
        prev.classList.remove('hidden');
    }
    toast(`Selected ${file.name}`, 'info');
}

async function parseRoutineAI() {
    const btn = document.getElementById('parse-routine-btn');
    const isImageTab = !document.getElementById('r-panel-image').classList.contains('hidden');
    const textVal = (document.getElementById('routine-text-input') || {}).value || '';

    if (isImageTab && !selectedRoutineFile) {
        toast('Please select an image or PDF routine file first', 'error');
        return;
    }
    if (!isImageTab && !textVal.trim()) {
        toast('Please paste your routine text or notice message', 'error');
        return;
    }

    playHaptic('pop');
    btn.disabled = true;
    btn.innerHTML = `<span class="material-symbols-outlined text-[17px] animate-spin">refresh</span> Analyzing Schedule with Vision AI...`;

    try {
        let resp;
        if (isImageTab && selectedRoutineFile) {
            const formData = new FormData();
            formData.append('file', selectedRoutineFile);
            resp = await fetch('/api/routine/parse', {
                method: 'POST',
                headers: { 'X-Session-Token': sessionToken || '' },
                body: formData
            }).then(r => r.json());
        } else {
            resp = await api('/api/routine/parse', 'POST', { text: textVal });
        }

        if (!resp.ok || !resp.classes || resp.classes.length === 0) {
            toast('Could not identify classes from input. Please try a clearer image or paste text.', 'error');
            return;
        }

        parsedRoutineClasses = resp.classes;
        renderParsedRoutineResults();
        toast(`Extracted ${resp.classes.length} classes successfully!`, 'success');
    } catch(e) {
        console.error('Routine parse error:', e);
        toast('Failed to parse routine. Please check internet connection.', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<span class="material-symbols-outlined text-[17px]">auto_awesome</span> Parse Schedule with AI`;
    }
}

function renderParsedRoutineResults() {
    const resBox = document.getElementById('routine-parsed-results');
    const countEl = document.getElementById('parsed-classes-count');
    const list = document.getElementById('parsed-classes-list');
    if (!resBox || !list) return;

    countEl.textContent = parsedRoutineClasses.length;
    
    list.innerHTML = parsedRoutineClasses.map((c, idx) => `
        <div class="glass-card rounded-xl p-2.5 flex items-center justify-between gap-2 text-xs">
            <div class="flex items-center gap-2 flex-1 min-w-0">
                <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${c.color || 'var(--primary)'}"></span>
                <span class="font-mono font-bold text-primary shrink-0">${escapeHtml(c.day)} ${escapeHtml(c.time)}</span>
                <span class="font-bold text-main truncate">${escapeHtml(c.course)}</span>
                <span class="text-[10px] text-muted truncate">${c.room ? 'Room ' + escapeHtml(c.room) : ''} ${c.prof ? '• ' + escapeHtml(c.prof) : ''}</span>
            </div>
            <button onclick="removeParsedClass(${idx})" class="text-muted hover:text-rose-500 p-1 shrink-0" title="Remove class">
                <span class="material-symbols-outlined text-[15px]">close</span>
            </button>
        </div>
    `).join('');

    resBox.classList.remove('hidden');
}

function removeParsedClass(idx) {
    playHaptic('tap');
    parsedRoutineClasses.splice(idx, 1);
    renderParsedRoutineResults();
}

async function importParsedRoutine() {
    if (!parsedRoutineClasses || parsedRoutineClasses.length === 0) {
        toast('No classes to import', 'error');
        return;
    }
    const replaceAll = document.getElementById('routine-replace-all')?.checked ?? true;
    
    try {
        playHaptic('success');
        await api('/api/routine/batch_import', 'POST', {
            classes: parsedRoutineClasses,
            replace_all: replaceAll
        });
        toast(`Imported ${parsedRoutineClasses.length} classes into your Routine! 🎉`, 'success');
        closeRoutineParserModal();
        loadRoutine();
        loadSummary();
    } catch(e) {
        toast('Failed to import classes', 'error');
    }
}

function startFocusForExam(label) {
    openPomodoroModal();
    const inp = document.getElementById('pomo-task-label');
    if (inp) inp.value = label + ' Preparation';
    setPomoCycles(2);
    setTimeout(() => {
        requestPABriefing('start', `Preparing for upcoming ${label}`);
    }, 300);
}

function openExamModal() {
    playHaptic('tap');
    const modal = document.getElementById('exam-modal');
    if (!modal) return;
    const dInp = document.getElementById('exam-date-input');
    if (dInp && !dInp.value) {
        const tom = new Date();
        tom.setDate(tom.getDate() + 3);
        dInp.value = tom.toISOString().split('T')[0];
    }
    modal.classList.remove('hidden');
}

function closeExamModal() {
    const modal = document.getElementById('exam-modal');
    if (modal) modal.classList.add('hidden');
}

async function saveExamEntry() {
    const title = (document.getElementById('exam-title-input') || {}).value || '';
    const course = (document.getElementById('exam-course-input') || {}).value || '';
    const type = (document.getElementById('exam-type-input') || {}).value || 'Quiz';
    const date = (document.getElementById('exam-date-input') || {}).value || '';
    const time = (document.getElementById('exam-time-input') || {}).value || '10:00 AM';
    const notes = (document.getElementById('exam-notes-input') || {}).value || '';

    if (!title.trim() || !course.trim() || !date) {
        toast('Please provide Title, Course Code, and Date', 'error');
        return;
    }

    try {
        playHaptic('success');
        await api('/api/exams', 'POST', { title, course, type, date, time, notes });
        toast(`Scheduled ${type}: ${course}`, 'success');
        closeExamModal();
        loadExams();
        loadSummary();
    } catch (e) {
        toast('Failed to save exam entry', 'error');
    }
}

async function deleteExam(id) {
    playHaptic('tap');
    try {
        await api('/api/exams', 'DELETE', { id });
        toast('Exam removed', 'info');
        loadExams();
        loadSummary();
    } catch (e) {
        toast('Failed to delete exam', 'error');
    }
}

function exportRoutineToICS() {
    playHaptic('success');
    window.open('/api/routine/export_ics', '_blank');
    toast('Downloading .ICS Calendar schedule...', 'success');
}

// ════════════════════════════════════════════════════════════════
//  ACTIVE RECALL FLASHCARDS & REVISION SUMMARIZER
// ════════════════════════════════════════════════════════════════
function toggleFlashcardPanel() {
    const panel = document.getElementById('pomo-flashcard-panel');
    const toggle = document.getElementById('pomo-flash-toggle');
    if (!panel) return;
    const isHidden = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !isHidden);
    if (toggle) toggle.textContent = isHidden ? 'Hide Hub ▴' : 'Show Hub ▾';
}

async function generateFlashcardsFromInput() {
    const inp = document.getElementById('pomo-flash-topic');
    const val = (inp ? inp.value : '').trim();
    if (!val) {
        toast('Please enter a topic or lecture concept', 'info');
        return;
    }

    const summaryBox = document.getElementById('pomo-flash-summary');
    const cardsCont = document.getElementById('pomo-flash-cards');
    if (summaryBox) {
        summaryBox.classList.remove('hidden');
        summaryBox.innerHTML = '<span class="text-primary font-bold animate-pulse">🤖 Ekkhu AI is analyzing study concepts and synthesizing flashcards...</span>';
    }

    try {
        playHaptic('tap');
        const res = await api('/api/study/generate_flashcards', 'POST', { topic: val, content: val });
        if (!res || !res.ok || !res.data) {
            toast('Failed to generate flashcards', 'error');
            return;
        }

        const data = res.data;
        if (summaryBox) {
            summaryBox.innerHTML = `<span class="font-bold text-amber-600 dark:text-amber-400 block mb-1">📖 5-Minute Key Concept Summary:</span> ${escapeHtml(data.summary)}`;
        }

        if (cardsCont && data.flashcards) {
            cardsCont.innerHTML = data.flashcards.map((f, idx) => `
                <div onclick="flipFlashcard(this)" class="glass-card rounded-2xl p-4 cursor-pointer hover:border-amber-500 transition-all border border-amber-500/15 relative min-h-[110px] flex flex-col justify-between group">
                    <div>
                        <div class="flex justify-between items-center mb-1.5">
                            <span class="text-[9px] font-bold px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-400 font-mono">${escapeHtml(f.tag || 'Concept')} #${idx+1}</span>
                            <span class="text-[9px] text-muted group-hover:text-primary font-bold">Tap to flip ↻</span>
                        </div>
                        <p class="flash-q text-xs font-bold text-main leading-snug">${escapeHtml(f.question)}</p>
                        <p class="flash-a hidden text-xs font-medium text-emerald-600 dark:text-emerald-400 leading-relaxed mt-1">${escapeHtml(f.answer)}</p>
                    </div>
                </div>
            `).join('');
        }
        toast('Generated 4 Active Recall Flashcards!', 'success');
    } catch (e) {
        toast('Generation error', 'error');
    }
}

function flipFlashcard(cardEl) {
    playHaptic('tap');
    const q = cardEl.querySelector('.flash-q');
    const a = cardEl.querySelector('.flash-a');
    if (!q || !a) return;
    const isShowingQ = !q.classList.contains('hidden');
    q.classList.toggle('hidden', isShowingQ);
    a.classList.toggle('hidden', !isShowingQ);
    cardEl.classList.toggle('border-emerald-500', isShowingQ);
}

async function logFocusSession(customMins = null) {
    try {
        const totalMinutes = customMins ? parseInt(customMins, 10) : (pomoCyclesDone * 25);
        await api('/api/focus/log', 'POST', {
            task_label: pomoTaskLabel || 'Academic Focus',
            cycles_planned: pomoCycles || 1,
            cycles_done: pomoCyclesDone || 1,
            total_minutes: totalMinutes,
            started_at: pomoSessionStart ? pomoSessionStart.toISOString() : new Date().toISOString()
        });
    } catch(e) {
        console.warn('[Focus] Could not log session:', e);
    }
}

async function loadFocusStats() {
    try {
        const stats = await api('/api/focus/stats');
        renderFocusStats(stats);
    } catch(e) {
        console.warn('[Focus] Could not load stats:', e);
    }
}

function renderFocusStats(stats) {
    if (!stats) return;

    // --- Total Stats Banner ---
    const totals = stats.totals || {};
    const elTotalMin = document.getElementById('focus-total-minutes');
    const elTotalSess = document.getElementById('focus-total-sessions');
    const elTotalCyc = document.getElementById('focus-total-cycles');
    if (elTotalMin) elTotalMin.textContent = (totals.total_minutes || 0) + 'm';
    if (elTotalSess) elTotalSess.textContent = totals.total_sessions || 0;
    if (elTotalCyc) elTotalCyc.textContent = totals.total_cycles || 0;

    // --- Weekly Chart ---
    renderFocusWeeklyChart(stats.weekly || []);

    // --- Task Breakdown Chart ---
    renderFocusTaskChart(stats.tasks || []);

    // --- Recent Sessions List ---
    renderRecentSessions(stats.recent || []);
}

function renderFocusWeeklyChart(weekData) {
    const canvas = document.getElementById('focus-weekly-chart');
    if (!canvas) return;

    // Build full week Mon→Sun with 0s for missing days
    const today = new Date();
    const dayOfWeek = today.getDay(); // 0=Sun
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((dayOfWeek + 6) % 7));

    const labels = [];
    const values = [];
    const dataMap = {};
    weekData.forEach(r => { dataMap[r.date] = r.mins; });

    const dayNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    for (let i = 0; i < 7; i++) {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        const key = d.toISOString().split('T')[0];
        labels.push(dayNames[i]);
        values.push(dataMap[key] || 0);
    }

    if (window._focusWeekChart) window._focusWeekChart.destroy();
    const ctx = canvas.getContext('2d');
    const rootStyle = getComputedStyle(document.documentElement);
    const primaryColor = rootStyle.getPropertyValue('--color-primary').trim() || '#e11d48';

    window._focusWeekChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Focus Minutes',
                data: values,
                backgroundColor: values.map((v, i) => {
                    const isToday = i === ((today.getDay() + 6) % 7);
                    return isToday ? primaryColor : primaryColor + '55';
                }),
                borderRadius: 8,
                borderSkipped: false,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { grid: { display: false }, ticks: { color: '#888', font: { size: 10, weight: 'bold' } } },
                y: { grid: { color: 'rgba(128,128,128,0.1)' }, ticks: { color: '#888', font: { size: 10 } }, beginAtZero: true }
            }
        }
    });
}

function renderFocusTaskChart(taskData) {
    const canvas = document.getElementById('focus-task-chart');
    if (!canvas) return;
    if (!taskData.length) {
        canvas.parentElement.innerHTML = '<p class="text-xs text-muted text-center py-4 font-medium">No task data yet. Label your next session!</p>';
        return;
    }

    if (window._focusTaskChart) window._focusTaskChart.destroy();
    const ctx = canvas.getContext('2d');
    const rootStyle = getComputedStyle(document.documentElement);
    const primaryColor = rootStyle.getPropertyValue('--color-primary').trim() || '#e11d48';

    window._focusTaskChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: taskData.map(t => t.task_label.length > 18 ? t.task_label.slice(0,18)+'…' : t.task_label),
            datasets: [{
                label: 'Minutes',
                data: taskData.map(t => t.mins),
                backgroundColor: primaryColor + '99',
                borderRadius: 6,
                borderSkipped: false,
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { grid: { color: 'rgba(128,128,128,0.1)' }, ticks: { color: '#888', font: { size: 10 } }, beginAtZero: true },
                y: { grid: { display: false }, ticks: { color: '#888', font: { size: 10, weight: 'bold' } } }
            }
        }
    });
}

function renderRecentSessions(sessions) {
    const container = document.getElementById('focus-recent-list');
    if (!container) return;
    if (!sessions.length) {
        container.innerHTML = '<p class="text-xs text-muted text-center py-3 font-medium">No sessions yet. Start your first focus session!</p>';
        return;
    }
    container.innerHTML = sessions.map(s => {
        const label = s.task_label || 'Untitled Session';
        const date = s.date || '';
        const mins = s.total_minutes || 0;
        const cycles = s.cycles_done || 1;
        const dots = Array(cycles).fill('●').join(' ');
        return `
        <div class="flex items-center justify-between py-2 border-b last:border-0" style="border-color:var(--border-subtle)">
            <div class="flex items-center gap-2.5 min-w-0">
                <div class="w-7 h-7 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <span class="material-symbols-outlined text-[13px] text-primary">timer</span>
                </div>
                <div class="min-w-0">
                    <p class="text-[11px] font-bold text-main truncate">${escapeHtml(label)}</p>
                    <p class="text-[10px] text-muted font-mono">${date}</p>
                </div>
            </div>
            <div class="text-right flex-shrink-0 ml-2">
                <p class="text-[11px] font-black text-primary">${mins}m</p>
                <p class="text-[10px] text-muted">${dots}</p>
            </div>
        </div>`;
    }).join('');
}

function playCompletionChime() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.3);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.8);
    } catch (e) { }
}

function toggleAmbientSound(type) {
    playHaptic('tap');
    currentAmbientType = type;

    ['ambient-rain', 'ambient-whitenoise', 'ambient-off'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            const isAct = id === `ambient-${type}`;
            el.classList.toggle('border-primary', isAct);
            el.classList.toggle('bg-primary/10', isAct);
            el.classList.toggle('text-primary', isAct);
        }
    });

    if (type === 'off') {
        stopAmbientSound();
        return;
    }

    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();

        stopAmbientSound();

        const bufferSize = audioCtx.sampleRate * 2;
        const noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
        const output = noiseBuffer.getChannelData(0);

        if (type === 'whitenoise') {
            for (let i = 0; i < bufferSize; i++) {
                output[i] = Math.random() * 2 - 1;
            }
        } else if (type === 'rain') {
            let lastOut = 0.0;
            for (let i = 0; i < bufferSize; i++) {
                const white = Math.random() * 2 - 1;
                output[i] = (lastOut + (0.02 * white)) / 1.02;
                lastOut = output[i];
                output[i] *= 3.5;
            }
        }

        ambientSource = audioCtx.createBufferSource();
        ambientSource.buffer = noiseBuffer;
        ambientSource.loop = true;

        ambientGain = audioCtx.createGain();
        ambientGain.gain.setValueAtTime(0.08, audioCtx.currentTime);

        ambientSource.connect(ambientGain);
        ambientGain.connect(audioCtx.destination);
        ambientSource.start();

    } catch (e) { }
}

function stopAmbientSound() {
    if (ambientSource) {
        try { ambientSource.stop(); } catch (e) { }
        ambientSource = null;
    }
}

// ════════════════════════════════════════════════════════════════
//  ✨ 3D CYBER ROBOT INTERACTIVE PHYSICS & GYROSCOPE ENGINE
// ════════════════════════════════════════════════════════════════
function initRobotInteractivePhysics() {
    // 1. Mouse Tracking (Desktop)
    window.addEventListener('mousemove', (e) => {
        const cx = window.innerWidth / 2;
        const cy = window.innerHeight / 2;
        const dx = (e.clientX - cx) / cx;
        const dy = (e.clientY - cy) / cy;

        applyRobotTilt(dx, dy);
    });

    // 2. Gyroscope Device Orientation Tracking (Mobile Phone Tilt!)
    if (window.DeviceOrientationEvent) {
        window.addEventListener('deviceorientation', (e) => {
            if (e.gamma !== null && e.beta !== null) {
                const dx = Math.min(Math.max(e.gamma / 45, -1), 1);
                const dy = Math.min(Math.max((e.beta - 45) / 45, -1), 1);
                applyRobotTilt(dx, dy);
            }
        });
    }

    // 3. Touch Drag Parallax fallback
    window.addEventListener('touchmove', (e) => {
        if (e.touches.length > 0) {
            const touch = e.touches[0];
            const cx = window.innerWidth / 2;
            const cy = window.innerHeight / 2;
            const dx = (touch.clientX - cx) / cx;
            const dy = (touch.clientY - cy) / cy;
            applyRobotTilt(dx, dy);
        }
    }, { passive: true });
}

function applyRobotTilt(dx, dy) {
    const deskHead = document.getElementById('desk-robot-body');
    if (deskHead) {
        const rotX = -dy * 14;
        const rotY = dx * 16;
        deskHead.style.transform = `perspective(800px) rotateX(${rotX}deg) rotateY(${rotY}deg) translateY(-6px)`;
    }

    const mobHead = document.getElementById('mob-robot-body');
    if (mobHead) {
        const rotX = -dy * 12;
        const rotY = dx * 14;
        mobHead.style.transform = `perspective(800px) rotateX(${rotX}deg) rotateY(${rotY}deg) translateY(-4px)`;
    }

    const floatPet = document.getElementById('float-pet-body');
    if (floatPet) {
        const rotX = -dy * 8;
        const rotY = dx * 10;
        floatPet.style.transform = `perspective(600px) rotateX(${rotX}deg) rotateY(${rotY}deg)`;
    }

    const pupilOffsetMax = 5.5;
    const px = dx * pupilOffsetMax;
    const py = dy * (pupilOffsetMax * 0.7);

    ['desk-pupil-l', 'desk-pupil-r', 'mob-pupil-l', 'mob-pupil-r'].forEach(id => {
        const p = document.getElementById(id);
        if (p) {
            p.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px))`;
        }
    });

    ['desk-eyes-row', 'mob-eyes-row'].forEach(id => {
        const row = document.getElementById(id);
        if (row) {
            row.style.transform = `translate(${dx * 3}px, ${dy * 2}px)`;
        }
    });
}

function playRobotChirp() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(650, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.12);
        osc.frequency.exponentialRampToValueAtTime(900, ctx.currentTime + 0.22);
        gain.gain.setValueAtTime(0.18, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.28);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.28);
    } catch (e) { }
}

function pokeRobot(type) {
    playRobotChirp();
    playHaptic('pop');

    const avatars = [
        document.getElementById('desk-neural-avatar'),
        document.getElementById('mob-neural-avatar')
    ];

    avatars.forEach(av => {
        if (!av) return;
        av.classList.remove('state-idle', 'state-listening', 'state-thinking', 'state-speaking');
        av.classList.add('state-speaking');
        setTimeout(() => {
            if (chatMode !== 'voice' || (mediaRecorder && mediaRecorder.state === 'inactive')) {
                av.classList.remove('state-speaking');
                av.classList.add('state-idle');
            }
        }, 1200);
    });

    const greetings = [
        "Beep boop! Ready to help you study! 🤖",
        "Hey! Need help with your routine or grades?",
        "All systems optimal, scholar! ✨",
        "Ready to listen! Tap 'Start Talking' anytime."
    ];
    const picked = greetings[Math.floor(Math.random() * greetings.length)];
    toast(picked, 'info');
}

// ════════════════════════════════════════════════════════════════
//  EKKHU AI CHAT & SENTIENT AVATAR ENGINE
// ════════════════════════════════════════════════════════════════
function abortAllRecognition() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        audioChunks = [];
        mediaRecorder.stop();
    }
    setVoiceUIState('idle');
}

function switchChatMode(mode) {
    playHaptic('tap');
    abortAllRecognition();
    chatMode = mode;
    const isVoice = mode === 'voice';

    // Desktop
    const dTextBtn = document.getElementById('desk-mode-text');
    const dVoiceBtn = document.getElementById('desk-mode-voice');
    const dTextVw = document.getElementById('desk-text-view');
    const dVoiceVw = document.getElementById('desk-voice-view');

    if (dTextBtn && dVoiceBtn) {
        dTextBtn.className = isVoice ? 'px-4 py-1.5 text-xs font-bold rounded-lg text-muted hover:text-main transition-all' : 'px-4 py-1.5 text-xs font-bold rounded-lg bg-primary text-white shadow-sm transition-all';
        dVoiceBtn.className = isVoice ? 'px-4 py-1.5 text-xs font-bold rounded-lg bg-primary text-white shadow-sm transition-all' : 'px-4 py-1.5 text-xs font-bold rounded-lg text-muted hover:text-main transition-all';
        if (dTextVw) dTextVw.classList.toggle('hidden', isVoice);
        if (dVoiceVw) dVoiceVw.classList.toggle('hidden', !isVoice);
    }

    // Mobile
    const mTextBtn = document.getElementById('mob-mode-text');
    const mVoiceBtn = document.getElementById('mob-mode-voice');
    const mTextVw = document.getElementById('mob-text-view');
    const mVoiceVw = document.getElementById('mob-voice-view');

    if (mTextBtn && mVoiceBtn) {
        mTextBtn.className = isVoice ? 'px-3 py-1 text-[11px] font-bold rounded-lg text-muted transition-all' : 'px-3 py-1 text-[11px] font-bold rounded-lg bg-primary text-white shadow-sm transition-all';
        mVoiceBtn.className = isVoice ? 'px-3 py-1 text-[11px] font-bold rounded-lg bg-primary text-white shadow-sm transition-all' : 'px-3 py-1 text-[11px] font-bold rounded-lg text-muted transition-all';
        if (mTextVw) {
            mTextVw.classList.toggle('hidden', isVoice);
            mTextVw.style.display = isVoice ? 'none' : 'flex';
        }
        if (mVoiceVw) {
            mVoiceVw.classList.toggle('hidden', !isVoice);
            mVoiceVw.style.display = isVoice ? 'flex' : 'none';
        }
    }

    if (!isVoice) {
        if (isDesktopDevice()) loadDesktopChatHistory();
        else loadMobileChatHistory();
    }
}

function getChatInput() {
    return isDesktopDevice() ? document.getElementById('desk-chat-input') : document.getElementById('chat-input');
}

function addChatMsg(text, sender, emotion = null) {
    const cont = document.getElementById('chat-messages');
    if (!cont) return;
    const clean = sanitizeChatMessage(text);
    if (!clean) return;
    const div = document.createElement('div');
    div.className = sender === 'user' ? 'flex justify-end animate-fade-up' : 'flex justify-start animate-fade-up';
    if (sender === 'user') {
        div.innerHTML = `<div class="cyber-glow-btn text-white rounded-2xl rounded-tr-sm px-3.5 py-2 max-w-[82%] text-xs shadow-md font-medium">${escapeHtml(clean)}</div>`;
    } else {
        const em = emotion ? `<span class="emotion-tag">${escapeHtml(emotion)}</span>` : '';
        div.innerHTML = `<div class="cyber-pill rounded-2xl rounded-tl-sm px-3.5 py-2.5 max-w-[88%] text-xs text-main shadow-sm"><p class="inline leading-relaxed">${escapeHtml(clean)}</p>${em}</div>`;
    }
    cont.appendChild(div);
    cont.scrollTop = cont.scrollHeight;
}

function addDesktopMsg(text, sender, emotion = null) {
    const cont = document.getElementById('desk-chat-messages');
    if (!cont) return;
    const clean = sanitizeChatMessage(text);
    if (!clean) return;
    const empty = document.getElementById('desk-chat-empty');
    if (empty) empty.remove();
    hideChatTyping();

    const wrap = document.createElement('div');
    wrap.className = 'chat-msg ' + (sender === 'user' ? 'flex justify-end animate-fade-up' : 'flex justify-start animate-fade-up');

    if (sender === 'user') {
        wrap.innerHTML = `<div class="max-w-[80%] cyber-glow-btn text-white rounded-2xl rounded-tr-sm px-5 py-3 shadow-lg font-medium text-xs md:text-sm">
            <p class="whitespace-pre-wrap leading-relaxed">${escapeHtml(clean)}</p>
        </div>`;
    } else {
        const em = emotion ? `<span class="emotion-tag">${escapeHtml(emotion)}</span>` : '';
        wrap.innerHTML = `<div class="max-w-[92%] glass-card rounded-2xl rounded-tl-sm px-5 py-4 shadow-sm">
            <div class="flex items-center gap-2.5 mb-2.5">
                <span class="w-7 h-7 rounded-xl bg-primary/10 text-primary flex items-center justify-center shadow-sm border border-primary/20">
                    <span class="material-symbols-outlined text-[16px]">smart_toy</span>
                </span>
                <span class="text-[10px] font-bold text-primary uppercase tracking-wider font-mono">EKKHU CYBER COMPANION</span>${em}
            </div>
            <div class="markdown-body text-xs md:text-sm text-main">${renderMarkdown(clean)}</div>
        </div>`;
    }
    cont.appendChild(wrap);
    cont.scrollTop = cont.scrollHeight;
}

async function loadMobileChatHistory() {
    const cont = document.getElementById('chat-messages');
    if (!cont) return;
    try {
        const history = await api('/api/chat/history');
        if (!history || history.length === 0) {
            if (cont.children.length === 0) {
                addChatMsg("কি অবস্থা! ক্লাস কেমন চলছে? যেকোনো একাডেমিক হেল্প লাগলে বলো। 😄", 'assistant', 'happy');
            }
            return;
        }
        cont.innerHTML = '';
        history.forEach(h => addChatMsg(stripTimestamp(h.content), h.role, h.emotion));
    } catch (e) { }
}

async function loadDesktopChatHistory() {
    if (!isDesktopDevice()) return;
    try {
        const history = await api('/api/chat/history');
        if (!history || history.length === 0) return;
        const empty = document.getElementById('desk-chat-empty');
        if (empty) empty.remove();
        history.forEach(h => addDesktopMsg(stripTimestamp(h.content), h.role, h.emotion));
    } catch (e) { }
}

function showChatTyping() {
    const isDesktop = isDesktopDevice();
    const cont = isDesktop ? document.getElementById('desk-chat-messages') : document.getElementById('chat-messages');
    if (!cont || document.getElementById('chat-typing-indicator') || document.getElementById('desk-typing')) return;

    if (isDesktop) {
        const empty = document.getElementById('desk-chat-empty');
        if (empty) empty.remove();
    }

    const d = document.createElement('div');
    d.id = isDesktop ? 'desk-typing' : 'chat-typing-indicator';
    d.className = isDesktop ? 'chat-msg flex justify-start animate-fade-in my-1' : 'flex justify-start animate-fade-in my-1.5';
    
    if (isDesktop) {
        d.innerHTML = `<div class="glass-card rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm flex items-center gap-2.5 max-w-[90px]">
            <span class="w-6 h-6 rounded-lg bg-primary/10 text-primary flex items-center justify-center border border-primary/20 shrink-0">
                <span class="material-symbols-outlined text-[14px]">smart_toy</span>
            </span>
            <div class="typing-dots"><span></span><span></span><span></span></div>
        </div>`;
    } else {
        d.innerHTML = `<div class="cyber-pill rounded-2xl rounded-tl-sm px-3.5 py-2 text-xs text-main shadow-sm flex items-center gap-2 max-w-[80px]">
            <div class="w-5 h-5 rounded-lg bg-primary/10 text-primary flex items-center justify-center border border-primary/20 shrink-0">
                <span class="material-symbols-outlined text-[12px]">smart_toy</span>
            </div>
            <div class="typing-dots"><span></span><span></span><span></span></div>
        </div>`;
    }

    cont.appendChild(d);
    cont.scrollTop = cont.scrollHeight;
}

function hideChatTyping() {
    const t = document.getElementById('chat-typing-indicator');
    if (t) t.remove();
    const dt = document.getElementById('desk-typing');
    if (dt) dt.remove();
}

function showDesktopTyping() { showChatTyping(); }
function hideDesktopTyping() { hideChatTyping(); }

async function renderStaggeredReply(messages, emotion, isDesktop, ttsText = null) {
    const msgs = Array.isArray(messages)
        ? messages.filter(m => m && String(m).trim())
        : [messages].filter(m => m && String(m).trim());

    hideChatTyping();
    if (msgs.length === 0) return;

    for (let i = 0; i < msgs.length; i++) {
        const msg = String(msgs[i]);
        if (i > 0) {
            showChatTyping();
            const delay = Math.min(Math.max(msg.length * 3, 80), 200);
            await new Promise(r => setTimeout(r, delay));
            hideChatTyping();
        }

        if (isDesktop) {
            addDesktopMsg(msg, 'assistant', emotion);
        } else {
            addChatMsg(msg, 'assistant', emotion);
        }
    }

    if (chatMode === 'voice') {
        speakText(ttsText || msgs.join(' '), emotion);
    }
    if (isDesktop) refreshDesktopPanel();
}

async function sendChat() {
    playHaptic('tap');
    const input = getChatInput();
    const msg = (input ? input.value : '').trim();
    if (!msg) return;
    const desktop = isDesktopDevice();

    if (desktop) addDesktopMsg(msg, 'user');
    else addChatMsg(msg, 'user');

    if (input) input.value = '';
    if (desktop) autoGrowDeskInput();

    showChatTyping();

    try {
        const res = await fetch('/chat', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'X-Session-Token': sessionToken || '',
                'Authorization': 'Bearer ' + (sessionToken || '')
            },
            body: JSON.stringify({ message: msg })
        });
        
        hideChatTyping();

        if (res.status === 401) {
            handleSessionExpired();
            if (desktop) addDesktopMsg('Your session has expired. Please sign in again.', 'assistant');
            else addChatMsg('Your session has expired. Please sign in again.', 'assistant');
            return;
        }

        const data = await res.json();
        if (!res.ok || !data || data.error || !data.reply) {
            const errMsg = (data && data.error) ? data.error : 'Server error occurred (' + res.status + ')';
            toast(errMsg, 'error');
            if (desktop) addDesktopMsg(errMsg, 'assistant');
            else addChatMsg(errMsg, 'assistant');
            return;
        }

        if (data.actions && Array.isArray(data.actions)) {
            executeClientActions(data.actions);
        }

        await renderStaggeredReply(data.reply, data.emotion, desktop, data.tts_text);
    } catch (e) {
        hideChatTyping();
        const errTxt = 'Network or server error: ' + (e.message || 'Please check your connection');
        toast(errTxt, 'error');
        if (desktop) {
            addDesktopMsg(errTxt, 'assistant');
        } else {
            addChatMsg(errTxt, 'assistant');
        }
    }
}

function quickAsk(text) {
    playHaptic('tap');
    const input = getChatInput();
    if (input) {
        input.value = text;
        if (isDesktopDevice()) autoGrowDeskInput();
    }
    sendChat();
}

function clearDesktopChat() {
    playHaptic('tap');
    const cont = document.getElementById('desk-chat-messages');
    if (!cont) return;
    cont.querySelectorAll('.chat-msg').forEach(el => el.remove());
    hideDesktopTyping();

    const empty = document.createElement('div');
    empty.id = 'desk-chat-empty';
    empty.className = 'h-full flex flex-col items-center justify-center text-center py-8 animate-fade-in';
    empty.innerHTML = `<span class="material-symbols-outlined text-[40px] text-muted mb-2">forum</span>
        <p class="text-muted text-xs font-bold">New conversation session active</p>`;
    cont.appendChild(empty);
}

function autoGrowDeskInput() {
    const el = document.getElementById('desk-chat-input');
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

// ── Voice & Neural Robot State Engine ────────────────────────────
function setVoiceUIState(state) {
    const isDesktop = isDesktopDevice();
    const btn = isDesktop ? document.getElementById('desk-voice-btn') : document.getElementById('mob-voice-btn');
    const btnText = isDesktop ? document.getElementById('desk-voice-btn-text') : document.getElementById('mob-voice-btn-text');
    const btnIcon = isDesktop ? document.getElementById('desk-voice-btn-icon') : document.getElementById('mob-voice-btn-icon');
    const status = isDesktop ? document.getElementById('desk-voice-status') : document.getElementById('mob-voice-status');
    const waves = isDesktop ? document.getElementById('desk-voice-waves') : document.getElementById('mob-voice-waves');

    const allAvatars = [
        document.getElementById('desk-neural-avatar'),
        document.getElementById('mob-neural-avatar')
    ];

    allAvatars.forEach(r => {
        if (!r) return;
        r.classList.remove('state-idle', 'state-listening', 'state-thinking', 'state-speaking');
        r.classList.add(`state-${state}`);
    });

    if (!btn) return;

    if (state === 'idle') {
        if (btnIcon) btnIcon.textContent = 'mic';
        if (btnText) btnText.textContent = 'Start Talking';
        btn.classList.remove('animate-pulse');
        if (status) status.textContent = "Tap to speak";
        if (waves) waves.style.opacity = '0';
    } else if (state === 'listening') {
        if (btnIcon) btnIcon.textContent = 'graphic_eq';
        if (btnText) btnText.textContent = 'Listening...';
        btn.classList.add('animate-pulse');
        if (status) status.textContent = "Listening to your voice...";
        if (waves) waves.style.opacity = '1';
    } else if (state === 'thinking') {
        if (btnIcon) btnIcon.textContent = 'psychology';
        if (btnText) btnText.textContent = 'Processing...';
        btn.classList.remove('animate-pulse');
        if (status) status.textContent = "Ekkhu is processing...";
        if (waves) waves.style.opacity = '1';
    } else if (state === 'speaking') {
        if (btnIcon) btnIcon.textContent = 'volume_up';
        if (btnText) btnText.textContent = 'Speaking...';
        btn.classList.remove('animate-pulse');
        if (status) status.textContent = "Ekkhu is speaking";
        if (waves) waves.style.opacity = '1';
    }
}

async function startRecording(mode) {
    playHaptic('pop');
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
        return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert('Microphone access is not supported. Please ensure HTTPS is enabled.');
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true }
        });

        let mimeType = 'audio/webm';
        if (typeof MediaRecorder.isTypeSupported === 'function') {
            if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mimeType = 'audio/webm;codecs=opus';
            else if (MediaRecorder.isTypeSupported('audio/mp4')) mimeType = 'audio/mp4';
        }

        mediaRecorder = new MediaRecorder(stream, { mimeType });
        audioChunks = [];
        voiceModeActive = (mode === 'voice');
        recordingStartTime = Date.now();

        if (voiceModeActive) {
            setVoiceUIState('listening');
            if (currentAudio) { currentAudio.pause(); currentAudio = null; }
        } else {
            ['mic-icon', 'desk-mic-icon'].forEach(id => {
                const el = document.getElementById(id);
                if (el) { el.textContent = 'stop_circle'; el.classList.add('text-rose-600'); }
            });
        }

        mediaRecorder.addEventListener("dataavailable", event => {
            if (event.data && event.data.size > 0) audioChunks.push(event.data);
        });

        mediaRecorder.addEventListener("stop", async () => {
            stream.getTracks().forEach(track => track.stop());

            const isVoice = voiceModeActive;
            const duration = Date.now() - recordingStartTime;
            mediaRecorder = null;

            if (audioChunks.length === 0 || duration < 350) {
                if (isVoice) setVoiceUIState('idle');
                else {
                    ['mic-icon', 'desk-mic-icon'].forEach(id => {
                        const el = document.getElementById(id);
                        if (el) { el.textContent = 'mic'; el.classList.remove('text-rose-600'); }
                    });
                }
                return;
            }

            if (isVoice) setVoiceUIState('thinking');
            else {
                ['mic-icon', 'desk-mic-icon'].forEach(id => {
                    const el = document.getElementById(id);
                    if (el) { el.textContent = 'mic'; el.classList.remove('text-rose-600'); }
                });
                if (isDesktopDevice()) showDesktopTyping();
            }

            const audioBlob = new Blob(audioChunks, { type: mimeType.split(';')[0] });
            const formData = new FormData();
            formData.append('audio', audioBlob, 'voice.webm');

            try {
                const response = await fetch('/voice', { method: 'POST', body: formData });
                const data = await response.json();

                if (data.text) {
                    if (isVoice) {
                        sendVoiceChat(data.text);
                    } else {
                        if (isDesktopDevice()) hideDesktopTyping();
                        const input = getChatInput();
                        if (input) { input.value = data.text; }
                        if (isDesktopDevice()) autoGrowDeskInput();
                    }
                } else {
                    if (isVoice) setVoiceUIState('idle');
                }
            } catch (e) {
                toast('Could not understand voice audio.', 'error');
                if (isVoice) setVoiceUIState('idle');
                if (!isVoice && isDesktopDevice()) hideDesktopTyping();
            }
        });

        mediaRecorder.start();

    } catch (err) {
        alert('Microphone access blocked or unavailable.');
    }
}

function toggleMic() {
    startRecording('text');
}

function startVoiceInteraction() {
    startRecording('voice');
}

async function sendVoiceChat(msg) {
    setVoiceUIState('thinking');
    try {
        const res = await fetch('/chat', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'X-Session-Token': sessionToken || '',
                'Authorization': 'Bearer ' + (sessionToken || '')
            },
            body: JSON.stringify({ message: msg })
        });

        if (res.status === 401) {
            handleSessionExpired();
            setVoiceUIState('idle');
            return;
        }

        const data = await res.json();
        if (!res.ok || !data || data.error || !data.reply) {
            toast((data && data.error) || 'Voice chat error occurred.', 'error');
            setVoiceUIState('idle');
            return;
        }

        setVoiceUIState('speaking');

        if (data.actions && Array.isArray(data.actions)) {
            executeClientActions(data.actions);
        }

        const msgs = Array.isArray(data.reply) ? data.reply : [data.reply];
        const fullText = msgs.filter(m => m && String(m).trim()).join(' ');

        speakText(data.tts_text || fullText, data.emotion);
    } catch (e) {
        toast('Network error during voice chat: ' + e.message, 'error');
        setVoiceUIState('idle');
    }
}

async function speakText(text, emotion = "neutral") {
    if (!voiceEnabled) return;
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }

    try {
        const res = await fetch('/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, emotion })
        });
        const data = await res.json();

        if (data.audio) {
            currentAudio = new Audio('data:audio/mp3;base64,' + data.audio);
            currentAudio.onplay = () => {
                if (chatMode === 'voice') {
                    const waves = isDesktopDevice() ? document.getElementById('desk-voice-waves') : document.getElementById('mob-voice-waves');
                    if (waves) waves.style.opacity = '1';
                }
            };
            currentAudio.onended = () => {
                if (chatMode === 'voice') setVoiceUIState('idle');
            };
            currentAudio.play().catch(() => {
                if (chatMode === 'voice') setVoiceUIState('idle');
            });
        } else {
            if (chatMode === 'voice') setVoiceUIState('idle');
        }
    } catch (e) {
        if (chatMode === 'voice') setVoiceUIState('idle');
    }
}

// ── Markdown & Code Copying ──────────────────────────────────────
function copyCode(btn) {
    playHaptic('tap');
    const code = btn.closest('.code-block').querySelector('code').innerText;
    navigator.clipboard.writeText(code).then(() => {
        btn.innerHTML = `<span class="material-symbols-outlined text-[13px]">check</span> Copied`;
        setTimeout(() => {
            btn.innerHTML = `<span class="material-symbols-outlined text-[13px]">content_copy</span> Copy`;
        }, 1500);
    }).catch(() => { });
}

function renderMarkdown(src) {
    let text = escapeHtml(String(src || '')).replace(/\r\n/g, '\n');
    const blocks = [];
    text = text.replace(/```([\w+-]*)\n?([^`]*?)```/g, (m, lang, code) => {
        blocks.push(`<div class="code-block relative my-3 rounded-2xl overflow-hidden shadow-md">
            <div class="flex items-center justify-between px-4 py-2 bg-white/10 border-b border-white/10">
                <span class="text-[10px] font-bold uppercase tracking-wider text-primary font-mono">${lang || 'code'}</span>
                <button onclick="copyCode(this)" class="text-[11px] font-bold flex items-center gap-1 text-muted hover:text-main transition-colors">
                    <span class="material-symbols-outlined text-[14px]">content_copy</span> Copy
                </button>
            </div>
            <pre class="p-4 overflow-x-auto text-xs leading-relaxed"><code>${code}</code></pre>
        </div>`);
        return '\u0000BLOCK\u0000';
    });
    text = text.replace(/^\s*([-*_])\1{2,}\s*$/gm, '\u0000HR\u0000');

    const inline = s => s
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="text-primary underline font-bold">$1</a>');

    const lines = text.split('\n');
    let html = '', para = [], listType = null;
    const flushPara = () => { if (para.length) { html += '<p>' + inline(para.join(' ')) + '</p>'; para = []; } };
    const flushList = () => { if (listType) { html += '</' + listType + '>'; listType = null; } };

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) { flushPara(); flushList(); continue; }
        if (line === '\u0000BLOCK\u0000') { flushPara(); flushList(); html += blocks.shift(); continue; }
        if (line === '\u0000HR\u0000') { flushPara(); flushList(); html += '<hr class="my-3 border-subtle"/>'; continue; }
        const h = line.match(/^(#{1,4})\s+(.*)$/);
        if (h) {
            flushPara(); flushList();
            const lv = h[1].length;
            const cls = lv === 1 ? 'text-base font-extrabold mt-3 mb-1.5' : lv === 2 ? 'text-sm font-bold mt-2.5 mb-1' : 'text-xs font-bold mt-2 mb-1';
            html += '<h' + lv + ' class="' + cls + ' text-main">' + inline(h[2]) + '</h' + lv + '>';
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

// ── Desktop Right Panel ──────────────────────────────────────────
async function loadDesktopChatPanel() {
    if (!isDesktopDevice()) return;
    try {
        const data = await api('/api/summary');
        renderPanelSchedule(data.today_routine || []);
        renderPanelSuggestions(data);
    } catch (e) { }
}

function refreshDesktopPanel() {
    loadDesktopChatPanel();
}

function renderPanelSchedule(classes) {
    const cont = document.getElementById('desk-panel-schedule');
    if (!cont) return;
    if (!classes || classes.length === 0) {
        cont.innerHTML = `<div class="text-xs text-muted py-2 font-semibold">No classes today 🎉</div>`;
        return;
    }
    cont.innerHTML = classes.slice(0, 3).map(c => `
        <div class="flex items-center gap-2.5 p-2 rounded-xl cyber-pill mb-1.5">
            <span class="text-[10px] font-mono font-bold text-primary shrink-0">${escapeHtml(c.time)}</span>
            <span class="text-xs font-bold text-main truncate">${escapeHtml(c.course)}</span>
        </div>
    `).join('');
}

function renderPanelSuggestions(data) {
    const cont = document.getElementById('desk-panel-suggestions');
    if (!cont) return;
    const items = [
        { icon: 'today', label: 'Daily Status Check', ask: 'How is my day going? Give me an honest diagnostic.' },
        { icon: 'event_available', label: 'Plan My Study Sprint', ask: 'Help me plan my study sprint based on my routine and tasks.' },
        { icon: 'favorite', label: 'Need Motivation', ask: 'I need a productivity boost and motivation right now.' },
        { icon: 'flag', label: 'High Priority Targets', ask: 'What should be my highest priority academic focus today?' }
    ];
    cont.innerHTML = items.map(it => `
        <button onclick="quickAsk('${it.ask.replace(/'/g, "\\'")}')" class="w-full flex items-center gap-2.5 p-2.5 rounded-xl cyber-pill hover:border-primary text-left transition-all group">
            <span class="material-symbols-outlined text-[16px] text-muted group-hover:text-primary transition-colors">${it.icon}</span>
            <span class="text-xs font-bold text-main leading-tight">${escapeHtml(it.label)}</span>
        </button>
    `).join('');
}

// ════════════════════════════════════════════════════════════════
//  SETTINGS
// ════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════
//  SETTINGS & SECURITY
// ════════════════════════════════════════════════════════════════
function loadSettingsUserList() {
    const nameEl = document.getElementById('settings-user-name');
    if (nameEl && currentUserData) {
        nameEl.textContent = `${currentUserData.name} (${currentUserData.id})`;
    }
}

async function updateAccountPin() {
    const inp = document.getElementById('settings-new-pin');
    const pin = (inp ? inp.value : '').trim();
    if (!pin || pin.length !== 6 || !/^\d{6}$/.test(pin)) {
        toast('PIN must be exactly 6 digits', 'error');
        return;
    }
    playHaptic('tap');
    try {
        const res = await api('/api/update_user', 'POST', { new_pin: pin });
        if (res.ok) {
            playHaptic('success');
            toast('6-digit security PIN updated successfully ✓', 'success');
            if (inp) inp.value = '';
        } else {
            toast(res.error || 'Failed to update PIN', 'error');
        }
    } catch(e) {
        toast('Failed to update PIN', 'error');
    }
}

// ════════════════════════════════════════════════════════════════
//  MODAL ACTIONS
// ════════════════════════════════════════════════════════════════
function closeModal() {
    playHaptic('tap');
    document.getElementById('modal-overlay').classList.add('hidden');
    MODAL_ACTION = null;
}

async function modalSave() {
    playHaptic('pop');
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
            day: document.getElementById('f-day').value,
            time: displayTime,
            course: g('f-course'),
            room: g('f-room'),
            prof: g('f-prof'),
            color: selectedColor
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
            credit: parseFloat(document.getElementById('f-credit').value) || 3.0,
            grade: parseFloat(document.getElementById('f-grade').value) || 0.0
        });
        loadCGPA();
    } else if (action === 'plan') {
        if (!g('f-title')) { alert('Activity title required'); return; }
        await api('/api/plans', 'POST', {
            day: document.getElementById('f-day').value,
            duration: g('f-duration'),
            title: g('f-title')
        });
        loadPlans();
    } else if (action === 'task') {
        if (!g('f-title')) { alert('Task title required'); return; }
        await api('/api/tasks', 'POST', {
            title: g('f-title'),
            note: g('f-note'),
            priority: document.getElementById('f-priority').value,
            date: document.getElementById('f-date').value,
            due_time: document.getElementById('f-due-time') ? document.getElementById('f-due-time').value : '11:59 PM'
        });
        loadTasks();
    }

    closeModal();
    loadSummary();
    toast('Saved successfully ✓', 'success');
}

// ════════════════════════════════════════════════════════════════
//  COMMAND PALETTE (Ctrl+K)
// ════════════════════════════════════════════════════════════════
let cmdIndex = 0;

const COMMANDS = [
    {
        group: 'Navigate Views', items: [
            { icon: 'dashboard', label: 'Dashboard', hint: 'Jump to main telemetry overview', run: () => showView('dashboard') },
            { icon: 'calendar_month', label: 'Class Routine', hint: 'View and manage schedule', run: () => showView('routine') },
            { icon: 'how_to_reg', label: 'Attendance Tracker', hint: 'Track course attendance & skips', run: () => showView('attendance') },
            { icon: 'school', label: 'CGPA Predictor', hint: 'Calculate GPA and targets', run: () => showView('cgpa') },
            { icon: 'payments', label: 'Budget Tracker', hint: 'Log expenses and allowance', run: () => showView('budget') },
            { icon: 'calendar_view_week', label: 'Weekly Plans', hint: 'Review weekly strategy', run: () => showView('plans') },
            { icon: 'task_alt', label: 'Daily Priorities', hint: 'Manage action items', run: () => showView('tasks') },
            { icon: 'smart_toy', label: 'Ekkhu AI Chat', hint: 'Chat with your AI companion', run: () => showView('chat') },
            { icon: 'settings', label: 'Settings', hint: 'System information and profiles', run: () => showView('settings') },
        ]
    },
    {
        group: 'Sweet Theme Palettes', items: [
            { icon: 'palette', label: 'Sweet Sakura Palette 🌸', hint: 'Soft pastel pink & candy blossom', run: () => setPalette('sakura') },
            { icon: 'palette', label: 'Crimson Luxe Palette 🌹', hint: 'Crisp porcelain & bold crimson ruby', run: () => setPalette('crimson') },
            { icon: 'palette', label: 'Cyber Cyan Palette 🌊', hint: 'Ice blue & futuristic neon mint', run: () => setPalette('cyan') },
            { icon: 'palette', label: 'Matcha Sage Palette 🍃', hint: 'Serene emerald green & gold', run: () => setPalette('matcha') },
        ]
    },
    {
        group: 'Quick Actions & Academic OS', items: [
            { icon: 'photo_camera', label: '📸 1-Snap Routine AI Parser', hint: 'Upload timetable image/PDF or paste text to auto-import schedule', run: () => openRoutineParserModal() },
            { icon: 'local_fire_department', label: '🚨 72-Hour Exam Survival Protocol', hint: 'Launch high-stakes 3-phase tactical sprint roadmap', run: () => openExamSurvivalModal(0, 'Active Semester Exam', 'Tactical Roadmap', new Date().toISOString().split('T')[0], '10:00 AM') },
            { icon: 'history_edu', label: 'Set Academic Standing & Baseline CGPA', hint: 'Update semester & prior credits (e.g. 6th Sem)', run: () => openBaselineModal() },
            { icon: 'monitor_heart', label: 'Academic Health Telemetry Audit', hint: 'View 5-factor breakdown & fatigue status', run: () => openHealthAuditModal() },
            { icon: 'campaign', label: 'Executive Daily Briefing', hint: 'Listen to AI time-of-day briefing', run: () => speakExecutiveBriefing() },
            { icon: 'notification_important', label: 'Add Upcoming Exam / Quiz', hint: 'Track exam countdown & AI prep', run: () => openExamModal() },
            { icon: 'calendar_month', label: 'Export Routine Calendar (.ICS)', hint: 'Download schedule for Google & Apple Calendar', run: () => exportRoutineToICS() },
            { icon: 'timer', label: 'Start Focus Timer', hint: 'Launch 25m Pomodoro sprint', run: () => openPomodoroModal() },
            { icon: 'contrast', label: 'Toggle Dark / Light Mode', hint: 'Switch color theme', run: () => toggleTheme() },
            { icon: 'add_task', label: 'Add Action Item', hint: 'Create new task', run: () => openTaskModal() },
            { icon: 'event_note', label: 'Add Class to Routine', hint: 'Insert new timetable slot', run: () => openRoutineModal() },
            { icon: 'payments', label: 'Add Budget Entry', hint: 'Log an income or expense', run: () => openBudgetModal() },
            { icon: 'school', label: 'Add Course Grade', hint: 'Track grade for CGPA', run: () => openGradeModal() },
            { icon: 'how_to_reg', label: 'Add Attendance Course', hint: 'Track a new course', run: () => openAttModal() },
            { icon: 'sync', label: 'Refresh All Telemetry', hint: 'Reload summaries from SQLite', run: () => loadSummary() },
            { icon: 'swap_horiz', label: 'Switch Profile / Sign Out', hint: 'Change active account', run: () => switchUser() },
        ]
    },
    {
        group: 'Ask Ekkhu AI & PA Copilot', items: [
            { icon: 'psychology', label: 'Ekkhu PA: What to Focus on Right Now?', hint: 'AI analysis of schedule & pending priorities', run: () => { openPomodoroModal(); setTimeout(askFocusPAActivity, 300); } },
            { icon: 'water_drop', label: 'Ekkhu PA: Should I Take a Break?', hint: 'Cognitive rest & hydration advice', run: () => { openPomodoroModal(); setTimeout(askFocusPABreak, 300); } },
            { icon: 'splitscreen', label: 'Ekkhu PA: Task Sprint Breakdown', hint: 'Structure active target into 25m blocks', run: () => { openPomodoroModal(); setTimeout(askFocusPATask, 300); } },
            { icon: 'today', label: 'Daily Academic Check-in', hint: 'Diagnostic on routine, attendance & tasks', run: () => quickAsk('How is my day going? Give me a quick, honest check-in.') },
            { icon: 'event_available', label: 'Plan My Day', hint: 'Sort priorities and tasks', run: () => quickAsk('Help me plan my day based on my routine and tasks.') },
            { icon: 'favorite', label: 'Cheer Me Up', hint: 'Motivation and supportive words', run: () => quickAsk('I am feeling a bit down today. Cheer me up and give me some support.') },
            { icon: 'flag', label: 'Focus Priorities', hint: 'Identify urgent targets', run: () => quickAsk('Help me stay on track with attendance, tasks and budget. What should I focus on?') }
        ]
    }
];

function openCommandPalette() {
    playHaptic('tap');
    const overlay = document.getElementById('cmd-overlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    cmdIndex = 0;
    const input = document.getElementById('cmd-input');
    if (input) {
        input.value = '';
        renderCommands();
        setTimeout(() => input.focus(), 30);
    }
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
            if (!ql || (it.label + ' ' + it.hint).toLowerCase().includes(ql)) {
                all.push({ ...it, group: g.group });
            }
        });
    });

    cmdIndex = Math.min(cmdIndex, Math.max(0, all.length - 1));

    if (all.length === 0) {
        list.innerHTML = `<div class="p-8 text-center text-muted font-medium text-xs">No matching commands found for "${escapeHtml(q)}"</div>`;
        return;
    }

    let html = '', lastGroup = '';
    all.forEach((it, i) => {
        if (it.group !== lastGroup) {
            lastGroup = it.group;
            html += `<div class="px-3 pt-2.5 pb-1 text-[10px] font-bold uppercase tracking-wider text-muted font-mono">${it.group}</div>`;
        }
        html += `
            <button onclick="runCmd(${i})" class="cmd-item w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all ${i === cmdIndex ? 'bg-primary text-white shadow-sm' : 'cyber-pill text-main hover:border-primary'}">
                <span class="material-symbols-outlined text-[18px] ${i === cmdIndex ? 'text-white' : 'text-primary'}">${it.icon}</span>
                <div class="flex-1 min-w-0">
                    <p class="text-xs font-bold truncate leading-tight">${escapeHtml(it.label)}</p>
                    <p class="text-[10px] ${i === cmdIndex ? 'text-white/80' : 'text-muted'} truncate">${escapeHtml(it.hint)}</p>
                </div>
                <span class="material-symbols-outlined text-[14px] opacity-40">north_west</span>
            </button>
        `;
    });
    list.innerHTML = html;
}

function runCmd(i) {
    const q = (document.getElementById('cmd-input') || {}).value || '';
    const ql = q.toLowerCase().trim();
    const all = [];
    COMMANDS.forEach(g => {
        g.items.forEach(it => {
            if (!ql || (it.label + ' ' + it.hint).toLowerCase().includes(ql)) all.push(it);
        });
    });
    const cmd = all[i];
    if (cmd) {
        closeCommandPalette();
        cmd.run();
    }
}

// ── Global Keyboard Shortcuts ─────────────────────────────────────
document.addEventListener('keydown', (e) => {
    const authScr = document.getElementById('auth-screen');
    const pinScr = document.getElementById('pin-screen');

    if (authScr && (authScr.style.display === 'flex' || authScr.style.display === '')) {
        const createTab = !document.getElementById('create-panel').classList.contains('hidden');
        const act = document.activeElement;
        if (createTab) {
            if (act && act.tagName === 'INPUT' && (act.id === 'ca-name' || act.id === 'ca-code')) {
                if (e.key === 'Enter') submitCreateAccount();
                return;
            }
            if (e.key >= '0' && e.key <= '9') caKey(e.key);
            else if (e.key === 'Backspace') caDel();
            else if (e.key === 'Enter') submitCreateAccount();
        } else {
            if (act && act.tagName === 'INPUT' && act.id === 'login-username') {
                if (e.key === 'Enter') {
                    if (loginPinBuffer.length === 6) submitLogin();
                    else document.getElementById('login-username').blur();
                }
                return;
            }
            if (e.key >= '0' && e.key <= '9') loginKey(e.key);
            else if (e.key === 'Backspace') loginDel();
            else if (e.key === 'Enter') submitLogin();
        }
        return;
    }

    const cmdOverlay = document.getElementById('cmd-overlay');
    const cmdOpen = cmdOverlay && !cmdOverlay.classList.contains('hidden');

    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        if (cmdOpen) closeCommandPalette(); else openCommandPalette();
        return;
    }

    if (e.key === 'Escape') {
        if (cmdOpen) { closeCommandPalette(); return; }
        const pModal = document.getElementById('pomodoro-modal');
        if (pModal && !pModal.classList.contains('hidden')) { closePomodoroModal(); return; }
        const modal = document.getElementById('modal-overlay');
        if (modal && !modal.classList.contains('hidden')) { closeModal(); return; }
        const sheet = document.getElementById('mob-bottom-sheet');
        if (sheet && !sheet.classList.contains('hidden')) { closeBottomSheet(); return; }
    }

    if (cmdOpen) {
        if (e.key === 'Enter') {
            e.preventDefault();
            runCmd(cmdIndex);
        }
    }
});

// ── Chat Input Key Handling ───────────────────────────────────────
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
    const mi = document.getElementById('chat-input');
    if (mi) {
        mi.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                sendChat();
            }
        });
    }

    const cmdInput = document.getElementById('cmd-input');
    if (cmdInput) {
        cmdInput.addEventListener('input', () => {
            cmdIndex = 0;
            renderCommands();
        });
    }

    initUserSelect();
});

// ════════════════════════════════════════════════════════════════
//  EKKHU PROACTIVE AUTONOMOUS PERSONAL ASSISTANT CLIENT ENGINE
// ════════════════════════════════════════════════════════════════
let proactivePollTimer = null;

async function checkProactiveNudge() {
    if (!currentUserId || !sessionToken) return;
    try {
        const res = await api('/api/proactive/unread');
        if (res && res.ok && res.unread && res.nudge) {
            renderProactiveBanner(res.nudge);
            triggerBrowserNotification(res.nudge.push_title || 'Ekkhu 💬', res.nudge.push_body || res.nudge.message);
        } else {
            const banner = document.getElementById('dash-proactive-banner');
            if (banner && !banner.dataset.sticky) banner.classList.add('hidden');
        }
    } catch(e) {
        console.debug('[Proactive] Check skipped:', e);
    }
}

function renderProactiveBanner(nudge) {
    const banner = document.getElementById('dash-proactive-banner');
    if (!banner) return;

    const txtEl = document.getElementById('proactive-nudge-text');
    const badgeEl = document.getElementById('proactive-nudge-badge');
    const timeEl = document.getElementById('proactive-nudge-time');
    const iconEl = document.getElementById('proactive-nudge-icon');

    if (txtEl) txtEl.textContent = `"${sanitizeChatMessage(nudge.message)}"`;
    
    const badgeMap = {
        'EXAM_ALERT': { label: 'Exam Countdown Alert 📚', icon: 'school' },
        'OVERDUE_TASK_FOLLOWUP': { label: 'Overdue Task Follow-up ⚠️', icon: 'priority_high' },
        'TASK_FOLLOWUP': { label: 'Task Accountability Check ⚡', icon: 'task_alt' },
        'INACTIVITY_NUDGE': { label: 'Ekkhu Checked In on You ❤️', icon: 'waving_hand' },
        'MORNING_ROUTINE': { label: 'Morning Kickoff ☀️', icon: 'wb_sunny' },
        'MANUAL_CHECKIN': { label: 'Live Assistant Check-in 🤖', icon: 'smart_toy' }
    };
    const bInfo = badgeMap[nudge.trigger_type] || { label: 'Ekkhu Checked In', icon: 'smart_toy' };
    
    if (badgeEl) badgeEl.textContent = bInfo.label;
    if (iconEl) iconEl.textContent = bInfo.icon;
    if (timeEl) {
        try {
            const dt = new Date(nudge.timestamp);
            timeEl.textContent = isNaN(dt) ? 'Just now' : dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch(_) {
            timeEl.textContent = 'Just now';
        }
    }

    banner.classList.remove('hidden');
    banner.dataset.sticky = 'true';
}

function dismissProactiveNudge() {
    playHaptic('tap');
    const banner = document.getElementById('dash-proactive-banner');
    if (banner) {
        banner.classList.add('hidden');
        delete banner.dataset.sticky;
    }
    api('/api/proactive/dismiss', 'POST').catch(() => {});
}

function openChatFromProactive() {
    playHaptic('tap');
    dismissProactiveNudge();
    showView('chat');
}

async function loadProactiveSettings() {
    try {
        const res = await api('/api/proactive/settings');
        if (res && res.ok && res.settings) {
            const tog = document.getElementById('proactive-assistant-toggle');
            if (tog) tog.checked = Boolean(res.settings.enabled);
        }
    } catch(e) {}
}

async function toggleProactiveSetting(enabled) {
    playHaptic('tap');
    try {
        await api('/api/proactive/settings', 'POST', { enabled: Boolean(enabled) });
        toast(enabled ? '✅ Ekkhu Proactive Assistant enabled' : '⏸️ Proactive Assistant paused', 'info');
    } catch(e) {
        toast('Failed to save setting', 'error');
    }
}

async function triggerTestProactiveNudge() {
    playHaptic('tap');
    const btn = document.getElementById('btn-test-proactive');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span class="material-symbols-outlined text-[14px] animate-spin">refresh</span> Evaluating...`;
    }
    try {
        const res = await api('/api/proactive/test_trigger', 'POST');
        if (res && res.triggered) {
            toast('🤖 Ekkhu generated a live check-in!', 'success');
            playHaptic('success');
            renderProactiveBanner({
                message: res.message,
                trigger_type: res.trigger_type,
                timestamp: new Date().toISOString(),
                push_title: res.push_title,
                push_body: res.push_body
            });
            // Reload chat history so it appears in Chat view immediately
            if (isDesktopDevice()) {
                loadDesktopChatHistory();
            } else {
                loadMobileChatHistory();
            }
        } else {
            toast(res.reason || 'No check-in needed right now', 'info');
        }
    } catch(e) {
        toast('Check-in test failed: ' + e.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<span class="material-symbols-outlined text-[14px]">play_arrow</span> Test Live Check-in`;
        }
    }
}

// ── Web Notifications Integration ────────────────────────────────
function initNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        const reqOnce = () => {
            Notification.requestPermission().catch(() => {});
            window.removeEventListener('click', reqOnce);
        };
        window.addEventListener('click', reqOnce, { once: true });
    }
}

function triggerBrowserNotification(title, body) {
    try {
        if ('Notification' in window && Notification.permission === 'granted') {
            const notif = new Notification(title || 'Ekkhu 💬', {
                body: body || 'You have a new check-in from Ekkhu.',
                icon: '/static/icon.png',
                tag: 'ekkhu-proactive'
            });
            notif.onclick = () => {
                window.focus();
                showView('chat');
            };
        }
    } catch(e) {
        console.debug('[Notification] Failed to trigger:', e);
    }
}

// Tab Focus & Visibility Proactive Triggers
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && currentUserId && sessionToken) {
        checkProactiveNudge();
    }
});

window.addEventListener('focus', () => {
    if (currentUserId && sessionToken) {
        checkProactiveNudge();
    }
});
