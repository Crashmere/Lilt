import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

document.addEventListener('keydown', event => {
  if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing) event.preventDefault();
});

createRoot(document.getElementById('root')!).render(<App />);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/lilt/sw.js', { scope: '/lilt/' }).catch(() => undefined); });
}
