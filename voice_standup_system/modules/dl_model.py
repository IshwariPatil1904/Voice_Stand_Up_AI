import os
import pickle
import re
from pathlib import Path

os.environ["TF_ENABLE_ONEDNN_OPTS"] = "0"
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"

import numpy as np
from tensorflow.keras.models import load_model

# Inference phase:
# Flask imports this module at startup, so we only load saved artifacts here.
# Training is handled once in train_model.py to keep app startup fast.
BASE_DIR = Path(__file__).resolve().parents[1]
MODEL_DIR = BASE_DIR / "models"
MODEL_PATH = MODEL_DIR / "model.h5"
VECTORIZER_PATH = MODEL_DIR / "vectorizer.pkl"
ENCODER_PATH = MODEL_DIR / "encoder.pkl"


def preprocess(text):
    text = text.lower()
    text = re.sub(r"[^a-z\s]", "", text)

    replacements = {
        "a p i": "api",
        "back end": "backend",
        "front end": "frontend",
        "log in": "login",
        "data base": "database",
        "done": "completed",
        "finished": "completed",
        "stuck": "blocked",
        "error": "problem",
    }

    for old_value, new_value in replacements.items():
        text = text.replace(old_value, new_value)

    return text


def _load_pickle(path):
    with path.open("rb") as file:
        return pickle.load(file)


def _load_artifacts():
    required_files = [MODEL_PATH, VECTORIZER_PATH, ENCODER_PATH]
    missing_files = [str(path) for path in required_files if not path.exists()]

    if missing_files:
        print("ERROR: Saved model artifacts not found. Run train_model.py first.")
        print("Missing files:", ", ".join(missing_files))
        return None, None, None

    model = load_model(str(MODEL_PATH), compile=False)
    vectorizer = _load_pickle(VECTORIZER_PATH)
    encoder = _load_pickle(ENCODER_PATH)

    return model, vectorizer, encoder


model, vectorizer, encoder = _load_artifacts()


def predict(sentence):
    if model is None or vectorizer is None or encoder is None:
        raise FileNotFoundError("Saved model artifacts not found. Run train_model.py first.")

    cleaned_sentence = preprocess(sentence)
    vector = vectorizer.transform([cleaned_sentence]).toarray()
    prediction = model.predict(vector, verbose=0)
    predicted_index = int(np.argmax(prediction))

    return encoder.inverse_transform([predicted_index])[0]
