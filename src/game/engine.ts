/**
 * Clone Dance game engine — framework-free port of the legacy
 * clone_dance.js game loop, running on the same @mediapipe/tasks-vision
 * PoseLandmarker as the extractor (VIDEO mode over the webcam stream).
 *
 * React owns the DOM elements and renders snapshots; the engine owns the
 * loop, MediaPipe calls, scoring and canvas drawing. All math lives in
 * src/core (comparison.ts / scoring.ts) and is unit-tested there.
 */

import type { PoseLandmarker } from '@mediapipe/tasks-vision';
import { toIndexedLandmarks } from '../core/drawing';
import {
    IDENTITY_NORMALIZATION,
    calculateLiveAngles,
    calculateNormalization,
    compareAngles,
    comparePositions,
    countDetectedAngles,
    getReferencePoseAtTime,
    getTorsoCenter,
    hasTorso,
    mirrorLandmarks,
    normalizePose,
    pickBestReferencePose
} from '../core/comparison';
import type { AngleComparison, IndexedLandmarks, Normalization, PositionComparison } from '../core/comparison';
import {
    averageAccuracy,
    createNoPoseState,
    createScoringState,
    getPerformanceTier,
    resolveFeedbackThresholds,
    updateNoPoseState,
    updateScoring
} from '../core/scoring';
import type { FeedbackTier, NoPoseState, ScoringState } from '../core/scoring';
import type { GameConfig } from '../core/gameConfig';
import type { LegacyChoreography, PoseFrame, RawLandmark } from '../core/types';
import { EffectsEngine } from './effects';
import { SoundBank } from './sounds';

export type GamePhase = 'calibration' | 'countdown' | 'ready' | 'playing' | 'paused' | 'ended';

export interface GameElements {
    referenceVideo: HTMLVideoElement;
    gameCanvas: HTMLCanvasElement;
    calibrationVideo: HTMLVideoElement;
    calibrationCanvas: HTMLCanvasElement;
    effectsCanvas: HTMLCanvasElement;
    inputVideo: HTMLVideoElement;
    videoContainer: HTMLElement;
}

export interface GameOptions {
    inputMode: 'webcam' | 'video';
    referenceVideoFile: File;
    playerVideoFile: File | null;
    choreography: LegacyChoreography;
    config: GameConfig;
    landmarker: PoseLandmarker;
    mirror: boolean;
    effectsEnabled: boolean;
    debugEnabled: boolean;
}

export interface GameSnapshot {
    phase: GamePhase;
    hud: { score: number; combos: number; accuracyPct: number; warning: string };
    combo: { value: number; visible: boolean };
    feedback: { seq: number; tier: FeedbackTier; text: string } | null;
    countdownValue: string | null;
    calibration: { progressPct: number; status: string; currentTimeSec: number; durationSec: number };
    stats: { score: number; avgAccuracyPct: number; maxCombo: number; dancedSec: number } | null;
    debug: { accuracyPct: number; matchText: string; missText: string } | null;
    needsUserPlay: boolean;
}

const FEEDBACK_TEXT: Record<FeedbackTier, string> = { good: 'GOOD', great: 'GREAT', perfect: 'PERFECT' };

export class GameEngine {
    private els: GameElements;
    private opts: GameOptions;
    private cfg: GameConfig;
    private poses: PoseFrame[];
    private onSnapshot: (snapshot: GameSnapshot) => void;

    private phase: GamePhase = 'calibration';
    private destroyed = false;
    private rafId: number | null = null;
    private lastDetectMs = -1;
    private mediaStream: MediaStream | null = null;
    private objectUrls: string[] = [];

    private normalization: Normalization = IDENTITY_NORMALIZATION;
    private angleSmoothHistory: Record<string, number> = {};
    private positionSmoothHistory: Record<number, number> = {};
    private scoring: ScoringState = createScoringState();
    private noPose: NoPoseState = createNoPoseState();
    private warningMessage = '';

    private calibrationTime = 0;
    private calibrationFramesHeld = 0;
    private calibrationStatus = 'Loading poses...';
    private calibrationProgress = 0;
    private countdownValue: string | null = null;
    private countdownToken = 0;

    private feedbackSeq = 0;
    private lastFeedback: { seq: number; tier: FeedbackTier; text: string } | null = null;
    private lastFeedbackAtMs = 0;
    private comboDisplayValue = 0;
    private comboVisibleUntilMs = 0;
    private needsUserPlay = false;
    private debugInfo: GameSnapshot['debug'] = null;

    private effects: EffectsEngine;
    private effectsPos = { x: 0.5, y: 0.5, hasInput: false };
    private sounds = new SoundBank();

    constructor(els: GameElements, opts: GameOptions, onSnapshot: (s: GameSnapshot) => void) {
        this.els = els;
        this.opts = opts;
        this.cfg = opts.config;
        this.poses = opts.choreography.poses ?? [];
        this.onSnapshot = onSnapshot;
        this.effects = new EffectsEngine(els.effectsCanvas);
    }

    // ------------------------------------------------------------- lifecycle

    async start(): Promise<void> {
        this.sounds.init();
        const refUrl = URL.createObjectURL(this.opts.referenceVideoFile);
        this.objectUrls.push(refUrl);

        const { referenceVideo, calibrationVideo, inputVideo } = this.els;
        referenceVideo.src = refUrl;
        referenceVideo.loop = false;
        referenceVideo.onended = () => this.handleSongEnded();
        calibrationVideo.src = refUrl;

        await new Promise<void>((resolve, reject) => {
            referenceVideo.onloadedmetadata = () => resolve();
            referenceVideo.onerror = () => reject(new Error('Could not load reference video'));
        });

        if (this.opts.inputMode === 'webcam') {
            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                video: { width: 640, height: 480 },
                audio: false
            });
            inputVideo.srcObject = this.mediaStream;
        } else {
            if (!this.opts.playerVideoFile) throw new Error('No player video selected');
            const playerUrl = URL.createObjectURL(this.opts.playerVideoFile);
            this.objectUrls.push(playerUrl);
            inputVideo.src = playerUrl;
        }
        inputVideo.muted = true;
        inputVideo.playsInline = true;
        await inputVideo.play();

        this.resize();
        this.effects.start();
        this.startCalibration();
        this.startPoseLoop();
    }

    destroy(): void {
        this.destroyed = true;
        this.countdownToken++;
        if (this.rafId !== null) cancelAnimationFrame(this.rafId);
        this.effects.stop();
        this.mediaStream?.getTracks().forEach((track) => track.stop());
        for (const url of this.objectUrls) URL.revokeObjectURL(url);
        this.els.referenceVideo.pause();
        this.els.inputVideo.pause();
    }

    // ------------------------------------------------------------- commands

    startCalibration(): void {
        this.countdownToken++;
        this.phase = 'calibration';
        this.countdownValue = null;
        this.calibrationFramesHeld = 0;
        this.calibrationProgress = 0;
        this.calibrationStatus = "Loading poses... Don't skip yet";
        this.angleSmoothHistory = {};
        this.positionSmoothHistory = {};
        this.normalization = IDENTITY_NORMALIZATION;
        this.noPose = createNoPoseState();
        this.warningMessage = '';

        const { referenceVideo, calibrationVideo } = this.els;
        referenceVideo.pause();
        referenceVideo.currentTime = 0;
        calibrationVideo.pause();
        calibrationVideo.currentTime = 0;
        this.calibrationTime = 0;
        this.emit();
    }

    setCalibrationTime(timeSec: number): void {
        this.calibrationTime = timeSec;
        this.els.calibrationVideo.currentTime = timeSec;
        this.emit();
    }

    skipCalibration(): void {
        if (this.phase !== 'calibration') return;
        this.normalization = IDENTITY_NORMALIZATION;
        void this.beginCountdown();
    }

    togglePlayPause(): void {
        if (this.phase === 'countdown' || this.phase === 'calibration') return;

        if (this.phase === 'playing') {
            this.phase = 'paused';
            this.els.referenceVideo.pause();
            if (this.opts.inputMode === 'video') this.els.inputVideo.pause();
        } else if (this.phase === 'paused' || this.phase === 'ready') {
            const video = this.els.referenceVideo;
            if (video.ended || (Number.isFinite(video.duration) && video.currentTime >= video.duration)) {
                void this.beginCountdown();
                return;
            }
            this.phase = 'playing';
            this.scoring = { ...this.scoring, lastScoreTimeSec: video.currentTime };
            this.noPose = createNoPoseState();
            video.muted = false;
            video.volume = 1;
            void video.play();
            if (this.opts.inputMode === 'video') void this.els.inputVideo.play();
        } else if (this.phase === 'ended') {
            void this.beginCountdown();
            return;
        }
        this.syncEffects();
        this.emit();
    }

    reset(): void {
        this.countdownToken++;
        this.phase = 'ready';
        this.countdownValue = null;
        this.scoring = createScoringState();
        this.noPose = createNoPoseState();
        this.warningMessage = '';
        this.angleSmoothHistory = {};
        this.positionSmoothHistory = {};
        this.comboDisplayValue = 0;
        this.comboVisibleUntilMs = 0;
        this.lastFeedback = null;
        this.lastFeedbackAtMs = 0;

        const { referenceVideo, inputVideo } = this.els;
        referenceVideo.pause();
        referenceVideo.currentTime = 0;
        if (this.opts.inputMode === 'video') {
            inputVideo.pause();
            inputVideo.currentTime = 0;
        }
        this.syncEffects();
        this.emit();
    }

    retry(): void {
        if (this.phase === 'calibration' || this.phase === 'countdown') return;
        void this.beginCountdown();
    }

    /** Resume playback after an autoplay block, from a user gesture. */
    resumePlayback(): void {
        if (!this.needsUserPlay) return;
        this.needsUserPlay = false;
        const video = this.els.referenceVideo;
        video.currentTime = 0;
        void video.play();
        if (this.opts.inputMode === 'video') {
            this.els.inputVideo.currentTime = 0;
            void this.els.inputVideo.play();
        }
        this.scoring = { ...this.scoring, lastScoreTimeSec: 0 };
        this.phase = 'playing';
        this.emit();
    }

    setMirror(enabled: boolean): void {
        this.opts.mirror = enabled;
    }

    setEffectsEnabled(enabled: boolean): void {
        this.opts.effectsEnabled = enabled;
        this.syncEffects();
    }

    setDebugEnabled(enabled: boolean): void {
        this.opts.debugEnabled = enabled;
        if (!enabled) this.debugInfo = null;
    }

    resize(): void {
        const { referenceVideo, gameCanvas, videoContainer, calibrationVideo, calibrationCanvas } = this.els;
        const videoWidth = referenceVideo.videoWidth;
        const videoHeight = referenceVideo.videoHeight;
        if (!videoWidth || !videoHeight) return;

        const availableWidth = Math.min(videoContainer.clientWidth || window.innerWidth, 1200);
        const availableHeight = videoContainer.clientHeight || window.innerHeight;
        const videoAspect = videoWidth / videoHeight;

        let renderWidth: number;
        let renderHeight: number;
        if (availableWidth / availableHeight > videoAspect) {
            renderHeight = availableHeight;
            renderWidth = renderHeight * videoAspect;
        } else {
            renderWidth = availableWidth;
            renderHeight = renderWidth / videoAspect;
        }

        const left = ((videoContainer.clientWidth || renderWidth) - renderWidth) / 2;
        gameCanvas.width = videoWidth;
        gameCanvas.height = videoHeight;

        for (const el of [referenceVideo, gameCanvas] as HTMLElement[]) {
            el.style.width = `${renderWidth}px`;
            el.style.height = `${renderHeight}px`;
            el.style.left = `${left}px`;
            el.style.top = '0px';
        }

        const effectsLayer = this.els.effectsCanvas.parentElement;
        if (effectsLayer) {
            effectsLayer.style.width = `${renderWidth}px`;
            effectsLayer.style.height = `${renderHeight}px`;
            effectsLayer.style.left = `${left}px`;
            effectsLayer.style.top = '0px';
        }
        this.effects.resize(renderWidth, renderHeight);

        if (calibrationVideo.videoWidth) {
            calibrationCanvas.width = calibrationVideo.videoWidth;
            calibrationCanvas.height = calibrationVideo.videoHeight;
        }
    }

    // ------------------------------------------------------------- pose loop

    private startPoseLoop(): void {
        const loop = () => {
            if (this.destroyed) return;
            this.detectAndProcess();
            this.rafId = requestAnimationFrame(loop);
        };
        this.rafId = requestAnimationFrame(loop);
    }

    private detectAndProcess(): void {
        const input = this.els.inputVideo;
        if (input.readyState < 2) return;

        const timestampMs = Math.max(this.lastDetectMs + 1, Math.round(performance.now()));
        this.lastDetectMs = timestampMs;

        let landmarks: RawLandmark[] | null = null;
        try {
            const result = this.opts.landmarker.detectForVideo(input, timestampMs);
            landmarks = (result.landmarks && result.landmarks[0]) || null;
        } catch {
            return; // transient detector failure: skip the frame
        }

        if (landmarks && this.opts.mirror) {
            landmarks = mirrorLandmarks(landmarks, this.cfg.keypointsMirrorSwap);
        }

        if (this.phase === 'calibration') {
            this.processCalibrationFrame(landmarks);
        } else {
            this.processGameFrame(landmarks);
        }
        this.emit();
    }

    // ----------------------------------------------------------- calibration

    private processCalibrationFrame(playerLandmarks: RawLandmark[] | null): void {
        const { calibrationCanvas, calibrationVideo } = this.els;
        const ctx = calibrationCanvas.getContext('2d');
        if (!ctx) return;

        ctx.clearRect(0, 0, calibrationCanvas.width, calibrationCanvas.height);
        if (calibrationVideo.videoWidth) {
            ctx.drawImage(calibrationVideo, 0, 0, calibrationCanvas.width, calibrationCanvas.height);
        }

        const refPose = getReferencePoseAtTime(this.poses, this.calibrationTime, this.cfg.poseTimeToleranceSec);
        if (!refPose) {
            this.calibrationStatus = 'No reference pose found. Try another frame';
            return;
        }

        const refIndexed = toIndexedLandmarks(refPose.landmarks);
        this.drawCalibrationSkeleton(ctx, refIndexed, 'rgba(0, 212, 255, 0.6)');
        if (!playerLandmarks) return;
        this.drawCalibrationSkeleton(ctx, playerLandmarks, '#00ff88');
        this.highlightAlignedJoints(ctx, playerLandmarks, refIndexed);

        const playerAngles = calculateLiveAngles(playerLandmarks, this.cfg.angleJoints);
        const angleResult = compareAngles(playerAngles, refPose.angles ?? {}, this.angleSmoothHistory, {
            angleSmoothing: this.cfg.angleSmoothing,
            matchSimilarity: this.cfg.angleMatchSimilarity,
            similarityRange: this.cfg.angleSimilarityRange,
            allowedMisses: this.cfg.angleAllowedMisses
        });
        const quality = this.overallScore(angleResult, playerLandmarks, refIndexed);

        this.calibrationProgress = Math.round(quality * 100);
        if (quality >= this.cfg.minCalibrationQuality) {
            this.calibrationFramesHeld++;
            this.calibrationStatus = `Good! Hold pose... (${this.calibrationFramesHeld}/${this.cfg.calibrationFrames})`;

            if (this.calibrationFramesHeld >= this.cfg.calibrationFrames) {
                this.normalization = this.cfg.normalizeByTorso && hasTorso(playerLandmarks) && hasTorso(refIndexed)
                    ? calculateNormalization(playerLandmarks, refIndexed, this.cfg.minTorsoSize)
                    : IDENTITY_NORMALIZATION;
                void this.beginCountdown();
            }
        } else {
            this.calibrationFramesHeld = 0;
            this.calibrationStatus = 'Insufficient match. Adjust your pose...';
        }
    }

    private overallScore(
        angleResult: AngleComparison,
        playerLandmarks: IndexedLandmarks,
        refIndexed: IndexedLandmarks
    ): number {
        const { positionWeight, angleWeight } = this.cfg;
        if (positionWeight <= 0) return angleResult.accuracy;

        const positionResult = comparePositions(playerLandmarks, refIndexed, this.positionSmoothHistory, {
            positionSmoothing: this.cfg.positionSmoothing,
            positionThreshold: this.cfg.positionThreshold,
            scoringJoints: this.cfg.scoringJoints
        });
        const weightSum = positionWeight + angleWeight;
        return weightSum > 0
            ? (positionWeight * positionResult.accuracy + angleWeight * angleResult.accuracy) / weightSum
            : angleResult.accuracy;
    }

    private drawCalibrationSkeleton(ctx: CanvasRenderingContext2D, landmarks: IndexedLandmarks, color: string): void {
        const { width, height } = ctx.canvas;
        ctx.lineWidth = 3;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;

        for (const [start, end] of this.cfg.poseConnections) {
            const a = landmarks[start];
            const b = landmarks[end];
            if (!a || !b || (a.visibility ?? 1) < 0.5 || (b.visibility ?? 1) < 0.5) continue;
            ctx.beginPath();
            ctx.moveTo(a.x * width, a.y * height);
            ctx.lineTo(b.x * width, b.y * height);
            ctx.stroke();
        }
        for (const lm of landmarks) {
            if (!lm || (lm.visibility ?? 1) < 0.5) continue;
            ctx.beginPath();
            ctx.arc(lm.x * width, lm.y * height, 5, 0, 2 * Math.PI);
            ctx.fill();
        }
    }

    private highlightAlignedJoints(
        ctx: CanvasRenderingContext2D,
        playerLandmarks: IndexedLandmarks,
        refIndexed: IndexedLandmarks
    ): void {
        const { width, height } = ctx.canvas;
        for (let i = 0; i < playerLandmarks.length; i++) {
            const player = playerLandmarks[i];
            const ref = refIndexed[i];
            if (!player || !ref || (player.visibility ?? 1) < 0.5 || (ref.visibility ?? 1) < 0.5) continue;

            const px = player.x * width;
            const py = player.y * height;
            if (Math.hypot(px - ref.x * width, py - ref.y * height) < 20) {
                ctx.fillStyle = '#ffff00';
                ctx.shadowBlur = 15;
                ctx.shadowColor = '#ffff00';
                ctx.beginPath();
                ctx.arc(px, py, 8, 0, 2 * Math.PI);
                ctx.fill();
                ctx.shadowBlur = 0;
            }
        }
    }

    // ------------------------------------------------------------- countdown

    private async beginCountdown(): Promise<void> {
        const token = ++this.countdownToken;
        this.phase = 'countdown';
        this.scoring = createScoringState();
        this.noPose = createNoPoseState();
        this.warningMessage = '';
        this.comboDisplayValue = 0;
        this.comboVisibleUntilMs = 0;
        this.lastFeedback = null;
        this.lastFeedbackAtMs = 0;
        this.els.referenceVideo.pause();
        this.emit();

        for (const value of ['3', '2', '1']) {
            if (this.countdownToken !== token || this.destroyed) return;
            this.countdownValue = value;
            this.emit();
            await new Promise((resolve) => setTimeout(resolve, 900));
        }
        if (this.countdownToken !== token || this.destroyed) return;

        this.countdownValue = null;
        this.beginPlayback();
    }

    private beginPlayback(): void {
        const video = this.els.referenceVideo;
        this.phase = 'playing';
        this.scoring = createScoringState();
        this.scoring.lastScoreTimeSec = 0;
        video.currentTime = 0;
        video.muted = false;
        video.volume = 1;

        const playPromise = video.play();
        playPromise?.catch(() => {
            this.needsUserPlay = true;
            this.phase = 'ready';
            this.emit();
        });

        if (this.opts.inputMode === 'video') {
            this.els.inputVideo.currentTime = 0;
            void this.els.inputVideo.play();
        }
        this.syncEffects();
        this.emit();
    }

    private handleSongEnded(): void {
        if (this.phase !== 'playing') return;
        this.phase = 'ended';
        if (this.opts.inputMode === 'video') this.els.inputVideo.pause();
        this.syncEffects();
        this.emit();
    }

    // ------------------------------------------------------------- game loop

    private processGameFrame(playerLandmarks: RawLandmark[] | null): void {
        const { gameCanvas } = this.els;
        const ctx = gameCanvas.getContext('2d');
        ctx?.clearRect(0, 0, gameCanvas.width, gameCanvas.height);

        if (this.phase !== 'playing' || !playerLandmarks || playerLandmarks.length === 0) {
            this.syncEffects();
            return;
        }

        const normalized = normalizePose(playerLandmarks, this.normalization);
        const playerAngles = calculateLiveAngles(normalized, this.cfg.angleJoints);
        const nowSec = this.els.referenceVideo.currentTime;

        const refPose = pickBestReferencePose(
            this.poses,
            nowSec,
            this.cfg.poseTimeWindowSec,
            this.cfg.poseTimeToleranceSec,
            normalized,
            playerAngles,
            {
                activeLandmarks: this.cfg.activeLandmarks,
                angleJoints: this.cfg.angleJoints,
                positionThreshold: this.cfg.positionThreshold,
                angleThreshold: this.cfg.angleThreshold,
                positionWeight: this.cfg.positionWeight,
                angleWeight: this.cfg.angleWeight
            },
            (pose) => toIndexedLandmarks(pose.landmarks)
        );
        if (!refPose || !refPose.landmarks || refPose.landmarks.length === 0) return;

        const refIndexed = toIndexedLandmarks(refPose.landmarks);
        const angleResult = compareAngles(playerAngles, refPose.angles ?? {}, this.angleSmoothHistory, {
            angleSmoothing: this.cfg.angleSmoothing,
            matchSimilarity: this.cfg.angleMatchSimilarity,
            similarityRange: this.cfg.angleSimilarityRange,
            allowedMisses: this.cfg.angleAllowedMisses
        });

        let positionResult: PositionComparison | null = null;
        if (this.cfg.positionWeight > 0 || this.opts.debugEnabled) {
            positionResult = comparePositions(normalized, refIndexed, this.positionSmoothHistory, {
                positionSmoothing: this.cfg.positionSmoothing,
                positionThreshold: this.cfg.positionThreshold,
                scoringJoints: this.cfg.scoringJoints
            });
        }

        // Scoring (uses angle accuracy, like the legacy game)
        const referenceDetected = countDetectedAngles(refPose.angles, this.cfg.angleJoints);
        const playerDetected = countDetectedAngles(playerAngles, this.cfg.angleJoints);
        const [noPoseState, noPoseResult] = updateNoPoseState(this.noPose, referenceDetected, playerDetected, nowSec, {
            minReferenceAngles: this.cfg.minReferenceDetectedAngles,
            minPlayerAngles: this.cfg.minPlayerDetectedAngles,
            referenceWarningDelaySec: this.cfg.referenceNoPoseWarningDelaySec,
            playerWarningDelaySec: this.cfg.playerNoPoseWarningDelaySec
        });
        this.noPose = noPoseState;
        this.warningMessage = noPoseResult.warningMessage;

        const [scoring, events] = updateScoring(this.scoring, angleResult.accuracy, nowSec, {
            accuracyThreshold: this.cfg.accuracyThreshold,
            pointsPerSecond: this.cfg.pointsPerSecond,
            comboSeconds: this.cfg.comboSeconds,
            maxCombo: this.cfg.maxCombo
        }, noPoseResult.freezeScoring);
        this.scoring = scoring;

        if (events.comboUp) this.sounds.play('comboUp');
        if (events.comboMax) this.sounds.play('comboMax');
        if (this.scoring.combo > 0) {
            this.comboDisplayValue = this.scoring.combo;
            this.comboVisibleUntilMs = performance.now() + this.cfg.comboIndicatorHoldSec * 1000;
        }

        if (events.aboveThreshold) {
            this.maybeEmitFeedback(this.scoring.currentAccuracy);
        }

        // Debug overlay info + skeleton
        if (this.opts.debugEnabled && ctx) {
            this.updateDebugInfo(angleResult);
            this.drawDebugSkeleton(ctx, playerLandmarks, positionResult);
        }

        this.updateEffectsInput(angleResult, refIndexed);
        this.syncEffects();
    }

    private maybeEmitFeedback(accuracy: number): void {
        const thresholds = resolveFeedbackThresholds(this.cfg.accuracyThreshold, {
            good: this.cfg.feedbackThresholdGood,
            great: this.cfg.feedbackThresholdGreat,
            perfect: this.cfg.feedbackThresholdPerfect
        });
        const tier = getPerformanceTier(accuracy, thresholds);
        if (!tier) return;

        const nowMs = performance.now();
        if (nowMs - this.lastFeedbackAtMs < this.cfg.feedbackIntervalSec * 1000) return;
        this.lastFeedbackAtMs = nowMs;
        this.lastFeedback = { seq: ++this.feedbackSeq, tier, text: FEEDBACK_TEXT[tier] };

        const soundKey = tier === 'perfect' ? 'feedbackPerfect' : tier === 'great' ? 'feedbackGreat' : 'feedbackGood';
        this.sounds.play(soundKey);
    }

    private updateDebugInfo(angleResult: AngleComparison): void {
        const matchNames: string[] = [];
        const missNames: string[] = [];
        for (const [name, isMatch] of Object.entries(angleResult.matches)) {
            const similarity = angleResult.similarities[name];
            const label = similarity === undefined ? name : `${name} ${Math.round(similarity * 100)}%`;
            (isMatch ? matchNames : missNames).push(label);
        }
        this.debugInfo = {
            accuracyPct: Math.round(angleResult.accuracy * 100),
            matchText: matchNames.length ? matchNames.join(', ') : '-',
            missText: missNames.length ? missNames.join(', ') : '-'
        };
    }

    private drawDebugSkeleton(
        ctx: CanvasRenderingContext2D,
        landmarks: IndexedLandmarks,
        positionResult: PositionComparison | null
    ): void {
        const { width, height } = ctx.canvas;
        const matches = positionResult?.matches ?? {};
        ctx.lineWidth = this.cfg.lineThickness;

        for (const [start, end] of this.cfg.poseConnections) {
            const a = landmarks[start];
            const b = landmarks[end];
            if (!a || !b || (a.visibility ?? 1) < 0.5 || (b.visibility ?? 1) < 0.5) continue;

            let color = 'rgba(255, 255, 255, 0.4)';
            if (matches[start] === true && matches[end] === true) color = this.cfg.skeletonColor;
            else if (matches[start] === false || matches[end] === false) color = '#ff0080';

            ctx.strokeStyle = color;
            ctx.beginPath();
            ctx.moveTo(a.x * width, a.y * height);
            ctx.lineTo(b.x * width, b.y * height);
            ctx.stroke();
        }

        for (let i = 0; i < landmarks.length; i++) {
            const lm = landmarks[i];
            if (!lm || (lm.visibility ?? 1) < 0.5) continue;

            let color = 'rgba(255, 255, 255, 0.6)';
            if (matches[i] === true) color = this.cfg.skeletonColor;
            else if (matches[i] === false) color = '#ff0080';

            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(lm.x * width, lm.y * height, 8, 0, 2 * Math.PI);
            ctx.fill();
        }
    }

    // --------------------------------------------------------------- effects

    /** Track the reference dancer's best-matching joint with the trail. */
    private updateEffectsInput(angleResult: AngleComparison, refIndexed: IndexedLandmarks): void {
        let bestAngle: string | null = null;
        let bestScore = -1;
        let bestMatched: string | null = null;
        let bestMatchedScore = -1;

        for (const [name, score] of Object.entries(angleResult.similarities)) {
            if (!Number.isFinite(score)) continue;
            if (angleResult.matches[name] && score > bestMatchedScore) {
                bestMatchedScore = score;
                bestMatched = name;
            }
            if (score > bestScore) {
                bestScore = score;
                bestAngle = name;
            }
        }

        const chosen = bestMatched ?? bestAngle;
        const joint = chosen ? this.cfg.angleJoints[chosen] : undefined;
        let target: { x: number; y: number } | null = null;

        if (joint) {
            const candidates = [joint[2], joint[0], joint[1]];
            const torsoCenter = hasTorso(refIndexed) ? getTorsoCenter(refIndexed) : null;
            let bestDist = -1;
            for (const idx of candidates) {
                const lm = refIndexed[idx];
                if (!lm || (lm.visibility ?? 1) < 0.5) continue;
                if (!torsoCenter) {
                    target = lm;
                    break;
                }
                const dist = (lm.x - torsoCenter.x) ** 2 + (lm.y - torsoCenter.y) ** 2;
                if (dist > bestDist) {
                    bestDist = dist;
                    target = lm;
                }
            }
        }
        if (!target && hasTorso(refIndexed)) target = getTorsoCenter(refIndexed);
        if (!target) {
            this.effectsPos.hasInput = false;
            return;
        }

        const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
        const smooth = 0.45;
        if (this.effectsPos.hasInput) {
            this.effectsPos.x = this.effectsPos.x * (1 - smooth) + clamp01(target.x) * smooth;
            this.effectsPos.y = this.effectsPos.y * (1 - smooth) + clamp01(target.y) * smooth;
        } else {
            this.effectsPos.x = clamp01(target.x);
            this.effectsPos.y = clamp01(target.y);
        }
        this.effectsPos.hasInput = true;
    }

    private syncEffects(): void {
        const accuracy = this.scoring.currentAccuracy;
        const active = this.opts.effectsEnabled &&
            this.phase === 'playing' &&
            accuracy >= this.cfg.accuracyThreshold &&
            this.scoring.combo > 0;

        let strength = 0;
        if (active) {
            const accuracyBoost = Math.max(0, Math.min(1,
                (accuracy - this.cfg.accuracyThreshold) / Math.max(1e-6, 1 - this.cfg.accuracyThreshold)));
            const comboBoost = Math.max(0, Math.min(1, this.scoring.combo / this.cfg.maxCombo));
            strength = Math.max(0.15, accuracyBoost * 0.7 + comboBoost * 0.3);
        }

        this.effects.setState({
            enabled: this.opts.effectsEnabled,
            active,
            strength,
            x: this.effectsPos.x,
            y: this.effectsPos.y,
            hasInput: this.effectsPos.hasInput
        });
        this.els.effectsCanvas.parentElement?.classList.toggle('active', this.opts.effectsEnabled);
    }

    // -------------------------------------------------------------- snapshot

    private emit(): void {
        if (this.destroyed) return;

        const nowMs = performance.now();
        const comboVisible = this.scoring.combo > 0 ||
            (this.comboDisplayValue > 0 && nowMs < this.comboVisibleUntilMs);
        if (!comboVisible) this.comboDisplayValue = 0;

        const refVideo = this.els.referenceVideo;
        this.onSnapshot({
            phase: this.phase,
            hud: {
                score: Math.floor(this.scoring.score),
                combos: this.scoring.combosAchieved,
                accuracyPct: Math.round(Math.max(0, Math.min(1, this.scoring.currentAccuracy)) * 100),
                warning: this.warningMessage
            },
            combo: { value: this.comboDisplayValue, visible: comboVisible },
            feedback: this.lastFeedback,
            countdownValue: this.countdownValue,
            calibration: {
                progressPct: this.calibrationProgress,
                status: this.calibrationStatus,
                currentTimeSec: this.calibrationTime,
                durationSec: Number.isFinite(refVideo.duration) ? refVideo.duration : 0
            },
            stats: this.phase === 'ended'
                ? {
                    score: Math.floor(this.scoring.score),
                    avgAccuracyPct: Math.round(averageAccuracy(this.scoring) * 100),
                    maxCombo: this.scoring.statsMaxCombo,
                    dancedSec: this.scoring.trackedTimeSec > 0
                        ? this.scoring.trackedTimeSec
                        : (Number.isFinite(refVideo.duration) ? refVideo.duration : 0)
                }
                : null,
            debug: this.opts.debugEnabled ? this.debugInfo : null,
            needsUserPlay: this.needsUserPlay
        });
    }
}
