import { LucideIcon } from 'lucide-react'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description: string
  action?: {
    label: string
    onClick: () => void
  }
}

export default function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center mb-4">
        <Icon size={24} className="text-gray-500" />
      </div>
      <h3 className="text-sm font-medium text-gray-300 mb-1">{title}</h3>
      <p className="text-xs text-gray-500 max-w-xs">{description}</p>
      {action && (
        <button
          onClick={action.onClick}
          className="mt-4 px-3 py-1.5 text-xs font-medium text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-md hover:bg-blue-500/20 transition-colors"
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
