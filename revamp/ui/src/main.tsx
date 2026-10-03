import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { DetailProvider } from './detail'
import { StoreProvider } from './store'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider>
      <DetailProvider>
        <App />
      </DetailProvider>
    </StoreProvider>
  </StrictMode>,
)
