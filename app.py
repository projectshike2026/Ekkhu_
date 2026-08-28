import os
import sqlite3
import re
import json
import base64
import hashlib
import shutil
from datetime import datetime, date, timedelta
from flask import Flask, render_template, request, jsonify
from dotenv import load_dotenv
import requests
from prompt import get_system_prompt, SYSTEM_PROMPT

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

def hash_pin(pin):
    return hashlib.sha256(str(pin).encode()).hexdigest()

def get_current_user_id():
    uid = request.headers.get('X-User-ID', '')
    users = load_users()
    valid_ids = {u['id'] for u in users}
    if uid in valid_ids:
        return uid
    # Fallback: first user
    return users[0]['id'] if users else 'u1'

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
# Database — Turso & Local
# ------------------------------------------------------------------
class TursoRow:
    def __init__(self, cols, vals):
        self._cols = cols
        self._vals = vals
        self._d = dict(zip(cols, vals))
    def __getitem__(self, key):
        if isinstance(key, int): return self._vals[key]
        return self._d[key]
    def get(self, key, default=None): return self._d.get(key, default)
    def __iter__(self): return iter(self._vals)
    def keys(self): return self._cols

class TursoCursor:
    def __init__(self, conn, user_id):
        self.conn = conn
        self.user_id = user_id
        self.rows = []
        self._row_idx = 0
        self.row_factory = None
        self.tables = ["routine", "attendance", "budget", "tasks", "plans", "grades", "chat_history", "long_term_memory"]

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
            resp = requests.post(http_url, headers=headers, json=payload, timeout=10)
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            raise sqlite3.OperationalError(f"Turso Network Error: {e}")
        
        result = data.get("results", [])[0]
        if result.get("type") == "ok":
            res = result["response"]["result"]
            cols = [c["name"] for c in res.get("cols", [])]
            self.rows = []
            for r in res.get("rows", []):
                vals = [val.get("value") if val.get("type") != "null" else None for val in r]
                self.rows.append(TursoRow(cols, vals) if self.row_factory else vals)
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

_initialized_users = set()

def get_db(user_id='A', skip_init=False):
    turso_url = os.getenv("TURSO_DATABASE_URL")
    turso_token = os.getenv("TURSO_AUTH_TOKEN")
    
    if turso_url and turso_token:
        conn = TursoConnection(turso_url, turso_token, user_id)
    else:
        db_name = f'user_{user_id}.db'
        conn = sqlite3.connect(db_name)
        
    conn.row_factory = sqlite3.Row
    if not skip_init and user_id not in _initialized_users:
        c = conn.cursor()
        try:
            c.execute("SELECT 1 FROM chat_history LIMIT 1")
            _initialized_users.add(user_id)
        except sqlite3.OperationalError:
            # Tables don't exist, initialize them
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
        date TEXT, priority TEXT DEFAULT 'medium'
    )''')
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
    conn.commit()

def init_db(user_id='A'):
    conn = get_db(user_id, skip_init=True)
    init_db_schema(conn)
    conn.close()

def init_all_users():
    """Initialize DB for all registered users."""
    users = load_users()
    for user in users:
        init_db(user['id'])
    print(f"[INIT] {len(users)} user database(s) ready.")

# Initialize DBs on startup
try:
    init_all_users()
except Exception as _e:
    print(f"[INIT] Error initializing DBs: {_e}")

# ------------------------------------------------------------------
# Chat helpers
# ------------------------------------------------------------------
def save_message(user_id, role, content, emotion=None, conn=None):
    close_after = False
    if conn is None:
        conn = get_db(user_id)
        close_after = True
    c = conn.cursor()
    ts = datetime.now().isoformat()
    c.execute('INSERT INTO chat_history (timestamp, role, content, emotion) VALUES (?, ?, ?, ?)',
              (ts, role, content, emotion))
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
    since = (datetime.now() - timedelta(days=7)).isoformat()
    c.execute('''SELECT timestamp, role, content FROM chat_history
                 WHERE timestamp >= ?
                 ORDER BY id DESC LIMIT ?''', (since, max_messages))
    rows = c.fetchall()
    if close_after:
        conn.close()
    
    messages = []
    for ts, role, content in reversed(rows):
        short_ts = ts[:16] if ts else "Unknown"
        formatted_content = f"[{short_ts}] {content}"
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
    ts = datetime.now().isoformat()
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

    from datetime import timezone
    from collections import Counter
    bd_tz = timezone(timedelta(hours=6))
    now_bd = datetime.now(bd_tz)

    summary = "\n\n=== SESSION CONTEXT ==="

    # Time since last message
    last_ts_str = rows[0][0]
    try:
        last_dt = datetime.fromisoformat(last_ts_str)
        if last_dt.tzinfo is None:
            last_dt = last_dt.replace(tzinfo=bd_tz)
        diff = now_bd - last_dt
        hours = diff.total_seconds() / 3600
        if hours < 1:
            summary += f"\nLast conversation: {int(diff.total_seconds() / 60)} minutes ago"
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

    if not rows:
        return False
    last_ts_str = rows[0][0]
    try:
        from datetime import timezone
        bd_tz = timezone(timedelta(hours=6))
        last_dt = datetime.fromisoformat(last_ts_str)
        if last_dt.tzinfo is None:
            last_dt = last_dt.replace(tzinfo=bd_tz)
        diff_hours = (datetime.now(bd_tz) - last_dt).total_seconds() / 3600
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
    arnob_ltm = get_long_term_memory('u1', conn=conn) if user_id != 'u1' else []

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
# LLM providers
# ------------------------------------------------------------------
def call_groq(messages):
    from groq import Groq
    client = Groq(api_key=GROQ_API_KEY)
    resp = client.chat.completions.create(
        messages=messages,
        model="llama3-70b-8192",
        response_format={"type": "json_object"},
        temperature=0.7,
        max_tokens=1024
    )
    return resp.choices[0].message.content

def call_gemini(messages, api_key):
    import google.generativeai as genai
    import json
    genai.configure(api_key=api_key)
    gm = []
    system_part = SYSTEM_PROMPT
    for m in messages:
        if m['role'] == 'system':
            system_part = m['content']
            continue
        role = 'model' if m['role'] == 'assistant' else 'user'
        content = m['content']
        
        if role == 'model':
            # Simplified mock JSON for context to avoid huge token padding
            mock_json = {
                "reply": [c.strip() for c in content.split('\n') if c.strip()],
                "emotion": "neutral"
            }
            content = json.dumps(mock_json)
            
        gm.append({'role': role, 'parts': [content]})
    for model_name in ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.5-flash']:
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
            return resp.text
        except Exception as e:
            print(f"Gemini model {model_name} failed: {e}")
    raise Exception("All Gemini models failed")

def call_llm(messages):
    """Priority: Gemini Key 1 → Gemini Key 2 (Groq disabled)"""
    providers = []
    if GEMINI_API_KEY_1:
        providers.append(('gemini-1', lambda: call_gemini(messages, GEMINI_API_KEY_1)))
    if GEMINI_API_KEY_2:
        providers.append(('gemini-2', lambda: call_gemini(messages, GEMINI_API_KEY_2)))
    # Groq disabled — uncomment below to re-enable:
    # if GROQ_API_KEY:
    #     providers.append(('groq', lambda: call_groq(messages)))
    if not providers:
        raise Exception("No API keys set! Set GEMINI_API_KEY_1 in environment variables.")
    errors = []
    for name, fn in providers:
        try:
            result = fn()
            print(f"[LLM] Provider '{name}' succeeded.")
            return result
        except Exception as e:
            errors.append(f"{name}: {e}")
            print(f"[LLM] Provider '{name}' failed → {e}")
    raise Exception("All providers failed: " + str(errors))

# ------------------------------------------------------------------
# Context builder
# ------------------------------------------------------------------
def get_user_context(user_id, conn=None):
    close_after = False
    if conn is None:
        conn = get_db(user_id)
        close_after = True
    c = conn.cursor()
    
    from datetime import datetime, timezone, timedelta
    bd_tz = timezone(timedelta(hours=6))
    now = datetime.now(bd_tz)
    
    days_map = {0: 'Mon', 1: 'Tue', 2: 'Wed', 3: 'Thu', 4: 'Fri', 5: 'Sat', 6: 'Sun'}
    today = days_map[now.weekday()]
    
    time_str = now.strftime("%I:%M %p")
    date_str = now.strftime("%B %d, %Y")
    
    hour = now.hour
    if 5 <= hour < 12:
        time_of_day = "Morning"
    elif 12 <= hour < 17:
        time_of_day = "Afternoon"
    elif 17 <= hour < 20:
        time_of_day = "Evening"
    else:
        time_of_day = "Night"

    today_routine = c.execute('SELECT * FROM routine WHERE day=? ORDER BY time', (today,)).fetchall()
    att = c.execute('SELECT * FROM attendance').fetchall()

    ctx = f"=== CURRENT CONTEXT (Bangladesh Time) ===\n"
    ctx += f"Date: {date_str} ({today})\n"
    ctx += f"Time: {time_str} ({time_of_day})\n\n"
    
    ctx += f"Today's Classes:\n"
    if today_routine:
        for r in today_routine:
            ctx += f"- {decrypt_text(r['course'])} at {r['time']}\n"
    else:
        ctx += "No classes scheduled for today.\n"

    # Query tasks
    tasks = c.execute('SELECT * FROM tasks WHERE done=0').fetchall()
    
    ctx += "\nPending Tasks:\n"
    if tasks:
        for t in tasks:
            title = decrypt_text(t['title'])
            note = decrypt_text(t['note']) if t['note'] else ""
            ctx += f"- {title} (Due: {t['date']}, Priority: {t['priority']}) {note}\n"
    else:
        ctx += "No pending tasks.\n"
        
    # Query budget for current month
    from datetime import date
    curr_month = date.today().strftime('%Y-%m')
    budget = c.execute('SELECT * FROM budget WHERE date LIKE ?', (f"{curr_month}%",)).fetchall()
    
    if close_after:
        conn.close()
    
    ctx += "\nThis Month's Budget & Expenses:\n"
    if budget:
        total_expense = sum(b['amount'] for b in budget if b['type'] == 'expense')
        total_income = sum(b['amount'] for b in budget if b['type'] == 'income')
        ctx += f"- Total Income: {total_income} BDT\n"
        ctx += f"- Total Expense: {total_expense} BDT\n"
        ctx += f"- Recent records:\n"
        for b in budget[-5:]:
            desc = decrypt_text(b['desc'])
            ctx += f"  * {b['type'].capitalize()}: {b['amount']} BDT for {desc} (on {b['date']})\n"
    else:
        ctx += "No budget records for this month.\n"

    ctx += "\nOverall Attendance History:\n"
    if att:
        for a in att:
            total = a['total']
            present = a['present']
            course = decrypt_text(a['course'])
            missed = total - present
            ctx += f"- {course}: Missed {missed} classes (Total: {total}, Attended: {present})\n"
    return ctx

# ------------------------------------------------------------------
# Routes — Auth & Users
# ------------------------------------------------------------------
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/users', methods=['GET'])
def api_users():
    users = load_users()
    safe = [
        {"id": u['id'], "name": u['name'], "color": u['color'],
         "has_pin": u['pin_hash'] is not None}
        for u in users
    ]
    return jsonify(safe)

@app.route('/api/create_account', methods=['POST'])
def api_create_account():
    """Create a new account using the invite code."""
    data = request.json or {}
    name = data.get('name', '').strip()
    pin  = str(data.get('pin', ''))
    code = data.get('invite_code', '').strip()

    if not name:
        return jsonify({"ok": False, "error": "Name is required"}), 400
    if len(pin) != 4 or not pin.isdigit():
        return jsonify({"ok": False, "error": "PIN must be exactly 4 digits"}), 400

    cfg = load_config()
    if code != cfg.get('invite_code', 'EKKU2025'):
        return jsonify({"ok": False, "error": "Invalid invite code"}), 403

    # Check duplicate name
    if any(u['name'].lower() == name.lower() for u in cfg['users']):
        return jsonify({"ok": False, "error": "An account with that name already exists"}), 409

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
    return jsonify({"ok": True, "id": uid, "name": name, "color": color})

@app.route('/api/auth', methods=['POST'])
def api_auth():
    data = request.json or {}
    user_id = data.get('user_id', '')
    pin = str(data.get('pin', ''))
    users = load_users()
    user = next((u for u in users if u['id'] == user_id), None)
    if not user:
        return jsonify({"ok": False, "error": "User not found"}), 404
    if user['pin_hash'] is None:
        return jsonify({"ok": True, "needs_setup": True})
    if hash_pin(pin) == user['pin_hash']:
        return jsonify({"ok": True, "needs_setup": False, "name": user['name'], "color": user['color']})
    return jsonify({"ok": False, "error": "Wrong PIN"}), 401

@app.route('/api/update_user', methods=['POST'])
def api_update_user():
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
        p = str(data['new_pin'])
        if len(p) == 4 and p.isdigit():
            user['pin_hash'] = hash_pin(p)
    save_users_data(users)
    return jsonify({"ok": True})

@app.route('/api/change_invite_code', methods=['POST'])
def api_change_invite_code():
    user_id = get_current_user_id()
    data = request.json or {}
    new_code = data.get('invite_code', '').strip()
    current_pin = str(data.get('pin', ''))
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
            for model_name in ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.5-flash']:
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
@app.route('/tts', methods=['POST'])
def tts():
    data = request.json or {}
    text = data.get('text', '')
    emotion = data.get('emotion', 'neutral').lower()
    if not text:
        return jsonify({"error": "No text"}), 400

    def clean_text(raw):
        # Strip any XML-like tags just in case they leak through
        cleaned = re.sub(r'</?[a-zA-Z]+[^>]*>', '', raw)
        cleaned = re.sub(r'[\U0001F300-\U0001F9FF\u2600-\u27BF]', '', cleaned)
        cleaned = re.sub(r'[ \t]+', ' ', cleaned)
        cleaned = re.sub(r'\n+', ' ', cleaned)
        return cleaned.strip()

    processed = clean_text(text)

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
        save_message(user_id, 'user', user_text, conn=read_conn)
        history = get_chat_history(user_id, max_messages=20, conn=read_conn)
        is_gap = is_first_message_after_gap(user_id, gap_hours=4, conn=read_conn)
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

        # 4. Fallback: extract plain text lines as reply
        lines = [line.strip() for line in text.split('\n') if line.strip() and not line.strip().startswith('{') and not line.strip().startswith('}') and '"reply"' not in line and '"actions"' not in line]
        reply = lines if lines else [text]
        return {"reply": reply, "emotion": "neutral", "tts_text": " ".join(reply)}

    try:
        result = safe_parse_llm_json(response_text)
        reply_data = result.get("reply", [response_text])
        if isinstance(reply_data, str):
            reply_data = [reply_data]
            
        # Clean SSML tags from visual reply
        cleaned_reply_data = []
        for r in reply_data:
            if isinstance(r, str):
                r_clean = re.sub(r'</?(break|emphasis|speak)[^>]*>', '', r).strip()
                r_clean = re.sub(r' +', ' ', r_clean)
                if r_clean:
                    cleaned_reply_data.append(r_clean)
            else:
                cleaned_reply_data.append(str(r))
        reply_data = cleaned_reply_data if cleaned_reply_data else ["বল দোস্ত, শুনতেছি।"]
            
        emotion = result.get("emotion", "neutral")
        actions = result.get("actions", [])
        memory_content = result.get("memory")
        tts_text = result.get("tts_text")
        if isinstance(tts_text, str):
            tts_text = re.sub(r'</?[a-zA-Z]+[^>]*>', '', tts_text).strip()
        else:
            tts_text = " ".join(reply_data)

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
                except Exception as ae:
                    print(f"[ACTION] Execution skipped on error: {ae}")

            try:
                write_conn.commit()
            except Exception as ce:
                print(f"[DB] Commit error: {ce}")
                
        write_conn.close()

    except Exception as e:
        import traceback; traceback.print_exc()
        print(f"Action execution error or JSON Parse error: {e}")
        reply_data = ["আরে দোস্ত, নেটওয়ার্কে একটু ঝামেলা হইছিল। আবার একটু বলবি?"]
        emotion = "neutral"
        tts_text = "আরে দোস্ত, নেটওয়ার্কে একটু ঝামেলা হইছিল। আবার একটু বলবি?"

    return jsonify({"reply": reply_data, "emotion": emotion, "tts_text": tts_text})

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

# ------------------------------------------------------------------
# Routes — Attendance
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
            it['percent'] = round((it['present'] / it['total'] * 100), 1) if it['total'] else 0
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
        rows = c.execute('SELECT * FROM tasks ORDER BY done ASC, date DESC').fetchall()
        conn.close()
        items = []
        for r in rows:
            it = dict(r)
            it['title'] = decrypt_text(it['title'])
            it['note']  = decrypt_text(it['note'])
            items.append(it)
        return jsonify(items)
    if request.method == 'POST':
        d = request.json or {}
        c.execute('INSERT INTO tasks (title, note, done, date, priority) VALUES (?,?,?,?,?)',
                  (encrypt_text(d.get('title','')), encrypt_text(d.get('note','')),
                   d.get('done',0), d.get('date', date.today().isoformat()), d.get('priority','medium')))
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
        conn.close()
        items = []
        tcredit = tpoints = 0.0
        for r in rows:
            it = dict(r)
            it['course'] = decrypt_text(it['course'])
            items.append(it)
            tcredit += it['credit']
            tpoints += it['grade'] * it['credit']
        cgpa = round(tpoints / tcredit, 2) if tcredit else 0.0
        return jsonify({"items": items, "cgpa": cgpa, "total_credit": tcredit})
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
    today = days_map[date.today().weekday()]
    today_routine = c.execute('SELECT * FROM routine WHERE day=? ORDER BY time', (today,)).fetchall()
    tr = [dict(r) for r in today_routine]
    for it in tr:
        for k in ['course','room','prof']:
            it[k] = decrypt_text(it[k])

    att = c.execute('SELECT * FROM attendance').fetchall()
    att_total   = sum(r['total']   for r in att)
    att_present = sum(r['present'] for r in att)
    att_percent = round((att_present / att_total * 100), 1) if att_total else 0

    budget   = c.execute('SELECT * FROM budget').fetchall()
    total_in  = sum(r['amount'] for r in budget if r['type'] == 'income')
    total_out = sum(r['amount'] for r in budget if r['type'] == 'expense')
    balance   = total_in - total_out

    grades  = c.execute('SELECT * FROM grades').fetchall()
    tcredit = sum(r['credit'] for r in grades)
    tpoints = sum(r['grade'] * r['credit'] for r in grades)
    cgpa    = round(tpoints / tcredit, 2) if tcredit else 0

    tasks   = c.execute('SELECT * FROM tasks').fetchall()
    pending = sum(1 for r in tasks if r['done'] == 0)
    done_ct = sum(1 for r in tasks if r['done'] == 1)

    conn.close()
    return jsonify({
        "today": today,
        "today_routine": tr,
        "att_percent": att_percent,
        "total_in": total_in,
        "total_out": total_out,
        "balance": balance,
        "cgpa": cgpa,
        "pending_tasks": pending,
        "done_tasks": done_ct
    })

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
    port = int(os.getenv('EKKU_PORT', 5000))
    app.run(debug=True, host='127.0.0.1', port=port)
