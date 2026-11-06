/**
 * SurrealQL tokenizer + recursive-descent parser for the dialect subset this
 * application actually uses. Produces a statement AST consumed by
 * `engine.mjs` (which executes it against MySQL).
 *
 * Supported statements: SELECT, CREATE, UPSERT, INSERT, UPDATE, DELETE,
 * RELATE, LIVE SELECT, KILL, DEFINE (TABLE/FIELD/INDEX/EVENT/...),
 * REMOVE, INFO, SHOW CHANGES, RETURN, USE, LET, BEGIN/COMMIT/CANCEL,
 * SLEEP, THROW, ALTER (accepted, storage no-op).
 */

const STRUCTURAL_KEYWORDS = new Set([
  'select', 'create', 'upsert', 'insert', 'update', 'delete', 'relate', 'live',
  'kill', 'define', 'remove', 'info', 'show', 'return', 'use', 'let', 'begin',
  'commit', 'cancel', 'sleep', 'throw', 'alter', 'from', 'where', 'split',
  'group', 'order', 'limit', 'start', 'fetch', 'value', 'values', 'diff',
  'by', 'all', 'only', 'ignore', 'into', 'set', 'content', 'merge', 'patch',
  'unset', 'unique', 'on', 'as', 'asc', 'desc', 'collate', 'numeric',
  'timeout', 'parallel', 'explain', 'and', 'or', 'not', 'is', 'in', 'inside',
  'contains', 'containsnot', 'containsall', 'containsany', 'containsnone',
  'allinside', 'anyinside', 'noneinside', 'intersects', 'none', 'null',
  'true', 'false', 'if', 'then', 'else', 'end', 'table', 'field', 'index',
  'event', 'user', 'access', 'analyzer', 'param', 'function', 'for', 'since',
  'structure', 'changes', 'transaction', 'db', 'ns', 'at', 'omit', 'dup',
  'duplicate', 'key', 'excluded', 'when', 'after', 'before', 'schemaless',
  'schemafull', 'permissions', 'changefeed', 'drop', 'type', 'default',
  'readonly', 'comment', 'flexible', 'overwrite', 'fields', 'search',
  'analyze', 'fulltext', 'exclude', 'include', 'exists',
]);

/**
 * Keywords that must NOT be read as table/field names in expression or
 * identifier positions (they terminate or start clauses). Keywords that are
 * ALSO used as real names in this app (`order` table, `group`/`value`/`key`
 * fields, `type` casts, `table`/`index` fields, ...) stay allowed.
 */
const NEVER_AS_NAME = new Set([
  'where', 'from', 'split', 'by', 'and', 'or', 'not', 'is', 'inside',
  'contains', 'containsnot', 'containsall', 'containsany', 'containsnone',
  'allinside', 'anyinside', 'noneinside', 'intersects', 'then', 'else',
  'end', 'if', 'as', 'since', 'unique', 'timeout', 'parallel', 'explain',
  'with', 'fetch', 'only', 'ignore', 'into', 'diff', 'all', 'collate',
  'numeric', 'content', 'merge', 'patch', 'unset', 'set', 'return',
]);

/** Keywords that cannot start a FROM/CREATE/UPDATE target. */
const TARGET_FORBIDDEN = new Set([
  'where', 'fetch', 'group', 'split', 'limit', 'start', 'with', 'timeout',
  'parallel', 'explain', 'value', 'by', 'set', 'content', 'merge', 'patch',
  'unset', 'return', 'and', 'or', 'not', 'is', 'in', 'inside', 'contains',
  'unique', 'on', 'as', 'then', 'else', 'end', 'if',
]);

const OPERATORS = [
  '->', '::', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '@@',
  'CONTAINSNOT', 'CONTAINSALL', 'CONTAINSANY', 'CONTAINSNONE', 'CONTAINSONLY',
  'ALLINSIDE', 'ANYINSIDE', 'NONEINSIDE', 'INTERSECTS', 'CONTAINS', 'INSIDE',
  '~', '=', '<', '>', '+', '-', '*', '/', '%', '|', '(', ')', '[', ']', '{', '}',
  ',', ';', ':', '.', '?', '@',
];

function isIdentStart(ch) {
  return /[A-Za-z_]/.test(ch);
}
function isIdentPart(ch) {
  return /[A-Za-z0-9_]/.test(ch);
}

class Token {
  constructor(type, value, pos) {
    this.type = type; // 'ident' | 'keyword' | 'number' | 'duration' | 'string' | 'param' | 'op' | 'qident' | 'uuid' | 'datetime' | 'eof'
    this.value = value;
    this.pos = pos;
  }
}

export function tokenize(input) {
  const tokens = [];
  let i = 0;
  const n = input.length;
  const prevAllowsUnary = () => {
    const last = tokens[tokens.length - 1];
    if (!last) return true;
    if (last.type === 'op') return !')]}'.includes(last.value);
    return false; // after ident/number/string/keyword, '-' is subtraction
  };
  while (i < n) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '-' && input[i + 1] === '-') {
      while (i < n && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && input[i + 1] === '*') {
      const end = input.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === '⟨' || ch === '`') {
      const close = ch === '⟨' ? '⟩' : '`';
      const end = input.indexOf(close, i + 1);
      if (end === -1) throw new Error(`Unterminated quoted identifier at ${i}`);
      tokens.push(new Token('qident', input.slice(i + 1, end), i));
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let out = '';
      while (j < n && input[j] !== quote) {
        if (input[j] === '\\' && j + 1 < n) {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '\\') out += '\\';
          else if (esc === '"') out += '"';
          else if (esc === "'") out += "'";
          else if (esc === 'u') {
            const hex = input.slice(j + 2, j + 6);
            out += String.fromCharCode(parseInt(hex, 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      if (j >= n) throw new Error(`Unterminated string at ${i}`);
      tokens.push(new Token('string', out, i));
      i = j + 1;
      continue;
    }
    if ((ch === 'u' || ch === 'r') && (input[i + 1] === '"' || input[i + 1] === "'")) {
      const end = input.indexOf(input[i + 1], i + 2);
      if (end === -1) throw new Error(`Unterminated literal at ${i}`);
      tokens.push(new Token('uuid', input.slice(i + 2, end), i));
      i = end + 1;
      continue;
    }
    // SurrealQL datetime literal: d"2024-01-01T00:00:00Z" / d'...'
    if (ch === 'd' && (input[i + 1] === '"' || input[i + 1] === "'")) {
      const end = input.indexOf(input[i + 1], i + 2);
      if (end === -1) throw new Error(`Unterminated literal at ${i}`);
      tokens.push(new Token('datetime', input.slice(i + 2, end), i));
      i = end + 1;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < n && (isIdentPart(input[j]) || input[j] === '*')) j += 1;
      if (j === i + 1) throw new Error(`Invalid parameter at ${i}`);
      tokens.push(new Token('param', input.slice(i + 1, j), i));
      i = j;
      continue;
    }
    // numbers & durations (incl. compound 1w2d); negative numbers only in unary position
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(input[i + 1] || '') && prevAllowsUnary())) {
      let j = i + 1;
      while (j < n && /[0-9a-zA-Z_.]/.test(input[j])) j += 1;
      const raw = input.slice(i, j);
      if (/[a-zA-Z]/.test(raw)) {
        tokens.push(new Token('duration', raw, i));
      } else {
        tokens.push(new Token('number', Number(raw), i));
      }
      i = j;
      continue;
    }
    if (isIdentStart(ch)) {
      let j = i;
      while (j < n && (isIdentPart(input[j]) || input[j] === ':')) j += 1;
      // do not swallow a trailing ':' that starts a record id (e.g. `table:`)
      while (j > i && input[j - 1] === ':' && !(input[j - 2] === ':')) j -= 1;
      while (j > i && input[j - 1] === ':') j -= 1;
      let k = i;
      while (k < j) {
        if (input[k] === ':' && input[k + 1] === ':') {
          tokens.push(new Token('op', '::', k));
          k += 2;
          continue;
        }
        if (input[k] === ':') {
          tokens.push(new Token('op', ':', k));
          k += 1;
          continue;
        }
        let e = k;
        while (e < j && isIdentPart(input[e])) e += 1;
        const word = input.slice(k, e);
        if (STRUCTURAL_KEYWORDS.has(word.toLowerCase())) tokens.push(new Token('keyword', word.toLowerCase(), k));
        else tokens.push(new Token('ident', word, k));
        k = e;
      }
      i = j;
      continue;
    }
    let matched = null;
    for (const op of OPERATORS) {
      if (input.startsWith(op, i)) {
        matched = op;
        break;
      }
    }
    if (matched) {
      tokens.push(new Token('op', matched, i));
      i += matched.length;
      continue;
    }
    throw new Error(`Unexpected character '${ch}' at position ${i} in: ${input.slice(Math.max(0, i - 30), i + 30)}`);
  }
  tokens.push(new Token('eof', null, n));
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek(offset = 0) {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }
  next() {
    const tok = this.tokens[this.pos];
    if (tok.type !== 'eof') this.pos += 1;
    return tok;
  }
  isKw(word, offset = 0) {
    const t = this.peek(offset);
    return t.type === 'keyword' && t.value === word;
  }
  isOp(op, offset = 0) {
    const t = this.peek(offset);
    return t.type === 'op' && t.value === op;
  }
  eatKw(word) {
    if (this.isKw(word)) {
      this.next();
      return true;
    }
    return false;
  }
  eatOp(op) {
    if (this.isOp(op)) {
      this.next();
      return true;
    }
    return false;
  }
  expectKw(word) {
    if (!this.eatKw(word)) {
      throw new Error(`Expected keyword ${word.toUpperCase()} but got ${describe(this.peek())}`);
    }
  }
  expectOp(op) {
    if (!this.eatOp(op)) {
      throw new Error(`Expected '${op}' but got ${describe(this.peek())}`);
    }
  }
  expectIdent(what = 'identifier') {
    const t = this.peek();
    if (t.type === 'ident' || t.type === 'qident') {
      this.next();
      return t.value;
    }
    if (t.type === 'keyword' && !NEVER_AS_NAME.has(t.value)) {
      // names like `order`, `table`, `key`, `value`, `index` used as identifiers
      this.next();
      return t.value;
    }
    throw new Error(`Expected ${what} but got ${describe(t)}`);
  }

  // ---- statements ---------------------------------------------------------

  parseStatements() {
    const statements = [];
    for (;;) {
      while (this.eatOp(';')) { /* skip empties */ }
      if (this.peek().type === 'eof') break;
      statements.push(this.parseStatement());
      if (!this.eatOp(';')) {
        if (this.peek().type !== 'eof') {
          throw new Error(`Expected ';' between statements, got ${describe(this.peek())}`);
        }
      }
    }
    return statements;
  }

  parseStatement() {
    const t = this.peek();
    if (t.type !== 'keyword') {
      throw new Error(`Expected statement, got ${describe(t)}`);
    }
    switch (t.value) {
      case 'select': return this.parseSelect();
      case 'create': return this.parseCreate('create');
      case 'upsert': return this.parseCreate('upsert');
      case 'insert': return this.parseInsert();
      case 'update': return this.parseUpdate();
      case 'delete': return this.parseDelete();
      case 'relate': return this.parseRelate();
      case 'live': return this.parseLive();
      case 'kill': return this.parseKill();
      case 'define': return this.parseDefine();
      case 'remove': return this.parseRemove();
      case 'info': return this.parseInfo();
      case 'show': return this.parseShowChanges();
      case 'return': return this.parseReturn();
      case 'use': return this.parseUse();
      case 'let': return this.parseLet();
      case 'alter': return this.parseAlter();
      case 'begin': {
        this.next();
        this.eatKw('transaction');
        return { kind: 'begin' };
      }
      case 'commit': {
        this.next();
        this.eatKw('transaction');
        return { kind: 'commit' };
      }
      case 'cancel': {
        this.next();
        this.eatKw('transaction');
        return { kind: 'cancel' };
      }
      case 'sleep': {
        this.next();
        const d = this.parseDuration();
        return { kind: 'sleep', ms: d.ms };
      }
      case 'throw': {
        this.next();
        return { kind: 'throw', expr: this.parseExpression() };
      }
      default:
        throw new Error(`Unsupported statement keyword: ${t.value.toUpperCase()}`);
    }
  }

  parseSelect() {
    this.expectKw('select');
    let only = this.eatKw('only');
    let value = null;
    // `SELECT VALUE x FROM t` (value mode) vs `SELECT value FROM t` (field
    // named value): value mode only when the next token starts a field name.
    if (this.isKw('value') && !this.isKw('from', 1) && !this.isOp(',', 1)) {
      this.next();
      value = { mode: 'value', fields: [this.parseProjectionField()] };
    } else if (this.eatKw('diff')) {
      value = { mode: 'diff' };
    }
    const fields = [];
    if (!value) {
      if (this.isOp('*')) {
        this.next();
        fields.push({ t: 'star' });
        // SurrealQL: `SELECT *, extra AS x FROM t` — star followed by more
        // projected fields (used by the dishes list subquery columns).
        while (this.eatOp(',')) {
          fields.push(this.parseProjectionField());
        }
      } else {
        for (;;) {
          fields.push(this.parseProjectionField());
          if (!this.eatOp(',')) break;
        }
      }
    }
    this.expectKw('from');
    if (this.eatKw('only')) only = true;
    const from = this.parseFromTargets();
    const stmt = { kind: 'select', only, value, fields, from, split: null };
    return this.finishSelect(stmt);
  }

  finishSelect(stmt) {
    for (;;) {
      if (this.eatKw('with')) {
        this.eatKw('index');
        stmt.withIndexes = [];
        for (;;) {
          stmt.withIndexes.push(this.expectIdent());
          if (!this.eatOp(',')) break;
        }
        continue;
      }
      if (this.eatKw('where')) {
        stmt.where = this.parseExpression();
        continue;
      }
      if (this.eatKw('split')) {
        this.eatKw('on');
        stmt.split = [];
        for (;;) {
          stmt.split.push(this.parsePath());
          if (!this.eatOp(',')) break;
        }
        continue;
      }
      if (this.eatKw('group')) {
        if (this.eatKw('all')) {
          stmt.group = 'all';
        } else {
          this.eatKw('by');
          const group = [];
          for (;;) {
            group.push(this.parsePath());
            if (!this.eatOp(',')) break;
          }
          stmt.group = group;
        }
        continue;
      }
      if (this.eatKw('order')) {
        this.eatKw('by');
        const order = [];
        for (;;) {
          const expr = this.parseExpression();
          const item = { expr, dir: 'asc', numeric: false };
          if (this.eatKw('collate')) item.collate = true;
          if (this.eatKw('numeric')) item.numeric = true;
          if (this.eatKw('desc')) item.dir = 'desc';
          else this.eatKw('asc');
          order.push(item);
          if (!this.eatOp(',')) break;
        }
        stmt.order = order;
        continue;
      }
      if (this.eatKw('limit')) {
        stmt.limit = this.parsePrimaryNumberish();
        continue;
      }
      if (this.eatKw('start')) {
        this.eatKw('at');
        stmt.start = this.parsePrimaryNumberish();
        continue;
      }
      if (this.eatKw('fetch')) {
        stmt.fetch = [];
        for (;;) {
          stmt.fetch.push(this.parsePath());
          if (!this.eatOp(',')) break;
        }
        continue;
      }
      if (this.eatKw('timeout')) {
        stmt.timeout = this.parseDuration();
        continue;
      }
      if (this.eatKw('parallel')) {
        stmt.parallel = true;
        continue;
      }
      if (this.eatKw('explain')) {
        stmt.explain = true;
        continue;
      }
      break;
    }
    return stmt;
  }

  parsePrimaryNumberish() {
    const t = this.peek();
    if (t.type === 'number') {
      this.next();
      return { t: 'lit', v: t.value };
    }
    if (t.type === 'param') {
      this.next();
      return { t: 'param', name: t.value };
    }
    throw new Error(`Expected number or parameter, got ${describe(t)}`);
  }

  parseProjectionField() {
    if (this.isOp('*')) {
      this.next();
      return { t: 'star' };
    }
    const expr = this.parseExpression();
    if (this.eatKw('as')) {
      const alias = this.expectIdent('alias');
      return { t: 'alias', expr, alias };
    }
    return expr;
  }

  parseFromTargets() {
    const targets = [];
    for (;;) {
      targets.push(this.parseTarget());
      if (!this.eatOp(',')) break;
    }
    return targets;
  }

  parseTarget() {
    const t = this.peek();
    if (t.type === 'param') {
      this.next();
      return { t: 'param', name: t.value };
    }
    if (t.type === 'ident' || t.type === 'qident') {
      const name = this.next().value;
      if (this.isOp(':')) {
        this.next();
        return this.finishRidLiteral(name);
      }
      return { t: 'table', name };
    }
    if (t.type === 'keyword') {
      if (this.isOp('::', 1)) {
        // type::record(...) / type::table(...) function forms
        return this.parseExpression();
      }
      if (TARGET_FORBIDDEN.has(t.value)) {
        throw new Error(`Expected FROM target, got ${describe(t)}`);
      }
      const name = this.next().value;
      if (this.isOp(':')) {
        this.next();
        return this.finishRidLiteral(name);
      }
      return { t: 'table', name };
    }
    if (t.type === 'string') {
      // Surreal allows `FROM "table:id"` string form
      this.next();
      const parsed = parseRidText(t.value);
      return parsed ? { t: 'rid', table: parsed.table, id: parsed.id } : { t: 'table', name: t.value };
    }
    if (t.type === 'uuid') {
      this.next();
      return { t: 'uuidlit', v: t.value };
    }
    if (t.type === 'op' || (t.type === 'keyword' && t.value === 'type')) {
      // type::record(...) / type::table(...) function forms
      return this.parseExpression();
    }
    throw new Error(`Expected FROM target, got ${describe(t)}`);
  }

  finishRidLiteral(table) {
    const t = this.peek();
    if (t.type === 'string' || t.type === 'uuid' || t.type === 'qident' || t.type === 'ident') {
      this.next();
      return { t: 'rid', table, id: t.value };
    }
    if (t.type === 'number') {
      this.next();
      return { t: 'rid', table, id: String(t.value) };
    }
    if (t.type === 'keyword' && !NEVER_AS_NAME.has(t.value)) {
      this.next();
      return { t: 'rid', table, id: t.value };
    }
    throw new Error(`Expected record id after '${table}:', got ${describe(t)}`);
  }

  parseCreate(kind) {
    this.expectKw(kind);
    const only = this.eatKw('only');
    const target = this.parseTarget();
    const stmt = { kind, only, target };
    this.finishWriteClause(stmt);
    return stmt;
  }

  /** SET/CONTENT/MERGE/PATCH/UNSET + RETURN + TIMEOUT + PARALLEL; true if anything matched */
  finishWriteClause(stmt) {
    let consumed = false;
    for (;;) {
      if (this.eatKw('set')) {
        stmt.set = this.parseAssignments();
        consumed = true;
        continue;
      }
      if (this.eatKw('content')) {
        stmt.content = this.parseExpression();
        consumed = true;
        continue;
      }
      if (this.eatKw('merge')) {
        stmt.merge = this.parseExpression();
        consumed = true;
        continue;
      }
      if (this.eatKw('patch')) {
        stmt.patch = this.parseExpression();
        consumed = true;
        continue;
      }
      if (this.eatKw('unset')) {
        stmt.unset = [];
        for (;;) {
          stmt.unset.push(this.parsePath());
          if (!this.eatOp(',')) break;
        }
        consumed = true;
        continue;
      }
      if (this.eatKw('return')) {
        stmt.return = this.parseReturnClause();
        consumed = true;
        continue;
      }
      if (this.eatKw('timeout')) {
        stmt.timeout = this.parseDuration();
        consumed = true;
        continue;
      }
      if (this.eatKw('parallel')) {
        stmt.parallel = true;
        consumed = true;
        continue;
      }
      if (this.eatKw('unique')) {
        stmt.unique = true;
        consumed = true;
        continue;
      }
      if (this.eatKw('fetch')) {
        stmt.fetch = [];
        for (;;) {
          stmt.fetch.push(this.parsePath());
          if (!this.eatOp(',')) break;
        }
        consumed = true;
        continue;
      }
      break;
    }
    return consumed;
  }

  parseAssignments() {
    const assignments = [];
    for (;;) {
      const path = this.parsePath();
      // Compound assignment: `SET tags += 'a'`, `SET count -= 1` (SurrealQL).
      // The tokenizer has no '+='/ '-=' token, so look for op('+'|'-') + op('=').
      let op = '=';
      if ((this.isOp('+') || this.isOp('-')) && this.isOp('=', 1)) {
        op = this.peek().value + '=';
        this.next();
        this.next();
      } else {
        this.expectOp('=');
      }
      const expr = this.parseExpression();
      assignments.push([path, expr, op]);
      if (!this.eatOp(',')) break;
    }
    return assignments;
  }

  parseInsert() {
    this.expectKw('insert');
    const ignore = this.eatKw('ignore');
    const only = this.eatKw('only');
    this.expectKw('into');
    const target = this.parseTarget();
    const stmt = { kind: 'insert', ignore, only, into: target };
    if (this.isOp('(')) {
      // Positional INSERT: `INSERT INTO t (a, b) VALUES (1, 2), (3, 4)` —
      // column list followed by one or more value tuples (SurrealDB core
      // syntax; used by the Users form/import).
      const cols = [];
      this.next();
      for (;;) {
        cols.push(this.expectIdent('column name'));
        if (!this.eatOp(',')) break;
      }
      this.expectOp(')');
      if (!this.eatKw('value') && !this.eatKw('values')) {
        throw new Error(`Expected VALUES but got ${describe(this.peek())}`);
      }
      const objs = [];
      for (;;) {
        this.expectOp('(');
        const vals = [];
        for (;;) {
          vals.push(this.parseExpression());
          if (!this.eatOp(',')) break;
        }
        this.expectOp(')');
        objs.push({
          t: 'obj',
          entries: cols.map((col, i) => [col, vals[i]]),
        });
        if (!this.eatOp(',')) break;
      }
      stmt.values = { mode: 'objs', objs };
    } else if (this.eatKw('value')) {
      stmt.values = { mode: 'objs', objs: [this.parseExpression()] };
    } else if (this.eatKw('values')) {
      stmt.values = { mode: 'objs', objs: [] };
      if (this.isOp('[')) {
        this.next();
        if (!this.isOp(']')) {
          for (;;) {
            stmt.values.objs.push(this.parseExpression());
            if (!this.eatOp(',')) break;
          }
        }
        this.expectOp(']');
      } else {
        for (;;) {
          stmt.values.objs.push(this.parseExpression());
          if (!this.eatOp(',')) break;
        }
      }
    } else if (this.isOp('[') || this.isOp('{')) {
      if (this.isOp('[')) {
        this.next();
        stmt.values = { mode: 'objs', objs: [] };
        if (!this.isOp(']')) {
          for (;;) {
            stmt.values.objs.push(this.parseExpression());
            if (!this.eatOp(',')) break;
          }
        }
        this.expectOp(']');
      } else {
        stmt.values = { mode: 'objs', objs: [this.parseExpression()] };
      }
    } else {
      stmt.values = { mode: 'expr', expr: this.parseExpression() };
    }
    if (this.eatKw('return')) {
      stmt.return = this.parseReturnClause();
    }
    if (this.eatKw('on')) {
      this.eatKw('duplicate');
      this.eatKw('key');
      this.expectKw('update');
      stmt.onDuplicate = this.parseAssignments();
    }
    if (this.eatKw('timeout')) {
      stmt.timeout = this.parseDuration();
    }
    return stmt;
  }

  parseUpdate() {
    this.expectKw('update');
    const only = this.eatKw('only');
    if (this.eatKw('from')) { /* tolerated */ }
    const targets = this.parseFromTargets();
    const stmt = { kind: 'update', only, targets };
    for (;;) {
      if (this.eatKw('where')) {
        stmt.where = this.parseExpression();
        continue;
      }
      const consumed = this.finishWriteClause(stmt);
      if (!consumed) break;
    }
    return stmt;
  }

  parseDelete() {
    this.expectKw('delete');
    const only = this.eatKw('only');
    this.eatKw('from');
    const targets = this.parseFromTargets();
    const stmt = { kind: 'delete', only, targets };
    for (;;) {
      if (this.eatKw('where')) {
        stmt.where = this.parseExpression();
        continue;
      }
      if (this.eatKw('return')) {
        stmt.return = this.parseReturnClause();
        continue;
      }
      if (this.eatKw('timeout')) {
        stmt.timeout = this.parseDuration();
        continue;
      }
      if (this.eatKw('parallel')) {
        stmt.parallel = true;
        continue;
      }
      break;
    }
    return stmt;
  }

  parseRelate() {
    this.expectKw('relate');
    const only = this.eatKw('only');
    const from = this.parseTarget();
    this.expectOp('->');
    const edge = this.expectIdent('edge table');
    this.expectOp('->');
    const to = this.parseTarget();
    const stmt = { kind: 'relate', only, from, edge, to };
    this.finishWriteClause(stmt);
    return stmt;
  }

  parseLive() {
    this.expectKw('live');
    this.eatKw('select');
    const stmt = { kind: 'live', select: { mode: 'fields' } };
    if (this.eatKw('diff')) {
      stmt.select = { mode: 'diff' };
    } else if (this.eatKw('value')) {
      stmt.select = { mode: 'value', fields: [this.expectIdent()] };
    } else if (this.isOp('*')) {
      this.next();
    }
    this.expectKw('from');
    stmt.from = this.parseFromTargets();
    if (this.eatKw('where')) {
      stmt.where = this.parseExpression();
    }
    if (this.eatKw('fetch')) {
      stmt.fetch = [];
      for (;;) {
        stmt.fetch.push(this.parsePath());
        if (!this.eatOp(',')) break;
      }
    }
    return stmt;
  }

  parseKill() {
    this.expectKw('kill');
    const t = this.peek();
    if (t.type === 'uuid') {
      this.next();
      return { kind: 'kill', id: { t: 'lit', v: t.value } };
    }
    return { kind: 'kill', id: this.parseExpression() };
  }

  parseDefine() {
    this.expectKw('define');
    const t = this.peek();
    if (t.type !== 'keyword') throw new Error(`Expected DEFINE target, got ${describe(t)}`);
    switch (t.value) {
      case 'table': {
        this.next();
        this.eatKw('if');
        this.eatKw('not');
        this.eatKw('exists');
        const name = this.expectIdent('table name');
        return { kind: 'define', what: 'table', name, raw: this.consumeRawRest() };
      }
      case 'field': {
        this.next();
        this.eatKw('if');
        this.eatKw('not');
        this.eatKw('exists');
        // Field names may be dotted / wildcard paths and may collide with
        // clause keywords (fields literally named 'patch' / 'content').
        const fieldNameToken = this.peek();
        const isFieldName = fieldNameToken.type === 'ident' || fieldNameToken.type === 'qident'
          || (fieldNameToken.type === 'keyword' && !['if', 'on', 'default', 'value', 'then'].includes(fieldNameToken.value));
        if (!isFieldName) throw new Error('Expected field name but got ' + describe(fieldNameToken));
        this.next();
        const nameParts = [String(fieldNameToken.value)];
        while (this.isOp('.')) {
          this.next();
          nameParts.push(this.isOp('*') ? (this.next(), '*') : this.expectIdent('field name'));
        }
        const name = nameParts.join('.');
        this.eatKw('on');
        this.eatKw('table');
        const table = this.expectIdent('table name');
        const def = { kind: 'define', what: 'field', name, table };
        for (;;) {
          if (this.eatKw('type')) {
            def.type = this.consumeTypeExpr();
            continue;
          }
          if (this.eatKw('default')) {
            def.default = this.parseExpression();
            continue;
          }
          if (this.eatKw('value')) {
            def.value = this.parseExpression();
            continue;
          }
          break;
        }
        def.raw = this.consumeRawRest();
        return def;
      }
      case 'index': {
        this.next();
        this.eatKw('if');
        this.eatKw('not');
        this.eatKw('exists');
        const name = this.expectIdent('index name');
        this.expectKw('on');
        this.eatKw('table');
        const table = this.expectIdent('table name');
        this.eatKw('fields');
        const fields = [];
        for (;;) {
          fields.push(this.expectIdent('field'));
          if (!this.eatOp(',')) break;
        }
        const def = { kind: 'define', what: 'index', name, table, fields, unique: false };
        if (this.eatKw('unique')) def.unique = true;
        def.raw = this.consumeRawRest();
        return def;
      }
      case 'event': {
        this.next();
        this.eatKw('if');
        this.eatKw('not');
        this.eatKw('exists');
        const name = this.expectIdent('event name');
        this.expectKw('on');
        this.eatKw('table');
        const table = this.expectIdent('table name');
        const def = { kind: 'define', what: 'event', name, table };
        if (this.eatKw('when')) {
          def.when = this.parseExpression();
        }
        if (this.eatKw('then')) {
          this.expectOp('{');
          def.then = [];
          for (;;) {
            while (this.eatOp(';')) { /* skip */ }
            if (this.isOp('}')) break;
            def.then.push(this.parseStatement());
          }
          this.expectOp('}');
        }
        def.raw = this.consumeRawRest();
        return def;
      }
      default: {
        const what = t.value;
        this.next();
        return { kind: 'define', what: `ignore:${what}`, raw: this.consumeRawRest() };
      }
    }
  }

  consumeTypeExpr() {
    const start = this.pos;
    let depth = 0;
    for (;;) {
      const tok = this.peek();
      if (tok.type === 'eof') break;
      if (tok.type === 'op' && (tok.value === '<' || tok.value === '[')) {
        depth += 1;
        this.next();
        continue;
      }
      if (tok.type === 'op' && (tok.value === '>' || tok.value === ']')) {
        depth -= 1;
        this.next();
        continue;
      }
      if (depth === 0 && tok.type === 'keyword' && ['default', 'permissions', 'readonly', 'comment', 'flexible', 'value', 'assert'].includes(tok.value)) break;
      if (depth === 0 && tok.type === 'op' && tok.value === ';') break;
      this.next();
    }
    return { from: start, to: this.pos };
  }

  consumeRawRest() {
    const parts = [];
    let depth = 0;
    for (;;) {
      const tok = this.peek();
      if (tok.type === 'eof') break;
      if (tok.type === 'op') {
        if ('([{'.includes(tok.value)) depth += 1;
        if (')]}'.includes(tok.value)) {
          if (depth === 0) break;
          depth -= 1;
        }
        if (tok.value === ';' && depth === 0) break;
        if (tok.value === ';' && depth === 0) break;
      }
      parts.push(this.next());
    }
    return parts;
  }

  parseRemove() {
    this.expectKw('remove');
    const what = this.expectIdent('remove target (table/field/index/event/...)');
    let name = null;
    let table = null;
    name = this.expectIdent();
    if (what !== 'table') {
      if (this.eatKw('on')) {
        this.eatKw('table');
        table = this.expectIdent();
      }
    }
    return { kind: 'remove', what, name, table };
  }

  parseInfo() {
    this.expectKw('info');
    this.eatKw('for');
    let scope = 'db';
    let name = null;
    if (this.eatKw('db')) scope = 'db';
    else if (this.eatKw('ns')) scope = 'ns';
    else if (this.eatKw('table')) {
      scope = 'table';
      name = this.expectIdent();
    } else if (this.eatKw('user')) {
      scope = 'user';
      name = this.expectIdent();
    }
    this.eatKw('structure');
    return { kind: 'info', scope, name };
  }

  parseShowChanges() {
    this.expectKw('show');
    this.expectKw('changes');
    this.expectKw('for');
    this.expectKw('table');
    const table = this.expectIdent();
    let since = null;
    let limit = null;
    if (this.eatKw('since')) {
      const t = this.peek();
      if (t.type === 'number' || t.type === 'string' || t.type === 'param') {
        this.next();
        since = t.type === 'param' ? { t: 'param', name: t.value } : { t: 'lit', v: t.value };
      } else {
        since = this.parseExpression();
      }
    }
    if (this.eatKw('limit')) {
      limit = this.parsePrimaryNumberish();
    }
    return { kind: 'show_changes', table, since, limit };
  }

  parseReturn() {
    this.expectKw('return');
    if (this.isOp(';') || this.peek().type === 'eof') {
      return { kind: 'return', expr: null };
    }
    if (this.isKw('none')) {
      this.next();
      return { kind: 'return', expr: { t: 'lit', v: 'NONE' } };
    }
    return { kind: 'return', expr: this.parseExpression() };
  }

  parseUse() {
    this.expectKw('use');
    let ns = null;
    let db = null;
    if (this.eatKw('ns')) {
      ns = this.expectIdent();
      if (this.eatKw('db')) db = this.expectIdent();
    } else if (this.eatKw('db')) {
      db = this.expectIdent();
    }
    return { kind: 'use', ns, db };
  }

  parseLet() {
    this.expectKw('let');
    this.eatKw('if');
    this.eatKw('not');
    this.eatKw('exists');
    const t = this.peek();
    if (t.type !== 'param') throw new Error(`Expected $parameter after LET, got ${describe(t)}`);
    this.next();
    this.expectOp('=');
    return { kind: 'let', name: t.value, expr: this.parseExpression() };
  }

  parseAlter() {
    this.expectKw('alter');
    this.expectKw('table');
    const name = this.expectIdent();
    // rest (CHANGEFEED etc.) is a storage no-op for us
    this.consumeRawRest();
    return { kind: 'alter', name };
  }

  parseReturnClause() {
    if (this.isKw('none')) {
      this.next();
      return { mode: 'none' };
    }
    if (this.isKw('diff')) {
      this.next();
      return { mode: 'diff' };
    }
    // RETURN BEFORE / RETURN AFTER — the pre-/post-write record (SurrealQL).
    // Only the bare keyword; `after.items` still parses as a path expression.
    if (
      (this.isKw('before') || this.isKw('after'))
      && !this.isOp('.', 1) && !this.isOp('[', 1) && !this.isOp('(', 1)
    ) {
      return { mode: this.next().value };
    }
    const exprs = [];
    for (;;) {
      exprs.push(this.parseExpression());
      if (!this.eatOp(',')) break;
    }
    return { mode: 'exprs', exprs };
  }

  // ---- expressions ---------------------------------------------------------

  parseExpression() {
    return this.parseOr();
  }
  parseOr() {
    let left = this.parseNullish();
    while (this.isKw('or') || this.isOp('||')) {
      this.next();
      left = { t: 'bin', op: 'or', l: left, r: this.parseNullish() };
    }
    return left;
  }
  parseNullish() {
    // `??` nullish coalescing (SurrealQL): used e.g. as math::max([value ?? 0, $seed])
    let left = this.parseAnd();
    while (this.isOp('??')) {
      this.next();
      left = { t: 'bin', op: '??', l: left, r: this.parseAnd() };
    }
    return left;
  }
  parseAnd() {
    let left = this.parseNot();
    while (this.isKw('and') || this.isOp('&&')) {
      this.next();
      left = { t: 'bin', op: 'and', l: left, r: this.parseNot() };
    }
    return left;
  }
  parseNot() {
    if (this.isKw('not')) {
      const nextTok = this.peek(1);
      if (nextTok.type === 'keyword' && ['in', 'inside', 'contains', 'allinside', 'anyinside', 'noneinside'].includes(nextTok.value)) {
        return this.parseComparison();
      }
      this.next();
      return { t: 'un', op: 'not', e: this.parseNot() };
    }
    return this.parseComparison();
  }
  parseComparison() {
    let left = this.parseAdditive();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && ['=', '==', '!=', '<', '<=', '>', '>=', '~', '@@'].includes(t.value)) {
        this.next();
        const op = t.value === '==' ? '=' : t.value;
        left = { t: 'bin', op, l: left, r: this.parseAdditive() };
        continue;
      }
      if (t.type === 'keyword') {
        let neg = false;
        let kw = t.value;
        if (kw === 'not') {
          const nxt = this.peek(1);
          if (nxt.type === 'keyword' && ['in', 'inside', 'contains', 'allinside', 'anyinside', 'noneinside'].includes(nxt.value)) {
            neg = true;
            kw = nxt.value;
            this.next();
            this.next();
          } else break;
        } else if (['in', 'inside', 'contains', 'containsall', 'containsany', 'containsnone', 'allinside', 'anyinside', 'noneinside', 'intersects'].includes(kw)) {
          this.next();
        } else if (kw === 'is') {
          this.next();
          neg = this.eatKw('not');
          if (this.isKw('none')) {
            this.next();
            left = { t: 'isnone', e: left, neg };
            continue;
          }
          if (this.isKw('null')) {
            this.next();
            left = { t: 'isnull', e: left, neg };
            continue;
          }
          const rhs = this.parseAdditive();
          left = { t: 'bin', op: neg ? '!=' : '=', l: left, r: rhs };
          continue;
        } else break;
        const rhs = this.parseAdditive();
        left = { t: 'bin', op: neg ? `!${kw}` : kw, l: left, r: rhs };
        continue;
      }
      break;
    }
    return left;
  }
  parseAdditive() {
    let left = this.parseMultiplicative();
    for (;;) {
      if (this.isOp('+') || this.isOp('-')) {
        const op = this.next().value;
        left = { t: 'bin', op, l: left, r: this.parseMultiplicative() };
        continue;
      }
      break;
    }
    return left;
  }
  parseMultiplicative() {
    let left = this.parseUnary();
    for (;;) {
      if (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
        const op = this.next().value;
        left = { t: 'bin', op, l: left, r: this.parseUnary() };
        continue;
      }
      break;
    }
    return left;
  }
  parseUnary() {
    if (this.isOp('-')) {
      this.next();
      return { t: 'un', op: 'neg', e: this.parseUnary() };
    }
    if (this.isOp('+')) {
      this.next();
      return this.parseUnary();
    }
    if (this.isKw('not')) {
      this.next();
      return { t: 'un', op: 'not', e: this.parseUnary() };
    }
    return this.parsePostfix();
  }
  parsePostfix() {
    let node = this.parsePrimary();
    for (;;) {
      if (this.isOp('.') || this.isOp('?.')) {
        const optional = this.peek().value === '?.';
        this.next();
        const t = this.peek();
        if (t.type === 'op' && t.value === '*') {
          this.next();
          node = { t: 'allpath', base: node };
          continue;
        }
        const name = this.expectIdent('field name');
        node = optional
          ? { t: 'optpath', base: node, name }
          : { t: 'get', base: node, name };
        continue;
      }
      if (this.isOp('[')) {
        this.next();
        if (this.isOp('*')) {
          this.next();
          this.expectOp(']');
          node = { t: 'allpath', base: node };
          continue;
        }
        if (this.isKw('where')) {
          this.next();
          const where = this.parseExpression();
          this.expectOp(']');
          node = { t: 'wherepath', base: node, where };
          continue;
        }
        const idx = this.parseExpression();
        this.expectOp(']');
        node = { t: 'index', base: node, idx };
        continue;
      }
      break;
    }
    return node;
  }
  parsePrimary() {
    const t = this.peek();
    // function names: ident/keyword(::ident)+ possibly followed by '('
    if ((t.type === 'ident' || (t.type === 'keyword' && !NEVER_AS_NAME.has(t.value))) && this.isOp('::', 1)) {
      const parts = [this.next().value];
      while (this.isOp('::')) {
        this.next();
        parts.push(this.expectIdent('function name'));
      }
      const name = parts.join('::');
      if (this.isOp('(')) return this.parseCall(name);
      return { t: 'path', parts };
    }
    switch (t.type) {
      case 'number':
        this.next();
        return { t: 'lit', v: t.value };
      case 'string':
        this.next();
        return { t: 'lit', v: t.value };
      case 'uuid':
        this.next();
        return { t: 'uuid', v: t.value };
      case 'datetime':
        this.next();
        return { t: 'dtlit', v: t.value };
      case 'duration':
        this.next();
        return parseDurationLiteral(t.value);
      case 'param':
        this.next();
        return { t: 'param', name: t.value };
      case 'qident': {
        const name = this.next().value;
        if (this.isOp(':')) {
          this.next();
          return this.finishRidLiteral(name);
        }
        return { t: 'path', parts: [name] };
      }
      case 'ident': {
        const name = this.next().value;
        if (this.isOp(':')) {
          this.next();
          return this.finishRidLiteral(name);
        }
        if (this.isOp('(')) {
          return this.parseCall(name);
        }
        return { t: 'path', parts: [name] };
      }
      case 'keyword':
        switch (t.value) {
          case 'none':
            this.next();
            return { t: 'lit', v: 'NONE' };
          case 'null':
            this.next();
            return { t: 'lit', v: null };
          case 'true':
            this.next();
            return { t: 'lit', v: true };
          case 'false':
            this.next();
            return { t: 'lit', v: false };
          case 'if':
            return this.parseIf();
          default:
            // Names that happen to collide with keywords (`order`, `key`,
            // `table`, `value`, `type`, `index`, ...) read as field paths.
            if (!NEVER_AS_NAME.has(t.value)) {
              this.next();
              return { t: 'path', parts: [t.value] };
            }
            throw new Error(`Unexpected keyword '${t.value}' in expression at ${t.pos}`);
        }
      case 'op':
        switch (t.value) {
          case '(':
            this.next();
            {
              const inner = this.parseExpression();
              this.expectOp(')');
              return inner;
            }
          case '[': {
            this.next();
            const items = [];
            if (!this.isOp(']')) {
              for (;;) {
                items.push(this.parseExpression());
                if (!this.eatOp(',')) break;
              }
            }
            this.expectOp(']');
            return { t: 'arr', items };
          }
          case '{': {
            this.next();
            const entries = [];
            if (!this.isOp('}')) {
              for (;;) {
                const kt = this.peek();
                if (kt.type === 'ident' || kt.type === 'qident' || kt.type === 'keyword' || kt.type === 'string') {
                  this.next();
                  const key = kt.value;
                  this.expectOp(':');
                  entries.push([key, this.parseExpression()]);
                } else if (kt.type === 'number') {
                  this.next();
                  this.expectOp(':');
                  entries.push([String(kt.value), this.parseExpression()]);
                } else {
                  throw new Error(`Unsupported object key ${describe(kt)}`);
                }
                if (!this.eatOp(',')) break;
              }
            }
            this.expectOp('}');
            return { t: 'obj', entries };
          }
          case '<': {
            this.next();
            const typeTokens = [];
            let depth = 0;
            for (;;) {
              const tok = this.peek();
              if (tok.type === 'eof') throw new Error('Unterminated cast');
              if (tok.type === 'op' && (tok.value === '[' || tok.value === '<')) {
                depth += 1;
                typeTokens.push(this.next());
                continue;
              }
              if (tok.type === 'op' && (tok.value === ']' || tok.value === '>')) {
                if (depth === 0 && tok.value === '>') {
                  this.next();
                  break;
                }
                depth -= 1;
                typeTokens.push(this.next());
                continue;
              }
              typeTokens.push(this.next());
            }
            const type = typeTokens.map((x) => (x.type === 'keyword' ? x.value : x.value)).join('');
            const operand = this.parseUnary();
            return { t: 'cast', type, e: operand };
          }
          default:
            throw new Error(`Unexpected operator '${t.value}' in expression at ${t.pos}`);
        }
      default:
        throw new Error(`Unexpected token ${describe(t)}`);
    }
  }

  parseCall(name) {
    this.expectOp('(');
    const args = [];
    if (!this.isOp(')')) {
      for (;;) {
        args.push(this.parseExpression());
        if (!this.eatOp(',')) break;
      }
    }
    this.expectOp(')');
    if (name === 'count' && args.length === 0) return { t: 'count' };
    return { t: 'func', name, args };
  }

  parseIf() {
    this.expectKw('if');
    const cond = this.parseExpression();
    // Both `IF cond THEN expr` and the brace form `IF cond { expr }` are valid.
    let then;
    if (this.eatKw('then')) {
      then = this.parseExpression();
    } else {
      this.expectOp('{');
      then = this.parseExpression();
      this.expectOp('}');
    }
    const node = { t: 'if', cond, then, elifs: [], else: null };
    for (;;) {
      if (this.eatKw('else')) {
        if (this.isKw('if')) {
          this.next();
          const c2 = this.parseExpression();
          let t2;
          if (this.eatKw('then')) {
            t2 = this.parseExpression();
          } else {
            this.expectOp('{');
            t2 = this.parseExpression();
            this.expectOp('}');
          }
          node.elifs.push({ cond: c2, then: t2 });
          continue;
        }
        if (this.isOp('{')) {
          this.next();
          node.else = this.parseExpression();
          this.expectOp('}');
        } else {
          node.else = this.parseExpression();
        }
        break;
      }
      break;
    }
    this.eatKw('end');
    return node;
  }

  parsePath() {
    const parts = [];
    for (;;) {
      const t = this.peek();
      if (t.type === 'ident' || t.type === 'qident' || t.type === 'keyword') {
        this.next();
        parts.push(t.value);
      } else if (t.type === 'number') {
        this.next();
        parts.push(String(t.value));
      } else {
        throw new Error(`Expected path part, got ${describe(t)}`);
      }
      if (this.isOp('.')) {
        this.next();
        continue;
      }
      break;
    }
    return { t: 'path', parts };
  }
}

function describe(token) {
  if (!token) return 'end of input';
  if (token.type === 'eof') return 'end of input';
  return `${token.type} '${String(token.value).slice(0, 40)}'`;
}

const DURATION_UNITS_MS = {
  us: 1 / 1000,
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  y: 365 * 24 * 60 * 60 * 1000,
};

export function parseDurationLiteral(raw) {
  const str = String(raw);
  let ms = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)(us|ms|s|m|h|d|w|y)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    ms += Number(m[1]) * DURATION_UNITS_MS[m[2]];
    matched = true;
  }
  if (!matched) throw new Error(`Invalid duration literal: ${raw}`);
  return { t: 'dur', ms, str };
}

/** Parse "table:id" / "table:⟨id⟩" text into {table, id}; null when not a rid. */
export function parseRidText(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/^([A-Za-z_][A-Za-z0-9_]*):(.+)$/s);
  if (!m) return null;
  let id = m[2];
  const braced = id.match(/^⟨(.*)⟩$/s);
  if (braced) id = braced[1];
  return { table: m[1], id };
}

/** Parse a full SurrealQL text into an array of statement ASTs. */
export function parse(sql) {
  const tokens = tokenize(sql);
  const parser = new Parser(tokens);
  return parser.parseStatements();
}
