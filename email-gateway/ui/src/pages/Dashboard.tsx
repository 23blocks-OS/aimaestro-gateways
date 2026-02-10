import { useEffect, useState } from 'react'
import { fetchAPI } from '../api'
import StatusBadge from '../components/StatusBadge'
import DataTable, { Column } from '../components/DataTable'
import { Mail, ArrowUpRight, ArrowDownLeft, AlertTriangle, Shield, Clock, Server, Radio } from 'lucide-react'

interface Stats {
  status: string
  version: string
  uptime: number
  uptimeHuman: string
  port: number
  totalEventsLogged: number
  today: {
    inbound: number
    outbound: number
    errors: number
    security: number
    total: number
  }
  connections: {
    aimaestro: boolean
    mandrill: boolean
  }
  tenants: string[]
  routing: {
    routes: number
    defaults: number
  }
}

interface ActivityEvent {
  id: string
  timestamp: string
  type: 'inbound' | 'outbound' | 'error' | 'security'
  summary: string
  details: {
    from?: string
    to?: string
    subject?: string
    tenant?: string
    routeMatch?: string
    securityFlags?: string[]
    error?: string
  }
}

const typeColors: Record<string, string> = {
  inbound: 'text-blue-400 bg-blue-500/10',
  outbound: 'text-emerald-400 bg-emerald-500/10',
  error: 'text-red-400 bg-red-500/10',
  security: 'text-amber-400 bg-amber-500/10',
}

const typeIcons: Record<string, typeof Mail> = {
  inbound: ArrowDownLeft,
  outbound: ArrowUpRight,
  error: AlertTriangle,
  security: Shield,
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [activity, setActivity] = useState<ActivityEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadData()
    const interval = setInterval(loadData, 10000)
    return () => clearInterval(interval)
  }, [])

  async function loadData() {
    try {
      const [statsData, activityData] = await Promise.all([
        fetchAPI<Stats>('/stats'),
        fetchAPI<{ events: ActivityEvent[] }>('/activity?limit=10'),
      ])
      setStats(statsData)
      setActivity(activityData.events)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return <LoadingSkeleton />
  }

  if (error && !stats) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <AlertTriangle className="mx-auto mb-3 text-red-400" size={32} />
          <p className="text-sm text-gray-400">{error}</p>
          <button
            onClick={loadData}
            className="mt-3 text-xs text-blue-400 hover:text-blue-300"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (!stats) return null

  const activityColumns: Column<ActivityEvent>[] = [
    {
      key: 'time',
      header: 'Time',
      className: 'w-28',
      render: (e) => (
        <span className="text-xs text-gray-500 font-mono">
          {new Date(e.timestamp).toLocaleTimeString()}
        </span>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      className: 'w-24',
      render: (e) => {
        const Icon = typeIcons[e.type] || Mail
        return (
          <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded ${typeColors[e.type]}`}>
            <Icon size={12} />
            {e.type}
          </span>
        )
      },
    },
    {
      key: 'summary',
      header: 'Event',
      render: (e) => <span className="text-xs">{e.summary}</span>,
    },
  ]

  return (
    <div className="max-w-5xl">
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-100">Dashboard</h2>
        <p className="text-sm text-gray-500">Email Gateway status and activity</p>
      </div>

      {/* Status bar */}
      <div className="flex items-center gap-4 mb-6 p-4 bg-gray-900/50 border border-gray-800 rounded-lg">
        <StatusBadge status={stats.status === 'online' ? 'online' : 'error'} />
        <div className="flex items-center gap-1.5 text-xs text-gray-400">
          <Clock size={12} />
          Uptime: {stats.uptimeHuman}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-gray-400">
          <Server size={12} />
          Port {stats.port}
        </div>
        <div className="text-xs text-gray-600">v{stats.version}</div>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard
          label="Inbound"
          value={stats.today.inbound}
          icon={ArrowDownLeft}
          color="text-blue-400"
          bgColor="bg-blue-500/10"
        />
        <StatCard
          label="Outbound"
          value={stats.today.outbound}
          icon={ArrowUpRight}
          color="text-emerald-400"
          bgColor="bg-emerald-500/10"
        />
        <StatCard
          label="Errors"
          value={stats.today.errors}
          icon={AlertTriangle}
          color="text-red-400"
          bgColor="bg-red-500/10"
        />
        <StatCard
          label="Flagged"
          value={stats.today.security}
          icon={Shield}
          color="text-amber-400"
          bgColor="bg-amber-500/10"
        />
      </div>

      {/* Connections + Recent Activity */}
      <div className="grid grid-cols-3 gap-4">
        {/* Connections */}
        <div className="bg-gray-900/50 border border-gray-800 rounded-lg p-4">
          <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-3">Connections</h3>
          <div className="space-y-3">
            <ConnectionItem
              label="AI Maestro"
              connected={stats.connections.aimaestro}
            />
            <ConnectionItem
              label="Mandrill API"
              connected={stats.connections.mandrill}
            />
          </div>

          <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider mt-5 mb-3">Tenants</h3>
          <div className="space-y-1">
            {stats.tenants.map((t) => (
              <div key={t} className="flex items-center gap-2 text-xs text-gray-300">
                <Radio size={10} className="text-blue-400" />
                {t}
              </div>
            ))}
            {stats.tenants.length === 0 && (
              <p className="text-xs text-gray-600">No tenants configured</p>
            )}
          </div>

          <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider mt-5 mb-3">Routing</h3>
          <div className="text-xs text-gray-300 space-y-1">
            <p>{stats.routing.routes} explicit route{stats.routing.routes !== 1 ? 's' : ''}</p>
            <p>{stats.routing.defaults} default{stats.routing.defaults !== 1 ? 's' : ''}</p>
          </div>
        </div>

        {/* Recent Activity */}
        <div className="col-span-2 bg-gray-900/50 border border-gray-800 rounded-lg p-4">
          <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-3">Recent Activity</h3>
          <DataTable
            columns={activityColumns}
            data={activity}
            keyExtractor={(e) => e.id}
            emptyMessage="No activity yet. Events will appear here as emails are processed."
          />
        </div>
      </div>
    </div>
  )
}

function StatCard({
  label,
  value,
  icon: Icon,
  color,
  bgColor,
}: {
  label: string
  value: number
  icon: typeof Mail
  color: string
  bgColor: string
}) {
  return (
    <div className="bg-gray-900/50 border border-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-gray-500 uppercase tracking-wider">{label}</span>
        <div className={`w-7 h-7 rounded-md ${bgColor} flex items-center justify-center`}>
          <Icon size={14} className={color} />
        </div>
      </div>
      <p className="text-2xl font-semibold text-gray-100">{value}</p>
      <p className="text-[10px] text-gray-600 mt-1">Today</p>
    </div>
  )
}

function ConnectionItem({ label, connected }: { label: string; connected: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-gray-300">{label}</span>
      <StatusBadge
        status={connected ? 'online' : 'offline'}
        label={connected ? 'Connected' : 'Unreachable'}
        size="sm"
      />
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="max-w-5xl animate-pulse">
      <div className="h-6 w-32 bg-gray-800 rounded mb-2" />
      <div className="h-4 w-56 bg-gray-800/50 rounded mb-6" />
      <div className="h-14 bg-gray-800/30 rounded-lg mb-6" />
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-24 bg-gray-800/30 rounded-lg" />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div className="h-64 bg-gray-800/30 rounded-lg" />
        <div className="col-span-2 h-64 bg-gray-800/30 rounded-lg" />
      </div>
    </div>
  )
}
