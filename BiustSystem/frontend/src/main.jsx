import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import Dashboard from './pages/Dashboard.jsx'
import BiustTestPanel from './pages/BiustTestPanel.jsx'

function NavBar() {
  const linkStyle = ({ isActive }) => ({
    padding: '8px 18px',
    borderRadius: 8,
    textDecoration: 'none',
    fontSize: '0.8rem',
    fontWeight: 600,
    fontFamily: "'JetBrains Mono', monospace",
    transition: 'all 0.2s',
    background: isActive ? 'rgba(0,255,200,0.15)' : 'transparent',
    color: isActive ? '#00ffc8' : '#718096',
    border: isActive ? '1px solid rgba(0,255,200,0.35)' : '1px solid transparent',
  })

  return (
    <nav style={{
      background: 'rgba(7,11,20,0.95)',
      borderBottom: '1px solid rgba(255,255,255,0.07)',
      padding: '10px 1.5rem',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      backdropFilter: 'blur(12px)',
      position: 'sticky',
      top: 0,
      zIndex: 100,
    }}>
      <span style={{ color: '#00ffc8', fontSize: '1.2rem', marginRight: 8 }}>◈</span>
      <NavLink to="/" end style={linkStyle}>Live Monitor</NavLink>
      <NavLink to="/dashboard" style={linkStyle}>Dashboard</NavLink>
      <NavLink to="/test" style={linkStyle}>⚡ Test Panel</NavLink>
    </nav>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <NavBar />
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/test" element={<BiustTestPanel />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)