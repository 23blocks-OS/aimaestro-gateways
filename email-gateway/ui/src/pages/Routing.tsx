import { useEffect, useState, FormEvent } from 'react'
import { fetchAPI, patchAPI } from '../api'
import DataTable, { Column } from '../components/DataTable'
import Modal from '../components/Modal'
import EmptyState from '../components/EmptyState'
import StatusBadge from '../components/StatusBadge'
import { Route, Plus, Trash2, Pencil, Database } from 'lucide-react'

interface RouteTarget {
  agent: string
  host: string
}

interface RoutingConfig {
  routes: Record<string, RouteTarget>
  defaults: Record<string, RouteTarget>
  emailIndex: {
    available: boolean
    lastError: string
  }
}

type ModalMode = 'add-route' | 'edit-route' | 'add-default' | 'edit-default' | null

interface FormState {
  key: string
  agent: string
  host: string
  originalKey?: string
}

const emptyForm: FormState = { key: '', agent: '', host: '' }

export default function Routing() {
  const [config, setConfig] = useState<RoutingConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [modalMode, setModalMode] = useState<ModalMode>(null)
  const [form, setForm] = useState<FormState>(emptyForm)

  useEffect(() => {
    loadConfig()
  }, [])

  async function loadConfig() {
    try {
      const data = await fetchAPI<RoutingConfig>('/config/routing')
      setConfig(data)
    } catch (err) {
      console.error('Failed to load routing config:', err)
    } finally {
      setLoading(false)
    }
  }

  async function saveRoutes(routes: Record<string, RouteTarget>) {
    setSaving(true)
    try {
      const result = await patchAPI<{ routes: Record<string, RouteTarget>; defaults: Record<string, RouteTarget> }>(
        '/config/routing',
        { routes }
      )
      setConfig((prev) => prev ? { ...prev, routes: result.routes, defaults: result.defaults } : prev)
      setModalMode(null)
      setForm(emptyForm)
    } catch (err) {
      console.error('Failed to save routes:', err)
    } finally {
      setSaving(false)
    }
  }

  async function saveDefaults(defaults: Record<string, RouteTarget>) {
    setSaving(true)
    try {
      const result = await patchAPI<{ routes: Record<string, RouteTarget>; defaults: Record<string, RouteTarget> }>(
        '/config/routing',
        { defaults }
      )
      setConfig((prev) => prev ? { ...prev, routes: result.routes, defaults: result.defaults } : prev)
      setModalMode(null)
      setForm(emptyForm)
    } catch (err) {
      console.error('Failed to save defaults:', err)
    } finally {
      setSaving(false)
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!config) return

    if (modalMode === 'add-route' || modalMode === 'edit-route') {
      const routes = { ...config.routes }
      if (modalMode === 'edit-route' && form.originalKey && form.originalKey !== form.key) {
        delete routes[form.originalKey]
      }
      routes[form.key] = { agent: form.agent, host: form.host }
      saveRoutes(routes)
    } else if (modalMode === 'add-default' || modalMode === 'edit-default') {
      const defaults = { ...config.defaults }
      if (modalMode === 'edit-default' && form.originalKey && form.originalKey !== form.key) {
        delete defaults[form.originalKey]
      }
      defaults[form.key] = { agent: form.agent, host: form.host }
      saveDefaults(defaults)
    }
  }

  function deleteRoute(email: string) {
    if (!config) return
    const routes = { ...config.routes }
    delete routes[email]
    saveRoutes(routes)
  }

  function deleteDefault(tenant: string) {
    if (!config) return
    const defaults = { ...config.defaults }
    delete defaults[tenant]
    saveDefaults(defaults)
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

  const routeEntries = Object.entries(config.routes).map(([email, target]) => ({
    email,
    ...target,
  }))

  const defaultEntries = Object.entries(config.defaults).map(([tenant, target]) => ({
    tenant,
    ...target,
  }))

  const routeColumns: Column<typeof routeEntries[0]>[] = [
    {
      key: 'email',
      header: 'Email Address',
      render: (r) => <span className="font-mono text-xs">{r.email}</span>,
    },
    {
      key: 'agent',
      header: 'Agent',
      render: (r) => <span className="text-xs">{r.agent}</span>,
    },
    {
      key: 'host',
      header: 'Host',
      render: (r) => <span className="text-xs text-gray-400">{r.host}</span>,
    },
    {
      key: 'actions',
      header: '',
      className: 'w-20 text-right',
      render: (r) => (
        <div className="flex items-center justify-end gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation()
              setForm({ key: r.email, agent: r.agent, host: r.host, originalKey: r.email })
              setModalMode('edit-route')
            }}
            className="p-1 text-gray-500 hover:text-gray-300"
          >
            <Pencil size={13} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              if (confirm(`Delete route for ${r.email}?`)) deleteRoute(r.email)
            }}
            className="p-1 text-gray-500 hover:text-red-400"
          >
            <Trash2 size={13} />
          </button>
        </div>
      ),
    },
  ]

  const defaultColumns: Column<typeof defaultEntries[0]>[] = [
    {
      key: 'tenant',
      header: 'Tenant',
      render: (r) => <span className="font-mono text-xs">{r.tenant}</span>,
    },
    {
      key: 'agent',
      header: 'Default Agent',
      render: (r) => <span className="text-xs">{r.agent}</span>,
    },
    {
      key: 'host',
      header: 'Host',
      render: (r) => <span className="text-xs text-gray-400">{r.host}</span>,
    },
    {
      key: 'actions',
      header: '',
      className: 'w-20 text-right',
      render: (r) => (
        <div className="flex items-center justify-end gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation()
              setForm({ key: r.tenant, agent: r.agent, host: r.host, originalKey: r.tenant })
              setModalMode('edit-default')
            }}
            className="p-1 text-gray-500 hover:text-gray-300"
          >
            <Pencil size={13} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              if (confirm(`Delete default for tenant ${r.tenant}?`)) deleteDefault(r.tenant)
            }}
            className="p-1 text-gray-500 hover:text-red-400"
          >
            <Trash2 size={13} />
          </button>
        </div>
      ),
    },
  ]

  const isRouteModal = modalMode === 'add-route' || modalMode === 'edit-route'
  const isDefaultModal = modalMode === 'add-default' || modalMode === 'edit-default'

  return (
    <div className="max-w-5xl">
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-100">Routing</h2>
        <p className="text-sm text-gray-500">Manage email-to-agent routing rules</p>
      </div>

      {/* Email Index status */}
      <div className="flex items-center gap-3 mb-6 p-3 bg-gray-900/50 border border-gray-800 rounded-lg">
        <Database size={16} className="text-gray-400" />
        <span className="text-xs text-gray-400">AI Maestro Email Index:</span>
        <StatusBadge
          status={config.emailIndex.available ? 'online' : 'offline'}
          label={config.emailIndex.available ? 'Connected' : 'Unavailable'}
          size="sm"
        />
        {config.emailIndex.lastError && (
          <span className="text-[10px] text-gray-600">{config.emailIndex.lastError}</span>
        )}
      </div>

      {/* Explicit Routes */}
      <div className="bg-gray-900/50 border border-gray-800 rounded-lg mb-4">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <h3 className="text-sm font-medium text-gray-200">Explicit Routes</h3>
          <button
            onClick={() => {
              setForm(emptyForm)
              setModalMode('add-route')
            }}
            className="flex items-center gap-1 px-2.5 py-1 text-xs text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-md hover:bg-blue-500/20 transition-colors"
          >
            <Plus size={12} />
            Add Route
          </button>
        </div>
        <div className="p-4">
          {routeEntries.length === 0 ? (
            <EmptyState
              icon={Route}
              title="No explicit routes"
              description="Add email-to-agent routes to direct specific addresses to specific agents."
              action={{ label: 'Add Route', onClick: () => { setForm(emptyForm); setModalMode('add-route') } }}
            />
          ) : (
            <DataTable
              columns={routeColumns}
              data={routeEntries}
              keyExtractor={(r) => r.email}
            />
          )}
        </div>
      </div>

      {/* Tenant Defaults */}
      <div className="bg-gray-900/50 border border-gray-800 rounded-lg">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <h3 className="text-sm font-medium text-gray-200">Tenant Defaults</h3>
          <button
            onClick={() => {
              setForm(emptyForm)
              setModalMode('add-default')
            }}
            className="flex items-center gap-1 px-2.5 py-1 text-xs text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-md hover:bg-blue-500/20 transition-colors"
          >
            <Plus size={12} />
            Add Default
          </button>
        </div>
        <div className="p-4">
          {defaultEntries.length === 0 ? (
            <EmptyState
              icon={Route}
              title="No tenant defaults"
              description="Tenant defaults catch all emails for a tenant when no explicit route matches."
              action={{ label: 'Add Default', onClick: () => { setForm(emptyForm); setModalMode('add-default') } }}
            />
          ) : (
            <DataTable
              columns={defaultColumns}
              data={defaultEntries}
              keyExtractor={(r) => r.tenant}
            />
          )}
        </div>
      </div>

      {/* Modal for add/edit */}
      <Modal
        open={isRouteModal || isDefaultModal}
        onClose={() => { setModalMode(null); setForm(emptyForm) }}
        title={
          modalMode === 'add-route' ? 'Add Route' :
          modalMode === 'edit-route' ? 'Edit Route' :
          modalMode === 'add-default' ? 'Add Tenant Default' :
          'Edit Tenant Default'
        }
        footer={
          <>
            <button
              onClick={() => { setModalMode(null); setForm(emptyForm) }}
              className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit as () => void}
              disabled={saving || !form.key || !form.agent || !form.host}
              className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </>
        }
      >
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">
              {isRouteModal ? 'Email Address' : 'Tenant Name'}
            </label>
            <input
              type="text"
              value={form.key}
              onChange={(e) => setForm({ ...form, key: e.target.value })}
              placeholder={isRouteModal ? 'agent@tenant.example.com' : 'tenant-name'}
              className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-md text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Agent</label>
            <input
              type="text"
              value={form.agent}
              onChange={(e) => setForm({ ...form, agent: e.target.value })}
              placeholder="agent-name"
              className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-md text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Host</label>
            <input
              type="text"
              value={form.host}
              onChange={(e) => setForm({ ...form, host: e.target.value })}
              placeholder="host-id"
              className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded-md text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
          </div>
        </form>
      </Modal>
    </div>
  )
}
