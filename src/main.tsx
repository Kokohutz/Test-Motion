import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
// Self-hosted game fonts (bundled by Vite, no CDN at runtime)
import '@fontsource/bungee/400.css';
import '@fontsource/rajdhani/400.css';
import '@fontsource/rajdhani/500.css';
import '@fontsource/rajdhani/700.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>
);
