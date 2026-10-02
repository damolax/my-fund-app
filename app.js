(() => {
  'use strict'

  const STORAGE_KEY = 'my-fund-app-v1'
  const CONFIG = window.MY_FUND_CONFIG || {}
  const CLOUD_CONFIGURED = Boolean(CONFIG.neonAuthUrl && CONFIG.neonDataApiUrl)
  let CLOUD_ENABLED = false
  let CLOUD_UNAVAILABLE = false
  let authDb = null
  let db = null
  const ADMIN_EMAIL = String(CONFIG.adminEmail || 'oyekunleolalekan3168@gmail.com').trim().toLowerCase()

  const DEFAULT_DATA = {
    workspace: {
      id: 'local-workspace',
      name: 'My Fund App',
      default_currency: 'NGN',
      upkeep_percentage: 20,
    },
    people: [],
    transactions: [],
    budgets: [],
    goals: [],
  }

  const CURRENCIES = ['NGN', 'USD', 'GBP', 'EUR', 'GHS', 'CAD', 'AUD', 'KES', 'ZAR', 'JPY', 'CNY', 'INR', 'AED']
  const EXPENSE_CATEGORIES = ['PV', 'Upkeep', 'Investment', 'Other']

  let state = structuredClone(DEFAULT_DATA)
  let session = null
  let realtimeChannel = null
  let viewerTimer = null
  let busy = false
  let toastTimer = null
  let adminState = null
  let adminLoading = false
  let adminError = ''
  let passwordRecoveryMode = false
  let accessContext = null
  let approvalState = { requests: [], notifications: [], members: [], invites: [] }
  let contributorState = null
  let viewerState = null
  let viewerToken = ''
  let approvalLoading = false
  let approvalError = ''

  async function initializeCloudClients() {
    if (!CLOUD_CONFIGURED) return
    try {
      const client = await window.MY_FUND_CLOUD_READY
      if (!client?.auth) throw new Error('Neon cloud client did not initialize.')
      db = client
      authDb = client
      CLOUD_ENABLED = true
      CLOUD_UNAVAILABLE = false
    } catch (error) {
      console.error('Neon cloud initialization failed:', error)
      CLOUD_ENABLED = false
      CLOUD_UNAVAILABLE = true
    }
  }

  const ui = {
    mobileOpen: false,
    dashboardPreset: 'thisMonth',
    dashboardStart: '',
    dashboardEnd: '',
    personCurrency: {},
    personMonth: {},
    transactionPerson: 'all',
    transactionType: 'all',
    transactionCurrency: 'all',
    transactionPreset: 'thisMonth',
    transactionStart: '',
    transactionEnd: '',
    reportPerson: 'all',
    reportCurrency: 'all',
    reportPreset: 'thisMonth',
    reportStart: '',
    reportEnd: '',
  }

  function id() {
    return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  }

  function num(value) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }

  function round(value) {
    return Math.round((num(value) + Number.EPSILON) * 100) / 100
  }

  function today(date = new Date()) {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  function currentMonth() {
    return today().slice(0, 7)
  }

  function money(value, currency) {
    try {
      return new Intl.NumberFormat('en', {
        style: 'currency',
        currency,
        minimumFractionDigits: Number.isInteger(num(value)) ? 0 : 2,
        maximumFractionDigits: 2,
      }).format(num(value))
    } catch {
      return `${currency} ${num(value).toLocaleString()}`
    }
  }

  function formatDate(value) {
    if (!value) return 'Date unknown'
    try {
      return new Intl.DateTimeFormat('en', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }).format(new Date(`${String(value).slice(0, 10)}T12:00:00`))
    } catch {
      return value
    }
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;')
  }

  function initials(name) {
    return String(name || '?')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase()
  }

  function loadLocal() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      return raw ? { ...structuredClone(DEFAULT_DATA), ...JSON.parse(raw) } : structuredClone(DEFAULT_DATA)
    } catch {
      return structuredClone(DEFAULT_DATA)
    }
  }

  function saveLocal() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }

  function signedInEmail() {
    return String(session?.user?.email || '').trim().toLowerCase()
  }

  function isPlatformAdmin() {
    return CLOUD_ENABLED && signedInEmail() === ADMIN_EMAIL
  }

  async function touchAppUser() {
    if (!CLOUD_ENABLED || !session?.user) return
    const result = await db.rpc('mfa_touch_app_user', { p_email: signedInEmail() })
    if (result.error) throw result.error
  }

  async function refreshAdmin() {
    if (!isPlatformAdmin()) throw new Error('Platform admin access is restricted.')
    const result = await db.rpc('mfa_admin_overview')
    if (result.error) throw result.error
    adminState = result.data || { users: [], workspaces: [], people: [], transactions: [], budgets: [], goals: [] }
    adminError = ''
    return adminState
  }

  function isContributor() {
    return accessContext?.role === 'contributor'
  }

  function isOwner() {
    return accessContext?.role === 'owner'
  }

  async function refreshApprovalCenter() {
    if (!CLOUD_ENABLED || !session?.user || !isOwner()) return approvalState
    const result = await db.rpc('mfa_get_approval_center')
    if (result.error) throw result.error
    approvalState = result.data || { requests: [], notifications: [], members: [], invites: [] }
    approvalError = ''
    return approvalState
  }

  async function refreshContributorDashboard() {
    if (!CLOUD_ENABLED || !session?.user || !isContributor()) return null
    const result = await db.rpc('mfa_get_contributor_dashboard')
    if (result.error) throw result.error
    contributorState = result.data || null
    if (contributorState) {
      state = normalizeCloudData({
        workspace: contributorState.workspace,
        people: contributorState.person ? [contributorState.person] : [],
        transactions: contributorState.transactions || [],
        budgets: contributorState.budgets || [],
        goals: contributorState.goals || [],
      })
    }
    return contributorState
  }

  async function createContributorInvite(personId, email) {
    const result = await db.rpc('mfa_create_member_invite', {
      p_person_id: personId,
      p_email: String(email || '').trim().toLowerCase(),
    })
    if (result.error) throw result.error
    await refreshApprovalCenter()
    return result.data
  }

  async function acceptContributorInvite(token) {
    const result = await db.rpc('mfa_accept_member_invite', { p_token: token })
    if (result.error) throw result.error
    await refreshCloud()
    return result.data
  }

  async function setContributorStatus(memberId, status) {
    const result = await db.rpc('mfa_set_member_status', {
      p_member_id: memberId,
      p_status: status,
    })
    if (result.error) throw result.error
    await refreshApprovalCenter()
  }

  async function revokeContributorInvite(inviteId) {
    const result = await db.rpc('mfa_revoke_member_invite', { p_invite_id: inviteId })
    if (result.error) throw result.error
    await refreshApprovalCenter()
  }

  async function triggerRequestEmail(requestId) {
    if (!requestId || !db?.auth) return
    try {
      const token = (await db.auth.getJWTToken?.()) || session?.access_token || null
      if (!token) return
      await fetch('/api/record-request-email', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ request_id: requestId }),
      })
    } catch {
      // In-app notifications and the email outbox remain the source of truth if email delivery is unavailable.
    }
  }

  async function triggerLedgerEmail(transactionId, changeType) {
    if (!transactionId || !changeType || !db?.auth) return
    try {
      const token = (await db.auth.getJWTToken?.()) || session?.access_token || null
      if (!token) return
      await fetch('/api/person-ledger-email', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ transaction_id: transactionId, change_type: changeType }),
      })
    } catch {
      // The database outbox keeps the notification queued if immediate delivery fails.
    }
  }
  async function submitContributorRequest(values) {
    const result = await db.rpc('mfa_submit_record_request', {
      p_person_id: values.person_id,
      p_request_action: values.request_action || 'create',
      p_target_transaction_id: values.target_transaction_id || null,
      p_transaction_type: values.type,
      p_amount: round(values.amount),
      p_currency: String(values.currency || state.workspace.default_currency).trim().toUpperCase(),
      p_date: values.date_unknown || !values.date ? null : values.date,
      p_description: String(values.description || '').trim(),
      p_category: values.type === 'expense' ? values.category : null,
    })
    if (result.error) throw result.error
    await triggerRequestEmail(result.data?.id)
    await refreshContributorDashboard()
    return result.data
  }

  async function updateContributorRequest(requestId, values) {
    const result = await db.rpc('mfa_update_record_request', {
      p_request_id: requestId,
      p_transaction_type: values.type,
      p_amount: round(values.amount),
      p_currency: String(values.currency || state.workspace.default_currency).trim().toUpperCase(),
      p_date: values.date_unknown || !values.date ? null : values.date,
      p_description: String(values.description || '').trim(),
      p_category: values.type === 'expense' ? values.category : null,
    })
    if (result.error) throw result.error
    await triggerRequestEmail(requestId)
    await refreshContributorDashboard()
    return result.data
  }

  async function deleteContributorRequest(requestId) {
    const result = await db.rpc('mfa_delete_record_request', { p_request_id: requestId })
    if (result.error) throw result.error
    await refreshContributorDashboard()
  }

  async function reviewRecordRequest(requestId, decision, note = '') {
    const result = await db.rpc('mfa_review_record_request', {
      p_request_id: requestId,
      p_decision: decision,
      p_note: note || null,
    })
    if (result.error) throw result.error
    if (decision === 'approve' && result.data?.recorded_transaction_id) {
      await triggerLedgerEmail(result.data.recorded_transaction_id, 'created')
    }
    await refreshCloud()
    return result.data
  }

  async function markNotificationRead(notificationId) {
    const result = await db.rpc('mfa_mark_notification_read', { p_notification_id: notificationId })
    if (result.error) throw result.error
    if (isOwner()) await refreshApprovalCenter()
    else if (isContributor()) await refreshContributorDashboard()
  }

  function normalizeCloudData(payload) {
    return {
      workspace: payload.workspace,
      people: (payload.people || []).map((person) => ({
        ...person,
        starting_balances: person.starting_balances || {},
      })),
      transactions: payload.transactions || [],
      budgets: (payload.budgets || []).map((item) => ({
        ...item,
        month: String(item.month).slice(0, 7),
      })),
      goals: payload.goals || [],
    }
  }

  function getRoute() {
    const hash = location.hash || '#/dashboard'
    const clean = hash.replace(/^#\/?/, '')
    const [pathPart, queryPart = ''] = clean.split('?')
    return {
      path: `/${pathPart || 'dashboard'}`,
      segments: pathPart.split('/').filter(Boolean),
      query: new URLSearchParams(queryPart),
    }
  }

  function go(path) {
    location.hash = path.startsWith('#') ? path : `#${path.startsWith('/') ? path : `/${path}`}`
  }

  function dateRange(preset, customStart = '', customEnd = '') {
    const now = new Date()
    const end = today(now)
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0)
    const startOfYear = new Date(now.getFullYear(), 0, 1)
    const startOfLastYear = new Date(now.getFullYear() - 1, 0, 1)
    const endOfLastYear = new Date(now.getFullYear() - 1, 11, 31)
    const minusDays = (days) => {
      const d = new Date(now)
      d.setDate(d.getDate() - days)
      return today(d)
    }

    if (preset === 'today') return { start: end, end }
    if (preset === 'last7') return { start: minusDays(6), end }
    if (preset === 'thisMonth') return { start: today(startOfMonth), end }
    if (preset === 'lastMonth') return { start: today(startOfLastMonth), end: today(endOfLastMonth) }
    if (preset === 'last30') return { start: minusDays(29), end }
    if (preset === 'thisYear') return { start: today(startOfYear), end }
    if (preset === 'lastYear') return { start: today(startOfLastYear), end: today(endOfLastYear) }
    if (preset === 'custom') return { start: customStart, end: customEnd }
    return { start: '', end: '' }
  }

  function inRange(date, start, end) {
    if (!date) return !start && !end
    const normalized = String(date).slice(0, 10)
    if (start && normalized < start) return false
    if (end && normalized > end) return false
    return true
  }

  function startingBalanceFor(personOrId, currency, data = state) {
    const person = typeof personOrId === 'string'
      ? data.people.find((item) => item.id === personOrId)
      : personOrId
    return round(person?.starting_balances?.[currency] || 0)
  }

  function uniqueCurrencies(personId = null, data = state) {
    const set = new Set([data.workspace?.default_currency || 'NGN'])
    data.people
      .filter((item) => !personId || item.id === personId)
      .forEach((item) => Object.keys(item.starting_balances || {}).forEach((currency) => set.add(currency)))
    data.transactions
      .filter((item) => !personId || item.person_id === personId)
      .forEach((item) => set.add(item.currency))
    data.budgets
      .filter((item) => !personId || item.person_id === personId)
      .forEach((item) => set.add(item.currency))
    data.goals
      .filter((item) => !personId || item.person_id === personId)
      .forEach((item) => set.add(item.currency))
    return [...set]
  }

  function personPosition(personId, currency, throughDate = '', data = state) {
    const records = data.transactions.filter(
      (item) =>
        item.person_id === personId &&
        item.currency === currency &&
        (!throughDate || !item.date || String(item.date).slice(0, 10) <= throughDate),
    )
    const starting = startingBalanceFor(personId, currency, data)
    const income = records
      .filter((item) => item.type === 'income')
      .reduce((sum, item) => sum + num(item.amount), 0)
    const expenses = records
      .filter((item) => item.type === 'expense')
      .reduce((sum, item) => sum + num(item.amount), 0)
    return {
      starting,
      income: round(income),
      expenses: round(expenses),
      balance: round(starting + income - expenses),
    }
  }

  function transactionSortValue(item) {
    return `${item.date || '0000-00-00'}|${item.created_at || ''}`
  }

  function sortTransactions(records, descending = true) {
    return [...records].sort((a, b) => {
      const compared = transactionSortValue(a).localeCompare(transactionSortValue(b))
      return descending ? -compared : compared
    })
  }

  function workspacePosition(currency, data = state) {
    const positions = data.people.map((person) => ({
      person,
      ...personPosition(person.id, currency, '', data),
    }))
    const positive = round(positions.reduce((sum, item) => sum + Math.max(item.balance, 0), 0))
    const borrowed = round(
      positions.reduce((sum, item) => sum + Math.abs(Math.min(item.balance, 0)), 0),
    )
    return {
      currency,
      positive,
      borrowed,
      net: round(positive - borrowed),
      income: round(positions.reduce((sum, item) => sum + item.income, 0)),
      expenses: round(positions.reduce((sum, item) => sum + item.expenses, 0)),
      positions,
    }
  }

  function monthlyIncome(personId, currency, month, data = state) {
    return round(
      data.transactions
        .filter(
          (item) =>
            item.person_id === personId &&
            item.currency === currency &&
            item.type === 'income' &&
            String(item.date).slice(0, 7) === month,
        )
        .reduce((sum, item) => sum + num(item.amount), 0),
    )
  }

  function monthlySpend(personId, currency, month, category, data = state) {
    return round(
      data.transactions
        .filter(
          (item) =>
            item.person_id === personId &&
            item.currency === currency &&
            item.type === 'expense' &&
            item.category === category &&
            String(item.date).slice(0, 7) === month,
        )
        .reduce((sum, item) => sum + num(item.amount), 0),
    )
  }

  function getBudget(personId, currency, month, data = state) {
    return data.budgets.find(
      (item) => item.person_id === personId && item.currency === currency && item.month === month,
    )
  }

  function personById(personId, data = state) {
    return data.people.find((person) => person.id === personId)
  }

  function dateOptions(selected) {
    const options = [
      ['today', 'Today'],
      ['last7', 'Last 7 days'],
      ['thisMonth', 'This month'],
      ['lastMonth', 'Last month'],
      ['last30', 'Last 30 days'],
      ['thisYear', 'This year'],
      ['lastYear', 'Last year'],
      ['all', 'All time'],
      ['custom', 'Custom range'],
    ]
    return options
      .map(([value, label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`)
      .join('')
  }

  function currencyOptions(selected, includeAll = false) {
    const values = includeAll ? ['all', ...uniqueCurrencies()] : CURRENCIES
    return values
      .map((currency) => {
        const label = currency === 'all' ? 'All currencies' : currency
        return `<option value="${currency}" ${selected === currency ? 'selected' : ''}>${label}</option>`
      })
      .join('')
  }

  function currencyChoiceOptions(selected) {
    const values = [...new Set([...CURRENCIES, ...uniqueCurrencies(), selected].filter(Boolean))]
    return values
      .map((currency) => `<option value="${escapeHtml(currency)}" ${selected === currency ? 'selected' : ''}>${escapeHtml(currency)}</option>`)
      .join('')
  }

  function currencyDatalist() {
    return `<datalist id="currency-codes">${[...new Set([...CURRENCIES, ...uniqueCurrencies()])]
      .map((currency) => `<option value="${escapeHtml(currency)}"></option>`)
      .join('')}</datalist>`
  }

  function pageHeader(eyebrow, title, description, actions = '') {
    return `
      <div class="page-header">
        <div>
          <span class="eyebrow">${escapeHtml(eyebrow)}</span>
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(description)}</p>
        </div>
        ${actions ? `<div class="page-actions">${actions}</div>` : ''}
      </div>`
  }

  function panelHeading(title, subtitle = '', action = '') {
    return `
      <div class="panel-heading">
        <div><h2>${escapeHtml(title)}</h2>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}</div>
        ${action}
      </div>`
  }

  function avatar(name, large = false) {
    return `<div class="avatar ${large ? 'large' : ''}">${escapeHtml(initials(name))}</div>`
  }

  function summaryCard(label, value, glyph, note = '', negative = false) {
    return `
      <article class="summary-card ${negative ? 'negative-card' : ''}">
        <div class="summary-icon"><span class="icon-glyph">${glyph}</span></div>
        <span>${escapeHtml(label)}</span>
        <strong class="${negative ? 'negative-text' : ''}">${escapeHtml(value)}</strong>
        ${note ? `<small>${escapeHtml(note)}</small>` : ''}
      </article>`
  }

  function shell(content, active) {
    const ownerPending = (approvalState.requests || []).filter((item) => item.status === 'pending').length
    const contributorUnread = (contributorState?.notifications || []).filter((item) => !item.is_read).length
    const navItems = isContributor()
      ? [
          ['contributor', '▦', 'My records'],
          ['requests', '◎', `Requests${contributorUnread ? ` · ${contributorUnread}` : ''}`],
        ]
      : [
          ['dashboard', '▦', 'Dashboard'],
          ['people', '◉', 'People'],
          ['transactions', '≡', 'Transactions'],
          ['approvals', '✓', `Approvals${ownerPending ? ` · ${ownerPending}` : ''}`],
          ['reports', '⇩', 'Reports'],
          ...(isPlatformAdmin() ? [['admin', '◆', 'Platform admin']] : []),
          ['settings', '⚙', 'Settings'],
        ]

    const nav = navItems
      .map(
        ([path, glyph, label]) => `
          <a class="nav-item ${active === path ? 'active' : ''}" href="#/${path}">
            <span class="icon-glyph">${glyph}</span><span>${label}</span>
          </a>`,
      )
      .join('')

    return `
      <div class="app-shell">
        <aside class="sidebar ${ui.mobileOpen ? 'open' : ''}">
          <div class="brand-row">
            <div class="brand-mark">M</div>
            <div><strong>${escapeHtml(state.workspace.name || 'My Fund App')}</strong><span>Held funds tracker</span></div>
            <button class="icon-button sidebar-close" data-action="close-mobile">×</button>
          </div>
          <nav class="nav-list">${nav}</nav>
          <div class="sidebar-foot">
            <div class="mode-chip ${CLOUD_ENABLED ? 'cloud' : ''}"><span class="status-dot"></span>${CLOUD_ENABLED ? 'Cloud live mode' : 'Local demo mode'}</div>
            ${CLOUD_ENABLED ? '<button class="sidebar-action" data-action="signout"><span>↪</span> Sign out</button>' : ''}
          </div>
        </aside>
        ${ui.mobileOpen ? '<button class="scrim" data-action="close-mobile"></button>' : ''}
        <main class="main-area">
          <header class="topbar">
            <button class="icon-button mobile-menu" data-action="open-mobile">☰</button>
            <div class="topbar-title"><span>My Fund App</span></div>
            <button class="icon-button" data-action="refresh" title="Refresh">↻</button>
          </header>
          ${
            CLOUD_UNAVAILABLE
              ? '<div class="local-banner"><span>!</span><span>Cloud services are configured but unavailable. No finance data will be saved locally until the cloud connection is restored.</span></div>'
              : !CLOUD_CONFIGURED
                ? '<div class="local-banner"><span>◈</span><span>Local development mode is active because no cloud configuration is present.</span></div>'
                : ''
          }
          <div id="toast"></div>
          <div class="page-wrap">${content}</div>
        </main>
      </div>
      <div id="modal-root"></div>`
  }

  async function refreshCloud() {
    if (!CLOUD_ENABLED || !session?.user) return
    try {
      const contextResult = await db.rpc('mfa_get_access_context')
      if (contextResult.error) throw contextResult.error
      accessContext = contextResult.data || null

      if (accessContext?.role === 'contributor') {
        await touchAppUser()
        await refreshContributorDashboard()
        subscribeRealtime()
        return
      }

      let workspace = accessContext?.role === 'owner' ? accessContext.workspace : null
      const route = getRoute()

      if (!workspace && route.path.startsWith('/join/')) {
        state = structuredClone(DEFAULT_DATA)
        contributorState = null
        return
      }

      if (!workspace) {
        const created = await db
          .from('mfa_workspaces')
          .insert({
            owner_id: session.user.id,
            name: 'My Fund App',
            default_currency: 'NGN',
            upkeep_percentage: 20,
          })
          .select('*')
          .single()
        if (created.error) throw created.error
        workspace = created.data
        accessContext = { role: 'owner', workspace }
      } else {
        accessContext = { ...accessContext, role: 'owner', workspace }
      }

      contributorState = null
      await touchAppUser()

      const [peopleResult, transactionResult, budgetResult, goalResult, approvalResult] = await Promise.all([
        db.from('mfa_people').select('*').eq('workspace_id', workspace.id).order('created_at'),
        db
          .from('mfa_transactions')
          .select('*')
          .eq('workspace_id', workspace.id)
          .order('date', { ascending: false })
          .order('created_at', { ascending: false }),
        db.from('mfa_monthly_budgets').select('*').eq('workspace_id', workspace.id),
        db.from('mfa_goals').select('*').eq('workspace_id', workspace.id),
        db.rpc('mfa_get_approval_center'),
      ])
      for (const result of [peopleResult, transactionResult, budgetResult, goalResult, approvalResult]) {
        if (result.error) throw result.error
      }
      state = normalizeCloudData({
        workspace,
        people: peopleResult.data,
        transactions: transactionResult.data,
        budgets: budgetResult.data,
        goals: goalResult.data,
      })
      approvalState = approvalResult.data || { requests: [], notifications: [], members: [], invites: [] }
      approvalError = ''
      subscribeRealtime()
    } catch (error) {
      toast(error.message || 'Unable to load cloud records.', 'danger')
      throw error
    }
  }

  function subscribeRealtime() {
    if (!CLOUD_ENABLED || !state.workspace?.id || state.workspace.id === 'local-workspace') return
    if (realtimeChannel) clearInterval(realtimeChannel)
    realtimeChannel = setInterval(async () => {
      if (document.visibilityState !== 'visible' || !session) return
      try {
        await refreshCloud()
        const route = getRoute()
        if (!route.path.startsWith('/view/')) render()
      } catch {
        // Keep the last successful cloud state visible.
      }
    }, 15000)
  }

  async function mutateLocal(mutator) {
    mutator(state)
    saveLocal()
  }

  async function createPerson(name, email, startingCurrency = '', startingAmount = '') {
    const clean = String(name || '').trim()
    const cleanEmail = String(email || '').trim().toLowerCase()
    if (!clean) throw new Error('Enter the person’s name.')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw new Error('Enter a valid email address for this person.')
    const currency = String(startingCurrency || state.workspace.default_currency || 'NGN').trim().toUpperCase()
    const hasStartingAmount = String(startingAmount ?? '').trim() !== ''
    const startingBalances = hasStartingAmount ? { [currency]: round(startingAmount) } : {}
    if (!CLOUD_ENABLED) {
      const person = {
        id: id(),
        workspace_id: state.workspace.id,
        name: clean,
        email: cleanEmail,
        starting_balances: startingBalances,
        share_token: id(),
        created_at: new Date().toISOString(),
      }
      await mutateLocal((draft) => draft.people.push(person))
      return person
    }
    const result = await db
      .from('mfa_people')
      .insert({
        workspace_id: state.workspace.id,
        name: clean,
        email: cleanEmail,
        starting_balances: startingBalances,
      })
      .select('*')
      .single()
    if (result.error) throw result.error
    await refreshCloud()
    return { ...result.data, starting_balances: result.data.starting_balances || {} }
  }

  async function updatePersonEmail(personId, email) {
    const person = personById(personId)
    if (!person) throw new Error('Person not found.')
    const cleanEmail = String(email || '').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw new Error('Enter a valid email address.')

    if (!CLOUD_ENABLED) {
      await mutateLocal((draft) => {
        draft.people = draft.people.map((item) =>
          item.id === personId ? { ...item, email: cleanEmail } : item,
        )
      })
      return
    }

    const result = await db
      .from('mfa_people')
      .update({ email: cleanEmail })
      .eq('id', personId)
    if (result.error) throw result.error
    await refreshCloud()
  }

  async function updateStartingBalance(personId, currencyValue, amountValue) {
    const person = personById(personId)
    if (!person) throw new Error('Person not found.')
    const currency = String(currencyValue || state.workspace.default_currency || 'NGN').trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Enter a valid three-letter currency code.')
    const amount = round(amountValue)
    const startingBalances = { ...(person.starting_balances || {}), [currency]: amount }
    if (!CLOUD_ENABLED) {
      await mutateLocal((draft) => {
        draft.people = draft.people.map((item) =>
          item.id === personId ? { ...item, starting_balances: startingBalances } : item,
        )
      })
      return
    }
    const result = await db
      .from('mfa_people')
      .update({ starting_balances: startingBalances })
      .eq('id', personId)
    if (result.error) throw result.error
    await refreshCloud()
  }

  async function removePerson(personId) {
    if (!CLOUD_ENABLED) {
      await mutateLocal((draft) => {
        draft.people = draft.people.filter((person) => person.id !== personId)
        draft.transactions = draft.transactions.filter((item) => item.person_id !== personId)
        draft.budgets = draft.budgets.filter((item) => item.person_id !== personId)
        draft.goals = draft.goals.filter((item) => item.person_id !== personId)
      })
      return
    }
    const result = await db.from('mfa_people').delete().eq('id', personId)
    if (result.error) throw result.error
    await refreshCloud()
  }

  function normalizeTransactionValues(values) {
    const dateUnknown = values.date_unknown === true || values.date_unknown === 'on' || !values.date
    return {
      id: id(),
      workspace_id: state.workspace.id,
      person_id: values.person_id,
      type: values.type,
      amount: round(values.amount),
      currency: String(values.currency || state.workspace.default_currency).trim().toUpperCase(),
      date: dateUnknown ? null : values.date,
      description: String(values.description || '').trim(),
      category: values.type === 'expense' ? values.category : null,
      created_at: new Date().toISOString(),
    }
  }

  async function addTransactions(entries) {
    const payloads = entries.map(normalizeTransactionValues)
    if (!payloads.length) throw new Error('Add at least one record.')
    const pending = []
    for (const payload of payloads) {
      if (!payload.person_id || !personById(payload.person_id)) throw new Error('Select a valid person.')
      if (!payload.amount || payload.amount <= 0) throw new Error('Every record needs an amount greater than zero.')
      if (!payload.description) throw new Error('Every record needs a description.')
      if (!/^[A-Z]{3}$/.test(payload.currency)) throw new Error('Use a valid three-letter currency code.')
      if (payload.type === 'expense' && !EXPENSE_CATEGORIES.includes(payload.category)) {
        throw new Error('Choose a valid expense category.')
      }
      validateExpense(payload, pending)
      pending.push(payload)
    }

    if (!CLOUD_ENABLED) {
      await mutateLocal((draft) => {
        draft.transactions.unshift(...payloads)
      })
      return payloads
    }
    const result = await db.from('mfa_transactions').insert(
      payloads.map((payload) => ({
        workspace_id: payload.workspace_id,
        person_id: payload.person_id,
        type: payload.type,
        amount: payload.amount,
        currency: payload.currency,
        date: payload.date,
        description: payload.description,
        category: payload.category,
      })),
    ).select('*')
    if (result.error) throw result.error
    const created = result.data || []
    await Promise.all(created.map((item) => triggerLedgerEmail(item.id, 'created')))
    await refreshCloud()
    return created.length ? created : payloads
  }

  async function addTransaction(values) {
    const records = await addTransactions([values])
    return records[0]
  }

  function validateExpense(payload, pending = []) {
    if (payload.type !== 'expense' || !payload.date) return
    const month = String(payload.date).slice(0, 7)
    const samePending = pending
      .filter(
        (item) =>
          item.type === 'expense' &&
          item.person_id === payload.person_id &&
          item.currency === payload.currency &&
          item.category === payload.category &&
          item.date &&
          String(item.date).slice(0, 7) === month,
      )
      .reduce((sum, item) => sum + num(item.amount), 0)

    if (payload.category === 'PV') {
      const limit = num(getBudget(payload.person_id, payload.currency, month)?.pv_limit)
      const spent = monthlySpend(payload.person_id, payload.currency, month, 'PV') + samePending
      if (spent + payload.amount > limit + 0.00001) {
        throw new Error(
          `This PV expense exceeds the remaining monthly limit by ${money(
            spent + payload.amount - limit,
            payload.currency,
          )}. Update the PV limit first.`,
        )
      }
    }
    if (payload.category === 'Upkeep') {
      const limit =
        monthlyIncome(payload.person_id, payload.currency, month) *
        (num(state.workspace.upkeep_percentage) / 100)
      const spent = monthlySpend(payload.person_id, payload.currency, month, 'Upkeep') + samePending
      if (spent + payload.amount > limit + 0.00001) {
        throw new Error(
          `This Upkeep expense exceeds the remaining monthly limit by ${money(
            spent + payload.amount - limit,
            payload.currency,
          )}.`,
        )
      }
    }
  }

  async function updateTransaction(transactionId, values) {
    const existing = state.transactions.find((item) => item.id === transactionId)
    if (!existing) throw new Error('Record not found.')
    const payload = normalizeTransactionValues({ ...values, person_id: existing.person_id })
    if (!payload.amount || payload.amount <= 0) throw new Error('Amount must be greater than zero.')
    if (!payload.description) throw new Error('Description is required.')
    if (!/^[A-Z]{3}$/.test(payload.currency)) throw new Error('Use a valid three-letter currency code.')
    if (payload.type === 'expense' && !EXPENSE_CATEGORIES.includes(payload.category)) {
      throw new Error('Choose a valid expense category.')
    }

    if (!CLOUD_ENABLED) {
      await mutateLocal((draft) => {
        draft.transactions = draft.transactions.map((item) =>
          item.id === transactionId ? { ...item, ...payload, id: transactionId, created_at: item.created_at } : item,
        )
      })
      return
    }

    const result = await db.rpc('mfa_update_owner_transaction', {
      p_transaction_id: transactionId,
      p_transaction_type: payload.type,
      p_amount: payload.amount,
      p_currency: payload.currency,
      p_date: payload.date,
      p_description: payload.description,
      p_category: payload.category,
    })
    if (result.error) throw result.error
    await triggerLedgerEmail(transactionId, 'updated')
    await refreshCloud()
  }

  async function deleteTransaction(transactionId) {
    if (!CLOUD_ENABLED) {
      await mutateLocal((draft) => {
        draft.transactions = draft.transactions.filter((item) => item.id !== transactionId)
      })
      return
    }
    const result = await db.from('mfa_transactions').delete().eq('id', transactionId)
    if (result.error) throw result.error
    await triggerLedgerEmail(transactionId, 'deleted')
    await refreshCloud()
  }

  async function saveBudget(personId, currency, month, value) {
    const pvLimit = round(value)
    const spent = monthlySpend(personId, currency, month, 'PV')
    if (pvLimit < spent) {
      throw new Error(`The PV limit cannot be below ${money(spent, currency)} already spent.`)
    }
    const existing = getBudget(personId, currency, month)
    if (!CLOUD_ENABLED) {
      await mutateLocal((draft) => {
        const payload = {
          id: existing?.id || id(),
          workspace_id: draft.workspace.id,
          person_id: personId,
          currency,
          month,
          pv_limit: pvLimit,
          updated_at: new Date().toISOString(),
        }
        if (existing) {
          draft.budgets = draft.budgets.map((item) => (item.id === existing.id ? payload : item))
        } else {
          draft.budgets.push(payload)
        }
      })
      return
    }
    const result = await db.from('mfa_monthly_budgets').upsert(
      {
        workspace_id: state.workspace.id,
        person_id: personId,
        currency,
        month: `${month}-01`,
        pv_limit: pvLimit,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'person_id,currency,month' },
    )
    if (result.error) throw result.error
    await refreshCloud()
  }

  async function saveGoal(values) {
    const payload = {
      id: values.id || id(),
      workspace_id: state.workspace.id,
      person_id: values.person_id,
      name: values.name.trim(),
      target_amount: round(values.target_amount),
      reserved_amount: round(values.reserved_amount),
      currency: String(values.currency || state.workspace.default_currency).trim().toUpperCase(),
      target_date: values.target_date || null,
      status: values.status || 'Active',
      created_at: new Date().toISOString(),
    }
    if (!payload.name) throw new Error('Enter what the person is saving for.')
    if (payload.target_amount <= 0) throw new Error('Enter a target amount.')
    if (!CLOUD_ENABLED) {
      await mutateLocal((draft) => draft.goals.push(payload))
      return
    }
    const result = await db.from('mfa_goals').insert({
      workspace_id: payload.workspace_id,
      person_id: payload.person_id,
      name: payload.name,
      target_amount: payload.target_amount,
      reserved_amount: payload.reserved_amount,
      currency: payload.currency,
      target_date: payload.target_date,
      status: payload.status,
    })
    if (result.error) throw result.error
    await refreshCloud()
  }

  async function deleteGoal(goalId) {
    if (!CLOUD_ENABLED) {
      await mutateLocal((draft) => {
        draft.goals = draft.goals.filter((goal) => goal.id !== goalId)
      })
      return
    }
    const result = await db.from('mfa_goals').delete().eq('id', goalId)
    if (result.error) throw result.error
    await refreshCloud()
  }

  async function updateWorkspace(values) {
    const changes = {
      name: values.name.trim() || 'My Fund App',
      default_currency: String(values.default_currency || 'NGN').trim().toUpperCase(),
      upkeep_percentage: Math.max(0, Math.min(100, round(values.upkeep_percentage))),
    }
    if (!CLOUD_ENABLED) {
      await mutateLocal((draft) => {
        draft.workspace = { ...draft.workspace, ...changes }
      })
      return
    }
    const result = await db.from('mfa_workspaces').update(changes).eq('id', state.workspace.id)
    if (result.error) throw result.error
    await refreshCloud()
  }

  async function regenerateToken(personId) {
    const token = id()
    if (!CLOUD_ENABLED) {
      await mutateLocal((draft) => {
        draft.people = draft.people.map((person) =>
          person.id === personId ? { ...person, share_token: token } : person,
        )
      })
      return token
    }
    const result = await db
      .from('mfa_people')
      .update({ share_token: token })
      .eq('id', personId)
      .select('share_token')
      .single()
    if (result.error) throw result.error
    await refreshCloud()
    return result.data.share_token
  }

  function renderDashboard() {
    const range = dateRange(ui.dashboardPreset, ui.dashboardStart, ui.dashboardEnd)
    const periodTransactions = state.transactions.filter((item) => inRange(item.date, range.start, range.end))
    const currencies = uniqueCurrencies()

    const controls = `
      <div class="date-controls">
        <select data-ui="dashboardPreset">${dateOptions(ui.dashboardPreset)}</select>
        ${
          ui.dashboardPreset === 'custom'
            ? `<input type="date" data-ui="dashboardStart" value="${escapeHtml(ui.dashboardStart)}"><span>to</span><input type="date" data-ui="dashboardEnd" value="${escapeHtml(ui.dashboardEnd)}">`
            : ''
        }
      </div>`

    let content = pageHeader(
      'Overview',
      'Money currently held',
      'Positive balances, borrowed funds and net holdings remain separate for every currency.',
      '<button class="primary-button" data-action="go-people"><span>＋</span>Add or update a person</button>',
    )
    content += controls

    if (!state.people.length) {
      content += `
        <div class="empty-state">
          <div class="empty-icon">◉</div>
          <h2>Add your first person</h2>
          <p>Only a name is required. Then enter previous or new income and actual expenses.</p>
          <button class="primary-button" data-action="go-people"><span>＋</span>Add person</button>
        </div>`
      return shell(content, 'dashboard')
    }

    content += '<section class="currency-grid">'
    for (const currency of currencies) {
      const summary = workspacePosition(currency)
      const periodIncome = periodTransactions
        .filter((item) => item.currency === currency && item.type === 'income')
        .reduce((sum, item) => sum + num(item.amount), 0)
      const periodExpenses = periodTransactions
        .filter((item) => item.currency === currency && item.type === 'expense')
        .reduce((sum, item) => sum + num(item.amount), 0)
      content += `
        <article class="currency-card">
          <div class="currency-card-head">
            <span class="currency-badge">${currency}</span>
            <span class="balance-status">${summary.net < 0 ? 'Net borrowed' : 'Net held'}</span>
          </div>
          <strong class="hero-number ${summary.net < 0 ? 'negative-text' : ''}">${money(summary.net, currency)}</strong>
          <div class="three-metrics">
            <div class="metric-mini"><span>Positive funds</span><strong>${money(summary.positive, currency)}</strong></div>
            <div class="metric-mini"><span>Borrowed in use</span><strong>${money(summary.borrowed, currency)}</strong></div>
            <div class="metric-mini"><span>Period movement</span><strong>${money(periodIncome - periodExpenses, currency)}</strong></div>
          </div>
        </article>`
    }
    content += '</section>'

    const peopleRows = state.people
      .map((person) => {
        const balances = uniqueCurrencies(person.id)
          .map((currency) => {
            const value = personPosition(person.id, currency).balance
            return `<span class="${value < 0 ? 'negative-text' : ''}">${money(value, currency)}</span>`
          })
          .join('')
        return `
          <button class="person-balance-row" data-action="open-person" data-person-id="${person.id}">
            ${avatar(person.name)}
            <div class="person-balance-main"><strong>${escapeHtml(person.name)}</strong><span>${state.transactions.filter((item) => item.person_id === person.id).length} records</span></div>
            <div class="person-currency-values">${balances}</div>
            <span>›</span>
          </button>`
      })
      .join('')

    const recent = sortTransactions(state.transactions, true).slice(0, 8)

    content += `
      <section class="dashboard-two-col">
        <div class="panel">
          ${panelHeading('People balances', 'All-time balance for each person')}
          <div class="people-balance-list">${peopleRows}</div>
        </div>
        <div class="panel">
          ${panelHeading('Recent activity', 'Latest income and expenses')}
          ${transactionList(recent, false)}
        </div>
      </section>`

    return shell(content, 'dashboard')
  }

  function renderPeople() {
    const cards = state.people.length
      ? state.people
          .map((person) => {
            const balances = uniqueCurrencies(person.id)
              .map((currency) => {
                const balance = personPosition(person.id, currency).balance
                return `<span class="${balance < 0 ? 'negative-pill' : 'positive-pill'}">${money(balance, currency)}</span>`
              })
              .join('')
            return `
              <button class="person-card" data-action="open-person" data-person-id="${person.id}">
                ${avatar(person.name, true)}
                <div class="person-card-copy">
                  <strong>${escapeHtml(person.name)}</strong>
                  <span>${state.transactions.filter((item) => item.person_id === person.id).length} records</span>
                  <div class="person-card-balances">${balances}</div>
                </div>
                <span>›</span>
              </button>`
          })
          .join('')
      : '<div class="small-empty">No people added yet.</div>'

    const content = `
      ${pageHeader('People', 'People whose funds you hold', 'Add each person with their email so they can receive ledger-change notifications and use their secure personal link.')}
      <section class="people-layout">
        <form class="panel add-person-card" id="add-person-form">
          <div class="section-icon">＋</div>
          <h2>Add a person</h2>
          <p>Name and email are required. The email receives alerts whenever an approved income or expense record is added, edited or removed.</p>
          <label class="field"><span>Name</span><input name="name" placeholder="Person's full name" required></label>
          <label class="field"><span>Email for notifications</span><input name="email" type="email" placeholder="person@example.com" required></label>
          <div class="two-fields">
            <label class="field"><span>Starting balance (optional)</span><input name="starting_balance" type="number" step="0.01" placeholder="0.00"></label>
            <label class="field"><span>Currency</span><input name="starting_currency" list="currency-codes" maxlength="3" pattern="[A-Za-z]{3}" value="${escapeHtml(state.workspace.default_currency)}">${currencyDatalist()}</label>
          </div>
          <div class="helper-text">Use a negative starting balance when the person already owes money.</div>
          <button class="primary-button full-width" ${busy ? 'disabled' : ''}><span>＋</span>Add person</button>
        </form>
        <div class="panel people-panel">
          ${panelHeading('All people', `${state.people.length} person${state.people.length === 1 ? '' : 's'}`)}
          <div class="people-cards">${cards}</div>
        </div>
      </section>`
    return shell(content, 'people')
  }

  function renderPerson(personId) {
    const person = personById(personId)
    if (!person) {
      go('/people')
      return shell('', 'people')
    }
    const currencies = uniqueCurrencies(person.id)
    const currency = ui.personCurrency[person.id] || currencies[0] || state.workspace.default_currency
    const month = ui.personMonth[person.id] || currentMonth()
    ui.personCurrency[person.id] = currency
    ui.personMonth[person.id] = month

    const position = personPosition(person.id, currency)
    const pvLimit = num(getBudget(person.id, currency, month)?.pv_limit)
    const pvSpent = monthlySpend(person.id, currency, month, 'PV')
    const monthIncome = monthlyIncome(person.id, currency, month)
    const upkeepLimit = round(monthIncome * (num(state.workspace.upkeep_percentage) / 100))
    const upkeepSpent = monthlySpend(person.id, currency, month, 'Upkeep')
    const records = sortTransactions(
      state.transactions.filter((item) => item.person_id === person.id && item.currency === currency),
      true,
    )
    const goals = state.goals.filter(
      (goal) => goal.person_id === person.id && goal.currency === currency,
    )
    const base = location.href.split('#')[0]
    const viewerLink = `${base}#/view/${person.share_token}`


    const currencySelect = currencyChoiceOptions(currency)

    const content = `
      <button class="text-button back-button" data-action="go-people">← Back to people</button>
      ${pageHeader(
        'Person dashboard',
        person.name,
        'Add income or actual expenses. Monthly limits control spending but never change the money balance.',
        `<div class="button-row"><button class="secondary-button" data-action="edit-starting-balance" data-person-id="${person.id}" data-currency="${currency}">▣ Starting balance</button><button class="secondary-button" data-action="open-expense" data-person-id="${person.id}">↗ Add expense</button><button class="primary-button" data-action="open-income" data-person-id="${person.id}">↘ Add income</button></div>`,
      )}
      <div class="toolbar-row">
        <label class="field inline-field"><span>Currency</span><select data-ui="personCurrency" data-person-id="${person.id}">${currencySelect}</select></label>
        <label class="field inline-field"><span>Budget month</span><input type="month" data-ui="personMonth" data-person-id="${person.id}" value="${month}"></label>
      </div>
      <section class="summary-card-grid four">
        ${summaryCard('Current balance', money(position.balance, currency), '▣', position.balance < 0 ? `Borrowed funds in use: ${money(Math.abs(position.balance), currency)}` : 'Starting balance + income − expenses', position.balance < 0)}
        ${summaryCard('Starting balance', money(position.starting, currency), '◫', 'Editable without creating a transaction', position.starting < 0)}
        ${summaryCard('Total income', money(position.income, currency), '↘')}
        ${summaryCard('Total expenses', money(position.expenses, currency), '↗')}
      </section>
      <section class="budget-grid">
        ${budgetCard('PV monthly limit', 'PV', pvLimit, pvSpent, currency, person.id, month, true)}
        ${budgetCard('Upkeep monthly limit', 'U', upkeepLimit, upkeepSpent, currency, person.id, month, false, `${state.workspace.upkeep_percentage}% of recorded income for ${month}`)}
        ${goalSummary(goals, position.balance, currency, person.id)}
      </section>
      <section class="person-two-col">
        <div class="panel">
          ${panelHeading('Income and expenses', `${records.length} ${currency} records`, `<button class="text-button" data-action="report-person" data-person-id="${person.id}">⇩ Download</button>`)}
          ${transactionList(records, true)}
        </div>
        <div class="stacked-panels">
          <div class="panel">
            ${panelHeading('Secure person link', 'View records and request new income or expenses')}
            <div class="share-box"><span>✉</span><div><strong>${escapeHtml(person.email || 'No email attached')}</strong><span>${person.email ? 'Receives alerts when an approved income or expense is added, edited or removed.' : 'Add an email to enable ledger-change alerts.'}</span></div></div>
            <button class="text-button" data-action="edit-person-email" data-person-id="${person.id}">✎ ${person.email ? 'Change notification email' : 'Add notification email'}</button>
            <div class="share-box"><span>🔗</span><div><strong>Personal finance link</strong><span>${CLOUD_ENABLED ? 'The person can view approved records and submit new records for your approval.' : 'Local mode: it works only where this browser data exists.'}</span></div></div>
            <div class="copy-row"><input readonly value="${escapeHtml(viewerLink)}"><button class="secondary-button" data-action="copy-link" data-link="${escapeHtml(viewerLink)}">⧉ Copy</button></div>
            <button class="text-button" data-action="regenerate-link" data-person-id="${person.id}">↻ Replace secure link</button><div class="helper-text">The link holder cannot edit or delete approved records. Only pending requests they submit can be changed or removed before you review them.</div>
          </div>
          <div class="panel">
            ${panelHeading('Savings goals', `${goals.length} tracked`, `<button class="text-button" data-action="open-goal" data-person-id="${person.id}" data-currency="${currency}">＋ Add goal</button>`)}
            ${goalList(goals)}
          </div>
          <div class="panel danger-panel">
            ${panelHeading('Person settings', 'Permanent actions')}
            <button class="danger-button" data-action="delete-person" data-person-id="${person.id}">⌫ Delete person and records</button>
          </div>
        </div>
      </section>`

    return shell(content, 'people')
  }

  function budgetCard(title, glyph, limit, spent, currency, personId, month, editable, note = '') {
    const available = round(limit - spent)
    const percentage = limit > 0 ? Math.min(100, (spent / limit) * 100) : 0
    return `
      <article class="budget-card">
        <div class="budget-icon"><span>${glyph}</span></div>
        <div class="budget-head"><span>${escapeHtml(title)}</span>${editable ? `<button class="icon-button mini" data-action="edit-budget" data-person-id="${personId}" data-currency="${currency}" data-month="${month}" data-current="${limit}">✎</button>` : ''}</div>
        <strong>${money(limit, currency)}</strong>
        <div class="progress-track"><span style="width:${percentage}%"></span></div>
        <div class="budget-stats"><span>Spent ${money(spent, currency)}</span><span>Available ${money(available, currency)}</span></div>
        ${note ? `<small>${escapeHtml(note)}</small>` : ''}
      </article>`
  }

  function goalSummary(goals, balance, currency, personId) {
    const reserved = goals
      .filter((goal) => goal.status === 'Active')
      .reduce((sum, goal) => sum + num(goal.reserved_amount), 0)
    return `
      <article class="budget-card goal-card">
        <div class="budget-icon">◎</div>
        <div class="budget-head"><span>Savings goals</span><button class="icon-button mini" data-action="open-goal" data-person-id="${personId}" data-currency="${currency}">＋</button></div>
        <strong>${money(reserved, currency)}</strong>
        <p>${goals.length ? `${goals.length} goal${goals.length === 1 ? '' : 's'} tracked` : 'No goal yet'}</p>
        <div class="budget-stats"><span>Current balance</span><span class="${balance < 0 ? 'negative-text' : ''}">${money(balance, currency)}</span></div>
      </article>`
  }

  function goalList(goals) {
    if (!goals.length) return '<div class="small-empty">No savings goal yet.</div>'
    return `<div class="goal-list">${goals
      .map((goal) => {
        const percentage = goal.target_amount > 0 ? Math.min(100, (goal.reserved_amount / goal.target_amount) * 100) : 0
        return `
          <div class="goal-item">
            <div class="goal-item-head"><strong>${escapeHtml(goal.name)}</strong><button class="icon-button mini" data-action="delete-goal" data-goal-id="${goal.id}">⌫</button></div>
            <div class="goal-progress"><span style="width:${percentage}%"></span></div>
            <div class="goal-meta"><span>${money(goal.reserved_amount, goal.currency)} reserved</span><span>${money(goal.target_amount, goal.currency)} target</span></div>
          </div>`
      })
      .join('')}</div>`
  }

  function transactionList(records, allowDelete) {
    if (!records.length) return '<div class="small-empty">No records yet.</div>'
    return `<div class="transaction-list">${records
      .map((item) => {
        const person = personById(item.person_id)
        return `
          <div class="transaction-row">
            <div class="transaction-icon ${item.type}">${item.type === 'income' ? '↘' : '↗'}</div>
            <div class="transaction-main">
              <strong>${escapeHtml(item.description)}</strong>
              <span>${escapeHtml(person?.name || '')}${item.category ? ` · ${escapeHtml(item.category)}` : ''} · ${formatDate(item.date)}</span>
            </div>
            <strong class="${item.type === 'income' ? 'income-text' : ''}">${item.type === 'income' ? '+' : '−'}${money(item.amount, item.currency)}</strong>
            ${allowDelete ? `<div class="row-actions"><button class="icon-button mini" data-action="edit-transaction" data-transaction-id="${item.id}" title="Edit record">✎</button><button class="icon-button mini delete-record" data-action="delete-transaction" data-transaction-id="${item.id}" title="Delete record">⌫</button></div>` : ''}
          </div>`
      })
      .join('')}</div>`
  }

  function renderTransactions() {
    const range = dateRange(
      ui.transactionPreset,
      ui.transactionStart,
      ui.transactionEnd,
    )
    const filtered = sortTransactions(
      state.transactions
        .filter((item) => ui.transactionPerson === 'all' || item.person_id === ui.transactionPerson)
        .filter((item) => ui.transactionType === 'all' || item.type === ui.transactionType)
        .filter((item) => ui.transactionCurrency === 'all' || item.currency === ui.transactionCurrency)
        .filter((item) => inRange(item.date, range.start, range.end)),
      true,
    )

    const peopleOptions = [
      '<option value="all">All people</option>',
      ...state.people.map(
        (person) => `<option value="${person.id}" ${ui.transactionPerson === person.id ? 'selected' : ''}>${escapeHtml(person.name)}</option>`,
      ),
    ].join('')

    const content = `
      ${pageHeader('Ledger', 'All income and expenses', 'Every balance is calculated from these records only.')}
      <div class="filter-panel">
        <select data-ui="transactionPerson">${peopleOptions}</select>
        <select data-ui="transactionType"><option value="all" ${ui.transactionType === 'all' ? 'selected' : ''}>Income and expenses</option><option value="income" ${ui.transactionType === 'income' ? 'selected' : ''}>Income only</option><option value="expense" ${ui.transactionType === 'expense' ? 'selected' : ''}>Expenses only</option></select>
        <select data-ui="transactionCurrency">${currencyOptions(ui.transactionCurrency, true)}</select>
        <select data-ui="transactionPreset">${dateOptions(ui.transactionPreset)}</select>
        ${
          ui.transactionPreset === 'custom'
            ? `<input type="date" data-ui="transactionStart" value="${escapeHtml(ui.transactionStart)}"><input type="date" data-ui="transactionEnd" value="${escapeHtml(ui.transactionEnd)}">`
            : ''
        }
      </div>
      <div class="panel">
        ${panelHeading(`${filtered.length} records`, range.start ? `${formatDate(range.start)} – ${formatDate(range.end)}` : 'All time')}
        ${transactionList(filtered, true)}
      </div>`
    return shell(content, 'transactions')
  }

  function reportRows(personId, currency, start, end) {
    const people = state.people.filter((person) => personId === 'all' || person.id === personId)
    const currencies = currency === 'all' ? uniqueCurrencies() : [currency]
    const transactions = sortTransactions(
      state.transactions
        .filter((item) => people.some((person) => person.id === item.person_id))
        .filter((item) => currency === 'all' || item.currency === currency)
        .filter((item) => inRange(item.date, start, end)),
      false,
    ).map((item) => ({
      ...item,
      person_name: personById(item.person_id)?.name || 'Unknown',
    }))

    const summary = []
    for (const person of people) {
      for (const curr of currencies) {
        const starting = startingBalanceFor(person, curr)
        const before = state.transactions.filter(
          (item) =>
            item.person_id === person.id &&
            item.currency === curr &&
            start &&
            item.date &&
            String(item.date).slice(0, 10) < start,
        )
        const period = state.transactions.filter(
          (item) =>
            item.person_id === person.id &&
            item.currency === curr &&
            inRange(item.date, start, end),
        )
        const beforeMovement = start
          ? before.reduce(
              (sum, item) => sum + (item.type === 'income' ? num(item.amount) : -num(item.amount)),
              0,
            )
          : 0
        const opening = round(starting + beforeMovement)
        const income = period
          .filter((item) => item.type === 'income')
          .reduce((sum, item) => sum + num(item.amount), 0)
        const expenses = period
          .filter((item) => item.type === 'expense')
          .reduce((sum, item) => sum + num(item.amount), 0)
        if (starting || opening || income || expenses) {
          summary.push({
            person_id: person.id,
            person_name: person.name,
            currency: curr,
            starting: round(starting),
            opening,
            income: round(income),
            expenses: round(expenses),
            closing: round(opening + income - expenses),
          })
        }
      }
    }
    return { transactions, summary }
  }

  function renderReports() {
    const range = dateRange(ui.reportPreset, ui.reportStart, ui.reportEnd)
    const rows = reportRows(ui.reportPerson, ui.reportCurrency, range.start, range.end)
    const peopleOptions = [
      '<option value="all">Everyone</option>',
      ...state.people.map(
        (person) => `<option value="${person.id}" ${ui.reportPerson === person.id ? 'selected' : ''}>${escapeHtml(person.name)}</option>`,
      ),
    ].join('')

    const preview = rows.summary.length
      ? rows.summary
          .map(
            (item) => `
              <div class="report-summary-card">
                <span>${escapeHtml(item.person_name)} · ${item.currency}</span>
                <strong class="${item.closing < 0 ? 'negative-text' : ''}">${money(item.closing, item.currency)}</strong>
                <small>Opening ${money(item.opening, item.currency)} · Income ${money(item.income, item.currency)} · Expenses ${money(item.expenses, item.currency)}</small>
              </div>`,
          )
          .join('')
      : '<div class="small-empty">No records match this report.</div>'

    const content = `
      ${pageHeader('Reports', 'Download records', 'Download everyone or one person for all time, a month or a custom range.')}
      <section class="report-layout">
        <div class="panel report-controls">
          ${panelHeading('Report options', 'Choose exactly what to include')}
          <label class="field"><span>People</span><select data-ui="reportPerson">${peopleOptions}</select></label>
          <label class="field"><span>Currency</span><select data-ui="reportCurrency">${currencyOptions(ui.reportCurrency, true)}</select></label>
          <label class="field"><span>Period</span><select data-ui="reportPreset">${dateOptions(ui.reportPreset)}</select></label>
          ${
            ui.reportPreset === 'custom'
              ? `<div class="two-fields"><label class="field"><span>Start</span><input type="date" data-ui="reportStart" value="${escapeHtml(ui.reportStart)}"></label><label class="field"><span>End</span><input type="date" data-ui="reportEnd" value="${escapeHtml(ui.reportEnd)}"></label></div>`
              : ''
          }
          <div class="export-buttons">
            <button class="primary-button" data-action="export-pdf" ${rows.transactions.length || rows.summary.length ? '' : 'disabled'}>⇩ PDF</button>
            <button class="secondary-button" data-action="export-xlsx" ${rows.transactions.length || rows.summary.length ? '' : 'disabled'}>▦ Excel</button>
            <button class="secondary-button" data-action="export-csv" ${rows.transactions.length || rows.summary.length ? '' : 'disabled'}>≡ CSV</button>
          </div>
        </div>
        <div class="panel report-preview">
          ${panelHeading('Report preview', `${rows.transactions.length} transactions`)}
          <div class="report-summary-grid">${preview}</div>
        </div>
      </section>`
    return shell(content, 'reports')
  }

  function adminBalanceForPerson(personId, currency, payload = adminState) {
    const person = (payload?.people || []).find((item) => item.id === personId)
    const starting = round(person?.starting_balances?.[currency] || 0)
    const records = (payload?.transactions || []).filter(
      (item) => item.person_id === personId && item.currency === currency,
    )
    const income = records
      .filter((item) => item.type === 'income')
      .reduce((sum, item) => sum + num(item.amount), 0)
    const expenses = records
      .filter((item) => item.type === 'expense')
      .reduce((sum, item) => sum + num(item.amount), 0)
    return {
      starting,
      income: round(income),
      expenses: round(expenses),
      balance: round(starting + income - expenses),
    }
  }

  function adminCurrenciesForPeople(people, payload = adminState) {
    const ids = new Set(people.map((person) => person.id))
    const set = new Set()
    people.forEach((person) => Object.keys(person.starting_balances || {}).forEach((currency) => set.add(currency)))
    ;(payload?.transactions || [])
      .filter((item) => ids.has(item.person_id))
      .forEach((item) => set.add(item.currency))
    return [...set]
  }

  function formatTimestamp(value) {
    if (!value) return 'Never'
    try {
      return new Intl.DateTimeFormat('en', {
        day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
      }).format(new Date(value))
    } catch {
      return String(value)
    }
  }

  function renderAdmin() {
    if (!isPlatformAdmin()) {
      return shell(`<section>${pageHeader('Platform admin', 'Access denied', 'This page is restricted to the configured platform administrator.')}</section>`, 'admin')
    }

    if (adminLoading && !adminState) {
      return shell(`<section>${pageHeader('Platform admin', 'Loading accounts', 'Reading My Fund App accounts and tracked balances…')}<div class="panel admin-loading">Loading platform records…</div></section>`, 'admin')
    }

    if (adminError && !adminState) {
      return shell(`<section>${pageHeader('Platform admin', 'Unable to load', adminError)}<button class="primary-button" data-action="refresh-admin">Try again</button></section>`, 'admin')
    }

    const payload = adminState || { users: [], workspaces: [], people: [], transactions: [], budgets: [], goals: [] }
    const users = payload.users || []
    const workspaces = payload.workspaces || []
    const people = payload.people || []
    const transactions = payload.transactions || []
    const currencies = adminCurrenciesForPeople(people, payload)
    const mainUser = users.find((user) => String(user.email || '').trim().toLowerCase() === ADMIN_EMAIL)
    const sortedUsers = [...users].sort((a, b) => {
      const aMain = String(a.email || '').trim().toLowerCase() === ADMIN_EMAIL ? 1 : 0
      const bMain = String(b.email || '').trim().toLowerCase() === ADMIN_EMAIL ? 1 : 0
      if (aMain !== bMain) return bMain - aMain
      return String(b.last_seen_at || '').localeCompare(String(a.last_seen_at || ''))
    })

    const currencyAnalysis = currencies.map((currency) => {
      const positions = people.map((person) => adminBalanceForPerson(person.id, currency, payload))
      const currentPositive = round(positions.reduce((sum, item) => sum + Math.max(item.balance, 0), 0))
      const borrowed = round(positions.reduce((sum, item) => sum + Math.abs(Math.min(item.balance, 0)), 0))
      const currentNet = round(currentPositive - borrowed)
      const openingTracked = round(
        people.reduce((sum, person) => sum + Math.max(num(person.starting_balances?.[currency]), 0), 0),
      )
      const incomeTracked = round(
        transactions
          .filter((item) => item.type === 'income' && item.currency === currency)
          .reduce((sum, item) => sum + num(item.amount), 0),
      )
      const expenses = round(
        transactions
          .filter((item) => item.type === 'expense' && item.currency === currency)
          .reduce((sum, item) => sum + num(item.amount), 0),
      )
      return {
        currency,
        totalTracked: round(openingTracked + incomeTracked),
        expenses,
        currentPositive,
        borrowed,
        currentNet,
      }
    })

    const fundCards = currencyAnalysis.length
      ? currencyAnalysis.map((item) => {
          return `<article class="admin-fund-card">
            <span>${item.currency}</span>
            <strong>${money(item.currentNet, item.currency)}</strong>
            <small>Currently held · ${money(item.totalTracked, item.currency)} tracked · ${money(item.expenses, item.currency)} spent · ${money(item.borrowed, item.currency)} borrowed</small>
          </article>`
        }).join('')
      : '<div class="empty-inline">No starting balances or transactions have been recorded yet.</div>'

    const trackedCards = currencyAnalysis.length
      ? currencyAnalysis.map((item) => `<article class="admin-fund-card"><span>${item.currency} tracked</span><strong>${money(item.totalTracked, item.currency)}</strong><small>Opening positive balances + recorded income</small></article>`).join('')
      : '<div class="empty-inline">No money has been tracked yet.</div>'

    const mainWorkspace = mainUser ? workspaces.find((item) => item.owner_id === mainUser.user_id) : null
    const mainPeople = mainWorkspace ? people.filter((item) => item.workspace_id === mainWorkspace.id) : []
    const mainPersonIds = new Set(mainPeople.map((item) => item.id))
    const mainTransactions = transactions.filter((item) => mainPersonIds.has(item.person_id))
    const mainCurrencies = adminCurrenciesForPeople(mainPeople, payload)
    const mainHoldings = mainCurrencies.map((currency) => {
      const total = round(mainPeople.reduce((sum, person) => sum + adminBalanceForPerson(person.id, currency, payload).balance, 0))
      return `<span class="balance-pill ${total < 0 ? 'negative-pill' : ''}">${money(total, currency)}</span>`
    }).join('') || '<span class="muted-text">No funds recorded</span>'

    const accountPanels = sortedUsers.length
      ? sortedUsers.map((user) => {
          const workspace = workspaces.find((item) => item.owner_id === user.user_id)
          const accountPeople = workspace ? people.filter((item) => item.workspace_id === workspace.id) : []
          const personIds = new Set(accountPeople.map((item) => item.id))
          const accountTransactions = transactions.filter((item) => personIds.has(item.person_id))
          const accountCurrencies = adminCurrenciesForPeople(accountPeople, payload)
          const accountTotals = accountCurrencies.map((currency) => {
            const total = round(accountPeople.reduce((sum, person) => sum + adminBalanceForPerson(person.id, currency, payload).balance, 0))
            return `<span class="balance-pill ${total < 0 ? 'negative-pill' : ''}">${money(total, currency)}</span>`
          }).join('') || '<span class="muted-text">No funds recorded</span>'
          const rows = accountPeople.length
            ? accountPeople.map((person) => {
                const pcSet = new Set(Object.keys(person.starting_balances || {}))
                accountTransactions
                  .filter((item) => item.person_id === person.id)
                  .forEach((item) => pcSet.add(item.currency))
                const pc = [...pcSet]
                const balances = pc.map((currency) => {
                  const position = adminBalanceForPerson(person.id, currency, payload)
                  return `<span class="balance-pill ${position.balance < 0 ? 'negative-pill' : ''}">${money(position.balance, currency)}</span>`
                }).join('') || '<span class="muted-text">No balance yet</span>'
                return `<tr><td><strong>${escapeHtml(person.name)}</strong></td><td>${balances}</td><td>${accountTransactions.filter((item) => item.person_id === person.id).length}</td><td>${formatTimestamp(person.created_at)}</td></tr>`
              }).join('')
            : '<tr><td colspan="4" class="empty-cell">This account has not added anyone yet.</td></tr>'
          const isMainAccount = String(user.email || '').trim().toLowerCase() === ADMIN_EMAIL
          return `<article class="panel admin-account-card">
            <div class="admin-account-head">
              <div><span class="eyebrow">${isMainAccount ? 'Main account · Administrator' : 'Account'}</span><h2>${escapeHtml(user.email || 'Unknown email')}</h2><p>${escapeHtml(workspace?.name || 'Workspace not created yet')}</p></div>
              <div class="admin-account-totals">${accountTotals}</div>
            </div>
            <div class="admin-meta-grid">
              <span><strong>${accountPeople.length}</strong> tracked people</span>
              <span><strong>${accountTransactions.length}</strong> transactions</span>
              <span>Created ${formatTimestamp(user.created_at)}</span>
              <span>Last active ${formatTimestamp(user.last_seen_at)}</span>
            </div>
            <div class="table-wrap"><table class="data-table"><thead><tr><th>Person</th><th>Current balance</th><th>Records</th><th>Added</th></tr></thead><tbody>${rows}</tbody></table></div>
          </article>`
        }).join('')
      : '<div class="panel empty-state"><h2>No My Fund App accounts yet</h2><p>Accounts appear here after they sign in to this app.</p></div>'

    const content = `
      ${pageHeader('Platform admin', 'My Fund App accounts', 'See who uses My Fund App, the people they track and the net funds held in each currency.', '<button class="secondary-button" data-action="refresh-admin">↻ Refresh</button>')}
      <section class="summary-grid admin-summary-grid">
        ${summaryCard('Accounts using app', String(users.length), '◎', 'Registered My Fund App accounts')}
        ${summaryCard('People being tracked', String(people.length), '◉', 'Across every account')}
        ${summaryCard('Total records', String(transactions.length), '≡', 'Income and expense records')}
        ${summaryCard('Main account', mainUser ? ADMIN_EMAIL : 'Not used yet', '◆', mainUser ? `${mainPeople.length} people · ${mainTransactions.length} records` : 'Administrator has not created a workspace yet')}
      </section>
      <section class="panel">
        <div class="panel-heading"><div><h2>Platform analysis</h2><p>Total tracked is positive opening balances plus recorded income. Current holdings are what remains after expenses, with borrowed balances shown separately.</p></div></div>
        <div class="admin-funds-grid">${fundCards}</div>
      </section>
      <section class="panel">
        <div class="panel-heading"><div><h2>Total money tracked</h2><p>Gross money entered into My Fund App, kept separate by currency.</p></div></div>
        <div class="admin-funds-grid">${trackedCards}</div>
      </section>
      <section class="panel">
        <div class="panel-heading"><div><h2>Main account</h2><p>${escapeHtml(ADMIN_EMAIL)} · your administrator workspace and current holdings.</p></div></div>
        <div class="admin-meta-grid">
          <span><strong>${mainPeople.length}</strong> tracked people</span>
          <span><strong>${mainTransactions.length}</strong> records</span>
          <span><strong>${mainWorkspace ? 'Active' : 'Not created'}</strong> workspace</span>
          <span>${mainHoldings}</span>
        </div>
      </section>
      <section class="admin-account-list">${accountPanels}</section>`
    return shell(content, 'admin')
  }

  function renderSettings() {
    const content = `
      ${pageHeader('Settings', 'Workspace settings', 'Upkeep is a percentage-based monthly limit. PV is set separately for each person and month.')}
      <section class="settings-grid">
        <form class="panel" id="settings-form">
          ${panelHeading('General settings', 'Applied across this workspace')}
          <label class="field"><span>Workspace name</span><input name="name" value="${escapeHtml(state.workspace.name)}"></label>
          <label class="field"><span>Default currency code</span><input name="default_currency" list="currency-codes" maxlength="3" pattern="[A-Za-z]{3}" value="${escapeHtml(state.workspace.default_currency)}" required>${currencyDatalist()}</label>
          <label class="field"><span>Monthly Upkeep percentage</span><div class="input-suffix"><input name="upkeep_percentage" type="number" min="0" max="100" step="0.01" value="${num(state.workspace.upkeep_percentage)}"><span>%</span></div></label>
          <p class="helper-text">The Upkeep limit equals this percentage of income recorded for the person, currency and month.</p>
          <button class="primary-button">✓ Save settings</button>
        </form>
        <div class="panel">
          ${panelHeading('Data and backup', CLOUD_ENABLED ? 'Cloud data is protected by your account.' : 'Keep a portable copy of local records.')}
          ${
            CLOUD_ENABLED
              ? '<div class="security-note"><span>◈</span><div><strong>Cloud mode enabled</strong><span>Owner data is protected using Neon Auth and Neon row-level security.</span></div></div>'
              : `<button class="secondary-button full-width" data-action="backup-json">⇩ Download JSON backup</button><label class="secondary-button full-width upload-button">↗ Restore JSON backup<input id="restore-file" type="file" accept="application/json"></label>`
          }
        </div>
      </section>`
    return shell(content, 'settings')
  }

  function authBrand() {
    return `<div class="auth-brand">
      <div class="brand-mark large-brand">M</div>
      <h1>My Fund App</h1>
      <p>Track income, actual expenses, monthly limits, borrowed balances and everything you currently hold.</p>
    </div>`
  }

  function passwordField(name, label, idValue, options = {}) {
    const minlength = options.minlength || 8
    const autocomplete = options.autocomplete || 'current-password'
    return `<label class="field"><span>${escapeHtml(label)}</span><div class="password-input-wrap"><input id="${idValue}" name="${name}" type="password" minlength="${minlength}" autocomplete="${autocomplete}" required><button type="button" class="password-toggle" data-action="toggle-password" data-target="${idValue}">Show</button></div></label>`
  }

  function renderAuth(message = '', mode = 'signin', email = '') {
    const signin = mode !== 'signup'
    document.getElementById('app').innerHTML = `
      <div class="auth-page">
        ${authBrand()}
        <form class="auth-card" id="auth-form" data-mode="${signin ? 'signin' : 'signup'}">
          <div class="auth-tabs">
            <button type="button" class="${signin ? 'active' : ''}" data-action="auth-mode" data-mode="signin">Sign in</button>
            <button type="button" class="${signin ? '' : 'active'}" data-action="auth-mode" data-mode="signup">Create account</button>
          </div>
          <label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" value="${escapeHtml(email)}" required></label>
          ${passwordField('password', 'Password', 'auth-password')}
          ${signin ? '<button type="button" class="text-button auth-help" data-action="forgot-password">Forgot password?</button>' : ''}
          ${message ? `<div class="info-box">${escapeHtml(message)}</div>` : ''}
          <button type="submit" class="primary-button full-width">${signin ? 'Sign in' : 'Create account'}</button>
        </form>
      </div>`
  }

  function renderForgotPassword(message = '', email = '') {
    document.getElementById('app').innerHTML = `
      <div class="auth-page">
        ${authBrand()}
        <form class="auth-card" id="forgot-password-form">
          <div class="auth-form-heading"><h2>Reset your password</h2><p>Enter your account email and we will send a secure reset link.</p></div>
          <label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" value="${escapeHtml(email)}" required></label>
          ${message ? `<div class="info-box">${escapeHtml(message)}</div>` : ''}
          <button type="submit" class="primary-button full-width">Send reset link</button>
          <button type="button" class="text-button full-width" data-action="back-to-signin">Back to sign in</button>
        </form>
      </div>`
  }

  function renderPasswordReset(message = '') {
    document.getElementById('app').innerHTML = `
      <div class="auth-page">
        ${authBrand()}
        <form class="auth-card" id="reset-password-form">
          <div class="auth-form-heading"><h2>Choose a new password</h2><p>Use at least eight characters.</p></div>
          ${passwordField('password', 'New password', 'new-password', { autocomplete: 'new-password' })}
          ${passwordField('confirm_password', 'Confirm new password', 'confirm-new-password', { autocomplete: 'new-password' })}
          ${message ? `<div class="info-box">${escapeHtml(message)}</div>` : ''}
          <button type="submit" class="primary-button full-width">Update password</button>
        </form>
      </div>`
  }

  async function loadViewer(token) {
    clearInterval(viewerTimer)
    viewerToken = token
    document.getElementById('app').innerHTML = '<div class="full-page-loading"><div class="loading-mark">M</div><span>Opening the read-only dashboard…</span></div>'
    try {
      let payload
      if (CLOUD_ENABLED) {
        const result = await db.rpc('mfa_get_person_public_view', { p_token: token })
        if (result.error) throw result.error
        if (!result.data) throw new Error('This viewer link is invalid or has been replaced.')
        payload = {
          workspace: result.data.workspace,
          person: result.data.person,
          transactions: result.data.transactions || [],
          budgets: (result.data.budgets || []).map((item) => ({
            ...item,
            month: String(item.month).slice(0, 7),
          })),
          goals: result.data.goals || [],
          requests: result.data.requests || [],
        }
      } else {
        const local = loadLocal()
        const person = local.people.find((item) => item.share_token === token)
        if (!person) throw new Error('This viewer link is invalid or this browser does not contain its local records.')
        payload = {
          workspace: local.workspace,
          person,
          transactions: local.transactions.filter((item) => item.person_id === person.id),
          budgets: local.budgets.filter((item) => item.person_id === person.id),
          goals: local.goals.filter((item) => item.person_id === person.id),
          requests: [],
        }
      }
      viewerState = payload
      renderViewer(payload)
      viewerTimer = setInterval(async () => {
        if (!getRoute().path.startsWith('/view/')) return clearInterval(viewerTimer)
        try {
          let refreshed
          if (CLOUD_ENABLED) {
            const result = await db.rpc('mfa_get_person_public_view', { p_token: token })
            if (!result.error && result.data) {
              refreshed = {
                workspace: result.data.workspace,
                person: result.data.person,
                transactions: result.data.transactions || [],
                budgets: (result.data.budgets || []).map((item) => ({
                  ...item,
                  month: String(item.month).slice(0, 7),
                })),
                goals: result.data.goals || [],
                requests: result.data.requests || [],
              }
            }
          } else {
            const local = loadLocal()
            const person = local.people.find((item) => item.share_token === token)
            if (person) {
              refreshed = {
                workspace: local.workspace,
                person,
                transactions: local.transactions.filter((item) => item.person_id === person.id),
                budgets: local.budgets.filter((item) => item.person_id === person.id),
                goals: local.goals.filter((item) => item.person_id === person.id),
              }
            }
          }
          if (refreshed) {
            viewerState = refreshed
            renderViewer(refreshed)
          }
        } catch {
          // Keep the last successful view visible.
        }
      }, 5000)
    } catch (error) {
      viewerState = null
      document.getElementById('app').innerHTML = `
        <div class="viewer-error"><div class="brand-mark">M</div><h1>Secure link unavailable</h1><p>${escapeHtml(error.message)}</p></div>`
    }
  }

  function viewerGoalSummary(goals, balance, currency) {
    const reserved = goals
      .filter((goal) => goal.status === 'Active')
      .reduce((sum, goal) => sum + num(goal.reserved_amount), 0)
    return `
      <article class="budget-card goal-card">
        <div class="budget-icon">◎</div>
        <div class="budget-head"><span>Savings goals</span></div>
        <strong>${money(reserved, currency)}</strong>
        <p>${goals.length ? `${goals.length} goal${goals.length === 1 ? '' : 's'} tracked` : 'No goal yet'}</p>
        <div class="budget-stats"><span>Money remaining</span><span class="${balance < 0 ? 'negative-text' : ''}">${money(balance, currency)}</span></div>
      </article>`
  }

  async function triggerPublicRequestEmail(requestId) {
    if (!requestId || !viewerToken) return
    try {
      await fetch('/api/record-request-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_id: requestId, share_token: viewerToken }),
      })
    } catch {
      // The manager's in-app notification remains active even if outbound email is unavailable.
    }
  }

  async function submitViewerRequest(values) {
    const result = await db.rpc('mfa_submit_public_record_request', {
      p_token: viewerToken,
      p_transaction_type: values.type,
      p_amount: round(values.amount),
      p_currency: String(values.currency || viewerState?.workspace?.default_currency || 'NGN').trim().toUpperCase(),
      p_date: values.date_unknown || !values.date ? null : values.date,
      p_description: String(values.description || '').trim(),
      p_category: values.type === 'expense' ? values.category : null,
    })
    if (result.error) throw result.error
    await triggerPublicRequestEmail(result.data?.id)
    return result.data
  }

  async function updateViewerRequest(requestId, values) {
    const result = await db.rpc('mfa_update_public_record_request', {
      p_token: viewerToken,
      p_request_id: requestId,
      p_transaction_type: values.type,
      p_amount: round(values.amount),
      p_currency: String(values.currency || viewerState?.workspace?.default_currency || 'NGN').trim().toUpperCase(),
      p_date: values.date_unknown || !values.date ? null : values.date,
      p_description: String(values.description || '').trim(),
      p_category: values.type === 'expense' ? values.category : null,
    })
    if (result.error) throw result.error
    await triggerPublicRequestEmail(requestId)
    return result.data
  }

  async function deleteViewerRequest(requestId) {
    const result = await db.rpc('mfa_delete_public_record_request', {
      p_token: viewerToken,
      p_request_id: requestId,
    })
    if (result.error) throw result.error
  }

  function viewerRequestCards(requests) {
    if (!requests.length) return '<div class="small-empty">You have not submitted any record requests yet.</div>'
    return `<div class="request-list">${requests.map((item) => {
      const editable = item.status === 'pending'
      return `
        <article class="request-card" data-request-id="${item.id}">
          <div class="request-card-head">
            <div><span class="eyebrow">New ${item.transaction_type === 'income' ? 'income' : 'expense'} record</span><h3>${escapeHtml(item.description)}</h3></div>
            ${requestStatusBadge(item.status)}
          </div>
          <div class="request-meta"><strong>${item.transaction_type === 'income' ? '+' : '−'}${money(item.amount, item.currency)}</strong><span>${formatDate(item.date)}</span>${item.category ? `<span>${escapeHtml(item.category)}</span>` : ''}</div>
          ${item.reviewer_note ? `<div class="review-note"><strong>Manager note:</strong> ${escapeHtml(item.reviewer_note)}</div>` : ''}
          ${editable ? `<div class="request-actions"><button class="secondary-button" data-action="viewer-edit-request" data-request-id="${item.id}">Edit pending request</button><button class="text-button danger-text" data-action="viewer-delete-request" data-request-id="${item.id}">Delete pending request</button></div>` : `<div class="immutable-note">${item.status === 'approved' ? 'Approved and recorded. This ledger record cannot be changed from your link.' : 'Rejected. This request is locked and did not change the ledger.'}</div>`}
        </article>`
    }).join('')}</div>`
  }

  function openViewerRequestModal(options = {}) {
    if (!viewerState?.person || !CLOUD_ENABLED) return
    const existing = options.requestId ? (viewerState.requests || []).find((item) => item.id === options.requestId) : null
    if (existing && existing.status !== 'pending') {
      toast('Only pending requests can be edited.', 'danger')
      return
    }
    const type = existing?.transaction_type || options.type || 'income'
    const amount = existing?.amount ?? ''
    const currency = existing?.currency || viewerState.workspace.default_currency
    const date = existing?.date ? String(existing.date).slice(0, 10) : today()
    const unknownDate = existing ? !existing.date : false
    const description = existing?.description || ''
    const category = existing?.category || 'Other'
    const body = `
      <form class="modal-form" id="viewer-request-form">
        <input type="hidden" name="request_id" value="${escapeHtml(existing?.id || '')}">
        ${currencyDatalist()}
        <div class="two-fields"><label class="field"><span>Record type</span><select name="type"><option value="income" ${type === 'income' ? 'selected' : ''}>Income</option><option value="expense" ${type === 'expense' ? 'selected' : ''}>Expense</option></select></label><label class="field"><span>Amount</span><input name="amount" type="number" min="0.01" step="0.01" value="${escapeHtml(amount)}" required></label></div>
        <div class="two-fields"><label class="field"><span>Currency</span><input name="currency" list="currency-codes" maxlength="3" pattern="[A-Za-z]{3}" value="${escapeHtml(currency)}" required></label><label class="field"><span>Date</span><input name="date" type="date" value="${unknownDate ? '' : escapeHtml(date)}" ${unknownDate ? 'disabled' : ''}></label></div>
        <label class="checkbox-row"><input name="date_unknown" type="checkbox" data-action="viewer-toggle-request-unknown-date" ${unknownDate ? 'checked' : ''}><span>Date unknown or not remembered</span></label>
        <label class="field"><span>Expense category</span><select name="category">${EXPENSE_CATEGORIES.map((item) => `<option value="${item}" ${item === category ? 'selected' : ''}>${item}</option>`).join('')}</select><small>Ignored when the record type is Income.</small></label>
        <label class="field"><span>Description</span><input name="description" value="${escapeHtml(description)}" placeholder="What is this record for?" required></label>
        <div class="notice">This only requests a new record. Approved records cannot be edited or deleted from this link. Your balance changes only after the manager approves it.</div>
        <div id="viewer-request-error"></div>
        <div class="modal-actions"><button type="button" class="secondary-button" data-action="close-modal">Cancel</button><button class="primary-button">${existing ? 'Save pending request' : 'Submit for approval'}</button></div>
      </form>`
    openModal(existing ? 'Edit pending request' : `Request new ${type} record`, body)
  }
  function renderViewer(payload) {
    viewerState = payload
    const person = { ...payload.person, starting_balances: payload.person.starting_balances || {} }
    const data = {
      workspace: payload.workspace,
      people: [person],
      transactions: payload.transactions,
      budgets: payload.budgets,
      goals: payload.goals,
    }
    const currencies = uniqueCurrencies(person.id, data)
    const sections = currencies
      .map((currency) => {
        const position = personPosition(person.id, currency, '', data)
        const month = currentMonth()
        const pvLimit = num(getBudget(person.id, currency, month, data)?.pv_limit)
        const pvSpent = monthlySpend(person.id, currency, month, 'PV', data)
        const upkeepLimit = round(
          monthlyIncome(person.id, currency, month, data) *
            (num(payload.workspace.upkeep_percentage) / 100),
        )
        const upkeepSpent = monthlySpend(person.id, currency, month, 'Upkeep', data)
        const records = sortTransactions(
          payload.transactions.filter((item) => item.currency === currency),
          true,
        ).slice(0, 25)
        const goals = payload.goals.filter((goal) => goal.currency === currency)
        return `
          <section class="viewer-currency-section">
            <div class="viewer-currency-title">
              <span class="currency-badge">${currency}</span>
              <strong class="${position.balance < 0 ? 'negative-text' : ''}">${money(position.balance, currency)}</strong>
              <span>${position.balance < 0 ? `Borrowed funds in use: ${money(Math.abs(position.balance), currency)}` : 'Current balance'}</span>
            </div>
            <div class="summary-card-grid four viewer-summary">
              ${summaryCard('Starting balance', money(position.starting, currency), '◫', 'Opening position', position.starting < 0)}
              ${summaryCard('Income', money(position.income, currency), '↘')}
              ${summaryCard('Expenses', money(position.expenses, currency), '↗')}
              ${summaryCard('Balance', money(position.balance, currency), '▣', position.balance < 0 ? 'This amount is currently borrowed.' : '', position.balance < 0)}
            </div>
            <div class="budget-grid viewer-budgets">
              ${budgetCard('PV limit this month', 'PV', pvLimit, pvSpent, currency, person.id, month, false, 'Only actual PV expenses reduce the balance.')}
              ${budgetCard('Upkeep limit this month', 'U', upkeepLimit, upkeepSpent, currency, person.id, month, false, `${payload.workspace.upkeep_percentage}% of this month’s recorded income.`)}
              ${viewerGoalSummary(goals, position.balance, currency)}
            </div>
            <div class="panel">
              ${panelHeading('Recent records', `${records.length} shown`)}
              ${transactionListForViewer(records, person)}
            </div>
          </section>`
      })
      .join('')

    document.getElementById('app').innerHTML = `
      <div class="viewer-page">
        <header class="viewer-header">
          <div class="brand-row viewer-brand"><div class="brand-mark">M</div><div><strong>${escapeHtml(payload.workspace.name || 'My Fund App')}</strong><span>Personal finance record</span></div></div>
          <div><div class="live-badge"><span class="status-dot"></span>Updated automatically</div><div class="viewer-refresh">Checks every 5 seconds</div></div>
        </header>
        <main class="viewer-main">
          ${pageHeader('Your money record', person.name, 'You can see approved income and expenses here. You may request a new income or expense record, but nothing changes your balance until the manager approves it.', '<div class="button-row"><button class="secondary-button" data-action="viewer-open-request" data-type="expense">↗ Request expense</button><button class="primary-button" data-action="viewer-open-request" data-type="income">↘ Request income</button></div>')}
          <section class="panel"><div class="panel-heading"><div><h2>Your record requests</h2><p>Pending requests can be edited or deleted. Approved records are locked.</p></div></div>${viewerRequestCards(payload.requests || [])}</section>
          <div class="viewer-currencies">${sections}</div>
        </main>
      </div>`
  }

  function transactionListForViewer(records, person) {
    if (!records.length) return '<div class="small-empty">No records yet.</div>'
    return `<div class="transaction-list">${records
      .map(
        (item) => `
          <div class="transaction-row">
            <div class="transaction-icon ${item.type}">${item.type === 'income' ? '↘' : '↗'}</div>
            <div class="transaction-main"><strong>${escapeHtml(item.description)}</strong><span>${escapeHtml(person.name)}${item.category ? ` · ${escapeHtml(item.category)}` : ''} · ${formatDate(item.date)}</span></div>
            <strong class="${item.type === 'income' ? 'income-text' : ''}">${item.type === 'income' ? '+' : '−'}${money(item.amount, item.currency)}</strong>
          </div>`,
      )
      .join('')}</div>`
  }

  function requestStatusBadge(status) {
    const clean = String(status || 'pending')
    const label = clean === 'approved' ? 'Approved' : clean === 'rejected' ? 'Rejected' : 'Pending approval'
    return `<span class="request-status ${escapeHtml(clean)}">${label}</span>`
  }

  function contributorTransactionList(records) {
    if (!records.length) return '<div class="small-empty">No approved records yet.</div>'
    return `<div class="transaction-list">${sortTransactions(records, true)
      .map((item) => `
        <div class="transaction-row">
          <div class="transaction-icon ${item.type}">${item.type === 'income' ? '↘' : '↗'}</div>
          <div class="transaction-main">
            <strong>${escapeHtml(item.description)}</strong>
            <span>${item.category ? `${escapeHtml(item.category)} · ` : ''}${formatDate(item.date)}</span>
          </div>
          <strong class="${item.type === 'income' ? 'income-text' : ''}">${item.type === 'income' ? '+' : '−'}${money(item.amount, item.currency)}</strong>
          <button class="secondary-button compact-button" data-action="request-update" data-transaction-id="${item.id}">Request update</button>
        </div>`)
      .join('')}</div>`
  }

  function contributorRequestCards(requests) {
    if (!requests.length) return '<div class="small-empty">No requests submitted yet.</div>'
    return `<div class="request-list">${requests
      .map((item) => {
        const editable = item.status === 'pending'
        const actionLabel = item.request_action === 'update' ? 'Update record' : 'New record'
        return `
          <article class="request-card" data-request-id="${item.id}">
            <div class="request-card-head">
              <div><span class="eyebrow">${actionLabel}</span><h3>${escapeHtml(item.description)}</h3></div>
              ${requestStatusBadge(item.status)}
            </div>
            <div class="request-meta">
              <span>${item.transaction_type === 'income' ? 'Income' : 'Expense'}</span>
              <strong>${money(item.amount, item.currency)}</strong>
              <span>${formatDate(item.date)}</span>
              ${item.category ? `<span>${escapeHtml(item.category)}</span>` : ''}
            </div>
            ${item.reviewer_note ? `<div class="review-note"><strong>Manager note:</strong> ${escapeHtml(item.reviewer_note)}</div>` : ''}
            ${editable ? `<div class="request-actions"><button class="secondary-button" data-action="edit-request" data-request-id="${item.id}">Edit</button><button class="text-button danger-text" data-action="delete-request" data-request-id="${item.id}">Delete request</button></div>` : '<div class="immutable-note">This request is locked because it has already been reviewed.</div>'}
          </article>`
      })
      .join('')}</div>`
  }

  function contributorNotifications() {
    const notifications = contributorState?.notifications || []
    if (!notifications.length) return '<div class="small-empty">No notifications yet.</div>'
    return `<div class="notification-list">${notifications.slice(0, 20).map((item) => `
      <button class="notification-item ${item.is_read ? '' : 'unread'}" data-action="read-notification" data-notification-id="${item.id}">
        <strong>${escapeHtml(item.title)}</strong>
        <span>${escapeHtml(item.body)}</span>
        <small>${formatTimestamp(item.created_at)}</small>
      </button>`).join('')}</div>`
  }

  function renderContributor() {
    const person = contributorState?.person
    if (!person) return shell('<section class="panel empty-state"><h2>Contributor access unavailable</h2><p>Your account is not connected to a person yet.</p></section>', 'contributor')

    const currencies = uniqueCurrencies(person.id)
    const balanceCards = (currencies.length ? currencies : [state.workspace.default_currency]).map((currency) => {
      const position = personPosition(person.id, currency)
      return summaryCard(
        `${currency} current balance`,
        money(position.balance, currency),
        '▣',
        `${money(position.income, currency)} income · ${money(position.expenses, currency)} expenses`,
        position.balance < 0,
      )
    }).join('')

    const pending = (contributorState.requests || []).filter((item) => item.status === 'pending').length
    const content = `
      ${pageHeader(
        'Contributor account',
        person.name,
        'You can submit new records or corrections. Nothing changes the real ledger until the account manager approves it.',
        `<div class="button-row"><button class="secondary-button" data-action="open-request" data-type="expense">↗ Request expense</button><button class="primary-button" data-action="open-request" data-type="income">↘ Request income</button></div>`,
      )}
      <section class="summary-card-grid four">
        ${balanceCards}
        ${summaryCard('Pending requests', String(pending), '◎', 'Editable until the manager reviews them')}
      </section>
      <section class="panel">
        ${panelHeading('Approved records', `${state.transactions.length} recorded item${state.transactions.length === 1 ? '' : 's'}`)}
        ${contributorTransactionList(state.transactions)}
      </section>
      <section class="panel">
        ${panelHeading('Notifications', 'Approval and rejection updates')}
        ${contributorNotifications()}
      </section>`
    return shell(content, 'contributor')
  }

  function renderContributorRequests() {
    const requests = contributorState?.requests || []
    const pending = requests.filter((item) => item.status === 'pending').length
    const content = `
      ${pageHeader(
        'Request history',
        'Your record requests',
        'Pending requests can be edited or deleted. Once approved or rejected, they are locked.',
        `<div class="button-row"><button class="secondary-button" data-action="open-request" data-type="expense">↗ Expense request</button><button class="primary-button" data-action="open-request" data-type="income">↘ Income request</button></div>`,
      )}
      <section class="summary-grid">
        ${summaryCard('Pending', String(pending), '◎', 'Waiting for manager review')}
        ${summaryCard('Approved', String(requests.filter((item) => item.status === 'approved').length), '✓')}
        ${summaryCard('Rejected', String(requests.filter((item) => item.status === 'rejected').length), '×')}
      </section>
      <section class="panel">
        ${contributorRequestCards(requests)}
      </section>`
    return shell(content, 'requests')
  }

  function ownerRequestCards(requests, focusId = '') {
    if (!requests.length) return '<div class="small-empty">No submitted requests yet.</div>'
    return `<div class="request-list">${requests.map((item) => {
      const pending = item.status === 'pending'
      const focused = focusId && item.id === focusId
      return `
        <article class="request-card ${focused ? 'request-focus' : ''}" data-request-id="${item.id}">
          <div class="request-card-head">
            <div>
              <span class="eyebrow">${item.request_action === 'update' ? 'Record update request' : 'New record request'}</span>
              <h3>${escapeHtml(item.person_name || 'Person')}</h3>
            </div>
            ${requestStatusBadge(item.status)}
          </div>
          <div class="approval-amount">${item.transaction_type === 'income' ? '+' : '−'}${money(item.amount, item.currency)}</div>
          <div class="request-meta">
            <span>${item.transaction_type === 'income' ? 'Income' : 'Expense'}</span>
            <span>${formatDate(item.date)}</span>
            ${item.category ? `<span>${escapeHtml(item.category)}</span>` : ''}
            <span>From ${escapeHtml(item.source_label || 'Personal secure link')}</span>
          </div>
          <p class="request-description">${escapeHtml(item.description)}</p>
          ${item.reviewer_note ? `<div class="review-note"><strong>Review note:</strong> ${escapeHtml(item.reviewer_note)}</div>` : ''}
          ${pending ? `<div class="request-actions"><button class="primary-button" data-action="approve-request" data-request-id="${item.id}">✓ Approve and record</button><button class="secondary-button" data-action="reject-request" data-request-id="${item.id}">Reject</button></div>` : '<div class="immutable-note">Review completed. The person can no longer edit or delete this request.</div>'}
        </article>`
    }).join('')}</div>`
  }

  function renderApprovals() {
    const route = getRoute()
    const focusId = route.query.get('request') || ''
    const requests = approvalState.requests || []
    const pending = requests.filter((item) => item.status === 'pending')
    const history = requests.filter((item) => item.status !== 'pending')
    const unread = (approvalState.notifications || []).filter((item) => !item.is_read).length

    const content = `
      ${pageHeader(
        'Manager approvals',
        'Review person-submitted records',
        'Requests from secure person links stay outside the ledger until you approve them. Approval creates the real record; rejection leaves the ledger unchanged.',
        '<button class="secondary-button" data-action="refresh-approvals">↻ Refresh</button>',
      )}
      <section class="summary-grid">
        ${summaryCard('Pending approval', String(pending.length), '◎', 'Needs your decision')}
        ${summaryCard('Unread notifications', String(unread), '◉')}
        ${summaryCard('People with requests', String(new Set(requests.map((item) => item.person_id)).size), '◇')}
      </section>
      ${approvalError ? `<div class="notice danger">${escapeHtml(approvalError)}</div>` : ''}
      <section class="panel">
        ${panelHeading('Waiting for approval', pending.length ? `${pending.length} request${pending.length === 1 ? '' : 's'}` : 'Nothing waiting')}
        ${ownerRequestCards(pending, focusId)}
      </section>
      <section class="panel">
        ${panelHeading('Review history', 'Approved and rejected requests')}
        ${ownerRequestCards(history, focusId)}
      </section>`

    setTimeout(() => {
      if (!focusId) return
      const target = document.querySelector(`[data-request-id="${CSS.escape(focusId)}"]`)
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 50)

    return shell(content, 'approvals')
  }

  function renderJoinInvite(token) {
    return `
      <div class="auth-page">
        ${authBrand()}
        <div class="auth-card">
          <div class="auth-form-heading">
            <h2>Join a My Fund account</h2>
            <p>This invite lets you submit records for the person connected to your email. Your entries will require manager approval before they affect the ledger.</p>
          </div>
          <div class="notice">Signed in as <strong>${escapeHtml(signedInEmail())}</strong>. The invite will only work if this is the invited email address.</div>
          <button class="primary-button full-width" data-action="accept-invite" data-token="${escapeHtml(token)}">Accept contributor access</button>
          <button class="text-button full-width" data-action="signout">Use a different account</button>
        </div>
      </div>`
  }

  function render() {
    clearInterval(viewerTimer)
    if (CLOUD_UNAVAILABLE) {
      document.getElementById('app').innerHTML = `
        <div class="viewer-error">
          <div class="brand-mark">M</div>
          <h1>Cloud service unavailable</h1>
          <p>My Fund App is configured for Neon cloud services, but the authentication or Data API client did not load. Your finance data has not been switched to browser-only storage.</p>
          <button class="primary-button" onclick="location.reload()">Try again</button>
        </div>`
      return
    }

    const resetToken = new URLSearchParams(location.search).get('token')
    const resetError = new URLSearchParams(location.search).get('error')
    if (resetError) {
      history.replaceState({}, '', location.pathname + (location.hash || ''))
      renderForgotPassword('This password reset link is invalid or has expired.')
      return
    }
    if (resetToken) {
      passwordRecoveryMode = true
      renderPasswordReset()
      return
    }

    const route = getRoute()
    if (route.path.startsWith('/view/')) {
      loadViewer(route.segments[1])
      return
    }

    if (CLOUD_ENABLED && !session) {
      renderAuth()
      return
    }





    let html
    if (route.path === '/dashboard' || route.path === '/') html = renderDashboard()
    else if (route.path === '/people') html = renderPeople()
    else if (route.segments[0] === 'person' && route.segments[1]) html = renderPerson(route.segments[1])
    else if (route.path === '/transactions') html = renderTransactions()
    else if (route.path === '/approvals') html = renderApprovals()
    else if (route.path === '/reports') html = renderReports()
    else if (route.path === '/admin') {
      if (!isPlatformAdmin()) {
        go('/dashboard')
        html = renderDashboard()
      } else {
        if (!adminState && !adminLoading) {
          adminLoading = true
          refreshAdmin()
            .catch((error) => { adminError = error.message || 'Unable to load platform records.' })
            .finally(() => { adminLoading = false; if (getRoute().path === '/admin') render() })
        }
        html = renderAdmin()
      }
    }
    else if (route.path === '/settings') html = renderSettings()
    else {
      go('/dashboard')
      html = renderDashboard()
    }
    document.getElementById('app').innerHTML = html
  }

  function openModal(title, body, wide = false) {
    let root = document.getElementById('modal-root')
    if (!root) {
      root = document.createElement('div')
      root.id = 'modal-root'
      document.body.appendChild(root)
    }
    root.innerHTML = `
      <div class="modal-backdrop" data-action="modal-backdrop">
        <div class="modal ${wide ? 'wide' : ''}">
          <div class="modal-head"><h2>${escapeHtml(title)}</h2><button class="icon-button" data-action="close-modal">×</button></div>
          ${body}
        </div>
      </div>`
  }

  function closeModal() {
    const root = document.getElementById('modal-root')
    if (root) root.innerHTML = ''
  }

  function transactionRowTemplate(type, currency, index = 0) {
    const categoryField =
      type === 'expense'
        ? `<label class="field"><span>Category</span><select data-field="category">${EXPENSE_CATEGORIES.map((item) => `<option value="${item}">${item}</option>`).join('')}</select></label>`
        : ''
    return `
      <div class="bulk-entry-row" data-entry-index="${index}">
        <div class="bulk-entry-head">
          <strong>${type === 'income' ? 'Income' : 'Expense'} ${index + 1}</strong>
          <button type="button" class="icon-button mini" data-action="remove-transaction-row" title="Remove row">×</button>
        </div>
        <div class="bulk-entry-grid">
          <label class="field"><span>Amount</span><input data-field="amount" type="number" min="0.01" step="0.01" required></label>
          <label class="field"><span>Currency</span><input data-field="currency" list="currency-codes" maxlength="3" pattern="[A-Za-z]{3}" value="${escapeHtml(currency)}" required></label>
          <label class="field"><span>Date</span><input data-field="date" type="date" value="${today()}"></label>
          ${categoryField}
        </div>
        <label class="checkbox-row">
          <input type="checkbox" data-action="toggle-unknown-date" data-field="date_unknown">
          <span>Date unknown or not remembered</span>
        </label>
        <label class="field"><span>${type === 'income' ? 'Income source or description' : 'What is this expense for?'}</span><input data-field="description" placeholder="${type === 'income' ? 'e.g. Monthly earnings' : 'e.g. PV order, food or investment'}" required></label>
      </div>`
  }

  function renumberTransactionRows() {
    document.querySelectorAll('#bulk-transaction-rows .bulk-entry-row').forEach((row, index) => {
      row.dataset.entryIndex = String(index)
      const heading = row.querySelector('.bulk-entry-head strong')
      const type = document.querySelector('#transaction-form input[name="type"]')?.value || 'income'
      if (heading) heading.textContent = `${type === 'income' ? 'Income' : 'Expense'} ${index + 1}`
      const remove = row.querySelector('[data-action="remove-transaction-row"]')
      if (remove) remove.hidden = document.querySelectorAll('#bulk-transaction-rows .bulk-entry-row').length === 1
    })
  }

  function transactionEntriesFromForm(form) {
    const personId = form.querySelector('input[name="person_id"]')?.value
    const type = form.querySelector('input[name="type"]')?.value
    return [...form.querySelectorAll('.bulk-entry-row')].map((row) => ({
      person_id: personId,
      type,
      amount: row.querySelector('[data-field="amount"]')?.value,
      currency: row.querySelector('[data-field="currency"]')?.value,
      date: row.querySelector('[data-field="date"]')?.value,
      date_unknown: row.querySelector('[data-field="date_unknown"]')?.checked,
      category: type === 'expense' ? row.querySelector('[data-field="category"]')?.value : null,
      description: row.querySelector('[data-field="description"]')?.value,
    }))
  }

  function openTransactionModal(personId, type) {
    const person = personById(personId)
    if (!person) return
    const currency = ui.personCurrency[personId] || uniqueCurrencies(personId)[0] || state.workspace.default_currency
    const body = `
      <form class="modal-form bulk-transaction-form" id="transaction-form">
        <input type="hidden" name="person_id" value="${person.id}">
        <input type="hidden" name="type" value="${type}">
        ${currencyDatalist()}
        <div id="bulk-transaction-rows">${transactionRowTemplate(type, currency, 0)}</div>
        <button type="button" class="secondary-button add-row-button" data-action="add-transaction-row" data-type="${type}" data-currency="${escapeHtml(currency)}">＋ Add another ${type}</button>
        <div class="notice ${type === 'expense' ? 'warn' : ''}">
          ${
            type === 'expense'
              ? 'Expenses may make the person’s overall balance negative. Records with an unknown date affect the balance but are not counted against a particular month’s PV or Upkeep limit.'
              : 'Income increases the person’s balance. Records with an unknown date appear in all-time totals but not in month-based reports.'
          }
        </div>
        <div id="transaction-error"></div>
        <div class="modal-actions"><button type="button" class="secondary-button" data-action="close-modal">Cancel</button><button class="primary-button">${type === 'income' ? '↘ Save income records' : '↗ Save expense records'}</button></div>
      </form>`
    openModal(`${type === 'income' ? 'Add income for' : 'Add expense for'} ${person.name}`, body, true)
    renumberTransactionRows()
  }

  function openContributorRequestModal(options = {}) {
    const person = contributorState?.person
    if (!person) return

    const existingRequest = options.requestId
      ? (contributorState?.requests || []).find((item) => item.id === options.requestId)
      : null
    const targetTransaction = options.transactionId
      ? state.transactions.find((item) => item.id === options.transactionId)
      : existingRequest?.target_transaction_id
        ? state.transactions.find((item) => item.id === existingRequest.target_transaction_id)
        : null

    const seed = existingRequest || targetTransaction || {}
    const requestAction = existingRequest?.request_action || (targetTransaction ? 'update' : 'create')
    const type = existingRequest?.transaction_type || targetTransaction?.type || options.type || 'income'
    const amount = seed.amount ?? ''
    const currency = seed.currency || state.workspace.default_currency
    const date = seed.date ? String(seed.date).slice(0, 10) : today()
    const unknownDate = !seed.date && Boolean(existingRequest || targetTransaction)
    const description = seed.description || ''
    const category = seed.category || 'Other'

    const body = `
      <form class="modal-form" id="contributor-request-form">
        <input type="hidden" name="request_id" value="${escapeHtml(existingRequest?.id || '')}">
        <input type="hidden" name="person_id" value="${escapeHtml(person.id)}">
        <input type="hidden" name="request_action" value="${escapeHtml(requestAction)}">
        <input type="hidden" name="target_transaction_id" value="${escapeHtml(targetTransaction?.id || existingRequest?.target_transaction_id || '')}">
        ${currencyDatalist()}
        <div class="two-fields">
          <label class="field"><span>Record type</span><select name="type"><option value="income" ${type === 'income' ? 'selected' : ''}>Income</option><option value="expense" ${type === 'expense' ? 'selected' : ''}>Expense</option></select></label>
          <label class="field"><span>Amount</span><input name="amount" type="number" min="0.01" step="0.01" value="${escapeHtml(amount)}" required></label>
        </div>
        <div class="two-fields">
          <label class="field"><span>Currency</span><input name="currency" list="currency-codes" maxlength="3" pattern="[A-Za-z]{3}" value="${escapeHtml(currency)}" required></label>
          <label class="field"><span>Date</span><input name="date" type="date" value="${unknownDate ? '' : escapeHtml(date)}" ${unknownDate ? 'disabled' : ''}></label>
        </div>
        <label class="checkbox-row"><input name="date_unknown" type="checkbox" data-action="toggle-request-unknown-date" ${unknownDate ? 'checked' : ''}><span>Date unknown or not remembered</span></label>
        <label class="field"><span>Expense category</span><select name="category">${EXPENSE_CATEGORIES.map((item) => `<option value="${item}" ${item === category ? 'selected' : ''}>${item}</option>`).join('')}</select><small>Ignored when the record type is Income.</small></label>
        <label class="field"><span>Description</span><input name="description" value="${escapeHtml(description)}" placeholder="What is this record for?" required></label>
        <div class="notice">${requestAction === 'update' ? 'This requests a correction to an approved record. The original record stays unchanged until the manager approves the update.' : 'This stays pending and does not affect your balance until the manager approves it.'}</div>
        <div id="contributor-request-error"></div>
        <div class="modal-actions"><button type="button" class="secondary-button" data-action="close-modal">Cancel</button><button class="primary-button">${existingRequest ? 'Save pending request' : 'Submit for approval'}</button></div>
      </form>`

    openModal(
      existingRequest
        ? 'Edit pending request'
        : requestAction === 'update'
          ? 'Request a record update'
          : 'Submit a new record',
      body,
    )
  }

  function openPersonEmailModal(personId) {
    const person = personById(personId)
    if (!person) return
    const body = `
      <form class="modal-form" id="person-email-form">
        <input type="hidden" name="person_id" value="${person.id}">
        <label class="field"><span>Email for ledger notifications</span><input name="email" type="email" value="${escapeHtml(person.email || '')}" placeholder="person@example.com" required autofocus></label>
        <div class="notice">This address receives an email whenever an approved income or expense record is added, edited or deleted for ${escapeHtml(person.name)}.</div>
        <div id="person-email-error"></div>
        <div class="modal-actions"><button type="button" class="secondary-button" data-action="close-modal">Cancel</button><button class="primary-button">✓ Save email</button></div>
      </form>`
    openModal(`Notification email for ${person.name}`, body)
  }
  function openEditTransactionModal(transactionId) {
    const item = state.transactions.find((record) => record.id === transactionId)
    if (!item) return
    const person = personById(item.person_id)
    const unknownDate = !item.date
    const body = `
      <form class="modal-form" id="edit-transaction-form">
        <input type="hidden" name="transaction_id" value="${item.id}">
        ${currencyDatalist()}
        <div class="two-fields">
          <label class="field"><span>Record type</span><select name="type"><option value="income" ${item.type === 'income' ? 'selected' : ''}>Income</option><option value="expense" ${item.type === 'expense' ? 'selected' : ''}>Expense</option></select></label>
          <label class="field"><span>Amount</span><input name="amount" type="number" min="0.01" step="0.01" value="${item.amount}" required></label>
        </div>
        <div class="two-fields">
          <label class="field"><span>Currency</span><input name="currency" list="currency-codes" maxlength="3" pattern="[A-Za-z]{3}" value="${escapeHtml(item.currency)}" required></label>
          <label class="field"><span>Date</span><input name="date" type="date" value="${unknownDate ? '' : escapeHtml(String(item.date).slice(0, 10))}" ${unknownDate ? 'disabled' : ''}></label>
        </div>
        <label class="checkbox-row"><input name="date_unknown" type="checkbox" data-action="toggle-edit-transaction-unknown-date" ${unknownDate ? 'checked' : ''}><span>Date unknown or not remembered</span></label>
        <label class="field"><span>Expense category</span><select name="category">${EXPENSE_CATEGORIES.map((category) => `<option value="${category}" ${item.category === category ? 'selected' : ''}>${category}</option>`).join('')}</select><small>Ignored for Income.</small></label>
        <label class="field"><span>Description</span><input name="description" value="${escapeHtml(item.description)}" required></label>
        <div class="notice">Saving this change updates the approved ledger and sends ${escapeHtml(person?.email || 'the attached email')} a notification.</div>
        <div id="edit-transaction-error"></div>
        <div class="modal-actions"><button type="button" class="secondary-button" data-action="close-modal">Cancel</button><button class="primary-button">✓ Save record changes</button></div>
      </form>`
    openModal(`Edit ${item.type} for ${person?.name || 'person'}`, body)
  }
  function openStartingBalanceModal(personId, currency) {
    const person = personById(personId)
    if (!person) return
    const selectedCurrency = currency || state.workspace.default_currency
    const current = startingBalanceFor(person, selectedCurrency)
    const body = `
      <form class="modal-form" id="starting-balance-form">
        <input type="hidden" name="person_id" value="${person.id}">
        <label class="field"><span>Currency code</span><input name="currency" list="currency-codes" maxlength="3" pattern="[A-Za-z]{3}" value="${escapeHtml(selectedCurrency)}" required>${currencyDatalist()}</label>
        <label class="field"><span>Starting balance</span><input name="amount" type="number" step="0.01" value="${current}" required autofocus></label>
        <div class="notice">This is the person’s balance before recorded income and expenses. Updating it recalculates all balances but does not create a transaction. Negative values are allowed.</div>
        <div id="starting-balance-error"></div>
        <div class="modal-actions"><button type="button" class="secondary-button" data-action="close-modal">Cancel</button><button class="primary-button">✓ Save starting balance</button></div>
      </form>`
    openModal(`Starting balance for ${person.name}`, body)
  }

  function openBudgetModal(personId, currency, month, current) {
    const person = personById(personId)
    const spent = monthlySpend(personId, currency, month, 'PV')
    const body = `
      <form class="modal-form" id="budget-form">
        <input type="hidden" name="person_id" value="${personId}">
        <input type="hidden" name="currency" value="${currency}">
        <input type="hidden" name="month" value="${month}">
        <label class="field"><span>PV spending limit for ${month}</span><input name="pv_limit" type="number" min="${spent}" step="0.01" value="${num(current)}" required autofocus></label>
        <div class="notice">Already recorded PV expenses: <strong>${money(spent, currency)}</strong>. Updating the limit does not add income or create an expense.</div>
        <div id="budget-error"></div>
        <div class="modal-actions"><button type="button" class="secondary-button" data-action="close-modal">Cancel</button><button class="primary-button">✓ Save PV limit</button></div>
      </form>`
    openModal(`Update ${person?.name || ''} PV limit`, body)
  }

  function openGoalModal(personId, currency) {
    const person = personById(personId)
    const body = `
      <form class="modal-form" id="goal-form">
        <input type="hidden" name="person_id" value="${personId}">
        <label class="field"><span>What are they saving for?</span><input name="name" placeholder="e.g. Property investment" required autofocus></label>
        <div class="two-fields">
          <label class="field"><span>Target amount</span><input name="target_amount" type="number" min="0.01" step="0.01" required></label>
          <label class="field"><span>Currency code</span><input name="currency" list="currency-codes" maxlength="3" pattern="[A-Za-z]{3}" value="${escapeHtml(currency)}" required>${currencyDatalist()}</label>
        </div>
        <label class="field"><span>Amount currently reserved</span><input name="reserved_amount" type="number" min="0" step="0.01" value="0"></label>
        <label class="field"><span>Target date (optional)</span><input name="target_date" type="date"></label>
        <div class="notice">A goal is informational. It does not change the person’s balance and is not an expense.</div>
        <div id="goal-error"></div>
        <div class="modal-actions"><button type="button" class="secondary-button" data-action="close-modal">Cancel</button><button class="primary-button">◎ Save goal</button></div>
      </form>`
    openModal(`Add a goal for ${person?.name || ''}`, body)
  }

  function toast(message, type = 'success') {
    clearTimeout(toastTimer)
    let container = document.getElementById('toast')
    if (!container) return
    container.innerHTML = `<div class="local-banner ${type === 'danger' ? 'notice danger' : ''}" style="margin:14px 0 0"><span>${type === 'danger' ? '!' : '✓'}</span><span>${escapeHtml(message)}</span></div>`
    toastTimer = setTimeout(() => {
      if (container) container.innerHTML = ''
    }, 3500)
  }

  const scriptPromises = new Map()

  function loadScript(src) {
    if (scriptPromises.has(src)) return scriptPromises.get(src)
    const promise = new Promise((resolve, reject) => {
      const existing = document.querySelector?.(`script[src="${src}"]`)
      if (existing) {
        existing.addEventListener('load', resolve, { once: true })
        existing.addEventListener('error', () => reject(new Error(`Unable to load ${src}`)), { once: true })
        return
      }
      const script = document.createElement('script')
      script.src = src
      script.onload = resolve
      script.onerror = () => reject(new Error(`Unable to load ${src}`))
      document.head.appendChild(script)
    })
    scriptPromises.set(src, promise)
    return promise
  }

  async function ensurePdfLibraries() {
    if (!window.jspdf?.jsPDF) {
      await loadScript('https://cdn.jsdelivr.net/npm/jspdf@4.0.0/dist/jspdf.umd.min.js')
    }
    if (window.jspdf?.jsPDF && typeof window.jspdf.jsPDF.prototype.autoTable !== 'function') {
      await loadScript('https://cdn.jsdelivr.net/npm/jspdf-autotable@5.0.8/dist/jspdf.plugin.autotable.min.js')
    }
  }

  async function ensureXlsxLibrary() {
    if (!window.XLSX) {
      await loadScript('https://cdn.sheetjs.com/xlsx-0.18.5/package/dist/xlsx.full.min.js')
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  function exportCsv() {
    const range = dateRange(ui.reportPreset, ui.reportStart, ui.reportEnd)
    const rows = reportRows(ui.reportPerson, ui.reportCurrency, range.start, range.end)
    const values = [
      ['Date', 'Person', 'Type', 'Category', 'Description', 'Amount', 'Currency'],
      ...rows.summary.map((item) => [
        '',
        item.person_name,
        'starting_balance',
        '',
        'Starting balance',
        item.starting,
        item.currency,
      ]),
      ...rows.transactions.map((item) => [
        item.date ? String(item.date).slice(0, 10) : 'Date unknown',
        item.person_name,
        item.type,
        item.category || '',
        item.description,
        item.amount,
        item.currency,
      ]),
    ]
    const csv = values
      .map((row) =>
        row
          .map((cell) => `"${String(cell ?? '').replaceAll('"', '""')}"`)
          .join(','),
      )
      .join('\n')
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `my-fund-app-records-${today()}.csv`)
  }

  async function exportXlsx() {
    try {
      await ensureXlsxLibrary()
    } catch {
      toast('Excel export library could not load. Use CSV or check the connection.', 'danger')
      return
    }
    const range = dateRange(ui.reportPreset, ui.reportStart, ui.reportEnd)
    const rows = reportRows(ui.reportPerson, ui.reportCurrency, range.start, range.end)
    const summarySheet = window.XLSX.utils.json_to_sheet(
      rows.summary.map((item) => ({
        Person: item.person_name,
        Currency: item.currency,
        StartingBalance: item.starting,
        Opening: item.opening,
        Income: item.income,
        Expenses: item.expenses,
        Closing: item.closing,
      })),
    )
    const transactionSheet = window.XLSX.utils.json_to_sheet(
      rows.transactions.map((item) => ({
        Date: item.date ? String(item.date).slice(0, 10) : 'Date unknown',
        Person: item.person_name,
        Type: item.type,
        Category: item.category || '',
        Description: item.description,
        Amount: item.amount,
        Currency: item.currency,
      })),
    )
    const workbook = window.XLSX.utils.book_new()
    window.XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary')
    window.XLSX.utils.book_append_sheet(workbook, transactionSheet, 'Transactions')
    window.XLSX.writeFile(workbook, `my-fund-app-${range.start || 'all-time'}-${range.end || today()}.xlsx`)
  }

  async function exportPdf() {
    try {
      await ensurePdfLibraries()
    } catch {
      // The printable browser fallback below remains available.
    }
    const range = dateRange(ui.reportPreset, ui.reportStart, ui.reportEnd)
    const rows = reportRows(ui.reportPerson, ui.reportCurrency, range.start, range.end)
    if (window.jspdf?.jsPDF) {
      const doc = new window.jspdf.jsPDF({ orientation: 'landscape' })
      doc.setFontSize(18)
      doc.text(state.workspace.name || 'My Fund App', 14, 16)
      doc.setFontSize(10)
      doc.text(
        `Financial records · ${range.start ? `${formatDate(range.start)} to ${formatDate(range.end)}` : 'All time'} · Generated ${formatDate(today())}`,
        14,
        23,
      )
      if (typeof doc.autoTable === 'function') {
        doc.autoTable({
          startY: 30,
          head: [['Person', 'Currency', 'Starting', 'Opening', 'Income', 'Expenses', 'Closing']],
          body: rows.summary.map((item) => [
            item.person_name,
            item.currency,
            money(item.starting, item.currency),
            money(item.opening, item.currency),
            money(item.income, item.currency),
            money(item.expenses, item.currency),
            money(item.closing, item.currency),
          ]),
          styles: { fontSize: 8 },
          headStyles: { fillColor: [20, 37, 31] },
        })
        doc.autoTable({
          startY: doc.lastAutoTable.finalY + 8,
          head: [['Date', 'Person', 'Type', 'Category', 'Description', 'Amount']],
          body: rows.transactions.map((item) => [
            formatDate(item.date),
            item.person_name,
            item.type,
            item.category || '—',
            item.description,
            money(item.amount, item.currency),
          ]),
          styles: { fontSize: 7 },
          headStyles: { fillColor: [20, 37, 31] },
        })
      } else {
        let y = 32
        rows.summary.slice(0, 25).forEach((item) => {
          doc.text(
            `${item.person_name} · ${item.currency} · Closing ${money(item.closing, item.currency)}`,
            14,
            y,
          )
          y += 6
        })
      }
      doc.save(`my-fund-app-${range.start || 'all-time'}-${range.end || today()}.pdf`)
      return
    }

    // Reliable fallback: printable report that users can save as PDF from the browser.
    const reportWindow = window.open('', '_blank')
    if (!reportWindow) {
      toast('Allow pop-ups to create a printable PDF report.', 'danger')
      return
    }
    const summaryHtml = rows.summary
      .map(
        (item) => `<tr><td>${escapeHtml(item.person_name)}</td><td>${item.currency}</td><td>${money(item.starting, item.currency)}</td><td>${money(item.opening, item.currency)}</td><td>${money(item.income, item.currency)}</td><td>${money(item.expenses, item.currency)}</td><td>${money(item.closing, item.currency)}</td></tr>`,
      )
      .join('')
    const transactionHtml = rows.transactions
      .map(
        (item) => `<tr><td>${formatDate(item.date)}</td><td>${escapeHtml(item.person_name)}</td><td>${escapeHtml(item.type)}</td><td>${escapeHtml(item.category || '')}</td><td>${escapeHtml(item.description)}</td><td>${money(item.amount, item.currency)}</td></tr>`,
      )
      .join('')
    reportWindow.document.write(`<!doctype html><html><head><title>My Fund App Report</title><style>body{font-family:Arial,sans-serif;padding:24px;color:#15221d}h1{margin-bottom:4px}p{color:#68756f}table{width:100%;border-collapse:collapse;margin:18px 0;font-size:11px}th,td{border:1px solid #dfe5e1;padding:7px;text-align:left}th{background:#14251f;color:white}@media print{button{display:none}}</style></head><body><h1>${escapeHtml(state.workspace.name)}</h1><p>${range.start ? `${formatDate(range.start)} to ${formatDate(range.end)}` : 'All time'}</p><button onclick="window.print()">Save as PDF / Print</button><h2>Summary</h2><table><thead><tr><th>Person</th><th>Currency</th><th>Starting</th><th>Opening</th><th>Income</th><th>Expenses</th><th>Closing</th></tr></thead><tbody>${summaryHtml}</tbody></table><h2>Transactions</h2><table><thead><tr><th>Date</th><th>Person</th><th>Type</th><th>Category</th><th>Description</th><th>Amount</th></tr></thead><tbody>${transactionHtml}</tbody></table></body></html>`)
    reportWindow.document.close()
  }

  function exportBackup() {
    downloadBlob(
      new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }),
      `my-fund-app-backup-${today()}.json`,
    )
  }

  async function restoreBackup(file) {
    if (CLOUD_ENABLED) throw new Error('JSON restore is available only in local mode.')
    const parsed = JSON.parse(await file.text())
    state = { ...structuredClone(DEFAULT_DATA), ...parsed }
    saveLocal()
    render()
    toast('Backup restored successfully.')
  }

  async function handleSubmit(event) {
    const form = event.target
    if (!(form instanceof HTMLFormElement)) return

    if (form.id === 'viewer-request-form') {
      event.preventDefault()
      if (busy) return
      busy = true
      const errorBox = document.getElementById('viewer-request-error')
      try {
        const values = Object.fromEntries(new FormData(form).entries())
        values.date_unknown = form.querySelector('input[name="date_unknown"]')?.checked || false
        if (values.request_id) await updateViewerRequest(values.request_id, values)
        else await submitViewerRequest(values)
        closeModal()
        await loadViewer(viewerToken)
        toast(values.request_id ? 'Pending request updated.' : 'Request sent for manager approval.')
      } catch (error) {
        if (errorBox) errorBox.innerHTML = `<div class="notice danger" style="margin-top:12px">${escapeHtml(error.message || 'Unable to save request.')}</div>`
      } finally {
        busy = false
      }
      return
    }
    if (form.id === 'invite-contributor-form') {
      event.preventDefault()
      if (busy) return
      busy = true
      try {
        const values = Object.fromEntries(new FormData(form).entries())
        const invite = await createContributorInvite(values.person_id, values.email)
        render()
        const link = `${location.href.split('#')[0]}#/join/${invite.token}`
        try { await navigator.clipboard.writeText(link) } catch {}
        toast('Contributor invite created. The secure invite link has been copied when clipboard access is available.')
      } catch (error) {
        toast(error.message || 'Unable to create contributor invite.', 'danger')
      } finally {
        busy = false
      }
      return
    }

    if (form.id === 'contributor-request-form') {
      event.preventDefault()
      if (busy) return
      busy = true
      const errorBox = document.getElementById('contributor-request-error')
      try {
        const values = Object.fromEntries(new FormData(form).entries())
        values.date_unknown = form.querySelector('input[name="date_unknown"]')?.checked || false
        if (values.request_id) await updateContributorRequest(values.request_id, values)
        else await submitContributorRequest(values)
        closeModal()
        render()
        toast(values.request_id ? 'Pending request updated.' : 'Request submitted for manager approval.')
      } catch (error) {
        if (errorBox) errorBox.innerHTML = `<div class="notice danger" style="margin-top:12px">${escapeHtml(error.message || 'Unable to save request.')}</div>`
      } finally {
        busy = false
      }
      return
    }

    if (form.id === 'add-person-form') {
      event.preventDefault()
      if (busy) return
      busy = true
      try {
        const values = new FormData(form)
        const person = await createPerson(
          values.get('name') || '',
          values.get('email') || '',
          values.get('starting_currency') || state.workspace.default_currency,
          values.get('starting_balance'),
        )
        go(`/person/${person.id}`)
      } catch (error) {
        toast(error.message, 'danger')
      } finally {
        busy = false
      }
      return
    }

    if (form.id === 'transaction-form') {
      event.preventDefault()
      if (busy) return
      busy = true
      const errorBox = document.getElementById('transaction-error')
      try {
        const entries = transactionEntriesFromForm(form)
        await addTransactions(entries)
        closeModal()
        render()
        toast(`${entries.length} ${entries[0]?.type === 'income' ? 'income' : 'expense'} record${entries.length === 1 ? '' : 's'} saved.`)
      } catch (error) {
        if (errorBox) errorBox.innerHTML = `<div class="notice danger" style="margin-top:12px">${escapeHtml(error.message)}</div>`
      } finally {
        busy = false
      }
      return
    }

    if (form.id === 'person-email-form') {
      event.preventDefault()
      if (busy) return
      busy = true
      const errorBox = document.getElementById('person-email-error')
      try {
        const values = Object.fromEntries(new FormData(form).entries())
        await updatePersonEmail(values.person_id, values.email)
        closeModal()
        render()
        toast('Notification email updated.')
      } catch (error) {
        if (errorBox) errorBox.innerHTML = `<div class="notice danger" style="margin-top:12px">${escapeHtml(error.message)}</div>`
      } finally {
        busy = false
      }
      return
    }
    if (form.id === 'edit-transaction-form') {
      event.preventDefault()
      if (busy) return
      busy = true
      const errorBox = document.getElementById('edit-transaction-error')
      try {
        const values = Object.fromEntries(new FormData(form).entries())
        values.date_unknown = form.querySelector('input[name="date_unknown"]')?.checked || false
        await updateTransaction(values.transaction_id, values)
        closeModal()
        render()
        toast('Record updated and notification queued.')
      } catch (error) {
        if (errorBox) errorBox.innerHTML = `<div class="notice danger" style="margin-top:12px">${escapeHtml(error.message)}</div>`
      } finally {
        busy = false
      }
      return
    }
    if (form.id === 'starting-balance-form') {
      event.preventDefault()
      if (busy) return
      busy = true
      const errorBox = document.getElementById('starting-balance-error')
      try {
        const values = Object.fromEntries(new FormData(form).entries())
        await updateStartingBalance(values.person_id, values.currency, values.amount)
        ui.personCurrency[values.person_id] = String(values.currency).trim().toUpperCase()
        closeModal()
        render()
        toast('Starting balance updated.')
      } catch (error) {
        if (errorBox) errorBox.innerHTML = `<div class="notice danger" style="margin-top:12px">${escapeHtml(error.message)}</div>`
      } finally {
        busy = false
      }
      return
    }

    if (form.id === 'budget-form') {
      event.preventDefault()
      if (busy) return
      busy = true
      const errorBox = document.getElementById('budget-error')
      try {
        const values = Object.fromEntries(new FormData(form).entries())
        await saveBudget(values.person_id, values.currency, values.month, values.pv_limit)
        closeModal()
        render()
        toast('PV monthly limit updated.')
      } catch (error) {
        if (errorBox) errorBox.innerHTML = `<div class="notice danger" style="margin-top:12px">${escapeHtml(error.message)}</div>`
      } finally {
        busy = false
      }
      return
    }

    if (form.id === 'goal-form') {
      event.preventDefault()
      if (busy) return
      busy = true
      const errorBox = document.getElementById('goal-error')
      try {
        const values = Object.fromEntries(new FormData(form).entries())
        await saveGoal(values)
        closeModal()
        render()
        toast('Savings goal added.')
      } catch (error) {
        if (errorBox) errorBox.innerHTML = `<div class="notice danger" style="margin-top:12px">${escapeHtml(error.message)}</div>`
      } finally {
        busy = false
      }
      return
    }

    if (form.id === 'settings-form') {
      event.preventDefault()
      if (busy) return
      busy = true
      try {
        const values = Object.fromEntries(new FormData(form).entries())
        await updateWorkspace(values)
        render()
        toast('Settings saved.')
      } catch (error) {
        toast(error.message, 'danger')
      } finally {
        busy = false
      }
      return
    }

    if (form.id === 'forgot-password-form') {
      event.preventDefault()
      if (!CLOUD_ENABLED || busy) return
      busy = true
      const values = Object.fromEntries(new FormData(form).entries())
      try {
        const redirectTo = CONFIG.appUrl || `${location.origin}${location.pathname}`
        const result = await authDb.auth.resetPasswordForEmail(values.email, { redirectTo })
        if (result.error) throw result.error
        renderForgotPassword('Reset link sent. Check your inbox and spam folder.', values.email)
      } catch (error) {
        renderForgotPassword(error.message || 'Unable to send the reset email.', values.email)
      } finally {
        busy = false
      }
      return
    }

    if (form.id === 'reset-password-form') {
      event.preventDefault()
      if (!CLOUD_ENABLED || busy) return
      busy = true
      const values = Object.fromEntries(new FormData(form).entries())
      if (values.password !== values.confirm_password) {
        renderPasswordReset('The passwords do not match.')
        busy = false
        return
      }
      try {
        const token = new URLSearchParams(location.search).get('token')
        if (!token) throw new Error('This password reset link is missing or has expired.')
        const betterAuth = authDb.auth.getBetterAuthInstance?.()
        if (!betterAuth?.resetPassword) throw new Error('Password recovery is unavailable.')
        const result = await betterAuth.resetPassword({
          newPassword: values.password,
          token,
        })
        if (result?.error) throw new Error(result.error.message || 'Unable to reset the password.')
        passwordRecoveryMode = false
        history.replaceState({}, '', location.pathname + (location.hash || ''))
        renderAuth('Password updated successfully. Sign in with your new password.')
      } catch (error) {
        renderPasswordReset(error.message || 'Unable to update the password.')
      } finally {
        busy = false
      }
      return
    }

    if (form.id === 'auth-form') {
      event.preventDefault()
      if (!CLOUD_ENABLED || busy) return
      busy = true
      const values = Object.fromEntries(new FormData(form).entries())
      const mode = form.dataset.mode || 'signin'
      try {
        const result =
          mode === 'signin'
            ? await authDb.auth.signInWithPassword({ email: values.email, password: values.password })
            : await authDb.auth.signUp({
                email: values.email,
                password: values.password,
                options: {
                  emailRedirectTo: CONFIG.appUrl || `${location.origin}${location.pathname}`,
                  data: { displayName: String(values.email || '').split('@')[0] || 'My Fund user' },
                },
              })
        if (result.error) throw result.error
        if (mode === 'signup' && !result.data.session) {
          renderAuth('Account created. You can sign in with your Neon Auth account.')
        }
      } catch (error) {
        renderAuth(error.message, mode, values.email)
      } finally {
        busy = false
      }
    }
  }

  async function handleClick(event) {
    const target = event.target.closest('[data-action]')
    if (!target) return
    const action = target.dataset.action

    if (action === 'toggle-password') {
      const input = document.getElementById(target.dataset.target)
      if (!input) return
      const reveal = input.type === 'password'
      input.type = reveal ? 'text' : 'password'
      target.textContent = reveal ? 'Hide' : 'Show'
      target.setAttribute('aria-pressed', String(reveal))
      return
    }
    if (action === 'forgot-password') {
      const email = document.querySelector('#auth-form input[name="email"]')?.value || ''
      renderForgotPassword('', email)
      return
    }
    if (action === 'back-to-signin') {
      renderAuth()
      return
    }
    if (action === 'accept-invite') {
      if (busy) return
      busy = true
      try {
        await acceptContributorInvite(target.dataset.token)
        go('/contributor')
        render()
        toast('Contributor access activated.')
      } catch (error) {
        toast(error.message || 'Unable to accept this invite.', 'danger')
      } finally {
        busy = false
      }
      return
    }
    if (action === 'toggle-contributor') {
      if (busy) return
      busy = true
      try {
        await setContributorStatus(target.dataset.memberId, target.dataset.status)
        render()
        toast(target.dataset.status === 'active' ? 'Contributor access enabled.' : 'Contributor access disabled.')
      } catch (error) {
        toast(error.message || 'Unable to update contributor access.', 'danger')
      } finally {
        busy = false
      }
      return
    }
    if (action === 'revoke-invite') {
      if (!confirm('Revoke this contributor invite?')) return
      try {
        await revokeContributorInvite(target.dataset.inviteId)
        render()
        toast('Invite revoked.')
      } catch (error) {
        toast(error.message || 'Unable to revoke invite.', 'danger')
      }
      return
    }
    if (action === 'viewer-open-request') {
      openViewerRequestModal({ type: target.dataset.type || 'income' })
      return
    }
    if (action === 'viewer-edit-request') {
      openViewerRequestModal({ requestId: target.dataset.requestId })
      return
    }
    if (action === 'viewer-delete-request') {
      if (!confirm('Delete this pending request?')) return
      try {
        await deleteViewerRequest(target.dataset.requestId)
        await loadViewer(viewerToken)
        toast('Pending request deleted.')
      } catch (error) {
        toast(error.message || 'Unable to delete request.', 'danger')
      }
      return
    }
    if (action === 'viewer-toggle-request-unknown-date') {
      const dateInput = target.closest('form')?.querySelector('input[name="date"]')
      if (dateInput) {
        dateInput.disabled = target.checked
        if (target.checked) dateInput.value = ''
        else if (!dateInput.value) dateInput.value = today()
      }
      return
    }    if (action === 'open-request') {
      openContributorRequestModal({ type: target.dataset.type || 'income' })
      return
    }
    if (action === 'request-update') {
      openContributorRequestModal({ transactionId: target.dataset.transactionId })
      return
    }
    if (action === 'edit-request') {
      openContributorRequestModal({ requestId: target.dataset.requestId })
      return
    }
    if (action === 'delete-request') {
      if (!confirm('Delete this pending request?')) return
      try {
        await deleteContributorRequest(target.dataset.requestId)
        render()
        toast('Pending request deleted.')
      } catch (error) {
        toast(error.message || 'Unable to delete request.', 'danger')
      }
      return
    }
    if (action === 'approve-request') {
      const note = prompt('Optional note for the person:', '')
      if (note === null) return
      if (!confirm('Approve this request and write it to the real ledger?')) return
      try {
        await reviewRecordRequest(target.dataset.requestId, 'approve', note)
        render()
        toast('Request approved and recorded.')
      } catch (error) {
        toast(error.message || 'Unable to approve request.', 'danger')
      }
      return
    }
    if (action === 'reject-request') {
      const note = prompt('Reason for rejection (optional):', '')
      if (note === null) return
      try {
        await reviewRecordRequest(target.dataset.requestId, 'reject', note)
        render()
        toast('Request rejected. The ledger was not changed.')
      } catch (error) {
        toast(error.message || 'Unable to reject request.', 'danger')
      }
      return
    }
    if (action === 'refresh-approvals') {
      approvalLoading = true
      approvalError = ''
      try {
        await refreshApprovalCenter()
        render()
        toast('Approval queue refreshed.')
      } catch (error) {
        approvalError = error.message || 'Unable to refresh approvals.'
        render()
      } finally {
        approvalLoading = false
      }
      return
    }
    if (action === 'read-notification') {
      try {
        await markNotificationRead(target.dataset.notificationId)
        render()
      } catch (error) {
        toast(error.message || 'Unable to update notification.', 'danger')
      }
      return
    }
    if (action === 'toggle-request-unknown-date') {
      const dateInput = target.closest('form')?.querySelector('input[name="date"]')
      if (dateInput) {
        dateInput.disabled = target.checked
        if (target.checked) dateInput.value = ''
        else if (!dateInput.value) dateInput.value = today()
      }
      return
    }
    if (action === 'refresh-admin') {
      if (!isPlatformAdmin()) return
      adminLoading = true
      adminError = ''
      try {
        await refreshAdmin()
        render()
        toast('Admin records refreshed.')
      } catch (error) {
        adminError = error.message || 'Unable to refresh platform records.'
        render()
      } finally {
        adminLoading = false
      }
      return
    }

    if (action === 'add-transaction-row') {
      const container = document.getElementById('bulk-transaction-rows')
      if (!container) return
      const index = container.querySelectorAll('.bulk-entry-row').length
      container.insertAdjacentHTML(
        'beforeend',
        transactionRowTemplate(target.dataset.type || 'income', target.dataset.currency || state.workspace.default_currency, index),
      )
      renumberTransactionRows()
      container.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      return
    }
    if (action === 'remove-transaction-row') {
      const row = target.closest('.bulk-entry-row')
      const container = document.getElementById('bulk-transaction-rows')
      if (!row || !container || container.querySelectorAll('.bulk-entry-row').length <= 1) return
      row.remove()
      renumberTransactionRows()
      return
    }
    if (action === 'toggle-unknown-date') {
      const row = target.closest('.bulk-entry-row')
      const dateInput = row?.querySelector('[data-field="date"]')
      if (dateInput) {
        dateInput.disabled = target.checked
        if (target.checked) dateInput.value = ''
        else if (!dateInput.value) dateInput.value = today()
      }
      return
    }
    if (action === 'edit-person-email') {
      openPersonEmailModal(target.dataset.personId)
      return
    }
    if (action === 'edit-transaction') {
      openEditTransactionModal(target.dataset.transactionId)
      return
    }
    if (action === 'toggle-edit-transaction-unknown-date') {
      const dateInput = target.closest('form')?.querySelector('input[name="date"]')
      if (dateInput) {
        dateInput.disabled = target.checked
        if (target.checked) dateInput.value = ''
        else if (!dateInput.value) dateInput.value = today()
      }
      return
    }
    if (action === 'edit-starting-balance') {
      openStartingBalanceModal(target.dataset.personId, target.dataset.currency)
      return
    }

    if (action === 'open-mobile') {
      ui.mobileOpen = true
      render()
      return
    }
    if (action === 'close-mobile') {
      ui.mobileOpen = false
      render()
      return
    }
    if (action === 'go-people') {
      go('/people')
      return
    }
    if (action === 'open-person') {
      go(`/person/${target.dataset.personId}`)
      return
    }
    if (action === 'open-income') {
      openTransactionModal(target.dataset.personId, 'income')
      return
    }
    if (action === 'open-expense') {
      openTransactionModal(target.dataset.personId, 'expense')
      return
    }
    if (action === 'edit-budget') {
      openBudgetModal(
        target.dataset.personId,
        target.dataset.currency,
        target.dataset.month,
        target.dataset.current,
      )
      return
    }
    if (action === 'open-goal') {
      openGoalModal(target.dataset.personId, target.dataset.currency)
      return
    }
    if (action === 'close-modal') {
      closeModal()
      return
    }
    if (action === 'modal-backdrop' && event.target === target) {
      closeModal()
      return
    }
    if (action === 'copy-link') {
      try {
        await navigator.clipboard.writeText(target.dataset.link)
        toast('Link copied.')
      } catch {
        const input = target.parentElement?.querySelector('input')
        input?.select()
        document.execCommand('copy')
        toast('Link copied.')
      }
      return
    }
    if (action === 'regenerate-link') {
      if (!confirm('Replace this viewer link? The old link will stop working.')) return
      try {
        await regenerateToken(target.dataset.personId)
        render()
        toast('Viewer link replaced.')
      } catch (error) {
        toast(error.message, 'danger')
      }
      return
    }
    if (action === 'delete-person') {
      const person = personById(target.dataset.personId)
      if (!person || !confirm(`Delete ${person.name} and all of their records?`)) return
      try {
        await removePerson(person.id)
        go('/people')
        toast('Person deleted.')
      } catch (error) {
        toast(error.message, 'danger')
      }
      return
    }
    if (action === 'delete-transaction') {
      if (!confirm('Delete this record? Balances will recalculate immediately.')) return
      try {
        await deleteTransaction(target.dataset.transactionId)
        render()
        toast('Record deleted.')
      } catch (error) {
        toast(error.message, 'danger')
      }
      return
    }
    if (action === 'delete-goal') {
      if (!confirm('Delete this goal? This does not affect transactions.')) return
      try {
        await deleteGoal(target.dataset.goalId)
        render()
        toast('Goal deleted.')
      } catch (error) {
        toast(error.message, 'danger')
      }
      return
    }
    if (action === 'report-person') {
      ui.reportPerson = target.dataset.personId
      go('/reports')
      return
    }
    if (action === 'export-csv') {
      exportCsv()
      return
    }
    if (action === 'export-xlsx') {
      await exportXlsx()
      return
    }
    if (action === 'export-pdf') {
      await exportPdf()
      return
    }
    if (action === 'backup-json') {
      exportBackup()
      return
    }
    if (action === 'refresh') {
      try {
        if (CLOUD_ENABLED) {
          await refreshCloud()
          if (isPlatformAdmin() && getRoute().path === '/admin') await refreshAdmin()
        } else state = loadLocal()
        render()
        toast('Records refreshed.')
      } catch (error) {
        toast(error.message, 'danger')
      }
      return
    }
    if (action === 'signout') {
      adminState = null
      approvalState = { requests: [], notifications: [], members: [], invites: [] }
      contributorState = null
      accessContext = null
      await authDb.auth.signOut()
      return
    }
    if (action === 'auth-mode') {
      const email = document.querySelector('#auth-form input[name="email"]')?.value || ''
      renderAuth('', target.dataset.mode, email)
      return
    }
  }

  function handleChange(event) {
    const target = event.target
    if (target.id === 'restore-file' && target.files?.[0]) {
      restoreBackup(target.files[0]).catch((error) => toast(error.message, 'danger'))
      return
    }
    const key = target.dataset.ui
    if (!key) return
    if (key === 'personCurrency') {
      ui.personCurrency[target.dataset.personId] = target.value
    } else if (key === 'personMonth') {
      ui.personMonth[target.dataset.personId] = target.value
    } else if (key in ui) {
      ui[key] = target.value
    }
    render()
  }

  async function init() {
    await initializeCloudClients()

    document.addEventListener('submit', handleSubmit)
    document.addEventListener('click', handleClick)
    document.addEventListener('change', handleChange)
    window.addEventListener('hashchange', render)

    const route = getRoute()
    if (route.path.startsWith('/view/')) {
      await loadViewer(route.segments[1])
      return
    }

    if (!CLOUD_ENABLED) {
      if (CLOUD_UNAVAILABLE) {
        render()
        return
      }
      state = loadLocal()
      if (!location.hash) go('/dashboard')
      render()
      return
    }

    const sessionResult = await authDb.auth.getSession()
    session = sessionResult.data.session
    authDb.auth.onAuthStateChange(async (event, nextSession) => {
      session = nextSession
      if (event === 'PASSWORD_RECOVERY') {
        passwordRecoveryMode = true
        renderPasswordReset()
        return
      }
      if (session) {
        try {
          await refreshCloud()
          if (!location.hash || getRoute().path === '/') go('/dashboard')
          if (!passwordRecoveryMode) render()
        } catch {
          if (!passwordRecoveryMode) render()
        }
      } else {
        state = structuredClone(DEFAULT_DATA)
        renderAuth()
      }
    })

    if (session) {
      try {
        await refreshCloud()
        if (!location.hash) go('/dashboard')
        render()
      } catch {
        render()
      }
    } else {
      renderAuth()
    }
  }

  init()
})()
