import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
export default defineConfig({plugins:[react(),VitePWA({registerType:'autoUpdate',includeAssets:['favicon.svg','apple-touch-icon.png'],manifest:{name:'Durak Ratings',short_name:'Durak',description:'Track physical Durak games with friends',theme_color:'#10251c',background_color:'#0a1611',display:'standalone',start_url:'/',icons:[{src:'/icon-192.png',sizes:'192x192',type:'image/png',purpose:'any'},{src:'/icon-512.png',sizes:'512x512',type:'image/png',purpose:'any'},{src:'/icon-maskable.svg',sizes:'any',type:'image/svg+xml',purpose:'maskable'}]},workbox:{globPatterns:['**/*.{js,css,html,svg,png}'],navigateFallback:'/index.html',runtimeCaching:[]}})]})
