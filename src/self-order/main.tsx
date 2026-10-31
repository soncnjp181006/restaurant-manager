import ReactDOM from 'react-dom/client';
import './self-order.css';
import { SelfOrderApp } from './app.tsx';
import { selfOrderLang, tr } from './i18n.ts';

const params = new URLSearchParams(window.location.search);

// The HTML shell only has an English title; follow the guest's language here.
document.title = tr('pageTitle');
document.documentElement.lang = selfOrderLang();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <SelfOrderApp token={params.get('t') ?? ''} returningCheckoutId={params.get('checkout')} />,
);
