# EKKU — Academic OS

**EKKU (একু)** একটি ১০০% অফলাইন-ফার্স্ট ডেস্কটপ অ্যাপ্লিকেশন, যা শিক্ষার্থীদের দৈনন্দিন একাডেমিক প্রোডাক্টিভিটি ম্যানেজমেন্টের জন্য তৈরি। এটি **Electron.js + Python Flask** এর সমন্বয়ে বানানো — দেখতে VS Code/Discord-এর মতো স্বতন্ত্র উইন্ডোতে চলে, আর একই কোডবেস থেকে Windows, macOS ও Linux-এর জন্য আলাদা ইনস্টলার তৈরি করা যায়।

> UI ডিজাইনটি **AODAS Dashboard**-এর Material Design ভাষায় অনুসরণ করে তৈরি — সাইডবার, টপবার, স্ট্যাটাস বার ও Material টোকেনসহ।

---

## 🚀 বৈশিষ্ট্য (Features)

| মডিউল | বিবরণ |
|---|---|
| **Dashboard** | আজকের রুটিন, বাজেট ব্যালেন্স, অ্যাটেন্ডেন্স %, CGPA, পেন্ডিং টাস্ক — সব এক নজরে |
| **Routine** | সাপ্তাহিক ক্লাস রুটিন (দিন, সময়, রুম, প্রফেসর, কালার) — add/delete |
| **Attendance** | প্রতি কোর্সে মোট/উপস্থিত ক্লাস, লাইভ % ট্র্যাকিং |
| **Budget** | মাসিক আয়/ব্যয়, রেমেইনিং ব্যালেন্স হিসাব |
| **CGPA Predictor** | কোর্স ও গ্রেড যোগ → বর্তমান CGPA; টার্গেট CGPA-র জন্য দরকারি GPA পূর্বাভাস |
| **Tasks** | দৈনন্দিন টাস্ক (high/medium/low priority) — track & record |
| **AI Tutor (একু)** | বাংলায় পড়াশোনা/প্রোডাক্টিভিটির সহায়ক চ্যাটবট (Gemini/Groq API) + বাংলা TTS |

## 🔒 প্রাইভেসি
সব ইউজার ডেটা (রুটিন, অ্যাটেন্ডেন্স, বাজেট, টাস্ক, CGPA) লোকাল **SQLite** ডেটাবেসে **Fernet এনক্রিপশন** দিয়ে সংরক্ষিত — কোনো তথ্য ইন্টারনেটে যায় না। শুধুমাত্র AI টিউটর চ্যাটে API কল হয়।

---

## 📂 প্রজেক্ট স্ট্রাকচার
```
EKKHU/
├── main.js              # Electron main process (Flask অটো-স্টার্ট, উইন্ডো)
├── preload.js           # নিরাপদ IPC bridge
├── package.json         # Electron config & build
├── app.py               # Flask backend (সব API + SQLite + encryption)
├── requirements.txt     # Python dependencies
├── templates/index.html # EKKU Dashboard UI (SPA)
├── static/app.js        # Frontend logic (SPA navigation + CRUD + chat)
└── ekku.db / ekku.key   # Runtime-এ তৈরি হয় (এনক্রিপ্টেড ডেটা)
```

---

## 🔧 চালানোর নিয়ম

### পদ্ধতি ১ — ব্রাউজারে (Flask)
```bash
py -m pip install -r requirements.txt
py app.py
```
ব্রাউজারে খুলুন: **http://127.0.0.1:5000**

### পদ্ধতি ২ — ডেস্কটপ অ্যাপ (Electron)
```bash
npm install
npm start
```

### পদ্ধতি ৩ — ইনস্টলার তৈরি
```bash
npm run dist
```
উইন্ডোজে `.exe` (NSIS), ম্যাকে `.dmg`, লিনাক্সে `.AppImage` তৈরি হবে।

---

## ⚙️ কনফিগারেশন
`.env` ফাইলে API কী দিন (AI টিউটরের জন্য):
```
GEMINI_API_KEY=your_key
GROQ_API_KEY=your_key
```
AI টিউটর ছাড়া বাকি সব ফিচার সম্পূর্ণ অফলাইনে কাজ করে।

---

## ℹ️ টিপস
- অ্যাপ প্রথম চালু হলে `init_db()` স্বয়ংক্রিয়ভাবে সব টেবিল তৈরি করবে।
- এনক্রিপশন কী `ekku.key` ফাইলে লোকালি সংরক্ষিত হয় — `.gitignore`-এ রাখা আছে।
