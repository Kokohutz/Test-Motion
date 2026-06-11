/**
 * Resolves config.json's game section plus a difficulty preset into one
 * typed, defaulted GameConfig struct that the game engine consumes.
 */

import { DEFAULT_ACTIVE_LANDMARKS, DEFAULT_ANGLE_JOINTS, DEFAULT_POSE_CONNECTIONS } from './choreography';
import type { AngleJointMap, AppConfig, ModelComplexity } from './types';

export const DIFFICULTY_KEYS = ['easy', 'medium', 'expert'] as const;
export type DifficultyKey = (typeof DIFFICULTY_KEYS)[number];

export const DIFFICULTY_LABELS: Record<DifficultyKey, string> = {
    easy: 'Easy',
    medium: 'Medium',
    expert: 'Expert'
};

export interface DifficultyPreset {
    SCORE_ACCURACY_THRESHOLD: number;
    SCORE_POINTS_PER_SECOND: number;
    COMBO_SECONDS: number;
    MAX_COMBO: number;
    PERFORMANCE_FEEDBACK_INTERVAL_SEC: number;
    PERFORMANCE_FEEDBACK_THRESHOLD_GOOD: number;
    PERFORMANCE_FEEDBACK_THRESHOLD_GREAT: number;
    PERFORMANCE_FEEDBACK_THRESHOLD_PERFECT: number;
    VISUAL_FEEDBACK_SCALE: number;
    VISUAL_FEEDBACK_ANIMATION_SEC: number;
    VISUAL_COMBO_PULSE_SCALE: number;
}

export const DIFFICULTY_FALLBACK_PRESETS: Record<DifficultyKey, DifficultyPreset> = {
    easy: {
        SCORE_ACCURACY_THRESHOLD: 0.62,
        SCORE_POINTS_PER_SECOND: 90,
        COMBO_SECONDS: 1.35,
        MAX_COMBO: 4,
        PERFORMANCE_FEEDBACK_INTERVAL_SEC: 1.0,
        PERFORMANCE_FEEDBACK_THRESHOLD_GOOD: 0.62,
        PERFORMANCE_FEEDBACK_THRESHOLD_GREAT: 0.74,
        PERFORMANCE_FEEDBACK_THRESHOLD_PERFECT: 0.85,
        VISUAL_FEEDBACK_SCALE: 0.9,
        VISUAL_FEEDBACK_ANIMATION_SEC: 0.62,
        VISUAL_COMBO_PULSE_SCALE: 1.05
    },
    medium: {
        SCORE_ACCURACY_THRESHOLD: 0.72,
        SCORE_POINTS_PER_SECOND: 120,
        COMBO_SECONDS: 2.0,
        MAX_COMBO: 6,
        PERFORMANCE_FEEDBACK_INTERVAL_SEC: 0.7,
        PERFORMANCE_FEEDBACK_THRESHOLD_GOOD: 0.72,
        PERFORMANCE_FEEDBACK_THRESHOLD_GREAT: 0.83,
        PERFORMANCE_FEEDBACK_THRESHOLD_PERFECT: 0.92,
        VISUAL_FEEDBACK_SCALE: 1,
        VISUAL_FEEDBACK_ANIMATION_SEC: 0.72,
        VISUAL_COMBO_PULSE_SCALE: 1.1
    },
    expert: {
        SCORE_ACCURACY_THRESHOLD: 0.84,
        SCORE_POINTS_PER_SECOND: 170,
        COMBO_SECONDS: 2.6,
        MAX_COMBO: 9,
        PERFORMANCE_FEEDBACK_INTERVAL_SEC: 0.45,
        PERFORMANCE_FEEDBACK_THRESHOLD_GOOD: 0.84,
        PERFORMANCE_FEEDBACK_THRESHOLD_GREAT: 0.91,
        PERFORMANCE_FEEDBACK_THRESHOLD_PERFECT: 0.97,
        VISUAL_FEEDBACK_SCALE: 1.2,
        VISUAL_FEEDBACK_ANIMATION_SEC: 0.95,
        VISUAL_COMBO_PULSE_SCALE: 1.16
    }
};

/** Fully-resolved configuration the game engine runs on. */
export interface GameConfig {
    difficulty: DifficultyKey;
    // comparison
    positionSmoothing: number;
    angleSmoothing: number;
    positionWeight: number;
    angleWeight: number;
    positionThreshold: number;
    angleThreshold: number;
    angleMatchSimilarity: number;
    angleSimilarityRange: number;
    angleAllowedMisses: number;
    poseTimeToleranceSec: number;
    poseTimeWindowSec: number;
    // scoring & feedback
    accuracyThreshold: number;
    pointsPerSecond: number;
    comboSeconds: number;
    maxCombo: number;
    feedbackIntervalSec: number;
    feedbackThresholdGood: number;
    feedbackThresholdGreat: number;
    feedbackThresholdPerfect: number;
    comboIndicatorHoldSec: number;
    controlsIdleHideSec: number;
    visualFeedbackScale: number;
    visualFeedbackAnimationSec: number;
    visualComboPulseScale: number;
    // no-pose warnings
    minReferenceDetectedAngles: number;
    minPlayerDetectedAngles: number;
    referenceNoPoseWarningDelaySec: number;
    playerNoPoseWarningDelaySec: number;
    // calibration
    minCalibrationQuality: number;
    calibrationFrames: number;
    normalizeByTorso: boolean;
    minTorsoSize: number;
    // drawing
    skeletonColor: string;
    lineThickness: number;
    scoringJoints: number[];
    poseConnections: [number, number][];
    // landmarks
    activeLandmarks: number[];
    angleJoints: AngleJointMap;
    keypointsMirrorSwap: [number, number][];
    // pose model
    modelComplexity: ModelComplexity;
    // defaults for toggles
    mirrorInputDefault: boolean;
    effectsEnabledDefault: boolean;
}

function num(value: unknown, fallback: number): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

export function resolveDifficultyKey(value: unknown, fallback: DifficultyKey = 'medium'): DifficultyKey {
    const normalized = String(value ?? '').trim().toLowerCase();
    return (DIFFICULTY_KEYS as readonly string[]).includes(normalized) ? (normalized as DifficultyKey) : fallback;
}

export function getDifficultyPresets(appConfig: AppConfig | null): Record<DifficultyKey, DifficultyPreset> {
    const raw = (appConfig?.game?.DIFFICULTY_PRESETS ?? {}) as Record<string, Partial<DifficultyPreset>>;
    const presets = {} as Record<DifficultyKey, DifficultyPreset>;
    for (const key of DIFFICULTY_KEYS) {
        presets[key] = { ...DIFFICULTY_FALLBACK_PRESETS[key], ...(raw[key] ?? {}) };
    }
    return presets;
}

const MODEL_COMPLEXITY_BY_INDEX: ModelComplexity[] = ['lite', 'full', 'heavy'];

export function resolveGameConfig(
    appConfig: AppConfig | null,
    difficulty: DifficultyKey,
    presetOverride?: Partial<DifficultyPreset>
): GameConfig {
    const common = (appConfig?.common ?? {}) as Record<string, unknown>;
    const game = (appConfig?.game ?? {}) as Record<string, unknown>;
    const preset: DifficultyPreset = {
        ...getDifficultyPresets(appConfig)[difficulty],
        ...(presetOverride ?? {})
    };

    return {
        difficulty,

        positionSmoothing: num(game.POSITION_SMOOTHING, 0.3),
        angleSmoothing: num(game.ANGLE_SMOOTHING, 0.4),
        positionWeight: num(game.POSITION_WEIGHT, 0),
        angleWeight: num(game.ANGLE_WEIGHT, 1),
        positionThreshold: num(game.POSITION_THRESHOLD, 0.15),
        angleThreshold: num(game.ANGLE_THRESHOLD, 20),
        angleMatchSimilarity: num(game.ANGLE_MATCH_SIMILARITY, 0.9),
        angleSimilarityRange: num(game.ANGLE_SIMILARITY_RANGE, 180),
        angleAllowedMisses: num(game.ANGLE_ALLOWED_MISSES, 2),
        poseTimeToleranceSec: num(common.POSE_TIME_TOLERANCE_SEC, 0.5),
        poseTimeWindowSec: num(game.POSE_TIME_WINDOW, 0.3),

        accuracyThreshold: num(preset.SCORE_ACCURACY_THRESHOLD, 0.7),
        pointsPerSecond: num(preset.SCORE_POINTS_PER_SECOND, 100),
        comboSeconds: Math.max(0.1, num(preset.COMBO_SECONDS, 2)),
        maxCombo: Math.max(1, Math.round(num(preset.MAX_COMBO, 5))),
        feedbackIntervalSec: Math.max(0, num(preset.PERFORMANCE_FEEDBACK_INTERVAL_SEC, 0.5)),
        feedbackThresholdGood: num(preset.PERFORMANCE_FEEDBACK_THRESHOLD_GOOD, 0.72),
        feedbackThresholdGreat: num(preset.PERFORMANCE_FEEDBACK_THRESHOLD_GREAT, 0.83),
        feedbackThresholdPerfect: num(preset.PERFORMANCE_FEEDBACK_THRESHOLD_PERFECT, 0.92),
        comboIndicatorHoldSec: Math.max(0, num(game.COMBO_INDICATOR_HOLD_SEC, 0.8)),
        controlsIdleHideSec: Math.max(0, num(game.CONTROLS_IDLE_HIDE_SEC, 1.5)),
        visualFeedbackScale: num(preset.VISUAL_FEEDBACK_SCALE, 1),
        visualFeedbackAnimationSec: num(preset.VISUAL_FEEDBACK_ANIMATION_SEC, 0.72),
        visualComboPulseScale: num(preset.VISUAL_COMBO_PULSE_SCALE, 1.1),

        minReferenceDetectedAngles: num(game.MIN_REFERENCE_DETECTED_ANGLES_FOR_SCORING, 1),
        minPlayerDetectedAngles: num(game.MIN_PLAYER_DETECTED_ANGLES_FOR_SCORING, 1),
        referenceNoPoseWarningDelaySec: num(game.REFERENCE_NO_POSE_WARNING_DELAY_SEC, 2),
        playerNoPoseWarningDelaySec: num(game.PLAYER_NO_POSE_WARNING_DELAY_SEC, 2),

        minCalibrationQuality: num(game.MIN_CALIBRATION_QUALITY, 0.7),
        calibrationFrames: Math.max(1, Math.round(num(game.CALIBRATION_FRAMES, 90))),
        normalizeByTorso: bool(common.NORMALIZE_BY_TORSO, true),
        minTorsoSize: num(common.MIN_TORSO_SIZE, 0.01),

        skeletonColor: typeof game.SKELETON_COLOR === 'string' ? game.SKELETON_COLOR : '#00ff88',
        lineThickness: num(game.LINE_THICKNESS, 3),
        scoringJoints: Array.isArray(game.SCORING_JOINTS) ? (game.SCORING_JOINTS as number[]) : DEFAULT_ACTIVE_LANDMARKS,
        poseConnections: Array.isArray(game.POSE_CONNECTIONS)
            ? (game.POSE_CONNECTIONS as [number, number][])
            : DEFAULT_POSE_CONNECTIONS,

        activeLandmarks: Array.isArray(common.ACTIVE_LANDMARKS) ? (common.ACTIVE_LANDMARKS as number[]) : DEFAULT_ACTIVE_LANDMARKS,
        angleJoints: (common.ANGLE_JOINTS as AngleJointMap) ?? DEFAULT_ANGLE_JOINTS,
        keypointsMirrorSwap: Array.isArray(common.KEYPOINTS_MIRROR_SWAP)
            ? (common.KEYPOINTS_MIRROR_SWAP as [number, number][])
            : [],

        modelComplexity: MODEL_COMPLEXITY_BY_INDEX[Math.round(num(game.MEDIAPIPE_MODEL_COMPLEXITY, 1))] ?? 'full',

        mirrorInputDefault: bool(game.MIRROR_INPUT_DEFAULT, false),
        effectsEnabledDefault: bool(game.EFFECTS_ENABLED_DEFAULT, false)
    };
}
