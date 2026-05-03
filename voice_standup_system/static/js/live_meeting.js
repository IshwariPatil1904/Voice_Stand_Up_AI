(function () {
    const appRoot = document.getElementById("meetingApp");
    if (!appRoot) {
        return;
    }

    const dom = {
        videoGrid: document.getElementById("videoGrid"),
        videoStage: document.getElementById("videoStage"),
        meetingTimer: document.getElementById("meetingTimer"),
        connectionStatus: document.getElementById("connectionStatus"),
        connectionPill: document.getElementById("connectionPill"),
        participantCountTop: document.getElementById("participantCountTop"),
        participantsPanelTitle: document.getElementById("participantsPanelTitle"),
        participantsList: document.getElementById("participantsList"),
        chatMessages: document.getElementById("chatMessages"),
        chatForm: document.getElementById("chatForm"),
        chatInput: document.getElementById("chatInput"),
        summaryText: document.getElementById("summaryText"),
        summaryUpdated: document.getElementById("summaryUpdated"),
        blockersList: document.getElementById("blockersList"),
        tasksList: document.getElementById("tasksList"),
        plansList: document.getElementById("plansList"),
        blockerCount: document.getElementById("blockerCount"),
        taskCount: document.getElementById("taskCount"),
        planCount: document.getElementById("planCount"),
        aiStatusText: document.getElementById("aiStatusText"),
        meetingToast: document.getElementById("meetingToast"),
        toggleMicBtn: document.getElementById("toggleMicBtn"),
        toggleCameraBtn: document.getElementById("toggleCameraBtn"),
        shareScreenBtn: document.getElementById("shareScreenBtn"),
        toggleChatBtn: document.getElementById("toggleChatBtn"),
        fullscreenBtn: document.getElementById("fullscreenBtn"),
        leaveMeetingBtn: document.getElementById("leaveMeetingBtn"),
        shareLinkBtn: document.getElementById("shareLinkBtn"),
        endMeetingBtn: document.getElementById("endMeetingBtn"),
        copyMeetingIdBtn: document.getElementById("copyMeetingIdBtn"),
        focusSummaryBtn: document.getElementById("focusSummaryBtn"),
        bottomPanels: document.getElementById("bottomPanels"),
    };

    const state = {
        meetingId: appRoot.dataset.meetingId || "",
        meetingName: appRoot.dataset.meetingName || "Live Meeting",
        currentUser: appRoot.dataset.user || "Guest",
        host: appRoot.dataset.host || "",
        dashboardUrl: appRoot.dataset.dashboardUrl || "/dashboard",
        leaveUrl: "/meeting/leave",
        currentSid: "",
        socket: null,
        socketConnected: false,
        localStream: new MediaStream(),
        displayStream: null,
        cameraTrack: null,
        audioTrack: null,
        displayTrack: null,
        peerConnections: new Map(),
        remoteStreams: new Map(),
        liveParticipants: new Map(),
        participants: [],
        onlineCount: 0,
        chatMessages: [],
        insights: { blockers: [], tasks: [], plans: [] },
        counts: { blockers: 0, tasks: 0, plans: 0 },
        summaryText: "AI is analyzing conversation...",
        createdAtIso: "",
        updatedAtIso: "",
        isHost: false,
        micEnabled: true,
        cameraEnabled: true,
        screenSharing: false,
        chatVisible: true,
        aiRecorder: null,
        aiBusy: false,
        pendingCandidates: new Map(),
        toastTimer: null,
        clockTimer: null,
        speakerTimer: null,
    };

    const RTC_CONFIG = {
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    };

    function makeElement(tag, className, text) {
        const node = document.createElement(tag);
        if (className) {
            node.className = className;
        }
        if (text !== undefined) {
            node.textContent = text;
        }
        return node;
    }

    function iconMarkup(name) {
        const icons = {
            mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16.5a4.5 4.5 0 0 0 4.5-4.5V7A4.5 4.5 0 0 0 7.5 7v5a4.5 4.5 0 0 0 4.5 4.5Z"></path><path d="M5 11.5a7 7 0 0 0 14 0"></path><path d="M12 18.5V21"></path></svg>',
            micOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 16 16"></path><path d="M9.2 9.2V12a2.8 2.8 0 0 0 4.8 2"></path><path d="M14.8 7A2.8 2.8 0 0 0 9.2 7"></path><path d="M5 11.5a7 7 0 0 0 11.5 5.4"></path><path d="M12 18.5V21"></path></svg>',
            camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="6.5" width="13" height="11" rx="2"></rect><path d="m16.5 10 4-2.5v9l-4-2.5"></path></svg>',
            cameraOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 16 16"></path><rect x="3.5" y="6.5" width="13" height="11" rx="2"></rect><path d="m16.5 10 4-2.5v9l-4-2.5"></path></svg>',
            screen: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="12" rx="2"></rect><path d="M8 20h8"></path><path d="M12 16.5V20"></path></svg>',
            warning: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 3.5 19h17Z"></path><path d="M12 9v4.5"></path><path d="M12 16.8h.01"></path></svg>',
        };
        return icons[name] || icons.mic;
    }

    function resolveAvatarColor(name) {
        const colors = ["#6a7cff", "#ff6b8a", "#36b37e", "#ff9f43", "#7a5cff", "#4d96ff", "#8e7dff", "#ff7c7c"];
        const source = name || "Guest";
        let total = 0;
        for (let index = 0; index < source.length; index += 1) {
            total += source.charCodeAt(index);
        }
        return colors[total % colors.length];
    }

    function participantInitials(name) {
        const letters = (name || "Guest")
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((part) => part[0].toUpperCase());
        return letters.join("") || "G";
    }

    function escapeSelector(value) {
        if (window.CSS && typeof window.CSS.escape === "function") {
            return window.CSS.escape(value);
        }
        return String(value).replace(/["\\]/g, "\\$&");
    }

    function formatClock(totalSeconds) {
        const seconds = Math.max(0, totalSeconds);
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const remainingSeconds = seconds % 60;
        return [hours, minutes, remainingSeconds].map((value) => String(value).padStart(2, "0")).join(":");
    }

    function formatUpdateAge(value) {
        if (!value) {
            return "00:00";
        }

        const timestamp = new Date(value);
        if (Number.isNaN(timestamp.getTime())) {
            return "00:00";
        }

        const seconds = Math.max(0, Math.floor((Date.now() - timestamp.getTime()) / 1000));
        if (seconds >= 3600) {
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
        }

        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
    }

    function showToast(message) {
        if (!message) {
            return;
        }

        dom.meetingToast.textContent = message;
        dom.meetingToast.classList.add("visible");
        window.clearTimeout(state.toastTimer);
        state.toastTimer = window.setTimeout(() => {
            dom.meetingToast.classList.remove("visible");
        }, 2200);
    }

    function setAiStatus(message) {
        dom.aiStatusText.textContent = message || "AI is analyzing conversation...";
    }

    function tickClocks() {
        const createdAt = state.createdAtIso ? new Date(state.createdAtIso) : null;
        const createdAtMs = createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt.getTime() : Date.now();
        const elapsedSeconds = Math.floor((Date.now() - createdAtMs) / 1000);
        dom.meetingTimer.textContent = formatClock(elapsedSeconds);
        dom.summaryUpdated.textContent = formatUpdateAge(state.updatedAtIso || state.createdAtIso);
    }

    function updateConnectionStatus() {
        let label = "Connecting...";

        if (!state.socketConnected) {
            label = "Reconnecting...";
        } else if (state.onlineCount > 1) {
            const connections = Array.from(state.peerConnections.values()).map((entry) => entry.pc.connectionState);
            if (connections.some((value) => value === "failed" || value === "disconnected")) {
                label = "Stabilizing connection";
            } else if (connections.some((value) => value === "connected")) {
                label = "Good connection";
            } else {
                label = "Joining peers...";
            }
        } else {
            label = "Ready to invite others";
        }

        dom.connectionStatus.textContent = label;
    }

    function applyMeetingSnapshot(payload) {
        if (!payload) {
            return;
        }

        state.meetingName = payload.meeting_name || state.meetingName;
        state.host = payload.host || state.host || state.currentUser;
        state.isHost = Boolean(payload.is_host || state.currentUser === state.host);
        state.participants = Array.isArray(payload.participants) ? payload.participants : [];
        state.onlineCount = typeof payload.online_count === "number" ? payload.online_count : state.participants.filter((item) => item.online).length;
        state.chatMessages = Array.isArray(payload.chat_messages) ? payload.chat_messages : [];
        state.insights = payload.insights || state.insights;
        state.summaryText = payload.summary_text || state.summaryText;
        state.counts = payload.counts || state.counts;
        state.createdAtIso = payload.created_at_iso || state.createdAtIso || new Date().toISOString();
        state.updatedAtIso = payload.updated_at_iso || state.updatedAtIso || state.createdAtIso;

        if (Array.isArray(payload.live_participants) && payload.live_participants.length) {
            state.liveParticipants.clear();
            payload.live_participants.forEach((participant) => {
                if (participant.sid) {
                    state.liveParticipants.set(participant.sid, participant);
                }
            });
        }

        renderParticipants();
        renderChatMessages(true);
        renderInsights();
        updateButtons();
        updateVideoGrid();
        updateConnectionStatus();
    }

    function renderParticipants() {
        dom.participantCountTop.textContent = String(state.onlineCount || state.participants.filter((item) => item.online).length || 1);
        dom.participantsPanelTitle.textContent = `Participants (${state.participants.length || 1})`;
        dom.participantsList.innerHTML = "";

        if (!state.participants.length) {
            const empty = makeElement("div", "empty-state", "Waiting for teammates to join the meeting.");
            dom.participantsList.appendChild(empty);
            return;
        }

        const fragment = document.createDocumentFragment();
        state.participants.forEach((participant) => {
            const row = makeElement("div", "participant-row");
            const avatar = makeElement("div", "participant-avatar", participant.initials || participantInitials(participant.user));
            avatar.style.setProperty("--avatar-color", participant.avatar_color || resolveAvatarColor(participant.user));

            const copy = makeElement("div", "participant-copy");
            const nameLine = makeElement("div", "participant-name-line");
            const name = makeElement("strong", "", participant.user === state.currentUser ? `${participant.user} (You)` : participant.user);
            nameLine.appendChild(name);

            if (participant.host) {
                nameLine.appendChild(makeElement("span", "small-badge host", "Host"));
            }

            if (participant.user === state.currentUser) {
                nameLine.appendChild(makeElement("span", "small-badge", "You"));
            }

            const statusLine = makeElement(
                "div",
                "participant-status-line",
                participant.online ? "Online in this meeting" : "Not currently connected"
            );

            copy.appendChild(nameLine);
            copy.appendChild(statusLine);

            const actions = makeElement("div", "participant-actions");
            const micIcon = makeElement("span", `icon-state ${participant.mic_on ? "success" : "danger"}`);
            micIcon.innerHTML = iconMarkup(participant.mic_on ? "mic" : "micOff");

            const cameraIcon = makeElement("span", `icon-state ${participant.camera_on ? "success" : "danger"}`);
            cameraIcon.innerHTML = iconMarkup(participant.camera_on ? "camera" : "cameraOff");

            actions.appendChild(micIcon);
            actions.appendChild(cameraIcon);

            if (participant.screen_sharing) {
                const screenIcon = makeElement("span", "icon-state success");
                screenIcon.innerHTML = iconMarkup("screen");
                actions.appendChild(screenIcon);
            }

            row.appendChild(avatar);
            row.appendChild(copy);
            row.appendChild(actions);
            fragment.appendChild(row);
        });

        dom.participantsList.appendChild(fragment);
    }

    function renderChatMessages(forceScroll) {
        dom.chatMessages.innerHTML = "";

        if (!state.chatMessages.length) {
            dom.chatMessages.appendChild(makeElement("div", "empty-state", "No messages yet. Start the conversation."));
            return;
        }

        const fragment = document.createDocumentFragment();
        state.chatMessages.forEach((message) => {
            const row = makeElement("div", "chat-message");
            const avatar = makeElement("div", "chat-avatar", message.initials || participantInitials(message.user));
            avatar.style.setProperty("--avatar-color", message.avatar_color || resolveAvatarColor(message.user));

            const body = makeElement("div", "chat-body");
            const meta = makeElement("div", "chat-meta");
            meta.appendChild(makeElement("strong", "", message.user));
            meta.appendChild(makeElement("span", "", message.time || ""));

            const text = makeElement("p", "", message.text || "");
            body.appendChild(meta);
            body.appendChild(text);

            row.appendChild(avatar);
            row.appendChild(body);
            fragment.appendChild(row);
        });

        dom.chatMessages.appendChild(fragment);

        if (forceScroll) {
            dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
        }
    }

    function renderInsightSection(container, items, kind, emptyMessage) {
        container.innerHTML = "";

        if (!items || !items.length) {
            container.appendChild(makeElement("div", "empty-state", emptyMessage));
            return;
        }

        const list = makeElement("div", "insight-list");
        items.forEach((item) => {
            const row = makeElement("div", "insight-item");
            const marker = makeElement("span", `insight-marker ${kind === "danger" ? "danger" : ""}`);
            if (kind === "danger") {
                marker.innerHTML = iconMarkup("warning");
            }

            const content = makeElement("div", "insight-content", item.text || "");
            const owner = makeElement("div", "insight-owner", item.user || "");

            row.appendChild(marker);
            row.appendChild(content);
            row.appendChild(owner);
            list.appendChild(row);
        });

        container.appendChild(list);
    }

    function renderInsights() {
        dom.summaryText.textContent = state.summaryText || "AI is analyzing conversation...";
        dom.blockerCount.textContent = String(state.counts.blockers || state.insights.blockers.length || 0);
        dom.taskCount.textContent = String(state.counts.tasks || state.insights.tasks.length || 0);
        dom.planCount.textContent = String(state.counts.plans || state.insights.plans.length || 0);

        renderInsightSection(dom.blockersList, state.insights.blockers, "danger", "No blockers detected yet.");
        renderInsightSection(dom.tasksList, state.insights.tasks, "success", "No tasks extracted yet.");
        renderInsightSection(dom.plansList, state.insights.plans, "primary", "No plans extracted yet.");
    }

    function highlightSpeaker(user) {
        if (!user) {
            return;
        }

        const normalizedUser = String(user).trim().toLowerCase();
        Array.from(dom.videoGrid.children).forEach((tile) => {
            const tileUser = tile.dataset.user || "";
            tile.classList.toggle("active-speaker", tileUser === normalizedUser);
        });

        window.clearTimeout(state.speakerTimer);
        state.speakerTimer = window.setTimeout(() => {
            Array.from(dom.videoGrid.children).forEach((tile) => {
                tile.classList.remove("active-speaker");
            });
        }, 2400);
    }

    function getLocalPreviewStream() {
        if (state.screenSharing && state.displayStream) {
            return state.displayStream;
        }
        return state.localStream;
    }

    function isVideoVisible(participant) {
        if (participant.local) {
            return Boolean(state.screenSharing || (state.cameraEnabled && state.cameraTrack));
        }
        return Boolean(participant.screen_sharing || participant.camera_on);
    }

    function ensureVideoTile(tileId) {
        let tile = dom.videoGrid.querySelector(`[data-peer-id="${escapeSelector(tileId)}"]`);
        if (tile) {
            return tile;
        }

        tile = makeElement("article", "video-tile video-hidden");
        tile.dataset.peerId = tileId;
        tile.innerHTML = [
            '<video autoplay playsinline></video>',
            '<div class="tile-placeholder"><div class="tile-avatar"></div></div>',
            '<div class="tile-you-badge" hidden>You</div>',
            '<div class="tile-screen-badge" hidden>Sharing</div>',
            '<div class="tile-footer">',
            '<div class="tile-name"></div>',
            '<div class="tile-meta">',
            '<span class="tile-state-icon tile-mic-state"></span>',
            '<span class="tile-state-icon tile-camera-state"></span>',
            "</div>",
            "</div>",
        ].join("");
        dom.videoGrid.appendChild(tile);
        return tile;
    }

    function updateTileStateIcons(tile, participant) {
        const micIcon = tile.querySelector(".tile-mic-state");
        const cameraIcon = tile.querySelector(".tile-camera-state");

        micIcon.className = `tile-state-icon tile-mic-state ${participant.mic_on ? "success" : "danger"}`;
        micIcon.innerHTML = iconMarkup(participant.mic_on ? "mic" : "micOff");

        const videoIsOn = Boolean(participant.screen_sharing || participant.camera_on);
        cameraIcon.className = `tile-state-icon tile-camera-state ${videoIsOn ? "success" : "danger"}`;
        cameraIcon.innerHTML = iconMarkup(videoIsOn ? (participant.screen_sharing ? "screen" : "camera") : "cameraOff");
    }

    function updateVideoGrid() {
        const entries = [];
        const localEntry = {
            sid: state.currentSid || "local-preview",
            user: state.currentUser,
            initials: participantInitials(state.currentUser),
            avatar_color: resolveAvatarColor(state.currentUser),
            mic_on: state.micEnabled,
            camera_on: state.cameraEnabled,
            screen_sharing: state.screenSharing,
            host: state.currentUser === state.host,
            local: true,
        };
        entries.push(localEntry);

        state.liveParticipants.forEach((participant, sid) => {
            if (!sid || sid === state.currentSid) {
                return;
            }

            entries.push({
                ...participant,
                local: false,
            });
        });

        dom.videoGrid.dataset.count = String(Math.min(Math.max(entries.length, 1), 6));
        const activeTileIds = new Set();

        entries.forEach((participant) => {
            const tileId = participant.sid || participant.user;
            activeTileIds.add(tileId);
            const tile = ensureVideoTile(tileId);
            const video = tile.querySelector("video");
            const avatar = tile.querySelector(".tile-avatar");
            const youBadge = tile.querySelector(".tile-you-badge");
            const screenBadge = tile.querySelector(".tile-screen-badge");
            const name = tile.querySelector(".tile-name");

            tile.style.setProperty("--avatar-color", participant.avatar_color || resolveAvatarColor(participant.user));
            tile.dataset.user = String(participant.user || participant.sid || "").trim().toLowerCase();
            tile.classList.toggle("local-camera", participant.local && !state.screenSharing && state.cameraEnabled);
            tile.classList.toggle("video-hidden", !isVideoVisible(participant));

            avatar.textContent = participant.initials || participantInitials(participant.user);
            avatar.style.setProperty("--avatar-color", participant.avatar_color || resolveAvatarColor(participant.user));
            name.textContent = participant.user;

            youBadge.hidden = !participant.local;
            screenBadge.hidden = !participant.screen_sharing;

            updateTileStateIcons(tile, participant);

            if (participant.local) {
                video.muted = true;
                const previewStream = isVideoVisible(participant) ? getLocalPreviewStream() : null;
                if (video.srcObject !== previewStream) {
                    video.srcObject = previewStream;
                }
            } else {
                video.muted = false;
                const remoteStream = state.remoteStreams.get(tileId) || null;
                if (video.srcObject !== remoteStream) {
                    video.srcObject = remoteStream;
                }
            }

            if (video.srcObject) {
                video.play().catch(() => {});
            }
        });

        Array.from(dom.videoGrid.children).forEach((tile) => {
            if (!activeTileIds.has(tile.dataset.peerId)) {
                tile.remove();
            }
        });
    }

    function updateButtons() {
        dom.toggleMicBtn.querySelector(".control-label").textContent = state.micEnabled ? "Mute" : "Unmute";
        dom.toggleCameraBtn.querySelector(".control-label").textContent = state.cameraEnabled ? "Stop Video" : "Start Video";
        dom.shareScreenBtn.querySelector(".control-label").textContent = state.screenSharing ? "Stop Share" : "Share Screen";
        dom.fullscreenBtn.querySelector(".control-label").textContent =
            document.fullscreenElement === dom.videoStage ? "Exit Full Screen" : "Full Screen";

        dom.toggleMicBtn.classList.toggle("active", state.micEnabled);
        dom.toggleMicBtn.classList.toggle("muted", !state.micEnabled);
        dom.toggleCameraBtn.classList.toggle("active", state.cameraEnabled || state.screenSharing);
        dom.toggleCameraBtn.classList.toggle("muted", !state.cameraEnabled && !state.screenSharing);
        dom.shareScreenBtn.classList.toggle("active", state.screenSharing);
        dom.toggleChatBtn.classList.toggle("active", state.chatVisible);

        dom.toggleMicBtn.disabled = !state.audioTrack;
        dom.toggleCameraBtn.disabled = !state.cameraTrack;
        dom.endMeetingBtn.disabled = !state.isHost;
        dom.endMeetingBtn.title = state.isHost ? "End meeting for everyone" : "Only the host can end the meeting";
    }

    function emitParticipantState() {
        if (!state.socketConnected || !state.socket) {
            return;
        }

        state.socket.emit("participant_state", {
            meeting_id: state.meetingId,
            mic_on: state.micEnabled,
            camera_on: state.cameraEnabled,
            screen_sharing: state.screenSharing,
        });
    }

    async function copyText(value, successMessage) {
        try {
            await navigator.clipboard.writeText(value);
            showToast(successMessage);
        } catch (_error) {
            const input = makeElement("input");
            input.value = value;
            document.body.appendChild(input);
            input.select();
            document.execCommand("copy");
            input.remove();
            showToast(successMessage);
        }
    }

    function getRecorderMimeType() {
        const options = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
        for (const option of options) {
            if (window.MediaRecorder && MediaRecorder.isTypeSupported(option)) {
                return option;
            }
        }
        return "";
    }

    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    async function startAiRecorder() {
        if (!window.MediaRecorder || !state.audioTrack) {
            setAiStatus("Live AI is waiting for a microphone.");
            return;
        }

        const audioOnlyStream = new MediaStream([state.audioTrack]);
        const mimeType = getRecorderMimeType();
        const recorderOptions = mimeType ? { mimeType } : undefined;
        state.aiRecorder = new MediaRecorder(audioOnlyStream, recorderOptions);

        state.aiRecorder.ondataavailable = async (event) => {
            if (!event.data || event.data.size < 1200 || !state.socketConnected || !state.micEnabled || state.aiBusy) {
                return;
            }

            try {
                state.aiBusy = true;
                setAiStatus("AI is analyzing conversation...");
                const audioChunk = await blobToDataUrl(event.data);
                state.socket.emit("send_audio", {
                    meeting_id: state.meetingId,
                    meeting_name: state.meetingName,
                    user: state.currentUser,
                    audio_chunk: audioChunk,
                });
            } catch (_error) {
                state.aiBusy = false;
                setAiStatus("Live AI could not process that audio chunk.");
            }
        };

        state.aiRecorder.onerror = () => {
            setAiStatus("Live AI recording stopped unexpectedly.");
        };

        state.aiRecorder.start(5000);
        setAiStatus("AI is analyzing conversation...");
    }

    async function initLocalMedia() {
        const mediaAttempts = [
            { video: true, audio: true },
            { video: false, audio: true },
            { video: true, audio: false },
        ];

        let stream = null;
        for (const constraints of mediaAttempts) {
            try {
                stream = await navigator.mediaDevices.getUserMedia(constraints);
                break;
            } catch (_error) {
                stream = null;
            }
        }

        state.localStream = stream || new MediaStream();
        state.cameraTrack = state.localStream.getVideoTracks()[0] || null;
        state.audioTrack = state.localStream.getAudioTracks()[0] || null;
        state.cameraEnabled = Boolean(state.cameraTrack);
        state.micEnabled = Boolean(state.audioTrack);

        if (state.cameraTrack) {
            state.cameraTrack.enabled = state.cameraEnabled;
        }
        if (state.audioTrack) {
            state.audioTrack.enabled = state.micEnabled;
        }

        updateButtons();
        updateVideoGrid();
    }

    function createPeerConnection(peer) {
        const existing = state.peerConnections.get(peer.sid);
        if (existing) {
            return existing;
        }

        const pc = new RTCPeerConnection(RTC_CONFIG);
        const audioTransceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
        const videoTransceiver = pc.addTransceiver("video", { direction: "sendrecv" });

        if (state.audioTrack) {
            audioTransceiver.sender.replaceTrack(state.audioTrack).catch(() => {});
        }

        const activeVideoTrack = state.screenSharing ? state.displayTrack : state.cameraEnabled ? state.cameraTrack : null;
        if (activeVideoTrack) {
            videoTransceiver.sender.replaceTrack(activeVideoTrack).catch(() => {});
        }

        pc.onicecandidate = (event) => {
            if (!event.candidate || !state.socketConnected) {
                return;
            }

            state.socket.emit("signal", {
                meeting_id: state.meetingId,
                to: peer.sid,
                user: state.currentUser,
                signal: { candidate: event.candidate },
            });
        };

        pc.ontrack = (event) => {
            const stream = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
            state.remoteStreams.set(peer.sid, stream);
            updateVideoGrid();
        };

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === "failed" || pc.connectionState === "closed") {
                cleanupPeer(peer.sid);
            }
            updateConnectionStatus();
        };

        const connection = {
            pc,
            user: peer.user,
            audioSender: audioTransceiver.sender,
            videoSender: videoTransceiver.sender,
        };
        state.peerConnections.set(peer.sid, connection);
        return connection;
    }

    async function flushPendingCandidates(peerId, pc) {
        const pending = state.pendingCandidates.get(peerId) || [];
        if (!pending.length) {
            return;
        }

        for (const candidate of pending) {
            try {
                await pc.addIceCandidate(candidate);
            } catch (_error) {
                return;
            }
        }

        state.pendingCandidates.delete(peerId);
    }

    async function createOfferForPeer(peer) {
        const connection = createPeerConnection(peer);
        const offer = await connection.pc.createOffer();
        await connection.pc.setLocalDescription(offer);
        state.socket.emit("signal", {
            meeting_id: state.meetingId,
            to: peer.sid,
            user: state.currentUser,
            signal: { description: connection.pc.localDescription },
        });
    }

    async function handleSignal(payload) {
        const peerId = payload.from;
        const participant = state.liveParticipants.get(peerId) || {
            sid: peerId,
            user: payload.user || "Participant",
            initials: participantInitials(payload.user),
            avatar_color: resolveAvatarColor(payload.user),
            mic_on: true,
            camera_on: true,
            screen_sharing: false,
        };

        if (!state.liveParticipants.has(peerId)) {
            state.liveParticipants.set(peerId, participant);
            updateVideoGrid();
        }

        const connection = createPeerConnection(participant);
        const pc = connection.pc;
        const signal = payload.signal || {};

        if (signal.description) {
            await pc.setRemoteDescription(new RTCSessionDescription(signal.description));
            await flushPendingCandidates(peerId, pc);

            if (signal.description.type === "offer") {
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                state.socket.emit("signal", {
                    meeting_id: state.meetingId,
                    to: peerId,
                    user: state.currentUser,
                    signal: { description: pc.localDescription },
                });
            }
            return;
        }

        if (signal.candidate) {
            if (pc.remoteDescription && pc.remoteDescription.type) {
                await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
            } else {
                const queued = state.pendingCandidates.get(peerId) || [];
                queued.push(new RTCIceCandidate(signal.candidate));
                state.pendingCandidates.set(peerId, queued);
            }
        }
    }

    function cleanupPeer(peerId) {
        const connection = state.peerConnections.get(peerId);
        if (connection) {
            connection.pc.onicecandidate = null;
            connection.pc.ontrack = null;
            connection.pc.close();
            state.peerConnections.delete(peerId);
        }

        state.remoteStreams.delete(peerId);
        state.pendingCandidates.delete(peerId);
        updateVideoGrid();
        updateConnectionStatus();
    }

    function cleanupAllPeers() {
        Array.from(state.peerConnections.keys()).forEach((peerId) => {
            cleanupPeer(peerId);
        });
        state.liveParticipants.clear();
    }

    async function replaceOutgoingVideoTrack(track) {
        const updates = [];
        state.peerConnections.forEach((connection) => {
            if (connection.videoSender) {
                updates.push(connection.videoSender.replaceTrack(track || null).catch(() => {}));
            }
        });
        await Promise.all(updates);
    }

    async function toggleMic() {
        if (!state.audioTrack) {
            showToast("Microphone permission is not available.");
            return;
        }

        state.micEnabled = !state.micEnabled;
        state.audioTrack.enabled = state.micEnabled;
        updateButtons();
        updateVideoGrid();
        emitParticipantState();
    }

    async function toggleCamera() {
        if (!state.cameraTrack) {
            showToast("Camera permission is not available.");
            return;
        }

        state.cameraEnabled = !state.cameraEnabled;
        state.cameraTrack.enabled = state.cameraEnabled;
        if (!state.screenSharing) {
            await replaceOutgoingVideoTrack(state.cameraEnabled ? state.cameraTrack : null);
        }
        updateButtons();
        updateVideoGrid();
        emitParticipantState();
    }

    async function stopScreenShare(notifyPeers) {
        if (state.displayTrack) {
            state.displayTrack.onended = null;
            state.displayTrack.stop();
        }

        state.displayTrack = null;
        state.displayStream = null;
        state.screenSharing = false;
        await replaceOutgoingVideoTrack(state.cameraEnabled ? state.cameraTrack : null);
        updateButtons();
        updateVideoGrid();
        if (notifyPeers) {
            emitParticipantState();
        }
    }

    async function toggleScreenShare() {
        if (state.screenSharing) {
            await stopScreenShare(true);
            return;
        }

        try {
            const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
            const displayTrack = displayStream.getVideoTracks()[0];

            state.displayStream = displayStream;
            state.displayTrack = displayTrack;
            state.screenSharing = true;
            await replaceOutgoingVideoTrack(displayTrack);

            displayTrack.onended = () => {
                stopScreenShare(true);
            };

            updateButtons();
            updateVideoGrid();
            emitParticipantState();
        } catch (_error) {
            showToast("Screen share was cancelled.");
        }
    }

    async function toggleFullscreen() {
        if (document.fullscreenElement === dom.videoStage) {
            await document.exitFullscreen();
        } else {
            await dom.videoStage.requestFullscreen();
        }
        updateButtons();
    }

    function toggleChatPanel() {
        state.chatVisible = !state.chatVisible;
        dom.bottomPanels.classList.toggle("chat-collapsed", !state.chatVisible);
        updateButtons();
    }

    function leaveMeeting() {
        if (state.socket) {
            state.socket.emit("leave_meeting", { meeting_id: state.meetingId });
        }
        window.setTimeout(() => {
            if (state.socket) {
                state.socket.disconnect();
            }
            window.location.href = state.leaveUrl;
        }, 120);
    }

    function sendChatMessage(event) {
        event.preventDefault();
        const text = dom.chatInput.value.trim();
        if (!text || !state.socketConnected) {
            return;
        }

        state.socket.emit("chat_message", {
            meeting_id: state.meetingId,
            user: state.currentUser,
            text,
        });
        dom.chatInput.value = "";
    }

    function bindUi() {
        dom.toggleMicBtn.addEventListener("click", toggleMic);
        dom.toggleCameraBtn.addEventListener("click", toggleCamera);
        dom.shareScreenBtn.addEventListener("click", toggleScreenShare);
        dom.toggleChatBtn.addEventListener("click", toggleChatPanel);
        dom.fullscreenBtn.addEventListener("click", toggleFullscreen);
        dom.leaveMeetingBtn.addEventListener("click", leaveMeeting);
        dom.shareLinkBtn.addEventListener("click", () => copyText(window.location.href, "Meeting link copied."));
        dom.copyMeetingIdBtn.addEventListener("click", () => copyText(state.meetingId, "Meeting ID copied."));
        dom.endMeetingBtn.addEventListener("click", () => {
            if (!state.isHost) {
                showToast("Only the host can end the meeting.");
                return;
            }
            state.socket.emit("end_meeting", { meeting_id: state.meetingId });
        });
        dom.focusSummaryBtn.addEventListener("click", () => {
            dom.summaryText.scrollIntoView({ block: "center", behavior: "smooth" });
            showToast("Live summary is in focus.");
        });
        dom.chatForm.addEventListener("submit", sendChatMessage);
        document.addEventListener("fullscreenchange", updateButtons);
        window.addEventListener("beforeunload", () => {
            if (state.socket) {
                state.socket.emit("leave_meeting", { meeting_id: state.meetingId });
            }
        });
    }

    async function connectSocket() {
        if (typeof io !== "function") {
            setAiStatus("Socket connection is unavailable.");
            return;
        }

        state.socket = io({
            transports: ["websocket", "polling"],
        });

        state.socket.on("connect", () => {
            state.socketConnected = true;
            state.currentSid = state.socket.id;
            cleanupAllPeers();
            updateVideoGrid();
            state.socket.emit("join_meeting", {
                meeting_id: state.meetingId,
                user: state.currentUser,
            });
            updateButtons();
            updateConnectionStatus();
        });

        state.socket.on("disconnect", () => {
            state.socketConnected = false;
            updateConnectionStatus();
        });

        state.socket.on("meeting_roster", async (payload) => {
            state.currentSid = payload.self && payload.self.sid ? payload.self.sid : state.currentSid;
            state.host = payload.host || state.host;
            state.isHost = state.currentUser === state.host;
            state.liveParticipants.clear();

            (payload.participants || []).forEach((participant) => {
                state.liveParticipants.set(participant.sid, participant);
            });

            updateButtons();
            updateVideoGrid();
            updateConnectionStatus();
            emitParticipantState();

            for (const peer of payload.peers || []) {
                try {
                    await createOfferForPeer(peer);
                } catch (_error) {
                    showToast(`Unable to connect to ${peer.user}.`);
                }
            }
        });

        state.socket.on("user_joined", (payload) => {
            if (!payload.sid) {
                return;
            }

            state.liveParticipants.set(payload.sid, {
                sid: payload.sid,
                user: payload.user,
                initials: participantInitials(payload.user),
                avatar_color: resolveAvatarColor(payload.user),
                mic_on: true,
                camera_on: true,
                screen_sharing: false,
            });
            updateVideoGrid();
            updateConnectionStatus();
        });

        state.socket.on("user_left", (payload) => {
            if (!payload.sid) {
                return;
            }

            state.liveParticipants.delete(payload.sid);
            cleanupPeer(payload.sid);
        });

        state.socket.on("participant_state", (payload) => {
            if (!payload.sid) {
                return;
            }

            const current = state.liveParticipants.get(payload.sid) || {
                sid: payload.sid,
                user: payload.user || "Participant",
                initials: participantInitials(payload.user),
                avatar_color: resolveAvatarColor(payload.user),
            };

            state.liveParticipants.set(payload.sid, {
                ...current,
                ...payload,
                initials: current.initials || participantInitials(payload.user),
                avatar_color: current.avatar_color || resolveAvatarColor(payload.user),
            });
            updateVideoGrid();
        });

        state.socket.on("participants_update", (payload) => {
            state.participants = payload.participants || state.participants;
            state.onlineCount = payload.online_count || 0;
            state.host = payload.host || state.host;
            state.isHost = state.currentUser === state.host;
            renderParticipants();
            updateButtons();
            updateConnectionStatus();
        });

        state.socket.on("signal", async (payload) => {
            try {
                await handleSignal(payload);
            } catch (_error) {
                showToast(`Connection sync failed with ${payload.user || "participant"}.`);
            }
        });

        state.socket.on("chat_message", (payload) => {
            state.chatMessages.push(payload);
            renderChatMessages(true);
        });

        state.socket.on("ai_status", (payload) => {
            state.aiBusy = payload.type === "processing";
            setAiStatus(payload.message || "AI is analyzing conversation...");
        });

        state.socket.on("ai_update", (payload) => {
            state.aiBusy = false;
            state.summaryText = payload.summary_text || state.summaryText;
            state.counts = payload.counts || state.counts;
            state.insights = payload.insights || state.insights;
            state.updatedAtIso = payload.updated_at_iso || new Date().toISOString();
            renderInsights();
            tickClocks();
            setAiStatus(`${payload.user || "A participant"} updated the AI summary.`);
            highlightSpeaker(payload.user);
        });

        state.socket.on("blocker_alert", (payload) => {
            const blockerText = Array.isArray(payload.blockers) && payload.blockers.length ? payload.blockers[0] : "New blocker detected.";
            setAiStatus(`${payload.user}: ${blockerText}`);
            highlightSpeaker(payload.user);
        });

        state.socket.on("ai_error", (payload) => {
            state.aiBusy = false;
            setAiStatus(payload.message || "Live AI hit an error.");
        });

        state.socket.on("meeting_error", (payload) => {
            showToast(payload.message || "Meeting error.");
        });

        state.socket.on("meeting_ended", (payload) => {
            showToast("The meeting has ended.");
            window.setTimeout(() => {
                window.location.href = payload && payload.redirect_url ? payload.redirect_url : state.dashboardUrl;
            }, 900);
        });
    }

    async function loadInitialMeetingState() {
        const response = await fetch(`/meeting-data?meeting_id=${encodeURIComponent(state.meetingId)}`, {
            credentials: "same-origin",
        });
        const payload = await response.json();
        applyMeetingSnapshot(payload);
    }

    async function init() {
        bindUi();

        try {
            await Promise.all([loadInitialMeetingState(), initLocalMedia()]);
        } catch (_error) {
            showToast("Unable to load the meeting page cleanly.");
        }

        updateButtons();
        updateVideoGrid();
        tickClocks();
        state.clockTimer = window.setInterval(tickClocks, 1000);
        await connectSocket();
        await startAiRecorder();
    }

    init();
})();
