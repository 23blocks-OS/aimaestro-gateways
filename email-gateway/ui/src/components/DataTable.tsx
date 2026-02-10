import { ReactNode } from 'react'

interface Column<T> {
  key: string
  header: string
  render: (row: T) => ReactNode
  className?: string
}

interface DataTableProps<T> {
  columns: Column<T>[]
  data: T[]
  keyExtractor: (row: T) => string
  onRowClick?: (row: T) => void
  emptyMessage?: string
}

export default function DataTable<T>({
  columns,
  data,
  keyExtractor,
  onRowClick,
  emptyMessage = 'No data',
}: DataTableProps<T>) {
  if (data.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500 text-sm">
        {emptyMessage}
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-800">
            {columns.map((col) => (
              <th
                key={col.key}
                className={`text-left py-2.5 px-3 text-xs font-medium text-gray-500 uppercase tracking-wider ${col.className || ''}`}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr
              key={keyExtractor(row)}
              onClick={() => onRowClick?.(row)}
              className={`border-b border-gray-800/50 ${
                onRowClick ? 'cursor-pointer hover:bg-gray-800/30' : ''
              }`}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={`py-2.5 px-3 text-gray-300 ${col.className || ''}`}
                >
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export type { Column }
