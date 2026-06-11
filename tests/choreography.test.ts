/**
 * Unit tests for the pure choreography-building logic (src/core/choreography.ts).
 * Run with: npm test
 */

import { describe, expect, test } from 'vitest';
import {
    BEATMAP_ANGLE_NAMES,
    DEFAULT_ACTIVE_LANDMARKS,
    DEFAULT_ANGLE_JOINTS,
    DEFAULT_POSE_CONNECTIONS,
    VISIBILITY_THRESHOLD,
    buildBeatmap,
    buildLegacyChoreography,
    calculateAngles,
    computeAngle2D,
    computeDominantJoints,
    mirrorLegacyChoreography,
    round,
    sanitizeFileName,
    serializeLandmarks
} from '../src/core/choreography';
import type { PoseFrame, RawLandmark } from '../src/core/types';

/** Build a full 33-landmark array with every point visible. */
function makeRawLandmarks(overrides: Record<number, Partial<RawLandmark>> = {}): RawLandmark[] {
    const landmarks: RawLandmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
    for (const [id, lm] of Object.entries(overrides)) {
        landmarks[Number(id)] = { x: 0.5, y: 0.5, z: 0, visibility: 1, ...lm };
    }
    return landmarks;
}

describe('computeAngle2D', () => {
    test('right angle is 90 degrees', () => {
        const angle = computeAngle2D({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 });
        expect(angle).toBeCloseTo(90, 3);
    });

    // The 1e-8 epsilon in the denominator (kept identical to the game's
    // computeAngle) shifts extreme angles by up to ~0.01 degrees.
    test('straight line is 180 degrees', () => {
        const angle = computeAngle2D({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 });
        expect(Math.abs(angle - 180)).toBeLessThan(0.05);
    });

    test('collinear same-side points are 0 degrees', () => {
        const angle = computeAngle2D({ x: 1, y: 1 }, { x: 0, y: 0 }, { x: 2, y: 2 });
        expect(Math.abs(angle)).toBeLessThan(0.05);
    });

    test('degenerate (zero-length) vectors do not produce NaN', () => {
        const angle = computeAngle2D({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 });
        expect(Number.isFinite(angle)).toBe(true);
    });

    test('z coordinate is ignored (2D angles)', () => {
        const flat = computeAngle2D({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 });
        const deep = computeAngle2D({ x: 1, y: 0, z: 9 } as RawLandmark, { x: 0, y: 0, z: -3 } as RawLandmark, { x: 0, y: 1, z: 5 } as RawLandmark);
        expect(flat).toBeCloseTo(deep, 9);
    });
});

describe('round', () => {
    test('rounds to the requested precision', () => {
        expect(round(1.23456, 2)).toBe(1.23);
        expect(round(1.23556, 3)).toBe(1.236);
    });
});

describe('serializeLandmarks', () => {
    test('keeps only active landmarks, in order, with rounded values', () => {
        const raw = makeRawLandmarks({ 11: { x: 0.123456, y: 0.654321, z: -0.111111, visibility: 0.98765 } });
        const serialized = serializeLandmarks(raw);

        expect(serialized).toHaveLength(DEFAULT_ACTIVE_LANDMARKS.length);
        expect(serialized.map((lm) => lm.id)).toEqual(DEFAULT_ACTIVE_LANDMARKS);

        const shoulder = serialized.find((lm) => lm.id === 11);
        expect(shoulder).toEqual({ id: 11, x: 0.1235, y: 0.6543, z: -0.1111, visibility: 0.9877 });
    });

    test('missing visibility defaults to fully visible', () => {
        const raw = makeRawLandmarks();
        delete raw[0].visibility;
        const serialized = serializeLandmarks(raw);
        expect(serialized.find((lm) => lm.id === 0)?.visibility).toBe(1);
    });

    test('skips landmarks absent from the raw array', () => {
        const raw: (RawLandmark | undefined)[] = makeRawLandmarks();
        raw[31] = undefined;
        const serialized = serializeLandmarks(raw);
        expect(serialized.find((lm) => lm.id === 31)).toBeUndefined();
        expect(serialized).toHaveLength(DEFAULT_ACTIVE_LANDMARKS.length - 1);
    });
});

describe('calculateAngles', () => {
    test('computes every configured joint angle when all points are visible', () => {
        // T-pose-ish: distinct positions so no degenerate vectors
        const raw = makeRawLandmarks({
            11: { x: 0.4, y: 0.3 }, 12: { x: 0.6, y: 0.3 },
            13: { x: 0.3, y: 0.45 }, 14: { x: 0.7, y: 0.45 },
            15: { x: 0.25, y: 0.6 }, 16: { x: 0.75, y: 0.6 },
            23: { x: 0.45, y: 0.6 }, 24: { x: 0.55, y: 0.6 },
            25: { x: 0.44, y: 0.78 }, 26: { x: 0.56, y: 0.78 },
            27: { x: 0.43, y: 0.95 }, 28: { x: 0.57, y: 0.95 }
        });
        const angles = calculateAngles(serializeLandmarks(raw));

        expect(Object.keys(angles).sort()).toEqual(Object.keys(DEFAULT_ANGLE_JOINTS).sort());
        for (const [name, value] of Object.entries(angles)) {
            expect(value, `${name} should be a finite number`).toBeTypeOf('number');
            expect(value!).toBeGreaterThanOrEqual(0);
            expect(value!).toBeLessThanOrEqual(180);
        }
    });

    test('elbow angle matches a hand-computed value', () => {
        // left_elbow = angle at 13 between 11 and 15; construct an exact right angle
        const raw = makeRawLandmarks({
            11: { x: 0.5, y: 0.2 },
            13: { x: 0.5, y: 0.5 },
            15: { x: 0.8, y: 0.5 }
        });
        const angles = calculateAngles(serializeLandmarks(raw));
        expect(angles.left_elbow).toBeCloseTo(90, 1);
    });

    test('angle is null when any point is below the visibility threshold', () => {
        const raw = makeRawLandmarks({ 15: { visibility: VISIBILITY_THRESHOLD - 0.01 } });
        const angles = calculateAngles(serializeLandmarks(raw));
        expect(angles.left_elbow).toBeNull();
    });

    test('angle is null when a point is missing entirely', () => {
        const landmarks = serializeLandmarks(makeRawLandmarks()).filter((lm) => lm.id !== 14);
        const angles = calculateAngles(landmarks);
        expect(angles.right_elbow).toBeNull();
        expect(angles.right_shoulder).toBeNull();
    });
});

function makeTestPoses(): PoseFrame[] {
    const landmarks = serializeLandmarks(makeRawLandmarks());
    return [
        { timestamp: 0, frame: 0, landmarks, angles: { left_elbow: 90, right_elbow: 100, left_knee: 170, right_knee: null } },
        { timestamp: 0.5, frame: 1, landmarks, angles: { left_elbow: 120, right_elbow: 101, left_knee: 170, right_knee: null } },
        { timestamp: 1, frame: 2, landmarks, angles: { left_elbow: 60, right_elbow: 99, left_knee: 171, right_knee: 90 } }
    ];
}

describe('buildLegacyChoreography', () => {
    const legacy = buildLegacyChoreography({
        name: 'test dance',
        poses: makeTestPoses(),
        failedCount: 1,
        duration: 1.5,
        targetFps: 30,
        complexity: 'full',
        resolution: [1280, 720],
        processedAt: '2026-01-01T00:00:00.000Z'
    });

    test('matches the schema clone_dance.js and the visualizer expect', () => {
        expect(legacy.metadata).toBeTruthy();
        expect(Array.isArray(legacy.poses)).toBe(true);
        expect(legacy.stats).toBeTruthy();

        for (const pose of legacy.poses) {
            expect(typeof pose.timestamp).toBe('number');
            expect(Array.isArray(pose.landmarks)).toBe(true);
            expect(pose.landmarks.every((lm) => 'id' in lm && 'x' in lm && 'y' in lm && 'visibility' in lm)).toBe(true);
            expect(typeof pose.angles).toBe('object');
        }
    });

    test('stats are consistent with the input', () => {
        expect(legacy.stats.total_poses).toBe(3);
        expect(legacy.metadata.total_frames).toBe(4); // poses + failed
        expect(legacy.stats.fps_effective).toBe(2); // 3 poses / 1.5s
        expect(legacy.metadata.fps).toBe(30);
        expect(legacy.metadata.resolution).toEqual([1280, 720]);
        expect(legacy.metadata.processing_params.model_complexity).toBe('full');
    });

    test('survives a JSON round-trip unchanged', () => {
        expect(JSON.parse(JSON.stringify(legacy))).toEqual(legacy);
    });
});

describe('buildBeatmap', () => {
    const beatmap = buildBeatmap({
        name: 'test dance',
        fileName: 'test.mp4',
        poses: makeTestPoses(),
        duration: 1.5,
        targetFps: 30
    });

    test('top-level schema (section 4) fields are present', () => {
        expect(beatmap.title).toBe('test dance');
        expect(beatmap.bpm).toBeNull();
        expect(beatmap.beatOffsetMs).toBeNull();
        expect(beatmap.mirrored).toBe(false);
        expect(beatmap.durationMs).toBe(1500);
        expect(Array.isArray(beatmap.steps)).toBe(true);
    });

    test('single full-routine step spans the whole video', () => {
        expect(beatmap.steps).toHaveLength(1);
        const step = beatmap.steps[0];
        expect(step.id).toBe(1);
        expect(step.startMs).toBe(0);
        expect(step.endMs).toBe(1500);
        expect(step.frames).toHaveLength(3);
    });

    test('frames carry millisecond timestamps and short angle names', () => {
        const step = beatmap.steps[0];
        expect(step.frames.map((f) => f.tMs)).toEqual([0, 500, 1000]);

        const firstAngles = step.frames[0].angles;
        expect(firstAngles.lElbow).toBe(90);
        expect(firstAngles.rElbow).toBe(100);
        expect(firstAngles.lKnee).toBe(170);
        expect(firstAngles.rKnee).toBeNull();
        for (const name of Object.keys(firstAngles)) {
            expect(Object.values(BEATMAP_ANGLE_NAMES)).toContain(name);
        }
    });

    test('dominant joints reflect the most-moving angles', () => {
        // left_elbow moves 30 + 60 = 90 deg; right_elbow 1 + 2 = 3; left_knee 0 + 1 = 1
        expect(beatmap.steps[0].dominantJoints).toEqual(['lElbow', 'rElbow']);
    });
});

describe('computeDominantJoints', () => {
    test('ignores null angles and handles empty input', () => {
        expect(computeDominantJoints([])).toEqual([]);
        const frames = [
            { angles: { lElbow: null, rElbow: 10 } },
            { angles: { lElbow: null, rElbow: 50 } }
        ];
        expect(computeDominantJoints(frames)).toEqual(['rElbow']);
    });
});

describe('mirrorLegacyChoreography', () => {
    test('flips x and swaps left/right landmark identities', () => {
        const legacy = buildLegacyChoreography({
            name: 'mirror me',
            poses: [{
                timestamp: 0,
                frame: 0,
                landmarks: [
                    { id: 11, x: 0.3, y: 0.4, z: 0, visibility: 1 },
                    { id: 12, x: 0.7, y: 0.4, z: 0, visibility: 1 }
                ],
                angles: {}
            }],
            failedCount: 0,
            duration: 1,
            targetFps: 30,
            complexity: 'lite',
            resolution: [100, 100]
        });

        const mirrored = mirrorLegacyChoreography(legacy, [[11, 12]]);
        const lms = mirrored.poses[0].landmarks;

        // Original left shoulder (11) at x=0.3 becomes the right shoulder (12) at x=0.7
        expect(lms[0]).toMatchObject({ id: 12, x: 0.7 });
        expect(lms[1]).toMatchObject({ id: 11, x: 0.3 });
        // Source object untouched
        expect(legacy.poses[0].landmarks[0]).toMatchObject({ id: 11, x: 0.3 });
    });
});

describe('sanitizeFileName', () => {
    test('lowercases and replaces spaces/dashes with underscores', () => {
        expect(sanitizeFileName('My Cool-Dance 2')).toBe('my_cool_dance_2');
    });

    test('strips unsafe characters and never returns empty', () => {
        expect(sanitizeFileName('???!!!')).toBe('choreography');
        expect(sanitizeFileName('día de baile')).toBe('da_de_baile');
    });
});

describe('default configuration tables', () => {
    test('every angle joint uses active landmarks', () => {
        for (const [name, triplet] of Object.entries(DEFAULT_ANGLE_JOINTS)) {
            expect(triplet, `${name} must have 3 points`).toHaveLength(3);
            for (const id of triplet) {
                expect(DEFAULT_ACTIVE_LANDMARKS, `${name}: landmark ${id} not active`).toContain(id);
            }
        }
    });

    test('every pose connection uses active landmarks', () => {
        for (const [a, b] of DEFAULT_POSE_CONNECTIONS) {
            expect(DEFAULT_ACTIVE_LANDMARKS).toContain(a);
            expect(DEFAULT_ACTIVE_LANDMARKS).toContain(b);
        }
    });

    test('beatmap angle names cover all angle joints', () => {
        expect(Object.keys(BEATMAP_ANGLE_NAMES).sort()).toEqual(Object.keys(DEFAULT_ANGLE_JOINTS).sort());
    });
});
