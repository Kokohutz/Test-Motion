/**
 * Shared domain types for Clone Dance.
 */

/** MediaPipe normalized landmark (0..1 image coordinates). */
export interface RawLandmark {
    x: number;
    y: number;
    z: number;
    visibility?: number;
}

/** Stored landmark: restricted to active landmarks, keyed by MediaPipe id. */
export interface StoredLandmark {
    id: number;
    x: number;
    y: number;
    z: number;
    visibility: number;
}

/** Named joint angles in degrees; null = not reliably visible that frame. */
export type AngleSet = Record<string, number | null>;

/** [p1, vertex, p2] landmark ids defining a joint angle. */
export type AngleJointTriplet = [number, number, number];
export type AngleJointMap = Record<string, AngleJointTriplet>;

export interface PoseFrame {
    /** Seconds from the start of the video. */
    timestamp: number;
    frame: number;
    landmarks: StoredLandmark[];
    angles: AngleSet;
}

/** Legacy Clone-Dance choreography JSON (consumed by the game/visualizer). */
export interface LegacyChoreography {
    metadata: {
        name: string;
        source_url: string;
        duration: number;
        fps: number;
        resolution: [number, number];
        total_frames: number;
        processed_at: string;
        processing_params: {
            model_complexity: string;
            skip_frames: number;
            active_landmarks: number[];
            mirror_mode: boolean;
            extractor: string;
        };
    };
    poses: PoseFrame[];
    stats: {
        total_poses: number;
        fps_effective: number;
        duration: number;
    };
}

/** Step-based beatmap (section-4 schema of the project breakdown). */
export interface BeatmapFrame {
    tMs: number;
    angles: AngleSet;
    landmarks: StoredLandmark[];
}

export interface BeatmapStep {
    id: number;
    label: string;
    startMs: number;
    endMs: number;
    frames: BeatmapFrame[];
    dominantJoints: string[];
}

export interface Beatmap {
    title: string;
    sourceFile: string;
    bpm: number | null;
    beatOffsetMs: number | null;
    mirrored: boolean;
    fps: number;
    durationMs: number;
    steps: BeatmapStep[];
}

export type ModelComplexity = 'lite' | 'full' | 'heavy';

/** Shape of public/config.json (shared with the legacy game). */
export interface AppConfig {
    common: {
        ACTIVE_LANDMARKS: number[];
        ANGLE_JOINTS: AngleJointMap;
        KEYPOINTS_MIRROR_SWAP: [number, number][];
        POSE_TIME_TOLERANCE_SEC: number;
        [key: string]: unknown;
    };
    game: {
        POSE_CONNECTIONS: [number, number][];
        [key: string]: unknown;
    };
    visualizer: {
        SKELETON_COLOR: string;
        LINE_THICKNESS: number;
        SKELETON_OPACITY: number;
        SHOW_CONNECTIONS: boolean;
        SHOW_ANGLES: boolean;
        KEYPOINTS: number[];
        POSE_CONNECTIONS: [number, number][];
        MIRROR_DEFAULT: boolean;
        [key: string]: unknown;
    };
}
