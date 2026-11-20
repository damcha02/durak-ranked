import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
// React and Supabase change far less often than the app, so they get their own files: after a deploy
// that only touches app code, phones keep the cached libraries.
const vendorChunks=(id:string)=>/node_modules\/(react|react-dom|scheduler)\//.test(id)?'react':/node_modules\/@supabase\//.test(id)?'supabase':undefined
export default defineConfig({build:{rollupOptions:{output:{manualChunks:vendorChunks}}},plugins:[react(),VitePWA({registerType:'autoUpdate',includeAssets:['favicon.svg','apple-touch-icon.png'],manifest:{name:'Durak Ranked',short_name:'Durak Ranked',description:'Track your Durak games with friends. Play with real cards, record who lost, and keep ratings for every game mode.',theme_color:'#e8f1f8',background_color:'#e8f1f8',display:'standalone',start_url:'/',icons:[{src:'/icon-192.png',sizes:'192x192',type:'image/png',purpose:'any'},{src:'/icon-512.png',sizes:'512x512',type:'image/png',purpose:'any'},{src:'/icon-maskable.svg',sizes:'any',type:'image/svg+xml',purpose:'maskable'}]},workbox:{globPatterns:['**/*.{js,css,html,svg,png}'],navigateFallback:'/index.html',runtimeCaching:[]}})]})
