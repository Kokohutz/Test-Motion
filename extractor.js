/**
 * Clone Dance - In-browser Choreography Extractor (no Python)
 *
 * Replaces process_video.py / pose_extractor.py with @mediapipe/tasks-vision
 * PoseLandmarker running in VIDEO mode. Steps through an uploaded video
 * deterministically (seek per frame), extracts landmarks + joint angles and
 * exports:
 *   1. Legacy Clone-Dance choreography JSON (works with clone_dance.html
 *      and visualizer.html as-is).
 *   2. Beatmap JSON (step/angle schema; bpm and step segmentation are
 *      filled in by the M2 beat-detection milestone).
 */

import { FilesetResolver, PoseLandmarker } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm';
import {
    DEFAULT_ACTIVE_LANDMARKS,
    DEFAULT_ANGLE_JOINTS,
    DEFAULT_POSE_CONNECTIONS,
    VISIBILITY_THRESHOLD,
    round,
    serializeLandmarks,
    calculateAngles,
    buildLegacyChoreography,
    buildBeatmap,
    sanitizeFileName
} from './choreo_core.js';

const MEDIAPIPE_WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';

const SEEK_TIMEOUT_MS = 8000;

const state = {
    activeLandmarks: DEFAULT_ACTIVE_LANDMARKS,
    angleJoints: DEFAULT_ANGLE_JOINTS,
    poseConnections: DEFAULT_POSE_CONNECTIONS,
    landmarker: null,
    landmarkerComplexity: null,
    video: null,
    videoUrl: null,
    isRunning: false,
    cancelRequested: false,
    result: null
};

const els = {};

document.addEventListener('DOMContentLoaded', () => {
    for (const id of [
        'videoFile', 'videoFileName', 'choreoName', 'modelSelect', 'fpsSelect',
        'startBtn', 'cancelBtn', 'statusText', 'progressBar', 'progressLabel',
        'previewSection', 'previewCanvas', 'resultsSection', 'resultsSummary',
        'downloadLegacyBtn', 'downloadBeatmapBtn'
    ]) {
        els[id] = document.getElementById(id);
    }

    loadSharedConfig();

    els.videoFile.addEventListener('change', onVideoSelected);
    els.startBtn.addEventListener('click', startExtraction);
    els.cancelBtn.addEventListener('click', () => {
        state.cancelRequested = true;
        setStatus('Stopping... (keeping poses extracted so far)');
    });
    els.downloadLegacyBtn.addEventListener('click', () => downloadResult('legacy'));
    els.downloadBeatmapBtn.addEventListener('click', () => downloadResult('beatmap'));
});

function loadSharedConfig() {
    if (!window.loadAppConfig) return;
    window.loadAppConfig()
        .then((config) => {
            const common = config.common || {};
            const game = config.game || {};
            if (Array.isArray(common.ACTIVE_LANDMARKS)) state.activeLandmarks = common.ACTIVE_LANDMARKS;
            if (common.ANGLE_JOINTS && typeof common.ANGLE_JOINTS === 'object') state.angleJoints = common.ANGLE_JOINTS;
            if (Array.isArray(game.POSE_CONNECTIONS)) state.poseConnections = game.POSE_CONNECTIONS;
        })
        .catch((error) => {
            console.warn('Could not load config.json, using built-in defaults:', error);
        });
}

function setStatus(text, isError = false) {
    els.statusText.textContent = text;
    els.statusText.classList.toggle('error', isError);
}

function onVideoSelected() {
    const file = els.videoFile.files[0];
    els.videoFileName.textContent = file ? file.name : 'Not selected';
    if (file && !els.choreoName.value.trim()) {
        els.choreoName.value = file.name.replace(/\.[^.]+$/, '');
    }
    els.startBtn.disabled = !file;
}

async function getLandmarker(complexity) {
    if (state.landmarker && state.landmarkerComplexity === complexity) {
        return state.landmarker;
    }
    if (state.landmarker) {
        state.landmarker.close();
        state.landmarker = null;
    }

    setStatus('Loading MediaPipe PoseLandmarker (' + complexity + ')...');
    const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_URL);
    const options = {
        baseOptions: {
            modelAssetPath: `pose_landmarker_${complexity}.task`,
            delegate: 'GPU'
        },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputSegmentationMasks: false
    };

    try {
        state.landmarker = await PoseLandmarker.createFromOptions(vision, options);
    } catch (error) {
        console.warn('GPU delegate failed, retrying with CPU:', error);
        options.baseOptions.delegate = 'CPU';
        state.landmarker = await PoseLandmarker.createFromOptions(vision, options);
    }

    state.landmarkerComplexity = complexity;
    return state.landmarker;
}

function loadVideo(file) {
    return new Promise((resolve, reject) => {
        if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
        const video = document.createElement('video');
        state.videoUrl = URL.createObjectURL(file);
        video.src = state.videoUrl;
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.onloadeddata = () => resolve(video);
        video.onerror = () => reject(new Error('Could not load video file'));
    });
}

function seekTo(video, timeSec) {
    return new Promise((resolve, reject) => {
        if (Math.abs(video.currentTime - timeSec) < 1e-4 && video.readyState >= 2) {
            resolve();
            return;
        }
        const timer = setTimeout(() => {
            video.removeEventListener('seeked', onSeeked);
            reject(new Error(`Seek to ${timeSec.toFixed(2)}s timed out`));
        }, SEEK_TIMEOUT_MS);
        const onSeeked = () => {
            clearTimeout(timer);
            resolve();
        };
        video.addEventListener('seeked', onSeeked, { once: true });
        video.currentTime = timeSec;
    });
}

async function startExtraction() {
    const file = els.videoFile.files[0];
    if (!file || state.isRunning) return;

    state.isRunning = true;
    state.cancelRequested = false;
    state.result = null;
    els.startBtn.disabled = true;
    els.cancelBtn.disabled = false;
    els.resultsSection.classList.add('hidden');
    els.previewSection.classList.remove('hidden');

    const complexity = els.modelSelect.value;
    const targetFps = Number(els.fpsSelect.value) || 30;
    const name = els.choreoName.value.trim() || file.name.replace(/\.[^.]+$/, '') || 'choreography';

    try {
        const landmarker = await getLandmarker(complexity);

        setStatus('Loading video...');
        const video = await loadVideo(file);
        state.video = video;

        const duration = video.duration;
        if (!Number.isFinite(duration) || duration <= 0) {
            throw new Error('Video duration is not available. Try re-encoding the video as MP4.');
        }

        const canvas = els.previewCanvas;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');

        const frameStep = 1 / targetFps;
        const totalSteps = Math.max(1, Math.floor(duration * targetFps));
        const poses = [];
        let failedCount = 0;
        let lastTimestampMs = -1;
        const startedAtMs = performance.now();

        landmarker.detectForVideo(video, 0); // warm-up so timing below is steadier

        for (let frameIdx = 0; frameIdx < totalSteps; frameIdx++) {
            if (state.cancelRequested) break;

            const timeSec = Math.min(frameIdx * frameStep, Math.max(0, duration - 0.001));
            await seekTo(video, timeSec);

            const timestampMs = Math.max(lastTimestampMs + 1, Math.round(timeSec * 1000));
            lastTimestampMs = timestampMs;

            const detection = landmarker.detectForVideo(video, timestampMs);
            const rawLandmarks = detection.landmarks && detection.landmarks[0];

            drawPreview(ctx, video, rawLandmarks);

            if (rawLandmarks && rawLandmarks.length > 0) {
                const landmarks = serializeLandmarks(rawLandmarks, state.activeLandmarks);
                poses.push({
                    timestamp: round(timeSec, 3),
                    frame: frameIdx,
                    landmarks,
                    angles: calculateAngles(landmarks, state.angleJoints)
                });
            } else {
                failedCount++;
            }

            if (frameIdx % 5 === 0 || frameIdx === totalSteps - 1) {
                updateProgress(frameIdx + 1, totalSteps, poses.length, startedAtMs);
            }
        }

        if (poses.length === 0) {
            throw new Error('No poses detected in this video. Make sure one full person is visible.');
        }

        state.result = buildResult({
            name,
            fileName: file.name,
            poses,
            failedCount,
            duration,
            targetFps,
            complexity,
            resolution: [video.videoWidth, video.videoHeight]
        });

        showResults(state.result, state.cancelRequested);
        setStatus(state.cancelRequested ? 'Stopped early - partial choreography ready.' : 'Extraction completed.');
    } catch (error) {
        console.error('Extraction error:', error);
        setStatus('Error: ' + error.message, true);
    } finally {
        state.isRunning = false;
        els.startBtn.disabled = !els.videoFile.files[0];
        els.cancelBtn.disabled = true;
    }
}

function drawPreview(ctx, video, rawLandmarks) {
    const { width, height } = ctx.canvas;
    ctx.drawImage(video, 0, 0, width, height);
    if (!rawLandmarks) return;

    ctx.lineWidth = 3;
    ctx.strokeStyle = '#00ff88';
    ctx.fillStyle = '#00ff88';

    for (const [start, end] of state.poseConnections) {
        const a = rawLandmarks[start];
        const b = rawLandmarks[end];
        if (!a || !b || (a.visibility ?? 1) < VISIBILITY_THRESHOLD || (b.visibility ?? 1) < VISIBILITY_THRESHOLD) continue;
        ctx.beginPath();
        ctx.moveTo(a.x * width, a.y * height);
        ctx.lineTo(b.x * width, b.y * height);
        ctx.stroke();
    }

    for (const id of state.activeLandmarks) {
        const lm = rawLandmarks[id];
        if (!lm || (lm.visibility ?? 1) < VISIBILITY_THRESHOLD) continue;
        ctx.beginPath();
        ctx.arc(lm.x * width, lm.y * height, 5, 0, 2 * Math.PI);
        ctx.fill();
    }
}

function updateProgress(processed, total, detected, startedAtMs) {
    const pct = Math.min(100, (processed / total) * 100);
    els.progressBar.style.width = pct.toFixed(1) + '%';

    const elapsedSec = (performance.now() - startedAtMs) / 1000;
    const etaSec = processed > 0 ? (elapsedSec / processed) * (total - processed) : 0;
    els.progressLabel.textContent =
        `Frame ${processed}/${total} (${pct.toFixed(0)}%) | poses: ${detected} | elapsed ${formatSec(elapsedSec)} | ETA ${formatSec(etaSec)}`;
}

function formatSec(seconds) {
    if (!Number.isFinite(seconds)) return '-';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

function buildResult({ name, fileName, poses, failedCount, duration, targetFps, complexity, resolution }) {
    const legacy = buildLegacyChoreography({
        name,
        poses,
        failedCount,
        duration,
        targetFps,
        complexity,
        resolution,
        activeLandmarks: state.activeLandmarks
    });
    const beatmap = buildBeatmap({ name, fileName, poses, duration, targetFps });

    return { name, legacy, beatmap, failedCount };
}

function showResults(result, wasCancelled) {
    const { legacy, failedCount } = result;
    const stats = legacy.stats;
    const detectionRate = stats.total_poses + failedCount > 0
        ? (stats.total_poses / (stats.total_poses + failedCount)) * 100
        : 0;

    els.resultsSummary.innerHTML = `
        <div><strong>${escapeHtml(legacy.metadata.name)}</strong>${wasCancelled ? ' (partial)' : ''}</div>
        <div>Duration: ${stats.duration.toFixed(1)}s | Poses: ${stats.total_poses} | Effective FPS: ${stats.fps_effective.toFixed(1)}</div>
        <div>Frames without a detected pose: ${failedCount} (detection rate ${detectionRate.toFixed(1)}%)</div>
    `;
    els.resultsSection.classList.remove('hidden');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function downloadResult(kind) {
    if (!state.result) return;

    const baseName = sanitizeFileName(state.result.name);
    const isLegacy = kind === 'legacy';
    const data = isLegacy ? state.result.legacy : state.result.beatmap;
    const fileName = isLegacy ? `${baseName}.json` : `${baseName}_beatmap.json`;

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}
