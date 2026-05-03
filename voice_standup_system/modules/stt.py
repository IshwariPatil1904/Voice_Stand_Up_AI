import os
import uuid

from pydub import AudioSegment
import speech_recognition as sr

def convert_audio_to_text(audio_path):
    try:
        converted_path = os.path.join("uploads", f"{uuid.uuid4()}.wav")

        audio = AudioSegment.from_file(audio_path)
        audio.export(converted_path, format="wav")

        recognizer = sr.Recognizer()

        with sr.AudioFile(converted_path) as source:
            audio_data = recognizer.record(source)

        try:
            text = recognizer.recognize_google(audio_data)
            print("Recognized Text:", text)
            return text
        except sr.UnknownValueError:
            return "Speech not recognized"
        except sr.RequestError:
            return "Speech recognition service unavailable"
    finally:
        if "converted_path" in locals() and os.path.exists(converted_path):
            os.remove(converted_path)
