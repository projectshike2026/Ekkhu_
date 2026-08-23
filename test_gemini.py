import os
from dotenv import load_dotenv
import google.generativeai as genai

load_dotenv(override=True)
GEMINI_API_KEY_1 = os.getenv('GEMINI_API_KEY_1')
GROQ_API_KEY = os.getenv('GROQ_API_KEY')

print(f"GEMINI_API_KEY_1: {'Loaded' if GEMINI_API_KEY_1 else 'MISSING'}")
print(f"GROQ_API_KEY: {'Loaded' if GROQ_API_KEY else 'MISSING'}")

if GEMINI_API_KEY_1:
    try:
        genai.configure(api_key=GEMINI_API_KEY_1)
        model = genai.GenerativeModel('gemini-3.6-flash')
        resp = model.generate_content("Hello! Are you working?")
        print("Gemini 3.6 response:", resp.text)
    except Exception as e:
        print("Gemini 3.6 Error:", type(e).__name__, "-", e)


if GROQ_API_KEY:
    try:
        from groq import Groq
        client = Groq(api_key=GROQ_API_KEY)
        resp = client.chat.completions.create(
            messages=[{"role": "user", "content": "Hello!"}],
            model="llama-3.3-70b-versatile",
            max_tokens=10
        )
        print("Groq response:", resp.choices[0].message.content)
    except Exception as e:
        print("Groq Error:", type(e).__name__, "-", e)

