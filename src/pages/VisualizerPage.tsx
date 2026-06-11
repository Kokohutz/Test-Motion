import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, MouseEvent } from 'react';
import { mirrorLegacyChoreography } from '../core/choreography';
import { drawAngleLabels, drawSkeleton, toIndexedLandmarks } from '../core/drawing';
import type { LegacyChoreography, PoseFrame } from '../core/types';
import { useAppConfig } from '../hooks/useAppConfig';

interface VisualizerSettings {
    color: string;
    thickness: number;
    opacity: number;
    showConnections: boolean;
    showAngles: boolean;
}

function formatTime(seconds: number): string {
    if (isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function findPoseAtTime(
    choreography: LegacyChoreography,
    time: number,
    toleranceSec: number
): PoseFrame | null {
    const poses = choreography.poses;
    if (!poses || poses.length === 0) return null;

    let closest = poses[0];
    let minDiff = Math.abs(time - closest.timestamp);
    for (const pose of poses) {
        const diff = Math.abs(time - pose.timestamp);
        if (diff < minDiff) {
            minDiff = diff;
            closest = pose;
        }
    }
    return minDiff < toleranceSec ? closest : null;
}

export default function VisualizerPage() {
    const { config, error: configError } = useAppConfig();

    const [videoFile, setVideoFile] = useState<File | null>(null);
    const [jsonFile, setJsonFile] = useState<File | null>(null);
    const [mirror, setMirror] = useState(false);
    const [settings, setSettings] = useState<VisualizerSettings | null>(null);
    const [choreography, setChoreography] = useState<LegacyChoreography | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [status, setStatus] = useState('');
    const [timeLabel, setTimeLabel] = useState('0:00 / 0:00');
    const [progressPct, setProgressPct] = useState(0);
    const [currentFrameLabel, setCurrentFrameLabel] = useState('-');

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const videoUrlRef = useRef<string | null>(null);
    const animationRef = useRef<number | null>(null);
    // Mutable copies for the render loop (avoids re-creating the loop per state change)
    const choreoRef = useRef<LegacyChoreography | null>(null);
    const settingsRef = useRef<VisualizerSettings | null>(null);
    const playingRef = useRef(false);

    // Initialize visual settings from config.json once it arrives
    useEffect(() => {
        if (!config || settings) return;
        const v = config.visualizer;
        setSettings({
            color: v.SKELETON_COLOR,
            thickness: v.LINE_THICKNESS,
            opacity: v.SKELETON_OPACITY,
            showConnections: v.SHOW_CONNECTIONS,
            showAngles: v.SHOW_ANGLES
        });
        setMirror(v.MIRROR_DEFAULT);
    }, [config, settings]);

    useEffect(() => {
        settingsRef.current = settings;
    }, [settings]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (animationRef.current) cancelAnimationFrame(animationRef.current);
            if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
            videoRef.current?.remove();
        };
    }, []);

    function renderFrame() {
        const canvas = canvasRef.current;
        const video = videoRef.current;
        const choreo = choreoRef.current;
        const style = settingsRef.current;
        if (!canvas || !video || !choreo || !style || !config) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const pose = findPoseAtTime(choreo, video.currentTime, config.common.POSE_TIME_TOLERANCE_SEC);
        setCurrentFrameLabel(pose ? String(pose.frame) : '-');
        if (!pose) return;

        const landmarks = toIndexedLandmarks(pose.landmarks);
        drawSkeleton(
            ctx,
            landmarks,
            style.showConnections ? config.visualizer.POSE_CONNECTIONS : [],
            config.visualizer.KEYPOINTS,
            { color: style.color, thickness: style.thickness, opacity: style.opacity }
        );
        if (style.showAngles && pose.angles) {
            drawAngleLabels(ctx, landmarks, pose.angles);
        }
    }

    function startRenderLoop() {
        const loop = () => {
            if (!playingRef.current) return;
            renderFrame();
            animationRef.current = requestAnimationFrame(loop);
        };
        loop();
    }

    async function loadFiles() {
        if (!videoFile || !jsonFile || !config) return;
        setStatus('Loading...');

        try {
            if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
            videoRef.current?.remove();

            const video = document.createElement('video');
            videoUrlRef.current = URL.createObjectURL(videoFile);
            video.src = videoUrlRef.current;
            video.muted = true;
            video.preload = 'auto';
            video.style.display = 'none';
            document.body.appendChild(video);

            await new Promise<void>((resolve, reject) => {
                video.oncanplay = () => resolve();
                video.onerror = () => reject(new Error('Could not load video'));
                video.load();
            });

            let parsed = JSON.parse(await jsonFile.text()) as LegacyChoreography;
            if (mirror) {
                parsed = mirrorLegacyChoreography(parsed, config.common.KEYPOINTS_MIRROR_SWAP);
            }

            const canvas = canvasRef.current;
            if (canvas) {
                canvas.width = video.videoWidth || 1280;
                canvas.height = video.videoHeight || 720;
            }

            video.ontimeupdate = () => {
                setProgressPct((video.currentTime / video.duration) * 100 || 0);
                setTimeLabel(`${formatTime(video.currentTime)} / ${formatTime(video.duration)}`);
                if (!playingRef.current) renderFrame();
            };
            video.onended = () => {
                playingRef.current = false;
                setIsPlaying(false);
                if (animationRef.current) cancelAnimationFrame(animationRef.current);
            };

            videoRef.current = video;
            choreoRef.current = parsed;
            setChoreography(parsed);
            setStatus('');
            video.currentTime = 0.01;
            setTimeout(renderFrame, 100);
        } catch (error) {
            console.error('Error loading files:', error);
            setStatus('Error: ' + (error as Error).message);
        }
    }

    function togglePlay() {
        const video = videoRef.current;
        if (!video) return;

        if (playingRef.current) {
            playingRef.current = false;
            setIsPlaying(false);
            video.pause();
            if (animationRef.current) cancelAnimationFrame(animationRef.current);
        } else {
            playingRef.current = true;
            setIsPlaying(true);
            video.play();
            startRenderLoop();
        }
    }

    function seekTo(event: MouseEvent<HTMLDivElement>) {
        const video = videoRef.current;
        if (!video) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const percentage = (event.clientX - rect.left) / rect.width;
        video.currentTime = percentage * video.duration;
        video.addEventListener('seeked', renderFrame, { once: true });
    }

    function onSettingChange<K extends keyof VisualizerSettings>(key: K, value: VisualizerSettings[K]) {
        setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
    }

    function onFileChange(setter: (file: File | null) => void) {
        return (event: ChangeEvent<HTMLInputElement>) => setter(event.target.files?.[0] ?? null);
    }

    if (configError) {
        return <div className="panel"><h2>Config error</h2><p>{configError}</p></div>;
    }

    return (
        <>
            <div className="panel">
                <h2>Load choreography</h2>

                <div className="form-grid">
                    <div className="file-input-group">
                        <label htmlFor="vizVideo">Video file</label>
                        <input type="file" id="vizVideo" accept="video/*" onChange={onFileChange(setVideoFile)} />
                        <div className="file-name">{videoFile?.name ?? 'Not selected'}</div>
                    </div>
                    <div className="file-input-group">
                        <label htmlFor="vizJson">Choreography JSON</label>
                        <input type="file" id="vizJson" accept=".json" onChange={onFileChange(setJsonFile)} />
                        <div className="file-name">{jsonFile?.name ?? 'Not selected'}</div>
                    </div>
                </div>

                <div className="form-group" style={{ marginBottom: 16 }}>
                    <label>
                        <input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} />
                        Mirror choreography
                    </label>
                </div>

                <button className="btn" onClick={loadFiles} disabled={!videoFile || !jsonFile || !config}>
                    Load
                </button>
                <div className={'status-text' + (status.startsWith('Error') ? ' error' : '')}>{status}</div>
            </div>

            {choreography && settings && (
                <>
                    <div className="panel">
                        <h2>Playback</h2>
                        <canvas ref={canvasRef} className="preview-canvas" />
                        <div className="timeline" onClick={seekTo}>
                            <div className="timeline-progress" style={{ width: `${progressPct}%` }} />
                        </div>
                        <div className="time-display">{timeLabel}</div>
                        <button className="btn" onClick={togglePlay} style={{ marginTop: 14 }}>
                            {isPlaying ? 'Pause' : 'Play'}
                        </button>
                        <div className="info-row">
                            <span>Total poses: {choreography.stats.total_poses}</span>
                            <span>Current frame: {currentFrameLabel}</span>
                            <span>Duration: {choreography.stats.duration.toFixed(1)}s</span>
                        </div>
                    </div>

                    <div className="panel">
                        <h2>Skeleton settings</h2>
                        <div className="form-grid">
                            <div className="form-group">
                                <label>Color</label>
                                <input
                                    type="color"
                                    value={settings.color}
                                    onChange={(e) => onSettingChange('color', e.target.value)}
                                />
                            </div>
                            <div className="form-group">
                                <label>Thickness: {settings.thickness}</label>
                                <input
                                    type="range"
                                    min={1}
                                    max={10}
                                    value={settings.thickness}
                                    onChange={(e) => onSettingChange('thickness', Number(e.target.value))}
                                />
                            </div>
                            <div className="form-group">
                                <label>Opacity: {Math.round(settings.opacity * 100)}%</label>
                                <input
                                    type="range"
                                    min={10}
                                    max={100}
                                    value={Math.round(settings.opacity * 100)}
                                    onChange={(e) => onSettingChange('opacity', Number(e.target.value) / 100)}
                                />
                            </div>
                            <div className="form-group">
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={settings.showConnections}
                                        onChange={(e) => onSettingChange('showConnections', e.target.checked)}
                                    />
                                    Show connections
                                </label>
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={settings.showAngles}
                                        onChange={(e) => onSettingChange('showAngles', e.target.checked)}
                                    />
                                    Show angles
                                </label>
                            </div>
                        </div>
                    </div>
                </>
            )}
        </>
    );
}
