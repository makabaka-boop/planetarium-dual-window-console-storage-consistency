import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConsolePage } from './pages/ConsolePage';
import { ViewerPage } from './pages/ViewerPage';
import './styles.css';

function route() {
  const path = window.location.pathname;
  if (path.startsWith('/viewer')) return <ViewerPage />;
  return <ConsolePage />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <React.Fragment key={window.location.pathname}>{route()}</React.Fragment>
  </React.StrictMode>
);
