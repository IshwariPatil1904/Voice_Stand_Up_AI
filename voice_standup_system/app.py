import base64
import csv
from datetime import datetime, timedelta
from functools import wraps
import io
import logging
from logging.handlers import RotatingFileHandler
import os
import re
import uuid
from urllib.parse import quote

import bcrypt
from bson import ObjectId
from flask import Flask, Response, jsonify, redirect, render_template, request, session
from flask_socketio import SocketIO, emit, join_room, leave_room

from config import db
from modules.dl_model import predict
from modules.preprocessing import preprocess_text, split_sentences
from modules.rule_based import rule_based
from modules.stt import convert_audio_to_text
from modules.summarizer import (
    build_summary_text,
    empty_analysis,
    normalize_analysis,
    summarize_analyses,
)

app = Flask(__name__)
app.config.update(
    SECRET_KEY=os.environ.get("FLASK_SECRET_KEY", os.environ.get("APP_SECRET_KEY", "supersecretkey")),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("FLASK_ENV") == "production",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
    MAX_CONTENT_LENGTH=25 * 1024 * 1024,
    SEND_FILE_MAX_AGE_DEFAULT=0,
    TEMPLATES_AUTO_RELOAD=True,
)
app.jinja_env.auto_reload = True
socketio = SocketIO(app, cors_allowed_origins="*", async_mode=os.environ.get("SOCKETIO_ASYNC_MODE", "eventlet"))

UPLOAD_FOLDER = "uploads"
LOG_FOLDER = "logs"
MEETING_CODE_LENGTH = 6
MEETING_CHAT_LIMIT = 120
AI_INSIGHT_LIMIT = 6
DEFAULT_PARTICIPANT_STATE = {
    "mic_on": True,
    "camera_on": True,
    "screen_sharing": False,
}

os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(LOG_FOLDER, exist_ok=True)

EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+$")
active_meetings = {}
socket_meetings = {}


def configure_logging():
    log_path = os.path.join(LOG_FOLDER, "voice_standup.log")
    absolute_log_path = os.path.abspath(log_path)

    if any(getattr(handler, "baseFilename", None) == absolute_log_path for handler in app.logger.handlers):
        return

    handler = RotatingFileHandler(log_path, maxBytes=512000, backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    handler.setLevel(logging.INFO)

    app.logger.setLevel(logging.INFO)
    app.logger.addHandler(handler)


configure_logging()


@app.after_request
def add_no_cache_headers(response):
    if request.path == "/dashboard" or request.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


def login_required(view_func):
    @wraps(view_func)
    def wrapped_view(*args, **kwargs):
        if "user" not in session:
            return redirect("/login")
        return view_func(*args, **kwargs)

    return wrapped_view


def set_message(message):
    session["ui_message"] = message


def pop_message():
    return session.pop("ui_message", None)


def format_timestamp(value):
    if not value:
        return ""
    return value.strftime("%Y-%m-%d %H:%M")


def relative_timestamp(value):
    if not value:
        return "Recently"

    if isinstance(value, str):
        try:
            value = datetime.strptime(value, "%Y-%m-%d %H:%M")
        except ValueError:
            return value or "Recently"

    delta = datetime.now() - value
    seconds = max(int(delta.total_seconds()), 0)

    if seconds < 60:
        return "Just now"

    minutes = seconds // 60
    if minutes < 60:
        suffix = "min" if minutes == 1 else "mins"
        return f"{minutes} {suffix} ago"

    hours = minutes // 60
    if hours < 24:
        suffix = "hour" if hours == 1 else "hours"
        return f"{hours} {suffix} ago"

    days = hours // 24
    if days == 1:
        return "Yesterday"
    if days < 7:
        return f"{days} days ago"

    return value.strftime("%b %d")


def iso_timestamp(value):
    if isinstance(value, datetime):
        return value.isoformat()
    return ""


def display_timestamp(value):
    if not isinstance(value, datetime):
        return ""
    return value.strftime("%I:%M %p").lstrip("0")


def participant_initials(name):
    parts = [part[:1] for part in (name or "Guest").split() if part]
    initials = "".join(parts[:2]).upper()
    return initials or "G"


def participant_avatar_color(name):
    palette = (
        "#6a7cff",
        "#ff6b8a",
        "#36b37e",
        "#ff9f43",
        "#7a5cff",
        "#4d96ff",
        "#8e7dff",
        "#ff7c7c",
    )
    index = sum(ord(char) for char in (name or "Guest")) % len(palette)
    return palette[index]


def to_bool(value, fallback=False):
    if isinstance(value, bool):
        return value
    if value is None:
        return fallback
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def validate_registration(name, email, password, confirm_password=""):
    if not name:
        return "Full name is required."
    if len(name) < 2:
        return "Name must be at least 2 characters long."
    if not email:
        return "Email is required."
    if not EMAIL_PATTERN.fullmatch(email):
        return "Email must contain @."
    if not password:
        return "Password is required."
    if len(password) < 6:
        return "Password must be at least 6 characters long."
    if password != confirm_password:
        return "Password and confirm password must match."
    return None


def export_rows_from_documents(documents):
    rows = []

    for document in documents:
        if document.get("results"):
            for participant in document.get("results", []):
                analysis = normalize_analysis(participant.get("analysis"))
                rows.append(
                    {
                        "meeting_id": document.get("legacy_meeting_id", "Legacy Meeting"),
                        "speaker": participant.get("user", "Unknown"),
                        "created_at": format_timestamp(document.get("created_at")),
                        "text": participant.get("text", ""),
                        "tasks": " | ".join(analysis["Task"]),
                        "plans": " | ".join(analysis["Plan"]),
                        "blockers": " | ".join(analysis["Blocker"]),
                    }
                )
            continue

        analysis = normalize_analysis(document.get("analysis"))
        rows.append(
            {
                "meeting_id": document.get("meeting_id") or "",
                "speaker": document.get("user", "Unknown"),
                "created_at": format_timestamp(document.get("created_at")),
                "text": document.get("text", ""),
                "tasks": " | ".join(analysis["Task"]),
                "plans": " | ".join(analysis["Plan"]),
                "blockers": " | ".join(analysis["Blocker"]),
            }
        )

    return rows


def generate_meeting_code():
    meeting_id = uuid.uuid4().hex.upper()
    return meeting_id


def smart_blocker(text):
    text = text.lower()
    patterns = [
        "blocked",
        "stuck",
        "issue",
        "problem",
        "error",
        "cannot proceed",
        "can't proceed",
        "waiting for",
        "dependency",
        "not able to",
        "delayed due to",
    ]
    return any(pattern in text for pattern in patterns)


def classify_sentence(sentence):
    cleaned_sentence = preprocess_text(sentence)
    if not cleaned_sentence:
        return "Task"

    dl_label = predict(cleaned_sentence)
    rb_label = rule_based(cleaned_sentence)

    if smart_blocker(cleaned_sentence) or rb_label == "Blocker":
        return "Blocker"
    if dl_label == "Plan" or rb_label == "Plan":
        return "Plan"
    return "Task"


def analyze_text(raw_text):
    analysis = empty_analysis()

    for sentence in split_sentences(raw_text):
        label = classify_sentence(sentence)
        analysis[label].append(sentence)

    return analysis


def count_analysis_items(analysis):
    normalized = normalize_analysis(analysis)
    return {
        "tasks": len(normalized["Task"]),
        "plans": len(normalized["Plan"]),
        "blockers": len(normalized["Blocker"]),
    }


def task_is_completed(task):
    if isinstance(task, dict):
        status = str(task.get("status") or "").strip().lower()
        return bool(task.get("completed")) or status in {"done", "completed", "finished", "closed", "resolved"}

    text = str(task or "").lower()
    return any(keyword in text for keyword in ("completed", "done", "finished", "fixed", "resolved"))


def meeting_document_id(meeting):
    return normalize_meeting_id(meeting.get("meeting_id") or meeting.get("code"))


def meeting_summary_analysis(meeting):
    summary = meeting.get("summary")
    if summary:
        return normalize_analysis(summary)

    return normalize_analysis(
        {
            "Task": meeting.get("tasks", []),
            "Plan": meeting.get("plans", []),
            "Blocker": meeting.get("blockers", []),
        }
    )


def meeting_detail_url(meeting_id):
    meeting_id = normalize_meeting_id(meeting_id)
    return f"/meeting/{quote(meeting_id)}/details" if meeting_id else "/search"


def dashboard_search_text(entry):
    parts = [
        entry.get("meeting_id", ""),
        entry.get("meeting_name", ""),
        entry.get("title", ""),
        entry.get("summary_text", ""),
        entry.get("user", ""),
        entry.get("text", ""),
    ]

    for participant in entry.get("participants", []):
        parts.extend([participant.get("user", ""), participant.get("text", ""), participant.get("summary_text", "")])

    for key in ("Task", "Plan", "Blocker"):
        parts.extend(entry.get("summary", entry.get("analysis", {})).get(key, []))

    return " ".join(str(part) for part in parts).lower()


def normalize_meeting_id(value):
    return (value or "").strip().upper()


def find_meeting_document(meeting_id):
    if not meeting_id:
        return None
    lower_id = meeting_id.lower()
    return db.meetings.find_one(
        {
            "$or": [
                {"code": meeting_id},
                {"meeting_id": meeting_id},
                {"code": lower_id},
                {"meeting_id": lower_id},
            ]
        }
    )


def meeting_display_name(meeting_id, fallback=None):
    meeting = find_meeting_document(meeting_id)
    if meeting and meeting.get("meeting_name"):
        return meeting["meeting_name"]
    return fallback or f"Meeting {meeting_id}"


def meeting_update_filter(meeting_id):
    meeting = find_meeting_document(meeting_id)
    if meeting:
        return {"_id": meeting["_id"]}
    return {"code": meeting_id}


def build_structured_summary(analysis):
    normalized = normalize_analysis(analysis)
    return {
        "highlights": normalized["Task"],
        "next_steps": normalized["Plan"],
        "blockers": normalized["Blocker"],
        "tasks": normalized["Task"],
        "plans": normalized["Plan"],
        "summary_text": build_summary_text(normalized),
        "Task": normalized["Task"],
        "Plan": normalized["Plan"],
        "Blocker": normalized["Blocker"],
    }


def dominant_label(analysis):
    normalized = normalize_analysis(analysis)
    for label in ("Blocker", "Plan", "Task"):
        if normalized[label]:
            return label
    return "Task"


def ensure_meeting_document(meeting_id, user=None, meeting_name=None):
    if not meeting_id:
        return

    now = datetime.now()
    meeting = find_meeting_document(meeting_id)
    add_to_set = {}

    if user:
        add_to_set = {"participants": user, "users": user}

    if meeting:
        update = {
            "$set": {
                "code": meeting.get("code") or meeting_id,
                "meeting_id": meeting.get("meeting_id") or meeting_id,
                "status": "active",
                "updated_at": now,
                "tasks": meeting.get("tasks", []),
                "plans": meeting.get("plans", []),
                "blockers": meeting.get("blockers", []),
            }
        }
        if user and not meeting.get("created_by"):
            update["$set"]["created_by"] = user
        if meeting_name:
            update["$set"]["meeting_name"] = meeting_name
        if add_to_set:
            update["$addToSet"] = add_to_set
        db.meetings.update_one({"_id": meeting["_id"]}, update)
        return

    empty_summary = build_structured_summary(empty_analysis())
    update = {
        "$setOnInsert": {
            "code": meeting_id,
            "meeting_id": meeting_id,
            "created_by": user,
            "participants": [user] if user else [],
            "users": [user] if user else [],
            "results": [],
            "summary": empty_summary,
            "tasks": empty_summary["tasks"],
            "plans": empty_summary["plans"],
            "blockers": empty_summary["blockers"],
            "chat_messages": [],
            "created_at": now,
        },
        "$set": {
            "status": "active",
            "updated_at": now,
        },
    }
    if meeting_name:
        update["$set"]["meeting_name"] = meeting_name
    db.meetings.update_one({"code": meeting_id}, update, upsert=True)


def meeting_host_name(meeting):
    if isinstance(meeting, str):
        meeting = find_meeting_document(meeting) or {}
    if not isinstance(meeting, dict):
        return ""
    return (
        meeting.get("created_by")
        or next(iter(meeting.get("users", []) or []), "")
        or next(iter(meeting.get("participants", []) or []), "")
    )


def current_live_socket_participants(meeting_id):
    meeting = find_meeting_document(meeting_id) or {}
    host_name = meeting_host_name(meeting)
    participants = []

    for sid, participant in active_meetings.get(meeting_id, {}).items():
        user = participant.get("user", "Guest")
        participants.append(
            {
                "sid": sid,
                "user": user,
                "initials": participant_initials(user),
                "avatar_color": participant_avatar_color(user),
                "joined_at": format_timestamp(participant.get("joined_at")),
                "joined_at_iso": iso_timestamp(participant.get("joined_at")),
                "host": user == host_name,
                "online": True,
                "mic_on": to_bool(participant.get("mic_on"), True),
                "camera_on": to_bool(participant.get("camera_on"), True),
                "screen_sharing": to_bool(participant.get("screen_sharing"), False),
            }
        )

    participants.sort(key=lambda item: (not item["host"], item["user"].lower()))
    return participants


def current_meeting_participants(meeting_id):
    meeting = find_meeting_document(meeting_id) or {}
    host_name = meeting_host_name(meeting)
    live_participants = current_live_socket_participants(meeting_id)
    by_user = {participant["user"]: participant for participant in live_participants}
    ordered_users = []

    for user in meeting.get("users", []) or meeting.get("participants", []) or []:
        if user and user not in ordered_users:
            ordered_users.append(user)

    for participant in live_participants:
        if participant["user"] not in ordered_users:
            ordered_users.append(participant["user"])

    participants = []
    for user in ordered_users:
        live_participant = by_user.get(user)
        if live_participant:
            participants.append(live_participant)
            continue

        participants.append(
            {
                "sid": "",
                "user": user,
                "initials": participant_initials(user),
                "avatar_color": participant_avatar_color(user),
                "joined_at": "",
                "joined_at_iso": "",
                "host": user == host_name,
                "online": False,
                "mic_on": False,
                "camera_on": False,
                "screen_sharing": False,
            }
        )

    participants.sort(key=lambda item: (not item["host"], not item["online"], item["user"].lower()))
    return participants


def meeting_online_count(meeting_id):
    return len({participant["user"] for participant in current_live_socket_participants(meeting_id)})


def serialize_chat_messages(messages):
    serialized = []
    for message in messages or []:
        timestamp = message.get("timestamp")
        if isinstance(timestamp, str):
            try:
                timestamp = datetime.fromisoformat(timestamp)
            except ValueError:
                timestamp = None

        user = message.get("user", "Guest")
        serialized.append(
            {
                "user": user,
                "text": message.get("text", ""),
                "time": message.get("time") or display_timestamp(timestamp),
                "timestamp": iso_timestamp(timestamp),
                "initials": participant_initials(user),
                "avatar_color": participant_avatar_color(user),
            }
        )

    return serialized[-MEETING_CHAT_LIMIT:]


def build_insight_items(submissions, label, limit=AI_INSIGHT_LIMIT):
    items = []
    seen = set()

    for submission in sorted(
        submissions,
        key=lambda item: item.get("created_at") or datetime.min,
        reverse=True,
    ):
        user = submission.get("user", "Unknown")
        created_at = submission.get("created_at")
        normalized = normalize_analysis(submission.get("analysis"))

        for text in normalized.get(label, []):
            dedupe_key = (user, text.strip().lower())
            if not text or dedupe_key in seen:
                continue

            items.append(
                {
                    "user": user,
                    "text": text,
                    "time": display_timestamp(created_at),
                    "timestamp": iso_timestamp(created_at),
                }
            )
            seen.add(dedupe_key)

            if len(items) >= limit:
                return items

    return items


def build_live_meeting_state(meeting_id, current_user=None):
    meeting_id = normalize_meeting_id(meeting_id)
    meeting = find_meeting_document(meeting_id) or {}
    submissions = list(db.standups.find({"meeting_id": meeting_id}).sort("created_at", -1))
    meeting_payload = build_meeting_payload(meeting_id, submissions)

    if not submissions:
        stored_summary = normalize_analysis(meeting.get("summary"))
        meeting_payload["summary"] = stored_summary
        meeting_payload["structured_summary"] = build_structured_summary(stored_summary)
        meeting_payload["summary_text"] = build_summary_text(stored_summary)
        meeting_payload["counts"] = count_analysis_items(stored_summary)
        meeting_payload["meeting_name"] = meeting.get("meeting_name") or meeting_payload["meeting_name"]
        meeting_payload["created_at"] = format_timestamp(meeting.get("created_at"))

    meeting_name = meeting.get("meeting_name") or meeting_payload.get("meeting_name") or meeting_display_name(meeting_id)
    host_name = meeting_host_name(meeting)
    participants = current_meeting_participants(meeting_id)
    live_sockets = current_live_socket_participants(meeting_id)
    chat_messages = serialize_chat_messages(meeting.get("chat_messages", []))
    latest_update = submissions[0].get("created_at") if submissions else meeting.get("updated_at") or meeting.get("created_at")

    meeting_state = {
        "meeting_id": meeting_id,
        "meeting_name": meeting_name,
        "status": meeting.get("status", "active"),
        "created_at": format_timestamp(meeting.get("created_at")),
        "created_at_iso": iso_timestamp(meeting.get("created_at")),
        "updated_at": format_timestamp(latest_update),
        "updated_at_iso": iso_timestamp(latest_update),
        "host": host_name,
        "is_host": bool(current_user and current_user == host_name),
        "participants": participants,
        "participant_count": len(participants),
        "online_count": len({participant["user"] for participant in live_sockets}),
        "live_participants": live_sockets,
        "chat_messages": chat_messages,
        "insights": {
            "blockers": build_insight_items(submissions, "Blocker"),
            "tasks": build_insight_items(submissions, "Task"),
            "plans": build_insight_items(submissions, "Plan"),
        },
        "summary": meeting_payload.get("structured_summary", build_structured_summary(empty_analysis())),
        "summary_text": meeting_payload.get("summary_text", ""),
        "counts": meeting_payload.get("counts", count_analysis_items(empty_analysis())),
        "updates": meeting_payload.get("updates", 0),
        "duration_minutes": meeting_payload.get("duration_minutes", 0),
        "segments": meeting_payload.get("segments", []),
        "share_path": f"/meeting/{quote(meeting_id)}",
    }

    return meeting_state


def emit_participants_update(meeting_id):
    meeting = find_meeting_document(meeting_id) or {}
    payload = {
        "meeting_id": meeting_id,
        "host": meeting_host_name(meeting),
        "participants": current_meeting_participants(meeting_id),
        "online_count": meeting_online_count(meeting_id),
        "status": meeting.get("status", "active"),
    }
    socketio.emit("participants_update", payload, room=meeting_id)
    return payload


def broadcast_dashboard_refresh():
    try:
        socketio.emit("dashboard_update", {}, broadcast=True)
    except Exception:
        app.logger.exception("Failed to broadcast dashboard refresh.")
    return True


def persist_analysis_result(
    user,
    email,
    raw_text,
    clean_text,
    analysis,
    meeting_id=None,
    source="recording",
    meeting_name=None,
):
    now = datetime.now()
    resolved_meeting_name = meeting_name or (meeting_display_name(meeting_id, "") if meeting_id else "")
    standup = {
        "user": user,
        "email": email,
        "text": raw_text,
        "clean_text": clean_text,
        "analysis": normalize_analysis(analysis),
        "meeting_id": meeting_id or None,
        "meeting_name": resolved_meeting_name or None,
        "source": source,
        "created_at": now,
    }

    db.standups.insert_one(standup)

    if not meeting_id:
        broadcast_dashboard_refresh()
        return standup, None

    ensure_meeting_document(meeting_id, user, resolved_meeting_name)
    submissions = list(db.standups.find({"meeting_id": meeting_id}).sort("created_at", -1))
    meeting_payload = build_meeting_payload(meeting_id, submissions)
    structured_summary = build_structured_summary(meeting_payload["summary"])
    meeting_payload["structured_summary"] = structured_summary

    result_entry = {
        "user": user,
        "text": raw_text,
        "clean_text": clean_text,
        "label": dominant_label(analysis),
        "analysis": normalize_analysis(analysis),
        "created_at": now,
        "meeting_name": resolved_meeting_name,
        "source": source,
    }

    stored_meeting = find_meeting_document(meeting_id) or {}
    meeting_status = "ended" if stored_meeting.get("status") == "ended" else "active"

    db.meetings.update_one(
        meeting_update_filter(meeting_id),
        {
            "$addToSet": {"participants": user, "users": user},
            "$push": {"results": result_entry},
            "$set": {
                "summary": structured_summary,
                "tasks": structured_summary["tasks"],
                "plans": structured_summary["plans"],
                "blockers": structured_summary["blockers"],
                "meeting_name": resolved_meeting_name or meeting_display_name(meeting_id),
                "status": meeting_status,
                "updated_at": now,
            },
        },
    )

    broadcast_dashboard_refresh()
    return standup, meeting_payload


def finalize_meeting_document(meeting_id):
    meeting_id = normalize_meeting_id(meeting_id)
    ensure_meeting_document(meeting_id)

    submissions = list(db.standups.find({"meeting_id": meeting_id}).sort("created_at", -1))
    meeting_payload = build_meeting_payload(meeting_id, submissions)
    structured_summary = build_structured_summary(meeting_payload["summary"])
    meeting_payload["structured_summary"] = structured_summary

    stored_meeting = find_meeting_document(meeting_id) or {}
    users = set(stored_meeting.get("users", []) or stored_meeting.get("participants", []) or [])
    users.update(submission.get("user") for submission in submissions if submission.get("user"))

    db.meetings.update_one(
        meeting_update_filter(meeting_id),
        {
            "$set": {
                "summary": structured_summary,
                "tasks": structured_summary["tasks"],
                "plans": structured_summary["plans"],
                "blockers": structured_summary["blockers"],
                "users": sorted(users),
                "participants": sorted(users),
                "status": "ended",
                "ended_at": datetime.now(),
                "updated_at": datetime.now(),
            }
        },
        upsert=True,
    )

    broadcast_dashboard_refresh()
    return meeting_payload


def save_socket_audio_chunk(audio_payload):
    if not audio_payload:
        raise ValueError("Audio chunk is required.")

    extension = "webm"

    if isinstance(audio_payload, (bytes, bytearray)):
        audio_bytes = bytes(audio_payload)
    else:
        payload_text = str(audio_payload)
        if payload_text.startswith("data:") and "," in payload_text:
            header, encoded_audio = payload_text.split(",", 1)
            if "wav" in header:
                extension = "wav"
            elif "ogg" in header:
                extension = "ogg"
            elif "mp4" in header:
                extension = "mp4"
        else:
            encoded_audio = payload_text

        audio_bytes = base64.b64decode(encoded_audio)

    if not audio_bytes:
        raise ValueError("Audio chunk is empty.")

    saved_path = os.path.join(UPLOAD_FOLDER, f"live-{uuid.uuid4()}.{extension}")
    with open(saved_path, "wb") as audio_file:
        audio_file.write(audio_bytes)

    return saved_path


def make_history_title(analysis, fallback):
    normalized = normalize_analysis(analysis)

    for key in ("Task", "Plan", "Blocker"):
        for item in normalized[key]:
            title = str(item).strip()
            if title:
                title = title[0].upper() + title[1:]
                return title[:48] + ("..." if len(title) > 48 else "")

    return fallback


def calculate_duration_minutes(timestamps, fallback_count=1):
    valid_timestamps = sorted(value for value in timestamps if value)

    if len(valid_timestamps) >= 2:
        seconds = (valid_timestamps[-1] - valid_timestamps[0]).total_seconds()
        return max(5, int(seconds // 60) + 1)

    return max(5, fallback_count * 5)


def create_participant_view(submission):
    normalized = normalize_analysis(submission.get("analysis"))
    return {
        "user": submission.get("user", "Unknown"),
        "speaker": submission.get("user", "Unknown"),
        "text": submission.get("text", ""),
        "analysis": normalized,
        "counts": count_analysis_items(normalized),
        "summary_text": build_summary_text(normalized),
        "created_at": format_timestamp(submission.get("created_at")),
        "created_at_raw": submission.get("created_at"),
    }


def build_meeting_payload(meeting_id, submissions):
    summary = summarize_analyses(submission.get("analysis") for submission in submissions)
    meeting_name = meeting_display_name(
        meeting_id,
        next((submission.get("meeting_name") for submission in submissions if submission.get("meeting_name")), None),
    )

    latest_by_user = {}
    ordered_submissions = sorted(
        submissions,
        key=lambda item: item.get("created_at") or datetime.min,
        reverse=True,
    )

    for submission in ordered_submissions:
        user = submission.get("user", "Unknown")
        if user not in latest_by_user:
            latest_by_user[user] = create_participant_view(submission)

    participants = sorted(
        latest_by_user.values(),
        key=lambda item: item["created_at_raw"] or datetime.min,
        reverse=True,
    )

    for participant in participants:
        participant.pop("created_at_raw", None)

    latest_created_at = ordered_submissions[0].get("created_at") if ordered_submissions else None
    duration_minutes = calculate_duration_minutes(
        (submission.get("created_at") for submission in submissions),
        fallback_count=max(len(participants), len(submissions), 1),
    )
    segments = [
        {
            "speaker": submission.get("user", "Unknown"),
            "text": submission.get("text", ""),
            "analysis": normalize_analysis(submission.get("analysis")),
            "counts": count_analysis_items(submission.get("analysis")),
            "summary_text": build_summary_text(submission.get("analysis")),
            "created_at": format_timestamp(submission.get("created_at")),
        }
        for submission in sorted(
            submissions,
            key=lambda item: item.get("created_at") or datetime.min,
        )
    ]

    return {
        "meeting_id": meeting_id,
        "meeting_name": meeting_name,
        "title": meeting_name,
        "participants": participants,
        "segments": segments,
        "summary": summary,
        "structured_summary": build_structured_summary(summary),
        "summary_text": build_summary_text(summary),
        "counts": count_analysis_items(summary),
        "updates": len(submissions),
        "duration_minutes": duration_minutes,
        "created_at": format_timestamp(latest_created_at),
    }


def iter_analyses(document):
    if document.get("analysis"):
        yield normalize_analysis(document.get("analysis"))

    for participant in document.get("results", []):
        yield normalize_analysis(participant.get("analysis"))


def build_history_entries(documents):
    entries = []
    grouped_meetings = {}

    for document in documents:
        meeting_id = document.get("meeting_id")

        if meeting_id:
            grouped_meetings.setdefault(meeting_id, []).append(document)
            continue

        if document.get("results"):
            participants = []
            segments = []
            for participant in document.get("results", []):
                analysis = normalize_analysis(participant.get("analysis"))
                participant_view = {
                    "user": participant.get("user", "Unknown"),
                    "speaker": participant.get("user", "Unknown"),
                    "text": participant.get("text", ""),
                    "analysis": analysis,
                    "counts": count_analysis_items(analysis),
                    "summary_text": build_summary_text(analysis),
                    "created_at": format_timestamp(document.get("created_at")),
                }
                participants.append(participant_view)
                segments.append(participant_view)

            summary = document.get("summary") or summarize_analyses(
                participant.get("analysis") for participant in document.get("results", [])
            )

            entries.append(
                {
                    "kind": "meeting",
                    "meeting_id": document.get("legacy_meeting_id", "Legacy Meeting"),
                    "meeting_name": document.get("meeting_name") or "Legacy meeting",
                    "title": document.get("meeting_name") or make_history_title(summary, "Legacy meeting"),
                    "participants": participants,
                    "segments": segments,
                    "summary": normalize_analysis(summary),
                    "summary_text": build_summary_text(summary),
                    "counts": count_analysis_items(summary),
                    "duration_minutes": calculate_duration_minutes(
                        [document.get("created_at")],
                        fallback_count=max(len(participants), 1),
                    ),
                    "created_at": format_timestamp(document.get("created_at")),
                    "sort_date": document.get("created_at") or datetime.min,
                }
            )
            continue

        analysis = normalize_analysis(document.get("analysis"))
        entries.append(
            {
                "kind": "single",
                "user": document.get("user", "Unknown"),
                "meeting_name": document.get("meeting_name") or "",
                "title": document.get("meeting_name") or make_history_title(analysis, f"{document.get('user', 'User')} standup"),
                "text": document.get("text", ""),
                "analysis": analysis,
                "summary_text": build_summary_text(analysis),
                "counts": count_analysis_items(analysis),
                "duration_minutes": 5,
                "created_at": format_timestamp(document.get("created_at")),
                "sort_date": document.get("created_at") or datetime.min,
            }
        )

    for meeting_id, submissions in grouped_meetings.items():
        payload = build_meeting_payload(meeting_id, submissions)
        entries.append(
            {
                "kind": "meeting",
                "meeting_id": payload["meeting_id"],
                "meeting_name": payload["meeting_name"],
                "title": payload["title"],
                "participants": payload["participants"],
                "segments": payload["segments"],
                "summary": payload["summary"],
                "summary_text": payload["summary_text"],
                "counts": payload["counts"],
                "duration_minutes": payload["duration_minutes"],
                "created_at": payload["created_at"],
                "sort_date": max(
                    (item.get("created_at") for item in submissions if item.get("created_at")),
                    default=datetime.min,
                ),
            }
        )

    existing_meeting_ids = {item.get("meeting_id") for item in entries if item.get("kind") == "meeting"}
    for meeting in db.meetings.find().sort("created_at", -1):
        meeting_id = meeting.get("meeting_id") or meeting.get("code")
        if not meeting_id or meeting_id in existing_meeting_ids:
            continue

        structured_summary = meeting.get("summary") or build_structured_summary(empty_analysis())
        entries.append(
            {
                "kind": "meeting",
                "meeting_id": meeting_id,
                "meeting_name": meeting.get("meeting_name") or f"Meeting {meeting_id}",
                "title": meeting.get("meeting_name") or f"Meeting {meeting_id}",
                "participants": [],
                "segments": [],
                "summary": structured_summary,
                "summary_text": structured_summary.get("summary_text", ""),
                "counts": count_analysis_items(structured_summary),
                "duration_minutes": 0,
                "created_at": format_timestamp(meeting.get("created_at")),
                "sort_date": meeting.get("created_at") or datetime.min,
            }
        )

    entries.sort(key=lambda item: item["sort_date"], reverse=True)

    for entry in entries:
        entry.pop("sort_date", None)

    return entries


@app.route("/")
def home():
    if "user" in session:
        return redirect("/dashboard")
    return redirect("/login")


@app.route("/register")
def register_page():
    return render_template("register.html", message=pop_message())


@app.route("/register", methods=["POST"])
def register():
    name = request.form.get("name", "").strip()
    email = request.form.get("email", "").strip().lower()
    password = request.form.get("password", "")
    confirm_password = request.form.get("confirm_password", "")

    validation_error = validate_registration(name, email, password, confirm_password)
    if validation_error:
        set_message(validation_error)
        return redirect("/register")

    if db.users.find_one({"email": email}):
        app.logger.warning("Registration rejected because email already exists: %s", email)
        set_message("User already exists. Please sign in.")
        return redirect("/register")

    hashed_password = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt())

    db.users.insert_one(
        {
            "name": name,
            "email": email,
            "password": hashed_password,
            "role": "member",
            "created_at": datetime.now(),
        }
    )

    app.logger.info("User registered successfully: %s", email)
    set_message("Registration successful. Please sign in.")
    return redirect("/login")


@app.route("/login")
def login_page():
    return render_template("login.html", message=pop_message())


@app.route("/login", methods=["POST"])
def login():
    email = request.form["email"].strip().lower()
    password = request.form["password"]

    user = db.users.find_one({"email": email})

    if user and bcrypt.checkpw(password.encode("utf-8"), user["password"]):
        session.permanent = True
        session["user"] = user["name"]
        session["email"] = user["email"]
        session["role"] = user.get("role", "member")
        app.logger.info("User logged in: %s", email)
        return redirect("/dashboard")

    app.logger.warning("Invalid login attempt for email: %s", email)
    set_message("Invalid email or password.")
    return redirect("/login")


@app.route("/dashboard")
@login_required
def dashboard():
    return render_template(
        "dashboard_v2.html",
        user=session["user"],
        active_meeting=session.get("meeting_id"),
        message=pop_message(),
    )


@app.route("/meeting/create", methods=["POST"])
@login_required
def create_meeting():
    meeting_id = generate_meeting_code()
    now = datetime.now()
    meeting_name = request.form.get("meeting_name", "").strip() or f"Meeting - {now.strftime('%d %b')}"
    structured_summary = build_structured_summary(empty_analysis())

    db.meetings.insert_one(
        {
            "code": meeting_id,
            "meeting_id": meeting_id,
            "meeting_name": meeting_name,
            "created_by": session["user"],
            "participants": [session["user"]],
            "users": [session["user"]],
            "results": [],
            "summary": structured_summary,
            "tasks": structured_summary["tasks"],
            "plans": structured_summary["plans"],
            "blockers": structured_summary["blockers"],
            "chat_messages": [],
            "status": "active",
            "created_at": now,
            "updated_at": now,
        }
    )

    session["meeting_id"] = meeting_id
    app.logger.info("Meeting created: %s by %s", meeting_id, session["user"])
    broadcast_dashboard_refresh()

    if request.headers.get("X-Requested-With") == "XMLHttpRequest" or request.accept_mimetypes["application/json"]:
        return jsonify(
            {
                "meeting_id": meeting_id,
                "meeting_name": meeting_name,
                "redirect": f"/meeting/{meeting_id}",
            }
        )

    set_message(f"Meeting {meeting_id} is ready.")
    return redirect(f"/meeting/{meeting_id}")


@app.route("/meeting/join", methods=["POST"])
@login_required
def join_meeting():
    meeting_code = request.form.get("meeting_code", "").strip().upper()

    if not meeting_code:
        set_message("Enter a meeting code to join.")
        return redirect("/dashboard")

    meeting = find_meeting_document(meeting_code)
    if not meeting:
        app.logger.warning("Meeting join failed for %s with code %s", session["user"], meeting_code)
        set_message("Meeting code not found.")
        return redirect("/dashboard")

    if meeting.get("status") == "ended":
        set_message("That meeting has already ended.")
        return redirect("/dashboard")

    db.meetings.update_one(
        {"_id": meeting["_id"]},
        {
            "$addToSet": {"participants": session["user"], "users": session["user"]},
            "$set": {"meeting_id": meeting_code, "status": "active", "updated_at": datetime.now()},
        },
    )

    session["meeting_id"] = meeting_code
    app.logger.info("Meeting joined: %s by %s", meeting_code, session["user"])
    broadcast_dashboard_refresh()
    set_message(f"Joined meeting {meeting_code}.")
    return redirect(f"/meeting/{meeting_code}")


@app.route("/meeting/<meeting_id>")
@login_required
def meeting(meeting_id):
    meeting_id = normalize_meeting_id(meeting_id)
    if not meeting_id:
        return redirect("/dashboard")

    meeting_document = find_meeting_document(meeting_id)
    if meeting_document and meeting_document.get("status") == "ended":
        set_message("That meeting has ended.")
        return redirect("/dashboard")

    ensure_meeting_document(meeting_id, session["user"])
    session["meeting_id"] = meeting_id
    return render_template(
        "live.html",
        meeting_id=meeting_id,
        meeting_name=meeting_display_name(meeting_id),
        meeting_host=meeting_host_name(meeting_document or meeting_id) or session["user"],
        active_meeting=meeting_id,
        active_page="meeting",
        user=session["user"],
        message=pop_message(),
    )


@app.route("/meeting/leave")
@login_required
def leave_meeting():
    meeting_code = session.pop("meeting_id", None)
    if meeting_code:
        app.logger.info("Meeting left: %s by %s", meeting_code, session["user"])
        broadcast_dashboard_refresh()
        set_message(f"Left meeting {meeting_code}.")
    return redirect("/dashboard")


@app.route("/record")
@login_required
def record_page():
    active_meeting = session.get("meeting_id")
    return render_template(
        "record_v2.html",
        user=session["user"],
        active_meeting=active_meeting,
        meeting_name=meeting_display_name(active_meeting, "") if active_meeting else "",
        message=pop_message(),
    )


@app.route("/meeting")
@login_required
def meeting_home():
    active_meeting = session.get("meeting_id")
    if active_meeting:
        return redirect(f"/meeting/{quote(active_meeting)}")
    return redirect("/record")


@app.route("/history")
@login_required
def history():
    return redirect("/search")


@app.route("/analytics")
@login_required
def analytics():
    return redirect("/dashboard#analytics")


@app.route("/settings")
@login_required
def settings():
    return redirect("/dashboard#settings")


@app.route("/profile")
@login_required
def profile():
    return redirect("/settings")


@app.route("/meeting/<meeting_id>/details")
@login_required
def meeting_details(meeting_id):
    meeting_id = normalize_meeting_id(meeting_id)
    if not meeting_id:
        return redirect("/search")
    return redirect(f"/search?q={quote(meeting_id)}")


@app.route("/export/history.csv")
@login_required
def export_history_csv():
    documents = list(db.standups.find().sort("created_at", -1))
    rows = export_rows_from_documents(documents)

    output = io.StringIO()
    writer = csv.DictWriter(
        output,
        fieldnames=["meeting_id", "speaker", "created_at", "text", "tasks", "plans", "blockers"],
    )
    writer.writeheader()
    writer.writerows(rows)

    app.logger.info("History CSV exported by %s", session["user"])
    return Response(
        output.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=voice-standup-history.csv"},
    )


@app.route("/export/meeting/<meeting_id>.json")
@login_required
def export_meeting_json(meeting_id):
    meeting_id = meeting_id.strip().upper()
    submissions = list(db.standups.find({"meeting_id": meeting_id}).sort("created_at", -1))

    if not submissions and not db.meetings.find_one({"code": meeting_id}):
        app.logger.warning("Meeting export failed because code was not found: %s", meeting_id)
        return jsonify({"error": "Meeting not found."}), 404

    payload = build_meeting_payload(meeting_id, submissions)
    app.logger.info("Meeting JSON exported by %s for %s", session["user"], meeting_id)

    response = jsonify(payload)
    response.headers["Content-Disposition"] = f"attachment; filename=meeting-{meeting_id}.json"
    return response


@app.route("/stats")
@login_required
def stats():
    updates = 0
    total_tasks = 0
    completed_tasks = 0
    blockers = 0
    recent_user_names = set()
    recent_cutoff = datetime.now() - timedelta(days=1)

    for document in db.standups.find({}, {"analysis": 1, "results": 1, "user": 1, "created_at": 1}):
        if isinstance(document.get("created_at"), datetime) and document["created_at"] >= recent_cutoff and document.get("user"):
            recent_user_names.add(document["user"])
        for analysis in iter_analyses(document):
            updates += 1
            total_tasks += len(analysis["Task"])
            completed_tasks += sum(1 for task in analysis["Task"] if task_is_completed(task))
            blockers += len(analysis["Blocker"])

    for meeting in db.meetings.find({}, {"users": 1, "participants": 1, "updated_at": 1, "tasks": 1, "summary": 1, "blockers": 1}):
        if isinstance(meeting.get("updated_at"), datetime) and meeting["updated_at"] >= recent_cutoff:
            recent_user_names.update(meeting.get("users", []) or meeting.get("participants", []))

        summary = meeting_summary_analysis(meeting)
        if not summary["Task"] and meeting.get("tasks"):
            total_tasks += len(meeting.get("tasks", []))
            completed_tasks += sum(1 for task in meeting.get("tasks", []) if task_is_completed(task))

    live_user_names = {
        participant.get("user")
        for meeting_participants in active_meetings.values()
        for participant in meeting_participants.values()
        if participant.get("user")
    }
    recent_user_names.update(live_user_names)

    return jsonify(
        {
            "updates": updates,
            "blockers": blockers,
            "tasks": completed_tasks or total_tasks,
            "tasks_completed": completed_tasks,
            "tasks_total": total_tasks,
            "meetings": db.meetings.count_documents({}),
            "users": len(recent_user_names) or db.users.count_documents({}),
            "registered_users": db.users.count_documents({}),
        }
    )


@app.route("/dashboard-insights")
@login_required
def dashboard_insights():
    entries = build_history_entries(list(db.standups.find().sort("created_at", -1)))

    recent_meetings = []
    blocker_highlights = []
    team_activity = []

    for entry in entries:
        is_meeting = entry.get("kind") == "meeting"
        meeting_id = normalize_meeting_id(entry.get("meeting_id"))
        title = entry.get("meeting_name") or entry.get("title") or (f"Meeting {meeting_id}" if is_meeting else f"{entry.get('user', 'User')} update")
        counts = entry.get("counts", {})
        analysis = entry.get("summary") if is_meeting else entry.get("analysis", {})

        if len(recent_meetings) < 5:
            recent_meetings.append(
                {
                    "meeting_id": meeting_id,
                    "meeting_name": entry.get("meeting_name", title),
                    "title": title,
                    "created_at": entry.get("created_at", ""),
                    "time": relative_timestamp(entry.get("created_at")),
                    "blockers": counts.get("blockers", 0),
                    "status": "blocker" if counts.get("blockers", 0) else "clear",
                    "summary": entry.get("summary_text", "No summary available."),
                    "kind": entry.get("kind", "single"),
                    "url": meeting_detail_url(meeting_id) if meeting_id else "/search",
                }
            )

        for blocker in normalize_analysis(analysis)["Blocker"]:
            if len(blocker_highlights) >= 5:
                break

            blocker_highlights.append(
                {
                    "text": blocker,
                    "source": title,
                    "meeting_id": meeting_id,
                    "url": meeting_detail_url(meeting_id) if meeting_id else "/search?blockers=with",
                    "created_at": entry.get("created_at", ""),
                    "time": relative_timestamp(entry.get("created_at")),
                    "severity": "high",
                }
            )

        segments = entry.get("segments", [])
        if not segments and entry.get("kind") == "single":
            segments = [
                {
                    "speaker": entry.get("user", "Unknown"),
                    "text": entry.get("text", ""),
                    "summary_text": entry.get("summary_text", ""),
                    "counts": entry.get("counts", {}),
                    "created_at": entry.get("created_at", ""),
                }
            ]

        for segment in reversed(segments):
            if len(team_activity) >= 5:
                break

            team_activity.append(
                {
                    "user": segment.get("speaker", segment.get("user", "Unknown")),
                    "action": "added blockers" if segment.get("counts", {}).get("blockers", 0) else "updated meeting",
                    "text": segment.get("text", ""),
                    "summary": segment.get("summary_text", "Updated standup summary."),
                    "created_at": segment.get("created_at", ""),
                    "time": relative_timestamp(segment.get("created_at") or entry.get("created_at")),
                    "blockers": segment.get("counts", {}).get("blockers", 0),
                    "meeting_id": meeting_id,
                    "url": meeting_detail_url(meeting_id) if meeting_id else "/search",
                }
            )

        if len(recent_meetings) >= 5 and len(blocker_highlights) >= 6 and len(team_activity) >= 5:
            break

    return jsonify(
        {
            "recent_meetings": recent_meetings,
            "blocker_highlights": blocker_highlights,
            "team_activity": team_activity,
            "active_meeting": session.get("meeting_id", ""),
        }
    )


@app.route("/chart-data")
@login_required
def chart_data():
    today = datetime.now().date()
    days = [today - timedelta(days=offset) for offset in range(13, -1, -1)]
    blocker_counts = {day.strftime("%Y-%m-%d"): 0 for day in days}
    start = datetime.combine(days[0], datetime.min.time())

    for document in db.standups.find({"created_at": {"$gte": start}}, {"created_at": 1, "analysis": 1, "results": 1}):
        created_at = document.get("created_at")
        if not created_at:
            continue

        label = created_at.strftime("%Y-%m-%d")
        if label not in blocker_counts:
            continue

        blockers = 0
        for analysis in iter_analyses(document):
            blockers += len(analysis["Blocker"])

        blocker_counts[label] = blocker_counts.get(label, 0) + blockers

    labels = [day.strftime("%a")[0] for day in days]
    values = [blocker_counts[day.strftime("%Y-%m-%d")] for day in days]

    return jsonify({"labels": labels, "values": values})


@app.route("/notifications")
@login_required
def notifications():
    insights_response = dashboard_insights().get_json()
    items = []

    for blocker in insights_response.get("blocker_highlights", [])[:5]:
        items.append(
            {
                "type": "blocker",
                "title": "New blocker",
                "message": blocker.get("text", "Blocker detected."),
                "time": blocker.get("time", "Recently"),
                "url": blocker.get("url", "/search?blockers=with"),
            }
        )

    for meeting in insights_response.get("recent_meetings", [])[:3]:
        items.append(
            {
                "type": "meeting",
                "title": "Meeting updated",
                "message": meeting.get("title", "Meeting activity"),
                "time": meeting.get("time", "Recently"),
                "url": meeting.get("url", "/search"),
            }
        )

    return jsonify({"notifications": items[:6], "unread": len(items)})


@app.route("/dashboard-search")
@login_required
def dashboard_search():
    query = request.args.get("q", "").strip().lower()
    entries = build_history_entries(list(db.standups.find().sort("created_at", -1)))
    results = []
    users = set()

    for entry in entries:
        for participant in entry.get("participants", []):
            if participant.get("user"):
                users.add(participant["user"])
        if entry.get("user"):
            users.add(entry["user"])

        if query and query not in dashboard_search_text(entry):
            continue

        meeting_id = normalize_meeting_id(entry.get("meeting_id"))
        results.append(
            {
                "title": entry.get("title") or entry.get("meeting_name") or f"Meeting {meeting_id}",
                "type": entry.get("kind", "meeting"),
                "created_at": entry.get("created_at", ""),
                "summary": entry.get("summary_text", ""),
                "blockers": entry.get("counts", {}).get("blockers", 0),
                "url": meeting_detail_url(meeting_id) if meeting_id else "/search",
            }
        )

        if len(results) >= 8:
            break

    return jsonify({"results": results, "users": sorted(users, key=str.lower)[:10]})


@app.route("/search")
@login_required
def search():
    search_text = request.args.get("q", "").strip().lower()
    selected_user = request.args.get("user", "").strip().lower()
    selected_date = request.args.get("date", "").strip()
    selected_date_range = request.args.get("date_range", "").strip().lower()
    blocker_filter = request.args.get("blockers", "").strip().lower()

    entries = build_history_entries(list(db.standups.find().sort("created_at", -1)))
    filtered_entries = []
    user_options = set()
    today = datetime.now().date()

    for entry in entries:
        users = []
        searchable_parts = [
            entry.get("meeting_id", ""),
            entry.get("meeting_name", ""),
            entry.get("title", ""),
            entry.get("summary_text", ""),
        ]

        if entry.get("kind") == "meeting":
            for participant in entry.get("participants", []):
                users.append(participant.get("user", "").lower())
                if participant.get("user"):
                    user_options.add(participant.get("user"))
                searchable_parts.extend(
                    [
                        participant.get("user", ""),
                        participant.get("text", ""),
                        participant.get("summary_text", ""),
                    ]
                )
        else:
            users.append(entry.get("user", "").lower())
            if entry.get("user"):
                user_options.add(entry.get("user"))
            searchable_parts.extend(
                [
                    entry.get("user", ""),
                    entry.get("text", ""),
                ]
            )

        for key in ("Task", "Plan", "Blocker"):
            searchable_parts.extend(entry.get("summary", entry.get("analysis", {})).get(key, []))

        searchable_text = " ".join(str(part) for part in searchable_parts).lower()
        entry_date = entry.get("created_at", "")[:10]
        blocker_count = entry.get("counts", {}).get("blockers", 0)
        try:
            entry_day = datetime.strptime(entry_date, "%Y-%m-%d").date() if entry_date else None
        except ValueError:
            entry_day = None

        matches_search = not search_text or search_text in searchable_text
        matches_user = not selected_user or selected_user in users
        matches_date = not selected_date or entry_date == selected_date
        if selected_date_range == "today":
            matches_date = entry_day == today
        elif selected_date_range == "week":
            matches_date = bool(entry_day and 0 <= (today - entry_day).days <= 7)
        elif selected_date_range == "month":
            matches_date = bool(entry_day and 0 <= (today - entry_day).days <= 30)
        matches_blockers = (
            not blocker_filter
            or (blocker_filter == "with" and blocker_count > 0)
            or (blocker_filter == "without" and blocker_count == 0)
        )

        if matches_search and matches_user and matches_date and matches_blockers:
            filtered_entries.append(entry)

    wants_json = (
        request.args.get("format") == "json"
        or request.headers.get("X-Requested-With") == "XMLHttpRequest"
    )

    if wants_json:
        return jsonify({"results": filtered_entries})

    return render_template(
        "search_v2.html",
        entries=filtered_entries,
        all_entries=entries,
        users=sorted(user_options, key=str.lower),
        user=session["user"],
        active_meeting=session.get("meeting_id"),
        query=request.args.get("q", "").strip(),
        selected_user=selected_user,
        selected_date_range=selected_date_range or "week",
        blocker_filter=blocker_filter,
    )


@app.route("/meeting-data")
@login_required
def meeting_data():
    meeting_id = request.args.get("meeting_id", "").strip().upper() or session.get("meeting_id")

    if not meeting_id:
        return jsonify(
            {
                "meeting_id": "",
                "meeting_name": "",
                "host": "",
                "status": "idle",
                "participants": [],
                "live_participants": [],
                "chat_messages": [],
                "insights": {"blockers": [], "tasks": [], "plans": []},
                "summary": empty_analysis(),
                "counts": count_analysis_items(empty_analysis()),
                "updates": 0,
                "created_at": "",
            }
        )

    return jsonify(build_live_meeting_state(meeting_id, session["user"]))


@app.route("/upload_audio", methods=["POST"])
@login_required
def upload_audio():
    audio = request.files.get("audio")
    if audio is None:
        return jsonify({"error": "Audio file is required."}), 400

    meeting_id = request.form.get("meeting_id", "").strip().upper() or session.get("meeting_id")
    upload_mode = request.form.get("mode", "final").strip().lower()
    saved_path = os.path.join(UPLOAD_FOLDER, f"{uuid.uuid4()}.webm")

    try:
        if meeting_id and not db.meetings.find_one({"code": meeting_id}):
            app.logger.warning("Upload rejected because meeting is not active: %s", meeting_id)
            return jsonify({"error": "Meeting code is not active."}), 404

        audio.save(saved_path)
        raw_text = convert_audio_to_text(saved_path)

        if raw_text in {"Speech not recognized", "Speech recognition service unavailable"}:
            if upload_mode == "live":
                return jsonify({"type": "empty", "message": raw_text})
            return jsonify({"error": raw_text}), 400

        cleaned_text = preprocess_text(raw_text)
        if not cleaned_text:
            if upload_mode == "live":
                return jsonify({"type": "empty", "message": "No clear speech detected yet."})
            return jsonify({"error": "No clear speech detected."}), 400

        analysis = analyze_text(cleaned_text)
        source = "live_chunk" if upload_mode == "live" else "recording"
        standup, meeting_payload = persist_analysis_result(
            session["user"],
            session.get("email"),
            raw_text,
            cleaned_text,
            analysis,
            meeting_id or None,
            source,
            request.form.get("meeting_name", "").strip() or None,
        )
        app.logger.info(
            "Standup stored for user=%s meeting=%s blockers=%s",
            session["user"],
            meeting_id or "solo",
            len(analysis["Blocker"]),
        )

        if meeting_id:
            return jsonify(
                {
                    "type": "meeting",
                    "meeting_id": meeting_id,
                    "meeting_name": meeting_payload.get("meeting_name", meeting_display_name(meeting_id)),
                    "user": session["user"],
                    "text": raw_text,
                    "clean_text": cleaned_text,
                    "source": source,
                    "label": dominant_label(analysis),
                    "analysis": analysis,
                    "summary": meeting_payload["summary"],
                    "structured_summary": meeting_payload["structured_summary"],
                    "summary_text": meeting_payload["summary_text"],
                    "participants": meeting_payload["participants"],
                    "segments": meeting_payload["segments"],
                    "counts": meeting_payload["counts"],
                }
            )

        return jsonify(
            {
                "type": "single",
                "user": session["user"],
                "text": raw_text,
                "clean_text": cleaned_text,
                "source": source,
                "label": dominant_label(analysis),
                "analysis": analysis,
                "structured_summary": build_structured_summary(analysis),
                "summary_text": build_summary_text(analysis),
                "counts": count_analysis_items(analysis),
            }
        )

    except Exception as exc:
        app.logger.exception("Audio upload failed for user=%s", session.get("user"))
        return jsonify({"error": str(exc)}), 500
    finally:
        if os.path.exists(saved_path):
            os.remove(saved_path)


@app.route("/save_note", methods=["POST"])
@login_required
def save_note():
    payload = request.get_json(silent=True) or {}
    note = payload.get("note", "").strip()
    meeting_id = payload.get("meeting_id", "").strip().upper() or session.get("meeting_id")

    if not note:
        return jsonify({"error": "Note text is required."}), 400

    db.meeting_notes.insert_one(
        {
            "meeting_id": meeting_id or None,
            "user": session["user"],
            "note": note,
            "created_at": datetime.now(),
        }
    )

    app.logger.info("Meeting note saved by %s for meeting=%s", session["user"], meeting_id or "solo")
    return jsonify({"message": "Note saved.", "note": note})


@app.route("/update_meeting_name", methods=["POST"])
@login_required
def update_meeting_name():
    payload = request.get_json(silent=True) or {}
    new_name = (payload.get("name") or "").strip()
    meeting_id = normalize_meeting_id(payload.get("meeting_id") or payload.get("code"))
    document_id = payload.get("id")

    if not new_name:
        return jsonify({"error": "Meeting name is required."}), 400

    if document_id:
        try:
            filter_query = {"_id": ObjectId(document_id)}
        except Exception:
            return jsonify({"error": "Invalid meeting id."}), 400
    elif meeting_id:
        filter_query = {"$or": [{"code": meeting_id}, {"meeting_id": meeting_id}]}
    else:
        return jsonify({"error": "Meeting id is required."}), 400

    db.meetings.update_one(filter_query, {"$set": {"meeting_name": new_name, "updated_at": datetime.now()}})
    if meeting_id:
        db.standups.update_many({"meeting_id": meeting_id}, {"$set": {"meeting_name": new_name}})

    return jsonify({"status": "updated", "meeting_name": new_name})


def remove_active_socket(sid, meeting_id=None):
    meeting_id = meeting_id or socket_meetings.pop(sid, None)
    if not meeting_id:
        return None, None

    socket_meetings.pop(sid, None)
    participant = active_meetings.get(meeting_id, {}).pop(sid, None)

    if meeting_id in active_meetings and not active_meetings[meeting_id]:
        active_meetings.pop(meeting_id, None)

    return meeting_id, participant


def compact_meeting_view(meeting_payload):
    return {
        "meeting_id": meeting_payload.get("meeting_id", ""),
        "meeting_name": meeting_payload.get("meeting_name", ""),
        "summary": meeting_payload.get("summary", empty_analysis()),
        "structured_summary": meeting_payload.get("structured_summary", build_structured_summary(empty_analysis())),
        "summary_text": meeting_payload.get("summary_text", ""),
        "participants": meeting_payload.get("participants", []),
        "counts": meeting_payload.get("counts", count_analysis_items(empty_analysis())),
        "updates": meeting_payload.get("updates", 0),
        "duration_minutes": meeting_payload.get("duration_minutes", 0),
        "created_at": meeting_payload.get("created_at", ""),
    }


def process_socket_audio_chunk(data, sid, user, email):
    """Socket.IO AI pipeline: decode live audio, run STT + NLP, persist, then broadcast insights."""
    meeting_id = normalize_meeting_id((data or {}).get("meeting_id"))
    meeting_name = (data or {}).get("meeting_name") or meeting_display_name(meeting_id, "")
    saved_path = None

    if not meeting_id:
        socketio.emit("ai_error", {"message": "Meeting ID is required for live AI."}, to=sid)
        return

    try:
        saved_path = save_socket_audio_chunk((data or {}).get("audio_chunk") or (data or {}).get("audio"))
        raw_text = convert_audio_to_text(saved_path)

        if raw_text in {"Speech not recognized", "Speech recognition service unavailable"}:
            socketio.emit("ai_status", {"type": "empty", "message": raw_text}, to=sid)
            return

        cleaned_text = preprocess_text(raw_text)
        if not cleaned_text:
            socketio.emit("ai_status", {"type": "empty", "message": "No clear speech detected yet."}, to=sid)
            return

        analysis = analyze_text(cleaned_text)
        _standup, meeting_payload = persist_analysis_result(
            user,
            email,
            raw_text,
            cleaned_text,
            analysis,
            meeting_id,
            "socket_live_chunk",
            meeting_name,
        )
        structured_summary = meeting_payload["structured_summary"]
        label = dominant_label(analysis)
        meeting_state = build_live_meeting_state(meeting_id, user)

        socketio.emit(
            "ai_update",
            {
                "meeting_id": meeting_id,
                "meeting_name": meeting_name,
                "user": user,
                "text": raw_text,
                "label": label,
                "analysis": normalize_analysis(analysis),
                "summary": structured_summary,
                "summary_text": structured_summary["summary_text"],
                "counts": count_analysis_items(meeting_payload["summary"]),
                "meeting": compact_meeting_view(meeting_payload),
                "insights": meeting_state["insights"],
                "updated_at": meeting_state["updated_at"],
                "updated_at_iso": meeting_state["updated_at_iso"],
            },
            room=meeting_id,
        )

        if analysis["Blocker"]:
            socketio.emit(
                "blocker_alert",
                {"meeting_id": meeting_id, "user": user, "blockers": analysis["Blocker"]},
                room=meeting_id,
            )

    except Exception as exc:
        app.logger.exception("Live audio processing failed for meeting=%s user=%s", meeting_id, user)
        socketio.emit("ai_error", {"message": str(exc)}, to=sid)
    finally:
        if saved_path and os.path.exists(saved_path):
            os.remove(saved_path)


@socketio.on("connect")
def socket_connected():
    emit("socket_ready", {"sid": request.sid})


@socketio.on("join_meeting")
def socket_join_meeting(data):
    """Socket.IO room join: each browser socket enters a meeting room and receives peer IDs."""
    payload = data or {}
    meeting_id = normalize_meeting_id(payload.get("meeting_id") or session.get("meeting_id"))
    user = (payload.get("user") or session.get("user") or "Guest").strip() or "Guest"
    sid = request.sid

    if not meeting_id:
        emit("meeting_error", {"message": "Meeting ID is required."})
        return

    meeting = find_meeting_document(meeting_id)
    if meeting and meeting.get("status") == "ended":
        emit("meeting_error", {"message": "This meeting has already ended."})
        return

    previous_meeting = socket_meetings.get(sid)
    if previous_meeting and previous_meeting != meeting_id:
        leave_room(previous_meeting)
        old_meeting, old_participant = remove_active_socket(sid, previous_meeting)
        if old_meeting and old_participant:
            socketio.emit(
                "user_left",
                {
                    "meeting_id": old_meeting,
                    "user": old_participant.get("user", "Guest"),
                    "sid": sid,
                    "participants": current_live_socket_participants(old_meeting),
                },
                room=old_meeting,
                skip_sid=sid,
            )
            emit_participants_update(old_meeting)

    join_room(meeting_id)
    ensure_meeting_document(meeting_id, user)
    active_meetings.setdefault(meeting_id, {})[sid] = {
        "user": user,
        "joined_at": datetime.now(),
        **DEFAULT_PARTICIPANT_STATE,
    }
    socket_meetings[sid] = meeting_id

    participants = current_live_socket_participants(meeting_id)
    peers = [participant for participant in participants if participant["sid"] != sid]
    meeting = find_meeting_document(meeting_id) or {}

    emit(
        "meeting_roster",
        {
            "meeting_id": meeting_id,
            "self": {"sid": sid, "user": user},
            "host": meeting_host_name(meeting),
            "status": meeting.get("status", "active"),
            "participants": participants,
            "peers": peers,
        },
    )
    emit(
        "user_joined",
        {"meeting_id": meeting_id, "user": user, "sid": sid, "participants": participants},
        room=meeting_id,
        include_self=False,
    )
    emit_participants_update(meeting_id)


@socketio.on("leave_meeting")
def socket_leave_meeting(data=None):
    meeting_id = normalize_meeting_id((data or {}).get("meeting_id")) or socket_meetings.get(request.sid)
    if meeting_id:
        leave_room(meeting_id)

    removed_meeting, participant = remove_active_socket(request.sid, meeting_id)
    if removed_meeting and participant:
        socketio.emit(
            "user_left",
            {
                "meeting_id": removed_meeting,
                "user": participant.get("user", "Guest"),
                "sid": request.sid,
                "participants": current_live_socket_participants(removed_meeting),
            },
            room=removed_meeting,
            skip_sid=request.sid,
        )
        emit_participants_update(removed_meeting)


@socketio.on("disconnect")
def socket_disconnected():
    removed_meeting, participant = remove_active_socket(request.sid)
    if removed_meeting and participant:
        socketio.emit(
            "user_left",
            {
                "meeting_id": removed_meeting,
                "user": participant.get("user", "Guest"),
                "sid": request.sid,
                "participants": current_live_socket_participants(removed_meeting),
            },
            room=removed_meeting,
            skip_sid=request.sid,
        )
        emit_participants_update(removed_meeting)


@socketio.on("signal")
def socket_signal(data):
    """WebRTC signaling relay: browsers exchange SimplePeer offers, answers, and ICE data here."""
    payload = data or {}
    meeting_id = normalize_meeting_id(payload.get("meeting_id") or socket_meetings.get(request.sid))
    signal = payload.get("signal")
    target_sid = payload.get("to")
    user = (payload.get("user") or session.get("user") or "Guest").strip() or "Guest"

    if not meeting_id or not signal:
        emit("meeting_error", {"message": "Invalid WebRTC signal."})
        return

    signal_payload = {"meeting_id": meeting_id, "from": request.sid, "user": user, "signal": signal}

    if target_sid:
        emit("signal", signal_payload, to=target_sid)
        return

    emit("signal", signal_payload, room=meeting_id, include_self=False)


@socketio.on("send_audio")
def socket_send_audio(data):
    """Receives 3-5 second MediaRecorder chunks for real-time STT and classification."""
    payload = data or {}
    user = (payload.get("user") or session.get("user") or "Guest").strip() or "Guest"
    email = session.get("email")
    socketio.start_background_task(process_socket_audio_chunk, payload, request.sid, user, email)
    emit("ai_status", {"type": "processing", "message": "Processing live audio..."})


@socketio.on("participant_state")
def socket_participant_state(data):
    payload = data or {}
    meeting_id = normalize_meeting_id(payload.get("meeting_id") or socket_meetings.get(request.sid))
    participant = active_meetings.get(meeting_id, {}).get(request.sid)

    if not meeting_id or participant is None:
        emit("meeting_error", {"message": "Participant state could not be updated."})
        return

    participant["mic_on"] = to_bool(payload.get("mic_on"), participant.get("mic_on", True))
    participant["camera_on"] = to_bool(payload.get("camera_on"), participant.get("camera_on", True))
    participant["screen_sharing"] = to_bool(payload.get("screen_sharing"), participant.get("screen_sharing", False))

    socketio.emit(
        "participant_state",
        {
            "meeting_id": meeting_id,
            "sid": request.sid,
            "user": participant.get("user", "Guest"),
            "mic_on": participant["mic_on"],
            "camera_on": participant["camera_on"],
            "screen_sharing": participant["screen_sharing"],
        },
        room=meeting_id,
    )
    emit_participants_update(meeting_id)


@socketio.on("chat_message")
def socket_chat_message(data):
    payload = data or {}
    meeting_id = normalize_meeting_id(payload.get("meeting_id") or socket_meetings.get(request.sid))
    user = (payload.get("user") or session.get("user") or "Guest").strip() or "Guest"
    text = (payload.get("text") or "").strip()

    if not meeting_id or not text:
        emit("meeting_error", {"message": "Meeting chat message is invalid."})
        return

    timestamp = datetime.now()
    chat_entry = {
        "user": user,
        "text": text[:1000],
        "time": display_timestamp(timestamp),
        "timestamp": timestamp,
    }

    db.meetings.update_one(
        meeting_update_filter(meeting_id),
        {
            "$push": {
                "chat_messages": {
                    "$each": [chat_entry],
                    "$slice": -MEETING_CHAT_LIMIT,
                }
            },
            "$set": {"updated_at": timestamp},
        },
        upsert=True,
    )

    emit(
        "chat_message",
        {
            "meeting_id": meeting_id,
            "user": user,
            "text": chat_entry["text"],
            "time": chat_entry["time"],
            "timestamp": iso_timestamp(timestamp),
            "initials": participant_initials(user),
            "avatar_color": participant_avatar_color(user),
        },
        room=meeting_id,
    )


@socketio.on("start_meeting")
def socket_start_meeting(data):
    payload = data or {}
    meeting_id = normalize_meeting_id(payload.get("meeting_id"))
    meeting_name = (payload.get("meeting_name") or "").strip()
    user = (payload.get("user") or session.get("user") or "Guest").strip() or "Guest"

    if not meeting_id or not meeting_name:
        emit("meeting_error", {"message": "Meeting name and ID are required."})
        return

    ensure_meeting_document(meeting_id, user, meeting_name)
    db.meetings.update_one(
        meeting_update_filter(meeting_id),
        {
            "$addToSet": {"participants": user, "users": user},
            "$set": {
                "meeting_name": meeting_name,
                "created_by": user,
                "status": "active",
                "updated_at": datetime.now(),
            },
            "$setOnInsert": {
                "code": meeting_id,
                "meeting_id": meeting_id,
                "results": [],
                "summary": build_structured_summary(empty_analysis()),
                "chat_messages": [],
                "created_at": datetime.now(),
            },
        },
        upsert=True,
    )
    emit("meeting_started", {"meeting_id": meeting_id, "meeting_name": meeting_name}, room=meeting_id)


@socketio.on("end_meeting")
def socket_end_meeting(data=None):
    meeting_id = normalize_meeting_id((data or {}).get("meeting_id")) or socket_meetings.get(request.sid)
    if not meeting_id:
        emit("meeting_error", {"message": "Meeting ID is required."})
        return

    meeting = find_meeting_document(meeting_id) or {}
    host_name = meeting_host_name(meeting)
    current_user = session.get("user") or "Guest"
    if host_name and current_user != host_name:
        emit("meeting_error", {"message": "Only the host can end the meeting."})
        return

    meeting_payload = finalize_meeting_document(meeting_id)
    meeting_state = build_live_meeting_state(meeting_id, current_user)
    socketio.emit(
        "meeting_ended",
        {
            "meeting_id": meeting_id,
            "meeting_name": meeting_payload.get("meeting_name", meeting_display_name(meeting_id)),
            "summary": meeting_payload["structured_summary"],
            "summary_text": meeting_payload["structured_summary"]["summary_text"],
            "counts": meeting_payload["counts"],
            "meeting": compact_meeting_view(meeting_payload),
            "insights": meeting_state["insights"],
            "redirect_url": "/dashboard",
        },
        room=meeting_id,
    )


@app.route("/logout")
def logout():
    session.clear()
    return redirect("/login")


@app.errorhandler(404)
def page_not_found(_error):
    return (
        render_template(
            "error_v2.html",
            title="Page Not Found",
            message="The page you requested could not be found.",
            user=session.get("user"),
            active_meeting=session.get("meeting_id"),
        ),
        404,
    )


@app.errorhandler(500)
def server_error(error):
    app.logger.exception("Unhandled server error: %s", error)
    return (
        render_template(
            "error_v2.html",
            title="Server Error",
            message="Something went wrong on the server. Please try again.",
            user=session.get("user"),
            active_meeting=session.get("meeting_id"),
        ),
        500,
    )


if __name__ == "__main__":
    socketio.run(app, debug=os.environ.get("FLASK_DEBUG", "1") == "1")
