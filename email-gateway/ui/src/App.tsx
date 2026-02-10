import { Routes, Route, Navigate } from 'react-router-dom'
import { useSearchParams } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Routing from './pages/Routing'
import Security from './pages/Security'
import Activity from './pages/Activity'

export default function App() {
  const [searchParams] = useSearchParams()
  const embedMode = searchParams.get('embed') === 'true'

  return (
    <Routes>
      <Route element={<Layout embed={embedMode} />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/routing" element={<Routing />} />
        <Route path="/security" element={<Security />} />
        <Route path="/activity" element={<Activity />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
