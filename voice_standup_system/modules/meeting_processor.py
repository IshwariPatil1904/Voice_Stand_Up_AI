import re

# -------- SPLIT BY SPEAKER --------
def split_by_speaker(text):
    lines = text.split("\n")
    data = []

    for line in lines:
        if ":" in line:
            name, speech = line.split(":", 1)
            data.append({
                "user": name.strip(),
                "text": speech.strip()
            })

    return data


# -------- SMART BLOCKER DETECTION --------
def smart_blocker_detection(text):
    patterns = [
        "blocked",
        "stuck",
        "issue",
        "problem",
        "error",
        "can't proceed",
        "waiting for",
        "dependency",
        "not able to",
        "delayed due to"
    ]

    for p in patterns:
        if p in text.lower():
            return True

    return False