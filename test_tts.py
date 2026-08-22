import asyncio
import edge_tts

async def test():
    text = "হ্যালো, আমি একু।"
    voice = "bn-BD-NabanitaNeural"
    communicate = edge_tts.Communicate(text, voice, rate="-10%", pitch="+0Hz")
    audio_data = b""
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio_data += chunk["data"]
    print(f"Success! Got {len(audio_data)} bytes of audio")
    return audio_data

if __name__ == "__main__":
    asyncio.run(test())
