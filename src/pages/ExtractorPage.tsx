import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import {
    DEFAULT_ACTIVE_LANDMARKS,
    DEFAULT_ANGLE_JOINTS,
    DEFAULT_POSE_CONNECTIONS,
    buildBeatmap,
    buildLegacyChoreography,
    sanitizeFileName
} from '../core/choreography';
import { extractChoreography, loadVideoFromFile } from '../core/extraction';
import type { ExtractionProgress } from '../core/extraction';
import { drawSkeleton } from '../core/drawing';
import type { Beatmap, LegacyChoreography, ModelComplexity } from '../core/types';
import { useAppConfig } from '../hooks/useAppConfig';
import { usePoseLandmarker } from '../hooks/usePoseLandmarker';

interface ExtractionOutput {
    name: string;
    legacy: LegacyChoreography;
    beatmap: Beatmap;
    failedCount: number;
    cancelled: boolean;
}

function formatSec(seconds: number): string {
    if (!Number.isFinite(seconds)) return '-';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

function downloadJson(data: unknown, fileName: string) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export default function ExtractorPage() {
    const { config } = useAppConfig();
    const { getLandmarker } = usePoseLandmarker();

    const [videoFile, setVideoFile] = useState<File | null>(null);
    const [name, setName] = useState('');
    const [complexity, setComplexity] = useState<ModelComplexity>('full');
    const [targetFps, setTargetFps] = useState(30);
    const [status, setStatus] = useState('Select a video to begin.');
    const [isError, setIsError] = useState(false);
    const [isRunning, setIsRunning] = useState(false);
    const [progress, setProgress] = useState<ExtractionProgress | null>(null);
    const [output, setOutput] = useState<ExtractionOutput | null>(null);

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const cancelRef = useRef(false);

    const activeLandmarks = config?.common.ACTIVE_LANDMARKS ?? DEFAULT_ACTIVE_LANDMARKS;
    const angleJoints = config?.common.ANGLE_JOINTS ?? DEFAULT_ANGLE_JOINTS;
    const poseConnections = config?.game.POSE_CONNECTIONS ?? DEFAULT_POSE_CONNECTIONS;

    function onVideoSelected(event: ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0] ?? null;
        setVideoFile(file);
        if (file && !name.trim()) {
            setName(file.name.replace(/\.[^.]+$/, ''));
        }
    }

    async function startExtraction() {
        if (!videoFile || isRunning) return;

        setIsRunning(true);
        cancelRef.current = false;
        setOutput(null);
        setProgress(null);
        setIsError(false);

        let revokeUrl: (() => void) | null = null;
        try {
            setStatus(`Loading MediaPipe PoseLandmarker (${complexity})...`);
            const landmarker = await getLandmarker(complexity);

            setStatus('Loading video...');
            const { video, revoke } = await loadVideoFromFile(videoFile);
            revokeUrl = revoke;

            const canvas = canvasRef.current;
            const ctx = canvas?.getContext('2d') ?? null;
            if (canvas) {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
            }

            setStatus('Extracting poses...');
            const result = await extractChoreography(
                { video, landmarker, targetFps, activeLandmarks, angleJoints },
                {
                    shouldCancel: () => cancelRef.current,
                    onProgress: setProgress,
                    onFrame: (frameVideo, landmarks) => {
                        if (!ctx) return;
                        ctx.drawImage(frameVideo, 0, 0, ctx.canvas.width, ctx.canvas.height);
                        if (landmarks) {
                            drawSkeleton(ctx, landmarks, poseConnections, activeLandmarks, {
                                color: '#00ff88',
                                thickness: 3
                            });
                        }
                    }
                }
            );

            if (result.poses.length === 0) {
                throw new Error('No poses detected in this video. Make sure one full person is visible.');
            }

            const choreoName = name.trim() || 'choreography';
            const legacy = buildLegacyChoreography({
                name: choreoName,
                poses: result.poses,
                failedCount: result.failedCount,
                duration: result.duration,
                targetFps,
                complexity,
                resolution: result.resolution,
                activeLandmarks
            });
            const beatmap = buildBeatmap({
                name: choreoName,
                fileName: videoFile.name,
                poses: result.poses,
                duration: result.duration,
                targetFps
            });

            setOutput({
                name: choreoName,
                legacy,
                beatmap,
                failedCount: result.failedCount,
                cancelled: result.cancelled
            });
            setStatus(result.cancelled ? 'Stopped early - partial choreography ready.' : 'Extraction completed.');
        } catch (error) {
            console.error('Extraction error:', error);
            setStatus('Error: ' + (error as Error).message);
            setIsError(true);
        } finally {
            revokeUrl?.();
            setIsRunning(false);
        }
    }

    const progressPct = progress ? Math.min(100, (progress.processedFrames / progress.totalFrames) * 100) : 0;
    const detectionRate = output
        ? (output.legacy.stats.total_poses / Math.max(1, output.legacy.stats.total_poses + output.failedCount)) * 100
        : 0;

    return (
        <>
            <div className="panel">
                <h2>1. Video &amp; settings</h2>

                <div className="file-input-group">
                    <label htmlFor="videoFile">Reference video (MP4/WebM)</label>
                    <input type="file" id="videoFile" accept="video/*" onChange={onVideoSelected} />
                    <div className="file-name">{videoFile?.name ?? 'Not selected'}</div>
                </div>

                <div className="form-grid">
                    <div className="form-group">
                        <label htmlFor="choreoName">Choreography name</label>
                        <input
                            type="text"
                            id="choreoName"
                            placeholder="my_dance"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                        />
                    </div>
                    <div className="form-group">
                        <label htmlFor="modelSelect">Pose model</label>
                        <select
                            id="modelSelect"
                            value={complexity}
                            onChange={(e) => setComplexity(e.target.value as ModelComplexity)}
                        >
                            <option value="lite">Lite (fastest)</option>
                            <option value="full">Full (balanced)</option>
                            <option value="heavy">Heavy (most accurate)</option>
                        </select>
                    </div>
                    <div className="form-group">
                        <label htmlFor="fpsSelect">Extraction FPS</label>
                        <select
                            id="fpsSelect"
                            value={targetFps}
                            onChange={(e) => setTargetFps(Number(e.target.value))}
                        >
                            <option value="15">15 (fast)</option>
                            <option value="24">24</option>
                            <option value="30">30 (recommended)</option>
                        </select>
                    </div>
                </div>

                <button className="btn" onClick={startExtraction} disabled={!videoFile || isRunning}>
                    Extract Choreography
                </button>
                <button className="btn secondary" onClick={() => { cancelRef.current = true; }} disabled={!isRunning}>
                    Stop
                </button>
                <div className={'status-text' + (isError ? ' error' : '')}>{status}</div>

                <div className="progress-track">
                    <div className="progress-bar" style={{ width: `${progressPct}%` }} />
                </div>
                {progress && (
                    <div className="progress-label">
                        Frame {progress.processedFrames}/{progress.totalFrames} ({progressPct.toFixed(0)}%)
                        {' | '}poses: {progress.detectedPoses}
                        {' | '}elapsed {formatSec(progress.elapsedSec)}
                        {' | '}ETA {formatSec(progress.etaSec)}
                    </div>
                )}
            </div>

            <div className="panel" hidden={!isRunning && !output}>
                <h2>2. Live preview</h2>
                <canvas ref={canvasRef} className="preview-canvas" />
            </div>

            {output && (
                <div className="panel">
                    <h2>3. Results</h2>
                    <div className="results-summary">
                        <div><strong>{output.name}</strong>{output.cancelled ? ' (partial)' : ''}</div>
                        <div>
                            Duration: {output.legacy.stats.duration.toFixed(1)}s
                            {' | '}Poses: {output.legacy.stats.total_poses}
                            {' | '}Effective FPS: {output.legacy.stats.fps_effective.toFixed(1)}
                        </div>
                        <div>
                            Frames without a detected pose: {output.failedCount} (detection rate {detectionRate.toFixed(1)}%)
                        </div>
                    </div>
                    <button
                        className="btn"
                        onClick={() => downloadJson(output.legacy, `${sanitizeFileName(output.name)}.json`)}
                    >
                        Download Clone-Dance JSON
                    </button>
                    <button
                        className="btn secondary"
                        onClick={() => downloadJson(output.beatmap, `${sanitizeFileName(output.name)}_beatmap.json`)}
                    >
                        Download Beatmap JSON
                    </button>
                    <div className="hint">
                        The Clone-Dance JSON works directly with <a href="/clone_dance.html">the game</a> and
                        the <a href="#/visualizer">visualizer</a>. The Beatmap JSON is the new step-based format
                        (beats and step labels are added in the next milestone).
                    </div>
                </div>
            )}
        </>
    );
}
