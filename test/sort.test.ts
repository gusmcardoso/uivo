import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Site } from '../src/web/api.ts';
import {
  activeFilters,
  clientsOf,
  countBySeverity,
  EMPTY_FILTER,
  filterSites,
  groupByClient,
  severity,
  sortSites,
} from '../src/web/sort.ts';

const NOW = Date.UTC(2026, 10, 24);
const DAY = 86_400_000;
const site = (name: string, over: Partial<Site> = {}): Site =>
  ({
    id: Math.random(),
    name,
    url: 'https://x.com.br',
    enabled: 1,
    status: 'up',
    check_domain: 1,
    ssl_expires_at: NOW + 90 * DAY,
    domain_expires_at: NOW + 300 * DAY,
    security_score: 95,
    last_challenge: null,
    uptime_24h: 100,
    client: null,
    ...over,
  }) as Site;

describe('ordem e grupos da lista de sites', () => {
  it('situação: fora do ar → atenção → no ar → aguardando → pausado; empate por nome', () => {
    const list = [
      site('Zeta'),
      site('Pausado', { enabled: 0, status: 'down' }),
      site('Beta', { ssl_expires_at: NOW + 5 * DAY }),
      site('Novo', { status: 'unknown' }),
      site('Caiu', { status: 'down' }),
      site('alfa'),
    ];
    assert.deepEqual(
      sortSites(list, 'situacao', NOW).map((s) => s.name),
      ['Caiu', 'Beta', 'alfa', 'Zeta', 'Novo', 'Pausado'],
    );
    assert.deepEqual(
      sortSites(list, 'nome', NOW).map((s) => s.name),
      ['alfa', 'Beta', 'Caiu', 'Novo', 'Pausado', 'Zeta'],
    );
  });

  it('o que conta como "pedindo atenção"', () => {
    assert.equal(severity(site('a', { domain_expires_at: NOW + 20 * DAY }), NOW), 1);
    assert.equal(severity(site('a', { domain_expires_at: NOW + 20 * DAY, check_domain: 0 }), NOW), 2);
    assert.equal(severity(site('a', { security_score: 60 }), NOW), 1);
    assert.equal(severity(site('a', { last_challenge: 'Cloudflare' }), NOW), 1);
    assert.equal(severity(site('a', { uptime_24h: 98 }), NOW), 1);
    assert.equal(severity(site('a'), NOW), 2);
  });

  it('agrupa por cliente em ordem alfabética, "sem cliente" por último, com contagens', () => {
    const groups = groupByClient(
      [
        site('Loja', { client: 'Padaria' }),
        site('Blog', { client: 'Clínica', status: 'down' }),
        site('Portfólio'),
        site('Site', { client: 'Clínica', security_score: 50 }),
        site('Cardápio', { client: ' Padaria ' }),
      ],
      'situacao',
      NOW,
    );
    assert.deepEqual(
      groups.map((g) => [g.client, g.sites.map((s) => s.name), g.down, g.attention]),
      [
        ['Clínica', ['Blog', 'Site'], 1, 1],
        ['Padaria', ['Cardápio', 'Loja'], 0, 0],
        [null, ['Portfólio'], 0, 0],
      ],
    );
  });

  it('lista os clientes sem repetir', () => {
    assert.deepEqual(
      clientsOf([
        site('a', { client: 'B' }),
        site('b', { client: 'a' }),
        site('c', { client: ' B ' }),
        site('d'),
      ]),
      ['a', 'B'],
    );
  });
});

describe('busca e filtros da lista', () => {
  const list = [
    site('Blog da Clínica', { url: 'https://clinica.com.br', client: 'Saúde Viva' }),
    site('Loja', { url: 'https://loja.com.br', client: 'Rede X', status: 'down' }),
    site('Agenda', {
      url: 'https://agenda.saude.com.br',
      client: 'Saúde Viva',
      ssl_expires_at: NOW + 3 * DAY,
    }),
    site('Antigo', { url: 'https://promo.com.br', enabled: 0 }),
  ];
  const names = (f: Partial<typeof EMPTY_FILTER>) =>
    filterSites(list, { ...EMPTY_FILTER, ...f }, NOW).map((s) => s.name);

  it('sem filtro, mostra tudo', () => {
    assert.equal(names({}).length, 4);
    assert.equal(activeFilters(EMPTY_FILTER), 0);
  });

  it('busca por nome, endereço ou cliente, sem diferenciar acento e maiúscula', () => {
    assert.deepEqual(names({ query: 'CLINICA' }), ['Blog da Clínica']);
    assert.deepEqual(names({ query: 'agenda.saude' }), ['Agenda']);
    assert.deepEqual(names({ query: 'saude viva' }), ['Blog da Clínica', 'Agenda']);
    assert.deepEqual(names({ query: 'https' }), [], 'o protocolo do endereço não conta');
    assert.deepEqual(names({ query: '   ' }).length, 4);
  });

  it('filtra por situação e por cliente (inclusive sem cliente), e combina com a busca', () => {
    assert.deepEqual(names({ situations: [0, 1] }), ['Loja', 'Agenda']);
    assert.deepEqual(names({ situations: [4] }), ['Antigo']);
    assert.deepEqual(names({ clients: [''] }), ['Antigo']);
    assert.deepEqual(names({ clients: ['Saúde Viva'], situations: [1] }), ['Agenda']);
    assert.deepEqual(names({ clients: ['Saúde Viva'], query: 'blog' }), ['Blog da Clínica']);
    assert.equal(activeFilters({ query: 'x', situations: [1], clients: ['a'] }), 3);
  });

  it('conta os sites de cada situação', () => {
    assert.deepEqual(countBySeverity(list, NOW), [1, 1, 1, 0, 1]);
  });
});
