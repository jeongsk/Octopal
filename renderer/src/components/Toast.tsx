import { useEffect, useState, useCallback, useRef } from 'react'

export type ToastType = 'info' | 'success' | 'error' | 'warning'

export interface ToastItem {
  id: string
  type: ToastType
  title: string
  message?: string
  /** Auto-dismiss after ms (0 = sticky). Default 5000 */
  duration?: number
  /** Optional progress (0–100) — shows a bar when set */
  progress?: number
  /** Optional action button */
  action?: { label: string; onClick: () => void }
}

let toastCounter = 0
let globalAddToast: ((toast: Omit<ToastItem, 'id'>) => string) | null = null
let globalUpdateToast: ((id: string, patch: Partial<Omit<ToastItem, 'id'>>) => void) | null = null
let globalRemoveToast: ((id: string) => void) | null = null

/** Imperatively show a toast from anywhere. Returns toast id. */
export function showToast(toast: Omit<ToastItem, 'id'>): string {
  if (globalAddToast) return globalAddToast(toast)
  return ''
}

/** Update an existing toast by id (e.g. change progress, message, type). */
export function updateToast(id: string, patch: Partial<Omit<ToastItem, 'id'>>) {
  if (globalUpdateToast) globalUpdateToast(id, patch)
}

/** Remove a toast by id. */
export function removeToast(id: string) {
  if (globalRemoveToast) globalRemoveToast(id)
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    const timer = timersRef.current.get(id)
    if (timer) { clearTimeout(timer); timersRef.current.delete(id) }
  }, [])

  const add = useCallback((toast: Omit<ToastItem, 'id'>): string => {
    const id = `toast-${++toastCounter}`
    const item: ToastItem = { ...toast, id }
    setToasts((prev) => [...prev, item])
    const dur = toast.duration ?? 5000
    if (dur > 0) {
      timersRef.current.set(id, setTimeout(() => remove(id), dur))
    }
    return id
  }, [remove])

  const update = useCallback((id: string, patch: Partial<Omit<ToastItem, 'id'>>) => {
    setToasts((prev) => prev.map((t) => t.id === id ? { ...t, ...patch } : t))
    // If changing to a type that should auto-dismiss and it was sticky, schedule removal
    if (patch.duration && patch.duration > 0 && !timersRef.current.has(id)) {
      timersRef.current.set(id, setTimeout(() => remove(id), patch.duration))
    }
  }, [remove])

  useEffect(() => {
    globalAddToast = add
    globalUpdateToast = update
    globalRemoveToast = remove
    return () => { globalAddToast = null; globalUpdateToast = null; globalRemoveToast = null }
  }, [add, update, remove])

  if (toasts.length === 0) return null

  return (
    <div className="toast-container">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.type}`}>
          <div className="toast-icon">
            {toast.type === 'success' && '✓'}
            {toast.type === 'error' && '✕'}
            {toast.type === 'warning' && '⚠'}
            {toast.type === 'info' && 'ℹ'}
          </div>
          <div className="toast-body">
            <div className="toast-title">{toast.title}</div>
            {toast.message && <div className="toast-message">{toast.message}</div>}
            {toast.progress !== undefined && (
              <div className="toast-progress-track">
                <div
                  className="toast-progress-bar"
                  style={{ width: `${Math.min(100, Math.max(0, toast.progress))}%` }}
                />
              </div>
            )}
            {toast.action && (
              <button className="toast-action" onClick={toast.action.onClick}>
                {toast.action.label}
              </button>
            )}
          </div>
          <button className="toast-close" onClick={() => remove(toast.id)}>×</button>
        </div>
      ))}
    </div>
  )
}
