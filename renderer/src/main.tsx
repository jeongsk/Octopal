import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { installApiAdapter } from './tauri-api'
import './globals.css'

// Install Tauri API adapter if running in Tauri, otherwise use Electron preload
installApiAdapter()

createRoot(document.getElementById('root')!).render(<App />)
