/**
 * Copies the MediaPipe wasm runtime from node_modules into public/ so the
 * built site is fully self-contained (no CDN dependency at runtime) and the
 * wasm version always matches the installed @mediapipe/tasks-vision package.
 * public/mediapipe-wasm/ is gitignored; this runs before dev and build.
 */

import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const target = join(root, 'public', 'mediapipe-wasm');

mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
console.log(`Copied MediaPipe wasm runtime to ${target}`);
