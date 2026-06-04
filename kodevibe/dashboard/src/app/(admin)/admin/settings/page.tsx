'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import {
  Save, Plus, Pencil, Trash2, Eye, EyeOff, CheckCircle, XCircle, Star,
} from 'lucide-react'
import { PROVIDERS, providerNeedsApiKey, type AiConfiguration } from '@/lib/ai-config'

// ── General settings ─────────────────────────────────────────────────────────

function GeneralSettings() {
  const [prefix, setPrefix] = useState('')
  const [banner, setBanner] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/admin/settings')
      .then(r => r.json())
      .then(d => { setPrefix(d.prefix || 'kodevibe'); setBanner(d.banner || ''); setLoading(false) })
      .catch(() => { setError('Failed to load'); setLoading(false) })
  }, [])

  async function save() {
    setSaving(true); setError(''); setSaved(false)
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix, banner }),
      })
      if (!res.ok) { const d = await res.json(); setError(d.error || 'Failed'); return }
      setSaved(true); setTimeout(() => setSaved(false), 3000)
    } catch { setError('Failed to save') }
    finally { setSaving(false) }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>CLI Prefix</CardTitle>
          <CardDescription>
            The tag shown before every line of shim output, e.g.{' '}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">[kode:harness]</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            placeholder="kodevibe"
            value={loading ? '' : prefix}
            disabled={loading}
            onChange={e => setPrefix(e.target.value)}
            className="max-w-xs font-mono"
          />
          <p className="text-xs text-muted-foreground">
            Preview: <code className="bg-muted px-1 py-0.5 rounded">[{prefix || 'kodevibe'}] Ready! Hi you</code>
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Banner Message</CardTitle>
          <CardDescription>
            Displayed to all users on every{' '}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">claude</code> startup.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Input
            placeholder="e.g. Deploy freeze until Friday."
            value={loading ? '' : banner}
            disabled={loading}
            onChange={e => setBanner(e.target.value)}
          />
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {saved && <p className="text-sm text-green-600">저장되었습니다.</p>}
      <Button onClick={save} disabled={loading || saving}>
        <Save className="h-4 w-4 mr-2" />
        {saving ? '저장 중…' : '저장'}
      </Button>
    </>
  )
}

// ── AI Configuration CRUD ─────────────────────────────────────────────────────

type AiConfigRow = Omit<AiConfiguration, 'api_key'> & { api_key: string }

interface ConfigFormState {
  name: string
  provider: string
  base_url: string
  api_key: string
  model: string
  is_default: boolean
}

const BLANK: ConfigFormState = {
  name: '', provider: 'litellm', base_url: 'http://host.docker.internal:4000', api_key: '', model: 'Qwen3.5-122B-A10B-FP8', is_default: false,
}

const DEFAULT_SYSTEM_PROMPT_PLACEHOLDER = `You are an AI efficiency consultant specializing in token optimization for Claude Code sessions.
Analyze the session metrics and provide specific, actionable recommendations in Korean.

## 📊 세션 요약 / ## ⚡ 캐시 효율 분석 / ## 📈 토큰 사용 패턴 / ## 🛠️ Tool 사용 최적화 / ## 💡 최적화 제안 / ## 📝 프롬프트 품질`

function SystemPromptSettings() {
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/admin/settings')
      .then(r => r.json())
      .then(d => { setPrompt(d.ai_analysis_system_prompt || ''); setLoading(false) })
      .catch(() => { setError('Failed to load'); setLoading(false) })
  }, [])

  async function save() {
    setSaving(true); setError(''); setSaved(false)
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ai_analysis_system_prompt: prompt }),
      })
      if (!res.ok) { const d = await res.json(); setError(d.error || 'Failed'); return }
      setSaved(true); setTimeout(() => setSaved(false), 3000)
    } catch { setError('Failed to save') }
    finally { setSaving(false) }
  }

  function reset() {
    setPrompt('')
    setSaved(false)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>AI 분석 System Prompt</CardTitle>
        <CardDescription>
          세션 상세 페이지의 AI 토큰 최적화 분석에 사용되는 system prompt입니다.
          비워두면 기본 프롬프트를 사용합니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          placeholder={DEFAULT_SYSTEM_PROMPT_PLACEHOLDER}
          value={loading ? '' : prompt}
          disabled={loading}
          onChange={e => setPrompt(e.target.value)}
          rows={12}
          className="font-mono text-xs resize-y"
        />
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={save} disabled={loading || saving}>
            <Save className="h-3.5 w-3.5 mr-1.5" />
            {saving ? '저장 중…' : '저장'}
          </Button>
          <Button size="sm" variant="outline" onClick={reset} disabled={loading || !prompt}>
            기본값으로 초기화
          </Button>
          {saved && <span className="text-xs text-green-600">저장되었습니다.</span>}
          {error && <span className="text-xs text-destructive">{error}</span>}
        </div>
      </CardContent>
    </Card>
  )
}

function AiConfigurations() {
  const [configs, setConfigs] = useState<AiConfigRow[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState<ConfigFormState>(BLANK)
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [formError, setFormError] = useState('')

  const selectedProvider = PROVIDERS.find(p => p.id === form.provider)

  useEffect(() => { loadConfigs() }, [])

  async function loadConfigs() {
    setLoading(true)
    const res = await fetch('/api/admin/ai-configs')
    if (res.ok) setConfigs(await res.json())
    setLoading(false)
  }

  function openCreate() {
    setEditId(null)
    setForm(BLANK)
    setShowKey(false)
    setTestResult(null)
    setFormError('')
    setDialogOpen(true)
  }

  function openEdit(c: AiConfigRow) {
    setEditId(c.id)
    setForm({
      name: c.name, provider: c.provider, base_url: c.base_url,
      api_key: c.api_key, model: c.model, is_default: c.is_default,
    })
    setShowKey(false)
    setTestResult(null)
    setFormError('')
    setDialogOpen(true)
  }

  function handleProviderChange(providerId: string) {
    const p = PROVIDERS.find(x => x.id === providerId)
    setForm(f => ({
      ...f,
      provider: providerId,
      base_url: p?.baseUrl ?? '',
      model: p?.defaultModel ?? '',
    }))
  }

  async function handleSave() {
    if (!form.name || !form.provider || !form.model) {
      setFormError('이름, Provider, Model은 필수입니다.'); return
    }
    setSaving(true); setFormError('')
    try {
      const url = editId ? `/api/admin/ai-configs/${editId}` : '/api/admin/ai-configs'
      const method = editId ? 'PATCH' : 'POST'
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!res.ok) { const d = await res.json(); setFormError(d.error || 'Failed'); return }
      setDialogOpen(false)
      await loadConfigs()
    } catch { setFormError('저장 실패') }
    finally { setSaving(false) }
  }

  async function handleDelete(id: string) {
    if (!confirm('이 AI 설정을 삭제하시겠습니까?')) return
    await fetch(`/api/admin/ai-configs/${id}`, { method: 'DELETE' })
    await loadConfigs()
  }

  async function handleTest() {
    setTesting(true); setTestResult(null)
    try {
      const res = await fetch('/api/admin/ai-configs/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(editId && form.api_key.includes('****') ? { id: editId } : {}),
          provider: form.provider,
          base_url: form.base_url || selectedProvider?.baseUrl,
          api_key: form.api_key.includes('****') ? undefined : form.api_key,
          model: form.model,
        }),
      })
      const data = await res.json().catch(() => ({}))
      setTestResult(res.ok
        ? { ok: true, message: '연결 성공' }
        : { ok: false, message: data.error || `HTTP ${res.status}` }
      )
    } catch (err) {
      setTestResult({ ok: false, message: String(err) })
    }
    setTesting(false)
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>AI Configurations</CardTitle>
            <CardDescription>
              세션 분석과 AI 챗봇에 사용할 API Provider를 설정합니다.
            </CardDescription>
          </div>
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4 mr-1" />추가
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">로딩 중…</p>
        ) : configs.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground mb-3">설정된 AI Provider가 없습니다.</p>
            <Button size="sm" variant="outline" onClick={openCreate}>
              <Plus className="h-4 w-4 mr-1" />첫 번째 설정 추가
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {configs.map(c => {
              const provider = PROVIDERS.find(p => p.id === c.provider)
              return (
                <div key={c.id} className="flex items-center gap-3 rounded-lg border px-4 py-3 hover:bg-muted/30">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{c.name}</span>
                      {c.is_default && (
                        <Badge variant="outline" className="text-xs gap-1">
                          <Star className="h-2.5 w-2.5 fill-amber-400 text-amber-400" />기본
                        </Badge>
                      )}
                      <Badge variant="secondary" className="text-xs">{provider?.label ?? c.provider}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 font-mono">{c.model}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => openEdit(c)}
                      className="p-1.5 text-muted-foreground hover:text-foreground rounded hover:bg-muted transition-colors"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => handleDelete(c.id)}
                      className="p-1.5 text-muted-foreground hover:text-destructive rounded hover:bg-muted transition-colors"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>

      {/* Add / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editId ? 'AI 설정 편집' : '새 AI 설정 추가'}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Name */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">이름</label>
              <Input
                placeholder="예: Claude (Anthropic)"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              />
            </div>

            {/* Provider */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">API Provider</label>
              <select
                value={form.provider}
                onChange={e => handleProviderChange(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {PROVIDERS.map(p => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </div>

            {/* Base URL */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                Base URL
                {!selectedProvider?.requiresBaseUrl && (
                  <span className="ml-1 text-xs text-muted-foreground">(자동 설정됨)</span>
                )}
              </label>
              <Input
                placeholder={selectedProvider?.baseUrl || 'https://...'}
                value={form.base_url}
                onChange={e => setForm(f => ({ ...f, base_url: e.target.value }))}
                className="font-mono text-sm"
              />
            </div>

            {/* API Key */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">API Key</label>
              <div className="relative">
                <Input
                  type={showKey ? 'text' : 'password'}
                  placeholder="sk-..."
                  value={form.api_key}
                  onChange={e => setForm(f => ({ ...f, api_key: e.target.value }))}
                  className="font-mono text-sm pr-9"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(v => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {/* Model */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Model</label>
              {selectedProvider && selectedProvider.models.length > 0 ? (
                <select
                  value={form.model}
                  onChange={e => setForm(f => ({ ...f, model: e.target.value }))}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {selectedProvider.models.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              ) : (
                <Input
                  placeholder={selectedProvider?.defaultModel || 'model-id'}
                  value={form.model}
                  onChange={e => setForm(f => ({ ...f, model: e.target.value }))}
                  className="font-mono text-sm"
                />
              )}
            </div>

            {/* Default toggle */}
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={form.is_default}
                onChange={e => setForm(f => ({ ...f, is_default: e.target.checked }))}
                className="rounded"
              />
              <span className="text-sm">기본 설정으로 사용</span>
            </label>

            {/* Test connection */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={handleTest} disabled={testing || !form.model || (!form.api_key && providerNeedsApiKey(form.provider))}>
                  {testing ? '테스트 중…' : '연결 테스트'}
                </Button>
                {testResult?.ok && (
                  <span className="text-xs text-green-600 flex items-center gap-1">
                    <CheckCircle className="h-3.5 w-3.5" />{testResult.message}
                  </span>
                )}
              </div>
              {testResult && !testResult.ok && (
                <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2">
                  <XCircle className="h-3.5 w-3.5 text-red-500 mt-0.5 shrink-0" />
                  <p className="text-xs text-red-700 break-all">{testResult.message}</p>
                </div>
              )}
            </div>

            {formError && <p className="text-sm text-destructive">{formError}</p>}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>취소</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? '저장 중…' : '저장'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground">Org-wide configuration for all Claude Code users</p>
      </div>
      <GeneralSettings />
      <AiConfigurations />
      <SystemPromptSettings />
    </div>
  )
}
