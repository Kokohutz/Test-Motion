/**
 * Video -> pose time series extraction engine.
 *
 * Browser-dependent (HTMLVideoElement + MediaPipe PoseLandmarker) but
 * framework-free: the React layer only provides callbacks and renders
 * whatever this reports. Frames are visited deterministically (seek per
 * frame at the requested FPS) so extraction is reproducible regardless of
 * machine speed.
 */

import type { PoseLandmarker } from '@mediapipe/tasks-vision';
import { calculateAngles, round, serializeLandmarks } from './choreography';
import type { AngleJointMap, PoseFrame, RawLandmark } from './types';

const SEEK_TIMEOUT_MS = 8000;

export interface ExtractionProgress {
    processedFrames: number;
    totalFrames: number;
    detectedPoses: number;
    elapsedSec: number;
    etaSec: number;
}

export interface ExtractionCallbacks {
    /** Called every few frames with progress numbers. */
    onProgress?: (progress: ExtractionProgress) => void;
    /** Called per frame with the raw landmarks (or null) for preview drawing. */
    onFrame?: (video: HTMLVideoElement, landmarks: RawLandmark[] | null) => void;
    /** Return true to stop early; partial results are returned. */
    shouldCancel?: () => boolean;
}

export interface ExtractionOptions {
    video: HTMLVideoElement;
    landmarker: PoseLandmarker;
    targetFps: number;
    activeLandmarks: number[];
    angleJoints: AngleJointMap;
}

export interface ExtractionResult {
    poses: PoseFrame[];
    failedCount: number;
    duration: number;
    resolution: [number, number];
    cancelled: boolean;
}

export function loadVideoFromFile(file: File): Promise<{ video: HTMLVideoElement; revoke: () => void }> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const video = document.createElement('video');
        video.src = url;
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.onloadeddata = () => resolve({ video, revoke: () => URL.revokeObjectURL(url) });
        video.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('Could not load video file'));
        };
    });
}

function seekTo(video: HTMLVideoElement, timeSec: number): Promise<void> {
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

export async function extractChoreography(
    { video, landmarker, targetFps, activeLandmarks, angleJoints }: ExtractionOptions,
    { onProgress, onFrame, shouldCancel }: ExtractionCallbacks = {}
): Promise<ExtractionResult> {
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error('Video duration is not available. Try re-encoding the video as MP4.');
    }

    const frameStep = 1 / targetFps;
    const totalFrames = Math.max(1, Math.floor(duration * targetFps));
    const poses: PoseFrame[] = [];
    let failedCount = 0;
    let lastTimestampMs = -1;
    let cancelled = false;
    const startedAtMs = performance.now();

    landmarker.detectForVideo(video, 0); // warm-up so per-frame timing is steadier

    for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
        if (shouldCancel?.()) {
            cancelled = true;
            break;
        }

        const timeSec = Math.min(frameIdx * frameStep, Math.max(0, duration - 0.001));
        await seekTo(video, timeSec);

        const timestampMs = Math.max(lastTimestampMs + 1, Math.round(timeSec * 1000));
        lastTimestampMs = timestampMs;

        const detection = landmarker.detectForVideo(video, timestampMs);
        const rawLandmarks = (detection.landmarks && detection.landmarks[0]) || null;

        onFrame?.(video, rawLandmarks);

        if (rawLandmarks && rawLandmarks.length > 0) {
            const landmarks = serializeLandmarks(rawLandmarks, activeLandmarks);
            poses.push({
                timestamp: round(timeSec, 3),
                frame: frameIdx,
                landmarks,
                angles: calculateAngles(landmarks, angleJoints)
            });
        } else {
            failedCount++;
        }

        if (onProgress && (frameIdx % 5 === 0 || frameIdx === totalFrames - 1)) {
            const elapsedSec = (performance.now() - startedAtMs) / 1000;
            const processed = frameIdx + 1;
            onProgress({
                processedFrames: processed,
                totalFrames,
                detectedPoses: poses.length,
                elapsedSec,
                etaSec: processed > 0 ? (elapsedSec / processed) * (totalFrames - processed) : 0
            });
        }
    }

    return {
        poses,
        failedCount,
        duration,
        resolution: [video.videoWidth, video.videoHeight],
        cancelled
    };
}
