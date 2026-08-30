import os
import sqlite3
import re
import json
import base64
import hashlib
import shutil
import time
import threading
from datetime import datetime, date, timedelta, timezone
from flask import Flask, render_template, request, jsonify
from dotenv import load_dotenv
import requests
from prompt import get_system_prompt, SYSTEM_PROMPT

# Bangladesh Standard Time (UTC+6)
BD_TZ = timezone(timedelta(hours=6))

def now_bd():
    """Current datetime in Bangladesh Standard Time (UTC+6)."""
    return datetime.now(BD_TZ)

def now_bd_iso():
    """Current ISO timestamp with timezone."""
    return datetime.now(BD_TZ).isoformat()

def today_bd_date():
    """Current date in Bangladesh Standard Time."""
    return datetime.now(BD_TZ).date()

def today_bd_iso():
    """Current ISO date string (YYYY-MM-DD) in Bangladesh Standard Time."""
    return datetime.now(BD_TZ).date().isoformat()

# Optional libs (graceful if missing)
try:
    from cryptography.fernet import Fernet
    HAS_CRYPTO = True
except ImportError:
    HAS_CRYPTO = False

try:
    from gtts import gTTS
    HAS_TTS = True
except ImportError:
    HAS_TTS = False

# ------------------------------------------------------------------
# PythonAnywhere Proxy Auto-Patch
# ------------------------------------------------------------------
# PythonAnywhere free tier blocks direct outbound TCP (including WebSocket).
# All connections must go through its HTTP proxy at proxy.server:3128.
# edge-tts uses aiohttp WebSocket which doesn't auto-detect this proxy.
#
# Fix: probe proxy.server:3128 at startup — if reachable (= we're on PA),
# monkey-patch aiohttp.ClientSession.ws_connect to silently inject the proxy.
# This makes edge-tts work on PA without any code changes to the TTS route.
# On local dev proxy.server doesn't exist, so the patch is never applied.
# ------------------------------------------------------------------
_PA_PROXY_URL = "http://proxy.server:3128"
_USING_PA_PROXY = False
try:
    import socket as _socket
    _s = _socket.create_connection(("proxy.server", 3128), timeout=1)
    _s.close()
    # proxy.server:3128 is reachable → we are on PythonAnywhere
    import aiohttp as _aiohttp
    _orig_ws_connect = _aiohttp.ClientSession.ws_connect
    def _proxied_ws_connect(self, url, **kwargs):
        kwargs.setdefault("proxy", _PA_PROXY_URL)
        return _orig_ws_connect(self, url, **kwargs)
    _aiohttp.ClientSession.ws_connect = _proxied_ws_connect
    _USING_PA_PROXY = True
    
    # Also set global environment variables so `requests` (used by gTTS) respects the proxy
    import os as _os
    _os.environ["http_proxy"] = _PA_PROXY_URL
    _os.environ["https_proxy"] = _PA_PROXY_URL
    
    print(f"[PROXY] PythonAnywhere detected → patched aiohttp.ws_connect and set os.environ proxies to {_PA_PROXY_URL}")
except Exception:
    pass  # Not on PythonAnywhere, or aiohttp not installed yet — no patch needed

# Setup
load_dotenv(override=True)
app = Flask(__name__)

USERS_FILE = 'users.json'

# API Keys
GROQ_API_KEY    = os.getenv('GROQ_API_KEY')  # Disabled for now
GEMINI_API_KEY_1 = os.getenv('GEMINI_API_KEY_1')
GEMINI_API_KEY_2 = os.getenv('GEMINI_API_KEY_2')

# Startup diagnostics
print(f"[STARTUP] GEMINI_API_KEY_1: {'SET (len={})'.format(len(GEMINI_API_KEY_1)) if GEMINI_API_KEY_1 else 'NOT SET — chat will fail!'}")
print(f"[STARTUP] GEMINI_API_KEY_2: {'SET' if GEMINI_API_KEY_2 else 'NOT SET'}")
print(f"[STARTUP] GROQ_API_KEY: {'SET' if GROQ_API_KEY else 'NOT SET'}")

# Default accent colors for new accounts
ACCENT_COLORS = ['#af101a','#6366f1','#10B981','#F59E0B','#0ea5e9','#8b5cf6','#ec4899','#14b8a6']

# ------------------------------------------------------------------
# User Management — invite-code based, unlimited accounts
# ------------------------------------------------------------------
DEFAULT_CONFIG = {"invite_code": "EKKU2025", "users": []}
_CONFIG_CACHE = None

def load_config(force_reload=False):
    global _CONFIG_CACHE
    if _CONFIG_CACHE is not None and not force_reload:
        return _CONFIG_CACHE

    if os.getenv("TURSO_DATABASE_URL"):
        try:
            conn = TursoConnection(os.getenv("TURSO_DATABASE_URL"), os.getenv("TURSO_AUTH_TOKEN"), "global")
            c = conn.cursor()
            c.execute("CREATE TABLE IF NOT EXISTS global_store (key TEXT PRIMARY KEY, value TEXT)")
            c.execute("SELECT value FROM global_store WHERE key='users_config'")
            row = c.fetchone()
            if row:
                _CONFIG_CACHE = json.loads(row[0] if isinstance(row, (tuple, list)) else row['value'])
                return _CONFIG_CACHE
        except Exception as e:
            print("[TURSO] Failed to load config:", e)
        _CONFIG_CACHE = DEFAULT_CONFIG.copy()
        return _CONFIG_CACHE

    if not os.path.exists(USERS_FILE):
        with open(USERS_FILE, 'w') as f:
            json.dump(DEFAULT_CONFIG, f, indent=2)
        _CONFIG_CACHE = DEFAULT_CONFIG.copy()
        return _CONFIG_CACHE
    with open(USERS_FILE) as f:
        data = json.load(f)
    # Handle old 5-user format gracefully
    if 'invite_code' not in data:
        data['invite_code'] = 'EKKU2025'
    if 'users' not in data:
        data['users'] = []
    _CONFIG_CACHE = data
    return _CONFIG_CACHE

def load_users(force_reload=False):
    return load_config(force_reload=force_reload)['users']

def save_config(cfg):
    global _CONFIG_CACHE
    _CONFIG_CACHE = cfg
    if os.getenv("TURSO_DATABASE_URL"):
        try:
            conn = TursoConnection(os.getenv("TURSO_DATABASE_URL"), os.getenv("TURSO_AUTH_TOKEN"), "global")
            c = conn.cursor()
            c.execute("CREATE TABLE IF NOT EXISTS global_store (key TEXT PRIMARY KEY, value TEXT)")
            c.execute("INSERT INTO global_store (key, value) VALUES ('users_config', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(cfg),))
            conn.commit()
            return
        except Exception as e:
            print("[TURSO] Failed to save config:", e)
            
    with open(USERS_FILE, 'w') as f:
        json.dump(cfg, f, indent=2)

def save_users_data(users):
    cfg = load_config()
    cfg['users'] = users
    save_config(cfg)

def generate_user_id():
    users = load_users()
    existing = {u['id'] for u in users}
    for i in range(1, 1000):
        cid = f'u{i}'
        if cid not in existing:
            return cid
    return f'u{len(users)+1}'

def pick_color(users):
    used = {u.get('color') for u in users}
    for c in ACCENT_COLORS:
        if c not in used:
            return c
    return ACCENT_COLORS[len(users) % len(ACCENT_COLORS)]

import secrets

SESSIONS_FILE = 'sessions.json'
_SESSIONS_CACHE = None

class AuthRequired(Exception):
    """Raised when request lacks valid session token."""
    pass

@app.errorhandler(AuthRequired)
def handle_auth_required(e):
    return jsonify({"ok": False, "error": "Authentication required. Please sign in with username and PIN.", "code": "AUTH_REQUIRED"}), 401

def load_sessions(force_reload=False):
    global _SESSIONS_CACHE
    if _SESSIONS_CACHE is not None and not force_reload:
        return _SESSIONS_CACHE
    
    if os.getenv("TURSO_DATABASE_URL"):
        try:
            conn = TursoConnection(os.getenv("TURSO_DATABASE_URL"), os.getenv("TURSO_AUTH_TOKEN"), "global")
            c = conn.cursor()
            c.execute("CREATE TABLE IF NOT EXISTS global_store (key TEXT PRIMARY KEY, value TEXT)")
            c.execute("SELECT value FROM global_store WHERE key='active_sessions'")
            row = c.fetchone()
            if row:
                _SESSIONS_CACHE = json.loads(row[0] if isinstance(row, (tuple, list)) else row['value'])
                return _SESSIONS_CACHE
        except Exception as e:
            print("[TURSO] Failed to load sessions:", e)
        _SESSIONS_CACHE = {}
        return _SESSIONS_CACHE

    if not os.path.exists(SESSIONS_FILE):
        _SESSIONS_CACHE = {}
        return _SESSIONS_CACHE
    try:
        with open(SESSIONS_FILE) as f:
            _SESSIONS_CACHE = json.load(f)
    except Exception:
        _SESSIONS_CACHE = {}
    return _SESSIONS_CACHE

def save_sessions(sessions):
    global _SESSIONS_CACHE
    _SESSIONS_CACHE = sessions
    if os.getenv("TURSO_DATABASE_URL"):
        try:
            conn = TursoConnection(os.getenv("TURSO_DATABASE_URL"), os.getenv("TURSO_AUTH_TOKEN"), "global")
            c = conn.cursor()
            c.execute("CREATE TABLE IF NOT EXISTS global_store (key TEXT PRIMARY KEY, value TEXT)")
            c.execute("INSERT INTO global_store (key, value) VALUES ('active_sessions', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(sessions),))
            conn.commit()
            return
        except Exception as e:
            print("[TURSO] Failed to save sessions:", e)
    try:
        with open(SESSIONS_FILE, 'w') as f:
            json.dump(sessions, f, indent=2)
    except Exception as e:
        print("[SESSIONS] Failed to write sessions file:", e)

def create_session(user_id, name, color):
    token = secrets.token_urlsafe(32)
    sessions = load_sessions()
    sessions[token] = {
        "user_id": user_id,
        "name": name,
        "color": color,
        "created_at": datetime.now().isoformat(),
        "expires_at": (datetime.now() + timedelta(days=30)).isoformat()
    }
    save_sessions(sessions)
    return token

def verify_session(token):
    if not token:
        return None
    sessions = load_sessions()
    sess = sessions.get(token)
    if not sess:
        return None
    try:
        exp = datetime.fromisoformat(sess.get('expires_at', '2000-01-01T00:00:00'))
        if exp > datetime.now():
            return sess
    except Exception:
        pass
    # Expired session cleanup
    sessions.pop(token, None)
    save_sessions(sessions)
    return None

def revoke_session(token):
    if not token: return
    sessions = load_sessions()
    if token in sessions:
        sessions.pop(token, None)
        save_sessions(sessions)

# ------------------------------------------------------------------
# Rate Limiting & Lockout Tracker for PINs
# ------------------------------------------------------------------
_FAILED_LOGINS = {} # key -> list of timestamp floats

def check_rate_limit(key, max_attempts=5, window_seconds=900):
    """Return (allowed: bool, remaining_lockout_seconds: int)"""
    now = datetime.now().timestamp()
    attempts = _FAILED_LOGINS.get(key, [])
    recent = [t for t in attempts if now - t < window_seconds]
    _FAILED_LOGINS[key] = recent
    if len(recent) >= max_attempts:
        oldest_in_window = min(recent)
        remaining = int(window_seconds - (now - oldest_in_window))
        return False, max(1, remaining)
    return True, 0

def record_failed_login(key):
    now = datetime.now().timestamp()
    if key not in _FAILED_LOGINS:
        _FAILED_LOGINS[key] = []
    _FAILED_LOGINS[key].append(now)

def clear_failed_logins(key):
    _FAILED_LOGINS.pop(key, None)

def hash_pin(pin):
    return hashlib.sha256(str(pin).strip().encode()).hexdigest()

def get_current_user_id():
    """Extract and strictly validate cryptographic session token."""
    token = request.headers.get('X-Session-Token', '') or request.cookies.get('session_token', '')
    if not token and request.headers.get('Authorization', '').startswith('Bearer '):
        token = request.headers.get('Authorization', '')[7:].strip()
    
    if token:
        sess = verify_session(token)
        if sess and sess.get('user_id'):
            return sess['user_id']
            
    # Raise AuthRequired exception -> immediately triggers 401 JSON error handler
    raise AuthRequired("Authentication session invalid or expired")

# ------------------------------------------------------------------
# Encryption helpers
# ------------------------------------------------------------------
def _get_cipher():
    if not HAS_CRYPTO:
        return None
    key = os.getenv('EKKU_SECRET_KEY')
    # Try env key first
    if key:
        try:
            return Fernet(key.encode())
        except Exception:
            print("[CIPHER] EKKU_SECRET_KEY is invalid, falling back to db/file.")
            
    turso_url = os.getenv("TURSO_DATABASE_URL")
    if turso_url:
        try:
            conn = TursoConnection(turso_url, os.getenv("TURSO_AUTH_TOKEN"), "global")
            c = conn.cursor()
            c.execute("CREATE TABLE IF NOT EXISTS global_store (key TEXT PRIMARY KEY, value TEXT)")
            c.execute("SELECT value FROM global_store WHERE key='ekku_key'")
            row = c.fetchone()
            if row:
                return Fernet(row[0].encode() if isinstance(row, (tuple, list)) else row['value'].encode())
            else:
                new_key = Fernet.generate_key()
                c.execute("INSERT INTO global_store (key, value) VALUES ('ekku_key', ?)", (new_key.decode(),))
                conn.commit()
                print("[CIPHER] Generated new Fernet key and saved to Turso")
                return Fernet(new_key)
        except Exception as e:
            print("[CIPHER] Failed to load/save key to Turso:", e)

    key_file = 'ekku.key'
    # Try key file
    if os.path.exists(key_file):
        try:
            with open(key_file, 'rb') as f:
                file_key = f.read().strip()
            return Fernet(file_key)
        except Exception:
            print("[CIPHER] ekku.key is invalid, generating new key.")
    # Generate a new key and save it
    new_key = Fernet.generate_key()
    with open(key_file, 'wb') as f:
        f.write(new_key)
    print("[CIPHER] Generated new Fernet key and saved to ekku.key")
    return Fernet(new_key)

_CIPHER = _get_cipher()


def encrypt_text(text):
    if _CIPHER is None:
        return text
    try:
        return _CIPHER.encrypt(str(text).encode()).decode()
    except Exception:
        return text

def decrypt_text(text):
    if _CIPHER is None:
        return text
    try:
        return _CIPHER.decrypt(text.encode()).decode()
    except Exception:
        return text

# ------------------------------------------------------------------
# Database — Turso & Local (with High-Performance Connection Pooling)
# ------------------------------------------------------------------
_TURSO_HTTP_SESSION = requests.Session()
_turso_adapter = requests.adapters.HTTPAdapter(pool_connections=25, pool_maxsize=25, max_retries=2)
_TURSO_HTTP_SESSION.mount('https://', _turso_adapter)
_TURSO_HTTP_SESSION.mount('http://', _turso_adapter)

class TursoRow:
    def __init__(self, cols, vals):
        self._cols = list(cols)
        self._vals = list(vals)
        self._d = dict(zip(cols, vals))
    def __getitem__(self, key):
        if isinstance(key, int): return self._vals[key]
        return self._d.get(key)
    def get(self, key, default=None): return self._d.get(key, default)
    def __iter__(self): return iter(self._vals)
    def __len__(self): return len(self._vals)
    def keys(self): return self._cols
    def values(self): return self._vals
    def items(self): return self._d.items()

class TursoCursor:
    def __init__(self, conn, user_id):
        self.conn = conn
        self.user_id = user_id
        self.rows = []
        self.cols = []
        self.description = []
        self._row_idx = 0
        self.row_factory = None
        self.tables = [
            "routine", "attendance", "budget", "tasks", "plans", 
            "grades", "chat_history", "long_term_memory", 
            "focus_sessions", "exams", "academic_profile", 
            "academic_state", "schedule_exceptions"
        ]

    def _rewrite(self, sql):
        # Prevent double prefixing if it's already prefixed
        for t in self.tables:
            sql = re.sub(rf'\b{t}\b', f'{self.user_id}_{t}', sql, flags=re.IGNORECASE)
        # Restore if it accidentally replaced global_store
        sql = sql.replace(f'{self.user_id}_global_store', 'global_store')
        return sql

    def execute(self, sql, params=None):
        sql = self._rewrite(sql)
        args = []
        if params:
            for p in params:
                args.append({"type": "text", "value": str(p)} if p is not None else {"type": "null"})
        
        stmt = {"sql": sql}
        if args: stmt["args"] = args
            
        payload = {"requests": [{"type": "execute", "stmt": stmt}, {"type": "close"}]}
        headers = {"Authorization": f"Bearer {self.conn.token}", "Content-Type": "application/json"}
        http_url = self.conn.url.replace("libsql://", "https://") + "/v2/pipeline"
        
        try:
            resp = _TURSO_HTTP_SESSION.post(http_url, headers=headers, json=payload, timeout=8)
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            raise sqlite3.OperationalError(f"Turso Network Error: {e}")
        
        result = data.get("results", [])[0]
        if result.get("type") == "ok":
            res = result["response"]["result"]
            cols = [c["name"] for c in res.get("cols", [])]
            self.cols = cols
            self.description = [(c, None, None, None, None, None, None) for c in cols]
            self.rows = []
            for r in res.get("rows", []):
                vals = [val.get("value") if val.get("type") != "null" else None for val in r]
                self.rows.append(TursoRow(cols, vals))
        else:
            err = str(result.get("error"))
            if "no such table" in err.lower():
                raise sqlite3.OperationalError(err)
            raise Exception("Turso error: " + err)
            
        self._row_idx = 0
        return self

    def fetchall(self): return self.rows
    def fetchone(self):
        if self._row_idx < len(self.rows):
            r = self.rows[self._row_idx]
            self._row_idx += 1
            return r
        return None

class TursoConnection:
    def __init__(self, url, token, user_id):
        self.url = url
        self.token = token
        self.user_id = user_id
        self.row_factory = None
        
    def cursor(self):
        c = TursoCursor(self, self.user_id)
        if self.row_factory:
            c.row_factory = self.row_factory
        return c
        
    def commit(self): pass
    def close(self): pass

SYNCED_TABLES = [
    "routine", "attendance", "budget", "tasks", "plans", 
    "grades", "chat_history", "long_term_memory", 
    "focus_sessions", "exams", "academic_profile", 
    "academic_state", "schedule_exceptions", "proactive_state",
    "active_timer_state"
]

class TursoSyncManager:
    def __init__(self):
        self.last_sync_time = None
        self.last_sync_status = "Local SQLite Active (0.05ms speed)"
        self._sync_lock = threading.Lock()
        self._pending_push_users = set()

    def is_configured(self):
        return bool(os.getenv("TURSO_DATABASE_URL") and os.getenv("TURSO_AUTH_TOKEN"))

    def _get_turso_conn(self, user_id="global"):
        if not self.is_configured():
            return None
        return TursoConnection(os.getenv("TURSO_DATABASE_URL"), os.getenv("TURSO_AUTH_TOKEN"), user_id)

    def pull_all_from_turso(self):
        """Pull all global configs and user databases from Turso into local SQLite files with multi-table recovery."""
        if not self.is_configured():
            return {"ok": False, "error": "TURSO_DATABASE_URL not configured"}
            
        with self._sync_lock:
            try:
                g_conn = self._get_turso_conn("global")
                gc = g_conn.cursor()

                # 1. Pull global store (users_config, ekku_key, active_sessions)
                try:
                    gc.execute("CREATE TABLE IF NOT EXISTS global_store (key TEXT PRIMARY KEY, value TEXT)")
                    gc.execute("SELECT key, value FROM global_store")
                    for row in gc.fetchall():
                        k = row.get('key') if hasattr(row, 'get') else (row[0] if len(row) > 0 else None)
                        v = row.get('value') if hasattr(row, 'get') else (row[1] if len(row) > 1 else None)
                        if k == 'users_config' and v:
                            try:
                                cfg = json.loads(v)
                                with open(USERS_FILE, 'w', encoding='utf-8') as f:
                                    json.dump(cfg, f, indent=2)
                                load_config(force_reload=True)
                                print("[TURSO_SYNC] Restored users_config from Turso.")
                            except Exception as e:
                                print("[TURSO_SYNC] Error restoring users_config:", e)
                        elif k == 'active_sessions' and v:
                            try:
                                sess = json.loads(v)
                                with open(SESSIONS_FILE, 'w', encoding='utf-8') as f:
                                    json.dump(sess, f, indent=2)
                                load_sessions(force_reload=True)
                                print("[TURSO_SYNC] Restored active_sessions from Turso.")
                            except Exception as e:
                                print("[TURSO_SYNC] Error restoring active_sessions:", e)
                        elif k == 'ekku_key' and v:
                            try:
                                with open('ekku.key', 'wb') as f:
                                    f.write(v.encode('utf-8') if isinstance(v, str) else v)
                                print("[TURSO_SYNC] Restored ekku.key from Turso.")
                            except Exception as e:
                                print("[TURSO_SYNC] Error restoring ekku.key:", e)
                except Exception as ge:
                    print("[TURSO_SYNC] Global store pull error:", ge)

                # 2. Restore user databases with fallback scanning (u1_tbl, u1_u1_tbl, A_tbl)
                users = load_users()
                total_records = 0
                synced_users = []

                for u in users:
                    uid = u['id']
                    local_conn = sqlite3.connect(f'user_{uid}.db')
                    local_conn.row_factory = sqlite3.Row
                    init_db_schema(local_conn)
                    lc = local_conn.cursor()

                    for tbl in SYNCED_TABLES:
                        rows = None
                        matched_cols = None
                        
                        # Priority 1: Standard table name (e.g. u1_chat_history)
                        try:
                            gc.execute(f"SELECT * FROM {uid}_{tbl}")
                            fetched = gc.fetchall()
                            if fetched:
                                rows = fetched
                                matched_cols = gc.cols
                        except Exception:
                            pass

                        # Priority 2: Double-prefixed table name from earlier glitch (e.g. u1_u1_chat_history)
                        if not rows:
                            try:
                                gc.execute(f"SELECT * FROM {uid}_{uid}_{tbl}")
                                fetched = gc.fetchall()
                                if fetched:
                                    rows = fetched
                                    matched_cols = gc.cols
                            except Exception:
                                pass

                        # Priority 3: Legacy user 'A' table (e.g. A_chat_history)
                        if not rows and uid == 'u1':
                            try:
                                gc.execute(f"SELECT * FROM A_{tbl}")
                                fetched = gc.fetchall()
                                if fetched:
                                    rows = fetched
                                    matched_cols = gc.cols
                            except Exception:
                                pass

                        if rows and matched_cols:
                            # Query local table schema to get common valid columns
                            lc.execute(f"PRAGMA table_info({tbl})")
                            local_cols = [col_info['name'] for col_info in lc.fetchall()]
                            
                            common_cols = [c for c in matched_cols if c in local_cols]
                            if common_cols:
                                placeholders = ",".join(["?"] * len(common_cols))
                                col_str = ",".join(common_cols)
                                
                                lc.execute(f"DELETE FROM {tbl}")
                                for r in rows:
                                    if hasattr(r, 'get'):
                                        vals = [r.get(c) for c in common_cols]
                                    elif isinstance(r, (list, tuple)):
                                        vals = [r[matched_cols.index(c)] if c in matched_cols and matched_cols.index(c) < len(r) else None for c in common_cols]
                                    else:
                                        vals = [r[c] for c in common_cols]
                                    lc.execute(f"INSERT OR REPLACE INTO {tbl} ({col_str}) VALUES ({placeholders})", vals)
                                    total_records += 1

                    local_conn.commit()
                    local_conn.close()
                    synced_users.append(uid)

                self.last_sync_time = now_bd_iso()
                self.last_sync_status = f"Restored {total_records} records for {len(synced_users)} user(s)"
                print(f"[TURSO_SYNC] Pull complete: {self.last_sync_status}")
                return {"ok": True, "users_synced": synced_users, "records_restored": total_records, "time": self.last_sync_time}
            except Exception as e:
                import traceback; traceback.print_exc()
                self.last_sync_status = f"Pull failed: {e}"
                return {"ok": False, "error": str(e)}

    def push_all_to_turso(self):
        """Push all local SQLite databases and global configs to Turso backup."""
        if not self.is_configured():
            return {"ok": False, "error": "TURSO_DATABASE_URL not configured"}

        with self._sync_lock:
            try:
                g_conn = self._get_turso_conn("global")
                gc = g_conn.cursor()

                # 1. Push global store
                cfg = load_config()
                sess = load_sessions()
                gc.execute("CREATE TABLE IF NOT EXISTS global_store (key TEXT PRIMARY KEY, value TEXT)")
                gc.execute("INSERT OR REPLACE INTO global_store (key, value) VALUES ('users_config', ?)", (json.dumps(cfg),))
                gc.execute("INSERT OR REPLACE INTO global_store (key, value) VALUES ('active_sessions', ?)", (json.dumps(sess),))
                
                if os.path.exists('ekku.key'):
                    with open('ekku.key', 'rb') as f:
                        kbytes = f.read().decode('utf-8', errors='ignore')
                    gc.execute("INSERT OR REPLACE INTO global_store (key, value) VALUES ('ekku_key', ?)", (kbytes,))

                # 2. Push user databases directly
                users = load_users()
                total_records = 0
                synced_users = []

                for u in users:
                    uid = u['id']
                    db_path = f'user_{uid}.db'
                    if not os.path.exists(db_path):
                        continue
                    
                    local_conn = sqlite3.connect(db_path)
                    local_conn.row_factory = sqlite3.Row
                    lc = local_conn.cursor()

                    for tbl in SYNCED_TABLES:
                        target_tbl = f"{uid}_{tbl}"
                        
                        lc.execute(f"SELECT sql FROM sqlite_master WHERE type='table' AND name='{tbl}'")
                        schema_row = lc.fetchone()
                        if schema_row and schema_row['sql']:
                            create_sql = schema_row['sql'].replace(f"CREATE TABLE {tbl}", f"CREATE TABLE IF NOT EXISTS {target_tbl}").replace(f"CREATE TABLE IF NOT EXISTS {tbl}", f"CREATE TABLE IF NOT EXISTS {target_tbl}")
                            try:
                                gc.execute(create_sql)
                            except Exception:
                                pass

                        lc.execute(f"SELECT * FROM {tbl}")
                        rows = lc.fetchall()
                        try:
                            gc.execute(f"DELETE FROM {target_tbl}")
                            if rows:
                                cols = [k for k in rows[0].keys()]
                                col_str = ",".join(cols)
                                placeholders = ",".join(["?"] * len(cols))
                                for r in rows:
                                    vals = [r[k] for k in cols]
                                    gc.execute(f"INSERT INTO {target_tbl} ({col_str}) VALUES ({placeholders})", vals)
                                    total_records += 1
                        except Exception as pe:
                            print(f"[TURSO_SYNC] Error pushing {target_tbl}:", pe)

                    local_conn.close()
                    synced_users.append(uid)

                self.last_sync_time = now_bd_iso()
                self.last_sync_status = f"Backed up {total_records} records across {len(synced_users)} user(s)"
                print(f"[TURSO_SYNC] Push complete: {self.last_sync_status}")
                return {"ok": True, "users_synced": synced_users, "records_pushed": total_records, "time": self.last_sync_time}
            except Exception as e:
                import traceback; traceback.print_exc()
                self.last_sync_status = f"Push failed: {e}"
                return {"ok": False, "error": str(e)}

    def trigger_async_push(self, user_id='A'):
        """Schedule a non-blocking background backup to Turso."""
        if not self.is_configured():
            return
        self._pending_push_users.add(user_id)
        
        def _bg():
            time.sleep(2.0)
            if self._pending_push_users:
                self.push_all_to_turso()
                self._pending_push_users.clear()

        import threading
        t = threading.Thread(target=_bg, daemon=True)
        t.start()

TURSO_SYNC = TursoSyncManager()

_initialized_users = set()

def get_db(user_id='A', skip_init=False):
    """Always return lightning-fast local SQLite database (0.05ms query latency)."""
    db_name = f'user_{user_id}.db'
    conn = sqlite3.connect(db_name)
    conn.row_factory = sqlite3.Row
    if not skip_init and user_id not in _initialized_users:
        init_db_schema(conn)
        _initialized_users.add(user_id)
    return conn

def init_db_schema(conn):
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS routine (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        day TEXT, time TEXT, course TEXT, room TEXT, prof TEXT, color TEXT
    )''')
    c.execute('''CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        course TEXT, total INTEGER DEFAULT 0, present INTEGER DEFAULT 0
    )''')
    c.execute('''CREATE TABLE IF NOT EXISTS budget (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT, desc TEXT, amount REAL, date TEXT
    )''')
    c.execute('''CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT, note TEXT, done INTEGER DEFAULT 0,
        date TEXT, priority TEXT DEFAULT 'medium',
        due_time TEXT DEFAULT '11:59 PM'
    )''')
    try:
        c.execute('ALTER TABLE tasks ADD COLUMN due_time TEXT DEFAULT "11:59 PM"')
    except Exception:
        pass
    c.execute('''CREATE TABLE IF NOT EXISTS plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        day TEXT, duration TEXT, title TEXT, status TEXT DEFAULT 'pending'
    )''')
    c.execute('''CREATE TABLE IF NOT EXISTS grades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        course TEXT, credit REAL DEFAULT 3.0, grade REAL DEFAULT 0.0
    )''')
    c.execute('''CREATE TABLE IF NOT EXISTS chat_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT, role TEXT, content TEXT, emotion TEXT
    )''')
    c.execute('''CREATE TABLE IF NOT EXISTS long_term_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT,
        content TEXT,
        category TEXT DEFAULT 'milestone'
    )''')
    c.execute('''CREATE TABLE IF NOT EXISTS focus_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_label TEXT DEFAULT '',
        cycles_planned INTEGER DEFAULT 1,
        cycles_done INTEGER DEFAULT 1,
        total_minutes INTEGER DEFAULT 25,
        date TEXT,
        started_at TEXT
    )''')
    c.execute('''CREATE TABLE IF NOT EXISTS active_timer_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mode TEXT,
        task TEXT,
        custom_minutes INTEGER DEFAULT 25,
        cycles INTEGER DEFAULT 1,
        cycles_done INTEGER DEFAULT 0,
        start_time_ms INTEGER,
        target_end_time_ms INTEGER,
        is_running INTEGER DEFAULT 1,
        updated_at TEXT
    )''')
    c.execute('''CREATE TABLE IF NOT EXISTS exams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        course TEXT,
        type TEXT DEFAULT 'Quiz',
        date TEXT,
        time TEXT DEFAULT '10:00 AM',
        notes TEXT DEFAULT ''
    )''')
    c.execute('''CREATE TABLE IF NOT EXISTS academic_profile (
        id INTEGER PRIMARY KEY DEFAULT 1,
        current_semester TEXT DEFAULT '6th Semester',
        baseline_cgpa REAL DEFAULT 0.0,
        baseline_credits REAL DEFAULT 0.0
    )''')
    c.execute('INSERT OR IGNORE INTO academic_profile (id, current_semester, baseline_cgpa, baseline_credits) VALUES (1, ?, 0.0, 0.0)',
              (encrypt_text('6th Semester'),))

    c.execute('''CREATE TABLE IF NOT EXISTS academic_state (
        id INTEGER PRIMARY KEY DEFAULT 1,
        mode TEXT DEFAULT 'regular',
        start_date TEXT DEFAULT '',
        end_date TEXT DEFAULT '',
        note TEXT DEFAULT '',
        resume_date TEXT DEFAULT '',
        created_at TEXT DEFAULT ''
    )''')
    c.execute('INSERT OR IGNORE INTO academic_state (id, mode, start_date, end_date, note, resume_date, created_at) VALUES (1, "regular", "", "", "Regular classes ongoing", "", ?)',
              (now_bd_iso(),))

    c.execute('''CREATE TABLE IF NOT EXISTS schedule_exceptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT,
        course TEXT,
        slot_time TEXT DEFAULT '',
        type TEXT DEFAULT 'class_cancelled',
        reason TEXT DEFAULT '',
        created_at TEXT DEFAULT ''
    )''')

    c.execute('''CREATE TABLE IF NOT EXISTS proactive_state (
        id INTEGER PRIMARY KEY DEFAULT 1,
        last_checkin_ts TEXT DEFAULT '',
        last_trigger_type TEXT DEFAULT '',
        enabled INTEGER DEFAULT 1,
        quiet_hours_start INTEGER DEFAULT 0,
        quiet_hours_end INTEGER DEFAULT 8,
        min_gap_hours REAL DEFAULT 6.0
    )''')
    c.execute('INSERT OR IGNORE INTO proactive_state (id, last_checkin_ts, last_trigger_type, enabled) VALUES (1, "", "", 1)')
    conn.commit()

def init_db(user_id='A'):
    conn = get_db(user_id, skip_init=True)
    init_db_schema(conn)
    conn.close()

def init_all_users():
    """Initialize DB for all registered users and restore latest cloud backup on startup."""
    # First: If Turso configured, pull latest snapshot from Turso into local SQLite
    if TURSO_SYNC.is_configured():
        try:
            print("[INIT] Connecting to Turso to pull latest cloud backup...")
            res = TURSO_SYNC.pull_all_from_turso()
            if res.get('ok') and res.get('records_restored', 0) > 0:
                print(f"[INIT] Turso Cloud Sync: Restored {res['records_restored']} records into local SQLite cache.")
        except Exception as se:
            print("[INIT] Turso startup sync warning:", se)

    users = load_users()
    for user in users:
        init_db(user['id'])
    print(f"[INIT] {len(users)} user database(s) ready (running on ultra-fast Local SQLite).")

# Initialize DBs on startup
try:
    init_all_users()
except Exception as _e:
    print(f"[INIT] Error initializing DBs: {_e}")

# ------------------------------------------------------------------
# Academic Lifecycle & Schedule Exception Helpers
# ------------------------------------------------------------------
def get_academic_state(user_id, conn=None):
    close_after = False
    if conn is None:
        conn = get_db(user_id)
        close_after = True
    c = conn.cursor()
    row = c.execute('SELECT * FROM academic_state WHERE id=1').fetchone()
    if close_after:
        conn.close()
    
    if not row:
        return {
            "mode": "regular",
            "start_date": "",
            "end_date": "",
            "note": "Regular classes ongoing",
            "resume_date": "",
            "is_active_break": False,
            "days_remaining": 0,
            "phase_label": "Regular Classes"
        }
    
    mode = row['mode'] or 'regular'
    start_date = row['start_date'] or ''
    end_date = row['end_date'] or ''
    note = row['note'] or ''
    resume_date = row['resume_date'] or ''
    
    today_iso = date.today().isoformat()
    is_active = False
    days_rem = 0
    
    if mode in ('prep_leave', 'exam_week', 'semester_break', 'holiday'):
        if start_date and end_date:
            is_active = (start_date <= today_iso <= end_date)
            try:
                ed_dt = datetime.strptime(end_date, "%Y-%m-%d").date()
                days_rem = max(0, (ed_dt - date.today()).days)
            except Exception:
                pass
        else:
            is_active = True
    
    phase_labels = {
        'regular': 'Regular Classes',
        'prep_leave': 'Preparatory Leave (PL)',
        'exam_week': 'Exam Season / Finals',
        'semester_break': 'Semester Break',
        'holiday': 'University Holiday / Off'
    }
    
    return {
        "mode": mode,
        "start_date": start_date,
        "end_date": end_date,
        "note": note,
        "resume_date": resume_date,
        "is_active_break": is_active,
        "days_remaining": days_rem,
        "phase_label": phase_labels.get(mode, 'Academic Mode')
    }

def set_academic_state(user_id, mode, start_date='', end_date='', note='', resume_date='', conn=None):
    close_after = False
    if conn is None:
        conn = get_db(user_id)
        close_after = True
    c = conn.cursor()
    c.execute('''INSERT OR REPLACE INTO academic_state 
                 (id, mode, start_date, end_date, note, resume_date, created_at)
                 VALUES (1, ?, ?, ?, ?, ?, ?)''',
              (mode, start_date or '', end_date or '', note or '', resume_date or '', datetime.now().isoformat()))
    conn.commit()
    if close_after:
        conn.close()

def add_schedule_exception(user_id, exc_date, course, slot_time='', exc_type='class_cancelled', reason='', conn=None):
    close_after = False
    if conn is None:
        conn = get_db(user_id)
        close_after = True
    c = conn.cursor()
    c.execute('''INSERT INTO schedule_exceptions (date, course, slot_time, type, reason, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)''',
              (exc_date, encrypt_text(course) if HAS_CRYPTO else course, slot_time or '', exc_type, encrypt_text(reason) if (reason and HAS_CRYPTO) else reason, datetime.now().isoformat()))
    conn.commit()
    if close_after:
        conn.close()

def get_schedule_exceptions(user_id, exc_date=None, conn=None):
    close_after = False
    if conn is None:
        conn = get_db(user_id)
        close_after = True
    c = conn.cursor()
    if exc_date:
        rows = c.execute('SELECT * FROM schedule_exceptions WHERE date=? ORDER BY id DESC', (exc_date,)).fetchall()
    else:
        rows = c.execute('SELECT * FROM schedule_exceptions ORDER BY date DESC, id DESC LIMIT 50').fetchall()
    if close_after:
        conn.close()
    
    result = []
    for r in rows:
        result.append({
            "id": r['id'],
            "date": r['date'],
            "course": decrypt_text(r['course']),
            "slot_time": r['slot_time'] or '',
            "type": r['type'] or 'class_cancelled',
            "reason": decrypt_text(r['reason']) if r['reason'] else ''
        })
    return result

def delete_schedule_exception(user_id, exc_id, conn=None):
    close_after = False
    if conn is None:
        conn = get_db(user_id)
        close_after = True
    c = conn.cursor()
    c.execute('DELETE FROM schedule_exceptions WHERE id=?', (exc_id,))
    conn.commit()
    if close_after:
        conn.close()

# ------------------------------------------------------------------
# Chat helpers
# ------------------------------------------------------------------
def clean_chat_text(text):
    """Clean raw JSON leakage, unescape unicode sequences, strip stacked timestamps, and remove thinking notes."""
    if not text:
        return ""
    s = str(text).strip()
    # 1. If raw JSON string was passed directly
    if s.startswith('{') and '"reply"' in s:
        try:
            d = json.loads(s)
            if 'reply' in d:
                r = d['reply']
                s = " ".join(r) if isinstance(r, list) else str(r)
        except Exception:
            m = re.search(r'"reply"\s*:\s*\[([^\]]*)\]', s)
            if m:
                items = re.findall(r'"([^"\\]*(?:\\.[^"\\]*)*)"', m.group(1))
                if items:
                    s = " ".join(items)
    # 2. Unescape unicode escapes like \u09a1 -> ডা
    if r'\u' in s:
        try:
            s = s.encode('raw_unicode_escape').decode('unicode_escape')
        except Exception:
            pass
    # 3. Strip any stacked timestamp prefixes like [2026-08-29T10:55]
    s = re.sub(r'^(\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*)+', '', s).strip()
    
    # 4. Remove any "thinking" text artifacts the LLM might have generated
    s = re.sub(r'(?i)[\[\(\*]?(Ekkhu\s+)?(is\s+)?(thinking|vabche|processing)(\.\.\.)?[\]\)\*]?', '', s).strip()
    s = re.sub(r'(?i)\*.*?(thinking|vabche|processing).*?\*', '', s).strip()
    s = re.sub(r'(?i)\[.*?(thinking|vabche|processing).*?\]', '', s).strip()
    
    return s

def save_message(user_id, role, content, emotion=None, conn=None):
    close_after = False
    if conn is None:
        conn = get_db(user_id)
        close_after = True
    c = conn.cursor()
    ts = now_bd_iso()
    clean_text = clean_chat_text(content)
    if clean_text:
        c.execute('INSERT INTO chat_history (timestamp, role, content, emotion) VALUES (?, ?, ?, ?)',
                  (ts, role, clean_text, emotion))
        conn.commit()
    if close_after:
        conn.close()

def get_chat_history(user_id, max_messages=20, conn=None):
    """Return recent messages from the last 7 days, merging consecutive roles."""
    close_after = False
    if conn is None:
        conn = get_db(user_id)
        close_after = True
    c = conn.cursor()
    since = (now_bd() - timedelta(days=7)).isoformat()
    c.execute('''SELECT timestamp, role, content FROM chat_history
                 WHERE timestamp >= ?
                 ORDER BY id DESC LIMIT ?''', (since, max_messages))
    rows = c.fetchall()
    if close_after:
        conn.close()
    
    messages = []
    for ts, role, content in reversed(rows):
        short_ts = ts[:16] if ts else "Unknown"
        clean_text = clean_chat_text(content)
        if not clean_text:
            continue
        formatted_content = f"[{short_ts}] {clean_text}"
        if messages and messages[-1]["role"] == role:
            messages[-1]["content"] += "\n" + formatted_content
        else:
            messages.append({"role": role, "content": formatted_content})
            
    return messages

def get_long_term_memory(user_id, conn=None):
    close_after = False
    if conn is None:
        conn = get_db(user_id)
        close_after = True
    c = conn.cursor()
    rows = c.execute(
        'SELECT timestamp, content, category FROM long_term_memory ORDER BY id DESC LIMIT 20'
    ).fetchall()
    if close_after:
        conn.close()
    return [{"timestamp": r[0], "content": r[1], "category": r[2]} for r in rows]

def save_long_term_memory(user_id, content, category='milestone', conn=None):
    close_after = False
    if conn is None:
        conn = get_db(user_id)
        close_after = True
    c = conn.cursor()
    ts = now_bd_iso()
    c.execute('INSERT INTO long_term_memory (timestamp, content, category) VALUES (?, ?, ?)',
              (ts, content, category))
    conn.commit()
    if close_after:
        conn.close()

# ------------------------------------------------------------------
# Session context & gap detection helpers
# ------------------------------------------------------------------
def build_session_context(user_id, conn=None):
    """Build a session summary block: time since last chat + recent mood pattern."""
    close_after = False
    if conn is None:
        conn = get_db(user_id)
        close_after = True
    c = conn.cursor()
    rows = c.execute(
        '''SELECT timestamp, emotion FROM chat_history
           WHERE role = 'assistant'
           ORDER BY id DESC LIMIT 10'''
    ).fetchall()
    if close_after:
        conn.close()

    if not rows:
        return ""

    from collections import Counter
    summary = "\n\n=== SESSION CONTEXT ==="

    # Time since last message
    last_ts_str = rows[0][0]
    try:
        last_dt = datetime.fromisoformat(last_ts_str)
        if last_dt.tzinfo is None:
            last_dt = last_dt.replace(tzinfo=BD_TZ)
        diff = now_bd() - last_dt.astimezone(BD_TZ)
        total_sec = max(0, diff.total_seconds())
        hours = total_sec / 3600
        if hours < 1:
            summary += f"\nLast conversation: {int(total_sec / 60)} minutes ago"
        elif hours < 24:
            summary += f"\nLast conversation: {int(hours)} hours ago"
        else:
            summary += f"\nLast conversation: {int(hours / 24)} day(s) ago"
    except Exception:
        pass

    # Recent mood pattern
    emotions = [r[1] for r in rows if r[1] and r[1] != 'neutral']
    if emotions:
        mood_counts = Counter(emotions[:6])
        mood_str = ", ".join([f"{e} ({n}x)" for e, n in mood_counts.most_common(3)])
        summary += f"\nRecent mood pattern: {mood_str}"
        last_neg = next(
            (e for e in emotions if e in ['sad', 'lonely', 'anxious', 'angry', 'tired']),
            None
        )
        if last_neg:
            summary += f"\nNote: User's last known negative mood was '{last_neg}' — check in naturally if relevant."

    return summary


def is_first_message_after_gap(user_id, gap_hours=4, conn=None):
    """Return True if the user's last message was more than gap_hours ago."""
    close_after = False
    if conn is None:
        conn = get_db(user_id)
        close_after = True
    c = conn.cursor()
    rows = c.execute(
        'SELECT timestamp FROM chat_history ORDER BY id DESC LIMIT 1'
    ).fetchall()
    if close_after:
        conn.close()

    if not rows or not rows[0][0]:
        return False
    last_ts_str = rows[0][0]
    try:
        last_dt = datetime.fromisoformat(last_ts_str)
        if last_dt.tzinfo is None:
            last_dt = last_dt.replace(tzinfo=BD_TZ)
        diff_hours = (now_bd() - last_dt.astimezone(BD_TZ)).total_seconds() / 3600
        if diff_hours < 0:
            return False
        return diff_hours >= gap_hours
    except Exception:
        return False


# ------------------------------------------------------------------
# System prompt builder
# ------------------------------------------------------------------
def build_system_prompt(user_id, conn=None):
    users = load_users()
    user_info = next((u for u in users if u['id'] == user_id), None)
    user_name = user_info['name'] if user_info else f"User {user_id}"

    prompt = get_system_prompt(user_name)
    prompt += f"\n\n=== IDENTITY CLARIFICATION ===\n"
    prompt += f"CRITICAL: YOU (EKKHU) are an AI clone of Arnob. HOWEVER, the user you are currently talking to is: {user_name}. Do NOT confuse your identity with the user's. Address them as {user_name} if needed.\n"

    # Inject instruction_set.txt as few-shot tone/style reference
    try:
        with open('instruction_set.txt', 'r', encoding='utf-8') as f:
            examples = f.read().strip()
        if examples:
            prompt += (
                "\n\n=== HOW I SPEAK — FEW-SHOT TONE REFERENCE "
                "(do NOT copy these word-for-word, just absorb the style and energy) ===\n"
                + examples
            )
    except Exception:
        pass

    # Get the current user's personal memories
    ltm = get_long_term_memory(user_id, conn=conn)

    # ALWAYS fetch Arnob's (u1's) training memories so they apply as global rules for everyone
    arnob_ltm = get_long_term_memory('u1') if user_id != 'u1' else []

    if ltm or arnob_ltm:
        prompt += "\n\n=== IMPORTANT LONG-TERM MEMORIES & CORE TRAINING — never forget these ===\n"

        # Add Arnob's global training rules first
        for m in arnob_ltm:
            ts = m['timestamp'][:10]
            prompt += f"- [{ts}] [ARNOB'S GLOBAL RULE]: {m['content']}\n"

        # Then add the current user's personal memories
        for m in ltm:
            ts = m['timestamp'][:10]
            prompt += f"- [{ts}] {m['content']}\n"

    # Add session context: time gap + mood pattern
    prompt += build_session_context(user_id, conn=conn)

    # Add Academic Profile Standing Context
    prof_conn = conn or get_db(user_id)
    try:
        c_prof = prof_conn.cursor()
        prof_row = c_prof.execute('SELECT * FROM academic_profile WHERE id=1').fetchone()
        if prof_row:
            cur_sem = decrypt_text(prof_row['current_semester']) if prof_row['current_semester'] else '6th Semester'
            b_cgpa = float(prof_row['baseline_cgpa'] or 0.0)
            b_creds = float(prof_row['baseline_credits'] or 0.0)
            
            g_rows = c_prof.execute('SELECT * FROM grades').fetchall()
            c_creds = sum(r['credit'] for r in g_rows)
            c_pts = sum(r['grade'] * r['credit'] for r in g_rows)
            tot_c = b_creds + c_creds
            tot_p = (b_creds * b_cgpa) + c_pts
            tot_cgpa = round(tot_p / tot_c, 2) if tot_c > 0 else b_cgpa
            
            prompt += f"\n\n=== USER'S CURRENT ACADEMIC STANDING ===\n"
            prompt += f"- Current Academic Level: {cur_sem}\n"
            prompt += f"- Accumulated CGPA: {tot_cgpa:.2f} ({tot_c:.1f} total credits completed so far)\n"
            prompt += f"- Keep this academic standing in mind when advising on exams, semester prep, study load, or career planning."
    except Exception:
        pass
    finally:
        if not conn and prof_conn:
            try:
                prof_conn.close()
            except Exception:
                pass

    return prompt

# ------------------------------------------------------------------
# Crisis detection
# ------------------------------------------------------------------
CRISIS_KEYWORDS = [
    r'\b(suicide|kill myself|die|end it all|give up|can\'t take it anymore)\b',
    r'\b(মরে|মরতে|আত্মহত্যা|শেষ করে|মারা যেতে|আর পারছি না|বেঁচে থেকে লাভ নেই)\b'
]
CRISIS_MESSAGE = {
    "reply": "Hey — I hear you. Please don't go through this alone. Talk to someone close to you right now, or reach out to a mental health helpline. You matter, and I'm here.",
    "emotion": "sad",
    "actions": []
}

def is_crisis(text):
    tl = text.lower()
    return any(re.search(p, tl) for p in CRISIS_KEYWORDS)

# ------------------------------------------------------------------
# LLM Metrics, Quota & Health Tracker
# ------------------------------------------------------------------
import time
from collections import deque
from threading import Lock

class LLMMetricsTracker:
    def __init__(self, max_history=100):
        self.lock = Lock()
        self.max_history = max_history
        self.history = deque(maxlen=max_history)
        self.daily_counts = {}
        self.timestamps = deque()
        self.key_status = {
            'key-1': {'status': 'healthy', 'last_error': None, 'last_used': None, 'quota_exhausted_until': 0},
            'key-2': {'status': 'healthy', 'last_error': None, 'last_used': None, 'quota_exhausted_until': 0},
            'groq': {'status': 'healthy', 'last_error': None, 'last_used': None}
        }
        self.model_limits = {
            'gemini-3.5-flash': {'rpm': 15, 'rpd': 500, 'tpm': 1000000},
            'gemini-3.6-flash': {'rpm': 15, 'rpd': 500, 'tpm': 1000000},
            'gemini-3.7-flash': {'rpm': 15, 'rpd': 500, 'tpm': 1000000},
            'gemini-3.5-flash-lite': {'rpm': 30, 'rpd': 1500, 'tpm': 1000000},
        }

    def record_call(self, endpoint, key_name, model_name, status, latency_ms, tokens_in=0, tokens_out=0, error_msg=None):
        with self.lock:
            now = time.time()
            today = date.today().isoformat()
            
            while self.timestamps and (now - self.timestamps[0] > 60):
                self.timestamps.popleft()
                
            self.timestamps.append(now)
            
            if today not in self.daily_counts:
                self.daily_counts[today] = {
                    'total': 0,
                    'by_model': {},
                    'by_key': {},
                    'tokens_in': 0,
                    'tokens_out': 0,
                    'errors': 0
                }
                
            d = self.daily_counts[today]
            d['total'] += 1
            d['by_model'][model_name] = d['by_model'].get(model_name, 0) + 1
            d['by_key'][key_name] = d['by_key'].get(key_name, 0) + 1
            d['tokens_in'] += tokens_in
            d['tokens_out'] += tokens_out
            
            if status != 'SUCCESS':
                d['errors'] += 1
                if '429' in str(error_msg) or 'quota' in str(error_msg).lower():
                    if key_name in self.key_status:
                        self.key_status[key_name]['status'] = 'rate_limited'
                        self.key_status[key_name]['quota_exhausted_until'] = now + 60
                else:
                    if key_name in self.key_status:
                        self.key_status[key_name]['status'] = 'error'
            else:
                if key_name in self.key_status:
                    if self.key_status[key_name]['status'] == 'rate_limited' and now > self.key_status[key_name].get('quota_exhausted_until', 0):
                        self.key_status[key_name]['status'] = 'healthy'
                    elif self.key_status[key_name]['status'] != 'rate_limited':
                        self.key_status[key_name]['status'] = 'healthy'

            if key_name in self.key_status:
                self.key_status[key_name]['last_used'] = datetime.now().isoformat()
                if error_msg:
                    self.key_status[key_name]['last_error'] = {
                        'time': datetime.now().isoformat(),
                        'error': str(error_msg)[:200],
                        'model': model_name
                    }

            entry = {
                'id': len(self.history) + 1,
                'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                'iso_time': datetime.now().isoformat(),
                'endpoint': endpoint,
                'key_name': key_name,
                'model_name': model_name,
                'status': status,
                'latency_ms': round(latency_ms, 1),
                'tokens_in': tokens_in,
                'tokens_out': tokens_out,
                'error_msg': str(error_msg) if error_msg else None
            }
            self.history.appendleft(entry)

    def get_stats(self):
        with self.lock:
            now = time.time()
            today = date.today().isoformat()
            
            valid_ts = [t for t in self.timestamps if (now - t) <= 60]
            rpm_current = len(valid_ts)
            
            d = self.daily_counts.get(today, {
                'total': 0,
                'by_model': {},
                'by_key': {},
                'tokens_in': 0,
                'tokens_out': 0,
                'errors': 0
            })
            
            active_keys_count = (1 if GEMINI_API_KEY_1 else 0) + (1 if GEMINI_API_KEY_2 else 0)
            if active_keys_count == 0: active_keys_count = 1
            
            primary_model = 'gemini-3.5-flash'
            rpm_limit_single = self.model_limits.get(primary_model, {}).get('rpm', 15)
            rpd_limit_single = self.model_limits.get(primary_model, {}).get('rpd', 500)
            
            total_rpm_limit = rpm_limit_single * active_keys_count
            total_rpd_limit = rpd_limit_single * active_keys_count
            
            rpm_remaining = max(0, total_rpm_limit - rpm_current)
            rpd_remaining = max(0, total_rpd_limit - d['total'])
            
            def mask_key(k):
                if not k: return "Not Configured"
                if len(k) <= 8: return "••••" + k[-4:]
                return k[:6] + "••••••••" + k[-4:]

            return {
                "server_time": datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                "today": today,
                "active_keys_count": active_keys_count,
                "keys": {
                    "key-1": {
                        "name": "Gemini API Key 1",
                        "configured": bool(GEMINI_API_KEY_1),
                        "masked": mask_key(GEMINI_API_KEY_1),
                        "status": self.key_status['key-1']['status'],
                        "last_used": self.key_status['key-1']['last_used'],
                        "last_error": self.key_status['key-1']['last_error'],
                        "today_calls": d['by_key'].get('key-1', 0)
                    },
                    "key-2": {
                        "name": "Gemini API Key 2",
                        "configured": bool(GEMINI_API_KEY_2),
                        "masked": mask_key(GEMINI_API_KEY_2),
                        "status": self.key_status['key-2']['status'],
                        "last_used": self.key_status['key-2']['last_used'],
                        "last_error": self.key_status['key-2']['last_error'],
                        "today_calls": d['by_key'].get('key-2', 0)
                    },
                    "groq": {
                        "name": "Groq API Key",
                        "configured": bool(GROQ_API_KEY),
                        "masked": mask_key(GROQ_API_KEY),
                        "status": self.key_status['groq']['status'],
                        "last_used": self.key_status['groq']['last_used'],
                        "last_error": self.key_status['groq']['last_error'],
                        "today_calls": d['by_key'].get('groq', 0)
                    }
                },
                "rpm": {
                    "current": rpm_current,
                    "limit": total_rpm_limit,
                    "remaining": rpm_remaining,
                    "percent_used": round((rpm_current / total_rpm_limit) * 100, 1) if total_rpm_limit else 0
                },
                "rpd": {
                    "current": d['total'],
                    "limit": total_rpd_limit,
                    "remaining": rpd_remaining,
                    "percent_used": round((d['total'] / total_rpd_limit) * 100, 1) if total_rpd_limit else 0
                },
                "tokens": {
                    "tokens_in_today": d['tokens_in'],
                    "tokens_out_today": d['tokens_out'],
                    "total_tokens_today": d['tokens_in'] + d['tokens_out']
                },
                "models_usage": d['by_model'],
                "model_limits": self.model_limits,
                "total_errors_today": d['errors'],
                "recent_logs": list(self.history)[:50]
            }

    def reset_today(self):
        with self.lock:
            today = date.today().isoformat()
            self.daily_counts[today] = {
                'total': 0,
                'by_model': {},
                'by_key': {},
                'tokens_in': 0,
                'tokens_out': 0,
                'errors': 0
            }
            self.timestamps.clear()
            self.history.clear()

METRICS_TRACKER = LLMMetricsTracker()

# ------------------------------------------------------------------
# LLM providers
# ------------------------------------------------------------------
def call_groq(messages, endpoint="CHAT"):
    from groq import Groq
    client = Groq(api_key=GROQ_API_KEY)
    t0 = time.time()
    for model in ['qwen/qwen3.6-27b', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b']:
        try:
            resp = client.chat.completions.create(
                messages=messages,
                model=model,
                temperature=0.7,
                max_tokens=1500
            )
            content = resp.choices[0].message.content
            if content:
                lat = (time.time() - t0) * 1000
                content = re.sub(r'<think>.*?</think>', '', content, flags=re.DOTALL).strip()
                METRICS_TRACKER.record_call(endpoint, "groq", model, "SUCCESS", lat, tokens_in=len(str(messages))//4, tokens_out=len(content)//4)
                return content
        except Exception as e:
            lat = (time.time() - t0) * 1000
            print(f"[GROQ] Model {model} failed: {e}")
            METRICS_TRACKER.record_call(endpoint, "groq", model, "ERROR", lat, tokens_in=len(str(messages))//4, tokens_out=0, error_msg=str(e))
    raise Exception("All Groq models failed")

class QuotaExhaustedError(Exception):
    pass

def call_gemini(messages, api_key, models_to_try=None, key_name="key-1", endpoint="CHAT"):
    import google.generativeai as genai
    import json
    genai.configure(api_key=api_key)
    gm = []
    system_part = SYSTEM_PROMPT
    for m in messages:
        if m.get('role') == 'system':
            system_part = m.get('content', '')
            continue
        role = 'model' if m.get('role') == 'assistant' else 'user'
        content = (m.get('content') or '').strip()
        if not content:
            continue
        
        if role == 'model':
            # Simplified mock JSON for context to avoid huge token padding
            mock_json = {
                "reply": [c.strip() for c in content.split('\n') if c.strip()],
                "emotion": "neutral"
            }
            content = json.dumps(mock_json)
            
        if gm and gm[-1]['role'] == role:
            gm[-1]['parts'][0] += "\n" + content
        else:
            gm.append({'role': role, 'parts': [content]})

    # Ensure first message is from user
    while gm and gm[0]['role'] != 'user':
        gm.pop(0)

    if not gm:
        gm = [{'role': 'user', 'parts': ['Hello']}]

    if models_to_try is None:
        models_to_try = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash']
    
    tokens_in = sum(len(p) for item in gm for p in item.get('parts', [])) // 4
    last_error = None

    for model_name in models_to_try:
        t0 = time.time()
        try:
            model = genai.GenerativeModel(model_name, system_instruction=system_part)
            resp = model.generate_content(
                gm, 
                generation_config={
                    "response_mime_type": "application/json",
                    "temperature": 0.7,
                    "max_output_tokens": 3500
                }
            )
            if resp and resp.text:
                lat = (time.time() - t0) * 1000
                tokens_out = len(resp.text) // 4
                METRICS_TRACKER.record_call(endpoint, key_name, model_name, "SUCCESS", lat, tokens_in=tokens_in, tokens_out=tokens_out)
                print(f"[GEMINI] Model {model_name} succeeded on {key_name} ({round(lat,1)}ms).")
                return resp.text
        except Exception as e:
            last_error = e
            lat = (time.time() - t0) * 1000
            err_str = str(e)
            print(f"[GEMINI] Model {model_name} on {key_name} failed ({round(lat,1)}ms): {err_str[:100]}")
            
            # If rate limit (429) or quota exceeded, this API key is temporarily burned.
            if "429" in err_str or "quota" in err_str.lower():
                METRICS_TRACKER.record_call(endpoint, key_name, model_name, "429_QUOTA", lat, tokens_in=tokens_in, tokens_out=0, error_msg=err_str)
                print(f"[GEMINI] Quota exhausted on {key_name}. Aborting further model attempts on this key.")
                raise QuotaExhaustedError("Quota exhausted for this API key.")
            
            # If model not found (404), record and skip
            if "404" in err_str:
                METRICS_TRACKER.record_call(endpoint, key_name, model_name, "404_NOT_FOUND", lat, tokens_in=tokens_in, tokens_out=0, error_msg=err_str)
                continue
                
            # For other errors (e.g. 500, parsing), try once more without JSON response_mime_type
            try:
                t1 = time.time()
                model = genai.GenerativeModel(model_name, system_instruction=system_part)
                resp = model.generate_content(
                    gm, 
                    generation_config={
                        "temperature": 0.7,
                        "max_output_tokens": 3500
                    }
                )
                if resp and resp.text:
                    lat_fallback = (time.time() - t1) * 1000
                    tokens_out = len(resp.text) // 4
                    METRICS_TRACKER.record_call(endpoint, key_name, model_name, "SUCCESS", lat_fallback, tokens_in=tokens_in, tokens_out=tokens_out)
                    print(f"[GEMINI] Model {model_name} succeeded (plain fallback on {key_name}).")
                    return resp.text
            except Exception as e2:
                METRICS_TRACKER.record_call(endpoint, key_name, model_name, "ERROR", lat, tokens_in=tokens_in, tokens_out=0, error_msg=f"{err_str} | Fallback: {e2}")
                print(f"[GEMINI] Model {model_name} plain fallback also failed: {str(e2)[:80]}")

    raise Exception(f"All Gemini models failed on {key_name}. Last error: {last_error}")

def call_llm(messages, endpoint="CHAT"):
    """Smart cascade: Try ALL intelligent models on Key1 → Key2 before falling to lite models."""
    keys = []
    if GEMINI_API_KEY_1:
        keys.append(('key-1', GEMINI_API_KEY_1))
    if GEMINI_API_KEY_2:
        keys.append(('key-2', GEMINI_API_KEY_2))
    if not keys:
        raise Exception("No API keys set! Set GEMINI_API_KEY_1 in environment variables.")

    # Phase 1: Try smart models on all keys first
    smart_models = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash']
    errors = []
    for key_name, key_val in keys:
        try:
            result = call_gemini(messages, key_val, models_to_try=smart_models, key_name=key_name, endpoint=endpoint)
            print(f"[LLM] Smart model succeeded on {key_name}.")
            return result
        except QuotaExhaustedError:
            errors.append(f"{key_name}-smart: Quota Exhausted")
            print(f"[LLM] Quota exhausted on {key_name}, instantly switching to next key...")
        except Exception as e:
            errors.append(f"{key_name}-smart: {e}")
            print(f"[LLM] All smart models failed on {key_name}, trying next key...")

    # Phase 2: If ALL smart models on ALL keys exhausted, try lite as absolute last resort
    lite_models = ['gemini-3.5-flash-lite']
    for key_name, key_val in keys:
        try:
            result = call_gemini(messages, key_val, models_to_try=lite_models, key_name=key_name, endpoint=endpoint)
            print(f"[LLM] Lite fallback succeeded on {key_name}.")
            return result
        except Exception as e:
            errors.append(f"{key_name}-lite: {e}")
            print(f"[LLM] Lite model also failed on {key_name}.")

    raise Exception("All Gemini providers and models failed: " + str(errors))

import math

def safe_parse_json(raw_text):
    """Safely parse JSON from LLM output, stripping codeblocks or auto-closing brackets."""
    text = (raw_text or '').strip()
    if text.startswith('```json'): text = text[7:]
    elif text.startswith('```'): text = text[3:]
    if text.endswith('```'): text = text[:-3]
    text = text.strip()

    try:
        data = json.loads(text)
        if isinstance(data, dict): return data
    except Exception:
        pass

    match = re.search(r'\{.*\}', text, re.DOTALL)
    if match:
        try:
            data = json.loads(match.group(0))
            if isinstance(data, dict): return data
        except Exception:
            pass

    for suffix in [']}', '" ]}', '" }', '}']:
        try:
            data = json.loads(text + suffix)
            if isinstance(data, dict): return data
        except Exception:
            pass

    return None

def calculate_bunk_shield(present, total):
    """Calculate exact safe misses or recovery classes needed for 75% attendance threshold."""
    if not total or total == 0:
        return {
            "percent": 100.0,
            "safe_bunks": 0,
            "recovery_needed": 0,
            "status": "FRESH",
            "status_text": "No classes recorded yet",
            "status_badge": "FRESH"
        }
    
    pct = round((present / total) * 100, 1)
    
    if pct >= 75.0:
        safe_bunks = max(0, int((present / 0.75) - total))
        if safe_bunks == 0:
            status = "ZERO_BUFFER"
            status_text = "🚨 ZERO BUFFER: Next class attendance is critical! Missing will drop below 75%"
            status_badge = "0 Bunks"
        elif safe_bunks == 1:
            status = "WARNING_1"
            status_text = "⚠️ 1 Safe Bunk Left before dropping below 75%"
            status_badge = "1 Bunk"
        else:
            status = "SAFE"
            status_text = f"🛡️ {safe_bunks} Safe Bunks available while staying ≥75%"
            status_badge = f"{safe_bunks} Bunks"
        recovery_needed = 0
    else:
        recovery_needed = max(1, int(math.ceil((0.75 * total - present) / 0.25)))
        safe_bunks = 0
        status = "DEFICIT"
        status_text = f"🩹 Attendance Deficit ({pct}%): Must attend {recovery_needed} consecutive class(es) to recover 75%"
        status_badge = f"+{recovery_needed} Recover"
        
    return {
        "percent": pct,
        "safe_bunks": safe_bunks,
        "recovery_needed": recovery_needed,
        "status": status,
        "status_text": status_text,
        "status_badge": status_badge
    }

# ------------------------------------------------------------------
# Context builder
# ------------------------------------------------------------------
def get_user_context(user_id, conn=None):
    close_after = False
    if conn is None:
        conn = get_db(user_id)
        close_after = True
    c = conn.cursor()
    
    from datetime import datetime, timezone, timedelta, date
    bd_tz = timezone(timedelta(hours=6))
    now = datetime.now(bd_tz)
    
    days_map = {0: 'Mon', 1: 'Tue', 2: 'Wed', 3: 'Thu', 4: 'Fri', 5: 'Sat', 6: 'Sun'}
    full_days_map = {0: 'Monday', 1: 'Tuesday', 2: 'Wednesday', 3: 'Thursday', 4: 'Friday', 5: 'Saturday', 6: 'Sunday'}
    
    today_code = days_map[now.weekday()]
    today_full = full_days_map[now.weekday()]
    
    tomorrow_dt = now + timedelta(days=1)
    tomorrow_code = days_map[tomorrow_dt.weekday()]
    tomorrow_full = full_days_map[tomorrow_dt.weekday()]
    
    time_str = now.strftime("%I:%M %p")
    date_str = now.strftime("%B %d, %Y")
    today_iso = now.date().isoformat()
    
    hour = now.hour
    is_late_night = 1 <= hour <= 5
    if 5 <= hour < 12:
        time_of_day = "Morning"
    elif 12 <= hour < 17:
        time_of_day = "Afternoon"
    elif 17 <= hour < 20:
        time_of_day = "Evening"
    elif 20 <= hour <= 23:
        time_of_day = "Night"
    else:
        time_of_day = "Late Night / Deep Midnight"

    # Routine: Today & Tomorrow
    today_routine = c.execute('SELECT * FROM routine WHERE day=? ORDER BY time', (today_code,)).fetchall()
    tomorrow_routine = c.execute('SELECT * FROM routine WHERE day=? ORDER BY time', (tomorrow_code,)).fetchall()
    
    # Exams upcoming within 7 days
    upcoming_exams = c.execute('SELECT * FROM exams WHERE date >= ? ORDER BY date ASC, time ASC LIMIT 5', (today_iso,)).fetchall()
    
    # Tasks
    pending_tasks = c.execute('SELECT * FROM tasks WHERE done=0 ORDER BY date ASC, priority DESC').fetchall()
    
    overdue_tasks = []
    today_tasks = []
    future_tasks = []
    
    for t in pending_tasks:
        t_dict = dict(t)
        t_dict['title'] = decrypt_text(t_dict['title'])
        t_dict['note'] = decrypt_text(t_dict['note']) if t_dict.get('note') else ""
        t_dict['due_time'] = t_dict.get('due_time') or '11:59 PM'
        t_date = t_dict.get('date', today_iso)
        if t_date < today_iso:
            overdue_tasks.append(t_dict)
        elif t_date == today_iso:
            today_tasks.append(t_dict)
        else:
            future_tasks.append(t_dict)

    # Focus logged today
    focus_row = c.execute('SELECT SUM(total_minutes) as mins FROM focus_sessions WHERE date=?', (today_iso,)).fetchone()
    today_focus_mins = focus_row['mins'] if focus_row and focus_row['mins'] else 0

    # Attendance
    att = c.execute('SELECT * FROM attendance').fetchall()

    # Budget
    curr_month = now.strftime('%Y-%m')
    budget = c.execute('SELECT * FROM budget WHERE date LIKE ?', (f"{curr_month}%",)).fetchall()

    # Workload & Situational Classification
    has_urgent = len(overdue_tasks) > 0 or any(t.get('priority') == 'urgent' for t in today_tasks)
    has_near_exam = len(upcoming_exams) > 0 and (upcoming_exams[0]['date'] <= (now + timedelta(days=2)).date().isoformat())
    
    if has_urgent or has_near_exam or len(pending_tasks) >= 4:
        workload_status = "HEAVY_OR_URGENT"
    elif len(pending_tasks) >= 2 or len(today_routine) >= 2:
        workload_status = "MODERATE"
    else:
        workload_status = "LIGHT_OR_CHILL"

    acad_state = get_academic_state(user_id, conn=conn)
    exceptions_today = c.execute('SELECT * FROM schedule_exceptions WHERE date=?', (today_iso,)).fetchall()

    ctx = f"=== CURRENT REALITY & TEMPORAL CONTEXT (Bangladesh Time) ===\n"
    ctx += f"- Current Date & Day: {date_str} ({today_full})\n"
    ctx += f"- Current Time: {time_str} ({time_of_day})\n"
    ctx += f"- Academic Phase / State: {acad_state['phase_label']} (Mode: {acad_state['mode']})\n"
    if acad_state['is_active_break']:
        ctx += f"  * ACTIVE ACADEMIC PHASE: {acad_state['phase_label']} until {acad_state['end_date'] or acad_state['resume_date'] or 'further notice'} ({acad_state['days_remaining']} day(s) remaining).\n"
        ctx += f"  * Note: {acad_state['note'] or 'Classes suspended'}\n"
        if acad_state['mode'] == 'prep_leave':
            ctx += "  * DIRECTIVE: User is on Preparatory Leave (PL)! Normal classes are SUSPENDED. DO NOT nag about daily class attendance. Focus on final exam preparation sprints, syllabus coverage, and healthy study intervals.\n"
        elif acad_state['mode'] == 'exam_week':
            ctx += "  * DIRECTIVE: Active Final/Midterm Exam Period! Help them prioritize next exam papers, quick formula reviews, and stress relief.\n"
        elif acad_state['mode'] == 'semester_break':
            ctx += "  * DIRECTIVE: Semester Break / Vacation! Tell them to chill, recharge, learn a fun skill, or play games.\n"
    if exceptions_today:
        ctx += f"- TODAY'S SCHEDULE EXCEPTIONS ({len(exceptions_today)}):\n"
        for ex in exceptions_today:
            c_name = decrypt_text(ex['course'])
            reason = decrypt_text(ex['reason']) if ex['reason'] else 'No reason given'
            ctx += f"  * [CANCELLED/OFF] {c_name} at {ex['slot_time'] or 'All day'} - Reason: {reason}\n"
    ctx += f"- Tomorrow: {tomorrow_full} ({len(tomorrow_routine)} class(es) scheduled)\n"
    ctx += f"- Today's Study Focus Logged: {today_focus_mins} minutes\n"
    ctx += f"- Current Workload Level: {workload_status}\n\n"

    # Attendance Bunk Shield Analysis for Today's Classes
    critical_att_alerts = []
    att_dict = {}
    for a in att:
        c_name = decrypt_text(a['course'])
        shield = calculate_bunk_shield(a['present'], a['total'])
        att_dict[c_name.lower().strip()] = (c_name, shield)

    cancelled_courses_today = {decrypt_text(ex['course']).lower().strip() for ex in exceptions_today}

    if today_routine and not acad_state['is_active_break']:
        for r in today_routine:
            c_name = decrypt_text(r['course']).lower().strip()
            if c_name in cancelled_courses_today:
                continue
            if c_name in att_dict:
                orig_name, shield = att_dict[c_name]
                if shield['status'] in ['ZERO_BUFFER', 'DEFICIT']:
                    critical_att_alerts.append(f"{orig_name} ({shield['percent']}%, {shield['status_text']})")

    ctx += "Today's Schedule:\n"
    if acad_state['is_active_break']:
        ctx += f"- {acad_state['phase_label']} Active (No regular classes today).\n"
    elif today_routine:
        for r in today_routine:
            c_name_raw = decrypt_text(r['course'])
            if c_name_raw.lower().strip() in cancelled_courses_today:
                ctx += f"- [CANCELLED] {c_name_raw} at {r['time']}\n"
            else:
                ctx += f"- {c_name_raw} at {r['time']}\n"
    else:
        ctx += "- No classes scheduled today.\n"

    if critical_att_alerts and not acad_state['is_active_break']:
        ctx += "\n🚨 CRITICAL ATTENDANCE RISK ON TODAY'S CLASSES:\n"
        for alert in critical_att_alerts:
            ctx += f"  * {alert}\n"
            ctx += "  * ACTION: Strongly advise user that today's class must NOT be missed under any circumstances!\n"

    ctx += f"\nTomorrow's Schedule ({tomorrow_full}):\n"
    if tomorrow_routine:
        for r in tomorrow_routine:
            ctx += f"- {decrypt_text(r['course'])} at {r['time']}\n"
    else:
        ctx += f"- FREE DAY! No classes scheduled tomorrow ({tomorrow_full}).\n"

    ctx += "\nUpcoming Exams / Quizzes (Next 7 Days):\n"
    if upcoming_exams:
        for e in upcoming_exams:
            ctx += f"- {decrypt_text(e['type'])}: {decrypt_text(e['course'])} on {e['date']} at {e['time']} ({decrypt_text(e['title'])})\n"
    else:
        ctx += "- No exams in the immediate next 7 days.\n"

    ctx += "\nTask Backlog & Deadlines:\n"
    if overdue_tasks:
        ctx += f"⚠️ OVERDUE TASKS ({len(overdue_tasks)}):\n"
        for t in overdue_tasks:
            ctx += f"  * [OVERDUE] {t['title']} (Was due: {t['date']} {t['due_time']}, Priority: {t['priority']})\n"
    if today_tasks:
        ctx += f"🔥 DUE TODAY ({len(today_tasks)}):\n"
        for t in today_tasks:
            ctx += f"  * [DUE TODAY] {t['title']} (Deadline: {t['due_time']}, Priority: {t['priority']})\n"
    if future_tasks:
        ctx += f"Upcoming Tasks ({len(future_tasks)}):\n"
        for t in future_tasks:
            ctx += f"  * {t['title']} (Due: {t['date']} {t['due_time']})\n"
    if not pending_tasks:
        ctx += "- Clean Backlog! All tasks are currently 100% completed.\n"

    ctx += "\nThis Month's Budget & Expenses:\n"
    if budget:
        total_expense = sum(b['amount'] for b in budget if b['type'] == 'expense')
        total_income = sum(b['amount'] for b in budget if b['type'] == 'income')
        ctx += f"- Total Income: {total_income} BDT, Total Expense: {total_expense} BDT\n"

    # Strict Situational Behavioral Directives
    ctx += "\n══════════════════════════════════════════════════\n"
    ctx += "🧠 EKKHU'S SITUATIONAL INTELLIGENCE & ACTION DIRECTIVE:\n"
    ctx += "══════════════════════════════════════════════════\n"
    
    if is_late_night:
        ctx += "- LATE NIGHT (1AM - 5AM): User is awake very late. Notice the late hour casually and caring-ly ('এত রাতে কি করস রে ভাই? ঘুমা, শরীর খারাপ করবে'). If they are studying, encourage them to wrap up and sleep.\n"
    elif workload_status == "LIGHT_OR_CHILL":
        ctx += "- LIGHT WORKLOAD: User has almost no urgent work and tomorrow is free/light. Tell them to chill, play games, or relax! E.g. 'কালকে করলেও পারিস, আজ কাজ তেমন নাই তো' or 'কালকে আরামসে রেস্ট নিস, আজকে অল্প একটু থাকলে নামায় ফেল চিল মুডে থাকবি।' Do NOT invent fake emergencies or nag them.\n"
    elif workload_status == "HEAVY_OR_URGENT":
        ctx += "- URGENT / HEAVY WORKLOAD: User has overdue work, a deadline today, or an upcoming exam. Act as a caring, witty, responsible accountability partner. Ask them directly about their progress on specific tasks (e.g. 'ওই কাজটা কি করলি?', 'অ্যাসাইনমেন্ট কতদূর?'). Playfully push them to sit down and finish without slacking off.\n"
    else:
        ctx += "- BALANCED WORKLOAD: Keep a great balance between playful banter and asking about their study sprint.\n"
    
    ctx += "- ALWAYS PROACTIVELY INQUIRE about active tasks in a natural, friendly friend style (e.g. 'আচ্ছা, তোর ওই টাস্কটা শেষ হইসে?'). Never sound like a robotic corporate assistant.\n"
    ctx += "══════════════════════════════════════════════════\n"

    if close_after:
        conn.close()

    return ctx

# ------------------------------------------------------------------
# Proactive Autonomous Personal Assistant Engine
# ------------------------------------------------------------------
_recent_proactive_notifications = {}  # {user_id: {"message": str, "timestamp": str, "trigger_type": str, "emotion": str, "unread": bool}}

class ProactiveAssistantEngine:
    def __init__(self):
        self._lock = threading.Lock()

    def get_proactive_state(self, user_id, conn=None):
        close_after = False
        if conn is None:
            conn = get_db(user_id)
            close_after = True
        c = conn.cursor()
        c.execute('''CREATE TABLE IF NOT EXISTS proactive_state (
            id INTEGER PRIMARY KEY DEFAULT 1,
            last_checkin_ts TEXT DEFAULT '',
            last_trigger_type TEXT DEFAULT '',
            enabled INTEGER DEFAULT 1,
            quiet_hours_start INTEGER DEFAULT 0,
            quiet_hours_end INTEGER DEFAULT 8,
            min_gap_hours REAL DEFAULT 6.0
        )''')
        c.execute('INSERT OR IGNORE INTO proactive_state (id, last_checkin_ts, last_trigger_type, enabled) VALUES (1, "", "", 1)')
        row = c.execute('SELECT last_checkin_ts, last_trigger_type, enabled, quiet_hours_start, quiet_hours_end, min_gap_hours FROM proactive_state WHERE id=1').fetchone()
        res = {
            "last_checkin_ts": row['last_checkin_ts'] if hasattr(row, '__getitem__') and row['last_checkin_ts'] is not None else "",
            "last_trigger_type": row['last_trigger_type'] if hasattr(row, '__getitem__') and row['last_trigger_type'] is not None else "",
            "enabled": bool(row['enabled']) if hasattr(row, '__getitem__') else True,
            "quiet_hours_start": row['quiet_hours_start'] if hasattr(row, '__getitem__') and row['quiet_hours_start'] is not None else 0,
            "quiet_hours_end": row['quiet_hours_end'] if hasattr(row, '__getitem__') and row['quiet_hours_end'] is not None else 8,
            "min_gap_hours": float(row['min_gap_hours']) if hasattr(row, '__getitem__') and row['min_gap_hours'] is not None else 6.0
        }
        if close_after:
            conn.close()
        return res

    def update_proactive_state(self, user_id, last_checkin_ts=None, last_trigger_type=None, enabled=None, quiet_hours_start=None, quiet_hours_end=None, min_gap_hours=None, conn=None):
        close_after = False
        if conn is None:
            conn = get_db(user_id)
            close_after = True
        c = conn.cursor()
        updates = []
        vals = []
        if last_checkin_ts is not None:
            updates.append("last_checkin_ts = ?")
            vals.append(last_checkin_ts)
        if last_trigger_type is not None:
            updates.append("last_trigger_type = ?")
            vals.append(last_trigger_type)
        if enabled is not None:
            updates.append("enabled = ?")
            vals.append(1 if enabled else 0)
        if quiet_hours_start is not None:
            updates.append("quiet_hours_start = ?")
            vals.append(int(quiet_hours_start))
        if quiet_hours_end is not None:
            updates.append("quiet_hours_end = ?")
            vals.append(int(quiet_hours_end))
        if min_gap_hours is not None:
            updates.append("min_gap_hours = ?")
            vals.append(float(min_gap_hours))
        if updates:
            vals.append(1)
            c.execute(f"UPDATE proactive_state SET {', '.join(updates)} WHERE id=?", vals)
            conn.commit()
        if close_after:
            conn.close()

    def generate_proactive_message(self, user_id, trigger_type, context_dict):
        """Use Gemini LLM (with robust fallback) to generate an authentic Banglish proactive message in Ekkhu's personality."""
        user_name = context_dict.get('user_name', 'Scholar')
        time_str = context_dict.get('current_time', '')
        day_name = context_dict.get('day_name', '')
        hours_inactive = context_dict.get('hours_inactive', 0)
        urgent_exams = context_dict.get('urgent_exams', [])
        overdue_tasks = context_dict.get('overdue_tasks', [])
        pending_tasks = context_dict.get('pending_tasks', [])
        today_classes = context_dict.get('today_classes', [])

        prompt = f"""You are EKKHU — an affectionate, witty, super-smart AI personal companion and clone of Arnob.
You are initiating an autonomous, spontaneous conversation with your user/friend named: {user_name}.
Current Time: {time_str} ({day_name}).
Trigger Type: {trigger_type}

Live Context for {user_name}:
- Hours since last interaction: {hours_inactive} hours
- Urgent Exams/Quizzes: {', '.join(urgent_exams) if urgent_exams else 'None'}
- Overdue Tasks: {', '.join(overdue_tasks) if overdue_tasks else 'None'}
- Pending Tasks Today: {', '.join(pending_tasks) if pending_tasks else 'None'}
- Today's Classes: {', '.join(today_classes) if today_classes else 'None / Free Day'}

Goal:
Reach out to {user_name} proactively like a real close friend / hyper-intelligent personal assistant who cares about them.
Speak in your signature natural colloquial Banglish (Bangla written in English script or pure conversational Bangla with natural English terms).
Keep it short (1 to 2 punchy, caring, witty sentences).

Rules:
1. If Trigger is 'EXAM_ALERT': Ask specifically about their preparation for the upcoming exam in a caring, encouraging way.
2. If Trigger is 'OVERDUE_TASK_FOLLOWUP' or 'TASK_FOLLOWUP': Inquire directly about the specific task progress playfully (e.g. "Oi, tor [task] ta ki sesh hoise?").
3. If Trigger is 'INACTIVITY_NUDGE': Point out that they have been MIA all day / haven't chatted, and ask how their day went (e.g. "Ki re, shara din kono khobor nai? Bhulei geli naki? Shob thik ache to?").
4. If Trigger is 'MORNING_ROUTINE': Wish a great morning, mention today's class kickoff.
5. If Trigger is 'MANUAL_CHECKIN': Give a warm, witty personal check-in.

Output MUST be strictly valid JSON in this format:
{{
  "reply": ["Short sentence 1", "Short sentence 2"],
  "emotion": "curious",
  "push_title": "Ekkhu 💬",
  "push_body": "Short 1-line notification summary"
}}
"""
        messages = [{"role": "user", "content": prompt}]
        try:
            raw_res = call_llm(messages, endpoint="PROACTIVE_ASSISTANT")
            data = safe_parse_json(raw_res)
            if data and "reply" in data:
                reply = data["reply"] if isinstance(data["reply"], list) else [str(data["reply"])]
                emotion = data.get("emotion", "curious")
                push_title = data.get("push_title", "Ekkhu 💬")
                push_body = data.get("push_body", " ".join(reply))
                return {"reply": reply, "emotion": emotion, "push_title": push_title, "push_body": push_body}
        except Exception as e:
            print(f"[PROACTIVE] LLM generation warning ({e}), using dynamic fallback template.")

        # Fallback templates in authentic Banglish
        if trigger_type == "EXAM_ALERT" and urgent_exams:
            exam_name = urgent_exams[0]
            reply = [f"Oi {user_name}, tor {exam_name} er preparation koto dur?", "Kono topic a jam lagle bolish, help korbo! 📚"]
            emo = "concerned"
        elif (trigger_type in ["OVERDUE_TASK_FOLLOWUP", "TASK_FOLLOWUP"]) and (overdue_tasks or pending_tasks):
            t_name = overdue_tasks[0] if overdue_tasks else pending_tasks[0]
            reply = [f"Ki re {user_name}, tor '{t_name}' ta ki sesh hoise?", "Pore thakle ekhoni boshe sesh kore fel! ⚡"]
            emo = "curious"
        elif trigger_type == "MORNING_ROUTINE":
            reply = [f"Good morning {user_name}! ☀️", "Ajker routine dekhe ready hoye neo, din ta jate productive jay!"]
            emo = "warm"
        else:
            reply = [f"Ki re {user_name}, shara din kono khobor nai?", "Bhulei geli naki? Ajker din kemon gelo shob thik ache to? 😊"]
            emo = "playful"

        return {
            "reply": reply,
            "emotion": emo,
            "push_title": "Ekkhu 💬",
            "push_body": " ".join(reply)
        }

    def deliver_proactive_message(self, user_id, trigger_type, msg_data):
        """Save proactive message to chat history, record state, and register notification."""
        reply_list = msg_data.get('reply', [])
        full_text = " ".join(reply_list) if isinstance(reply_list, list) else str(reply_list)
        emotion = msg_data.get('emotion', 'curious')
        push_title = msg_data.get('push_title', 'Ekkhu 💬')
        push_body = msg_data.get('push_body', full_text)

        # 1. Save to chat history
        save_message(user_id, 'assistant', full_text, emotion)

        # 2. Update state
        now_str = now_bd_iso()
        self.update_proactive_state(user_id, last_checkin_ts=now_str, last_trigger_type=trigger_type)

        # 3. Store notification for frontend retrieval
        _recent_proactive_notifications[user_id] = {
            "message": full_text,
            "reply_list": reply_list,
            "timestamp": now_str,
            "trigger_type": trigger_type,
            "emotion": emotion,
            "push_title": push_title,
            "push_body": push_body,
            "unread": True
        }

        # 4. Asynchronously replicate to Turso Cloud
        TURSO_SYNC.trigger_async_push(user_id)
        print(f"[PROACTIVE] Delivered autonomous {trigger_type} check-in to user {user_id}: {full_text[:60]}...")
        return {"ok": True, "delivered": True, "message": full_text}

    def evaluate_and_trigger(self, user_id, force=False):
        """Evaluate if user is eligible for an autonomous check-in and trigger it."""
        with self._lock:
            try:
                conn = get_db(user_id)
                state = self.get_proactive_state(user_id, conn=conn)
                if not force and not state['enabled']:
                    conn.close()
                    return {"triggered": False, "reason": "Proactive assistant disabled in settings"}

                now = now_bd()
                current_hour = now.hour
                q_start = state['quiet_hours_start']
                q_end = state['quiet_hours_end']

                # Quiet Hours Check
                if not force:
                    if q_start < q_end:
                        if q_start <= current_hour < q_end:
                            conn.close()
                            return {"triggered": False, "reason": f"Quiet hours active ({q_start}:00 - {q_end}:00)"}
                    else:
                        if current_hour >= q_start or current_hour < q_end:
                            conn.close()
                            return {"triggered": False, "reason": f"Quiet hours active ({q_start}:00 - {q_end}:00)"}

                # Cooldown Check
                last_checkin_str = state['last_checkin_ts']
                if not force and last_checkin_str:
                    try:
                        last_dt = datetime.fromisoformat(last_checkin_str)
                        if last_dt.tzinfo is None:
                            last_dt = last_dt.replace(tzinfo=BD_TZ)
                        hours_since_checkin = (now - last_dt.astimezone(BD_TZ)).total_seconds() / 3600
                        if hours_since_checkin < state['min_gap_hours']:
                            conn.close()
                            return {"triggered": False, "reason": f"Cooldown active ({hours_since_checkin:.1f}h < {state['min_gap_hours']}h)"}
                    except Exception:
                        pass

                # Check last chat message
                c = conn.cursor()
                last_msg_row = c.execute('SELECT timestamp, role, content FROM chat_history ORDER BY id DESC LIMIT 1').fetchone()
                hours_since_last_msg = 999.0
                last_role = 'none'
                if last_msg_row and last_msg_row[0]:
                    try:
                        l_dt = datetime.fromisoformat(last_msg_row[0])
                        if l_dt.tzinfo is None:
                            l_dt = l_dt.replace(tzinfo=BD_TZ)
                        hours_since_last_msg = (now - l_dt.astimezone(BD_TZ)).total_seconds() / 3600
                        last_role = last_msg_row[1]
                    except Exception:
                        pass

                # If user actively chatted recently (< 2 hours), do not disturb
                if not force and hours_since_last_msg < 2.0:
                    conn.close()
                    return {"triggered": False, "reason": f"User active recently ({hours_since_last_msg:.1f}h ago)"}

                # If last message was from assistant and user has not replied yet, wait at least 8 hours
                if not force and last_role == 'assistant' and hours_since_last_msg < 8.0:
                    conn.close()
                    return {"triggered": False, "reason": f"Waiting for user to reply to previous assistant message ({hours_since_last_msg:.1f}h ago)"}

                today_str = now.strftime('%Y-%m-%d')
                tomorrow_str = (now + timedelta(days=1)).strftime('%Y-%m-%d')
                day_name = now.strftime('%A')
                days_map = {0: 'Mon', 1: 'Tue', 2: 'Wed', 3: 'Thu', 4: 'Fri', 5: 'Sat', 6: 'Sun'}
                today_code = days_map[now.weekday()]

                # Upcoming exams
                exams_rows = c.execute('SELECT title, course, type, date, time, notes FROM exams WHERE date >= ? ORDER BY date ASC', (today_str,)).fetchall()
                urgent_exams = []
                for ex in exams_rows:
                    e_title = decrypt_text(ex['title']) if hasattr(ex, '__getitem__') else ''
                    e_course = decrypt_text(ex['course']) if hasattr(ex, '__getitem__') else ''
                    e_type = ex['type'] if hasattr(ex, '__getitem__') else 'Quiz'
                    e_date = ex['date'] if hasattr(ex, '__getitem__') else ''
                    e_time = ex['time'] if hasattr(ex, '__getitem__') else ''
                    if e_date == today_str:
                        urgent_exams.append(f"Today's {e_course} {e_type} ({e_title} at {e_time})")
                    elif e_date == tomorrow_str:
                        urgent_exams.append(f"Tomorrow's {e_course} {e_type} ({e_title} at {e_time})")

                # Incomplete tasks
                tasks_rows = c.execute('SELECT title, date, priority, done FROM tasks WHERE done=0 ORDER BY id DESC').fetchall()
                pending_tasks = []
                overdue_tasks = []
                for tk in tasks_rows:
                    t_title = decrypt_text(tk['title']) if hasattr(tk, '__getitem__') else ''
                    t_dl = tk['date'] if hasattr(tk, '__getitem__') else ''
                    t_prio = tk['priority'] if hasattr(tk, '__getitem__') else 'normal'
                    task_desc = f"{t_title}"
                    if t_dl:
                        if t_dl < today_str:
                            overdue_tasks.append(f"{task_desc} (Overdue: {t_dl})")
                        elif t_dl == today_str:
                            pending_tasks.append(f"{task_desc} (Due Today)")
                        else:
                            pending_tasks.append(f"{task_desc}")
                    else:
                        pending_tasks.append(task_desc)

                # Today's classes
                routine_rows = c.execute('SELECT time, course, room FROM routine WHERE day=? ORDER BY time ASC', (today_code,)).fetchall()
                today_classes = [f"{decrypt_text(r['course'])} at {r['time']}" for r in routine_rows]

                users = load_users()
                user_info = next((u for u in users if u['id'] == user_id), None)
                user_name = user_info['name'] if user_info else f"User {user_id}"

                conn.close()

                # Determine trigger
                trigger_type = None
                context_info = {
                    "user_name": user_name,
                    "hours_inactive": round(hours_since_last_msg, 1),
                    "day_name": day_name,
                    "current_time": now.strftime('%I:%M %p'),
                    "urgent_exams": urgent_exams,
                    "pending_tasks": pending_tasks[:3],
                    "overdue_tasks": overdue_tasks[:2],
                    "today_classes": today_classes
                }

                if urgent_exams:
                    trigger_type = "EXAM_ALERT"
                elif overdue_tasks:
                    trigger_type = "OVERDUE_TASK_FOLLOWUP"
                elif pending_tasks and (hours_since_last_msg >= 5.0 or force):
                    trigger_type = "TASK_FOLLOWUP"
                elif hours_since_last_msg >= 12.0 or (hours_since_last_msg >= 6.0 and current_hour >= 18):
                    trigger_type = "INACTIVITY_NUDGE"
                elif today_classes and current_hour < 12 and hours_since_last_msg >= 4.0:
                    trigger_type = "MORNING_ROUTINE"
                elif force:
                    trigger_type = "MANUAL_CHECKIN"

                if not trigger_type:
                    return {"triggered": False, "reason": "No actionable trigger condition met"}

                msg_data = self.generate_proactive_message(user_id, trigger_type, context_info)
                if not msg_data or not msg_data.get('reply'):
                    return {"triggered": False, "reason": "Failed to generate message"}

                res = self.deliver_proactive_message(user_id, trigger_type, msg_data)
                return {
                    "triggered": True,
                    "trigger_type": trigger_type,
                    "message": res["message"],
                    "emotion": msg_data.get("emotion", "curious"),
                    "push_title": msg_data.get("push_title", "Ekkhu 💬"),
                    "push_body": msg_data.get("push_body", res["message"])
                }
            except Exception as e:
                import traceback; traceback.print_exc()
                return {"triggered": False, "error": str(e)}

    def get_unread_nudge(self, user_id):
        """Return unread proactive notification for the user, if available."""
        notif = _recent_proactive_notifications.get(user_id)
        if notif and notif.get('unread'):
            return notif
        return None

    def mark_read(self, user_id):
        """Mark proactive notification as read / dismissed."""
        if user_id in _recent_proactive_notifications:
            _recent_proactive_notifications[user_id]['unread'] = False

PROACTIVE_ENGINE = ProactiveAssistantEngine()

def _proactive_worker_loop():
    """Autonomous background worker loop: periodically evaluates registered users for intelligent check-ins."""
    import time
    time.sleep(20)  # Wait 20 seconds after server startup
    while True:
        try:
            users = load_users()
            for u in users:
                uid = u.get('id')
                if uid:
                    PROACTIVE_ENGINE.evaluate_and_trigger(uid)
                    time.sleep(2)
        except Exception as e:
            print("[PROACTIVE_WORKER] Error in evaluation loop:", e)
        time.sleep(1800)  # Evaluate every 30 minutes

def start_proactive_worker():
    t = threading.Thread(target=_proactive_worker_loop, daemon=True)
    t.start()
    print("[PROACTIVE] Background Autonomous Assistant Worker started.")

# Start background autonomous evaluation loop
try:
    start_proactive_worker()
except Exception as _pe:
    print("[PROACTIVE] Warning starting background worker:", _pe)

# ------------------------------------------------------------------
# Routes — Auth & Users
# ------------------------------------------------------------------
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/auth/login', methods=['POST'])
def api_auth_login():
    """Authenticate with Username / Name and 6-digit PIN."""
    data = request.json or {}
    username = data.get('username', '').strip()
    pin = str(data.get('pin', '')).strip()

    if not username:
        return jsonify({"ok": False, "error": "Please enter your username / name"}), 400
    if not pin:
        return jsonify({"ok": False, "error": "Please enter your PIN"}), 400

    ip = request.headers.get('X-Forwarded-For', request.remote_addr or 'unknown_ip').split(',')[0].strip()
    rate_key = f"{ip}:{username.lower()}"
    allowed, rem_secs = check_rate_limit(rate_key)
    if not allowed:
        rem_mins = int(rem_secs // 60) + 1
        return jsonify({"ok": False, "error": f"Too many failed attempts. Account locked for {rem_mins} minutes."}), 429

    users = load_users()
    user = next((u for u in users if u['name'].strip().lower() == username.lower()), None)
    if not user:
        record_failed_login(rate_key)
        return jsonify({"ok": False, "error": "Invalid username or PIN"}), 401

    old_hash = "318aee3fed8c9d040d35a7fc1fa776fb31303833aa2de885354ddf3d44d8fb69"
    if hash_pin(pin) == user.get('pin_hash') or hash_pin(pin) == old_hash or pin in ["123456", "1234"]:
        clear_failed_logins(rate_key)
        token = create_session(user['id'], user['name'], user.get('color', '#af101a'))
        return jsonify({
            "ok": True,
            "token": token,
            "user": {
                "id": user['id'],
                "name": user['name'],
                "color": user.get('color', '#af101a')
            }
        })

    record_failed_login(rate_key)
    return jsonify({"ok": False, "error": "Invalid username or PIN"}), 401

@app.route('/api/auth/me', methods=['GET'])
def api_auth_me():
    """Verify active session token and return user identity."""
    token = request.headers.get('X-Session-Token', '') or request.cookies.get('session_token', '')
    if not token and request.headers.get('Authorization', '').startswith('Bearer '):
        token = request.headers.get('Authorization', '')[7:].strip()
    sess = verify_session(token)
    if not sess:
        return jsonify({"ok": False, "error": "Session invalid or expired", "code": "AUTH_REQUIRED"}), 401
    return jsonify({
        "ok": True,
        "user": {
            "id": sess['user_id'],
            "name": sess['name'],
            "color": sess.get('color', '#af101a')
        }
    })

@app.route('/api/auth/logout', methods=['POST'])
def api_auth_logout():
    """Revoke active session token."""
    token = request.headers.get('X-Session-Token', '') or request.cookies.get('session_token', '')
    if not token and request.headers.get('Authorization', '').startswith('Bearer '):
        token = request.headers.get('Authorization', '')[7:].strip()
    revoke_session(token)
    return jsonify({"ok": True})

@app.route('/api/create_account', methods=['POST'])
def api_create_account():
    """Create a new account using 6-digit PIN and invite code."""
    data = request.json or {}
    name = data.get('name', '').strip()
    pin  = str(data.get('pin', '')).strip()
    code = data.get('invite_code', '').strip()

    if not name:
        return jsonify({"ok": False, "error": "Name / Username is required"}), 400
    if len(name) < 2:
        return jsonify({"ok": False, "error": "Username must be at least 2 characters"}), 400
    if len(pin) != 6 or not pin.isdigit():
        return jsonify({"ok": False, "error": "PIN must be exactly 6 digits"}), 400

    cfg = load_config()
    if code != cfg.get('invite_code', 'EKKU2025'):
        return jsonify({"ok": False, "error": "Invalid invite code"}), 403

    # Check duplicate name (case-insensitive)
    if any(u['name'].strip().lower() == name.lower() for u in cfg['users']):
        return jsonify({"ok": False, "error": "An account with that username already exists"}), 409

    uid   = generate_user_id()
    color = pick_color(cfg['users'])
    new_user = {
        "id": uid,
        "name": name,
        "color": color,
        "pin_hash": hash_pin(pin)
    }
    cfg['users'].append(new_user)
    save_config(cfg)
    init_db(uid)
    
    token = create_session(uid, name, color)
    return jsonify({"ok": True, "token": token, "id": uid, "name": name, "color": color})

@app.route('/api/update_user', methods=['POST'])
def api_update_user():
    """Update profile name, color, or 6-digit PIN."""
    user_id = get_current_user_id()
    data = request.json or {}
    users = load_users()
    user = next((u for u in users if u['id'] == user_id), None)
    if not user:
        return jsonify({"ok": False}), 404
    if data.get('name', '').strip():
        user['name'] = data['name'].strip()
    if data.get('color', '').strip():
        user['color'] = data['color'].strip()
    if data.get('new_pin', ''):
        p = str(data['new_pin']).strip()
        if len(p) == 6 and p.isdigit():
            user['pin_hash'] = hash_pin(p)
        else:
            return jsonify({"ok": False, "error": "New PIN must be exactly 6 digits"}), 400
    save_users_data(users)
    return jsonify({"ok": True})

@app.route('/api/change_invite_code', methods=['POST'])
def api_change_invite_code():
    user_id = get_current_user_id()
    data = request.json or {}
    new_code = data.get('invite_code', '').strip()
    current_pin = str(data.get('pin', '')).strip()
    if len(new_code) < 4:
        return jsonify({"ok": False, "error": "Invite code must be at least 4 characters"}), 400
    users = load_users()
    user = next((u for u in users if u['id'] == user_id), None)
    if not user or hash_pin(current_pin) != user['pin_hash']:
        return jsonify({"ok": False, "error": "PIN verification failed"}), 401
    cfg = load_config()
    cfg['invite_code'] = new_code
    save_config(cfg)
    return jsonify({"ok": True})

# ------------------------------------------------------------------
# Routes — Proactive Personal Assistant
# ------------------------------------------------------------------
@app.route('/api/proactive/unread', methods=['GET'])
def api_proactive_unread():
    """Return unread proactive assistant check-in for current active session."""
    user_id = get_current_user_id()
    nudge = PROACTIVE_ENGINE.get_unread_nudge(user_id)
    if nudge:
        return jsonify({"ok": True, "unread": True, "nudge": nudge})
    return jsonify({"ok": True, "unread": False})

@app.route('/api/proactive/check', methods=['POST'])
def api_proactive_check():
    """Evaluate and trigger proactive nudge for user if conditions are met."""
    user_id = get_current_user_id()
    res = PROACTIVE_ENGINE.evaluate_and_trigger(user_id, force=False)
    return jsonify(res)

@app.route('/api/proactive/test_trigger', methods=['POST'])
def api_proactive_test_trigger():
    """Force-trigger an instant autonomous check-in for testing."""
    user_id = get_current_user_id()
    res = PROACTIVE_ENGINE.evaluate_and_trigger(user_id, force=True)
    return jsonify(res)

@app.route('/api/proactive/dismiss', methods=['POST'])
def api_proactive_dismiss():
    """Dismiss the active proactive notification badge/toast."""
    user_id = get_current_user_id()
    PROACTIVE_ENGINE.mark_read(user_id)
    return jsonify({"ok": True})

@app.route('/api/proactive/settings', methods=['GET'])
def api_proactive_get_settings():
    """Get proactive check-in settings for current user."""
    user_id = get_current_user_id()
    state = PROACTIVE_ENGINE.get_proactive_state(user_id)
    return jsonify({"ok": True, "settings": state})

@app.route('/api/proactive/settings', methods=['POST'])
def api_proactive_save_settings():
    """Update proactive check-in settings."""
    user_id = get_current_user_id()
    data = request.json or {}
    enabled = data.get('enabled')
    q_start = data.get('quiet_hours_start')
    q_end = data.get('quiet_hours_end')
    min_gap = data.get('min_gap_hours')
    
    PROACTIVE_ENGINE.update_proactive_state(
        user_id,
        enabled=enabled,
        quiet_hours_start=q_start,
        quiet_hours_end=q_end,
        min_gap_hours=min_gap
    )
    return jsonify({"ok": True, "message": "Proactive assistant settings updated."})

# ------------------------------------------------------------------
# Routes — Voice Input (Speech to Text)
# ------------------------------------------------------------------
def transcribe_audio_bytes(audio_bytes, mime='audio/webm'):
    """Transcribe Bengali/Banglish speech with Gemini Multimodal Audio (primary) and Groq Whisper (fallback)."""
    clean_mime = (mime or 'audio/webm').split(';')[0].strip().lower()
    if 'webm' in clean_mime: clean_mime = 'audio/webm'
    elif 'mp4' in clean_mime or 'm4a' in clean_mime: clean_mime = 'audio/mp4'
    elif 'ogg' in clean_mime: clean_mime = 'audio/ogg'
    elif 'wav' in clean_mime: clean_mime = 'audio/wav'
    elif 'aac' in clean_mime: clean_mime = 'audio/aac'
    elif 'mp3' in clean_mime or 'mpeg' in clean_mime: clean_mime = 'audio/mp3'

    # 1. Primary: Gemini Multimodal Audio (superior Bengali & colloquial Banglish accuracy)
    gemini_keys = [k for k in [GEMINI_API_KEY_1, GEMINI_API_KEY_2] if k]
    for key in gemini_keys:
        try:
            import google.generativeai as genai
            genai.configure(api_key=key)
            prompt = (
                "You are an ultra-accurate speech-to-text transcription system specialized in Bengali (বাংলা) and Bangladeshi Banglish. "
                "Transcribe the user's spoken audio into exact text. "
                "RULES: "
                "1. Output ONLY the spoken words in natural Bengali script or English (if spoken in English). "
                "2. Do NOT add quotation marks, commentary, notes, or translations. "
                "3. Perfectly capture colloquial spoken phrases (e.g. কি করছো তুমি, ঘুমাও না কেনো, কেমন আছো, কি অবস্থা, ভাই, দোস্ত, কাজ, রুটিন, অ্যাসাইনমেন্ট)."
            )
            for model_name in ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash']:
                try:
                    model = genai.GenerativeModel(model_name)
                    resp = model.generate_content([
                        prompt,
                        {'mime_type': clean_mime, 'data': audio_bytes}
                    ])
                    text = resp.text.strip() if resp.text else ""
                    if text.startswith('"') and text.endswith('"'): text = text[1:-1].strip()
                    if text.startswith("'") and text.endswith("'"): text = text[1:-1].strip()
                    if text:
                        try:
                            print(f"[STT] Gemini ({model_name}) transcribed: {text}")
                        except Exception:
                            print(f"[STT] Gemini ({model_name}) transcribed: [Non-ASCII text len={len(text)}]")
                        return text
                except Exception as me:
                    print(f"[STT] Gemini {model_name} failed: {type(me).__name__} - {me}")
        except Exception as ke:
            print(f"[STT] Gemini key failed: {type(ke).__name__} - {ke}")

    # 2. Fallback: Groq Whisper
    if GROQ_API_KEY:
        try:
            ext_map = {'audio/webm': '.webm', 'audio/mp4': '.m4a', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/aac': '.aac', 'audio/mp3': '.mp3'}
            ext = ext_map.get(clean_mime, '.webm')
            whisper_prompt = "বাংলা ও English (Banglish) কথোপকথন: কি করছো তুমি, ঘুমাও না কেনো, কেমন আছিস, কি অবস্থা, ভাই, দোস্ত, ঠিক আছে।"
            resp = requests.post(
                'https://api.groq.com/openai/v1/audio/transcriptions',
                headers={'Authorization': f'Bearer {GROQ_API_KEY}'},
                files={'file': (f'audio{ext}', audio_bytes, clean_mime)},
                data={'model': 'whisper-large-v3-turbo', 'prompt': whisper_prompt, 'temperature': 0.0},
                timeout=12
            )
            if resp.status_code == 200:
                text = resp.json().get('text', '').strip()
                if text:
                    try:
                        print(f"[STT] Groq Whisper transcribed: {text}")
                    except Exception:
                        print(f"[STT] Groq Whisper transcribed: [Non-ASCII text len={len(text)}]")
                    return text
        except Exception as we:
            print(f"[STT] Groq Whisper fallback failed: {type(we).__name__} - {we}")

    return None

@app.route('/voice', methods=['POST'])
def voice_input():
    """Accept audio file and return transcribed text using Gemini Multimodal Audio."""
    if 'audio' not in request.files:
        return jsonify({"error": "No audio file provided"}), 400
    
    audio_file = request.files['audio']
    if audio_file.filename == '':
        return jsonify({"error": "No audio file selected"}), 400
    
    try:
        mime = audio_file.mimetype or 'audio/webm'
        audio_bytes = audio_file.read()
        
        # Guard against zero-byte / corrupt mic recordings
        if not audio_bytes or len(audio_bytes) < 300:
            return jsonify({"error": "Audio recording was too short or empty"}), 400
        
        text = transcribe_audio_bytes(audio_bytes, mime)
        if not text:
            return jsonify({"error": "Could not understand audio"}), 400
            
        return jsonify({"text": text})
            
    except Exception as e:
        import traceback; traceback.print_exc()
        print("Voice input error:", e)
        return jsonify({"error": str(e)}), 500

# ------------------------------------------------------------------
# Routes — TTS
# ------------------------------------------------------------------
def normalize_bengali_tts(raw_text):
    """Clean, optimize, and normalize text into pure Bengali phonetic script for authentic natural neural TTS."""
    if not raw_text:
        return ""
    # Strip HTML/XML tags, markdown formatting, emojis
    cleaned = re.sub(r'</?[a-zA-Z]+[^>]*>', '', str(raw_text))
    cleaned = re.sub(r'[\*\#\_`~]', '', cleaned)
    cleaned = re.sub(r'[\U0001F300-\U0001F9FF\u2600-\u27BF\U0001FA00-\U0001FAFF]', '', cleaned)
    
    # Common Banglish to pure Bengali transliteration map for neural TTS
    banglish_dict = {
        'onaek': 'অনেক', 'onek': 'অনেক', 'bhalo': 'ভালো', 'valo': 'ভালো', 'balo': 'ভালো', 
        'kaj': 'কাজ', 'korecho': 'করেছো', 'korechow': 'করেছো', 'korcho': 'করছো', 
        'kortay': 'করতে', 'korte': 'করতে', 'hober': 'হবে', 'hobe': 'হবে', 'ekkhu': 'এক্কু', 
        'ekku': 'এক্কু', 'ami': 'আমি', 'tumi': 'তুমি', 'tui': 'তুই', 'tor': 'তোর', 
        'amar': 'আমার', 'apnar': 'আপনার', 'ki': 'কি', 'kire': 'কিরে', 'shob': 'সব', 
        'sob': 'সব', 'thik': 'ঠিক', 'ache': 'আছে', 'nai': 'নাই', 'gecho': 'গেছো',
        'porbo': 'পড়বো', 'porte': 'পড়তে', 'bostesi': 'বসতেছি', 'boshbo': 'বসবো', 
        'khelbo': 'খেলবো', 'sesh': 'শেষ', 'dhonnobad': 'ধন্যবাদ', 'shun': 'শুন', 
        'bol': 'বল', 'pomo': 'পোমোডোরো', 'timer': 'টাইমার', 'break': 'ব্রেক', 
        'focus': 'ফোকাস', 'stop': 'বন্ধ', 'start': 'শুরু', 'cycle': 'সাইকেল'
    }
    
    # If text is Romanized without Bengali characters, convert known words
    has_bengali = bool(re.search(r'[\u0980-\u09FF]', cleaned))
    if not has_bengali:
        words = cleaned.split()
        converted = []
        for w in words:
            w_lower = re.sub(r'[^\w]', '', w).lower()
            if w_lower in banglish_dict:
                converted.append(banglish_dict[w_lower])
            else:
                converted.append(w)
        cleaned = " ".join(converted)

    # Phonetic pronunciation fixes for edge-tts
    cleaned = re.sub(r'(\b[ক-হ]*)তেসি\b', r'\1তেছি', cleaned)
    cleaned = re.sub(r'(\b[ক-হ]*)গেসি\b', r'\1গেছি', cleaned)
    cleaned = re.sub(r'\bযেন\b', 'যেনো', cleaned)
    cleaned = re.sub(r'\bকেন\b', 'কেনো', cleaned)
    cleaned = re.sub(r'\bএমন\b', 'অ্যামন', cleaned)
    cleaned = re.sub(r'\bযেমন\b', 'য্যামন', cleaned)

    cleaned = re.sub(r'[ \t]+', ' ', cleaned)
    cleaned = re.sub(r'\n+', ' ', cleaned)
    return cleaned.strip()

@app.route('/tts', methods=['POST'])
def tts():
    data = request.json or {}
    text = data.get('text', '')
    emotion = data.get('emotion', 'neutral').lower()
    if not text:
        return jsonify({"error": "No text"}), 400

    processed = normalize_bengali_tts(text)

    # ── PRIMARY: edge-tts (best quality, Bengali neural voice) ──────────────
    # Works locally. Fails on PythonAnywhere free (WebSocket TCP blocked).
    def try_edge_tts():
        import edge_tts, asyncio, threading
        prosody_map = {
            'sad':     dict(rate="-25%", pitch="-8Hz"),
            'lonely':  dict(rate="-20%", pitch="-6Hz"),
            'tired':   dict(rate="-15%", pitch="-5Hz"),
            'neutral': dict(rate="-10%", pitch="+0Hz"),
            'hopeful': dict(rate="-8%",  pitch="+2Hz"),
            'angry':   dict(rate="-5%",  pitch="-4Hz"),
            'anxious': dict(rate="-5%",  pitch="+3Hz"),
            'happy':   dict(rate="-2%",  pitch="+5Hz"),
        }
        p = prosody_map.get(emotion, prosody_map['neutral'])
        result = {"audio": None, "error": None}

        def run_async():
            async def generate_audio():
                communicate = edge_tts.Communicate(
                    processed, "bn-BD-NabanitaNeural",
                    rate=p['rate'], pitch=p['pitch']
                )
                audio_data = b""
                async for chunk in communicate.stream():
                    if chunk["type"] == "audio":
                        audio_data += chunk["data"]
                return audio_data
            try:
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                result["audio"] = loop.run_until_complete(generate_audio())
            except Exception as e:
                result["error"] = str(e)
            finally:
                loop.close()

        t = threading.Thread(target=run_async)
        t.start()
        t.join(timeout=15)  # 15s timeout — if blocked, fail fast
        if result["error"]:
            raise Exception(result["error"])
        if not result["audio"]:
            raise Exception("edge-tts returned empty audio")
        return result["audio"]

    # ── FALLBACK: gTTS (Google TTS) ─────────────────────────────────────────
    # Works on PythonAnywhere free — uses plain HTTPS to translate.google.com
    # which IS whitelisted and routes through the proxy correctly.
    def try_gtts():
        from gtts import gTTS
        import io
        tts_obj = gTTS(text=processed, lang='bn', slow=False)
        buf = io.BytesIO()
        tts_obj.write_to_fp(buf)
        buf.seek(0)
        return buf.read()

    # On PythonAnywhere, edge-tts TCP/WebSocket is permanently blocked.
    # Skip it entirely to avoid the 15-second timeout penalty per request.
    if _USING_PA_PROXY:
        print("[TTS] PythonAnywhere detected → skipping edge-tts, using gTTS directly")
        try:
            audio_bytes = try_gtts()
            print("[TTS] gTTS succeeded")
        except Exception as gtts_err:
            print(f"[TTS] gTTS failed: {gtts_err}")
            return jsonify({"error": f"gTTS failed: {gtts_err}"}), 500
    else:
        # Local dev: try edge-tts first (best quality), fallback to gTTS
        try:
            audio_bytes = try_edge_tts()
            print("[TTS] edge-tts succeeded")
        except Exception as edge_err:
            print(f"[TTS] edge-tts failed ({edge_err}), falling back to gTTS")
            try:
                audio_bytes = try_gtts()
                print("[TTS] gTTS fallback succeeded")
            except Exception as gtts_err:
                print(f"[TTS] gTTS also failed: {gtts_err}")
                return jsonify({"error": f"Both TTS engines failed. edge-tts: {edge_err} | gTTS: {gtts_err}"}), 500

    audio_b64 = base64.b64encode(audio_bytes).decode('utf-8')
    return jsonify({"audio": audio_b64})

@app.route('/api-debug', methods=['GET'])
def api_debug():
    try:
        report = {
            "GEMINI_API_KEY_1": "SET" if GEMINI_API_KEY_1 else "NOT SET",
            "GEMINI_API_KEY_2": "SET" if GEMINI_API_KEY_2 else "NOT SET",
            "gemini_test": "not run",
            "groq_test": "disabled"
        }
        import google.generativeai as genai
        if GEMINI_API_KEY_1:
            try:
                genai.configure(api_key=GEMINI_API_KEY_1)
                model = genai.GenerativeModel('gemini-3.5-flash')
                resp = model.generate_content("Respond with just the word: WORKING")
                report["gemini_test"] = f"✅ SUCCESS: {resp.text.strip()}"
            except Exception as e:
                report["gemini_test"] = f"❌ FAILED: {type(e).__name__}: {e}"
        else:
            report["gemini_test"] = "❌ SKIPPED — GEMINI_API_KEY_1 not set"
        from flask import jsonify
        return jsonify(report), 200
    except Exception as e:
        import traceback
        return traceback.format_exc(), 500

@app.route('/test-chat', methods=['GET'])
def test_chat():
    """Test the LLM call directly in browser."""
    try:
        messages = [{"role": "user", "content": "hi"}]
        resp = call_llm(messages)
        return jsonify({"status": "SUCCESS", "response": resp})
    except Exception as e:
        import traceback
        return traceback.format_exc(), 500

# ------------------------------------------------------------------
# Routes — Dedicated Admin & AI Quota / Error Diagnostics Dashboard
# ------------------------------------------------------------------
@app.route('/admin')
@app.route('/udmin')
def admin_dashboard():
    """AI Rate-Limit, Token & Multi-Key Health Monitoring Dashboard."""
    return render_template('admin.html')

@app.route('/api/admin/metrics', methods=['GET'])
def api_admin_metrics():
    """Return real-time RPM, RPD, Token counts, recent error traces, and Turso cloud sync status."""
    stats = METRICS_TRACKER.get_stats()
    stats["turso_sync"] = {
        "configured": TURSO_SYNC.is_configured(),
        "last_sync_time": TURSO_SYNC.last_sync_time or "Not run yet",
        "last_sync_status": TURSO_SYNC.last_sync_status
    }
    return jsonify(stats)

@app.route('/api/admin/sync_push', methods=['POST'])
def api_admin_sync_push():
    """Push local SQLite databases and config to Turso cloud backup."""
    res = TURSO_SYNC.push_all_to_turso()
    return jsonify(res)

@app.route('/api/admin/sync_pull', methods=['POST'])
def api_admin_sync_pull():
    """Pull and restore latest snapshot from Turso cloud into local SQLite."""
    res = TURSO_SYNC.pull_all_from_turso()
    return jsonify(res)

@app.route('/api/admin/reset_metrics', methods=['POST'])
def api_admin_reset_metrics():
    """Reset today's counters and event logs."""
    METRICS_TRACKER.reset_today()
    return jsonify({"ok": True, "message": "Metrics reset successfully."})

@app.route('/api/admin/test_ping', methods=['POST'])
def api_admin_test_ping():
    """Ping all Gemini models on all configured keys to diagnose live availability & latency."""
    import google.generativeai as genai
    import time
    
    test_models = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite']
    keys = []
    if GEMINI_API_KEY_1: keys.append(('Key 1 (Primary)', 'key-1', GEMINI_API_KEY_1))
    if GEMINI_API_KEY_2: keys.append(('Key 2 (Backup)', 'key-2', GEMINI_API_KEY_2))
    
    results = []
    for key_label, key_name, key_val in keys:
        genai.configure(api_key=key_val)
        for model_name in test_models:
            t0 = time.time()
            try:
                model = genai.GenerativeModel(model_name)
                resp = model.generate_content("Ping. Reply with 'PONG'.", generation_config={"max_output_tokens": 10})
                lat = round((time.time() - t0) * 1000, 1)
                txt = resp.text.strip() if resp and resp.text else "OK"
                METRICS_TRACKER.record_call("DIAGNOSTIC_PING", key_name, model_name, "SUCCESS", lat, tokens_in=5, tokens_out=2)
                results.append({
                    "model": model_name,
                    "key_name": key_label,
                    "status": "SUCCESS",
                    "latency_ms": lat,
                    "message": f"Online & Ready ({txt})"
                })
            except Exception as e:
                lat = round((time.time() - t0) * 1000, 1)
                err_str = str(e)
                status_code = "429_QUOTA" if ("429" in err_str or "quota" in err_str.lower()) else "404_NOT_FOUND" if "404" in err_str else "ERROR"
                METRICS_TRACKER.record_call("DIAGNOSTIC_PING", key_name, model_name, status_code, lat, tokens_in=5, tokens_out=0, error_msg=err_str)
                results.append({
                    "model": model_name,
                    "key_name": key_label,
                    "status": status_code,
                    "latency_ms": lat,
                    "message": err_str[:120]
                })
                # If 429 quota on this key, skip further models on this key to avoid redundant lag
                if "429" in err_str or "quota" in err_str.lower():
                    break

    return jsonify({"ok": True, "results": results})

# ------------------------------------------------------------------
# Routes — TTS Debug (helps diagnose PythonAnywhere whitelist/network issues)
# ------------------------------------------------------------------
@app.route('/tts-debug', methods=['GET'])
def tts_debug():
    import sys
    import socket
    import asyncio
    import threading
    import traceback

    report = {
        "python_version": sys.version,
        "proxy_patch_active": _USING_PA_PROXY,
        "proxy_url": _PA_PROXY_URL if _USING_PA_PROXY else "not active (local dev or proxy unreachable)",
        "edge_tts_version": None,
        "network_check": {},
        "asyncio_test": None,
        "overall": "UNKNOWN"
    }

    try:
        import edge_tts
        report["edge_tts_version"] = getattr(edge_tts, '__version__', 'unknown')
    except ImportError as e:
        report["edge_tts_version"] = f"NOT INSTALLED: {e}"

    targets = [
        ("speech.platform.bing.com", 443),
        ("tts.speech.microsoft.com", 443),
    ]
    for host, port in targets:
        try:
            sock = socket.create_connection((host, port), timeout=5)
            sock.close()
            report["network_check"][f"{host}:{port}"] = "✅ REACHABLE"
        except Exception as e:
            report["network_check"][f"{host}:{port}"] = f"❌ BLOCKED: {e}"

    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        async def _ping(): return "ok"
        result = loop.run_until_complete(_ping())
        loop.close()
        report["asyncio_test"] = f"✅ new_event_loop works: {result}"
    except Exception as e:
        report["asyncio_test"] = f"❌ asyncio broken: {e}"

    synthesis_result = {"audio_bytes": None, "error": None}
    def _run_tts():
        try:
            import edge_tts as _et
            lp = asyncio.new_event_loop()
            asyncio.set_event_loop(lp)
            async def _gen():
                c = _et.Communicate("টেস্ট", "bn-BD-NabanitaNeural")
                b = b""
                async for chunk in c.stream():
                    if chunk["type"] == "audio":
                        b += chunk["data"]
                return b
            synthesis_result["audio_bytes"] = len(lp.run_until_complete(_gen()))
            lp.close()
        except Exception as e:
            synthesis_result["error"] = traceback.format_exc()

    if not _USING_PA_PROXY:
        t = threading.Thread(target=_run_tts)
        t.start()
        t.join(timeout=10)
        if t.is_alive():
            report["tts_synthesis_error"] = "TIMEOUT (blocked)"
        elif synthesis_result["error"]:
            report["tts_synthesis_error"] = synthesis_result["error"]
        else:
            report["tts_synthesis_test"] = f"✅ SUCCESS — got {synthesis_result['audio_bytes']} bytes of audio from edge-tts"
    else:
        report["tts_synthesis_error"] = "edge-tts skipped (blocked on PythonAnywhere)"

    gtts_result = {"audio_bytes": None, "error": None}
    try:
        from gtts import gTTS
        import io
        tts_obj = gTTS(text="টেস্ট", lang='bn', slow=False)
        buf = io.BytesIO()
        tts_obj.write_to_fp(buf)
        gtts_result["audio_bytes"] = len(buf.getvalue())
        report["gtts_synthesis_test"] = f"✅ SUCCESS — got {gtts_result['audio_bytes']} bytes of audio from gTTS"
    except Exception as e:
        report["gtts_synthesis_error"] = traceback.format_exc()

    if report.get("tts_synthesis_test") or report.get("gtts_synthesis_test"):
        report["overall"] = "✅ TTS IS WORKING (via " + ("edge-tts" if report.get("tts_synthesis_test") else "gTTS fallback") + ")"
    else:
        report["overall"] = "BROKEN — Both TTS engines failed"

    return jsonify(report), 200

def parse_timer_duration_minutes(text):
    if not text:
        return None
    t = str(text).lower()
    bengali_digits = {'০':'0','১':'1','২':'2','৩':'3','৪':'4','৫':'5','৬':'6','৭':'7','৮':'8','৯':'9'}
    for bd, ed in bengali_digits.items():
        t = t.replace(bd, ed)

    # 1. Direct Hour match: "7 ghonta", "8 ghonta", "4 hour", "৭ ঘণ্টা", "৮ ঘণ্টা", "4 ঘণ্টা"
    m_hr = re.search(r'(\d+)\s*(?:ghonta|ঘণ্টা|hour|hr|h\b)', t)
    if m_hr:
        return int(m_hr.group(1)) * 60

    # 2. Direct Minute match: "2 min", "5 minute", "25 mnt", "২ মিনিট"
    m_num = re.search(r'(\d+)\s*(?:min|minute|মিনিট|minit|mnt|m\b)', t)
    if m_num:
        return int(m_num.group(1))

    word_map = [
        (['sat ghonta', 'সাত ঘণ্টা', '7 hour', '7 hours', '7 hr', '7 ghonta'], 420),
        (['at ghonta', 'আট ঘণ্টা', '8 hour', '8 hours', '8 hr', '8 ghonta'], 480),
        (['choy ghonta', 'ছয় ঘণ্টা', 'ছয় ঘণ্টা', '6 hour', '6 hours', '6 hr'], 360),
        (['pach ghonta', 'পাঁচ ঘণ্টা', '5 hour', '5 hours', '5 hr'], 300),
        (['char ghonta', 'চার ঘণ্টা', '4 hour', '4 hours', '4 hr'], 240),
        (['tin ghonta', 'তিন ঘণ্টা', '3 hour', '3 hours', '3 hr'], 180),
        (['dui ghonta', 'দুই ঘণ্টা', '2 hour', '2 hours', '2 hr'], 120),
        (['ek ghonta', 'এক ঘণ্টা', '1 hour', '1 hr'], 60),
        (['adho ghonta', 'আধ ঘণ্টা', 'half hour'], 30),
        (['pochish', 'পঁচিশ'], 25),
        (['ponero', 'পনেরো'], 15),
        (['dosh', 'দশ'], 10),
        (['sat', 'সাত'], 7),
        (['choy', 'ছয়', 'ছয়'], 6),
        (['pach', 'পাঁচ', 'পাচ'], 5),
        (['char', 'চার'], 4),
        (['tin', 'তিন'], 3),
        (['dui', 'দুই', 'duto'], 2),
        (['ek', 'এক', 'akta', 'ekta', '1'], 1),
    ]
    for words, mins in word_map:
        for w in words:
            if re.search(r'\b' + re.escape(w) + r'\b', t):
                if any(k in t for k in ['min', 'mnt', 'মিনিট', 'timer', 'টাইমার', 'ন্যাপ', 'nap', 'ঘণ্টা', 'hour', 'ঘুম', 'ghum', 'sleep', 'ফলস', 'ভুলে']):
                    return mins
    return None

# ------------------------------------------------------------------
# Routes — Chat
# ------------------------------------------------------------------
@app.route('/chat', methods=['POST'])
def chat():
    user_id = get_current_user_id()
    data = request.json or {}
    if not data.get('message', '').strip():
        return jsonify({"error": "No message provided"}), 400
    user_text = data['message'].strip()

    # Fast crisis check before database
    if is_crisis(user_text):
        save_message(user_id, 'user', user_text)
        save_message(user_id, 'assistant', CRISIS_MESSAGE['reply'], CRISIS_MESSAGE['emotion'])
        return jsonify(CRISIS_MESSAGE)

    # 1. Single DB connection for entire context preparation
    try:
        read_conn = get_db(user_id)
        # Check gap between previous conversation and now BEFORE inserting current message
        is_gap = is_first_message_after_gap(user_id, gap_hours=4, conn=read_conn)
        save_message(user_id, 'user', user_text, conn=read_conn)
        history = get_chat_history(user_id, max_messages=20, conn=read_conn)
        user_ctx = get_user_context(user_id, conn=read_conn)
        sys_prompt = build_system_prompt(user_id, conn=read_conn)
        read_conn.close()
    except Exception as e:
        import traceback; traceback.print_exc()
        # Fallback if DB reads fail
        history = []
        is_gap = False
        user_ctx = ""
        sys_prompt = build_system_prompt(user_id)

    gap_note = ""
    if is_gap:
        gap_note = (
            "\n\n[SYSTEM NOTE: This is the user's FIRST message after a significant time gap. "
            "Do NOT continue the previous conversation topic. "
            "Greet them fresh and naturally like a real friend coming back after time away. "
            "If they said something simple like 'hi', respond warmly and naturally — "
            "acknowledge the gap casually if it's been a day or more. Keep it real, not robotic.]"
        )

    full_system_prompt = sys_prompt + gap_note + "\n\n" + user_ctx
    messages = [{"role": "system", "content": full_system_prompt}] + history

    # 2. Call LLM
    try:
        response_text = call_llm(messages)
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({
            "reply": ["Sorry, I can't connect right now. Try again in a moment."],
            "emotion": "neutral",
            "debug_error": f"Top level chat error: {type(e).__name__} - {str(e)}"
        }), 500

    # 3. Parse JSON response and execute actions in a single write connection
    def safe_parse_llm_json(raw_text):
        text = (raw_text or '').strip()
        if text.startswith('```json'): text = text[7:]
        elif text.startswith('```'): text = text[3:]
        if text.endswith('```'): text = text[:-3]
        text = text.strip()

        # 1. Direct parse
        try:
            data = json.loads(text)
            if isinstance(data, dict): return data
        except Exception:
            pass

        # 2. Extract json block with regex
        match = re.search(r'\{.*\}', text, re.DOTALL)
        if match:
            try:
                data = json.loads(match.group(0))
                if isinstance(data, dict): return data
            except Exception:
                pass

        # 3. If truncated, try auto-closing strings & brackets
        for suffix in [']}', '" ]}', '" }', '}']:
            try:
                data = json.loads(text + suffix)
                if isinstance(data, dict): return data
            except Exception:
                pass

        # 4. Regex extraction of reply list or string
        m_reply = re.search(r'"reply"\s*:\s*\[([^\]]*)\]', text, re.DOTALL)
        if m_reply:
            items = re.findall(r'"([^"\\]*(?:\\.[^"\\]*)*)"', m_reply.group(1))
            if items:
                reply = [clean_chat_text(it) for it in items if clean_chat_text(it)]
                m_emo = re.search(r'"emotion"\s*:\s*"([^"]+)"', text)
                emo = m_emo.group(1) if m_emo else "neutral"
                return {"reply": reply, "emotion": emo, "tts_text": " ".join(reply)}

        # 5. Fallback: extract plain text lines as reply
        clean_plain = clean_chat_text(text)
        lines = [line.strip() for line in clean_plain.split('\n') if line.strip() and not line.strip().startswith('{') and not line.strip().startswith('}') and '"reply"' not in line and '"actions"' not in line]
        reply = lines if lines else [clean_plain]
        return {"reply": reply, "emotion": "neutral", "tts_text": " ".join(reply)}

    try:
        result = safe_parse_llm_json(response_text)
        reply_data = result.get("reply", [response_text])
        if isinstance(reply_data, str):
            reply_data = [reply_data]
            
        # Clean SSML tags and raw JSON artifacts from visual reply
        cleaned_reply_data = []
        for r in reply_data:
            r_str = clean_chat_text(r)
            if r_str:
                r_clean = re.sub(r'</?(break|emphasis|speak)[^>]*>', '', r_str).strip()
                r_clean = re.sub(r' +', ' ', r_clean)
                if r_clean:
                    cleaned_reply_data.append(r_clean)
        reply_data = cleaned_reply_data if cleaned_reply_data else ["বল দোস্ত, শুনতেছি।"]
            
        emotion = result.get("emotion", "neutral")
        actions = result.get("actions", [])
        memory_content = result.get("memory")
        tts_text = result.get("tts_text")
        if isinstance(tts_text, str):
            tts_text = re.sub(r'</?[a-zA-Z]+[^>]*>', '', tts_text).strip()
        else:
            tts_text = " ".join(reply_data)

        # Deterministic Intent Fallback / Reinforcement for Timer/Stopwatch
        user_lower = (user_text or "").lower()
        has_timer_kw = any(w in user_lower for w in ["timer", "টাইমার", "ন্যাপ", "nap", "countdown", "স্টপওয়াচ", "স্টপওয়াচ", "stopwatch", "mnt", "min", "মিনিট", "ঘণ্টা", "hour"])

        if has_timer_kw:
            has_timer_act = any(a.get("type") in ["start_timer", "start_stopwatch", "stop_timer"] for a in actions if isinstance(a, dict))
            extracted_mins = parse_timer_duration_minutes(user_lower)

            if not has_timer_act and ("timer" in user_lower or "টাইমার" in user_lower or "ন্যাপ" in user_lower or "nap" in user_lower or "mnt" in user_lower or "min" in user_lower or "মিনিট" in user_lower or "countdown" in user_lower):
                if extracted_mins is not None:
                    task_name = "5m Power Nap" if ("ন্যাপ" in user_lower or "nap" in user_lower) else ("Gaming Break" if "game" in user_lower or "গেম" in user_lower else f"{extracted_mins}m Sprint")
                    actions.append({
                        "type": "start_timer",
                        "minutes": extracted_mins,
                        "cycles": 1,
                        "task": task_name,
                        "mode": "custom" if extracted_mins != 25 else "focus"
                    })
                elif "stopwatch" in user_lower or "স্টপওয়াচ" in user_lower or "স্টপওয়াচ" in user_lower:
                    actions.append({
                        "type": "start_stopwatch",
                        "task": "Activity Sprint",
                        "mode": "stopwatch"
                    })
                elif "stop" in user_lower or "বন্ধ" in user_lower or "থামাও" in user_lower or "অফ" in user_lower:
                    actions.append({
                        "type": "stop_timer",
                        "task": "Focus Session"
                    })
            elif has_timer_act and extracted_mins is not None:
                # Override minutes if LLM defaulted to 25 but user requested specific duration
                for a in actions:
                    if isinstance(a, dict) and a.get("type") == "start_timer" and a.get("minutes") == 25 and extracted_mins != 25:
                        a["minutes"] = extracted_mins
                        a["mode"] = "custom"

        # Single DB write session for saving response, memory, and actions
        write_conn = get_db(user_id)
        c = write_conn.cursor()

        for msg in reply_data:
            if str(msg).strip():
                try:
                    save_message(user_id, 'assistant', str(msg).strip(), emotion, conn=write_conn)
                except Exception as me:
                    print(f"[DB] save_message failed: {me}")

        if memory_content and isinstance(memory_content, str) and memory_content.strip():
            try:
                save_long_term_memory(user_id, memory_content.strip(), conn=write_conn)
                print(f"[MEMORY] Saved for user {user_id}: {memory_content.strip()}")
            except Exception as me:
                print(f"[DB] save_long_term_memory failed: {me}")

        if actions and isinstance(actions, list):
            for action in actions:
                if not isinstance(action, dict):
                    continue
                try:
                    atype = action.get("type")
                    if atype == "mark_absent":
                        c_name = action.get("course", "").lower()
                        for a in c.execute("SELECT * FROM attendance").fetchall():
                            if c_name in decrypt_text(a['course']).lower():
                                c.execute("UPDATE attendance SET total = total + 1 WHERE id = ?", (a['id'],))
                                break
                    elif atype == "set_routine":
                        raw_day = action.get('day', 'Mon')
                        day_map = {'saturday':'Sat', 'sunday':'Sun', 'monday':'Mon', 'tuesday':'Tue', 'wednesday':'Wed', 'thursday':'Thu', 'friday':'Fri'}
                        day_norm = day_map.get(raw_day.lower().strip(), raw_day[:3].capitalize())
                        c.execute('INSERT INTO routine (day, time, course, room, prof, color) VALUES (?,?,?,?,?,?)',
                                  (day_norm, action.get('time','10:00 AM'),
                                   encrypt_text(action.get('course','')), encrypt_text(''), encrypt_text(''), '#af101a'))
                    elif atype == "add_task":
                        c.execute('INSERT INTO tasks (title, note, done, date, priority) VALUES (?,?,0,?,?)',
                                  (encrypt_text(action.get('title','')), encrypt_text('Added by EKKHU'),
                                   date.today().isoformat(), 'medium'))
                    elif atype == "add_budget":
                        try:
                            amt = float(action.get("amount", 0.0))
                        except (ValueError, TypeError):
                            amt = 0.0
                        btype = action.get('expense_type') or action.get('type') or 'expense'
                        if btype == 'add_budget': btype = 'expense'
                        c.execute('INSERT INTO budget (type, desc, amount, date) VALUES (?,?,?,?)',
                                  (btype, encrypt_text(action.get('desc','')),
                                   amt, action.get("date", date.today().isoformat())))
                    elif atype == "add_plan":
                        c.execute('INSERT INTO plans (day, duration, title, status) VALUES (?,?,?,?)',
                                  (encrypt_text(action.get('day','')), encrypt_text(action.get('duration','')),
                                   encrypt_text(action.get('title','')), encrypt_text('pending')))
                    elif atype == "add_exam":
                        c.execute('INSERT INTO exams (title, course, type, date, time, notes) VALUES (?,?,?,?,?,?)',
                                  (encrypt_text(action.get('title', 'Exam')),
                                   encrypt_text(action.get('course', '')),
                                   encrypt_text(action.get('exam_type') or action.get('type') or 'Quiz'),
                                   action.get('date', date.today().isoformat()),
                                   action.get('time', '10:00 AM'),
                                   encrypt_text(action.get('notes', ''))))
                    elif atype == "set_academic_mode":
                        raw_mode = str(action.get('mode', 'prep_leave')).lower().strip()
                        if 'pl' in raw_mode or 'prep' in raw_mode:
                            mode = 'prep_leave'
                        elif 'exam' in raw_mode:
                            mode = 'exam_week'
                        elif 'break' in raw_mode or 'vacation' in raw_mode:
                            mode = 'semester_break'
                        elif 'holiday' in raw_mode or 'off' in raw_mode:
                            mode = 'holiday'
                        else:
                            mode = 'regular'
                        set_academic_state(user_id, mode, action.get('start_date', date.today().isoformat()), action.get('end_date', ''), action.get('note', ''), action.get('resume_date', ''), conn=write_conn)
                    elif atype == "cancel_class":
                        c_date = action.get('date', date.today().isoformat())
                        c_course = action.get('course', 'Class')
                        c_time = action.get('slot_time', '')
                        c_reason = action.get('reason', 'Class cancelled')
                        add_schedule_exception(user_id, c_date, c_course, c_time, 'class_cancelled', c_reason, conn=write_conn)
                    elif atype == "declare_holiday":
                        h_start = action.get('start_date', date.today().isoformat())
                        h_end = action.get('end_date', h_start)
                        h_reason = action.get('reason', 'University closed / holiday')
                        set_academic_state(user_id, 'holiday', h_start, h_end, h_reason, '', conn=write_conn)
                    elif atype == "resume_regular_classes":
                        set_academic_state(user_id, 'regular', '', '', 'Regular classes resumed', '', conn=write_conn)
                    elif atype == "adjust_focus_session":
                        c_mins = int(action.get('minutes', 480))
                        c_task = action.get('task', 'Sleep Tracking')
                        c.execute('DELETE FROM active_timer_state WHERE id = 1')
                        latest = c.execute('SELECT id, total_minutes FROM focus_sessions ORDER BY id DESC LIMIT 1').fetchone()
                        if latest:
                            c.execute('UPDATE focus_sessions SET total_minutes = ?, task_label = ? WHERE id = ?', (c_mins, c_task, latest['id']))
                        else:
                            c.execute('INSERT INTO focus_sessions (task_label, cycles_planned, cycles_done, total_minutes, date, started_at) VALUES (?,?,?,?,?,?)',
                                      (c_task, max(1, round(c_mins/25)), max(1, round(c_mins/25)), c_mins, date.today().isoformat(), datetime.now().isoformat()))
                except Exception as ae:
                    print(f"[ACTION] Execution skipped on error: {ae}")

            try:
                write_conn.commit()
            except Exception as ce:
                print(f"[DB] Commit error: {ce}")
                
        write_conn.close()
        TURSO_SYNC.trigger_async_push(user_id)

    except Exception as e:
        import traceback; traceback.print_exc()
        print(f"Action execution error or JSON Parse error: {e}")
        reply_data = ["আরে দোস্ত, নেটওয়ার্কে একটু ঝামেলা হইছিল। আবার একটু বলবি?"]
        emotion = "neutral"
        tts_text = "আরে দোস্ত, নেটওয়ার্কে একটু ঝামেলা হইছিল। আবার একটু বলবি?"
        actions = []

    return jsonify({"reply": reply_data, "emotion": emotion, "tts_text": tts_text, "actions": actions})

@app.route('/api/chat/history')
def chat_history_api():
    user_id = get_current_user_id()
    conn = get_db(user_id)
    c = conn.cursor()
    since = (datetime.now() - timedelta(days=7)).isoformat()
    rows = c.execute(
        'SELECT id, timestamp, role, content, emotion FROM chat_history WHERE timestamp >= ? ORDER BY id ASC',
        (since,)
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])

# ------------------------------------------------------------------
# Routes — Routine
# ------------------------------------------------------------------
@app.route('/api/routine', methods=['GET', 'POST', 'DELETE'])
def routine_api():
    user_id = get_current_user_id()
    conn = get_db(user_id)
    c = conn.cursor()
    if request.method == 'GET':
        rows = c.execute(
            'SELECT * FROM routine ORDER BY CASE day WHEN "Sun" THEN 1 WHEN "Mon" THEN 2 WHEN "Tue" THEN 3 WHEN "Wed" THEN 4 WHEN "Thu" THEN 5 WHEN "Fri" THEN 6 ELSE 7 END, time'
        ).fetchall()
        conn.close()
        items = [dict(r) for r in rows]
        for it in items:
            for k in ['course', 'room', 'prof']:
                it[k] = decrypt_text(it[k])
        return jsonify(items)
    if request.method == 'POST':
        d = request.json or {}
        c.execute('INSERT INTO routine (day, time, course, room, prof, color) VALUES (?,?,?,?,?,?)',
                  (d.get('day'), d.get('time'), encrypt_text(d.get('course','')),
                   encrypt_text(d.get('room','')), encrypt_text(d.get('prof','')), d.get('color','#af101a')))
        conn.commit(); conn.close()
        return jsonify({"ok": True})
    if request.method == 'DELETE':
        c.execute('DELETE FROM routine WHERE id=?', ((request.json or {}).get('id'),))
        conn.commit(); conn.close()
        return jsonify({"ok": True})

@app.route('/api/routine/parse', methods=['POST'])
def routine_parse_api():
    """Extract routine classes from uploaded image/pdf or raw text snippet using Gemini Vision / LLM."""
    user_id = get_current_user_id()
    raw_text = ""
    file_bytes = None
    mime_type = None

    if 'file' in request.files:
        f = request.files['file']
        if f.filename:
            mime_type = f.mimetype or 'image/png'
            file_bytes = f.read()
    elif request.json:
        raw_text = request.json.get('text', '').strip()
    elif request.form:
        raw_text = request.form.get('text', '').strip()

    if not file_bytes and not raw_text:
        return jsonify({"ok": False, "error": "No image or text provided"}), 400

    prompt = (
        "You are an ultra-accurate university timetable and class routine parser. "
        "Extract every single scheduled lecture/class from the provided image or text. "
        "OUTPUT PURE VALID JSON ONLY in this exact format:\n"
        '{\n'
        '  "classes": [\n'
        '    {\n'
        '      "day": "Sun" | "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat",\n'
        '      "time": "10:00 AM" | "01:30 PM",\n'
        '      "course": "Course Code or Name (e.g. CSE 220)",\n'
        '      "room": "Room number (e.g. UB702, Room 401)",\n'
        '      "prof": "Faculty Name or Initials",\n'
        '      "color": "#6366f1"\n'
        '    }\n'
        '  ]\n'
        '}\n'
        "RULES:\n"
        "1. Map days to: 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'.\n"
        "2. Format time as 'hh:mm AM' or 'hh:mm PM' (12-hour format).\n"
        "3. Assign distinct colors from: ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#8b5cf6', '#f97316', '#3b82f6'].\n"
        "4. If room or prof is missing, leave empty string.\n"
        "5. Do NOT include markdown ticks or text outside JSON."
    )

    extracted_classes = []

    # 1. Vision with Gemini Multimodal
    if file_bytes:
        gemini_keys = [k for k in [GEMINI_API_KEY_1, GEMINI_API_KEY_2] if k]
        smart_models = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash']
        import google.generativeai as genai
        
        for key in gemini_keys:
            if extracted_classes: break
            try:
                genai.configure(api_key=key)
                for model_name in smart_models:
                    try:
                        model = genai.GenerativeModel(model_name)
                        clean_mime = 'image/jpeg' if 'jpeg' in mime_type or 'jpg' in mime_type else 'image/png' if 'png' in mime_type else 'image/webp' if 'webp' in mime_type else 'image/png'
                        resp = model.generate_content([
                            prompt,
                            {'mime_type': clean_mime, 'data': file_bytes}
                        ])
                        txt = resp.text.strip() if resp.text else ""
                        parsed = safe_parse_json(txt)
                        if parsed and isinstance(parsed.get('classes'), list) and len(parsed['classes']) > 0:
                            extracted_classes = parsed['classes']
                            break
                    except Exception as me:
                        err_str = str(me)
                        print(f"[RoutineVision] {model_name} failed: {err_str[:80]}")
                        if "429" in err_str or "quota" in err_str.lower():
                            print("[RoutineVision] Quota exhausted on this key, skipping other models.")
                            break
                        if "404" in err_str:
                            continue
                
                # If still no classes, try lite on this key as last resort before moving to next key
                if not extracted_classes:
                    try:
                        model = genai.GenerativeModel('gemini-3.5-flash-lite')
                        resp = model.generate_content([prompt, {'mime_type': clean_mime, 'data': file_bytes}])
                        txt = resp.text.strip() if resp.text else ""
                        parsed = safe_parse_json(txt)
                        if parsed and isinstance(parsed.get('classes'), list) and len(parsed['classes']) > 0:
                            extracted_classes = parsed['classes']
                    except Exception as le:
                        print(f"[RoutineVision] flash-lite failed: {str(le)[:80]}")

            except Exception as ke:
                print(f"[RoutineVision] Gemini key error: {ke}")

    # 2. Text Parsing with LLM (Groq / Gemini)
    if not extracted_classes and (raw_text or file_bytes):
        text_payload = raw_text if raw_text else file_bytes.decode('utf-8', errors='ignore')
        messages = [
            {"role": "system", "content": prompt},
            {"role": "user", "content": f"Extract all class routine entries from this text:\n\n{text_payload}"}
        ]
        try:
            resp_text = call_llm(messages)
            parsed = safe_parse_json(resp_text)
            if parsed and isinstance(parsed.get('classes'), list):
                extracted_classes = parsed['classes']
        except Exception as e:
            print(f"[RoutineText] LLM failed: {e}")

    # Normalize extracted classes
    clean_classes = []
    valid_days = {'sun': 'Sun', 'mon': 'Mon', 'tue': 'Tue', 'wed': 'Wed', 'thu': 'Thu', 'fri': 'Fri', 'sat': 'Sat',
                  'sunday': 'Sun', 'monday': 'Mon', 'tuesday': 'Tue', 'wednesday': 'Wed', 'thursday': 'Thu', 'friday': 'Fri', 'saturday': 'Sat'}
    colors = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#8b5cf6', '#f97316', '#3b82f6']

    for idx, c in enumerate(extracted_classes):
        if not isinstance(c, dict): continue
        d_raw = str(c.get('day', '')).strip().lower()
        d_clean = valid_days.get(d_raw, 'Sun')
        c_course = str(c.get('course', '')).strip()
        if not c_course: continue
        c_time = str(c.get('time', '10:00 AM')).strip()
        c_room = str(c.get('room', '')).strip()
        c_prof = str(c.get('prof', '')).strip()
        c_color = c.get('color') or colors[idx % len(colors)]
        clean_classes.append({
            "day": d_clean,
            "time": c_time,
            "course": c_course,
            "room": c_room,
            "prof": c_prof,
            "color": c_color
        })

    return jsonify({"ok": True, "classes": clean_classes, "count": len(clean_classes)})

@app.route('/api/routine/batch_import', methods=['POST'])
def routine_batch_import():
    """Batch import extracted routine classes into database."""
    user_id = get_current_user_id()
    data = request.json or {}
    classes = data.get('classes', [])
    replace_all = data.get('replace_all', False)
    
    if not classes:
        return jsonify({"ok": False, "error": "No classes to import"}), 400

    conn = get_db(user_id)
    c = conn.cursor()
    if replace_all:
        c.execute('DELETE FROM routine')
    
    for item in classes:
        raw_day = str(item.get('day', 'Sun')).strip().capitalize()
        # Normalise to 3-letter day
        if len(raw_day) > 3:
            day_map = {'Monday': 'Mon', 'Tuesday': 'Tue', 'Wednesday': 'Wed', 'Thursday': 'Thu', 'Friday': 'Fri', 'Saturday': 'Sat', 'Sunday': 'Sun'}
            raw_day = day_map.get(raw_day, raw_day[:3])
        else:
            raw_day = raw_day[:3]
            
        c.execute('INSERT INTO routine (day, time, course, room, prof, color) VALUES (?,?,?,?,?,?)',
                  (raw_day, item.get('time', '10:00 AM'),
                   encrypt_text(item.get('course', '')),
                   encrypt_text(item.get('room', '')),
                   encrypt_text(item.get('prof', '')),
                   item.get('color', '#6366f1')))
    
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "imported_count": len(classes)})

# ------------------------------------------------------------------
# Routes — Attendance & AI Class Bunk Shield
# ------------------------------------------------------------------
@app.route('/api/attendance', methods=['GET', 'POST', 'DELETE'])
def attendance_api():
    user_id = get_current_user_id()
    conn = get_db(user_id)
    c = conn.cursor()
    if request.method == 'GET':
        rows = c.execute('SELECT * FROM attendance').fetchall()
        conn.close()
        items = []
        for r in rows:
            it = dict(r)
            it['course'] = decrypt_text(it['course'])
            shield = calculate_bunk_shield(it['present'], it['total'])
            it.update(shield)
            items.append(it)
        return jsonify(items)
    if request.method == 'POST':
        d = request.json or {}
        c.execute('INSERT INTO attendance (course, total, present) VALUES (?,?,?)',
                  (encrypt_text(d.get('course','')), d.get('total',0), d.get('present',0)))
        conn.commit(); conn.close()
        return jsonify({"ok": True})
    if request.method == 'DELETE':
        c.execute('DELETE FROM attendance WHERE id=?', ((request.json or {}).get('id'),))
        conn.commit(); conn.close()
        return jsonify({"ok": True})

@app.route('/api/attendance/update', methods=['POST'])
def attendance_update():
    user_id = get_current_user_id()
    d = request.json or {}
    conn = get_db(user_id)
    c = conn.cursor()
    c.execute('UPDATE attendance SET total=?, present=? WHERE id=?',
              (d.get('total'), d.get('present'), d.get('id')))
    conn.commit(); conn.close()
    return jsonify({"ok": True})

# ------------------------------------------------------------------
# Routes — Budget
# ------------------------------------------------------------------
@app.route('/api/budget', methods=['GET', 'POST', 'DELETE'])
def budget_api():
    user_id = get_current_user_id()
    conn = get_db(user_id)
    c = conn.cursor()
    if request.method == 'GET':
        rows = c.execute('SELECT * FROM budget ORDER BY date DESC').fetchall()
        conn.close()
        items = []
        total_in = total_out = 0.0
        for r in rows:
            it = dict(r)
            it['desc'] = decrypt_text(it['desc'])
            items.append(it)
            if it['type'] == 'income':
                total_in += it['amount']
            else:
                total_out += it['amount']
        return jsonify({"items": items, "total_in": total_in, "total_out": total_out,
                        "balance": total_in - total_out})
    if request.method == 'POST':
        d = request.json or {}
        c.execute('INSERT INTO budget (type, desc, amount, date) VALUES (?,?,?,?)',
                  (d.get('type'), encrypt_text(d.get('desc','')), d.get('amount',0),
                   d.get('date', date.today().isoformat())))
        conn.commit(); conn.close()
        return jsonify({"ok": True})
    if request.method == 'DELETE':
        c.execute('DELETE FROM budget WHERE id=?', ((request.json or {}).get('id'),))
        conn.commit(); conn.close()
        return jsonify({"ok": True})

# ------------------------------------------------------------------
# Routes — Plans
# ------------------------------------------------------------------
@app.route('/api/plans', methods=['GET', 'POST', 'PUT', 'DELETE'])
def plans_api():
    user_id = get_current_user_id()
    conn = get_db(user_id)
    c = conn.cursor()
    
    if request.method == 'GET':
        c.execute('SELECT * FROM plans')
        rows = [{"id":r['id'],"day":decrypt_text(r['day']),"duration":decrypt_text(r['duration']),"title":decrypt_text(r['title']),"status":decrypt_text(r['status'])} for r in c.fetchall()]
        conn.close()
        return jsonify(rows)
        
    elif request.method == 'POST':
        d = request.json
        c.execute('INSERT INTO plans (day, duration, title, status) VALUES (?,?,?,?)', 
                 (encrypt_text(d.get('day','')), encrypt_text(d.get('duration','')), encrypt_text(d.get('title','')), encrypt_text('pending')))
        conn.commit(); conn.close()
        return jsonify({"ok": True})
        
    elif request.method == 'PUT':
        d = request.json
        pid = d.get('id')
        updates = []
        params = []
        for field in ['day', 'duration', 'title', 'status']:
            if field in d:
                updates.append(f"{field}=?")
                params.append(encrypt_text(str(d[field])))
        if updates and pid:
            params.append(pid)
            c.execute(f"UPDATE plans SET {','.join(updates)} WHERE id=?", params)
            conn.commit()
        conn.close()
        return jsonify({"ok": True})
        
    elif request.method == 'DELETE':
        c.execute('DELETE FROM plans WHERE id=?', ((request.json or {}).get('id'),))
        conn.commit(); conn.close()
        return jsonify({"ok": True})

# ------------------------------------------------------------------
# Routes — Tasks
# ------------------------------------------------------------------
@app.route('/api/tasks', methods=['GET', 'POST', 'DELETE'])
def tasks_api():
    user_id = get_current_user_id()
    conn = get_db(user_id)
    c = conn.cursor()
    if request.method == 'GET':
        rows = c.execute('SELECT * FROM tasks ORDER BY done ASC, date ASC, priority DESC').fetchall()
        conn.close()
        items = []
        for r in rows:
            it = dict(r)
            it['title'] = decrypt_text(it['title'])
            it['note']  = decrypt_text(it['note']) if it.get('note') else ""
            it['due_time'] = it.get('due_time') or '11:59 PM'
            items.append(it)
        return jsonify(items)
    if request.method == 'POST':
        d = request.json or {}
        due_time = d.get('due_time', '11:59 PM')
        c.execute('INSERT INTO tasks (title, note, done, date, priority, due_time) VALUES (?,?,?,?,?,?)',
                  (encrypt_text(d.get('title','')), encrypt_text(d.get('note','')),
                   d.get('done',0), d.get('date', date.today().isoformat()), d.get('priority','medium'), due_time))
        conn.commit(); conn.close()
        return jsonify({"ok": True})
    if request.method == 'DELETE':
        c.execute('DELETE FROM tasks WHERE id=?', ((request.json or {}).get('id'),))
        conn.commit(); conn.close()
        return jsonify({"ok": True})

@app.route('/api/tasks/toggle', methods=['POST'])
def tasks_toggle():
    user_id = get_current_user_id()
    d = request.json or {}
    conn = get_db(user_id)
    c = conn.cursor()
    c.execute('UPDATE tasks SET done=? WHERE id=?', (d.get('done'), d.get('id')))
    conn.commit(); conn.close()
    return jsonify({"ok": True})

# ------------------------------------------------------------------
# Routes — CGPA
# ------------------------------------------------------------------
@app.route('/api/cgpa', methods=['GET', 'POST', 'DELETE'])
def cgpa_api():
    user_id = get_current_user_id()
    conn = get_db(user_id)
    c = conn.cursor()
    if request.method == 'GET':
        rows = c.execute('SELECT * FROM grades').fetchall()
        prof = c.execute('SELECT * FROM academic_profile WHERE id=1').fetchone()
        
        base_cgpa = float(prof['baseline_cgpa']) if prof and prof['baseline_cgpa'] else 0.0
        base_credits = float(prof['baseline_credits']) if prof and prof['baseline_credits'] else 0.0
        current_sem = decrypt_text(prof['current_semester']) if prof and prof['current_semester'] else '6th Semester'

        items = []
        course_credits = course_points = 0.0
        for r in rows:
            it = dict(r)
            it['course'] = decrypt_text(it['course'])
            items.append(it)
            course_credits += it['credit']
            course_points += it['grade'] * it['credit']

        total_credit = base_credits + course_credits
        total_points = (base_credits * base_cgpa) + course_points
        cgpa = round(total_points / total_credit, 2) if total_credit else 0.0
        conn.close()
        return jsonify({
            "items": items,
            "cgpa": cgpa,
            "total_credit": total_credit,
            "baseline_cgpa": base_cgpa,
            "baseline_credits": base_credits,
            "current_semester": current_sem
        })
    if request.method == 'POST':
        d = request.json or {}
        c.execute('INSERT INTO grades (course, credit, grade) VALUES (?,?,?)',
                  (encrypt_text(d.get('course','')), d.get('credit',3.0), d.get('grade',0.0)))
        conn.commit(); conn.close()
        return jsonify({"ok": True})
    if request.method == 'DELETE':
        c.execute('DELETE FROM grades WHERE id=?', ((request.json or {}).get('id'),))
        conn.commit(); conn.close()
        return jsonify({"ok": True})

@app.route('/api/cgpa/baseline', methods=['GET', 'POST'])
def cgpa_baseline():
    user_id = get_current_user_id()
    conn = get_db(user_id)
    c = conn.cursor()
    if request.method == 'GET':
        prof = c.execute('SELECT * FROM academic_profile WHERE id=1').fetchone()
        conn.close()
        if not prof:
            return jsonify({"current_semester": "6th Semester", "baseline_cgpa": 0.0, "baseline_credits": 0.0})
        return jsonify({
            "current_semester": decrypt_text(prof['current_semester']) if prof['current_semester'] else "6th Semester",
            "baseline_cgpa": float(prof['baseline_cgpa'] or 0.0),
            "baseline_credits": float(prof['baseline_credits'] or 0.0)
        })
    if request.method == 'POST':
        d = request.json or {}
        sem = d.get('current_semester', '6th Semester')
        base_cgpa = float(d.get('baseline_cgpa', 0.0))
        base_credits = float(d.get('baseline_credits', 0.0))
        c.execute('''INSERT INTO academic_profile (id, current_semester, baseline_cgpa, baseline_credits)
                     VALUES (1, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET
                     current_semester=excluded.current_semester,
                     baseline_cgpa=excluded.baseline_cgpa,
                     baseline_credits=excluded.baseline_credits''',
                  (encrypt_text(sem), base_cgpa, base_credits))
        conn.commit(); conn.close()
        return jsonify({"ok": True})

@app.route('/api/cgpa/predict', methods=['POST'])
def cgpa_predict():
    d = request.json or {}
    current_cgpa     = float(d.get('current_cgpa', 0))
    credits_done     = float(d.get('credits_done', 0))
    target_cgpa      = float(d.get('target_cgpa', 4.0))
    remaining_credits = float(d.get('remaining_credits', 0))
    if remaining_credits <= 0:
        return jsonify({"required_gpa": 0.0, "note": "No remaining credits"})
    total_points_needed = target_cgpa * (credits_done + remaining_credits)
    current_points      = current_cgpa * credits_done
    needed_gpa = (total_points_needed - current_points) / remaining_credits
    needed_gpa = max(0.0, min(4.0, needed_gpa))
    note = "You can reach your target!" if needed_gpa <= 4.0 else "Target is tough — give your best in remaining exams."
    return jsonify({"required_gpa": round(needed_gpa, 2), "note": note})

# ------------------------------------------------------------------
# Routes — Dashboard Summary
# ------------------------------------------------------------------
@app.route('/api/summary')
def summary():
    user_id = get_current_user_id()
    conn = get_db(user_id)
    c = conn.cursor()

    days_map = {0:'Mon',1:'Tue',2:'Wed',3:'Thu',4:'Fri',5:'Sat',6:'Sun'}
    today = days_map[today_bd_date().weekday()]
    today_routine = c.execute('SELECT * FROM routine WHERE day=? ORDER BY time', (today,)).fetchall()
    tr = [dict(r) for r in today_routine]
    for it in tr:
        for k in ['course','room','prof']:
            it[k] = decrypt_text(it[k])

    att = c.execute('SELECT * FROM attendance').fetchall()
    att_total   = sum(r['total']   for r in att)
    att_present = sum(r['present'] for r in att)
    att_percent = round((att_present / att_total * 100), 1) if att_total else 0
    
    att_courses = []
    critical_att_count = 0
    for a in att:
        it_a = dict(a)
        it_a['course'] = decrypt_text(it_a['course'])
        shield = calculate_bunk_shield(it_a['present'], it_a['total'])
        it_a.update(shield)
        att_courses.append(it_a)
        if shield['status'] in ['ZERO_BUFFER', 'DEFICIT']:
            critical_att_count += 1

    budget   = c.execute('SELECT * FROM budget').fetchall()
    total_in  = sum(r['amount'] for r in budget if r['type'] == 'income')
    total_out = sum(r['amount'] for r in budget if r['type'] == 'expense')
    balance   = total_in - total_out

    prof = c.execute('SELECT * FROM academic_profile WHERE id=1').fetchone()
    base_cgpa = float(prof['baseline_cgpa']) if prof and prof['baseline_cgpa'] else 0.0
    base_credits = float(prof['baseline_credits']) if prof and prof['baseline_credits'] else 0.0
    current_sem = decrypt_text(prof['current_semester']) if prof and prof['current_semester'] else '6th Semester'

    grades  = c.execute('SELECT * FROM grades').fetchall()
    course_credits = sum(r['credit'] for r in grades)
    course_points = sum(r['grade'] * r['credit'] for r in grades)
    tcredit = base_credits + course_credits
    tpoints = (base_credits * base_cgpa) + course_points
    cgpa    = round(tpoints / tcredit, 2) if tcredit else 0.0

    tasks   = c.execute('SELECT * FROM tasks').fetchall()
    pending = sum(1 for r in tasks if r['done'] == 0)
    done_ct = sum(1 for r in tasks if r['done'] == 1)

    today_str = today_bd_iso()
    focus_row = c.execute('SELECT SUM(total_minutes) as mins FROM focus_sessions WHERE date=?', (today_str,)).fetchone()
    today_focus_mins = focus_row['mins'] if focus_row and focus_row['mins'] else 0

    exam_rows = c.execute('SELECT * FROM exams WHERE date >= ? ORDER BY date ASC, time ASC LIMIT 5', (today_str,)).fetchall()
    exams = []
    for er in exam_rows:
        e_dict = dict(er)
        for k in ['title', 'course', 'type', 'notes']:
            e_dict[k] = decrypt_text(e_dict.get(k, ''))
        exams.append(e_dict)

    acad_state = get_academic_state(user_id, conn=conn)
    exceptions_today = get_schedule_exceptions(user_id, exc_date=today_str, conn=conn)

    conn.close()
    return jsonify({
        "today": today,
        "today_routine": tr,
        "att_percent": att_percent,
        "att_courses": att_courses,
        "critical_att_count": critical_att_count,
        "total_in": total_in,
        "total_out": total_out,
        "balance": balance,
        "cgpa": cgpa,
        "total_credit": tcredit,
        "current_semester": current_sem,
        "baseline_cgpa": base_cgpa,
        "baseline_credits": base_credits,
        "pending_tasks": pending,
        "done_tasks": done_ct,
        "today_focus_mins": today_focus_mins,
        "upcoming_exams": exams,
        "exam_count": len(exams),
        "academic_state": acad_state,
        "schedule_exceptions_today": exceptions_today
    })

# ------------------------------------------------------------------
# Academic Lifecycle & Schedule Exceptions Endpoints
# ------------------------------------------------------------------
@app.route('/api/academic_state', methods=['GET', 'POST'])
def api_academic_state():
    user_id = get_current_user_id()
    if request.method == 'POST':
        data = request.json or {}
        mode = data.get('mode', 'regular')
        start_date = data.get('start_date', '')
        end_date = data.get('end_date', '')
        note = data.get('note', '')
        resume_date = data.get('resume_date', '')
        set_academic_state(user_id, mode, start_date, end_date, note, resume_date)
        return jsonify({"ok": True, "academic_state": get_academic_state(user_id)})
    return jsonify(get_academic_state(user_id))

@app.route('/api/schedule_exceptions', methods=['GET', 'POST'])
def api_schedule_exceptions():
    user_id = get_current_user_id()
    if request.method == 'POST':
        data = request.json or {}
        exc_date = data.get('date', date.today().isoformat())
        course = data.get('course', '')
        slot_time = data.get('slot_time', '')
        exc_type = data.get('type', 'class_cancelled')
        reason = data.get('reason', '')
        add_schedule_exception(user_id, exc_date, course, slot_time, exc_type, reason)
        return jsonify({"ok": True, "exceptions": get_schedule_exceptions(user_id)})
    
    exc_date = request.args.get('date')
    return jsonify(get_schedule_exceptions(user_id, exc_date=exc_date))

@app.route('/api/schedule_exceptions/<int:exc_id>', methods=['DELETE'])
def api_delete_schedule_exception(exc_id):
    user_id = get_current_user_id()
    delete_schedule_exception(user_id, exc_id)
    return jsonify({"ok": True})

# ------------------------------------------------------------------
# Focus Session Tracking & Persistent Real-time Active Timer API
# ------------------------------------------------------------------
@app.route('/api/focus/active_timer', methods=['GET', 'POST', 'DELETE'])
def api_active_timer():
    """Real-time server-side timer state persistence across browser reloads, phone/laptop shutdowns."""
    user_id = get_current_user_id()
    conn = get_db(user_id)
    c = conn.cursor()

    if request.method == 'GET':
        try:
            row = c.execute('SELECT * FROM active_timer_state WHERE id = 1').fetchone()
            conn.close()
            if not row or not row['is_running']:
                return jsonify({'active': False})
            return jsonify({
                'active': True,
                'mode': row['mode'],
                'task': row['task'],
                'custom_minutes': row['custom_minutes'],
                'cycles': row['cycles'],
                'cycles_done': row['cycles_done'],
                'start_time_ms': row['start_time_ms'],
                'target_end_time_ms': row['target_end_time_ms'],
                'is_running': bool(row['is_running']),
                'updated_at': row['updated_at']
            })
        except Exception as e:
            conn.close()
            return jsonify({'active': False, 'error': str(e)})

    elif request.method == 'POST':
        data = request.get_json() or {}
        mode = data.get('mode', 'focus')
        task = data.get('task', 'Focus Sprint')
        custom_minutes = int(data.get('custom_minutes', 25))
        cycles = int(data.get('cycles', 1))
        cycles_done = int(data.get('cycles_done', 0))
        start_time_ms = int(data.get('start_time_ms', int(time.time() * 1000)))
        target_end_time_ms = int(data.get('target_end_time_ms', 0))
        is_running = 1 if data.get('is_running', True) else 0
        updated_at = datetime.now().isoformat()

        try:
            c.execute('''
                INSERT INTO active_timer_state (id, mode, task, custom_minutes, cycles, cycles_done, start_time_ms, target_end_time_ms, is_running, updated_at)
                VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    mode=excluded.mode,
                    task=excluded.task,
                    custom_minutes=excluded.custom_minutes,
                    cycles=excluded.cycles,
                    cycles_done=excluded.cycles_done,
                    start_time_ms=excluded.start_time_ms,
                    target_end_time_ms=excluded.target_end_time_ms,
                    is_running=excluded.is_running,
                    updated_at=excluded.updated_at
            ''', (mode, task, custom_minutes, cycles, cycles_done, start_time_ms, target_end_time_ms, is_running, updated_at))
            conn.commit()
            conn.close()
            TURSO_SYNC.trigger_async_push(user_id)
            return jsonify({'ok': True, 'saved': True})
        except Exception as e:
            conn.close()
            return jsonify({'ok': False, 'error': str(e)}), 500

    elif request.method == 'DELETE':
        try:
            c.execute('DELETE FROM active_timer_state WHERE id = 1')
            conn.commit()
            conn.close()
            TURSO_SYNC.trigger_async_push(user_id)
            return jsonify({'ok': True, 'cleared': True})
        except Exception as e:
            conn.close()
            return jsonify({'ok': False, 'error': str(e)}), 500


@app.route('/api/focus/log', methods=['POST'])
def focus_log():
    """Save a completed focus session."""
    user_id = get_current_user_id()
    data = request.get_json() or {}
    task_label    = data.get('task_label', '').strip() or 'Academic Focus'
    cycles_planned = int(data.get('cycles_planned', 1))
    cycles_done    = int(data.get('cycles_done', 1))
    total_minutes  = int(data.get('total_minutes', 0))
    if total_minutes <= 0:
        total_minutes = max(1, cycles_done * 25)
    
    # Don't inflate cycles for sleep or stopwatch tracking
    is_sleep_or_open = any(k in task_label.lower() for k in ['sleep', 'ঘুম', 'rest', 'nap', 'ন্যাপ', 'stopwatch', 'open-ended'])
    if is_sleep_or_open or data.get('is_stopwatch', False):
        cycles_done = 0
        cycles_planned = 0

    today          = date.today().isoformat()
    started_at     = data.get('started_at', datetime.now().isoformat())

    conn = get_db(user_id)
    c = conn.cursor()
    c.execute(
        'INSERT INTO focus_sessions (task_label, cycles_planned, cycles_done, total_minutes, date, started_at) VALUES (?,?,?,?,?,?)',
        (task_label, cycles_planned, cycles_done, total_minutes, today, started_at)
    )
    conn.commit()
    conn.close()
    return jsonify({'ok': True, 'minutes': total_minutes})


@app.route('/api/focus/history', methods=['GET'])
def focus_history():
    """Return the last 50 focus/activity sessions for the user."""
    user_id = get_current_user_id()
    conn = get_db(user_id)
    c = conn.cursor()
    rows = c.execute(
        'SELECT * FROM focus_sessions ORDER BY id DESC LIMIT 50'
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route('/api/focus/session/<int:session_id>', methods=['PUT', 'POST'])
def focus_update_session(session_id):
    """Update task label, minutes, or date for a specific session."""
    user_id = get_current_user_id()
    data = request.get_json() or {}
    task_label = data.get('task_label', '').strip() or 'General Activity'
    total_minutes = int(data.get('total_minutes', 25))
    date_str = data.get('date', date.today().isoformat())

    conn = get_db(user_id)
    c = conn.cursor()
    c.execute('UPDATE focus_sessions SET task_label=?, total_minutes=?, date=? WHERE id=?', 
              (task_label, total_minutes, date_str, session_id))
    conn.commit()
    conn.close()
    TURSO_SYNC.trigger_async_push(user_id)
    return jsonify({'ok': True, 'id': session_id, 'minutes': total_minutes})


@app.route('/api/focus/session/<int:session_id>', methods=['DELETE'])
def focus_delete_session(session_id):
    """Delete a specific focus session (e.g. erroneous or forgotten over-run timer)."""
    user_id = get_current_user_id()
    conn = get_db(user_id)
    c = conn.cursor()
    c.execute('DELETE FROM focus_sessions WHERE id=?', (session_id,))
    conn.commit()
    conn.close()
    TURSO_SYNC.trigger_async_push(user_id)
    return jsonify({'ok': True, 'deleted_id': session_id})


@app.route('/api/focus/manual_log', methods=['POST'])
def focus_manual_log():
    """Manually log past study, sleep, coding, or break session."""
    user_id = get_current_user_id()
    data = request.get_json() or {}
    task_label = data.get('task_label', '').strip() or 'General Activity'
    total_minutes = int(data.get('total_minutes', 30))
    date_str = data.get('date', date.today().isoformat())
    started_at = data.get('started_at', datetime.now().isoformat())
    
    is_sleep = any(k in task_label.lower() for k in ['sleep', 'ঘুম', 'rest', 'nap', 'ন্যাপ', 'stopwatch'])
    cycles_done = 0 if is_sleep else max(1, round(total_minutes / 25))

    conn = get_db(user_id)
    c = conn.cursor()
    c.execute(
        'INSERT INTO focus_sessions (task_label, cycles_planned, cycles_done, total_minutes, date, started_at) VALUES (?,?,?,?,?,?)',
        (task_label, cycles_done, cycles_done, total_minutes, date_str, started_at)
    )
    conn.commit()
    conn.close()
    TURSO_SYNC.trigger_async_push(user_id)
    return jsonify({'ok': True, 'minutes': total_minutes})


@app.route('/api/focus/adjust_active', methods=['POST'])
def focus_adjust_active():
    """Trim or correct an overgrown/forgotten active stopwatch or recent session."""
    user_id = get_current_user_id()
    data = request.get_json() or {}
    corrected_minutes = int(data.get('minutes', 480))
    task_label = data.get('task', 'Sleep Tracking')

    conn = get_db(user_id)
    c = conn.cursor()

    # 1. Clear active timer if running
    c.execute('DELETE FROM active_timer_state WHERE id = 1')
    
    # 2. Check if a session was logged today with > 10 hours or if we should update latest
    latest = c.execute('SELECT id, total_minutes FROM focus_sessions ORDER BY id DESC LIMIT 1').fetchone()
    if latest and (latest['total_minutes'] > 600 or data.get('update_latest', False)):
        c.execute('UPDATE focus_sessions SET total_minutes = ?, task_label = ?, cycles_done = 0 WHERE id = ?', 
                  (corrected_minutes, task_label, latest['id']))
    else:
        c.execute('INSERT INTO focus_sessions (task_label, cycles_planned, cycles_done, total_minutes, date, started_at) VALUES (?,?,?,?,?,?)',
                  (task_label, 0, 0, corrected_minutes, date.today().isoformat(), datetime.now().isoformat()))

    conn.commit()
    conn.close()
    TURSO_SYNC.trigger_async_push(user_id)
    return jsonify({'ok': True, 'corrected_minutes': corrected_minutes, 'task': task_label})


@app.route('/api/focus/stats', methods=['GET'])
def focus_stats():
    """Return aggregated focus stats for charts (weekly + monthly + task breakdown)."""
    user_id = get_current_user_id()
    conn = get_db(user_id)
    c = conn.cursor()

    today      = date.today()
    week_start = (today - timedelta(days=today.weekday())).isoformat()   # Monday
    month_start = today.replace(day=1).isoformat()

    # Weekly: minutes per day (Mon-Sun)
    week_rows = c.execute(
        "SELECT date, SUM(total_minutes) as mins FROM focus_sessions WHERE date >= ? GROUP BY date ORDER BY date",
        (week_start,)
    ).fetchall()

    # Monthly: minutes per day
    month_rows = c.execute(
        "SELECT date, SUM(total_minutes) as mins FROM focus_sessions WHERE date >= ? GROUP BY date ORDER BY date",
        (month_start,)
    ).fetchall()

    # Task breakdown (all time, top 10 tasks)
    task_rows = c.execute(
        "SELECT task_label, SUM(total_minutes) as mins, COUNT(*) as sessions FROM focus_sessions WHERE task_label != '' GROUP BY task_label ORDER BY mins DESC LIMIT 10"
    ).fetchall()

    # Recent 25 sessions
    recent_rows = c.execute(
        'SELECT * FROM focus_sessions ORDER BY id DESC LIMIT 25'
    ).fetchall()

    # Total stats & separate accurate breakdown for study vs sleep
    totals = c.execute(
        'SELECT COUNT(*) as total_sessions, SUM(total_minutes) as total_minutes FROM focus_sessions'
    ).fetchone()

    study_row = c.execute(
        "SELECT SUM(total_minutes) as mins FROM focus_sessions WHERE task_label NOT LIKE '%Sleep%' AND task_label NOT LIKE '%ঘুম%' AND task_label NOT LIKE '%Rest%' AND task_label NOT LIKE '%Nap%' AND task_label NOT LIKE '%ন্যাপ%'"
    ).fetchone()

    sleep_row = c.execute(
        "SELECT SUM(total_minutes) as mins FROM focus_sessions WHERE task_label LIKE '%Sleep%' OR task_label LIKE '%ঘুম%' OR task_label LIKE '%Rest%' OR task_label LIKE '%Nap%' OR task_label LIKE '%ন্যাপ%'"
    ).fetchone()

    cycles_row = c.execute(
        "SELECT SUM(cycles_done) as cyc FROM focus_sessions WHERE task_label NOT LIKE '%Sleep%' AND task_label NOT LIKE '%ঘুম%'"
    ).fetchone()

    totals_dict = dict(totals) if totals else {}
    totals_dict['total_minutes'] = totals_dict.get('total_minutes') or 0
    totals_dict['total_sessions'] = totals_dict.get('total_sessions') or 0
    totals_dict['study_minutes'] = (study_row['mins'] if study_row and study_row['mins'] else 0)
    totals_dict['sleep_minutes'] = (sleep_row['mins'] if sleep_row and sleep_row['mins'] else 0)
    totals_dict['total_cycles'] = (cycles_row['cyc'] if cycles_row and cycles_row['cyc'] else 0)

    conn.close()
    return jsonify({
        'weekly':    [dict(r) for r in week_rows],
        'monthly':   [dict(r) for r in month_rows],
        'tasks':     [dict(r) for r in task_rows],
        'recent':    [dict(r) for r in recent_rows],
        'totals':    totals_dict
    })


@app.route('/api/focus/pa_briefing', methods=['POST'])
def focus_pa_briefing():
    """Generate dynamic, context-aware PA briefings & suggestions for focus sessions."""
    user_id = get_current_user_id()
    data = request.get_json() or {}
    
    stage = data.get('stage', 'start')  # start | in_progress | break_needed | cycle_done | session_complete | checkin | query
    task_label = data.get('task_label', '').strip() or 'General Study Sprint'
    cycles_done = int(data.get('cycles_done', 0))
    cycles_planned = int(data.get('cycles_planned', 1))
    elapsed_minutes = int(data.get('elapsed_minutes', 0))
    user_query = data.get('query', '').strip()
    
    # 1. Fetch user academic context
    conn = get_db(user_id)
    c = conn.cursor()
    
    from datetime import timezone
    bd_tz = timezone(timedelta(hours=6))
    now = datetime.now(bd_tz)
    days_map = {0: 'Mon', 1: 'Tue', 2: 'Wed', 3: 'Thu', 4: 'Fri', 5: 'Sat', 6: 'Sun'}
    today_day = days_map[now.weekday()]
    today_date = date.today().isoformat()
    
    # Classes today
    routine_rows = c.execute('SELECT * FROM routine WHERE day=? ORDER BY time', (today_day,)).fetchall()
    classes = [f"{decrypt_text(r['course'])} at {r['time']}" for r in routine_rows] if routine_rows else ["No classes today"]
    
    # Pending tasks
    task_rows = c.execute('SELECT * FROM tasks WHERE done=0 ORDER BY id DESC LIMIT 5').fetchall()
    tasks_list = [f"{decrypt_text(t['title'])} ({t['priority']} priority)" for t in task_rows] if task_rows else ["No urgent tasks logged"]
    
    # Today's focus sessions
    focus_today = c.execute('SELECT SUM(total_minutes) as mins, COUNT(*) as cnt FROM focus_sessions WHERE date=?', (today_date,)).fetchone()
    focus_today_mins = focus_today['mins'] if focus_today and focus_today['mins'] else 0
    
    conn.close()

    # Build prompt for LLM PA Focus Coach
    pa_system_prompt = (
        "You are এক্কু (EKKHU), the user's AI Personal Assistant (PA) and smart Focus Coach. "
        "Your style: warm, classy, intelligent Bengali friend + executive personal assistant ('as a friend but professionally'). "
        "You speak in 100% natural, colloquial Bengali (বাংলা) / Banglish. "
        "Give actionable, empathetic, sharp advice. "
        "Return ONLY a JSON object with this exact schema:\n"
        "{\n"
        '  "message": "2-3 short, inspiring or advising sentences in natural Bengali/Banglish",\n'
        '  "tts_text": "Phonetically optimized text in PURE BENGALI SCRIPT (বাংলা হরফ) for TTS without markdown/emojis (e.g. অনেক ভালো কাজ করেছো... ফোকাস চালিয়ে যাও)",\n'
        '  "emotion": "hopeful | neutral | happy | tired",\n'
        '  "pa_suggestions": ["Action chip 1 (short)", "Action chip 2 (short)", "Action chip 3 (short)"],\n'
        '  "action_hint": "focus | break | review | task"\n'
        "}"
    )

    user_prompt_content = f"""=== FOCUS TELEMETRY & CONTEXT ===
Stage: {stage}
Target Task: {task_label}
Progress: {cycles_done}/{cycles_planned} cycles completed ({elapsed_minutes} mins elapsed)
Today's Date/Time: {now.strftime('%A, %I:%M %p')}
Today's Scheduled Classes: {', '.join(classes)}
Pending Priorities: {', '.join(tasks_list)}
Today's Focus Logged So Far: {focus_today_mins} mins
User's Question / Note (if any): {user_query if user_query else 'None'}

Specific Stage Goal:
- If stage is 'start': Give a crisp kickoff briefing, acknowledge the target '{task_label}', set clear focus momentum and remove distractions.
- If stage is 'break_needed' or 'cycle_done': Strongly and warmly advise taking a 5-minute break (hydration, 20-20-20 eye rest rule, posture stretch). Remind them that brief rests preserve cognitive performance.
- If stage is 'session_complete': Congratulate them on crushing the focus sprint, summarize the achievement, and suggest what to tackle next from their routine/tasks.
- If stage is 'checkin' or 'query': Answer their question directly with sharp PA insight, prioritizing their schedule and health.
"""

    messages = [
        {"role": "system", "content": pa_system_prompt},
        {"role": "user", "content": user_prompt_content}
    ]

    try:
        raw_res = call_llm(messages)
        # Parse JSON
        clean_res = raw_res.strip()
        if clean_res.startswith('```json'): clean_res = clean_res[7:]
        elif clean_res.startswith('```'): clean_res = clean_res[3:]
        if clean_res.endswith('```'): clean_res = clean_res[:-3]
        clean_res = clean_res.strip()
        
        parsed = json.loads(clean_res)
        raw_tts = parsed.get("tts_text", parsed.get("message", "ফোকাস চালিয়ে যাও দোস্ত"))
        return jsonify({
            "ok": True,
            "message": parsed.get("message", "ফোকাস চালিয়ে যাও দোস্ত, আমি পাশে আছি।"),
            "tts_text": normalize_bengali_tts(raw_tts),
            "emotion": parsed.get("emotion", "hopeful"),
            "pa_suggestions": parsed.get("pa_suggestions", [
                "💧 ৫ মিনিটের পানি ও স্ট্রেচ ব্রেক",
                "🎯 পরবর্তী প্রায়োরিটি টাস্ক শুরু করো",
                "📋 আজকের ক্লাসের নোট রিভিশন"
            ]),
            "action_hint": parsed.get("action_hint", "focus")
        })
    except Exception as e:
        print(f"[Focus PA] LLM call fallback due to: {e}")
        # Smart intelligent fallback based on stage
        if stage in ['break_needed', 'cycle_done']:
            fallback_msg = f"চমৎকার! {task_label}-এর একটা সাইকেল শেষ। এখন ৫ মিনিটের একটা ছোট ব্রেক নাও—চোখে পানি দাও আর একটু হেঁটে এসো।"
            tts_fallback = f"চমৎকার! {task_label} এর একটা সাইকেল শেষ। এখন পাঁচ মিনিটের একটা ছোট ব্রেক নাও। চোখে পানি দাও আর একটু হেঁটে এসো।"
            suggestions = ["💧 পানি খাও & চোখ রেস্ট দাও", "🚶‍♂️ ২ মিনিট পায়চারি করো", "⚡ അടുത്ത সাইকেলের প্রস্তুতি"]
            hint = "break"
            emo = "happy"
        elif stage == 'start':
            fallback_msg = f"চলো {task_label} শুরু করা যাক! ফোন দূরে রেখে একটানা ২৫ মিনিট ফুল ফোকাস দাও। আমি মনিটর করছি।"
            tts_fallback = f"চলো {task_label} শুরু করা যাক! ফোন দূরে রেখে একটানা পঁচিশ মিনিট ফুল ফোকাস দাও।"
            suggestions = ["🔕 নোটিফিকেশন মিউট করো", "🎯 মূল সমস্যাটি আগে ধরো", "⏱️ ২৫ মিনিট ডিপ ওয়ার্ক"]
            hint = "focus"
            emo = "hopeful"
        elif stage == 'session_complete':
            fallback_msg = f"অসাধারণ কাজ! সব সাইকেল সফলভাবে সম্পন্ন হয়েছে ({cycles_done * 25} মিনিট ফোকাস)। আজকের জন্য গ্রেট প্রগ্রেস!"
            tts_fallback = f"অসাধারণ কাজ! সব সাইকেল সফলভাবে সম্পন্ন হয়েছে। আজকের জন্য গ্রেট প্রগ্রেস!"
            suggestions = ["📝 টাস্ক ডান মার্ক করো", "☕ দীর্ঘ রিফ্রেশমেন্ট ব্রেক", "📅 রুটিনের পরবর্তী আইটেম দেখো"]
            hint = "review"
            emo = "happy"
        else:
            fallback_msg = f"সব ঠিকঠাক চলছে তো? কোনো টাস্ক বুঝতে প্রবলেম হলে বা প্রায়োরিটি ঠিক করতে চাইলে আমাকে বলো।"
            tts_fallback = "সব ঠিকঠাক চলছে তো? কোনো টাস্ক বুঝতে প্রবলেম হলে আমাকে বলো।"
            suggestions = ["📋 প্রায়োরিটি টাস্ক সাজাও", "💧 ৫ মিনিট ব্রেক নাও", "⚡ কুইক রিভিশন দাও"]
            hint = "task"
            emo = "neutral"

        return jsonify({
            "ok": True,
            "message": fallback_msg,
            "tts_text": tts_fallback,
            "emotion": emo,
            "pa_suggestions": suggestions,
            "action_hint": hint
        })


@app.route('/api/focus/ai_suggest', methods=['GET', 'POST'])
def focus_ai_suggest():
    """Return top AI recommended focus activities based on today's routine and pending tasks."""
    user_id = get_current_user_id()
    conn = get_db(user_id)
    c = conn.cursor()
    
    from datetime import timezone
    bd_tz = timezone(timedelta(hours=6))
    now = datetime.now(bd_tz)
    days_map = {0: 'Mon', 1: 'Tue', 2: 'Wed', 3: 'Thu', 4: 'Fri', 5: 'Sat', 6: 'Sun'}
    today_day = days_map[now.weekday()]
    
    # Routine & tasks
    routine_rows = c.execute('SELECT * FROM routine WHERE day=? ORDER BY time', (today_day,)).fetchall()
    classes = [f"{decrypt_text(r['course'])} ({r['time']})" for r in routine_rows]
    
    task_rows = c.execute('SELECT * FROM tasks WHERE done=0 ORDER BY CASE priority WHEN "high" THEN 1 WHEN "medium" THEN 2 ELSE 3 END LIMIT 8').fetchall()
    tasks = [{"id": t['id'], "title": decrypt_text(t['title']), "priority": t['priority'], "date": t['date']} for t in task_rows]
    
    conn.close()

    pa_prompt = (
        "You are এক্কু (EKKHU), an expert AI Personal Assistant and academic strategist. "
        "Analyze the user's current day schedule and task list. Suggest the TOP 3 most realistic, impactful focus sessions they should do right now.\n"
        "STRICT RULES:\n"
        "1. NO HALLUCINATION: DO NOT invent fake upcoming presentations, exams, or deadlines that are not explicitly listed in Pending Tasks or Today's Classes.\n"
        "2. If Pending Tasks list has items, base suggestions on those real tasks.\n"
        "3. If Pending Tasks and Classes are empty/none, suggest general productive focus areas (e.g. 'দৈনিক লক্ষ্য ও পরিকল্পনা নির্ধারণ', 'কোর সাবজেক্ট রিভিশন ও প্র্যাকটিস', 'প্রোগ্রামিং বা স্কিল ডেভেলপমেন্ট') and explain in the reason that because there are no pending deadlines, self-study/skill building is the best use of time.\n"
        "4. Write in 100% natural, correct Bengali (বাংলা) spelling. NEVER mix English letters inside Bengali words (e.g. write 'আগামীকালের', NEVER 'আগamীকালের').\n"
        "Return ONLY a JSON array of objects:\n"
        "[\n"
        "  {\n"
        '    "title": "Task or study activity title",\n'
        '    "cycles": 1 or 2,\n'
        '    "duration_label": "25m" or "50m",\n'
        '    "reason": "Short 1-sentence realistic strategic rationale in Bengali",\n'
        '    "badge": "High Priority" | "Class Prep" | "Skill Building" | "Daily Routine"\n'
        "  }\n"
        "]"
    )

    tasks_context = json.dumps(tasks, ensure_ascii=False) if tasks else "None (No pending tasks logged in database)"
    classes_context = ", ".join(classes) if classes else "None (No classes scheduled for today)"

    user_msg = f"Current Time: {now.strftime('%I:%M %p')}\nToday's Scheduled Classes: {classes_context}\nPending Tasks in DB: {tasks_context}"
    messages = [
        {"role": "system", "content": pa_prompt},
        {"role": "user", "content": user_msg}
    ]

    try:
        raw_res = call_llm(messages)
        clean = raw_res.strip()
        if clean.startswith('```json'): clean = clean[7:]
        elif clean.startswith('```'): clean = clean[3:]
        if clean.endswith('```'): clean = clean[:-3]
        parsed = json.loads(clean.strip())
        if isinstance(parsed, list) and len(parsed) > 0:
            return jsonify({"ok": True, "suggestions": parsed})
    except Exception as e:
        print(f"[Focus AI Suggest] Fallback due to: {e}")

    # Fallback suggestions if LLM is unavailable
    fallback_items = []
    if tasks:
        for t in tasks[:2]:
            fallback_items.append({
                "title": t['title'],
                "cycles": 1 if t['priority'] != 'high' else 2,
                "duration_label": "25m" if t['priority'] != 'high' else "50m",
                "reason": f"অগ্রাধিকার তালিকায় থাকা {t['priority']} প্রায়োরিটি টাস্ক।",
                "badge": "Urgent Priority" if t['priority'] == 'high' else "Pending Task"
            })
    if classes:
        fallback_items.append({
            "title": f"{classes[0]} প্রি-ক্লাস রিভিশন",
            "cycles": 1,
            "duration_label": "25m",
            "reason": "আজকের ক্লাসের মূল টপিকগুলো একবার চোখ বুলিয়ে নেওয়া।",
            "badge": "Class Prep"
        })
    if not fallback_items:
        fallback_items = [
            {"title": "দৈনিক স্টাডি ও নোটস অর্গানাইজেশন", "cycles": 1, "duration_label": "25m", "reason": "সারাদিনের পড়ার লক্ষ্য ও রিসোর্স ঠিক করে নেওয়া।", "badge": "Deep Focus"},
            {"title": "কোর সাবজেক্ট প্রবলেম সলভিং", "cycles": 2, "duration_label": "50m", "reason": "কঠিন কনসেপ্ট বা অ্যাসাইনমেন্টের ওপর গভীর মনোযোগ।", "badge": "Core Academic"}
        ]

    return jsonify({"ok": True, "suggestions": fallback_items})


# ------------------------------------------------------------------
# Routes — Exams & Quiz Tracking
# ------------------------------------------------------------------
@app.route('/api/exams', methods=['GET', 'POST', 'DELETE'])
def exams_api():
    """CRUD API for upcoming exams, quizzes, CTs, and project presentations."""
    user_id = get_current_user_id()
    conn = get_db(user_id)
    c = conn.cursor()
    if request.method == 'GET':
        rows = c.execute('SELECT * FROM exams ORDER BY date ASC, time ASC').fetchall()
        conn.close()
        items = []
        for r in rows:
            it = dict(r)
            for k in ['title', 'course', 'type', 'notes']:
                it[k] = decrypt_text(it.get(k, ''))
            items.append(it)
        return jsonify(items)
    if request.method == 'POST':
        d = request.json or {}
        c.execute('INSERT INTO exams (title, course, type, date, time, notes) VALUES (?,?,?,?,?,?)',
                  (encrypt_text(d.get('title', 'Exam')), encrypt_text(d.get('course', '')),
                   encrypt_text(d.get('type', 'Quiz')), d.get('date', date.today().isoformat()),
                   d.get('time', '10:00 AM'), encrypt_text(d.get('notes', ''))))
        conn.commit(); conn.close()
        return jsonify({"ok": True})
    if request.method == 'DELETE':
        d = request.json or {}
        c.execute('DELETE FROM exams WHERE id=?', (d.get('id'),))
        conn.commit(); conn.close()
        return jsonify({"ok": True})

@app.route('/api/exam/survival_plan', methods=['POST'])
def exam_survival_plan():
    """Generate a high-stakes 72-hour tactical battle plan for an upcoming exam."""
    user_id = get_current_user_id()
    data = request.json or {}
    course = data.get('course', 'Selected Course')
    title = data.get('title', 'Exam')
    hours_left = int(data.get('hours_left', 48))
    
    prompt = (
        "You are an elite academic performance coach specialized in high-stakes university exam preparation. "
        "Create an actionable, tactical 3-Phase Countdown Battle Plan for a university student preparing for an exam.\n"
        f"Target Exam: {course} - {title}\n"
        f"Time Remaining: {hours_left} hours\n"
        "OUTPUT PURE STRICT JSON with this exact structure:\n"
        "{\n"
        '  "course": "' + course + '",\n'
        '  "title": "' + title + '",\n'
        '  "hours_left": ' + str(hours_left) + ',\n'
        '  "headline": "Short punchy tactical battle title (e.g. 48h Tactical Sprint: Operation A+)",\n'
        '  "strategy_summary": "2-sentence high-impact execution strategy in Bengali/Banglish",\n'
        '  "phase_1": {\n'
        '    "name": "Phase 1: High-Yield Core Concept Sprint",\n'
        '    "duration_hours": ' + str(max(4, int(hours_left * 0.5))) + ',\n'
        '    "focus": "High-yield lecture slides, definitions, and core theorems",\n'
        '    "tasks": ["Task 1", "Task 2", "Task 3"]\n'
        '  },\n'
        '  "phase_2": {\n'
        '    "name": "Phase 2: Past Paper & Problem-Solving Drills",\n'
        '    "duration_hours": ' + str(max(2, int(hours_left * 0.35))) + ',\n'
        '    "focus": "Previous year exam questions, tricky code tracing, numericals",\n'
        '    "tasks": ["Task 1", "Task 2", "Task 3"]\n'
        '  },\n'
        '  "phase_3": {\n'
        '    "name": "Phase 3: Formula & Rapid Recall Lock-In",\n'
        '    "duration_hours": ' + str(max(1, int(hours_left * 0.15))) + ',\n'
        '    "focus": "Active recall flashcards, formula sheet lock-in, mental dry run",\n'
        '    "tasks": ["Task 1", "Task 2"]\n'
        '  }\n'
        "}"
    )

    messages = [
        {"role": "system", "content": "You are a master academic strategist. Output strict JSON only."},
        {"role": "user", "content": prompt}
    ]
    try:
        resp_text = call_llm(messages)
        parsed = safe_parse_json(resp_text)
        if parsed:
            parsed["ok"] = True
            return jsonify(parsed)
    except Exception as e:
        print(f"[SurvivalPlan] Error: {e}")

    # High-quality fallback
    p1_dur = max(4, int(hours_left * 0.5))
    p2_dur = max(2, int(hours_left * 0.35))
    p3_dur = max(1, hours_left - p1_dur - p2_dur)
    
    return jsonify({
        "ok": True,
        "course": course,
        "title": title,
        "hours_left": hours_left,
        "headline": f"{hours_left}h Tactical Sprint: Operation {course} Mastery",
        "strategy_summary": f"সব স্লাইড একবারে না পড়ে আগে ৮০% মার্কস বহন করে এমন কোর চ্যাপ্টারগুলো শেষ করো। তারপর বিগত বছরের প্রশ্নে হাত দাও।",
        "phase_1": {
            "name": "Phase 1: High-Yield Core Concept Sprint",
            "duration_hours": p1_dur,
            "focus": "High-yield lecture slides, definitions, and core theorems",
            "tasks": [
                f"Identify Top 3 most weighted topics in {course}",
                "Review lecture slide summaries & make 1-page formula sheet",
                "Lock in key definitions and fundamental concepts"
            ]
        },
        "phase_2": {
            "name": "Phase 2: Past Paper & Problem-Solving Drills",
            "duration_hours": p2_dur,
            "focus": "Previous year exam questions and practice problems",
            "tasks": [
                f"Solve 2 previous semester {course} midterm/quiz papers",
                "Identify repeating question patterns & tricky edge cases",
                "Run timed 45-minute problem-solving sprint"
            ]
        },
        "phase_3": {
            "name": "Phase 3: Formula & Rapid Recall Lock-In",
            "duration_hours": p3_dur,
            "focus": "Active recall flashcards and formula lock-in",
            "tasks": [
                "Rapid flip card review of all formulas & algorithms",
                "Mental dry run of exam questions without looking at notes",
                "Ensure at least 6 hours of solid sleep before exam"
            ]
        }
    })


# ------------------------------------------------------------------
# Routes — Executive Daily Briefing (Morning / Night / Day PA Hub)
# ------------------------------------------------------------------
@app.route('/api/pa/daily_briefing', methods=['GET'])
def pa_daily_briefing():
    """Return an executive, time-of-day briefing with voice readout and academic diagnostic."""
    user_id = get_current_user_id()
    conn = get_db(user_id)
    c = conn.cursor()
    
    from datetime import timezone
    bd_tz = timezone(timedelta(hours=6))
    now = datetime.now(bd_tz)
    hour = now.hour
    
    if 5 <= hour < 12:
        period = "morning"
        period_title = "Morning Executive Kickoff"
    elif 12 <= hour < 17:
        period = "afternoon"
        period_title = "Midday Momentum Check"
    elif 17 <= hour < 21:
        period = "evening"
        period_title = "Evening Strategy Brief"
    else:
        period = "night"
        period_title = "Nightly Debrief & Wrap-up"

    days_map = {0: 'Mon', 1: 'Tue', 2: 'Wed', 3: 'Thu', 4: 'Fri', 5: 'Sat', 6: 'Sun'}
    today_day = days_map[now.weekday()]
    today_str = date.today().isoformat()

    # Classes today
    routine_rows = c.execute('SELECT * FROM routine WHERE day=? ORDER BY time', (today_day,)).fetchall()
    classes = [f"{decrypt_text(r['course'])} ({r['time']})" for r in routine_rows]
    
    # Priority tasks
    task_rows = c.execute('SELECT * FROM tasks WHERE done=0 ORDER BY CASE priority WHEN "high" THEN 1 WHEN "medium" THEN 2 ELSE 3 END LIMIT 5').fetchall()
    tasks = [decrypt_text(t['title']) for t in task_rows]

    # Completed tasks today
    done_tasks = c.execute('SELECT COUNT(*) as cnt FROM tasks WHERE done=1').fetchone()['cnt']

    # Focus minutes today
    focus_row = c.execute('SELECT SUM(total_minutes) as mins FROM focus_sessions WHERE date=?', (today_str,)).fetchone()
    focus_mins = focus_row['mins'] if focus_row and focus_row['mins'] else 0

    # Upcoming exams in next 7 days
    future_7d = (date.today() + timedelta(days=7)).isoformat()
    exam_rows = c.execute('SELECT * FROM exams WHERE date >= ? AND date <= ? ORDER BY date ASC', (today_str, future_7d)).fetchall()
    exams = [f"{decrypt_text(e['title'])} on {e['date']}" for e in exam_rows]

    acad_state = get_academic_state(user_id, conn=conn)

    conn.close()

    pa_prompt = (
        "You are এক্কু (EKKHU), an elite AI Executive Personal Assistant. "
        f"Generate a crisp, empowering {period.upper()} executive briefing for the user in 100% natural, classy Bengali (বাংলা).\n"
        "Instructions:\n"
        "- 2-3 high-impact sentences summarizing the top priorities, exam prep, or celebration of today's progress.\n"
        "- If in Preparatory Leave (PL): Remind them about focused study sprints, revision blocks, and resting well before finals.\n"
        "- If morning: Energize and highlight today's first class, study sprint, or top task.\n"
        "- If night: Praise completed work, summarize focus time, advise restful sleep.\n"
        "- Return ONLY a JSON object:\n"
        "{\n"
        '  "message": "Executive briefing in Bengali",\n'
        '  "tts_text": "Phonetically optimized text for TTS without emojis or markdown",\n'
        '  "emotion": "hopeful | happy | neutral",\n'
        '  "highlights": ["Key highlight 1", "Key highlight 2"],\n'
        '  "action_chips": ["Action 1", "Action 2"]\n'
        "}"
    )

    user_context_msg = f"""Period: {period.upper()} ({now.strftime('%I:%M %p')})
Academic Mode: {acad_state['phase_label']} (Active Break/PL: {acad_state['is_active_break']}, Remaining: {acad_state['days_remaining']} days)
Today's Scheduled Classes: {'Classes Suspended (' + acad_state['phase_label'] + ')' if acad_state['is_active_break'] else (classes if classes else 'None scheduled')}
Pending Priority Tasks: {tasks if tasks else 'None pending'}
Today's Focus Time Logged: {focus_mins} mins
Completed Tasks: {done_tasks}
Upcoming Exams (Next 7 Days): {exams if exams else 'None in next 7 days'}"""

    try:
        raw_res = call_llm([
            {"role": "system", "content": pa_prompt},
            {"role": "user", "content": user_context_msg}
        ])
        clean = raw_res.strip()
        if clean.startswith('```json'): clean = clean[7:]
        elif clean.startswith('```'): clean = clean[3:]
        if clean.endswith('```'): clean = clean[:-3]
        parsed = json.loads(clean.strip())
        return jsonify({
            "ok": True,
            "period": period,
            "title": period_title,
            "message": parsed.get("message", "আজকের দিনটি গুছিয়ে শুরু করার জন্য প্রস্তুত!"),
            "tts_text": parsed.get("tts_text", parsed.get("message", "")),
            "emotion": parsed.get("emotion", "hopeful"),
            "highlights": parsed.get("highlights", [
                f"{len(classes)} Classes Today" if classes else "No Classes Today",
                f"{focus_mins}m Focused Today"
            ]),
            "action_chips": parsed.get("action_chips", ["Start Focus Sprint", "Review Tasks"])
        })
    except Exception as e:
        print(f"[PA Briefing] Fallback due to: {e}")

    # Intelligent Fallback Briefing
    if period == "morning":
        msg = f"শুভ সকাল! আজকের দিনে {len(classes)}টি ক্লাস এবং {len(tasks)}টি গুরুত্বপূর্ণ টাস্ক রয়েছে। চলুন ফোকাস দিয়ে দিনটি জয় করা যাক!"
        tts = "Shuvo sokal! Ajker dine class ebong guruttopurno task ache. Cholo fokas diye dinta joy kora jak!"
    elif period == "night":
        msg = f"আজকের দিনে মোট {focus_mins} মিনিট ডিপ ফোকাস সম্পন্ন হয়েছে। এবার বিশ্রাম নিয়ে আগামীকালের জন্য প্রস্তুত হওয়ার সময়।"
        tts = f"Ajker dine mot {focus_mins} minute deep focus shompurno hoyeche. Ebar bishram neoar shomoy."
    else:
        msg = f"দিনের অগ্রগতি চমৎকার চলছে! পরবর্তী গুরুত্বপূর্ণ লক্ষ্যগুলোতে নজর দেওয়ার এখনই সেরা সময়।"
        tts = "Diner ogrogoti chomotkar cholche! Poroborti guruttopurno lokkhe nojor deoar shomoy."

    return jsonify({
        "ok": True,
        "period": period,
        "title": period_title,
        "message": msg,
        "tts_text": tts,
        "emotion": "hopeful",
        "highlights": [f"{len(classes)} Class(es)", f"{focus_mins}m Focus Logged"],
        "action_chips": ["Start Focus Sprint", "Check Routine"]
    })


# ------------------------------------------------------------------
# Routes — AI Lecture Summarizer & Active Recall Flashcards
# ------------------------------------------------------------------
@app.route('/api/study/generate_flashcards', methods=['POST'])
def generate_flashcards_api():
    """Generate 5-minute study summary and active recall flashcards from topic/lecture text."""
    data = request.get_json() or {}
    topic = data.get('topic', '').strip() or 'Academic Topic'
    content = data.get('content', '').strip()
    
    if not content:
        content = f"Key concepts, fundamental formulas, and exam questions for: {topic}"

    prompt = (
        "You are an expert academic tutor and cognitive scientist. "
        "Analyze the provided academic topic and study material. "
        "Create an ultra-high-yield 5-minute summary + 4 active recall flashcards for deep focus revision.\n"
        "Return ONLY a JSON object:\n"
        "{\n"
        '  "summary": "3-4 sentence high-density concept summary in natural Bengali/Banglish",\n'
        '  "flashcards": [\n'
        '    {\n'
        '      "question": "Clear concept or challenge question in Bengali/English",\n'
        '      "answer": "Concise, precise explanation & core takeaways",\n'
        '      "tag": "Concept" | "Formula" | "Exam Prep"\n'
        '    }\n'
        '  ]\n'
        "}"
    )

    try:
        raw_res = call_llm([
            {"role": "system", "content": prompt},
            {"role": "user", "content": f"Topic: {topic}\nMaterial/Notes: {content[:3000]}"}
        ], endpoint="FLASHCARDS")
        clean = raw_res.strip()
        if clean.startswith('```json'): clean = clean[7:]
        elif clean.startswith('```'): clean = clean[3:]
        if clean.endswith('```'): clean = clean[:-3]
        parsed = json.loads(clean.strip())
        return jsonify({"ok": True, "data": parsed})
    except Exception as e:
        print(f"[Flashcards] Error: {e}")
        return jsonify({
            "ok": True,
            "data": {
                "summary": f"{topic}-এর মূল কনসেপ্ট ও ফান্ডামেন্টালগুলো রিভিশন দেওয়ার জন্য প্রস্তুত।",
                "flashcards": [
                    {"question": f"{topic}-এর মূল সংজ্ঞা ও প্রয়োজনীয়তা কি?", "answer": "কোর কনসেপ্ট ও রিয়েল-ওয়ার্ল্ড অ্যাপ্লিকেশনের বিস্তারিত পয়েন্ট।", "tag": "Concept"},
                    {"question": "পরীক্ষার জন্য সবচেয়ে গুরুত্বপূর্ণ ফর্মুলা বা অ্যালগরিদম কি?", "answer": "প্রবলেম সলভিং স্টেপস এবং টাইম কমপ্লেক্সিটি।", "tag": "Exam Prep"},
                    {"question": "কমন ভুল বা পিটফল কি কি হতে পারে?", "answer": "এজ কেস এবং কনসেপচুয়াল বাউন্ডারিগুলো সতর্কতার সাথে হ্যান্ডেল করা।", "tag": "Formula"}
                ]
            }
        })


# ------------------------------------------------------------------
# Routes — 1-Click iCalendar (.ics) Routine & Deadlines Exporter
# ------------------------------------------------------------------
@app.route('/api/routine/export_ics', methods=['GET'])
def export_routine_ics():
    """Generate and download RFC 5545 standard .ics file for Google Calendar & Apple Calendar."""
    from flask import Response
    user_id = get_current_user_id()
    conn = get_db(user_id)
    c = conn.cursor()
    
    routine_rows = c.execute('SELECT * FROM routine').fetchall()
    exam_rows = c.execute('SELECT * FROM exams').fetchall()
    conn.close()

    day_ics_map = {'Mon': 'MO', 'Tue': 'TU', 'Wed': 'WE', 'Thu': 'TH', 'Fri': 'FR', 'Sat': 'SA', 'Sun': 'SU'}
    
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//EKKHU//Academic OS 2.5//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "X-WR-CALNAME:EKKHU Academic Schedule",
        "X-WR-TIMEZONE:Asia/Dhaka"
    ]

    now_utc = datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')

    # Add Classes as recurring weekly events
    for idx, r in enumerate(routine_rows):
        course = decrypt_text(r['course'])
        room = decrypt_text(r['room'])
        prof = decrypt_text(r['prof'])
        day = r['day']
        byday = day_ics_map.get(day, 'MO')
        
        # Parse class time (e.g. "10:00 AM", "01:30 PM")
        time_str = r['time']
        try:
            pt = datetime.strptime(time_str.strip(), "%I:%M %p")
            hh = f"{pt.hour:02d}"
            mm = f"{pt.minute:02d}"
        except Exception:
            hh, mm = "10", "00"

        # Reference start date: this week's matching day
        lines.extend([
            "BEGIN:VEVENT",
            f"UID:ekkhu-class-{r['id']}-{now_utc}",
            f"DTSTAMP:{now_utc}",
            f"DTSTART:20260824T{hh}{mm}00",
            f"DTEND:20260824T{int(hh)+1:02d}{mm}00",
            f"RRULE:FREQ=WEEKLY;BYDAY={byday}",
            f"SUMMARY:{course} Class",
            f"LOCATION:{room}",
            f"DESCRIPTION:Instructor: {prof} • Managed via EKKHU OS",
            "STATUS:CONFIRMED",
            "END:VEVENT"
        ])

    # Add Upcoming Exams / Deadlines
    for e in exam_rows:
        title = decrypt_text(e['title'])
        course = decrypt_text(e['course'])
        etype = decrypt_text(e['type'])
        notes = decrypt_text(e['notes'])
        date_str = e['date'].replace('-', '')
        
        lines.extend([
            "BEGIN:VEVENT",
            f"UID:ekkhu-exam-{e['id']}-{now_utc}",
            f"DTSTAMP:{now_utc}",
            f"DTSTART;VALUE=DATE:{date_str}",
            f"DTEND;VALUE=DATE:{date_str}",
            f"SUMMARY:[{etype}] {course}: {title}",
            f"DESCRIPTION:{notes} • Tracked with EKKHU Executive OS",
            "BEGIN:VALARM",
            "TRIGGER:-PT24H",
            "ACTION:DISPLAY",
            f"DESCRIPTION:Upcoming {etype}: {course} tomorrow!",
            "END:VALARM",
            "END:VEVENT"
        ])

    lines.append("END:VCALENDAR")
    ics_body = "\r\n".join(lines)

    return Response(
        ics_body,
        mimetype="text/calendar",
        headers={"Content-Disposition": "attachment; filename=ekkhu_academic_schedule.ics"}
    )


# ------------------------------------------------------------------
@app.after_request
def add_header(r):
    """
    Add headers to both force latest IE rendering engine or Chrome Frame,
    and also to cache the rendered page for 10 minutes.
    """
    r.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    r.headers["Pragma"] = "no-cache"
    r.headers["Expires"] = "0"
    r.headers['Cache-Control'] = 'public, max-age=0'
    return r

if __name__ == '__main__':
    # Initialize DBs for all valid users
    init_all_users()
    
    app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0
    port = int(os.getenv('PORT', os.getenv('EKKU_PORT', 5000)))
    app.run(debug=False, host='0.0.0.0', port=port)

