'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Save } from 'lucide-react'

export default function SettingsPage() {
  const [banner, setBanner] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/admin/settings')
      .then(r => r.json())
      .then(data => {
        setBanner(data.banner || '')
        setLoading(false)
      })
      .catch(() => {
        setError('Failed to load settings')
        setLoading(false)
      })
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ banner }),
      })
      if (!res.ok) {
        const data = await res.json()
        setError(data.error || 'Failed to save')
      } else {
        setSaved(true)
        setTimeout(() => setSaved(false), 3000)
      }
    } catch {
      setError('Failed to save settings')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground">Org-wide configuration for all Claude Code users</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Banner Message</CardTitle>
          <CardDescription>
            Displayed to all users on every <code className="text-xs bg-muted px-1 py-0.5 rounded">claude</code> startup.
            Leave empty to show no banner.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="banner" className="text-sm font-medium">Banner text</label>
            <Input
              id="banner"
              placeholder="e.g. Deploy freeze until Friday. Use feature branches only."
              value={loading ? '' : banner}
              disabled={loading}
              onChange={e => setBanner(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSave()}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {saved && <p className="text-sm text-green-600">Saved! Users will see it on next <code className="text-xs bg-muted px-1 py-0.5 rounded">claude</code> startup.</p>}
          <Button onClick={handleSave} disabled={loading || saving}>
            <Save className="h-4 w-4 mr-2" />
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
