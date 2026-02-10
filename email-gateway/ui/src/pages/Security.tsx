import { useEffect, useState } from 'react'
import { fetchAPI, patchAPI } from '../api'
import DataTable, { Column } from '../components/DataTable'
import EmptyState from '../components/EmptyState'
import { Shield, Plus, Trash2, AlertTriangle, UserCheck, Users, Globe, ArrowRight } from 'lucide-react'

interface SecurityConfig {
  operatorEmails: string[]
}

interface ActivityEvent {
  id: string
  timestamp: string
  type: string
  summary: string
  details: {
    from?: string
    to?: string
    subject?: string
    securityFlags?: string[]
  }
}

export default function Security() {
  const [config, setConfig] = useState<SecurityConfig | null>(null)
  const [flaggedEvents, setFlaggedEvents] = useState<ActivityEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [newEmail, setNewEmail] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    loadData()
  }, [])

  async function loadData() {
    try {
      const [secData, activityData] = await Promise.all([
        fetchAPI<SecurityConfig>('/config/security'),
        fetchAPI<{ events: ActivityEvent[] }>('/activity?type=security&limit=20'),
      ])
      setConfig(secData)
      setFlaggedEvents(activityData.events)
    } catch (err) {
      console.error('Failed to load security config:', err)
    } finally {
      setLoading(false)
    }
  }

  async function addOperator() {
    if (!config || !newEmail.trim()) return
    setSaving(true)
    try {
      const updated = [...config.operatorEmails, newEmail.trim().toLowerCase()]
      const result = await patchAPI<{ operatorEmails: string[] }>('/config/security', {
        operatorEmails: updated,
      })
      setConfig({ operatorEmails: result.operatorEmails })
      setNewEmail('')
    } catch (err) {
      console.error('Failed to add operator:', err)
    } finally {
      setSaving(false)
    }
  }

  async function removeOperator(email: string) {
    if (!config) return
    if (!confirm(`Remove ${email} from operator whitelist?`)) return
    setSaving(true)
    try {
      const updated = config.operatorEmails.filter((e) => e !== email)
      const result = await patchAPI<{ operatorEmails: string[] }>('/config/security', {
        operatorEmails: updated,
      })
      setConfig({ operatorEmails: result.operatorEmails })
    } catch (err) {
      console.error('Failed to remove operator:', err)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="max-w-5xl animate-pulse">
        <div className="h-6 w-32 bg-gray-800 rounded mb-6" />
        <div className="h-48 bg-gray-800/30 rounded-lg mb-4" />
        <div className="h-48 bg-gray-800/30 rounded-lg" />
      </div>
    )
  }

  if (!config) return null

  const flaggedColumns: Column<ActivityEvent>[] = [
    {
      key: 'time',
      header: 'Time',
      className: 'w-36',
      render: (e) => (
        <span className="text-xs text-gray-500 font-mono">
          {new Date(e.timestamp).toLocaleString()}
        </span>
      ),
    },
    {
      key: 'from',
      header: 'From',
      className: 'w-40',
      render: (e) => (
        <span className="text-xs font-mono">{e.details.from || '-'}</span>
      ),
    },
    {
      key: 'summary',
      header: 'Details',
      render: (e) => (
        <div>
          <p className="text-xs">{e.summary}</p>
          {e.details.securityFlags && e.details.securityFlags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {e.details.securityFlags.map((flag, i) => (
                <span key={i} className="text-[10px] px-1.5 py-0.5 bg-amber-500/10 text-amber-400 rounded">
                  {flag}
                </span>
              ))}
            </div>
          )}
        </div>
      ),
    },
  ]

  return (
    <div className="max-w-5xl">
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-100">Security</h2>
        <p className="text-sm text-gray-500">Content security and operator trust settings</p>
      </div>

      {/* Trust Model Diagram */}
      <div className="bg-gray-900/50 border border-gray-800 rounded-lg p-5 mb-4">
        <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-4">Trust Model</h3>
        <div className="flex items-center justify-center gap-3">
          <TrustLevel
            icon={UserCheck}
            label="Operator"
            description="Full trust. Content passes through unmodified."
            color="text-emerald-400"
            bgColor="bg-emerald-500/10"
            borderColor="border-emerald-500/20"
          />
          <ArrowRight size={16} className="text-gray-600" />
          <TrustLevel
            icon={Users}
            label="Trusted Agent"
            description="Known agent. Content lightly wrapped."
            color="text-blue-400"
            bgColor="bg-blue-500/10"
            borderColor="border-blue-500/20"
          />
          <ArrowRight size={16} className="text-gray-600" />
          <TrustLevel
            icon={Globe}
            label="External"
            description="Unknown sender. Content wrapped + scanned."
            color="text-amber-400"
            bgColor="bg-amber-500/10"
            borderColor="border-amber-500/20"
          />
        </div>
      </div>

      {/* Operator Whitelist */}
      <div className="bg-gray-900/50 border border-gray-800 rounded-lg mb-4">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <h3 className="text-sm font-medium text-gray-200">Operator Whitelist</h3>
          <span className="text-xs text-gray-500">{config.operatorEmails.length} email(s)</span>
        </div>
        <div className="p-4">
          {/* Add form */}
          <div className="flex gap-2 mb-4">
            <input
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="operator@example.com"
              onKeyDown={(e) => { if (e.key === 'Enter') addOperator() }}
              className="flex-1 px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-md text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={addOperator}
              disabled={saving || !newEmail.trim()}
              className="flex items-center gap-1 px-3 py-2 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Plus size={12} />
              Add
            </button>
          </div>

          {/* Email list */}
          {config.operatorEmails.length === 0 ? (
            <EmptyState
              icon={Shield}
              title="No operators configured"
              description="Add operator emails to grant full trust to known senders."
            />
          ) : (
            <div className="space-y-1">
              {config.operatorEmails.map((email) => (
                <div
                  key={email}
                  className="flex items-center justify-between px-3 py-2 rounded-md hover:bg-gray-800/50"
                >
                  <div className="flex items-center gap-2">
                    <UserCheck size={14} className="text-emerald-400" />
                    <span className="text-sm font-mono text-gray-300">{email}</span>
                  </div>
                  <button
                    onClick={() => removeOperator(email)}
                    disabled={saving}
                    className="p-1 text-gray-500 hover:text-red-400 disabled:opacity-50"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Flagged Messages */}
      <div className="bg-gray-900/50 border border-gray-800 rounded-lg">
        <div className="px-4 py-3 border-b border-gray-800">
          <h3 className="text-sm font-medium text-gray-200">Recent Flagged Messages</h3>
        </div>
        <div className="p-4">
          {flaggedEvents.length === 0 ? (
            <EmptyState
              icon={AlertTriangle}
              title="No flagged messages"
              description="Messages flagged for suspicious injection patterns will appear here."
            />
          ) : (
            <DataTable
              columns={flaggedColumns}
              data={flaggedEvents}
              keyExtractor={(e) => e.id}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function TrustLevel({
  icon: Icon,
  label,
  description,
  color,
  bgColor,
  borderColor,
}: {
  icon: typeof Shield
  label: string
  description: string
  color: string
  bgColor: string
  borderColor: string
}) {
  return (
    <div className={`flex-1 p-3 rounded-lg border ${borderColor} ${bgColor} text-center`}>
      <Icon size={20} className={`mx-auto mb-2 ${color}`} />
      <p className={`text-xs font-medium ${color}`}>{label}</p>
      <p className="text-[10px] text-gray-500 mt-1">{description}</p>
    </div>
  )
}
