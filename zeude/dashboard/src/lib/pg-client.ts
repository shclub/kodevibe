/**
 * PostgreSQL client with Supabase-compatible query builder.
 * Replaces @supabase/supabase-js — same API, no PostgREST required.
 */
import { Pool, PoolConfig, types as pgTypes } from 'pg'

// Return TIMESTAMPTZ / TIMESTAMP as ISO strings (matches Supabase JS client behaviour)
pgTypes.setTypeParser(1114, (v: string) => new Date(v + 'Z').toISOString())
pgTypes.setTypeParser(1184, (v: string) => new Date(v).toISOString())

const config: PoolConfig = {
  host:     process.env.POSTGRES_HOST     || 'localhost',
  port:     parseInt(process.env.POSTGRES_PORT || '5432'),
  user:     process.env.POSTGRES_USER     || 'zeude',
  password: process.env.POSTGRES_PASSWORD || '',
  database: process.env.POSTGRES_DB       || 'zeude',
  max: 10,
  idleTimeoutMillis:       30_000,
  connectionTimeoutMillis:  5_000,
}

const pool = new Pool(config)

// ── Types ─────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export interface DBError {
  message: string
  code?:   string
  details?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface DBResult<_T = unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data:   any
  error:  DBError | null
  count?: number | null
}

// ── PostgREST OR-filter parser ────────────────────────────────────────────────

function parseOrFilter(orStr: string, table: string, params: unknown[]): string {
  const parts = orStr.split(',').map(clause => {
    const dot1 = clause.indexOf('.')
    if (dot1 === -1) return 'false'
    const col  = clause.slice(0, dot1)
    const rest = clause.slice(dot1 + 1)
    const dot2 = rest.indexOf('.')
    if (dot2 === -1) return 'false'
    const op  = rest.slice(0, dot2)
    const val = rest.slice(dot2 + 1)
    const ref = `"${table}"."${col}"`

    switch (op) {
      case 'eq':
        if (val === 'true')  return `${ref} = true`
        if (val === 'false') return `${ref} = false`
        if (val === 'null')  return `${ref} IS NULL`
        params.push(val); return `${ref} = $${params.length}`
      case 'neq':
        if (val === 'null') return `${ref} IS NOT NULL`
        params.push(val); return `${ref} != $${params.length}`
      case 'ilike':
        params.push(val); return `${ref} ILIKE $${params.length}`
      case 'cs': {
        const inner = val.replace(/^\{|\}$/g, '').replace(/^"|"$/g, '')
        params.push([inner])
        return `${ref} @> $${params.length}::text[]`
      }
      default:
        return 'false'
    }
  })
  return `(${parts.join(' OR ')})`
}

// ── Nested-select parser ──────────────────────────────────────────────────────

interface JoinSpec { alias: string; table: string; fields: string }

function parseSelectStr(s: string): { mainFields: string; joins: JoinSpec[] } {
  const joins: JoinSpec[] = []
  const re = /(\w+):(\w+)\(([^)]*)\)/g
  let clean = s, m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    joins.push({ alias: m[1], table: m[2], fields: m[3].trim() || '*' })
    clean = clean.replace(m[0], '')
  }
  return {
    mainFields: clean.split(',').map(s => s.trim()).filter(Boolean).join(', ') || '*',
    joins,
  }
}

// ── QueryBuilder ──────────────────────────────────────────────────────────────

class QueryBuilder {
  private _table       = ''
  private _op          = 'select'
  private _selectStr   = '*'
  private _countExact  = false
  private _headOnly    = false
  private _joins:       JoinSpec[] = []
  private _wheres:      string[]   = []
  private _params:      unknown[]  = []
  private _orderParts:  string[]   = []
  private _limitN:      number | null = null
  private _offsetN:     number | null = null
  private _isSingle    = false
  private _writeData:   Row | Row[] | null = null
  private _updateData:  Row | null  = null
  private _upsertConflict  = ''
  private _upsertIgnoreDup = false
  private _returnData  = false
  private _rpcFn       = ''
  private _rpcArgs:     Row = {}

  constructor(private pool: Pool, table: string) {
    this._table = table
  }

  private _clone(): QueryBuilder {
    const c = new QueryBuilder(this.pool, this._table)
    return Object.assign(c, {
      _op:             this._op,
      _selectStr:      this._selectStr,
      _countExact:     this._countExact,
      _headOnly:       this._headOnly,
      _joins:          [...this._joins],
      _wheres:         [...this._wheres],
      _params:         [...this._params],
      _orderParts:     [...this._orderParts],
      _limitN:         this._limitN,
      _offsetN:        this._offsetN,
      _isSingle:       this._isSingle,
      _writeData:      this._writeData,
      _updateData:     this._updateData,
      _upsertConflict: this._upsertConflict,
      _upsertIgnoreDup: this._upsertIgnoreDup,
      _returnData:     this._returnData,
      _rpcFn:          this._rpcFn,
      _rpcArgs:        this._rpcArgs,
    })
  }

  // ── Query-type ───────────────────────────────────────────────────────────────

  select(fields = '*', options?: { count?: string; head?: boolean }): QueryBuilder {
    const c = this._clone()
    if (c._op === 'insert' || c._op === 'update' || c._op === 'upsert') {
      c._returnData = true
      if (fields && fields !== '*') c._selectStr = fields
    } else {
      c._op = 'select'
      if (options?.count === 'exact') c._countExact = true
      if (options?.head)              c._headOnly   = true
      const parsed = parseSelectStr(fields)
      c._joins     = parsed.joins
      c._selectStr = parsed.mainFields
    }
    return c
  }

  insert(data: Row | Row[]): QueryBuilder {
    const c = this._clone(); c._op = 'insert'; c._writeData = data; return c
  }

  update(data: Row): QueryBuilder {
    const c = this._clone(); c._op = 'update'; c._updateData = data; return c
  }

  delete(): QueryBuilder {
    const c = this._clone(); c._op = 'delete'; return c
  }

  upsert(data: Row | Row[], options?: { onConflict?: string; ignoreDuplicates?: boolean; count?: string }): QueryBuilder {
    const c = this._clone()
    c._op = 'upsert'
    c._writeData = data
    c._upsertConflict  = options?.onConflict     ?? ''
    c._upsertIgnoreDup = options?.ignoreDuplicates ?? false
    if (options?.count === 'exact') c._countExact = true
    return c
  }

  // ── Filters ──────────────────────────────────────────────────────────────────

  eq(col: string, val: unknown): QueryBuilder {
    const c = this._clone()
    c._params.push(this._pgVal(val))
    c._wheres.push(`"${c._table}"."${col}" = $${c._params.length}`)
    return c
  }

  neq(col: string, val: unknown): QueryBuilder {
    const c = this._clone()
    c._params.push(this._pgVal(val))
    c._wheres.push(`"${c._table}"."${col}" != $${c._params.length}`)
    return c
  }

  gt(col: string, val: unknown): QueryBuilder {
    const c = this._clone()
    c._params.push(this._pgVal(val))
    c._wheres.push(`"${c._table}"."${col}" > $${c._params.length}`)
    return c
  }

  is(col: string, val: null | boolean): QueryBuilder {
    const c = this._clone()
    if (val === null) {
      c._wheres.push(`"${c._table}"."${col}" IS NULL`)
    } else {
      c._wheres.push(`"${c._table}"."${col}" IS ${val ? 'TRUE' : 'FALSE'}`)
    }
    return c
  }

  not(col: string, op: string, val: unknown): QueryBuilder {
    const c = this._clone()
    if (op === 'is' && val === null) {
      c._wheres.push(`"${c._table}"."${col}" IS NOT NULL`)
    } else {
      c._params.push(this._pgVal(val))
      c._wheres.push(`"${c._table}"."${col}" != $${c._params.length}`)
    }
    return c
  }

  or(orStr: string): QueryBuilder {
    const c = this._clone()
    c._wheres.push(parseOrFilter(orStr, c._table, c._params))
    return c
  }

  in(col: string, vals: unknown[]): QueryBuilder {
    const c = this._clone()
    c._params.push(vals.map(v => this._pgVal(v)))
    c._wheres.push(`"${c._table}"."${col}" = ANY($${c._params.length})`)
    return c
  }

  // ── Result modifiers ─────────────────────────────────────────────────────────

  order(col: string, options?: { ascending?: boolean }): QueryBuilder {
    const c = this._clone()
    c._orderParts.push(`"${c._table}"."${col}" ${options?.ascending === false ? 'DESC' : 'ASC'}`)
    return c
  }

  single(): QueryBuilder {
    const c = this._clone(); c._isSingle = true; return c
  }

  limit(n: number): QueryBuilder {
    const c = this._clone(); c._limitN = n; return c
  }

  range(from: number, to: number): QueryBuilder {
    const c = this._clone(); c._offsetN = from; c._limitN = to - from + 1; return c
  }

  // ── Thenable ─────────────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  then<R>(onfulfilled?: ((v: DBResult) => R) | null, onrejected?: ((r: unknown) => R) | null): Promise<R> {
    return this._execute().then(onfulfilled as never, onrejected as never)
  }

  // ── Execution ─────────────────────────────────────────────────────────────────

  private async _execute(): Promise<DBResult> {
    try {
      switch (this._op) {
        case 'select': return this._execSelect()
        case 'insert': return this._execInsert()
        case 'update': return this._execUpdate()
        case 'delete': return this._execDelete()
        case 'upsert': return this._execUpsert()
        case 'rpc':    return this._execRpc()
        default:       return { data: null, error: { message: 'Unknown operation' } }
      }
    } catch (e) {
      const err = e as Error & { code?: string }
      return { data: null, error: { message: err.message, code: err.code } }
    }
  }

  private async _execSelect(): Promise<DBResult> {
    const t = `"${this._table}"`
    const params = [...this._params]

    // HEAD-only: just count
    if (this._headOnly) {
      let sql = `SELECT COUNT(*) AS __c FROM ${t}`
      if (this._wheres.length) sql += ` WHERE ${this._wheres.join(' AND ')}`
      const res = await pool.query(sql, params)
      return { data: null, count: Number(res.rows[0]?.__c ?? 0), error: null }
    }

    let selectCols: string
    if (this._joins.length === 0) {
      selectCols = this._selectStr === '*'
        ? `${t}.*`
        : this._selectStr.split(',').map(f => `${t}."${f.trim()}"`).join(', ')
      if (this._countExact) selectCols += `, COUNT(*) OVER() AS __total_count`
    } else {
      const cols: string[] = []
      if (this._selectStr === '*') { cols.push(`${t}.*`) }
      else { for (const f of this._selectStr.split(',').map(s => s.trim()).filter(Boolean)) cols.push(`${t}."${f}"`) }
      for (const j of this._joins) {
        const fields = j.fields === '*'
          ? ['id','email','name','agent_key','team','role','status','disabled_skills','invited_by','created_at','updated_at']
          : j.fields.split(',').map(s => s.trim()).filter(Boolean)
        for (const f of fields) cols.push(`"${j.table}"."${f}" AS "__${j.alias}__${f}"`)
      }
      selectCols = cols.join(', ')
    }

    let sql = `SELECT ${selectCols} FROM ${t}`
    for (const j of this._joins) {
      sql += ` LEFT JOIN "${j.table}" ON ${t}."${j.alias}_id" = "${j.table}"."id"`
    }
    if (this._wheres.length)  sql += ` WHERE ${this._wheres.join(' AND ')}`
    if (this._orderParts.length) sql += ` ORDER BY ${this._orderParts.join(', ')}`
    if (this._limitN  !== null) { params.push(this._limitN);  sql += ` LIMIT $${params.length}` }
    if (this._offsetN !== null) { params.push(this._offsetN); sql += ` OFFSET $${params.length}` }

    const res  = await pool.query(sql, params)
    const rows = res.rows.map(r => this._reshapeRow(r))

    if (this._isSingle) return { data: rows[0] ?? null, error: null }

    if (this._countExact) {
      const count = rows.length > 0 ? Number((res.rows[0] as Row).__total_count ?? 0) : 0
      const data  = rows.map(({ __total_count: _, ...r }) => r)
      return { data, count, error: null }
    }

    return { data: rows, error: null }
  }

  private async _execInsert(): Promise<DBResult> {
    const rows = Array.isArray(this._writeData) ? this._writeData : [this._writeData!]
    const results: Row[] = []
    for (const row of rows) {
      const cols   = Object.keys(row)
      const params = cols.map(k => this._pgVal(row[k]))
      const colStr = cols.map(c => `"${c}"`).join(', ')
      const phs    = cols.map((_, i) => `$${i + 1}`).join(', ')
      let sql = `INSERT INTO "${this._table}" (${colStr}) VALUES (${phs})`
      if (this._returnData) sql += ' RETURNING *'
      const r = await pool.query(sql, params)
      if (this._returnData && r.rows[0]) results.push(r.rows[0])
    }
    if (!this._returnData) return { data: null, error: null }
    return { data: this._isSingle ? (results[0] ?? null) : results, error: null }
  }

  private async _execUpdate(): Promise<DBResult> {
    const data   = this._updateData!
    const params = [...this._params]
    const sets   = Object.entries(data).map(([k, v]) => {
      params.push(this._pgVal(v)); return `"${k}" = $${params.length}`
    })
    let sql = `UPDATE "${this._table}" SET ${sets.join(', ')}`
    if (this._wheres.length) sql += ` WHERE ${this._wheres.join(' AND ')}`
    if (this._returnData) sql += ' RETURNING *'
    const res = await pool.query(sql, params)
    if (!this._returnData) return { data: null, error: null }
    return { data: this._isSingle ? (res.rows[0] ?? null) : res.rows, error: null }
  }

  private async _execDelete(): Promise<DBResult> {
    const params = [...this._params]
    let sql = `DELETE FROM "${this._table}"`
    if (this._wheres.length) sql += ` WHERE ${this._wheres.join(' AND ')}`
    await pool.query(sql, params)
    return { data: null, error: null }
  }

  private async _execUpsert(): Promise<DBResult> {
    const rows = Array.isArray(this._writeData) ? this._writeData : [this._writeData!]
    const conflictCols = this._upsertConflict
      ? this._upsertConflict.split(',').map(c => `"${c.trim()}"`)
      : ['"id"']
    let inserted = 0
    const results: Row[] = []

    for (const row of rows) {
      const cols   = Object.keys(row)
      const params = cols.map(k => this._pgVal(row[k]))
      const colStr = cols.map(c => `"${c}"`).join(', ')
      const phs    = cols.map((_, i) => `$${i + 1}`).join(', ')
      let sql = `INSERT INTO "${this._table}" (${colStr}) VALUES (${phs})`

      if (this._upsertIgnoreDup) {
        sql += ` ON CONFLICT (${conflictCols.join(', ')}) DO NOTHING`
      } else {
        const updates = cols
          .filter(c => !conflictCols.includes(`"${c}"`))
          .map(c => `"${c}" = EXCLUDED."${c}"`)
        sql += ` ON CONFLICT (${conflictCols.join(', ')}) DO UPDATE SET ${updates.join(', ')}`
      }
      if (this._returnData) sql += ' RETURNING *'

      const r = await pool.query(sql, params)
      inserted += r.rowCount ?? 0
      if (this._returnData && r.rows[0]) results.push(r.rows[0])
    }

    if (this._countExact) return { data: null, count: inserted, error: null }
    if (!this._returnData) return { data: null, error: null }
    return { data: this._isSingle ? (results[0] ?? null) : results, error: null }
  }

  private async _execRpc(): Promise<DBResult> {
    const argNames = Object.keys(this._rpcArgs)
    const params   = argNames.map(k => this._pgVal(this._rpcArgs[k]))
    const phs      = argNames.map((_, i) => `$${i + 1}`).join(', ')
    const sql      = `SELECT ${this._rpcFn}(${phs}) AS result`
    const res      = await pool.query(sql, params)
    return { data: res.rows[0]?.result ?? null, error: null }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private _pgVal(v: unknown): unknown {
    if (v instanceof Date) return v
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v)
    return v
  }

  private _reshapeRow(row: Row): Row {
    if (this._joins.length === 0) return row
    const result: Row = {}
    const nested: Record<string, Row> = {}
    for (const [key, val] of Object.entries(row)) {
      const m = key.match(/^__(\w+)__(.+)$/)
      if (m) { if (!nested[m[1]]) nested[m[1]] = {}; nested[m[1]][m[2]] = val }
      else    { result[key] = val }
    }
    for (const [alias, data] of Object.entries(nested)) {
      result[alias] = Object.values(data).every(v => v === null) ? null : data
    }
    return result
  }
}

// ── RPCBuilder ────────────────────────────────────────────────────────────────

class RPCBuilder extends QueryBuilder {
  constructor(fn: string, args: Row) {
    super(pool, '__rpc__')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const self = this as any
    self._op      = 'rpc'
    self._rpcFn   = fn
    self._rpcArgs = args
  }
}

// ── DBClient ──────────────────────────────────────────────────────────────────

class DBClient {
  from(table: string): QueryBuilder { return new QueryBuilder(pool, table) }
  rpc(fn: string, args: Row): RPCBuilder { return new RPCBuilder(fn, args) }
}

// ── Public API (mirrors @supabase/supabase-js) ────────────────────────────────

export function createClient(): DBClient      { return new DBClient() }
export function createServerClient(): DBClient { return new DBClient() }

export function isDBConnectionError(error: { message?: string; code?: string } | null): boolean {
  if (!error) return false
  const msg  = error.message ?? ''
  const code = error.code    ?? ''
  return msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') ||
         msg.includes('ENOTFOUND')    || msg.includes('fetch failed') ||
         code === 'ECONNREFUSED'      || code === 'ETIMEDOUT'
}

export type { User, OneTimeToken, Session } from './database.types'
