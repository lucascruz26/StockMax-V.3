// StockMax — servidor web (Node.js + Express + PostgreSQL): site renderizado no servidor + API REST em /api.
require('dotenv').config();
const crypto = require('crypto'), express = require('express'), cookieSession = require('cookie-session');
const s = require('./services'), api = require('./api'), pool = require('./db/pool'), { migrate } = require('./db/migrate');
const { esc, brl, dt, KINDS, status, csrf, field, table, page } = require('./views');

const ready = migrate(pool);  // aplica as migrations pendentes (idempotente) — funciona também na Vercel
ready.catch(e => console.error('Falha nas migrations:', e.message));
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const flash = (req, m) => { req.session.flash = [...(req.session.flash || []), m]; };
const send = (req, res, title, body, code = 200) => res.status(code).send(page(req, title, body));
const movesTable = rows => table(['Data', 'Produto', 'Tipo', 'Qtd.', 'Saldo', 'Usuário', 'Motivo'], rows.map(m => [dt(m.created_at),
  `${esc(m.produto)}<br><small>${esc(m.sku)}</small>`, KINDS[m.tipo], m.quantidade, `${m.saldo_anterior} → ${m.saldo_novo}`, esc(m.usuario), esc(m.motivo)])) || '<p>Nenhuma movimentação encontrada.</p>';
const opts = (rows, sel, label = 'nome') => rows.map(r => `<option value="${r.id}" ${String(r.id) === String(sel) ? 'selected' : ''}>${esc(r[label])}</option>`).join('');

const app = express();
app.set('trust proxy', 1);
app.get('/saude', (req, res) => res.json({ ok: true, DATABASE_URL_definida: !!process.env.DATABASE_URL, SECRET_KEY_definida: !!process.env.SECRET_KEY }));  // diagnóstico, sem expor segredos
app.use(async (req, res, next) => {
  try { await ready; next(); } catch (e) { res.status(503).send('Não foi possível conectar ao banco de dados. Confira DATABASE_URL nas variáveis de ambiente e os Logs da Vercel.'); }
});
app.use('/api', api);  // API JSON (token Bearer), sem cookies
app.use(express.urlencoded({ extended: false }));
app.use(cookieSession({ name: 'sm', secret: [process.env.SECRET_KEY || 'dev-troque-esta-chave'], httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === '1', maxAge: 8 * 3600e3 }));
app.use(h(async (req, res, next) => {
  req.session.csrf ??= crypto.randomBytes(16).toString('hex');
  if (req.method === 'POST' && req.body._csrf !== req.session.csrf) return res.status(400).send('Requisição inválida (CSRF).');
  req.user = await s.usuarioPorId(req.session.uid);
  next();
}));
const need = papel => (req, res, next) => !req.user ? res.redirect('/login')
  : papel && req.user.permissao !== papel ? send(req, res, 'Acesso negado', '<p><mark>Apenas o perfil admin faz esta ação.</mark></p>', 403) : next();
const adm = req => req.user.permissao === 'admin';

/* ---------- autenticação ---------- */
const authPage = (req, res, reg) => send(req, res, reg ? 'Criar conta' : 'Entrar', `<h2>${reg ? 'Criar conta' : 'Entrar'}</h2><p>Controle de estoque simples e seguro.</p>
  <form method="post">${csrf(req)}${reg ? field('Nome', 'nome', { required: true, autocomplete: 'name' }) : ''}
  ${field('E-mail', 'email', { type: 'email', required: true, autocomplete: 'email' })}
  ${field('Senha', 'senha', { type: 'password', required: true, minlength: reg ? 6 : 1, autocomplete: reg ? 'new-password' : 'current-password' })}
  <button>${reg ? 'Criar conta' : 'Entrar'}</button></form><p><a href="${reg ? '/login' : '/cadastro'}">${reg ? 'Já tenho conta' : 'Criar conta nova'}</a></p>`);
app.get('/login', (req, res) => authPage(req, res, false));
app.get('/cadastro', (req, res) => authPage(req, res, true));
app.post('/login', h(async (req, res) => {
  const u = await s.autenticar(req.body.email, req.body.senha);
  req.session = { uid: u.id, csrf: crypto.randomBytes(16).toString('hex') }; res.redirect('/');
}));
app.post('/cadastro', h(async (req, res) => { await s.criarUsuario(req.body); flash(req, 'Conta criada. Faça login.'); res.redirect('/login'); }));  // a 1ª conta vira admin
app.post('/sair', (req, res) => { req.session = null; res.redirect('/login'); });

/* ---------- painel ---------- */
app.get('/', need(), h(async (req, res) => {
  const [k, al, mv] = await Promise.all([s.resumo(), s.estoqueBaixo(), s.listarMovimentacoes()]);
  send(req, res, 'Painel', `<h1>Painel</h1>
    <article><header>Capital investido</header><h2>${brl(k.capital)}</h2></article>
    <article><header>Estoque crítico</header><h2>${k.criticos} produtos</h2></article>
    <article><header>Esgotados</header><h2>${k.esgotados} produtos</h2></article>
    <h2>Produtos em alerta</h2>${table(['Produto', 'Situação', 'Qtd.', 'Mín.', ''], al.map(p => [`${esc(p.nome)}<br><small>${esc(p.sku)}</small>`,
      `<mark>${status(p)}</mark>`, p.estoque_atual, p.estoque_min, `<a href="/movimentacoes?repor=${p.id}">Repor</a>`])) || '<p>Nenhum produto em alerta.</p>'}
    <h2>Últimas movimentações</h2>${movesTable(mv.slice(0, 8))}`);
}));

/* ---------- produtos ---------- */
app.get('/produtos', need(), h(async (req, res) => {
  const [r, fo] = await Promise.all([s.listarProdutos(req.query), s.listarFornecedores()]), st = req.query.status || 'ativo', qs = new URLSearchParams(req.query);
  const link = n => { qs.set('pagina', n); return '/produtos?' + qs; }, paginas = Math.max(1, Math.ceil(r.total / r.limite));
  send(req, res, 'Produtos', `<h1>Produtos</h1>${adm(req) ? '<p><a href="/produtos/novo" role="button">+ Novo produto</a></p>' : '<p><small>Somente admin cria, edita e desativa produtos.</small></p>'}
    <form method="get"><input type="search" name="q" value="${esc(req.query.q)}" placeholder="Nome, SKU ou código de barras">
    <select name="status">${[['ativo', 'Ativos'], ['inativo', 'Inativos'], ['todos', 'Todos']].map(([v, l]) => `<option value="${v}" ${st === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <select name="fornecedor"><option value="">Todos os fornecedores</option>${opts(fo, req.query.fornecedor, 'razao_social')}</select><button>Filtrar</button></form>
    ${table(['Produto', 'Fornecedor', 'Qtd.', 'Mín.', 'Venda', 'Situação', ''], r.dados.map(p => [`${esc(p.nome)}<br><small>${esc(p.sku)}${p.categoria ? ' · ' + esc(p.categoria) : ''}</small>`,
      esc(p.fornecedor || '—'), `${p.estoque_atual} ${esc(p.unidade)}`, p.estoque_min, brl(p.preco_venda), status(p) === 'OK' ? 'OK' : `<mark>${status(p)}</mark>`,
      adm(req) ? `<a href="/produtos/${p.id}/editar">Editar</a><form method="post" action="/produtos/${p.id}/alternar">${csrf(req)}<button class="secondary">${p.ativo ? 'Desativar' : 'Ativar'}</button></form>` : ''])) || '<p>Nenhum produto encontrado.</p>'}
    <p>${r.pagina > 1 ? `<a href="${link(r.pagina - 1)}">← Anterior</a> · ` : ''}Página ${r.pagina} de ${paginas} (${r.total} produtos)${r.pagina < paginas ? ` · <a href="${link(r.pagina + 1)}">Próxima →</a>` : ''}</p>`);
}));
const caminhos = ['/produtos/novo', '/produtos/:id/editar'];
app.get(caminhos, need('admin'), h(async (req, res) => {
  const id = req.params.id, [p, fo] = await Promise.all([id ? s.obterProduto(id) : {}, s.listarFornecedores()]);
  send(req, res, id ? 'Editar produto' : 'Novo produto', `<h1>${id ? 'Editar' : 'Novo'} produto</h1><form method="post">${csrf(req)}
    ${field('SKU', 'sku', { value: p.sku, required: true, maxlength: 50 })}${field('Código de barras', 'codigo_barras', { value: p.codigo_barras, maxlength: 50 })}
    ${field('Nome', 'nome', { value: p.nome, required: true, maxlength: 150 })}${field('Categoria', 'categoria', { value: p.categoria, maxlength: 80 })}
    ${field('Unidade de medida', 'unidade', { value: p.unidade || 'un', maxlength: 10 })}${field('Preço de custo (R$)', 'preco_custo', { type: 'number', step: '0.01', min: 0, value: p.preco_custo })}
    ${field('Preço de venda (R$)', 'preco_venda', { type: 'number', step: '0.01', min: 0, value: p.preco_venda })}${field('Estoque mínimo', 'estoque_min', { type: 'number', min: 0, value: p.estoque_min ?? 0 })}
    <label>Fornecedor<select name="fornecedor_id"><option value="">— nenhum —</option>${opts(fo, p.fornecedor_id, 'razao_social')}</select></label>
    <button>Salvar</button></form><p><a href="/produtos">Voltar</a>${id ? '' : ' · O saldo inicial é lançado como "Entrada" em Movimentações.'}</p>`);
}));
app.post(caminhos, need('admin'), h(async (req, res) => { await s.salvarProduto(s.dtoProduto(req.body), req.params.id); flash(req, 'Produto salvo.'); res.redirect('/produtos'); }));
app.post('/produtos/:id/alternar', need('admin'), h(async (req, res) => {  // soft delete: nada é apagado fisicamente
  const p = await s.definirAtivo(req.params.id, null);
  flash(req, p.ativo ? 'Produto reativado.' : 'Produto desativado (ativo = false).'); res.redirect('/produtos?status=todos');
}));

/* ---------- movimentações ---------- */
app.post('/movimentacoes', need(), h(async (req, res) => {
  const m = await s.movimentar({ ...req.body, usuario_id: req.user.id });
  flash(req, `Movimentação registrada. Saldo: ${m.saldo_anterior} → ${m.saldo_novo}.`); res.redirect('/movimentacoes');
}));
app.get('/movimentacoes', need(), h(async (req, res) => {
  const f = req.query, [mv, pr, us] = await Promise.all([s.listarMovimentacoes(f), s.listarProdutos({ limite: 100 }), s.listarUsuarios()]);
  const tipos = sel => Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('');
  send(req, res, 'Movimentações', `<h1>Movimentações</h1><details ${f.repor ? 'open' : ''}><summary>Registrar movimentação</summary><form method="post">${csrf(req)}
    <label>Produto<select name="produto_id" required>${pr.dados.map(p => `<option value="${p.id}" ${p.id === f.repor ? 'selected' : ''}>${esc(p.nome)} (${p.estoque_atual} em estoque)</option>`).join('')}</select></label>
    <label>Tipo<select name="tipo">${tipos()}</select></label>${field('Quantidade', 'quantidade', { type: 'number', min: 1, required: true })}
    ${field('Motivo (obrigatório)', 'motivo', { required: true, maxlength: 255, placeholder: 'Ex.: compra NF 123, venda, avaria' })}<button>Registrar</button></form></details>
    <h2>Histórico (Audit_Log)</h2><form method="get"><label>Tipo<select name="tipo"><option value="">Todos</option>${tipos(f.tipo)}</select></label>
    <label>Produto<select name="produto"><option value="">Todos</option>${opts(pr.dados, f.produto)}</select></label><label>Usuário<select name="usuario"><option value="">Todos</option>${opts(us, f.usuario)}</select></label>
    ${field('De', 'de', { type: 'date', value: f.de })}${field('Até', 'ate', { type: 'date', value: f.ate })}<button>Filtrar</button></form>
    <p><a href="/movimentacoes">Limpar filtros</a></p>${movesTable(mv)}`);
}));

/* ---------- fornecedores ---------- */
app.get('/fornecedores', need(), h(async (req, res) => {
  const rows = await s.listarFornecedores();
  send(req, res, 'Fornecedores', `<h1>Fornecedores</h1>${table(['Razão social', 'CNPJ/CPF', 'Telefone', 'Produtos'], rows.map(f => [esc(f.razao_social), esc(f.cnpj), esc(f.telefone || '—'), f.produtos])) || '<p>Nenhum fornecedor cadastrado ainda.</p>'}
    ${adm(req) ? `<details><summary>+ Novo fornecedor</summary><form method="post">${csrf(req)}${field('Razão social', 'razao_social', { required: true, maxlength: 150 })}
    ${field('CNPJ/CPF', 'cnpj', { required: true, maxlength: 18 })}${field('Telefone', 'telefone', { maxlength: 30 })}<button>Salvar</button></form></details>` : ''}`);
}));
app.post('/fornecedores', need('admin'), h(async (req, res) => { await s.criarFornecedor(req.body); flash(req, 'Fornecedor cadastrado.'); res.redirect('/fornecedores'); }));

app.use((e, req, res, next) => {  // erros de validação/regra voltam à página anterior com a mensagem; o resto é erro 500
  if (e.status && req.session) { flash(req, e.message); return res.redirect(req.get('referer') || '/'); }
  console.error(e); res.status(500).send('Erro interno. Tente novamente.');
});

const PORT = process.env.PORT || 3000;
if (require.main === module) app.listen(PORT, () => console.log('StockMax em http://localhost:' + PORT));  // execução local
module.exports = app;  // a Vercel usa a aplicação exportada
