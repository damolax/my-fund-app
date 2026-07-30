(() => {
  'use strict'

  const STORAGE_KEY = 'fhg-funds-standalone-v1'
  const CONFIG = window.FHG_CONFIG || {}
  const CLOUD_ENABLED = Boolean(CONFIG.supabaseUrl && CONFIG.supabasePublishableKey && window.supabase)
  const db = CLOUD_ENABLED ? window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabasePublishableKey) : null

  const DEFAULT_DATA = {
    workspace: {
      id: 'local-workspace',
      name: 'FHG Funds',
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
    if (!value) return '—'
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

  function normalizeCloudData(payload) {
    return {
      workspace: payload.workspace,
      people: payload.people || [],
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
    const normalized = String(date).slice(0, 10)
    if (start && normalized < start) return false
    if (end && normalized > end) return false
    return true
  }

  function uniqueCurrencies(personId = null, data = state) {
    const set = new Set([data.workspace?.default_currency || 'NGN'])
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
        (!throughDate || String(item.date).slice(0, 10) <= throughDate),
    )
    const income = records
      .filter((item) => item.type === 'income')
      .reduce((sum, item) => sum + num(item.amount), 0)
    const expenses = records
      .filter((item) => item.type === 'expense')
      .reduce((sum, item) => sum + num(item.amount), 0)
    return { income: round(income), expenses: round(expenses), balance: round(income - expenses) }
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
    const nav = [
      ['dashboard', '▦', 'Dashboard'],
      ['people', '◉', 'People'],
      ['transactions', '≡', 'Transactions'],
      ['reports', '⇩', 'Reports'],
      ['settings', '⚙', 'Settings'],
    ]
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
            <div class="brand-mark">F</div>
            <div><strong>${escapeHtml(state.workspace.name || 'FHG Funds')}</strong><span>Held funds tracker</span></div>
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
            <div class="topbar-title"><span>FHG money management</span></div>
            <button class="icon-button" data-action="refresh" title="Refresh">↻</button>
          </header>
          ${
            !CLOUD_ENABLED
              ? '<div class="local-banner"><span>◈</span><span>This app works immediately in local mode. Add Supabase keys in config.js for accounts, cross-device data and live secure links.</span></div>'
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
      let workspaceResult = await db
        .from('workspaces')
        .select('*')
        .eq('owner_id', session.user.id)
        .maybeSingle()
      if (workspaceResult.error) throw workspaceResult.error
      let workspace = workspaceResult.data
      if (!workspace) {
        const created = await db
          .from('workspaces')
          .insert({
            owner_id: session.user.id,
            name: 'FHG Funds',
            default_currency: 'NGN',
            upkeep_percentage: 20,
          })
          .select('*')
          .single()
        if (created.error) throw created.error
        workspace = created.data
      }

      const [peopleResult, transactionResult, budgetResult, goalResult] = await Promise.all([
        db.from('people').select('*').eq('workspace_id', workspace.id).order('created_at'),
        db
          .from('transactions')
          .select('*')
          .eq('workspace_id', workspace.id)
          .order('date', { ascending: false })
          .order('created_at', { ascending: false }),
        db.from('monthly_budgets').select('*').eq('workspace_id', workspace.id),
        db.from('goals').select('*').eq('workspace_id', workspace.id),
      ])
      for (const result of [peopleResult, transactionResult, budgetResult, goalResult]) {
        if (result.error) throw result.error
      }
      state = normalizeCloudData({
        workspace,
        people: peopleResult.data,
        transactions: transactionResult.data,
        budgets: budgetResult.data,
        goals: goalResult.data,
      })
      subscribeRealtime()
    } catch (error) {
      toast(error.message || 'Unable to load cloud records.', 'danger')
      throw error
    }
  }

  function subscribeRealtime() {
    if (!CLOUD_ENABLED || !state.workspace?.id || state.workspace.id === 'local-workspace') return
    if (realtimeChannel) db.removeChannel(realtimeChannel)
    const reload = async () => {
      await refreshCloud()
      const route = getRoute()
      if (!route.path.startsWith('/view/')) render()
    }
    realtimeChannel = db
      .channel(`fhg-${state.workspace.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'people', filter: `workspace_id=eq.${state.workspace.id}` },
        reload,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'transactions',
          filter: `workspace_id=eq.${state.workspace.id}`,
        },
        reload,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'monthly_budgets',
          filter: `workspace_id=eq.${state.workspace.id}`,
        },
        reload,
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'goals', filter: `workspace_id=eq.${state.workspace.id}` },
        reload,
      )
      .subscribe()
  }

  async function mutateLocal(mutator) {
    mutator(state)
    saveLocal()
  }

  async function createPerson(name) {
    const clean = name.trim()
    if (!clean) throw new Error('Enter the person’s name.')
    if (!CLOUD_ENABLED) {
      const person = {
        id: id(),
        workspace_id: state.workspace.id,
        name: clean,
        share_token: id(),
        created_at: new Date().toISOString(),
      }
      await mutateLocal((draft) => draft.people.push(person))
      return person
    }
    const result = await db
      .from('people')
      .insert({ workspace_id: state.workspace.id, name: clean })
      .select('*')
      .single()
    if (result.error) throw result.error
    await refreshCloud()
    return result.data
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
    const result = await db.from('people').delete().eq('id', personId)
    if (result.error) throw result.error
    await refreshCloud()
  }

  async function addTransaction(values) {
    const payload = {
      id: id(),
      workspace_id: state.workspace.id,
      person_id: values.person_id,
      type: values.type,
      amount: round(values.amount),
      currency: String(values.currency || state.workspace.default_currency).trim().toUpperCase(),
      date: values.date,
      description: values.description.trim(),
      category: values.type === 'expense' ? values.category : null,
      created_at: new Date().toISOString(),
    }
    if (!payload.amount || payload.amount <= 0) throw new Error('Enter an amount greater than zero.')
    if (!payload.description) throw new Error('Enter what the income or expense is for.')
    validateExpense(payload)

    if (!CLOUD_ENABLED) {
      await mutateLocal((draft) => draft.transactions.unshift(payload))
      return payload
    }
    const result = await db.from('transactions').insert({
      workspace_id: payload.workspace_id,
      person_id: payload.person_id,
      type: payload.type,
      amount: payload.amount,
      currency: payload.currency,
      date: payload.date,
      description: payload.description,
      category: payload.category,
    })
    if (result.error) throw result.error
    await refreshCloud()
    return result.data
  }

  function validateExpense(payload) {
    if (payload.type !== 'expense') return
    const month = String(payload.date).slice(0, 7)
    if (payload.category === 'PV') {
      const limit = num(getBudget(payload.person_id, payload.currency, month)?.pv_limit)
      const spent = monthlySpend(payload.person_id, payload.currency, month, 'PV')
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
      const spent = monthlySpend(payload.person_id, payload.currency, month, 'Upkeep')
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

  async function deleteTransaction(transactionId) {
    if (!CLOUD_ENABLED) {
      await mutateLocal((draft) => {
        draft.transactions = draft.transactions.filter((item) => item.id !== transactionId)
      })
      return
    }
    const result = await db.from('transactions').delete().eq('id', transactionId)
    if (result.error) throw result.error
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
    const result = await db.from('monthly_budgets').upsert(
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
    const result = await db.from('goals').insert({
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
    const result = await db.from('goals').delete().eq('id', goalId)
    if (result.error) throw result.error
    await refreshCloud()
  }

  async function updateWorkspace(values) {
    const changes = {
      name: values.name.trim() || 'FHG Funds',
      default_currency: String(values.default_currency || 'NGN').trim().toUpperCase(),
      upkeep_percentage: Math.max(0, Math.min(100, round(values.upkeep_percentage))),
    }
    if (!CLOUD_ENABLED) {
      await mutateLocal((draft) => {
        draft.workspace = { ...draft.workspace, ...changes }
      })
      return
    }
    const result = await db.from('workspaces').update(changes).eq('id', state.workspace.id)
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
      .from('people')
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

    const recent = [...state.transactions]
      .sort((a, b) => `${b.date}${b.created_at || ''}`.localeCompare(`${a.date}${a.created_at || ''}`))
      .slice(0, 8)

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
      ${pageHeader('People', 'People whose funds you hold', 'Create a person using only their name, then enter all previous or new records from their page.')}
      <section class="people-layout">
        <form class="panel add-person-card" id="add-person-form">
          <div class="section-icon">＋</div>
          <h2>Add a person</h2>
          <p>No email, phone number or opening balance is required.</p>
          <label class="field"><span>Name</span><input name="name" placeholder="Person's full name" required></label>
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
    const records = state.transactions
      .filter((item) => item.person_id === person.id && item.currency === currency)
      .sort((a, b) => `${b.date}${b.created_at || ''}`.localeCompare(`${a.date}${a.created_at || ''}`))
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
        `<div class="button-row"><button class="secondary-button" data-action="open-expense" data-person-id="${person.id}">↗ Add expense</button><button class="primary-button" data-action="open-income" data-person-id="${person.id}">↘ Add income</button></div>`,
      )}
      <div class="toolbar-row">
        <label class="field inline-field"><span>Currency</span><select data-ui="personCurrency" data-person-id="${person.id}">${currencySelect}</select></label>
        <label class="field inline-field"><span>Budget month</span><input type="month" data-ui="personMonth" data-person-id="${person.id}" value="${month}"></label>
      </div>
      <section class="summary-card-grid">
        ${summaryCard('Current balance', money(position.balance, currency), '▣', position.balance < 0 ? `Borrowed funds in use: ${money(Math.abs(position.balance), currency)}` : 'Income minus actual expenses', position.balance < 0)}
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
            ${panelHeading('Secure read-only link', 'The person sees only their own records')}
            <div class="share-box"><span>🔗</span><div><strong>Viewer link</strong><span>${CLOUD_ENABLED ? 'Updates automatically from the cloud.' : 'Local mode: it works only where this browser data exists.'}</span></div></div>
            <div class="copy-row"><input readonly value="${escapeHtml(viewerLink)}"><button class="secondary-button" data-action="copy-link" data-link="${escapeHtml(viewerLink)}">⧉ Copy</button></div>
            <button class="text-button" data-action="regenerate-link" data-person-id="${person.id}">↻ Replace viewer link</button>
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
            ${allowDelete ? `<button class="icon-button mini delete-record" data-action="delete-transaction" data-transaction-id="${item.id}" title="Delete record">⌫</button>` : ''}
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
    const filtered = state.transactions
      .filter((item) => ui.transactionPerson === 'all' || item.person_id === ui.transactionPerson)
      .filter((item) => ui.transactionType === 'all' || item.type === ui.transactionType)
      .filter((item) => ui.transactionCurrency === 'all' || item.currency === ui.transactionCurrency)
      .filter((item) => inRange(item.date, range.start, range.end))
      .sort((a, b) => `${b.date}${b.created_at || ''}`.localeCompare(`${a.date}${a.created_at || ''}`))

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
    const transactions = state.transactions
      .filter((item) => people.some((person) => person.id === item.person_id))
      .filter((item) => currency === 'all' || item.currency === currency)
      .filter((item) => inRange(item.date, start, end))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .map((item) => ({
        ...item,
        person_name: personById(item.person_id)?.name || 'Unknown',
      }))

    const summary = []
    for (const person of people) {
      for (const curr of currencies) {
        const before = state.transactions.filter(
          (item) =>
            item.person_id === person.id &&
            item.currency === curr &&
            start &&
            String(item.date).slice(0, 10) < start,
        )
        const period = state.transactions.filter(
          (item) =>
            item.person_id === person.id &&
            item.currency === curr &&
            inRange(item.date, start, end),
        )
        const opening = start
          ? before.reduce(
              (sum, item) => sum + (item.type === 'income' ? num(item.amount) : -num(item.amount)),
              0,
            )
          : 0
        const income = period
          .filter((item) => item.type === 'income')
          .reduce((sum, item) => sum + num(item.amount), 0)
        const expenses = period
          .filter((item) => item.type === 'expense')
          .reduce((sum, item) => sum + num(item.amount), 0)
        if (opening || income || expenses) {
          summary.push({
            person_id: person.id,
            person_name: person.name,
            currency: curr,
            opening: round(opening),
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
            <button class="primary-button" data-action="export-pdf" ${rows.transactions.length ? '' : 'disabled'}>⇩ PDF</button>
            <button class="secondary-button" data-action="export-xlsx" ${rows.transactions.length ? '' : 'disabled'}>▦ Excel</button>
            <button class="secondary-button" data-action="export-csv" ${rows.transactions.length ? '' : 'disabled'}>≡ CSV</button>
          </div>
        </div>
        <div class="panel report-preview">
          ${panelHeading('Report preview', `${rows.transactions.length} transactions`)}
          <div class="report-summary-grid">${preview}</div>
        </div>
      </section>`
    return shell(content, 'reports')
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
              ? '<div class="security-note"><span>◈</span><div><strong>Cloud mode enabled</strong><span>Owner data is protected using Supabase authentication and row-level security.</span></div></div>'
              : `<button class="secondary-button full-width" data-action="backup-json">⇩ Download JSON backup</button><label class="secondary-button full-width upload-button">↗ Restore JSON backup<input id="restore-file" type="file" accept="application/json"></label>`
          }
        </div>
      </section>`
    return shell(content, 'settings')
  }

  function renderAuth(message = '') {
    document.getElementById('app').innerHTML = `
      <div class="auth-page">
        <div class="auth-brand">
          <div class="brand-mark large-brand">F</div>
          <h1>FHG Funds</h1>
          <p>Track income, actual expenses, monthly limits, borrowed balances and everything you currently hold.</p>
        </div>
        <form class="auth-card" id="auth-form" data-mode="signin">
          <div class="auth-tabs">
            <button type="button" class="active" data-action="auth-mode" data-mode="signin">Sign in</button>
            <button type="button" data-action="auth-mode" data-mode="signup">Create account</button>
          </div>
          <label class="field"><span>Email</span><input name="email" type="email" required></label>
          <label class="field"><span>Password</span><input name="password" type="password" minlength="6" required></label>
          ${message ? `<div class="info-box">${escapeHtml(message)}</div>` : ''}
          <button class="primary-button full-width">Sign in</button>
        </form>
      </div>`
  }

  async function loadViewer(token) {
    clearInterval(viewerTimer)
    document.getElementById('app').innerHTML = '<div class="full-page-loading"><div class="loading-mark">F</div><span>Opening the read-only dashboard…</span></div>'
    try {
      let payload
      if (CLOUD_ENABLED) {
        const result = await db.rpc('get_person_public_view', { p_token: token })
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
        }
      }
      renderViewer(payload)
      viewerTimer = setInterval(async () => {
        if (!getRoute().path.startsWith('/view/')) return clearInterval(viewerTimer)
        try {
          let refreshed
          if (CLOUD_ENABLED) {
            const result = await db.rpc('get_person_public_view', { p_token: token })
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
          if (refreshed) renderViewer(refreshed)
        } catch {
          // Keep the last successful view visible.
        }
      }, 5000)
    } catch (error) {
      document.getElementById('app').innerHTML = `
        <div class="viewer-error"><div class="brand-mark">F</div><h1>Viewer link unavailable</h1><p>${escapeHtml(error.message)}</p></div>`
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

  function renderViewer(payload) {
    const data = {
      workspace: payload.workspace,
      people: [payload.person],
      transactions: payload.transactions,
      budgets: payload.budgets,
      goals: payload.goals,
    }
    const currencies = uniqueCurrencies(payload.person.id, data)
    const sections = currencies
      .map((currency) => {
        const position = personPosition(payload.person.id, currency, '', data)
        const month = currentMonth()
        const pvLimit = num(getBudget(payload.person.id, currency, month, data)?.pv_limit)
        const pvSpent = monthlySpend(payload.person.id, currency, month, 'PV', data)
        const upkeepLimit = round(
          monthlyIncome(payload.person.id, currency, month, data) *
            (num(payload.workspace.upkeep_percentage) / 100),
        )
        const upkeepSpent = monthlySpend(payload.person.id, currency, month, 'Upkeep', data)
        const records = payload.transactions
          .filter((item) => item.currency === currency)
          .sort((a, b) => String(b.date).localeCompare(String(a.date)))
          .slice(0, 25)
        const goals = payload.goals.filter((goal) => goal.currency === currency)
        return `
          <section class="viewer-currency-section">
            <div class="viewer-currency-title">
              <span class="currency-badge">${currency}</span>
              <strong class="${position.balance < 0 ? 'negative-text' : ''}">${money(position.balance, currency)}</strong>
              <span>${position.balance < 0 ? `Borrowed funds in use: ${money(Math.abs(position.balance), currency)}` : 'Current balance'}</span>
            </div>
            <div class="summary-card-grid viewer-summary">
              ${summaryCard('Income', money(position.income, currency), '↘')}
              ${summaryCard('Expenses', money(position.expenses, currency), '↗')}
              ${summaryCard('Balance', money(position.balance, currency), '▣', position.balance < 0 ? 'This amount is currently borrowed.' : '', position.balance < 0)}
            </div>
            <div class="budget-grid viewer-budgets">
              ${budgetCard('PV limit this month', 'PV', pvLimit, pvSpent, currency, payload.person.id, month, false, 'Only actual PV expenses reduce the balance.')}
              ${budgetCard('Upkeep limit this month', 'U', upkeepLimit, upkeepSpent, currency, payload.person.id, month, false, `${payload.workspace.upkeep_percentage}% of this month’s recorded income.`)}
              ${viewerGoalSummary(goals, position.balance, currency)}
            </div>
            <div class="panel">
              ${panelHeading('Recent records', `${records.length} shown`)}
              ${transactionListForViewer(records, payload.person)}
            </div>
          </section>`
      })
      .join('')

    document.getElementById('app').innerHTML = `
      <div class="viewer-page">
        <header class="viewer-header">
          <div class="brand-row viewer-brand"><div class="brand-mark">F</div><div><strong>${escapeHtml(payload.workspace.name || 'FHG Funds')}</strong><span>Read-only finance dashboard</span></div></div>
          <div><div class="live-badge"><span class="status-dot"></span>Updated automatically</div><div class="viewer-refresh">Checks every 5 seconds</div></div>
        </header>
        <main class="viewer-main">
          ${pageHeader('Your records', payload.person.name, 'Income, actual expenses, monthly limits and current balances. A minus balance means borrowed funds are currently in use.')}
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

  function render() {
    clearInterval(viewerTimer)
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
    else if (route.path === '/reports') html = renderReports()
    else if (route.path === '/settings') html = renderSettings()
    else {
      go('/dashboard')
      html = renderDashboard()
    }
    document.getElementById('app').innerHTML = html
  }

  function openModal(title, body) {
    let root = document.getElementById('modal-root')
    if (!root) {
      root = document.createElement('div')
      root.id = 'modal-root'
      document.body.appendChild(root)
    }
    root.innerHTML = `
      <div class="modal-backdrop" data-action="modal-backdrop">
        <div class="modal">
          <div class="modal-head"><h2>${escapeHtml(title)}</h2><button class="icon-button" data-action="close-modal">×</button></div>
          ${body}
        </div>
      </div>`
  }

  function closeModal() {
    const root = document.getElementById('modal-root')
    if (root) root.innerHTML = ''
  }

  function openTransactionModal(personId, type) {
    const person = personById(personId)
    if (!person) return
    const currency = ui.personCurrency[personId] || uniqueCurrencies(personId)[0] || state.workspace.default_currency
    const body = `
      <form class="modal-form" id="transaction-form">
        <input type="hidden" name="person_id" value="${person.id}">
        <input type="hidden" name="type" value="${type}">
        <div class="two-fields">
          <label class="field"><span>Amount</span><input name="amount" type="number" min="0.01" step="0.01" required autofocus></label>
          <label class="field"><span>Currency code</span><input name="currency" list="currency-codes" maxlength="3" pattern="[A-Za-z]{3}" value="${escapeHtml(currency)}" required>${currencyDatalist()}</label>
        </div>
        <label class="field"><span>Date</span><input name="date" type="date" value="${today()}" required></label>
        ${
          type === 'expense'
            ? `<label class="field"><span>Expense category</span><select name="category">${EXPENSE_CATEGORIES.map((item) => `<option value="${item}">${item}</option>`).join('')}</select></label>`
            : ''
        }
        <label class="field"><span>${type === 'income' ? 'Income source or description' : 'What is this expense for?'}</span><input name="description" placeholder="${type === 'income' ? 'e.g. Monthly earnings' : 'e.g. PV order, food or investment'}" required></label>
        <div class="notice ${type === 'expense' ? 'warn' : ''}">
          ${
            type === 'expense'
              ? 'This expense may make the person’s overall balance negative. PV and Upkeep expenses still cannot exceed their monthly category limits.'
              : 'Income increases the person’s balance and automatically reduces any existing negative balance.'
          }
        </div>
        <div id="transaction-error"></div>
        <div class="modal-actions"><button type="button" class="secondary-button" data-action="close-modal">Cancel</button><button class="primary-button">${type === 'income' ? '↘ Save income' : '↗ Save expense'}</button></div>
      </form>`
    openModal(`${type === 'income' ? 'Add income for' : 'Add expense for'} ${person.name}`, body)
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
      ...rows.transactions.map((item) => [
        String(item.date).slice(0, 10),
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
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `fhg-records-${today()}.csv`)
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
        Opening: item.opening,
        Income: item.income,
        Expenses: item.expenses,
        Closing: item.closing,
      })),
    )
    const transactionSheet = window.XLSX.utils.json_to_sheet(
      rows.transactions.map((item) => ({
        Date: String(item.date).slice(0, 10),
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
    window.XLSX.writeFile(workbook, `fhg-funds-${range.start || 'all-time'}-${range.end || today()}.xlsx`)
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
      doc.text(state.workspace.name || 'FHG Funds', 14, 16)
      doc.setFontSize(10)
      doc.text(
        `Financial records · ${range.start ? `${formatDate(range.start)} to ${formatDate(range.end)}` : 'All time'} · Generated ${formatDate(today())}`,
        14,
        23,
      )
      if (typeof doc.autoTable === 'function') {
        doc.autoTable({
          startY: 30,
          head: [['Person', 'Currency', 'Opening', 'Income', 'Expenses', 'Closing']],
          body: rows.summary.map((item) => [
            item.person_name,
            item.currency,
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
      doc.save(`fhg-funds-${range.start || 'all-time'}-${range.end || today()}.pdf`)
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
        (item) => `<tr><td>${escapeHtml(item.person_name)}</td><td>${item.currency}</td><td>${money(item.opening, item.currency)}</td><td>${money(item.income, item.currency)}</td><td>${money(item.expenses, item.currency)}</td><td>${money(item.closing, item.currency)}</td></tr>`,
      )
      .join('')
    const transactionHtml = rows.transactions
      .map(
        (item) => `<tr><td>${formatDate(item.date)}</td><td>${escapeHtml(item.person_name)}</td><td>${escapeHtml(item.type)}</td><td>${escapeHtml(item.category || '')}</td><td>${escapeHtml(item.description)}</td><td>${money(item.amount, item.currency)}</td></tr>`,
      )
      .join('')
    reportWindow.document.write(`<!doctype html><html><head><title>FHG Funds Report</title><style>body{font-family:Arial,sans-serif;padding:24px;color:#15221d}h1{margin-bottom:4px}p{color:#68756f}table{width:100%;border-collapse:collapse;margin:18px 0;font-size:11px}th,td{border:1px solid #dfe5e1;padding:7px;text-align:left}th{background:#14251f;color:white}@media print{button{display:none}}</style></head><body><h1>${escapeHtml(state.workspace.name)}</h1><p>${range.start ? `${formatDate(range.start)} to ${formatDate(range.end)}` : 'All time'}</p><button onclick="window.print()">Save as PDF / Print</button><h2>Summary</h2><table><thead><tr><th>Person</th><th>Currency</th><th>Opening</th><th>Income</th><th>Expenses</th><th>Closing</th></tr></thead><tbody>${summaryHtml}</tbody></table><h2>Transactions</h2><table><thead><tr><th>Date</th><th>Person</th><th>Type</th><th>Category</th><th>Description</th><th>Amount</th></tr></thead><tbody>${transactionHtml}</tbody></table></body></html>`)
    reportWindow.document.close()
  }

  function exportBackup() {
    downloadBlob(
      new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }),
      `fhg-funds-backup-${today()}.json`,
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

    if (form.id === 'add-person-form') {
      event.preventDefault()
      if (busy) return
      busy = true
      try {
        const values = new FormData(form)
        const person = await createPerson(values.get('name') || '')
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
        const values = Object.fromEntries(new FormData(form).entries())
        await addTransaction(values)
        closeModal()
        render()
        toast(`${values.type === 'income' ? 'Income' : 'Expense'} saved.`)
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

    if (form.id === 'auth-form') {
      event.preventDefault()
      if (!CLOUD_ENABLED || busy) return
      busy = true
      const values = Object.fromEntries(new FormData(form).entries())
      const mode = form.dataset.mode || 'signin'
      try {
        const result =
          mode === 'signin'
            ? await db.auth.signInWithPassword({ email: values.email, password: values.password })
            : await db.auth.signUp({ email: values.email, password: values.password })
        if (result.error) throw result.error
        if (mode === 'signup' && !result.data.session) {
          renderAuth('Account created. Check your email if confirmation is enabled in Supabase.')
        }
      } catch (error) {
        renderAuth(error.message)
        const nextForm = document.getElementById('auth-form')
        if (nextForm) nextForm.dataset.mode = mode
      } finally {
        busy = false
      }
    }
  }

  async function handleClick(event) {
    const target = event.target.closest('[data-action]')
    if (!target) return
    const action = target.dataset.action

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
        toast('Viewer link copied.')
      } catch {
        const input = target.parentElement?.querySelector('input')
        input?.select()
        document.execCommand('copy')
        toast('Viewer link copied.')
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
        if (CLOUD_ENABLED) await refreshCloud()
        else state = loadLocal()
        render()
        toast('Records refreshed.')
      } catch (error) {
        toast(error.message, 'danger')
      }
      return
    }
    if (action === 'signout') {
      await db.auth.signOut()
      return
    }
    if (action === 'auth-mode') {
      const form = document.getElementById('auth-form')
      if (!form) return
      form.dataset.mode = target.dataset.mode
      form.querySelectorAll('.auth-tabs button').forEach((button) =>
        button.classList.toggle('active', button.dataset.mode === target.dataset.mode),
      )
      const submit = form.querySelector('button[type="submit"], button:not([type])')
      if (submit) submit.textContent = target.dataset.mode === 'signin' ? 'Sign in' : 'Create account'
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
      state = loadLocal()
      if (!location.hash) go('/dashboard')
      render()
      return
    }

    const sessionResult = await db.auth.getSession()
    session = sessionResult.data.session
    db.auth.onAuthStateChange(async (_event, nextSession) => {
      session = nextSession
      if (session) {
        try {
          await refreshCloud()
          if (!location.hash || getRoute().path === '/') go('/dashboard')
          render()
        } catch {
          render()
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
