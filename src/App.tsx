import { useEffect, useState } from 'react';
import ExtractorPage from './pages/ExtractorPage';
import VisualizerPage from './pages/VisualizerPage';

type Route = 'extractor' | 'visualizer';

function routeFromHash(): Route {
    const hash = window.location.hash.replace(/^#\/?/, '');
    return hash === 'visualizer' ? 'visualizer' : 'extractor';
}

export default function App() {
    const [route, setRoute] = useState<Route>(routeFromHash);

    useEffect(() => {
        const onHashChange = () => setRoute(routeFromHash());
        window.addEventListener('hashchange', onHashChange);
        return () => window.removeEventListener('hashchange', onHashChange);
    }, []);

    return (
        <>
            <header className="app-header">
                <h1>Clone Dance</h1>
                <nav>
                    <a href="#/extractor" className={route === 'extractor' ? 'active' : ''}>Extractor</a>
                    <a href="#/visualizer" className={route === 'visualizer' ? 'active' : ''}>Visualizer</a>
                    {/* Legacy page, served from public/ until it is migrated to React */}
                    <a href="/clone_dance.html">Play the Game</a>
                </nav>
            </header>
            <main className="container">
                {route === 'extractor' ? <ExtractorPage /> : <VisualizerPage />}
            </main>
        </>
    );
}
