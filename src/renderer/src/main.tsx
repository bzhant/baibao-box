import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

const rootElement = document.getElementById('root')!;

if (window.location.hash === '#floating') {
  document.body.classList.add('floating-mode');
  document.documentElement.style.background = 'transparent';
  document.documentElement.style.colorScheme = 'dark';
  document.body.style.background = 'transparent';
  rootElement.style.background = 'transparent';
}

createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
