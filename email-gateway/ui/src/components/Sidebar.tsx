import { NavLink } from 'react-router-dom'
import { LayoutDashboard, Route, Shield, ScrollText, Mail } from 'lucide-react'

const navItems = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/routing', label: 'Routing', icon: Route },
  { to: '/security', label: 'Security', icon: Shield },
  { to: '/activity', label: 'Activity', icon: ScrollText },
]

export default function Sidebar() {
  return (
    <aside className="fixed left-0 top-0 h-screen w-56 bg-sidebar-bg border-r border-sidebar-border flex flex-col">
      {/* Header */}
      <div className="px-4 py-5 border-b border-sidebar-border">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-blue-600/20 flex items-center justify-center">
            <Mail className="w-4.5 h-4.5 text-blue-400" size={18} />
          </div>
          <div>
            <h1 className="text-sm font-semibold text-gray-100">Email Gateway</h1>
            <p className="text-[10px] text-gray-500 uppercase tracking-wider">AI Maestro</p>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-3 px-2">
        {navItems.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors mb-0.5 ${
                isActive
                  ? 'bg-sidebar-active text-gray-100'
                  : 'text-gray-400 hover:bg-sidebar-hover hover:text-gray-200'
              }`
            }
          >
            <Icon size={16} />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-sidebar-border">
        <p className="text-[10px] text-gray-600">v0.1.0</p>
      </div>
    </aside>
  )
}
