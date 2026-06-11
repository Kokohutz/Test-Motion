/**
 * Unit tests for the game scoring state machine (src/core/scoring.ts).
 */

import { describe, expect, test } from 'vitest';
import {
    averageAccuracy,
    createNoPoseState,
    createScoringState,
    getPerformanceTier,
    resolveFeedbackThresholds,
    updateNoPoseState,
    updateScoring
} from '../src/core/scoring';
import type { ScoringConfig, ScoringState } from '../src/core/scoring';

const CFG: ScoringConfig = {
    accuracyThreshold: 0.7,
    pointsPerSecond: 100,
    comboSeconds: 2,
    maxCombo: 4
};

/** Run updates at a fixed accuracy from t=start to t=end in steps. */
function run(state: ScoringState, accuracy: number, startSec: number, endSec: number, stepSec = 0.1): ScoringState {
    let s = state;
    for (let t = startSec; t <= endSec + 1e-9; t += stepSec) {
        [s] = updateScoring(s, accuracy, t, CFG);
    }
    return s;
}

describe('updateScoring', () => {
    test('first update only anchors the clock', () => {
        const [s, events] = updateScoring(createScoringState(), 0.9, 5, CFG);
        expect(s.score).toBe(0);
        expect(s.lastScoreTimeSec).toBe(5);
        expect(events.comboChanged).toBe(false);
    });

    test('awards pointsPerSecond for each full second above the threshold', () => {
        const s = run(createScoringState(), 0.9, 0, 3.05);
        expect(s.score).toBe(300);
    });

    test('no points below the threshold', () => {
        const s = run(createScoringState(), 0.5, 0, 3);
        expect(s.score).toBe(0);
        expect(s.combo).toBe(0);
        expect(s.trackedTimeSec).toBeGreaterThan(2.9); // time still tracked for stats
    });

    test('combo builds per comboSeconds of streak and caps at maxCombo', () => {
        const s = run(createScoringState(), 0.9, 0, 9);
        expect(s.combo).toBe(CFG.maxCombo); // 9s streak / 2s = 4 (capped)
        expect(s.statsMaxCombo).toBe(CFG.maxCombo);
        expect(s.combosAchieved).toBe(1); // one unbroken streak
    });

    test('dropping below the threshold resets the streak and combo', () => {
        let s = run(createScoringState(), 0.9, 0, 4.05); // combo 2
        expect(s.combo).toBe(2);
        [s] = updateScoring(s, 0.1, 4.2, CFG);
        expect(s.combo).toBe(0);
        expect(s.goodStreakSec).toBe(0);

        // Recovering starts a second combo run
        s = run(s, 0.9, 4.3, 8.5);
        expect(s.combo).toBeGreaterThan(0);
        expect(s.combosAchieved).toBe(2);
    });

    test('comboUp/comboMax events fire when the combo rises', () => {
        let s = createScoringState();
        const seen: string[] = [];
        for (let t = 0; t <= 9; t += 0.1) {
            const [next, events] = updateScoring(s, 0.95, t, CFG);
            s = next;
            if (events.comboUp) seen.push('up');
            if (events.comboMax) seen.push('max');
        }
        expect(seen).toEqual(['up', 'up', 'up', 'max']); // combos 1,2,3 then 4=max
    });

    test('freezeScoring keeps score/combo and re-anchors the clock', () => {
        let s = run(createScoringState(), 0.9, 0, 2.05);
        const before = { score: s.score, combo: s.combo };
        [s] = updateScoring(s, 0, 10, CFG, true); // long gap with no pose
        expect(s.score).toBe(before.score);
        expect(s.combo).toBe(before.combo);
        expect(s.lastScoreTimeSec).toBe(10); // no retroactive delta on resume
    });

    test('time going backwards (seek) re-anchors instead of scoring', () => {
        let s = run(createScoringState(), 0.9, 0, 2);
        const scoreBefore = s.score;
        [s] = updateScoring(s, 0.9, 0.5, CFG);
        expect(s.score).toBe(scoreBefore);
        expect(s.lastScoreTimeSec).toBe(0.5);
    });

    test('averageAccuracy is the time-weighted mean', () => {
        let s = run(createScoringState(), 1.0, 0, 1);     // 1s at 100%
        s = run(s, 0.0, 1.1, 2.1);                        // ~1s at 0%
        expect(averageAccuracy(s)).toBeGreaterThan(0.4);
        expect(averageAccuracy(s)).toBeLessThan(0.6);
    });
});

describe('feedback tiers', () => {
    const thresholds = resolveFeedbackThresholds(0.7, { good: 0.72, great: 0.83, perfect: 0.92 });

    test('maps accuracy to the configured tier', () => {
        expect(getPerformanceTier(0.5, thresholds)).toBeNull();
        expect(getPerformanceTier(0.75, thresholds)).toBe('good');
        expect(getPerformanceTier(0.85, thresholds)).toBe('great');
        expect(getPerformanceTier(0.95, thresholds)).toBe('perfect');
    });

    test('unconfigured thresholds derive from the accuracy threshold, ordered', () => {
        const derived = resolveFeedbackThresholds(0.6, {});
        expect(derived.good).toBe(0.6);
        expect(derived.great).toBeGreaterThanOrEqual(derived.good);
        expect(derived.perfect).toBeGreaterThanOrEqual(derived.great);
    });
});

describe('no-pose warnings', () => {
    const cfg = {
        minReferenceAngles: 7,
        minPlayerAngles: 7,
        referenceWarningDelaySec: 5,
        playerWarningDelaySec: 2
    };

    test('freezes scoring immediately but warns only after the delay', () => {
        let state = createNoPoseState();
        let result;

        [state, result] = updateNoPoseState(state, 8, 3, 10, cfg); // player lost
        expect(result.freezeScoring).toBe(true);
        expect(result.warningMessage).toBe('');

        [state, result] = updateNoPoseState(state, 8, 3, 12.5, cfg); // 2.5s later
        expect(result.warningMessage).toContain('YOUR VIDEO');
    });

    test('recovering clears the warning timer', () => {
        let state = createNoPoseState();
        [state] = updateNoPoseState(state, 8, 3, 10, cfg);
        [state] = updateNoPoseState(state, 8, 8, 11, cfg); // recovered
        const [, result] = updateNoPoseState(state, 8, 3, 11.5, cfg); // lost again
        expect(result.freezeScoring).toBe(true);
        expect(result.warningMessage).toBe(''); // timer restarted at 11.5
    });

    test('both warnings combine', () => {
        let state = createNoPoseState();
        [state] = updateNoPoseState(state, 0, 0, 0, cfg);
        const [, result] = updateNoPoseState(state, 0, 0, 6, cfg);
        expect(result.warningMessage).toContain('REFERENCE VIDEO');
        expect(result.warningMessage).toContain('YOUR VIDEO');
    });
});
