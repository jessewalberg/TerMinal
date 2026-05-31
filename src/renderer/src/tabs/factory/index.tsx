import { useEffect, useState } from 'react'
import {
  Factory,
  GitPullRequest,
  Ticket,
  Bot,
  Clock,
  AlertTriangle,
  CalendarClock,
  GaugeCircle,
  Inbox,
  RefreshCw,
} from 'lucide-react'
import { Card, Stat, Row, Gauge, Badge, Empty } from '../../components/ui'
import type { Tab, FactoryHealth, WindowStats } from '../../lib/types'
import { fmtNum, fmtAgo } from '../../lib/format'

// Factory health — the cross-repo rollup the harness already computes in
// factory-health.ts + cycle.ts (throughput, run success rates, cycle time +
// funnel, recent failures, a daily sparkline, top repos) but surfaced nowhere.
// Read-only: one window.gt.factory.health() poll, no new main-side code.
// Global, not repo-scoped (appliesTo: always) — it's the whole factory.

const runTone = (pct: number, total: number) => (total === 0 ? 'mute' : pct >= 80 ? 'ok' : pct >= 50 ? 'warn' : 'bad')
const hours = (h: number | null) => (h == null ? '—' : h < 1 ? `${Math.round(h * 60)}m` : `${h}h`)

function Throughput({ title, w }: { title: string; w: WindowStats }) {
  return (
    <Card icon={GitPullRequest} title={title}>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        <Stat label="PRs opened" value={fmtNum(w.prsOpened)} />
        <Stat label="merged" value={fmtNum(w.prsMerged)} />
        <Stat label="reviews" value={fmtNum(w.reviews)} />
        <Stat label="tickets filed" value={fmtNum(w.ticketsFiled)} />
        <Stat label="closed" value={fmtNum(w.ticketsClosed)} />
        <Stat label="agent runs" value={fmtNum(w.agentRuns)} />
        <Stat label="tests ✓" value={fmtNum(w.testsPass)} />
        <Stat label="tests ✗" value={fmtNum(w.testsFail)} />
        <Stat label="blocked" value={fmtNum(w.blocked)} />
      </div>
    </Card>
  )
}

function RunCard({
  icon,
  title,
  total,
  done,
  failed,
  running,
  successRate,
  extra,
}: {
  icon: typeof Bot
  title: string
  total: number
  done: number
  failed: number
  running: number
  successRate: number
  extra?: string
}) {
  return (
    <Card
      icon={icon}
      title={title}
      right={<Badge tone={runTone(successRate, total)}>{total === 0 ? 'no runs' : `${successRate}% ok`}</Badge>}
    >
      <Gauge pct={successRate} color={total === 0 ? 'var(--gt-border)' : undefined} />
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
        <Stat label="total" value={fmtNum(total)} />
        <Stat label="done" value={fmtNum(done)} />
        <Stat label="failed" value={fmtNum(failed)} />
        <Stat label="running" value={fmtNum(running)} />
        {extra && <Stat label="recent fails" value={extra} />}
      </div>
    </Card>
  )
}

function Sparkline({ daily }: { daily: { day: string; count: number }[] }) {
  const max = Math.max(1, ...daily.map((d) => d.count))
  return (
    <div className="flex h-12 items-end gap-[3px]">
      {daily.map((d) => (
        <div key={d.day} className="flex-1" title={`${d.day}: ${d.count}`}>
          <div
            className="w-full rounded-sm bg-[var(--gt-accent-2)]/70"
            style={{ height: `${Math.max(2, (d.count / max) * 100)}%` }}
          />
        </div>
      ))}
    </div>
  )
}

function FactoryTab() {
  const [h, setH] = useState<FactoryHealth | null>(null)
  const [loading, setLoading] = useState(true)

  const load = () => window.gt.factory.health().then((d) => {
    setH(d)
    setLoading(false)
  })

  useEffect(() => {
    load()
    const id = setInterval(load, 15_000)
    return () => clearInterval(id)
  }, [])

  if (loading && !h)
    return <div className="p-6 text-[12px] text-zinc-500">Loading factory health…</div>
  if (!h) return <Empty>No factory activity yet.</Empty>

  return (
    <div className="h-full overflow-y-auto px-4 py-3">
      <div className="mb-3 flex items-center gap-2">
        <Factory size={15} strokeWidth={2} className="text-[var(--gt-accent-light)]" />
        <h2 className="text-[13px] font-bold text-zinc-100">Factory health</h2>
        <span className="text-[10.5px] text-zinc-600">across all repos · updated {fmtAgo(h.generatedAt)}</span>
        <button
          onClick={load}
          className="ml-auto flex items-center gap-1 rounded-md border border-[var(--gt-border)] px-2 py-1 text-[10.5px] text-zinc-400 hover:border-[var(--gt-accent)]/60 hover:text-zinc-200"
        >
          <RefreshCw size={11} strokeWidth={2} /> refresh
        </button>
      </div>

      <div className="grid grid-cols-1 gap-x-3 lg:grid-cols-2">
        <Throughput title="Last 24h" w={h.window24h} />
        <Throughput title="Last 7d" w={h.window7d} />
        <RunCard icon={Bot} title="Agent runs" {...h.agents} />
        <RunCard
          icon={CalendarClock}
          title="Scheduled runs"
          {...h.cron}
          extra={h.cron.recentFailures ? fmtNum(h.cron.recentFailures) : undefined}
        />

        <Card icon={GaugeCircle} title="Cycle time (last 30d)">
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            <Stat label="merged" value={fmtNum(h.cycle.merged)} />
            <Stat label="filed→merged" value={hours(h.cycle.medianHours)} />
            <Stat label="filed→open" value={hours(h.cycle.fileToOpenHours)} />
            <Stat label="open→merged" value={hours(h.cycle.openToMergeHours)} />
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-zinc-400">
            <span className="text-zinc-500">7d funnel:</span>
            <Badge tone="mute">{fmtNum(h.funnel.filed)} filed</Badge>
            <span className="text-zinc-600">→</span>
            <Badge tone="blue">{fmtNum(h.funnel.opened)} opened</Badge>
            <span className="text-zinc-600">→</span>
            <Badge tone="ok">{fmtNum(h.funnel.merged)} merged</Badge>
          </div>
        </Card>

        <Card icon={Inbox} title="Waiting on you (HITL)">
          <Row label="open items" value={<Badge tone={h.hitlOpen ? 'warn' : 'ok'}>{fmtNum(h.hitlOpen)}</Badge>} />
        </Card>

        <Card icon={Clock} title="Activity (14d)">
          {h.daily.length ? <Sparkline daily={h.daily} /> : <Empty>No events.</Empty>}
        </Card>

        <Card icon={Factory} title="Most active repos">
          {h.byRepo.length ? (
            h.byRepo.slice(0, 6).map((r) => <Row key={r.repo} label={r.repo} value={`${fmtNum(r.events)} ev`} />)
          ) : (
            <Empty>No repos yet.</Empty>
          )}
        </Card>
      </div>

      <Card icon={AlertTriangle} title="Recent failures">
        {h.recentFailures.length ? (
          <div className="space-y-1">
            {h.recentFailures.slice(0, 8).map((f, i) => (
              <div key={i} className="flex items-center gap-2 text-[11.5px]">
                <Badge tone="bad">{f.kind}</Badge>
                <span className="min-w-0 flex-1 truncate text-zinc-300">{f.title}</span>
                {f.repo && <span className="shrink-0 text-zinc-600">{f.repo}</span>}
                <span className="shrink-0 text-zinc-600">{fmtAgo(f.ts)}</span>
              </div>
            ))}
          </div>
        ) : (
          <Empty>No recent failures. 🎉</Empty>
        )}
      </Card>
    </div>
  )
}

const tab: Tab = {
  id: 'factory',
  title: 'Factory',
  icon: Factory,
  order: 3.6, // right after the Runs (3.45) / Schedules (3.5) / CI (3.55) cluster
  appliesTo: () => true, // global rollup — not repo-scoped
  Component: FactoryTab,
}
export default tab
