import { ReactNode, useEffect, useRef } from 'react'
import { X } from 'lucide-react'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
}

export default function Modal({ open, onClose, title, children, footer }: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open) {
      dialog.showModal()
    } else {
      dialog.close()
    }
  }, [open])

  if (!open) return null

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      className="bg-gray-900 border border-gray-700 rounded-lg shadow-xl p-0 backdrop:bg-black/60 max-w-lg w-full"
    >
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700">
        <h3 className="text-sm font-semibold text-gray-100">{title}</h3>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-300 transition-colors"
        >
          <X size={16} />
        </button>
      </div>
      <div className="px-5 py-4">{children}</div>
      {footer && (
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-700">
          {footer}
        </div>
      )}
    </dialog>
  )
}
