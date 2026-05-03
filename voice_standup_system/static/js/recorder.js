let socket = null;
let currentSid = "";
let localStream = null;
let audioRecorder = null;
let audioChunks = [];
let timerInterval = null;
let recordingStartedAt = null;
let meetingActive = false;
let meetingJoined = false;
let isMuted = false;
let isCameraOff = false;
let isScreenSharing = false;
let cameraVideoTrack = null;
let lastBlockerCount = 0;
let quickNotes = [];
let chatMessages = [];
let activeSpeakerTimer = null;
let pendingEndMeeting = false;
let meetingEndFallbackTimer = null;

const peers = new Map();
const participants = new Map();
const LIVE_CHUNK_MS = 5000;

const pageRoot = document.getElementById("record-page");
const meetingId = pageRoot ? pageRoot.dataset.meetingId : "";
const currentUser = pageRoot ? pageRoot.dataset.user || "Guest" : "Guest";
let activeMeetingName = pageRoot ? pageRoot.dataset.meetingName || "" : "";
const statusBox = document.getElementById("status");
const recIndicator = document.getElementById("rec-indicator");
const meetingTimer = document.getElementById("meeting-timer");
const videoTimer = document.getElementById("video-timer");
const micStatus = document.getElementById("mic-status");
const videoRecPill = document.getElementById("video-rec-pill");
const startButton = document.getElementById("start-btn");
const stopButton = document.getElementById("stop-btn");
const leaveButton = document.getElementById("leave-btn");
const mainRecordButton = document.getElementById("main-record-btn");
const muteButton = document.getElementById("mute-btn");
const cameraButton = document.getElementById("camera-btn");
const recordingStatusText = document.getElementById("recording-status-text");
const recordingStatusDot = document.getElementById("recording-status-dot");
const liveAlert = document.getElementById("live-alert");
const summaryList = document.getElementById("live-summary-list");
const blockerList = document.getElementById("blocker-detection-list");
const suggestionList = document.getElementById("suggestion-list");
const taskList = document.getElementById("task-list");
const planList = document.getElementById("plan-list");
const participantList = document.getElementById("participants-row");
const participantCount = document.getElementById("participant-count");
const topParticipantCount = document.getElementById("top-participant-count");
const quickNoteList = document.getElementById("quick-note-list");
const noteInput = document.getElementById("note-input");
const chatList = document.getElementById("chat-list");
const chatInput = document.getElementById("chat-input");
const screenButton = document.getElementById("screen-btn");
const localVideo = document.getElementById("localVideo");
const localPlaceholder = document.getElementById("local-placeholder");
const videoGrid = document.getElementById("videoContainer") || document.getElementById("video-grid");
const connectionStatus = document.getElementById("connection-status");
const aiStateLabel = document.getElementById("ai-state-label");
const meetingNameInput = document.getElementById("meetingName");
const summaryClock = document.getElementById("summary-clock");
const blockerCountPill = document.getElementById("blocker-count-pill");
const taskCountPill = document.getElementById("task-count-pill");
const planCountPill = document.getElementById("plan-count-pill");

function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function uniqueItems(items) {
    return [...new Set((items || []).filter(Boolean))];
}

function normalizeAnalysis(analysis) {
    return {
        Task: analysis && Array.isArray(analysis.Task) ? analysis.Task : [],
        Plan: analysis && Array.isArray(analysis.Plan) ? analysis.Plan : [],
        Blocker: analysis && Array.isArray(analysis.Blocker) ? analysis.Blocker : [],
    };
}

function normalizeStructuredSummary(summary, fallbackAnalysis = {}) {
    const fallback = normalizeAnalysis(fallbackAnalysis);
    const value = summary || {};

    return {
        highlights: uniqueItems(value.highlights || value.tasks || value.Task || fallback.Task),
        next_steps: uniqueItems(value.next_steps || value.plans || value.Plan || fallback.Plan),
        blockers: uniqueItems(value.blockers || value.Blocker || fallback.Blocker),
        tasks: uniqueItems(value.tasks || value.Task || fallback.Task),
        plans: uniqueItems(value.plans || value.Plan || fallback.Plan),
        summary_text: value.summary_text || "",
    };
}

function setStatus(message, state = "ok") {
    if (!statusBox) {
        return;
    }

    statusBox.innerHTML = `<p class="status ${state}">${escapeHtml(message)}</p>`;
}

function setAiState(label, items = []) {
    if (aiStateLabel) {
        aiStateLabel.textContent = label;
    }

    renderPanelList(suggestionList, items, "Waiting for meeting audio.");
}

function setConnectionStatus(message) {
    if (connectionStatus) {
        connectionStatus.textContent = message;
    }
}

function participantKey(participant, fallbackUser = "") {
    const sid = participant && participant.sid ? String(participant.sid) : "";
    if (sid) {
        return sid;
    }

    const user = participant && participant.user ? participant.user : fallbackUser;
    return `user:${String(user || "guest").trim().toLowerCase()}`;
}

function upsertParticipant(participant) {
    if (!participant) {
        return;
    }

    Array.from(participants.entries()).forEach(([key, value]) => {
        if (
            (participant.sid && value.sid && value.sid === participant.sid)
            || (
                participant.user
                && value.user
                && String(value.user).trim().toLowerCase() === String(participant.user).trim().toLowerCase()
            )
        ) {
            participants.delete(key);
        }
    });

    participants.set(participantKey(participant, participant.user), participant);
}

function getParticipantByIdentity(sid, user) {
    if (sid && participants.has(String(sid))) {
        return participants.get(String(sid));
    }

    if (!user) {
        return null;
    }

    return participants.get(`user:${String(user).trim().toLowerCase()}`) || null;
}

function updateVideoGridLayout() {
    if (!videoGrid) {
        return;
    }

    const tileCount = Math.max(videoGrid.querySelectorAll(".video-tile").length, 1);
    videoGrid.dataset.count = String(tileCount);
}

function setMeetingStage(stage) {
    const nextStage = ["ready", "recording", "active"].includes(stage) ? stage : "ready";
    const stageLabels = {
        ready: "Ready",
        recording: "Recording",
        active: "Active",
    };

    if (recIndicator) {
        recIndicator.dataset.stage = nextStage;
        recIndicator.classList.toggle("idle", nextStage === "ready");
        recIndicator.classList.toggle("recording", nextStage === "recording");
        recIndicator.classList.toggle("active", nextStage === "active");
        const label = recIndicator.querySelector(".rec-pill-label");
        if (label) {
            label.textContent = stageLabels[nextStage];
        }
    }

    if (startButton) {
        startButton.dataset.stage = nextStage;
        startButton.textContent = nextStage === "ready"
            ? "Start Meeting"
            : nextStage === "recording"
                ? "Starting..."
                : "Meeting Active";
    }

    if (mainRecordButton) {
        mainRecordButton.dataset.stage = nextStage;
        mainRecordButton.textContent = nextStage === "ready" ? "Start" : "End";
    }
}

function setMeetingActionButtons(isStarted) {
    if (startButton) {
        startButton.hidden = isStarted;
        startButton.setAttribute("aria-hidden", String(isStarted));
    }

    if (leaveButton) {
        leaveButton.hidden = !isStarted;
        leaveButton.setAttribute("aria-hidden", String(!isStarted));
    }
}

function micIconMarkup(enabled) {
    return enabled
        ? '<svg viewBox="0 0 24 24"><path d="M12 4v8m-4 0a4 4 0 0 0 8 0V6a4 4 0 0 0-8 0v6m-2 0a6 6 0 0 0 12 0M12 18v3"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M12 4v8m-4 0a4 4 0 0 0 8 0V6a4 4 0 0 0-8 0v6M4 4l16 16"/></svg>';
}

function updateTileStatusElement(tile, micEnabled) {
    const status = tile ? tile.querySelector(".tile-status") : null;
    if (!status) {
        return;
    }

    status.classList.toggle("mic-on", micEnabled);
    status.classList.toggle("mic-off", !micEnabled);
    status.innerHTML = micIconMarkup(micEnabled);
}

function updateVideoTileStates() {
    const localCard = document.getElementById("localCard");
    const localVideoVisible = Boolean(localStream && (!isCameraOff || isScreenSharing));

    if (localCard) {
        localCard.dataset.user = String(currentUser || "guest").trim().toLowerCase();
        localCard.classList.toggle("camera-live", localVideoVisible);
        localCard.classList.toggle("video-hidden", !localVideoVisible);
        updateTileStatusElement(localCard, !isMuted);
    }

    if (localPlaceholder) {
        localPlaceholder.classList.toggle("visible", !localVideoVisible);
    }

    Array.from(participants.values()).forEach((participant) => {
        if (!participant.sid || participant.user === currentUser) {
            return;
        }

        const tile = document.getElementById(`remote-${participant.sid}`);
        if (!tile) {
            return;
        }

        const videoVisible = Boolean(participant.screen_sharing || participant.camera_on);
        const placeholder = tile.querySelector(".video-placeholder");
        const label = tile.querySelector(".user-label");

        tile.dataset.user = String(participant.user || participant.sid).trim().toLowerCase();
        tile.classList.toggle("camera-live", videoVisible);
        tile.classList.toggle("video-hidden", !videoVisible);

        if (placeholder) {
            placeholder.classList.toggle("visible", !videoVisible);
        }

        if (label && participant.user) {
            label.innerText = participant.user;
        }

        updateTileStatusElement(tile, participant.mic_on !== false);
    });

    updateVideoGridLayout();
}

function highlightSpeaker(user) {
    if (!videoGrid || !user) {
        return;
    }

    const normalizedUser = String(user).trim().toLowerCase();
    Array.from(videoGrid.querySelectorAll(".video-tile")).forEach((tile) => {
        tile.classList.toggle("active-speaker", tile.dataset.user === normalizedUser);
    });

    window.clearTimeout(activeSpeakerTimer);
    activeSpeakerTimer = window.setTimeout(() => {
        Array.from(videoGrid.querySelectorAll(".video-tile")).forEach((tile) => {
            tile.classList.remove("active-speaker");
        });
    }, 2400);
}

function emitParticipantState() {
    if (!meetingId || !socket || !socket.connected) {
        return;
    }

    socket.emit("participant_state", {
        meeting_id: meetingId,
        mic_on: !isMuted,
        camera_on: !isCameraOff,
        screen_sharing: isScreenSharing,
    });
}

function renderPanelList(element, items, emptyLabel, className = "") {
    if (!element) {
        return;
    }

    const cleanItems = uniqueItems(items);
    if (cleanItems.length === 0) {
        element.innerHTML = `<li>${escapeHtml(emptyLabel)}</li>`;
        return;
    }

    element.innerHTML = cleanItems
        .slice(-8)
        .map((item) => `<li class="${className}">${escapeHtml(item)}</li>`)
        .join("");
}

function setCount(element, count) {
    if (element) {
        element.textContent = String(count);
    }
}

function buildSuggestions(blockers, plans) {
    if (blockers.length > 0) {
        return [
            `Escalate: ${blockers[blockers.length - 1]}`,
            "Assign an owner",
            "Review dependency path",
        ];
    }

    if (plans.length > 0) {
        return ["Track next step owners", "Confirm follow-up timing"];
    }

    return ["Listening for updates"];
}

function showBlockerAlert(blockers) {
    if (!liveAlert || !blockers || blockers.length === 0) {
        return;
    }

    liveAlert.textContent = `Blocker detected: ${blockers[blockers.length - 1]}`;
    liveAlert.hidden = false;
    window.setTimeout(() => {
        liveAlert.hidden = true;
    }, 3600);
}

function renderInsights(structuredSummary, analysis) {
    const normalized = normalizeAnalysis(analysis);
    const structured = normalizeStructuredSummary(structuredSummary, normalized);
    const summaryItems = uniqueItems([
        structured.summary_text,
        ...structured.highlights,
        ...structured.next_steps,
    ]);
    const blockers = uniqueItems(structured.blockers.length ? structured.blockers : normalized.Blocker);
    const tasks = uniqueItems(structured.tasks.length ? structured.tasks : normalized.Task);
    const plans = uniqueItems(structured.plans.length ? structured.plans : normalized.Plan);

    renderPanelList(summaryList, summaryItems, "No summary yet.");
    renderPanelList(blockerList, blockers, "No blockers detected.", "danger-item");
    renderPanelList(taskList, tasks, "None yet.");
    renderPanelList(planList, plans, "None yet.");
    setCount(blockerCountPill, blockers.length);
    setCount(taskCountPill, tasks.length);
    setCount(planCountPill, plans.length);
    setAiState(blockers.length ? "Blocker found" : "Live", buildSuggestions(blockers, plans));

    if (blockers.length > lastBlockerCount) {
        showBlockerAlert(blockers);
    }
    lastBlockerCount = blockers.length;
}

function updateInsightsFromPayload(payload) {
    const meeting = payload.meeting || {};
    const analysis = normalizeAnalysis(meeting.summary || payload.analysis);
    const structuredSummary = meeting.structured_summary || payload.structured_summary || payload.summary;
    const counts = meeting.counts || {};
    const hasInsightData = Boolean(
        (structuredSummary && structuredSummary.summary_text)
        || analysis.Task.length
        || analysis.Plan.length
        || analysis.Blocker.length
        || counts.tasks
        || counts.plans
        || counts.blockers
    );

    if (hasInsightData) {
        renderInsights(structuredSummary, analysis);
    }

    if (meeting.participants && meeting.participants.length > 0) {
        renderStoredParticipants(meeting.participants);
    }
}

function formatDuration(totalSeconds) {
    const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;
}

function updateTimer() {
    if (!recordingStartedAt) {
        return;
    }

    const elapsedSeconds = Math.floor((Date.now() - recordingStartedAt) / 1000);
    const value = formatDuration(elapsedSeconds);

    if (meetingTimer) {
        meetingTimer.textContent = value;
    }
    if (videoTimer) {
        videoTimer.textContent = value;
    }
    if (summaryClock) {
        summaryClock.textContent = value;
    }
}

function startTimer() {
    stopTimer();
    recordingStartedAt = Date.now();
    updateTimer();
    timerInterval = window.setInterval(updateTimer, 1000);
}

function stopTimer() {
    if (timerInterval) {
        window.clearInterval(timerInterval);
        timerInterval = null;
    }
    recordingStartedAt = null;
}

function setRecordingUi(isRecording, label) {
    const stage = isRecording ? "active" : "ready";
    setMeetingStage(stage);
    setMeetingActionButtons(isRecording);

    if (videoRecPill) {
        videoRecPill.classList.toggle("hidden", !isRecording);
    }

    if (recordingStatusText) {
        recordingStatusText.textContent = label || (isRecording ? "Live" : "Waiting...");
    }

    if (recordingStatusDot) {
        recordingStatusDot.classList.toggle("active", isRecording);
    }

    if (startButton) {
        startButton.disabled = isRecording;
    }

    if (stopButton) {
        stopButton.disabled = !isRecording;
    }

    if (mainRecordButton) {
        mainRecordButton.textContent = isRecording ? "End" : "Start";
    }

    updateMicLabel();
    updateCameraLabel();
    updateVideoTileStates();
}

function updateMicLabel() {
    if (micStatus) {
        micStatus.textContent = meetingActive ? (isMuted ? "Muted" : "Mic active") : "Mic standby";
        micStatus.classList.toggle("active", meetingActive && !isMuted);
    }

    if (muteButton) {
        muteButton.innerHTML = `${isMuted
            ? '<svg viewBox="0 0 24 24"><path d="M12 4v8m-4 0a4 4 0 0 0 8 0V6a4 4 0 0 0-8 0v6M4 4l16 16"/></svg>Unmute'
            : '<svg viewBox="0 0 24 24"><path d="M12 4v8m-4 0a4 4 0 0 0 8 0V6a4 4 0 0 0-8 0v6m-2 0a6 6 0 0 0 12 0M12 18v3"/></svg>Mute'}`;
        muteButton.setAttribute("aria-pressed", String(isMuted));
    }

    renderParticipants();
}

function updateCameraLabel() {
    if (cameraButton) {
        cameraButton.innerHTML = `${isCameraOff
            ? '<svg viewBox="0 0 24 24"><path d="M4 7h11v10H4zM15 11l5-3v8l-5-3zM3 3l18 18"/></svg>Start Video'
            : '<svg viewBox="0 0 24 24"><path d="M4 7h11v10H4zM15 11l5-3v8l-5-3z"/></svg>Stop Video'}`;
        cameraButton.setAttribute("aria-pressed", String(isCameraOff));
    }

    if (localPlaceholder) {
        localPlaceholder.classList.toggle("visible", isCameraOff || !localStream);
    }

    const localCard = document.getElementById("localCard");
    if (localCard) {
        localCard.classList.toggle("camera-live", Boolean(localStream && !isCameraOff));
    }

    renderParticipants();
}

function renderParticipants() {
    if (!participantList) {
        return;
    }

    let roster = Array.from(participants.values());
    if (roster.length === 0) {
        roster = [{ sid: currentSid || "local", user: currentUser, host: true }];
    }

    participantList.innerHTML = roster
        .map((participant) => {
            const user = participant.user || "Guest";
            const activeClass = participant.sid === currentSid || user === currentUser ? " active" : "";
            const hostLabel = user === currentUser || participant.host ? "<small>Host</small>" : "";
            const mutedClass = participant.mic_on === false || (isMuted && user === currentUser) ? "off" : "";
            const cameraClass = participant.camera_on === false || (isCameraOff && user === currentUser) ? "off" : "";
            return `
                <div class="participant-chip${activeClass}">
                    <span>${escapeHtml(user.slice(0, 1).toUpperCase())}</span>
                    <strong>${escapeHtml(user)}${user === currentUser ? " (You)" : ""}</strong>
                    ${hostLabel}
                    <em class="${mutedClass}">mic</em>
                    <em class="${cameraClass}">cam</em>
                </div>
            `;
        })
        .join("");

    const displayedCount = roster.length;
    if (participantCount) {
        participantCount.textContent = String(displayedCount);
    }
    if (topParticipantCount) {
        topParticipantCount.textContent = String(displayedCount);
    }
}

function renderStoredParticipants(storedParticipants) {
    if (participants.size > 0 || !Array.isArray(storedParticipants)) {
        renderParticipants();
        return;
    }

    storedParticipants.forEach((participant, index) => {
        const user = participant && typeof participant === "object"
            ? participant.user || participant.speaker || "Guest"
            : String(participant || "Guest");
        upsertParticipant({ sid: `stored-${index}`, user });
    });
    renderParticipants();
}

function syncParticipants(roster) {
    participants.clear();
    (roster || []).forEach((participant) => {
        upsertParticipant(participant);
    });
    renderParticipants();
    updateVideoTileStates();
}

function getRecorderOptions() {
    const preferredTypes = ["audio/webm;codecs=opus", "audio/webm"];

    if (!window.MediaRecorder) {
        return {};
    }

    for (const type of preferredTypes) {
        if (MediaRecorder.isTypeSupported(type)) {
            return { mimeType: type };
        }
    }

    return {};
}

function attachLocalStream(stream) {
    if (!localVideo) {
        return;
    }

    localVideo.srcObject = stream || null;
    const localCard = document.getElementById("localCard");
    if (localCard) {
        localCard.classList.toggle("camera-live", Boolean(stream && !isCameraOff));
    }
    if (stream && !isScreenSharing) {
        cameraVideoTrack = stream.getVideoTracks()[0] || cameraVideoTrack;
    }
    if (localPlaceholder) {
        localPlaceholder.classList.toggle("visible", !stream || isCameraOff);
    }

    updateVideoTileStates();
}

function addRemoteVideo(sid, user, stream) {
    if (!videoGrid || document.getElementById(`remote-${sid}`)) {
        return;
    }

    document.querySelectorAll(".demo-tile").forEach((tile) => tile.remove());

    const card = document.createElement("div");
    card.className = "video-card video-tile remote-tile";
    card.id = `remote-${sid}`;
    card.dataset.user = String(user || sid).trim().toLowerCase();

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = stream;

    const placeholder = document.createElement("div");
    placeholder.className = "video-placeholder";
    placeholder.innerHTML = `<span>${escapeHtml((user || sid || "G").slice(0, 1).toUpperCase())}</span><strong>${escapeHtml(user || "Guest")}</strong>`;

    const label = document.createElement("span");
    label.className = "user-label video-name";
    label.innerText = user || sid;

    const status = document.createElement("span");
    status.className = "tile-status mic-off";
    status.innerHTML = micIconMarkup(false);

    card.appendChild(video);
    card.appendChild(placeholder);
    card.appendChild(label);
    card.appendChild(status);
    videoGrid.appendChild(card);
    updateVideoGridLayout();
    updateVideoTileStates();
}

function removeRemoteVideo(sid) {
    const tile = document.getElementById(`remote-${sid}`);
    if (tile) {
        tile.remove();
    }
    updateVideoGridLayout();
}

function destroyPeer(sid) {
    const peer = peers.get(sid);
    if (peer) {
        peer.destroy();
        peers.delete(sid);
    }
    removeRemoteVideo(sid);
}

function destroyAllPeers() {
    Array.from(peers.keys()).forEach((sid) => destroyPeer(sid));
    updateVideoGridLayout();
}

function createPeer(targetSid, user, initiator) {
    if (!meetingId || !socket || !localStream || !window.SimplePeer || targetSid === currentSid) {
        return null;
    }

    if (peers.has(targetSid)) {
        return peers.get(targetSid);
    }

    // WebRTC media travels peer-to-peer; Socket.IO only relays setup signals.
    const peer = new SimplePeer({
        initiator,
        trickle: false,
        stream: localStream,
    });

    peer.on("signal", (signal) => {
        socket.emit("signal", {
            meeting_id: meetingId,
            user: currentUser,
            to: targetSid,
            signal,
        });
    });

    peer.on("stream", (remoteStream) => {
        addRemoteVideo(targetSid, user, remoteStream);
    });

    peer.on("close", () => {
        peers.delete(targetSid);
        removeRemoteVideo(targetSid);
    });

    peer.on("error", () => {
        peers.delete(targetSid);
        removeRemoteVideo(targetSid);
    });

    peers.set(targetSid, peer);
    return peer;
}

function handleSignal(payload) {
    if (!payload || payload.from === currentSid || !payload.signal) {
        return;
    }

    let peer = peers.get(payload.from);
    if (!peer) {
        peer = createPeer(payload.from, payload.user, false);
    }

    if (!peer) {
        return;
    }

    try {
        peer.signal(payload.signal);
    } catch (error) {
        setStatus("Unable to connect a remote participant.", "error");
    }
}

function initializeSocket() {
    if (!meetingId) {
        setConnectionStatus("Good connection");
        renderParticipants();
        return;
    }

    if (!window.io) {
        setConnectionStatus("Socket.IO unavailable");
        setStatus("Realtime server client did not load.", "error");
        return;
    }

    socket = io();

    socket.on("connect", () => {
        currentSid = socket.id;
        setConnectionStatus("Good connection");
        if (meetingId) {
            joinRealtimeRoom();
        }
    });

    socket.on("socket_ready", (payload) => {
        currentSid = payload.sid || socket.id;
        if (meetingId) {
            joinRealtimeRoom();
        }
        renderParticipants();
    });

    socket.on("meeting_roster", (payload) => {
        currentSid = payload.self ? payload.self.sid : currentSid;
        syncParticipants(payload.participants);
        setConnectionStatus(`${(payload.participants || []).length} online`);
        meetingJoined = true;

        (payload.peers || []).forEach((participant) => {
            createPeer(participant.sid, participant.user, true);
        });

        if (meetingActive) {
            emitParticipantState();
        }
    });

    socket.on("meeting_started", (payload) => {
        activeMeetingName = payload.meeting_name || activeMeetingName;
        if (meetingNameInput && activeMeetingName) {
            meetingNameInput.value = activeMeetingName;
        }
    });

    socket.on("user_joined", (payload) => {
        syncParticipants(payload.participants);
        setConnectionStatus(`${(payload.participants || []).length} online`);
    });

    socket.on("user_left", (payload) => {
        destroyPeer(payload.sid);
        syncParticipants(payload.participants);
        setConnectionStatus(`${(payload.participants || []).length} online`);
    });

    socket.on("participants_update", (payload) => {
        syncParticipants(payload.participants);
        setConnectionStatus(`${payload.online_count || (payload.participants || []).length} online`);
    });

    socket.on("participant_state", (payload) => {
        const current = getParticipantByIdentity(payload.sid, payload.user) || {
            sid: payload.sid,
            user: payload.user || "Guest",
        };
        upsertParticipant({
            ...current,
            ...payload,
        });
        renderParticipants();
        updateVideoTileStates();
    });

    socket.on("signal", handleSignal);

    socket.on("ai_status", (payload) => {
        if (payload.type === "processing") {
            setAiState("Analyzing", ["Processing live audio"]);
            return;
        }

        setStatus(payload.message || "Listening for clear speech...", "loading");
    });

    socket.on("ai_error", (payload) => {
        setStatus(payload.message || "Live AI processing failed.", "error");
        setAiState("Needs attention", ["Check microphone and server logs"]);
    });

    socket.on("ai_update", (payload) => {
        updateInsightsFromPayload(payload);
        setStatus(`${payload.user || "Participant"} update analyzed.`, "ok");
        highlightSpeaker(payload.user);
    });

    socket.on("blocker_alert", (payload) => {
        showBlockerAlert(payload.blockers || []);
    });

    socket.on("chat_message", (payload) => {
        chatMessages.push({
            user: payload.user || "User",
            text: payload.text || "",
            time: payload.time || new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        });
        renderChatMessages();
    });

    socket.on("meeting_ended", (payload) => {
        const meetingPayload = payload || {};
        pendingEndMeeting = false;
        window.clearTimeout(meetingEndFallbackTimer);
        updateInsightsFromPayload(meetingPayload);
        stopLocalSession(false);
        setStatus("Meeting saved. Redirecting to dashboard...", "ok");
        setAiState("Saved", ["Final summary stored", "Auto-save complete"]);
        window.setTimeout(() => {
            window.location.href = meetingPayload.redirect_url || "/dashboard";
        }, 700);
    });

    socket.on("meeting_error", (payload) => {
        if (pendingEndMeeting) {
            pendingEndMeeting = false;
            window.clearTimeout(meetingEndFallbackTimer);
            if (stopButton) {
                stopButton.disabled = !meetingActive;
            }
        }
        setStatus(payload.message || "Meeting connection error.", "error");
        setMeetingStage(meetingActive ? "active" : "ready");
    });
}

function joinRealtimeRoom() {
    if (!meetingId || !socket) {
        return;
    }

    socket.emit("join_meeting", {
        meeting_id: meetingId,
        user: currentUser,
    });
}

function currentMeetingName() {
    return (meetingNameInput ? meetingNameInput.value : activeMeetingName || "").trim();
}

function startAudioRecorder() {
    if (!window.MediaRecorder || !localStream) {
        setStatus("Your browser does not support live audio recording.", "error");
        return;
    }

    const audioTracks = localStream.getAudioTracks();
    if (audioTracks.length === 0) {
        setStatus("No microphone track was found.", "error");
        return;
    }

    const audioStream = new MediaStream(audioTracks);
    audioChunks = [];
    audioRecorder = new MediaRecorder(audioStream, getRecorderOptions());

    audioRecorder.ondataavailable = (event) => {
        if (!event.data || event.data.size === 0) {
            return;
        }

        if (meetingId && socket && socket.connected) {
            sendAudioChunk(event.data);
            return;
        }

        audioChunks.push(event.data);
    };

    audioRecorder.onstop = async () => {
        if (!meetingId && audioChunks.length > 0) {
            await uploadSoloRecording();
        }
        audioChunks = [];
    };

    audioRecorder.start(meetingId ? LIVE_CHUNK_MS : undefined);
}

function sendAudioChunk(blob) {
    if (!socket || !socket.connected || !meetingId) {
        return;
    }

    const reader = new FileReader();
    reader.onloadend = () => {
        socket.emit("send_audio", {
            meeting_id: meetingId,
            meeting_name: currentMeetingName(),
            user: currentUser,
            audio_chunk: reader.result,
        });
    };
    reader.readAsDataURL(blob);
}

async function uploadSoloRecording() {
    const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
    const formData = new FormData();
    formData.append("audio", audioBlob, "meeting-audio.webm");

    try {
        setAiState("Analyzing", ["Processing solo update"]);
        const response = await fetch("/upload_audio", {
            method: "POST",
            body: formData,
        });
        const payload = await response.json();

        if (!response.ok || payload.error) {
            throw new Error(payload.error || "Upload failed.");
        }

        updateInsightsFromPayload({
            analysis: payload.analysis,
            structured_summary: payload.structured_summary,
            user: payload.user,
        });
        setStatus("Solo update saved.", "ok");
    } catch (error) {
        setStatus(error.message || "Unable to analyze audio.", "error");
    }
}

function openMeetingModal() {
    const modal = document.getElementById("meeting-create-modal");
    const input = document.getElementById("meetingNameModalInput");
    if (modal) {
        modal.hidden = false;
        modal.classList.add("open");
    }
    if (input) {
        input.focus();
    }
}

function closeMeetingModal() {
    const modal = document.getElementById("meeting-create-modal");
    if (modal) {
        modal.classList.remove("open");
        modal.hidden = true;
    }
}

function submitMeetingModal() {
    const modalInput = document.getElementById("meetingNameModalInput");
    const pageInput = document.getElementById("meetingName");
    if (!modalInput) {
        return;
    }

    const name = modalInput.value.trim();
    if (!name) {
        setStatus("Meeting name is required.", "error");
        modalInput.focus();
        return;
    }

    if (pageInput) {
        pageInput.value = name;
    }
    closeMeetingModal();
    startMeeting();
}

async function createMeetingFromLive() {
    const meetingName = currentMeetingName() || `Meeting - ${new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}`;
    const formData = new FormData();
    formData.append("meeting_name", meetingName);

    const response = await fetch("/meeting/create", {
        method: "POST",
        headers: {
            "X-Requested-With": "XMLHttpRequest",
        },
        body: formData,
    });
    const payload = await response.json();

    if (!response.ok || !payload.redirect) {
        throw new Error(payload.error || "Unable to create meeting.");
    }

    return payload.redirect;
}

async function startMeeting() {
    if (meetingActive) {
        return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setStatus("Camera and microphone are not available in this browser.", "error");
        return;
    }

    const meetingName = currentMeetingName();
    if (!meetingName) {
        if (!meetingId) {
            openMeetingModal();
            return;
        }

        setStatus("Please enter a meeting name before starting.", "error");
        if (meetingNameInput) {
            meetingNameInput.focus();
        }
        return;
    }
    activeMeetingName = meetingName;

    if (!meetingId) {
        try {
            setStatus("Creating meeting...", "loading");
            const redirectUrl = await createMeetingFromLive();
            window.location.href = redirectUrl;
        } catch (error) {
            setStatus(error.message || "Unable to create meeting.", "error");
        }
        return;
    }

    try {
        setStatus("Starting camera and microphone...", "loading");
        setAiState("Connecting", ["Opening media devices"]);
        setMeetingStage("recording");
        if (startButton) {
            startButton.disabled = true;
        }
        if (stopButton) {
            stopButton.disabled = true;
        }
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        cameraVideoTrack = localStream.getVideoTracks()[0] || null;
        meetingActive = true;
        isMuted = false;
        isCameraOff = false;

        attachLocalStream(localStream);
        startTimer();
        setRecordingUi(true, meetingId ? "Live meeting running" : "Solo recording");
        startAudioRecorder();

        if (meetingId) {
            joinRealtimeRoom();
            if (socket && socket.connected) {
                socket.emit("start_meeting", {
                    meeting_id: meetingId,
                    meeting_name: activeMeetingName,
                    user: currentUser,
                });
                emitParticipantState();
            }
            setStatus(`${activeMeetingName} started.`, "ok");
            setAiState("Listening", ["AI chunks every 5 seconds"]);
        } else {
            setConnectionStatus("Solo recording");
            setStatus("Solo recording started.", "ok");
            setAiState("Listening", ["Recording solo update"]);
        }
    } catch (error) {
        meetingActive = false;
        stopTimer();
        setRecordingUi(false, "Permission denied");
        setStatus("Camera or microphone permission was denied.", "error");
        setAiState("Blocked", ["Allow camera and microphone access"]);
    }
}

function stopRecorder() {
    if (audioRecorder && audioRecorder.state !== "inactive") {
        try {
            audioRecorder.requestData();
        } catch (error) {
            // Some browsers throw when no data is pending; stopping still works.
        }
        audioRecorder.stop();
    }
}

function stopLocalTracks() {
    if (localStream) {
        localStream.getTracks().forEach((track) => track.stop());
        localStream = null;
    }

    attachLocalStream(null);
}

function stopLocalSession(notifyServer) {
    if (!meetingActive && !localStream && peers.size === 0) {
        setRecordingUi(false, "Waiting...");
        return;
    }

    meetingActive = false;
    stopTimer();
    stopRecorder();
    window.setTimeout(stopLocalTracks, 150);
    destroyAllPeers();
    setRecordingUi(false, "Meeting saved");
    setConnectionStatus(meetingId ? "Meeting ended" : "Solo saved");
    window.clearTimeout(meetingEndFallbackTimer);
    pendingEndMeeting = false;
    isScreenSharing = false;

    if (screenButton) {
        screenButton.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H4zM8 20h8M12 16v4"/></svg>Share Screen';
        screenButton.setAttribute("aria-pressed", "false");
    }

    updateVideoTileStates();
}

function endMeeting() {
    if (!meetingId && !meetingActive) {
        setStatus("Start the meeting before ending it.", "error");
        return;
    }

    if (meetingId && socket && socket.connected) {
        pendingEndMeeting = true;
        window.clearTimeout(meetingEndFallbackTimer);
        setStatus("Ending meeting for everyone...", "loading");
        setAiState("Saving", ["Finalizing team summary"]);
        if (stopButton) {
            stopButton.disabled = true;
        }
        socket.emit("end_meeting", { meeting_id: meetingId });
        meetingEndFallbackTimer = window.setTimeout(() => {
            if (!pendingEndMeeting) {
                return;
            }

            pendingEndMeeting = false;
            stopLocalSession(false);
            window.location.href = "/dashboard";
        }, 3200);
        return;
    }

    setStatus("Saving meeting summary...", "loading");
    stopLocalSession(false);
}

function toggleMeeting() {
    if (meetingActive) {
        endMeeting();
        return;
    }

    startMeeting();
}

function toggleMute() {
    if (!localStream) {
        return;
    }

    isMuted = !isMuted;
    localStream.getAudioTracks().forEach((track) => {
        track.enabled = !isMuted;
    });
    updateMicLabel();
    updateVideoTileStates();
    emitParticipantState();
}

function toggleCamera() {
    if (!localStream) {
        return;
    }

    isCameraOff = !isCameraOff;
    localStream.getVideoTracks().forEach((track) => {
        track.enabled = !isCameraOff;
    });
    updateCameraLabel();
    updateVideoTileStates();
    emitParticipantState();
}

async function shareMeeting() {
    const link = window.location.href;

    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(link);
        } else {
            const input = document.createElement("input");
            input.value = link;
            document.body.appendChild(input);
            input.select();
            document.execCommand("copy");
            input.remove();
        }
        setStatus("Meeting link copied.", "ok");
    } catch (error) {
        setStatus("Unable to copy meeting link.", "error");
    }
}

async function copyMeetingId() {
    const value = meetingId || window.location.href;
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(value);
        } else {
            const input = document.createElement("input");
            input.value = value;
            document.body.appendChild(input);
            input.select();
            document.execCommand("copy");
            input.remove();
        }
        setStatus("Meeting ID copied.", "ok");
    } catch (error) {
        setStatus("Unable to copy meeting ID.", "error");
    }
}

async function shareScreen() {
    if (!localStream || !navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        setStatus("Start the meeting before sharing your screen.", "error");
        return;
    }

    if (isScreenSharing && cameraVideoTrack) {
        const currentTrack = localStream.getVideoTracks()[0];
        if (currentTrack && currentTrack !== cameraVideoTrack) {
            currentTrack.stop();
            localStream.removeTrack(currentTrack);
        }
        localStream.addTrack(cameraVideoTrack);
        attachLocalStream(localStream);
        peers.forEach((peer) => {
            try {
                peer.replaceTrack(currentTrack, cameraVideoTrack, localStream);
            } catch (error) {
                // Existing peer will continue receiving the previous track if replaceTrack is unsupported.
            }
        });
        isScreenSharing = false;
        if (screenButton) {
            screenButton.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H4zM8 20h8M12 16v4"/></svg>Share Screen';
            screenButton.setAttribute("aria-pressed", "false");
        }
        setStatus("Camera restored.", "ok");
        updateVideoTileStates();
        emitParticipantState();
        return;
    }

    try {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = displayStream.getVideoTracks()[0];
        const previousTrack = localStream.getVideoTracks()[0];

        if (previousTrack) {
            localStream.removeTrack(previousTrack);
        }
        localStream.addTrack(screenTrack);
        isScreenSharing = true;
        attachLocalStream(localStream);

        peers.forEach((peer) => {
            try {
                peer.replaceTrack(previousTrack, screenTrack, localStream);
            } catch (error) {
                // Existing peer will continue receiving the previous track if replaceTrack is unsupported.
            }
        });

        if (screenButton) {
            screenButton.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H4zM8 20h8M12 16v4"/></svg>Stop Share';
            screenButton.setAttribute("aria-pressed", "true");
        }

        screenTrack.onended = () => {
            if (isScreenSharing) {
                shareScreen();
            }
        };
        setStatus("Screen sharing started.", "ok");
        updateVideoTileStates();
        emitParticipantState();
    } catch (error) {
        setStatus("Screen sharing was cancelled.", "error");
    }
}

function renderChatMessages() {
    if (!chatList) {
        return;
    }

    if (!chatMessages.length) {
        chatList.innerHTML = `<div class="chat-empty"><span>No messages yet. Start the conversation.</span></div>`;
        return;
    }

    chatList.innerHTML = chatMessages
        .slice(-20)
        .map((message) => `
            <div class="chat-row">
                <span class="chat-avatar">${escapeHtml((message.user || "U").slice(0, 1).toUpperCase())}</span>
                <div>
                    <strong>${escapeHtml(message.user || "User")} <small>${escapeHtml(message.time || "now")}</small></strong>
                    <p>${escapeHtml(message.text || "")}</p>
                </div>
            </div>
        `)
        .join("");
    chatList.scrollTop = chatList.scrollHeight;
}

function focusChat() {
    const panel = document.getElementById("chat-panel");
    if (panel) {
        panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    if (chatInput) {
        chatInput.focus();
    }
}

function sendChatMessage() {
    if (!chatInput) {
        return;
    }

    const text = chatInput.value.trim();
    if (!text) {
        return;
    }

    const message = {
        meeting_id: meetingId,
        user: currentUser,
        text,
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    chatInput.value = "";
    if (socket && socket.connected && meetingId) {
        socket.emit("chat_message", message);
    } else {
        chatMessages.push(message);
        renderChatMessages();
    }
}

function toggleFullScreen() {
    const container = document.getElementById("videoContainer");
    if (!container) {
        return;
    }

    if (!document.fullscreenElement) {
        container.requestFullscreen().catch(() => {
            setStatus("Fullscreen is not available in this browser.", "error");
        });
        return;
    }

    document.exitFullscreen();
}

function leaveCurrentMeeting() {
    setMeetingActionButtons(false);
    stopLocalSession(false);

    if (socket && socket.connected && meetingJoined) {
        socket.emit("leave_meeting", { meeting_id: meetingId });
    }

    window.location.href = "/meeting/leave";
}

function renderQuickNotes() {
    if (!quickNoteList) {
        return;
    }

    if (quickNotes.length === 0) {
        quickNoteList.innerHTML = `<div class="note-row muted">No quick notes yet.</div>`;
        return;
    }

    quickNoteList.innerHTML = quickNotes
        .slice(0, 3)
        .map((note) => `<div class="note-row"><span>!</span>${escapeHtml(note)}</div>`)
        .join("");
}

async function saveQuickNote() {
    if (!noteInput) {
        return;
    }

    const value = noteInput.value.trim();
    if (!value) {
        return;
    }

    quickNotes.unshift(value);
    noteInput.value = "";
    renderQuickNotes();

    try {
        await fetch("/save_note", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                note: value,
                meeting_id: meetingId,
            }),
        });
        setStatus("Note saved.", "ok");
    } catch (error) {
        setStatus("Note saved locally. Server save failed.", "error");
    }
}

async function loadMeetingData() {
    if (!meetingId) {
        return;
    }

    try {
        const response = await fetch(`/meeting-data?meeting_id=${encodeURIComponent(meetingId)}`);
        const payload = await response.json();
        updateInsightsFromPayload({
            meeting: {
                summary: payload.summary,
                structured_summary: payload.structured_summary,
                summary_text: payload.summary_text,
                participants: payload.participants,
                counts: payload.counts,
            },
        });
    } catch (error) {
        setStatus("Unable to load saved meeting state.", "error");
    }
}

window.startMeeting = startMeeting;
window.endMeeting = endMeeting;
window.toggleMeeting = toggleMeeting;
window.toggleMute = toggleMute;
window.toggleCamera = toggleCamera;
window.shareMeeting = shareMeeting;
window.copyMeetingId = copyMeetingId;
window.shareScreen = shareScreen;
window.toggleFullScreen = toggleFullScreen;
window.leaveCurrentMeeting = leaveCurrentMeeting;
window.saveQuickNote = saveQuickNote;
window.focusChat = focusChat;
window.sendChatMessage = sendChatMessage;
window.startRecording = startMeeting;
window.stopRecording = endMeeting;

initializeSocket();
renderQuickNotes();
chatMessages = [];
    renderChatMessages();
    renderParticipants();
    loadMeetingData();

if (chatInput) {
    chatInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            sendChatMessage();
        }
    });
}
