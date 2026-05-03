import os
import pickle
import random
import re
from pathlib import Path

os.environ["TF_ENABLE_ONEDNN_OPTS"] = "0"
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.preprocessing import LabelEncoder
from tensorflow.keras.layers import Dense, Input
from tensorflow.keras.models import Sequential

# Training phase:
# Run this file only when you want to train or refresh the model artifacts.
# The Flask app uses modules/dl_model.py for inference and loads these files.
BASE_DIR = Path(__file__).resolve().parent
MODEL_DIR = BASE_DIR / "models"
MODEL_PATH = MODEL_DIR / "model.h5"
VECTORIZER_PATH = MODEL_DIR / "vectorizer.pkl"
ENCODER_PATH = MODEL_DIR / "encoder.pkl"

RANDOM_SEED = 42
SAMPLES_PER_CATEGORY = 1000
MAX_FEATURES = 4000
EPOCHS = 20


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


TASK_TEMPLATES = [
    "I completed {}",
    "I finished {}",
    "I implemented {}",
    "I fixed {}",
    "I resolved {}",
    "Yesterday I completed {}",
    "I have completed {}",
    "I worked on {} and completed it",
    "Completed {}",
    "Done {}",
]

PLAN_TEMPLATES = [
    "I will work on {}",
    "I plan to work on {}",
    "Today I will do {}",
    "I will start {}",
    "I am going to work on {}",
    "I will implement {}",
    "I will fix {}",
    "Planning to work on {}",
    "Will do {}",
    "Next I will work on {}",
]

BLOCKER_TEMPLATES = [
    "I am blocked due to {}",
    "I am stuck because of {}",
    "Facing issue with {}",
    "There is a problem with {}",
    "I am unable to proceed due to {}",
    "I have issue in {}",
    "There is error in {}",
    "Blocked because of {}",
    "Facing problem in {}",
    "Cannot continue due to {}",
]

TOPICS = [
    "login module",
    "backend api",
    "database connection",
    "dashboard ui",
    "authentication system",
    "payment integration",
    "user profile",
    "testing module",
    "frontend design",
    "api integration",
    "bug fixing",
    "deployment process",
    "server configuration",
    "performance optimization",
    "validation logic",
    "notification system",
    "search functionality",
    "security features",
    "error handling",
    "session management",
    "report generation",
    "chat system",
    "file upload feature",
    "authentication bug",
    "database query",
    "api response",
    "frontend layout",
    "css styling",
    "data processing",
    "model training",
    "voice recognition",
    "speech processing",
    "nlp analysis",
    "blocker detection",
]


def generate_data(templates, label, rng):
    data = []

    for _ in range(SAMPLES_PER_CATEGORY):
        template = rng.choice(templates)
        topic = rng.choice(TOPICS)
        sentence = template.format(topic)

        variations = [
            sentence,
            sentence.lower(),
            "uh " + sentence,
            sentence.replace("I ", ""),
            sentence.replace("I am ", ""),
            sentence + " today",
            sentence + " yesterday",
        ]

        data.extend(variations)

    return data, [label] * len(data)


def build_dataset():
    rng = random.Random(RANDOM_SEED)

    task_data, task_labels = generate_data(TASK_TEMPLATES, "Task", rng)
    plan_data, plan_labels = generate_data(PLAN_TEMPLATES, "Plan", rng)
    blocker_data, blocker_labels = generate_data(BLOCKER_TEMPLATES, "Blocker", rng)

    sentences = task_data + plan_data + blocker_data
    labels = task_labels + plan_labels + blocker_labels

    return [preprocess(sentence) for sentence in sentences], labels


def build_model(input_size, output_size):
    model = Sequential(
        [
            Input(shape=(input_size,)),
            Dense(128, activation="relu"),
            Dense(64, activation="relu"),
            Dense(32, activation="relu"),
            Dense(output_size, activation="softmax"),
        ]
    )

    model.compile(
        loss="sparse_categorical_crossentropy",
        optimizer="adam",
        metrics=["accuracy"],
    )

    return model


def save_pickle(value, path):
    with path.open("wb") as file:
        pickle.dump(value, file)


def main():
    random.seed(RANDOM_SEED)
    np.random.seed(RANDOM_SEED)
    MODEL_DIR.mkdir(parents=True, exist_ok=True)

    sentences, labels = build_dataset()

    vectorizer = TfidfVectorizer(
        ngram_range=(1, 2),
        max_features=MAX_FEATURES,
    )
    features = vectorizer.fit_transform(sentences).toarray()

    encoder = LabelEncoder()
    encoded_labels = encoder.fit_transform(labels)

    model = build_model(features.shape[1], len(encoder.classes_))
    model.fit(
        features,
        encoded_labels,
        epochs=EPOCHS,
        batch_size=32,
        validation_split=0.1,
        verbose=1,
    )

    model.save(str(MODEL_PATH))
    save_pickle(vectorizer, VECTORIZER_PATH)
    save_pickle(encoder, ENCODER_PATH)

    print("Training complete.")
    print(f"Model saved to: {MODEL_PATH}")
    print(f"Vectorizer saved to: {VECTORIZER_PATH}")
    print(f"Encoder saved to: {ENCODER_PATH}")


if __name__ == "__main__":
    main()
