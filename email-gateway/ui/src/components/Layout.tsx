import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'

interface LayoutProps {
  embed: boolean
}

export default function Layout({ embed }: LayoutProps) {
  if (embed) {
    return (
      <div className="min-h-screen bg-gray-950">
        <Outlet />
      </div>
    )
  }

  return (
    <div className="flex min-h-screen bg-gray-950">
      <Sidebar />
      <main className="flex-1 ml-56 p-6">
        <Outlet />
      </main>
    </div>
  )
}
