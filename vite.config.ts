import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    server: {
        // Polling keeps hot reload working through Docker bind mounts
        watch: process.env.VITE_USE_POLLING ? { usePolling: true, interval: 300 } : undefined
    },
    test: {
        environment: 'node',
        include: ['tests/**/*.test.ts']
    }
});
