import { useEffect, useState, useCallback } from 'react'
import { fetchAPI } from '../api'
import DataTable, { Column } from '../components/DataTable'
import EmptyState from '../components/EmptyState'
import { ScrollText, ArrowDownLeft, ArrowUpRight, AlertTriangle, Shield, Search, RefreshCw, Mail } from 'lucide-react'

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

type FilterType = 'all' | 'inbound' | 'outbound' | 'error' | 'security'

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

const filterOptions: { value: FilterType; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'inbound', label: 'Inbound' },
  { value: 'outbound', label: 'Outbound' },
  { value: 'error', label: 'Errors' },
  { value: 'security', label: 'Security' },
]

export default function Activity() {
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<FilterType>('all')
  const [search, setSearch] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const loadEvents = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: '100' })
      if (filter !== 'all') params.set('type', filter)
      if (search) params.set('search', search)
      const data = await fetchAPI<{ events: ActivityEvent[] }>(`/activity?${params}`)
      setEvents(data.events)
    } catch (err) {
      console.error('Failed to load activity:', err)
    } finally {
      setLoading(false)
    }
  }, [filter, search])

  useEffect(() => {
    loadEvents()
  }, [loadEvents])

  useEffect(() => {
    if (!autoRefresh) return
    const interval = setInterval(loadEvents, 5000)
    return () => clearInterval(interval)
  }, [autoRefresh, loadEvents])

  const columns: Column<ActivityEvent>[] = [
    {
      key: 'time',
      header: 'Time',
      className: 'w-40',
      render: (e) => (
        <span className="text-xs text-gray-500 font-mono">
          {new Date(e.timestamp).toLocaleString()}
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
      key: 'from',
      header: 'From',
      className: 'w-44',
      render: (e) => (
        <span className="text-xs font-mono truncate block max-w-[10rem]" title={e.details.from}>
          {e.details.from || '-'}
        </span>
      ),
    },
    {
      key: 'subject',
      header: 'Subject',
      render: (e) => (
        <span className="text-xs truncate block max-w-xs" title={e.details.subject}>
          {e.details.subject || e.summary}
        </span>
      ),
    },
    {
      key: 'route',
      header: 'Match',
      className: 'w-20',
      render: (e) => (
        <span className="text-[10px] text-gray-500">
          {e.details.routeMatch || '-'}
        </span>
      ),
    },
  ]

  return (
    <div className="max-w-5xl">
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-100">Activity Log</h2>
        <p className="text-sm text-gray-500">Full event history for the gateway</p>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4">
        {/* Type filter */}
        <div className="flex rounded-md border border-gray-800 overflow-hidden">
          {filterOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setFilter(opt.value)}
              className={`px-3 py-1.5 text-xs transition-colors ${
                filter === opt.value
                  ? 'bg-gray-700 text-gray-100'
                  : 'bg-gray-900 text-gray-500 hover:text-gray-300'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search events..."
            className="w-full pl-9 pr-3 py-1.5 text-sm bg-gray-900 border border-gray-800 rounded-md text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-700"
          />
        </div>

        {/* Auto-refresh toggle */}
        <button
          onClick={() => setAutoRefresh(!autoRefresh)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border transition-colors ${
            autoRefresh
              ? 'bg-blue-500/10 text-blue-400 border-blue-500/20'
              : 'bg-gray-900 text-gray-500 border-gray-800 hover:text-gray-300'
          }`}
        >
          <RefreshCw size={12} className={autoRefresh ? 'animate-spin' : ''} />
          Auto
        </button>

        {/* Manual refresh */}
        <button
          onClick={loadEvents}
          className="p-1.5 text-gray-500 hover:text-gray-300 transition-colors"
          title="Refresh"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {/* Events table */}
      <div className="bg-gray-900/50 border border-gray-800 rounded-lg">
        {loading ? (
          <div className="p-8 text-center text-sm text-gray-500">Loading...</div>
        ) : events.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={ScrollText}
              title="No events"
              description={
                filter !== 'all' || search
                  ? 'No events match your filters. Try broadening your search.'
                  : 'Events will appear here as the gateway processes emails.'
              }
            />
          </div>
        ) : (
          <>
            <DataTable
              columns={columns}
              data={events}
              keyExtractor={(e) => e.id}
              onRowClick={(e) => setExpandedId(expandedId === e.id ? null : e.id)}
            />
            {/* Expanded details */}
            {expandedId && (
              <EventDetails
                event={events.find((e) => e.id === expandedId)!}
                onClose={() => setExpandedId(null)}
              />
            )}
          </>
        )}
      </div>

      <div className="mt-2 text-right">
        <span className="text-[10px] text-gray-600">
          {events.length} event{events.length !== 1 ? 's' : ''} shown (last 500 in memory)
        </span>
      </div>
    </div>
  )
}

function EventDetails({ event, onClose }: { event: ActivityEvent; onClose: () => void }) {
  return (
    <div className="border-t border-gray-800 px-4 py-3 bg-gray-800/30">
      <div className="flex justify-between items-start mb-2">
        <p className="text-xs font-medium text-gray-300">{event.summary}</p>
        <button onClick={onClose} className="text-[10px] text-gray-600 hover:text-gray-400">
          Close
        </button>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
        {event.details.from && (
          <Detail label="From" value={event.details.from} />
        )}
        {event.details.to && (
          <Detail label="To" value={event.details.to} />
        )}
        {event.details.subject && (
          <Detail label="Subject" value={event.details.subject} />
        )}
        {event.details.tenant && (
          <Detail label="Tenant" value={event.details.tenant} />
        )}
        {event.details.routeMatch && (
          <Detail label="Route Match" value={event.details.routeMatch} />
        )}
        {event.details.error && (
          <Detail label="Error" value={event.details.error} />
        )}
      </div>
      {event.details.securityFlags && event.details.securityFlags.length > 0 && (
        <div className="mt-2">
          <span className="text-[10px] text-gray-500">Security Flags:</span>
          <div className="flex flex-wrap gap-1 mt-1">
            {event.details.securityFlags.map((flag, i) => (
              <span key={i} className="text-[10px] px-1.5 py-0.5 bg-amber-500/10 text-amber-400 rounded">
                {flag}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-gray-500">{label}:</span>{' '}
      <span className="text-gray-300 font-mono">{value}</span>
    </div>
  )
}
