import re

FILLER_PATTERN = re.compile(
    r"\b(?:um+|uh+|hmm+|like|you know|actually|basically)\b",
    flags=re.IGNORECASE,
)

MULTISPACE_PATTERN = re.compile(r"[ \t]+")
MULTILINE_PATTERN = re.compile(r"\n+")

REPLACEMENTS = {
    "can't": "cannot",
    "won't": "will not",
    "issue": "problem",
    "errors": "problems",
}


def preprocess_text(text):
    cleaned = (text or "").replace("\r", "\n")

    for source, target in REPLACEMENTS.items():
        cleaned = re.sub(rf"\b{re.escape(source)}\b", target, cleaned, flags=re.IGNORECASE)

    cleaned = FILLER_PATTERN.sub(" ", cleaned)
    cleaned = MULTISPACE_PATTERN.sub(" ", cleaned)
    cleaned = MULTILINE_PATTERN.sub("\n", cleaned)
    return cleaned.strip()


def split_sentences(text):
    parts = re.split(r"[.!?]+", text or "")
    return [part.strip(" \n\t-") for part in parts if part.strip(" \n\t-")]
