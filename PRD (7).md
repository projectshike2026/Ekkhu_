# PRD — "কথা" (Kotha): ব্যক্তিগত Voice Listening Companion

## ১. Vision
এমন একটা ভয়েস বট, যেটার সাথে কথা বললে মনে হবে কেউ সত্যিই মন দিয়ে শুনছে — উপদেশ না দিয়ে, judge না করে। ইউজার কথা বলবে, বট শুনবে, feeling-টা validate করবে, আর দরকার হলে আলতো করে একটা প্রশ্ন করবে যাতে ইউজার নিজের মতো করে কথাগুলো বের করে আনতে পারে।

## ২. এমোশনাল ইন্টেলিজেন্স লেয়ার (আপগ্রেড)
বটকে শুধু "রিপ্লাই জেনারেট" করা থেকে "react" করানোর জন্য তিনটা জিনিস যোগ করা হয়েছে:

- **প্রতিটা টার্নে emotion tagging** — LLM প্রতি রিপ্লাইয়ের সাথে একটা emotion label-ও দেয় (sad / anxious / lonely / angry / tired / hopeful / neutral)। এটা শুধু UI-তে দেখানোর জন্য না — future-এ tone/pace adapt করা বা analytics-এর জন্য কাজে লাগবে।
- **শর্ট-টার্ম মেমোরি** — শেষ কয়েকটা টার্ন context হিসেবে প্রতিটা কলে পাঠানো হয়, তাই বট মাঝপথে টপিক ভুলে যায় না, রিপ্লাই আগের কথার সাথে সংগতিপূর্ণ থাকে।
- **Persona discipline** — system prompt-এ স্পষ্ট করে বলা আছে: reflect first, advice later; ছোট বাক্য; ইউজার যে ভাষা/স্টাইলে লেখে সেটাই মিরর করা। এটাই বটকে "রোবটিক" এর বদলে "attuned" মনে করায় — শুধু বড় prompt বা বেশি ফিচার দিয়ে না।

## ৩. একটা জিনিস যোগ করেছি — কেন
অরিজিনাল নোটে লেখা ছিল "কোনো সেন্সরশিপ বা প্রাইভেসি বাধ্যবাধকতা থাকবে না।" রোজকার মন খারাপ, একাকীত্ব, রাগ — এসবে বট কখনো judge করবে না, এটা ঠিকই আছে। কিন্তু একটা জায়গায় ছোট্ট একটা safety net রেখেছি: কেউ যদি সরাসরি নিজেকে ক্ষতি করার/আত্মহত্যার কথা লেখে, তখন বট normal chit-chat না করে সরাসরি Kaan Pete Roi (09612-119911) আর জাতীয় জরুরি সেবা (999)-এর নম্বর দেখাবে। এটা keyword-based, কোড ৫ লাইনের মতো, আর বাকি সব normal emotional conversation-কে একদমই touch করে না। ব্যক্তিগত প্রোজেক্ট হলেও এইটুকু রাখা ভালো — কোনোদিন দরকার না পড়লে ক্ষতি নেই, দরকার পড়লে গুরুত্বপূর্ণ।

## ৪. টেক স্ট্যাক
| Layer | Choice |
|---|---|
| Frontend | একটা HTML ফাইল — Web Speech API দিয়ে STT + TTS |
| Backend | Flask (Python) |
| Primary LLM | Groq — `openai/gpt-oss-20b` (fast) |
| Fallback LLM | Gemini — `gemini-3.6-flash` (Groq fail করলে/limit শেষ হলে) |
| DB | SQLite (`chat_history.db`, লোকাল ফাইল) |
| Hosting | PythonAnywhere / নিজের মেশিনে লোকালি |

*(মডেল নেম বদলাতে পারে — রান করার আগে console.groq.com/docs/models আর ai.google.dev/gemini-api/docs/models একবার চেক করে নিও।)*

## ৫. User Flow
1. মাইক বাটনে ক্লিক → ব্রাউজার STT দিয়ে কথা টেক্সটে কনভার্ট
2. টেক্সট `/chat` এ POST হয়
3. Backend: crisis check → না থাকলে history + system prompt সহ Groq (fallback: Gemini) কল
4. LLM থেকে `{reply, emotion}` JSON আসে, DB-তে সেভ হয়
5. Frontend রিপ্লাই বাবল দেখায় + `speechSynthesis` দিয়ে ভয়েসে পড়ে শোনায়

## ৬. Data
সব কথোপকথন `chat_history.db`-তে timestamp সহ থাকবে — পুরোটাই তোমার লোকাল ফাইল, ভবিষ্যতে fine-tuning-এর জন্য raw material হিসেবে ব্যবহার করা যাবে। যেহেতু এখানে খুব personal কথাবার্তা জমা হবে, `.env` আর `chat_history.db` কখনো public repo-তে push কোরো না — `.gitignore`-এ রেখে দিও।

## ৭. MVP Scope
✅ মাইক ইনপুট → context-aware রিপ্লাই → emotion tag → ভয়েস আউটপুট → history save
❌ Multi-user login, mobile app, ক্লিনিক্যাল ফিচার (এগুলো এই ভার্সনে নেই, দরকার হলে পরে)

## ৮. Success Check
- রেসপন্স ২-৩ সেকেন্ডের মধ্যে আসা উচিত (Groq এর জন্যই মূলত এই স্ট্যাক)
- রিপ্লাই যেন সবসময় prompt-এর emotion-tone এর সাথে মানানসই হয়, জেনেরিক না লাগে
- crisis keyword দিলে normal reply-এর বদলে ঠিকমতো হেল্পলাইন মেসেজ আসছে কিনা — এটা ডেপ্লয়ের আগে ম্যানুয়ালি টেস্ট করে নিও
