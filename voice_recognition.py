import speech_recognition as sr

def take_voice_input():
    r = sr.Recognizer()
    with sr.Microphone() as source:
        print("Please say something:")
        audio = r.listen(source, phrase_time_limit=3)
        
        try:
            voice_input = r.recognize_google(audio)
            print("You said: " + voice_input)
            return voice_input
        except sr.UnknownValueError:
            print("Google Speech Recognition could not understand your audio")
        except sr.RequestError as e:
            print("Could not request results from Google Speech Recognition service; {0}".format(e))

take_voice_input()