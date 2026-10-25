import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyTheme, readTheme } from './theme'
import './styles.css'
// Apply the saved theme before the first render so the other theme never flashes.
applyTheme(readTheme())
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>)
