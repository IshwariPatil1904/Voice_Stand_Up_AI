let mediaRecorder = null;
let audioChunks = [];
let refreshTimer = null;

const pageRoot = document.getElementById("record-page");
const meetingId = pageRoot ? pageRoot.dataset.meetingId : "";
const statusBox = document.getElementById("status");
const resultBox = document.getElementById("result");
const liveMeetingBox = document.getElementById("meeting-live");

function escapeHtml(value) {
    return (value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function renderList(items, emptyLabel) {
    if (!items || items.length === 0) {
        return `<li>${emptyLabel}</li>`;
    }

    return items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

function renderAnalysis(title, analysis) {
    return `
        <div class="analysis-grid">
            <div class="result-box">
                <h3>${title} Tasks</h3>
                <ul>${renderList(analysis.Task, "No tasks found.")}</ul>
            </div>
            <div class="result-box">
                <h3>${title} Plans</h3>
                <ul>${renderList(analysis.Plan, "No plans found.")}</ul>
            </div>
            <div class="result-box">
                <h3>${title} Blockers</h3>
                <ul>${renderList(analysis.Blocker, "No blockers found.")}</ul>
            </div>
        </div>
    `;
}

function renderUploadResult(payload) {
    const analysis = payload.analysis || { Task: [], Plan: [], Blocker: [] };
    const summaryText = payload.summary_text || "";

    let html = `
        <div class="result-card">
            <div class="card-head">
                <div>
                    <h2>Latest AI Analysis</h2>
                    <p class="muted-text">Submitted by ${escapeHtml(payload.user || "Current user")}</p>
                </div>
            </div>
            <div class="transcript-box">
                <h3>Recognized Text</h3>
                <p>${escapeHtml(payload.text || "")}</p>
            </div>
            ${summaryText ? `<div class="summary-banner">${escapeHtml(summaryText)}</div>` : ""}
            ${renderAnalysis("Your", analysis)}
    `;

    if (payload.type === "meeting" && payload.summary) {
        html += `
            <div class="result-card nested-card">
                <div class="card-head">
                    <div>
                        <h2>Live Meeting Summary</h2>
                        <p class="muted-text">Meeting ${escapeHtml(payload.meeting_id || "")}</p>
                    </div>
                </div>
                ${renderAnalysis("Meeting", payload.summary)}
            </div>
        `;
    }

    html += "</div>";
    resultBox.innerHTML = html;
}

function renderLiveMeeting(payload) {
    if (!meetingId || !liveMeetingBox) {
        return;
    }

    const participants = payload.participants || [];
    const summary = payload.summary || { Task: [], Plan: [], Blocker: [] };
    const summaryText = payload.summary_text || "";

    let html = `
        <div class="surface-card">
            <div class="card-head">
                <div>
                    <h2>Real-Time Meeting Analysis</h2>
                    <p class="muted-text">This board refreshes automatically while the meeting is active.</p>
                </div>
                <span class="badge">${participants.length} participant(s)</span>
            </div>
            ${summaryText ? `<div class="summary-banner">${escapeHtml(summaryText)}</div>` : ""}
            ${renderAnalysis("Team", summary)}
            <div class="participants-grid">
    `;

    if (participants.length === 0) {
        html += `
            <div class="result-box">
                <h3>Waiting for submissions</h3>
                <p>Ask team members to record their updates to see blockers instantly.</p>
            </div>
        `;
    } else {
        participants.forEach((participant) => {
            html += `
                <div class="result-box">
                    <h3>${escapeHtml(participant.user)}</h3>
                    <p class="muted-text">${escapeHtml(participant.created_at || "Recently updated")}</p>
                    <p>${escapeHtml(participant.text || "")}</p>
                    <div class="mini-stats">
                        <span class="mini-pill">Tasks: ${participant.counts.tasks}</span>
                        <span class="mini-pill">Plans: ${participant.counts.plans}</span>
                        <span class="mini-pill alert">Blockers: ${participant.counts.blockers}</span>
                    </div>
                </div>
            `;
        });
    }

    html += `
            </div>
        </div>
    `;

    liveMeetingBox.innerHTML = html;
}

async function loadMeetingData() {
    if (!meetingId) {
        return;
    }

    try {
        const response = await fetch(`/meeting-data?meeting_id=${encodeURIComponent(meetingId)}`);
        const payload = await response.json();
        renderLiveMeeting(payload);
    } catch (error) {
        liveMeetingBox.innerHTML = `
            <div class="surface-card">
                <h2>Real-Time Meeting Analysis</h2>
                <p class="error-text">Unable to refresh meeting data right now.</p>
            </div>
        `;
    }
}

async function startRecording() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];

        mediaRecorder.ondataavailable = (event) => {
            audioChunks.push(event.data);
        };

        mediaRecorder.start();
        statusBox.innerHTML = `<p class="status ok">Recording in progress...</p>`;
    } catch (error) {
        statusBox.innerHTML = `<p class="status error">Microphone permission was denied.</p>`;
    }
}

function stopRecording() {
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
        statusBox.innerHTML = `<p class="status error">Start recording before stopping.</p>`;
        return;
    }

    mediaRecorder.stop();

    mediaRecorder.onstop = async () => {
        statusBox.innerHTML = `<p class="status loading">Analyzing audio with AI...</p>`;

        const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
        const formData = new FormData();
        formData.append("audio", audioBlob, "meeting-audio.webm");

        if (meetingId) {
            formData.append("meeting_id", meetingId);
        }

        try {
            const response = await fetch("/upload_audio", {
                method: "POST",
                body: formData,
            });

            const payload = await response.json();

            if (!response.ok || payload.error) {
                statusBox.innerHTML = `<p class="status error">${escapeHtml(payload.error || "Upload failed.")}</p>`;
                return;
            }

            statusBox.innerHTML = `<p class="status ok">Analysis complete.</p>`;
            renderUploadResult(payload);
            await loadMeetingData();
        } catch (error) {
            statusBox.innerHTML = `<p class="status error">Unable to reach the server.</p>`;
        } finally {
            audioChunks = [];
        }
    };
}

window.startRecording = startRecording;
window.stopRecording = stopRecording;

if (meetingId) {
    loadMeetingData();
    refreshTimer = window.setInterval(loadMeetingData, 5000);
}
