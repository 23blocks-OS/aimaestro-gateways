interface StatusBadgeProps {
  status: 'online' | 'offline' | 'error' | 'unknown'
  label?: string
  size?: 'sm' | 'md'
}

const statusStyles = {
  online: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  offline: 'bg-gray-500/10 text-gray-400 border-gray-500/20',
  error: 'bg-red-500/10 text-red-400 border-red-500/20',
  unknown: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
}

const dotStyles = {
  online: 'bg-emerald-400',
  offline: 'bg-gray-400',
  error: 'bg-red-400',
  unknown: 'bg-amber-400',
}

export default function StatusBadge({ status, label, size = 'md' }: StatusBadgeProps) {
  const sizeClasses = size === 'sm' ? 'text-xs px-2 py-0.5' : 'text-sm px-2.5 py-1'

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border ${statusStyles[status]} ${sizeClasses}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dotStyles[status]}`} />
      {label || status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  )
}
