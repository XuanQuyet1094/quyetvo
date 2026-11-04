import type { Page, Response } from 'patchright'
import { emitEvidence } from '../../../automation/Compatibility'

// Fixed vocabulary only. Never emit text, URLs, arbitrary object keys, numbers from the UI, or raw payloads.
const keyNames = [
    'dashboard', 'userStatus', 'userInfo', 'flyoutResult', 'data', 'result', 'counters', 'counter',
    'earn', 'pointsBreakdown', 'search', 'searches', 'searchQuota', 'searchProgress', 'searchPoints',
    'searchPointsEarned', 'searchPointsLimit', 'dailySearch', 'dailySearchPoints', 'searchCounters',
    'pcSearch', 'desktopSearch', 'mobileSearch', 'device', 'devices', 'platform', 'platforms', 'pc',
    'mobile', 'desktop', 'progress', 'pointProgress', 'pointProgressMax', 'earned', 'earnedPoints',
    'maximum', 'max', 'maxPoints', 'limit', 'remaining', 'remainingPoints', 'points', 'status',
    'dailyLimit', 'activityAndQuiz', 'dailyPoint', 'activities', 'rewards', 'offers', 'promotions',
    'streak', 'streaks', 'bonus', 'pointLimit', 'pointsEarned', 'pointsLimit', 'quota', 'quotas'
] as const
const fixedKeys = new Map<string, string>(keyNames.map(name => [name.toLowerCase(), name]))
const atoms = [
    'search', 'mobile', 'desktop', 'quota', 'counter', 'progress', 'breakdown', 'limit', 'earned',
    'remaining', 'device', 'platform', 'points', 'daily'
]
const scalar = (x: unknown) => x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x
function safeKey(raw: string): string {
    if (raw.length > 80) return '*'
    const key = raw.toLowerCase()
    const exact = fixedKeys.get(key)
    if (exact) return exact
    const parts = atoms.filter(a => key.includes(a))
    return parts.length ? '~' + parts.join('+') : '*'
}

export function inspectPayload(payload: unknown) {
    const branches = new Map<string, { path: string; keys: string[]; hidden: number }>()
    let visited = 0
    function visit(value: unknown, path: string, depth: number, related: boolean) {
        if (++visited > 2500 || depth > 10 || value === null || typeof value !== 'object') return
        if (Array.isArray(value)) {
            for (const child of value.slice(0, 12)) visit(child, path + '[]', depth + 1, related)
            return
        }
        const entries = Object.entries(value)
        const keys = entries.map(([key, item]) => [safeKey(key), scalar(item)] as const)
        if (branches.size < 28 && (related || keys.some(([key]) => /search|quota|breakdown|counter/i.test(key)))) {
            const safe = [...new Set(keys.filter(([key]) => key !== '*').map(([key, type]) => key + ':' + type))].slice(0, 24)
            const hidden = keys.filter(([key]) => key === '*').length
            if (safe.length) branches.set(path + ':' + safe.join(','), { path, keys: safe, hidden })
        }
        for (const [key, item] of entries) {
            if (visited > 2500) break
            const segment = safeKey(key)
            visit(item, path + '.' + segment, depth + 1, /search|quota|breakdown|counter|^(mobile|desktop|pc)$/i.test(segment))
        }
    }
    visit(payload, '$', 0, false)
    return { visited: Math.min(visited, 2500), truncated: visited >= 2500, branches: [...branches.values()] }
}

const labelTests = {
    mobile: /\bmobile\b|di động|điện thoại/i,
    desktop: /\bdesktop\b|\bpc\b|máy tính/i,
    search: /\bsearch(?:es|ing)?\b|tìm kiếm/i,
    points: /\bpoints?\b|điểm/i,
    earned: /\b(?:earned|progress|collected)\b|đã (?:kiếm|nhận)|tiến độ/i,
    cap: /\b(?:max(?:imum)?|limit|quota|remaining)\b|tối đa|còn lại|giới hạn/i,
    streak: /\bstreak\b|chuỗi/i,
    breakdown: /\bbreakdown\b|(?:chi tiết|phân tích) điểm/i
}
const tags = (text: string) => Object.entries(labelTests).filter(([, test]) => test.test(text)).map(([name]) => name)
const ratio = (s: string) => /\b\d{1,5}\s*(?:\/|\bof\b|\btrên\b)\s*\d{1,5}\b/i.test(s)
export function inspectRows(text: string) {
    const rows = text.slice(0, 200000).split('\n').map(row => row.trim()).filter(Boolean).slice(0, 2500)
    const groups = new Map<string, { tags: string[]; ratio: boolean; adjacentRatio: boolean; count: number }>()
    for (let i = 0; i < rows.length; i++) {
        const t = tags(rows[i]!)
        if (!t.some(tag => ['mobile', 'desktop', 'search', 'breakdown'].includes(tag))) continue
        const own = ratio(rows[i]!)
        const adjacent = ratio(rows[i-1] ?? '') || ratio(rows[i+1] ?? '')
        const key = JSON.stringify([t, own, adjacent])
        const existing = groups.get(key)
        if (existing) existing.count++
        else if (groups.size < 25) groups.set(key, { tags: t, ratio: own, adjacentRatio: adjacent, count: 1 })
    }
    return [...groups.values()]
}

export async function inspectQuotaPage(page: Page, route: string, text: string, clicked: boolean, isMobile: boolean) {
    // The caller supplies only its two fixed route names. Browser-returned strings are classified, not emitted.
    const panels = await page.evaluate(() => {
        const visible = (e: Element) => e.getClientRects().length > 0
        const dialogs = Array.from(document.querySelectorAll('dialog[open],[role="dialog"],[aria-modal="true"]'))
            .filter(visible).slice(0, 4)
        const labels = Array.from(document.querySelectorAll('[aria-label],[role="progressbar"]')).filter(visible)
            .slice(0, 160).map(e => (e.getAttribute('aria-label') ?? '').slice(0, 250))
        return {
            dialogs: dialogs.map(e => (e as HTMLElement).innerText?.slice(0, 12000) ?? ''),
            labels,
            progressbars: Math.min(50, document.querySelectorAll('[role="progressbar"],progress').length)
        }
    }).catch(() => ({ dialogs: [], labels: [], progressbars: 0 }))
    emitEvidence('QUOTA_LAYOUT_DOM', {
        platform: isMobile ? 'mobile' : 'desktop', route, clicked, progressbars: panels.progressbars,
        page: inspectRows(text), dialogs: panels.dialogs.map(inspectRows), accessible: inspectRows(panels.labels.join('\n'))
    })
}

export function observeQuotaNetwork(page: Page, isMobile: boolean) {
    const seen: Array<Promise<unknown>> = []
    let candidates = 0
    const listener = (response: Response) => {
        try {
            const url = new URL(response.url())
            const request = response.request()
            const type = response.headers()['content-type'] ?? ''
            if (url.protocol !== 'https:' || !['rewards.bing.com','www.bing.com'].includes(url.hostname) ||
                request.method() !== 'GET' || !['fetch','xhr'].includes(request.resourceType()) || !/\bjson\b/i.test(type)) return
            candidates++
            const bytes = Number(response.headers()['content-length'] || 0)
            if (seen.length >= 16 || bytes > 1024 * 1024 || !response.ok()) return
            const kind = /getuserinfo/i.test(url.pathname) ? 'userinfo' :
                /breakdown|quota|counter|progress|earn|search/i.test(url.pathname) ? 'related' : 'other'
            seen.push(response.body().then(body => body.length > 1024 * 1024 ? { kind, status: response.status(), oversized: true }
                : { kind, status: response.status(), shape: inspectPayload(JSON.parse(body.toString('utf8'))) })
                .catch(() => ({ kind, status: response.status(), unavailable: true })))
        } catch { /* Do not log URLs, exception messages, or payloads. */ }
    }
    page.on('response', listener)
    return async () => {
        page.off('response', listener)
        let timer: ReturnType<typeof setTimeout> | undefined
        const replies = await Promise.race([
            Promise.all(seen),
            new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1500) })
        ])
        if (timer) clearTimeout(timer)
        emitEvidence('QUOTA_LAYOUT_NETWORK', { platform: isMobile ? 'mobile' : 'desktop', candidates, replies })
    }
}
