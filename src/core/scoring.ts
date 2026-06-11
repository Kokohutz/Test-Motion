/**
 * Game scoring state machine, ported from the legacy clone_dance.js
 * updateScore/updateNoPoseState. Pure: every update takes the previous
 * state and returns the next state plus the events the UI should react to
 * (sounds, popups), so the whole thing is unit-testable.
 */

export interface ScoringConfig {
    accuracyThreshold: number;
    pointsPerSecond: number;
    comboSeconds: number;
    maxCombo: number;
}

export interface ScoringState {
    score: number;
    combo: number;
    combosAchieved: number;
    currentAccuracy: number;
    lastScoreTimeSec: number | null;
    goodTimeAccumSec: number;
    goodStreakSec: number;
    statsMaxCombo: number;
    accuracyAccum: number;
    trackedTimeSec: number;
}

export interface ScoringEvents {
    comboChanged: boolean;
    comboUp: boolean;
    comboMax: boolean;
    /** Accuracy is at or above the scoring threshold this update. */
    aboveThreshold: boolean;
}

export function createScoringState(): ScoringState {
    return {
        score: 0,
        combo: 0,
        combosAchieved: 0,
        currentAccuracy: 0,
        lastScoreTimeSec: null,
        goodTimeAccumSec: 0,
        goodStreakSec: 0,
        statsMaxCombo: 0,
        accuracyAccum: 0,
        trackedTimeSec: 0
    };
}

/** Reset the per-run counters but keep nothing (fresh song start). */
export function resetForPlayback(state: ScoringState, nowSec: number | null): ScoringState {
    return {
        ...state,
        combo: 0,
        combosAchieved: 0,
        goodTimeAccumSec: 0,
        goodStreakSec: 0,
        lastScoreTimeSec: nowSec
    };
}

const NO_EVENTS: ScoringEvents = { comboChanged: false, comboUp: false, comboMax: false, aboveThreshold: false };

export function updateScoring(
    state: ScoringState,
    accuracy: number,
    nowSec: number,
    cfg: ScoringConfig,
    freezeScoring = false
): [ScoringState, ScoringEvents] {
    if (freezeScoring) {
        const next = Number.isFinite(nowSec) ? { ...state, lastScoreTimeSec: nowSec } : state;
        return [next, NO_EVENTS];
    }

    const currentAccuracy = Number.isFinite(accuracy) ? accuracy : 0;

    if (!Number.isFinite(nowSec)) {
        return [{ ...state, currentAccuracy }, NO_EVENTS];
    }
    if (state.lastScoreTimeSec === null || nowSec < state.lastScoreTimeSec) {
        return [{ ...state, currentAccuracy, lastScoreTimeSec: nowSec }, NO_EVENTS];
    }

    const delta = nowSec - state.lastScoreTimeSec;
    if (delta <= 0) {
        return [{ ...state, currentAccuracy, lastScoreTimeSec: nowSec }, NO_EVENTS];
    }

    const next: ScoringState = {
        ...state,
        currentAccuracy,
        lastScoreTimeSec: nowSec,
        accuracyAccum: state.accuracyAccum + currentAccuracy * delta,
        trackedTimeSec: state.trackedTimeSec + delta
    };

    if (currentAccuracy >= cfg.accuracyThreshold) {
        next.goodTimeAccumSec += delta;
        next.goodStreakSec += delta;

        while (next.goodTimeAccumSec >= 1) {
            next.score += cfg.pointsPerSecond;
            next.goodTimeAccumSec -= 1;
        }

        const newCombo = Math.min(cfg.maxCombo, Math.floor(next.goodStreakSec / cfg.comboSeconds));
        const previousCombo = next.combo;
        const comboChanged = newCombo !== previousCombo;
        if (comboChanged) {
            next.combo = newCombo;
            if (previousCombo === 0 && newCombo > 0) {
                next.combosAchieved += 1;
            }
        }
        next.statsMaxCombo = Math.max(next.statsMaxCombo, next.combo);

        const comboRose = comboChanged && newCombo > previousCombo && newCombo > 0;
        return [next, {
            comboChanged,
            comboUp: comboRose && newCombo < cfg.maxCombo,
            comboMax: comboRose && newCombo >= cfg.maxCombo,
            aboveThreshold: true
        }];
    }

    const comboChanged = next.combo !== 0;
    next.goodTimeAccumSec = 0;
    next.goodStreakSec = 0;
    next.combo = 0;
    return [next, { comboChanged, comboUp: false, comboMax: false, aboveThreshold: false }];
}

export function averageAccuracy(state: ScoringState): number {
    if (state.trackedTimeSec <= 0) return Math.max(0, Math.min(1, state.currentAccuracy));
    return Math.max(0, Math.min(1, state.accuracyAccum / state.trackedTimeSec));
}

// ---------------------------------------------------------------------------
// Performance feedback tiers (GOOD / GREAT / PERFECT)

export type FeedbackTier = 'good' | 'great' | 'perfect';

export interface FeedbackThresholds {
    good: number;
    great: number;
    perfect: number;
}

export function resolveFeedbackThresholds(
    accuracyThreshold: number,
    configured: Partial<FeedbackThresholds> = {}
): FeedbackThresholds {
    const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
    const good = clamp01(Number.isFinite(configured.good) ? configured.good! : accuracyThreshold);
    const great = clamp01(Math.max(Number.isFinite(configured.great) ? configured.great! : Math.max(good + 0.1, 0.8), good));
    const perfect = clamp01(Math.max(Number.isFinite(configured.perfect) ? configured.perfect! : Math.max(great + 0.08, 0.9), great));
    return { good, great, perfect };
}

export function getPerformanceTier(accuracy: number, thresholds: FeedbackThresholds): FeedbackTier | null {
    if (!Number.isFinite(accuracy)) return null;
    if (accuracy >= thresholds.perfect) return 'perfect';
    if (accuracy >= thresholds.great) return 'great';
    if (accuracy >= thresholds.good) return 'good';
    return null;
}

// ---------------------------------------------------------------------------
// No-pose warning state machine

export interface NoPoseConfig {
    minReferenceAngles: number;
    minPlayerAngles: number;
    referenceWarningDelaySec: number;
    playerWarningDelaySec: number;
}

export interface NoPoseState {
    referenceLowSinceSec: number | null;
    playerLowSinceSec: number | null;
}

export interface NoPoseResult {
    freezeScoring: boolean;
    warningMessage: string;
}

export function createNoPoseState(): NoPoseState {
    return { referenceLowSinceSec: null, playerLowSinceSec: null };
}

export function updateNoPoseState(
    state: NoPoseState,
    referenceDetectedAngles: number,
    playerDetectedAngles: number,
    nowSec: number,
    cfg: NoPoseConfig
): [NoPoseState, NoPoseResult] {
    const referenceInsufficient = referenceDetectedAngles < cfg.minReferenceAngles;
    const playerInsufficient = playerDetectedAngles < cfg.minPlayerAngles;

    const next: NoPoseState = {
        referenceLowSinceSec: referenceInsufficient
            ? (state.referenceLowSinceSec ?? (Number.isFinite(nowSec) ? nowSec : null))
            : null,
        playerLowSinceSec: playerInsufficient
            ? (state.playerLowSinceSec ?? (Number.isFinite(nowSec) ? nowSec : null))
            : null
    };

    const warnings: string[] = [];
    if (referenceInsufficient && next.referenceLowSinceSec !== null &&
        Number.isFinite(nowSec) && nowSec - next.referenceLowSinceSec >= cfg.referenceWarningDelaySec) {
        warnings.push('TOO FEW POSES IN REFERENCE VIDEO');
    }
    if (playerInsufficient && next.playerLowSinceSec !== null &&
        Number.isFinite(nowSec) && nowSec - next.playerLowSinceSec >= cfg.playerWarningDelaySec) {
        warnings.push('TOO FEW POSES IN YOUR VIDEO');
    }

    return [next, {
        freezeScoring: referenceInsufficient || playerInsufficient,
        warningMessage: warnings.join(' | ')
    }];
}
