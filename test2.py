import os
from dotenv import load_dotenv
import google.generativeai as genai

load_dotenv(override=True)
GEMINI_API_KEY = os.getenv('GEMINI_API_KEY')
print("API Key loaded:", bool(GEMINI_API_KEY))

genai.configure(api_key=GEMINI_API_KEY)
model = genai.GenerativeModel('gemini-flash-latest', system_instruction="You are a friend.")

try:
    gemini_messages = [{'role': 'user', 'parts': ['hi']}]
    print("Calling generate_content...")
    response = model.generate_content(
        gemini_messages,
        generation_config={"response_mime_type": "application/json"}
    )
    print("Success:", response.text)
except Exception as e:
    print("Error during call_gemini:", e)
