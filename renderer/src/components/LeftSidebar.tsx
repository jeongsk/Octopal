import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { basename } from '../utils'
import { Plus, FolderOpen, ChevronDown, ChevronRight, X, BookOpen, Activity, Settings, LayoutGrid, MessageSquare } from 'lucide-react'
import type { Conversation } from '../types'
import { ConfirmModal } from './ConfirmModal'

interface LeftSidebarProps {
  activeWorkspace: Workspace | null
  state: AppState
  activeFolder: string | null
  centerTab: 'chat' | 'wiki' | 'activity' | 'settings' | 'tasks'
  setCenterTab: (tab: 'chat' | 'wiki' | 'activity' | 'settings' | 'tasks') => void
  activityCount: number
  workspaceMenuOpen: boolean
  setWorkspaceMenuOpen: (v: boolean | ((prev: boolean) => boolean)) => void
  setActiveFolder: (f: string | null) => void
  switchWorkspace: (id: string) => void
  removeWorkspace: (id: string) => void
  removeFolder: (p: string) => void
  pickFolder: () => void
  setShowCreateWorkspace: (v: boolean) => void
  conversations: Record<string, Conversation[]>
  activeConversationId: Record<string, string>
  onNewConversation: (folderPath: string) => void
  onSwitchConversation: (folderPath: string, conversationId: string) => void
  onRequestRenameConversation: (folderPath: string, conversation: Conversation) => void
  onDeleteConversation: (folderPath: string, conversationId: string) => void
}

export function LeftSidebar({
  activeWorkspace,
  state,
  activeFolder,
  centerTab,
  setCenterTab,
  activityCount,
  workspaceMenuOpen,
  setWorkspaceMenuOpen,
  setActiveFolder,
  switchWorkspace,
  removeWorkspace,
  removeFolder,
  pickFolder,
  setShowCreateWorkspace,
  conversations,
  activeConversationId,
  onNewConversation,
  onSwitchConversation,
  onRequestRenameConversation,
  onDeleteConversation,
}: LeftSidebarProps) {
  const { t } = useTranslation()
  const folders = activeWorkspace?.folders || []
  const menuRef = useRef<HTMLDivElement>(null)
  // Folders auto-expand when active. Users can collapse/expand each folder
  // independently — preference persists for the session via local state.
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    () => new Set(activeFolder ? [activeFolder] : []),
  )
  const [folderPendingDelete, setFolderPendingDelete] = useState<string | null>(null)
  const [convMenu, setConvMenu] = useState<
    | { folder: string; conv: Conversation; x: number; y: number }
    | null
  >(null)
  const [convPendingDelete, setConvPendingDelete] = useState<
    | { folder: string; conv: Conversation }
    | null
  >(null)

  useEffect(() => {
    if (!convMenu) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConvMenu(null)
    }
    const onMouseDown = () => setConvMenu(null)
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onMouseDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onMouseDown)
    }
  }, [convMenu])

  useEffect(() => {
    if (activeFolder) {
      setExpandedFolders((prev) => {
        if (prev.has(activeFolder)) return prev
        const next = new Set(prev)
        next.add(activeFolder)
        return next
      })
    }
  }, [activeFolder])

  const toggleFolderExpanded = (folder: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(folder)) next.delete(folder)
      else next.add(folder)
      return next
    })
  }

  useEffect(() => {
    if (!workspaceMenuOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setWorkspaceMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [workspaceMenuOpen, setWorkspaceMenuOpen])

  return (
    <aside className="left-sidebar">
      <div className="sidebar-header drag" data-tauri-drag-region />

      <div className="workspace-section" ref={menuRef}>
        <button
          className="workspace-switcher"
          onClick={() => setWorkspaceMenuOpen((v: boolean) => !v)}
        >
          <span className="workspace-name">{activeWorkspace?.name || 'Octopal'}</span>
          <span className="workspace-caret"><ChevronDown size={14} /></span>
        </button>
        {workspaceMenuOpen && (
          <div className="workspace-menu">
            {state.workspaces.map((w) => (
              <div
                key={w.id}
                className={`workspace-item ${w.id === state.activeWorkspaceId ? 'active' : ''}`}
                onClick={() => switchWorkspace(w.id)}
              >
                <span className="workspace-item-name">{w.name}</span>
                {state.workspaces.length > 1 && (
                  <button
                    className="workspace-item-remove"
                    onClick={(e) => {
                      e.stopPropagation()
                      removeWorkspace(w.id)
                    }}
                    title={t('sidebar.removeWorkspace')}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            ))}
            <div className="workspace-divider" />
            <button
              className="workspace-add"
              onClick={() => {
                setWorkspaceMenuOpen(false)
                setShowCreateWorkspace(true)
              }}
            >
              {t('sidebar.newWorkspace')}
            </button>
          </div>
        )}
      </div>
      <div className="sidebar-nav">
        <button
          className={`sidebar-nav-item ${centerTab === 'wiki' ? 'active' : ''}`}
          onClick={() => {
            if (centerTab === 'wiki') {
              if (!activeFolder && folders.length > 0) {
                setActiveFolder(folders[0])
              }
              setCenterTab('chat')
            } else {
              setActiveFolder(null)
              setCenterTab('wiki')
            }
          }}
          disabled={!state.activeWorkspaceId}
        >
          <BookOpen size={16} />
          <span>{t('sidebar.wiki')}</span>
        </button>
        <button
          className={`sidebar-nav-item ${centerTab === 'activity' ? 'active' : ''}`}
          onClick={() => {
            if (centerTab === 'activity') {
              if (!activeFolder && folders.length > 0) {
                setActiveFolder(folders[0])
              }
              setCenterTab('chat')
            } else {
              setCenterTab('activity')
            }
          }}
          disabled={!state.activeWorkspaceId}
        >
          <Activity size={16} />
          <span>{t('sidebar.activity')}</span>
          {activityCount > 0 && (
            <span className="sidebar-nav-badge">{activityCount}</span>
          )}
        </button>
        {/* TODO: Tasks menu temporarily hidden
        <button
          className={`sidebar-nav-item ${centerTab === 'tasks' ? 'active' : ''}`}
          onClick={() => {
            if (centerTab === 'tasks') {
              if (!activeFolder && folders.length > 0) {
                setActiveFolder(folders[0])
              }
              setCenterTab('chat')
            } else {
              setCenterTab('tasks')
            }
          }}
          disabled={!state.activeWorkspaceId}
        >
          <LayoutGrid size={16} />
          <span>Tasks</span>
        </button>
        */}
      </div>
      <div className="project-list">
        <button className="add-folder-btn" onClick={pickFolder} disabled={!activeWorkspace}>
          <Plus size={14} />
          <span>{t('sidebar.addFolder')}</span>
        </button>
        {folders.map((f) => {
          const isActive = f === activeFolder
          const isExpanded = expandedFolders.has(f)
          const folderConvs = conversations[f] || []
          const activeConvId = activeConversationId[f]
          return (
            <div key={f} className="project-group">
              <button
                className={`project-item ${isActive ? 'active' : ''}`}
                onClick={() => {
                  setActiveFolder(f)
                  setCenterTab('chat')
                  setExpandedFolders((prev) => {
                    const next = new Set(prev)
                    next.add(f)
                    return next
                  })
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setFolderPendingDelete(f)
                }}
                title={f}
              >
                <span
                  className="project-caret"
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleFolderExpanded(f)
                  }}
                  role="button"
                  aria-label={isExpanded ? 'Collapse' : 'Expand'}
                >
                  {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </span>
                <span className="project-icon"><FolderOpen size={16} /></span>
                <span className="project-name">{basename(f)}</span>
              </button>
              {isExpanded && (
                <div className="conversation-list">
                  {folderConvs.map((c) => (
                    <button
                      key={c.id}
                      className={`conversation-item ${c.id === activeConvId && isActive ? 'active' : ''}`}
                      onClick={() => onSwitchConversation(f, c.id)}
                      onDoubleClick={() => onRequestRenameConversation(f, c)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setConvMenu({ folder: f, conv: c, x: e.clientX, y: e.clientY })
                      }}
                      title={c.title}
                    >
                      <span className="conversation-icon"><MessageSquare size={12} /></span>
                      <span className="conversation-name">{c.title}</span>
                    </button>
                  ))}
                  <button
                    className="conversation-add"
                    onClick={() => onNewConversation(f)}
                  >
                    {t('conversations.addNew')}
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="sidebar-footer">
        <button
          className={`sidebar-footer-btn ${centerTab === 'settings' ? 'active' : ''}`}
          onClick={() => {
            if (centerTab === 'settings') {
              if (!activeFolder && folders.length > 0) {
                setActiveFolder(folders[0])
              }
              setCenterTab('chat')
            } else {
              setCenterTab('settings')
            }
          }}
        >
          <Settings size={16} />
          <span>{t('sidebar.settings')}</span>
        </button>
      </div>
      {folderPendingDelete && (
        <ConfirmModal
          title={t('sidebar.removeFolderTitle')}
          message={t('sidebar.removeFolderConfirm', { name: basename(folderPendingDelete) })}
          confirmLabel={t('common.delete')}
          cancelLabel={t('common.cancel')}
          variant="danger"
          onConfirm={() => {
            const target = folderPendingDelete
            setFolderPendingDelete(null)
            removeFolder(target)
          }}
          onCancel={() => setFolderPendingDelete(null)}
        />
      )}
      {convMenu && (
        <div
          className="context-menu"
          style={{
            top: Math.min(convMenu.y, window.innerHeight - 96),
            left: Math.min(convMenu.x, window.innerWidth - 168),
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
          role="menu"
        >
          <button
            className="context-menu-item"
            onClick={() => {
              const m = convMenu
              setConvMenu(null)
              onRequestRenameConversation(m.folder, m.conv)
            }}
          >
            {t('conversations.rename')}
          </button>
          <button
            className="context-menu-item context-menu-item--danger"
            onClick={() => {
              const m = convMenu
              setConvMenu(null)
              setConvPendingDelete({ folder: m.folder, conv: m.conv })
            }}
          >
            {t('conversations.delete')}
          </button>
        </div>
      )}
      {convPendingDelete && (
        <ConfirmModal
          title={t('conversations.delete')}
          message={t('conversations.deleteConfirm', { title: convPendingDelete.conv.title })}
          confirmLabel={t('common.delete')}
          cancelLabel={t('common.cancel')}
          variant="danger"
          onConfirm={() => {
            const target = convPendingDelete
            setConvPendingDelete(null)
            onDeleteConversation(target.folder, target.conv.id)
          }}
          onCancel={() => setConvPendingDelete(null)}
        />
      )}
    </aside>
  )
}
