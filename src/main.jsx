import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import './index.css';
import { AuthProvider } from './contexts/AuthContext.jsx';
import { CyberChaosProvider } from './contexts/CyberChaosContext.jsx';
import { QuantumViewProvider } from './contexts/QuantumViewContext.jsx';
import { Toaster } from 'react-hot-toast';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <QuantumViewProvider>
        <AuthProvider>
          <CyberChaosProvider>
            <App />
            <Toaster
              position="top-center"
              reverseOrder={false}
              toastOptions={{
                style: {
                  background: '#1a1a24',
                  color: '#fff',
                  border: '1px solid #00e0ff',
                },
              }}
            />
          </CyberChaosProvider>
        </AuthProvider>
      </QuantumViewProvider>
    </BrowserRouter>
  </StrictMode>,
);
