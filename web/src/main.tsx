import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

document.addEventListener('keydown', event => {
  if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing) event.preventDefault();
});

createRoot(document.getElementById('root')!).render(<App />);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  const shellReady = () => navigator.serviceWorker.controller?.postMessage({ type: 'lilt-shell-ready' });
  navigator.serviceWorker.addEventListener('controllerchange', shellReady);
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type !== 'lilt-shell-assets') return;
    const assets = Array.from(document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[src], link[rel="stylesheet"][href]'))
      .map(element => element instanceof HTMLScriptElement ? element.src : element.href)
      .filter(url => new URL(url).pathname.startsWith('/lilt/assets/'));
    event.ports[0]?.postMessage(assets);
  });
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/lilt/sw.js', { scope: '/lilt/', updateViaCache: 'none' }).then(shellReady).catch(() => undefined); });
}
