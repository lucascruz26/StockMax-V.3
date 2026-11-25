// StockMax — regras de aplicação compartilhadas pelo site e pela API (validação tipo DTO + acesso ao banco).
const bcrypt = require('bcryptjs'), pool = require('./db/pool'), q = (t, p) => pool.query(t, p);
class Erro extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = v => String(v ?? '').trim();
const num = v => { const n = Number(v === '' || v == null ? 0 : v); return Number.isFinite(n) && n >= 0 ? n : null; };
const traduz = e => {  // converte erros do PostgreSQL em respostas com status HTTP semântico
  if (e instanceof Erro) return e;
  const m = { 23505: ['Já existe um registro com este valor único (SKU, e-mail ou CNPJ).', 409], 23503: ['Referência inexistente.', 422], '22P02': ['Identificador inválido.', 400],
    P0002: [e.message, 404], 22023: [e.message, 422], 23514: [e.constraint ? 'Valor recusado por uma regra do banco.' : e.message, 422] }[e.code];
  return m ? new Erro(...m) : e;
};
const run = async fn => { try { return await fn(); } catch (e) { throw traduz(e); } };

/* usuários */
const criarUsuario = b => run(async () => {
  const nome = str(b.nome), email = str(b.email).toLowerCase(), senha = String(b.senha ?? '');
  if (!nome || !email.includes('@') || senha.length < 6) throw new Erro('Informe nome, e-mail válido e senha com no mínimo 6 caracteres.');
  return (await q(`INSERT INTO usuarios(nome, email, senha_hash, permissao) VALUES($1, $2, $3,
    CASE WHEN EXISTS (SELECT 1 FROM usuarios) THEN 'operador'::permissao_usuario ELSE 'admin'::permissao_usuario END) RETURNING id, nome, email, permissao`,
    [nome, email, await bcrypt.hash(senha, 10)])).rows[0];
});
const autenticar = async (email, senha) => {
  const u = (await q('SELECT * FROM usuarios WHERE email = $1', [str(email).toLowerCase()])).rows[0];
  if (!u || !await bcrypt.compare(String(senha ?? ''), u.senha_hash)) throw new Erro('E-mail ou senha inválidos.', 401);
  await q('UPDATE usuarios SET ultimo_acesso = now() WHERE id = $1', [u.id]);
  return { id: u.id, nome: u.nome, email: u.email, permissao: u.permissao };
};
const usuarioPorId = async id => UUID.test(id || '') ? (await q('SELECT id, nome, permissao FROM usuarios WHERE id = $1', [id])).rows[0] : null;
const listarUsuarios = () => q('SELECT id, nome FROM usuarios ORDER BY nome').then(r => r.rows);

/* fornecedores */
const listarFornecedores = () => q('SELECT f.*, (SELECT COUNT(*) FROM produtos p WHERE p.fornecedor_id = f.id)::int AS produtos FROM fornecedores f ORDER BY razao_social').then(r => r.rows);
const criarFornecedor = b => run(async () => {
  const d = [str(b.razao_social), str(b.cnpj), str(b.telefone) || null];
  if (!d[0] || !d[1]) throw new Erro('Razão social e CNPJ/CPF são obrigatórios.');
  return (await q('INSERT INTO fornecedores(razao_social, cnpj, telefone) VALUES($1,$2,$3) RETURNING *', d)).rows[0];
});

/* produtos */
const COLS = ['sku', 'nome', 'categoria', 'unidade', 'codigo_barras', 'preco_custo', 'preco_venda', 'estoque_min', 'fornecedor_id'];
function dtoProduto(b) {
  const d = { sku: str(b.sku).toUpperCase(), nome: str(b.nome), categoria: str(b.categoria), unidade: str(b.unidade) || 'un', codigo_barras: str(b.codigo_barras) || null,
    preco_custo: num(b.preco_custo), preco_venda: num(b.preco_venda), estoque_min: num(b.estoque_min), fornecedor_id: str(b.fornecedor_id) || null };
  if (!d.sku || !d.nome) throw new Erro('SKU e nome são obrigatórios.');
  if ([d.preco_custo, d.preco_venda, d.estoque_min].includes(null) || !Number.isInteger(d.estoque_min)) throw new Erro('Preços devem ser números e o estoque mínimo um inteiro, todos não negativos.');
  if (d.fornecedor_id && !UUID.test(d.fornecedor_id)) throw new Erro('Fornecedor inválido.');
  return d;
}
const obterProduto = id => run(async () => { const p = (await q('SELECT * FROM produtos WHERE id = $1', [id])).rows[0]; if (!p) throw new Erro('Produto não encontrado.', 404); return p; });
const salvarProduto = (d, id) => run(async () => {
  const v = COLS.map(c => d[c]);
  const r = await q(id ? `UPDATE produtos SET ${COLS.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${v.length + 1} RETURNING *`
    : `INSERT INTO produtos(${COLS.join(',')}) VALUES(${v.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, id ? [...v, id] : v);
  if (!r.rows[0]) throw new Erro('Produto não encontrado.', 404);
  return r.rows[0];
});
const definirAtivo = (id, valor) => run(async () => {  // soft delete: valor null alterna
  const r = await q('UPDATE produtos SET ativo = COALESCE($2::boolean, NOT ativo) WHERE id = $1 RETURNING *', [id, valor]);
  if (!r.rows[0]) throw new Erro('Produto não encontrado.', 404);
  return r.rows[0];
});
const listarProdutos = (f = {}) => run(async () => {
  const limite = Math.min(Math.max(parseInt(f.limite) || 20, 1), 100), pagina = Math.max(parseInt(f.pagina) || 1, 1), forn = str(f.fornecedor) || null;
  if (forn && !UUID.test(forn)) throw new Erro('Fornecedor inválido.');
  const st = { ativo: true, inativo: false }[f.status ?? 'ativo'];  // "todos" => sem filtro
  const r = await q(`SELECT p.*, fo.razao_social AS fornecedor, COUNT(*) OVER()::int AS total FROM produtos p LEFT JOIN fornecedores fo ON fo.id = p.fornecedor_id
    WHERE ($1::boolean IS NULL OR p.ativo = $1) AND ($2::text IS NULL OR p.categoria = $2) AND ($3::uuid IS NULL OR p.fornecedor_id = $3)
      AND ($4::text = '' OR p.nome ILIKE '%' || $4 || '%' OR p.sku ILIKE '%' || $4 || '%' OR p.codigo_barras = $4)
    ORDER BY p.nome LIMIT $5 OFFSET $6`, [st ?? null, str(f.categoria) || null, forn, str(f.q), limite, (pagina - 1) * limite]);
  return { dados: r.rows, pagina, limite, total: r.rows[0]?.total ?? 0 };
});
const estoqueBaixo = () => q('SELECT * FROM v_estoque_baixo ORDER BY estoque_atual - estoque_min, nome').then(r => r.rows);
const resumo = () => q(`SELECT COALESCE(SUM(estoque_atual * preco_custo), 0) AS capital, COUNT(*) FILTER (WHERE estoque_atual = 0) AS esgotados,
  COUNT(*) FILTER (WHERE estoque_atual > 0 AND estoque_atual <= estoque_min) AS criticos FROM produtos WHERE ativo`).then(r => r.rows[0]);

/* movimentações */
const movimentar = b => run(async () => {
  const n = Number(b.quantidade), tipo = str(b.tipo).toUpperCase();
  if (!UUID.test(str(b.produto_id))) throw new Erro('Produto inválido.');
  if (!['E', 'S'].includes(tipo)) throw new Erro('Tipo deve ser E (entrada) ou S (saída).');
  if (!Number.isInteger(n) || n <= 0) throw new Erro('A quantidade deve ser um inteiro maior que zero.');
  return (await q('SELECT o_movimentacao_id AS movimentacao_id, o_saldo_anterior AS saldo_anterior, o_saldo_novo AS saldo_novo FROM registrar_movimentacao($1, $2, $3::tipo_movimentacao, $4, $5)',
    [b.produto_id, b.usuario_id, tipo, n, str(b.motivo)])).rows[0];
});
const listarMovimentacoes = (f = {}) => run(async () => {
  const w = [], p = [], add = (sql, v) => { p.push(v); w.push(sql.replace('?', '$' + p.length)); }, data = /^\d{4}-\d{2}-\d{2}$/;
  if (['E', 'S'].includes(f.tipo)) add('m.tipo = ?::tipo_movimentacao', f.tipo);
  for (const [k, col] of [['produto', 'm.produto_id'], ['usuario', 'm.usuario_id']]) if (f[k]) { if (!UUID.test(f[k])) throw new Erro('Filtro inválido.'); add(col + ' = ?', f[k]); }
  if (data.test(f.de || '')) add('m.created_at >= ?::date', f.de);
  if (data.test(f.ate || '')) add('m.created_at < (?::date + 1)', f.ate);
  return (await q(`SELECT m.*, p.nome AS produto, p.sku, u.nome AS usuario, a.saldo_anterior, a.saldo_novo FROM movimentacoes m
    JOIN produtos p ON p.id = m.produto_id JOIN usuarios u ON u.id = m.usuario_id JOIN audit_log a ON a.movimentacao_id = m.id
    ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY m.created_at DESC LIMIT 200`, p)).rows;
});

module.exports = { Erro, UUID, pool, criarUsuario, autenticar, usuarioPorId, listarUsuarios, listarFornecedores, criarFornecedor, dtoProduto, obterProduto, salvarProduto,
  definirAtivo, listarProdutos, estoqueBaixo, resumo, movimentar, listarMovimentacoes };
