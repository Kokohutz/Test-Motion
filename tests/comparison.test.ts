/**
 * Unit tests for the live pose comparison logic (src/core/comparison.ts).
 */

import { describe, expect, test } from 'vitest';
import {
    IDENTITY_NORMALIZATION,
    calculateLiveAngles,
    calculateNormalization,
    compareAngles,
    comparePositions,
    countDetectedAngles,
    getReferencePoseAtTime,
    getReferencePosesInWindow,
    mirrorLandmarks,
    normalizePose,
    pickBestReferencePose
} from '../src/core/comparison';
import { DEFAULT_ANGLE_JOINTS } from '../src/core/choreography';
import { toIndexedLandmarks } from '../src/core/drawing';
import { resolveGameConfig } from '../src/core/gameConfig';
import type { PoseFrame, RawLandmark } from '../src/core/types';

function fullBody(): RawLandmark[] {
    return Array.from({ length: 33 }, (_, i) => ({ x: 0.3 + i * 0.01, y: 0.3 + i * 0.01, z: 0, visibility: 1 }));
}

function poseFrame(timestamp: number, angles: Record<string, number | null> = {}): PoseFrame {
    return {
        timestamp,
        frame: Math.round(timestamp * 30),
        landmarks: [{ id: 11, x: 0.4, y: 0.4, z: 0, visibility: 1 }],
        angles
    };
}

describe('mirrorLandmarks', () => {
    test('flips x and swaps left/right identities', () => {
        const landmarks = fullBody();
        landmarks[11] = { x: 0.3, y: 0.5, z: 0, visibility: 1 };
        landmarks[12] = { x: 0.7, y: 0.5, z: 0, visibility: 1 };

        const mirrored = mirrorLandmarks(landmarks, [[11, 12]]);
        // After flip, old 11 (x=0.3) is at x=0.7 and now sits in slot 12
        expect(mirrored[12].x).toBeCloseTo(0.7);
        expect(mirrored[11].x).toBeCloseTo(0.3);
        expect(landmarks[11].x).toBe(0.3); // source untouched
    });
});

describe('normalization', () => {
    test('maps the player torso onto the reference torso', () => {
        // Player torso: half the size of the reference, offset position
        const player = fullBody();
        player[11] = { x: 0.2, y: 0.2, z: 0, visibility: 1 };
        player[12] = { x: 0.3, y: 0.2, z: 0, visibility: 1 };
        player[23] = { x: 0.2, y: 0.35, z: 0, visibility: 1 };
        player[24] = { x: 0.3, y: 0.35, z: 0, visibility: 1 };

        const reference = fullBody();
        reference[11] = { x: 0.4, y: 0.3, z: 0, visibility: 1 };
        reference[12] = { x: 0.6, y: 0.3, z: 0, visibility: 1 };
        reference[23] = { x: 0.4, y: 0.6, z: 0, visibility: 1 };
        reference[24] = { x: 0.6, y: 0.6, z: 0, visibility: 1 };

        const n = calculateNormalization(player, reference, 0.01);
        expect(n.scaleX).toBe(n.scaleY);
        expect(n.scaleX).toBeCloseTo(2, 1); // ref torso is 2x the player's

        const normalized = normalizePose(player, n);
        const center = {
            x: (normalized[11].x + normalized[12].x + normalized[23].x + normalized[24].x) / 4,
            y: (normalized[11].y + normalized[12].y + normalized[23].y + normalized[24].y) / 4
        };
        expect(center.x).toBeCloseTo(0.5, 5); // torso centers now coincide
        expect(center.y).toBeCloseTo(0.45, 5);
    });

    test('identity normalization is a no-op', () => {
        const player = fullBody();
        const normalized = normalizePose(player, IDENTITY_NORMALIZATION);
        expect(normalized[5].x).toBeCloseTo(player[5].x);
        expect(normalized[5].y).toBeCloseTo(player[5].y);
    });
});

describe('compareAngles', () => {
    const cfg = { angleSmoothing: 1, matchSimilarity: 0.95, similarityRange: 150, allowedMisses: 2 };

    test('identical angles are a perfect match', () => {
        const angles = { left_elbow: 90, right_elbow: 120, left_knee: 170 };
        const result = compareAngles(angles, angles, {}, cfg);
        expect(result.accuracy).toBe(1);
        expect(result.matchedCount).toBe(3);
    });

    test('a large angle difference is a miss; allowedMisses forgives it', () => {
        const player = { left_elbow: 90, right_elbow: 120, left_knee: 170 };
        const ref = { left_elbow: 90, right_elbow: 120, left_knee: 30 }; // 140 deg off
        const result = compareAngles(player, ref, {}, cfg);
        expect(result.matches.left_knee).toBe(false);
        // 2 matched / max(1, 3-2 allowed misses) = 2 → clamped to 1
        expect(result.accuracy).toBe(1);
    });

    test('null player angles count as misses', () => {
        const result = compareAngles({ left_elbow: null }, { left_elbow: 90 }, {}, cfg);
        expect(result.matches.left_elbow).toBe(false);
        expect(result.similarities.left_elbow).toBe(0);
    });

    test('null reference angles are skipped entirely', () => {
        const result = compareAngles({ left_elbow: 90 }, { left_elbow: null }, {}, cfg);
        expect(result.totalAngles).toBe(0);
        expect(result.accuracy).toBe(0);
    });

    test('EMA smoothing dampens a sudden player jump', () => {
        const history: Record<string, number> = {};
        const smoothCfg = { ...cfg, angleSmoothing: 0.4 };
        compareAngles({ left_elbow: 100 }, { left_elbow: 100 }, history, smoothCfg);
        const result = compareAngles({ left_elbow: 180 }, { left_elbow: 100 }, history, smoothCfg);
        // smoothed = 0.4*180 + 0.6*100 = 132 → diff 32, not 80
        expect(result.diffs.left_elbow).toBeCloseTo(32, 5);
    });
});

describe('comparePositions', () => {
    test('matching joints within threshold, visibility-gated', () => {
        const player = fullBody();
        const ref = fullBody();
        ref[11] = { ...ref[11], x: ref[11].x + 0.5 }; // far off
        ref[12] = { ...ref[12], visibility: 0.1 };    // invisible

        const result = comparePositions(player, ref, {}, {
            positionSmoothing: 1,
            positionThreshold: 0.15,
            scoringJoints: [0, 11, 12, 13]
        });
        expect(result.matches[0]).toBe(true);
        expect(result.matches[11]).toBe(false);
        expect(result.matches[12]).toBeNull();
        expect(result.totalJoints).toBe(3); // 12 excluded
    });
});

describe('calculateLiveAngles / countDetectedAngles', () => {
    test('computes angles from raw landmarks and counts detections', () => {
        const landmarks = fullBody();
        const angles = calculateLiveAngles(landmarks, DEFAULT_ANGLE_JOINTS);
        expect(Object.keys(angles).sort()).toEqual(Object.keys(DEFAULT_ANGLE_JOINTS).sort());
        expect(countDetectedAngles(angles, DEFAULT_ANGLE_JOINTS)).toBeGreaterThan(0);
        expect(countDetectedAngles(undefined, DEFAULT_ANGLE_JOINTS)).toBe(0);
    });
});

describe('reference pose lookup', () => {
    const poses = [poseFrame(0), poseFrame(0.5), poseFrame(1), poseFrame(1.5), poseFrame(2)];

    test('finds the closest pose within tolerance', () => {
        expect(getReferencePoseAtTime(poses, 1.1, 0.5)?.timestamp).toBe(1);
        expect(getReferencePoseAtTime(poses, 9, 0.5)).toBeNull();
    });

    test('window query returns only poses inside the window', () => {
        const inWindow = getReferencePosesInWindow(poses, 1, 0.45);
        expect(inWindow.map((p) => p.timestamp)).toEqual([1]);
        const wider = getReferencePosesInWindow(poses, 1, 0.55);
        expect(wider.map((p) => p.timestamp)).toEqual([0.5, 1, 1.5]);
    });

    test('pickBestReferencePose prefers the candidate matching the player angles', () => {
        const cfg = resolveGameConfig(null, 'medium');
        const player = fullBody();
        const playerAngles = { left_elbow: 90 };

        const candidates = [
            { ...poseFrame(0.9, { left_elbow: 30 }), landmarks: [{ id: 11, x: 0.31, y: 0.31, z: 0, visibility: 1 }] },
            { ...poseFrame(1.0, { left_elbow: 91 }), landmarks: [{ id: 11, x: 0.41, y: 0.41, z: 0, visibility: 1 }] }
        ];

        const best = pickBestReferencePose(
            candidates, 1, 0.3, 0.5, player, playerAngles,
            {
                activeLandmarks: [11],
                angleJoints: { left_elbow: DEFAULT_ANGLE_JOINTS.left_elbow },
                positionThreshold: cfg.positionThreshold,
                angleThreshold: cfg.angleThreshold,
                positionWeight: 0,
                angleWeight: 1
            },
            (pose) => toIndexedLandmarks(pose.landmarks)
        );
        expect(best?.timestamp).toBe(1.0); // angle match wins over the earlier pose
    });
});
