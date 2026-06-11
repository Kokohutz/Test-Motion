/**
 * Pure choreography-building logic. No DOM, no React, no MediaPipe —
 * everything here is deterministic and unit-tested in Node (Vitest).
 */

import type {
    AngleJointMap,
    AngleSet,
    Beatmap,
    BeatmapFrame,
    LegacyChoreography,
    ModelComplexity,
    PoseFrame,
    RawLandmark,
    StoredLandmark
} from './types';

// Kept in sync with public/config.json; used as fallbacks when it is unavailable
export const DEFAULT_ACTIVE_LANDMARKS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
export const DEFAULT_ANGLE_JOINTS: AngleJointMap = {
    left_shoulder: [12, 11, 13],
    right_shoulder: [11, 12, 14],
    left_elbow: [11, 13, 15],
    right_elbow: [12, 14, 16],
    left_knee: [23, 25, 27],
    right_knee: [24, 26, 28],
    left_hip: [24, 23, 25],
    right_hip: [23, 24, 26]
};
export const DEFAULT_POSE_CONNECTIONS: [number, number][] = [
    [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
    [11, 23], [12, 24], [23, 24], [23, 25], [25, 27],
    [24, 26], [26, 28], [27, 29], [27, 31], [28, 30], [28, 32]
];

// Beatmap schema uses short camelCase angle names
export const BEATMAP_ANGLE_NAMES: Record<string, string> = {
    left_shoulder: 'lShoulder',
    right_shoulder: 'rShoulder',
    left_elbow: 'lElbow',
    right_elbow: 'rElbow',
    left_hip: 'lHip',
    right_hip: 'rHip',
    left_knee: 'lKnee',
    right_knee: 'rKnee'
};

export const VISIBILITY_THRESHOLD = 0.5;

export function round(value: number, decimals: number): number {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}

/**
 * Angle in degrees at `vertex` between p1-vertex-p2, in 2D (z ignored),
 * matching the game's computeAngle and the old Python extractor.
 */
export function computeAngle2D(
    p1: { x: number; y: number },
    vertex: { x: number; y: number },
    p2: { x: number; y: number }
): number {
    const v1x = p1.x - vertex.x;
    const v1y = p1.y - vertex.y;
    const v2x = p2.x - vertex.x;
    const v2y = p2.y - vertex.y;

    const dot = v1x * v2x + v1y * v2y;
    const mag1 = Math.hypot(v1x, v1y);
    const mag2 = Math.hypot(v2x, v2y);
    const cosAngle = Math.max(-1, Math.min(1, dot / (mag1 * mag2 + 1e-8)));
    return Math.acos(cosAngle) * (180 / Math.PI);
}

/**
 * Convert MediaPipe landmarks (array indexed 0..32) to the stored format,
 * restricted to active landmarks.
 */
export function serializeLandmarks(
    rawLandmarks: (RawLandmark | undefined)[],
    activeLandmarks: number[] = DEFAULT_ACTIVE_LANDMARKS
): StoredLandmark[] {
    const landmarks: StoredLandmark[] = [];
    for (const id of activeLandmarks) {
        const lm = rawLandmarks[id];
        if (!lm) continue;
        landmarks.push({
            id,
            x: round(lm.x, 4),
            y: round(lm.y, 4),
            z: round(lm.z, 4),
            visibility: round(lm.visibility ?? 1, 4)
        });
    }
    return landmarks;
}

/**
 * Joint angles from stored landmarks. An angle is null when any of its
 * three points is missing or below the visibility threshold.
 */
export function calculateAngles(
    landmarks: StoredLandmark[],
    angleJoints: AngleJointMap = DEFAULT_ANGLE_JOINTS
): AngleSet {
    const byId: Record<number, StoredLandmark> = {};
    for (const lm of landmarks) byId[lm.id] = lm;

    const angles: AngleSet = {};
    for (const [angleName, [p1Id, vertexId, p2Id]] of Object.entries(angleJoints)) {
        const p1 = byId[p1Id];
        const vertex = byId[vertexId];
        const p2 = byId[p2Id];

        if (!p1 || !vertex || !p2 ||
            p1.visibility < VISIBILITY_THRESHOLD ||
            vertex.visibility < VISIBILITY_THRESHOLD ||
            p2.visibility < VISIBILITY_THRESHOLD) {
            angles[angleName] = null;
            continue;
        }
        angles[angleName] = round(computeAngle2D(p1, vertex, p2), 2);
    }
    return angles;
}

export interface BuildLegacyParams {
    name: string;
    poses: PoseFrame[];
    failedCount: number;
    duration: number;
    targetFps: number;
    complexity: ModelComplexity | string;
    resolution: [number, number];
    activeLandmarks?: number[];
    processedAt?: string;
}

/**
 * Legacy Clone-Dance choreography JSON, compatible with clone_dance.html
 * and the visualizer (same schema the Python pipeline produced).
 */
export function buildLegacyChoreography({
    name,
    poses,
    failedCount,
    duration,
    targetFps,
    complexity,
    resolution,
    activeLandmarks = DEFAULT_ACTIVE_LANDMARKS,
    processedAt = new Date().toISOString()
}: BuildLegacyParams): LegacyChoreography {
    const fpsEffective = duration > 0 ? poses.length / duration : 0;

    return {
        metadata: {
            name,
            source_url: '',
            duration,
            fps: targetFps,
            resolution,
            total_frames: poses.length + failedCount,
            processed_at: processedAt,
            processing_params: {
                model_complexity: String(complexity),
                skip_frames: 0,
                active_landmarks: activeLandmarks,
                mirror_mode: false,
                extractor: 'browser'
            }
        },
        poses,
        stats: {
            total_poses: poses.length,
            fps_effective: round(fpsEffective, 2),
            duration
        }
    };
}

export interface BuildBeatmapParams {
    name: string;
    fileName: string;
    poses: PoseFrame[];
    duration: number;
    targetFps: number;
}

/**
 * Step-based beatmap JSON. Until beat detection lands (M2), the whole
 * routine is a single step and bpm/beatOffsetMs stay null.
 */
export function buildBeatmap({ name, fileName, poses, duration, targetFps }: BuildBeatmapParams): Beatmap {
    const frames: BeatmapFrame[] = poses.map((pose) => {
        const angles: AngleSet = {};
        for (const [legacyName, shortName] of Object.entries(BEATMAP_ANGLE_NAMES)) {
            if (legacyName in pose.angles) {
                angles[shortName] = pose.angles[legacyName];
            }
        }
        return {
            tMs: Math.round(pose.timestamp * 1000),
            angles,
            landmarks: pose.landmarks
        };
    });

    return {
        title: name,
        sourceFile: fileName,
        bpm: null,           // M2: beat detection
        beatOffsetMs: null,  // M2: beat detection
        mirrored: false,
        fps: targetFps,
        durationMs: Math.round(duration * 1000),
        steps: [
            {
                id: 1,
                label: 'full routine', // M2: split into per-beat steps with auto-labels
                startMs: 0,
                endMs: Math.round(duration * 1000),
                frames,
                dominantJoints: computeDominantJoints(frames)
            }
        ]
    };
}

/** Joints with the largest total angular motion across the frames. */
export function computeDominantJoints(frames: { angles: AngleSet }[], topN = 2): string[] {
    const totals: Record<string, number> = {};
    let previous: { angles: AngleSet } | null = null;

    for (const frame of frames) {
        if (previous) {
            for (const [jointName, angle] of Object.entries(frame.angles)) {
                const prevAngle = previous.angles[jointName];
                if (Number.isFinite(angle) && Number.isFinite(prevAngle)) {
                    totals[jointName] = (totals[jointName] || 0) + Math.abs((angle as number) - (prevAngle as number));
                }
            }
        }
        previous = frame;
    }

    return Object.entries(totals)
        .sort((a, b) => b[1] - a[1])
        .slice(0, topN)
        .map(([jointName]) => jointName);
}

/**
 * Mirror a legacy choreography in place-free fashion: flips x and swaps
 * left/right landmark identities (used by the visualizer's mirror toggle).
 */
export function mirrorLegacyChoreography(
    choreography: LegacyChoreography,
    swapPairs: [number, number][]
): LegacyChoreography {
    const swapMap = new Map<number, number>();
    for (const [a, b] of swapPairs) {
        swapMap.set(a, b);
        swapMap.set(b, a);
    }

    const poses = choreography.poses.map((pose) => ({
        ...pose,
        landmarks: pose.landmarks.map((lm) => ({
            ...lm,
            x: round(1 - lm.x, 4),
            id: swapMap.get(lm.id) ?? lm.id
        }))
    }));

    return { ...choreography, poses };
}

export function sanitizeFileName(name: string): string {
    const cleaned = String(name).toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
    return cleaned || 'choreography';
}
