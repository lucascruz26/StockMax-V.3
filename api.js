// StockMax — API REST (JSON) em /api. Autenticação por token Bearer (JWT). Erros: { "erro": "mensagem" } com status HTTP semântico.
const express = require('express'), jwt = require('jsonwebtoken'), s = require('./services');
const SECRET = process.env.SECRET_KEY || 'dev-troque-esta-chave';
const api = express.Router();
api.use(express.json());
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const auth = papel => h(async (req, res, next) => {
  let id; try { id = jwt.verify((req.headers.authorization || '').replace(/^Bearer /, ''), SECRET).sub; } catch { throw new s.Erro('Token ausente ou inválido.', 401); }
  const u = await s.usuarioPorId(id);
  if (!u) throw new s.Erro('Usuário não encontrado.', 401);
  if (papel && u.permissao !== papel) throw new s.Erro(`Acesso negado: requer perfil ${papel}.`, 403);
  req.user = u; next();
});

api.post('/auth/login', h(async (req, res) => { const u = await s.autenticar(req.body.email, req.body.senha); res.json({ token: jwt.sign({ sub: u.id }, SECRET, { expiresIn: '8h' }), usuario: u }); }));
api.get('/produtos', auth(), h(async (req, res) => res.json(await s.listarProdutos(req.query))));                                  // listagem paginada com filtros
api.post('/produtos', auth('admin'), h(async (req, res) => res.status(201).json(await s.salvarProduto(s.dtoProduto(req.body)))));  // cadastro
api.put('/produtos/:id', auth('admin'), h(async (req, res) => res.json(await s.salvarProduto(s.dtoProduto(req.body), req.params.id))));
api.delete('/produtos/:id', auth('admin'), h(async (req, res) => res.json(await s.definirAtivo(req.params.id, false))));          // soft delete
api.post('/movimentacoes', auth(), h(async (req, res) => res.status(201).json(await s.movimentar({ ...req.body, usuario_id: req.user.id }))));
api.get('/movimentacoes', auth(), h(async (req, res) => res.json(await s.listarMovimentacoes(req.query))));
api.get('/relatorios/estoque-baixo', auth(), h(async (req, res) => res.json(await s.estoqueBaixo())));
api.use((req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));
api.use((e, req, res, next) => { if (!e.status) console.error(e); res.status(e.status || 500).json({ erro: e.status ? e.message : 'Erro interno.' }); });
module.exports = api;
