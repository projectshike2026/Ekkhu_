import os
from dotenv import load_dotenv

load_dotenv(override=True)
GEMINI_API_KEY = os.getenv('GEMINI_API_KEY')
print("Key:", GEMINI_API_KEY)

import google.generativeai as genai
genai.configure(api_key=GEMINI_API_KEY)
SYSTEM_PROMPT = "You are a test."
model = genai.GenerativeModel('gemini-1.5-flash', system_instruction=SYSTEM_PROMPT)

try:
    print("Available models:")
    for m in genai.list_models():
        if 'generateContent' in m.supported_generation_methods:
            print(m.name)
except Exception as e:
    print("Error:", e)
