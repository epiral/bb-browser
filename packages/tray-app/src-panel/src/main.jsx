import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { StoreProvider } from './store/useStore.jsx';
import Dashboard from './Dashboard.jsx';
import './styles/global.css';
import './styles/tracestudio.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <StoreProvider>
      <Dashboard />
    </StoreProvider>
  </StrictMode>
);
