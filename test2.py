import os
from dotenv import load_dotenv
import google.generativeai as genai
import json

load_dotenv(override=True)
api_key = os.getenv('GEMINI_API_KEY_1')

genai.configure(api_key=api_key)
system_part = "You are a friend."
gm = [{'role': 'user', 'parts': ['{"thought_process": {"strategy": "Answer"}, "reply": ["Hello"], "emotion": "neutral", "actions": [], "memory": ""}']}]

models = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.5-flash']
for model_name in models:
    try:
        model = genai.GenerativeModel(model_name, system_instruction=system_part)
        resp = model.generate_content(
            gm, 
            generation_config={
                "response_mime_type": "application/json",
                "temperature": 0.7
            }
        )
        print(f"SUCCESS {model_name}: {resp.text}")
    except Exception as e:
        print(f"FAILED {model_name}: {type(e).__name__} - {e}")

